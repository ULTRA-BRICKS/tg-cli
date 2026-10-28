import { describe, expect, test } from 'bun:test';
import {
  CLAIM_MAX_MS,
  DEFAULT_ALERT_TTL_MS,
  DEFAULT_ALERT_WINDOW_MS,
  KEY_MAX,
  TEXT_MAX,
  alertRequestId,
  alertTag,
  alertTitle,
  claimAlert,
  claimInternalAlert,
  internalThrottleKey,
  internalAlertRequestId,
  internalAlertText,
  markInternalAlertDelivered,
  reconcileInternalAlertRecipients,
  pinInternalAlertAttempt,
  releaseInternalAlertAttempt,
  formatAlertList,
  markAlertDelivered,
  nearestLiveAncestor,
  parseAlertArgv,
  parseAlertSubscriptions,
  parseAlertThrottle,
  parseDurationMs,
  parseTgSendOk,
  removeAlertSubscription,
  resolveAlertBindings,
  serializeAlertSubscriptions,
  serializeAlertThrottle,
  sessionAlertText,
  settleAlert,
  telegramAlertBody,
  throttleKey,
  throttleVerdict,
  upsertAlertSubscription,
  claimHolder,
  denyHandoff,
  grantHandoff,
  holderState,
  markHolderDelivery,
  refreshHolder,
  releaseHolder,
  requestHandoff,
  settleHolderAlert,
  takeHolder,
  releaseHolderClaim,
  deliverWithStaleRetry,
  holderRequestId,
  holderThrottleKey,
  withdrawRequest,
  holderAlertText,
  HOLDER_TEXT_MAX_BYTES,
  type AlertHolder,
  type AlertSubscriptionStore,
  type Claimant,
  type AlertMessage,
  type AlertSubscription,
  type AlertThrottleEntry,
} from '../features/tg-ctl/alert-subscriptions';
import type { OriginalOmpEndpoint } from '../features/tg-ctl/omp-live-routing';

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

const sub = (over: Partial<AlertSubscription> = {}): AlertSubscription => ({
  sessionId: '01a11860-850d-729a-ae3f-d5ffb6d07464',
  title: '🕹️ AGENTS: Supervise omp agents and rig',
  pid: 3467203,
  cwd: '/tmp',
  sources: null,
  createdAt: NOW - HOUR,
  expiresAt: NOW + HOUR,
  ...over,
});

const endpoint = (over: Partial<OriginalOmpEndpoint> = {}): OriginalOmpEndpoint => ({
  pid: 3467203,
  instanceId: '4a72bb345646497e7bc5c9c24a189362',
  sessionId: '01a11860-850d-729a-ae3f-d5ffb6d07464',
  sessionFile: null,
  cwd: '/tmp',
  durableSession: null,
  busy: false,
  title: '🕹️ AGENTS: Supervise omp agents and rig',
  ...over,
});

const msg = (over: Partial<AlertMessage> = {}): AlertMessage => ({
  source: 'sysmon',
  severity: 'critical',
  key: 'load',
  text: 'load 38 > 24; swap 10 GB',
  html: false,
  title: null,
  ...over,
});

describe('internal incident receipts', () => {
  test('snapshot is durable before acceptance and pending recipients keep original identity past the repeat window', () => {
    const key = internalThrottleKey(msg(), null);
    const text = internalAlertText(msg(), 'withheld');
    const claimed = claimInternalAlert({ sent: [] }, key, NOW, text, ['a', 'b', 'a']);
    const restored = parseAlertThrottle(serializeAlertThrottle(claimed, NOW), NOW);
    expect(restored.sent).toEqual([{ key, at: NOW, messageId: 0, pending: ['a', 'b'], internalText: text, internalRecipients: ['a', 'b'], internalAttempts: [] }]);
    expect(throttleVerdict(restored, key, NOW + 2 * DEFAULT_ALERT_WINDOW_MS, DEFAULT_ALERT_WINDOW_MS).kind).toBe('throttled');
    const done = markInternalAlertDelivered(restored, key, NOW, ['a', 'b']);
    expect(throttleVerdict(done, key, NOW + 2 * DEFAULT_ALERT_WINDOW_MS, DEFAULT_ALERT_WINDOW_MS).kind).toBe('send');
    expect(throttleVerdict(restored, throttleKey(msg().source, msg().key, msg().severity), NOW, DEFAULT_ALERT_WINDOW_MS).kind).toBe('send');
  });

  test('stable bounded request id includes incident, claim and session identity without truncation collisions', () => {
    const key = internalThrottleKey(msg({ key: 'x'.repeat(255) + 'A' }), null);
    const id = internalAlertRequestId(key, NOW, 'a'.repeat(511) + 'A');
    expect(id.length).toBeLessThanOrEqual(256);
    expect(id).toBe(internalAlertRequestId(key, NOW, 'a'.repeat(511) + 'A'));
    for (const other of [
      internalAlertRequestId(internalThrottleKey(msg({ key: 'x'.repeat(255) + 'B' }), null), NOW, 'a'.repeat(511) + 'A'),
      internalAlertRequestId(key, NOW + 1, 'a'.repeat(511) + 'A'),
      internalAlertRequestId(key, NOW, 'a'.repeat(511) + 'B'),
    ]) expect(other).not.toBe(id);
    expect(internalThrottleKey(msg(), 'holder-a')).not.toBe(internalThrottleKey(msg(), 'holder-b'));
    expect(internalThrottleKey(msg(), null)).not.toBe(internalThrottleKey(msg(), 'holder-a'));
  });

  test('concurrent acknowledgements merge, and stale acknowledgement cannot clear a forced replacement', () => {
    const key = internalThrottleKey(msg(), null);
    const first = claimInternalAlert({ sent: [] }, key, NOW, 'first snapshot', ['a', 'b']);
    const once = markInternalAlertDelivered(first, key, NOW, ['a']);
    expect(markInternalAlertDelivered(once, key, NOW, ['b']).sent[0].pending).toEqual([]);
    const forced = claimInternalAlert(once, key, NOW, 'forced snapshot', ['a', 'b']);
    expect(forced.sent[0].at).toBeGreaterThan(NOW);
    expect(markInternalAlertDelivered(forced, key, NOW, ['b'])).toEqual(forced);
    expect(reconcileInternalAlertRecipients(forced, key, NOW, ['replacement'])).toEqual(forced);
  });

  test('assignment changes keep only responsible pending recipients while preserving the snapshot and acknowledgements', () => {
    const key = internalThrottleKey(msg(), null);
    const initial = claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['accepted', 'withdrawn']);
    const partial = markInternalAlertDelivered(initial, key, NOW, ['accepted']);
    const reassigned = reconcileInternalAlertRecipients(partial, key, NOW, ['accepted', 'replacement']);
    expect(reassigned.sent[0]).toEqual({ key, at: NOW, messageId: 0, pending: ['replacement'], internalText: 'incident', internalRecipients: ['accepted', 'replacement'], internalAttempts: [] });
    const renewed = reconcileInternalAlertRecipients(reassigned, key, NOW, ['accepted', 'withdrawn']);
    expect(renewed.sent[0].pending).toEqual(['withdrawn']);
  });

  test('accepted identity survives unsubscribe and resubscribe without replaying the same incident', () => {
    const key = internalThrottleKey(msg(), null);
    const initial = claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['accepted', 'pending']);
    const partial = markInternalAlertDelivered(initial, key, NOW, ['accepted']);
    const removed = reconcileInternalAlertRecipients(partial, key, NOW, ['pending']);
    const restored = reconcileInternalAlertRecipients(parseAlertThrottle(serializeAlertThrottle(removed, NOW), NOW), key, NOW, ['accepted', 'pending']);
    expect(restored.sent[0].pending).toEqual(['pending']);
  });

  test('a late acceptance after subscription withdrawal is retained for a later resubscription', () => {
    const key = internalThrottleKey(msg(), null);
    const initial = claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['in-flight']);
    const reassigned = reconcileInternalAlertRecipients(initial, key, NOW, ['replacement']);
    const acknowledged = markInternalAlertDelivered(reassigned, key, NOW, ['in-flight']);
    const resumed = reconcileInternalAlertRecipients(acknowledged, key, NOW, ['in-flight', 'replacement']);
    expect(resumed.sent[0].pending).toEqual(['replacement']);
  });

  test('an unresolved attempt is durably pinned to its endpoint generation, with claim fencing', () => {
    const key = internalThrottleKey(msg(), null);
    const target = { sessionId: 'pending', pid: 7, instanceId: 'a'.repeat(32) };
    const initial = claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['pending']);
    const pinned = pinInternalAlertAttempt(initial, key, NOW, target);
    expect(pinned.result).toBe('pinned');
    const restored = parseAlertThrottle(serializeAlertThrottle(pinned.store, NOW), NOW);
    expect(pinInternalAlertAttempt(restored, key, NOW, target).result).toBe('ready');
    for (const resumed of [{ ...target, pid: 8 }, { ...target, instanceId: 'b'.repeat(32) }]) {
      const refused = pinInternalAlertAttempt(restored, key, NOW, resumed);
      expect(refused.result).toBe('internal_delivery_uncertain');
      expect(refused.store).toEqual(restored);
    }
    const forced = claimInternalAlert(restored, key, NOW + 1, 'reconciled incident', ['pending']);
    expect(pinInternalAlertAttempt(forced, key, NOW, target).result).toBe('internal_receipt_changed');
    expect(pinInternalAlertAttempt(forced, key, NOW + 1, { ...target, pid: 8 }).result).toBe('pinned');
  });

  test('a pin the host rejected as stale_identity is released so the fresh endpoint generation can be tried once', () => {
    const key = internalThrottleKey(msg(), null);
    const target = { sessionId: 'pending', pid: 7, instanceId: 'a'.repeat(32) };
    const fresh = { ...target, pid: 8, instanceId: 'b'.repeat(32) };
    const pinned = pinInternalAlertAttempt(claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['pending']), key, NOW, target).store;
    expect(pinInternalAlertAttempt(pinned, key, NOW, fresh).result).toBe('internal_delivery_uncertain');
    const released = releaseInternalAlertAttempt(pinned, key, NOW, target);
    expect(pinInternalAlertAttempt(released, key, NOW, fresh).result).toBe('pinned');
    // Only the rejected generation of this claim is released.
    expect(releaseInternalAlertAttempt(pinned, key, NOW, fresh)).toEqual(pinned);
    expect(releaseInternalAlertAttempt(pinned, key, NOW + 1, target)).toEqual(pinned);
  });

  test('unresolved receipt survives ordinary history eviction and the 24-hour retention boundary', () => {
    const key = internalThrottleKey(msg(), null);
    const target = { sessionId: 'pending', pid: 7, instanceId: 'a'.repeat(32) };
    const initial = pinInternalAlertAttempt(claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['pending']), key, NOW, target).store;
    let crowded = initial;
    for (let i = 0; i < 200; i++) crowded = settleAlert(claimAlert(crowded, `ordinary-${i}`, NOW + 1), `ordinary-${i}`, i + 1, []);
    const underPressure = parseAlertThrottle(serializeAlertThrottle(crowded, NOW + 2), NOW + 2);
    expect(underPressure.sent.find(entry => entry.key === key)).toEqual(initial.sent[0]);
    for (const age of [24 * HOUR, 25 * HOUR, 30 * 24 * HOUR]) {
      const raw = JSON.stringify({ version: 1, sent: initial.sent });
      const parsed = parseAlertThrottle(raw, NOW + age);
      expect(parsed.sent).toEqual(initial.sent);
      const restored = parseAlertThrottle(serializeAlertThrottle(parsed, NOW + age), NOW + age);
      expect(throttleVerdict(restored, key, NOW + age, DEFAULT_ALERT_WINDOW_MS).kind).toBe('throttled');
      expect(pinInternalAlertAttempt(restored, key, NOW, { ...target, pid: 8 }).result).toBe('internal_delivery_uncertain');
      expect(internalAlertRequestId(key, restored.sent[0].at, target.sessionId)).toBe(internalAlertRequestId(key, NOW, target.sessionId));
    }
  });

  test('withdrawal and corrupt attempt history do not expire unresolved delivery identity', () => {
    const key = internalThrottleKey(msg(), null);
    const target = { sessionId: 'pending', pid: 7, instanceId: 'a'.repeat(32) };
    const initial = pinInternalAlertAttempt(claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['pending']), key, NOW, target).store;
    const withdrawn = reconcileInternalAlertRecipients(initial, key, NOW, []);
    expect(withdrawn.sent[0].pending).toEqual([]);
    const restored = parseAlertThrottle(serializeAlertThrottle(withdrawn, NOW + 25 * HOUR), NOW + 25 * HOUR);
    expect(throttleVerdict(restored, key, NOW + 25 * HOUR, DEFAULT_ALERT_WINDOW_MS).kind).toBe('throttled');
    const assigned = reconcileInternalAlertRecipients(restored, key, NOW, ['pending']);
    expect(pinInternalAlertAttempt(assigned, key, NOW, { ...target, pid: 8 }).result).toBe('internal_delivery_uncertain');
    const corrupt = parseAlertThrottle(JSON.stringify({ version: 1, sent: [{ ...initial.sent[0], internalAttempts: 'invalid' }] }), NOW + 25 * HOUR);
    expect(corrupt.sent).toHaveLength(1);
    expect(pinInternalAlertAttempt(corrupt, key, NOW, target).result).toBe('internal_delivery_uncertain');
  });

  test('a newly acknowledged receipt keeps its ordinary throttle slot ahead of older history', () => {
    const key = internalThrottleKey(msg(), null);
    let store = claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['pending']);
    for (let i = 0; i < 200; i++) store = settleAlert(claimAlert(store, `older-${i}`, NOW - 1), `older-${i}`, i + 1, []);
    const protectedFirst = parseAlertThrottle(serializeAlertThrottle(store, NOW), NOW);
    const acknowledged = markInternalAlertDelivered(protectedFirst, key, NOW, ['pending']);
    const restored = parseAlertThrottle(serializeAlertThrottle(acknowledged, NOW + 1), NOW + 1);
    expect(restored.sent.some(entry => entry.key === key)).toBe(true);
    expect(restored.sent).toHaveLength(200);
    expect(throttleVerdict(restored, key, NOW + 1, DEFAULT_ALERT_WINDOW_MS).kind).toBe('throttled');
  });

  test('unresolved receipt capacity fails closed without blocking ordinary owner history or dropping old attempts', () => {
    let full = { sent: [] as AlertThrottleEntry[] };
    for (let i = 0; i < 200; i++) full = claimInternalAlert(full, internalThrottleKey(msg({ key: `pending-${i}` }), null), NOW, 'incident', ['pending']);
    const newKey = internalThrottleKey(msg({ key: 'overflow' }), null);
    expect(() => claimInternalAlert(full, newKey, NOW, 'new incident', ['pending'])).toThrow('internal receipt capacity');
    expect(parseAlertThrottle(serializeAlertThrottle(full, NOW + 25 * HOUR), NOW + 25 * HOUR).sent).toHaveLength(200);
    let withOrdinary = full;
    for (let i = 0; i < 250; i++) withOrdinary = settleAlert(claimAlert(withOrdinary, `owner-${i}`, NOW), `owner-${i}`, i + 1, []);
    const restored = parseAlertThrottle(serializeAlertThrottle(withOrdinary, NOW), NOW);
    expect(restored.sent.filter(entry => entry.internalText !== undefined)).toHaveLength(200);
    expect(restored.sent.filter(entry => entry.internalText === undefined)).toHaveLength(200);
    expect(restored.sent.some(entry => entry.key === 'owner-249')).toBe(true);
    const released = markInternalAlertDelivered(full, full.sent[0].key, NOW, ['pending']);
    expect(() => claimInternalAlert(released, newKey, NOW + 1, 'new incident', ['pending'])).not.toThrow();
    expect(() => claimInternalAlert(full, full.sent[0].key, NOW + 1, 'explicit replacement', ['pending'])).not.toThrow();
    const overflow = { sent: [...full.sent, { ...full.sent[0], key: newKey }] };
    expect(() => serializeAlertThrottle(overflow, NOW)).toThrow('internal receipt capacity');
  });

  test('missing or corrupt attempt history is uncertain, while unattempted suspended recipients remain eligible', () => {
    const key = internalThrottleKey(msg(), null);
    const target = { sessionId: 'pending', pid: 7, instanceId: 'a'.repeat(32) };
    const initial = claimInternalAlert({ sent: [] }, key, NOW, 'incident', ['pending']);
    expect(pinInternalAlertAttempt(initial, key, NOW, target).result).toBe('pinned');
    for (const internalAttempts of [undefined, 'invalid', [{ ...target, instanceId: 'bad' }], [target, { ...target, pid: 8 }]]) {
      const restored = parseAlertThrottle(JSON.stringify({ version: 1, sent: [{ ...initial.sent[0], internalAttempts }] }), NOW);
      expect(pinInternalAlertAttempt(restored, key, NOW, target).result).toBe('internal_delivery_uncertain');
    }
    const accepted = markInternalAlertDelivered(initial, key, NOW, ['pending']);
    expect(pinInternalAlertAttempt(accepted, key, NOW, { ...target, pid: 8 }).result).toBe('internal_receipt_acknowledged');
  });

  test('internal zero id needs an intact bounded snapshot; it never masquerades as a Telegram id', () => {
    const entry = { key: internalThrottleKey(msg(), null), at: NOW, messageId: 0, pending: ['a'] };
    const parse = (over: Record<string, unknown>) => parseAlertThrottle(JSON.stringify({ version: 1, sent: [{ ...entry, ...over }] }), NOW).sent;
    expect(parse({})).toEqual([]);
    expect(parse({ internalText: '' })).toEqual([]);
    expect(parse({ internalText: 'я'.repeat(HOLDER_TEXT_MAX_BYTES) })).toEqual([]);
    expect(parse({ internalText: 'snapshot', key: throttleKey('sysmon', 'load', 'critical') })).toEqual([]);
    expect(parse({ internalText: 'snapshot' })).toHaveLength(1);
  });

  test('internal status distinguishes withheld from unknown owner delivery and never invents remediation', () => {
    const text = internalAlertText(msg({ html: true, text: '<b>Memory</b> &gt; 97%' }), 'withheld');
    expect(text).toContain('Memory > 97%');
    expect(text).toContain('Owner problem report withheld');
    expect(text).toContain('Receipt of this incident does not mean remediation has started');
    expect(text).not.toMatch(/tg#|--reply-to/u);
    expect(internalAlertText(msg(), 'unconfirmed')).toContain('Owner delivery is unconfirmed');
  });
});

describe('subscription store', () => {
  test('round-trips and prunes expired subscriptions on serialize and parse', () => {
    const live = sub();
    const expired = sub({ sessionId: 'dead', expiresAt: NOW - 1 });
    const forever = sub({ sessionId: 'forever', expiresAt: null });
    const blob = serializeAlertSubscriptions({ subscriptions: [live, expired, forever], holders: [] }, NOW);
    expect(parseAlertSubscriptions(blob, NOW).subscriptions).toEqual([live, forever]);
    const stale = JSON.stringify({ version: 1, subscriptions: [live, expired] });
    expect(parseAlertSubscriptions(stale, NOW).subscriptions).toEqual([live]);
  });

  test('parse never throws: absent, malformed and invalid records → empty', () => {
    expect(parseAlertSubscriptions(null, NOW).subscriptions).toEqual([]);
    expect(parseAlertSubscriptions('nope', NOW).subscriptions).toEqual([]);
    expect(parseAlertSubscriptions('{"subscriptions":"x"}', NOW).subscriptions).toEqual([]);
    const blob = JSON.stringify({ version: 1, subscriptions: [sub(), { sessionId: 5 }, { ...sub(), pid: 'x' }, { ...sub(), sources: 'all' }, sub({ sessionId: 'closed', pid: null })] });
    expect(parseAlertSubscriptions(blob, NOW).subscriptions).toEqual([sub(), sub({ sessionId: 'closed', pid: null })]);
    // Subscribed by session id while closed: no pid until the session comes back.
    const closed = resolveAlertBindings({ subscriptions: [sub({ sessionId: 'closed', pid: null, title: null })], holders: [] }, [], NOW);
    expect(formatAlertList(closed, NOW)).toContain('suspended (no live omp-live endpoint) · (untitled) · pid ? · session closed');
    expect(resolveAlertBindings({ subscriptions: [sub({ sessionId: 'closed', pid: null })], holders: [] }, [endpoint({ sessionId: 'closed', pid: 77 })], NOW)[0].subscription.pid).toBe(77);
  });

  test('upsert replaces the record of the same sessionId; remove drops it', () => {
    const a = sub();
    const b = sub({ sessionId: 'other', pid: 7 });
    let store = upsertAlertSubscription({ subscriptions: [a], holders: [] }, b);
    store = upsertAlertSubscription(store, { ...a, pid: 99, sources: ['sysmon'] });
    expect(store.subscriptions.map((s) => s.pid)).toEqual([7, 99]);
    expect(removeAlertSubscription(store, 'other').subscriptions.map((s) => s.sessionId)).toEqual([a.sessionId]);
  });
});

describe('binding resolution against the live registry', () => {
  test('a live endpoint with the same sessionId binds — pid and title are refreshed from it (resume)', () => {
    const resumed = endpoint({ pid: 4_000_001, instanceId: 'f'.repeat(32), title: 'renamed' });
    const [b] = resolveAlertBindings({ subscriptions: [sub()], holders: [] }, [resumed], NOW);
    expect(b.state).toBe('bound');
    expect(b.endpoint).toEqual(resumed);
    expect(b.subscription.pid).toBe(4_000_001);
    expect(b.subscription.title).toBe('renamed');
  });

  test('no live endpoint → suspended; expired → dropped', () => {
    const bindings = resolveAlertBindings(
      { subscriptions: [sub(), sub({ sessionId: 'gone', pid: 1 }), sub({ sessionId: 'old', expiresAt: NOW - 1 })], holders: [] },
      [endpoint()],
      NOW,
    );
    expect(bindings.map((b) => [b.subscription.sessionId, b.state])).toEqual([
      [sub().sessionId, 'bound'],
      ['gone', 'suspended'],
    ]);
  });

  test('a source filter keeps subscriptions for that source or for every source', () => {
    const store = { subscriptions: [sub({ sources: ['sysmon'] }), sub({ sessionId: 's2', sources: ['supervisor'] }), sub({ sessionId: 's3', sources: null })], holders: [] };
    const bound = resolveAlertBindings(store, [], NOW, 'sysmon');
    expect(bound.map((b) => b.subscription.sessionId)).toEqual([sub().sessionId, 's3']);
  });
});

describe('throttle protocol', () => {
  const key = throttleKey('sysmon', 'load', 'warning');

  test('claim → settle: a repeat inside the window is throttled, an escalation and a window-old entry are not', () => {
    expect(key).toBe('sysmon|load|warning');
    expect(throttleVerdict({ sent: [] }, key, NOW, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'send' });
    let store = claimAlert({ sent: [] }, key, NOW);
    expect(throttleVerdict(store, key, NOW + 1, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'in-flight', entry: { key, at: NOW, messageId: null, pending: [] } });
    store = settleAlert(store, key, 123, ['s2', 's2']);
    const entry = { key, at: NOW, messageId: 123, pending: ['s2'] };
    expect(throttleVerdict(store, key, NOW + 5 * 60_000, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'throttled', entry });
    expect(throttleVerdict(store, key, NOW + DEFAULT_ALERT_WINDOW_MS, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'send' });
    expect(throttleVerdict(store, throttleKey('sysmon', 'load', 'critical'), NOW + 1, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'send' });
    expect(throttleVerdict(store, key, NOW + 1, 0)).toEqual({ kind: 'send' }); // --window 0 = no throttle
    expect(markAlertDelivered(store, key, ['s2']).sent[0].pending).toEqual([]);
  });

  test('a failed post releases the claim; an unsettled claim expires; a clock stepped back never blocks', () => {
    const claimed = claimAlert({ sent: [] }, key, NOW);
    expect(settleAlert(claimed, key, null, []).sent).toEqual([]);
    expect(throttleVerdict(claimed, key, NOW + CLAIM_MAX_MS, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'send' });
    expect(throttleVerdict(settleAlert(claimed, key, 5, []), key, NOW - 1, DEFAULT_ALERT_WINDOW_MS)).toEqual({ kind: 'send' });
  });

  test('store round-trips, keeps the latest entry per key, forgets day-old ones and rejects another version', () => {
    let store = settleAlert(claimAlert({ sent: [] }, 'a', NOW - 25 * HOUR), 'a', 1, []);
    store = settleAlert(claimAlert(store, 'b', NOW - HOUR), 'b', 2, ['x']);
    store = claimAlert(store, 'b', NOW);
    const parsed = parseAlertThrottle(serializeAlertThrottle(store, NOW), NOW);
    expect(parsed.sent).toEqual([{ key: 'b', at: NOW, messageId: null, pending: [] }]);
    expect(parseAlertThrottle('garbage', NOW).sent).toEqual([]);
    expect(parseAlertThrottle(JSON.stringify({ version: 2, sent: [{ key: 'b', at: NOW, messageId: 1, pending: [] }] }), NOW).sent).toEqual([]);
    expect(parseAlertSubscriptions(JSON.stringify({ version: 2, subscriptions: [sub()] }), NOW).subscriptions).toEqual([]);
    let many = { sent: [] as AlertThrottleEntry[] };
    for (let i = 0; i < 250; i++) many = settleAlert(claimAlert(many, `k${i}`, NOW - 250 + i), `k${i}`, i + 1, []);
    expect(parseAlertThrottle(serializeAlertThrottle(many, NOW), NOW).sent).toHaveLength(200);
  });
});

describe('message formatting', () => {
  test('telegram body escapes a plain text, keeps an html one, and lists each bound session in the footer', () => {
    const bound = resolveAlertBindings({ subscriptions: [sub()], holders: [] }, [endpoint()], NOW);
    const body = telegramAlertBody(msg({ text: 'load 38 > 24 & swap' }), bound);
    expect(body).toBe('load 38 &gt; 24 &amp; swap\n\n<i>↳ также адресовано агенту: 🕹️ AGENTS: Supervise omp agents and rig (pid 3467203)</i>');
    expect(telegramAlertBody(msg({ text: '<b>x</b>', html: true }), [])).toBe('<b>x</b>');
    const suspended = resolveAlertBindings({ subscriptions: [sub()], holders: [] }, [], NOW);
    expect(telegramAlertBody(msg({ text: 'plain' }), suspended)).toBe('plain');
  });

  test('session text carries the Telegram id so the agent can follow up with --reply-to', () => {
    expect(sessionAlertText(msg(), 777)).toBe(
      '[alert tg#777 · sysmon · critical] load 38 > 24; swap 10 GB\n— when fixed, follow up on this alert: tg --reply-to 777 "<status>"',
    );
    expect(sessionAlertText(msg({ text: '<b>x</b> &amp; y', html: true }), 8)).toStartWith('[alert tg#8 · sysmon · critical] x & y\n');
  });

  test('title, tag, request id and the parsed tg OK line', () => {
    expect(alertTitle(msg())).toBe('sysmon CRITICAL: load');
    expect(alertTitle(msg({ title: 'sysmon CRITICAL on ultra: load; swap' }))).toBe('sysmon CRITICAL on ultra: load; swap');
    expect(alertTag('critical')).toBe('problem');
    expect(alertTag('warning')).toBe('problem');
    expect(alertTag('info')).toBe('report');
    expect(parseTgSendOk('OK tg#4210 tg#4211\n')).toBe(4210);
    expect(parseTgSendOk('warning: x\nOK tg#9')).toBe(9);
    expect(parseTgSendOk('OK')).toBeNull();
    expect(parseTgSendOk('')).toBeNull();
    expect(alertRequestId(4210, 'sess-1')).toBe('alert:4210:sess-1');
    expect(alertRequestId(4210, 'sess 1')).toBe('alert:4210:sess_1');
  });
});

describe('argv', () => {
  test('send: required flags, severity validation, window and html', () => {
    expect(parseAlertArgv(['send', '--source', 'sysmon', '--severity', 'warning', '--key', 'load', '--text', 'hi'])).toEqual({
      cmd: 'send',
      message: { source: 'sysmon', severity: 'warning', key: 'load', text: 'hi', html: false, title: null },
      windowMs: DEFAULT_ALERT_WINDOW_MS,
      force: false,
      toHolder: false,
    });
    expect(parseAlertArgv(['send', '--source', 'supervisor', '--severity', 'critical', '--key', 'OVERLOAD', '--text', 'x', '--html', '--window', '2m', '--force', '--title', 'T'])).toEqual({
      cmd: 'send',
      message: { source: 'supervisor', severity: 'critical', key: 'OVERLOAD', text: 'x', html: true, title: 'T' },
      windowMs: 120_000,
      force: true,
      toHolder: false,
    });
    expect(parseAlertArgv(['send', '--source', 'x', '--severity', 'fatal', '--key', 'k', '--text', 't'])).toEqual({ cmd: 'error', error: 'invalid --severity: fatal (info|warning|critical)' });
    expect(parseAlertArgv(['send', '--severity', 'info', '--key', 'k', '--text', 't'])).toEqual({ cmd: 'error', error: 'send requires --source, --severity, --key and --text' });
    expect(parseAlertArgv(['send', '--source', 'a b', '--severity', 'info', '--key', 'k', '--text', 't'])).toEqual({ cmd: 'error', error: 'invalid --source: a b (letters, digits, - _ . only)' });
    expect(parseAlertArgv(['send', 'positional'])).toEqual({ cmd: 'error', error: 'unexpected argument: positional' });
    expect(parseAlertArgv(['send', '--source', 's', '--severity', 'info', '--key', 'k'.repeat(KEY_MAX + 1), '--text', 't'])).toEqual({ cmd: 'error', error: `--key longer than ${KEY_MAX} chars` });
    expect(parseAlertArgv(['send', '--source', 's', '--severity', 'info', '--key', 'k', '--text', 't'.repeat(TEXT_MAX + 1)])).toEqual({ cmd: 'error', error: `--text longer than ${TEXT_MAX} chars` });
    expect(parseAlertArgv(['send', '--source', 's', '--severity', 'info', '--key', 'k', '--text', '-starts with dash', '--window', '0'])).toMatchObject({ cmd: 'send', windowMs: 0, message: { text: '-starts with dash' } });
  });

  test('subscribe / unsubscribe / list', () => {
    expect(parseAlertArgv(['subscribe'])).toEqual({ cmd: 'subscribe', pid: null, sessionId: null, sources: null, ttlMs: DEFAULT_ALERT_TTL_MS, exclusive: false, source: null });
    expect(parseAlertArgv(['subscribe', '--pid', '42', '--sources', 'sysmon,supervisor', '--ttl', '0'])).toEqual({ cmd: 'subscribe', pid: 42, sessionId: null, sources: ['sysmon', 'supervisor'], ttlMs: null, exclusive: false, source: null });
    expect(parseAlertArgv(['subscribe', '--session', 'abc', '--ttl', '2h'])).toEqual({ cmd: 'subscribe', pid: null, sessionId: 'abc', sources: null, ttlMs: 2 * HOUR, exclusive: false, source: null });
    expect(parseAlertArgv(['subscribe', '--pid', 'x'])).toEqual({ cmd: 'error', error: 'invalid --pid: x' });
    expect(parseAlertArgv(['unsubscribe', '--all'])).toEqual({ cmd: 'unsubscribe', pid: null, sessionId: null, all: true });
    expect(parseAlertArgv(['unsubscribe', '--pid', '5'])).toEqual({ cmd: 'unsubscribe', pid: 5, sessionId: null, all: false });
    expect(parseAlertArgv(['unsubscribe', '--pid', '5', '--session', 'a'])).toEqual({ cmd: 'error', error: '--pid and --session are exclusive' });
    expect(parseAlertArgv(['subscribe', '--sources', ' ,'])).toEqual({ cmd: 'error', error: 'invalid --sources:  ,' });
    expect(parseAlertArgv(['list', '--json'])).toEqual({ cmd: 'list', json: true });
    expect(parseAlertArgv([])).toEqual({ cmd: 'error', error: 'usage: tg-ctl alert send|subscribe|unsubscribe|list|handoff-request|handoff|take|release|holder' });
    expect(parseAlertArgv(['send', '--bogus', 'v'])).toEqual({ cmd: 'error', error: 'unknown flag: --bogus' });
    expect(parseAlertArgv(['send', '--bogus'])).toEqual({ cmd: 'error', error: 'missing value for --bogus' });
  });

  test('durations', () => {
    expect(parseDurationMs('10m')).toBe(600_000);
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('1h')).toBe(HOUR);
    expect(parseDurationMs('2d')).toBe(48 * HOUR);
    expect(parseDurationMs('15')).toBe(15 * 60_000);
    expect(parseDurationMs('x')).toBeNull();
    expect(parseDurationMs('-1m')).toBeNull();
    expect(parseDurationMs('9007199254740991h')).toBeNull();
  });
});

test('nearestLiveAncestor picks the first ancestor (nearest first) that has a live endpoint', () => {
  const hosts = [endpoint({ pid: 10 }), endpoint({ pid: 30, sessionId: 's30' })];
  expect(nearestLiveAncestor([99, 30, 10, 1], hosts)?.pid).toBe(30);
  expect(nearestLiveAncestor([99, 1], hosts)).toBeNull();
});

test('formatAlertList renders bound/suspended with expiry', () => {
  const bindings = resolveAlertBindings({ subscriptions: [sub(), sub({ sessionId: 'gone', pid: 1, title: null, expiresAt: null, sources: ['sysmon'] })], holders: [] }, [endpoint()], NOW);
  expect(formatAlertList(bindings, NOW)).toBe([
    'alert subscriptions: 2',
    '  - bound · 🕹️ AGENTS: Supervise omp agents and rig · pid 3467203 · session 01a11860-850d-729a-ae3f-d5ffb6d07464 · sources: all · expires in 1 h 0 min',
    '  - suspended (no live omp-live endpoint) · (untitled) · pid 1 · session gone · sources: sysmon · no expiry',
  ].join('\n'));
  expect(formatAlertList([], NOW)).toBe('alert subscriptions: none');
});

describe('exclusive holder', () => {
  const MIN = 60_000;
  const A = 'session-a';
  const B = 'session-b';
  const holder = (over: Partial<AlertHolder> = {}): AlertHolder => ({
    source: 'sysmon',
    sessionId: A,
    title: 'A',
    pid: 100,
    cwd: '/tmp',
    since: NOW - HOUR,
    lastSeenLiveAt: NOW,
    failingSince: null,
    expiresAt: NOW + HOUR,
    request: null,
    ...over,
  });
  const store = (...holders: AlertHolder[]): AlertSubscriptionStore => ({ subscriptions: [], holders });
  const epA = endpoint({ pid: 100, sessionId: A, title: 'A' });
  const epB = endpoint({ pid: 200, sessionId: B, title: 'B' });
  const claimA: Claimant = { sessionId: A, title: 'A', pid: 100, cwd: '/tmp' };
  const claimB: Claimant = { sessionId: B, title: 'B', pid: 200, cwd: '/tmp' };

  test('state: bound with an endpoint; suspended for 10 min after it vanished, then vacant', () => {
    const s = store(holder());
    expect(holderState(s, 'sysmon', [epA], NOW).state).toBe('bound');
    expect(holderState(s, 'sysmon', [], NOW + 10 * MIN - 1).state).toBe('suspended');
    expect(holderState(s, 'sysmon', [], NOW + 10 * MIN).state).toBe('vacant');
    expect(holderState(s, 'other', [epA], NOW)).toEqual({ state: 'vacant', holder: null, endpoint: null });
  });

  test('a resumed session (new pid, same session id) stays bound and refresh stores the new pid', () => {
    const s = store(holder({ lastSeenLiveAt: NOW - 5 * MIN }));
    const resumed = endpoint({ pid: 999, sessionId: A, title: 'A2', cwd: '/w' });
    const st = holderState(s, 'sysmon', [resumed], NOW);
    expect(st.state).toBe('bound');
    expect(st.endpoint?.pid).toBe(999);
    const h = refreshHolder(s, 'sysmon', [resumed], NOW).holders[0];
    expect(h).toEqual(holder({ pid: 999, title: 'A2', cwd: '/w', lastSeenLiveAt: NOW }));
    expect(refreshHolder(s, 'sysmon', [], NOW)).toEqual(s);
  });

  test('failing deliveries for 10 min or an expired TTL → vacant', () => {
    expect(holderState(store(holder({ failingSince: NOW - 10 * MIN })), 'sysmon', [epA], NOW).state).toBe('vacant');
    expect(holderState(store(holder({ failingSince: NOW - 9 * MIN })), 'sysmon', [epA], NOW).state).toBe('bound');
    expect(holderState(store(holder({ expiresAt: NOW })), 'sysmon', [epA], NOW).state).toBe('vacant');
  });

  test('claim: vacant → ok; same session → ok with a refreshed TTL; another session → code 3 naming the holder', () => {
    const first = claimHolder(store(), 'sysmon', claimA, [epA], NOW, HOUR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.holder).toMatchObject({ source: 'sysmon', sessionId: A, pid: 100, since: NOW, expiresAt: NOW + HOUR, request: null, failingSince: null });
    const again = claimHolder(first.store, 'sysmon', claimA, [epA], NOW + MIN, 2 * HOUR);
    expect(again.ok && again.holder).toMatchObject({ sessionId: A, since: NOW, expiresAt: NOW + MIN + 2 * HOUR });
    const other = claimHolder(first.store, 'sysmon', claimB, [epA, epB], NOW, HOUR);
    expect(other).toMatchObject({ ok: false, code: 3 });
    expect(other.holder?.sessionId).toBe(A);
    const forever = claimHolder(store(), 'sysmon', claimA, [epA], NOW, null);
    expect(forever.ok && forever.holder.expiresAt).toBeNull();
    expect(takeHolder(store(), 'sysmon', claimA, [epA], NOW, 0).ok && forever.ok && forever.holder.expiresAt).toBeNull();
    const taken0 = takeHolder(store(), 'sysmon', claimA, [epA], NOW, 0);
    expect(taken0.ok && taken0.holder.expiresAt).toBeNull();
  });

  test('a re-claim while suspended (resuming) refreshes pid/title/cwd, lastSeenLiveAt and the TTL', () => {
    const suspended = store(holder({ lastSeenLiveAt: NOW - 5 * MIN, request: { sessionId: B, title: 'B', pid: 200, at: NOW - MIN, reason: null } }));
    expect(holderState(suspended, 'sysmon', [], NOW).state).toBe('suspended');
    const re = claimHolder(suspended, 'sysmon', { sessionId: A, title: 'A2', pid: 555, cwd: '/w' }, [], NOW, HOUR);
    expect(re.ok && re.holder).toEqual(holder({ title: 'A2', pid: 555, cwd: '/w', lastSeenLiveAt: NOW, expiresAt: NOW + HOUR, request: { sessionId: B, title: 'B', pid: 200, at: NOW - MIN, reason: null } }));
  });

  test('no expiry: never vacant by the expiry branch and survives serialize', () => {
    const forever = store(holder({ expiresAt: null }));
    expect(holderState(forever, 'sysmon', [epA], NOW + 1000 * HOUR).state).toBe('bound');
    expect(parseAlertSubscriptions(serializeAlertSubscriptions(forever, NOW + 1000 * HOUR), NOW + 1000 * HOUR).holders).toEqual(forever.holders);
  });

  test('request: vacant or own slot → code 3; a pending request of any age blocks another requester', () => {
    expect(requestHandoff(store(), 'sysmon', claimB, [epB], NOW, null)).toMatchObject({ ok: false, code: 3 });
    expect(requestHandoff(store(holder()), 'sysmon', claimA, [epA], NOW, null)).toMatchObject({ ok: false, code: 3 });
    const r = requestHandoff(store(holder()), 'sysmon', claimB, [epA, epB], NOW, 'need it');
    expect(r.ok && r.holder.request).toEqual({ sessionId: B, title: 'B', pid: 200, at: NOW, reason: 'need it' });
    if (!r.ok) return;
    const claimC: Claimant = { sessionId: 'c', title: 'C', pid: 300, cwd: null };
    expect(requestHandoff(r.store, 'sysmon', claimC, [epA], NOW + MIN, null)).toMatchObject({ ok: false, code: 3 });
    const later = requestHandoff(r.store, 'sysmon', claimC, [epA], NOW + 50 * MIN, null);
    expect(later).toMatchObject({ ok: false, code: 3 });
    expect(later.ok ? '' : later.error).toContain(B);
  });

  test('withdrawRequest drops only the matching request', () => {
    const req = { sessionId: B, title: 'B', pid: 200, at: NOW, reason: null };
    const asked = store(holder({ request: req }));
    expect(withdrawRequest(asked, 'sysmon', B, NOW).holders[0].request).toBeNull();
    expect(withdrawRequest(asked, 'sysmon', B, NOW + 1)).toEqual(asked);
    expect(withdrawRequest(asked, 'sysmon', 'c', NOW)).toEqual(asked);
  });

  test('take: the requester only after 10 min unanswered; anyone when vacant', () => {
    const asked = store(holder({ request: { sessionId: B, title: 'B', pid: 200, at: NOW, reason: null } }));
    expect(takeHolder(asked, 'sysmon', claimB, [epA, epB], NOW + 10 * MIN - 1, HOUR)).toMatchObject({ ok: false, code: 3 });
    const taken = takeHolder(asked, 'sysmon', claimB, [epA, epB], NOW + 10 * MIN, HOUR);
    expect(taken.ok && taken.holder).toMatchObject({ sessionId: B, request: null, since: NOW + 10 * MIN });
    expect(takeHolder(store(holder()), 'sysmon', claimB, [epA, epB], NOW, HOUR)).toMatchObject({ ok: false, code: 3 });
    expect(takeHolder(store(), 'sysmon', claimB, [epB], NOW, HOUR).ok).toBe(true);
  });

  test('grant: holder only, to a live target; deny clears the request; release by the holder only', () => {
    const asked = store(holder({ request: { sessionId: B, title: 'B', pid: 200, at: NOW, reason: null } }));
    expect(grantHandoff(asked, 'sysmon', A, claimB, [epA], NOW)).toMatchObject({ ok: false, code: 1 });
    expect(grantHandoff(asked, 'sysmon', B, claimB, [epA, epB], NOW)).toMatchObject({ ok: false, code: 1 });
    const granted = grantHandoff(asked, 'sysmon', A, claimB, [epA, epB], NOW);
    expect(granted.ok && granted.holder).toEqual({ source: 'sysmon', sessionId: B, title: 'B', pid: 200, cwd: '/tmp', since: NOW, lastSeenLiveAt: NOW, failingSince: null, expiresAt: NOW + DEFAULT_ALERT_TTL_MS, request: null });
    const forever = grantHandoff(store(holder({ expiresAt: null, failingSince: NOW - MIN })), 'sysmon', A, claimB, [epA, epB], NOW);
    expect(forever.ok && forever.holder).toMatchObject({ expiresAt: null, failingSince: null });
    expect(denyHandoff(store(holder()), 'sysmon', A, [epA], NOW)).toMatchObject({ ok: false, code: 1, error: 'no pending handoff request' });
    const denied = denyHandoff(asked, 'sysmon', A, [epA], NOW);
    expect(denied.ok && denied.holder.request).toBeNull();
    expect(denied.denied?.sessionId).toBe(B);
    expect(denyHandoff(asked, 'sysmon', B, [epA], NOW)).toMatchObject({ ok: false, code: 1 });
    // A holder whose slot went vacant (deliveries failing 10 min) no longer answers requests.
    const lapsed = store(holder({ failingSince: NOW - 10 * MIN, request: { sessionId: B, title: 'B', pid: 200, at: NOW, reason: null } }));
    expect(denyHandoff(lapsed, 'sysmon', A, [epA], NOW)).toMatchObject({ ok: false, code: 1 });
    expect(releaseHolder(asked, 'sysmon', B)).toMatchObject({ ok: false, code: 1 });
    const released = releaseHolder(asked, 'sysmon', A);
    expect(released.ok && released.store.holders).toEqual([]);
  });

  test('parse: an old store without holders, a malformed holder dropped, a holder with a request round-trips', () => {
    expect(parseAlertSubscriptions(JSON.stringify({ version: 1, subscriptions: [sub()] }), NOW)).toEqual({ subscriptions: [sub()], holders: [] });
    const { source: _drop, ...noSource } = holder();
    const blob = JSON.stringify({ version: 1, subscriptions: [], holders: [noSource, { ...holder(), pid: 'x' }, 7, null] });
    expect(parseAlertSubscriptions(blob, NOW).holders).toEqual([]);
    expect(parseAlertSubscriptions(JSON.stringify({ version: 1, subscriptions: [], holders: 'x' }), NOW).holders).toEqual([]);
    const bad = [
      { ...holder(), since: null },
      { ...holder(), lastSeenLiveAt: 'now' },
      { ...holder(), failingSince: -1 },
      { ...holder(), expiresAt: '1' },
      { ...holder(), request: { sessionId: B } },
      { ...holder(), request: { sessionId: B, title: null, pid: null, at: null, reason: null } },
      { ...holder(), request: 'x' },
    ];
    expect(parseAlertSubscriptions(JSON.stringify({ version: 1, subscriptions: [], holders: bad }), NOW).holders).toEqual([]);
    // Not JSON-representable, but a parse must hold even for an in-memory blob with NaN/Infinity text.
    expect(() => parseAlertSubscriptions('{"version":1,"subscriptions":[],"holders":[{"since":NaN}]}', NOW)).not.toThrow();
    const late = holder({ sessionId: B, since: NOW - MIN });
    const early = holder({ since: NOW - HOUR });
    expect(parseAlertSubscriptions(JSON.stringify({ version: 1, subscriptions: [], holders: [late, early] }), NOW).holders).toEqual([early]);
    const withRequest = holder({ request: { sessionId: B, title: null, pid: null, at: NOW, reason: 'r' }, failingSince: NOW - MIN });
    const expired = holder({ source: 'old', expiresAt: NOW - 1 });
    expect(parseAlertSubscriptions(serializeAlertSubscriptions(store(withRequest, expired), NOW), NOW).holders).toEqual([withRequest]);
  });

  test('subscription upsert/remove leave holders untouched', () => {
    const s = store(holder());
    expect(upsertAlertSubscription(s, sub()).holders).toEqual([holder()]);
    expect(removeAlertSubscription(s, A).holders).toEqual([holder()]);
  });

  test('a delivery result for a session that no longer holds the slot changes nothing', () => {
    const since = NOW - HOUR;
    const movedToB = store(holder({ sessionId: B }));
    expect(markHolderDelivery(movedToB, 'sysmon', A, since, false, NOW)).toEqual(movedToB);
    // Same session, newer tenure (released and re-claimed meanwhile): unchanged too.
    expect(markHolderDelivery(movedToB, 'sysmon', B, since - 1, false, NOW)).toEqual(movedToB);
    const failing = markHolderDelivery(movedToB, 'sysmon', B, since, false, NOW);
    expect(failing.holders[0].failingSince).toBe(NOW);
    expect(markHolderDelivery(failing, 'sysmon', B, since, false, NOW + MIN).holders[0].failingSince).toBe(NOW);
    expect(markHolderDelivery(failing, 'sysmon', B, since, true, NOW + MIN).holders[0]).toMatchObject({ failingSince: null, lastSeenLiveAt: NOW + MIN });
  });

  test('holder throttle: a delivered holder send is posted with messageId 0 and survives parse only for holder: keys', () => {
    const key = `holder:${throttleKey('sysmon', 'swap', 'warning')}`;
    const settled = settleHolderAlert(claimAlert({ sent: [] }, key, NOW), key, NOW);
    // Fenced on the claim's time: another sender's newer claim is never settled or released.
    const replaced = claimAlert({ sent: [] }, key, NOW + 5);
    expect(settleHolderAlert(replaced, key, NOW)).toEqual(replaced);
    expect(releaseHolderClaim(replaced, key, NOW)).toEqual(replaced);
    expect(releaseHolderClaim(replaced, key, NOW + 5).sent).toEqual([]);
    expect(releaseHolderClaim(settled, key, NOW)).toEqual(settled);
    expect(throttleVerdict(settled, key, NOW + 1, DEFAULT_ALERT_WINDOW_MS).kind).toBe('throttled');
    expect(parseAlertThrottle(serializeAlertThrottle(settled, NOW), NOW).sent).toEqual([{ key, at: NOW, messageId: 0, pending: [] }]);
    const plain = JSON.stringify({ version: 1, sent: [{ key: 'sysmon|swap|warning', at: NOW, messageId: 0, pending: [] }] });
    expect(parseAlertThrottle(plain, NOW).sent).toEqual([]);
    expect(settleAlert(claimAlert({ sent: [] }, key, NOW), key, null, []).sent).toEqual([]);
  });
});

describe('holder argv', () => {
  test('subscribe --exclusive needs --source and refuses --sources', () => {
    expect(parseAlertArgv(['subscribe', '--exclusive', '--source', 'sysmon'])).toEqual({ cmd: 'subscribe', pid: null, sessionId: null, sources: null, ttlMs: DEFAULT_ALERT_TTL_MS, exclusive: true, source: 'sysmon' });
    expect(parseAlertArgv(['subscribe', '--exclusive'])).toEqual({ cmd: 'error', error: '--exclusive requires --source' });
    expect(parseAlertArgv(['subscribe', '--exclusive', '--source', 'sysmon', '--sources', 'a'])).toEqual({ cmd: 'error', error: '--exclusive and --sources are exclusive' });
    expect(parseAlertArgv(['subscribe', '--source', 'sysmon'])).toEqual({ cmd: 'error', error: '--source requires --exclusive (use --sources for a non-exclusive subscription)' });
    expect(parseAlertArgv(['subscribe', '--exclusive', '--source', 'bad source'])).toEqual({ cmd: 'error', error: 'invalid --source: bad source (letters, digits, - _ . only)' });
  });

  test('handoff-request, handoff, take, release, holder', () => {
    expect(parseAlertArgv(['handoff-request', '--source', 'sysmon', '--reason', 'need it', '--pid', '7'])).toEqual({ cmd: 'handoff-request', source: 'sysmon', reason: 'need it', pid: 7, sessionId: null });
    expect(parseAlertArgv(['handoff', '--source', 'sysmon', '--to', 'b', '--session', 'a'])).toEqual({ cmd: 'handoff', source: 'sysmon', to: 'b', deny: false, reason: null, pid: null, sessionId: 'a' });
    expect(parseAlertArgv(['handoff', '--source', 'sysmon', '--deny', '--reason', 'busy'])).toEqual({ cmd: 'handoff', source: 'sysmon', to: null, deny: true, reason: 'busy', pid: null, sessionId: null });
    expect(parseAlertArgv(['handoff', '--source', 'sysmon', '--to', 'b', '--deny'])).toEqual({ cmd: 'error', error: '--to and --deny are exclusive' });
    expect(parseAlertArgv(['handoff', '--source', 'sysmon'])).toEqual({ cmd: 'error', error: 'handoff requires --to <session id> or --deny' });
    expect(parseAlertArgv(['take', '--source', 'sysmon', '--ttl', '0'])).toEqual({ cmd: 'take', source: 'sysmon', pid: null, sessionId: null, ttlMs: null });
    expect(parseAlertArgv(['take', '--source', 'sysmon'])).toEqual({ cmd: 'take', source: 'sysmon', pid: null, sessionId: null, ttlMs: DEFAULT_ALERT_TTL_MS });
    expect(parseAlertArgv(['release', '--source', 'sysmon', '--pid', '9'])).toEqual({ cmd: 'release', source: 'sysmon', pid: 9, sessionId: null });
    expect(parseAlertArgv(['holder', '--source', 'sysmon', '--json'])).toEqual({ cmd: 'holder', source: 'sysmon', json: true });
    expect(parseAlertArgv(['holder'])).toEqual({ cmd: 'error', error: 'holder requires --source' });
    expect(parseAlertArgv(['take', '--source', 'a/b'])).toEqual({ cmd: 'error', error: 'invalid --source: a/b (letters, digits, - _ . only)' });
    expect(parseAlertArgv(['release', '--source', 's', '--pid', '1', '--session', 'x'])).toEqual({ cmd: 'error', error: '--pid and --session are exclusive' });
  });

  test('send --to-holder and the usage line', () => {
    const cmd = parseAlertArgv(['send', '--to-holder', '--source', 'sysmon', '--severity', 'warning', '--key', 'swap', '--text', 't']);
    expect(cmd.cmd === 'send' && cmd.toHolder).toBe(true);
    const plain = parseAlertArgv(['send', '--source', 'sysmon', '--severity', 'warning', '--key', 'swap', '--text', 't']);
    expect(plain.cmd === 'send' && plain.toHolder).toBe(false);
    expect(parseAlertArgv(['nope'])).toEqual({ cmd: 'error', error: 'usage: tg-ctl alert send|subscribe|unsubscribe|list|handoff-request|handoff|take|release|holder' });
  });
});

describe('holder delivery helpers', () => {
  const ep = endpoint({ pid: 1, sessionId: 's' });
  const fresh = endpoint({ pid: 2, sessionId: 's', instanceId: 'new' });
  const fail = (code: string) => Object.assign(new Error(code), { code });

  test('a stale_identity answer re-resolves the endpoint once and retries', async () => {
    const tried: number[] = [];
    const ok = await deliverWithStaleRetry(ep, async (e) => {
      tried.push(e.pid);
      if (e.pid === 1) throw fail('stale_identity');
    }, async () => fresh);
    expect(ok).toBeNull();
    expect(tried).toEqual([1, 2]);
    expect(await deliverWithStaleRetry(ep, async () => { throw fail('stale_identity'); }, async () => fresh)).toBe('stale_identity');
    expect(await deliverWithStaleRetry(ep, async () => { throw fail('stale_identity'); }, async () => null)).toBe('endpoint_unavailable');
    // A resume under a new pid: the old pid has no endpoint at all.
    const resumed: number[] = [];
    expect(await deliverWithStaleRetry(ep, async (e) => {
      resumed.push(e.pid);
      if (e.pid === 1) throw fail('endpoint_unavailable');
    }, async () => fresh)).toBeNull();
    expect(resumed).toEqual([1, 2]);
    let calls = 0;
    expect(await deliverWithStaleRetry(ep, async () => { calls++; throw fail('invalid_acceptance'); }, async () => fresh)).toBe('invalid_acceptance');
    expect(calls).toBe(1);
  });

  test('the holder copy is measured in bytes against the transport limit', () => {
    const text = '😀'.repeat(16_000);
    expect(text.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(Buffer.byteLength(holderAlertText(msg({ text })))).toBeGreaterThan(HOLDER_TEXT_MAX_BYTES);
  });

  test('holder request ids are bounded and sanitized', () => {
    const id = holderRequestId('s'.repeat(64), 'x/'.repeat(400), NOW, 'n'.repeat(99));
    expect(id.length).toBeLessThanOrEqual(256);
    expect(id).toMatch(/^[A-Za-z0-9:_.-]+$/);
    // Same holder, same millisecond, two deliveries: distinct ids (the host rejects a reuse).
    expect(holderRequestId('sysmon', 's', NOW, 'a')).not.toBe(holderRequestId('sysmon', 's', NOW, 'b'));
  });

  test('the holder throttle key names the holder, so a handoff starts a fresh window', () => {
    expect(holderThrottleKey('A', 'sysmon', 'swap', 'warning')).toBe('holder:A:sysmon|swap|warning');
    expect(holderThrottleKey('A', 'sysmon', 'swap', 'warning')).not.toBe(holderThrottleKey('B', 'sysmon', 'swap', 'warning'));
  });
});
