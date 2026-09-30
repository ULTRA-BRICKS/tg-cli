import { expect, test } from 'bun:test';
import { hatchGrantNoticeText } from '../features/tg-ctl/grants';
import { inboxDirFor, inboxRoot, isDeliveredBatchFile, parseInboxLines, serializeInboxEntry, splitStrandedLines, strandedReportText, type InboxEntry } from '../features/tg-ctl/inbox';

test('inbox paths live under <configDir>/inbox/<key>', () => {
  expect(inboxRoot('/cfg')).toBe('/cfg/inbox');
  expect(inboxDirFor('/cfg', 'landing')).toBe('/cfg/inbox/landing');
});

test('serializeInboxEntry is one newline-terminated JSON line (newlines escaped)', () => {
  const line = serializeInboxEntry({ id: 42, ts: '2026-09-06T00:00:00Z', from: 'Alex', text: 'a\nb', wrapped: '[TG from Alex tg#42] a\nb' });
  expect(line.endsWith('\n')).toBe(true);
  expect(line.slice(0, -1)).not.toContain('\n');
  expect(JSON.parse(line)).toMatchObject({ id: 42, text: 'a\nb' });
});

test('parseInboxLines is lenient: malformed lines are counted, good ones kept', () => {
  const text = '{"id":1,"ts":"t","from":"a","text":"x","wrapped":"w1"}\nnot json\n{"nope":true}\n\n{"id":null,"ts":"t","from":"a","text":"y","wrapped":"w2"}\n';
  const r = parseInboxLines(text);
  expect(r.entries.map((e) => e.wrapped)).toEqual(['w1', 'w2']);
  expect(r.malformed).toBe(2);
});

// --- the one-time stranded report (tg-cli#456) ---

function entry(ts: string, text: string): InboxEntry {
  return { id: null, ts, from: 'tg', text, wrapped: text };
}

test('splitStrandedLines: only the daemon-queued notice of a still-live omp grant stays pending; everything else is stranded', () => {
  const noticeText = (requestId: string, approvalId: string) =>
    hatchGrantNoticeText({ requestId, question: 'Allow rig hatch escalation: h?', hookId: 'h', approvalId, approvedAt: 0, expiresAt: 1 });
  const notice = (requestId: string, approvalId: string) => JSON.stringify(entry('2026-09-30T10:00:00.000Z', noticeText(requestId, approvalId)));
  const omp = notice('hatch-omp', 'hgr-aaaaaaaaaaaa');
  const cc = notice('hatch-cc', 'hgr-bbbbbbbbbbbb');
  // The live approval id under another request id: not that grant's notice.
  const otherRequest = notice('hatch-other', 'hgr-aaaaaaaaaaaa');
  const agentText = JSON.stringify({ id: 10, ts: 't', from: 'Alex', text: 'deploy now', wrapped: '[TG from Alex tg#10] deploy now' });
  // User-authored copies of the live notice: an `/agent` message (has a Telegram id) and
  // an `inbox queue` line (from tg-ctl, wrapped) — never omp's fallback.
  const forgedAgent = JSON.stringify({ id: 11, ts: 't', from: 'tg', text: noticeText('hatch-omp', 'hgr-aaaaaaaaaaaa'), wrapped: noticeText('hatch-omp', 'hgr-aaaaaaaaaaaa') });
  const forgedQueue = JSON.stringify({ id: null, ts: 't', from: 'tg-ctl', text: noticeText('hatch-omp', 'hgr-aaaaaaaaaaaa'), wrapped: `[tg-ctl] ${noticeText('hatch-omp', 'hgr-aaaaaaaaaaaa')}` });
  const raw = [omp, cc, otherRequest, agentText, forgedAgent, forgedQueue, 'not json', ''].join('\n');
  expect(splitStrandedLines(raw, new Map([['hgr-aaaaaaaaaaaa', 'hatch-omp']]))).toEqual({
    keep: [omp],
    stranded: [cc, otherRequest, agentText, forgedAgent, forgedQueue, 'not json'],
  });
  // With no live omp approval every line is stranded.
  expect(splitStrandedLines(raw, new Map()).keep).toEqual([]);
});

test('strandedReportText: nothing stranded → no message at all', () => {
  expect(strandedReportText([], '/cfg/inbox')).toBeNull();
  expect(strandedReportText([{ key: 'cwd-a', entries: [] }], '/cfg/inbox')).toBeNull();
});

test('strandedReportText: every stranded message on its own line, oldest first, with its inbox key and a plain-text preview', () => {
  const text = strandedReportText(
    [
      { key: 'subagent', entries: [entry('2026-09-27T10:08:19.249Z', 'third')] },
      {
        key: 'cwd-55302326138d2374',
        entries: [
          entry('2026-09-19T10:44:29.092Z', 'second'),
          entry('2026-09-18T12:15:28.116Z', 'Your earlier hatch request hatch-x (<b>🔓 Hatch approval request</b>) was\nAPPROVED'),
        ],
      },
    ],
    '/cfg/inbox',
  )!;
  const lines = text.split('\n');
  expect(lines[0]).toContain('3 message(s)');
  expect(lines[0]).toContain('oldest 2026-09-18 12:15 UTC');
  expect(lines[0]).toContain('tmux-only');
  expect(lines[0]).toContain('/cfg/inbox');
  // The CTO reads this in a plain-text message: tags stripped, newlines collapsed.
  expect(lines.slice(1)).toEqual([
    '• 2026-09-18 12:15 cwd-55302326138d2374 — Your earlier hatch request hatch-x (🔓 Hatch approval request) was APPROVED',
    '• 2026-09-19 10:44 cwd-55302326138d2374 — second',
    '• 2026-09-27 10:08 subagent — third',
  ]);
});

test('strandedReportText: a long backlog stays one Telegram message and says how many it left out', () => {
  const many = Array.from({ length: 200 }, (_, i) => entry(`2026-09-18T12:${String(i % 60).padStart(2, '0')}:00.000Z`, 'x'.repeat(700)));
  const text = strandedReportText([{ key: 'cwd-a', entries: many }], '/cfg/inbox')!;
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text.split('\n')[0]).toContain('200 message(s)');
  const shown = text.split('\n').filter((l) => l.startsWith('• ')).length;
  expect(shown).toBeGreaterThan(0);
  expect(text.endsWith(`… and ${200 - shown} more in the archive`)).toBe(true);
});

test('isDeliveredBatchFile: only complete delivered-*.jsonl batches, never the temp file', () => {
  expect(isDeliveredBatchFile('delivered-77-1757000000000000000-ab12cd34.jsonl')).toBe(true);
  expect(isDeliveredBatchFile('delivered-77-1757000000000000000-ab12cd34.jsonl.tmp')).toBe(false);
  expect(isDeliveredBatchFile('pending.jsonl')).toBe(false);
  expect(isDeliveredBatchFile('acked.jsonl')).toBe(false);
});
