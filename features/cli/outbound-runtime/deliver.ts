// Delivery stage of the outbound `tg` pipeline: bot-bound transport → transmit → queued-send
// persistence (tg-cli#710) → daemon topic-result → done reaction → history → tg-ctl lazy
// auto-start → the OK line. Order of every effect is the CLI contract.
import { writeStdoutLine } from "../stdout-line"
import { rmSync } from "fs"
import { join } from "path"
import { checkAttachmentFile } from "../../auto-attach/file-check"
import { transmit } from "../../auto-attach/transmitter"
import { doneReactionForSend } from "../../tg-ctl/reactions"
import { shouldAutoStart } from "../../tg-ctl/lock"
import { sendRetryPolicyFromEnv } from "../../transport/send-retry"
import { createTelegramTransport, type QueuedSend } from "../../transport/telegram"
import { formatSendOk } from "../send-output"
import { askDaemon } from "../session-topic"
import { SESSION_LOOKUP_TIMEOUT_MS } from "./constants"
import { persistQueuedSends } from "./outbox-queue"
import type { OutboundRun } from "./types"

/** Generated code→pdf / md→pdf artifacts are dropped once uploaded or copied into the
 * outbox, so repeated reports don't pile up in the OS tmp (codex review finding). */
function removeTempDirs(dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

/** Tell the daemon how the threaded send went (§4.5): a success clears the session's miss
 * counter; a General fallback counts a miss, and the daemon posts the notice and, once
 * the topic is proven gone, recreates it. Best-effort, bounded like the lookup. */
async function reportTopicResult(run: OutboundRun, topicFallback: string | null): Promise<void> {
  const { sessionTopic, ctlFiles } = run.thread
  if (!sessionTopic) return
  await askDaemon(ctlFiles.socket, {
    kind: "topic-result",
    key: sessionTopic.key,
    threadId: sessionTopic.threadId,
    ok: topicFallback === null,
    ...(topicFallback !== null ? { description: topicFallback } : {}),
  }, SESSION_LOOKUP_TIMEOUT_MS, false)
}

/** Reaction lifecycle (tg-cli#114): an `--tag answer --reply-to <id>` send means
 * message <id> is now ANSWERED — flip its reaction to the done mark (👌, the
 * allowed proxy for ✅). Best-effort: the answer already sent, so a reaction
 * failure must never fail the command (mirrors the daemon's fail-open receipt). */
async function markAnswered(run: OutboundRun): Promise<void> {
  const doneReaction = doneReactionForSend({ tag: run.send.tag, replyToMessageId: run.send.replyTo })
  if (!doneReaction) return
  try {
    await fetch(`${run.sender.api}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: run.sender.chatId,
        message_id: doneReaction.messageId,
        reaction: [{ type: "emoji", emoji: doneReaction.emoji }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // best-effort — a failed done-mark never fails an already-sent answer
  }
}

/** tg-ctl lazy auto-start (control spec §7): fires only AFTER a fully
 * successful send, only inside tmux with a DETECTED AI AGENT (MODEL — the
 * same in-session detection that brands the message) AND control.enabled.
 * Fire-and-forget: the daemon's flock makes repeated starts a no-op, and
 * NOTHING in this block may ever break a send — hence the swallow-all catch. */
function autoStartDaemon(run: OutboundRun): void {
  try {
    if (run.sender.model && shouldAutoStart(process.env, run.thread.ctlCfg)) {
      Bun.spawn(
        [
          join(run.paths.rootDir, "tg-ctl"),
          "start",
          "--pane",
          process.env.TMUX_PANE ?? "",
          "--cwd",
          process.cwd(),
        ],
        { detached: true, stdio: ["ignore", "ignore", "ignore"] },
      ).unref()
    }
  } catch {
    // best-effort — auto-start failures are invisible by design
  }
}

export async function deliver(run: OutboundRun): Promise<void> {
  const { send, features, sender, prepared, built, recorder, thread, fileCheckDeps } = run
  const { plan, pdfTempDirs } = built
  const { chatId } = sender
  if (chatId === undefined) throw new Error("deliver: TG_CHAT_ID is unset after the dry-run exit")
  // A rejected advisory thread falls back to General; the description is reported to the daemon.
  let topicFallback: string | null = null
  const floodCapOn = features["flood-cap"] !== false

  // Build the bot-bound transport (api + chat + the route recorder + an
  // optional --reply-to anchor), then hand it to the transmitter, which applies
  // caption-overflow + the >4096 split + the photos→text→documents ordering on
  // top of the four send primitives. replyTo threads the first outbound message
  // under the referenced inbound Telegram message_id (Feature: threaded replies).
  // A 5xx / 429 / timeout / reset is retried within the budget; past it the
  // transport hands the unsent rest of the send to `queuedSends` (tg-cli#710).
  const sendStartedAt = Date.now()
  const queuedSends: QueuedSend[] = []
  const transport = createTelegramTransport({
    api: sender.api,
    chatId,
    recordRoute: recorder.recordRoute,
    replyToMessageId: send.replyTo,
    messageThreadId: thread.messageThreadId,
    threadIdAdvisory: thread.threadIdAdvisory,
    ...(thread.sessionTopic ? { threadRetryDelayMs: 1000 } : {}),
    ...(thread.threadIdAdvisory ? { onThreadFallback: (description: string) => void (topicFallback = description) } : {}),
    retry: sendRetryPolicyFromEnv(process.env),
    queue: (queued) => void queuedSends.push(queued),
  })
  // fileCheckDeps: defined earlier (before code-as-pdf/md-as-pdf), reused here
  // unchanged so the pre- and post-conversion checks agree on what "ok" means.
  await transmit(plan, transport, {
    checkFile: (path) => checkAttachmentFile(path, fileCheckDeps),
    allowFlood: !floodCapOn,
  })

  if (queuedSends.length > 0) await persistQueuedSends(run, queuedSends, sendStartedAt, () => removeTempDirs(pdfTempDirs))
  removeTempDirs(pdfTempDirs)

  await reportTopicResult(run, topicFallback)
  await markAnswered(run)

  // Outbound history for `tg replies` recall — one `agent` record per
  // outbound message_id (now known; see buildOutboundHistoryRecords). The
  // body is the raw user-typed message (caption), so recall shows what the
  // agent meant to say, not the branded envelope. Best-effort; never blocks
  // the (already-sent) send.
  recorder.recordOutboundHistory(prepared.caption)
  // Ctl client: route + history to the server, bounded, warnings on stderr, never an exit code.
  await recorder.publishRemote?.()

  autoStartDaemon(run)

  // Reaching here means every send actually went through (checkResponse exits
  // the process on any API failure).
  writeStdoutLine(formatSendOk(recorder.outboundIds))
}
