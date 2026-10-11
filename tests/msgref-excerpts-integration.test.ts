// Real `tg` subprocess against a fake Bot API with a seeded `tg-ctl.<bot>.history.jsonl`:
// inline quoted previews of referenced messages (tg-cli#116) and the bottom excerpt block
// that refs without a preview still get (docs/specs/autolink-msgrefs.md).
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { MSGREF_EXCERPT_MAX, MSGREF_PREVIEW_MAX, oneLineHead } from '../features/autolink-msgrefs/preview';
import { serializeHistoryRecord } from '../features/replies/history';
import type { HistoryRecord } from '../features/replies/history';
import { tempDir } from './helpers/test-temp';

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const MESSAGE_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

let sent: Array<Record<string, unknown> & { method: string }> = [];
let nextMessageId = 7001;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const method = url.pathname.split('/').pop() ?? '';
    if (method === 'sendMessage' || method === 'sendRichMessage') {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push({ ...body, method });
      // Telegram rejects a sendMessage text over 4096; the raw HTML length is an upper bound
      // of the visible length Telegram counts, so this is at least as strict as the real API.
      if (method === 'sendMessage' && String(body.text).length > MESSAGE_LIMIT) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
    }
    if (method === 'sendPhoto') {
      const form = await req.formData();
      // multipart/form-data carries line breaks as CRLF; Telegram counts the text, not the wire.
      const raw = form.get('caption');
      const caption = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n') : undefined;
      sent.push({ method, caption });
      if (caption !== undefined && caption.length > CAPTION_LIMIT) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message caption is too long' }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];

afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(chatId: string = '1'): string {
  const home = tempDir('tg-msgref-excerpt-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), `TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=${chatId}\n`);
  return home;
}

function writeHistory(home: string, records: HistoryRecord[]): void {
  const cfg = join(home, '.config', 'tg-cli');
  writeFileSync(join(cfg, 'tg-ctl.123.history.jsonl'), `${records.map(serializeHistoryRecord).join('\n')}\n`);
}

async function runSend(args: string[], home: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      OPENCODE: '',
      CODEX: '',
      TMUX: '',
      TG_AI_MODEL: 'unknown-model',
      TG_AI_EMOJI: '🤖',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

function historyRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    ts: 1700000000,
    message_id: 6006,
    direction: 'user',
    from: 'Vida',
    text: 'Mentions in Telegram messages still are not converted to links',
    pane: '%1',
    ...overrides,
  };
}

const NO_PREVIEW = ['--no-feature', 'autolink-msgref-preview'];

test('DM tg# mention is replaced by an inline «quoted preview» + the styled marker, no bottom block', async () => {
  sent = [];
  const home = makeHome();
  const longText = `Упоминания в тг сообщениях до сих пор\nне превращаются в ссылки ${'x'.repeat(80)} хвост не должен попасть`;
  writeHistory(home, [historyRecord({ text: longText })]);

  const { exitCode, stderr } = await runSend(['Вида смотри tg#6006'], home);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBe('HTML');
  const text = String(sent[0].text);
  expect(text).toContain(`Вида смотри «${oneLineHead(longText, MSGREF_PREVIEW_MAX)}» (𝒕𝒈#6006)`);
  expect(text).not.toContain('<blockquote');
  expect(text).not.toContain('хвост не должен попасть');
  expect(text).not.toContain('<a ');
});

test('--no-feature autolink-msgref-preview keeps the compact bottom excerpt block', async () => {
  sent = [];
  const home = makeHome();
  const longText = `Упоминания в тг сообщениях до сих пор не превращаются в ссылки ${'x'.repeat(
    MSGREF_EXCERPT_MAX + 80,
  )} хвост не должен попасть целиком`;
  writeHistory(home, [historyRecord({ text: longText })]);

  const { exitCode, stderr } = await runSend([...NO_PREVIEW, 'Вида смотри tg#6006'], home);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBe('HTML');
  const text = String(sent[0].text);
  expect(text).toContain('Вида смотри 𝒕𝒈#6006');
  expect(text).not.toContain('«');
  expect(text).toContain('<blockquote expandable>');
  expect(text).toContain('𝒕𝒈#6006 — Vida: Упоминания в тг сообщениях');
  expect(text).toContain('…');
  expect(text).not.toContain('хвост не должен попасть целиком');
});

test('already-styled 𝒕𝒈# mention also gets the inline preview, marker kept styled', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [historyRecord({ text: 'styled mention copied from a previous tg output' })]);

  const { exitCode } = await runSend(['Вида смотри 𝒕𝒈#6006'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain('Вида смотри «styled mention copied from a previous tg output» (𝒕𝒈#6006)');
  expect(text).not.toContain('<blockquote');
});

test('an id missing from history renders byte-identical with the preview flag on and off', async () => {
  const home = makeHome();
  writeHistory(home, [historyRecord({ message_id: 1, text: 'some other message' })]);

  sent = [];
  expect((await runSend(['see tg#6006 and tg#6007'], home)).exitCode).toBe(0);
  const withFlag = String(sent[0].text);
  sent = [];
  expect((await runSend([...NO_PREVIEW, 'see tg#6006 and tg#6007'], home)).exitCode).toBe(0);
  const withoutFlag = String(sent[0].text);

  expect(withFlag).toBe(withoutFlag);
  expect(withFlag).toContain('see 𝒕𝒈#6006 and 𝒕𝒈#6007');
  expect(withFlag).not.toContain('«');
});

test('several refs: each found id is quoted once, a missing one keeps the marker', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [
    historyRecord({ message_id: 10, text: 'first <ask> & more' }),
    historyRecord({ message_id: 20, text: 'second ask' }),
  ]);

  const { exitCode } = await runSend(['tg#20 then tg#10, tg#30 and tg#20 again'], home);

  expect(exitCode).toBe(0);
  const text = String(sent[0].text);
  expect(text).toContain(
    '«second ask» (𝒕𝒈#20) then «first &lt;ask&gt; &amp; more» (𝒕𝒈#10), 𝒕𝒈#30 and 𝒕𝒈#20 again',
  );
  expect(text).not.toContain('<blockquote');
});

test('tg# mention inside code gets neither a preview nor an excerpt block', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [historyRecord({ text: 'this should stay out of the reference block' })]);

  const { exitCode } = await runSend(['<code>tg#6006</code>'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain('<code>tg#6006</code>');
  expect(text).not.toContain('<blockquote expandable>');
  expect(text).not.toContain('this should stay out of the reference block');
});

test('tg# lookup skips history rows stamped with a different chat_id', async () => {
  sent = [];
  const home = makeHome('1');
  writeHistory(home, [historyRecord({ chat_id: 2, text: 'wrong chat excerpt' })]);

  const { exitCode } = await runSend(['see tg#6006'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain('see 𝒕𝒈#6006');
  expect(text).not.toContain('<blockquote expandable>');
  expect(text).not.toContain('wrong chat excerpt');
});

test('tg# lookup with a non-numeric current chat only matches legacy history rows', async () => {
  sent = [];
  const home = makeHome('@channelname');
  writeHistory(home, [historyRecord({ chat_id: 1, text: 'stamped row cannot be safely scoped' })]);

  const { exitCode } = await runSend(['see tg#6006'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain('see 𝒕𝒈#6006');
  expect(text).not.toContain('<blockquote expandable>');
  expect(text).not.toContain('stamped row cannot be safely scoped');
});

test('supergroup tg# mention: the quote is the t.me/c link, the marker stays beside it', async () => {
  sent = [];
  const home = makeHome('-1001234567890');
  writeHistory(home, [historyRecord({ text: 'supergroup message with a public deep link' })]);

  const { exitCode } = await runSend(['see tg#6006'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain(
    'see <a href="https://t.me/c/1234567890/6006">«supergroup message with a public deep link»</a> (tg#6006)',
  );
  expect(text).not.toContain('<blockquote');
});

test('supergroup with the preview flag off keeps the deep-linked marker and excerpt label', async () => {
  sent = [];
  const home = makeHome('-1001234567890');
  writeHistory(home, [historyRecord({ text: 'supergroup message with a public deep link' })]);

  const { exitCode } = await runSend([...NO_PREVIEW, 'see tg#6006'], home);

  expect(exitCode).toBe(0);
  const text = String(sent[0].text);
  expect(text).toContain('<a href="https://t.me/c/1234567890/6006">tg#6006</a>');
  expect(text).toContain(
    '<blockquote expandable><a href="https://t.me/c/1234567890/6006">tg#6006</a> — Vida: supergroup message with a public deep link</blockquote>',
  );
});

test('rich tier: a rich HTML body carries the inline preview through sendRichMessage', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [historyRecord({ text: 'please add a table' })]);

  const { exitCode, stderr } = await runSend(['--format', 'html', '<h1>Report</h1>\nanswered tg#6006'], home);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].method).toBe('sendRichMessage');
  const rich = sent[0].rich_message;
  const html = rich && typeof rich === 'object' && 'html' in rich ? String(rich.html) : '';
  expect(html).toContain('answered «please add a table» (𝒕𝒈#6006)');
});

test('a near-4096 body that the preview pushes over the limit is split, every part sends', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [historyRecord({ text: 'Ю'.repeat(200) })]);
  // ~4060 chars before substitution: one message without the preview, over the limit
  // with it (the preview adds ~60). Paragraphs, so the long-plain-message structure
  // warning stays quiet.
  const paragraph = `${'word '.repeat(19)}word`;
  const body = `see tg#6006\n\n${Array.from({ length: 40 }, () => paragraph).join('\n\n')}\n\nend`;
  expect(body.length).toBeLessThan(MESSAGE_LIMIT - 10);

  const { exitCode, stderr } = await runSend([body], home);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(sent.length).toBe(2);
  for (const m of sent) expect(String(m.text).length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  expect(String(sent[0].text)).toContain(`see «${'Ю'.repeat(MSGREF_PREVIEW_MAX)}…» (𝒕𝒈#6006)`);
  expect(String(sent[1].text)).toContain('end');
});

test('a caption that the preview pushes past 1024 stops riding the photo and is sent as a message', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [historyRecord({ text: 'Ж'.repeat(200) })]);
  const photo = join(home, 'chart.png');
  writeFileSync(photo, 'PNG');
  // ~985 chars before substitution: a caption without the preview, too long for one with it
  // (the preview adds ~60).
  const paragraph = `${'word '.repeat(19)}word`;
  const body = `see tg#6006\n\n${Array.from({ length: 9 }, () => paragraph).join('\n\n')}\n\n${'tail '.repeat(12)}end`;
  expect(body.length).toBeGreaterThan(CAPTION_LIMIT - 50);
  expect(body.length).toBeLessThan(CAPTION_LIMIT - 30);

  const { exitCode, stderr } = await runSend(['--photo', photo, body], home);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  const photos = sent.filter((m) => m.method === 'sendPhoto');
  const messages = sent.filter((m) => m.method === 'sendMessage');
  expect(photos).toHaveLength(1);
  expect(photos[0].caption).toBeUndefined();
  expect(messages).toHaveLength(1);
  expect(String(messages[0].text)).toContain(`see «${'Ж'.repeat(MSGREF_PREVIEW_MAX)}…» (𝒕𝒈#6006)`);
});
