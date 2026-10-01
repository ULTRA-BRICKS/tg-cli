// Unit tests for the hatch late-approval grant protocol v1.1 (tg-cli#398):
// features/tg-ctl/grants.ts (PURE store + decisions) and the ADDITIVE ask-payload
// fields (hookId/timeoutMs/origin/operation) threaded through BOTH normalizers
// (hook-normalize.ts's already-normalized passthrough and tg-ctl's authoritative
// normalizeButtonRequest).
//
// The persisted GRANT record uses contract §4's exact snake_case field names
// (approval_id/request_id/hook_id/approved_at/expires_at/consumed_at) — the on-disk
// JSON IS the cross-repo contract surface, so the TypeScript interface mirrors it
// verbatim instead of camelCasing and remapping at the boundary.
import { expect, test } from 'bun:test';
import {
  GRANT_ID_RE,
  buildGraceRecord,
  buildGrantRecord,
  closeDecidedCard,
  dropSettledDecided,
  hatchDenyNoticeText,
  hatchGrantNoticeText,
  operationMatches,
  parseGrantStore,
  pruneGrantStore,
  serializeGrantStore,
  upsertGraceRecord,
  verifyGrant,
  type GraceRecord,
  type GrantRecord,
  type GrantStoreData,
} from '../features/tg-ctl/grants';
import { normalizeHookPayload, type HookEnv } from '../features/tg-ctl/hook-normalize';
import { ASK_TIMEOUT_MAX_MS, clampRequestTimeoutMs, type ButtonRequest } from '../features/tg-ctl/questions';
import { hasUnpairedSurrogate } from '../features/tg-ctl/text-util';
import { normalizeButtonRequest } from '../tg-ctl';

const NOW = 1_800_000_000_000; // fixed clock for determinism
const HOOK_ID = 'test-hook';
const REQUEST_ID = `hatch-${HOOK_ID}-aaaaaaaaaaaa`;

function hatchReq(extra: Partial<ButtonRequest> = {}): ButtonRequest {
  return {
    requestId: REQUEST_ID,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    hookId: HOOK_ID,
    ...extra,
  };
}

function grant(extra: Partial<GrantRecord> = {}): GrantRecord {
  return {
    approval_id: 'hgr-0123456789ab',
    request_id: REQUEST_ID,
    hook_id: HOOK_ID,
    operation: { kind: 'bash', fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' },
    approved_at: NOW,
    expires_at: NOW + 24 * 60 * 60_000,
    consumed_at: null,
    ...extra,
  };
}

// --- id shape ---

test('grant id shape: hgr- + 12 lowercase hex', () => {
  expect(GRANT_ID_RE.test('hgr-0123456789ab')).toBe(true);
  expect(GRANT_ID_RE.test('hgr-0123456789AB')).toBe(false);
  expect(GRANT_ID_RE.test('hgr-short')).toBe(false);
  expect(GRANT_ID_RE.test('xyz-0123456789ab')).toBe(false);
});

// --- operationMatches: the verify-grant binding (fail-closed) ---

test('operationMatches: identical fingerprint + cwd (+ repoRoot) matches', () => {
  expect(
    operationMatches(
      { kind: 'bash', fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' },
      { kind: 'bash', fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' },
    ),
  ).toBe(true);
});

test('operationMatches: a fingerprint mismatch does NOT match (a typo must not burn the grant)', () => {
  expect(
    operationMatches({ fingerprint: 'fp1', cwd: '/repo' }, { fingerprint: 'fp2', cwd: '/repo' }),
  ).toBe(false);
});

test('operationMatches: a cwd mismatch does NOT match', () => {
  expect(
    operationMatches({ fingerprint: 'fp1', cwd: '/repo' }, { fingerprint: 'fp1', cwd: '/other' }),
  ).toBe(false);
});

test('operationMatches: repoRoot is compared only when BOTH sides carry it', () => {
  const g = { fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' };
  expect(operationMatches(g, { fingerprint: 'fp1', cwd: '/repo' })).toBe(true); // one-sided repoRoot: skipped
  expect(operationMatches(g, { fingerprint: 'fp1', cwd: '/repo', repoRoot: '/elsewhere' })).toBe(false);
});

test('operationMatches: missing operation on EITHER side never matches (deny-by-default)', () => {
  expect(operationMatches(undefined, { fingerprint: 'fp1', cwd: '/repo' })).toBe(false);
  expect(operationMatches({ fingerprint: 'fp1', cwd: '/repo' }, undefined)).toBe(false);
  expect(operationMatches({ cwd: '/repo' }, { fingerprint: 'fp1', cwd: '/repo' })).toBe(false); // no fingerprint
  expect(operationMatches({ fingerprint: 'fp1' }, { fingerprint: 'fp1' })).toBe(false); // no cwd
});

// --- verifyGrant: single-use, 24h expiry, bound to hook_id + operation ---

test('verifyGrant: a valid, unconsumed, unexpired, fully-matching grant allows', () => {
  const g = grant();
  const out = verifyGrant([g], g.approval_id, HOOK_ID, { kind: 'bash', fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' }, NOW + 1000);
  expect(out).toEqual({ kind: 'allow', grant: g });
});

test('verifyGrant: unknown approval id denies', () => {
  const out = verifyGrant([grant()], 'hgr-ffffffffffff', HOOK_ID, { fingerprint: 'fp1', cwd: '/repo' }, NOW + 1000);
  expect(out).toEqual({ kind: 'deny', reason: 'unknown-approval' });
});

test('verifyGrant: an already-consumed grant denies (single-use)', () => {
  const g = grant({ consumed_at: NOW + 500 });
  const out = verifyGrant([g], g.approval_id, HOOK_ID, { fingerprint: 'fp1', cwd: '/repo' }, NOW + 1000);
  expect(out).toEqual({ kind: 'deny', reason: 'already-consumed' });
});

test('verifyGrant: an expired grant denies', () => {
  const g = grant();
  const out = verifyGrant([g], g.approval_id, HOOK_ID, { fingerprint: 'fp1', cwd: '/repo' }, g.expires_at + 1);
  expect(out).toEqual({ kind: 'deny', reason: 'expired' });
});

test('verifyGrant: a hook_id mismatch denies', () => {
  const g = grant();
  const out = verifyGrant([g], g.approval_id, 'other-hook', { fingerprint: 'fp1', cwd: '/repo' }, NOW + 1000);
  expect(out).toEqual({ kind: 'deny', reason: 'hook-mismatch' });
});

test('verifyGrant: an operation mismatch denies and does NOT consume (verifyGrant is pure — consumption is the caller\'s job, only on allow)', () => {
  const g = grant();
  const out = verifyGrant([g], g.approval_id, HOOK_ID, { fingerprint: 'fp2', cwd: '/repo' }, NOW + 1000);
  expect(out).toEqual({ kind: 'deny', reason: 'operation-mismatch' });
  expect(g.consumed_at).toBeNull(); // untouched by a deny
});

// --- grace records ---

test('buildGraceRecord: expiry + 24h grace window, carrying the full request for later re-validation', () => {
  const req = hatchReq();
  const rec = buildGraceRecord(req, 'cbkey', HOOK_ID, 'pane:42', 42, NOW, 24 * 60 * 60_000);
  expect(rec.key).toBe('cbkey');
  expect(rec.requestId).toBe(REQUEST_ID);
  expect(rec.hookId).toBe(HOOK_ID);
  expect(rec.route).toBe('pane:42');
  expect(rec.messageId).toBe(42);
  expect(rec.expiredAt).toBe(NOW);
  expect(rec.graceExpiresAt).toBe(NOW + 24 * 60 * 60_000);
  expect(rec.req.requestId).toBe(REQUEST_ID);
});

test('upsertGraceRecord: same callback key replaces (re-retire never duplicates)', () => {
  const req = hatchReq();
  const a = buildGraceRecord(req, 'cbkey', HOOK_ID, 'pane:1', 1, NOW, 1000);
  const b = buildGraceRecord(req, 'cbkey', HOOK_ID, 'pane:2', 2, NOW + 5, 1000);
  const grace: GraceRecord[] = [a];
  upsertGraceRecord(grace, b);
  expect(grace).toHaveLength(1);
  expect(grace[0].messageId).toBe(2);
});

test('buildGrantRecord: grant mirrors contract §4 fields byte-for-byte', () => {
  const req = hatchReq({ origin: { agent: 'omp', sessionId: 's1' }, operation: { fingerprint: 'fp1', cwd: '/repo' } });
  const g = buildGrantRecord(req, 'hgr-abcdef012345', 'acp:s1', NOW, 24 * 60 * 60_000);
  expect(g.approval_id).toBe('hgr-abcdef012345');
  expect(g.request_id).toBe(REQUEST_ID);
  expect(g.hook_id).toBe(HOOK_ID);
  expect(g.origin).toEqual({ agent: 'omp', sessionId: 's1' });
  expect(g.operation).toEqual({ fingerprint: 'fp1', cwd: '/repo' });
  expect(g.route).toBe('acp:s1');
  expect(g.approved_at).toBe(NOW);
  expect(g.expires_at).toBe(NOW + 24 * 60 * 60_000);
  expect(g.consumed_at).toBeNull();
});

// --- store (de)serialization: fail-soft, versioned, pruned ---

test('grant store roundtrip: serialize → parse preserves grace + grants + decided cards with contract field names on disk', () => {
  const data = {
    grace: [buildGraceRecord(hatchReq(), 'cbkey', HOOK_ID, 'inbox:cwd-x', 7, NOW, 24 * 60 * 60_000)],
    grants: [grant()],
    decided: [{ key: 'cbkey-denied', decision: 'deny' as const, decidedAt: NOW, expiresAt: NOW + 1000 }],
  };
  const raw = serializeGrantStore(data, NOW);
  // The on-disk JSON carries the contract's snake_case grant fields verbatim.
  const onDisk = JSON.parse(raw) as { grants: Array<Record<string, unknown>> };
  expect(onDisk.grants[0].approval_id).toBe('hgr-0123456789ab');
  expect(onDisk.grants[0].request_id).toBe(REQUEST_ID);
  expect(onDisk.grants[0].hook_id).toBe(HOOK_ID);
  expect(onDisk.grants[0].consumed_at).toBeNull();
  const parsed = parseGrantStore(raw, NOW);
  expect(parsed.grace).toHaveLength(1);
  expect(parsed.grace[0].requestId).toBe(REQUEST_ID);
  expect(parsed.grants).toHaveLength(1);
  expect(parsed.grants[0].approval_id).toBe('hgr-0123456789ab');
  // A Deny's record survives the restart that must not re-open its card (tg-cli#433).
  expect(parsed.decided).toEqual(data.decided);
});

test('grant store parse: garbage / unknown version / null degrade to empty, never throw', () => {
  const empty = { grace: [], grants: [], decided: [] };
  expect(parseGrantStore('not json', NOW)).toEqual(empty);
  expect(parseGrantStore('{"version":99}', NOW)).toEqual(empty);
  expect(parseGrantStore(null, NOW)).toEqual(empty);
  expect(parseGrantStore('{"version":1,"grants":[{"approval_id":5}],"decided":[{"key":"k","decision":"maybe"}]}', NOW)).toEqual(empty);
});

test('grant store prune: past-grace records, expired grants and expired decided cards are dropped (parse AND serialize)', () => {
  const data = {
    grace: [buildGraceRecord(hatchReq(), 'cbkey', HOOK_ID, 7, NOW - 2000, 1000)], // grace closed 1000ms ago
    grants: [grant({ expires_at: NOW - 1 })], // expired
    decided: [{ key: 'cbkey', decision: 'deny' as const, decidedAt: NOW - 2000, expiresAt: NOW - 1 }], // expired
  };
  const empty = { grace: [], grants: [], decided: [] };
  expect(parseGrantStore(serializeGrantStore(data, NOW), NOW)).toEqual(empty);
  const inMemory = { grace: [...data.grace], grants: [...data.grants], decided: [...data.decided] };
  pruneGrantStore(inMemory, NOW);
  expect(inMemory).toEqual(empty);
});

// A late Deny revokes an unused grant through its card's grace record, and the grant lives
// 24h from the Approve — past the grace window when the Approve came late in it.
test('grant store prune: a past-grace record outlives its window while its card has an unused grant', () => {
  const pastGrace = buildGraceRecord(hatchReq(), 'cbkey', HOOK_ID, null, 7, NOW - 2000, 1000);
  const withUnused = { grace: [pastGrace], grants: [grant()], decided: [] };
  pruneGrantStore(withUnused, NOW);
  expect(withUnused.grace).toHaveLength(1);

  const withUsed = { grace: [pastGrace], grants: [grant({ consumed_at: NOW - 1 })], decided: [] };
  pruneGrantStore(withUsed, NOW);
  expect(withUsed.grace).toHaveLength(0);
});

// A critical ask waits without limit, so its decided card's record has no expiry: it
// survives any restart while a copy of the card is on disk, and only then.
test('grant store: a decided card with no expiry survives parse and prune until its card leaves the questions store', () => {
  const forever = { key: 'crit', decision: 'deny' as const, decidedAt: NOW - 1, expiresAt: null };
  const timed = { key: 'timed', decision: 'deny' as const, decidedAt: NOW - 1, expiresAt: NOW + 1000 };
  const later = NOW + 365 * 24 * 60 * 60_000;
  expect(parseGrantStore(serializeGrantStore({ grace: [], grants: [], decided: [forever] }, NOW), later).decided).toEqual([forever]);
  // A record with no expiresAt at all is malformed, not "no expiry".
  expect(parseGrantStore('{"version":1,"decided":[{"key":"k","decision":"deny","decidedAt":1}]}', NOW).decided).toEqual([]);

  const data: GrantStoreData = { grace: [], grants: [], decided: [forever, timed] };
  expect(dropSettledDecided(data, new Set(['crit']))).toBe(false);
  expect(data.decided).toEqual([forever, timed]);
  // A timed record is the prune's business, never dropped for a missing card.
  expect(dropSettledDecided(data, new Set())).toBe(true);
  expect(data.decided).toEqual([timed]);
});

test('closeDecidedCard: retires the grace record and records the decision; the undo restores both', () => {
  const grace = buildGraceRecord(hatchReq(), 'k', HOOK_ID, null, 7, NOW - 10, 1000);
  const data: GrantStoreData = {
    grace: [grace],
    grants: [],
    decided: [{ key: 'k', decision: 'allow', decidedAt: NOW - 5, expiresAt: NOW + 5 }],
  };
  const prior = data.decided[0];
  const undoReplace = closeDecidedCard(data, 'k', 'deny', NOW, 1000);
  expect(data.grace).toEqual([]);
  expect(data.decided).toEqual([{ key: 'k', decision: 'deny', decidedAt: NOW, expiresAt: NOW + 1000 }]);
  undoReplace();
  expect(data.grace).toEqual([grace]);
  expect(data.decided).toEqual([prior]);

  const undoAdd = closeDecidedCard(data, 'other', 'deny', NOW, 1000);
  expect(data.grace).toEqual([grace]);
  expect(data.decided.map((d) => d.key)).toEqual(['k', 'other']);
  undoAdd();
  expect(data.decided).toEqual([prior]);
});

test('grant store parse: a consumed-but-unexpired grant survives (single-use proof across restarts)', () => {
  const g = grant({ consumed_at: NOW + 10 });
  const parsed = parseGrantStore(serializeGrantStore({ grace: [], grants: [g], decided: [] }, NOW), NOW + 20);
  expect(parsed.grants).toHaveLength(1);
  expect(parsed.grants[0].consumed_at).toBe(NOW + 10);
});

// --- the contract §4 routed message ---

test('hatchGrantNoticeText: exact consume semantics — same op once, same dir, env var with approved:<id>, single-use, expiry', () => {
  const text = hatchGrantNoticeText({
    requestId: REQUEST_ID,
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    hookId: HOOK_ID,
    approvalId: 'hgr-0123456789ab',
    approvedAt: NOW,
    expiresAt: NOW + 24 * 60 * 60_000,
  });
  expect(text).toContain(`hatch request ${REQUEST_ID}`);
  expect(text).toContain(`(Allow rig hatch escalation: ${HOOK_ID}?)`);
  expect(text).toContain('APPROVED belatedly by the user');
  expect(text).toContain('retry the SAME blocked operation ONCE, in the SAME directory');
  expect(text).toContain('RIG_HATCH_REQUEST_TEST_HOOK="approved:hgr-0123456789ab"');
  expect(text).toContain('ONLY if you have not already achieved the same goal another way');
  expect(text).toContain('single-use');
  expect(text).toContain(new Date(NOW + 24 * 60 * 60_000).toISOString());
});

test('hatchGrantNoticeText: a multi-line/novel-length question is clamped to one short line', () => {
  const text = hatchGrantNoticeText({
    requestId: REQUEST_ID,
    question: `line one\nline two ${'x'.repeat(300)}`,
    hookId: HOOK_ID,
    approvalId: 'hgr-0123456789ab',
    approvedAt: NOW,
    expiresAt: NOW + 1000,
  });
  expect(text).not.toContain('line two');
  expect(text.split('\n')).toHaveLength(1);
});

// tg-cli#433 item 5: the clamp must never leave half of a surrogate pair (an emoji
// straddling the cut) — the downstream consumer would get invalid UTF-16 text.
test('both routed notices clamp the question without orphaning a surrogate half', () => {
  // Slide the emoji across every cut position near the 120-unit clamp.
  for (let at = 110; at <= 122; at += 1) {
    const question = `${'x'.repeat(at)}😀${'y'.repeat(20)} tail`;
    const grantNotice = hatchGrantNoticeText({
      requestId: REQUEST_ID,
      question,
      hookId: HOOK_ID,
      approvalId: 'hgr-0123456789ab',
      approvedAt: NOW,
      expiresAt: NOW + 1000,
    });
    const denyNotice = hatchDenyNoticeText({ requestId: REQUEST_ID, question, deniedAt: NOW, revokedApprovalId: null });
    for (const text of [grantNotice, denyNotice]) {
      expect(text).not.toContain(' tail');
      expect(hasUnpairedSurrogate(text)).toBe(false);
    }
  }
});

// --- per-request timeoutMs (contract §1: cap 15 min, absent → 115s default) ---

test('clampRequestTimeoutMs: absent/invalid → fallback (the unchanged 115s/110s defaults)', () => {
  expect(clampRequestTimeoutMs(undefined, 115_000)).toBe(115_000);
  expect(clampRequestTimeoutMs(0, 115_000)).toBe(115_000);
  expect(clampRequestTimeoutMs(-5, 115_000)).toBe(115_000);
  expect(clampRequestTimeoutMs(Number.NaN, 115_000)).toBe(115_000);
});

test('clampRequestTimeoutMs: honored within the 15-min cap, clamped beyond it', () => {
  expect(clampRequestTimeoutMs(600_000, 115_000)).toBe(600_000); // the hatch ask value
  expect(clampRequestTimeoutMs(ASK_TIMEOUT_MAX_MS, 115_000)).toBe(ASK_TIMEOUT_MAX_MS);
  expect(clampRequestTimeoutMs(ASK_TIMEOUT_MAX_MS + 1, 115_000)).toBe(ASK_TIMEOUT_MAX_MS);
  expect(ASK_TIMEOUT_MAX_MS).toBe(15 * 60_000);
});

// --- additive field tolerance (contract §3): BOTH normalizers carry the fields ---

const ENV: HookEnv = { agent: 'claude', invocationNonce: 'nonce-1' };

test('normalizeHookPayload passthrough: carries hookId/timeoutMs/origin/operation (new lib → new daemon)', () => {
  const req = normalizeHookPayload(
    {
      requestId: REQUEST_ID,
      agent: 'claude',
      kind: 'permission',
      question: 'Allow rig hatch escalation?',
      hookId: HOOK_ID,
      timeoutMs: 600_000,
      origin: { agent: 'omp', sessionId: 'sess-1', subagent: 'worker' },
      operation: { kind: 'bash', fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' },
    },
    ENV,
  );
  expect(req).not.toBeNull();
  expect(req!.hookId).toBe(HOOK_ID);
  expect(req!.timeoutMs).toBe(600_000);
  expect(req!.origin).toEqual({ agent: 'omp', sessionId: 'sess-1', subagent: 'worker' });
  expect(req!.operation).toEqual({ kind: 'bash', fingerprint: 'fp1', cwd: '/repo', repoRoot: '/repo' });
});

test('normalizeHookPayload passthrough: an OLD payload without the additive fields still normalizes (undefined, never rejected)', () => {
  const req = normalizeHookPayload(
    { requestId: REQUEST_ID, agent: 'claude', kind: 'permission', question: 'Allow rig hatch escalation?' },
    ENV,
  );
  expect(req).not.toBeNull();
  expect(req!.hookId).toBeUndefined();
  expect(req!.timeoutMs).toBeUndefined();
  expect(req!.origin).toBeUndefined();
  expect(req!.operation).toBeUndefined();
});

test('normalizeButtonRequest (daemon authoritative): same additive tolerance, malformed subfields dropped not rejected', () => {
  const req = normalizeButtonRequest({
    requestId: REQUEST_ID,
    agent: 'claude',
    kind: 'permission',
    question: 'Allow rig hatch escalation?',
    hookId: HOOK_ID,
    timeoutMs: 600_000,
    origin: { agent: 'omp', sessionId: 'sess-1', subagent: 5 }, // non-string subfield dropped
    operation: { kind: 'bash', fingerprint: 'fp1', cwd: '/repo' },
  });
  expect(req).not.toBeNull();
  expect(req!.hookId).toBe(HOOK_ID);
  expect(req!.timeoutMs).toBe(600_000);
  expect(req!.origin).toEqual({ agent: 'omp', sessionId: 'sess-1' });
  expect(req!.operation).toEqual({ kind: 'bash', fingerprint: 'fp1', cwd: '/repo' });

  const old = normalizeButtonRequest({ requestId: REQUEST_ID, agent: 'claude', kind: 'permission', question: 'q' });
  expect(old).not.toBeNull();
  expect(old!.hookId).toBeUndefined();
  expect(old!.operation).toBeUndefined();

  const badTimeout = normalizeButtonRequest({
    requestId: REQUEST_ID, agent: 'claude', kind: 'permission', question: 'q', timeoutMs: -1,
  });
  expect(badTimeout!.timeoutMs).toBeUndefined();
});
