// Stale-daemon detection (tg-cli#279): a merged fix only runs once the resident
// `tg-ctl run` process is restarted, so `status` and `restart --if-stale` must tell a
// daemon still holding pre-merge code from a current one. Pure decision logic here;
// tests/ctl-daemon-lifecycle-integration.test.ts drives the real daemon + git checkout.
import { expect, test } from 'bun:test';
import {
  assessCodeFreshness,
  codeFreshnessLine,
  isDaemonCodePath,
  parseRunInfo,
  serializeRunInfo,
  shouldRestartForFreshness,
  type DaemonRunInfo,
} from '../features/tg-ctl/code-freshness';

const OLD = 'fa8a6ff0000000000000000000000000000000aa';
const NEW = '989674b0000000000000000000000000000000bb';
const INFO: DaemonRunInfo = { pid: 1817, commit: OLD, codeDir: '/deployed/tg-cli', startedAt: 1_700_000_000_000 };

test('run-info survives a serialize/parse round trip; torn or foreign content is rejected', () => {
  expect(parseRunInfo(serializeRunInfo(INFO))).toEqual(INFO);
  expect(parseRunInfo(null)).toBeNull();
  expect(parseRunInfo('{"pid":1817,"commit":"fa8a')).toBeNull();
  expect(parseRunInfo(JSON.stringify({ ...INFO, pid: 0 }))).toBeNull();
  expect(parseRunInfo(JSON.stringify({ ...INFO, commit: '' }))).toBeNull();
  expect(parseRunInfo(JSON.stringify({ ...INFO, codeDir: 7 }))).toBeNull();
});

test('daemon code paths: the entrypoint, feature modules, tools and deps count; the sender, docs, tests and ops files do not', () => {
  for (const p of ['tg-ctl', 'features/tg-ctl/lock.ts', 'features/render/x.ts', 'tools/omp-live-cli.mjs', 'package.json']) {
    expect(isDaemonCodePath(p)).toBe(true);
  }
  for (const p of ['tg', 'README.md', 'CHANGELOG.md', 'docs/ROADMAP.md', 'features/tg-ctl/NOTES.md', 'tests/x.test.ts', 'scripts/deploy.sh', '.github/workflows/ci.yml', 'screenshots/a.png', 'task.yaml']) {
    expect(isDaemonCodePath(p)).toBe(false);
  }
});

test('the running daemon loaded the checkout HEAD → current, no restart', () => {
  const f = assessCodeFreshness(INFO, 1817, OLD, []);
  expect(f).toEqual({ kind: 'current', commit: OLD });
  expect(shouldRestartForFreshness(f)).toBe(false);
  expect(codeFreshnessLine(f)).toBe('code: fa8a6ff (current)');
});

test('HEAD moved with daemon code changes → STALE, restart needed, line names both commits and the checkout', () => {
  const f = assessCodeFreshness(INFO, 1817, NEW, ['CHANGELOG.md', 'tg-ctl', 'features/tg-ctl/omp.ts']);
  expect(f).toEqual({ kind: 'stale', running: OLD, head: NEW, codeDir: '/deployed/tg-cli', changedFiles: 2 });
  expect(shouldRestartForFreshness(f)).toBe(true);
  expect(codeFreshnessLine(f)).toBe('code: STALE — daemon runs fa8a6ff but /deployed/tg-cli is at 989674b (2 daemon file(s) changed)');
});

test('HEAD moved by docs/tests only → not stale (a docs merge must not bounce the daemon)', () => {
  const f = assessCodeFreshness(INFO, 1817, NEW, ['docs/ROADMAP.md', 'tests/a.test.ts', 'README.md']);
  expect(f).toEqual({ kind: 'current-code', running: OLD, head: NEW });
  expect(shouldRestartForFreshness(f)).toBe(false);
  expect(codeFreshnessLine(f)).toBe('code: fa8a6ff (checkout at 989674b — no daemon code changed)');
});

test('HEAD moved but the diff is unavailable (running commit gone after a force-push) → STALE, conservatively', () => {
  const f = assessCodeFreshness(INFO, 1817, NEW, null);
  expect(f.kind).toBe('stale');
  expect(shouldRestartForFreshness(f)).toBe(true);
});

test('run-info from ANOTHER pid (daemon predates code-identity recording) → unknown, restart to be sure', () => {
  const f = assessCodeFreshness(INFO, 4242, NEW, []);
  expect(f.kind).toBe('unknown');
  expect(shouldRestartForFreshness(f)).toBe(true);
  expect(codeFreshnessLine(f)).toContain('pid 4242');
  expect(shouldRestartForFreshness(assessCodeFreshness(null, 4242, NEW, []))).toBe(true);
});

test('checkout HEAD unreadable (not a git checkout any more) → unknown, restart to be sure', () => {
  const f = assessCodeFreshness(INFO, 1817, null, null);
  expect(f.kind).toBe('unknown');
  expect(shouldRestartForFreshness(f)).toBe(true);
});
