import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { configSchemaText } from '../features/config/schema';
import { configurationDocText, syncConfigArtifact } from '../scripts/generate-config-schema';
import { tempDir } from './helpers/test-temp';

const ROOT = join(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = tempDir('tg-config-artifact-');
  dirs.push(dir);
  return dir;
}

test('the committed schema matches the runtime registry', () => {
  expect(readFileSync(join(ROOT, 'config.schema.json'), 'utf8')).toBe(configSchemaText());
});

test('the committed configuration reference matches the generated help', () => {
  expect(readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8')).toBe(configurationDocText());
});

test('artifact check fails on missing or stale output without changing it', () => {
  const dir = fixture();
  const path = join(dir, 'config.schema.json');
  expect(syncConfigArtifact(path, configSchemaText(), true)).toBe(false);
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, '{"stale":true}\n');
  expect(syncConfigArtifact(path, configSchemaText(), true)).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe('{"stale":true}\n');
});

test('artifact generation converges and does not rewrite current output', () => {
  const dir = fixture();
  const path = join(dir, 'config.schema.json');
  expect(syncConfigArtifact(path, configSchemaText())).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(configSchemaText());
  const before = statSync(path);
  expect(syncConfigArtifact(path, configSchemaText())).toBe(true);
  expect(syncConfigArtifact(path, configSchemaText(), true)).toBe(true);
  const after = statSync(path);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino).toBe(before.ino);
});

test('generator check resolves artifacts from its own checkout rather than cwd', () => {
  const result = Bun.spawnSync([process.execPath, join(ROOT, 'scripts', 'generate-config-schema.ts'), '--check'], {
    cwd: fixture(),
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
});
