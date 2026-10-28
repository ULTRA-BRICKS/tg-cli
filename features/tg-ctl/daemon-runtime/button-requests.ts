// daemon-runtime/button-requests: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { type Socket } from "net"
import { resolve } from "path"
import { parseAskerIdentity } from "../session-topics"
import { ASK_TIMEOUT_MAX_MS, questionCapability, queuedDecisionCanAutoDeliver, registrationSetAllowsHook, type ButtonMessagePayload, type ButtonRequest, type PermissionDecision } from "../questions"
import { type OpenCard } from "../question-inbox"
import { type GrantStoreData } from "../grants"
import type { Registration } from "../types"

// --- hook/client handoff over a local Unix socket ---

export const MAX_HOOK_REQUEST_BYTES = 64 * 1024

// How long an UNSCOPED forwarded question (paneId undefined — the hook ran
// without TMUX_PANE) may stay open before it self-clears to "expired — answer in
// terminal". This bound exists ONLY for the unscoped case, because an unscoped
// question defers inbound for ALL panes (paneHasPendingQuestion's fail-closed
// `if (!pb.req.paneId) return true`); without the bound it would wedge every
// pane's routing forever. A SCOPED question gets NO timer and waits indefinitely
// for its Telegram answer or socket close — that is safe (the timer is armed only
// for the `!req.paneId` branch in handleHookSocketLine). Overridable via env only
// so the integration tests can exercise the expiry without a real 110s wait;
// production never sets it.
export const UNSCOPED_ABANDON_MS = (() => {
  const raw = Number(process.env.TG_CTL_UNSCOPED_TIMEOUT_MS)
  // setTimeout clamps any delay > 2^31-1 ms to ~1ms in Node/Bun, which would
  // flip a huge "wait longer" override into "expire instantly" — the opposite of
  // intent. Clamp to TIMEOUT_MAX so an oversized value still means "a long wait".
  // A non-positive / non-numeric / absent value (incl. 0) falls back to the 110s
  // default — 0 is NOT "expire instantly" (the bound is a backstop, never zero).
  const TIMEOUT_MAX = 2_147_483_647
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, TIMEOUT_MAX) : 110_000
})()

export interface PendingButton {
  req: ButtonRequest
  socket: Socket
  messageId: number | null
  // ms epoch when this entry was created (or revived). Persisted so the durable file
  // can be ordered by recency, and shown as the card's age in its 📥 Inbox copy.
  at: number
  // Only a SCOPED-less (unscoped) question arms an abandon timer; a scoped
  // question waits forever, so its timer is undefined. clearTimeout(undefined)
  // is a safe no-op, so every clearTimeout(entry.timer) call site is correct
  // whether or not the timer was armed.
  timer?: ReturnType<typeof setTimeout>
  finalText?: string
  finalReplyMarkup?: ButtonMessagePayload["reply_markup"]
}

// A SCOPED question whose hook socket has CLOSED — the agent's 120s hook budget
// elapsed (it fell back to the terminal AskUserQuestion prompt) OR the daemon
// restarted and restored it from disk. Its answer can STILL reach the pane it asked
// from, so we retain {paneId, options, card id} keyed by callbackRequestId. A LATER
// Telegram tap injects the chosen option into that pane (late-delivery), and a
// reconnecting hook with the SAME requestId re-attaches to this card instead of
// posting a duplicate (lossless restart). Unlike a PendingButton it holds NO live
// socket and — crucially — is NOT in `pendingButtons`, so it never defers the pane's
// inbound (the agent moved on / is blocked on its own reconnect).
export interface AbandonedButton {
  req: ButtonRequest
  messageId: number | null
  at: number
  // A PERMISSION decision the user already tapped while the hook was disconnected
  // (queued because, unlike a question, a permission has no pane-text-injection
  // fallback — the hook needs a structured JSON reply, not terminal text). Never
  // silently dropped: this is delivered down the socket the instant a reconnecting
  // hook re-attaches to the same requestId AND its payload still matches
  // (permissionPayloadMatches — the RECONNECT re-attach branch in
  // handleHookSocketLine). PERSISTED: `persistQuestions` writes it and the restore
  // path re-reads it (see question-store.ts's RetainedQuestionRecord.queuedDecision),
  // and it is persisted IMMEDIATELY on tap (not only on the next unrelated
  // mutation) — a daemon crash between the tap and the reconnect must not lose the
  // human's decision while the card still claims it is "delivered automatically"
  // (PERM QUEUE RESTART proves this). The card stays visibly "queued" until actually
  // delivered so a re-tap (last tap wins) or a terminal answer both stay available.
  // `decision` is REQUIRED — see question-store.ts's matching RetainedQuestionRecord
  // field for why (review finding: the two types must agree).
  // `notifiedAt`: when the ONE-TIME "still waiting to reconnect" notice
  // (noticeStaleQueuedDecisions, QUEUED_DECISION_NOTICE_MS) fired for this queued
  // tap — undefined until it does. Persisted so a daemon restart doesn't re-fire
  // the notice for an entry that already got one (would read as spam / a false
  // "still no connection" repeat right after a bounce).
  queuedDecision?: { value: string; label: string; decision: PermissionDecision; at: number; notifiedAt?: number }
}

// Shared by permissionRequestIdForMessage's lookups (PendingButton, AbandonedButton
// and the grace store's GraceRecord have compatible {req, messageId} shapes) — a
// single copy of the "is this the one decidable permission card at this message_id"
// predicate instead of independently-written loops that could silently drift apart
// if the definition of "decidable" ever changes (review finding).
export function findDecidablePermissionRequestId(
  entries: Iterable<[string, { req: ButtonRequest; messageId: number | null }]>,
  messageId: number,
): string | null {
  for (const [requestId, entry] of entries) {
    if (entry.messageId === messageId && entry.req.kind === "permission" && !entry.req.multiQuestion) return requestId
  }
  return null
}

// A question that has already been ANSWERED, kept briefly so a re-forward of the
// SAME requestId (a stable hash of session + question text) replays the stored
// answer instead of posting a fresh card. The in-flight dedup (`activeButtonKeys`)
// is released the instant a question is answered, so without this an
// AskUserQuestion that re-fires AFTER its answer would post a second, superseded
// card whose tap reads as "expired" (tg-cli#97). Keyed by `callbackRequestId`.
export interface AnsweredButton {
  value: string
  label: string
  decision?: PermissionDecision
  at: number
  // How the answer reached the agent: `socket` (down the hook socket → a re-fire
  // REPLAYS it, #98) or `pane` (late-delivered by pane injection → a reconnecting
  // hook must NOT also replay it, or the agent gets it twice). Defaults to socket.
  delivery: "socket" | "pane"
}

// How long an answered request stays replayable. The re-fire that motivated this
// arrived ~37s after the answer; 5 min is a generous bound that still lets a
// genuinely NEW question reusing the same hash (the human re-asks much later) post
// a fresh card rather than silently replaying a stale answer. Overridable via env
// only so the integration tests can exercise the past-window expiry without a real
// 5-minute wait; production never sets it. Unlike UNSCOPED_ABANDON_MS this is only
// ever compared against (now - answeredAt), never used as a setTimeout delay, so no
// overflow clamp is needed. A non-positive / non-numeric / absent value falls back
// to the 5-minute default.
export const ANSWERED_REPLAY_MS = (() => {
  const raw = Number(process.env.TG_CTL_ANSWERED_REPLAY_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000
})()

// Drop answered entries past the replay window. Called whenever a NEW answer is
// recorded, so the cache stays bounded to ~the questions answered in the last
// window instead of growing for the daemon's whole lifetime (most requestIds are
// unique and never re-forwarded, so access-time pruning alone would leak).
export function pruneAnsweredButtons(answered: Map<string, AnsweredButton>, now: number): void {
  for (const [key, entry] of answered) {
    if (now - entry.at > ANSWERED_REPLAY_MS) answered.delete(key)
  }
}

// Grant protocol v1.1 windows (tg-cli#398): how long an EXPIRED hatch ask stays
// addressable for a late Approve tap (grace), and how long a minted grant stays
// consumable (grant TTL). Both default 24h; env-overridable so integration
// tests can expire a grant/grace without a real 24h wait — production never
// sets them. These are security windows, not question retention: an open card
// stays open until a relevance signal closes it (tg-cli#705).
export const GRACE_WINDOW_MS = (() => {
  const raw = Number(process.env.TG_CTL_GRACE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60_000
})()

export const GRANT_TTL_MS = (() => {
  const raw = Number(process.env.TG_CTL_GRANT_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60_000
})()

// How long a NON-critical ask can wait on its socket at most: its timeoutMs is clamped to
// ASK_TIMEOUT_MAX_MS, and the unscoped backstop retires it by then. A restored record still
// marked pending but older than this is a stale copy (a lost questions write after the
// card was answered), so its grace window is anchored no later than this past posting.
export const ASK_LIVE_MAX_MS = Math.max(ASK_TIMEOUT_MAX_MS, UNSCOPED_ABANDON_MS)

// How long a decided card's record (grants.ts DecidedCard) is kept: past the latest grace
// window a stale questions-store copy of the card could still open — anchored at most
// ASK_LIVE_MAX_MS after posting, and the decision comes no earlier than the posting. A
// critical ask has no such bound (its restart anchor is the restart itself), so its record
// is kept while a copy of the card is on disk (null; grants.ts dropSettledDecided).
export const DECIDED_RETAIN_MS = GRACE_WINDOW_MS + ASK_LIVE_MAX_MS

export const decidedRetainMs = (req: ButtonRequest): number | null => (req.critical ? null : DECIDED_RETAIN_MS)

// PURE decision for what a hook reconnect should do about a retained entry's
// QUEUED permission decision — extracted from handleHookSocketLine so the
// branch is unit-testable with no daemon and no timing race. Order matters:
// one function, one return value, one caller switch. There is no expiry
// outcome (tg-cli#705): a queued decision stays deliverable until a relevance
// signal closes its card.
export type QueuedPermissionReconnectOutcome =
  | { kind: "no-queued-decision" }
  | { kind: "no-turn-proof" }
  | { kind: "turn-mismatch" }
  | { kind: "payload-mismatch" }
  | { kind: "deliver"; queuedDecision: NonNullable<AbandonedButton["queuedDecision"]> }

export function decideQueuedPermissionReconnect(
  retained: Pick<AbandonedButton, "req" | "queuedDecision">,
  req: ButtonRequest,
): QueuedPermissionReconnectOutcome {
  if (!retained.queuedDecision) return { kind: "no-queued-decision" }
  if (!queuedDecisionCanAutoDeliver(retained.req)) return { kind: "no-turn-proof" }
  if (retained.req.promptTurnId !== req.promptTurnId) return { kind: "turn-mismatch" }
  if (!permissionPayloadMatches(retained.req, req)) return { kind: "payload-mismatch" }
  return { kind: "deliver", queuedDecision: retained.queuedDecision }
}

// REMOVED (tg-cli#398, grant protocol v1.1): findQueuedHatchDecision and the
// handleHookSocketLine hatch short-circuit it fed. That mechanism authorized
// ANY later operation behind the same hookId — exactly the over-broad silent
// approval v1.1 forbids. A late Approve now mints a single-use,
// operation-bound grant (grants.ts) and a plain retry WITHOUT a grant simply
// posts a FRESH card (or consumes an outstanding grant via --verify-grant
// --pull, route-bound).

// How long a QUEUED permission decision can wait with no reconnect before the
// human gets a PROACTIVE "still waiting to reconnect" notice — a NOTICE
// threshold, not an expiry (Alex tg#9982: a queued tap must never be silently
// dropped/demoted on a timer). Past it the queue is NOT cleared and stays fully
// eligible for automatic delivery (decideQueuedPermissionReconnect).
//
// The identity check that makes delivery safe WITHIN that window lives
// upstream, in hook-normalize.ts's `invocationSeed`: requestId is now scoped to the prompt
// TURN (Claude Code's `prompt_id`, Codex's `turn_id`), not just the session, so
// a materially later, only-coincidentally-identical-looking request (the agent
// re-running the same command in a NEW turn) gets a fresh requestId and can
// never satisfy the reconnect branch's exact-requestId gate in the first
// place — permissionPayloadMatches (full toolInput/agent/pane/event/question
// equality) is defense-in-depth on top of that for the residual, much narrower
// risk of a lossy `summarizeInput` digest collision, not a time bound.
// Env-overridable for tests; production never sets it.
export const QUEUED_DECISION_NOTICE_MS = (() => {
  const raw = Number(process.env.TG_CTL_QUEUED_DECISION_NOTICE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000
})()

// Exported for tests (same pattern as decideQueuedPermissionReconnect above):
// the AUTHORITATIVE socket/disk validator is the boundary the grant protocol's
// additive fields (tg-cli#398) must survive, so tests/ctl-grants.test.ts pins
// its tolerance contract directly instead of through a daemon round-trip.
export function normalizeButtonRequest(value: unknown): ButtonRequest | null {
  if (!value || typeof value !== "object") return null
  const rec = value as Record<string, unknown>
  const requestId = readNonEmptyString(rec.requestId)
  const agent = readString(rec.agent)
  const kind = rec.kind === "question" || rec.kind === "permission" ? rec.kind : null
  const question = readNonEmptyString(rec.question)
  if (!requestId || !agent || !kind || !question) return null

  return {
    requestId,
    buttonId: readString(rec.buttonId),
    paneId: readString(rec.paneId),
    cwd: readString(rec.cwd),
    sessionName: readString(rec.sessionName),
    windowName: readString(rec.windowName),
    subagent: readString(rec.subagent),
    agent: agent as ButtonRequest["agent"],
    kind,
    question,
    title: readString(rec.title),
    options: readButtonOptions(rec.options),
    decisionLabels: readDecisionLabels(rec.decisionLabels),
    // Which Claude hook event fired — decides the reply shape (PreToolUse →
    // permissionDecision; PermissionRequest → decision.behavior). Default
    // PermissionRequest preserves the pre-existing reply for older payloads.
    permissionEvent: rec.permissionEvent === "PreToolUse" ? "PreToolUse" : undefined,
    toolInput: readToolInput(rec.toolInput),
    // Set-member marker: a multi-question sub-answer must never late-deliver
    // into the pane (all-or-nothing — see ButtonRequest.multiQuestion). Parsed
    // here so it survives BOTH the socket boundary and the disk restore.
    multiQuestion: rec.multiQuestion === true ? true : undefined,
    // Owner-only asks (ask-owner-only-v1) keep the bit across the socket and the disk restore.
    ownerOnly: rec.ownerOnly === true ? true : undefined,
    // The per-turn identity proof (see ButtonRequest.promptTurnId) MUST survive
    // BOTH the socket boundary and the disk restore — it's what the reconnect
    // branch requires before auto-delivering a queued permission decision
    // (handleHookSocketLine, tg-cli#182). Dropping it here would silently
    // degrade every restored/reconnected request to the untrusted case.
    promptTurnId: readString(rec.promptTurnId),
    // tg-cli#403 / agent-tools#754: MUST survive BOTH the socket boundary and
    // the disk restore — it's what gates askDaemon's Infinity deadline and
    // forwardAndPostQuestion's UNSCOPED_ABANDON_MS skip. This is the
    // SERVER-side (daemon socket) parse; the CLIENT-side counterpart lives in
    // hook-normalize.ts's normalizeHookPayload "already normalized" branch.
    critical: rec.critical === true ? true : undefined,
    // Grant protocol v1.1 additive fields (tg-cli#398) — the AUTHORITATIVE
    // socket/disk validator carries them tolerantly: unknown or malformed
    // subfields are dropped, never a rejection, so an old lib ↔ new daemon
    // (or vice versa) keep interoperating. `operation` is OPAQUE (the lib
    // computes the fingerprint; this daemon only compares it, grants.ts).
    hookId: readNonEmptyString(rec.hookId),
    timeoutMs: readPositiveFiniteNumber(rec.timeoutMs),
    origin: readAskAdditiveOrigin(rec.origin),
    operation: readAskAdditiveOperation(rec.operation),
    sessionPin: readNonEmptyString(rec.sessionPin)?.slice(0, 128),
    // Daemon-stamped at arrival (handleHookSocketLine overwrites whatever a
    // client sent); read back here so it survives the disk restore.
    sessionKey: readNonEmptyString(rec.sessionKey),
    asker: parseAskerIdentity(rec.asker),
  }
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function readNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined
}

function readPositiveFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

function readButtonOptions(raw: unknown): ButtonRequest["options"] {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
    .map((o) => {
      const label = typeof o.label === "string" ? o.label : ""
      const description = typeof o.description === "string" ? o.description : undefined
      return label ? (description ? { label, description } : { label }) : null
    })
    .filter((o): o is { label: string; description?: string } => o !== null)
}

// Custom allow/deny button wording (plan-approval → Proceed/Keep planning).
// Both labels must be present + non-empty strings, else fall back to the
// default Approve/Reject by leaving it undefined.
function readDecisionLabels(raw: unknown): ButtonRequest["decisionLabels"] {
  if (!raw || typeof raw !== "object") return undefined
  const { allow, deny } = raw as Record<string, unknown>
  if (typeof allow !== "string" || !allow || typeof deny !== "string" || !deny) return undefined
  return { allow, deny }
}

// The original tool_input MUST survive the socket boundary: a PreToolUse
// ALLOW (ExitPlanMode Proceed, claude question) echoes it as `updatedInput`,
// and the live hooks docs say "allow alone is not sufficient" for the
// user-interactive tools — dropping it here silently downgraded the reply to
// a bare allow (tg#5741 review finding).
function readToolInput(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
}

// Subfield-tolerant readers for the v1.1 additive fields (tg-cli#398) — same
// tolerance contract as hook-normalize.ts's readAskOrigin/readAskOperation,
// duplicated at the authoritative boundary on purpose: the daemon MUST NOT
// trust the client side's normalization for a socket/disk payload.
export function readAskAdditiveOrigin(raw: unknown): ButtonRequest["origin"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const out: NonNullable<ButtonRequest["origin"]> = {}
  if (typeof rec.agent === "string" && rec.agent) out.agent = rec.agent
  if (typeof rec.sessionId === "string" && rec.sessionId) out.sessionId = rec.sessionId
  if (typeof rec.subagent === "string" && rec.subagent) out.subagent = rec.subagent
  return Object.keys(out).length ? out : undefined
}

export function readAskAdditiveOperation(raw: unknown): ButtonRequest["operation"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const out: NonNullable<ButtonRequest["operation"]> = {}
  if (typeof rec.kind === "string" && rec.kind) out.kind = rec.kind
  if (typeof rec.fingerprint === "string" && rec.fingerprint) out.fingerprint = rec.fingerprint
  if (typeof rec.cwd === "string" && rec.cwd) out.cwd = rec.cwd
  if (typeof rec.repoRoot === "string" && rec.repoRoot) out.repoRoot = rec.repoRoot
  return Object.keys(out).length ? out : undefined
}

export function canForwardButtonRequest(req: ButtonRequest): boolean {
  if (questionCapability(req.agent) !== "buttons") return false
  return !(req.agent === "codex" && req.kind !== "permission")
}

export function hookMatchesRegistration(regs: Registration[], req: ButtonRequest): boolean {
  return registrationSetAllowsHook(regs, req, resolve)
}

// One-line, greppable descriptors for the ask-forward log. They identify which
// question arrived and which registration it was matched against, so a silent
// non-forward (the question stays in the harness) becomes a visible log line
// stating exactly why it was dropped — never a bare socket.end("null").
export function describeAskRequest(req: ButtonRequest): string {
  return `agent=${req.agent} kind=${req.kind} req=${req.requestId} subagent=${req.subagent ?? "-"} window=${req.windowName ?? "-"} pane=${req.paneId ?? "-"} cwd=${req.cwd ?? "-"} session=${req.sessionName ?? "-"}`
}

// An interim STATUS line the daemon writes to the hook socket BEFORE its final reply
// (tg-cli#317). The final reply is unchanged (`null\n` or `<json>\n`), so a client that
// predates this still works; a client that reads status lines can tell a card that was
// POSTED and then expired from a request DROPPED at the door. Those two used to be one
// bare `null`, and the asking side reported a card the human could see in Telegram as
// "not-posted … daemon declined or unreachable" (messageId=14880, 2026-09-05).
export type AskStatusLine =
  | { tgctl: "ask-status"; state: "posted"; messageId: number }
  | { tgctl: "ask-status"; state: "dropped"; reason: string }
  | { tgctl: "ask-status"; state: "expired"; messageId: number | null; ageMs: number }

export function writeAskStatus(socket: Socket, status: AskStatusLine): void {
  if (socket.destroyed || socket.writableEnded) return
  socket.write(`${JSON.stringify(status)}\n`)
}

// Decline a forward: the reason travels down the socket as a status line, then the
// unchanged `null` reply. Every drop branch names its reason here AND in the daemon log.
export function dropAsk(socket: Socket, reason: string): void {
  writeAskStatus(socket, { tgctl: "ask-status", state: "dropped", reason })
  socket.end("null\n")
}

export function describeRegistration(regs: Registration[]): string {
  if (regs.length === 0) return "none"
  return regs
    .map((reg) => `pane=${reg.paneId ?? "-"} cwd=${reg.cwd ?? "-"} session=${reg.sessionName ?? "-"}`)
    .join(" | ")
}

export function describeHookLine(line: string): string {
  const one = line.replace(/\s+/g, " ").trim()
  return one.length > 120 ? `${one.slice(0, 120)}…` : one
}

// The in-memory + durable state for forwarded questions, threaded through the hook
// socket handlers. Bundled into one struct so the handlers (and their helpers) take
// a single param instead of a long positional list, and so the durable `persist`
// callback travels with the maps it serializes.
export interface QuestionRuntime {
  pending: Map<string, PendingButton>
  activeKeys: Set<string>
  // Socket-closed SCOPED questions retained for late-delivery + reconnect. NEVER in
  // `pending`, so an abandoned question never defers its pane's inbound.
  abandoned: Map<string, AbandonedButton>
  // Answered-request replay cache (tg-cli#97): a re-forward of an already-answered
  // requestId replays the stored answer down the socket and posts NO second card.
  answered: Map<string, AnsweredButton>
  // Persist the durable question state after any mutation (atomic write). A restored
  // daemon late-delivers a late tap and re-attaches a reconnecting hook.
  persist: () => void
  // Release a pane's deferred backlog when its question goes away without an inline
  // answer (timeout / socket close / send failure). Idle panes flush immediately;
  // panes with another live question keep their queue for that question's answer.
  onRelease: (paneId: string) => void
  // A scoped question's hook socket closed, so the harness may have fallen back to
  // the terminal prompt. The Telegram card remains answerable by reply-text, and
  // queued inbound is allowed to flush into the pane instead of requiring a resend.
  onTerminalFallback: (paneId: string) => void
  // Same, for an UNSCOPED question (no paneId): sweep every pane that still holds
  // a backlog. Must run AFTER the entry is deleted from `pending` so the per-pane
  // guard sees the real post-removal state.
  onUnscopedRelease: () => void
  // Grant protocol v1.1 (tg-cli#398): the daemon-owned grant + grace store
  // (in-memory mirror of the 0600 file at paths.grants; grants.ts). The daemon
  // is the ONLY authority — clients never touch this file.
  grants: GrantStoreData
  // Persist the grant store (atomic 0600 write). FAIL-CLOSED, unlike the
  // best-effort question persist: returns false on write failure, and every
  // grant mutation (mint/consume) MUST roll its in-memory change back and
  // deny/report rather than confirm a grant that a restart would replay or
  // lose.
  persistGrants: () => boolean
  // A hatch permission ask EXPIRED (retired from `pending`, both paths —
  // the unscoped backstop timer and the hook socket close): upsert its grace
  // record so a late tap within GRACE_WINDOW_MS stays addressable.
  onHatchExpired: (entry: PendingButton, pendingKey: string) => void
  // tg-cli#705: close an open card (pending or retained) on a relevance signal — a newer hatch
  // request, a decision on a sibling, an explicit withdraw. Ends a live asker's socket with a
  // `null` reply, edits the card to `status`, and the Inbox drops its copy. False when `key`
  // names no open card.
  closeCard: (key: string, status: string) => boolean
  // Every card not yet delivered, a retained one with a queued decision included — what a
  // newer hatch request or a sibling's decision closes.
  closableCards: () => OpenCard[]
  // tg-cli#717: post a card with no session topic INTO the 📥 Inbox (with a notification),
  // recorded as its own Inbox entry so no second copy is posted. null when topics are off or
  // the Inbox is unavailable — the caller then posts to General.
  postCardToInbox: (req: ButtonRequest, key: string) => Promise<{ messageId: number; threadId: number } | null>
}

// abandonedPermissionText / abandonedMultiText (features/tg-ctl/questions.ts) cover
// a SCOPED permission or multi-question SET MEMBER whose hook socket closed (daemon
// restart mid-block, or the hook's 120s budget elapsed): the keyboard stays live so
// the user can tap once the agent reconnects, and the reconnect re-attach delivers
// the answer down the new socket. A multi-question set member additionally can't be
// late-delivered (the local dialog may be on a DIFFERENT question of the set — see
// ButtonRequest.multiQuestion), so its text points at the terminal instead. Both are
// built at the call site with the pane's resolved label (resolveSessionName primary) so
// the card identifies WHICH agent disconnected instead of a bare, unidentifiable
// message — and phrased as a transient reconnect, not agent death (tg-cli UX fix).

// Whether two permission ButtonRequests represent the SAME approved action —
// the guard a queued decision must pass before it is auto-delivered to a
// reconnecting hook (see handleHookSocketLine). Compares both the displayed
// question text AND the raw toolInput: the text alone is not enough, since
// toolInput can carry content (an edit's diff, a write's body, structured args)
// the question string never shows.
export function permissionPayloadMatches(a: ButtonRequest, b: ButtonRequest): boolean {
  // `a` (the retained request) is always a permission — only a permission ever
  // carries a queuedDecision (see AbandonedButton.queuedDecision). `b` (the
  // reconnecting request) is NOT guaranteed to be one: `requestId` equality alone
  // (the caller's outer gate) doesn't prove kind/agent/pane/hook-event also match
  // — a reused or hash-colliding requestId across a DIFFERENT kind/agent/pane/event
  // must never have a permission decision auto-delivered onto it (review finding:
  // "not bound to request provenance"). `permissionEvent` matters too — the reply
  // SHAPE differs between PreToolUse and PermissionRequest.
  if (a.kind !== "permission" || b.kind !== "permission") return false
  if (a.agent !== b.agent) return false
  if (a.paneId !== b.paneId) return false
  if ((a.permissionEvent ?? "PermissionRequest") !== (b.permissionEvent ?? "PermissionRequest")) return false
  if (a.question !== b.question) return false
  // `promptTurnId` (review finding): the caller's outer `requestId` equality
  // isn't itself proof of invocation identity — requestId is a SHORT djb2 hash
  // (hook-normalize.ts), and the whole "a different invocation can't reach this
  // branch" argument for dropping the delivery timer rests on env.invocationNonce
  // being folded into that hash, not on the hash being collision-free. Comparing
  // the raw `promptTurnId` values here closes that gap directly instead of
  // trusting the hash alone. A genuine reconnect (the SAME process's own
  // reconnect-and-resend loop) resends the identical serialized request — same
  // nonce — so this never rejects a real reconnect.
  if (a.promptTurnId !== b.promptTurnId) return false
  return JSON.stringify(a.toolInput ?? null) === JSON.stringify(b.toolInput ?? null)
}
