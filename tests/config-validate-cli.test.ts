import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_VALIDATE_USAGE } from '../features/config/validate';
import { tempDir } from './helpers/test-temp';

const TG = join(import.meta.dir, '..', 'tg');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(config?: string) {
  const home = tempDir('tg-config-validate-');
  dirs.push(home);
  const configDir = join(home, 'cfg');
  if (config !== undefined) {
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), config);
  }
  return { home, configDir };
}

function run(args: string[], home: string, configDir: string) {
  const result = Bun.spawnSync([process.execPath, TG, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      NO_COLOR: '1',
      TG_LAYA: '0',
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      TG_API_BASE: 'http://127.0.0.1:1',
      TG_CTL_CONFIG_DIR: configDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5000,
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const snapshot = (dir: string) =>
  readdirSync(dir).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return [name, readFileSync(join(dir, name), 'utf8'), stat.mtimeMs, stat.mode];
  });

const USER_SHAPE = 'control:\n  private_topics: true\n  enabled: false\nvoice:\n  enabled: true\n  runner: faster-whisper\n  language: auto\n';

test('validates the current user configuration without writing anything', () => {
  const { home, configDir } = fixture(USER_SHAPE);
  const before = snapshot(configDir);
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.out).toBe(`${join(configDir, 'config.yaml')}: valid\n`);
  expect(result.err).toBe('');
  // No modeline, schema file, lock or credential read: the directory is byte-identical.
  expect(snapshot(configDir)).toEqual(before);
  expect(readdirSync(home)).toEqual(['cfg']);
});

test('a missing config is valid: defaults apply and nothing is created', () => {
  const { home, configDir } = fixture();
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.out).toContain('defaults apply');
  expect(readdirSync(home)).toEqual([]);
});

test('invalid settings exit 1 with file:line diagnostics on stderr', () => {
  const yaml = 'control:\n  enabled: maybe\n  nope: 1\nvoice:\n  threads: 0\n';
  const { home, configDir } = fixture(yaml);
  const path = join(configDir, 'config.yaml');
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(1);
  expect(result.err).toBe(
    `${path}:2: error: control.enabled must be true or false (got "maybe")\n` +
    `${path}:3: error: control.nope is not a known setting\n` +
    `${path}:5: error: voice.threads must be at least 1 (got 0)\n`,
  );
  expect(result.out).toBe(`${path}: 3 errors\n`);
  expect(readFileSync(path, 'utf8')).toBe(yaml);
});

test('a valid laya block passes and an invalid one is reported by the Python caller with its line', () => {
  const good = fixture('control:\n  enabled: true\nlaya:\n  autostart: false\n  warm_timeout_ms: 2000\n  task_bin: /usr/bin/task\n');
  const ok = run(['config', 'validate'], good.home, good.configDir);
  expect(ok.code).toBe(0);
  expect(ok.out).toBe(`${join(good.configDir, 'config.yaml')}: valid\n`);

  const yaml = 'laya:\n  enabled: false\n  required: true\n  warm_timeout_ms: soon\n  bogus: 1\n  task_bin: task\n';
  const bad = fixture(yaml);
  const path = join(bad.configDir, 'config.yaml');
  const result = run(['config', 'validate'], bad.home, bad.configDir);
  expect(result.code).toBe(1);
  expect(result.err).toContain(`${path}:3: error: laya.required: true conflicts with laya.enabled: false`);
  expect(result.err).toContain(`${path}:4: error: laya.warm_timeout_ms must be a positive integer (got 'soon')`);
  expect(result.err).toContain(`${path}:5: error: laya.bogus is not a known setting`);
  expect(result.err).toContain(`${path}:6: error: laya.task_bin must be an absolute path (got 'task')`);
  expect(readFileSync(path, 'utf8')).toBe(yaml);
});

test('laya.socket must be an absolute path without .. and a valid one passes', () => {
  const good = fixture('laya:\n  socket: /home/u/.local/state/tg-cli/laya-ubuntu.sock\n');
  expect(run(['config', 'validate'], good.home, good.configDir).code).toBe(0);
  const bad = fixture('laya:\n  socket: laya.sock\n');
  const relative = run(['config', 'validate'], bad.home, bad.configDir);
  expect(relative.code).toBe(1);
  expect(relative.err).toContain(`${join(bad.configDir, 'config.yaml')}:2: error: laya.socket must be an absolute path (got 'laya.sock')`);
  const dotdot = fixture('laya:\n  socket: /a/../b.sock\n');
  expect(run(['config', 'validate'], dotdot.home, dotdot.configDir).err).toContain('laya.socket must not contain ..');
});

test('an inline laya value is reported once, by the structural check', () => {
  const { home, configDir } = fixture('laya: true\n');
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(1);
  expect(result.err.match(/:1: error:/g)).toHaveLength(1);
});

test('legacy forms warn but still exit 0', () => {
  const { home, configDir } = fixture('control:\n  topics: yes\n');
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.err).toContain(':2: warning: control.topics: "yes" is accepted by the runtime');
  expect(result.out).toBe(`${join(configDir, 'config.yaml')}: valid (1 warning)\n`);
});

test('malformed and non-mapping files fail', () => {
  for (const yaml of ['- a\n- b\n', 'control: [broken\n', 'control:\n  enabled false\n']) {
    const { home, configDir } = fixture(yaml);
    const result = run(['config', 'validate'], home, configDir);
    expect(result.code).toBe(1);
    expect(result.err).toContain(': error: ');
  }
});

test('an unreadable config path fails instead of passing as missing', () => {
  const { home, configDir } = fixture();
  mkdirSync(join(configDir, 'config.yaml'), { recursive: true });
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(1);
  expect(result.err).toContain('cannot read');
});

test('a config the runtime could not read is not reported as valid', () => {
  const { home, configDir } = fixture('control:\n  enabled: false\n');
  chmodSync(join(configDir, 'config.yaml'), 0o000);
  const result = run(['config', 'validate'], home, configDir);
  chmodSync(join(configDir, 'config.yaml'), 0o600);
  // root bypasses file modes; there the file is simply readable and valid.
  expect(result.code).toBe(process.getuid?.() === 0 ? 0 : 1);
});

for (const flag of ['help', '--help', '-h']) {
  test(`config validate ${flag} prints usage without reading the config`, () => {
    const { home, configDir } = fixture('control: [broken\n');
    const before = snapshot(configDir);
    const result = run(['config', 'validate', flag], home, configDir);
    expect(result.code).toBe(0);
    expect(result.out).toBe(CONFIG_VALIDATE_USAGE);
    expect(result.err).toBe('');
    expect(snapshot(configDir)).toEqual(before);
  });
}

test('prose beginning with config validate stays an ordinary message', () => {
  const { home, configDir } = fixture('control:\n  enabled: maybe\n');
  const result = run(['config', 'validate', 'my', 'file', '--dry-run'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.out).toContain('tg --dry-run: OK');
  expect(result.err).not.toContain('control.enabled');
});

test('config help documents validate and main help advertises it', () => {
  const { home, configDir } = fixture();
  expect(run(['help', 'config'], home, configDir).out).toContain('tg config validate');
  expect(run(['--help'], home, configDir).out).toContain('tg config validate');
});

test('a dangling config symlink is an error, not a missing file', () => {
  const { home, configDir } = fixture();
  mkdirSync(configDir);
  symlinkSync(join(home, 'gone.yaml'), join(configDir, 'config.yaml'));
  const result = run(['config', 'validate'], home, configDir);
  expect(result.code).toBe(1);
  expect(result.err).toContain('dangling symlink');
});
