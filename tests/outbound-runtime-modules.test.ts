// Structural guard for the outbound `tg` decomposition (tg-cli#817): the global file-size gate
// (warn above 1200 lines, error above 2400) must pass for the entrypoint and every module
// extracted from it, with real cohesive modules rather than exemptions.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');
const WARN_ABOVE = 1200;

function lineCount(path: string): number {
  const text = readFileSync(path, 'utf8');
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name));
}

const OWNED = [
  'tg',
  ...listFiles('features/cli/outbound-runtime', '.ts'),
  ...listFiles('features/cli', '.ts').filter((p) => p.includes('/args')),
  'CHANGELOG.md',
  ...listFiles('docs/changelog', '.md'),
];

test('the entrypoint, its extracted runtime modules, the argument parser and the changelog files stay under the file-size gate', () => {
  const over = OWNED.map((path) => ({ path, lines: lineCount(join(root, path)) })).filter((f) => f.lines > WARN_ABOVE);
  expect(over).toEqual([]);
});

test('the entrypoint only wires: it hands the parsed process over to the outbound runtime modules', () => {
  const tg = readFileSync(join(root, 'tg'), 'utf8');
  expect(tg).toContain('./features/cli/outbound-runtime/');
  expect(OWNED.filter((p) => p.startsWith('features/cli/outbound-runtime/')).length).toBeGreaterThanOrEqual(8);
});
