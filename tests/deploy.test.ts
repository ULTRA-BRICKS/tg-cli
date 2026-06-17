import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// HERMETIC PATH for every spawned `deploy.sh`: only the system dirs that `git` /
// `bash` / coreutils live in — NEVER the host PATH. A `deploy` that could find the
// real installed `tg` on PATH would resolve and `git pull` the LIVE checkout from
// a test run (it did, once). This PATH has no `tg`, so the resolution path is
// exercised only against the symlink a test plants under its own temp bin.
const SAFE_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';

// Exercise the REAL scripts/deploy.sh against throwaway local git repos: a bare
// "origin" + a checkout cloned from it. No network, no mocks — the script runs
// its actual fetch / merge-base / pull --ff-only logic against real git. The
// tg-ctl daemon branches are driven by a STUB `tg-ctl` planted in the checkout
// (the script runs `$CHECKOUT/tg-ctl`, never a host daemon), so the warn path and
// the --restart-ctl stop/start path are covered without touching a real daemon.

const DEPLOY = join(import.meta.dir, '..', 'scripts', 'deploy.sh');

let root: string;
let origin: string; // bare "remote"
let checkout: string; // working clone the script updates

function git(cwd: string, ...args: string[]) {
  // Deterministic git: identity + signing/default-branch pinned via flags, HOME
  // pointed at the per-test root so the host ~/.gitconfig (signing, hooks) never
  // leaks in. SAFE_PATH keeps git findable without exposing the host `tg`.
  const proc = Bun.spawnSync(
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
  return Bun.spawnSync(['bash', DEPLOY, '--checkout', checkout, ...args], {
    env: { PATH: SAFE_PATH, HOME: root },
  });
}

// Run the script with a custom env (no implicit --checkout). Used to exercise the
// PATH-symlink resolution path and the "no tg on PATH" error. Callers pass a
// hermetic PATH (SAFE_PATH, optionally with a temp bin prefixed).
function deployEnv(env: Record<string, string>, ...args: string[]) {
  return Bun.spawnSync(['bash', DEPLOY, ...args], { env });
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
  Bun.spawnSync(['mkdir', '-p', join(other, file.slice(0, Math.max(0, file.lastIndexOf('/'))) || '.')]);
  writeFileSync(join(other, file), body);
  git(other, 'add', file);
  git(other, 'commit', '-q', '-m', msg);
  git(other, 'push', '-q', 'origin', 'main');
}

// Plant a stub `tg-ctl` in the checkout that records each subcommand to a log and
// returns the given exit codes (status defaults to 0 = "running"; stop/start to 0).
// The deploy script runs `$CHECKOUT/tg-ctl`, so this is the exact binary it calls.
function plantStubCtl(opts: { statusCode?: number; stopCode?: number; startCode?: number } = {}) {
  const log = join(root, 'ctl-calls.log');
  const script = [
    '#!/usr/bin/env bash',
    `echo "$1" >> "${log}"`,
    `[ "$1" = status ] && exit ${opts.statusCode ?? 0}`,
    `[ "$1" = stop ] && exit ${opts.stopCode ?? 0}`,
    `[ "$1" = start ] && exit ${opts.startCode ?? 0}`,
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
  root = mkdtempSync(join(tmpdir(), 'tg-deploy-test-'));
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

test('flags a tg-ctl restart when the deploy changes daemon code', () => {
  advanceOrigin('features/tg-ctl/inject.ts', '// daemon code\n', 'feat(tg-ctl): change inject');

  // --dry-run surfaces the restart-needed note without touching the daemon.
  const proc = deploy('--dry-run');
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('would require a tg-ctl restart');
});

test('does NOT flag a restart for a docs-only deploy', () => {
  advanceOrigin('README.md', 'docs only\n', 'docs: tweak');

  const proc = deploy('--dry-run');
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).not.toContain('would require a tg-ctl restart');
});

// Plant + commit the stub tg-ctl, push it as the shared base, THEN advance origin
// with a daemon-code change so the checkout is exactly one fast-forward behind and
// has a clean tree. Returns the stub's call log path.
function setupDaemonDeploy(stub: { statusCode?: number; stopCode?: number; startCode?: number }) {
  const log = plantStubCtl(stub);
  git(checkout, 'add', 'tg-ctl');
  git(checkout, 'commit', '-q', '-m', 'test: stub tg-ctl');
  git(checkout, 'push', '-q', 'origin', 'main');
  advanceOrigin('features/tg-ctl/inject.ts', '// daemon code\n', 'feat(tg-ctl): change inject');
  return log;
}

test('real deploy with daemon code change + running daemon prints the ACTION-NEEDED banner (no restart without the flag)', () => {
  const log = setupDaemonDeploy({ statusCode: 0 }); // status 0 = "running"

  const proc = deploy(); // no --restart-ctl
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toContain('ACTION NEEDED');
  // Only `status` was queried; the daemon was NOT stopped/started.
  const calls = readFileSync(log, 'utf8');
  expect(calls).toContain('status');
  expect(calls).not.toContain('stop');
  expect(calls).not.toContain('start');
});

test('--restart-ctl stops then starts the daemon when its code changed', () => {
  const log = setupDaemonDeploy({ statusCode: 0, startCode: 0 });

  const proc = deploy('--restart-ctl');
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('restarting tg-ctl');
  const calls = readFileSync(log, 'utf8');
  expect(calls).toContain('stop');
  expect(calls).toContain('start');
});

test('--restart-ctl aborts (exit 1) when the daemon fails to start', () => {
  setupDaemonDeploy({ statusCode: 0, startCode: 1 }); // start fails

  const proc = deploy('--restart-ctl');
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('tg-ctl start FAILED');
});

test('--restart-ctl aborts on a stop failure (exit 1, blames stop not start)', () => {
  const log = setupDaemonDeploy({ statusCode: 0, stopCode: 1 }); // stop fails

  const proc = deploy('--restart-ctl');
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('tg-ctl stop FAILED');
  expect(proc.stderr.toString()).not.toContain('start FAILED');
  // start must NOT be attempted after a failed stop.
  expect(readFileSync(log, 'utf8')).not.toContain('start');
});

test('daemon-code change but NO running daemon: no warning, no restart, exit 0', () => {
  const log = setupDaemonDeploy({ statusCode: 1 }); // status 1 = NOT running

  const proc = deploy(); // even without --restart-ctl
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).not.toContain('ACTION NEEDED');
  const calls = readFileSync(log, 'utf8');
  expect(calls).not.toContain('stop');
  expect(calls).not.toContain('start');
});

test('--restart-ctl is a no-op when the daemon is not running (does not start one)', () => {
  const log = setupDaemonDeploy({ statusCode: 1 }); // not running

  const proc = deploy('--restart-ctl');
  expect(proc.exitCode).toBe(0);
  expect(readFileSync(log, 'utf8')).not.toContain('start');
});

test('resolves the checkout from a `tg` symlink on PATH when no --checkout given', () => {
  // Production default: no --checkout. Put a bin/ dir with `tg` -> checkout/tg on
  // a HERMETIC PATH (only this bin + the system dirs git/bash need — NEVER the
  // host PATH, or it could resolve and `git pull` the real installed checkout).
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');
  const bin = join(root, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
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
  Bun.spawnSync(['mkdir', '-p', notRepo]);
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
  expect(proc.stdout.toString()).toContain('--restart-ctl');
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

test('reports "no restart needed" when a running daemon\'s code is untouched', () => {
  const ctlLog = plantStubCtl({ statusCode: 0 }); // running
  git(checkout, 'add', 'tg-ctl');
  git(checkout, 'commit', '-q', '-m', 'test: stub tg-ctl');
  git(checkout, 'push', '-q', 'origin', 'main');
  // A docs-only change — does NOT touch tg-ctl or features/.
  advanceOrigin('README.md', 'docs only\n', 'docs: tweak');

  const proc = deploy();
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('no restart needed');
  const calls = readFileSync(ctlLog, 'utf8');
  expect(calls).not.toContain('stop');
  expect(calls).not.toContain('start');
});

test('resolves a multi-hop tg symlink chain to the final checkout', () => {
  // tg -> mid -> checkout/tg (two hops, all valid/executable). Exercises the
  // resolve_link LOOP (a single-hop readlink would land on `mid`'s dir, not the
  // checkout). A cyclic chain can't be tested via PATH — `command -v` rejects a
  // non-executable cyclic symlink before resolve_link ever sees it — so the
  // script's hop cap stays a defensive guard, exercised here only as a real chain.
  advanceOrigin('README.md', 'hello\n', 'docs: add readme');
  const bin = join(root, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
  symlinkSync(join(checkout, 'tg'), join(bin, 'mid')); // mid -> checkout/tg
  symlinkSync(join(bin, 'mid'), join(bin, 'tg')); // tg -> mid
  expect(realpathSync(join(bin, 'tg'))).toBe(realpathSync(join(checkout, 'tg')));

  const proc = deployEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: root });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain(`checkout = ${checkout}`);
});
