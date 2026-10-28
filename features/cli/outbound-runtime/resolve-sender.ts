// Stage 3 of the outbound `tg` pipeline: who is sending (model/emoji brand, session identity,
// credentials) and every info-only action that needs that identity but sends nothing
// (`--ls-emoji-helpers`, `--detect-model`, `--detect-agent`, `--session-topic`, `--session-id`).
import { writeStdoutLine } from "../stdout-line"
import { join } from "path"
import { senderRole } from "../../agent-role/role"
import { ensureConfigMetadata } from "../../config/config-file"
import { loadEnv } from "../../config/env"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import { parseControlConfig, resolveControlConfig } from "../../tg-ctl/config"
import { type ParseResult } from "../args"
import { askDaemon, parseResolvedSession, tmuxServerPidFromEnv } from "../session-topic"
import { SESSION_LOOKUP_TIMEOUT_MS } from "./constants"
import { applyEmojiEnvOverrides } from "./emoji-env"
import { enforceEscalationGate } from "./escalation-gate"
import { detectAiEmoji, detectAiModel, listEmojiHelpers } from "./model-detect"
import { ownSessionKey, readSessionRegistry } from "./session-helpers"
import { resolveSessionIdentity, type SessionIdentity } from "./session-identity"
import type { RemoteMode } from "../../tg-ctl/remote-config"
import type { Invocation, MergedEnv, RuntimePaths, SendAction, SenderContext } from "./types"

// Info-only flags inspect local state and send nothing, so they must work
// without Telegram credentials configured. Resolve them before the gate.
function handleModelInfoActions(parsed: ParseResult, model: string, aiEmoji: string): void {
  if (parsed.action === "lsEmojiHelpers") {
    writeStdoutLine(listEmojiHelpers())
    process.exit(0)
  }
  if (parsed.action === "detectModel") {
    // codeql[js/clear-text-logging] False positive: `tg --detect-model` prints the model/emoji label on
    // purpose (TG_AI_MODEL/TG_AI_EMOJI or process-ancestry detection). These are display labels, not
    // credentials; TG_BOT_TOKEN is never an input to detectAiModel/detectAiEmoji.
    writeStdoutLine(`${model || "(none)"}\t${aiEmoji || "(none)"}`)
    process.exit(0)
  }
}

function handleDetectAgent(parsed: ParseResult, identity: SessionIdentity, env: MergedEnv): void {
  if (parsed.action !== "detectAgent") return
  // The auto `[window]` label this session's messages get with no flag (the
  // resolver's primary name, or "(none)"), the harness title on a second line
  // when it is shown as the secondary name, and — when the shell's env marks it
  // a subagent (TG_AGENT / RIG_AGENT_ID / RIG_DETACHED_AGENT) — the `[subagent]`
  // bracket it gets, as `subagent: <label>`.
  const name = identity.sessionNameFor(identity.harnessTitle)
  writeStdoutLine(name.primary || "(none)")
  if (name.secondary) writeStdoutLine(`title: ${name.secondary}`)
  const role = senderRole(undefined, env)
  if (role.label) writeStdoutLine(`subagent: ${role.label}`)
  process.exit(0)
}

// --- Escalation-format gate (DENY-BY-DEFAULT) --------------------------
// parseArgs attaches `escalationWarning` when a --tag decision send
// does not follow the decision-request format. By DEFAULT this is a hard stop
// (exit 1): the escalation format is REQUIRED. ESCALATION_GATE_ENFORCE=0 is the
// one documented escape — it downgrades to advisory (warn + proceed). Placed
// BEFORE the credential gate so a block reports the format problem first (and
// so the block path is observable in a no-creds subprocess test). The --table
// path bypasses THIS parse-time gate (stdin unseen) and is validated on the
// final rendered body further below. See args.ts for the validator wiring.
// `escalationWarning` is only ever attached by the escalation-format gate,
// which TAG_GATES registers for ESCALATION_TAGS entries alone — so `tag` is
// always set here; the narrowing guard keeps that explicit rather than
// fabricating a tag word for the Blocked line.
function enforceParseTimeEscalationGate(parsed: ParseResult, env: MergedEnv): void {
  if (parsed.action === "send" && parsed.escalationWarning && parsed.tag !== undefined) {
    enforceEscalationGate(parsed.escalationWarning, parsed.tag, env)
  }
}

// `tg --session-topic`: the forum topic of the session this shell runs in, for a launcher to
// hand to a child that cannot be matched itself (`export TG_TOPIC=$(tg --session-topic)` before
// a nohup-detached `omp -p` worker, which is reparented to pid 1 and so loses the ancestry the
// daemon matches on). Same daemon lookup as a send, creating the topic on the first ask. Prints
// the id, or nothing: outside a session, topics off, daemon down — never an error exit, so the
// launcher's `$(...)` stays harmless.
async function handleSessionTopic(
  parsed: ParseResult,
  identity: SessionIdentity,
  botToken: string | undefined,
  inv: Invocation,
  paths: RuntimePaths,
  remote: RemoteMode,
): Promise<void> {
  if (parsed.action !== "sessionTopic") return
  const { pinned, ancestor, hasSessionIdentity, sessionless } = identity
  const ctl = resolveControlConfig(parseControlConfig(inv.configYamlRaw))
  // A ctl client has no session topics (spec §3): the daemon lives on the server and is never asked.
  const topicsOn = remote.mode !== "client" && (ctl.topics || ctl.privateTopics)
  if (hasSessionIdentity && !sessionless && topicsOn && botToken) {
    const answer = parseResolvedSession(
      await askDaemon(ctlPaths(paths.configDir, botIdFromToken(botToken)).socket, {
        kind: "resolve-session",
        tmuxPane: pinned ? null : (process.env.TMUX_PANE ?? null),
        tmuxServerPid: tmuxServerPidFromEnv(process.env.TMUX),
        ancestorPids: ancestor ? [ancestor.pid] : [],
        sessionKey: pinned?.key ?? null,
      }, SESSION_LOOKUP_TIMEOUT_MS),
    )
    if (answer?.threadId) writeStdoutLine(String(answer.threadId))
  }
  process.exit(0)
}

// `tg --session-id`: the registry key of the session this shell runs in, for a launcher to
// pin a background job to it (`TG_SESSION=<key>`): omp runs such jobs under a shared worker
// broker the job's own `tg` cannot see past (tg-cli#709). Read from the daemon's registry, no
// daemon round-trip. Prints the key, or nothing — never an error exit.
function handleSessionId(parsed: ParseResult, identity: SessionIdentity): void {
  if (parsed.action !== "sessionId") return
  const { sessionless, pinnedKey, sessionsPath, ancestor } = identity
  const key = sessionless ? null : pinnedKey !== undefined ? pinnedKey : ownSessionKey(readSessionRegistry(sessionsPath), ancestor)
  if (key) writeStdoutLine(key)
  process.exit(0)
}

// --dry-run needs no credentials at all: it never reaches the network, so an
// agent can iterate against the escalation-format gate (or any other guard
// below) without TG_BOT_TOKEN/TG_CHAT_ID configured.
function requireCredentials(send: SendAction, botToken: string | undefined, chatId: string | undefined, configDir: string): void {
  if (!send.dryRun && (!botToken || !chatId)) {
    // 78 = EX_CONFIG: distinct from a failed send (1) so a script can tell "set me up" apart.
    console.error(
      `Error: tg is not connected to Telegram — TG_BOT_TOKEN and TG_CHAT_ID must be set in ${join(configDir, ".env")}.\n` +
        "Run `tg auth` to connect in one step (BotFather token + one Start tap).",
    )
    process.exit(78)
  }
}

// Every info action above exited, and parseInvocation exited on help/version/formatHelp/error, so a
// non-send result cannot reach here; the exit keeps the type honest rather than fabricating a send.
function asSendAction(parsed: ParseResult): SendAction {
  if (parsed.action === "send") return parsed
  console.error(`Error: unexpected non-send action '${parsed.action}'`)
  process.exit(1)
}

export async function resolveSender(
  inv: Invocation,
  paths: RuntimePaths,
  remote: RemoteMode = { mode: "local" },
): Promise<{ send: SendAction; sender: SenderContext }> {
  const { parsed } = inv
  // Help/version/error exits above are pure. Refresh editor metadata only for
  // an actionable invocation; every dry-run leaves config and schema untouched.
  if (!inv.rawArgs.includes("--dry-run")) ensureConfigMetadata(paths.configDir)

  const configEnv = loadEnv(join(paths.configDir, ".env"))
  const env = { ...configEnv, ...process.env }

  // Runs before any info-flag handler so --ls-emoji-helpers reflects overrides + emits warnings.
  applyEmojiEnvOverrides(env)
  // Runs once per process, so the ps walk is paid once per send, not per message part.
  const model = detectAiModel(env)
  const aiEmoji = detectAiEmoji(env, model)
  handleModelInfoActions(parsed, model, aiEmoji)

  const identity = resolveSessionIdentity(parsed, env, paths.configDir, remote.mode === "client" ? remote.machine : undefined)
  handleDetectAgent(parsed, identity, env)
  enforceParseTimeEscalationGate(parsed, env)

  const botToken = env.TG_BOT_TOKEN
  const chatId = env.TG_CHAT_ID
  const chatIdNumber = Number(chatId)
  const currentChatId = Number.isFinite(chatIdNumber) ? chatIdNumber : undefined

  await handleSessionTopic(parsed, identity, botToken, inv, paths, remote)
  handleSessionId(parsed, identity)

  const send = asSendAction(parsed)
  requireCredentials(send, botToken, chatId, paths.configDir)

  // Honor TG_API_BASE (default api.telegram.org) — same as the tg-ctl daemon — so a test
  // harness can point the OUTBOUND sender at a mock Bot-API server (review qa bot harness).
  const api = `${process.env.TG_API_BASE || "https://api.telegram.org"}/bot${botToken}`

  return { send, sender: { env, model, aiEmoji, botToken, chatId, currentChatId, api, ...identity } }
}
