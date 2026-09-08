import { expect, test } from 'bun:test';
import { checkAttachmentFile, type FileCheckDeps } from '../features/auto-attach/file-check';

// tg-cli#207: a disk-sourced auto-attach candidate must be re-validated right
// before the send (detection and send are two different points in time — the
// file can vanish, get truncated to empty, or lose read permission in
// between). `checkAttachmentFile` is the pure decision function; the real fs
// calls (stat/canRead) are injected so this stays disk-free.
function fakeDeps(overrides: Partial<FileCheckDeps> = {}): FileCheckDeps {
  return {
    stat: () => ({ isFile: () => true, size: 100 }),
    canRead: () => true,
    ...overrides,
  };
}

test('a path whose stat() throws (does not exist) is "missing"', () => {
  const deps = fakeDeps({
    stat: () => {
      throw new Error('ENOENT: no such file or directory');
    },
  });
  expect(checkAttachmentFile('/nope.log', deps)).toBe('missing');
});

test('a directory (isFile() false) is "missing"', () => {
  const deps = fakeDeps({ stat: () => ({ isFile: () => false, size: 4096 }) });
  expect(checkAttachmentFile('/some/dir', deps)).toBe('missing');
});

test('a 0-byte file is "empty"', () => {
  const deps = fakeDeps({ stat: () => ({ isFile: () => true, size: 0 }) });
  expect(checkAttachmentFile('/empty.log', deps)).toBe('empty');
});

test('an existing, non-empty file that fails the read-access check is "unreadable"', () => {
  const deps = fakeDeps({
    stat: () => ({ isFile: () => true, size: 10 }),
    canRead: () => false,
  });
  expect(checkAttachmentFile('/locked.pdf', deps)).toBe('unreadable');
});

test('an existing, non-empty, readable file is "ok"', () => {
  const deps = fakeDeps({ stat: () => ({ isFile: () => true, size: 10 }), canRead: () => true });
  expect(checkAttachmentFile('/good.pdf', deps)).toBe('ok');
});

// --- real-fs integration (mirrors tests/cli-helpers.test.ts's mkdtempSync pattern) ---
// `checkAttachmentFile` stays pure (no fs import in features/auto-attach/
// file-check.ts, per AGENTS.md's pure-feature-module convention) — the real
// statSync/accessSync wiring lives in the `tg` entrypoint. This test builds
// the SAME shape of real-fs deps locally (mirroring what `tg` wires) so the
// checker's behavior against a genuine filesystem is still covered, without
// exporting an impure helper from the feature module.
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function realFsDeps(): FileCheckDeps {
  return {
    stat: (p) => statSync(p),
    canRead: (p) => {
      try {
        accessSync(p, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

test('real fs: nonexistent path → missing, 0-byte file → empty, populated file → ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-file-check-'));
  try {
    const missing = join(dir, 'nope.log');
    const empty = join(dir, 'empty.log');
    const good = join(dir, 'good.log');
    writeFileSync(empty, '');
    writeFileSync(good, 'hello');
    const deps = realFsDeps();
    expect(checkAttachmentFile(missing, deps)).toBe('missing');
    expect(checkAttachmentFile(empty, deps)).toBe('empty');
    expect(checkAttachmentFile(good, deps)).toBe('ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real fs: a directory path (not a file) is "missing"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-file-check-'));
  try {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(checkAttachmentFile(sub, realFsDeps())).toBe('missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real fs: a non-empty file with read permission revoked is "unreadable"', () => {
  // Permission bits don't gate root, and CI/dev boxes sometimes run as root —
  // skip rather than false-fail there (mirrors the repo's own guard style for
  // environment-dependent checks).
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-file-check-'));
  try {
    const locked = join(dir, 'locked.pdf');
    writeFileSync(locked, 'secret bytes');
    chmodSync(locked, 0o000);
    expect(checkAttachmentFile(locked, realFsDeps())).toBe('unreadable');
  } finally {
    chmodSync(join(dir, 'locked.pdf'), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});
