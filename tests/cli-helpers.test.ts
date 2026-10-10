import { afterAll, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expandHome, hasRealExtension, isImagePath } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';
import {
  VERSION,
  latestChangelogSection,
  resolveVersion,
  versionOutput,
} from '../features/cli/version';

// Focused unit tests for the pure CLI helpers extracted from the `tg`
// entrypoint (decomposition Stages 0c/0d). parseArgs itself is covered
// end-to-end by denylist/extensionless/recursive/worktree/ergonomics; here we
// pin the small path + version helpers that gained direct exports.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = tempDir('tg-cli-helpers-');
  dirs.push(d);
  return d;
}

// --- isImagePath ---
test('isImagePath accepts Telegram photo extensions, case-insensitively', () => {
  expect(isImagePath('shot.png')).toBe(true);
  expect(isImagePath('a.JPG')).toBe(true);
  expect(isImagePath('photo.jpeg')).toBe(true);
  expect(isImagePath('anim.gif')).toBe(true);
});

test('isImagePath rejects SVG (Telegram rejects it as a photo) and non-images', () => {
  expect(isImagePath('vector.svg')).toBe(false);
  expect(isImagePath('notes.txt')).toBe(false);
  expect(isImagePath('Makefile')).toBe(false);
  expect(isImagePath('noext')).toBe(false);
});

// --- hasRealExtension ---
test('hasRealExtension is true only for a basename dot with chars after it', () => {
  expect(hasRealExtension('a.ts')).toBe(true);
  expect(hasRealExtension('dir/sub/a.js')).toBe(true);
  expect(hasRealExtension('archive.tar.gz')).toBe(true);
});

test('hasRealExtension is false for extensionless names and leading-dot files', () => {
  expect(hasRealExtension('LICENSE')).toBe(false);
  expect(hasRealExtension('Makefile')).toBe(false);
  expect(hasRealExtension('.env')).toBe(false);
  expect(hasRealExtension('dir/.gitignore')).toBe(false);
});

// --- expandHome ---
test('expandHome expands ~ and ~/path, leaves absolute and relative tokens alone', () => {
  expect(expandHome('~', '/home/alex')).toBe('/home/alex');
  expect(expandHome('~/docs/a.txt', '/home/alex')).toBe('/home/alex/docs/a.txt');
  expect(expandHome('/abs/path', '/home/alex')).toBe('/abs/path');
  expect(expandHome('rel/path', '/home/alex')).toBe('rel/path');
  // a bare "~name" is NOT expanded (only "~" and "~/")
  expect(expandHome('~other', '/home/alex')).toBe('~other');
});

// --- latestChangelogSection ---
test('latestChangelogSection returns only the top-most ## section, trimmed', () => {
  const d = tmp();
  writeFileSync(
    join(d, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.6.0\n\n- feat A\n- feat B\n\n## 1.5.0\n\n- old stuff\n',
  );
  expect(latestChangelogSection(d)).toBe('## 1.6.0\n\n- feat A\n- feat B');
});

test('latestChangelogSection degrades to "" with no changelog / no version heading', () => {
  expect(latestChangelogSection(tmp())).toBe('');
  const d = tmp();
  writeFileSync(join(d, 'CHANGELOG.md'), '# Changelog\n\nno version sections here\n');
  expect(latestChangelogSection(d)).toBe('');
});

// --- resolveVersion ---
test('resolveVersion reads the version field from package.json in scriptDir', () => {
  const d = tmp();
  writeFileSync(join(d, 'package.json'), '{"name":"x","version":"2.3.4"}');
  expect(resolveVersion(d)).toBe('2.3.4');
});

test('resolveVersion degrades to "unknown" with no/malformed package.json', () => {
  expect(resolveVersion(tmp())).toBe('unknown');
  const d = tmp();
  writeFileSync(join(d, 'package.json'), '{ not json');
  expect(resolveVersion(d)).toBe('unknown');
  const e = tmp();
  writeFileSync(join(e, 'package.json'), '{"name":"x"}'); // no version field
  expect(resolveVersion(e)).toBe('unknown');
});

// --- versionOutput ---
test('versionOutput composes the version+hash head and appends the changelog', () => {
  const d = tmp();
  writeFileSync(join(d, 'package.json'), '{"version":"6.6.6"}');
  writeFileSync(join(d, 'CHANGELOG.md'), '## 1.6.0\n\n- the latest\n');
  const out = versionOutput(d);
  // a non-git temp dir resolves the hash to "unknown" (never throws);
  // the version comes from the temp dir's package.json, not the literal.
  expect(out.startsWith('tg 6.6.6 (')).toBe(true);
  expect(out).toContain('## 1.6.0');
  expect(out).toContain('- the latest');
});

test('versionOutput without a changelog is just the head line', () => {
  const d = tmp();
  writeFileSync(join(d, 'package.json'), '{"version":"6.6.6"}');
  expect(versionOutput(d)).toBe('tg 6.6.6 (unknown)');
});

// --- drift guard: package.json is the SINGLE SOURCE OF TRUTH (tg-cli#80) ---
// Pins the numeric part of the real `tg --version` to package.json's `version`
// so a future hardcoded literal (or a missed package.json bump) can never let
// the two diverge again. Also asserts the runtime git-hash suffix still appends.
test('tg --version numeric part equals package.json version (no drift)', () => {
  const repoRoot = join(import.meta.dir, '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  // the exported VERSION must equal package.json (single source)
  expect(VERSION).toBe(pkg.version);
  // and the rendered --version head must carry exactly that version + a hash suffix
  const head = versionOutput(repoRoot).split('\n')[0];
  const m = head.match(/^tg (\S+) \((\S+)\)$/);
  expect(m).not.toBeNull();
  expect(m![1]).toBe(pkg.version); // numeric/version part == package.json
  expect(m![2].length).toBeGreaterThan(0); // git-hash suffix still appends
});
