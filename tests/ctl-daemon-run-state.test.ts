// Unit coverage for tg-cli#316: `tg-ctl status` must not report "not running" while a
// launchd-owned instance (or any live daemon process) is up. The pidfile is informational
// (spec §6); launchd and the flock holder are independent sources of truth.
//
// Accessed via: `tg-ctl status` / Telegram `/status` → composeStatus → daemonRunState.
// Assumptions: no real launchctl or kill(2) — pids and dumps are injected.
// Past bugs: pidfile-only status lied "not running" for launchd pid 11062 (tg-cli#316,
// 2026-09-08 repro); earlier cousin was cleanExit deleting a successor pidfile (tg-cli#93).
import { expect, test } from 'bun:test';
import { daemonRunState, daemonStatusLine } from '../features/tg-ctl/lock';
import {
  launchdJobConfigDir,
  parseLaunchctlListJobs,
  parseLaunchctlPrintEnvironment,
  parseLaunchctlPrintPid,
  selectLaunchdDaemonJob,
  type ProbedLaunchdJob,
} from '../features/tg-ctl/autostart';

const BOT = '8574086668';
const BIN = '/Users/u/.files/bin/tg-ctl';
const CFG = '/Users/u/.config/tg-cli';

// Trimmed from the live 2026-09-08 dump (`launchctl print gui/501/ai.hyperide.tg-ctl`).
const LIVE_DUMP = `gui/501/ai.hyperide.tg-ctl = {
	active count = 1
	path = /Users/u/Library/LaunchAgents/ai.hyperide.tg-ctl.plist
	type = LaunchAgent
	state = running

	program = /Users/u/.bun/bin/bun
	arguments = {
		/Users/u/.bun/bin/bun
		/Users/u/.files/bin/tg-ctl
		run
	}

	inherited environment = {
		SSH_AUTH_SOCK => /var/run/com.apple.launchd.X/Listeners
	}

	default environment = {
		PATH => /usr/bin:/bin
	}

	environment = {
		PATH => /Users/u/.bun/bin:/usr/bin
		HOME => /Users/u
		XPC_SERVICE_NAME => ai.hyperide.tg-ctl
	}

	domain = gui/501 [112914]
	properties = keepalive | runatload
	runs = 2
	pid = 11062
}`;

test('parseLaunchctlPrintPid reads the live pid; a job with no pid line yields undefined', () => {
  expect(parseLaunchctlPrintPid(LIVE_DUMP)).toBe(11062);
  expect(parseLaunchctlPrintPid('gui/501/x = {\n\tstate = not running\n}')).toBeUndefined();
});

test('parseLaunchctlListJobs reads live pids and treats dash as not-running', () => {
  const out = ['PID\tStatus\tLabel', '11062\t0\tai.hyperide.tg-ctl', '-\t0\tai.hyperide.tmux-boot', '', 'garbage'].join('\n');
  expect(parseLaunchctlListJobs(out)).toEqual([
    { pid: 11062, label: 'ai.hyperide.tg-ctl' },
    { pid: null, label: 'ai.hyperide.tmux-boot' },
  ]);
});


test('parseLaunchctlPrintEnvironment merges the blocks, the job-specific one winning', () => {
  const env = parseLaunchctlPrintEnvironment(LIVE_DUMP);
  expect(env.HOME).toBe('/Users/u');
  expect(env.PATH).toBe('/Users/u/.bun/bin:/usr/bin');
  expect(env.SSH_AUTH_SOCK).toBe('/var/run/com.apple.launchd.X/Listeners');
});

test('launchdJobConfigDir: explicit override wins, else the default under the job HOME, else unknown', () => {
  expect(launchdJobConfigDir({ TG_CTL_CONFIG_DIR: '/pinned', HOME: '/Users/u' })).toBe('/pinned');
  expect(launchdJobConfigDir({ HOME: '/Users/u' })).toBe(CFG);
  expect(launchdJobConfigDir({})).toBeUndefined();
});

function job(over: Partial<ProbedLaunchdJob> = {}): ProbedLaunchdJob {
  return {
    label: 'ai.hyperide.tg-ctl',
    argv: ['/Users/u/.bun/bin/bun', BIN, 'run'],
    persistent: true,
    pid: 11062,
    configDir: CFG,
    ...over,
  };
}

test('selectLaunchdDaemonJob finds the live job serving this config dir', () => {
  expect(selectLaunchdDaemonJob([job()], BIN, CFG, CFG)).toEqual({ label: 'ai.hyperide.tg-ctl', pid: 11062 });
});

test('selectLaunchdDaemonJob ignores a job serving a DIFFERENT config dir (another bot, or a test HOME)', () => {
  expect(selectLaunchdDaemonJob([job()], BIN, '/tmp/throwaway-cfg', '/tmp/home/.config/tg-cli')).toBeUndefined();
});

test('selectLaunchdDaemonJob credits a dump with no environment only when WE are on the default dir', () => {
  const unknownEnv = job({ configDir: undefined });
  expect(selectLaunchdDaemonJob([unknownEnv], BIN, CFG, CFG)).toEqual({ label: 'ai.hyperide.tg-ctl', pid: 11062 });
  expect(selectLaunchdDaemonJob([unknownEnv], BIN, '/tmp/cfg', CFG)).toBeUndefined();
});

test('selectLaunchdDaemonJob ignores a loaded-but-not-running job and one that runs another binary', () => {
  expect(selectLaunchdDaemonJob([job({ pid: undefined })], BIN, CFG, CFG)).toBeUndefined();
  expect(selectLaunchdDaemonJob([job({ argv: ['/usr/bin/other', 'run'] })], BIN, CFG, CFG)).toBeUndefined();
});

test("selectLaunchdDaemonJob accepts tg-ctl's OWN unit and a non-persistent job (both still RUN it)", () => {
  expect(selectLaunchdDaemonJob([job({ label: 'com.agenttools.tg-ctl.tg-ctl' })], BIN, CFG, CFG)?.label).toBe(
    'com.agenttools.tg-ctl.tg-ctl',
  );
  expect(selectLaunchdDaemonJob([job({ persistent: false })], BIN, CFG, CFG)?.pid).toBe(11062);
});

const LAUNCHD = { label: 'ai.hyperide.tg-ctl', pid: 11062 };

test('live pidfile, no launchd → running (pid) — existing wording', () => {
  expect(daemonStatusLine(daemonRunState(4242, true, undefined), BOT)).toBe(`tg-ctl: running (pid 4242) — bot ${BOT}`);
});

test('stale pidfile, no other evidence → not running (stale pidfile)', () => {
  expect(daemonStatusLine(daemonRunState(4242, false, undefined), BOT)).toBe(
    `tg-ctl: not running (stale pidfile, pid 4242) — bot ${BOT}`,
  );
});

test('absent pidfile, nothing else → not running', () => {
  expect(daemonStatusLine(daemonRunState(null, false, undefined), BOT)).toBe(`tg-ctl: not running — bot ${BOT}`);
});

test('no pidfile + live launchd job → running (launchd) — THE live regression', () => {
  const state = daemonRunState(null, false, LAUNCHD);
  expect(state).toEqual({ kind: 'running', owner: 'launchd', pid: 11062, label: 'ai.hyperide.tg-ctl' });
  expect(daemonStatusLine(state, BOT)).toBe(
    `tg-ctl: running (launchd, pid 11062) — bot ${BOT} (job ai.hyperide.tg-ctl)`,
  );
});

test('stale pidfile + live launchd job → running (launchd), not "not running"', () => {
  const line = daemonStatusLine(daemonRunState(999, false, LAUNCHD), BOT);
  expect(line).toContain('running (launchd, pid 11062)');
  expect(line).not.toMatch(/^tg-ctl: not running/);
  expect(line).toContain('stale pidfile pid 999');
});

test('pidfile agreeing with the launchd pid → one clean launchd line', () => {
  expect(daemonStatusLine(daemonRunState(11062, true, LAUNCHD), BOT)).toBe(
    `tg-ctl: running (launchd, pid 11062) — bot ${BOT} (job ai.hyperide.tg-ctl)`,
  );
});

test('socket missing but lock-holder process alive → running, not "not running"', () => {
  // The 2026-09-08 machine: pidfile gone, unix socket may be gone, flock still held by pid 11062.
  const state = daemonRunState(null, false, undefined, 11062);
  expect(state).toEqual({ kind: 'running', owner: 'process', pid: 11062 });
  const line = daemonStatusLine(state, BOT);
  expect(line).toBe(`tg-ctl: running (pid 11062) — bot ${BOT}`);
  expect(line).not.toMatch(/not running/);
});

test('stale pidfile + live lock holder → running (the process), not stale', () => {
  const line = daemonStatusLine(daemonRunState(999, false, undefined, 11062), BOT);
  expect(line).toBe(`tg-ctl: running (pid 11062) — bot ${BOT}`);
  expect(line).not.toMatch(/not running/);
});

test('launchd wins over a live lock holder (same process, named as launchd)', () => {
  const line = daemonStatusLine(daemonRunState(null, false, LAUNCHD, 11062), BOT);
  expect(line).toContain('running (launchd, pid 11062)');
});

test('a live pidfile pid that does not hold the flock is a reused pid — the lock holder is the daemon (tg-cli#438)', () => {
  // stop/restart probe the flock even when the pidfile pid is alive; signalling the
  // pidfile's pid here would SIGTERM an unrelated process and leave the daemon running.
  expect(daemonRunState(4242, true, undefined, 11062)).toEqual({ kind: 'running', owner: 'process', pid: 11062 });
});
