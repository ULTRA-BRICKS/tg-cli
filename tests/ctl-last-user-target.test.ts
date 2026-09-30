import { expect, test } from 'bun:test';
import { parseLastUserTarget, serializeLastUserTarget, withSessionKey } from '../features/tg-ctl/last-user-target';

// tg-cli#78 anchor fix: pure serialization tests for the store's parse/write
// contract. Integration coverage (the daemon actually recording/resolving
// against this store) lives in ctl-ambiguous-picker-integration.test.ts and
// ctl-reply-misroute-integration.test.ts.

test('parseLastUserTarget: null raw → null', () => {
  expect(parseLastUserTarget(null)).toBeNull();
});

test('parseLastUserTarget: empty string → null', () => {
  expect(parseLastUserTarget('')).toBeNull();
});

test('parseLastUserTarget: malformed JSON → null (never throws)', () => {
  expect(parseLastUserTarget('{not valid json')).toBeNull();
});

test('parseLastUserTarget: JSON that is not an object → null', () => {
  expect(parseLastUserTarget('42')).toBeNull();
  expect(parseLastUserTarget('"a string"')).toBeNull();
  expect(parseLastUserTarget('[1,2,3]')).toBeNull();
  expect(parseLastUserTarget('null')).toBeNull();
});

test('parseLastUserTarget: missing paneId → null', () => {
  expect(parseLastUserTarget(JSON.stringify({ ts: 100 }))).toBeNull();
});

test('parseLastUserTarget: non-string paneId → null', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: 5, ts: 100 }))).toBeNull();
});

test('parseLastUserTarget: missing ts → null', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: '%5', cwd: '/x' }))).toBeNull();
});

test('parseLastUserTarget: missing cwd → null (required, not optional — invalid states are not representable)', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: '%5', ts: 100 }))).toBeNull();
});

test('parseLastUserTarget: non-string cwd → null', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: '%5', cwd: 42, ts: 100 }))).toBeNull();
});

test('parseLastUserTarget: empty-string cwd → null (not just wrong type — review finding)', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: '%5', cwd: '', ts: 100 }))).toBeNull();
});

test('parseLastUserTarget: empty-string paneId → null', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: '', cwd: '/x', ts: 100 }))).toBeNull();
});

test('parseLastUserTarget: non-number ts → null', () => {
  expect(parseLastUserTarget(JSON.stringify({ paneId: '%5', ts: 'now' }))).toBeNull();
});

test('parseLastUserTarget: non-finite ts (NaN/Infinity) → null', () => {
  // NaN isn't valid JSON (JSON.parse throws, caught before Number.isFinite runs)
  // and JSON.stringify({ts: Infinity}) serializes ts as `null` (rejected by the
  // `typeof rec.ts !== 'number'` check, not isFinite) — both inputs are also
  // missing `cwd`, so all three cases reject for reasons OTHER than the
  // !Number.isFinite branch itself. Kept as documentation of those paths.
  expect(parseLastUserTarget('{"paneId":"%5","ts":NaN}')).toBeNull();
  expect(parseLastUserTarget(JSON.stringify({ paneId: '%5', ts: Infinity }))).toBeNull();
});

test('parseLastUserTarget: ts that overflows to Infinity via valid JSON → null (actually exercises !Number.isFinite, review finding)', () => {
  // `1e999` IS valid JSON syntax that parses to the JS value Infinity — unlike
  // the literal `Infinity`/`NaN` tokens above (invalid JSON) or a stringified
  // Infinity (which serializes to `null`), this is the one input that actually
  // reaches and is rejected by the `!Number.isFinite(rec.ts)` branch.
  expect(parseLastUserTarget('{"paneId":"%5","cwd":"/x","ts":1e999}')).toBeNull();
});

test('parseLastUserTarget: valid record round-trips', () => {
  const target = { paneId: '%5', cwd: '/Users/x/proj', ts: 12345 };
  expect(parseLastUserTarget(serializeLastUserTarget(target))).toEqual(target);
});

test('serializeLastUserTarget: produces valid JSON parseable by parseLastUserTarget', () => {
  const target = { paneId: '%2', cwd: '/Users/x/proj', ts: 999 };
  const raw = serializeLastUserTarget(target);
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(parseLastUserTarget(raw)).toEqual(target);
});

// A confirmed delivery rewrites the anchor; its session registry key must survive
// the rewrite (#487): the registry's fresh answer wins, else the current anchor's
// key carries over while it names the same pane and project.
test('withSessionKey: the registry key wins; otherwise a same pane+cwd anchor keeps its key', () => {
  const next = { paneId: '%2', cwd: '/w/a', ts: 9 };
  const current = { paneId: '%2', cwd: '/w/a', ts: 1, sessionKey: 'omp:old' };
  expect(withSessionKey(next, 'omp:fresh', () => current)).toEqual({ ...next, sessionKey: 'omp:fresh' });
  expect(withSessionKey(next, null, () => current)).toEqual({ ...next, sessionKey: 'omp:old' });
  expect(withSessionKey(next, null, () => ({ ...current, cwd: '/w/b' }))).toEqual(next);
  expect(withSessionKey(next, null, () => ({ ...current, paneId: '%3' }))).toEqual(next);
  expect(withSessionKey(next, null, () => null)).toEqual(next);
});
