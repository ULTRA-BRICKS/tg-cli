// Normalize a RAW harness hook payload into a ButtonRequest the daemon
// understands (q→buttons, docs/specs/2026-06-10-tg-ctl-control-design.md §8).
//
// The installed hook command is just `tg-ctl ask` (optionally `--agent codex`),
// so the agent's harness pipes its native hook JSON straight in — this module
// turns that into the normalized request, using the hook process's own
// environment (TMUX_PANE / cwd / tmux session) for the routing fields. PURE: the
// entrypoint reads stdin + env and calls in here.
//
// Supported today: Claude Code PreToolUse `AskUserQuestion` (1-4 questions,
// non-multiSelect, concrete options — a multi-question call becomes ONE
// ButtonRequest PER question via normalizeHookRequests, and the ask client
// composes the collected answers into a single hook reply; tg#5741), Claude
// Code PreToolUse `ExitPlanMode` (plan-approval — a harness BLOCKING prompt
// mirrored as Proceed/Keep planning buttons; ROADMAP "Forward harness
// confirmation / permission prompts to TG"), and Claude Code / Codex
// `PermissionRequest`. Anything else returns null → the hook emits nothing and
// the local agent UI takes over (multiSelect / free-form fall back on purpose).

import type { AgentKind } from './types';
import type { ButtonOption, ButtonRequest, ButtonRequestKind, DecisionLabels } from './questions';
import { safeSliceEnd, truncateWithEllipsis } from './text-util';
import { hookPayloadRole } from '../agent-role/role';

export interface HookEnv {
  agent: AgentKind; // from the --agent flag the installer wrote (default claude)
  paneId?: string; // $TMUX_PANE of the hook process, else its verified rig-wrapper `host:<name>` (tg-cli#544)
  cwd?: string; // hook process cwd (payload.cwd wins when present)
  sessionName?: string; // tmux session of the pane
  windowName?: string; // tmux window name of the hook process
  subagent?: string; // TG_AGENT / harness subagent signal when available
  // A random id the entrypoint generates ONCE per `tg-ctl ask` PROCESS (see
  // tg-ctl's askDaemon). This is the PRIMARY per-invocation identity proof
  // folded into every requestId hash below and carried as
  // ButtonRequest.promptTurnId — see that field's own doc comment (questions.ts)
  // for why it exists and what it gates.
  invocationNonce: string;
}

// djb2 — a short stable id so a repeated identical prompt reuses its callback key.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The per-TURN identifier Claude Code (`prompt_id`, docs: "UUID identifying the
// user prompt currently being processed", v2.1.196+) and Codex (`turn_id`) carry
// on every tool/permission hook event, distinct from `session_id` (which spans
// the whole conversation). Used two ways below:
//   - For a PERMISSION/plan-approval, folded in alongside the STRICT
//     `env.invocationNonce` (extra hash entropy only — the nonce alone already
//     proves per-invocation identity there; see HookEnv.invocationNonce and
//     `build`'s doc comment for why permissions need that strictness and
//     questions deliberately don't).
//   - For a QUESTION, this is the ONLY identity signal used (no
//     `env.invocationNonce`) — a question has no queuedDecision auto-delivery
//     hazard, and the existing, TESTED multi-question retry contract
//     (ctl-multi-question-abandon-integration.test.ts) relies on a re-asked
//     question — a genuinely NEW `tg-ctl ask` process, since the harness spawns
//     one per hook event — re-attaching to its retained card via a STABLE hash
//     instead of posting a duplicate. Folding a per-process nonce in here would
//     make every retry hash differently and break that (tried once, reverted).
//     Absent on an older/foreign harness payload, a question degrades to
//     session-only scoping — unchanged pre-existing behavior, not made worse.
function invocationSeed(p: Record<string, unknown>): string {
  if (typeof p.prompt_id === 'string' && p.prompt_id) return p.prompt_id;
  if (typeof p.turn_id === 'string' && p.turn_id) return p.turn_id;
  return '';
}

// The harness's own subagent identity on a RAW payload (top-level agent_id, written
// by Claude Code / Codex only inside a spawned subagent) outranks the hook process
// env label: a subagent inside a detached child keeps its own identity
// (docs/specs/agent-role-model.md §4.2).
function withPayloadRole(p: Record<string, unknown>, env: HookEnv): HookEnv {
  const role = hookPayloadRole(p);
  return role ? { ...env, subagent: role.label } : env;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

// Validate a client-supplied decisionLabels object: both labels must be present
// non-empty strings, else fall back to the default Approve/Reject (undefined).
function readDecisionLabels(raw: unknown): DecisionLabels | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const allow = typeof rec.allow === 'string' ? rec.allow : '';
  const deny = typeof rec.deny === 'string' ? rec.deny : '';
  return allow && deny ? { allow, deny } : undefined;
}

function readOptions(raw: unknown): ButtonOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ButtonOption[] = [];
  for (const o of raw) {
    const rec = asRecord(o);
    const label = rec && typeof rec.label === 'string' ? rec.label : null;
    if (!label) continue;
    const description = rec && typeof rec.description === 'string' ? rec.description : undefined;
    out.push(description ? { label, description } : { label });
  }
  return out.length ? out : null;
}

// Tolerant readers for the grant protocol v1.1 additive subfields (tg-cli#398):
// a present-but-malformed subfield is DROPPED (the field degrades to its
// remaining valid parts, or undefined), never a rejection — an old daemon must
// keep accepting a new lib's payload.
function readAskOrigin(raw: unknown): ButtonRequest['origin'] {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const out: NonNullable<ButtonRequest['origin']> = {};
  if (typeof rec.agent === 'string' && rec.agent) out.agent = rec.agent;
  if (typeof rec.sessionId === 'string' && rec.sessionId) out.sessionId = rec.sessionId;
  if (typeof rec.subagent === 'string' && rec.subagent) out.subagent = rec.subagent;
  return Object.keys(out).length ? out : undefined;
}
function readAskOperation(raw: unknown): ButtonRequest['operation'] {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const out: NonNullable<ButtonRequest['operation']> = {};
  if (typeof rec.kind === 'string' && rec.kind) out.kind = rec.kind;
  if (typeof rec.fingerprint === 'string' && rec.fingerprint) out.fingerprint = rec.fingerprint;
  if (typeof rec.cwd === 'string' && rec.cwd) out.cwd = rec.cwd;
  if (typeof rec.repoRoot === 'string' && rec.repoRoot) out.repoRoot = rec.repoRoot;
  return Object.keys(out).length ? out : undefined;
}

// Build a ButtonRequest from an already-known field set, folding in the env.
// `promptTurnId`, when non-empty, rides along as ButtonRequest.promptTurnId —
// the identity proof tg-ctl requires before auto-delivering a QUEUED
// PERMISSION decision to a reconnecting hook within its retention window
// (tg-cli#182: ABANDONED_PERMISSION_RETAIN_MS, not a tight one — see the
// field's own doc comment in questions.ts). DELIBERATELY per-KIND, not
// blanket-applied: a `permission` gets the STRICT per-process
// `env.invocationNonce` (see HookEnv.invocationNonce) because that's the one
// place a stale queued decision could otherwise auto-apply to an unrelated
// later invocation. A `question` keeps the LOOSER turn-scoped `invocationSeed`
// (Claude's `prompt_id` / Codex's `turn_id`) on purpose: a question has no
// queuedDecision auto-delivery risk at all (only late-delivery into the pane on
// an explicit human tap, or reconnect re-attach), and the existing, TESTED
// multi-question retry contract relies on a re-asked question (a genuinely NEW
// `tg-ctl ask` process, since the harness spawns a fresh one per hook event)
// re-attaching to its retained card instead of duplicating — folding a
// per-process nonce into a question's hash would break that (caught by
// ctl-multi-question-abandon-integration.test.ts when first tried).
function build(
  env: HookEnv,
  kind: ButtonRequestKind,
  idSeed: string,
  question: string,
  title: string | undefined,
  options: ButtonOption[] | undefined,
  cwd: string | undefined,
  promptTurnId: string,
): ButtonRequest {
  return {
    requestId: `${env.agent}-${hash(idSeed)}`,
    agent: env.agent,
    kind,
    question,
    title,
    options,
    paneId: env.paneId,
    cwd: cwd ?? env.cwd,
    sessionName: env.sessionName,
    windowName: env.windowName,
    subagent: env.subagent,
    ...(promptTurnId ? { promptTurnId } : {}),
  };
}

export function normalizeHookPayload(payload: unknown, env: HookEnv): ButtonRequest | null {
  const p = asRecord(payload);
  if (!p) return null;

  // Already a normalized ButtonRequest (back-compat / manual callers): trust its
  // core fields, but let the live env supply any missing routing fields.
  if (typeof p.requestId === 'string' && typeof p.question === 'string' && (p.kind === 'question' || p.kind === 'permission')) {
    return {
      requestId: p.requestId,
      agent: (typeof p.agent === 'string' ? p.agent : env.agent) as AgentKind,
      kind: p.kind,
      question: p.question,
      title: typeof p.title === 'string' ? p.title : undefined,
      options: readOptions(p.options) ?? undefined,
      // Carry the permission-rendering fields through too — a normalized
      // plan-approval must keep its Proceed/Keep-planning labels and its
      // event-correct reply shape, not silently downgrade to Approve/Reject +
      // the default PermissionRequest output.
      decisionLabels: readDecisionLabels(p.decisionLabels),
      permissionEvent: p.permissionEvent === 'PreToolUse' ? 'PreToolUse' : undefined,
      toolInput: asRecord(p.toolInput) ?? undefined,
      multiQuestion: p.multiQuestion === true ? true : undefined,
      paneId: typeof p.paneId === 'string' ? p.paneId : env.paneId,
      cwd: typeof p.cwd === 'string' ? p.cwd : env.cwd,
      sessionName: typeof p.sessionName === 'string' ? p.sessionName : env.sessionName,
      windowName: typeof p.windowName === 'string' ? p.windowName : env.windowName,
      subagent: typeof p.subagent === 'string' ? p.subagent : env.subagent,
      promptTurnId: typeof p.promptTurnId === 'string' ? p.promptTurnId : undefined,
      // tg-cli#403 / agent-tools#754: the caller's opt-in "wait indefinitely,
      // remind periodically" mode. This is the branch a hand-built hatch
      // ButtonRequest (agent-tools' request_hatch_approval, piped into
      // `tg-ctl ask` from a Python script, never a live harness hook) actually
      // goes through — it must survive here or `critical:true` would silently
      // never reach the daemon at all.
      critical: p.critical === true ? true : undefined,
      // Grant protocol v1.1 additive fields (tg-cli#398): carry them through
      // tolerantly — the agent-tools lib ships independently of this daemon,
      // so an old lib simply omits them (undefined) and malformed subfields
      // are dropped, never a rejection. `operation` is OPAQUE here (the lib
      // computes the fingerprint; the daemon only compares it, grants.ts).
      hookId: typeof p.hookId === 'string' && p.hookId ? p.hookId : undefined,
      timeoutMs:
        typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : undefined,
      origin: readAskOrigin(p.origin),
      operation: readAskOperation(p.operation),
    };
  }

  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  const session = typeof p.session_id === 'string' ? p.session_id.slice(0, 8) : '';
  const input = asRecord(p.tool_input);
  const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';

  // Claude Code AskUserQuestion → one question request per concrete question
  // (the single-request contract of THIS function keeps only the 1-question
  // case; normalizeHookRequests exposes the full 1-4 set to the ask client).
  if (toolName === 'AskUserQuestion' && input) {
    const reqs = normalizeAskUserQuestions(p, env);
    return reqs && reqs.length === 1 ? reqs[0] : null;
  }

  // Everything below builds its request from the payload-first role (the AskUserQuestion
  // branch above resolves it itself, per question set).
  const roleEnv = withPayloadRole(p, env);

  // ExitPlanMode → plan-approval: a harness BLOCKING prompt ("the plan is ready,
  // proceed?"). It is gated as a tool (PreToolUse / PermissionRequest), but its
  // semantics are proceed-with-this-plan vs keep-planning, not Approve/Reject of a
  // side-effecting command — and its tool_input carries the PLAN TEXT, which the
  // generic permission branch drops. Forward the plan body + relabel the buttons.
  if (toolName === 'ExitPlanMode') {
    // Clamp ONCE and reuse the bounded string for both the message body and the
    // requestId seed: the full plan can be tens of KiB, and hashing/concatenating
    // it would do O(plan) work that is discarded before sending.
    const plan = clampPlan(typeof input?.plan === 'string' ? input.plan.trim() : '');
    const body = plan ? `Proceed with this plan?\n\n${plan}` : 'The plan is ready. Proceed?';
    return {
      requestId: `${env.agent}-${hash(`${session}:${invocationSeed(p)}:${env.invocationNonce}:plan:${plan}`)}`,
      agent: env.agent,
      kind: 'permission',
      question: body,
      title: 'Plan ready',
      decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
      permissionEvent: permissionEventOf(p),
      // Carry the original input so a PreToolUse allow can echo it as updatedInput
      // (docs: ExitPlanMode allow needs updatedInput, not allow alone).
      ...(input ? { toolInput: input } : {}),
      ...harnessOrigin(p),
      paneId: env.paneId,
      cwd: cwd ?? env.cwd,
      sessionName: env.sessionName,
      windowName: env.windowName,
      subagent: roleEnv.subagent,
      promptTurnId: env.invocationNonce,
    };
  }

  // PermissionRequest (Claude Code or Codex): allow/deny a tool call.
  if (p.hook_event_name === 'PermissionRequest' || (toolName && p.hook_event_name === undefined && !input?.questions)) {
    if (!toolName) return null;
    const detail = input ? summarizeInput(toolName, input) : '';
    const question = detail ? `Allow ${toolName}? ${detail}` : `Allow ${toolName}?`;
    const req = build(roleEnv, 'permission', `${session}:${invocationSeed(p)}:${env.invocationNonce}:perm:${toolName}:${detail}`, question, toolName, undefined, cwd, env.invocationNonce);
    req.permissionEvent = permissionEventOf(p);
    if (input) req.toolInput = input;
    Object.assign(req, harnessOrigin(p));
    return req;
  }

  return null;
}

// Normalize a RAW payload into the FULL set of ButtonRequests it forwards as —
// identical to normalizeHookPayload for everything except a Claude Code
// AskUserQuestion with 2-4 questions, which becomes one request per question
// (each carrying the whole original tool_input, each with its own stable
// per-question requestId so replay/reconnect dedup keeps working). The ask
// client posts them as SEQUENTIAL cards and composes ONE combined hook reply
// from the collected answers (tg#5741 — a multi-question call used to bail to
// the local UI, whose flow ends on an extra manual Enter).
export function normalizeHookRequests(payload: unknown, env: HookEnv): ButtonRequest[] | null {
  const p = asRecord(payload);
  if (!p) return null;
  if (typeof p.tool_name === 'string' && p.tool_name === 'AskUserQuestion' && asRecord(p.tool_input)) {
    return normalizeAskUserQuestions(p, env);
  }
  const single = normalizeHookPayload(payload, env);
  return single ? [single] : null;
}

// The AskUserQuestion branch shared by normalizeHookPayload (1 question) and
// normalizeHookRequests (1-4 questions). ALL-OR-NOTHING: any multiSelect or
// option-less (free-form) question bails the whole call to the local UI — a
// partially-forwarded call could only produce a partial answers record, which
// the reply path must never emit (see collectQuestionAnswers).
function normalizeAskUserQuestions(p: Record<string, unknown>, env: HookEnv): ButtonRequest[] | null {
  const input = asRecord(p.tool_input);
  if (!input) return null;
  // AskUserQuestion is forwarded ONLY via its dedicated PreToolUse matcher. The
  // `PermissionRequest *` catch-all (hook-install.ts) ALSO fires for it and
  // re-normalizes to the SAME stable requestId. Once the PreToolUse card is
  // answered the in-flight dedup key is freed, so this PermissionRequest copy
  // would post a SECOND, superseded card whose tap reads as "expired" (tg-cli#97).
  // Drop the PermissionRequest-delivered copy so exactly one hook forwards each
  // AskUserQuestion. (Manual / back-compat callers leave hook_event_name unset
  // and still pass through.)
  if (p.hook_event_name === 'PermissionRequest') return null;
  const questions = input.questions;
  // 4 = the tool's own schema cap; anything beyond is malformed → local UI.
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return null;
  // Duplicate question texts (the tool's schema refines them unique) would
  // collide the per-question requestIds AND collapse the answers record (both
  // are keyed by question text) — a malformed payload, so: local UI.
  const texts = questions.map((q) => asRecord(q)?.question);
  if (new Set(texts).size !== texts.length) return null;
  const roleEnv = withPayloadRole(p, env);
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  const session = typeof p.session_id === 'string' ? p.session_id.slice(0, 8) : '';
  const out: ButtonRequest[] = [];
  for (const rawQuestion of questions) {
    const q = asRecord(rawQuestion);
    if (!q || typeof q.question !== 'string') return null;
    if (q.multiSelect === true) return null; // multi-select → local UI (single-tap model)
    const options = readOptions(q.options);
    if (!options) return null; // free-form → local UI
    const header = typeof q.header === 'string' ? q.header : undefined;
    // A (i/N) progress suffix so the human sees more cards are coming and the
    // agent stays blocked until the LAST one is answered.
    const title = questions.length > 1 ? `${header ?? 'Question'} (${out.length + 1}/${questions.length})` : header;
    // The id seed includes the ORDERED option labels, not just the question
    // text: reconnect re-attach and answered-replay both key on this id, and a
    // LATER call re-asking the same text with DIFFERENT options must get a
    // fresh id (a stale retained card's buttons would otherwise resolve by
    // index against the new options — review finding). A true re-fire of the
    // same call keeps the same id, so tg-cli#97 dedup/replay is unchanged.
    const seed = `${session}:${invocationSeed(p)}:q:${q.question}:${options.map((o) => o.label).join('\u001F')}`;
    const req = build(roleEnv, 'question', seed, q.question, title, options, cwd, invocationSeed(p));
    // Carried so the answer envelope can echo the original input (schema-valid
    // wholesale) instead of a lossy rebuild — see buildClaudeQuestionAnswerOutput.
    req.toolInput = input;
    Object.assign(req, harnessOrigin(p));
    // A set member's lone answer must never late-deliver into the pane
    // (all-or-nothing) — see ButtonRequest.multiQuestion.
    if (questions.length > 1) req.multiQuestion = true;
    out.push(req);
  }
  return out;
}

// The harness's own session id (`session_id` on every Claude Code / Codex hook)
// rides the ask as `origin.sessionId`, so the daemon's hook socket can record
// pane → session for the session registry (session-registry-and-topics §2.1).
function harnessOrigin(p: Record<string, unknown>): Pick<ButtonRequest, 'origin'> {
  return typeof p.session_id === 'string' && p.session_id ? { origin: { sessionId: p.session_id } } : {};
}

// Bound the plan body so the forwarded prompt stays well inside Telegram's
// 4096-char message limit (the heading + buttons + wrap share that budget). A
// plan over the bound keeps its head and gains a truncation marker — the CTO can
// read the full plan in the pane; the button is for the proceed/keep decision.
const PLAN_MAX = 3000;
function clampPlan(plan: string): string {
  return plan.length > PLAN_MAX ? `${plan.slice(0, safeSliceEnd(plan, PLAN_MAX))}\n… (plan truncated — see the pane)` : plan;
}

// Which Claude Code hook event delivered this permission — the reply shape
// depends on it (PreToolUse → permissionDecision; PermissionRequest →
// decision.behavior). A PreToolUse matcher (e.g. ExitPlanMode) sets
// hook_event_name: 'PreToolUse'; the `*` PermissionRequest matcher sets
// 'PermissionRequest'; an absent field defaults to PermissionRequest (the matcher
// we install, and the pre-existing behavior for Codex-style payloads).
function permissionEventOf(p: Record<string, unknown>): 'PreToolUse' | 'PermissionRequest' {
  return p.hook_event_name === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest';
}

// A short, safe one-line summary of the tool input for the permission prompt —
// the command for Bash, the path for file tools, else nothing.
function summarizeInput(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string): string | null => (typeof input[k] === 'string' ? (input[k] as string) : null);
  const raw = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('url') ?? '';
  return truncateWithEllipsis(raw.replace(/\s+/g, ' ').trim(), 100);
}
