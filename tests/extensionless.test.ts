import { expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';

// Explicit --file/--photo are direct instructions and attach any file,
// extension or not. Files named in the message text are never attached
// (tg-cli#648), extensionless or not.

const dir = tempDir('tg-extless-');
writeFileSync(join(dir, 'LICENSE'), 'MIT license text\n');

test('a mentioned extensionless file is not attached, token stays', () => {
  const r = parseArgs(['see LICENSE here'], dir, dir);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items).toEqual([]);
    expect(r.caption).toBe('see LICENSE here');
  }
});

test('explicit --file attaches an extensionless file (direct instruction)', () => {
  const r = parseArgs(['--file', join(dir, 'LICENSE'), 'here'], dir, dir);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items).toEqual([{ type: 'document', path: join(dir, 'LICENSE') }]);
  }
});
