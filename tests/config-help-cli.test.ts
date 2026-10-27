import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { renderConfigHelp } from '../features/config/schema';
import { tempDir } from './helpers/test-temp';

const TG = join(import.meta.dir, '..', 'tg');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = tempDir('tg-config-help-');
  dirs.push(home);
  return { home, configDir: join(home, 'custom-config') };
}

function run(args: string[], home: string, configDir?: string) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    NO_COLOR: '1',
    TG_LAYA: '0',
    // Disable Bun's own disk cache so the empty-HOME assertions measure tg.
    // https://bun.com/docs/runtime/environment-variables#disable-the-runtime-transpiler-cache
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    // No credentials are inherited; an accidental send cannot reach Telegram.
    TG_API_BASE: 'http://127.0.0.1:1',
  };
  if (configDir !== undefined) env.TG_CTL_CONFIG_DIR = configDir;
  const result = Bun.spawnSync([process.execPath, TG, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5000,
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

for (const args of [['help', 'config'], ['config', 'help'], ['config', '--help'], ['config', '-h']]) {
  test(`${args.join(' ')} renders static help without credentials or filesystem initialization`, () => {
    const { home, configDir } = fixture();
    const result = run(args, home, configDir);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out.trimEnd()).toBe(renderConfigHelp(configDir).trimEnd());
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(configDir)).toBe(false);
  });
}

test('config help leaves an existing malformed config and custom schema untouched', () => {
  const { home, configDir } = fixture();
  mkdirSync(configDir);
  const yaml = '# user comment\ncontrol: [broken\n';
  const schema = '{"user":"schema"}\n';
  writeFileSync(join(configDir, 'config.yaml'), yaml);
  writeFileSync(join(configDir, 'config.schema.json'), schema);
  const result = run(['help', 'config'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.out.trimEnd()).toBe(renderConfigHelp(configDir).trimEnd());
  expect(readFileSync(join(configDir, 'config.yaml'), 'utf8')).toBe(yaml);
  expect(readFileSync(join(configDir, 'config.schema.json'), 'utf8')).toBe(schema);
  expect(readdirSync(configDir).sort()).toEqual(['config.schema.json', 'config.yaml']);
});

test('config help names the default HOME config path without creating it', () => {
  const { home } = fixture();
  const result = run(['help', 'config'], home);
  expect(result.code).toBe(0);
  expect(result.out).toContain(join(home, '.config', 'tg-cli', 'config.yaml'));
  expect(readdirSync(home)).toEqual([]);
});

test('main help advertises config help', () => {
  const { home } = fixture();
  const result = run(['--help'], home);
  expect(result.code).toBe(0);
  expect(result.out).toContain('tg help config');
  expect(result.out).toContain('tg config --help');
  expect(readdirSync(home)).toEqual([]);
});

test('version output does not initialize the configuration directory', () => {
  const { home, configDir } = fixture();
  const result = run(['--version'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.out).toMatch(/tg.*\d+\.\d+/);
  expect(readdirSync(home)).toEqual([]);
});

test('longer prose beginning with config help keeps the ordinary message path', () => {
  const { home, configDir } = fixture();
  const result = run(['config', 'help', 'is', 'available', '--dry-run'], home, configDir);
  expect(result.code).toBe(0);
  expect(result.out).toContain('tg --dry-run: OK');
  expect(result.out.trimEnd()).not.toBe(renderConfigHelp(configDir).trimEnd());
  expect(readdirSync(home)).toEqual([]);
});
