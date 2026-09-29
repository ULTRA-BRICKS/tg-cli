// End-to-end CLI checks for the tg-ctl service-management lifecycle (the agenttools_service
// contract): bare invocation prints HELP and never launches; the autostart subcommands exist and
// describe a per-OS plan. Like the shared service-management lib's own suite, this NEVER touches
// real autostart — `enable` is exercised through `--dry-run`, which prints the plan (unit path +
// launchctl/systemctl commands) and writes nothing, so no live LaunchAgent / systemd unit is ever
// loaded by the test run. (A real `launchctl load` would register a RunAtLoad agent into the
// tester's session and actually start the daemon — exactly the side effect this avoids.)
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claudeStatusLineTelemetryInstalled,
  codexUsageHookInstalled,
  harnessHooksInstalled,
  withClaudeHooks,
  withClaudeStatusLineTelemetry,
} from '../features/tg-ctl/hook-install';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

// Deterministically reap a daemon that `enable`'s fallback spawned (detached). The daemon writes
// its pidfile only AFTER taking the flock, so a bare `stop` races it; poll the pidfile, then
// SIGKILL the pid. Bounded so a never-spawned daemon doesn't hang the test. Leaves nothing behind.
function reapDaemon(cfg: string, botId: string): void {
  const pidFile = join(cfg, `tg-ctl.${botId}.pid`);
  for (let i = 0; i < 50; i++) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      return;
    }
    Bun.sleepSync(50);
  }
}

function run(args: string[], env: Record<string, string>, cwd?: string) {
  return Bun.spawnSync(['bun', TG_CTL, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env } });
}

function processCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  const out = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { stdout: 'pipe', stderr: 'pipe' });
  if (out.exitCode !== 0) return null;
  return out.stdout.toString().split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? null;
}

// A throwaway HOME + config dir with fake creds so the bot-token gate passes.
function fakeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-svc-'));
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-cfg-'));
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');
  return { home, cfg, env: { HOME: home, TG_CTL_CONFIG_DIR: cfg } as Record<string, string> };
}

// A throwaway bin dir holding a shim binary `name` that always exits with `code`. Prepended to
// PATH so the entrypoint's `launchctl`/`systemctl` spawn hits the shim, never the real OS — lets
// us drive both the success (code 0) and command-FAILURE (code != 0) branches without touching
// real autostart.
function exitCodeShimDir(name: string, code: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tgctl-shim-'));
  const shim = join(dir, name);
  writeFileSync(shim, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(shim, 0o755);
  return dir;
}

test('bare `tg-ctl` prints HELP on stdout and exits 0 — never launches', () => {
  const proc = run([], { HOME: '/tmp/tg-ctl-svc-nohome' });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('Usage:');
  expect(out).toContain('tg-ctl enable');
  expect(out).toContain('tg-ctl disable');
  expect(out).toContain('agenttools_service');
  // Help goes to stdout, not stderr (the contract: bare = help, not an error).
  expect(proc.stderr.toString().trim()).toBe('');
});

test('unknown subcommand exits 1 with USAGE on stderr', () => {
  const proc = run(['frobnicate'], { HOME: '/tmp/tg-ctl-svc-nohome' });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('Usage:');
});

test('codex-usage-hook is a quiet no-op when tg credentials are not configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-no-creds-'));
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-no-creds-cfg-'));
  const proc = run(['codex-usage-hook'], { HOME: home, TG_CTL_CONFIG_DIR: cfg });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toBe('');
  expect(proc.stderr.toString()).toBe('');
});

test.if(process.platform === 'darwin')(
  'enable --dry-run: prints the launchd plan (contract label + plist path + launchctl load) without touching launchd',
  () => {
    const { home, env } = fakeEnv();
    const plist = join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist');

    const enabled = run(['enable', '--dry-run'], env);
    expect(enabled.exitCode).toBe(0);
    const out = enabled.stdout.toString();
    expect(out).toContain('[dry-run]');
    expect(out).toContain('autostart kind: launchd');
    expect(out).toContain('com.agenttools.tg-ctl.tg-ctl');
    expect(out).toContain(plist);
    expect(out).toContain('launchctl load');
    // The whole point of --dry-run: nothing is written and no real agent is loaded.
    expect(existsSync(plist)).toBe(false);
  },
);

test.if(process.platform === 'linux')(
  'enable --dry-run on Linux: prints a systemd-user plan (or the none fallback), writes nothing',
  () => {
    const { home, env } = fakeEnv();

    const enabled = run(['enable', '--dry-run'], env);
    expect(enabled.exitCode).toBe(0);
    const out = enabled.stdout.toString();
    expect(out).toContain('[dry-run]');
    // systemd when `systemctl --user` is available, else the no-op fallback (NOT crontab).
    expect(out).toMatch(/autostart kind: (systemd|none)/);
    expect(out).not.toContain('crontab');
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'agenttools-tg-ctl-tg-ctl.service'))).toBe(false);
  },
);

test('status reports an autostart line (the lifecycle state)', () => {
  const { env } = fakeEnv();
  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('autostart:');
});

test('status reports StopFailure hook separately from q→buttons hook', () => {
  const { home, env } = fakeEnv();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(withClaudeHooks({}, 'tg-ctl ask').settings)}\n`);

  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('q→buttons hooks: installed');
  expect(out).toContain('limit/error hooks: NOT installed');
  expect(out).toContain('usage telemetry: NOT installed');
});

test('install-hooks provisions Claude statusLine and Codex Stop usage telemetry collectors', () => {
  const { home, env } = fakeEnv();

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('statusLine usage telemetry');
  expect(out).toContain('Codex Stop usage telemetry collector');

  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  expect(harnessHooksInstalled(settings, 'tg-ctl harness-event')).toBe(true);
  expect(claudeStatusLineTelemetryInstalled(settings, 'tg-ctl harness-event --agent claude')).toBe(true);

  const codexHooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  expect(codexUsageHookInstalled(codexHooks, 'tg-ctl codex-usage-hook')).toBe(true);
});

test('install-hooks and status respect CODEX_HOME for Codex hooks', () => {
  const { home, env } = fakeEnv();
  const codexHome = mkdtempSync(join(tmpdir(), 'tgctl-codex-home-'));
  const codexEnv = { ...env, CODEX_HOME: codexHome };

  const proc = run(['install-hooks'], codexEnv);
  expect(proc.exitCode).toBe(0);

  const codexHooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'));
  expect(codexUsageHookInstalled(codexHooks, 'tg-ctl codex-usage-hook')).toBe(true);
  expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);

  const status = run(['status'], codexEnv);
  expect(status.exitCode).toBe(0);
  expect(status.stdout.toString()).toContain('Codex usage telemetry: installed');
});

test('install-hooks reports malformed Claude settings without clobbering the file', () => {
  const { home, env } = fakeEnv();
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settingsPath, '{ not valid json');

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('is not valid JSON');
  expect(readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');
});

test('install-hooks reports malformed Codex hooks before writing Claude settings', () => {
  const { home, env } = fakeEnv();
  const settingsPath = join(home, '.claude', 'settings.json');
  const codexHooksPath = join(home, '.codex', 'hooks.json');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(codexHooksPath, '{ not valid json');

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('is not valid JSON');
  expect(readFileSync(codexHooksPath, 'utf8')).toBe('{ not valid json');
  expect(existsSync(settingsPath)).toBe(false);
});

test('install-hooks rejects non-object Codex hooks without writing Claude settings', () => {
  const { home, env } = fakeEnv();
  const settingsPath = join(home, '.claude', 'settings.json');
  const codexHooksPath = join(home, '.codex', 'hooks.json');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(codexHooksPath, '[]');

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('is not a JSON object');
  expect(readFileSync(codexHooksPath, 'utf8')).toBe('[]');
  expect(existsSync(settingsPath)).toBe(false);
});

test('status reports when a project-local Claude statusLine shadows the installed telemetry collector', () => {
  const { home, env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`,
  );

  const proc = run(['status'], env, project);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('usage telemetry: shadowed by');
  expect(out).toContain(join(project, '.claude', 'settings.json'));
  expect(out).not.toContain('usage telemetry: installed (Claude Code statusLine)');

  const userSettings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  expect(claudeStatusLineTelemetryInstalled(userSettings, 'tg-ctl harness-event --agent claude')).toBe(true);
});

test('status checks the registered active scope when invoked from another directory', () => {
  const { cfg, env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`,
  );
  writeFileSync(join(cfg, 'tg-ctl.123456.registration.json'), `${JSON.stringify([{ cwd: project, registeredAt: 2 }])}\n`);

  const shimDir = exitCodeShimDir('tmux', 0);
  const otherDir = mkdtempSync(join(tmpdir(), 'tgctl-other-'));
  const proc = run(['status'], { ...env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }, otherDir);

  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('usage telemetry: shadowed by');
  expect(out).toContain(join(project, '.claude', 'settings.json'));
  expect(out).not.toContain('usage telemetry: installed (Claude Code statusLine)');
});

test('install-hooks from a shadowed project wraps that project-local statusLine override', () => {
  const { home, env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  const projectSettingsPath = join(project, '.claude', 'settings.json');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(projectSettingsPath, `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`);

  const proc = run(['install-hooks'], env, project);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain(`installed Claude statusLine usage telemetry → ${realpathSync(projectSettingsPath)}`);

  const projectSettings = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
  expect(claudeStatusLineTelemetryInstalled(projectSettings, 'tg-ctl harness-event --agent claude')).toBe(true);

  const status = run(['status'], env, project);
  expect(status.exitCode).toBe(0);
  const out = status.stdout.toString();
  expect(out).toContain('usage telemetry: installed (Claude Code statusLine)');
  expect(out).not.toContain('usage telemetry: shadowed by');

  const userSettings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  expect(harnessHooksInstalled(userSettings, 'tg-ctl harness-event')).toBe(true);
});

test('status stops at the nearest project collector instead of reporting an ancestor shadow', () => {
  const { env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  const nested = join(project, 'subdir');
  mkdirSync(join(project, '.claude'), { recursive: true });
  mkdirSync(join(nested, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf parent-only' } })}\n`,
  );
  const nestedSettings = withClaudeStatusLineTelemetry(
    { statusLine: { type: 'command', command: 'printf nested-collector' } },
    'tg-ctl harness-event --agent claude',
  ).settings;
  writeFileSync(join(nested, '.claude', 'settings.json'), `${JSON.stringify(nestedSettings)}\n`);

  const proc = run(['status'], env, nested);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('usage telemetry: installed (Claude Code statusLine)');
  expect(out).not.toContain('usage telemetry: shadowed by');
  expect(out).not.toContain(join(project, '.claude', 'settings.json'));
});

// On a host where the OS control command (launchctl/systemctl) fails, `enable` writes the unit
// but the activation fails — the contract is: fall back to a one-shot start so the service is up
// now, and exit 4 (autostart NOT live). We force failure with a shim that always exits 1, with no
// real launchctl/systemctl reachable (PATH = only the shim dir + bun).
test.if(process.platform === 'darwin')(
  'enable: launchd activation failure → writes plist, falls back to a start, exits 4 (the contract)',
  () => {
    const { home, env } = fakeEnv();
    const shimDir = exitCodeShimDir('launchctl', 1); // launchctl load fails → autostart NOT live
    // bun must still be resolvable for the fallback `start` (it re-spawns this script). Keep the
    // real PATH but PREPEND the shim dir so the failing launchctl wins. Point the API at a dead
    // local port so the fallback daemon's getUpdates fails fast and never hits real Telegram.
    const fullEnv = { ...env, TG_API_BASE: 'http://127.0.0.1:1', PATH: `${shimDir}:${process.env.PATH ?? ''}` };
    const proc = run(['enable'], fullEnv);
    expect(proc.exitCode).toBe(4);
    // The plist was written even though activation failed (so a manual launchctl retry works).
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist'))).toBe(true);
    expect(proc.stderr.toString()).toContain('will NOT survive reboot');
    // Reap the fallback daemon the enable spawned (the flock + getUpdates loop), so the test run
    // leaves nothing behind. `cfg` is in `env` (TG_CTL_CONFIG_DIR); botId 123456 from the fake token.
    reapDaemon(env.TG_CTL_CONFIG_DIR, '123456');
  },
);

test.if(process.platform === 'darwin')(
  'disable with no unit installed is a no-op that exits 0 (idempotent removal)',
  () => {
    const { home, env } = fakeEnv();
    // No enable ran, so no plist exists. disable must not error.
    const proc = run(['disable'], env);
    expect(proc.exitCode).toBe(0);
    // Nothing to remove.
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist'))).toBe(false);
  },
);

// Full enable→disable round-trip on macOS with a PASSING launchctl shim: enable writes the plist
// and "loads" it (shim exits 0, no real agent), disable "unloads" it and removes the file. This
// pins the idempotent install/remove contract end-to-end without a real LaunchAgent.
test.if(process.platform === 'darwin')(
  'enable then disable (shimmed launchctl): writes the plist then removes it, both exit 0',
  () => {
    const { home, env } = fakeEnv();
    const shimDir = exitCodeShimDir('launchctl', 0); // exit 0 = "succeeded"
    const path = { PATH: `${shimDir}:${process.env.PATH ?? ''}` };
    const plist = join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist');

    const enabled = run(['enable'], { ...env, ...path });
    expect(enabled.exitCode).toBe(0);
    expect(existsSync(plist)).toBe(true);
    expect(enabled.stdout.toString()).toContain('autostart enabled');

    // Re-enable is idempotent: still exit 0, still one file (no duplicate agent).
    const reEnabled = run(['enable'], { ...env, ...path });
    expect(reEnabled.exitCode).toBe(0);
    expect(existsSync(plist)).toBe(true);

    const disabled = run(['disable'], { ...env, ...path });
    expect(disabled.exitCode).toBe(0);
    expect(existsSync(plist)).toBe(false);

    // Disable again is a no-op (idempotent).
    const reDisabled = run(['disable'], { ...env, ...path });
    expect(reDisabled.exitCode).toBe(0);
  },
);

// disable when the OS deactivate (launchctl unload) FAILS: the contract is to LEAVE the unit file
// in place (don't orphan a still-loaded agent by deleting its plist) and exit 4. We first enable
// with a passing shim to put a plist on disk, then disable with a failing one.
test.if(process.platform === 'darwin')(
  'disable: launchctl unload failure → leaves the plist on disk, exits 4 (no orphaning)',
  () => {
    const { home, env } = fakeEnv();
    const plist = join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist');

    // Put a plist on disk via an enable with a passing launchctl shim.
    const okShim = { PATH: `${exitCodeShimDir('launchctl', 0)}:${process.env.PATH ?? ''}` };
    expect(run(['enable'], { ...env, ...okShim }).exitCode).toBe(0);
    expect(existsSync(plist)).toBe(true);

    // Now disable with a launchctl that fails the unload.
    const failShim = { PATH: `${exitCodeShimDir('launchctl', 1)}:${process.env.PATH ?? ''}` };
    const disabled = run(['disable'], { ...env, ...failShim });
    expect(disabled.exitCode).toBe(4);
    // The plist is LEFT in place (the OS may still be running the agent).
    expect(existsSync(plist)).toBe(true);
    expect(disabled.stderr.toString()).toContain('leaving the unit file in place');
  },
);

// --- restart (#56) ---

// `restart` must be a known subcommand — not rejected by the unknown-command guard.
// Without creds, it exits 1 for auth, NOT because of the "unknown subcommand" check.
// Distinguisher: unknown exits with USAGE on stderr; missing-creds exits with "TG_BOT_TOKEN".
test('restart: known subcommand — rejected for missing creds, not as unknown', () => {
  const proc = run(['restart'], { HOME: '/tmp/tg-ctl-restart-nocreds' });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).not.toContain('Usage:');
  expect(proc.stderr.toString()).toContain('TG_BOT_TOKEN');
});

// `restart` with a running daemon: stops it, starts a new one, exits 0.
// Uses a dead API base so the daemon loops without external calls. The pidfile
// is our observable: it appears after the grandchild acquires the flock.
test('restart: stops any running daemon and starts a fresh one, exits 0', () => {
  const { env, cfg } = fakeEnv();
  const fullEnv = { ...env, TG_API_BASE: 'http://127.0.0.1:1' };
  // start a daemon first so stopDaemon has something to signal
  const started = run(['start'], fullEnv);
  expect(started.exitCode).toBe(0);
  reapDaemon(cfg, '123456'); // wait for the grandchild to write its pidfile
  const oldPid = Number(readFileSync(join(cfg, 'tg-ctl.123456.pid'), 'utf8').trim());
  expect(oldPid).toBeGreaterThan(0);
  // restart: stops the daemon above, then starts a new one
  const restarted = run(['restart'], fullEnv);
  expect(restarted.exitCode).toBe(0);
  // a new daemon should appear (pidfile may be the same or a new pid — the
  // flock serialises them, so at least one daemon must land a pidfile)
  reapDaemon(cfg, '123456');
}, 10_000);

// A signal-0 liveness probe (does the pid exist and are we allowed to signal it).
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Poll the pidfile until it names a LIVE pid (the daemon took the flock + wrote
// its pid AND is running), or the bound elapses. Returns the pid, or 0.
function waitForLivePid(pidFile: string, tries = 120): number {
  for (let i = 0; i < tries; i++) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid > 0 && pidAlive(pid)) return pid;
    }
    Bun.sleepSync(50);
  }
  return 0;
}

test('stop finds a live daemon by the flock holder when its pidfile is missing (#438)', () => {
  const { env, cfg } = fakeEnv();
  const fullEnv = { ...env, TG_API_BASE: 'http://127.0.0.1:1' };
  const pidFile = join(cfg, 'tg-ctl.123456.pid');
  let pid = 0;
  try {
    expect(run(['start'], fullEnv).exitCode).toBe(0);
    pid = waitForLivePid(pidFile);
    expect(pid).toBeGreaterThan(0);
    unlinkSync(pidFile);
    expect(pidAlive(pid)).toBe(true);

    const stopped = run(['stop'], fullEnv);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout.toString()).toContain(`stopped (pid ${pid})`);
    expect(pidAlive(pid)).toBe(false);
  } finally {
    if (pid > 0 && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}, 20_000);

// restart while the old daemon is ALIVE must leave a LIVE successor — the whole
// point of the graceful reload is that a restart never drops the channel. The
// regression this guards (review): the cooperative SIGTERM drain can hold the
// flock briefly; if `restart`'s stopDaemon returned early (its old flat 2s wait,
// unlinking a live pidfile), startLauncher would launch INTO the still-alive old
// daemon, the successor would no-op-exit on the contended flock, and once the old
// finally drained NOTHING would remain running. Unlike the test above, this does
// NOT reap the first daemon before restarting — it stays alive so restart must
// truly wait it out. A dead API base keeps both daemons looping without network.
test('restart while the old daemon is alive leaves a live successor (no dropped channel)', () => {
  const { env, cfg } = fakeEnv();
  const fullEnv = { ...env, TG_API_BASE: 'http://127.0.0.1:1' };
  const pidFile = join(cfg, 'tg-ctl.123456.pid');
  let oldPid = 0;
  let newPid = 0;
  try {
    const started = run(['start'], fullEnv);
    expect(started.exitCode).toBe(0);
    oldPid = waitForLivePid(pidFile);
    expect(oldPid).toBeGreaterThan(0); // genuinely alive, NOT reaped
    // restart while it is alive: stopDaemon must wait for the drain, THEN start.
    const restarted = run(['restart'], fullEnv);
    expect(restarted.exitCode).toBe(0);
    // A live daemon MUST remain — restart never leaves the channel unmanned.
    newPid = waitForLivePid(pidFile);
    expect(newPid).toBeGreaterThan(0);
    expect(pidAlive(newPid)).toBe(true);
  } finally {
    // Reap whatever is (still) running — the successor, and the old pid if it
    // somehow survived — so the test leaves no detached daemon behind.
    for (const pid of new Set([newPid, oldPid])) {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
}, 20_000);

// --- env-pin (#61) ---

// startLauncher passes TG_CTL_CONFIG_DIR: ctx.configDir to the grandchild even
// when process.env does NOT have TG_CTL_CONFIG_DIR. Verified by running `start`
// with only HOME in env (no TG_CTL_CONFIG_DIR); the grandchild must land its
// pidfile in the HOME-derived configDir, proving it received the right configDir.
test('env-pin: grandchild uses ctx.configDir when TG_CTL_CONFIG_DIR absent from env', () => {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-envpin-'));
  const cfgDir = join(home, '.config', 'tg-cli');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');

  // Deliberately omit TG_CTL_CONFIG_DIR — ctx resolves configDir from HOME.
  const envNoConfigDir = {
    HOME: home,
    TG_API_BASE: 'http://127.0.0.1:1',
  };

  const proc = run(['start'], envNoConfigDir as Record<string, string>);
  expect(proc.exitCode).toBe(0);

  // The grandchild must write its pidfile inside cfgDir. If the env pin were
  // absent and the grandchild computed a different configDir, the pidfile would
  // not appear here (reapDaemon times out → test would hang but cleanup kills it).
  reapDaemon(cfgDir, '123456');
});

test('start launches the daemon from a stable cwd, not the caller cwd', async () => {
  const { home, cfg, env } = fakeEnv();
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n');
  const deployedDir = join(home, '.files', 'bin');
  mkdirSync(deployedDir, { recursive: true });
  symlinkSync(TG_CTL, join(deployedDir, 'tg-ctl'));
  const launchDir = mkdtempSync(join(tmpdir(), 'tgctl-launch-cwd-'));
  const shimDir = mkdtempSync(join(tmpdir(), 'tgctl-snapshot-shim-'));
  writeFileSync(
    join(shimDir, 'tmux'),
    "#!/bin/sh\nprintf 's\\t1\\t%%9\\t111\\t2.1.199\\text\\t\\t/project\\n'\n",
    { mode: 0o755 },
  );
  writeFileSync(
    join(shimDir, 'ps'),
    "#!/bin/sh\nprintf ' 111 1 /bin/zsh\\n 222 111 /Users/ultra/.claude/local/claude --resume\\n'\n",
    { mode: 0o755 },
  );

  let releaseUpdates = false;
  let served = false;
  const sent: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMyCommands')) {
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getUpdates')) {
        const deadline = Date.now() + 5000;
        while (!releaseUpdates && Date.now() < deadline) await Bun.sleep(20);
        if (!served) {
          served = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 10,
                  from: { id: 42, first_name: 'Alex' },
                  chat: { id: 42 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/status',
                },
              },
            ],
          });
        }
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as { text?: string };
        sent.push(body.text ?? '');
        return Response.json({ ok: true, result: { message_id: sent.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });

  try {
    const started = run(
      ['start'],
      {
        ...env,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      },
      launchDir,
    );
    expect(started.exitCode).toBe(0);

    const pidFile = join(cfg, 'tg-ctl.123456.pid');
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    const daemonPid = Number(readFileSync(pidFile, 'utf8').trim());

    rmSync(launchDir, { recursive: true, force: true });
    expect(processCwd(daemonPid)).toBe(realpathSync(deployedDir));
    releaseUpdates = true;

    const statusDeadline = Date.now() + 5000;
    while (!sent.some((text) => text.includes('target: claude in s:1 %9 (pid 222)')) && Date.now() < statusDeadline) {
      await Bun.sleep(20);
    }
    expect(sent.join('\n')).toContain('target: claude in s:1 %9 (pid 222)');
  } finally {
    releaseUpdates = true;
    reapDaemon(cfg, '123456');
    server.stop(true);
  }
}, 12_000);
