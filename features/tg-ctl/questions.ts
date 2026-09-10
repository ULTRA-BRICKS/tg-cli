// Telegram inline-button model for agent questions and permission prompts.
//
// This module is pure: the daemon owns sendMessage, editMessageText,
// answerCallbackQuery, hook sockets, and native adapter I/O.

import type { AgentKind, Registration } from './types';

export type ButtonRequestKind = 'question' | 'permission';
export type QuestionCapability = 'buttons' | 'unsupported';
export type PermissionDecision = 'allow' | 'deny';

export interface ButtonOption {
  label: string;
  description?: string;
}

// Custom wording for a permission-kind request's two buttons. Defaults to
// Approve/Reject; a plan-approval (ExitPlanMode) overrides to Proceed/Keep
// planning so the tap reads correctly while the routed decision stays allow/deny.
export interface DecisionLabels {
  allow: string;
  deny: string;
}

export interface OpencodeRequestRef {
  sessionId: string;
  requestId: string;
  replyKind: 'question' | 'question-v2' | 'permission' | 'permission-v2';
}

export interface OmpRequestRef {
  sessionId: string;
  rpcId: string | number;
}

export interface ButtonRequest {
  requestId: string;
  buttonId?: string; // short Telegram callback id; requestId may be long/opaque
  paneId?: string;
  cwd?: string;
  sessionName?: string;
  windowName?: string;
  subagent?: string;
  agent: AgentKind;
  kind: ButtonRequestKind;
  question: string;
  title?: string;
  options?: ButtonOption[];
  // Permission-kind only: relabel the allow/deny buttons (e.g. plan-approval →
  // Proceed/Keep planning). The decision routed back is unchanged (allow/deny).
  decisionLabels?: DecisionLabels;
  // Permission-kind only: which Claude Code hook event this came from. The two
  // events take DIFFERENT output shapes (PreToolUse → permissionDecision;
  // PermissionRequest → decision.behavior), so the hook reply must match the
  // event that fired. Defaults to PermissionRequest (the `*` matcher we install).
  permissionEvent?: 'PreToolUse' | 'PermissionRequest';
  // The tool's original `tool_input`, carried so an ALLOW can echo it back as
  // `updatedInput`. The live hooks docs require allow + updatedInput for the
  // user-interactive tools ("allow alone is not sufficient"); echoing the
  // unchanged input is the documented round trip. A permission echoes it
  // verbatim (PreToolUse ExitPlanMode); a claude QUESTION echoes it with the
  // collected `answers` record merged in (tg#5741) — the original input is
  // schema-valid wholesale, unlike a lossy rebuild from the request fields
  // (which stays as the fallback for manual/back-compat callers).
  toolInput?: Record<string, unknown>;
  // This request is ONE member of a multi-question AskUserQuestion set. A lone
  // answer is meaningless to the harness (the reply needs the WHOLE answers
  // record), so a set member must never be LATE-DELIVERED into the pane — the
  // local multi-question dialog may be showing a DIFFERENT question, and the
  // injected text would answer the wrong prompt (all-or-nothing contract).
  // Reconnect re-attach (daemon bounce mid-collection) still works: retention
  // is unchanged, only the pane-injection fallback is refused.
  multiQuestion?: boolean;
  opencode?: OpencodeRequestRef;
  // ACP session/request_permission (omp 18.1.14). A tap replies via the JSON-RPC
  // result on this connection — never a tmux digit inject.
  omp?: OmpRequestRef;
  // The identity proof tg-ctl requires before AUTOMATICALLY delivering a QUEUED
  // permission decision to a reconnecting hook within its retention window
  // (tg-cli#182: ABANDONED_PERMISSION_RETAIN_MS): without this proof,
  // requestId equality alone doesn't prove the reconnect is the SAME invocation
  // rather than a later, unrelated one that merely asks an identical question —
  // see permissionPayloadMatches and tg-ctl's reconnect branch. SOURCED
  // DIFFERENTLY PER KIND (hook-normalize.ts):
  //   - `permission` (and plan-approval): `env.invocationNonce`, a random id
  //     generated ONCE PER `tg-ctl ask` PROCESS — the harness spawns a fresh
  //     process for every hook event, so this is ALWAYS present for anything
  //     normalized from a raw harness payload, regardless of whether the
  //     harness itself sends `prompt_id`/`turn_id`. This is the field the
  //     auto-delivery gate actually relies on.
  //   - `question`: Claude's `prompt_id` / Codex's `turn_id` (hook-normalize
  //     .ts's `invocationSeed`) — set ONLY when the harness supplied one. A
  //     question never carries a queuedDecision (no auto-delivery hazard), so
  //     this field is informational for it, not a safety gate; kept turn-scoped
  //     (not per-process) so a re-asked question from a new process still
  //     re-attaches to its retained card (the tested multi-question retry
  //     contract) instead of hashing differently and duplicating.
  //   - Either kind: undefined for an already-normalized manual/back-compat
  //     request that omits it, or a record persisted to disk before this field
  //     existed (pre-upgrade transient).
  promptTurnId?: string;
}

export interface ButtonMessagePayload {
  chat_id: number;
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface ParsedButtonCallback {
  requestId: string;
  value: string;
}

export interface ParsedQuestionCloseCallback {
  requestId: string;
}

export type ButtonAnswer =
  | {
      status: 'answered';
      requestId: string;
      label: string;
      value: string;
      decision?: PermissionDecision;
    }
  | { status: 'unsupported'; requestId: string; reason: string };

const CALLBACK_PREFIX = 'tgq';
const CLOSE_CALLBACK_PREFIX = 'tgqc';

// A RIG_HATCH_REQUEST_* approval (agent-tools' agenttools_hatch_escalation,
// cross-repo) is a ONE-SHOT, HEADLESS `permission` request: a Python hook
// script builds it by hand (never a live harness), so it carries no `paneId`
// (no tmux session to inject into or fall back to a terminal in) and no
// `promptTurnId` (there is no per-invocation nonce source — see
// ButtonRequest.promptTurnId — because it isn't normalized from a harness
// hook payload at all). That combination means queuedDecisionCanAutoDeliver
// is always false for it AND the generic "tap again once it reconnects" /
// "answer in the terminal" fallbacks are both structurally impossible: the
// requesting `tg-ctl ask` process already exited (it cannot reconnect — it
// isn't a long-lived hook) and there never was a terminal. requestId is
// minted as `hatch-<hookId>-<12 lowercase hex chars>` (agent_tools'
// request_hatch_approval: `f"hatch-{hook_id}-{uuid.uuid4().hex[:12]}"`); the
// hex suffix is random PER ATTEMPT, so two retries of the SAME hatch never
// share a requestId — hookId is the one thing stable across retries, which is
// what lets tg-ctl recognize "this is a retry of a request I already have a
// human decision for" (handleHookSocketLine's hatch short-circuit) instead of
// only ever matching by exact requestId equality (the reconnect re-attach
// path above, which a hatch retry can never hit — a NEW random requestId every
// time means `rt.abandoned.get(pendingKey)` never finds the prior attempt).
const HATCH_REQUEST_RE = /^hatch-(.+)-[0-9a-f]{12}$/;

// Exported: the "is this the one delivery path a headless RIG_HATCH_REQUEST_*
// approval has" check is a stable domain concept consumed both here
// (text builders below) and in tg-ctl (retainAbandonedQuestion's paneless
// retention carve-out, the durable-state restore filter) — a shared boundary
// name, not an inlineable one-off.
export function parseHatchHookId(requestId: string): string | null {
  const m = HATCH_REQUEST_RE.exec(requestId);
  return m ? m[1] : null;
}

export function isHatchRequest(req: Pick<ButtonRequest, 'requestId'>): boolean {
  return parseHatchHookId(req.requestId) !== null;
}

// The `RIG_HATCH_REQUEST_<HOOK_ID>` env var name for a parsed hookId — the SAME
// canonicalization agent-tools' `hatch_env_var` applies (hook_id is passed
// hyphenated, e.g. "block-reset-hard"; the env var uppercases and swaps
// hyphens for underscores: `hook_id.strip().upper().replace("-", "_")`).
// Mirrored here (three call sites below need lockstep spelling) so the retry
// command shown to the human is byte-identical to what the hook itself
// documents, not a re-derived spelling that could drift.
function hatchEnvVarName(hookId: string): string {
  return `RIG_HATCH_REQUEST_${hookId.trim().toUpperCase().replace(/-/g, '_')}`;
}

// Registration guard for incoming hook requests. paneId is authoritative: when
// both sides know the pane, a mismatch REJECTS even if cwd/sessionName agree —
// a second keyboard session in the same cwd must never block on Telegram.
// cwd comparison is the caller's job (path normalization needs node:path);
// pass both already-resolved.
export function registrationAllowsHook(
  reg: Registration | null,
  req: Pick<ButtonRequest, 'paneId' | 'cwd' | 'sessionName'>,
  resolvePath: (p: string) => string = (p) => p,
): boolean {
  if (!reg) return false;
  if (req.paneId && reg.paneId) return req.paneId === reg.paneId;
  if (req.cwd && reg.cwd && resolvePath(req.cwd) === resolvePath(reg.cwd)) return true;
  if (req.sessionName && reg.sessionName && req.sessionName === reg.sessionName) return true;
  return false;
}

// Per-pane registration SET gate (tg-cli#67): a hook question is forwarded when
// its pane (the asking session's TMUX_PANE, carried in the ask payload) matches
// ANY registered entry — so EVERY concurrently-registered session's questions
// forward, each scoped to its own pane, instead of only the single global
// last-writer. Each entry is checked with the same per-entry rule as the
// single-registration path (registrationAllowsHook), so the paneId-authoritative
// guard (a second keyboard session in the same cwd but a different pane is
// rejected by THAT entry) is preserved unchanged. An empty set rejects
// (fail-closed), matching `reg === null`.
export function registrationSetAllowsHook(
  regs: Registration[],
  req: Pick<ButtonRequest, 'paneId' | 'cwd' | 'sessionName'>,
  resolvePath: (p: string) => string = (p) => p,
): boolean {
  return regs.some((reg) => registrationAllowsHook(reg, req, resolvePath));
}

// Hatch permission asks (agent-tools hatch escalation) arrive from non-tmux omp
// with pane=- and a cwd that is not in the registration set. The #67
// not-registered gate would drop them before Telegram ever sees the card.
// Kind AND prefix: a question that merely reuses `hatch-` is still gated.
export function isHatchPermissionRequest(
  req: Pick<ButtonRequest, 'kind' | 'requestId'>,
): boolean {
  return req.kind === 'permission' && req.requestId.startsWith('hatch-');
}

// Exhaustive over AgentKind on purpose: adding a new kind forces a deliberate
// capability decision here (the compiler flags a missing case) instead of a
// silent default — omp is ACP buttons (session/request_permission), not the
// tmux floor.
// The default branch is the RUNTIME fail-safe: the kind crosses a JS boundary
// (JSON on the hook socket), so an out-of-union value must still get the safe
// capability rather than `undefined`.
export function questionCapability(agent: AgentKind): QuestionCapability {
  switch (agent) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'omp':
      return 'buttons';
    case 'pi':
    case 'aider':
    case 'unknown':
      return 'unsupported';
    default: {
      const _exhaustive: never = agent;
      void _exhaustive;
      return 'unsupported';
    }
  }
}

export function buildButtonMessage(chatId: number, req: ButtonRequest): ButtonMessagePayload {
  return {
    chat_id: chatId,
    text: buildQuestionText(req),
    reply_markup: {
      inline_keyboard: buildInlineKeyboard(req),
    },
  };
}

export function buildPostTimeoutQuestionMessage(chatId: number, req: ButtonRequest): ButtonMessagePayload {
  return {
    chat_id: chatId,
    text: [
      buildQuestionText(req, { includeOptions: true }),
      'Time-out expired. Reply to this message with your answer; it will still be sent to the agent.',
    ].join('\n\n'),
    reply_markup: {
      inline_keyboard: [[{ text: 'Close', callback_data: closeQuestionCallbackData(callbackRequestId(req)) }]],
    },
  };
}

// The hook socket for a SCOPED permission closed — either a daemon restart (fully
// reconnectable: the reconnecting hook re-attaches to this exact card) OR the
// harness's own ~120s hook budget elapsing, in which case the harness has likely
// already fallen back to prompting in the terminal and there may be no live hook
// left to reconnect. The daemon can't tell the two apart from a bare socket close,
// so the text never PROMISES a reconnect — it states what IS true either way: the
// card restores automatically if a reconnect happens, and a tap right now is
// QUEUED (see queuedPermissionDecisionText) rather than silently dropped, so the
// choice is never lost even when reconnect never comes. `label` identifies WHICH
// pane (the caller resolves it with resolveWindowAgentLabel,
// features/tg-ctl/agent-match.ts) so a fleet with several agents can tell which one
// needs attention instead of a bare, unidentifiable card. The ORIGINAL prompt
// (buildQuestionText) rides along too — the status line alone would invite a tap
// on Approve/Reject buttons with no visible clue what they're approving, which is
// worse than the socket never having closed at all (review finding).
// The "queued and delivered the moment that happens" promise below is only
// true when queuedDecisionCanAutoDeliver(req) — same predicate, same rule as
// queuedPermissionDecisionText and the tap-time toast (review finding: this
// INITIAL disconnect card, shown before any tap even happens, made the same
// overclaim for a no-promptTurnId request).
export function abandonedPermissionText(req: ButtonRequest, label: string): string {
  const status = queuedDecisionCanAutoDeliver(req)
    ? `hook disconnected for ${label} — if it reconnects, this card restores automatically. A tap now is queued and delivered the moment that happens; you can also answer directly in the terminal.`
    : `hook disconnected for ${label} — if it reconnects, this card restores automatically. A tap now is queued, but this daemon can't prove a later reconnect is the SAME request, so it won't auto-deliver; you'll need to tap again once it reconnects, or answer directly in the terminal.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// Hatch counterpart to abandonedPermissionText: a RIG_HATCH_REQUEST_<hookId>
// (see parseHatchHookId) has no pane to reconnect into and no terminal to
// answer in — the requesting `tg-ctl ask` process already exited — so this
// must NOT make either promise. Instead it names the one path that actually
// works: retrying the exact same command with the same
// RIG_HATCH_REQUEST_<HOOK_ID> env var, which handleHookSocketLine's hatch
// short-circuit recognizes as the same hatch and answers immediately (see
// hatchApprovalRecordedText for the post-tap version of this same message).
// The caveat ("only if still current") matters because a retry may run long
// after the original need — a stale auto-applied decision would be worse
// than asking again.
export function hatchAbandonedPermissionText(req: ButtonRequest, hookId: string): string {
  const status = `hatch request disconnected — the requesting command already gave up waiting, so there is no live process left to answer. A tap now IS recorded: retry the exact same command with the same ${hatchEnvVarName(hookId)}="<justification>" env var and it will be applied automatically with no new Telegram prompt. Only retry if the original need is still current.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// A Telegram tap landed while a permission's hook was disconnected (see
// abandonedPermissionText): the decision can't be delivered yet (no live socket to
// write the hook's JSON reply to), so it is QUEUED on the retained entry and
// flushed automatically the instant a reconnecting hook re-attaches to the same
// requestId (features/tg-ctl/questions.ts callers: tg-ctl's RECONNECT re-attach
// branch). Re-tappable: a later tap overwrites the queued decision (last tap
// wins) in case of a misclick, up until it is actually delivered. Keeps the
// original prompt visible for the same reason as abandonedPermissionText.
// THE single source of truth for "can a queued decision on this request ever
// auto-deliver on reconnect" — every UI surface that promises (or refuses to
// promise) automatic delivery MUST branch on this, not re-derive the same
// truthiness check independently (review finding: two independently-written
// conditions — even identical ones today — silently drift the moment either
// is edited, reintroducing the exact toast/card disagreement bug this predicate
// exists to prevent). tg-ctl's reconnect-branch delivery gate CALLS this
// directly (`queuedDecisionCanAutoDeliver(retained.req) &&`) rather than
// re-deriving the truthiness check inline — see ButtonRequest.promptTurnId's
// own doc comment for why permission vs question source it differently. Note:
// necessary, not sufficient — the reconnect branch additionally requires
// `permissionPayloadMatches` (which itself compares raw `promptTurnId`
// equality, not just presence) before actually delivering.
export function queuedDecisionCanAutoDeliver(req: ButtonRequest): boolean {
  return Boolean(req.promptTurnId);
}

// The "delivered automatically once the hook reconnects" promise is only TRUE
// when `queuedDecisionCanAutoDeliver(req)` — for a PERMISSION (the only kind
// that ever carries a queuedDecision), `promptTurnId` is `env.invocationNonce`
// (a per-process nonce, hook-normalize.ts), NOT `prompt_id`/`turn_id` — a
// turn-level id alone is NOT sufficient (it can't distinguish two invocations
// in the same turn); see ButtonRequest.promptTurnId's own doc comment for the
// full per-kind sourcing. tg-ctl's reconnect branch REQUIRES it before
// auto-delivering. Without it (a request persisted to disk before this field
// existed, or a manual/back-compat caller that hand-builds an already-normalized
// request) a reconnect always falls through to a fresh live prompt instead, so
// the auto-delivery promise would be false — the SAME predicate tg-ctl's
// tap-time callback TOAST uses (review finding: the toast was the one
// remaining place that still made the unconditional promise).
// `queuedDecisionStillWaitingText` (below) ALSO self-gates on this predicate
// now (defense-in-depth) — its CALLER (tg-ctl's noticeStaleQueuedDecisions)
// already skips a no-proof entry before ever calling it, so today this is
// belt-and-suspenders, not a behavior change; it just means a FUTURE direct
// caller can't reintroduce the overclaim by bypassing that caller-side gate.
export function queuedPermissionDecisionText(req: ButtonRequest, label: string, decisionLabel: string): string {
  const status = queuedDecisionCanAutoDeliver(req)
    ? `queued "${decisionLabel}" for ${label} — delivered automatically once the hook reconnects. Tap again to change it, or answer in the terminal now.`
    : `queued "${decisionLabel}" for ${label} — this daemon can't prove a later reconnect is the SAME request, so it won't auto-deliver; you'll need to tap again (or answer in the terminal) once it reconnects.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// Hatch counterpart to queuedPermissionDecisionText: a tap DID land for a
// RIG_HATCH_REQUEST_<hookId> (see parseHatchHookId) whose requesting process
// had already exited, so — unlike a scoped permission — there is no live hook
// socket to deliver to and never will be for THIS attempt. The decision is
// still recorded (findQueuedHatchDecision, tg-ctl) so a retry (a NEW
// requestId, same hookId) is answered instantly instead of asking again.
export function hatchApprovalRecordedText(req: ButtonRequest, hookId: string, decisionLabel: string): string {
  const status = `recorded "${decisionLabel}" for hatch request ${hookId} — the requesting command already gave up waiting, so it could not be delivered. Retry the exact same command with the same ${hatchEnvVarName(hookId)}="<justification>" env var and it will be applied automatically with no new Telegram prompt. Only retry if the original need is still current.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// Same socket-close event, but for a multi-question SET MEMBER: a lone late answer
// must NOT be delivered (the local dialog may be showing a DIFFERENT question of
// the set, see ButtonRequest.multiQuestion) and, unlike a permission, there is no
// safe single-value queue for a set — so the terminal is the only path until (or
// unless) the hook reconnects and the card restores itself. Keeps the original
// prompt visible for the same reason as abandonedPermissionText.
export function abandonedMultiText(req: ButtonRequest, label: string): string {
  const status = `hook disconnected for ${label} — if it reconnects, this card restores automatically. Until then this question can't be delivered from here; answer all questions in the terminal.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// Reconnect never happened within the applicable retention window
// (ABANDONED_RETAIN_MS for a question, the much longer
// ABANDONED_PERMISSION_RETAIN_MS for a permission — tg-cli#182 — tg-ctl's
// retainMsFor): the daemon is giving up on this entry (see pruneAbandonedButtons's
// notify callback) rather than leaving the human staring at a stale "queued" or
// "hook disconnected" card forever with no further signal (Alex tg requirement:
// a long-running uncertainty must eventually be reported, not left silent). The
// keyboard is cleared for this one (see tg-ctl's notifyAbandonedLongOutage) — the
// original prompt still rides along so the human knows what was never delivered.
// `queuedDecisionLabel`, when set, means the human HAD already tapped a decision
// (still QUEUED at the moment the daemon gave up) — the text then says so
// explicitly instead of the generic "never delivered", since simply saying
// "answer in the terminal" would understate that a real choice was made and is
// about to be discarded along with this entry.
export function abandonedLongOutageText(req: ButtonRequest, label: string, queuedDecisionLabel?: string): string {
  const status = queuedDecisionLabel
    ? `still no connection for ${label} after a long wait — your queued "${queuedDecisionLabel}" was never delivered and this card is giving up on it; answer directly in the terminal.`
    : `still no connection for ${label} after a long wait — this was never delivered over Telegram; answer directly in the terminal.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// Hatch counterpart to abandonedLongOutageText: mirrors its two-branch shape
// (a named queued decision vs. none) but drops the "answer in the terminal"
// fallback — a headless hatch request never had one. Once the retention
// window elapses with no retry, the decision (if any) is discarded; the next
// attempt starts fresh and prompts again from scratch.
export function hatchAbandonedLongOutageText(req: ButtonRequest, hookId: string, queuedDecisionLabel?: string): string {
  const status = queuedDecisionLabel
    ? `hatch request ${hookId}: no retry arrived after a long wait — your recorded "${queuedDecisionLabel}" was never applied and this card is giving up on it. A fresh retry will prompt again from scratch.`
    : `hatch request ${hookId}: no retry arrived after a long wait — this was never delivered. A fresh retry will prompt again from scratch.`;
  return [buildQuestionText(req), status].join('\n\n');
}

// A QUEUED permission decision has been waiting past QUEUED_DECISION_NOTICE_MS
// with no reconnect — a PROACTIVE heads-up (Alex tg#9982: if the connection
// doesn't recover for a long time, say so), fired ONCE per queued tap
// (tg-ctl tracks `queuedDecision.notifiedAt` so this never repeats on every
// sweep). Unlike the pre-fix "demoted" text this replaced, the decision is
// NEVER cleared here — it stays fully queued and deliverable the instant a
// genuine reconnect lands within its retention window; this is a notice, not
// an expiry (the entry's own later expiry, if the window runs out with no
// reconnect, is handled elsewhere — see the next comment).
// `decisionLabel` is deliberately NOT promised "however long that takes" — the
// entry is still bound by its retention window (ABANDONED_PERMISSION_RETAIN_MS
// for a permission — tg-cli#182 — the daemon's genuine give-up point,
// tg-ctl's notifyAbandonedLongOutage), so a human who never re-taps and
// never sees that later give-up notice would be misled by an unconditional
// guarantee (review finding). This says only what's true right now: not
// discarded YET, still queued, will keep trying until reconnect OR the
// retention window runs out (at which point the human gets a SEPARATE,
// explicit notice — this text is never the last word on it). Self-gates on
// queuedDecisionCanAutoDeliver like abandonedPermissionText and
// queuedPermissionDecisionText — the CALLER (tg-ctl's noticeStaleQueuedDecisions)
// already gates before ever calling this, so this is defense-in-depth, not a
// change in current behavior: a FUTURE caller that skips that gate must not be
// able to reintroduce the overclaim just by calling this function directly
// (two review models independently flagged this as the one builder relying
// solely on its caller's discipline instead of its own).
export function queuedDecisionStillWaitingText(req: ButtonRequest, label: string, decisionLabel: string): string {
  const status = queuedDecisionCanAutoDeliver(req)
    ? `still waiting to reconnect for ${label} — your queued "${decisionLabel}" has NOT been discarded and will still be delivered automatically if it reconnects. If the connection stays down much longer you'll get a separate notice. Tap again to change it, or answer in the terminal now.`
    : `still waiting to reconnect for ${label} — your queued "${decisionLabel}" has NOT been discarded, but this daemon can't prove a later reconnect is the SAME request, so it won't auto-deliver; you'll need to tap again once it reconnects. If the connection stays down much longer you'll get a separate notice. You can also answer in the terminal now.`;
  return [buildQuestionText(req), status].join('\n\n');
}

export function buildAnsweredQuestionText(req: ButtonRequest, answer: string): string {
  return [
    buildQuestionText(req),
    `Selected answer: ${answer}`,
  ].join('\n\n');
}

export function parseButtonCallback(data: string | undefined): ParsedButtonCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  return { requestId: parts[1], value: parts[2] };
}

export function parseQuestionCloseCallback(data: string | undefined): ParsedQuestionCloseCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 2 || parts[0] !== CLOSE_CALLBACK_PREFIX || !parts[1]) return null;
  return { requestId: parts[1] };
}

export function resolveButtonCallback(req: ButtonRequest, cb: ParsedButtonCallback): ButtonAnswer {
  if (cb.requestId !== callbackRequestId(req)) {
    return { status: 'unsupported', requestId: req.requestId, reason: 'callback request mismatch' };
  }

  if (req.kind === 'permission') {
    const labels = permissionLabels(req);
    if (cb.value === 'allow') {
      return { status: 'answered', requestId: req.requestId, label: labels.allow, value: 'allow', decision: 'allow' };
    }
    if (cb.value === 'deny') {
      return { status: 'answered', requestId: req.requestId, label: labels.deny, value: 'deny', decision: 'deny' };
    }
    return { status: 'unsupported', requestId: req.requestId, reason: 'unknown permission button' };
  }

  const match = cb.value.match(/^o(\d+)$/);
  const index = match ? Number(match[1]) : -1;
  const option = questionOptions(req)[index];
  if (!option) return { status: 'unsupported', requestId: req.requestId, reason: 'unknown question option' };
  return {
    status: 'answered',
    requestId: req.requestId,
    label: option.label,
    value: option.label,
  };
}

// The Claude Code PreToolUse answer envelope for AskUserQuestion: allow +
// updatedInput({questions, answers}) pre-answers the question with no local
// dialog. `hookEventName` is REQUIRED — Claude Code (verified on 2.1.198)
// validates hook JSON output and DISCARDS the ENTIRE output when
// hookSpecificOutput lacks it ("hookSpecificOutput is missing required field
// hookEventName"), so without it the card reads "answered" while the agent
// falls back to the local question UI and the answer never arrives (tg#5741).
// `input` should be the tool's ORIGINAL `tool_input` whenever available: CC
// schema-validates updatedInput wholesale against the tool's input schema
// (option `description` is a REQUIRED field there, previews must survive, …),
// which the original input satisfies by construction.
export function buildClaudeQuestionAnswerOutput(
  input: Record<string, unknown>,
  answers: Record<string, string>,
): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input, answers },
    },
  };
}

export function formatAgentHookOutput(req: ButtonRequest, answer: ButtonAnswer): unknown | null {
  if (answer.status !== 'answered') return null;

  if (req.agent === 'claude' && req.kind === 'question') {
    // Prefer echoing the ORIGINAL tool_input; rebuild from the request fields
    // only for manual/back-compat callers that never carried it.
    const input = req.toolInput ?? {
      questions: [
        {
          header: req.title,
          question: req.question,
          options: req.options ?? [],
        },
      ],
    };
    return buildClaudeQuestionAnswerOutput(input, { [req.question]: answer.value });
  }

  if (req.agent === 'claude' && req.kind === 'permission') {
    const behavior = answer.decision ?? decisionFromValue(answer.value);
    // On a RELABELED deny (plan-approval → "Keep planning"), convey the tapped
    // label as the reason so the model gets the INTENT, not an unexplained block
    // (a bare deny on ExitPlanMode can leave it re-prompting or looping). A plain
    // Approve/Reject deny carries no extra reason (the default "Reject" is noise).
    const denyReason = behavior === 'deny' && req.decisionLabels ? answer.label : undefined;

    // PreToolUse output (hookEventName REQUIRED): permissionDecision, with the deny
    // reason in the event's own `permissionDecisionReason`. For an ALLOW the live
    // hooks docs require `updatedInput` ALONGSIDE allow for the user-interactive
    // tools (ExitPlanMode / AskUserQuestion): "Returning allow alone is not
    // sufficient for these tools." Echo the unchanged `tool_input` back so the tool
    // runs without falling through to the local permission prompt.
    if (req.permissionEvent === 'PreToolUse') {
      const out: Record<string, unknown> = { hookEventName: 'PreToolUse', permissionDecision: behavior };
      if (behavior === 'allow' && req.toolInput) out.updatedInput = req.toolInput;
      if (denyReason) out.permissionDecisionReason = denyReason;
      return { hookSpecificOutput: out };
    }
    // PermissionRequest output (hookEventName REQUIRED). The `decision` object has a
    // `message` field documented "for deny only: tells Claude why the permission was
    // denied" (live hooks reference, PermissionRequest decision control). That is the
    // MODEL-facing reason channel — distinct from top-level `systemMessage`, which is
    // "shown to the user" only. On a RELABELED deny (plan-approval → "Keep planning")
    // the intent must reach Claude so it resumes planning rather than re-prompting on
    // an unexplained block, so the tapped label rides `decision.message`. A bare allow
    // needs no `updatedInput` echo (it is optional for a permission we never modify).
    const decision: Record<string, unknown> = { behavior };
    if (denyReason) decision.message = denyReason;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }

  if (req.agent === 'codex' && req.kind === 'permission') {
    const behavior = answer.decision ?? decisionFromValue(answer.value);
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: behavior === 'deny'
          ? { behavior, message: 'Rejected from Telegram' }
          : { behavior },
      },
    };
  }

  if (req.agent === 'opencode') {
    return { answer: answer.value };
  }

  return null;
}

// Pull the answers record out of ONE daemon reply line (the JSON the daemon
// writes down the hook socket for an answered claude question). Tolerant of the
// LEGACY envelope that predates `hookEventName` — the RUNNING daemon may be
// older than this hook client (the live-symlink deploy updates the client the
// moment main advances, the daemon only on restart) — because only the
// `updatedInput.answers` shape matters here. null → not an answered-question
// reply (a "null" decline, a permission envelope, or garbage).
export function extractAnswersFromHookReply(raw: string | null): Record<string, string> | null {
  if (!raw || raw === 'null') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const hso = (parsed as Record<string, unknown>).hookSpecificOutput;
  if (!hso || typeof hso !== 'object') return null;
  const updated = (hso as Record<string, unknown>).updatedInput;
  if (!updated || typeof updated !== 'object') return null;
  const answers = (updated as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const out: Record<string, string> = {};
  for (const [question, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== 'string') return null;
    out[question] = value;
  }
  return out;
}

// Sequentially collect an answer for EACH question request via the injected ask
// function (one Telegram card at a time — the next card posts only after the
// previous answer lands). ALL-OR-NOTHING: any decline/timeout aborts the whole
// collection (null) so the local question UI takes over. A PARTIAL answers
// record must never be emitted — once a hook supplies updatedInput no dialog is
// shown, so Claude Code would silently record the unanswered questions as
// "(no option selected)".
export async function collectQuestionAnswers(
  requests: ButtonRequest[],
  ask: (req: ButtonRequest) => Promise<string | null>,
): Promise<Record<string, string> | null> {
  const merged: Record<string, string> = {};
  for (const req of requests) {
    const answers = extractAnswersFromHookReply(await ask(req));
    const value = answers?.[req.question];
    if (typeof value !== 'string') return null;
    merged[req.question] = value;
  }
  return merged;
}

// Rebuild the answer envelope for a single claude-question reply from the
// ORIGINAL tool input carried on the request. Repairs replies from a STALE
// RUNNING daemon that predates `hookEventName` (see extractAnswersFromHookReply)
// so the fix works the moment the hook client updates, before the daemon is
// restarted. null → not repairable (no original input, or the reply carries no
// recognizable answer); the caller then forwards the daemon reply verbatim.
export function repairClaudeQuestionReply(req: ButtonRequest, raw: string | null): string | null {
  if (req.agent !== 'claude' || req.kind !== 'question' || !req.toolInput) return null;
  const answers = extractAnswersFromHookReply(raw);
  const value = answers?.[req.question];
  if (typeof value !== 'string') return null;
  return JSON.stringify(buildClaudeQuestionAnswerOutput(req.toolInput, { [req.question]: value }));
}

// Allow/deny button wording for a permission request: a plan-approval relabels
// the pair (Proceed/Keep planning); everything else stays Approve/Reject.
function permissionLabels(req: ButtonRequest): DecisionLabels {
  return req.decisionLabels ?? { allow: 'Approve', deny: 'Reject' };
}

function buildInlineKeyboard(req: ButtonRequest): ButtonMessagePayload['reply_markup']['inline_keyboard'] {
  if (req.kind === 'permission') {
    const labels = permissionLabels(req);
    return [[
      { text: labels.allow, callback_data: callbackData(callbackRequestId(req), 'allow') },
      { text: labels.deny, callback_data: callbackData(callbackRequestId(req), 'deny') },
    ]];
  }

  return questionOptions(req).map((option, index) => [
    { text: option.label, callback_data: callbackData(callbackRequestId(req), `o${index}`) },
  ]);
}

function buildQuestionText(req: ButtonRequest, opts: { includeOptions?: boolean } = {}): string {
  const heading = req.kind === 'permission'
    ? `Permission request from ${req.agent}`
    : `Question from ${req.agent}`;
  const parts = [heading];
  parts.push(formatQuestionSource(req));
  if (req.title) parts.push(req.title);
  parts.push(req.question);
  if (opts.includeOptions && req.kind === 'question') parts.push(formatQuestionOptions(req));
  return parts.join('\n\n');
}

function formatQuestionSource(req: ButtonRequest): string {
  const labels = [`agent=${req.agent}`];
  if (req.subagent) labels.push(`subagent=${req.subagent}`);
  if (req.windowName) labels.push(`window=${req.windowName}`);
  if (req.paneId) labels.push(`pane=${req.paneId}`);
  if (req.sessionName) labels.push(`session=${req.sessionName}`);
  const lines = [`Source: ${labels.join(' · ')}`];
  if (req.cwd) lines.push(`Cwd: ${req.cwd}`);
  return lines.join('\n');
}

function formatQuestionOptions(req: ButtonRequest): string {
  const rows = questionOptions(req).map((option, index) => {
    const description = option.description ? ` - ${option.description}` : '';
    return `${index + 1}. ${option.label}${description}`;
  });
  return ['Options:', ...rows].join('\n');
}

function questionOptions(req: ButtonRequest): ButtonOption[] {
  return req.options?.length ? req.options : [{ label: 'OK' }];
}

export function callbackRequestId(req: ButtonRequest): string {
  if (req.buttonId && /^[A-Za-z0-9_-]{1,40}$/.test(req.buttonId)) return req.buttonId;
  if (/^[A-Za-z0-9_-]{1,40}$/.test(req.requestId)) return req.requestId;
  return `b${hashId(req.requestId)}`;
}

function callbackData(requestId: string, value: string): string {
  return `${CALLBACK_PREFIX}:${requestId}:${value}`;
}

function closeQuestionCallbackData(requestId: string): string {
  return `${CLOSE_CALLBACK_PREFIX}:${requestId}`;
}

function hashId(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function decisionFromValue(value: string): PermissionDecision {
  return value === 'deny' ? 'deny' : 'allow';
}
