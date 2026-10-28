// Module-boundary contract of the alert decomposition (tg-cli#817): the argv grammar, the
// throttle-receipt reader and the shared limits live in alert-remediation/, while every
// name callers (tg-ctl, tests) import from alert-subscriptions keeps resolving to the
// same implementation. Behavior is pinned by alert-parser-modular-parity.test.ts.

import { describe, expect, test } from 'bun:test';
import * as facade from '../features/tg-ctl/alert-subscriptions';
import * as argv from '../features/tg-ctl/alert-remediation/alert-argv';
import * as primitives from '../features/tg-ctl/alert-remediation/alert-primitives';
import * as records from '../features/tg-ctl/alert-remediation/throttle-records';

describe('alert-subscriptions facade', () => {
  test('re-exports the decomposed parsers and limits unchanged', () => {
    expect(facade.parseAlertArgv).toBe(argv.parseAlertArgv);
    expect(facade.parseDurationMs).toBe(argv.parseDurationMs);
    expect(facade.parseAlertThrottle).toBe(records.parseAlertThrottle);
    for (const name of ['DEFAULT_ALERT_TTL_MS', 'DEFAULT_ALERT_WINDOW_MS', 'HOLDER_TEXT_MAX_BYTES', 'KEY_MAX', 'TEXT_MAX', 'TITLE_MAX'] as const) {
      expect(facade[name]).toBe(primitives[name]);
    }
  });
});

describe('persisted receipt retention', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60_000;
  const store = (sent: unknown[]): string => JSON.stringify({ version: 1, sent });

  test('an unresolved internal receipt outlives the ordinary 24 h window; an ordinary one does not', () => {
    const old = NOW - 2 * DAY;
    const parsed = records.parseAlertThrottle(store([
      { key: 'internal:a', at: old, messageId: 0, internalText: 'incident', pending: ['s1'] },
      { key: 'rig|k|info', at: old, messageId: 7, pending: [] },
    ]), NOW);
    expect(parsed.sent.map((e) => e.key)).toEqual(['internal:a']);
  });

  test('a resolved internal receipt expires with the ordinary window', () => {
    const attempt = { sessionId: 's1', pid: 5, instanceId: 'a'.repeat(32) };
    const resolved = { key: 'internal:a', at: NOW - 2 * DAY, messageId: 0, internalText: 'incident', pending: [], internalRecipients: ['s1'], internalAttempts: [attempt] };
    expect(records.parseAlertThrottle(store([resolved]), NOW).sent).toEqual([]);
    expect(records.parseAlertThrottle(store([{ ...resolved, internalRecipients: [] }]), NOW).sent).toHaveLength(1);
  });
});
