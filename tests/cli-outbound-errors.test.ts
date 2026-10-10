import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { apiError, BOT_TOKEN, makeTgHome, readHistory, removeTgHomes, runTg, startFakeBotApi, type TgHome } from './helpers/fake-bot-api';

// The REAL `tg` against a Bot API that refuses or rate-limits: the exit code an agent scripts
// against, what reaches the terminal (and so the agent's transcript), and what history keeps.
//   * A failed send exits non-zero and prints no `OK` refs (tg --help "Send output").
//   * Every message Telegram DID accept gets its history row (one per outbound message_id,
//     AGENTS.md "Message history & recall") — also when a later chunk of the same send failed,
//     so a reply to the delivered part still finds its topic and stays recall-able.
//   * A 429 flood wait is honoured: the refused message is resent after `retry_after`; a 429
//     delivers nothing, so the resend can never duplicate.
//   * The bot token never reaches stderr.

const api = startFakeBotApi();
beforeEach(() => api.reset());
afterAll(() => {
  api.stop();
  removeTgHomes();
});

function session(): { h: TgHome; cwd: string } {
  const h = makeTgHome();
  const cwd = join(h.home, 'api-bot');
  mkdirSync(cwd);
  return { h, cwd };
}

const threeChunks = Array.from({ length: 3 }, (_, i) => `part ${i} `.repeat(500).trim()).join('\n\n');

test('Telegram refusing the HTML (400 can\'t parse entities) fails the send: exit 1, its description shown, no OK, no blind resend', async () => {
  const { h, cwd } = session();
  api.respond = () => apiError(400, "Bad Request: can't parse entities: Unsupported start tag \"foo\" at byte offset 0");
  const r = await runTg(api, h, ['--format', 'html', '<b>x</b>'], { cwd });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).not.toContain('OK');
  expect(r.stderr).toContain("can't parse entities");
  expect(api.calls).toHaveLength(1);
  expect(readHistory(h)).toEqual([]);
});

test('a refused middle chunk stops the send, but the chunk Telegram already delivered keeps its history row', async () => {
  const { h, cwd } = session();
  api.respond = (_call, i) => (i === 1 ? apiError(400, 'Bad Request: message is too long') : undefined);
  const r = await runTg(api, h, [threeChunks], { cwd });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).not.toContain('OK');
  // The third chunk is never attempted after the second failed.
  expect(api.calls).toHaveLength(2);
  const rows = readHistory(h).filter((row) => row.direction === 'agent');
  expect(rows).toHaveLength(1);
  expect(rows[0].message_id).toBeGreaterThan(0);
  expect(rows[0].threadId).toBeNull();
});

test('a 429 flood wait is honoured: the message is resent once after retry_after and the send succeeds', async () => {
  const { h, cwd } = session();
  api.respond = (_call, i) => (i === 0 ? apiError(429, 'Too Many Requests: retry after 1', { retry_after: 1 }) : undefined);
  const started = Date.now();
  const r = await runTg(api, h, ['after the flood wait'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(api.calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
  expect(api.calls[1].body).toEqual(api.calls[0].body);
  expect(r.stdout).toMatch(/^OK tg#\d+\n$/);
  expect(r.stderr).toContain('retry');
});

test('a 429 on the second chunk resends only that chunk — the delivered first chunk is not duplicated', async () => {
  const { h, cwd } = session();
  api.respond = (_call, i) => (i === 1 ? apiError(429, 'Too Many Requests: retry after 1', { retry_after: 1 }) : undefined);
  const r = await runTg(api, h, [threeChunks], { cwd });
  expect(r.exitCode).toBe(0);
  const texts = api.calls.map((c) => String(c.body.text));
  expect(texts).toHaveLength(4);
  expect(texts[2]).toBe(texts[1]);
  expect(new Set(texts).size).toBe(3);
  expect(readHistory(h).filter((row) => row.direction === 'agent')).toHaveLength(3);
});

test('a flood wait longer than tg will block for fails at once with Telegram\'s description', async () => {
  const { h, cwd } = session();
  api.respond = () => apiError(429, 'Too Many Requests: retry after 3600', { retry_after: 3600 });
  const started = Date.now();
  const r = await runTg(api, h, ['too long to wait'], { cwd });
  expect(r.exitCode).toBe(1);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(api.calls).toHaveLength(1);
  expect(r.stderr).toContain('retry after 3600');
});

test('Telegram unreachable: exit 1 with a one-line reason — never a stack trace carrying the bot token', async () => {
  const { h, cwd } = session();
  const dead = { ...api, base: 'http://127.0.0.1:9' };
  const r = await runTg(dead, h, ['nobody home'], { cwd });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).not.toContain('OK');
  expect(r.stderr).not.toContain(BOT_TOKEN);
  expect(r.stderr).toContain('sendMessage');
  expect(r.stderr.trim().split('\n')).toHaveLength(1);
});
