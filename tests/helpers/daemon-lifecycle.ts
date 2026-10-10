// Shared daemon lifecycle for tg-ctl integration tests.
//
// Runtime path: imported by every `tests/ctl-*-integration.test.ts` that spawns
// a real `tg-ctl run` (or, via `tg-ctl start`, a DETACHED `run` grandchild)
// against a mock Telegram + a temp config dir. Its job is a teardown that NEVER
// leaks a daemon — not on a test that throws/times out before its own cleanup,
// not on a daemon that escaped the tracked `procs[]` (the spawn-before-track gap),
// and not on a detached grandchild that `procs[]` never held (issue #70).
//
// Two leak vectors this guards, both observed reaping stray daemons by hand:
//   1. spawn-before-track: a helper did `Bun.spawn([... 'run'])` and THEN
//      `expect(socketExists).toBe(true)`. When that assert throws, the spawned
//      daemon was not yet pushed to `procs[]` → never killed. `spawnDaemon`
//      registers the proc BEFORE the socket wait, so a thrown wait still reaps it.
//   2. detached grandchild: `tg-ctl start` always spawns an unref'd detached
//      `tg-ctl run`; the flock makes a duplicate exit fast, but on a busy machine
//      one escapes a `procs[]`-only teardown (it was never the tracked proc).
//
// Safety invariant — the backstop sweep is SCOPED to the test's own temp config
// dirs. It only ever kills a pid read from `<cfgDir>/tg-ctl.<botId>.pid`, where
// every daemon (tracked or detached) records its real pid. cfgDir is always a
// `tempDir('tgctl-*')` path, so the sweep can NEVER match the CTO's
// real daemon (a non-temp config dir). It does not pattern-match process names.

import type { Subprocess } from 'bun';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { trackChild } from './test-temp';

// All integration tests use the mock token `123:abc` → botId `123`.
const DEFAULT_BOT_ID = '123';

function pidFilePath(cfgDir: string, botId: string): string {
  return join(cfgDir, `tg-ctl.${botId}.pid`);
}

// A live process? `kill(pid, 0)` throws ESRCH when the pid is gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Read the daemon's own recorded pid from its temp config dir. Returns null when
// the file is absent (daemon never started / already cleaned it up) or unparsable.
function readDaemonPid(cfgDir: string, botId: string = DEFAULT_BOT_ID): number | null {
  const p = pidFilePath(cfgDir, botId);
  if (!existsSync(p)) return null;
  try {
    const pid = Number.parseInt(readFileSync(p, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Kill, for ONE temp config dir, whatever live daemon its pid file currently
// names. Returns the reaped pid, or null if the dir held no live daemon.
async function reapCfgDirOnce(cfgDir: string, reaped: number[]): Promise<number | null> {
  const pid = readDaemonPid(cfgDir);
  if (pid === null || !isAlive(pid)) return null;
  await killPidAndWait(pid);
  reaped.push(pid);
  return pid;
}

// Settle-reap a temp config dir that may have spawned DETACHED `start`
// grandchildren — repeatedly, until it stays quiet for a `quietMs` window.
//
// Why a loop: `tg-ctl start` spawns a DETACHED, unref'd `tg-ctl run` grandchild
// whose flock+pid-write happens ASYNCHRONOUSLY, AFTER the `start` launcher exited
// and possibly after the test's main daemon was killed. So a grandchild can come
// up LATE (acquiring the now-free flock) and become a surviving daemon a one-shot
// read already missed. The loop keeps killing whatever the pid file names until a
// full quiet window passes — covering a grandchild that materializes mid-teardown.
// Bounded by `maxMs`. Only the cfgDirs that opted into `detachedStarts` pay this
// cost; a plain `run` cfgDir is reaped in a single pass (see reapDaemons).
async function reapCfgDirSettling(
  cfgDir: string,
  reaped: number[],
  maxMs = 4000,
  quietMs = 600,
): Promise<void> {
  const t0 = Date.now();
  let lastKill = 0;
  for (;;) {
    if ((await reapCfgDirOnce(cfgDir, reaped)) !== null) lastKill = Date.now();
    if (Date.now() - t0 >= maxMs) return;
    const since = lastKill === 0 ? t0 : lastKill;
    if (Date.now() - since >= quietMs) return;
    await Bun.sleep(50);
  }
}

// SIGKILL a pid and busy-wait (bounded) until it's actually gone. Returns true
// when the process is confirmed dead, false if it outlived the deadline.
async function killPidAndWait(pid: number, deadlineMs = 4000): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone between the check and the signal — fine.
    return !isAlive(pid);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !isAlive(pid);
}

/**
 * A bag of daemons/subprocesses a test spawned, plus the temp config dirs it
 * used. Create one per test file; pass it to `spawnDaemon`/`trackProc` and reap
 * it in `afterEach`/`afterAll`. `settleCfgDirs` is the subset that may spawn a
 * DETACHED `start` grandchild and therefore needs the slower settle-reap.
 */
export interface DaemonRegistry {
  procs: Subprocess[];
  cfgDirs: Set<string>;
  settleCfgDirs: Set<string>;
}

export function createDaemonRegistry(): DaemonRegistry {
  return { procs: [], cfgDirs: new Set(), settleCfgDirs: new Set() };
}

/**
 * Track a spawned subprocess (daemon, `ask`, `start`, …) so teardown reaps it.
 * Call this IMMEDIATELY after `Bun.spawn`, before any assertion that can throw.
 */
export function trackProc(reg: DaemonRegistry, proc: Subprocess): Subprocess {
  reg.procs.push(proc);
  // Also run-scoped: an interrupted run skips this test's teardown, and off Linux the
  // preload's process sweep is a no-op, so only trackChild reaches this daemon then.
  return trackChild(proc);
}

/**
 * Record a temp config dir so the scoped backstop sweep covers any daemon that
 * escaped `procs[]` (one whose tracking we missed, or a detached grandchild).
 * Pass `{ detachedStarts: true }` only when this cfgDir runs `tg-ctl start`,
 * which spawns a DETACHED grandchild that can come up late — that opts the dir
 * into the slower settle-reap. The default is a single-pass reap (no per-teardown
 * settle wait), so plain `run` cfgDirs stay fast.
 */
export function trackCfgDir(
  reg: DaemonRegistry,
  cfgDir: string,
  opts: { detachedStarts?: boolean } = {},
): void {
  reg.cfgDirs.add(cfgDir);
  if (opts.detachedStarts) reg.settleCfgDirs.add(cfgDir);
}

/**
 * Spawn `tg-ctl run` against a temp config dir + mock Telegram, tracked BEFORE
 * the socket wait so a failed wait can never leak it. Waits up to `socketWaitMs`
 * for the daemon's unix socket; on timeout it returns the (tracked) proc anyway
 * so the caller can assert and teardown still reaps it.
 */
export async function spawnDaemon(
  reg: DaemonRegistry,
  opts: {
    tgCtlPath: string;
    cfgDir: string;
    env: Record<string, string>;
    logFd?: number;
    botId?: string;
    socketWaitMs?: number;
  },
): Promise<Subprocess> {
  const botId = opts.botId ?? DEFAULT_BOT_ID;
  const stdio: ['ignore', number | 'ignore', number | 'ignore'] =
    opts.logFd !== undefined ? ['ignore', opts.logFd, opts.logFd] : ['ignore', 'ignore', 'ignore'];
  // `detached` makes the daemon a process-group leader, so teardown can SIGKILL the daemon AND
  // every child it forked (tmux/ps shims, hook helpers) in one signal — a child that outlived a
  // pid-only kill was the orphan left behind after a timed-out test.
  const daemon = Bun.spawn([process.execPath, opts.tgCtlPath, 'run'], { env: opts.env, stdio, detached: true });
  // Track + record the cfgDir BEFORE waiting on the socket — the whole point.
  trackProc(reg, daemon);
  trackCfgDir(reg, opts.cfgDir);

  const socket = join(opts.cfgDir, `tg-ctl.${botId}.sock`);
  const t0 = Date.now();
  const deadline = opts.socketWaitMs ?? 5000;
  while (Date.now() - t0 < deadline && !existsSync(socket)) await Bun.sleep(50);
  return daemon;
}

/**
 * Settle the DETACHED `tg-ctl run` grandchildren that a `tg-ctl start` (or N of
 * them) spawns, while the test's main daemon STILL HOLDS the flock. Call this
 * after the `start`(s) and before the test ends.
 *
 * The race it closes: `Bun.spawn(..., { detached: true })` returns before the
 * grandchild has even run; the grandchild then flock-tries and — because the main
 * daemon holds it — `process.exit(0)`s without creating a socket/pid. But if the
 * test ends and teardown kills the main daemon FIRST, a not-yet-run grandchild can
 * acquire the now-free flock and survive as a leaked daemon. Waiting here lets
 * every grandchild reach (and lose) the flock while main still owns it, so none
 * can later claim it. Deterministic signal: the daemon's pid file keeps naming the
 * SAME live main pid for a full quiet window (a grandchild winning the flock would
 * rewrite it). Bounded by `maxMs`.
 */
export async function awaitDetachedStartsSettled(
  cfgDir: string,
  mainPid: number,
  opts: { maxMs?: number; quietMs?: number } = {},
): Promise<void> {
  const maxMs = opts.maxMs ?? 3000;
  const quietMs = opts.quietMs ?? 700;
  const t0 = Date.now();
  let stableSince = Date.now();
  for (;;) {
    const pid = readDaemonPid(cfgDir);
    // The main daemon must still be the recorded, live owner. Any deviation
    // (a grandchild rewrote the pid file) resets the quiet window.
    if (pid !== mainPid || !isAlive(mainPid)) stableSince = Date.now();
    if (Date.now() - stableSince >= quietMs) return;
    if (Date.now() - t0 >= maxMs) return;
    await Bun.sleep(50);
  }
}

/**
 * The guaranteed teardown. Kills every tracked proc and AWAITS its exit, then a
 * SCOPED backstop sweep: for each temp config dir, read the daemon's recorded
 * pid file and SIGKILL+await that pid too (covers a detached grandchild or any
 * daemon that escaped `procs[]`). Safe to call from `afterEach` or `afterAll`;
 * never throws, so it always runs even when the test itself failed.
 *
 * Returns the list of pids it had to reap via the backstop (i.e. ones the
 * tracked-proc pass missed) so a self-check can assert the sweep actually fires.
 */
export async function reapDaemons(reg: DaemonRegistry): Promise<number[]> {
  // 1. Kill tracked procs — their whole process group when they lead one (spawnDaemon's are) — and
  //    wait for each to actually exit. A tracked proc that Bun has not reaped (exitCode null) still
  //    owns its pid, so the group id cannot have been recycled to an unrelated process.
  for (const p of reg.procs.splice(0)) {
    if (p.exitCode === null) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        // Not a group leader (a plain trackProc'd child) — kill the pid alone below.
      }
      try {
        p.kill(9);
      } catch {
        // Process already reaped — ignore.
      }
      // Bound the wait so a wedged exit can't hang teardown forever; the backstop
      // sweep below SIGKILLs by pid as the hard fallback.
      await Promise.race([p.exited, Bun.sleep(4000)]);
    }
  }

  // 2. Scoped backstop: for each tracked TEMP config dir, reap any daemon its pid
  //    file names — covering a daemon that escaped procs[] (the spawn-before-track
  //    gap). A cfgDir that ran `tg-ctl start` gets the slower settle-reap (a
  //    DETACHED grandchild can come up late); every other dir is a single pass, so
  //    the common teardown pays no settle wait. cfgDir is always a `mkdtempSync`
  //    temp dir, so this can never touch the real daemon (a non-temp config dir).
  const reaped: number[] = [];
  for (const cfgDir of reg.cfgDirs) {
    if (reg.settleCfgDirs.has(cfgDir)) await reapCfgDirSettling(cfgDir, reaped);
    else await reapCfgDirOnce(cfgDir, reaped);
  }
  reg.cfgDirs.clear();
  reg.settleCfgDirs.clear();
  return reaped;
}

// Exposed for the self-test only.
export const __test = { readDaemonPid, isAlive, killPidAndWait };
