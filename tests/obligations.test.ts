// Follow-up obligations (features/cli/obligations.ts, tg-cli#706): the append-only store of
// what a sent message still owes as replies, and the `tg obligations` argument parser.
import { expect, test } from 'bun:test';
import {
  dismissLine,
  formatObligations,
  fulfilmentLine,
  openObligations,
  owedLines,
  parseObligationsArgs,
} from '../features/cli/obligations';

const ctx = { chatId: '1', originalId: 500, at: 1_000, sender: '[tg-cli]' };
const owed = owedLines(
  [
    { kind: 'decision', quote: 'Мержить #694?' },
    { kind: 'problem', quote: 'Блокер: нет доступа к проду.' },
  ],
  ctx,
);

test('owed lines open one obligation per follow-up, keyed <original id>.<n>', () => {
  const open = openObligations(owed);
  expect(open.map((o) => [o.id, o.kind, o.originalId, o.sender])).toEqual([
    ['500.1', 'decision', 500, '[tg-cli]'],
    ['500.2', 'problem', 500, '[tg-cli]'],
  ]);
});

test('a reply under the original settles the oldest open item of its kind, and only that', () => {
  const open = openObligations(owed);
  const settled = fulfilmentLine(open, { chatId: '1', replyTo: 500, kind: 'decision', by: 501, at: 1_100 });
  expect(settled).not.toBeNull();
  expect(openObligations(owed + settled).map((o) => o.id)).toEqual(['500.2']);
  // Wrong anchor, wrong chat, or nothing of that kind owed there: no settlement.
  expect(fulfilmentLine(open, { chatId: '1', replyTo: 499, kind: 'decision', by: 501, at: 1 })).toBeNull();
  expect(fulfilmentLine(open, { chatId: '2', replyTo: 500, kind: 'decision', by: 501, at: 1 })).toBeNull();
  expect(fulfilmentLine(openObligations(owed + settled), { chatId: '1', replyTo: 500, kind: 'decision', by: 502, at: 1 })).toBeNull();
});

test('dismiss closes one item by id with a reason; an unknown id is refused', () => {
  const open = openObligations(owed);
  const dismissed = dismissLine(open, '500.2', 'rhetorical question', 1_200);
  expect(dismissed).toContain('"reason":"rhetorical question"');
  expect(openObligations(owed + dismissed).map((o) => o.id)).toEqual(['500.1']);
  expect(dismissLine(open, '999.1', 'x', 1)).toBeNull();
});

test('a torn or foreign line is skipped, never hiding the rest of the store', () => {
  expect(openObligations(`{"event":"owed","id":"1.1"\nnot json\n${owed}`).map((o) => o.id)).toEqual(['500.1', '500.2']);
});

test('the list names each item, its kind, its sender and the reply command', () => {
  expect(formatObligations([])).toBe('No follow-ups owed.');
  const text = formatObligations(openObligations(owed));
  expect(text).toContain('2 follow-up(s) owed');
  expect(text).toContain('500.1  [decision] «Мержить #694?»  — [tg-cli]');
  expect(text).toContain('tg --reply-to 500 --tag problem --format html');
});

test('tg obligations arguments: list / --check / --json / dismiss / errors', () => {
  expect(parseObligationsArgs([])).toEqual({ action: 'list', json: false, check: false });
  expect(parseObligationsArgs(['--check', '--json'])).toEqual({ action: 'list', json: true, check: true });
  expect(parseObligationsArgs(['dismiss', '500.1', '--reason', 'not a question'])).toEqual({
    action: 'dismiss',
    id: '500.1',
    reason: 'not a question',
  });
  expect(parseObligationsArgs(['dismiss', '500.1']).action).toBe('error');
  expect(parseObligationsArgs(['--bogus']).action).toBe('error');
  expect(parseObligationsArgs(['--help']).action).toBe('help');
});
