// tg-cli#464: remind the human about agent questions he has not answered.
//
// An agent's question/permission/decision card that nobody answers is never re-surfaced
// on its own: the CTO scrolls past it and the agent stays blocked for hours. Once an open
// card is older than UNANSWERED_REMINDER_AFTER_MS it gets exactly ONE reminder; the
// reminder message lists every question still waiting and REPLACES the previous reminder
// (the daemon deletes it), so the chat holds at most one "still waiting" ping. When every
// card a reminder listed is answered, the reminder itself is withdrawn.
//
// Quiet hours are #403's (hatch-critical-reminder.ts `isQuietHours`, same env knobs): a
// question that crosses the threshold at night is reminded once, right after quiet hours
// end — the next sweep outside the window finds it still un-reminded and fires then.
//
// Age is measured from when the daemon FIRST saw the card open (`firstSeen`, persisted),
// not from the entry's `at`: that clock restarts when a card's hook socket closes and it
// moves to the retained map (~2 min after posting for a Claude Code question) and on every
// re-attach, so reading it would postpone — or, with a flapping client, starve — the
// reminder.
//
// The default threshold (20 min) sits below the daemon's 30-min retention of an unanswered
// QUESTION (ABANDONED_RETAIN_MS): a question card expires — and stops being answerable —
// 30 min after its hook gave up, so a threshold at or above that would only ever remind
// permissions (12 h retention).
//
// Critical requests (`ButtonRequest.critical`) are excluded by the daemon: they already
// run #403's own repeating cadence, and a second reminder stream would double-ping.
//
// PURE — the daemon supplies the open questions (its pendingButtons + undecided
// abandonedButtons), `now`, and the persisted state; it owns the Telegram send/delete and
// commits a send only after it succeeded (the #403 / awareness-nudge discipline).

import { decodeHtmlEntities, stripHtmlTags } from '../render/html';
import { isQuietHours, QUIET_HOURS_END_HOUR, QUIET_HOURS_START_HOUR } from './hatch-critical-reminder';
import { formatAge, truncateWithEllipsis } from './text-util';

// `TG_CTL_UNANSWERED_REMINDER_AFTER_MS` (ms, non-negative integer); an explicit `0` turns
// reminders off. Unset/blank/invalid → the default (same "blank is not zero" rule as
// #403's hour knobs). Exported for its own tests: the module const reads it at import.
export function parseReminderAfterMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
export const UNANSWERED_REMINDER_AFTER_MS = parseReminderAfterMs(process.env.TG_CTL_UNANSWERED_REMINDER_AFTER_MS, 20 * 60_000);

// One open, answerable agent question as the daemon sees it.
export interface OpenQuestion {
  key: string; // callbackRequestId — stable across pending ↔ abandoned and daemon restarts
  openedAt: number; // the entry's own `at` (ms epoch) — a fallback for `firstSeen`, see header
  label: string; // session name the question came from
  question: string; // card text — HTML only when `html` (a hatch card), else plain text
  html: boolean; // the card was posted with parse_mode HTML: strip its tags for the plain reminder
  messageId: number | null; // the card's Telegram message id, null if posting failed
}

export interface UnansweredReminderState {
  firstSeen: Record<string, number>; // open card key → ms epoch the daemon first saw it open
  remindedKeys: string[]; // cards that already got their one reminder
  messageId: number | null; // the live reminder message — replaced or withdrawn later
  // The chat `messageId` lives in: a reminder posted before TG_CHAT_ID changed must still be
  // deleted THERE. null with a null messageId, or for a file written before it was stored
  // (the daemon then falls back to its current chat).
  chatId: number | null;
}

export function emptyUnansweredReminderState(): UnansweredReminderState {
  return { firstSeen: {}, remindedKeys: [], messageId: null, chatId: null };
}

// An overdue card as the reminder lists it: `askedAt` is its first-seen time.
export interface OverdueQuestion extends OpenQuestion {
  askedAt: number;
}

export interface UnansweredReminderPlan {
  // Post a reminder listing `overdue`, then delete `state.messageId` (the one it replaces).
  send: boolean;
  // Every card the live reminder listed has been answered: delete `state.messageId` and
  // commit `{ ...state, messageId: null }`, so no stale "still waiting" ping lingers.
  // Never true together with `send`.
  withdraw: boolean;
  // Every open card past the threshold, oldest first — a new reminder replaces the old one,
  // so it must carry the earlier still-open cards too.
  overdue: OverdueQuestion[];
  // `firstSeen` gained the newly opened cards; `firstSeen`/`remindedKeys` dropped the
  // closed ones (a closed card never recurs under the same key), keeping the file bounded.
  state: UnansweredReminderState;
  changed: boolean; // `state` differs from the input — persist it even when nothing is sent
}

export function planUnansweredReminder(
  open: readonly OpenQuestion[],
  state: UnansweredReminderState,
  now: number,
  afterMs: number = UNANSWERED_REMINDER_AFTER_MS,
  startHour: number = QUIET_HOURS_START_HOUR,
  endHour: number = QUIET_HOURS_END_HOUR,
): UnansweredReminderPlan {
  const firstSeen: Record<string, number> = {};
  for (const q of open) firstSeen[q.key] = Math.min(state.firstSeen[q.key] ?? q.openedAt, q.openedAt);
  const remindedKeys = state.remindedKeys.filter((k) => k in firstSeen);
  const next = { firstSeen, remindedKeys, messageId: state.messageId, chatId: state.chatId };
  const changed =
    remindedKeys.length !== state.remindedKeys.length ||
    Object.keys(firstSeen).length !== Object.keys(state.firstSeen).length ||
    open.some((q) => state.firstSeen[q.key] !== firstSeen[q.key]);
  const overdue =
    afterMs <= 0
      ? []
      : open
          .map((q) => ({ ...q, askedAt: firstSeen[q.key] }))
          .filter((q) => now - q.askedAt >= afterMs)
          .sort((a, b) => a.askedAt - b.askedAt);
  const send = overdue.some((q) => !remindedKeys.includes(q.key)) && !isQuietHours(now, startHour, endHour);
  // A zero threshold (reminders off) withdraws a reminder an earlier run left live, even
  // while its cards stay open: nothing would ever replace or close it otherwise.
  const withdraw = !send && state.messageId !== null && (afterMs <= 0 || remindedKeys.length === 0);
  return { send, withdraw, overdue, state: next, changed };
}

// State after the reminder listing `overdue` was posted as Telegram message `messageId` in
// `chatId`. Called ONLY after the send succeeded: a failed send stays due and retries next sweep.
export function markUnansweredReminderSent(
  state: UnansweredReminderState,
  overdue: readonly OpenQuestion[],
  messageId: number,
  chatId: number,
): UnansweredReminderState {
  return { ...state, remindedKeys: [...new Set([...state.remindedKeys, ...overdue.map((q) => q.key)])], messageId, chatId };
}

const LIST_MAX = 10;
const LABEL_MAX = 40;
const QUESTION_HEAD_MAX = 80;

// Plain-text reminder body. Each line names the session, the question head, the card's
// `tg#<id>` (the same inbound-ref convention agents and autolink-msgrefs use) and its age.
// Label, head and line count are capped, so the body stays far below Telegram's 4096 chars.
export function unansweredReminderText(overdue: readonly OverdueQuestion[], now: number): string {
  const n = overdue.length;
  const oneLine = (s: string, max: number): string => truncateWithEllipsis(s.replace(/\s+/g, ' ').trim(), max);
  const lines = overdue.slice(0, LIST_MAX).map((q) => {
    const head = oneLine(q.html ? decodeHtmlEntities(stripHtmlTags(q.question)) : q.question, QUESTION_HEAD_MAX);
    const ref = q.messageId !== null ? `tg#${q.messageId}, ` : '';
    return `• ${oneLine(q.label, LABEL_MAX)} — ${head} (${ref}${formatAge(now - q.askedAt)})`;
  });
  if (n > LIST_MAX) lines.push(`…and ${n - LIST_MAX} more`);
  return [`⏳ ${n} agent question${n === 1 ? '' : 's'} still waiting on you:`, ...lines].join('\n');
}

export function serializeUnansweredReminderState(state: UnansweredReminderState): string {
  return JSON.stringify({ version: 1, ...state });
}

// Never throws: absent/malformed content is "nothing seen or reminded yet" — the worst case
// after a corrupted file is one repeated reminder, never a lost one.
export function parseUnansweredReminderState(blob: string | null): UnansweredReminderState {
  if (!blob) return emptyUnansweredReminderState();
  try {
    const r: unknown = JSON.parse(blob);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return emptyUnansweredReminderState();
    const firstSeen: Record<string, number> = {};
    if ('firstSeen' in r && r.firstSeen && typeof r.firstSeen === 'object' && !Array.isArray(r.firstSeen)) {
      for (const [k, v] of Object.entries(r.firstSeen)) if (typeof v === 'number' && Number.isFinite(v)) firstSeen[k] = v;
    }
    const remindedKeys =
      'remindedKeys' in r && Array.isArray(r.remindedKeys) ? r.remindedKeys.filter((k): k is string => typeof k === 'string') : [];
    const messageId = 'messageId' in r && typeof r.messageId === 'number' && Number.isInteger(r.messageId) ? r.messageId : null;
    const chatId = messageId !== null && 'chatId' in r && typeof r.chatId === 'number' && Number.isInteger(r.chatId) ? r.chatId : null;
    return { firstSeen, remindedKeys, messageId, chatId };
  } catch {
    return emptyUnansweredReminderState();
  }
}
