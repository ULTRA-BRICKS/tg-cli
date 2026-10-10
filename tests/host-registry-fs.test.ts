import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import { readHostRecordFile, readHostRecords } from '../features/tg-ctl/host-registry-fs';
import { tempDir } from './helpers/test-temp';

const UID = process.getuid?.() ?? -1;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function hostsDir(): string {
  const dir = tempDir('tg-hosts-');
  dirs.push(dir);
  return dir;
}

const record = (name: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, name, harness: 'claude', label: 'tg-cli', cwd: '/w/tg-cli', socket: `/s/${name}@h`, serverPid: 100, role: 'coordinator', ...over });

test('a missing hosts dir is simply no hosts', () => {
  expect(readHostRecords(join(hostsDir(), 'absent'), UID)).toEqual({ records: [], rejected: [] });
});

test('valid records are returned, bad ones are named with the reason, non-json files (the wrapper\u2019s temp files) are ignored', () => {
  const dir = hostsDir();
  writeFileSync(join(dir, 'claude-3f9a0c1d2e4b.json'), record('claude-3f9a0c1d2e4b'));
  writeFileSync(join(dir, 'claude-aaaaaaaaaaaa.json'), record('claude-bbbbbbbbbbbb'));
  writeFileSync(join(dir, 'claude-cccccccccccc.json'), '{not json');
  writeFileSync(join(dir, 'claude-dddddddddddd.json.tmp'), record('claude-dddddddddddd'));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const { records, rejected } = readHostRecords(dir, UID);
  expect(records.map((r) => r.name)).toEqual(['claude-3f9a0c1d2e4b']);
  expect(rejected.map((r) => r.file).sort()).toEqual(['claude-aaaaaaaaaaaa.json', 'claude-cccccccccccc.json']);
  expect(rejected.find((r) => r.file === 'claude-cccccccccccc.json')?.reason).toBe('not JSON');
});

test('a symlink — even to a valid record — is rejected', () => {
  const dir = hostsDir();
  const outside = hostsDir();
  writeFileSync(join(outside, 'real.json'), record('claude-3f9a0c1d2e4b'));
  symlinkSync(join(outside, 'real.json'), join(dir, 'claude-3f9a0c1d2e4b.json'));
  const { records, rejected } = readHostRecords(dir, UID);
  expect(records).toEqual([]);
  expect(rejected).toEqual([{ file: 'claude-3f9a0c1d2e4b.json', reason: 'not a regular file' }]);
});

test('a record owned by another uid is rejected', () => {
  const dir = hostsDir();
  writeFileSync(join(dir, 'claude-3f9a0c1d2e4b.json'), record('claude-3f9a0c1d2e4b'));
  expect(readHostRecords(dir, UID + 1).rejected[0].reason).toMatch(/owned by uid/);
});

test('a directory named like a record is not one', () => {
  const dir = hostsDir();
  mkdirSync(join(dir, 'claude-3f9a0c1d2e4b.json'));
  expect(readHostRecords(dir, UID).rejected[0].reason).toBe('not a regular file');
});

test('a FIFO named like a record is rejected without hanging the read', () => {
  const dir = hostsDir();
  expect(Bun.spawnSync(['mkfifo', join(dir, 'claude-3f9a0c1d2e4b.json')]).exitCode).toBe(0);
  expect(readHostRecords(dir, UID).rejected).toEqual([{ file: 'claude-3f9a0c1d2e4b.json', reason: 'not a regular file' }]);
});

test('a unix socket named like a record is rejected, not skipped as vanished', async () => {
  // a socket path holds ~104 bytes on Darwin: tmpdir() (/var/folders/...) is too long for it
  const dir = tempDir('tgh-', { short: true });
  dirs.push(dir);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(join(dir, 'claude-3f9a0c1d2e4b.json'), resolve));
  try {
    expect(readHostRecords(dir, UID).rejected).toEqual([{ file: 'claude-3f9a0c1d2e4b.json', reason: 'not a regular file' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a record that vanished between listing and reading is not an error', () => {
  expect(readHostRecordFile(hostsDir(), 'claude-3f9a0c1d2e4b.json', UID)).toBeNull();
});
