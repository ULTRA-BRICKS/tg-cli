import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, trackCfgDir, trackProc } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

// Process-level singleton check (spec §6, §11): two REAL `tg-ctl run` daemons
// race for the same per-bot flock; exactly one survives, the loser exits 0
// (idempotent no-op, so double auto-starts are cheap). No live Telegram —
// TG_API_BASE points at a local fake whose getUpdates holds the connection,
// keeping the winner parked in its long-poll like production.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();

// Fake Bot API: hold ~2s then answer empty. An INSTANT empty response would
// make the daemon loop spin hot (real Telegram paces via the 50s hold).
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/getUpdates')) {
      await Bun.sleep(2000);
      return Response.json({ ok: true, result: [] });
    }
    return Response.json({ ok: true, result: {} });
  },
});

// Isolated config dir: creds in .env (the entrypoint reads them from there),
// control enabled. botIdFromToken('123:abc') = '123' → state files tg-ctl.123.*.
const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-singleton-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const pidFile = join(cfgDir, 'tg-ctl.123.pid');

// PATH-shim tmux so daemon discovery never even READS the user's real tmux
// server (this test runs on dev machines with live agent panes).
const shimDir = join(cfgDir, 'bin');
mkdirSync(shimDir);
writeFileSync(join(shimDir, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

function spawnDaemon(): Subprocess {
  // Explicit env (no inherit): no TMUX, no real credentials, shim first on PATH.
  const proc = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  trackProc(reg, proc);
  trackCfgDir(reg, cfgDir);
  return proc;
}

afterAll(async () => {
  // Snapshot the tracked pids before reapDaemons drains the registry, so we can
  // still assert nothing survived after teardown.
  const pids = reg.procs.map((p) => p.pid);
  await reapDaemons(reg);
  // Double-check nothing survived: kill(pid, 0) must throw once reaped.
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
  server.stop(true);
});

test('flock singleton: one daemon survives, the loser exits 0, SIGTERM cleans the pidfile', async () => {
  const a = spawnDaemon();
  const b = spawnDaemon();
  const t0 = Date.now();

  // Wait for exactly one process (the flock loser) to exit. Bun startup is
  // a few hundred ms; 5s is generous without dragging out the test.
  let loser: Subprocess | undefined;
  let survivor: Subprocess | undefined;
  while (Date.now() - t0 < 5000) {
    const aDone = a.exitCode !== null;
    const bDone = b.exitCode !== null;
    if (aDone && bDone) break; // both dead — loser stays undefined, fails below
    if (aDone || bDone) {
      loser = aDone ? a : b;
      survivor = aDone ? b : a;
      break;
    }
    await Bun.sleep(50);
  }
  expect(loser).toBeDefined();
  expect(survivor).toBeDefined();
  expect(loser!.exitCode).toBe(0);

  // The winner must still be alive past the 1s mark, holding the lock and
  // its pidfile (which names the SURVIVOR, not the loser).
  const elapsed = Date.now() - t0;
  if (elapsed < 1200) await Bun.sleep(1200 - elapsed);
  expect(survivor!.exitCode).toBeNull();
  expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(survivor!.pid));

  // SIGTERM → clean exit removes the pidfile even mid-long-poll.
  survivor!.kill('SIGTERM');
  const exited = await Promise.race([
    survivor!.exited,
    Bun.sleep(4000).then(() => 'timeout' as const),
  ]);
  expect(exited).not.toBe('timeout');
  expect(survivor!.exitCode).toBe(0);
  expect(existsSync(pidFile)).toBe(false);
}, 10_000);

// tg#93 — the launchd-relaunch ownership race. A daemon that is shutting down
// must remove the pidfile ONLY when it still names its OWN pid. If a newer
// instance has already taken ownership and rewritten the pidfile with ITS pid
// (the window a launchd KeepAlive relaunch / a re-run `enable` opens), the
// departing daemon's cleanExit must NOT delete it — otherwise `tg-ctl status`
// reads no pid and falsely reports "not running" while the real daemon is alive.
//
// We can't deterministically schedule two real daemons into that overlap, so we
// drive the exact cleanExit decision: bring a daemon up, then OVERWRITE its
// pidfile with a FOREIGN live pid (a successor's), SIGTERM the daemon, and assert
// the foreign pidfile SURVIVES. RED before the fix (cleanExit unlinked it blindly).
test('cleanExit leaves a FOREIGN pidfile intact — a successor pidfile survives the old daemon shutdown (tg#93)', async () => {
  const ownCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-ownership-'));
  writeFileSync(join(ownCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(ownCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const ownPidFile = join(ownCfgDir, 'tg-ctl.123.pid');

  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: ownCfgDir,
      TG_CTL_CONFIG_DIR: ownCfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  trackProc(reg, daemon);
  // NOTE: deliberately do NOT trackCfgDir here. The teardown backstop reaps
  // whatever pid this cfgDir's pidfile names — and this test parks a FOREIGN
  // live pid in it on purpose. We clean the pidfile ourselves at the end so the
  // sweep can never read (and SIGKILL) the foreign successor.

  // Wait until the daemon has written its own pidfile.
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(ownPidFile)) await Bun.sleep(50);
  expect(readFileSync(ownPidFile, 'utf8').trim()).toBe(String(daemon.pid));

  // A throwaway, demonstrably-LIVE "successor" process whose pid we park in the
  // pidfile — simulating a newer daemon that took ownership during the relaunch
  // overlap. A long sleep so it stays alive across the SIGTERM + assertion.
  const successor = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  trackProc(reg, successor);
  const foreignPid = successor.pid;
  expect(foreignPid).not.toBe(daemon.pid);
  // Assumption: the daemon writes its pidfile ONCE at startup and never rewrites
  // it in the run loop. If a future heartbeat re-writes it, the daemon would put
  // its own pid back over `foreignPid` before SIGTERM and this would go falsely
  // RED even with the fix — revisit the parking strategy then.
  writeFileSync(ownPidFile, `${foreignPid}\n`);

  try {
    daemon.kill('SIGTERM');
    const exited = await Promise.race([
      daemon.exited,
      Bun.sleep(4000).then(() => 'timeout' as const),
    ]);
    expect(exited).not.toBe('timeout');

    // The foreign (successor) pidfile MUST survive — cleanExit only removes a
    // pidfile it owns. Pre-fix this asserts false (the blind unlink deleted it).
    expect(existsSync(ownPidFile)).toBe(true);
    expect(readFileSync(ownPidFile, 'utf8').trim()).toBe(String(foreignPid));
  } finally {
    // Deterministic cleanup even if an assertion threw (e.g. the RED run): remove
    // the parked-pid pidfile and kill the successor so nothing reads the foreign pid.
    try {
      unlinkSync(ownPidFile);
    } catch {}
    successor.kill('SIGKILL');
  }
}, 12_000);
