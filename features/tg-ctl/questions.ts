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

export interface ButtonRequest {
  requestId: string;
  buttonId?: string; // short Telegram callback id; requestId may be long/opaque
  paneId?: string;
  cwd?: string;
  sessionName?: string;
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
const MAX_ANSWERED_MESSAGE_CHARS = 3900;
const MAX_ANSWERED_LABEL_CHARS = 500;
const MAX_ANSWERED_CONTEXT_CHARS = 500;
const MAX_ANSWERED_QUESTION_CHARS = 2200;

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

export function questionCapability(agent: AgentKind): QuestionCapability {
  if (agent === 'claude' || agent === 'codex' || agent === 'opencode') return 'buttons';
  return 'unsupported';
}

export function buildButtonMessage(chatId: number, req: ButtonRequest): ButtonMessagePayload {
  const heading = req.kind === 'permission'
    ? `Permission request from ${req.agent}`
    : `Question from ${req.agent}`;
  const parts = [heading];
  if (req.title) parts.push(req.title);
  parts.push(req.question);

  return {
    chat_id: chatId,
    text: parts.join('\n\n'),
    reply_markup: {
      inline_keyboard: buildInlineKeyboard(req),
    },
  };
}

export function formatAnsweredButtonMessage(
  req: ButtonRequest,
  answer: Extract<ButtonAnswer, { status: 'answered' }>,
): string {
  const heading = req.kind === 'permission' ? 'Permission answered' : 'Question answered';
  const parts = [
    heading,
    `Agent: ${req.agent}`,
    `Subagent: ${truncateAnsweredField(answeredSubagentLabel(req), MAX_ANSWERED_LABEL_CHARS)}`,
  ];
  const context = answeredContextLabel(req);
  if (context) parts.push(`Context: ${truncateAnsweredField(context, MAX_ANSWERED_CONTEXT_CHARS)}`);
  if (req.title) parts.push(`Title:\n${truncateAnsweredField(req.title, MAX_ANSWERED_LABEL_CHARS)}`);
  parts.push(`Asked:\n${truncateAnsweredField(req.question, MAX_ANSWERED_QUESTION_CHARS)}`);
  parts.push(`Selected:\n${truncateAnsweredField(answer.label, MAX_ANSWERED_LABEL_CHARS)}`);
  return truncateAnsweredField(parts.join('\n\n'), MAX_ANSWERED_MESSAGE_CHARS);
}

function truncateAnsweredField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = '\n... [truncated]';
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

export function parseButtonCallback(data: string | undefined): ParsedButtonCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  return { requestId: parts[1], value: parts[2] };
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

function questionOptions(req: ButtonRequest): ButtonOption[] {
  return req.options?.length ? req.options : [{ label: 'OK' }];
}

export function callbackRequestId(req: ButtonRequest): string {
  if (req.buttonId && /^[A-Za-z0-9_-]{1,40}$/.test(req.buttonId)) return req.buttonId;
  if (/^[A-Za-z0-9_-]{1,40}$/.test(req.requestId)) return req.requestId;
  return `b${hashId(req.requestId)}`;
}

function answeredSubagentLabel(req: ButtonRequest): string {
  const explicit = req.subagent?.trim();
  if (explicit) return explicit;
  const session = req.sessionName?.trim();
  if (session) return `session ${session}`;
  const pane = req.paneId?.trim();
  if (pane) return `pane ${pane}`;
  const project = cwdBasename(req.cwd);
  if (project) return `project ${project}`;
  return 'unknown';
}

function answeredContextLabel(req: ButtonRequest): string | null {
  const parts: string[] = [];
  const session = req.sessionName?.trim();
  if (session) parts.push(`session ${session}`);
  const pane = req.paneId?.trim();
  if (pane) parts.push(`pane ${pane}`);
  const project = cwdBasename(req.cwd);
  if (project) parts.push(`project ${project}`);
  return parts.length ? parts.join(', ') : null;
}

function cwdBasename(path: string | undefined): string | null {
  const cleaned = path?.trim().replace(/[\\/]+$/, '');
  if (!cleaned) return null;
  const parts = cleaned.split(/[\\/]+/);
  return parts[parts.length - 1] || null;
}

function callbackData(requestId: string, value: string): string {
  return `${CALLBACK_PREFIX}:${requestId}:${value}`;
}

function hashId(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function decisionFromValue(value: string): PermissionDecision {
  return value === 'deny' ? 'deny' : 'allow';
}
