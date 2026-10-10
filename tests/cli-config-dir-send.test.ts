import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// The outbound `tg` sender's credential resolution honors TG_CTL_CONFIG_DIR (review
// finding, tg-cli#263 sweep): before this fix, the send path and `tg hooks ...`
// hardcoded `~/.config/tg-cli/.env` while only the `replies` subcommand honored the
// override — so a non-default TG_CTL_CONFIG_DIR (the exact "two bots on one machine"
// setup ctlPaths' per-bot state files exist for, and what tg-ctl's usage-schedule
// launchd job pins into its own plist) silently either failed every send ("TG_BOT_TOKEN
// and TG_CHAT_ID must be set") or, worse, sent with whatever OTHER bot's creds happened
// to live in the default dir. This test runs the REAL `tg` binary against a mock
// Bot-API server with credentials placed ONLY under a non-default config dir.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let received: Array<Record<string, unknown>>;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      received.push((await req.json()) as Record<string, unknown>);
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

// An empty HOME (no ~/.config/tg-cli at all) plus a SEPARATE dir carrying creds —
// proves resolution goes through TG_CTL_CONFIG_DIR, not merely "falls back to HOME".
function makeEmptyHomeAndConfigDir(): { home: string; configDir: string } {
  const home = tempDir('tg-cfgdir-home-');
  const configDir = tempDir('tg-cfgdir-work-');
  dirs.push(home, configDir);
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=999:work\nTG_CHAT_ID=42\n');
  return { home, configDir };
}

async function run(args: string[], env: Record<string, string>): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

test('a non-default TG_CTL_CONFIG_DIR is honored for the real send — no ~/.config/tg-cli needed', async () => {
  received = [];
  const { home, configDir } = makeEmptyHomeAndConfigDir();
  const { exitCode, stderr } = await run(['hello from the work config dir'], {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TG_CTL_CONFIG_DIR: configDir,
    TG_API_BASE: `http://127.0.0.1:${server.port}`,
  });
  expect(stderr).not.toContain('TG_BOT_TOKEN and TG_CHAT_ID must be set');
  expect(exitCode).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0].text as string).toContain('hello from the work config dir');
});

test('with NO TG_CTL_CONFIG_DIR, the default ~/.config/tg-cli/.env is still used (regression: the override must not become mandatory)', async () => {
  received = [];
  const home = tempDir('tg-cfgdir-default-home-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:default\nTG_CHAT_ID=1\n');
  const { exitCode, stderr } = await run(['hello from the default dir'], {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TG_API_BASE: `http://127.0.0.1:${server.port}`,
  });
  expect(stderr).not.toContain('TG_BOT_TOKEN and TG_CHAT_ID must be set');
  expect(exitCode).toBe(0);
  expect(received).toHaveLength(1);
});

test('an empty HOME with no TG_CTL_CONFIG_DIR still hard-fails on missing credentials (sanity: the override is not silently bypassing the gate)', async () => {
  received = [];
  const home = tempDir('tg-cfgdir-nocreds-home-');
  dirs.push(home);
  const { exitCode, stderr } = await run(['should never send'], {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TG_API_BASE: `http://127.0.0.1:${server.port}`,
  });
  // 78 = not configured (docs/specs/tg-auth.md §7), with the `tg auth` hint and the resolved path.
  expect(exitCode).toBe(78);
  expect(stderr).toContain(join(home, '.config', 'tg-cli', '.env'));
  expect(stderr).toContain('TG_BOT_TOKEN and TG_CHAT_ID must be set');
  expect(received).toHaveLength(0);
});
