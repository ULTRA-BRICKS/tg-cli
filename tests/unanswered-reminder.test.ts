// tg-cli#464: one quiet-hours-aware reminder per unanswered agent question; each new
// reminder replaces the previous one; a reminder whose cards were all answered is
// withdrawn. Instants are LOCAL time (`new Date(y, m, d, hh, mm)`), matching
// isQuietHours' host-local clock (see hatch-critical-reminder.test.ts).
import { expect, test } from 'bun:test';
import {
  emptyUnansweredReminderState,
  markUnansweredReminderSent,
  parseReminderAfterMs,
  parseUnansweredReminderState,
  planUnansweredReminder,
  serializeUnansweredReminderState,
  unansweredReminderText,
  type OpenQuestion,
  type UnansweredReminderState,
} from '../features/tg-ctl/unanswered-reminder';

const at = (hh: number, mm = 0): number => new Date(2026, 8, 30, hh, mm).getTime();
const MIN = 60_000;
const AFTER = 20 * MIN;
// The default 23-8 quiet window, passed explicitly so an env override can't skew the test.
const plan = (open: OpenQuestion[], state: UnansweredReminderState, now: number) => planUnansweredReminder(open, state, now, AFTER, 23, 8);

const q = (key: string, openedAt: number, messageId: number | null = 900): OpenQuestion => ({
  key,
  openedAt,
  label: 'tg-cli',
  question: `Which DB for ${key}?`,
  html: false,
  messageId,
});

const CHAT = 1;

// Run one sweep the way the daemon does and return the state it would persist.
function sweep(open: OpenQuestion[], state: UnansweredReminderState, now: number, sentId = 1000): UnansweredReminderState {
  const p = plan(open, state, now);
  if (p.send) return markUnansweredReminderSent(p.state, p.overdue, sentId, CHAT);
  if (p.withdraw) return { ...p.state, messageId: null, chatId: null };
  return p.state;
}

test('a question younger than N minutes is not reminded; at N minutes it is', () => {
  const open = [q('a', at(12, 0))];
  const s = sweep(open, emptyUnansweredReminderState(), at(12, 5));
  expect(plan(open, s, at(12, 19)).send).toBe(false);
  const due = plan(open, s, at(12, 20));
  expect(due.send).toBe(true);
  expect(due.overdue.map((x) => x.key)).toEqual(['a']);
});

test('a reminded question gets exactly ONE reminder, however long it stays open', () => {
  const open = [q('a', at(9, 0))];
  const s = sweep(open, emptyUnansweredReminderState(), at(9, 20), 1001);
  expect(s.remindedKeys).toEqual(['a']);
  for (const now of [at(9, 21), at(12, 0), at(22, 59)]) expect(plan(open, s, now).send).toBe(false);
});

test('age counts from when the card was first seen open — a retained/re-attached entry restarting its `at` does not postpone the reminder', () => {
  let s = sweep([q('a', at(10, 0))], emptyUnansweredReminderState(), at(10, 1));
  // The hook socket closed at 10:02 — the daemon's retained entry now reports at=10:02, and
  // a re-attach at 10:15 restarts it again.
  s = sweep([q('a', at(10, 2))], s, at(10, 3));
  const p = plan([q('a', at(10, 15))], s, at(10, 20));
  expect(p.send).toBe(true);
  expect(p.overdue[0].askedAt).toBe(at(10, 0));
});

test('a newly overdue question triggers a reminder that lists every still-open overdue one and records its id for replacement', () => {
  const s1 = sweep([q('a', at(9, 0))], emptyUnansweredReminderState(), at(9, 20), 1001);
  const open = [q('b', at(10, 0), 905), q('a', at(9, 0), 901)];
  const p = plan(open, s1, at(10, 20));
  expect(p.send).toBe(true);
  expect(p.overdue.map((x) => x.key)).toEqual(['a', 'b']); // oldest first
  expect(p.state.messageId).toBe(1001); // the reminder the daemon must delete
  const s2 = markUnansweredReminderSent(p.state, p.overdue, 1002, CHAT);
  expect(s2.remindedKeys).toEqual(['a', 'b']);
  expect(s2.messageId).toBe(1002);
  expect(s2.chatId).toBe(CHAT); // the chat the reminder lives in — a later chat change still retires it there
});

test('the reminder is withdrawn only once EVERY card it listed is answered', () => {
  const both = [q('a', at(9, 0)), q('b', at(9, 5))];
  const s = sweep(both, emptyUnansweredReminderState(), at(9, 30), 1001);
  const partly = plan([q('b', at(9, 5))], s, at(9, 40));
  expect(partly.withdraw).toBe(false);
  const done = plan([], partly.state, at(9, 45));
  expect(done.withdraw).toBe(true);
  expect(done.state).toEqual({ firstSeen: {}, remindedKeys: [], messageId: 1001, chatId: CHAT });
  // Nothing to withdraw when no reminder is live.
  expect(plan([], emptyUnansweredReminderState(), at(9, 45)).withdraw).toBe(false);
});

test('quiet hours: a question overdue at night is held, then reminded once right after quiet hours end', () => {
  const open = [q('a', at(1, 0))];
  let s = sweep(open, emptyUnansweredReminderState(), at(1, 0));
  expect(plan(open, s, at(2, 0)).send).toBe(false);
  expect(plan(open, s, at(7, 59)).send).toBe(false);
  expect(plan(open, s, at(8, 0)).send).toBe(true);
  s = sweep(open, s, at(8, 0));
  expect(plan(open, s, at(8, 5)).send).toBe(false);
});

test('closed cards are pruned from the state; `changed` flags exactly the sweeps that must persist', () => {
  const s = sweep([q('gone', at(8, 0)), q('a', at(9, 0))], emptyUnansweredReminderState(), at(9, 30), 1001);
  const p = plan([q('a', at(9, 0))], s, at(12, 0));
  expect(p.state).toEqual({ firstSeen: { a: at(9, 0) }, remindedKeys: ['a'], messageId: 1001, chatId: CHAT });
  expect(p.changed).toBe(true);
  expect(plan([q('a', at(9, 0))], p.state, at(12, 1)).changed).toBe(false);
  expect(plan([q('a', at(9, 0)), q('new', at(12, 0))], p.state, at(12, 1)).changed).toBe(true);
});

test('a zero threshold disables reminders', () => {
  expect(planUnansweredReminder([q('a', at(9, 0))], emptyUnansweredReminderState(), at(12, 0), 0, 23, 8).send).toBe(false);
});

test('a zero threshold withdraws a reminder persisted by an earlier run, even while its card is still open (#518)', () => {
  const s = sweep([q('a', at(9, 0))], emptyUnansweredReminderState(), at(9, 30), 1001);
  const p = planUnansweredReminder([q('a', at(9, 0))], s, at(12, 0), 0, 23, 8);
  expect(p.send).toBe(false);
  expect(p.withdraw).toBe(true);
  expect(planUnansweredReminder([q('a', at(9, 0))], emptyUnansweredReminderState(), at(12, 0), 0, 23, 8).withdraw).toBe(false);
});

test('TG_CTL_UNANSWERED_REMINDER_AFTER_MS: blank/invalid keep the default, 0 turns reminders off', () => {
  expect(parseReminderAfterMs(undefined, 7)).toBe(7);
  expect(parseReminderAfterMs('', 7)).toBe(7);
  expect(parseReminderAfterMs('  ', 7)).toBe(7);
  expect(parseReminderAfterMs('abc', 7)).toBe(7);
  expect(parseReminderAfterMs('-5', 7)).toBe(7);
  expect(parseReminderAfterMs('1.5', 7)).toBe(7);
  expect(parseReminderAfterMs('0', 7)).toBe(0);
  expect(parseReminderAfterMs('600000', 7)).toBe(600_000);
});

test('reminder text names session, plain-text question head, card ref and age; long lists and labels are capped', () => {
  const hatch = { ...q('h', 0, 777), question: '<b>Allow</b> rig hatch &amp; push?', html: true, askedAt: at(9, 0) };
  const other = { ...q('x', 0, null), askedAt: at(9, 50) };
  expect(unansweredReminderText([hatch, other], at(10, 5))).toBe(
    '⏳ 2 agent questions still waiting on you:\n• tg-cli — Allow rig hatch & push? (tg#777, 1 h 5 min)\n• tg-cli — Which DB for x? (15 min)',
  );
  const old = { ...q('o', 0), askedAt: at(9, 0) - 26 * 60 * MIN };
  expect(unansweredReminderText([old], at(9, 0))).toEndWith('(tg#900, 1 d 2 h)');
  const many = Array.from({ length: 12 }, (_, i) => ({ ...q(`k${i}`, 0), label: 'w'.repeat(500), question: 'x'.repeat(5000), askedAt: at(9, 0) }));
  const text = unansweredReminderText(many, at(10, 0));
  expect(text.split('\n')).toHaveLength(12); // header + 10 + "…and 2 more"
  expect(text).toEndWith('…and 2 more');
  expect(text.length).toBeLessThan(4096); // Telegram's sendMessage limit
});

test('a plain-text question keeps its <angle-bracket> words and entities verbatim; only HTML cards are tag-stripped (#518)', () => {
  const plain = { ...q('p', 0, 5), question: 'merge <branch> into main &amp; push?', askedAt: at(9, 0) };
  expect(unansweredReminderText([plain], at(9, 10))).toContain('— merge <branch> into main &amp; push? (tg#5, 10 min)');
});

test('state round-trips through disk; malformed content is "nothing seen or reminded yet"', () => {
  const s = { firstSeen: { a: 5, b: 6 }, remindedKeys: ['a'], messageId: 1002, chatId: -100123 };
  expect(parseUnansweredReminderState(serializeUnansweredReminderState(s))).toEqual(s);
  // A file written before the chat id was stored: no chat → the daemon falls back to its current chat.
  expect(parseUnansweredReminderState('{"firstSeen":{},"remindedKeys":[],"messageId":7}').chatId).toBeNull();
  for (const bad of [null, '', '{', '[]', '{"firstSeen":[1],"remindedKeys":"a","messageId":"x"}']) {
    expect(parseUnansweredReminderState(bad)).toEqual(emptyUnansweredReminderState());
  }
});
