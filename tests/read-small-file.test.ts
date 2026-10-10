import { test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readSmallFile } from '../features/transport/telegram';
import { tempDir } from './helpers/test-temp';

// readSmallFile replaced a statSync()+readFileSync() pair (js/file-system-race)
// with a single-fd open→fstat→read. These pin its contract: the BOM-prepend
// path in blobFor depends on getting back the FULL bytes for an in-range file
// and null otherwise (so it falls through to a streamed Bun.file).

let dir: string;

beforeEach(() => {
  dir = tempDir('tg-readsmall-');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('returns the full bytes for a file within the size cap', () => {
  const p = join(dir, 'a.txt');
  const content = 'привет mir'; // multi-byte UTF-8
  writeFileSync(p, content);
  const bytes = readSmallFile(p, 1024);
  expect(bytes).not.toBeNull();
  expect(new TextDecoder().decode(bytes!)).toBe(content);
});

test('returns null for an empty file (nothing to BOM)', () => {
  const p = join(dir, 'empty.txt');
  writeFileSync(p, '');
  expect(readSmallFile(p, 1024)).toBeNull();
});

test('returns null when the file exceeds the cap (caller should stream it)', () => {
  const p = join(dir, 'big.bin');
  writeFileSync(p, Buffer.alloc(2048, 0x41));
  expect(readSmallFile(p, 1024)).toBeNull();
});

test('returns exactly maxBytes-sized file (boundary)', () => {
  const p = join(dir, 'exact.bin');
  writeFileSync(p, Buffer.alloc(16, 0x42));
  const bytes = readSmallFile(p, 16);
  expect(bytes).not.toBeNull();
  expect(bytes!.length).toBe(16);
});

test('returns null for a missing/unreadable path (no throw)', () => {
  expect(readSmallFile(join(dir, 'does-not-exist'), 1024)).toBeNull();
});
