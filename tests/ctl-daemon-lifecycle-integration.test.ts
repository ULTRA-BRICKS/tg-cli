// Integration: `tg-ctl stop` / `restart` find the running daemon through the SAME
// pidfile → flock-holder → launchd chain `status` uses (tg-cli#438) — a vanished
// pidfile must never make them no-op against a live daemon — and `restart` reports
// success only for a verified hand-off (old process confirmed dead, a successor holding
// the flock). `status` / `restart --if-stale` compare the commit a running daemon loaded
// with its checkout's HEAD, so a merged-but-not-restarted fix is visible (tg-cli#279).
//
// Accessed via: real `tg-ctl run` daemons against a mock Bot API in temp config dirs;
// the #279 case runs the daemon from a throwaway git checkout (a copy of this tree) so
// commits can move its HEAD. Never touches the developer's live daemon or LaunchAgent.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackCfgDir, trackProc } from './helpers/daemon-lifecycle';

const REPO = join(import.meta.dir, '..');
const TG_CTL = join(REPO, 'tg-ctl');
const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) s.stop(true);
});

function startMockBot(): number {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        await Bun.sleep(80); // an idle long-poll, so the real daemon loop doesn't spin
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  return server.port;
}

// A temp config dir with fake creds, control enabled, a no-op tmux, and the env every
// tg-ctl invocation (daemon, stop, restart, status) runs under — the restart launcher
// forwards its own env to the successor, so TG_API_BASE reaches it.
function prepareCfg(prefix: string): { cfgDir: string; env: Record<string, string> } {
  const cfgDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = {
    PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${startMockBot()}`,
  };
  return { cfgDir, env };
}

// ASYNC on purpose: the daemons under test are children of this test process, and an exited
// child stays a zombie (kill -0 still succeeds) until our event loop reaps it — a blocking
// spawnSync here would make every stop look like it never finished.
async function ctl(bin: string, args: string[], env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, bin, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { exitCode: await p.exited, stdout, stderr };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Live pids holding the daemon's flock file open (lsof names the singleton's owner).
function lockHolders(cfgDir: string): number[] {
  const r = Bun.spawnSync(['lsof', '-t', join(cfgDir, 'tg-ctl.123.lock')], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout
    .toString()
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => pid > 0 && alive(pid));
}

// Polls a REAL process condition (exit, flock hand-off): these are separate OS processes,
// so there is no in-process promise or fake clock to await instead.
async function waitFor<T>(probe: () => T | null | false | Promise<T | null | false>, ms: number): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 >= ms) return null;
    await Bun.sleep(50);
  }
}

test('stop terminates a live daemon whose pidfile vanished — located via the flock holder', async () => {
  const { cfgDir, env } = prepareCfg('tgctl-stop-nopid-');
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env });
  unlinkSync(join(cfgDir, 'tg-ctl.123.pid'));

  const res = await ctl(TG_CTL, ['stop'], env);

  expect(res.stdout).not.toContain('not running');
  expect(res.stdout).toContain(`stopped (pid ${daemon.pid})`);
  expect(res.exitCode).toBe(0);
  expect(await waitFor(() => daemon.exitCode !== null, 2000)).toBe(true);
}, 30_000);

test('restart replaces a live daemon whose pidfile vanished and reports the verified successor', async () => {
  const { cfgDir, env } = prepareCfg('tgctl-restart-nopid-');
  trackCfgDir(reg, cfgDir, { detachedStarts: true });
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env });
  const oldPid = daemon.pid;
  unlinkSync(join(cfgDir, 'tg-ctl.123.pid'));

  const res = await ctl(TG_CTL, ['restart'], env);

  expect(res.exitCode).toBe(0);
  expect(await waitFor(() => daemon.exitCode !== null, 2000)).toBe(true);
  const holders = lockHolders(cfgDir);
  expect(holders.length).toBe(1);
  expect(holders[0]).not.toBe(oldPid);
  expect(res.stdout).toContain(`restarted (pid ${oldPid} → ${holders[0]})`);
}, 40_000);

test('restart fails loudly and launches nothing when the lock holder survives SIGTERM', async () => {
  const { cfgDir, env } = prepareCfg('tgctl-restart-wedged-');
  // A wedged "daemon": holds the flock, has no pidfile, ignores SIGTERM.
  const holderSrc = join(cfgDir, 'holder.ts');
  writeFileSync(
    holderSrc,
    [
      "import { dlopen, FFIType } from 'bun:ffi';",
      "import { openSync } from 'fs';",
      "const lib = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';",
      'const ffi = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });',
      'if (ffi.symbols.flock(openSync(process.argv[2], "w"), 6) !== 0) process.exit(3);',
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const holder = trackProc(reg, Bun.spawn([process.execPath, holderSrc, join(cfgDir, 'tg-ctl.123.lock')], { stdio: ['ignore', 'ignore', 'ignore'] }));
  expect(await waitFor(() => lockHolders(cfgDir).includes(holder.pid), 5000)).toBe(true);

  const res = await ctl(TG_CTL, ['restart'], env);

  expect(res.exitCode).not.toBe(0);
  expect(res.stderr).toContain(`pid ${holder.pid}`);
  expect(res.stderr).toContain('did NOT start a replacement');
  expect(res.stdout).not.toContain('launch requested');
  expect(alive(holder.pid)).toBe(true);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.log'))).toBe(false);
}, 40_000);

test('stop/restart never signal a live pidfile pid when nobody holds the flock — a reused pid, the daemon is gone', async () => {
  const { cfgDir, env } = prepareCfg('tgctl-reused-pid-');
  trackCfgDir(reg, cfgDir, { detachedStarts: true });
  // The daemon died (its flock released, the empty lock file left behind) and the OS handed its
  // pid to an unrelated process that the stale pidfile now names.
  const bystander = trackProc(reg, Bun.spawn(['sleep', '60'], { stdio: ['ignore', 'ignore', 'ignore'] }));
  writeFileSync(join(cfgDir, 'tg-ctl.123.lock'), '');
  writeFileSync(join(cfgDir, 'tg-ctl.123.pid'), `${bystander.pid}\n`);

  const ifStale = await ctl(TG_CTL, ['restart', '--if-stale'], env);
  expect(ifStale.exitCode).toBe(0);
  expect(ifStale.stdout).toContain('not running — nothing to restart');

  const stop = await ctl(TG_CTL, ['stop'], env);
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout).toContain(`not running (cleaned stale pidfile, pid ${bystander.pid})`);
  expect(alive(bystander.pid)).toBe(true);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.pid'))).toBe(false);
}, 30_000);

// --- tg-cli#279: stale-daemon detection + restart --if-stale ---

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// A throwaway checkout holding exactly what the daemon loads, so commits can move its HEAD.
function makeCheckout(): string {
  const co = mkdtempSync(join(tmpdir(), 'tgctl-checkout-'));
  for (const rel of ['tg-ctl', 'features', 'tools', 'package.json']) cpSync(join(REPO, rel), join(co, rel), { recursive: true });
  writeFileSync(join(co, 'README.md'), 'checkout\n');
  git(co, 'init', '-q', '-b', 'main');
  git(co, 'add', '-A');
  git(co, 'commit', '-q', '-m', 'deployed');
  return co;
}

test('the code line names the loaded commit; a daemon-code commit makes it STALE and restart --if-stale fixes it, a docs commit does not', async () => {
  const co = makeCheckout();
  const bin = join(co, 'tg-ctl');
  const { cfgDir, env } = prepareCfg('tgctl-stale-');
  trackCfgDir(reg, cfgDir, { detachedStarts: true });
  const daemon = await spawnDaemon(reg, { tgCtlPath: bin, cfgDir, env });
  const first = git(co, 'rev-parse', '--short=7', 'HEAD');

  const current = await ctl(bin, ['restart', '--if-stale'], env);
  expect(current.stdout).toContain(`code: ${first} (current) — no restart needed`);

  writeFileSync(join(co, 'README.md'), 'docs only\n');
  git(co, 'commit', '-qam', 'docs');
  const docs = git(co, 'rev-parse', '--short=7', 'HEAD');
  const noop = await ctl(bin, ['restart', '--if-stale'], env);
  expect(noop.exitCode).toBe(0);
  expect(noop.stdout).toContain(`code: ${first} (checkout at ${docs} — no daemon code changed) — no restart needed`);
  expect(alive(daemon.pid)).toBe(true);

  appendFileSync(join(co, 'features', 'tg-ctl', 'lock.ts'), '\n// merged fix\n');
  git(co, 'commit', '-qam', 'fix(tg-ctl): daemon change');
  const fix = git(co, 'rev-parse', '--short=7', 'HEAD');
  const status = (await ctl(bin, ['status'], env)).stdout;
  expect(status).toContain(`code: STALE — daemon runs ${first} but`);
  expect(status).toContain(`is at ${fix} (1 daemon file(s) changed) — run \`tg-ctl restart\``);

  const restarted = await ctl(bin, ['restart', '--if-stale'], env);
  expect(restarted.exitCode).toBe(0);
  expect(restarted.stdout).toContain('— restarting');
  expect(await waitFor(() => daemon.exitCode !== null, 2000)).toBe(true);
  // The successor records its own run-info a moment after it writes the pidfile restart waits on.
  const settled = await waitFor(async () => (await ctl(bin, ['restart', '--if-stale'], env)).stdout.includes(`code: ${fix} (current) — no restart needed`), 5000);
  expect(settled).toBe(true);
}, 90_000);

test('restart --if-stale is a no-op when no daemon runs (a deploy never starts one)', async () => {
  const { cfgDir, env } = prepareCfg('tgctl-ifstale-down-');
  trackCfgDir(reg, cfgDir, { detachedStarts: true });

  const res = await ctl(TG_CTL, ['restart', '--if-stale'], env);

  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('not running');
  expect(existsSync(join(cfgDir, 'tg-ctl.123.log'))).toBe(false);
});
