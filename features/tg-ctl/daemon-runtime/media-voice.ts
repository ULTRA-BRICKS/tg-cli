// daemon-runtime/media-voice: downloading media and transcribing voice notes.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { readConfigFile } from "../../config/config-file"
import { buildTextInjectPlan, wrapInbound } from "../inject"
import { retryFetch, type RetryInfo } from "../retry"
import { formatVoiceTranscript, decideOnboarding, onboardingMessage, parseVoiceConfig, resolveVoiceConfig } from "../voice"
import { probeWhisper } from "../voice-probe"
import type { Action } from "../types"
import { api, log } from "./ctx-io"
import { sendMessage } from "./telegram-api"
import { formatVoiceConfirmation, persistVoiceConfigToDir, runTranscription, voiceReady } from "./voice-setup"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { InboundInjectApi } from "./inbound-inject"
import type { AgentRoutesApi } from "./agent-routes"
import type { TargetRoutingApi } from "./target-routing"

export type MediaDeps = {
  ctx: Ctx
  state: DaemonState
  inboundInject: InboundInjectApi
  agentRoutes: AgentRoutesApi
  targetRouting: TargetRoutingApi
}

export function createMedia(d: MediaDeps) {
  const { ctx, state } = d
  const { injectViaTarget, routePrewrappedAgentMessage } = d.inboundInject
  const { injectIntoSelectedAgent, handleReplyRoute } = d.agentRoutes
  const { withGitStateBanner } = d.targetRouting

  // getFile → /file/ download into ~/.cache/tg-cli/inbound under the daemon-
  // chosen name (never the Telegram basename, spec §5.2). Returns the local path
  // or null (already logged + replied). Shared by media + voice download. The
  // WHOLE body is exception-guarded: a getFile timeout, a non-JSON body, a
  // download read error or a disk-write failure THROWS otherwise, and since the
  // poll loop persists the offset BEFORE acting, an uncaught throw loses the note
  // permanently with no reply. Catch → "media download failed" → null.
  const downloadFileToCache = async (
    fileId: string,
    suggestedName: string,
    out: Record<string, unknown> = {},
  ): Promise<string | null> => {
    // Log each retry of a network step with its label, the file id, and the
    // attempt count — shared by both steps so the message format stays in sync.
    const retryLog = (step: string) => (i: RetryInfo) =>
      log(`${step} retry ${i.attempt}/${i.maxAttempts} for ${fileId} in ${i.delayMs}ms`)
    try {
      // BOTH network steps run under bounded retry-with-backoff (default 3
      // attempts, ~300ms→900ms→2.7s jittered) so a single transient blip —
      // dropped connection, 5xx, timeout — no longer silently loses the inbound
      // note. Worst case wall time per step ≈ maxAttempts·timeout + backoffs
      // (getFile ~30s/try, file bytes ~120s/try). retryFetch only retries a
      // thrown error / non-2xx HTTP; a 200-with-{ok:false} getFile body is a
      // PERMANENT Telegram error (e.g. file gone) and is handled below, not
      // retried — same for a final non-2xx from either step, which is returned
      // for the local `!resp.ok` checks rather than thrown.
      const getFile = () =>
        // codeql[js/file-access-to-http] Intentional: the request goes to the operator-configured Bot API
        // base (TG_API_BASE) with the operator's own bot token, both read from ~/.config/tg-cli/.env /
        // process env by cli-main (the daemon's trust root, 0600 owner file). file_id is URL-encoded. No
        // attacker-controlled file data reaches the URL host. Covered by the ctl-*-integration tests that run
        // the daemon against a fake Bot API.
        fetch(`${api(ctx)}/getFile?file_id=${encodeURIComponent(fileId)}`, {
          signal: AbortSignal.timeout(30_000),
        })
      const fileResp = await retryFetch(getFile, { onRetry: retryLog("getFile") })
      const fileJson = (await fileResp.json()) as { ok: boolean; result?: { file_path?: string } }
      const remotePath = fileJson.ok ? fileJson.result?.file_path : undefined
      if (!remotePath) {
        log(`getFile failed for ${fileId}`)
        await sendMessage(ctx, "media download failed", out)
        return null
      }
      const fetchBytes = () =>
        // codeql[js/file-access-to-http] Intentional: the request goes to the operator-configured Bot API
        // base (TG_API_BASE) with the operator's own bot token, both read from ~/.config/tg-cli/.env /
        // process env by cli-main (the daemon's trust root, 0600 owner file). remotePath is Telegram's own
        // getFile answer on the same authenticated API (spec 5.2); the host stays fixed. No
        // attacker-controlled file data reaches the URL host. Covered by the ctl-*-integration tests that run
        // the daemon against a fake Bot API.
        fetch(`${ctx.apiBase}/file/bot${ctx.token}/${remotePath}`, {
          signal: AbortSignal.timeout(120_000),
        })
      const dataResp = await retryFetch(fetchBytes, { onRetry: retryLog("file download") })
      if (!dataResp.ok) {
        log(`file download failed: HTTP ${dataResp.status} for ${fileId} after retries`)
        await sendMessage(ctx, "media download failed", out)
        return null
      }
      const dir = join(ctx.home, ".cache", "tg-cli", "inbound")
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, suggestedName)
      // codeql[js/http-to-file-access] Intentional: the bytes are the media the CTO sent (downloaded over the
      // authenticated Bot API); the destination is <home>/.cache/tg-cli/inbound/<update_id>.<ext>, where
      // updates.ts builds the name from the numeric update id and sanitizedExt() (lowercase [a-z0-9], <=10
      // chars, else 'bin'), never the remote basename, so the path cannot escape the cache dir. Covered by
      // tests/ctl-download-retry.test.ts and tests/ctl-voice-integration.test.ts.
      writeFileSync(dest, new Uint8Array(await dataResp.arrayBuffer()))
      return dest
    } catch (err) {
      log(`media download error for ${fileId}: ${err}`)
      await sendMessage(ctx, "media download failed", out)
      return null
    }
  }

  // The agent-facing receipt for a downloaded photo/file: its local path plus the caption.
  // Shared by the flat media path and topic delivery so both read the same.
  const mediaReceipt = (mediaKind: "photo" | "document", dest: string, caption: string | undefined): string =>
    `sent ${mediaKind === "photo" ? "photo" : "file"}: ${dest}` + (caption ? `\n${caption}` : "")

  const downloadMedia = async (action: Extract<Action, { kind: "download-media" }>): Promise<boolean> => {
    const dest = await downloadFileToCache(action.fileId, action.suggestedName)
    if (dest === null) return false
    const routedCaption = action.agentRoute ? action.agentRoute.rest : action.caption
    const wrapped = wrapInbound(ctx.cfg.injectWrap, action.from, mediaReceipt(action.mediaKind, dest, routedCaption), action.messageId)
    if (action.agentRoute) {
      return routePrewrappedAgentMessage(action.agentRoute, wrapped, action.messageId)
    }
    if (action.replyToMessageId !== undefined) {
      const injectText = `${action.replyAnchor ?? ""}\n${wrapped}`.replace(/^\n/, "")
      return handleReplyRoute({
        kind: "reply-route",
        replyToMessageId: action.replyToMessageId,
        injectText,
        from: action.from,
        messageId: action.messageId,
        media: true,
      })
    }
    if (state.selectedAgentRoute) {
      const selectedResult = await injectIntoSelectedAgent(wrapped, action.messageId)
      if (selectedResult !== null) return selectedResult
    }
    // A non-reply photo/file → auto-bind to the last-active agent like a text msg, with the
    // git-state-check banner (withGitStateBanner) prepended when that pane is mid-flight.
    return injectViaTarget(
      (target) => buildTextInjectPlan(target.pane.paneId, withGitStateBanner(target.pane.panePath, wrapped)),
      wrapped,
      true,
      action.messageId,
    )
  }

  // Download + transcribe one voice note and post the STT confirmation. Returns the non-empty
  // transcript, or null once the failure (or the onboarding walk-through) has been answered —
  // except for the documented `voice.enabled: false` opt-out, which is only logged. Shared by the
  // flat voice path and topic delivery; `out` threads every reply into the source topic.
  const transcribeVoiceNote = async (
    fileId: string,
    suggestedName: string,
    messageId: number,
    out: Record<string, unknown> = {},
  ): Promise<string | null> => {
    // Reload the voice config from disk EVERY note: a `tg voice setup` run while
    // this daemon was already up must take effect without a restart. The parsed
    // PARTIAL is kept too, to tell "explicitly disabled" from "not configured".
    const rawYaml = readConfigFile(ctx.configDir)
    const voicePartial = parseVoiceConfig(rawYaml)
    ctx.voice = resolveVoiceConfig(voicePartial)

    // Master switch: an explicit `voice.enabled: false` means OFF — drop the
    // note silently (no onboarding, no re-enable). The documented opt-out must
    // survive a discoverable Whisper still being on the box.
    if (voicePartial.enabled === false) {
      log("voice note ignored — voice.enabled: false")
      return null
    }

    if (!voiceReady(ctx)) {
      // Not yet configured → auto-onboarding reply. No ack (the reply IS the
      // signal); the caller returns false, marking the action unhandled for the ack gate.
      const verdict = decideOnboarding(probeWhisper(ctx.home), ctx.voice.language)
      if (verdict.kind === "ready") {
        // We discovered a working install on the fly — persist it so the NEXT
        // voice note transcribes without re-prompting. But only CLAIM success if
        // the write actually landed: a read-only config.yaml would otherwise tell
        // the user "configured" while the next note loops back to onboarding.
        if (persistVoiceConfigToDir(ctx.configDir, verdict.cfg)) {
          ctx.voice = verdict.cfg
          await sendMessage(ctx, onboardingMessage(verdict), out)
        } else {
          await sendMessage(
            ctx,
            `🎙️ Found a local Whisper (${verdict.cfg.runner}, ${verdict.cfg.modelPath}) but could not save ` +
              `the config. Fix write permissions on ${join(ctx.configDir, "config.yaml")} and resend, or run \`tg voice setup\`.`,
            out,
          )
        }
      } else {
        await sendMessage(ctx, onboardingMessage(verdict), out)
      }
      return null
    }

    const dest = await downloadFileToCache(fileId, suggestedName, out)
    if (dest === null) return null

    const text = await runTranscription(ctx, dest)
    if (text === null) {
      await sendMessage(ctx, "voice transcription failed — see daemon log", out)
      return null
    }
    if (text.trim() === "") {
      await sendMessage(ctx, "voice note had no recognizable speech", out)
      return null
    }

    // This is an STT confirmation only, not a delivery receipt. Routing below may
    // still produce a separate no-agent / picker / inject-failed signal.
    await sendMessage(ctx, formatVoiceConfirmation(text), { ...out, reply_to_message_id: messageId })
    return text
  }

  // Voice note → text (inbound STT). Unconfigured? Walk the user through setup
  // instead of dropping it (the CTO's "если не настроено — бот проводит через
  // настройку"). Otherwise: download OGG → ffmpeg WAV 16k mono → local Whisper →
  // clean → route EXACTLY like a typed message (reply-route when it was a reply,
  // else inject into the discovered pane). The 👀 ack still fires via the step's
  // trailing ack action when this returns true.
  const transcribeVoice = async (action: Extract<Action, { kind: "transcribe-voice" }>): Promise<boolean> => {
    const text = await transcribeVoiceNote(action.fileId, action.suggestedName, action.messageId)
    if (text === null) return false

    // Route exactly like a typed message, but present the transcript as a 🎤-marked
    // quote (formatVoiceTranscript) so the agent can tell it's transcribed speech, not
    // typed text: a reply note carries the quote anchor and goes through the SAME
    // reply-route path; a standalone note injects into the discovered pane.
    const quoted = formatVoiceTranscript(text)
    if (action.replyToMessageId !== undefined) {
      const injectText = `${action.replyAnchor ?? ""}\n${wrapInbound(
        ctx.cfg.injectWrap,
        action.from,
        quoted,
        action.messageId,
      )}`.replace(/^\n/, "")
      return handleReplyRoute(
        {
          kind: "reply-route",
          replyToMessageId: action.replyToMessageId,
          injectText,
          from: action.from,
          messageId: action.messageId,
        },
        action.replyToMessageId,
      )
    }
    const wrapped = wrapInbound(ctx.cfg.injectWrap, action.from, quoted, action.messageId)
    if (state.selectedAgentRoute) {
      const selectedResult = await injectIntoSelectedAgent(wrapped, action.messageId)
      if (selectedResult !== null) return selectedResult
    }
    // A non-reply voice note → auto-bind to the last-active agent like a text msg, with the
    // git-state-check banner (withGitStateBanner) prepended when that pane is mid-flight.
    return injectViaTarget(
      (target) => buildTextInjectPlan(target.pane.paneId, withGitStateBanner(target.pane.panePath, wrapped)),
      wrapped,
      true,
      action.messageId,
    )
  }

  return { downloadFileToCache, mediaReceipt, downloadMedia, transcribeVoiceNote, transcribeVoice }
}

export type MediaApi = ReturnType<typeof createMedia>
