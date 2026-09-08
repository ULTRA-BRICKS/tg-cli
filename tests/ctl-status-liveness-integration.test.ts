// Integration: `tg-ctl status` must not say "not running" while the daemon process is
// up, even when the pidfile is gone and the unix socket is unlinked (tg-cli#316).
// `tg-ctl ask` must still attempt the hook socket in that same state — hatch callers
// that previously trusted a lying status skipped ask entirely.
//
// Accessed via: spawn `tg-ctl run` against a mock Bot API, then `status` / `ask`.
// Assumptions: the daemon takes the flock before writing the pidfile; lsof can name
// the lock holder. Does not touch the developer's live LaunchAgent.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const procs: Subprocess[] = [];
const servers: Array<{ stop: (c?: boolean) => void }> = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const s of servers.splice(0)) s.stop(true);
});

function startMockBot(): { port: number; sent: { text: string }[] } {
  const sent: { text: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as { text: string };
        sent.push(body);
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  return { port: server.port, sent };
}

async function startDaemon(cfgDir: string, port: number): Promise<Subprocess> {
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: '%1', cwd: cfgDir }),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  procs.push(daemon);
  const pidFile = join(cfgDir, 'tg-ctl.123.pid');
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !(existsSync(pidFile) && existsSync(socket))) await Bun.sleep(50);
  expect(existsSync(pidFile)).toBe(true);
  expect(existsSync(socket)).toBe(true);
  return daemon;
}

function runStatus(cfgDir: string): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, TG_CTL, 'status'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// Real daemon + mock Bot API; poll loops wait on pidfile/socket/send, not a guessed sleep.
test('status reports running after the pidfile is deleted while the process is alive', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-status-nopid-'));
  const { port } = startMockBot();
  const daemon = await startDaemon(cfgDir, port);
  const pid = daemon.pid;
  expect(pid).toBeGreaterThan(0);
  unlinkSync(join(cfgDir, 'tg-ctl.123.pid'));
  const { stdout, stderr } = runStatus(cfgDir);
  expect(stdout + stderr).not.toMatch(/tg-ctl: not running/);
  expect(stdout).toContain(`tg-ctl: running (pid ${pid})`);
}, 20_000);

test('status reports running when the socket is gone too — lock holder is enough', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-status-nosock-'));
  const { port } = startMockBot();
  const daemon = await startDaemon(cfgDir, port);
  const pid = daemon.pid;
  unlinkSync(join(cfgDir, 'tg-ctl.123.pid'));
  unlinkSync(join(cfgDir, 'tg-ctl.123.sock'));
  const { stdout } = runStatus(cfgDir);
  expect(stdout).not.toMatch(/tg-ctl: not running/);
  expect(stdout).toContain(`tg-ctl: running (pid ${pid})`);
}, 20_000);

test('ask is still attempted when the pidfile is gone but the process is alive', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-ask-nopid-'));
  const { port, sent } = startMockBot();
  await startDaemon(cfgDir, port);
  unlinkSync(join(cfgDir, 'tg-ctl.123.pid'));
  const before = sent.length;
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(ask);
  ask.stdin.write(
    JSON.stringify({
      requestId: 'q_nopid',
      cwd: cfgDir,
      paneId: '%1',
      agent: 'claude',
      kind: 'question',
      question: 'Approve the hatch?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    }) + '\n',
  );
  ask.stdin.end();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && sent.length === before) await Bun.sleep(50);
  expect(sent.length).toBeGreaterThan(before);
  expect(sent.some((m) => m.text.includes('Approve the hatch?'))).toBe(true);
  const log = existsSync(join(cfgDir, 'daemon.log')) ? readFileSync(join(cfgDir, 'daemon.log'), 'utf8') : '';
  expect(log).not.toContain('ask-forward not-posted');
  expect(log).toContain('ask-forward posted');
  ask.kill(9);
  await ask.exited;
}, 20_000);

