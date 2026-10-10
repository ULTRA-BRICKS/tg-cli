import { expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';

// Auto-attach must skip files WITHOUT a real extension (LICENSE, Makefile,
// binaries like `tg`, dotfiles like `.env`): they are usually code-adjacent
// artifacts the reader can't preview, and dotfiles tend to hold secrets.
// Explicit --file/--photo are direct instructions and always attach.

const dir = tempDir('tg-extless-');
writeFileSync(join(dir, 'LICENSE'), 'MIT license text\n');
writeFileSync(join(dir, '.env'), 'SECRET=1\n');
writeFileSync(join(dir, 'Makefile'), 'all:\n\techo ok\n');
writeFileSync(join(dir, 'normal.ts'), 'export const x = 1\n');

test('auto: extensionless file mentioned in text is NOT attached, token stays', () => {
  const r = parseArgs(['see LICENSE here'], dir, dir);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items).toEqual([]);
    expect(r.caption).toBe('see LICENSE here');
  }
});

test('auto: dotfile without extension is NOT attached', () => {
  const r = parseArgs(['check .env please'], dir, dir);
  if (r.action === 'send') expect(r.items).toEqual([]);
});

test('auto: file with a real extension still attaches (regression)', () => {
  const r = parseArgs(['see normal.ts'], dir, dir);
  if (r.action === 'send') {
    expect(r.items.length).toBe(1);
    expect(r.items[0].path.endsWith('normal.ts')).toBe(true);
  }
});

test('auto: line-spec on an extensionless file does not attach it', () => {
  const r = parseArgs(['broken at Makefile:2'], dir, dir);
  if (r.action === 'send') {
    expect(r.items).toEqual([]);
    expect(r.caption).toBe('broken at Makefile:2');
  }
});

test('explicit --file attaches an extensionless file (direct instruction)', () => {
  const r = parseArgs(['--file', join(dir, 'LICENSE'), 'here'], dir, dir);
  if (r.action === 'send') {
    expect(r.items.length).toBe(1);
    expect(r.items[0].type).toBe('document');
  }
});
