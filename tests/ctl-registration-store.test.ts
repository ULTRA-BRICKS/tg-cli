// Per-pane registration SET (tg-cli#67). The store keeps one entry PER agent
// session keyed by paneId, so concurrent sessions register side by side instead
// of clobbering one global slot. These unit tests pin the parse/upsert/prune/
// query contract; ctl-multi-session-forward-integration.test.ts asserts the
// end-to-end daemon behavior (every session's questions forward).

import { expect, test } from 'bun:test';
import {
  MAX_REGISTRATIONS,
  parseRegistrations,
  pruneRegistrations,
  registrationKey,
  serializeRegistrations,
  upsertRegistration,
} from '../features/tg-ctl/registration-store';
import { registrationSetAllowsHook } from '../features/tg-ctl/questions';
import type { Registration } from '../features/tg-ctl/types';

test('parseRegistrations reads the array form', () => {
  const raw = JSON.stringify([
    { paneId: '%2', cwd: '/a' },
    { paneId: '%3', cwd: '/b', sessionName: 'work' },
  ]);
  expect(parseRegistrations(raw)).toEqual([
    { paneId: '%2', cwd: '/a' },
    { paneId: '%3', cwd: '/b', sessionName: 'work' },
  ]);
});

test('parseRegistrations migrates the LEGACY single-object form (back-compat)', () => {
  // A daemon upgraded in place must keep the live registration the prior version
  // wrote as a bare object — not lose it on the first read.
  const raw = JSON.stringify({ paneId: '%2', cwd: '/a', registeredAt: 123 });
  expect(parseRegistrations(raw)).toEqual([{ paneId: '%2', cwd: '/a', registeredAt: 123 }]);
});

test('parseRegistrations is fail-soft on garbage and empty', () => {
  expect(parseRegistrations(null)).toEqual([]);
  expect(parseRegistrations('not json')).toEqual([]);
  expect(parseRegistrations('123')).toEqual([]);
  expect(parseRegistrations('[]')).toEqual([]);
  // An entry with no identifying field at all is dropped (it can never match).
  expect(parseRegistrations(JSON.stringify([{ registeredAt: 5 }, { paneId: '%2' }]))).toEqual([
    { paneId: '%2' },
  ]);
});

test('registrationKey: paneId is the key; paneless entries have none', () => {
  expect(registrationKey({ paneId: '%2', cwd: '/a' })).toBe('%2');
  expect(registrationKey({ cwd: '/a' })).toBe(null);
  expect(registrationKey({ paneId: '' })).toBe(null);
});

test('upsertRegistration adds a NEW pane without dropping the others', () => {
  const a: Registration = { paneId: '%2', cwd: '/a' };
  const b: Registration = { paneId: '%3', cwd: '/b' };
  const after = upsertRegistration([a], b);
  expect(after).toEqual([a, b]);
});

test('upsertRegistration replaces ONLY the same pane (re-register is per-entry)', () => {
  const a: Registration = { paneId: '%2', cwd: '/a' };
  const b: Registration = { paneId: '%3', cwd: '/b' };
  const aPrime: Registration = { paneId: '%2', cwd: '/a-moved', registeredAt: 99 };
  const after = upsertRegistration([a, b], aPrime);
  // %3 survives untouched; %2's entry is updated in place (appended at the tail).
  expect(after).toEqual([b, aPrime]);
});

test('upsertRegistration: a paneless entry collapses to a single fallback slot', () => {
  const first: Registration = { cwd: '/a' };
  const second: Registration = { cwd: '/b' };
  // Two paneless registrations cannot be distinguished — the newer replaces the
  // older (the old single-slot behavior, preserved for the no-pane case). A
  // pane-keyed entry is never disturbed by a paneless upsert.
  const keyed: Registration = { paneId: '%9', cwd: '/c' };
  expect(upsertRegistration([first, keyed], second)).toEqual([keyed, second]);
});

test('upsertRegistration caps the store at MAX_REGISTRATIONS (oldest fall off)', () => {
  let store: Registration[] = [];
  for (let i = 0; i < MAX_REGISTRATIONS + 5; i++) {
    store = upsertRegistration(store, { paneId: `%${i}` });
  }
  expect(store.length).toBe(MAX_REGISTRATIONS);
  expect(store[0].paneId).toBe('%5'); // the first 5 were evicted
});

test('pruneRegistrations drops dead-pane entries by liveness', () => {
  const store: Registration[] = [
    { paneId: '%2', cwd: '/a' },
    { paneId: '%3', cwd: '/b' },
    { cwd: '/fallback' }, // paneless — never pruned
  ];
  const live = new Set(['%2']); // %3 is gone
  expect(pruneRegistrations(store, live)).toEqual([
    { paneId: '%2', cwd: '/a' },
    { cwd: '/fallback' },
  ]);
});

test('pruneRegistrations keeps a LIVE entry even when many dead entries precede it', () => {
  // Regression guard for the cap-evicts-live-session bug: prune by liveness must
  // drop the dead entries so the cap (insertion-order eviction) never has a
  // chance to evict the operator's still-live main session.
  const store: Registration[] = [];
  for (let i = 0; i < MAX_REGISTRATIONS - 1; i++) store.push({ paneId: `%dead${i}` });
  store.push({ paneId: '%live', cwd: '/main' }); // the operator's live session, registered last
  const pruned = pruneRegistrations(store, new Set(['%live']));
  expect(pruned).toEqual([{ paneId: '%live', cwd: '/main' }]);
});

test('pruneRegistrations NEVER prunes on a null (missing/flaky) snapshot', () => {
  // An empty/flaky tmux read must not wipe every live session at once.
  const store: Registration[] = [{ paneId: '%2' }, { paneId: '%3' }];
  expect(pruneRegistrations(store, null)).toEqual(store);
});

test('serializeRegistrations round-trips through parseRegistrations', () => {
  const store: Registration[] = [
    { paneId: '%2', cwd: '/a', registeredAt: 1 },
    { paneId: '%3', cwd: '/b', sessionName: 's' },
  ];
  expect(parseRegistrations(serializeRegistrations(store))).toEqual(store);
});

test('registrationSetAllowsHook: a question forwards when ITS pane matches ANY entry', () => {
  const regs: Registration[] = [
    { paneId: '%2', cwd: '/a' },
    { paneId: '%3', cwd: '/b' },
  ];
  // Either registered session's question forwards.
  expect(registrationSetAllowsHook(regs, { paneId: '%2' })).toBe(true);
  expect(registrationSetAllowsHook(regs, { paneId: '%3' })).toBe(true);
  // A pane that is NOT registered does not forward.
  expect(registrationSetAllowsHook(regs, { paneId: '%9' })).toBe(false);
});

test('registrationSetAllowsHook preserves the paneId-authoritative reject (#per-entry rule)', () => {
  // A second keyboard session in the SAME cwd but a DIFFERENT pane must NOT
  // forward off the cwd of an entry whose pane contradicts it — the per-entry
  // guard still rejects on a pane mismatch.
  const regs: Registration[] = [{ paneId: '%2', cwd: '/proj' }];
  expect(registrationSetAllowsHook(regs, { paneId: '%40', cwd: '/proj' })).toBe(false);
});

test('registrationSetAllowsHook on an EMPTY set fails closed', () => {
  expect(registrationSetAllowsHook([], { paneId: '%2' })).toBe(false);
});

// A `tg start` re-run in the same pane and project rewrites that pane's row; the
// session registry key the migration gave it must survive the rewrite (#487).
test('upsertRegistration keeps the replaced row\'s sessionKey only while pane and cwd are unchanged', () => {
  const keyed: Registration = { paneId: '%1', cwd: '/w/a', registeredAt: 1, sessionKey: 'omp:s1' };
  expect(upsertRegistration([keyed], { paneId: '%1', cwd: '/w/a', registeredAt: 2 })).toEqual([
    { paneId: '%1', cwd: '/w/a', registeredAt: 2, sessionKey: 'omp:s1' },
  ]);
  expect(upsertRegistration([keyed], { paneId: '%1', cwd: '/w/b', registeredAt: 2 })).toEqual([
    { paneId: '%1', cwd: '/w/b', registeredAt: 2 },
  ]);
  expect(upsertRegistration([keyed], { paneId: '%1', cwd: '/w/a', registeredAt: 2, sessionKey: 'omp:s2' })).toEqual([
    { paneId: '%1', cwd: '/w/a', registeredAt: 2, sessionKey: 'omp:s2' },
  ]);
});
