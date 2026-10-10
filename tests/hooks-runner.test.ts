import { expect, test } from 'bun:test';
import {
  orderDescriptors,
  resolveTrust,
  runHooks,
  trimAuditLines,
  validateDescriptor,
  type AuditLine,
  type RunnerDeps,
  type SpawnResult,
} from '../features/hooks/runner';
import {
  HOOK_API,
  invocationDigest,
  type HookDescriptor,
  type HookEvent,
  type LoadedDescriptor,
} from '../features/hooks/types';
import { trustAutoActive, untrustedGuardActive } from '../features/hooks/run-photo-hooks';

// --- helpers ---------------------------------------------------------------

function desc(over: Partial<HookDescriptor> = {}): HookDescriptor {
  return { id: 'h', point: 'pre-send-photo', cmd: '/bin/hook', ...over };
}

function loaded(over: Partial<HookDescriptor> = {}, file = 'a.json'): LoadedDescriptor {
  return { descriptor: desc(over), file };
}

function evt(): HookEvent {
  return {
    hook_api: HOOK_API,
    event_id: 'e1',
    tool: 'tg',
    point: 'pre-send-photo',
    command: 'send-photo',
    cwd: '/tmp',
    args: { image_path: '/tmp/x.png', caption: '', chat_id: '' },
  };
}

interface MockOpts {
  spawn?: (cmd: string) => SpawnResult;
  trust?: Record<
    string,
    { cmd_sha256: string; invocation_sha256?: string; point: string; on_error: 'open' | 'closed' }
  >;
  trustAuto?: boolean;
  // Default true here so the existing TOFU/quarantine/pin assertions exercise the
  // GUARDED path (AGENTS_HOOKS_TRUST=1). Trust-by-default is covered explicitly.
  untrustedGuard?: boolean;
  sha?: (path: string) => string | null;
}

function mkDeps(opts: MockOpts = {}): { deps: RunnerDeps; warns: string[]; audits: AuditLine[] } {
  const warns: string[] = [];
  const audits: AuditLine[] = [];
  const deps: RunnerDeps = {
    trust: opts.trust ?? {},
    trustAuto: opts.trustAuto ?? false,
    untrustedGuard: opts.untrustedGuard ?? true,
    sha256: opts.sha ?? (() => 'SHA'),
    sha256Str: () => 'INV',
    spawn: opts.spawn ?? (() => ({ exitCode: 0, stdout: '{"decision":"allow"}', stderr: '', timedOut: false })),
    audit: (l) => audits.push(l),
    warn: (m) => warns.push(m),
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
    isoNow: () => '2026-01-01T00:00:00Z',
  };
  return { deps, warns, audits };
}

// A trust pin matching the default mock sha 'SHA'.
const trustOk = {
  'h.pre-send-photo': {
    cmd_sha256: 'SHA',
    invocation_sha256: 'INV',
    point: 'pre-send-photo',
    on_error: 'open' as const,
  },
};

// --- ordering --------------------------------------------------------------

test('orderDescriptors sorts by priority then filename', () => {
  const a = loaded({ priority: 10 }, 'z.json');
  const b = loaded({ priority: 5 }, 'b.json');
  const c = loaded({ priority: 5 }, 'a.json');
  const out = orderDescriptors([a, b, c]).map((d) => d.file);
  expect(out).toEqual(['a.json', 'b.json', 'z.json']);
});

// --- trust-by-default (guard OFF — the common path) ------------------------

test('resolveTrust: guard OFF → any present descriptor is trusted-default (no pin needed)', () => {
  const r = resolveTrust(desc(), 'SHA', 'INV', { trust: {}, trustAuto: false, untrustedGuard: false });
  expect(r.state).toBe('trusted-default');
  expect(r.pinnedOnError).toBeUndefined();
});

test('resolveTrust: guard OFF still reports a missing cmd (nothing to run)', () => {
  const r = resolveTrust(desc(), null, 'INV', { trust: {}, trustAuto: false, untrustedGuard: false });
  expect(r.state).toBe('untrusted-missing-cmd');
});

// --- guarded TOFU trust (AGENTS_HOOKS_TRUST=1) -----------------------------

test('resolveTrust: guard ON, unseen descriptor is quarantined-new', () => {
  const r = resolveTrust(desc(), 'SHA', 'INV', { trust: {}, trustAuto: false, untrustedGuard: true });
  expect(r.state).toBe('quarantined-new');
});

test('resolveTrust: guard ON, matching pin is trusted and carries on_error', () => {
  const r = resolveTrust(desc(), 'SHA', 'INV', { trust: trustOk, trustAuto: false, untrustedGuard: true });
  expect(r.state).toBe('trusted');
  expect(r.pinnedOnError).toBe('open');
});

test('resolveTrust: guard ON, changed sha re-quarantines', () => {
  const r = resolveTrust(desc(), 'DIFFERENT', 'INV', { trust: trustOk, trustAuto: false, untrustedGuard: true });
  expect(r.state).toBe('quarantined-changed');
});

test('resolveTrust: guard ON, changed INVOCATION (cmd+args) re-quarantines even if cmd sha matches', () => {
  // The executable bytes are unchanged ('SHA') but args were repointed, so the
  // invocation digest no longer matches the pin → re-trust required.
  const r = resolveTrust(desc(), 'SHA', 'DIFFERENT_INV', { trust: trustOk, trustAuto: false, untrustedGuard: true });
  expect(r.state).toBe('quarantined-changed');
});

test('resolveTrust: guard ON, missing cmd → untrusted-missing-cmd', () => {
  const r = resolveTrust(desc(), null, 'INV', { trust: trustOk, trustAuto: false, untrustedGuard: true });
  expect(r.state).toBe('untrusted-missing-cmd');
});

test('resolveTrust: guard ON, trustAuto bypasses pins', () => {
  const r = resolveTrust(desc(), 'whatever', 'whatever', { trust: {}, trustAuto: true, untrustedGuard: true });
  expect(r.state).toBe('auto');
});

// --- trust-by-default: a dropped descriptor RUNS with NO trust step --------

test('guard OFF: a dropped descriptor with no pin RUNS by default (and can block)', () => {
  let ran = false;
  const { deps, warns } = mkDeps({
    untrustedGuard: false, // the default world: trust-by-default
    spawn: () => {
      ran = true;
      return { exitCode: 10, stdout: '{"message":"unstyled"}', stderr: '', timedOut: false };
    },
  });
  const v = runHooks([loaded()], evt, deps); // NO trust pin supplied
  expect(ran).toBe(true);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('unstyled');
  expect(v.results[0].trustState).toBe('trusted-default');
  expect(v.results[0].quarantined).toBe(false);
  // no quarantine banner in the common path
  expect(warns.some((w) => w.includes('NEW HOOK'))).toBe(false);
});

test('guard OFF: a dropped descriptor exiting 0 allows the send (runs, no pin)', () => {
  const { deps } = mkDeps({
    untrustedGuard: false,
    spawn: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(false);
  expect(v.results[0].trustState).toBe('trusted-default');
});

// --- guarded TOFU: quarantine = absent (never runs, never blocks) ----------

test('guard ON: quarantined-new descriptor does NOT run and does NOT block', () => {
  let ran = false;
  const { deps, warns } = mkDeps({
    untrustedGuard: true,
    spawn: () => {
      ran = true;
      return { exitCode: 10, stdout: '', stderr: '', timedOut: false };
    },
  });
  const v = runHooks([loaded()], evt, deps);
  expect(ran).toBe(false);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('NEW HOOK'))).toBe(true);
});

// --- block via exit 10 -----------------------------------------------------

test('exit 10 blocks (canonical) with message from stdout JSON', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 10, stdout: '{"message":"unstyled render"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('unstyled render');
});

test('exit 10 blocks even with MALFORMED stdout (no silent bypass)', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 10, stdout: 'not json at all', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('blocked by hook');
});

// --- allow -----------------------------------------------------------------

test('exit 0 allows the send', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"allow"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(false);
});

test('exit 0 with stdout decision:block also blocks (belt & suspenders)', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"block","message":"x"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('x');
});

test('exit 0 with EMPTY stdout → allow (valid: no extra fields)', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  });
  expect(runHooks([loaded()], evt, deps).blocked).toBe(false);
});

// P2 fix: exit 0 + MALFORMED stdout is a protocol violation = hook error.
test('exit 0 with malformed stdout + on_error open → allow + warn (treated as error)', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: 'random log line, not json', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('malformed'))).toBe(true);
});

test('exit 0 with malformed stdout + on_error closed → BLOCKS (no silent bypass)', () => {
  const pin = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: 'INV',
      point: 'pre-send-photo',
      on_error: 'closed' as const,
    },
  };
  const { deps } = mkDeps({
    trust: pin,
    spawn: () => ({ exitCode: 0, stdout: 'oops not protocol', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
});

test('exit 0 with UNKNOWN decision ("deny") + on_error closed → BLOCKS', () => {
  const pin = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: 'INV',
      point: 'pre-send-photo',
      on_error: 'closed' as const,
    },
  };
  const { deps } = mkDeps({
    trust: pin,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"deny"}', stderr: '', timedOut: false }),
  });
  expect(runHooks([loaded()], evt, deps).blocked).toBe(true);
});

test('exit 0 with UNKNOWN decision + on_error open → allow + warn', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"blocked"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('unknown decision'))).toBe(true);
});

// --- fail-open / fail-closed ----------------------------------------------

test('hook error (non-zero exit) with on_error open → allow + warn', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('on_error=open'))).toBe(true);
});

test('hook timeout with on_error open → allow + warn (fail-open default)', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('timed out'))).toBe(true);
});

test('hook error with on_error closed → blocks', () => {
  // pin on_error closed (pin is authoritative)
  const pin = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: 'INV',
      point: 'pre-send-photo',
      on_error: 'closed' as const,
    },
  };
  const { deps } = mkDeps({
    trust: pin,
    spawn: () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps); // descriptor says open, pin says closed
  expect(v.blocked).toBe(true);
});

// --- first block short-circuits -------------------------------------------

test('first blocking hook short-circuits the rest', () => {
  let secondRan = false;
  const { deps } = mkDeps({
    trust: {
      'a.pre-send-photo': { cmd_sha256: 'SHA', invocation_sha256: 'INV', point: 'pre-send-photo', on_error: 'open' },
      'b.pre-send-photo': { cmd_sha256: 'SHA', invocation_sha256: 'INV', point: 'pre-send-photo', on_error: 'open' },
    },
    spawn: (cmd) => {
      if (cmd === '/bin/b') secondRan = true;
      return { exitCode: 10, stdout: '{"message":"stop"}', stderr: '', timedOut: false };
    },
  });
  const a = { descriptor: desc({ id: 'a', cmd: '/bin/a', priority: 1 }), file: 'a.json' };
  const b = { descriptor: desc({ id: 'b', cmd: '/bin/b', priority: 2 }), file: 'b.json' };
  const v = runHooks([a, b], evt, deps);
  expect(v.blocked).toBe(true);
  expect(secondRan).toBe(false);
});

// --- audit -----------------------------------------------------------------

test('every hook firing writes an audit line', () => {
  const { deps, audits } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  });
  runHooks([loaded()], evt, deps);
  expect(audits.length).toBe(1);
  expect(audits[0].decision).toBe('allow');
  expect(audits[0].trust_state).toBe('trusted');
});

test('a quarantined hook still writes a quarantined audit line', () => {
  const { deps, audits } = mkDeps();
  runHooks([loaded()], evt, deps);
  expect(audits.length).toBe(1);
  expect(audits[0].decision).toBe('quarantined');
});

// --- descriptor validation -------------------------------------------------

test('validateDescriptor rejects bad shapes, accepts good', () => {
  expect(validateDescriptor(null).ok).toBe(false);
  expect(validateDescriptor({}).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p' }).ok).toBe(false); // no cmd
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/c', on_error: 'maybe' }).ok).toBe(false);
  const ok = validateDescriptor({ id: 'x', point: 'p', cmd: '/c', on_error: 'open', priority: 3 });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.descriptor.priority).toBe(3);
    expect(ok.descriptor.on_error).toBe('open');
  }
});

test('validateDescriptor rejects a RELATIVE/bare cmd (pin-vs-exec mismatch)', () => {
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: 'review' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: './hook.py' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/abs/hook.py' }).ok).toBe(true);
});

test('validateDescriptor rejects an id/point with shell metacharacters', () => {
  expect(validateDescriptor({ id: "x' && rm -rf ~ #", point: 'p', cmd: '/c' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p; evil', cmd: '/c' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'review-visual', point: 'pre-send-photo', cmd: '/c' }).ok).toBe(true);
});

test('validateDescriptor rejects non-string args entries', () => {
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/c', args: ['ok', 3] }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/c', args: ['--strict'] }).ok).toBe(true);
});

// --- invocation digest: cmd + args + timeout -------------------------------

test('invocationDigest differs when timeout_ms changes (a lowered timeout re-quarantines)', () => {
  // A trusted fail-open gate forced to time out becomes an allow; the pin must
  // notice a timeout edit just like an args swap, so the digest must change.
  const base = invocationDigest('/c', ['--strict'], 60000);
  const lowered = invocationDigest('/c', ['--strict'], 1);
  expect(lowered).not.toBe(base);
});

test('invocationDigest: undefined timeout is stable and distinct from any explicit one', () => {
  expect(invocationDigest('/c', ['--strict'])).toBe(invocationDigest('/c', ['--strict'], undefined));
  expect(invocationDigest('/c', ['--strict'])).not.toBe(invocationDigest('/c', ['--strict'], 0));
});

test('invocationDigest still catches an args repoint (unchanged behaviour)', () => {
  expect(invocationDigest('/python3', ['a.py'], 5000)).not.toBe(invocationDigest('/python3', ['b.py'], 5000));
});

test('resolveTrust (guard ON): a timeout edit re-quarantines a previously trusted hook', () => {
  // Pin made for the 60s descriptor; the descriptor now requests 1ms. cmd sha is
  // unchanged ('SHA') but the invocation digest no longer matches → re-trust.
  const sha256Str = (s: string): string => s; // identity so digests compare by value
  const pinnedInv = sha256Str(invocationDigest('/bin/hook', ['--strict'], 60000));
  const currentInv = sha256Str(invocationDigest('/bin/hook', ['--strict'], 1));
  const trust = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: pinnedInv,
      point: 'pre-send-photo',
      on_error: 'open' as const,
    },
  };
  const r = resolveTrust(desc({ args: ['--strict'], timeout_ms: 1 }), 'SHA', currentInv, {
    trust,
    trustAuto: false,
    untrustedGuard: true,
  });
  expect(r.state).toBe('quarantined-changed');
});

// --- AGENTS_HOOKS_TRUST parsing: guard and auto use the SAME normalization ---

test('trustAutoActive normalizes (trim + lowercase) like the guard check', () => {
  for (const v of ['auto', 'AUTO', ' auto ', 'Auto']) {
    expect(untrustedGuardActive({ AGENTS_HOOKS_TRUST: v } as NodeJS.ProcessEnv)).toBe(true);
    expect(trustAutoActive({ AGENTS_HOOKS_TRUST: v } as NodeJS.ProcessEnv)).toBe(true);
  }
});

test('trustAutoActive is false for the guarded-but-not-auto values', () => {
  for (const v of ['1', 'true', 'on', 'yes']) {
    expect(untrustedGuardActive({ AGENTS_HOOKS_TRUST: v } as NodeJS.ProcessEnv)).toBe(true);
    expect(trustAutoActive({ AGENTS_HOOKS_TRUST: v } as NodeJS.ProcessEnv)).toBe(false);
  }
  expect(trustAutoActive({} as NodeJS.ProcessEnv)).toBe(false);
});

// --- gate_* passthrough (generic audit extension any gate hook may report) ---

test('a hook that reports gate_* fields on stdout gets them copied into its audit line', () => {
  const { deps, audits } = mkDeps({
    untrustedGuard: false,
    spawn: () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        decision: 'allow',
        gate_tag: 'decision',
        gate_missing: 'table',
        gate_table_kind: 'none',
        gate_bypass: '',
        body_sha256: 'abc123',
        gate_version: '1',
      }),
      stderr: '',
      timedOut: false,
    }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(false);
  expect(audits).toHaveLength(1);
  expect(audits[0].gate_tag).toBe('decision');
  expect(audits[0].gate_missing).toBe('table');
  expect(audits[0].gate_table_kind).toBe('none');
  expect(audits[0].body_sha256).toBe('abc123');
  expect(audits[0].gate_version).toBe('1');
});

test('a hook that never reports gate_* fields leaves them undefined (audit line unchanged)', () => {
  const { deps, audits } = mkDeps({ untrustedGuard: false });
  runHooks([loaded()], evt, deps);
  expect(audits).toHaveLength(1);
  expect(audits[0].gate_tag).toBeUndefined();
  expect(audits[0].gate_missing).toBeUndefined();
  expect(audits[0].gate_table_kind).toBeUndefined();
  expect(audits[0].body_sha256).toBeUndefined();
  // JSON.stringify drops undefined keys, so the on-disk line stays flat —
  // this is what keeps a non-gate hook's audit output byte-identical.
  expect(JSON.stringify(audits[0])).not.toContain('gate_tag');
});

// --- audit.jsonl rotation (mirrors features/replies/history.ts's MAX_HISTORY) ---

test('trimAuditLines keeps a blob under the cap unchanged (besides a trailing newline)', () => {
  const raw = ['{"a":1}', '{"a":2}'].join('\n') + '\n';
  expect(trimAuditLines(raw, 5)).toBe(raw);
});

test('trimAuditLines drops the OLDEST lines once the cap is exceeded (FIFO by write order)', () => {
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i }));
  const raw = lines.join('\n') + '\n';
  const trimmed = trimAuditLines(raw, 3);
  const parsed = trimmed
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).n);
  expect(parsed).toEqual([7, 8, 9]); // last 3 writes survive
});

test('trimAuditLines drops blank lines and re-emits a single trailing newline', () => {
  const raw = '{"a":1}\n\n{"a":2}\n\n\n';
  expect(trimAuditLines(raw, 100)).toBe('{"a":1}\n{"a":2}\n');
});

test('trimAuditLines of an empty/blank blob returns empty string', () => {
  expect(trimAuditLines('', 100)).toBe('');
  expect(trimAuditLines('\n\n', 100)).toBe('');
});
