// Regression coverage for the audit.jsonl rotation lock (review finding on
// this feature's first pass: a bare read-existing + append + trim + write-back
// with NO lock is a lost-update race — two concurrent `tg` sends could each
// read the same bytes and the second writer's write silently drops the
// first's just-appended line). appendAudit now serializes the read-trim-write
// under features/tg-ctl/routes.ts's ALREADY-TESTED `withRoutesLock` +
// `fsRoutesLockIo` mutex (reused rather than a hand-rolled copy — a first
// pass here reimplemented the lock and reintroduced a bug that pattern had
// already fixed once: treating an EMPTY lockfile, the SIGKILL window between
// creating the file and writing the pid, as "not dead" forever), and falls
// back to a bare atomic append only when the lock is genuinely unavailable
// for the whole spin budget.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import { appendAudit, auditFile } from '../features/hooks/run-photo-hooks';
import { MAX_AUDIT_LINES, type AuditLine } from '../features/hooks/runner';
import { writeOrphanLock } from './helpers/orphan-lock';
import { tempDir } from './helpers/test-temp';

let home: string;

beforeEach(() => {
  home = tempDir('tg-audit-lock-');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function line(hookId: string): AuditLine {
  return {
    ts: new Date().toISOString(),
    event_id: hookId,
    tool: 'tg',
    hook_id: hookId,
    point: 'pre-send-photo',
    cmd_sha256: 'sha',
    decision: 'allow',
    duration_ms: 1,
    on_error_applied: 'open',
    trust_state: 'trusted-default',
  };
}

function readLines(): string[] {
  try {
    return readFileSync(auditFile(home), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

// Small budget so the contended-path tests don't pay the full ~1.5s
// production spin (appendAudit's third param is test-only — see its doc
// comment in run-photo-hooks.ts).
const FAST = { attempts: 5, delayMs: 2 };

test('sequential appends all survive (baseline, no contention)', () => {
  for (let i = 0; i < 5; i++) appendAudit(home, line(`h${i}`));
  const lines = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  expect(lines).toEqual(['h0', 'h1', 'h2', 'h3', 'h4']);
});

// Simulate an already-held lock (as if another `tg` process were mid-rotation)
// by pre-creating the lockfile with OUR OWN pid — process.kill(ownPid, 0)
// always succeeds for our own pid, so the lock reads as held-by-a-live-owner
// and appendAudit must NOT break it; once its (shrunk) spin budget is
// exhausted it must fall back to a bare atomic append so the line still lands.
test('a CONTENDED lock (held by a live owner) still delivers the line via the atomic-append fallback', () => {
  appendAudit(home, line('before')); // establish a baseline line first
  const lockPath = `${auditFile(home)}.lock`;
  mkdirSync(join(home, '.agents', 'hooks'), { recursive: true });
  const fd = openSync(lockPath, 'wx');
  writeSync(fd, String(process.pid)); // our own pid = "alive" from kill(0)'s POV
  closeSync(fd);

  appendAudit(home, line('during-contention'), FAST);

  const ids = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  // Both the pre-existing line AND the contended one survive — nothing lost.
  expect(ids).toContain('before');
  expect(ids).toContain('during-contention');
});

// A lock left behind by a CRASHED process (pid that no longer exists) must be
// stolen, not permanently wedge rotation — otherwise one SIGKILLed `tg` would
// disable trimming forever.
test('a STALE lock (dead pid) is broken and rotation resumes', () => {
  const lockPath = `${auditFile(home)}.lock`;
  mkdirSync(join(home, '.agents', 'hooks'), { recursive: true });
  const fd = openSync(lockPath, 'wx');
  // A pid that is essentially guaranteed not to exist.
  writeSync(fd, '999999999');
  closeSync(fd);

  appendAudit(home, line('after-stale-lock'), FAST);

  const ids = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  expect(ids).toContain('after-stale-lock');
});

// The bug this reuse fixed: an EMPTY lockfile (the SIGKILL window between
// openSync('wx') creating it and the pid write landing) must ALSO be treated
// as a dead/breakable owner — not "not dead" forever. fsRoutesLockIo models
// this as its 'unparseable' owner state, breakable once it is older than
// ORPHAN_LOCK_AGE_MS (younger, it may be a live writer mid-acquire).
test('an EMPTY lockfile (SIGKILL-window orphan) is broken, not a permanent wedge', () => {
  const lockPath = `${auditFile(home)}.lock`;
  mkdirSync(join(home, '.agents', 'hooks'), { recursive: true });
  writeOrphanLock(lockPath); // empty — never got a pid written

  appendAudit(home, line('after-empty-lock'), FAST);

  const ids = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  expect(ids).toContain('after-empty-lock');
  // Broken and taken, not bypassed by the contended-path fallback append.
  expect(existsSync(lockPath)).toBe(false);
});

// Review finding (Opus): appendAudit's write is NOT allowed to throw out and
// abort the send — "an audit failure must never break a send" is this
// module's own stated invariant. Force a real write failure (EISDIR: the
// audit.jsonl PATH is a directory, not a file) rather than mocking fs, and
// assert appendAudit swallows it silently instead of throwing.
test('a write failure (EISDIR: audit.jsonl path is a directory) never throws out of appendAudit', () => {
  mkdirSync(auditFile(home), { recursive: true }); // audit.jsonl is a DIR here
  expect(() => appendAudit(home, line('should-not-throw'), FAST)).not.toThrow();
});

test('rotation still caps the file at MAX_AUDIT_LINES once the lock is free', () => {
  for (let i = 0; i < 20; i++) appendAudit(home, line(`h${i}`));
  // Force a tiny effective cap isn't exposed here (MAX_AUDIT_LINES is a large
  // constant), so this just asserts monotonic non-loss under normal operation
  // — the exact rotation math is covered directly in tests/hooks-runner.test.ts
  // (trimAuditLines unit tests).
  const ids = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  expect(ids.length).toBe(20);
  expect(ids[ids.length - 1]).toBe('h19');
});

// --- REAL cross-process concurrency ----------------------------------------
//
// Everything above exercises the lock's DECISION logic (contended/stale/
// empty) synchronously in one process. This test instead spawns N separate
// `bun` child processes that each call appendAudit ONCE against the SAME
// home concurrently (Bun.spawn, not spawnSync — genuinely overlapping), and
// asserts every single line survives. This is the actual race class the
// review finding was about.
test('N concurrent child processes each appending once → every line survives, none lost', async () => {
  const N = 12;
  const script = join(home, 'append-once.ts');
  const runPhotoHooksPath = join(import.meta.dir, '..', 'features', 'hooks', 'run-photo-hooks.ts');
  const scriptSrc = `
    import { appendAudit } from ${JSON.stringify(runPhotoHooksPath)};
    const home = process.argv[2];
    const id = process.argv[3];
    appendAudit(home, {
      ts: new Date().toISOString(),
      event_id: id,
      tool: 'tg',
      hook_id: id,
      point: 'pre-send-photo',
      cmd_sha256: 'sha',
      decision: 'allow',
      duration_ms: 1,
      on_error_applied: 'open',
      trust_state: 'trusted-default',
    });
  `;
  writeFileSync(script, scriptSrc);

  const ids = Array.from({ length: N }, (_, i) => `child-${i}`);
  const procs = ids.map((id) => Bun.spawn(['bun', script, home, id], { stdout: 'ignore', stderr: 'inherit' }));
  await Promise.all(procs.map((p) => p.exited));

  const survivingIds = readLines()
    .map((l) => (JSON.parse(l) as AuditLine).hook_id)
    .filter((id) => id.startsWith('child-'));
  expect(new Set(survivingIds)).toEqual(new Set(ids));
  expect(survivingIds.length).toBe(N); // no duplicates either
}, 20000);

// --- fast-path append vs full-rewrite rotation (review finding) -----------
//
// Review finding: an earlier version rewrote the WHOLE file on every single
// append (read + trim + temp-write + rename), even far below the cap — O(file)
// per hook firing instead of O(1), which also lengthens the lock hold time.
// appendAudit now takes a cheap appendFileSync fast path below the cap and
// only pays for the full rewrite once AT/OVER MAX_AUDIT_LINES.

test('below the cap: appendAudit does not trim (all lines survive, no rewrite needed)', () => {
  mkdirSync(join(home, '.agents', 'hooks'), { recursive: true });
  const seedLines = Array.from({ length: 10 }, (_, i) => JSON.stringify(line(`seed-${i}`))).join('\n') + '\n';
  writeFileSync(auditFile(home), seedLines);

  appendAudit(home, line('new-below-cap'), FAST);

  const ids = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  expect(ids.length).toBe(11); // 10 seeded + 1 new — nothing trimmed
  expect(ids[ids.length - 1]).toBe('new-below-cap');
});

test('AT the cap: appendAudit rotates (trims the oldest, keeps the newest, stays capped)', () => {
  mkdirSync(join(home, '.agents', 'hooks'), { recursive: true });
  const seedLines =
    Array.from({ length: MAX_AUDIT_LINES }, (_, i) => JSON.stringify(line(`seed-${i}`))).join('\n') + '\n';
  writeFileSync(auditFile(home), seedLines);

  appendAudit(home, line('pushes-out-the-oldest'), FAST);

  const ids = readLines().map((l) => (JSON.parse(l) as AuditLine).hook_id);
  expect(ids.length).toBe(MAX_AUDIT_LINES); // capped, not MAX_AUDIT_LINES + 1
  expect(ids[ids.length - 1]).toBe('pushes-out-the-oldest');
  expect(ids).not.toContain('seed-0'); // the oldest line was trimmed away
  expect(ids).toContain('seed-1'); // its neighbor survives
}, 15000);
