import { expect, test } from 'bun:test';
import {
  AWARENESS_NUDGE_THRESHOLD_MS,
  lastTgSentAtByKey,
  markAwarenessNudgeSent,
  parseAwarenessNudgeStore,
  planAwarenessNudges,
  serializeAwarenessNudgeStore,
  type AwarenessNudgeStore,
} from '../features/tg-ctl/tg-awareness-nudge';
import type { HistoryRecord } from '../features/replies/history';

const NOW = 1_720_000_000_000; // ms epoch, arbitrary fixed instant
const HOUR = 60 * 60 * 1000;

test('an agent silent for over an hour with no prior tg activity is nudged exactly once', () => {
  const key = 'omp:4242';
  const store: AwarenessNudgeStore = { [key]: { firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: null } };
  const first = planAwarenessNudges([key], new Map(), store, NOW);
  expect(first.due).toEqual([key]);
  // The send SUCCEEDS — the caller commits the nudge via markAwarenessNudgeSent.
  const sentStore = markAwarenessNudgeSent(first.store, first.due, NOW);
  // Re-running the SAME sweep (nothing changed — still no tg send) must NOT re-nudge.
  const second = planAwarenessNudges([key], new Map(), sentStore, NOW + 1000);
  expect(second.due).toEqual([]);
});

test('a FAILED nudge delivery does not consume the silence episode — stays due next sweep', () => {
  const key = 'omp:501';
  const store: AwarenessNudgeStore = { [key]: { firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: null } };
  const first = planAwarenessNudges([key], new Map(), store, NOW);
  expect(first.due).toEqual([key]);
  // The send FAILS — the caller never calls markAwarenessNudgeSent, so
  // first.store (persisted as-is) must NOT have recorded a nudge.
  const second = planAwarenessNudges([key], new Map(), first.store, NOW + 1000);
  expect(second.due).toEqual([key]);
});

test('markAwarenessNudgeSent marks only the given keys, keyed off their current lastTgSentAt', () => {
  const key = 'omp:7';
  const other = 'omp:8';
  const store: AwarenessNudgeStore = {
    [key]: { firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: null },
    [other]: { firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: NOW - 90 * 60 * 1000 },
  };
  const updated = markAwarenessNudgeSent(store, [key], NOW);
  expect(updated[key]).toEqual({ firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: null, lastNudgedAt: NOW, lastNudgedForTgSentAt: null });
  // Untouched key is unchanged.
  expect(updated[other]).toEqual(store[other]);
});

test('markAwarenessNudgeSent ignores a key no longer present in the store (dropped as no-longer-live)', () => {
  const store: AwarenessNudgeStore = {};
  expect(markAwarenessNudgeSent(store, ['omp:gone'], NOW)).toEqual({});
});

test('markAwarenessNudgeSent with no sent keys returns the same store reference (no-op)', () => {
  const store: AwarenessNudgeStore = { 'omp:1': { firstSeenAt: NOW, lastTgSentAt: null } };
  expect(markAwarenessNudgeSent(store, [], NOW)).toBe(store);
});

test('an agent that sent a tg message recently is not nudged even if first seen long ago', () => {
  const key = 'omp:99';
  const store: AwarenessNudgeStore = {};
  const lastSent = new Map([[key, NOW - 5 * 60 * 1000]]); // sent 5 min ago
  const plan = planAwarenessNudges([key], lastSent, store, NOW);
  expect(plan.due).toEqual([]);
});

test('a freshly-seen agent (silence just started) is not nudged before the threshold', () => {
  const key = 'omp:7';
  const store: AwarenessNudgeStore = {};
  const plan = planAwarenessNudges([key], new Map(), store, NOW);
  expect(plan.due).toEqual([]);
  expect(plan.store[key].firstSeenAt).toBe(NOW);
});

test('a new tg send resets the silence clock, allowing a fresh nudge after another hour', () => {
  const key = 'omp:1';
  const store: AwarenessNudgeStore = {
    [key]: { firstSeenAt: NOW - 3 * HOUR, lastTgSentAt: null, lastNudgedAt: NOW - 2 * HOUR, lastNudgedForTgSentAt: null },
  };
  // Agent finally sends a tg message.
  const sentAt = NOW - 30 * 60 * 1000;
  let plan = planAwarenessNudges([key], new Map([[key, sentAt]]), store, NOW);
  expect(plan.due).toEqual([]); // only 30 min silent since the send
  // Another hour passes with no further send.
  plan = planAwarenessNudges([key], new Map(), plan.store, NOW + HOUR);
  expect(plan.due).toEqual([key]);
});

test('a dead key (no longer live) is dropped from the returned store', () => {
  const store: AwarenessNudgeStore = { 'omp:1': { firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: null } };
  const plan = planAwarenessNudges([], new Map(), store, NOW);
  expect(plan.store).toEqual({});
});

test('round-trips a valid store through serialize/parse', () => {
  const store: AwarenessNudgeStore = {
    'omp:1': {
      firstSeenAt: NOW,
      lastTgSentAt: NOW - 1000,
      lastNudgedAt: NOW,
      lastNudgedForTgSentAt: NOW - 1000,
      sessionId: 'sess-abc',
    },
  };
  expect(parseAwarenessNudgeStore(serializeAwarenessNudgeStore(store))).toEqual(store);
});

test('parse: malformed / absent / non-object -> empty store', () => {
  expect(parseAwarenessNudgeStore(null)).toEqual({});
  expect(parseAwarenessNudgeStore('not json')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":"x"}')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":{"k":{"firstSeenAt":"x"}}}')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":{"k":{"firstSeenAt":1,"lastTgSentAt":null,"sessionId":5}}}')).toEqual({});
});

test('a replacement session in the same key (e.g. a tmux pane reused after Ctrl-C) does not inherit the old suppression', () => {
  const key = 'tmux:%5';
  // Session A was nudged, never sent tg — suppressed for the rest of its episode.
  const store: AwarenessNudgeStore = {
    [key]: { firstSeenAt: NOW - 3 * HOUR, lastTgSentAt: null, lastNudgedAt: NOW - 2 * HOUR, lastNudgedForTgSentAt: null, sessionId: 'session-A' },
  };
  // Session B starts in the same pane moments later — different sessionId, hasn't sent tg either.
  const plan = planAwarenessNudges([key], new Map(), store, NOW, new Map([[key, 'session-B']]));
  // B must NOT inherit A's suppression, but it also just started, so it is not YET due.
  expect(plan.due).toEqual([]);
  expect(plan.store[key].firstSeenAt).toBe(NOW);
  expect(plan.store[key].lastNudgedAt).toBeUndefined();
  expect(plan.store[key].sessionId).toBe('session-B');
});

test('an unknown (null) observed sessionId cannot disprove identity — carries the prior state forward as before', () => {
  const key = 'omp:9';
  const store: AwarenessNudgeStore = {
    [key]: { firstSeenAt: NOW - 2 * HOUR, lastTgSentAt: null, sessionId: 'session-A' },
  };
  // No live session jsonl yet this sweep (observed sessionId unknown) — can't compare, prior stands.
  const plan = planAwarenessNudges([key], new Map(), store, NOW, new Map([[key, null]]));
  expect(plan.due).toEqual([key]);
  expect(plan.store[key].firstSeenAt).toBe(NOW - 2 * HOUR);
});

test('a stale tg-send record under a reused key cannot backdate a just-started session\'s silence clock', () => {
  const key = 'omp:500';
  // No prior state at all (first time this key is seen) — but history.jsonl
  // still has an old send under this same pid/pane from a dead session.
  const staleSend = NOW - 2 * HOUR;
  const plan = planAwarenessNudges([key], new Map([[key, staleSend]]), {}, NOW);
  // Without the firstSeenAt clamp this would be immediately due (silentMs ~2h).
  expect(plan.due).toEqual([]);
  expect(plan.store[key].lastTgSentAt).toBe(staleSend);
});

test('keysChanged is a real set comparison, not a length check — simultaneous add+remove is detected', () => {
  const store: AwarenessNudgeStore = { 'omp:1': { firstSeenAt: NOW - HOUR, lastTgSentAt: null } };
  // omp:1 dies, omp:2 appears — same COUNT (1), different SET.
  const plan = planAwarenessNudges(['omp:2'], new Map(), store, NOW);
  expect(plan.keysChanged).toBe(true);
});

test('keysChanged is false when the live key set is identical to the stored one', () => {
  const store: AwarenessNudgeStore = { 'omp:1': { firstSeenAt: NOW - HOUR, lastTgSentAt: null } };
  const plan = planAwarenessNudges(['omp:1'], new Map(), store, NOW);
  expect(plan.keysChanged).toBe(false);
});

test('lastTgSentAtByKey: only agent-direction records with a pane count, latest wins', () => {
  const records: HistoryRecord[] = [
    { ts: 1000, message_id: 1, direction: 'agent', from: 'agent', text: 'a', pane: 'omp:5' },
    { ts: 2000, message_id: 2, direction: 'agent', from: 'agent', text: 'b', pane: 'omp:5' },
    { ts: 5000, message_id: 3, direction: 'user', from: 'Alex', text: 'c', pane: 'omp:5' },
    { ts: 3000, message_id: 4, direction: 'agent', from: 'agent', text: 'd', pane: null },
  ];
  const out = lastTgSentAtByKey(records);
  expect(out.get('omp:5')).toBe(2000 * 1000);
  expect(out.size).toBe(1);
});

test('threshold default is exactly one hour', () => {
  expect(AWARENESS_NUDGE_THRESHOLD_MS).toBe(60 * 60 * 1000);
});
