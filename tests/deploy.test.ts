import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncBounded } from './helpers/spawn-sync';
import { tempDir } from './helpers/test-temp';

// HERMETIC PATH for every spawned `deploy.sh`: only the system dirs that `git` /
// `bash` / coreutils live in — NEVER the host PATH. A `deploy` that could find the
// real installed `tg` on PATH would resolve and `git pull` the LIVE checkout from
// a test run (it did, once). This PATH has no `tg`, so the resolution path is
// exercised only against the symlink a test plants under its own temp bin.
const SAFE_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';

// Exercise the REAL scripts/deploy.sh against throwaway local git repos: a bare
// "origin" + a checkout cloned from it. No network, no mocks — the script runs
// its actual fetch / merge-base / pull --ff-only logic against real git. The
// tg-ctl daemon step is driven by a STUB `tg-ctl` planted in the checkout (the
// script runs `$CHECKOUT/tg-ctl`, never a host daemon), so the restart hand-off,
// its failure exit, and --no-restart-ctl are covered without touching a real daemon.

const DEPLOY = join(import.meta.dir, '..', 'scripts', 'deploy.sh');

let root: string;
let origin: string; // bare "remote"
let checkout: string; // working clone the script updates

function git(cwd: string, ...args: string[]) {
  // Deterministic git: identity + signing/default-branch pinned via flags, HOME
  // pointed at the per-test root so the host ~/.gitconfig (signing, hooks) never
  // leaks in. SAFE_PATH keeps git findable without exposing the host `tg`.
  const proc = spawnSyncBounded(
    ['git', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-C', cwd, ...args],
    {
      env: {
        PATH: SAFE_PATH,
        HOME: root,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

function deploy(...args: string[]) {
  // Always pass --checkout (the test tree) on a hermetic PATH so the host `tg` is
  // unreachable; SAFE_PATH still has git/bash/coreutils.
  return spawnSyncBounded(['bash', DEPLOY, '--checkout', checkout, ...args], {
    env: { PATH: SAFE_PATH, HOME: root },
  });
}

// Run the script with a custom env (no implicit --checkout). Used to exercise the
// PATH-symlink resolution path and the "no tg on PATH" error. Callers pass a
// hermetic PATH (SAFE_PATH, optionally with a temp bin prefixed).
function deployEnv(env: Record<string, string>, ...args: string[]) {
  return spawnSyncBounded(['bash', DEPLOY, ...args], { env });
}

function commitFile(rel: string, body: string, msg: string) {
  writeFileSync(join(checkout, rel), body);
  git(checkout, 'add', rel);
  git(checkout, 'commit', '-q', '-m', msg);
}

// Advance origin/main by one pushed commit (via a throwaway second clone) so the
// checkout under test is exactly one fast-forward behind.
function advanceOrigin(file: string, body: string, msg: string) {
  const other = join(root, `other-${Math.random().toString(36).slice(2)}`);
  git(root, 'clone', '--quiet', origin, other);
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  mkdirSync(join(other, file.slice(0, Math.max(0, file.lastIndexOf('/'))) || '.'), { recursive: true });
  writeFileSync(join(other, file), body);
  git(other, 'add', file);
  git(other, 'commit', '-q', '-m', msg);
  git(other, 'push', '-q', 'origin', 'main');
}

// Plant a stub `tg-ctl` in the checkout that records each invocation's argv to a log
// and exits with `restartCode` for `restart` (0 = the verified reload succeeded or
// was not needed). The deploy script runs `$CHECKOUT/tg-ctl`, so this is the exact
// binary it calls; the restart DECISION itself lives in tg-ctl and is covered by
// tests/ctl-daemon-lifecycle-integration.test.ts.
function plantStubCtl(opts: { restartCode?: number } = {}) {
  const log = join(root, 'ctl-calls.log');
  const script = [
    '#!/usr/bin/env bash',
    `echo "$*" >> "${log}"`,
    `[ "$1" = restart ] && exit ${opts.restartCode ?? 0}`,
    '[ "$1" = status ] && { echo "tg-ctl: running (pid 4242) — bot 1"; echo "code: 1234567 (current)"; echo "registrations: none"; }',
    'exit 0',
  ].join('\n');
  writeFileSync(join(checkout, 'tg-ctl'), `${script}\n`, { mode: 0o755 });
  return log;
}

// Plant an EXECUTABLE stub `tg` in the checkout and STAGE it with the exec bit set
// (the seeded `tg` was first tracked as 0o644; git keeps that mode through a chmod
// on disk, so without an explicit index --chmod the pulled file is non-executable
// and the `[ -x ]`-guarded --version / install-skill branches never run). The stub
// logs its subcommand and returns `installSkillCode` for `install-skill`.
function plantStubTg(opts: { installSkillCode?: number } = {}) {
  const log = join(root, 'tg-calls.log');
  const script = [
    '#!/usr/bin/env bash',
    `echo "$1" >> "${log}"`,
    '[ "$1" = --version ] && { echo "tg 9.9.9 (test)"; exit 0; }',
    `[ "$1" = install-skill ] && exit ${opts.installSkillCode ?? 0}`,
    'exit 0',
  ].join('\n');
  writeFileSync(join(checkout, 'tg'), `${script}\n`, { mode: 0o755 });
  git(checkout, 'add', 'tg');
  return log;
}

beforeEach(() => {
  root = tempDir('tg-deploy-test-');
  origin = join(root, 'origin.git');
  checkout = join(root, 'checkout');

  git(root, 'init', '--quiet', '--bare', origin);
  git(root, 'clone', '--quiet', origin, checkout);
  git(checkout, 'config', 'user.email', 't@t');
  git(checkout, 'config', 'user.name', 't');
  // Honor the on-disk exec bit so a 0o755 stub `tg` is tracked executable (some
  // hosts default core.fileMode=false, which would drop the bit and skip the
  // `[ -x ]`-guarded post-deploy branches).
  git(checkout, 'config', 'core.fileMode', 'true');
  // Seed an initial commit and an upstream branch named `main`. `tg` is seeded
  // EXECUTABLE so planting an executable stub later produces no mode diff.
  writeFileSync(join(checkout, 'tg'), '#!/usr/bin/env bun\n', { mode: 0o755 });
  git(checkout, 'add', 'tg');
  git(checkout, 'commit', '-q', '-m', 'initial');
  git(checkout, 'branch', '-M', 'main');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('up-to-date checkout is a clean no-op (exit 0)', () => {
  const proc = deploy();
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('already up to date');
});

test('fast-forwards the checkout to origin and reports the landed commits', () => {
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');

  const before = git(checkout, 'rev-parse', 'HEAD');
  const proc = deploy();
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('docs: add readme');
  expect(out).toContain('pulled');
  const after = git(checkout, 'rev-parse', 'HEAD');
  expect(after).not.toBe(before);
  expect(after).toBe(git(checkout, 'rev-parse', 'origin/main'));
});

test('refuses to deploy over tracked local changes (exit 1)', () => {
  writeFileSync(join(checkout, 'tg'), '#!/usr/bin/env bun\n// local edit\n');
  const proc = deploy();
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString() + proc.stdout.toString()).toContain('local (tracked) changes');
});

test('untracked files do NOT block a deploy (only tracked changes do)', () => {
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');
  // A stray untracked file (e.g. a bun.lock / node_modules left by `bun install`).
  writeFileSync(join(checkout, 'stray.lock'), 'junk\n');
  const proc = deploy();
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('pulled');
});

test('refuses a non-fast-forward divergence (exit 2)', () => {
  advanceOrigin('README.md', 'remote\n', 'remote commit');
  // ...and the local checkout makes its OWN divergent commit.
  commitFile('local.txt', 'local\n', 'local divergent commit');

  const proc = deploy();
  expect(proc.exitCode).toBe(2);
  expect(proc.stderr.toString()).toContain('diverged');
});

test('--dry-run reports the pending commits without pulling', () => {
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');

  const before = git(checkout, 'rev-parse', 'HEAD');
  const proc = deploy('--dry-run');
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('--dry-run — not pulling');
  // HEAD unmoved.
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
});

// Plant + commit the stub tg-ctl, push it as the shared base, THEN advance origin
// with a daemon-code change so the checkout is exactly one fast-forward behind and
// has a clean tree. Returns the stub's call log path.
function setupDaemonDeploy(stub: { restartCode?: number } = {}) {
  const log = plantStubCtl(stub);
  git(checkout, 'add', 'tg-ctl');
  git(checkout, 'commit', '-q', '-m', 'test: stub tg-ctl');
  git(checkout, 'push', '-q', 'origin', 'main');
  advanceOrigin('features/tg-ctl/inject.ts', '// daemon code\n', 'feat(tg-ctl): change inject');
  return log;
}

test('after the pull, the daemon decision goes to the deployed `tg-ctl restart --if-stale`', () => {
  const log = setupDaemonDeploy();

  const proc = deploy();
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('pulled');
  expect(readFileSync(log, 'utf8').trim()).toBe('restart --if-stale');
});

test('an up-to-date checkout still converges the daemon (a pull done by hand left it stale)', () => {
  const log = plantStubCtl();
  git(checkout, 'add', 'tg-ctl');
  git(checkout, 'commit', '-q', '-m', 'test: stub tg-ctl');
  git(checkout, 'push', '-q', 'origin', 'main');

  const proc = deploy();
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('already up to date');
  expect(readFileSync(log, 'utf8').trim()).toBe('restart --if-stale');
});

// A hermetic PATH with the tools deploy.sh and the stubs need but NO timeout(1)/gtimeout (stock
// macOS), so the script runs the checkout's binaries unbounded.
function noTimeoutPath(): string {
  const bin = join(root, 'no-timeout-bin');
  mkdirSync(bin);
  for (const tool of ['bash', 'git', 'sed', 'head', 'grep', 'dirname', 'readlink', 'cat']) {
    const real = Bun.which(tool, { PATH: SAFE_PATH });
    if (real) symlinkSync(real, join(bin, tool));
  }
  return bin;
}

const NO_TIMEOUT_NOTE = 'NOTE — no timeout(1)/gtimeout';

// tg-cli#490(c): the up-to-date path runs `tg-ctl restart --if-stale` unbounded too, yet only the
// pull path said so.
test('without timeout/gtimeout the NOTE is printed on the already-up-to-date path too', () => {
  const log = plantStubCtl();
  git(checkout, 'add', 'tg-ctl');
  git(checkout, 'commit', '-q', '-m', 'test: stub tg-ctl');
  git(checkout, 'push', '-q', 'origin', 'main');

  const proc = deployEnv({ PATH: noTimeoutPath(), HOME: root }, '--checkout', checkout);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('already up to date');
  expect(proc.stderr.toString()).toContain(NO_TIMEOUT_NOTE);
  expect(readFileSync(log, 'utf8').trim()).toBe('restart --if-stale');
});

test('without timeout/gtimeout the NOTE is printed on the pull path', () => {
  const log = setupDaemonDeploy();

  const proc = deployEnv({ PATH: noTimeoutPath(), HOME: root }, '--checkout', checkout);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('pulled');
  expect(proc.stderr.toString()).toContain(NO_TIMEOUT_NOTE);
  expect(readFileSync(log, 'utf8').trim()).toBe('restart --if-stale');
});

test('a box with timeout(1) prints no NOTE', () => {
  setupDaemonDeploy();
  expect(deploy().stderr.toString()).not.toContain(NO_TIMEOUT_NOTE);
});

test('a failed tg-ctl restart fails the deploy with exit 3 — the checkout IS deployed', () => {
  setupDaemonDeploy({ restartCode: 1 });

  const proc = deploy();
  expect(proc.exitCode).toBe(3);
  expect(proc.stderr.toString()).toContain('tg-ctl restart FAILED');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'origin/main'));
});

test('--no-restart-ctl never restarts; it reports the daemon status and code lines', () => {
  const log = setupDaemonDeploy();

  const proc = deploy('--no-restart-ctl');
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('code: 1234567 (current)');
  expect(proc.stdout.toString()).not.toContain('registrations');
  expect(readFileSync(log, 'utf8').trim()).toBe('status');
});

test('--dry-run never touches the daemon', () => {
  const log = setupDaemonDeploy();

  const proc = deploy('--dry-run');
  expect(proc.exitCode).toBe(0);
  expect(existsSync(log)).toBe(false);
});

test('resolves the checkout from a `tg` symlink on PATH when no --checkout given', () => {
  // Production default: no --checkout. Put a bin/ dir with `tg` -> checkout/tg on
  // a HERMETIC PATH (only this bin + the system dirs git/bash need — NEVER the
  // host PATH, or it could resolve and `git pull` the real installed checkout).
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(checkout, 'tg'), join(bin, 'tg'));
  // Sanity: the symlink resolves to THIS test's checkout, not anything on the host.
  expect(realpathSync(join(bin, 'tg'))).toBe(realpathSync(join(checkout, 'tg')));

  const proc = deployEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: root });
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain(`checkout = ${checkout}`);
  expect(out).toContain('pulled');
});

test('errors when no `tg` is on PATH and no --checkout is given (exit 1)', () => {
  // Empty PATH -> no `tg` resolvable. Provide a minimal PATH with only the dir
  // holding `bash`/`git` so the script itself can run but `command -v tg` fails.
  const proc = deployEnv({ PATH: '/usr/bin:/bin', HOME: root });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain("no 'tg' on PATH");
});

test('errors when --checkout points at a non-git directory (exit 1)', () => {
  const notRepo = join(root, 'not-a-repo');
  mkdirSync(notRepo, { recursive: true });
  const proc = deployEnv({ PATH: SAFE_PATH, HOME: root }, '--checkout', notRepo);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('not a git checkout');
});

test('--checkout with no value exits 1 cleanly (not a set -e crash)', () => {
  const proc = deployEnv({ PATH: SAFE_PATH, HOME: root }, '--checkout');
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('--checkout requires a directory');
});

test('rejects an unknown argument (exit 1)', () => {
  const proc = deploy('--bogus');
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('unknown argument');
});

test('--help prints usage and exits 0', () => {
  const proc = deploy('--help');
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('Usage:');
  expect(proc.stdout.toString()).toContain('--no-restart-ctl');
});

test('refuses a detached-HEAD checkout (exit 1)', () => {
  // Detach HEAD at the current commit.
  const sha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '--quiet', sha);
  const proc = deploy();
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('detached-HEAD');
});

test('runs the deployed tg for the version check and skill refresh after a pull', () => {
  // Plant an executable tg stub (the seeded tg is non-executable, so these
  // branches would never run). Commit it, then fast-forward over a docs change.
  const tgLog = plantStubTg();
  git(checkout, 'commit', '-q', '-m', 'test: stub tg');
  git(checkout, 'push', '-q', 'origin', 'main');
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');

  const proc = deploy();
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('tg --version -> tg 9.9.9 (test)');
  expect(out).toContain('refreshed tg skill');
  const calls = readFileSync(tgLog, 'utf8');
  expect(calls).toContain('--version');
  expect(calls).toContain('install-skill');
});

test('warns (but still exits 0) when the deployed tg install-skill fails', () => {
  plantStubTg({ installSkillCode: 1 });
  git(checkout, 'commit', '-q', '-m', 'test: stub tg');
  git(checkout, 'push', '-q', 'origin', 'main');
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');

  const proc = deploy();
  expect(proc.exitCode).toBe(0); // install-skill failure is a non-blocking warning
  expect(proc.stderr.toString()).toContain("'tg install-skill' failed");
});

test('resolves a multi-hop tg symlink chain to the final checkout', () => {
  // tg -> mid -> checkout/tg (two hops, all valid/executable). Exercises the
  // resolve_link LOOP (a single-hop readlink would land on `mid`'s dir, not the
  // checkout). A cyclic chain can't be tested via PATH — `command -v` rejects a
  // non-executable cyclic symlink before resolve_link ever sees it — so the
  // script's hop cap stays a defensive guard, exercised here only as a real chain.
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(checkout, 'tg'), join(bin, 'mid')); // mid -> checkout/tg
  symlinkSync(join(bin, 'mid'), join(bin, 'tg')); // tg -> mid
  expect(realpathSync(join(bin, 'tg'))).toBe(realpathSync(join(checkout, 'tg')));

  const proc = deployEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: root });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain(`checkout = ${checkout}`);
});
