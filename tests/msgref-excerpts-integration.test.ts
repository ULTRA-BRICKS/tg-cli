import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { MSGREF_EXCERPT_MAX } from '../features/autolink-msgrefs/render';
import { serializeHistoryRecord } from '../features/replies/history';
import type { HistoryRecord } from '../features/replies/history';
import { tempDir } from './helpers/test-temp';

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let sent: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 7001 } });
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

test('tg# mention sends a compact history excerpt block, not the full referenced message', async () => {
  sent = [];
  const home = makeHome();
  const longText = `Упоминания в тг сообщениях до сих пор не превращаются в ссылки ${'x'.repeat(
    MSGREF_EXCERPT_MAX + 80,
  )} хвост не должен попасть целиком`;
  writeHistory(home, [historyRecord({ text: longText })]);

  const { exitCode, stderr } = await runSend(['Вида смотри tg#6006'], home);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBe('HTML');
  const text = String(sent[0].text);
  expect(text).toContain('Вида смотри 𝒕𝒈#6006');
  expect(text).toContain('<blockquote expandable>');
  expect(text).toContain('𝒕𝒈#6006 — Vida: Упоминания в тг сообщениях');
  expect(text).toContain('…');
  expect(text).not.toContain('хвост не должен попасть целиком');
});

test('already-styled 𝒕𝒈# mention also sends an excerpt block', async () => {
  sent = [];
  const home = makeHome();
  writeHistory(home, [historyRecord({ text: 'styled mention copied from a previous tg output' })]);

  const { exitCode } = await runSend(['Вида смотри 𝒕𝒈#6006'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain('Вида смотри 𝒕𝒈#6006');
  expect(text).toContain('<blockquote expandable>𝒕𝒈#6006 — Vida: styled mention copied from a previous tg output</blockquote>');
});

test('tg# mention inside code is not linkified and does not add an excerpt block', async () => {
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

test('tg# excerpt lookup skips history rows stamped with a different chat_id', async () => {
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

test('tg# excerpt lookup with a non-numeric current chat only matches legacy history rows', async () => {
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

test('supergroup tg# mention is deep-linked in the body and excerpt label', async () => {
  sent = [];
  const home = makeHome('-1001234567890');
  writeHistory(home, [historyRecord({ text: 'supergroup message with a public deep link' })]);

  const { exitCode } = await runSend(['see tg#6006'], home);

  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  const text = String(sent[0].text);
  expect(text).toContain('<a href="https://t.me/c/1234567890/6006">tg#6006</a>');
  expect(text).toContain(
    '<blockquote expandable><a href="https://t.me/c/1234567890/6006">tg#6006</a> — Vida: supergroup message with a public deep link</blockquote>',
  );
});
