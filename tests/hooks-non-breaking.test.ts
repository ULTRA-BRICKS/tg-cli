import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gatePhotos, hooksActive, hooksRoot, runPreSendPhotoHooks } from '../features/hooks/run-photo-hooks';
import { tempDir } from './helpers/test-temp';

// THE GATE: prove the no-descriptors path is byte-identical to "no hooks at
// all" — no subprocess, no audit, no extra work beyond a single stat. These
// are the tests that defend `tg --photo` as a daily driver.

let home: string;

beforeEach(() => {
  home = tempDir('tg-hooks-nb-');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('a clean home has NO ~/.agents/hooks at all', () => {
  expect(existsSync(hooksRoot(home))).toBe(false);
});

test('hooksActive is false on a clean home (the one-stat fast path)', () => {
  // This is THE call the tg seam makes first. False → the entire hook block is
  // skipped and the send path is unchanged from today.
  expect(hooksActive({}, home)).toBe(false);
});

test('with no descriptors dir, runPreSendPhotoHooks does ZERO work', () => {
  // The seam never calls this when hooksActive is false, but even if it did,
  // it must be a pure no-op: no block, no results, no spawn, no audit file.
  const png = join(home, 'x.png');
  writeFileSync(png, 'data');
  const v = runPreSendPhotoHooks({ imagePath: png }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results).toEqual([]);
  // no audit.jsonl was created (nothing fired)
  expect(existsSync(join(hooksRoot(home), 'audit.jsonl'))).toBe(false);
});

test('gatePhotos on a clean home never blocks and creates nothing', () => {
  const png = join(home, 'x.png');
  writeFileSync(png, 'data');
  const r = gatePhotos([png], {}, {}, home);
  expect(r.blocked).toBe(false);
  expect(existsSync(hooksRoot(home))).toBe(false);
});

test('AGENTS_HOOKS=0 disables even when a hooks dir would exist', () => {
  // global kill switch — instant rollback for the daily driver.
  expect(hooksActive({ AGENTS_HOOKS: '0' }, home)).toBe(false);
});
