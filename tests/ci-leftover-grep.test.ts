// tests/ci-leftover-grep.test.ts — ci/leftover-grep/leftover-grep.sh never passes having scanned
// nothing (tg-cli#326).
//
// The gate runs under pull_request_target with LEFTOVER_BASE / LEFTOVER_HEAD set by the
// workflow. Before #326 three failure modes all ended in a green check: an explicit base that
// didn't resolve silently fell back to another base, a `git diff` error inside the process
// substitution was swallowed, and a head with no merge-base (a --depth=1 fetch) diffed nothing.
// Each test builds a throwaway git repo and runs the real script.
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { tempDir } from './helpers/test-temp';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, '..', 'ci', 'leftover-grep', 'leftover-grep.sh');

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// A repo with `main` (one clean file) and a checked-out `feature` branch adding `added`.
function repoWithFeature(added: string): string {
  const dir = tempDir('leftover-grep-');
  cleanups.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'app.ts'), `export const a = 1;\n${added}\n`);
  git(dir, 'commit', '-qam', 'feature');
  return dir;
}

function runGate(cwd: string, env: Record<string, string>) {
  const p = Bun.spawnSync(['bash', SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe('leftover-grep.sh fails closed', () => {
  test('a debugger statement added on the branch blocks (baseline)', () => {
    const dir = repoWithFeature('debugger;');
    const r = runGate(dir, { LEFTOVER_BASE: 'main', LEFTOVER_HEAD: 'HEAD' });
    expect(r.out).toContain('debugger');
    expect(r.exitCode).toBe(1);
  });

  test('an explicitly requested base that does not resolve fails instead of falling back', () => {
    const dir = repoWithFeature('export const b = 2;');
    const r = runGate(dir, { LEFTOVER_BASE: 'origin/main', LEFTOVER_HEAD: 'HEAD' });
    expect(r.out).toContain("'origin/main' does not resolve");
    expect(r.exitCode).toBe(1);
  });

  test('a head the diff cannot reach fails instead of passing an empty scan', () => {
    const dir = repoWithFeature('export const b = 2;');
    const r = runGate(dir, { LEFTOVER_BASE: 'main', LEFTOVER_HEAD: '0123456789abcdef0123456789abcdef01234567' });
    expect(r.out).toContain('could not compute the lines to scan');
    expect(r.exitCode).toBe(1);
  });

  test('a head with no merge-base is still scanned (two-dot fallback) and its leftovers block', () => {
    const dir = repoWithFeature('export const b = 2;');
    git(dir, 'checkout', '-q', '--orphan', 'unrelated');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\ndebugger;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'unrelated history');
    const r = runGate(dir, { LEFTOVER_BASE: 'main', LEFTOVER_HEAD: 'HEAD' });
    expect(r.out).toContain('two-dot');
    expect(r.out).toContain('debugger');
    expect(r.exitCode).toBe(1);
  });
});

describe('leftover-grep.sh merge-marker rule', () => {
  test('a decorative ======= separator line is not a merge marker', () => {
    const dir = repoWithFeature('// section\n=======\nexport const b = 2;');
    const r = runGate(dir, { LEFTOVER_BASE: 'main', LEFTOVER_HEAD: 'HEAD' });
    expect(r.out).not.toContain('merge-marker');
    expect(r.exitCode).toBe(0);
  });

  test('a conflict start marker still blocks', () => {
    const dir = repoWithFeature('<<<<<<< HEAD');
    const r = runGate(dir, { LEFTOVER_BASE: 'main', LEFTOVER_HEAD: 'HEAD' });
    expect(r.out).toContain('merge-marker');
    expect(r.exitCode).toBe(1);
  });
});
