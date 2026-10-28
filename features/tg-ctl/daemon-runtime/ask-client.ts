// daemon-runtime/ask-client: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { createConnection } from "net"
import { envRole } from "../../agent-role/role"
import { parseProcList } from "../discover"
import { ancestorPidChain, type AskerIdentity } from "../session-topics"
import { tmuxServerPidFromEnv } from "../../cli/session-topic"
import { buildClaudeQuestionAnswerOutput, clampRequestTimeoutMs, collectQuestionAnswers, isHatchRequest, repairClaudeQuestionReply, type ButtonRequest } from "../questions"
import { parseWithdrawArgv, WITHDRAW_USAGE } from "../question-inbox"
import { normalizeHookRequests, type HookEnv } from "../hook-normalize"
import { GENERIC_ASK_ORIGIN_AGENT, genericAskDaemonAbandonMs, isPrivateOwnerChatId, resolveGenericAskVerdict, type GenericAskTimeout } from "../generic-ask"
import { HOOK_AGENT_KINDS, isHookAgentKind, type HookAgentKind } from "../types"
import { log, readStdinText, type Ctx } from "./ctx-io"
import { SUBPROC_ENV } from "./tmux-probe"
import { type AskStatusLine } from "./button-requests"

// The agent kind the hook was installed for (`tg-ctl ask --agent codex`). Decides
// how the raw payload is normalized + formatted. The accepted set is
// HOOK_AGENT_KINDS (features/tg-ctl/types.ts) — an exhaustiveness-checked single
// source, so a future harness kind forces a compile error there, never a silent
// fallthrough. An ABSENT flag defaults to claude (back-compat with hook installs
// older than the selector); a PRESENT-but-unrecognized value still defaults to
// claude but logs a warning — coercing it silently would hand a typo'd or
// newer-than-the-daemon kind claude semantics with zero signal.
export function hookAgentFromArgv(): HookAgentKind {
  const i = process.argv.indexOf("--agent")
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (v && isHookAgentKind(v)) return v
  if (v) log(`ask: unrecognized --agent '${v}' — falling back to claude (known: ${HOOK_AGENT_KINDS.join("/")})`)
  return "claude"
}

export function tmuxSessionName(): string | undefined {
  return tmuxDisplay("#{session_name}")
}

export function tmuxWindowName(): string | undefined {
  return tmuxDisplay("#{window_name}")
}

export function tmuxDisplay(format: string): string | undefined {
  if (!process.env.TMUX) return undefined
  try {
    const r = Bun.spawnSync(["tmux", "display-message", "-p", format], { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
    if (r.exitCode === 0) return r.stdout.toString().trim() || undefined
  } catch {}
  return undefined
}

// One result of a single hook-socket attempt. `response` is a COMPLETE reply (a
// newline-terminated line the daemon wrote before closing — including a legitimate
// "null" decline); `dropped` is a connection that closed/errored WITHOUT a complete
// reply (daemon down, restarting, or died mid-block); `timeout` is the overall
// budget elapsing. The distinction is what makes reconnect safe: only `dropped` is
// retried — a real "null" decline is honored, not looped.
export type AskAttempt = { kind: "response" | "dropped" | "timeout"; raw: string | null; statuses: AskStatusLine[] }

export function parseAskStatus(line: string): AskStatusLine | null {
  try {
    const v = JSON.parse(line) as { tgctl?: unknown; state?: unknown }
    if (v && typeof v === "object" && v.tgctl === "ask-status" && typeof v.state === "string") {
      return v as AskStatusLine
    }
  } catch {}
  return null
}

// Everything the daemon wrote before the socket went away: status lines (kept) and the
// final reply (the LAST newline-terminated non-status line; `null` is a real decline).
// `end` with no complete reply line is a drop (the daemon closed mid-block) — a status
// line alone does not make a response, so the reconnect loop still resends.
export function parseAskStream(raw: string, how: "end" | "dropped" | "timeout"): AskAttempt {
  const statuses: AskStatusLine[] = []
  let reply: string | null | undefined
  for (const line of raw.split("\n").slice(0, -1)) {
    const status = parseAskStatus(line)
    if (status) statuses.push(status)
    else reply = line.trim() || null
  }
  if (how !== "end") return { kind: how, raw: null, statuses }
  if (reply === undefined) return { kind: "dropped", raw: null, statuses }
  return { kind: "response", raw: reply, statuses }
}

// `tg-ctl ask --verify-grant <approval_id> --hook <hook_id>` (TOKEN path) or
// `tg-ctl ask --verify-grant --pull --hook <hook_id>` (PULL path) — the grant
// consume client (contract §5 + pull-model, tg-cli#398). stdin carries the
// normalized payload (with the recomputed `operation`); the daemon answers
// immediately. Modeled on hookAgentFromArgv's argv-scan style.
export interface VerifyGrantArgv {
  approvalId?: string
  pull: boolean
  hookId?: string
}

export function verifyGrantArgvFrom(args: string[]): VerifyGrantArgv | null {
  const i = args.indexOf("--verify-grant")
  if (i < 0) return null
  const out: VerifyGrantArgv = { pull: args.includes("--pull") }
  const maybeId = args[i + 1]
  if (maybeId && !maybeId.startsWith("--")) out.approvalId = maybeId
  const h = args.indexOf("--hook")
  const hookId = h >= 0 ? args[h + 1] : undefined
  if (hookId && !hookId.startsWith("--")) out.hookId = hookId
  return out
}

// The verify-grant round-trip: one short socket exchange (the daemon answers
// immediately — no human in the loop — so 30s is a generous ceiling), then
// print the daemon's reply JSON VERBATIM on stdout. Exit 0 ALWAYS; the outcome
// rides stderr. Fail CLOSED on any transport failure (daemon down, old daemon
// that drops the unknown marker with `null`, timeout): a deny envelope on
// stdout so the calling hook blocks the operation — never an empty stdout that
// a lenient caller could misread as "no objection".
export async function verifyGrantDaemon(ctx: Ctx, argv: VerifyGrantArgv, stdinPayload: unknown): Promise<void> {
  const denyUnreachable = (why: string): void => {
    log(`verify-grant failed-closed: ${why}`)
    writeStdoutLine(
      JSON.stringify({
        requestId: null,
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: `tg-ctl grant verification failed closed: ${why}` },
        },
      }),
    )
  }
  if (!argv.hookId || (!argv.pull && !argv.approvalId)) {
    denyUnreachable("malformed invocation — need --hook <hook_id> and either --verify-grant <approval_id> or --verify-grant --pull")
    return
  }
  const line = JSON.stringify({
    tgctl: "verify-grant",
    hookId: argv.hookId,
    ...(argv.pull ? { pull: true } : { approvalId: argv.approvalId }),
    payload: stdinPayload ?? null,
  })
  const attempt = await oneAskAttempt(ctx, line, 30_000)
  if (attempt.kind === "response" && attempt.raw && attempt.raw !== "null") {
    writeStdoutLine(attempt.raw)
    // Outcome on stderr (contract §5: exit 0 always, verdict rides stderr) —
    // the human/lib reading the terminal sees WHY alongside the stdout JSON.
    try {
      const parsed = JSON.parse(attempt.raw) as { approvalId?: string; requestId?: string | null }
      log(
        parsed.approvalId
          ? `grant consumed: approvalId=${parsed.approvalId} requestId=${parsed.requestId ?? "-"}`
          : `grant denied: requestId=${parsed.requestId ?? "-"}`,
      )
    } catch {
      log(`grant verify reply (unparsable): ${attempt.raw}`)
    }
    return
  }
  // An OLD daemon doesn't know the marker: it drops the line as
  // unparsable-payload and replies `null` — fail closed (the correct
  // self-healing behavior; the lib surfaces this as a deny).
  denyUnreachable(
    attempt.kind === "response"
      ? "daemon declined the verify-grant request (older daemon without grant support)"
      : `daemon unreachable (${attempt.kind})`,
  )
}

// Overall hook budget. Kept UNDER the 120s the harness gives the hook process so the
// reconnect loop returns a real answer (or null) before the harness kills it. Skipped
// entirely for a CRITICAL ask (tg-cli#403) — see askDaemon's deadline computation.
// Env-overridable ONLY for tests to prove the non-critical/critical contrast without a
// real 115s wait (mirrors UNSCOPED_ABANDON_MS's own clamp: setTimeout silently clamps
// any delay > 2^31-1 ms to ~1ms, so an oversized override is clamped rather than
// flipping into an immediate false timeout); production never sets it.
export const ASK_TOTAL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.TG_CTL_ASK_TOTAL_TIMEOUT_MS)
  const TIMEOUT_MAX = 2_147_483_647
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, TIMEOUT_MAX) : 115_000
})()

// How often `tg-ctl ask` checks that the process that asked is still alive (tg-cli#717).
export const ORPHAN_CHECK_MS = 2_000

// Backoff between reconnect attempts. Also lets a LIVE daemon's socket-close handler
// run (moving the entry to `abandoned`) BEFORE the resend lands, so the resend
// re-attaches instead of racing the in-flight dedup.
export const ASK_RECONNECT_BACKOFF_MS = 250

export function oneAskAttempt(ctx: Ctx, requestLine: string, timeoutMs: number): Promise<AskAttempt> {
  return new Promise<AskAttempt>((resolve) => {
    let done = false
    let raw = ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (how: "end" | "dropped" | "timeout"): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(parseAskStream(raw, how))
    }
    const socket = createConnection(ctx.paths.socket)
    // tg-cli#403 CRITICAL LANDMINE: `timeoutMs` is `Infinity` for a critical ask
    // (askDaemon's deadline is Infinity, and Date.now() subtracted from Infinity
    // is still Infinity). Node/Bun's setTimeout silently CLAMPS any delay beyond
    // 2^31-1 ms (32-bit signed overflow) to ~1ms and fires almost immediately —
    // passing Infinity straight to setTimeout would flip "wait forever" into "time
    // out instantly", the EXACT OPPOSITE of critical mode's intent. Skip scheduling
    // the timer entirely when the delay isn't finite; the promise then resolves
    // purely from the socket's own data/end/error/close events, with no deadline
    // to race against at all — the "skip scheduling" fix this ticket explicitly
    // prescribes over clamping, since clamping still needs SOME real bound to
    // clamp TO, which a genuinely unbounded critical wait doesn't have.
    timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          socket.destroy()
          finish("timeout")
        }, timeoutMs)
      : undefined
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(requestLine + "\n"))
    socket.on("data", (chunk) => {
      raw += chunk
    })
    socket.on("error", () => finish("dropped"))
    // A complete reply always ends in a newline (the daemon's socket.end(`${out}\n`));
    // EOF with no complete reply line means the daemon closed without answering → a drop
    // to retry (parseAskStream decides, so an interim status line alone is not a reply).
    socket.on("end", () => finish("end"))
    socket.on("close", () => finish("dropped"))
  })
}

// Reconnect-and-resend the SAME requestId across a mid-block socket drop (lossless
// restart): a SCOPED question whose daemon restarted (crash-relaunch in ~1s, or a
// deliberate stop+start) keeps trying until the restored daemon answers — it either
// re-attaches the still-pending entry (no duplicate card) or replays the stored
// answer. Bounded by the caller's deadline (shared across a multi-question
// sequence); a real "null" decline returns immediately.
export async function requestHookAnswerWithReconnect(ctx: Ctx, requestLine: string, deadline: number): Promise<AskAttempt> {
  let announcedDrop = false
  let last: AskAttempt = { kind: "timeout", raw: null, statuses: [] }
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return last
    const res = await oneAskAttempt(ctx, requestLine, remaining)
    if (res.kind !== "dropped") return { ...res, statuses: [...last.statuses, ...res.statuses] }
    // ACCUMULATE, never replace (review finding, x2 independent reviewers): a `posted`
    // status learned on an earlier attempt (daemon posted the card, then crashed
    // mid-wait) must survive every later attempt that cannot even connect
    // (`statuses: []` on ECONNREFUSED) — otherwise the deadline verdict below loses
    // the one fact that proves the card is genuinely live in Telegram, reintroducing
    // this file's own incident as "unreachable" for a card that was posted.
    last = { ...res, statuses: [...last.statuses, ...res.statuses] }
    if (!announcedDrop) {
      log("ask reconnect: daemon socket dropped — resending requestId until it comes back")
      announcedDrop = true
    }
    const backoff = Math.min(ASK_RECONNECT_BACKOFF_MS, Math.max(0, deadline - Date.now()))
    if (backoff > 0) await new Promise((r) => setTimeout(r, backoff))
  }
}

// One daemon round-trip for one ButtonRequest, within the caller's deadline.
// SCOPED questions and SCOPED permissions reconnect-and-resend across a daemon
// restart: both are retained on socket close (abandoned map + persist), so a
// resend re-attaches to the existing card rather than posting a duplicate.
// UNSCOPED requests keep the single-attempt path — they aren't retained (no
// pane to late-deliver to), so a resend after a restart would post a duplicate
// card.
export async function askDaemonOnce(ctx: Ctx, req: ButtonRequest, deadline: number): Promise<AskAttempt> {
  const requestLine = JSON.stringify(req)
  const reconnectable = Boolean(req.paneId) && (req.kind === "question" || req.kind === "permission")
  if (reconnectable) return requestHookAnswerWithReconnect(ctx, requestLine, deadline)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { kind: "timeout", raw: null, statuses: [] }
  return oneAskAttempt(ctx, requestLine, remaining)
}

type PostedStatus = Extract<AskStatusLine, { state: "posted" }>
type DroppedStatus = Extract<AskStatusLine, { state: "dropped" }>
type ExpiredStatus = Extract<AskStatusLine, { state: "expired" }>

// The truthful client-side verdict for a request that produced no usable reply
// (tg-cli#317). The asking agent reads this line — the agent-tools hatch helper forwards
// hook stderr into its deny reason — so it must say what the daemon actually did: a card
// that WAS posted is never reported as "not-posted", and a daemon expiry is an expiry.
export function describeAskOutcome(req: ButtonRequest, attempt: AskAttempt): string {
  const who = `req=${req.requestId} agent=${req.agent} pane=${req.paneId ?? "-"}`
  const posted = attempt.statuses.find((s): s is PostedStatus => s.state === "posted")
  const dropped = attempt.statuses.find((s): s is DroppedStatus => s.state === "dropped")
  const expired = attempt.statuses.find((s): s is ExpiredStatus => s.state === "expired")
  // A reconnect that lands AFTER the human already tapped the card is answered —
  // the daemon delivered the decision via pane injection (no live socket to answer
  // on) and drops this stale resend with reason=already-pane-delivered (review
  // finding: checked ahead of the generic `posted` branch below, which would
  // otherwise report a real decision as "the daemon closed with no decision" —
  // the exact class of false claim this file exists to eliminate).
  if (dropped?.reason === "already-pane-delivered") {
    return `ask-forward answered-via-pane: ${who} messageId=${posted?.messageId ?? "-"} — the human already answered this card; delivered directly to the pane, not through this hook`
  }
  if (expired) {
    // The unscoped-abandon timer is armed BEFORE `sendMessage` resolves (review
    // finding): if Telegram is slow and the timer fires first, `expired.messageId`
    // is still null — no card was ever posted, and asserting "posted to Telegram"
    // would be exactly the false claim tg-cli#317 exists to eliminate.
    const where = expired.messageId !== null ? "posted to Telegram" : "the send to Telegram had not completed"
    return `ask-forward expired: ${who} messageId=${expired.messageId ?? "-"} — ${where}; no decision within ${expired.ageMs}ms (daemon expiry, nobody tapped)`
  }
  if (posted && attempt.kind === "timeout") {
    return `ask-forward timed-out: ${who} messageId=${posted.messageId} — posted to Telegram; no decision within this hook's ${clampRequestTimeoutMs(req.timeoutMs, ASK_TOTAL_TIMEOUT_MS)}ms budget (the card stays answerable for late delivery)`
  }
  if (posted) {
    // `attempt.kind` here is only ever "response" (an explicit `null` reply) or
    // "dropped" ("timeout" was handled above) — spell those out rather than
    // printing the bare internal enum (review finding: "(response)"/"(dropped)"
    // is jargon to whoever reads the hook/daemon log this line is meant for).
    const how = attempt.kind === "response" ? "explicit null reply" : "connection lost after posting"
    return `ask-forward declined-after-post: ${who} messageId=${posted.messageId} — posted to Telegram; the daemon closed with no decision (${how})`
  }
  if (dropped) return `ask-forward not-posted: ${who} — daemon declined: reason=${dropped.reason}`
  if (attempt.kind === "timeout") {
    return `ask-forward timed-out: ${who} — no reply and no status line from the daemon within ${clampRequestTimeoutMs(req.timeoutMs, ASK_TOTAL_TIMEOUT_MS)}ms`
  }
  if (attempt.kind === "dropped") return `ask-forward unreachable: ${who} — daemon socket closed or errored without a reply`
  return `ask-forward not-posted: ${who} — daemon declined or unreachable (no status line: a daemon older than tg-cli#317 cannot say which)`
}

// Who this `tg-ctl ask` process is (tg-cli#717): its pid chain and its tmux pane — the daemon
// matches them against the session registry so the card lands in the asking session's topic
// (an explicit TG_SESSION pin rides as `sessionPin`). Best effort: a failed `ps` leaves the
// pid chain empty.
export function askerIdentity(): AskerIdentity {
  let ancestorPids: number[] = []
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe" })
    if (ps.exitCode === 0) ancestorPids = ancestorPidChain(parseProcList(ps.stdout.toString()), process.ppid)
  } catch {
    // no process table — the session is found by its pin or pane alone
  }
  return {
    ancestorPids,
    tmuxPane: process.env.TMUX_PANE || null,
    tmuxServerPid: tmuxServerPidFromEnv(process.env.TMUX),
  }
}

export async function askDaemon(ctx: Ctx): Promise<void> {
  const input = await readStdinText()
  if (!input.trim()) return
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    return
  }
  const env = hookEnvForThisInvocation()
  // Normalize the harness's raw hook payload (or an already-normalized request)
  // into ButtonRequests, filling routing fields from the hook process's own
  // env. A claude AskUserQuestion with 2-4 questions yields one request PER
  // question; everything else yields exactly one. null → unsupported shape;
  // emit nothing so the local agent UI takes over.
  const normalized = normalizeHookRequests(payload, env)
  if (!normalized) {
    // Unsupported payload shape (multi-select / free-form / an event we don't
    // forward). This never reaches the daemon, so the daemon log can't see it —
    // emit here (hook process stderr) so the drop isn't silent.
    log(`ask-forward dropped: reason=unsupported-payload agent=${env.agent} pane=${env.paneId ?? "-"} cwd=${env.cwd ?? "-"}`)
    return
  }
  // tg-cli#717: who is asking, so the daemon posts the card in the asking session's topic.
  const asker = askerIdentity()
  const reqs = normalized.map((r) => ({ ...r, asker }))
  // A stopped or orphaned asker withdraws its cards — except a hatch ask: its asker being
  // killed (a `gh ship` timeout) is exactly when the #398 late approval matters, and a withdraw
  // would retire the grace record that lets a later Approve mint a grant for the retry. Its card
  // closes on the retry (superseded), a decision, or an explicit `tg-ctl withdraw`.
  const withdrawable = reqs.filter((r) => !isHatchRequest(r)).map((r) => r.requestId)
  withdrawOnSignal(ctx, withdrawable)
  withdrawWhenOrphaned(ctx, withdrawable)
  const deadline = askDeadline(reqs)
  if (reqs.length === 1) await answerSingleQuestion(ctx, reqs[0], deadline)
  else await answerQuestionSet(ctx, reqs, deadline)
}

// `invocationNonce`: a random id generated ONCE per `tg-ctl ask` PROCESS —
// the harness spawns a fresh process for EVERY tool/permission/question hook
// event, so this is a true per-INVOCATION identity, stronger than (and not
// dependent on) any field the harness itself may or may not send
// (Claude Code's `prompt_id` / Codex's `turn_id` identify the whole prompt
// TURN, not the individual tool call — two distinct tool invocations with
// byte-identical input in the SAME turn would otherwise share a requestId;
// review finding, tg#9982 follow-up). Threaded into every requestId hash
// (hook-normalize.ts) and into ButtonRequest.promptTurnId, so a queued
// permission decision's no-time-bound auto-delivery (see AGENTS.md's "Queued
// permission decisions") is scoped to THIS exact invocation: the SAME
// process's own reconnect-and-resend loop reuses this same requestLine/nonce
// (requestHookAnswerWithReconnect resends the identical serialized `req`), so
// a genuine reconnect still matches; a genuinely later invocation is always a
// NEW process with a NEW nonce and can never collide.
function hookEnvForThisInvocation(): HookEnv {
  return {
    agent: hookAgentFromArgv(),
    paneId: process.env.TMUX_PANE || undefined,
    cwd: process.cwd(),
    sessionName: tmuxSessionName(),
    windowName: tmuxWindowName(),
    subagent: envRole(process.env).label,
    invocationNonce: crypto.randomUUID(),
    sessionPin: process.env.TG_SESSION?.trim() || undefined,
  }
}

// ONE deadline shared by the whole call (all cards of a multi-question), kept
// under the harness's 120s hook budget so we always answer before it kills us.
//
// tg-cli#403: a CRITICAL request (never true for a multi-question set in
// practice — critical is a hatch/permission-only opt-in) removes this bound
// entirely. `Infinity` is a safe DEADLINE sentinel (never passed directly to
// setTimeout): `Date.now() < Infinity` is always true, and `Infinity - x` stays
// `Infinity` through every downstream subtraction (requestHookAnswerWithReconnect's
// `remaining`, askDaemonOnce's `remaining`) — every one of THOSE call sites turns
// its own "remaining" into an actual setTimeout delay only inside oneAskAttempt,
// which explicitly skips scheduling when the delay isn't finite (see its own doc
// comment on the 32-bit setTimeout overflow clamp this guards against).
//
// Contract §1 (tg-cli#398): for a non-critical request, a per-request
// timeoutMs (the agent-tools lib sends 600000 for hatch asks) extends the
// deadline instead, clamped to the 15-min cap; absent/invalid → the
// unchanged 115s default. (A hatch ask carrying 600000 still answers EARLY
// the moment a tap lands — the deadline is only the wait ceiling.)
function askDeadline(reqs: ButtonRequest[]): number {
  return reqs.some((r) => r.critical === true)
    ? Infinity
    : Date.now() + clampRequestTimeoutMs(reqs[0].timeoutMs, ASK_TOTAL_TIMEOUT_MS)
}

async function answerSingleQuestion(ctx: Ctx, req: ButtonRequest, deadline: number): Promise<void> {
  const attempt = await askDaemonOnce(ctx, req, deadline)
  const output = attempt.raw
  if (output && output !== "null") {
    // Repair a claude-question reply from a STALE RUNNING daemon that predates
    // `hookEventName` in the answer envelope (Claude Code discards the whole
    // hook output without it — tg#5741); anything else passes through verbatim.
    writeStdoutLine(repairClaudeQuestionReply(req, output) ?? output)
  } else {
    // No usable reply: the harness UI takes over. Say exactly what happened — posted
    // then expired, dropped (with the daemon's reason), timed out, or unreachable —
    // because the asking agent acts on this line (tg-cli#317).
    log(describeAskOutcome(req, attempt))
  }
}

// Multi-question (claude AskUserQuestion, 2-4 questions): one SEQUENTIAL card
// per question — the next card posts only after the previous answer — then ONE
// combined PreToolUse reply with the full answers record, so the tool completes
// with no local dialog and no manual Enter (tg#5741). ALL-OR-NOTHING: any
// decline/timeout emits nothing and the local UI re-asks everything (a partial
// answers record would silently skip the unanswered questions).
async function answerQuestionSet(ctx: Ctx, reqs: ButtonRequest[], deadline: number): Promise<void> {
  const answers = await collectQuestionAnswers(reqs, (r) => askDaemonOnce(ctx, r, deadline).then((a) => a.raw))
  const toolInput = reqs[0].toolInput
  if (answers && toolInput) {
    writeStdoutLine(JSON.stringify(buildClaudeQuestionAnswerOutput(toolInput, answers)))
  } else {
    log(
      `ask-forward multi-question not-completed: req=${reqs[0].requestId} n=${reqs.length} pane=${reqs[0].paneId ?? "-"} — declined, timed out, or partial; local UI takes over`,
    )
  }
}

// Generic blocking approval (tg-cli#149): `tg-ctl ask "<question>"` posts an
// Approve/Reject card and waits. Only a verified Telegram tap exits 0; reject,
// timeout, an unreachable daemon or a malformed reply exit 1 (fail closed).
export async function runGenericAsk(ctx: Ctx, question: string, timeout: GenericAskTimeout, ownerOnly = false): Promise<number> {
  if (ownerOnly && !isPrivateOwnerChatId(ctx.chatId)) {
    console.error("denied: --owner-only needs a positive private TG_CHAT_ID")
    return 1
  }
  if (timeout.warning) console.error(`tg-ctl ask: ${timeout.warning}`)
  const req: ButtonRequest = {
    requestId: crypto.randomUUID(),
    agent: "claude",
    kind: "permission",
    question,
    cwd: process.cwd(),
    // The daemon keeps the card a margin past the client's own deadline, so the
    // client's timeout is the one that fires; clamped to the daemon's 15-min cap.
    timeoutMs: genericAskDaemonAbandonMs(timeout.seconds),
    origin: { agent: GENERIC_ASK_ORIGIN_AGENT },
    asker: askerIdentity(),
    ...(ownerOnly ? { ownerOnly: true } : {}),
  }
  log(`generic-ask requested: requestId=${req.requestId} timeoutS=${timeout.seconds} cwd=${req.cwd}`)
  withdrawOnSignal(ctx, [req.requestId])
  const attempt = await oneAskAttempt(ctx, JSON.stringify(req), timeout.seconds * 1000)
  if (attempt.kind === "dropped") {
    console.error("denied: daemon unreachable — is it running? try `tg-ctl start`")
    log(`generic-ask denied: requestId=${req.requestId} reason=daemon-unreachable`)
    return 1
  }
  if (attempt.kind === "timeout") {
    console.error(`denied: timeout after ${timeout.seconds}s`)
    log(`generic-ask denied: requestId=${req.requestId} reason=timeout`)
    return 1
  }
  const verdict = resolveGenericAskVerdict(attempt.raw)
  if (verdict.exitCode === 0) {
    writeStdoutLine(verdict.detail ? `approved: ${verdict.detail}` : "approved")
    log(`generic-ask approved: requestId=${req.requestId}`)
    return 0
  }
  console.error(verdict.reason)
  log(`generic-ask denied: requestId=${req.requestId} reason=${verdict.reason}`)
  return 1
}

// One withdraw line to the daemon (tg-cli#705): resolves with how many cards it closed, or
// null when the daemon could not be reached or did not answer within `timeoutMs` (an older
// daemon replies `null` to a line it does not know).
export function sendWithdrawLine(ctx: Ctx, line: Record<string, string>, timeoutMs: number): Promise<number | null> {
  const { promise, resolve } = Promise.withResolvers<number | null>()
  let raw = ""
  const socket = createConnection(ctx.paths.socket)
  const timer = setTimeout(() => {
    socket.destroy()
    resolve(null)
  }, timeoutMs)
  socket.setEncoding("utf8")
  socket.on("connect", () => socket.write(`${JSON.stringify(line)}\n`))
  socket.on("data", (chunk) => {
    raw += chunk
  })
  // 'close' follows 'error' too; the first resolve wins.
  socket.on("close", () => {
    clearTimeout(timer)
    let closed: unknown
    try {
      const reply: unknown = JSON.parse(raw.trim())
      closed = reply && typeof reply === "object" ? (reply as Record<string, unknown>).closed : undefined
    } catch {
      closed = undefined
    }
    resolve(typeof closed === "number" ? closed : null)
  })
  socket.on("error", () => {})
  return promise
}

// How long a stopping asker waits for its withdraw to land before it exits anyway.
export const WITHDRAW_ON_SIGNAL_MS = 1500

export const SIGNAL_NUMBERS: Record<"SIGHUP" | "SIGINT" | "SIGTERM", number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

// An asker stopped while it waits (its harness gave up on the hook, the terminal closed,
// Ctrl-C) withdraws its cards so they leave the chat and the 📥 Inbox instead of waiting for a
// Dismiss (tg-cli#705). Best effort: SIGKILL cannot be caught — the daemon then only sees the
// socket close and the card stays open. Exits with the conventional 128+signal status; the
// withdraw itself ends the ask with a `null` reply, so the ask entrypoint awaits
// `signalExit` before its own exit and the signal status wins.
export let signalExit: Promise<unknown> | null = null

export function withdrawOnSignal(ctx: Ctx, requestIds: readonly string[]): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (signalExit) return
      const reason = `the asking process was stopped (${signal})`
      signalExit = Promise.all(requestIds.map((id) => sendWithdrawLine(ctx, { withdraw: id, reason }, WITHDRAW_ON_SIGNAL_MS))).finally(() =>
        process.exit(128 + SIGNAL_NUMBERS[signal]),
      )
    })
  }
}

// tg-cli#717: whoever asked waits on our stdout. If it dies (a `gh ship` killed by its timeout)
// we are reparented and nobody can use the answer: withdraw the cards that are no longer
// relevant (tg-cli#705) and exit, instead of a critical ask waiting forever with its card open.
// The exit closes the socket, which retires anything not withdrawn.
export function withdrawWhenOrphaned(ctx: Ctx, requestIds: readonly string[]): void {
  const askerPid = process.ppid
  setInterval(() => {
    // ppid 1: the asker may already be gone before this process read its ppid.
    if (signalExit || (process.ppid === askerPid && process.ppid !== 1)) return
    log(`ask-forward orphaned: asker pid ${askerPid} exited — withdrawing`)
    const reason = "the asking process exited"
    signalExit = Promise.all(requestIds.map((id) => sendWithdrawLine(ctx, { withdraw: id, reason }, WITHDRAW_ON_SIGNAL_MS))).finally(() =>
      process.exit(0),
    )
  }, ORPHAN_CHECK_MS).unref()
}

// `tg-ctl withdraw <requestId> | --hook-id <id> [--cwd <dir>] [--reason <text>]` — close cards
// whose question is no longer relevant (tg-cli#705), for wrappers like the agent-tools hatch
// helper. Exit 0: at least one card closed; 1: no open card matched; 2: usage; 69: the daemon
// is not reachable.
export async function runWithdrawCommand(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const parsed = parseWithdrawArgv(argv)
  if ("error" in parsed) {
    console.error(`tg-ctl withdraw: ${parsed.error}\n${WITHDRAW_USAGE}`)
    return 2
  }
  const closed = await sendWithdrawLine(ctx, parsed.line, 5000)
  if (closed === null) {
    console.error("tg-ctl withdraw: the daemon is not reachable (or predates withdraw) — is it running? try `tg-ctl start`")
    return 69
  }
  writeStdoutLine(closed === 0 ? "no open question matched" : `withdrawn: ${closed} card${closed === 1 ? "" : "s"}`)
  return closed === 0 ? 1 : 0
}
