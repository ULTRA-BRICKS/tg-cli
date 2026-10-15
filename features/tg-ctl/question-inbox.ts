// tg-cli#705: the 📥 Inbox forum topic and the relevance signals that close an open question.
//
// Every question/permission/hatch card that is still open (the daemon's pendingButtons plus the
// abandonedButtons no tap has decided) gets a SILENT copy in one "📥 Inbox" topic, with the
// card's own buttons plus a Dismiss. The copy leaves the topic when the card leaves the open set.
// A card leaves the open set on a relevance signal — a tap or reply (on the card or its copy),
// an answer typed in chat, a newer hatch request for the same (hookId, cwd), a decision on a
// sibling hatch card, an explicit withdraw from the asker, Dismiss — never on a timer. This
// replaces the #403 / #464 "⏳ still waiting" reminders (spec:
// docs/specs/2026-10-13-question-inbox-design.md).
//
// PURE — the daemon owns the Bot API calls, the state file (`tg-ctl.<bot>.question-inbox.json`;
// named apart from the Stop-hook inbox in inbox.ts, a different thing) and the
// open-card maps; this module plans, renders and parses.

import { escapeHtml } from '../render/html';
import {
  buildButtonMessage,
  closeQuestionCallbackData,
  hatchParseMode,
  parseDecisionReplyToken,
  isHatchPermissionRequest,
  parseHatchHookId,
  type ButtonAnswer,
  type ButtonMessagePayload,
  type ButtonRequest,
} from './questions';
import { formatAge } from './text-util';

export const INBOX_TOPIC_NAME = '📥 Inbox';

// The Inbox topic and the mirror message of each open card, keyed by the card's
// callbackRequestId. `chatId` is the chat both live in: after `tg auth` rebinds the chat the
// old topic and mirrors are unreachable, so the state resets. A copy records `cardId`, the
// message id of the card it copies: a request id can be reused by a later card, and a copy
// acts only for the card it was made from. `card: true` marks an entry that IS the card
// itself — posted into the Inbox because its session has no topic (tg-cli#717) — so it is never
// copied again and never deleted on close (closing edits it in place).
export type InboxMirror = { messageId: number; cardId: number } | { messageId: number; card: true };

// `removing`: copies that left the open set but whose removal Telegram has not confirmed yet (an
// outage, a 429), retried on every sync until it does (tg-cli#722) — dropping them at the first
// failed attempt left dead copies with live buttons in the Inbox for good.
export interface InboxState {
  chatId: number;
  threadId: number | null;
  mirrors: Record<string, InboxMirror>;
  removing: number[];
}

export function emptyInboxState(chatId: number): InboxState {
  return { chatId, threadId: null, mirrors: emptyMirrors(), removing: [] };
}

// Keyed by request id, which may be any string (`__proto__`, `toString`): a null-prototype
// object, so such a key is an ordinary entry and never Object.prototype's.
export function emptyMirrors(): InboxState['mirrors'] {
  return Object.create(null) as InboxState['mirrors'];
}

export function serializeInboxState(state: InboxState): string {
  return JSON.stringify({ version: 1, ...state });
}

// Never throws: absent, malformed or foreign-chat content is a fresh state. The worst case is a
// second Inbox topic and a re-posted copy of each open card — never a lost question.
export function parseInboxState(raw: string | null, chatId: number): InboxState {
  if (!raw) return emptyInboxState(chatId);
  try {
    const r: unknown = JSON.parse(raw);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return emptyInboxState(chatId);
    const rec = r as Record<string, unknown>;
    if (rec.version !== 1 || rec.chatId !== chatId) return emptyInboxState(chatId);
    const threadId = typeof rec.threadId === 'number' && Number.isInteger(rec.threadId) ? rec.threadId : null;
    const mirrors = emptyMirrors();
    const removing: number[] = [];
    if (threadId !== null && rec.mirrors && typeof rec.mirrors === 'object' && !Array.isArray(rec.mirrors)) {
      for (const [key, m] of Object.entries(rec.mirrors as Record<string, unknown>)) {
        const entry = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
        const { messageId, cardId } = entry;
        if (typeof messageId !== 'number' || !Number.isInteger(messageId)) continue;
        if (entry.card === true) mirrors[key] = { messageId, card: true };
        // A copy without its card id (an older state file) is kept with an id no card has, so
        // the next sync replaces it with a bound one.
        else mirrors[key] = { messageId, cardId: typeof cardId === 'number' && Number.isInteger(cardId) ? cardId : -1 };
      }
    }
    // Absent in a state file from before tg-cli#722: nothing owed.
    if (threadId !== null && Array.isArray(rec.removing)) {
      for (const id of rec.removing) if (typeof id === 'number' && Number.isInteger(id)) removing.push(id);
    }
    return { chatId, threadId, mirrors, removing };
  } catch {
    return emptyInboxState(chatId);
  }
}

// The card message an Inbox entry stands for: the card itself, or the card it copies.
function mirroredCardId(m: InboxMirror): number {
  return 'card' in m ? m.messageId : m.cardId;
}

// What to change so the Inbox holds exactly one copy per open card: post the open cards with no
// copy of THEIR message yet, remove every entry whose card is no longer open — including a copy
// left from an earlier card that had the same request id. Order follows `open`, so copies are
// posted oldest card first.
export function planInboxSync(open: Iterable<{ key: string; messageId: number }>, state: InboxState): { post: string[]; remove: string[] } {
  const cardIds = new Map<string, number>();
  for (const c of open) cardIds.set(c.key, c.messageId);
  // Own keys only: a request id like `toString` must not match Object.prototype.
  const current = (key: string): boolean => Object.hasOwn(state.mirrors, key) && mirroredCardId(state.mirrors[key]) === cardIds.get(key);
  return {
    post: [...cardIds.keys()].filter((key) => !current(key)),
    remove: Object.keys(state.mirrors).filter((key) => !current(key)),
  };
}

// The Inbox entry `messageId` belongs to: its card key and the card message it stands for, or
// null when it is no Inbox entry.
export function inboxEntryOf(state: InboxState, messageId: number): { key: string; cardId: number } | null {
  for (const [key, m] of Object.entries(state.mirrors)) if (m.messageId === messageId) return { key, cardId: mirroredCardId(m) };
  return null;
}

export interface OpenCard {
  key: string;
  req: ButtonRequest;
  at: number;
}

// The Inbox copy of one open card: who asks, what kind, how long it has waited, then the card
// text exactly as the original renders it (HTML for a hatch card) and the original's buttons —
// the same callback_data, so a tap on the copy is a tap on the card — plus Dismiss.
export function inboxMirrorMessage(card: OpenCard, label: string, now: number): Pick<ButtonMessagePayload, 'text' | 'parse_mode' | 'reply_markup'> {
  const original = buildButtonMessage(0, card.req);
  const hookId = hatchIdentity(card.req)?.hookId ?? null;
  const kind = hookId !== null ? `hatch ${hookId}` : card.req.kind;
  const header = `📥 ${label} · ${kind} · ${formatAge(now - card.at)}`;
  const parseMode = hatchParseMode(card.req);
  return {
    text: `${parseMode === 'HTML' ? escapeHtml(header) : header}\n\n${original.text}`,
    parse_mode: parseMode,
    reply_markup: {
      inline_keyboard: [...original.reply_markup.inline_keyboard, [{ text: '✕ Dismiss', callback_data: closeQuestionCallbackData(card.key) }]],
    },
  };
}

// The (hookId, cwd) a hatch request is retried under: a retry of the same hatch carries the same
// hook id and runs in the same directory, with a fresh requestId each attempt.
function hatchIdentity(req: ButtonRequest): { hookId: string; cwd: string | undefined } | null {
  // A hatch is told by its request id (`hatch-<hookId>-<12 hex>`, isHatchRequest): any other
  // request may carry a `hookId` too, and must never supersede or be superseded as a hatch.
  const parsed = parseHatchHookId(req.requestId);
  if (req.kind !== 'permission' || parsed === null) return null;
  return { hookId: req.hookId ?? parsed, cwd: req.cwd ?? req.operation?.cwd };
}

// The arrival time of each ask, strictly increasing within the daemon: which of two hatch
// requests is the newer decides which card a supersede closes, and two asks arriving in the
// same millisecond must still have an order — the one they arrived in (tg-cli#723).
export function arrivalClock(now: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    last = Math.max(now(), last + 1);
    return last;
  };
}

// The open hatch cards a newer request or a decision makes irrelevant: same hook id in the same
// directory, excluding `exceptKey` (the card that decided or superseded). The directory matches
// exactly — a request with no cwd only matches cards with no cwd, so a cwd-less retry never
// closes a card asked from some other directory. `ANY_CWD` widens it to every directory: only
// for an explicit `tg-ctl withdraw --hook-id` with no `--cwd`.
export const ANY_CWD = Symbol('any cwd');
export function hatchSiblingKeys(
  cards: Iterable<OpenCard>,
  hookId: string,
  cwd: string | undefined | typeof ANY_CWD,
  exceptKey: string | null,
): string[] {
  const out: string[] = [];
  for (const card of cards) {
    if (card.key === exceptKey) continue;
    const id = hatchIdentity(card.req);
    if (id && id.hookId === hookId && (cwd === ANY_CWD || id.cwd === cwd)) out.push(card.key);
  }
  return out;
}

export function hatchSiblingsOf(cards: Iterable<OpenCard>, req: ButtonRequest, exceptKey: string): string[] {
  const id = hatchIdentity(req);
  return id ? hatchSiblingKeys(cards, id.hookId, id.cwd, exceptKey) : [];
}

// The open cards a free-text message to a session can answer: asked by that registry session,
// or asked from the pane the message goes to. A pane id (`%1`) is only unique within one tmux
// server, so the pane counts only when the card's asker ran on `serverPid`, the server that pane
// is on (tg-cli#722); a card or target whose server is unknown matches by session key alone.
// Never a hatch card: it is a shell gate, not a prompt the agent waits on (its pane is merely
// inherited — tg-cli#717), so a message to the session is for the agent. Never a multi-question
// card either: one text cannot answer each of its questions (a text reply to it is refused the
// same way).
export function sessionCardKeys(cards: Iterable<OpenCard>, target: { sessionKey?: string; paneId: string; serverPid: number | null }): string[] {
  const out: string[] = [];
  for (const card of cards) {
    if (isHatchPermissionRequest(card.req) || card.req.multiQuestion) continue;
    const bySession = target.sessionKey !== undefined && card.req.sessionKey === target.sessionKey;
    const cardServer = card.req.asker?.tmuxServerPid ?? null;
    const byPane = card.req.paneId === target.paneId && cardServer !== null && cardServer === target.serverPid;
    if (bySession || byPane) out.push(card.key);
  }
  return out;
}

// A message typed in chat as the answer to a LIVE card. A question takes the text as its answer.
// A permission reads yes/ok/да/ок as allow and no/нет as deny (the card-reply words); any other
// text denies, carrying the text as the model-facing reason so the agent learns what to do instead.
export function freeTextAnswer(req: ButtonRequest, text: string): Extract<ButtonAnswer, { status: 'answered' }> {
  const trimmed = text.trim();
  if (req.kind === 'question') return { status: 'answered', requestId: req.requestId, label: trimmed, value: trimmed };
  const choice = parseDecisionReplyToken(trimmed);
  const labels = req.decisionLabels ?? { allow: 'Approve', deny: 'Reject' };
  if (choice === 'allow') return { status: 'answered', requestId: req.requestId, label: labels.allow, value: 'allow', decision: 'allow' };
  if (choice === 'deny') return { status: 'answered', requestId: req.requestId, label: labels.deny, value: 'deny', decision: 'deny' };
  return { status: 'answered', requestId: req.requestId, label: `${labels.deny}: ${trimmed}`, value: 'deny', decision: 'deny', reason: trimmed };
}

// A withdraw line on the hook socket: `{"withdraw": "<requestId>", "reason": "…"}` closes that
// request's card; `{"withdrawHookId": "<id>", "cwd": "…", "reason": "…"}` closes every open
// hatch card of that hook (in that directory, when given). null → not a withdraw line.
export type WithdrawRequest =
  | { kind: 'request'; requestId: string; reason: string | undefined }
  | { kind: 'hook'; hookId: string; cwd: string | undefined; reason: string | undefined };

export function parseWithdrawLine(parsed: unknown): WithdrawRequest | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const reason = typeof rec.reason === 'string' && rec.reason.trim() ? rec.reason.trim() : undefined;
  if (typeof rec.withdraw === 'string' && rec.withdraw) return { kind: 'request', requestId: rec.withdraw, reason };
  if (typeof rec.withdrawHookId === 'string' && rec.withdrawHookId) {
    const cwd = typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : undefined;
    return { kind: 'hook', hookId: rec.withdrawHookId, cwd, reason };
  }
  return null;
}

// The status line a closed card shows (closedQuestionText appends it to the prompt).
export const CLOSE_STATUS = {
  superseded: '↻ superseded by a newer request',
  decided: '✓ decided',
  dismissed: '✕ dismissed',
  withdrawn: (reason: string | undefined): string => `⏹ withdrawn: ${reason ?? 'the asker withdrew the request'}`,
  answeredInChat: (text: string): string => `✓ answered in chat: ${text}`,
} as const;

export const WITHDRAW_USAGE = 'usage: tg-ctl withdraw <requestId> | --hook-id <id> [--cwd <dir>] [--reason <text>]';

// `tg-ctl withdraw` argv → the socket line it sends, or a usage error.
export function parseWithdrawArgv(argv: readonly string[]): { line: Record<string, string> } | { error: string } {
  const flags: Record<string, string> = {};
  let requestId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hook-id' || arg === '--cwd' || arg === '--reason') {
      const value = argv[++i];
      if (value === undefined || !value.trim()) return { error: `${arg} needs a value` };
      flags[arg] = value;
    } else if (arg.startsWith('--')) return { error: `unknown flag ${arg}` };
    else if (requestId === undefined) {
      if (!arg.trim()) return { error: 'the request id is empty' };
      requestId = arg;
    }
    else return { error: `unexpected argument ${arg}` };
  }
  const hookId = flags['--hook-id'];
  if ((requestId === undefined) === (hookId === undefined)) return { error: 'give exactly one of <requestId> or --hook-id <id>' };
  if (requestId !== undefined && flags['--cwd'] !== undefined) return { error: '--cwd only narrows --hook-id' };
  const line: Record<string, string> = requestId !== undefined ? { withdraw: requestId } : { withdrawHookId: hookId };
  if (flags['--cwd'] !== undefined) line.cwd = flags['--cwd'];
  if (flags['--reason'] !== undefined) line.reason = flags['--reason'];
  return { line };
}

// One reminder message still to take out of the chat it was posted in.
export interface RetireTarget {
  chatId: number;
  messageId: number;
}

// Reminder messages the removed #403 / #464 reminders may have left live in the chat (one-shot
// startup migration): every `criticalState.lastReminderMessageId` in the questions store and the
// unanswered-reminder state's `messageId`. A reminder with no recorded chat was posted before
// tg-cli#518 started recording one — in the current chat.
export function legacyReminderMessages(questionsRaw: string | null, unansweredRaw: string | null, currentChatId: number): RetireTarget[] {
  const out: RetireTarget[] = [];
  const add = (rec: unknown, idField: string, chatField: string): void => {
    if (!rec || typeof rec !== 'object') return;
    const r = rec as Record<string, unknown>;
    const messageId = r[idField];
    if (typeof messageId !== 'number' || !Number.isInteger(messageId)) return;
    const chat = r[chatField];
    out.push({ chatId: typeof chat === 'number' && Number.isInteger(chat) ? chat : currentChatId, messageId });
  };
  const questions = parseJsonOrNull(questionsRaw);
  const list = questions && typeof questions === 'object' ? (questions as Record<string, unknown>).questions : null;
  if (Array.isArray(list)) {
    for (const q of list) {
      if (q && typeof q === 'object') add((q as Record<string, unknown>).criticalState, 'lastReminderMessageId', 'lastReminderChatId');
    }
  }
  add(parseJsonOrNull(unansweredRaw), 'messageId', 'chatId');
  return out;
}

// The reminders the migration found but Telegram has not retired yet (tg-cli#723):
// `tg-ctl.<bot>.reminder-retire.json`, written BEFORE the old sources are dropped, so an outage
// at upgrade time leaves the ids on disk and the next start (or poll) retries them. Never throws:
// garbage or an unknown version is an empty queue — never a message deleted on a guess.
export function parseRetireQueue(raw: string | null): RetireTarget[] {
  const rec = parseJsonOrNull(raw);
  const r = rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : null;
  const list = r?.version === 1 ? r.messages : null;
  if (!Array.isArray(list)) return [];
  const out: RetireTarget[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const { chatId, messageId } = m as Record<string, unknown>;
    if (Number.isInteger(chatId) && Number.isInteger(messageId)) out.push({ chatId: chatId as number, messageId: messageId as number });
  }
  return out;
}

export function serializeRetireQueue(queue: readonly RetireTarget[]): string {
  return JSON.stringify({ version: 1, messages: queue });
}

// `queue` plus every target of `additions` it does not hold yet: a migration that runs again before
// the queue drained (it crashed between the queue write and the old sources' removal) adds
// nothing twice.
export function addRetireTargets(queue: readonly RetireTarget[], additions: readonly RetireTarget[]): RetireTarget[] {
  const out = [...queue];
  for (const t of additions) if (!out.some((q) => q.chatId === t.chatId && q.messageId === t.messageId)) out.push(t);
  return out;
}

// Whether the questions file still carries a record with the removed #403 `criticalState`
// field — checked on the parsed records, not the raw text, so a question that merely mentions
// the word does not re-trigger the one-shot migration's rewrite on every restart.
export function hasLegacyCriticalState(questionsRaw: string | null): boolean {
  const questions = parseJsonOrNull(questionsRaw);
  const list = questions && typeof questions === 'object' ? (questions as Record<string, unknown>).questions : null;
  return Array.isArray(list) && list.some((q) => q !== null && typeof q === 'object' && Object.hasOwn(q, 'criticalState'));
}

function parseJsonOrNull(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
