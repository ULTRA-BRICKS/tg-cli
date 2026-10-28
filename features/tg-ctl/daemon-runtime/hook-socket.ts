// daemon-runtime/hook-socket: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { chmodSync, unlinkSync } from "fs"
import { isRecord } from "../guards"
import { createServer, type Server, type Socket } from "net"
import { hookSessionKey } from "../harness-sessions"
import { pinnedSession } from "../session-registry-store"
import { sessionAtPane } from "../session-target"
import { findSessionForAsker, parseResolveSessionRequest, parseTopicResult } from "../session-topics"
import { buildAnsweredQuestionText, buildButtonMessage, callbackRequestId, formatAgentHookOutput, hatchParseMode, isHatchPermissionRequest, type ButtonAnswer, type ButtonRequest } from "../questions"
import { CLOSE_STATUS, hatchSiblingKeys, parseWithdrawLine, type WithdrawRequest } from "../question-inbox"
import { grantDenyReasonText, pullGrant, type GrantRecord, type VerifyGrantOutcome, routeForRequest, verifyGrant } from "../grants"
import { isGenericAskRequest, isPrivateOwnerChatId } from "../generic-ask"
import { log, type Ctx } from "./ctx-io"
import { applyRemoteRecordLine, remoteStatusReply } from "./remote-hub"
import { ANSWERED_REPLAY_MS, MAX_HOOK_REQUEST_BYTES, canForwardButtonRequest, decideQueuedPermissionReconnect, describeAskRequest, describeHookLine, describeRegistration, dropAsk, hookMatchesRegistration, normalizeButtonRequest, type AbandonedButton, type PendingButton, type QuestionRuntime, writeAskStatus } from "./button-requests"
import { clearSessionTopicMisses, currentSessionRegistry, handleResolveSession, liveEntry, noteSessionTopicMiss, recordHookSession } from "./session-registry"
import { armPendingSocketClose, forwardAndPostQuestion, withdrawCards } from "./question-cards"
import { readRegistrations } from "./pane-discovery"
import { clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"

export function startHookServer(ctx: Ctx, rt: QuestionRuntime): Server | null {
  try {
    try {
      unlinkSync(ctx.paths.socket)
    } catch {}
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      let raw = ""
      socket.on("data", (chunk) => {
        raw += chunk
        const newline = raw.indexOf("\n")
        if (newline === -1) {
          // A hook request is a single small JSON line; anything bigger is a
          // misbehaving client trying to grow the buffer forever.
          if (raw.length > hookLineCap(raw)) socket.destroy()
          return
        }
        const line = raw.slice(0, newline).trim()
        raw = raw.slice(newline + 1)
        void handleHookSocketLine(ctx, rt, socket, line)
      })
    })
    server.on("error", (err) => {
      log(`hook socket failed: ${err}`)
    })
    server.listen(ctx.paths.socket, () => {
      // Owner-only: the socket answers with approved hook JSON, so other local
      // users must not be able to connect (the guard trusts client-sent fields).
      try {
        chmodSync(ctx.paths.socket, 0o600)
      } catch {}
    })
    return server
  } catch (err) {
    log(`hook socket failed: ${err}`)
    return null
  }
}

// A hook request is one small line, but `tg-remote server` relays a whole message record. The wire
// contract caps a request at 1 MiB (spec §4: 256 KiB of history text, which JSON escaping can inflate
// several times over), and the relay adds a short `{kind, peer}` wrapper: only a line that announces
// itself as a remote record, in its first bytes, may be that long.
const MAX_REMOTE_LINE_BYTES = 1024 * 1024 + 8 * 1024
const REMOTE_RECORD_PREFIX = /^\{\s*"kind"\s*:\s*"remote-record"/

function hookLineCap(raw: string): number {
  return REMOTE_RECORD_PREFIX.test(raw.slice(0, 64)) ? MAX_REMOTE_LINE_BYTES : MAX_HOOK_REQUEST_BYTES
}

// `tg-remote server` (the forced SSH command of a client machine) asks the daemon to record one
// message sent from that machine, or for its status (spec §4.1). The peer is checked against this
// host's own control.remote_machines inside, never trusted from the line. Dispatched before
// normalization like the other control lines; a host that serves no machine answers PEER_UNKNOWN.
function answerRemoteLine(ctx: Ctx, socket: Socket, parsedLine: unknown): boolean {
  if (!isRecord(parsedLine)) return false
  if (parsedLine.kind !== "remote-record" && parsedLine.kind !== "remote-status") return false
  const reply = parsedLine.kind === "remote-record" ? applyRemoteRecordLine(ctx, parsedLine) : remoteStatusReply(ctx, parsedLine)
  socket.end(`${JSON.stringify(reply)}\n`)
  return true
}

function parseHookLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

// Lines that are NOT a ButtonRequest, dispatched by their marker BEFORE normalization so an
// old/normalized-looking payload can never be confused with a question forward. Resolves true
// when the line was one of them (and answered).
async function dispatchControlLine(ctx: Ctx, rt: QuestionRuntime, socket: Socket, parsedLine: unknown): Promise<boolean> {
  if (answerRemoteLine(ctx, socket, parsedLine)) return true
  // The verify-grant exchange (grant protocol v1.1, tg-cli#398).
  // Cross-repo compatibility: an OLD daemon (no marker handling)
  // receives this line, fails normalizeButtonRequest, and drops it as
  // "unparsable-payload" with a `null` reply — the new lib's client fails
  // CLOSED on that (deny), which is the correct self-healing behavior.
  // codeql[js/user-controlled-bypass] False positive: this is a dispatch marker, not an authorization check.
  // A line claiming tgctl=verify-grant only routes to handleVerifyGrantRequest, which authorizes by itself:
  // it requires a hook id and an approval id or pull, and verifyGrant/pullGrant must find an unexpired,
  // unconsumed grant minted by the owner's Telegram tap in the daemon's grant store; anything else is denied
  // fail-closed. The socket is 0600 owner-only. Covered by the grant/hatch integration tests.
  if (parsedLine && typeof parsedLine === "object" && (parsedLine as { tgctl?: unknown }).tgctl === "verify-grant") {
    await handleVerifyGrantRequest(ctx, rt, socket, parsedLine as Record<string, unknown>)
    return true
  }
  // `tg`'s session-topic lines (spec §4.3/§4.5, tg-cli#467), also dispatched before
  // normalization. An old daemon drops them as unparsable with a `null` reply, which `tg`
  // reads as "no topic" and posts to General.
  const lookup = parseResolveSessionRequest(parsedLine)
  if (lookup) {
    await handleResolveSession(ctx, socket, lookup)
    return true
  }
  const topicResult = parseTopicResult(parsedLine)
  if (topicResult) {
    await handleTopicResultLine(ctx, socket, topicResult)
    return true
  }
  // tg-cli#705: an asker (or a wrapper on its behalf — `tg-ctl withdraw`) says its question is
  // no longer relevant. Dispatched before normalization like the lines above; an old daemon
  // drops it as unparsable with a `null` reply, which the client reports as "not withdrawn".
  const withdraw = parseWithdrawLine(parsedLine)
  if (withdraw) {
    handleWithdrawLine(rt, socket, withdraw)
    return true
  }
  return false
}

async function handleTopicResultLine(ctx: Ctx, socket: Socket, topicResult: NonNullable<ReturnType<typeof parseTopicResult>>): Promise<void> {
  socket.end()
  const entry = liveEntry(ctx, topicResult.key)
  if (entry?.threadId !== topicResult.threadId) return
  if (topicResult.ok) clearSessionTopicMisses(ctx, entry.key)
  else await noteSessionTopicMiss(ctx, entry.key, topicResult.threadId, topicResult.description)
}

function handleWithdrawLine(rt: QuestionRuntime, socket: Socket, withdraw: WithdrawRequest): void {
  const closed = withdrawCards(rt, withdraw)
  log(`ask-withdraw: ${withdraw.kind === "request" ? `req=${withdraw.requestId}` : `hookId=${withdraw.hookId} cwd=${withdraw.cwd ?? "-"}`} closed=${closed}`)
  socket.end(`${JSON.stringify({ tgctl: "withdrawn", closed })}\n`)
}

// Parse + door checks that need no session context. Null once the ask was dropped (the
// socket is already answered).
function parseAdmissibleAsk(ctx: Ctx, socket: Socket, parsedLine: unknown, line: string): ButtonRequest | null {
  let req: ButtonRequest | null = null
  try {
    req = parsedLine === undefined ? null : normalizeButtonRequest(parsedLine)
  } catch {
    // malformed hook payload: let the local agent UI take over
  }
  if (!req) {
    // A non-forward must NEVER be silent: the question stays in the harness and
    // the operator gets zero signal. Every drop below logs a distinct, greppable
    // `ask-forward` reason so a question that doesn't reach Telegram is visible.
    log(`ask-forward dropped: reason=unparsable-payload line=${describeHookLine(line)}`)
    dropAsk(socket, "unparsable-payload")
    return null
  }
  if (req.ownerOnly && !isPrivateOwnerChatId(ctx.chatId)) {
    log(`ask-forward dropped: reason=owner-only-needs-private-owner-chat req=${req.requestId}`)
    dropAsk(socket, "owner-only-needs-private-owner-chat")
    return null
  }
  return req
}

// The asking session (spec §2.6): the hook's own session id, else the asker's TG_SESSION pin
// (a headless hatch ask has neither pane nor harness id — tg-cli#717), else the session owning
// the asker's pid chain or pane, else the registry's occupant of the asking pane. Overwrites
// any client-sent sessionKey.
function stampAskingSession(req: ButtonRequest): ButtonRequest {
  const askReg = currentSessionRegistry()
  const pinKey = req.sessionPin && askReg ? pinnedSession(askReg, req.sessionPin)?.key : undefined
  const askerSession = req.asker && askReg ? findSessionForAsker(askReg, req.asker)?.key : undefined
  // The pane fallback only on the asker's own tmux server (or for an asker that did not say):
  // `%1` on another server is another session's pane (tg-cli#722).
  const askerServer = req.asker?.tmuxServerPid ?? null
  const paneEntry = req.paneId && askReg ? sessionAtPane(askReg, req.paneId) : null
  const paneKey = paneEntry && (askerServer === null || paneEntry.locators.tmux?.serverPid === askerServer) ? paneEntry.key : undefined
  return { ...req, sessionKey: hookSessionKey(req) ?? pinKey ?? askerSession ?? paneKey }
}

// Registration + forwardability guards. False once the ask was dropped.
function passesForwardGuards(ctx: Ctx, socket: Socket, req: ButtonRequest): boolean {
  // The per-pane registration SET: the question forwards when ITS pane matches
  // ANY registered entry, so EVERY concurrently-registered session forwards
  // (tg-cli#67), not only the single global last-writer. No liveness pruning
  // here — the asking pane is itself live (it is blocking on this very question),
  // and an unrelated dead-pane entry can never match this req's paneId, so a
  // prune would only cost an extra tmux read on the hot forward path.
  const registrations = readRegistrations(ctx.paths)
  // Hatch permissions skip the pane/cwd registration set (tg-cli#333): non-tmux
  // omp sessions are never registered, and hatch is the documented exception to
  // no-long-inline-process. Generic `tg-ctl ask "<question>"` calls skip it too
  // (isGenericAskRequest). canForwardButtonRequest still runs below.
  if (!isHatchPermissionRequest(req) && !isGenericAskRequest(req) && !hookMatchesRegistration(registrations, req)) {
    log(
      `ask-forward dropped: reason=not-registered ${describeAskRequest(req)} reg=${describeRegistration(registrations)}`,
    )
    dropAsk(socket, "not-registered")
    return false
  }
  if (!canForwardButtonRequest(req)) {
    log(`ask-forward dropped: reason=not-forwardable ${describeAskRequest(req)}`)
    dropAsk(socket, "not-forwardable")
    void sendMessage(
      ctx,
      `native question forwarding isn't available for \`${req.agent}\` — answer in the terminal`,
    )
    return false
  }
  return true
}

function endWithAgentOutput(socket: Socket, req: ButtonRequest, answer: ButtonAnswer): void {
  const output = formatAgentHookOutput(req, answer)
  socket.end(output === null ? "null\n" : `${JSON.stringify(output)}\n`)
}

export async function handleHookSocketLine(ctx: Ctx, rt: QuestionRuntime, socket: Socket, line: string): Promise<void> {
  const parsedLine = parseHookLine(line)
  if (await dispatchControlLine(ctx, rt, socket, parsedLine)) return
  const admitted = parseAdmissibleAsk(ctx, socket, parsedLine, line)
  if (!admitted) return
  const req = stampAskingSession(admitted)
  log(`ask-forward arrived: ${describeAskRequest(req)}`)
  recordHookSession(req)
  if (!passesForwardGuards(ctx, socket, req)) return

  // REMOVED (tg-cli#398): the hatch retry short-circuit that auto-applied a
  // queued tap to ANY retry behind the same hookId (see the note at the old
  // findQueuedHatchDecision site). A plain hatch retry now simply forwards a
  // FRESH card; a late human approval reaches the agent exclusively through
  // the operation-bound, single-use grant consumed via the verify-grant
  // protocol (handleVerifyGrantRequest, dispatched before normalization above).

  const pendingKey = callbackRequestId(req)
  if (rt.activeKeys.has(pendingKey)) {
    log(`ask-forward dropped: reason=duplicate-in-flight ${describeAskRequest(req)} key=${pendingKey}`)
    dropAsk(socket, "duplicate-in-flight")
    return
  }
  if (replayAnsweredQuestion(rt, socket, req, pendingKey)) return
  if (reattachRetainedCard(ctx, rt, socket, req, pendingKey)) return
  await forwardAndPostQuestion(ctx, rt, req, socket, pendingKey)
}

// Idempotency across the answer boundary (tg-cli#97): the in-flight dedup is
// RELEASED the instant a question is answered, so the SAME requestId
// re-firing afterwards would post a second, superseded card. If we have a FRESH
// answer for this key, replay it down the socket — rebuilt against the NEW req so
// the reply shape matches this re-fire's own kind/event — and post no card. The
// entry stays replayable for the whole window (a question can re-fire more than
// once); a STALE entry (a genuinely new question reusing the hash past the TTL)
// is pruned here so it falls through to a fresh forward. Only QUESTIONS are ever
// cached (the write is kind-guarded), so consult it only for questions — symmetric
// with the write and immune to a (practically impossible) cross-kind key clash.
// Multi-question members also skip the replay READ defensively: they are never
// written (all-or-nothing, see the answer branch), but an entry persisted by an
// older daemon must not replay into a new round either. True when the socket was answered.
function replayAnsweredQuestion(rt: QuestionRuntime, socket: Socket, req: ButtonRequest, pendingKey: string): boolean {
  const prior = req.kind === "question" && !req.multiQuestion ? rt.answered.get(pendingKey) : undefined
  if (!prior) return false
  if (Date.now() - prior.at > ANSWERED_REPLAY_MS) {
    rt.answered.delete(pendingKey)
    return false
  }
  if (prior.delivery === "pane") {
    // The answer was already LATE-DELIVERED into the pane (this PR). A hook that
    // reconnects (the restart race) or re-fires must NOT also have it replayed
    // down the socket — that delivers the answer twice. Return null with NO card:
    // a still-blocked hook falls back to the terminal, where the pane injection
    // lands, so the agent gets the chosen option exactly once.
    log(`ask-forward already-pane-delivered: ${describeAskRequest(req)} key=${pendingKey} label=${prior.label}`)
    dropAsk(socket, "already-pane-delivered")
    return true
  }
  const replayAnswer: ButtonAnswer = {
    status: "answered",
    requestId: req.requestId,
    label: prior.label,
    value: prior.value,
    decision: prior.decision,
  }
  log(`ask-forward replayed-answer: ${describeAskRequest(req)} key=${pendingKey} label=${prior.label}`)
  endWithAgentOutput(socket, req, replayAnswer)
  return true
}

// RECONNECT re-attach (lossless restart): the SAME question or permission re-arriving
// while we still RETAIN it — its socket died because the 120s window closed OR a
// daemon restart restored it from disk — re-attaches THIS new socket to the existing
// card instead of posting a duplicate. The agent's `tg-ctl ask` reconnect-and-resend
// (byte-identical requestId, still inside its hook budget) lands here. We require an
// EXACT requestId match (not just the callbackRequestId hash) so a genuinely different
// request that merely hash-collides falls through to a fresh card. A late TAP that
// already late-delivered moved the entry to `answered` (replayed above), so a tap and
// a reconnect never fight over the same key. Only SCOPED entries are ever retained,
// so the revived entry needs no unscoped timer. True when the socket was answered.
function reattachRetainedCard(ctx: Ctx, rt: QuestionRuntime, socket: Socket, req: ButtonRequest, pendingKey: string): boolean {
  const retained = rt.abandoned.get(pendingKey)
  if (!retained) return false
  rt.abandoned.delete(pendingKey) // a stale hash-collision also drops here → fresh forward
  if (retained.req.requestId !== req.requestId) return false
  if (deliverQueuedPermissionDecision(ctx, rt, socket, retained, req, pendingKey)) return true
  reattachLiveCard(ctx, rt, socket, retained, req, pendingKey)
  return true
}

// Why a retained entry's queued decision was NOT auto-delivered to a reconnecting hook.
// "no-queued-decision" (the ordinary reconnect) logs nothing.
const QUEUED_DECISION_DISCARD_LOG: Record<"no-turn-proof" | "turn-mismatch" | "payload-mismatch", (pendingKey: string) => string> = {
  "no-turn-proof": (key) => `ask-forward queued-decision-discarded: retained request has no promptTurnId (no per-invocation identity proof) — refusing auto-delivery, showing a fresh live prompt instead. key=${key}`,
  // Distinct from the generic payload-mismatch case below (review finding:
  // this log used to blame "question text or toolInput" even when the REAL
  // mismatch was promptTurnId — e.g. a manual/back-compat caller reusing the
  // same requestId while omitting or changing the field).
  "turn-mismatch": (key) => `ask-forward queued-decision-discarded: reconnecting request's promptTurnId does not match the queued decision's (permissionPayloadMatches) — showing a fresh live prompt instead. key=${key}`,
  "payload-mismatch": (key) => `ask-forward queued-decision-discarded: reconnecting request's question text or toolInput no longer matches the queued decision's (permissionPayloadMatches) — showing a fresh live prompt instead. key=${key}`,
}

// A Telegram tap already chose a permission decision WHILE this hook was
// disconnected (queued by lateDeliverAbandonedQuestion, since a permission has
// no pane-text fallback). Deliver it down THIS reconnecting socket right away
// instead of re-showing a live prompt the human already answered — this is
// what makes abandonedPermissionText's "delivered the moment it reconnects"
// claim true rather than aspirational.
// Only auto-deliver when the reconnecting request is PROVABLY the same prompt
// the human read and decided on — requestId alone is a hash of session+question
// text (tg-cli#97) and normally can't collide across different prompts, but a
// harness that reused a stale requestId against a MUTATED payload must not
// have that old decision silently rubber-stamped onto a request the human
// never actually saw (review finding). This must compare the FULL approved
// surface, not just the displayed question text: `toolInput` can carry
// content (an edit's diff, a write's contents, structured args) the question
// string never shows, so two requests can read identically to the human while
// asking for materially different actions. A mismatch on EITHER is treated as
// "no queued decision": fall through to the ordinary re-attach so the human is
// shown a fresh live prompt and taps it explicitly.
//
// Not time-bounded (tg-cli#705 removed the retention window): delivery is safe
// because the identity check itself is airtight for permissions — requestId folds in
// `env.invocationNonce` (hook-normalize.ts), a random id generated ONCE PER
// `tg-ctl ask` PROCESS. Claude's `prompt_id` / Codex's `turn_id` alone are
// NOT sufficient here (they scope to the whole prompt TURN, not the
// individual tool call — two distinct calls in the same turn could still
// share a requestId under turn-id-only scoping; caught in review), so a
// materially later, only-coincidentally-identical-looking request (whether a
// later turn OR a second call within the same turn) can never reach this
// branch at all — it's always a NEW process with a NEW nonce, hashing to a
// DIFFERENT requestId that never matches `retained.req.requestId ===
// req.requestId` (reattachRetainedCard). permissionPayloadMatches remains as defense-in-depth
// against the narrower residual risk of a lossy `summarizeInput` digest
// collision (two DIFFERENT toolInputs summarizing to the same short string).
//
// `retained.req.promptTurnId` is REQUIRED (not just permissionPayloadMatches):
// it's the proof that THIS retained request was actually captured with
// turn-level identity in the first place. Without it (an older Claude Code
// <v2.1.196, a harness with no turn_id equivalent, or a manual/back-compat
// caller), requestId is only session-scoped, and a same-session re-run of an
// identical command is a routine, non-malicious occurrence — auto-delivering
// onto it would be exactly the "different prompt, same-looking request"
// hazard this whole check exists to prevent (review finding). Refusing
// auto-delivery there does NOT silently drop the tap: the fallthrough
// restores the card to a LIVE, freshly-buttoned prompt (buildButtonMessage)
// — visibly pending again, not a dead/expired card and not a false "queued"
// claim — so the human sees exactly what's happening and can re-decide. The
// OLD queued value itself is NOT carried forward into that fresh prompt
// (PendingButton has no queuedDecision slot): once identity can't be proven,
// presenting a genuinely fresh choice is the honest, safe behavior, not a
// stale tap silently reapplied.
// True when the decision was delivered (the socket is answered).
function deliverQueuedPermissionDecision(
  ctx: Ctx,
  rt: QuestionRuntime,
  socket: Socket,
  retained: AbandonedButton,
  req: ButtonRequest,
  pendingKey: string,
): boolean {
  const outcome = decideQueuedPermissionReconnect(retained, req)
  if (outcome.kind === "no-queued-decision") return false
  if (outcome.kind !== "deliver") {
    log(QUEUED_DECISION_DISCARD_LOG[outcome.kind](pendingKey))
    return false
  }
  const qd = outcome.queuedDecision
  const answer: ButtonAnswer = {
    status: "answered",
    requestId: req.requestId,
    label: qd.label,
    value: qd.value,
    decision: qd.decision,
  }
  endWithAgentOutput(socket, req, answer)
  // Deliberately NOT added to `rt.answered` (the question-only replay cache —
  // see the "Scoped to questions on purpose" comment in the live-tap handler
  // below): silently replaying a permission decision to a LATER unrelated
  // re-fire that happens to reuse the same key would be exactly the
  // behavioral/security change that cache was built to avoid (review
  // finding). The entry is already gone from `rt.abandoned` (reattachRetainedCard), so a
  // genuinely fresh re-fire of this requestId just forwards as a normal new
  // prompt — no double-delivery risk without the cache.
  rt.persist()
  if (retained.messageId !== null) {
    void clearMessageKeyboard(ctx, retained.messageId)
    void editMessageText(ctx, retained.messageId, buildAnsweredQuestionText(req, qd.label), undefined, hatchParseMode(req))
  }
  log(`ask-forward queued-decision-delivered: ${describeAskRequest(req)} key=${pendingKey} label=${qd.label}`)
  return true
}

// Re-register the retained card as a live pending question on THIS socket.
function reattachLiveCard(
  ctx: Ctx,
  rt: QuestionRuntime,
  socket: Socket,
  retained: AbandonedButton,
  req: ButtonRequest,
  pendingKey: string,
): void {
  rt.activeKeys.add(pendingKey)
  const entry: PendingButton = {
    req,
    socket,
    messageId: retained.messageId,
    at: Date.now(),
  }
  rt.pending.set(pendingKey, entry)
  armPendingSocketClose(ctx, rt, entry, pendingKey)
  // tg-cli#317 review finding: a reconnect landing HERE (the daemon reattaching
  // an already-posted-but-undecided card after a restart or a transient socket
  // drop) previously wrote no status line at all. If this new connection then
  // also drops or times out with no tap, describeAskOutcome saw an empty
  // `statuses` array and reported "unreachable"/"no status line" for a card
  // that is genuinely live and answerable in Telegram — the exact incident
  // this file exists to fix, recreated in the one path the first pass missed.
  if (retained.messageId !== null) {
    writeAskStatus(socket, { tgctl: "ask-status", state: "posted", messageId: retained.messageId })
  }
  rt.persist()
  // The card is LIVE again — restore the original prompt text, which the
  // socket-close path replaced with "window closed …" (actively misleading
  // for a multi-question member: it tells the user NOT to tap the one card
  // that now works — review finding). The keyboard rides along explicitly:
  // Telegram's editMessageText DETACHES the inline keyboard when
  // reply_markup is omitted. Best-effort like every card edit (a restart-
  // restored card that was never edited yields "message is not modified",
  // which botPostResult counts as success — tg-cli#728).
  if (retained.messageId !== null) {
    const restored = buildButtonMessage(ctx.chatId, req)
    void editMessageText(ctx, retained.messageId, restored.text, restored.reply_markup, restored.parse_mode)
  }
  log(`ask-forward reattached: ${describeAskRequest(req)} key=${pendingKey} messageId=${retained.messageId ?? "-"}`)
}

// --- Grant protocol v1.1 (tg-cli#398): the verify-grant exchange ---
//
// The daemon is the ONLY grant authority. A `{"tgctl":"verify-grant",…}` line
// (dispatched from handleHookSocketLine BEFORE normalization) carries:
//   hookId     — RIG_HATCH_REQUEST_<HOOK_ID>'s hook id (required)
//   approvalId — TOKEN path (contract §5): explicit id, route-agnostic (the
//                agent was told the id out-of-band)
//   pull: true — PULL path: no id; matched by hook_id + operation + ROUTE
//                EQUALITY (routeForRequest recomputed from `payload`, never a
//                client-sent route field). NO blank-route fallback.
//   payload    — the normalized ask (carries the recomputed `operation`)
// The reply is the SAME hookSpecificOutput allow/deny JSON shape a normal ask
// reply uses (formatAgentHookOutput where the payload normalizes, a
// PermissionRequest envelope otherwise), PLUS the original ask's `requestId`
// at TOP level (the pinned shape the agent-tools lib reads; it also parses
// hookSpecificOutput.requestId tolerantly) and `approvalId` on allow.

// Deny envelope: constructed directly (not via formatAgentHookOutput) so the
// deny REASON always reaches the caller — formatAgentHookOutput only conveys
// a reason for a RELABELED deny (plan-approval), not a bare Approve/Reject.
export function buildVerifyGrantDeny(payloadReq: ButtonRequest | null, reasonText: string, requestId: string | null): Record<string, unknown> {
  if (payloadReq?.permissionEvent === "PreToolUse") {
    return {
      requestId,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonText },
    }
  }
  return {
    requestId,
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reasonText } },
  }
}

export function buildVerifyGrantAllow(payloadReq: ButtonRequest | null, grant: { approval_id: string; request_id: string }): Record<string, unknown> {
  let out: unknown = null
  if (payloadReq) {
    const answer: ButtonAnswer = {
      status: "answered",
      requestId: grant.request_id,
      label: "Approve",
      value: "allow",
      decision: "allow",
    }
    out = formatAgentHookOutput(payloadReq, answer)
  }
  if (!out || typeof out !== "object") {
    out = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }
  }
  return { requestId: grant.request_id, approvalId: grant.approval_id, ...(out as Record<string, unknown>) }
}

// Consume-on-allow, FAIL-CLOSED: mutate consumed_at and persist BEFORE
// replying; if the atomic write fails the mutation is rolled back and the
// reply is a DENY — otherwise a daemon restart would resurrect the grant as
// unconsumed and permit a single-use replay (security invariant §6).
export async function handleVerifyGrantRequest(ctx: Ctx, rt: QuestionRuntime, socket: Socket, rec: Record<string, unknown>): Promise<void> {
  const hookId = readNonEmpty(rec.hookId)
  const approvalId = readNonEmpty(rec.approvalId)
  const pull = rec.pull === true
  const payloadReq = rec.payload ? normalizeButtonRequest(rec.payload) : null
  const reply = (obj: Record<string, unknown>): void => {
    socket.end(`${JSON.stringify(obj)}\n`)
  }
  const request = validGrantRequest(hookId, approvalId, pull)
  if (!request) {
    log(`grant-deny: reason=malformed-request hookId=${hookId ?? "-"} approvalId=${approvalId ?? "-"} pull=${pull}`)
    reply(buildVerifyGrantDeny(payloadReq, "malformed verify-grant request (needs --hook <hook_id>, and an approval id or --pull)", null))
    return
  }
  const now = Date.now()
  // TOKEN path: explicit approval id, route-agnostic. PULL path: no id —
  // matched by hook_id + operation + route equality, route recomputed
  // daemon-side from the query payload's routing fields.
  const route = request.pull && payloadReq ? routeForRequest(payloadReq) : null
  const outcome = request.pull
    ? pullGrant(rt.grants.grants, request.hookId, payloadReq?.operation, route, now)
    : verifyGrant(rt.grants.grants, request.approvalId, request.hookId, payloadReq?.operation, now)
  if (outcome.kind === "deny") {
    reply(describeGrantDenial(rt, request, payloadReq, outcome.reason, route, approvalId))
    return
  }
  const consumed = consumeGrant(rt, outcome.grant, request, now)
  if (!consumed) {
    reply(buildVerifyGrantDeny(payloadReq, "grant store write failed — denying fail-closed (the grant was NOT consumed); retry", outcome.grant.request_id))
    return
  }
  log(`grant-consume: via=${grantVia(request)} approvalId=${outcome.grant.approval_id} hookId=${request.hookId} req=${outcome.grant.request_id}`)
  reply(buildVerifyGrantAllow(payloadReq, outcome.grant))
  // The agent got its decision through the grant: every other open card of this hatch is moot.
  closeSiblingCards(rt, outcome.grant, payloadReq)
}

function readNonEmpty(v: unknown): string | null {
  return typeof v === "string" && v ? v : null
}

// Log the denial and build the deny reply.
function describeGrantDenial(
  rt: QuestionRuntime,
  request: GrantRequest,
  payloadReq: ButtonRequest | null,
  reason: Extract<VerifyGrantOutcome, { kind: "deny" }>["reason"],
  route: string | null,
  approvalId: string | null,
): Record<string, unknown> {
  const existing = request.pull ? null : (rt.grants.grants.find((g) => g.approval_id === request.approvalId) ?? null)
  log(
    `grant-deny: via=${grantVia(request)} hookId=${request.hookId} approvalId=${approvalId ?? "-"} reason=${reason}` +
      ` cwd=${payloadReq?.operation?.cwd ?? "-"} route=${request.pull ? route ?? "-" : "(n/a)"}`,
  )
  // Top-level requestId (the pinned shape the lib reads): the ORIGINAL ask's
  // when the grant is known, else the retry payload's own (the lib correlates
  // either), never a missing key.
  return buildVerifyGrantDeny(
    payloadReq,
    grantDenyReasonText(reason, request.hookId),
    existing?.request_id ?? payloadReq?.requestId ?? null,
  )
}

// A verify-grant query that names its hook and either an approval id (TOKEN) or --pull.
type GrantRequest =
  | { hookId: string; pull: true }
  | { hookId: string; pull: false; approvalId: string }

function validGrantRequest(hookId: string | null, approvalId: string | null, pull: boolean): GrantRequest | null {
  if (!hookId) return null
  if (pull) return { hookId, pull: true }
  return approvalId ? { hookId, pull: false, approvalId } : null
}

function grantVia(request: GrantRequest): "pull" | "token" {
  return request.pull ? "pull" : "token"
}

// Mark the grant consumed and persist it. FAIL-CLOSED: false (mutation rolled back) when the
// atomic write fails.
function consumeGrant(rt: QuestionRuntime, grant: GrantRecord, request: GrantRequest, now: number): boolean {
  grant.consumed_at = now
  if (rt.persistGrants()) return true
  grant.consumed_at = null
  log(`grant-deny: via=${grantVia(request)} approvalId=${grant.approval_id} reason=persist-failed — rolled back, NOT consumed`)
  return false
}

function closeSiblingCards(rt: QuestionRuntime, grant: GrantRecord, payloadReq: ButtonRequest | null): void {
  for (const key of hatchSiblingKeys(rt.closableCards(), grant.hook_id, grant.operation?.cwd ?? payloadReq?.cwd, null)) {
    rt.closeCard(key, CLOSE_STATUS.decided)
  }
}
