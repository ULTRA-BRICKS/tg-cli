import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// End-to-end tests for HTML auto-detection: when the message body contains
// Telegram HTML tags (<b>, <i>, <code>, etc.) without an explicit --format html,
// tg should automatically treat the body as HTML so the tags render as formatting
// rather than appearing as literal text.
//
// Guarantees:
//   1. Body with <b>/<i>/<code> etc. → parse_mode=HTML on the wire, tags render.
//   2. Plain text without tags → no parse_mode (plain message, unaffected).
//   3. Comparison operators `x < y > z` → no parse_mode (not treated as HTML).
//   4. Explicit --format html still works and is not double-processed.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let sent: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(): string {
  const home = tempDir('tg-html-detect-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function runSend(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      // Suppress prefix side-effects so parse_mode is driven purely by the
      // body content, not by prefix.forceHtml (custom emoji, Cyrillic window,
      // or tag pills all force HTML on the prefix side). Clear every env var
      // that feeds model/emoji detection; setting TG_AI_EMOJI to a plain
      // unicode char that has no custom-emoji id keeps the prefix plain.
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

test('body with <b> tag auto-upgrades to parse_mode=HTML without --format html', async () => {
  sent = [];
  const { exitCode } = await runSend(['<b>Title</b>\nBody text']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBe('HTML');
  // The tag should appear in the text as-is (not escaped).
  expect(String(sent[0].text)).toContain('<b>Title</b>');
});

test('body with <code> tag auto-upgrades to parse_mode=HTML', async () => {
  sent = [];
  const { exitCode } = await runSend(['<code>handleAgentRoute</code> had a bug']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBe('HTML');
});

test('plain text without HTML tags is sent without parse_mode', async () => {
  sent = [];
  const { exitCode } = await runSend(['Just plain text here']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBeUndefined();
});

test('comparison operators `x < y > z` do NOT trigger HTML mode', async () => {
  sent = [];
  const { exitCode } = await runSend(['x < y > z, 2 < 3']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBeUndefined();
});

test('explicit --format html still works and is not double-processed', async () => {
  sent = [];
  const { exitCode } = await runSend(['--format', 'html', '<b>Title</b>\n<i>body</i>']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].parse_mode).toBe('HTML');
  expect(String(sent[0].text)).toContain('<b>Title</b>');
});
