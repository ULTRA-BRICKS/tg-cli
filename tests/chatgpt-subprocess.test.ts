// Spawns the real `tg` with a fake `pm` on PATH and a POISONED Bot API: any attempt to send a
// Telegram message would hit a listening server that records it, so `tg chatgpt ...` provably
// never reaches the generic send path.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

const REPO = join(import.meta.dir, '..');
let hits: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let binDir = '';
let configDir = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      hits.push(new URL(req.url).pathname);
      return new Response('{"ok":false,"description":"poisoned"}', { status: 500 });
    },
  });
  binDir = tempDir('chatgpt-tg-bin-');
  configDir = tempDir('chatgpt-tg-cfg-');
  mkdirSync(binDir, { recursive: true });
  const pm = join(binDir, 'pm');
  writeFileSync(
    pm,
    `#!/bin/sh
# fake pm: ONE envelope per call, args echoed so the test can see the fixed argv
case "$3" in
  accounts.list) echo '{"ok":true,"result":{"accounts":[{"workspace":"home","configured":true,"service":{"active":"active"},"monitor":{"ok":true,"sessions":1,"running":1}}]}}' ;;
  sessions.list) echo '{"ok":true,"result":{"workspace":"all","accounts":[],"sessions":[],"events":[]}}' ;;
  *) echo '{"ok":false,"error":{"code":"fake","message":"fake pm has no such method"}}'; exit 1 ;;
esac
`,
  );
  chmodSync(pm, 0o755);
});
afterAll(() => server.stop(true));

function tg(args: string[]) {
  hits = [];
  const res = Bun.spawnSync(['bun', join(REPO, 'tg'), ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TG_BOT_TOKEN: '1:POISONED',
      TG_CHAT_ID: '1',
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TG_API_URL: `http://127.0.0.1:${server.port}`,
      TG_CTL_CONFIG_DIR: configDir,
      TG_SEND_RETRY_BUDGET_MS: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  });
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
}

describe('tg chatgpt (real tg process)', () => {
  test('accounts goes to pm and prints, with no Telegram request', () => {
    const r = tg(['chatgpt', 'accounts']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('home');
    expect(hits).toEqual([]);
  });
  test('--json prints one envelope', () => {
    const r = tg(['chatgpt', '--json', 'list']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).ok).toBe(true);
    expect(hits).toEqual([]);
  });
  test('help chatgpt prints the topic', () => {
    const r = tg(['help', 'chatgpt']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('tg chatgpt');
    expect(hits).toEqual([]);
  });
  test('tg help lists the chatgpt topic in the usage and unknown-topic error', () => {
    expect(tg(['help']).out).toContain('chatgpt');
    expect(tg(['help', 'nope']).err).toContain('chatgpt');
  });
  test.each([
    [['chatgpt', 'bogus']],
    [['chatgpt', 'list', '--wat']],
    [['chatgpt', 'sessions.list']],
    [['chatgpt', 'send', 'hello there']],
    [['chatgpt', 'pause', 'all', 'c']],
    [['chatgpt', '--', 'hello']],
  ])('%j is a usage error (exit 2) that never sends a Telegram message', (args) => {
    const r = tg(args);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
  test('a pm failure exits with the CLI code, still no Telegram request', () => {
    const r = tg(['chatgpt', 'requests']);
    expect(r.code).toBe(1);
    expect(hits).toEqual([]);
  });
  test('pm missing from PATH exits 69, no Telegram request', () => {
    hits = [];
    // bun is addressed by absolute path so the stripped PATH only hides `pm`
    const res = Bun.spawnSync([process.execPath, join(REPO, 'tg'), 'chatgpt', 'accounts'], {
      env: { ...process.env, PATH: '/nonexistent-bin', TG_BOT_TOKEN: '1:POISONED', TG_CHAT_ID: '1', TG_API_BASE: `http://127.0.0.1:${server.port}`, TG_CTL_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    });
    expect(res.exitCode).toBe(69);
    expect(hits).toEqual([]);
  });
});
