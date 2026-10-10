// tg-cli#317: the asking side must report what the daemon actually did. Before this,
// a card the daemon POSTED (messageId in its own log) and then expired on its unscoped
// timer produced the same bare `null` as a request DROPPED at the door, and the client
// logged both as "ask-forward not-posted … daemon declined or unreachable" — the hatch
// helper forwarded that to the agent, which was told a card Alex could see in Telegram
// was never sent (2026-09-05, messageId=14880). The daemon now writes an interim status
// line before its final reply; the client reads it and says expired / dropped(reason) /
// timed-out / unreachable. These tests drive a private daemon with a 400ms unscoped
// timer against a mock Telegram and read the CLIENT's stderr (what the hook sees).

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir, trackChild } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const REGISTERED_CWD = '/registered/project';

const cfgDir = tempDir('tgctl-asktruth-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
// An UNSCOPED request (no paneId — the hatch helper's shape) matches a registration by cwd.
writeFileSync(
  join(cfgDir, 'tg-ctl.123.registration.json'),
  JSON.stringify({ paneId: '%9', cwd: REGISTERED_CWD }),
);
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      await Bun.sleep(100);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      return Response.json({ ok: true, result: { message_id: 4242 } });
    }
    if (url.pathname.endsWith('/editMessageText') || url.pathname.endsWith('/editMessageReplyMarkup')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const procs: Subprocess[] = [];
const daemonEnv = {
  PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
  HOME: cfgDir,
  TG_CTL_CONFIG_DIR: cfgDir,
  TG_API_BASE: `http://127.0.0.1:${server.port}`,
  TG_CTL_UNSCOPED_TIMEOUT_MS: '400', // the incident's 110s, shrunk so the expiry is observable
};

beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], { env: daemonEnv, stdio: ['ignore', logFd, logFd] }));
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
});

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  server.stop(true);
});

// Run one `tg-ctl ask` (the hook client) to completion and return what the hook sees.
async function askAndWait(payload: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(JSON.stringify(payload) + '\n');
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr };
}

const hatchRequest = (requestId: string, cwd: string) => ({
  requestId,
  agent: 'claude',
  kind: 'permission',
  question: 'Approve a one-time exception?',
  title: 'Hatch: no-long-inline-process',
  decisionLabels: { allow: 'Approve', deny: 'Deny' },
  cwd,
});

test('a posted card that expires is reported as EXPIRED with its messageId, never as not-posted', async () => {
  const { stdout, stderr } = await askAndWait(hatchRequest('hatch-posted-then-expired', REGISTERED_CWD));
  expect(stdout.trim()).toBe(''); // no decision → nothing for the harness
  expect(stderr).toContain('ask-forward expired: req=hatch-posted-then-expired');
  expect(stderr).toContain('messageId=4242');
  expect(stderr).toContain('posted to Telegram');
  expect(stderr).toMatch(/no decision within \d+ms \(daemon expiry/);
  expect(stderr).not.toContain('not-posted');
  expect(stderr).not.toContain('unreachable');
}, 15_000);

test('a request the daemon declines is reported as NOT-POSTED with the daemon reason', async () => {
  // requestId deliberately does NOT start with `hatch-`: tg-cli#333 (merged after this
  // branch was cut) exempts hatch-prefixed permissions from the registration gate, so a
  // hatch-shaped request here would skip straight to forward/expire instead of exercising
  // the not-registered drop this test is about.
  const { stdout, stderr } = await askAndWait(hatchRequest('plain-not-registered', '/some/unregistered/dir'));
  expect(stdout.trim()).toBe('');
  expect(stderr).toContain('ask-forward not-posted: req=plain-not-registered');
  expect(stderr).toContain('daemon declined: reason=not-registered');
  expect(stderr).not.toContain('posted to Telegram');
}, 15_000);

test('no daemon at all is reported as UNREACHABLE', async () => {
  const lonely = tempDir('tgctl-asktruth-nodaemon-');
  writeFileSync(join(lonely, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(lonely, 'config.yaml'), 'control:\n  enabled: true\n');
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: lonely, TG_CTL_CONFIG_DIR: lonely, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(JSON.stringify(hatchRequest('hatch-no-daemon', REGISTERED_CWD)) + '\n');
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain('ask-forward unreachable: req=hatch-no-daemon');
  expect(stderr).toContain('daemon socket closed or errored without a reply');
}, 15_000);
