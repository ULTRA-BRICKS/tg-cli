// Round-trip: the exact on-disk JSONL the WRITERS produce (inbound via
// inboundHistoryRecords, outbound via outboundHistoryText) must be readable by
// the READER (runReplies) through a real file. Guards the wire format end to end
// without a live Telegram bot.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { inboundHistoryRecords } from '../features/replies/inbound';
import { buildOutboundHistoryRecords, outboundHistoryText } from '../features/replies/outbound';
import { appendRecordsToBlob, type HistoryRecord } from '../features/replies/history';
import { tempDir } from './helpers/test-temp';
import { runReplies } from '../features/replies/cli';
import type { TgUpdate } from '../features/tg-ctl/types';

const CHAT = 555;

test('inbound writer → file → tg replies reader, scoped to the routed pane', () => {
  const dir = tempDir('tg-replies-');
  const file = join(dir, 'history.jsonl');

  const updates: TgUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: CHAT },
        date: 1700000000,
        from: { id: CHAT, first_name: 'Alex' },
        text: 'ship it',
      },
    },
  ];
  const inbound = inboundHistoryRecords(updates, { chatId: CHAT, allowedSenders: [], pane: '%4' });
  writeFileSync(file, appendRecordsToBlob(null, inbound));

  const out: string[] = [];
  const code = runReplies(['replies'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(code).toBe(0);
  expect(out).toEqual(['[T] #10 [→ ?] ship it']);
});

test('outbound writer → file → tg replies agent reader', () => {
  const dir = tempDir('tg-replies-');
  const file = join(dir, 'history.jsonl');

  const text = outboundHistoryText('done, shipped', { photos: 0, documents: 0 });
  expect(text).not.toBeNull();
  const rec: HistoryRecord = {
    ts: 1700000200,
    message_id: 99,
    direction: 'agent',
    from: 'agent',
    text: text!,
    pane: '%4',
  };
  writeFileSync(file, appendRecordsToBlob(null, [rec]));

  const out: string[] = [];
  runReplies(['replies', 'agent'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(out).toEqual(['[T] #99 [→ ?] done, shipped']);
});

// tg-cli#131: production writes via buildOutboundHistoryRecords(outboundIds,
// ...), one record per Telegram message_id a send produced (a >4096 split or
// a media-group album emits several). This exercises the REAL write path
// (not a hand-built HistoryRecord) end to end: a reply anchored to a
// NON-FIRST id (the album's 2nd item) must still be recall-able via
// `tg replies --json`, matching what buildReplyAnchor promises.
test('outbound writer (multi-id) → file → a NON-FIRST id is recall-able via --json', () => {
  const dir = tempDir('tg-replies-');
  const file = join(dir, 'history.jsonl');

  const text = outboundHistoryText('', { photos: 3, documents: 0 });
  expect(text).not.toBeNull();
  const recs = buildOutboundHistoryRecords([301, 302, 303], text!, 1700000300, '%4', 'grp-token');
  writeFileSync(file, appendRecordsToBlob(null, recs));

  const out: string[] = [];
  const code = runReplies(['replies', 'agent', '--json'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(code).toBe(0);
  const rows = JSON.parse(out[0]) as Array<{ id: number | null; text: string }>;
  const secondAlbumItem = rows.find((r) => r.id === 302); // the reported bug case
  expect(secondAlbumItem?.text).toBe('[3 photos]');
});

// Same multi-part write, but the PLAIN (non-JSON) listing: proves `groupId`
// survives the REAL disk round-trip (writeFileSync → appendRecordsToBlob →
// readFileSync → parseHistory → collapseMultiPartSends), not just the
// hand-called serializeHistoryRecord path tests/replies-cli.test.ts exercises.
// If appendRecordsToBlob's serializer ever dropped groupId, this would fail
// with 3 lines instead of 1 (review: tg-cli#131 follow-up, tg-cli#134).
test('outbound writer (multi-id) → file → plain listing collapses to ONE line', () => {
  const dir = tempDir('tg-replies-');
  const file = join(dir, 'history.jsonl');

  const text = outboundHistoryText('', { photos: 3, documents: 0 });
  expect(text).not.toBeNull();
  const recs = buildOutboundHistoryRecords([301, 302, 303], text!, 1700000300, '%4', 'grp-token');
  writeFileSync(file, appendRecordsToBlob(null, recs));

  const out: string[] = [];
  const code = runReplies(['replies', 'agent'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(code).toBe(0);
  expect(out).toEqual(['[T] #301 [→ ?] [3 photos]']); // ONE line, not three
});

test('both writers append to the SAME file; `all` shows the conversation in order', () => {
  const dir = tempDir('tg-replies-');
  const file = join(dir, 'history.jsonl');

  // Inbound first.
  const inbound = inboundHistoryRecords(
    [
      {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: CHAT },
          date: 1700000000,
          from: { id: CHAT, first_name: 'Alex' },
          text: 'status?',
        },
      },
    ],
    { chatId: CHAT, allowedSenders: [], pane: '%4' },
  );
  writeFileSync(file, appendRecordsToBlob(null, inbound));

  // Then outbound appends to the existing blob.
  const reply: HistoryRecord = {
    ts: 1700000050,
    message_id: 11,
    direction: 'agent',
    from: 'agent',
    text: 'all green',
    pane: '%4',
  };
  writeFileSync(file, appendRecordsToBlob(readFileSync(file, 'utf8'), [reply]));

  const out: string[] = [];
  runReplies(['replies', 'all'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(out).toEqual(['← [T] #10 [→ ?] status?', '→ [T] #11 [→ ?] all green']);
});
