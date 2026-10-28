import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fakeRemote, REMOTE_INVALID, REMOTE_OK_CLIENT, REMOTE_OK_HUB } from './helpers/fake-remote';
import { tempDir } from './helpers/test-temp';

// The real `tg` / `tg-ctl` entrypoints against a fake `tg-remote` (TG_REMOTE_BIN): remote-ctl
// guards (spec §3), the golden "no keys, no spawn" rule, and `tg config validate`.

const ROOT = join(import.meta.dir, '..');
const CLIENT_YAML = 'control:\n  server: ssh://tg-ctl-ubuntu\n  machine: clvm\n';
const HUB_YAML = 'control:\n  remote_machines: clvm=ultra@clvm.example.com\n';

function fixture(yaml: string | null, creds = false) {
  const home = tempDir('tg-remote-cli-');
  const configDir = join(home, 'cfg');
  mkdirSync(configDir);
  if (yaml !== null) writeFileSync(join(configDir, 'config.yaml'), yaml);
  if (creds) writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return { home, configDir };
}

function run(entry: 'tg' | 'tg-ctl', args: string[], f: { home: string; configDir: string }, bin?: string, path = process.env.PATH ?? '') {
  const env: Record<string, string> = {
    PATH: path,
    HOME: f.home,
    NO_COLOR: '1',
    TG_LAYA: '0',
    TG_API_BASE: 'http://127.0.0.1:1',
    TG_CTL_CONFIG_DIR: f.configDir,
  };
  if (bin !== undefined) env.TG_REMOTE_BIN = bin;
  const result = Bun.spawnSync([process.execPath, join(ROOT, entry), ...args], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 20_000, killSignal: 'SIGKILL' });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

// --- tg-ctl guards ------------------------------------------------------------------------

test.each(['run', 'start', 'restart', 'enable'])('tg-ctl %s on a ctl client exits 78 and never reaches credentials or a daemon', (cmd) => {
  const remote = fakeRemote({ stdout: REMOTE_OK_CLIENT, exit: 0 });
  const f = fixture(CLIENT_YAML); // no .env: a missed guard would fail differently (exit 1)
  const r = run('tg-ctl', [cmd], f, remote.bin);
  expect(r.code).toBe(78);
  expect(r.err).toContain('tg-ctl: this machine is a ctl client of ssh://tg-ctl-ubuntu; it must not poll Telegram (control.server is set)');
  expect(remote.calls()).toEqual([{ argv: ['config', 'check', '--json'], configDir: f.configDir, isolated: true }]);
  expect(readdirSync(f.configDir).sort()).toEqual(['config.yaml']);
});

test.each(['run', 'start', 'restart', 'enable'])('tg-ctl %s with an invalid remote config prints every diagnostic and exits 78', (cmd) => {
  const remote = fakeRemote({ stdout: REMOTE_INVALID, exit: 78 });
  const r = run('tg-ctl', [cmd], fixture('control:\n  server: ssh://u@h\n'), remote.bin);
  expect(r.code).toBe(78);
  expect(r.err).toContain('tg-ctl: invalid remote config: control.server: must match ^ssh://alias$\n');
  expect(r.err).toContain('tg-ctl: invalid remote config: control.machine: required when control.server is set\n');
});

test('tg-ctl run with a missing checker is invalid (78), not a local daemon', () => {
  const r = run('tg-ctl', ['run'], fixture(CLIENT_YAML), '/nonexistent/tg-remote');
  expect(r.code).toBe(78);
  expect(r.err).toContain('tg-ctl: invalid remote config: tg-remote unavailable:');
});

test('the daemon host (remote_machines) is not refused: tg-ctl run passes the guard and meets the credential gate', () => {
  const remote = fakeRemote({ stdout: REMOTE_OK_HUB, exit: 0 });
  const r = run('tg-ctl', ['run'], fixture(HUB_YAML), remote.bin); // no .env → exit 1, nothing starts
  expect(r.code).toBe(1);
  expect(r.err).toContain('TG_BOT_TOKEN and TG_CHAT_ID must be set');
  expect(remote.calls()).toHaveLength(1);
});

// --- tg send path -------------------------------------------------------------------------

test.each([['--dry-run', 'hello world'], ['hello world']])('tg %j with an invalid remote config exits 78 before dry-run, credentials and network', (...args) => {
  const remote = fakeRemote({ stdout: REMOTE_INVALID, exit: 78 });
  const r = run('tg', args, fixture('control:\n  server: ssh://u@h\n'), remote.bin);
  expect(r.code).toBe(78);
  expect(r.err).toContain('tg: invalid remote config: control.server: must match ^ssh://alias$\n');
  expect(r.err).toContain('tg: invalid remote config: control.machine: required when control.server is set\n');
  expect(r.out).toBe('');
});

test('tg --dry-run with a missing checker is invalid, never local', () => {
  const r = run('tg', ['--dry-run', 'hello world'], fixture(CLIENT_YAML), '/nonexistent/tg-remote');
  expect(r.code).toBe(78);
  expect(r.err).toContain('tg: invalid remote config: tg-remote unavailable:');
});

test.each([['client', CLIENT_YAML, REMOTE_OK_CLIENT], ['hub', HUB_YAML, REMOTE_OK_HUB]])('tg --dry-run in %s mode succeeds after exactly one offline check', (_mode, yaml, stdout) => {
  const remote = fakeRemote({ stdout, exit: 0 });
  const f = fixture(yaml);
  const r = run('tg', ['--dry-run', 'hello world'], f, remote.bin);
  expect(r.code).toBe(0);
  expect(r.out).toContain('tg --dry-run: OK');
  expect(remote.calls()).toEqual([{ argv: ['config', 'check', '--json'], configDir: f.configDir, isolated: true }]);
});

// --- GOLDEN: no keys, nothing changes ------------------------------------------------------

test('with none of the keys, tg --dry-run and tg-ctl status spawn no remote checker and create no remote state', () => {
  // The launcher would answer "client"; if anything ran it, the calls log (or an exit 78) shows it.
  const remote = fakeRemote({ stdout: REMOTE_OK_CLIENT, exit: 0 });
  for (const yaml of [null, 'control:\n  enabled: true\n  topics: false\n']) {
    const f = fixture(yaml, true);
    const dry = run('tg', ['--dry-run', 'hello world'], f, remote.bin);
    expect(dry.code).toBe(0);
    const status = run('tg-ctl', ['status'], f, remote.bin);
    expect(status.code).not.toBe(78);
    expect(status.err).not.toContain('remote');
    expect(existsSync(join(f.configDir, 'remote'))).toBe(false);
    expect(readdirSync(f.configDir).filter((n) => n.includes('remote'))).toEqual([]);
  }
  expect(remote.calls()).toEqual([]);
});

// --- tg config validate ---------------------------------------------------------------------

test('config validate: a valid client and a valid hub config pass', () => {
  for (const [yaml, stdout] of [[CLIENT_YAML, REMOTE_OK_CLIENT], [HUB_YAML, REMOTE_OK_HUB]]) {
    const f = fixture(yaml);
    const remote = fakeRemote({ stdout, exit: 0 });
    const r = run('tg', ['config', 'validate'], f, remote.bin);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(r.out).toContain(': valid');
    expect(remote.calls()).toHaveLength(1);
  }
});

test('config validate: invalid remote keys are errors on their own lines (exit 1) using the same checker', () => {
  const remote = fakeRemote({ stdout: REMOTE_INVALID, exit: 78 });
  const f = fixture('control:\n  enabled: true\n  server: ssh://u@h\n  machine: BAD\n');
  const r = run('tg', ['config', 'validate'], f, remote.bin);
  expect(r.code).toBe(1);
  expect(r.err).toContain('config.yaml:3: error: control.server: must match ^ssh://alias$');
  expect(r.err).toContain('config.yaml:4: error: control.machine: required when control.server is set');
  expect(r.out).toContain('2 errors');
});

test('config validate: python missing is still reported as an error, not a pass', () => {
  const empty = tempDir('tg-empty-path-');
  const f = fixture(CLIENT_YAML);
  const r = run('tg', ['config', 'validate'], f, undefined, empty);
  expect(r.code).toBe(1);
  expect(r.err).toContain('error: tg-remote unavailable:');
});

test('config validate: no remote keys means no checker is run', () => {
  const remote = fakeRemote({ stdout: REMOTE_INVALID, exit: 78 });
  const r = run('tg', ['config', 'validate'], fixture('control:\n  enabled: true\n'), remote.bin);
  expect(r.code).toBe(0);
  expect(remote.calls()).toEqual([]);
});
