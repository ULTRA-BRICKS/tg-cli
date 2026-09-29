// End-to-end coverage for tg-cli#316, driving the REAL `tg-ctl` binary against a throwaway HOME:
//   (a) `install-hooks` migrates the legacy Codex hooks.json Stop entry away once config.toml
//       carries the same hook, and is idempotent afterwards;
//   (b) `status` finds the Codex usage-telemetry hook in config.toml first, hooks.json as a legacy
//       fallback, and names the file;
//   (c) `status` reports a launchd-owned daemon as running instead of trusting the pidfile alone.
//
// rig is forced ABSENT (RIG_AGENT_TOOLS_SOURCE points nowhere) so no real rig is ever invoked, and
// launchd is driven through a `launchctl` SHIM on PATH — this suite never spawns real launchctl and
// never loads, bootstraps or stops anything.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const CMD = 'tg-ctl codex-usage-hook';
const NOWHERE = join(tmpdir(), 'tgctl-316-no-agent-tools');

// The file Alex had to delete by hand on the live machine — kept verbatim as the migration fixture
// (~/.codex/hooks.json.pre-308-migration.bak).
const LEGACY_HOOKS_JSON = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD, timeout: 30 }] }] } }, null, 2)}\n`;

// The Stop line rig actually writes: an absolute `bun <path>/tg-ctl codex-usage-hook` invocation
// sharing the array with agent-tools' own bridge hook.
function rigConfigToml(): string {
  return [
    '# >>> rig managed: codex hook bridge',
    '[hooks]',
    'Stop = [{hooks = [{type = "command", command = "PYTHONPATH=/x/lib python3 -m codex_hook_bridge Stop"}]}, ' +
      `{hooks = [{type = "command", command = "/opt/bun/bin/bun /opt/files/bin/${CMD}"}]}]`,
    '',
  ].join('\n');
}

function fakeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-316-home-'));
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-316-cfg-'));
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');
  const codex = join(home, '.codex');
  mkdirSync(codex, { recursive: true });
  return { home, cfg, codex, env: { HOME: home, TG_CTL_CONFIG_DIR: cfg, RIG_AGENT_TOOLS_SOURCE: NOWHERE } as Record<string, string> };
}

function run(args: string[], env: Record<string, string>) {
  return Bun.spawnSync(['bun', TG_CTL, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
}

// --- (a) migration -------------------------------------------------------------------------------

test('install-hooks migrates the legacy hooks.json entry away when config.toml carries the hook, then is idempotent', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);

  const first = run(['install-hooks'], env);
  expect(first.exitCode).toBe(0);
  const out = first.stdout.toString();
  expect(out).toContain('already provisioned in the Codex config.toml');
  expect(out).toContain('skipping the direct hooks.json write');
  expect(out).toContain('it held nothing else, so the file was removed');

  // The dual hook source is gone and the pre-migration content is recoverable.
  expect(existsSync(join(codex, 'hooks.json'))).toBe(false);
  expect(readFileSync(join(codex, 'hooks.json.pre-migration.bak'), 'utf8')).toBe(LEGACY_HOOKS_JSON);

  // Idempotent: a second run has nothing to migrate and does NOT recreate hooks.json.
  const second = run(['install-hooks'], env);
  expect(second.exitCode).toBe(0);
  expect(second.stdout.toString()).toContain('nothing to migrate');
  expect(existsSync(join(codex, 'hooks.json'))).toBe(false);
  expect(readFileSync(join(codex, 'hooks.json.pre-migration.bak'), 'utf8')).toBe(LEGACY_HOOKS_JSON);
});

test('install-hooks keeps a hooks.json that still holds someone else’s hook, removing only our entry', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(
    join(codex, 'hooks.json'),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } })}\n`,
  );

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('its other hooks were kept');

  const kept = JSON.parse(readFileSync(join(codex, 'hooks.json'), 'utf8'));
  expect(kept).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } });
  expect(existsSync(join(codex, 'hooks.json.pre-migration.bak'))).toBe(true);
});

test('install-hooks leaves hooks.json alone when config.toml does NOT carry the hook (telemetry is never lost)', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), '[hooks]\nPreToolUse = []\n');

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('installed Codex Stop usage telemetry collector');
  expect(existsSync(join(codex, 'hooks.json'))).toBe(true);
  expect(existsSync(join(codex, 'hooks.json.pre-migration.bak'))).toBe(false);
});

// --- (b) status detection ------------------------------------------------------------------------

test('status finds the telemetry hook in config.toml and names that file', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('Codex usage telemetry: installed');
  expect(out).toContain(join(codex, 'config.toml'));
});

test('status falls back to the legacy hooks.json and says so', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);
  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('Codex usage telemetry: installed');
  expect(out).toContain(`legacy ${join(codex, 'hooks.json')}`);
});

test('status reports NOT installed when neither file carries the hook', () => {
  const { env } = fakeEnv();
  expect(run(['status'], env).stdout.toString()).toContain('Codex usage telemetry: NOT installed');
});

// --- (c) launchd-owned daemon --------------------------------------------------------------------

// A `launchctl` shim answering `list` with one job and `print` with a dump shaped like the real one.
// `jobConfigDir` pins the config dir the fake job serves, so a job serving a DIFFERENT dir can be
// exercised too. No real launchctl is ever reached.
function launchctlShimDir(binPath: string, jobConfigDir: string | null, pid: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tgctl-316-shim-'));
  const envLines = jobConfigDir === null ? '' : `\t\tTG_CTL_CONFIG_DIR => ${jobConfigDir}\\n`;
  const dump = [
    'gui/501/ai.hyperide.tg-ctl = {',
    '\\tstate = running',
    '\\targuments = {',
    '\\t\\t/opt/bun/bin/bun',
    `\\t\\t${binPath}`,
    '\\t\\trun',
    '\\t}',
    '\\tenvironment = {',
    `${envLines}\\t}`,
    '\\tproperties = keepalive | runatload',
    `\\tpid = ${pid}`,
    '}',
  ].join('\\n');
  const shim = join(dir, 'launchctl');
  writeFileSync(
    shim,
    ['#!/bin/sh', 'case "$1" in', `  list) printf 'PID\\tStatus\\tLabel\\n${pid}\\t0\\tai.hyperide.tg-ctl\\n' ;;`, `  print) printf '${dump}\\n' ;;`, 'esac', 'exit 0', ''].join('\n'),
  );
  chmodSync(shim, 0o755);
  return dir;
}

// The binary path `status` resolves for the fake HOME (resolveDeployedBin): the deployed symlink
// when it exists, so seed it and match the launchd job's argv against it.
function seedDeployedBin(home: string): string {
  const binDir = join(home, '.files', 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, 'tg-ctl');
  writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
  return binPath;
}

test.if(process.platform === 'darwin')('status reports a launchd-owned daemon as running even with NO pidfile', () => {
  const { home, cfg, env } = fakeEnv();
  const shimDir = launchctlShimDir(seedDeployedBin(home), cfg, 4242);
  const proc = run(['status'], { ...env, PATH: `${shimDir}:${process.env.PATH ?? ''}` });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('running (launchd, pid 4242)');
  expect(out).toContain('job ai.hyperide.tg-ctl');
});

test.if(process.platform === 'darwin')('status reports a launchd-owned daemon as running and flags the stale pidfile', () => {
  const { home, cfg, env } = fakeEnv();
  // A pid that cannot be alive — the pidfile is stale, the launchd instance is not.
  writeFileSync(join(cfg, 'tg-ctl.123456.pid'), '999999\n');
  const shimDir = launchctlShimDir(seedDeployedBin(home), cfg, 4242);
  const out = run(['status'], { ...env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }).stdout.toString();
  expect(out).toContain('running (launchd, pid 4242)');
  expect(out).toContain('stale pidfile pid 999999');
});

test.if(process.platform === 'darwin')('a launchd job serving ANOTHER config dir is not claimed as this bot’s daemon', () => {
  const { home, env } = fakeEnv();
  const shimDir = launchctlShimDir(seedDeployedBin(home), '/some/other/tg-cli', 4242);
  const out = run(['status'], { ...env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }).stdout.toString();
  expect(out).toContain('tg-ctl: not running');
  expect(out).not.toContain('running (launchd');
});

test.if(process.platform === 'darwin')('a hand-started daemon is reported as running (manual, pid N)', () => {
  const { home, cfg, env } = fakeEnv();
  // Our own test process is certainly alive — a stand-in for a `tg-ctl start` daemon.
  writeFileSync(join(cfg, 'tg-ctl.123456.pid'), `${process.pid}\n`);
  const shimDir = launchctlShimDir(seedDeployedBin(home), '/some/other/tg-cli', 4242);
  const out = run(['status'], { ...env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }).stdout.toString();
  expect(out).toContain(`running (manual, pid ${process.pid})`);
});
