import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HistoryRecord } from '../features/replies/history';
import { apiError, makeTgHome, readHistory, removeTgHomes, runTg, sentRefs, startFakeBotApi, type HomeOptions, type TgHome } from './helpers/fake-bot-api';

// The REAL `tg` against a recording Bot API: where a send lands and how it is threaded.
//   * Rich Messages — a body with rich-only tags goes out WHOLE as sendRichMessage, threaded with
//     reply_parameters, pre-flighted against the documented limits (AGENTS.md "Rich messages").
//   * --reply-to — the outbound message threads UNDER the inbound one ("an answer visibly attaches
//     to the message it answers"), whatever primitive carries it first.
//   * --topic / TG_TOPIC — message_thread_id on EVERY outbound primitive; flag > process env >
//     ~/.config/tg-cli/.env; a reply's anchor topic only when neither is set
//     (docs/specs/tg-forum-topics.md §8, session-registry-and-topics.md §4.3).

const api = startFakeBotApi();
beforeEach(() => api.reset());
afterAll(() => {
  api.stop();
  removeTgHomes();
});

const HEADER = '📁 [𝗮𝗽𝗶-𝗯𝗼𝘁]\n';

function session(opts: HomeOptions = {}): { h: TgHome; cwd: string } {
  const h = makeTgHome(opts);
  const cwd = join(h.home, 'api-bot');
  mkdirSync(cwd);
  return { h, cwd };
}

function file(cwd: string, name: string): string {
  const p = join(cwd, name);
  writeFileSync(p, `bytes of ${name}`);
  return p;
}

// The html a sendRichMessage call carries ('' when there is none).
function richHtml(body: Record<string, unknown>): string {
  const rich = body.rich_message;
  return rich && typeof rich === 'object' && 'html' in rich ? String(rich.html) : '';
}

// --- Rich Messages -----------------------------------------------------------------------------

test('an HTML body with a heading and a list goes out as ONE sendRichMessage carrying the header, never as sendMessage', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--format', 'html', '<h2>Status</h2><ul><li>build green</li><li>deploy queued</li></ul>'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendRichMessage']);
  const body = api.calls[0].body;
  expect(body.text).toBeUndefined();
  expect(body.parse_mode).toBeUndefined();
  const html = richHtml(body);
  expect(html.startsWith(HEADER)).toBe(true);
  expect(html).toContain('<h2>Status</h2><ul><li>build green</li>');
  // The rich message is recalled like any other send.
  expect(readHistory(h).at(-1)?.message_id).toBe(sentRefs(r.stdout)[0]);
});

test('a markdown pipe table typed in a PLAIN body becomes a native <table> rich message, its text escaped', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['Options:\n| option | cost |\n|---|---|\n| a<b | 1 & 2 |\n| c | 3 |'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendRichMessage']);
  const html = richHtml(api.calls[0].body);
  expect(html).toContain('<table>');
  expect(html).toContain('a&lt;b');
  expect(html).toContain('1 &amp; 2');
  expect(html).not.toContain('|---|');
});

test('a 30 000-char rich body goes out WHOLE in one call — never 4096-split, never flood-refused', async () => {
  const { h, cwd } = session();
  const rows = Array.from({ length: 300 }, (_, i) => `<tr><td>row ${i}</td><td>${'value '.repeat(16)}</td></tr>`).join('');
  const body = `<table>${rows}</table>`;
  expect(body.length).toBeGreaterThan(30_000);
  const r = await runTg(api, h, ['--format', 'html', body], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendRichMessage']);
  expect(richHtml(api.calls[0].body)).toContain('<td>row 299</td>');
});

test('a rich body over the 32768-char budget is refused locally — and nothing goes out, not even its photo', async () => {
  const { h, cwd } = session();
  const body = `<h1>Huge</h1><p>${'x'.repeat(33_000)}</p>`;
  const r = await runTg(api, h, ['--format', 'html', '--photo', file(cwd, 'shot.png'), body], { cwd });
  expect(r.exitCode).toBe(1);
  expect(api.calls).toEqual([]);
  expect(r.stderr).toContain('32768');
});

test('a rich reply threads with reply_parameters (sendRichMessage has no reply_to_message_id) and lands in --topic', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--reply-to', '777', '--topic', '9', '--format', 'html', '<h3>Answer</h3><p>done</p>'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendRichMessage']);
  expect(api.calls[0].body.reply_parameters).toEqual({ message_id: 777 });
  expect(api.calls[0].body.reply_to_message_id).toBeUndefined();
  expect(api.calls[0].body.message_thread_id).toBe(9);
});

test('a rich body never rides as a photo caption: photo first caption-less, then the rich message', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--format', 'html', '--photo', file(cwd, 'shot.png'), '<h2>Shot</h2><p>see above</p>'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendRichMessage']);
  expect(api.calls[0].body.caption).toBeUndefined();
});

// --- --reply-to on every primitive ------------------------------------------------------------

test('a reply whose short caption rides a photo threads the PHOTO under the anchor', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--reply-to', '4242', '--photo', file(cwd, 'shot.png'), 'here is the screen'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendPhoto']);
  expect(Number(api.calls[0].body.reply_to_message_id)).toBe(4242);
});

test('a reply with a document and a short caption threads the document', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--reply-to', '4242', '--file', file(cwd, 'report.bin'), 'the report'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendDocument']);
  expect(Number(api.calls[0].body.reply_to_message_id)).toBe(4242);
});

test('a reply carrying an album, overflow text and a document anchors ONLY the first message sent', async () => {
  const { h, cwd } = session();
  const long = 'answer text that is far too long for a caption '.repeat(30).trim();
  const r = await runTg(
    api,
    h,
    ['--reply-to', '4242', '--photo', file(cwd, 'a.png'), '--photo', file(cwd, 'b.png'), '--file', file(cwd, 'c.bin'), long],
    { cwd },
  );
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage', 'sendDocument']);
  // Multipart fields arrive as strings, JSON ones as numbers.
  expect(api.calls.map((c) => (c.body.reply_to_message_id === undefined ? null : Number(c.body.reply_to_message_id)))).toEqual([4242, null, null]);
});

test('--tag answer --reply-to marks the answered message 👌 after the send; a refused reaction never fails the answer', async () => {
  const { h, cwd } = session();
  api.respond = (call) => (call.method === 'setMessageReaction' ? apiError(400, 'Bad Request: REACTION_INVALID') : undefined);
  const r = await runTg(api, h, ['--tag', 'answer', '--reply-to', '4242', 'yes, merged'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendMessage', 'setMessageReaction']);
  expect(api.calls[1].body).toMatchObject({ message_id: 4242, reaction: [{ type: 'emoji', emoji: '👌' }] });
  expect(r.stdout).toMatch(/^OK tg#\d+/);
});

// --- --topic / TG_TOPIC ----------------------------------------------------------------------

test('--topic stamps message_thread_id on the album, every split chunk and the document of one send', async () => {
  const { h, cwd } = session();
  const long = Array.from({ length: 3 }, () => 'topic paragraph '.repeat(200).trim()).join('\n\n');
  const r = await runTg(api, h, ['--topic', '31', '--photo', file(cwd, 'a.png'), '--photo', file(cwd, 'b.png'), '--file', file(cwd, 'c.bin'), long], { cwd });
  expect(r.exitCode).toBe(0);
  const methods = api.calls.map((c) => c.method);
  expect(methods[0]).toBe('sendMediaGroup');
  expect(methods.at(-1)).toBe('sendDocument');
  expect(methods.filter((m) => m === 'sendMessage').length).toBeGreaterThan(1);
  expect(api.calls.map((c) => Number(c.body.message_thread_id))).toEqual(methods.map(() => 31));
  // Every recorded id knows the topic it sits in, so a reply to any of them stays there.
  const rows = readHistory(h).filter((row) => row.direction === 'agent');
  expect(rows.map((row) => row.message_id)).toEqual(sentRefs(r.stdout));
  expect(rows.map((row) => row.threadId)).toEqual(rows.map(() => 31));
});

test('TG_TOPIC set only in ~/.config/tg-cli/.env threads the send', async () => {
  const { h, cwd } = session({ envFile: 'TG_TOPIC=55\n' });
  const r = await runTg(api, h, ['from the env file'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls[0].body.message_thread_id).toBe(55);
});

test('a TG_TOPIC in the process env wins over the one in ~/.config/tg-cli/.env', async () => {
  const { h, cwd } = session({ envFile: 'TG_TOPIC=55\n' });
  const r = await runTg(api, h, ['process env wins'], { cwd, env: { TG_TOPIC: '66' } });
  expect(r.exitCode).toBe(0);
  expect(api.calls[0].body.message_thread_id).toBe(66);
});

test('a TG_TOPIC with surrounding whitespace (written from a file) still threads; "0" is not a topic → General with a warning', async () => {
  const { h, cwd } = session();
  await runTg(api, h, ['padded'], { cwd, env: { TG_TOPIC: ' 77\n' } });
  expect(api.calls[0].body.message_thread_id).toBe(77);

  api.reset();
  const zero = await runTg(api, h, ['zero'], { cwd, env: { TG_TOPIC: '0' } });
  expect(zero.exitCode).toBe(0);
  expect('message_thread_id' in api.calls[0].body).toBe(false);
  expect(zero.stderr).toContain("ignoring invalid TG_TOPIC '0'");
});

test('TG_TOPIC wins over the topic a reply anchor sits in', async () => {
  const anchor: HistoryRecord = { ts: 1, message_id: 19000, chat_id: 5153477378, direction: 'user', from: 'Alex', text: 'q', pane: null, threadId: 192230 };
  const { h, cwd } = session({ configYaml: 'control:\n  topics: true\n  private_topics: true\n', history: [anchor] });
  const r = await runTg(api, h, ['--reply-to', '19000', 'env topic wins'], { cwd, env: { TG_TOPIC: '66' } });
  expect(r.exitCode).toBe(0);
  expect(api.calls[0].body.message_thread_id).toBe(66);
  expect(api.calls[0].body.reply_to_message_id).toBe(19000);
});

// --- header labels -----------------------------------------------------------------------------

test('a --subagent label with HTML-special characters is escaped in an HTML send, so Telegram can parse it', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--subagent', 'R&D<x>', '--format', 'html', '<b>done</b>'], { cwd });
  expect(r.exitCode).toBe(0);
  const text = String(api.calls[0].body.text);
  expect(api.calls[0].body.parse_mode).toBe('HTML');
  expect(text).toContain('&amp;');
  expect(text).toContain('&lt;');
  expect(text).not.toContain('<x>');
  expect(text.endsWith('<b>done</b>')).toBe(true);
});
