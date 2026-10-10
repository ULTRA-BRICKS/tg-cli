// Self-test for the shared daemon-lifecycle teardown (tests/helpers/daemon-lifecycle.ts).
//
// Proves the two properties the leak fix depends on:
//   1. reapDaemons kills a real `tg-ctl run` daemon and AWAITS its death.
//   2. The scoped backstop reaps a daemon that was NEVER tracked in procs[]
//      (the spawn-before-track / detached-grandchild leak) — and is keyed on the
//      temp cfgDir's own pid file, so it can never touch a non-temp daemon.

import { afterEach, expect, test } from 'bun:test';
import { existsSync, openSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import {
  awaitDetachedStartsSettled,
  createDaemonRegistry,
  reapDaemons,
  spawnDaemon,
  trackCfgDir,
  __test,
} from './helpers/daemon-lifecycle';
import { tempDir, trackChild } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();

afterEach(async () => {
  await reapDaemons(reg);
});

function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-lifecycle-selftest-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  return cfgDir;
}

function daemonEnv(cfgDir: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    // No mock server needed — getUpdates failures are tolerated; we only assert
    // the process lifecycle (socket + pid file), not Telegram traffic.
    TG_API_BASE: 'http://127.0.0.1:1',
  };
}

test('reapDaemons kills a tracked tg-ctl run daemon and waits for it to exit', async () => {
  const cfgDir = makeCfgDir();
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: daemonEnv(cfgDir), logFd });
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  expect(existsSync(socket)).toBe(true);
  const pid = daemon.pid;
  expect(__test.isAlive(pid)).toBe(true);

  await reapDaemons(reg);

  expect(__test.isAlive(pid)).toBe(false);
}, 15_000);

test('scoped backstop reaps a daemon that was NEVER tracked in procs[]', async () => {
  // Simulate the spawn-before-track / detached-grandchild leak: spawn a real
  // daemon WITHOUT registering the Subprocess, only its temp cfgDir. The tracked
  // procs[] pass cannot see it; only the cfgDir-scoped pid-file sweep can.
  const cfgDir = makeCfgDir();
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const leaked: Subprocess = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: daemonEnv(cfgDir),
    stdio: ['ignore', logFd, logFd],
  }));
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
  expect(__test.isAlive(leaked.pid)).toBe(true);

  // Only the cfgDir is known to the registry — NOT the Subprocess.
  trackCfgDir(reg, cfgDir);

  const reaped = await reapDaemons(reg);

  expect(reaped).toContain(leaked.pid);
  expect(__test.isAlive(leaked.pid)).toBe(false);
  await leaked.exited;
}, 15_000);

test('backstop ignores a cfgDir whose pid file names an already-dead process', async () => {
  // A stale pid file must not cause a spurious kill of an unrelated reused pid.
  // We point at a pid that is guaranteed dead (a freshly-exited child).
  const cfgDir = makeCfgDir();
  const dead = Bun.spawn([process.execPath, '-e', 'process.exit(0)']);
  await dead.exited;
  writeFileSync(join(cfgDir, 'tg-ctl.123.pid'), `${dead.pid}\n`);
  trackCfgDir(reg, cfgDir);

  const reaped = await reapDaemons(reg);

  expect(reaped).not.toContain(dead.pid);
}, 10_000);

test('settle-reap (detachedStarts) reaps a late daemon that grabbed the freed flock', async () => {
  // The issue #70 core: after the main daemon is killed (flock freed), a detached
  // grandchild comes up LATE and acquires the flock, becoming a surviving daemon a
  // one-shot read already missed. Simulate it: track the cfgDir with detachedStarts,
  // then — WITHOUT tracking the Subprocess — bring up a fresh daemon on that cfgDir
  // just before teardown. Only the settle-loop can catch a daemon that materializes
  // mid-teardown.
  const cfgDir = makeCfgDir();
  trackCfgDir(reg, cfgDir, { detachedStarts: true });

  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const late: Subprocess = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: daemonEnv(cfgDir),
    stdio: ['ignore', logFd, logFd],
  }));
  // Don't wait for its socket — let it come up DURING reapDaemons' settle window,
  // exactly like a real late grandchild.
  const reaped = await reapDaemons(reg);

  expect(reaped).toContain(late.pid);
  expect(__test.isAlive(late.pid)).toBe(false);
  await late.exited;
}, 15_000);

test('awaitDetachedStartsSettled returns once the pid file is stable on the main daemon', async () => {
  // The detached-`start` settle gate: with the main daemon up and its pid file
  // naming the live main pid, the gate must return promptly (a full quiet window
  // with no pid-file change), well under its maxMs cap.
  const cfgDir = makeCfgDir();
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: daemonEnv(cfgDir), logFd });
  expect(__test.readDaemonPid(cfgDir)).toBe(daemon.pid);

  const t0 = Date.now();
  await awaitDetachedStartsSettled(cfgDir, daemon.pid, { maxMs: 3000, quietMs: 400 });
  const elapsed = Date.now() - t0;

  // Settled via the quiet window, not the maxMs backstop.
  expect(elapsed).toBeLessThan(2500);
  expect(elapsed).toBeGreaterThanOrEqual(400);
  expect(__test.isAlive(daemon.pid)).toBe(true);

  await reapDaemons(reg);
}, 15_000);
