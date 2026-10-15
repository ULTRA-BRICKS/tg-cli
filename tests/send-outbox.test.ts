import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Route } from '../features/tg-ctl/routes';
import type { HistoryRecord } from '../features/replies/history';
import {
  flushOutbox,
  formatDelayMark,
  OUTBOX_LIMITS,
  pruneOutbox,
  readOutbox,
  writeOutboxEntry,
  type OutboxHistory,
  type OutboxRoute,
} from '../features/transport/outbox';
import type { QueuedSend } from '../features/transport/telegram';
import { tempDir } from './helpers/test-temp';

// tg-cli#710: a send Telegram did not take within the retry budget is queued on disk
// (the unsent remainder only) and the daemon replays it later, marked as delayed.

const WRITTEN_AT = Date.UTC(2026, 9, 14, 19, 7, 30);
const LATER = Date.UTC(2026, 9, 14, 19, 25, 0);
const MARK = formatDelayMark(WRITTEN_AT, LATER);

const route: OutboxRoute = { paneId: '%3', cwd: '/w/proj', sessionKey: 'omp:abc' };
const history: OutboxHistory = { ts: Math.floor(WRITTEN_AT / 1000), text: 'report', pane: '%3', chatId: 1, targetAgent: 'proj', sessionKey: 'omp:abc', groupToken: 'g-1' };

const msg = (body: Record<string, unknown>, extra: Partial<QueuedSend> = {}): QueuedSend => ({ method: 'sendMessage', body: { chat_id: '1', ...body }, threadAdvisory: false, ...extra });

interface Posted {
  method: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

function harness(replies: Array<Response | Error>) {
  const posted: Posted[] = [];
  const logs: string[] = [];
  const routes: Route[] = [];
  const records: HistoryRecord[] = [];
  return {
    posted,
    logs,
    routes,
    records,
    deps: {
      post: async (method: string, init: RequestInit) => {
        if (init.body instanceof FormData) posted.push({ method, form: init.body });
        else posted.push({ method, json: JSON.parse(String(init.body)) });
        const next = replies.shift();
        if (next === undefined) throw new Error('no reply scripted');
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => LATER,
      log: (line: string) => logs.push(line),
      recordRoutes: (r: Route[]) => routes.push(...r),
      appendHistory: (r: HistoryRecord[]) => records.push(...r),
    },
  };
}

const ok = (id: number | number[]): Response =>
  Response.json({ ok: true, result: Array.isArray(id) ? id.map((message_id) => ({ message_id })) : { message_id: id } });
const fail = (status: number, description = `HTTP ${status}`): Response => Response.json({ ok: false, description }, { status });

function entryFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
}

test('the delay mark names the original UTC time, and the date once the day changed', () => {
  expect(MARK).toBe('⏳ доставлено с задержкой, написано в 19:07 UTC');
  expect(formatDelayMark(WRITTEN_AT, Date.UTC(2026, 9, 15, 1, 0))).toBe('⏳ доставлено с задержкой, написано 2026-10-14 в 19:07 UTC');
});

test('an entry is written atomically, private, and lists FIFO', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'first' })], createdAt: WRITTEN_AT });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'second' })], createdAt: WRITTEN_AT + 1 });
  const names = entryFiles(dir);
  expect(names).toHaveLength(2);
  expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);
  for (const n of names) expect(statSync(join(dir, n)).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const { entries } = readOutbox(dir);
  expect(entries.map((e) => e.entry.ops[0].body.text)).toEqual(['first', 'second']);
});

test('past a day, or the oldest beyond the count/size cap, an entry is archived with a warning, never sent', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'stale' })], createdAt: LATER - OUTBOX_LIMITS.maxAgeMs - 1 });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'a' })], createdAt: LATER - 3 });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'b' })], createdAt: LATER - 2 });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'c' })], createdAt: LATER - 1 });
  const h = harness([]);
  expect(pruneOutbox(dir, h.deps, { ...OUTBOX_LIMITS, maxEntries: 2 })).toBe(2);
  expect(readOutbox(dir).entries.map((e) => e.entry.ops[0].body.text)).toEqual(['b', 'c']);
  expect(readdirSync(join(dir, 'archive')).filter((n) => n.endsWith('.json'))).toHaveLength(2);
  expect(h.logs[0]).toContain('older than 24 h');
  expect(h.logs[1]).toContain('more than 2 queued sends');
  // Size cap: the oldest go until the rest fit.
  expect(pruneOutbox(dir, h.deps, { ...OUTBOX_LIMITS, maxBytes: 1 })).toBe(2);
  expect(h.logs.at(-1)).toContain('MB');
});

test('flush archives an over-limit entry instead of sending it', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'stale' })], createdAt: LATER - OUTBOX_LIMITS.maxAgeMs - 1 });
  const h = harness([]);
  const result = await flushOutbox(dir, h.deps);
  expect(result.delivered).toBe(0);
  expect(h.posted).toEqual([]);
  expect(h.logs.some((l) => l.includes('archived'))).toBe(true);
});

test('an archived entry keeps the history of the parts that went out before the outage', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'part 2' })], createdAt: LATER - OUTBOX_LIMITS.maxAgeMs - 1, history, delivered: [{ id: 41, threadId: null }] });
  const h = harness([]);
  pruneOutbox(dir, h.deps);
  expect(h.records.map((r) => r.message_id)).toEqual([41]);
});

test('an entry with a damaged upload dir goes to failed/ and the next entry still replays', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const { id } = await writeOutboxEntry(dir, { sends: [msg({ text: 'broken' })], createdAt: WRITTEN_AT });
  writeFileSync(join(dir, `${id}.files`), 'not a directory');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'fine' })], createdAt: WRITTEN_AT + 1 });
  const h = harness([ok(7)]);
  const result = await flushOutbox(dir, h.deps);
  expect(result.delivered).toBe(1);
  expect(existsSync(join(dir, 'failed', `${id}.json`))).toBe(true);
});

test('flush delivers with the delay mark into the original thread and reply anchor, records route + history, removes the entry', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, {
    sends: [msg({ text: '<b>report</b>', parse_mode: 'HTML', message_thread_id: 5, reply_to_message_id: 77 })],
    createdAt: WRITTEN_AT,
    route,
    history,
  });
  const h = harness([ok(100)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res).toEqual({ delivered: 1, dropped: 0, stopped: false });
  expect(h.posted).toHaveLength(1);
  const body = h.posted[0].json!;
  expect(body.text).toBe(`${MARK}\n<b>report</b>`);
  expect(body.parse_mode).toBe('HTML');
  expect(body.message_thread_id).toBe(5);
  expect(body.reply_to_message_id).toBe(77);
  expect(body.chat_id).toBe('1');
  expect(entryFiles(dir)).toEqual([]);
  expect(h.routes).toEqual([{ id: 100, ts: Math.floor(LATER / 1000), ...route }]);
  expect(h.records).toHaveLength(1);
  expect(h.records[0]).toMatchObject({ message_id: 100, ts: history.ts, text: 'report', pane: '%3', direction: 'agent', threadId: 5, sessionKey: 'omp:abc' });
  expect(h.logs.join('\n')).toContain('delivered');
});

test('a plain-text mark is plain; an HTML mark is escaped so the markup stays valid', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'a < b' })], createdAt: WRITTEN_AT });
  const h = harness([ok(1)]);
  await flushOutbox(dir, h.deps);
  expect(h.posted[0].json!.text).toBe(`${MARK}\na < b`);
  expect(h.posted[0].json!.parse_mode).toBeUndefined();
});

test('a rich body gets the mark as its first paragraph', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ rich_message: { html: '<h1>T</h1>' } }, { method: 'sendRichMessage' })], createdAt: WRITTEN_AT });
  const h = harness([ok(1)]);
  await flushOutbox(dir, h.deps);
  expect(h.posted[0].method).toBe('sendRichMessage');
  expect(h.posted[0].json!.rich_message).toEqual({ html: `<p>${MARK}</p><h1>T</h1>` });
});

test('a 2xx that is not a Telegram answer keeps the entry queued', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'x' })], createdAt: WRITTEN_AT });
  const h = harness([new Response('<html>proxy</html>', { status: 200 })]);
  expect((await flushOutbox(dir, h.deps)).stopped).toBe(true);
  expect(entryFiles(dir)).toHaveLength(1);
});

test('a separate mark gets a route but no history row: history lists only the report', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'x'.repeat(4096) })], createdAt: WRITTEN_AT, route, history });
  const h = harness([ok(1), ok(2)]);
  await flushOutbox(dir, h.deps);
  expect(h.routes.map((r) => r.id)).toEqual([1, 2]);
  expect(h.records.map((r) => r.message_id)).toEqual([2]);
});

test('a 4xx after some parts went out still writes their history before moving the entry aside', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, {
    sends: [msg({ text: 'p1' }), msg({ text: 'p2' })],
    createdAt: WRITTEN_AT,
    history,
    delivered: [{ id: 10, threadId: null }],
  });
  const h = harness([ok(11), fail(400, 'Bad Request: message to reply not found\n\x1b[31mforged')]);
  expect((await flushOutbox(dir, h.deps)).dropped).toBe(1);
  expect(h.records.map((r) => r.message_id)).toEqual([10, 11]);
  // the server text is scrubbed before it reaches the daemon log
  expect(h.logs.join('\n')).not.toMatch(/[\x00-\x1f\x7f](?!$)/m);
  expect(h.logs.some((l) => l.includes('\x1b'))).toBe(false);
});

test('a queued answer sets its done reaction once the replay delivered it', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'answer' })], createdAt: WRITTEN_AT, reaction: { chatId: '1', messageId: 77, emoji: '👌' } });
  const h = harness([ok(1), ok(1)]);
  await flushOutbox(dir, h.deps);
  expect(h.posted[1]).toEqual({ method: 'setMessageReaction', json: { chat_id: '1', message_id: 77, reaction: [{ type: 'emoji', emoji: '👌' }] } });
});

test('parts delivered before the outage join the replayed ones in ONE history group', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'chunk 2' })], createdAt: WRITTEN_AT, route, history, delivered: [{ id: 11, threadId: null }] });
  const h = harness([ok(12)]);
  await flushOutbox(dir, h.deps);
  expect(h.records.map((r) => [r.message_id, r.groupId])).toEqual([
    [11, 'g-1'],
    [12, 'g-1'],
  ]);
  // the route for 11 was written by the live send; only the replayed id gets one now
  expect(h.routes.map((r) => r.id)).toEqual([12]);
});

test('a separate mark for a multipart request carries its anchor and thread as integers', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const form = new FormData();
  form.append('chat_id', '1');
  form.append('message_thread_id', '5');
  form.append('reply_to_message_id', '77');
  form.append('caption', 'c'.repeat(1024));
  form.append('document', new Blob(['x']), 'a.txt');
  await writeOutboxEntry(dir, { sends: [{ method: 'sendDocument', body: form, threadAdvisory: false }], createdAt: WRITTEN_AT });
  const h = harness([ok(1), ok(2)]);
  await flushOutbox(dir, h.deps);
  expect(h.posted[0].json).toMatchObject({ text: MARK, message_thread_id: 5, reply_to_message_id: 77 });
});

test('a 429 during flush stops it and hands back Telegram\'s retry_after', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'x' })], createdAt: WRITTEN_AT });
  const h = harness([Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, { status: 429 })]);
  expect(await flushOutbox(dir, h.deps)).toEqual({ delivered: 0, dropped: 0, stopped: true, retryAfterMs: 7000 });
  expect(entryFiles(dir)).toHaveLength(1);
});

test('an entry with a malformed request is moved aside instead of wedging the queue', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '000000000000001-1-aaaa.json'), JSON.stringify({ version: 1, id: 'x', createdAt: 1, delivered: [], ops: [null] }));
  await writeOutboxEntry(dir, { sends: [msg({ text: 'fine' })], createdAt: WRITTEN_AT });
  const h = harness([ok(1)]);
  expect(await flushOutbox(dir, h.deps)).toEqual({ delivered: 1, dropped: 1, stopped: false });
});

test('a rich body already at its block limit gets the mark as a separate message', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const html = '<p>x</p>'.repeat(500);
  await writeOutboxEntry(dir, { sends: [msg({ rich_message: { html } }, { method: 'sendRichMessage' })], createdAt: WRITTEN_AT });
  const h = harness([ok(1), ok(2)]);
  await flushOutbox(dir, h.deps);
  expect(h.posted.map((p) => p.method)).toEqual(['sendMessage', 'sendRichMessage']);
  expect(h.posted[0].json!.text).toBe(MARK);
  expect(h.posted[1].json!.rich_message).toEqual({ html });
});

test('an album entry with unparseable media does not wedge the queue', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ media: '{' }, { method: 'sendMediaGroup' })], createdAt: WRITTEN_AT });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'next' })], createdAt: WRITTEN_AT + 1 });
  // the separate mark goes out, Telegram refuses the album, the next entry still goes
  const h = harness([ok(1), fail(400, 'Bad Request: can\'t parse media JSON object'), ok(2)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res).toEqual({ delivered: 1, dropped: 1, stopped: false });
});

test('a text that has no room for the mark gets it as a separate message just before it', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const full = 'x'.repeat(4096);
  await writeOutboxEntry(dir, { sends: [msg({ text: full, message_thread_id: 5 })], createdAt: WRITTEN_AT, route });
  const h = harness([ok(1), ok(2)]);
  await flushOutbox(dir, h.deps);
  expect(h.posted.map((p) => p.json!.text)).toEqual([MARK, full]);
  expect(h.posted[0].json!.message_thread_id).toBe(5);
  expect(h.routes.map((r) => r.id)).toEqual([1, 2]);
});

test('a separate mark that went out is not sent again when its message then fails transiently', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const full = 'x'.repeat(4096);
  await writeOutboxEntry(dir, { sends: [msg({ text: full })], createdAt: WRITTEN_AT, route });
  const h = harness([ok(1), fail(502)]);
  expect((await flushOutbox(dir, h.deps)).stopped).toBe(true);
  const h2 = harness([ok(2)]);
  await flushOutbox(dir, h2.deps);
  expect(h2.posted.map((p) => p.json!.text)).toEqual([full]);
  expect(entryFiles(dir)).toEqual([]);
});

test('an entry whose copied file is gone is moved aside, not retried in front of the queue forever', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const form = new FormData();
  form.append('chat_id', '1');
  form.append('document', new Blob(['x']), 'a.txt');
  const { id } = await writeOutboxEntry(dir, { sends: [{ method: 'sendDocument', body: form, threadAdvisory: false }], createdAt: WRITTEN_AT });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'next' })], createdAt: WRITTEN_AT + 1 });
  rmSync(join(dir, `${id}.files`), { recursive: true });
  const h = harness([ok(5)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res).toEqual({ delivered: 1, dropped: 1, stopped: false });
  expect(h.posted.map((p) => p.method)).toEqual(['sendMessage']);
});

test('a queued document is copied into the outbox: the replay survives the original file vanishing, and the mark rides as caption', async () => {
  const scratch = tempDir('tg-outbox-');
  const dir = join(scratch, 'outbox');
  const doc = join(scratch, 'report.txt');
  writeFileSync(doc, 'payload bytes');
  const form = new FormData();
  form.append('chat_id', '1');
  form.append('message_thread_id', '5');
  form.append('document', Bun.file(doc));
  await writeOutboxEntry(dir, { sends: [{ method: 'sendDocument', body: form, threadAdvisory: false }], createdAt: WRITTEN_AT });
  rmSync(doc);
  const h = harness([ok(3)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res.delivered).toBe(1);
  const sent = h.posted[0].form!;
  expect(sent.get('message_thread_id')).toBe('5');
  expect(sent.get('caption')).toBe(MARK);
  const file = sent.get('document') as File;
  expect(file.name).toBe('report.txt');
  expect(await file.text()).toBe('payload bytes');
  // the entry and its copied files are gone once delivered
  expect(readdirSync(dir)).toEqual([]);
});

test('an album gets the mark on its first item\'s caption', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  const form = new FormData();
  form.append('chat_id', '1');
  form.append('file0', new Blob(['a']), 'a.png');
  form.append('file1', new Blob(['b']), 'b.png');
  form.append('media', JSON.stringify([
    { type: 'photo', media: 'attach://file0', caption: '<b>c</b>', parse_mode: 'HTML' },
    { type: 'photo', media: 'attach://file1' },
  ]));
  await writeOutboxEntry(dir, { sends: [{ method: 'sendMediaGroup', body: form, threadAdvisory: false }], createdAt: WRITTEN_AT });
  const h = harness([ok([10, 11])]);
  await flushOutbox(dir, h.deps);
  const media = JSON.parse(String(h.posted[0].form!.get('media')));
  expect(media[0].caption).toBe(`${MARK}\n<b>c</b>`);
  expect(media[1].caption).toBeUndefined();
  expect(((h.posted[0].form!.get('file1')) as File).name).toBe('b.png');
});

test('a 4xx during flush moves the entry aside, logs it, and the next entry still goes out', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'bad' })], createdAt: WRITTEN_AT });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'good' })], createdAt: WRITTEN_AT + 1 });
  const h = harness([fail(400, 'Bad Request: chat not found'), ok(4)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res).toEqual({ delivered: 1, dropped: 1, stopped: false });
  expect(entryFiles(dir)).toEqual([]);
  const failed = entryFiles(join(dir, 'failed'));
  expect(failed).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, 'failed', failed[0]), 'utf8')).ops[0].body.text).toBe('bad');
  expect(h.logs.join('\n')).toContain('chat not found');
  // a dropped entry is not retried on the next flush
  const again = harness([]);
  expect(await flushOutbox(dir, again.deps)).toEqual({ delivered: 0, dropped: 0, stopped: false });
  expect(again.posted).toEqual([]);
});

test('a transient failure stops the flush and keeps everything queued, FIFO intact', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'one' })], createdAt: WRITTEN_AT });
  await writeOutboxEntry(dir, { sends: [msg({ text: 'two' })], createdAt: WRITTEN_AT + 1 });
  const h = harness([fail(502)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res).toEqual({ delivered: 0, dropped: 0, stopped: true });
  expect(h.posted).toHaveLength(1);
  expect(entryFiles(dir)).toHaveLength(2);
  const h2 = harness([new Error('ECONNRESET')]);
  expect((await flushOutbox(dir, h2.deps)).stopped).toBe(true);
  expect(entryFiles(dir)).toHaveLength(2);
});

test('a partly replayed entry keeps only its unsent parts; history is written once it completes', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'p1' }), msg({ text: 'p2' })], createdAt: WRITTEN_AT, route, history });
  const h = harness([ok(21), fail(503)]);
  expect((await flushOutbox(dir, h.deps)).stopped).toBe(true);
  const { entries } = readOutbox(dir);
  expect(entries).toHaveLength(1);
  expect(entries[0].entry.ops.map((o) => o.body.text)).toEqual(['p2']);
  expect(h.routes.map((r) => r.id)).toEqual([21]);
  expect(h.records).toEqual([]);
  const h2 = harness([ok(22)]);
  await flushOutbox(dir, h2.deps);
  expect(h2.posted[0].json!.text).toBe(`${MARK}\np2`);
  expect(h2.records.map((r) => r.message_id)).toEqual([21, 22]);
  expect(h2.records.every((r) => r.groupId === 'g-1')).toBe(true);
  expect(entryFiles(dir)).toEqual([]);
});

test('an advisory thread that Telegram rejects on replay lands in General without the anchor', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  await writeOutboxEntry(dir, {
    sends: [msg({ text: 'x', message_thread_id: 5, reply_to_message_id: 77 }, { threadAdvisory: true })],
    createdAt: WRITTEN_AT,
    route,
  });
  const h = harness([fail(400, 'Bad Request: message thread not found'), ok(30)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res.delivered).toBe(1);
  expect(h.posted[1].json!.message_thread_id).toBeUndefined();
  expect(h.posted[1].json!.reply_to_message_id).toBeUndefined();
  expect(h.routes).toEqual([{ id: 30, ts: Math.floor(LATER / 1000), ...route }]);
});

test('an unreadable entry is moved aside instead of blocking the queue', async () => {
  const dir = join(tempDir('tg-outbox-'), 'outbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '000000000000001-1-aaaa.json'), '{not json');
  await writeOutboxEntry(dir, { sends: [msg({ text: 'fine' })], createdAt: WRITTEN_AT });
  const h = harness([ok(1)]);
  const res = await flushOutbox(dir, h.deps);
  expect(res).toEqual({ delivered: 1, dropped: 1, stopped: false });
  expect(entryFiles(join(dir, 'failed'))).toHaveLength(1);
});
