// Unit coverage for tg-cli#316 (c): `tg-ctl status` must not report "not running" while a
// launchd-owned instance is alive. The pidfile and the launchd probe are two independent sources
// of truth; these tests pin the precedence between them and the parsing of a `launchctl print`
// dump. No real launchctl is ever spawned here.
import { expect, test } from 'bun:test';
import { daemonRunState, daemonStatusLine } from '../features/tg-ctl/lock';
import {
  launchdJobConfigDir,
  parseLaunchctlPrintEnvironment,
  parseLaunchctlPrintPid,
  selectLaunchdDaemonJob,
  type ProbedLaunchdJob,
} from '../features/tg-ctl/autostart';

const BOT = '8574086668';
const BIN = '/Users/u/.files/bin/tg-ctl';
const CFG = '/Users/u/.config/tg-cli';

// The live dump this was reproduced against (`launchctl print gui/501/ai.hyperide.tg-ctl`), trimmed.
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

test('parseLaunchctlPrintEnvironment merges the blocks, the job-specific one winning', () => {
  const env = parseLaunchctlPrintEnvironment(LIVE_DUMP);
  expect(env.HOME).toBe('/Users/u');
  expect(env.PATH).toBe('/Users/u/.bun/bin:/usr/bin'); // the job `environment` block, not `default`
  expect(env.SSH_AUTH_SOCK).toBe('/var/run/com.apple.launchd.X/Listeners');
});

test('launchdJobConfigDir: explicit override wins, else the default under the job HOME, else unknown', () => {
  expect(launchdJobConfigDir({ TG_CTL_CONFIG_DIR: '/pinned', HOME: '/Users/u' })).toBe('/pinned');
  expect(launchdJobConfigDir({ HOME: '/Users/u' })).toBe(CFG);
  expect(launchdJobConfigDir({})).toBeUndefined();
});

function job(over: Partial<ProbedLaunchdJob> = {}): ProbedLaunchdJob {
  return { label: 'ai.hyperide.tg-ctl', argv: ['/Users/u/.bun/bin/bun', BIN, 'run'], persistent: true, pid: 11062, configDir: CFG, ...over };
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

test('selectLaunchdDaemonJob accepts tg-ctl’s OWN unit and a non-persistent job (both still RUN it)', () => {
  expect(selectLaunchdDaemonJob([job({ label: 'com.agenttools.tg-ctl.tg-ctl' })], BIN, CFG, CFG)?.label).toBe('com.agenttools.tg-ctl.tg-ctl');
  expect(selectLaunchdDaemonJob([job({ persistent: false })], BIN, CFG, CFG)?.pid).toBe(11062);
});

// --- the pidfile x launchd matrix ---------------------------------------------------------------

const LAUNCHD = { label: 'ai.hyperide.tg-ctl', pid: 11062 };

test('no pidfile at all + a live launchd job → running (launchd) — THE live regression', () => {
  const state = daemonRunState(null, false, LAUNCHD, true);
  expect(state).toEqual({ kind: 'running', owner: 'launchd', pid: 11062, label: 'ai.hyperide.tg-ctl' });
  expect(daemonStatusLine(state, BOT)).toBe(`tg-ctl: running (launchd, pid 11062) — bot ${BOT} (job ai.hyperide.tg-ctl)`);
});

test('stale pidfile + a live launchd job → running (launchd), the stale pid reported as such', () => {
  const line = daemonStatusLine(daemonRunState(999, false, LAUNCHD, true), BOT);
  expect(line).toContain('running (launchd, pid 11062)');
  expect(line).toContain('stale pidfile pid 999');
});

test('the pidfile agreeing with the launchd pid → one clean launchd line, no note', () => {
  expect(daemonStatusLine(daemonRunState(11062, true, LAUNCHD, true), BOT)).toBe(
    `tg-ctl: running (launchd, pid 11062) — bot ${BOT} (job ai.hyperide.tg-ctl)`,
  );
});

test('a DIFFERENT live pid in the pidfile is surfaced, launchd still named as the owner', () => {
  const line = daemonStatusLine(daemonRunState(4242, true, LAUNCHD, true), BOT);
  expect(line).toContain('running (launchd, pid 11062)');
  expect(line).toContain('pidfile points at a different live pid 4242');
});

test('no launchd job, live pidfile → running (manual)', () => {
  expect(daemonStatusLine(daemonRunState(4242, true, undefined, true), BOT)).toBe(`tg-ctl: running (manual, pid 4242) — bot ${BOT}`);
});

test('no launchd job, dead pidfile → the unchanged stale-pidfile line', () => {
  expect(daemonStatusLine(daemonRunState(4242, false, undefined, true), BOT)).toBe(`tg-ctl: not running (stale pidfile, pid 4242) — bot ${BOT}`);
});

test('nothing anywhere → the unchanged not-running line', () => {
  expect(daemonStatusLine(daemonRunState(null, false, undefined, true), BOT)).toBe(`tg-ctl: not running — bot ${BOT}`);
});

test('on a platform with NO supervisor probe a live pidfile is reported without claiming "manual"', () => {
  // Only launchd is probed today; on Linux a systemd --user unit with Restart= supervises the
  // daemon exactly the way launchd does, so calling it "manual" would be a guess.
  expect(daemonStatusLine(daemonRunState(4242, true, undefined, false), BOT)).toBe(`tg-ctl: running (pid 4242) — bot ${BOT}`);
});
