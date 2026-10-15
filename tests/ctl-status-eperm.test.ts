// tg-cli#748: `tg-ctl status` must report a live daemon as running when signal 0 to its pid
// answers EPERM — the process exists, the caller just may not signal it (a different uid, or a
// session inside a Landlock signal domain, rig-cli#704). Only ESRCH, or a pid kill(2) cannot even
// take, means the pid is gone.
//
// Accessed via: `bun [--preload kill0-eperm-preload.ts] tg-ctl status` against a config dir whose
// pidfile names the pid under test. There is no flock file, so the pidfile is the only evidence —
// the same as a contained caller that cannot read the holder's /proc/<pid>/fd.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncBounded } from './helpers/spawn-sync';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir, trackChild } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const EPERM_PRELOAD = join(import.meta.dir, 'helpers', 'kill0-eperm-preload.ts');

// `123` is the bot id: the token's prefix names the daemon's files, so `tg-ctl.123.pid` is the
// pidfile `status` reads for this token.
function configDir(pidfilePid: number): string {
  const cfgDir = tempDir('tgctl-status-eperm-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.pid'), `${pidfilePid}\n`);
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  return cfgDir;
}

function runStatus(cfgDir: string, bunFlags: string[] = []): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = spawnSyncBounded([process.execPath, ...bunFlags, TG_CTL, 'status'], {
    env: { PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// Does the kernel refuse this test process signal 0 to init? True for an unprivileged user on a
// normal host; false as root or inside a container whose pid 1 is our own uid.
function realEpermFromInit(): boolean {
  try {
    process.kill(1, 0);
    return false;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

test.skipIf(!realEpermFromInit())('status reports init as running from a real kernel EPERM, no stub', () => {
  const { exitCode, stdout, stderr } = runStatus(configDir(1));
  expect(exitCode).toBe(0);
  expect(stdout + stderr).not.toMatch(/tg-ctl: not running/);
  expect(stdout).toContain('tg-ctl: running (pid 1)');
}, 20_000);

test('status reports a live pidfile pid as running when kill(pid, 0) answers EPERM', () => {
  const daemon = trackChild(Bun.spawn(['sleep', '60'], { stdio: ['ignore', 'ignore', 'ignore'] }));
  const { exitCode, stdout } = runStatus(configDir(daemon.pid), ['--preload', EPERM_PRELOAD]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toMatch(/tg-ctl: not running/);
  expect(stdout).toContain(`tg-ctl: running (pid ${daemon.pid})`);
}, 20_000);

test('status still reports a stale pidfile when the pid is gone (ESRCH)', async () => {
  const gone = Bun.spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore'] });
  await gone.exited;
  const { exitCode, stdout } = runStatus(configDir(gone.pid));
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`tg-ctl: not running (stale pidfile, pid ${gone.pid})`);
}, 20_000);

test('status reports a stale pidfile for a pid kill(2) cannot take (above pid_t)', () => {
  // The pidfile parser accepts any positive integer; process.kill rejects this one with a
  // TypeError before any syscall, which is no evidence of a live process.
  const { exitCode, stdout } = runStatus(configDir(2 ** 31));
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`tg-ctl: not running (stale pidfile, pid ${2 ** 31})`);
}, 20_000);
