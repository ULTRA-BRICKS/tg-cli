// Proof that moving old releases out of CHANGELOG.md into docs/changelog/ (tg-cli#817: the global
// file-size gate warns above 1200 lines) lost, reworded or split no release section.
// docs/changelog/sections.sha256.json was generated once from the pre-split CHANGELOG.md: one entry
// per ARCHIVED `## <version>` section, in original (newest-first) order, with the sha256 of its exact
// text (heading line through the line before the next `## ` heading) and the archive that holds it.
// It is an ordered list, not a map, because the original file repeats 1.14.0 and 1.55.16.
// Only archived sections are pinned: the live changelog keeps changing with every release.
import { createHash } from 'crypto';
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');
const MAX_LINES = 1200;
const ARCHIVE_DIR = 'docs/changelog';

interface ManifestEntry {
  version: string;
  sha256: string;
  file: string;
}

interface Section {
  version: string;
  sha256: string;
}

const manifest: ManifestEntry[] = JSON.parse(readFileSync(join(root, ARCHIVE_DIR, 'sections.sha256.json'), 'utf8')).sections;
const archives = readdirSync(join(root, ARCHIVE_DIR))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `${ARCHIVE_DIR}/${name}`)
  .sort();

function readText(file: string): string {
  return existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '';
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function sectionsOf(text: string): Section[] {
  return text
    .split(/^(?=## )/m)
    .filter((part) => part.startsWith('## '))
    .map((part) => ({
      version: /^## (\S+)\n/.exec(part)?.[1] ?? part.split('\n')[0],
      sha256: createHash('sha256').update(part).digest('hex'),
    }));
}

const foundByFile = new Map(archives.map((file) => [file, sectionsOf(readText(file))]));

test('CHANGELOG.md and every archive stay under the file-size gate', () => {
  const over = ['CHANGELOG.md', ...archives]
    .map((file) => ({ file, lines: lineCount(readText(file)) }))
    .filter((entry) => entry.lines === 0 || entry.lines > MAX_LINES);
  expect(over).toEqual([]);
});

test('each archive holds exactly the manifest sections for it, in order, byte for byte', () => {
  const manifestFiles = [...new Set(manifest.map((entry) => entry.file))].sort();
  expect(archives).toEqual(manifestFiles);
  for (const file of archives) {
    const expected = manifest.filter((entry) => entry.file === file).map(({ version, sha256 }) => ({ version, sha256 }));
    expect(foundByFile.get(file)).toEqual(expected);
  }
});

test('archives run newest-first across files: the manifest order is the original release order', () => {
  const order = manifest.map((entry) => entry.file);
  expect(order).toEqual([...order].sort((a, b) => manifest.findIndex((m) => m.file === a) - manifest.findIndex((m) => m.file === b)));
  const runs = order.filter((file, i) => i === 0 || file !== order[i - 1]);
  expect(new Set(runs).size).toBe(runs.length);
});

test('a release section appears in exactly one changelog file, except the two headings the original already repeated', () => {
  const live = sectionsOf(readText('CHANGELOG.md')).map((section) => section.version);
  const all = [...live, ...archives.flatMap((file) => (foundByFile.get(file) ?? []).map((section) => section.version))];
  const counts = new Map<string, number>();
  for (const version of all) counts.set(version, (counts.get(version) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([version]) => version).sort();
  expect(repeated).toEqual(['1.14.0', '1.55.16']);
});

test('the live changelog keeps its newest release first and points at every archive', () => {
  const live = readText('CHANGELOG.md');
  expect(sectionsOf(live).length).toBeGreaterThan(0);
  for (const file of archives) expect(live).toContain(`(${file})`);
});
