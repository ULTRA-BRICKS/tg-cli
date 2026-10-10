import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cwdOfPid, jsonlPathsOfPid, pidFilesIo, type PidFilesIo } from '../features/tg-ctl/pid-files';

// tg-cli#481: an omp's session files and cwd come from procfs where it exists, and from a
// bounded lsof only where it does not.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeIo(opts: { proc?: Record<string, string[] | string>; lsof?: string | null }): PidFilesIo & { lsofCalls: string[][] } {
  const lsofCalls: string[][] = [];
  const proc = opts.proc;
  return {
    lsofCalls,
    readdir(dir) {
      const v = proc?.[dir];
      if (!Array.isArray(v)) throw new Error(`ENOENT ${dir}`);
      return v;
    },
    readlink(path) {
      const v = proc?.[path];
      if (typeof v !== 'string') throw new Error(`ENOENT ${path}`);
      return v;
    },
    lsof(args) {
      lsofCalls.push(args);
      return opts.lsof ?? null;
    },
  };
}

test('procfs present: jsonl paths come from /proc/<pid>/fd and lsof is never run', () => {
  const io = fakeIo({
    proc: {
      '/proc/42/fd': ['0', '1', '7', '9'],
      '/proc/42/fd/0': '/dev/pts/3',
      '/proc/42/fd/1': '/dev/pts/3',
      '/proc/42/fd/7': '/home/u/.omp/agent/sessions/x/2026-10-10T00-00-00-000Z_abc.jsonl',
      // fd 9 closed between readdir and readlink → skipped
    },
  });
  expect(jsonlPathsOfPid(42, io)).toEqual(['/home/u/.omp/agent/sessions/x/2026-10-10T00-00-00-000Z_abc.jsonl']);
  expect(io.lsofCalls).toEqual([]);
});

test('no procfs: jsonl paths come from lsof -n -P, and a failed/timed-out lsof is no paths', () => {
  const io = fakeIo({ lsof: 'p42\nn/dev/null\nn/s/a.jsonl\nn/s/b.log\n' });
  expect(jsonlPathsOfPid(42, io)).toEqual(['/s/a.jsonl']);
  expect(io.lsofCalls).toEqual([['-a', '-p', '42', '-Fn', '-n', '-P']]);
  expect(jsonlPathsOfPid(42, fakeIo({ lsof: null }))).toEqual([]);
});

test('cwd: /proc/<pid>/cwd first, bounded lsof -d cwd otherwise', () => {
  const procIo = fakeIo({ proc: { '/proc/42/cwd': '/work/repo' } });
  expect(cwdOfPid(42, procIo)).toBe('/work/repo');
  expect(procIo.lsofCalls).toEqual([]);

  const lsofIo = fakeIo({ lsof: 'p42\nfcwd\nn/work/other\n' });
  expect(cwdOfPid(42, lsofIo)).toBe('/work/other');
  expect(lsofIo.lsofCalls).toEqual([['-a', '-p', '42', '-d', 'cwd', '-Fn', '-n', '-P']]);
  expect(cwdOfPid(42, fakeIo({ lsof: null }))).toBeNull();
});

test('the real lsof io gives up on a hanging lsof within its probe bound, and stops asking when told to', () => {
  const bin = mkdtempSync(join(tmpdir(), 'tg-pid-files-bin-'));
  dirs.push(bin);
  const calls = join(bin, 'lsof.calls');
  writeFileSync(join(bin, 'lsof'), `#!/bin/sh\necho x >> '${calls}'\nexec sleep 30\n`, { mode: 0o755 });
  const io = pidFilesIo({ env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, giveUpAfterTimeout: true });
  const started = Date.now();
  expect(io.lsof(['-a', '-p', '1', '-Fn'])).toBeNull();
  expect(io.lsof(['-a', '-p', '1', '-d', 'cwd', '-Fn'])).toBeNull();
  expect(Date.now() - started).toBeLessThan(4000);
  expect(readFileSync(calls, 'utf8')).toBe('x\n');
}, 10_000);

test('the real lsof io lets a missing lsof binary throw, so the caller can say so', () => {
  const empty = mkdtempSync(join(tmpdir(), 'tg-pid-files-nobin-'));
  dirs.push(empty);
  const io = pidFilesIo({ env: { PATH: empty } });
  expect(() => io.lsof(['-a', '-p', '1', '-Fn'])).toThrow();
});
