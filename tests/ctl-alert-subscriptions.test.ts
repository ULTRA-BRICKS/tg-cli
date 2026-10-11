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

describe('subscription store', () => {
  test('round-trips and prunes expired subscriptions on serialize and parse', () => {
    const live = sub();
    const expired = sub({ sessionId: 'dead', expiresAt: NOW - 1 });
    const forever = sub({ sessionId: 'forever', expiresAt: null });
    const blob = serializeAlertSubscriptions({ subscriptions: [live, expired, forever] }, NOW);
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
    const closed = resolveAlertBindings({ subscriptions: [sub({ sessionId: 'closed', pid: null, title: null })] }, [], NOW);
    expect(formatAlertList(closed, NOW)).toContain('suspended (no live omp-live endpoint) · (untitled) · pid ? · session closed');
    expect(resolveAlertBindings({ subscriptions: [sub({ sessionId: 'closed', pid: null })] }, [endpoint({ sessionId: 'closed', pid: 77 })], NOW)[0].subscription.pid).toBe(77);
  });

  test('upsert replaces the record of the same sessionId; remove drops it', () => {
    const a = sub();
    const b = sub({ sessionId: 'other', pid: 7 });
    let store = upsertAlertSubscription({ subscriptions: [a] }, b);
    store = upsertAlertSubscription(store, { ...a, pid: 99, sources: ['sysmon'] });
    expect(store.subscriptions.map((s) => s.pid)).toEqual([7, 99]);
    expect(removeAlertSubscription(store, 'other').subscriptions.map((s) => s.sessionId)).toEqual([a.sessionId]);
  });
});

describe('binding resolution against the live registry', () => {
  test('a live endpoint with the same sessionId binds — pid and title are refreshed from it (resume)', () => {
    const resumed = endpoint({ pid: 4_000_001, instanceId: 'f'.repeat(32), title: 'renamed' });
    const [b] = resolveAlertBindings({ subscriptions: [sub()] }, [resumed], NOW);
    expect(b.state).toBe('bound');
    expect(b.endpoint).toEqual(resumed);
    expect(b.subscription.pid).toBe(4_000_001);
    expect(b.subscription.title).toBe('renamed');
  });

  test('no live endpoint → suspended; expired → dropped', () => {
    const bindings = resolveAlertBindings(
      { subscriptions: [sub(), sub({ sessionId: 'gone', pid: 1 }), sub({ sessionId: 'old', expiresAt: NOW - 1 })] },
      [endpoint()],
      NOW,
    );
    expect(bindings.map((b) => [b.subscription.sessionId, b.state])).toEqual([
      [sub().sessionId, 'bound'],
      ['gone', 'suspended'],
    ]);
  });

  test('a source filter keeps subscriptions for that source or for every source', () => {
    const store = { subscriptions: [sub({ sources: ['sysmon'] }), sub({ sessionId: 's2', sources: ['supervisor'] }), sub({ sessionId: 's3', sources: null })] };
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
    const bound = resolveAlertBindings({ subscriptions: [sub()] }, [endpoint()], NOW);
    const body = telegramAlertBody(msg({ text: 'load 38 > 24 & swap' }), bound);
    expect(body).toBe('load 38 &gt; 24 &amp; swap\n\n<i>↳ также адресовано агенту: 🕹️ AGENTS: Supervise omp agents and rig (pid 3467203)</i>');
    expect(telegramAlertBody(msg({ text: '<b>x</b>', html: true }), [])).toBe('<b>x</b>');
    const suspended = resolveAlertBindings({ subscriptions: [sub()] }, [], NOW);
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
    });
    expect(parseAlertArgv(['send', '--source', 'supervisor', '--severity', 'critical', '--key', 'OVERLOAD', '--text', 'x', '--html', '--window', '2m', '--force', '--title', 'T'])).toEqual({
      cmd: 'send',
      message: { source: 'supervisor', severity: 'critical', key: 'OVERLOAD', text: 'x', html: true, title: 'T' },
      windowMs: 120_000,
      force: true,
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
    expect(parseAlertArgv(['subscribe'])).toEqual({ cmd: 'subscribe', pid: null, sessionId: null, sources: null, ttlMs: DEFAULT_ALERT_TTL_MS });
    expect(parseAlertArgv(['subscribe', '--pid', '42', '--sources', 'sysmon,supervisor', '--ttl', '0'])).toEqual({ cmd: 'subscribe', pid: 42, sessionId: null, sources: ['sysmon', 'supervisor'], ttlMs: null });
    expect(parseAlertArgv(['subscribe', '--session', 'abc', '--ttl', '2h'])).toEqual({ cmd: 'subscribe', pid: null, sessionId: 'abc', sources: null, ttlMs: 2 * HOUR });
    expect(parseAlertArgv(['subscribe', '--pid', 'x'])).toEqual({ cmd: 'error', error: 'invalid --pid: x' });
    expect(parseAlertArgv(['unsubscribe', '--all'])).toEqual({ cmd: 'unsubscribe', pid: null, sessionId: null, all: true });
    expect(parseAlertArgv(['unsubscribe', '--pid', '5'])).toEqual({ cmd: 'unsubscribe', pid: 5, sessionId: null, all: false });
    expect(parseAlertArgv(['unsubscribe', '--pid', '5', '--session', 'a'])).toEqual({ cmd: 'error', error: '--pid and --session are exclusive' });
    expect(parseAlertArgv(['subscribe', '--sources', ' ,'])).toEqual({ cmd: 'error', error: 'invalid --sources:  ,' });
    expect(parseAlertArgv(['list', '--json'])).toEqual({ cmd: 'list', json: true });
    expect(parseAlertArgv([])).toEqual({ cmd: 'error', error: 'usage: tg-ctl alert send|subscribe|unsubscribe|list' });
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
  const bindings = resolveAlertBindings({ subscriptions: [sub(), sub({ sessionId: 'gone', pid: 1, title: null, expiresAt: null, sources: ['sysmon'] })] }, [endpoint()], NOW);
  expect(formatAlertList(bindings, NOW)).toBe([
    'alert subscriptions: 2',
    '  - bound · 🕹️ AGENTS: Supervise omp agents and rig · pid 3467203 · session 01a11860-850d-729a-ae3f-d5ffb6d07464 · sources: all · expires in 1 h 0 min',
    '  - suspended (no live omp-live endpoint) · (untitled) · pid 1 · session gone · sources: sysmon · no expiry',
  ].join('\n'));
  expect(formatAlertList([], NOW)).toBe('alert subscriptions: none');
});
