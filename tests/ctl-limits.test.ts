import { expect, test } from 'bun:test';
import {
  autoContinueDelayMs,
  buildCodexHardLimitDiagnostic,
  buildLimitNotification,
  buildTransientAutoContinue,
  buildUsageLimitNotification,
  classifyFailure,
  continueCallbackData,
  extractAssistantText,
  extractFailure,
  extractUsageLimitEvent,
  extractUsageLimitEvents,
  formatClock,
  formatDelta,
  MAX_TIMER_MS,
  overloadAutoContinueDelayMs,
  parseContinueCallback,
  parseResetTime,
  type HarnessFailureEvent,
  type UsageLimitEvent,
} from '../features/tg-ctl/limits';
import { hasUnpairedSurrogate } from '../features/tg-ctl/text-util';

// A fixed local reference so wall-clock resolution is deterministic regardless of
// when the suite runs. 2026-07-02 12:00 local.
const NOW = new Date(2026, 6, 2, 12, 0, 0, 0).getTime();

const ev = (over: Partial<HarnessFailureEvent> = {}): HarnessFailureEvent => ({
  kind: 'session-limit',
  agent: 'hyperide',
  paneId: '%3',
  sessionId: null,
  reason: 'session_limit',
  detail: '',
  resetAt: null,
  sourceMessageId: null,
  ...over,
});

const usageEv = (over: Partial<UsageLimitEvent> = {}): UsageLimitEvent => ({
  kind: 'usage-warning',
  agent: 'codex',
  percent: 91,
  limitName: 'primary',
  resetAt: NOW + 60 * 60_000,
  language: 'en',
  detail: '',
  ...over,
});

test('classifyFailure: a limit matcher is a session-limit, everything else an api-error', () => {
  expect(classifyFailure('session_limit')).toBe('session-limit');
  expect(classifyFailure('rate_limit')).toBe('session-limit');
  expect(classifyFailure('overloaded')).toBe('api-error');
  expect(classifyFailure('billing_error')).toBe('api-error');
});

test('parseResetTime: 12h wall clock resolves to the next future occurrence (local)', () => {
  // 4:10am is BEFORE 12:00 now → tomorrow 04:10.
  const r = parseResetTime('You have hit your session limit · resets 4:10am (Europe/Belgrade)', NOW);
  expect(r).not.toBeNull();
  const d = new Date(r!);
  expect(d.getHours()).toBe(4);
  expect(d.getMinutes()).toBe(10);
  expect(d.getDate()).toBe(3); // rolled to tomorrow
});

test('parseResetTime: a time later today stays today', () => {
  const r = parseResetTime('5-hour limit reached ∙ resets 3pm', NOW);
  const d = new Date(r!);
  expect(d.getHours()).toBe(15);
  expect(d.getMinutes()).toBe(0);
  expect(d.getDate()).toBe(2); // still today
});

test('parseResetTime: 24h form and "reset at" phrasing', () => {
  expect(new Date(parseResetTime('resets 16:10', NOW)!).getHours()).toBe(16);
  expect(new Date(parseResetTime('Your limit will reset at 4am', NOW)!).getHours()).toBe(4);
  expect(new Date(parseResetTime('resets 12pm', NOW)!).getHours()).toBe(12);
  expect(new Date(parseResetTime('resets 12am', NOW)!).getHours()).toBe(0);
});

test('parseResetTime: explicit ISO timestamp wins', () => {
  const r = parseResetTime('resets at 2026-07-02T04:10:00+02:00', NOW);
  expect(r).toBe(Date.parse('2026-07-02T04:10:00+02:00'));
});

test('parseResetTime: no reset info → null; nonsense clock → null', () => {
  expect(parseResetTime('overloaded_error: please try again', NOW)).toBeNull();
  expect(parseResetTime('overloaded_error: please try again at 4:10pm', NOW)).toBeNull();
  expect(parseResetTime('resets 13pm', NOW)).toBeNull();
  expect(parseResetTime('resets 25:00', NOW)).toBeNull();
});

test('parseResetTime: a bare count near "resets" is NOT a time (no false positive)', () => {
  expect(parseResetTime('the counter resets 3 times per hour', NOW)).toBeNull();
  expect(parseResetTime('resets 5 requests remaining', NOW)).toBeNull();
});

test('parseResetTime: a bare count does NOT shadow the real reset later in the text', () => {
  // The first "resets 3 times" must not swallow the parse — scan finds "resets 4:10am".
  const r = parseResetTime('counter resets 3 times. your session resets 4:10am', NOW);
  expect(new Date(r!).getHours()).toBe(4);
  expect(new Date(r!).getMinutes()).toBe(10);
});

test('parseResetTime: an unrelated ISO timestamp far from "reset" is ignored', () => {
  // A transcript line stamp must not be mistaken for the reset time.
  const text = '2020-01-01T00:00:00Z the agent said hi. later: your session limit resets 4:10am';
  const r = parseResetTime(text, NOW);
  expect(new Date(r!).getHours()).toBe(4); // the wall clock near "resets", not the 2020 stamp
});

test('extractAssistantText: pulls the LAST assistant message, both content shapes, ignoring stamps', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-07-02T09:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] }, timestamp: '2026-07-02T09:01:00.000Z' }),
    JSON.stringify({ role: 'assistant', content: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }),
    'not json — skipped',
  ].join('\n');
  const text = extractAssistantText(jsonl);
  expect(text).toContain('session limit');
  expect(text).not.toContain('2026-07-02T09'); // no timestamp bled in
});

test('extractAssistantText + extractFailure: a realistic JSONL transcript yields the reset + clean detail', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-07-02T08:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }] }, timestamp: '2026-07-02T10:00:00.000Z' }),
  ].join('\n');
  const f = extractFailure('session_limit', extractAssistantText(jsonl), NOW);
  expect(f.kind).toBe('session-limit');
  expect(new Date(f.resetAt!).getHours()).toBe(4);
  // detail is clean prose, NOT a raw JSONL line with a timestamp
  expect(f.detail).toContain('session limit');
  expect(f.detail).not.toContain('timestamp');
  expect(f.detail).not.toContain('{');
});

test('staleness guard: a limit whose reset is already past is SUPPRESSED (null)', () => {
  const past = NOW - 60_000;
  expect(buildLimitNotification(ev({ resetAt: past }), NOW)).toBeNull();
  // exactly now also counts as past
  expect(buildLimitNotification(ev({ resetAt: NOW }), NOW)).toBeNull();
});

test('notification: future reset → text + auto-continue button; no unrendered placeholder', () => {
  const future = NOW + 3 * 60 * 60_000 + 5 * 60_000; // +3h05m
  const n = buildLimitNotification(ev({ resetAt: future, sourceMessageId: 55 }), NOW)!;
  expect(n).not.toBeNull();
  expect(n.text).toContain('hyperide');
  expect(n.text).toContain('Resets at');
  expect(n.text).toContain('in 3h 5m');
  expect(n.button).not.toBeNull();
  // the source message id is threaded into the button so the resume flip can find it
  expect(n.button!.data).toBe(continueCallbackData('%3', future, 55));
  expect(n.button!.data).toContain(':55');
  // bug (c): the rendered text must never carry a printf-style or template token.
  expect(n.text).not.toMatch(/%\d/);
  expect(n.text).not.toMatch(/%s/);
  expect(n.text).not.toMatch(/\{[a-z]+\}/i);
});

test('notification: session-limit with unknown reset → alert, no button, NOT suppressed', () => {
  const n = buildLimitNotification(ev({ resetAt: null }), NOW)!;
  expect(n).not.toBeNull();
  expect(n.button).toBeNull();
  expect(n.text).toContain('Reset time unknown');
});

test('notification: api-error → alert with reason, no button', () => {
  const n = buildLimitNotification(ev({ kind: 'api-error', reason: 'overloaded', resetAt: null }), NOW)!;
  expect(n.text).toContain('API error');
  expect(n.text).toContain('overloaded');
  expect(n.button).toBeNull();
});

test('transient auto-continue: overload API errors get language-specific continue text', () => {
  const failure = ev({
    kind: 'api-error',
    reason: 'unknown',
    detail: 'API Error: 529 Overloaded. The upstream provider is temporarily overloaded.',
    resetAt: null,
  });
  expect(buildTransientAutoContinue(failure, { attempt: 1, language: 'en' })).toMatchObject({
    text: 'continue',
    attempt: 1,
    delayMs: overloadAutoContinueDelayMs(1),
  });
  expect(buildTransientAutoContinue(failure, { attempt: 2, language: 'ru' })).toMatchObject({
    text: 'продолжи',
    attempt: 2,
    delayMs: overloadAutoContinueDelayMs(2),
  });
});

test('transient auto-continue: backoff is increasing and never tight-loops', () => {
  const delays = [1, 2, 4, 8].map((attempt) => overloadAutoContinueDelayMs(attempt));
  expect(delays[0]).toBeGreaterThanOrEqual(30_000);
  expect(delays[1]).toBeGreaterThan(delays[0]);
  expect(delays[2]).toBeGreaterThan(delays[1]);
  expect(delays[3]).toBeGreaterThan(delays[2]);
});

test('transient auto-continue: non-retryable failures are not auto-continued', () => {
  for (const [reason, detail] of [
    ['billing_error', 'Billing quota exhausted.'],
    ['authentication_failed', 'Invalid API key.'],
    ['invalid_request', 'Invalid request body.'],
    ['max_output_tokens', 'Maximum output tokens exceeded.'],
  ]) {
    expect(buildTransientAutoContinue(ev({ kind: 'api-error', reason, detail, resetAt: null }), { attempt: 1, language: 'en' })).toBeNull();
  }
});

test('notification: no button when the reset is known but the pane is not', () => {
  const n = buildLimitNotification(ev({ resetAt: NOW + 60_000, paneId: null }), NOW)!;
  expect(n.button).toBeNull();
});

test('notification: agent name is HTML-escaped', () => {
  const n = buildLimitNotification(ev({ agent: 'a<b>&c', resetAt: NOW + 60_000 }), NOW)!;
  expect(n.text).toContain('a&lt;b&gt;&amp;c');
  expect(n.text).not.toContain('a<b>&c');
});

test('notification: short reset delta is HTML-escaped', () => {
  const n = buildLimitNotification(ev({ resetAt: NOW + 30_000 }), NOW)!;
  expect(n.text).toContain('&lt;1m');
  expect(n.text).not.toContain('(<1m)');
});

test('autoContinueDelayMs: future = remaining, past = 0, far future clamped', () => {
  expect(autoContinueDelayMs(NOW + 5000, NOW)).toBe(5000);
  expect(autoContinueDelayMs(NOW - 5000, NOW)).toBe(0);
  expect(autoContinueDelayMs(NOW + MAX_TIMER_MS * 3, NOW)).toBe(MAX_TIMER_MS);
});

test('parseContinueCallback: round-trips a tap with/without a source id, rejects foreign data', () => {
  expect(parseContinueCallback(continueCallbackData('%12', 1720000000000))).toEqual({
    paneId: '%12',
    resetAt: 1720000000000,
    sourceMessageId: null,
  });
  // the source message id survives the round-trip and is NOT swallowed into paneId
  expect(parseContinueCallback(continueCallbackData('%3', 1720000000000, 55))).toEqual({
    paneId: '%3',
    resetAt: 1720000000000,
    sourceMessageId: 55,
  });
  expect(parseContinueCallback('agent:foo:1')).toBeNull();
  expect(parseContinueCallback('lc:%3:notanumber')).toBeNull();
});

test('extractFailure: a session-limit tail yields kind=session-limit + resetAt + detail', () => {
  const text = 'Claude is thinking…\nYou have hit your session limit · resets 4:10am (Europe/Belgrade)';
  const f = extractFailure('session_limit', text, NOW);
  expect(f.kind).toBe('session-limit');
  expect(f.resetAt).not.toBeNull();
  expect(new Date(f.resetAt!).getHours()).toBe(4);
  expect(f.detail).toContain('session limit');
});

test('extractFailure: a reset time upgrades a vague matcher to session-limit', () => {
  const f = extractFailure('', 'rate limited, resets 3pm', NOW);
  expect(f.kind).toBe('session-limit');
});

test('extractFailure: Codex hard usage-limit prose parses "try again at" as reset text', () => {
  const f = extractFailure(
    'unknown',
    "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    NOW,
    { agent: 'codex' },
  );
  expect(f.kind).toBe('session-limit');
  expect(new Date(f.resetAt!).getHours()).toBe(16);
  expect(new Date(f.resetAt!).getMinutes()).toBe(10);
  expect(f.detail).toContain("You've hit your usage limit");
});

test('extractFailure: non-Codex usage-limit prose with "try again at" does not become a session limit', () => {
  const f = extractFailure(
    'unknown',
    "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    NOW,
    { agent: 'ext' },
  );
  expect(f.kind).toBe('api-error');
  expect(f.resetAt).toBeNull();
});

test('extractFailure: non-retryable Codex StopFailure prose does not get a reset button from "try again at"', () => {
  const f = extractFailure(
    'billing_error',
    "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    NOW,
    { agent: 'codex' },
  );
  expect(f.kind).toBe('api-error');
  expect(f.resetAt).toBeNull();
});

test('extractFailure: overload prose with "try again at" remains an API error', () => {
  const f = extractFailure(
    'overloaded',
    'API Error: 529 Overloaded. Provider is temporarily overloaded, please try again at 4:10pm.',
    NOW,
  );
  expect(f.kind).toBe('api-error');
  expect(f.resetAt).toBeNull();
});

test('Codex hard usage-limit diagnostic explains missing proactive telemetry', () => {
  const failure = ev({
    kind: 'session-limit',
    agent: 'codex',
    reason: 'unknown',
    detail: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    resetAt: NOW + 4 * 60 * 60_000,
  });
  const diagnostic = buildCodexHardLimitDiagnostic(failure, { hasSupportedUsageTelemetry: false });
  expect(diagnostic).toContain('No supported Codex usage telemetry');
  expect(diagnostic).toContain('90% warning');
  expect(diagnostic).toContain('natural reset');
  expect(diagnostic).toContain('Banked/earned resets are not auto-consumed');
  expect(diagnostic).toContain('/usage');
  const n = buildLimitNotification(failure, NOW, { diagnostic })!;
  expect(n.text).toContain('No supported Codex usage telemetry');
  expect(n.text).toContain('/usage');
});

test('Codex hard usage-limit diagnostic explains below-threshold telemetry', () => {
  const failure = ev({
    kind: 'session-limit',
    agent: 'codex',
    reason: 'unknown',
    detail: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    resetAt: NOW + 4 * 60 * 60_000,
  });
  const diagnostic = buildCodexHardLimitDiagnostic(failure, {
    hasSupportedUsageTelemetry: true,
    latestSupportedUsagePercent: 80,
    latestSupportedUsageLimitName: 'primary',
  });
  expect(diagnostic).toContain('Supported Codex usage telemetry');
  expect(diagnostic).toContain('below the 90% warning threshold');
  expect(diagnostic).toContain('80%');
  expect(diagnostic).toContain('natural reset');
  expect(diagnostic).toContain('/usage');
});

test('Codex hard usage-limit diagnostic explains already-high telemetry without claiming a below-threshold sample', () => {
  const failure = ev({
    kind: 'session-limit',
    agent: 'codex',
    reason: 'unknown',
    detail: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    resetAt: NOW + 4 * 60 * 60_000,
  });
  const diagnostic = buildCodexHardLimitDiagnostic(failure, {
    hasSupportedUsageTelemetry: true,
    latestSupportedUsagePercent: 91,
    latestSupportedUsageLimitName: 'primary',
  });
  expect(diagnostic).toContain('at or above the 90% warning threshold');
  expect(diagnostic).toContain('shadowed');
  expect(diagnostic).toContain('deduped');
  expect(diagnostic).toContain('/usage');
  expect(diagnostic).not.toContain('below the 90% warning threshold');
});

test('Codex hard usage-limit diagnostic distinguishes stale telemetry from missing telemetry', () => {
  const failure = ev({
    kind: 'session-limit',
    agent: 'codex',
    reason: 'unknown',
    detail: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    resetAt: NOW + 4 * 60 * 60_000,
  });
  const diagnostic = buildCodexHardLimitDiagnostic(failure, {
    hasSupportedUsageTelemetry: false,
    hadExpiredSupportedUsageTelemetry: true,
  });
  expect(diagnostic).toContain('Supported Codex usage telemetry was seen');
  expect(diagnostic).toContain('latest stored sample was stale');
  expect(diagnostic).not.toContain('No supported Codex usage telemetry');
  expect(diagnostic).toContain('/usage');
});

test('Codex hard usage-limit diagnostic still explains banked reset redemption when telemetry exists', () => {
  const failure = ev({
    kind: 'session-limit',
    agent: 'codex',
    reason: 'unknown',
    detail: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
    resetAt: NOW + 4 * 60 * 60_000,
  });
  const diagnostic = buildCodexHardLimitDiagnostic(failure, { hasSupportedUsageTelemetry: true });
  expect(diagnostic).toContain('Banked/earned resets are not auto-consumed');
  expect(diagnostic).toContain('/usage');
});

test('extractFailure: an API error with no reset → api-error, null resetAt', () => {
  const f = extractFailure('overloaded', 'Error: overloaded_error (529)', NOW);
  expect(f.kind).toBe('api-error');
  expect(f.resetAt).toBeNull();
  expect(f.detail).toContain('overloaded');
});

// tg#17245-class bug: the detail line is cut at a fixed 240 UTF-16 code-unit
// count. A naive slice can land between the two halves of a surrogate pair
// (an emoji), orphaning a lone surrogate that Telegram's sendMessage rejects
// wholesale with a 400 "strings must be encoded in UTF-8". The cut must back
// up to keep the pair whole.
test('extractFailure: a detail line that would split an emoji surrogate pair at the 240-char cut is not orphaned', () => {
  // 238 filler chars + 😀 (\uD83D\uDE00) puts the high surrogate exactly at
  // index 238 — a naive `.slice(0, 239)` keeps it and drops its low-surrogate
  // partner.
  const long = `${'x'.repeat(238)}\ud83d\ude00${'y'.repeat(30)}`;
  const f = extractFailure('overloaded', long, NOW);
  expect(f.detail).toBe(`${'x'.repeat(238)}\u2026`);
  expect(hasUnpairedSurrogate(f.detail)).toBe(false);
});

test('formatClock / formatDelta', () => {
  expect(formatClock(new Date(2026, 0, 1, 4, 5).getTime())).toBe('04:05');
  expect(formatDelta(45 * 60_000)).toBe('45m');
  expect(formatDelta(125 * 60_000)).toBe('2h 5m');
  expect(formatDelta(30_000)).toBe('<1m');
});

test('usage parser: Codex token_count rate_limits extracts the highest percentage + reset', () => {
  const primaryReset = Math.floor((NOW + 60 * 60_000) / 1000);
  const secondaryReset = Math.floor((NOW + 7 * 24 * 60 * 60_000) / 1000);
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 91, window_minutes: 300, resets_at: primaryReset },
          secondary: { used_percent: 63, window_minutes: 10080, resets_at: secondaryReset },
        },
      },
    }),
    { agent: 'codex', language: 'ru', now: NOW },
  );
  expect(ev).toMatchObject({
    kind: 'usage-warning',
    agent: 'codex',
    percent: 91,
    limitName: '5-hour',
    language: 'ru',
  });
  expect(ev?.resetAt).toBe(primaryReset * 1000);
});

test('usage parser: stale high bucket does not hide a lower active bucket', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 99, window_minutes: 300, resets_at: Math.floor((NOW - 60_000) / 1000) },
          secondary: { used_percent: 95, window_minutes: 10080, resets_at: Math.floor((NOW + 60_000) / 1000) },
        },
      },
    }),
    { agent: 'codex', now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'codex', percent: 95, limitName: 'weekly' });
});

test('usage parser: percent fields are literal 0-100 values, not guessed ratios', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 1, window_minutes: 300 },
        secondary: { used_percent: 0.9, window_minutes: 10080 },
      },
    }),
  );
  expect(ev).toMatchObject({ agent: 'codex', percent: 1 });
  expect(buildUsageLimitNotification(ev!, NOW)).toBeNull();
});

test('usage parser: percent fields outside 0-100 are ignored', () => {
  expect(
    extractUsageLimitEvent(
      JSON.stringify({
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 9100, window_minutes: 300 },
        },
      }),
    ),
  ).toBeNull();
  expect(
    extractUsageLimitEvent(
      JSON.stringify({
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 120, window_minutes: 300 },
          secondary: { used_percent: 91, window_minutes: 10080 },
        },
      }),
    ),
  ).toMatchObject({ agent: 'codex', percent: 91, limitName: 'weekly' });
});

test('usage parser: Codex app-server account rateLimits shape prefers the Codex weekly bucket', () => {
  const primaryReset = Math.floor((NOW + 60 * 60_000) / 1000);
  const secondaryReset = Math.floor((NOW + 7 * 24 * 60 * 60_000) / 1000);
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      method: 'account/rateLimits/updated',
      params: {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: primaryReset },
            secondary: { usedPercent: 94, windowDurationMins: 10080, resetsAt: secondaryReset },
          },
        },
      },
    }),
    { now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'codex', percent: 94, limitName: 'weekly' });
  expect(ev?.resetAt).toBe(secondaryReset * 1000);
});

test('usage parser: Codex app-server accepts the documented account/rateLimits/* method family', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      method: 'account/rateLimits/snapshot',
      params: {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: Math.floor((NOW + 60_000) / 1000) },
          },
        },
      },
    }),
    { now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'codex', percent: 92, limitName: '5-hour' });
});

test('usage parser: Codex rollout relative reset seconds resolve against now', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      msg: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 90, window_minutes: 300, resets_in_seconds: 120 },
        },
      },
    }),
    { now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'codex', percent: 90, limitName: '5-hour' });
  expect(ev?.resetAt).toBe(NOW + 120_000);
});

test('usage parser: Claude statusLine rate_limits shape is recognized', () => {
  const primaryReset = Math.floor((NOW + 60 * 60_000) / 1000);
  const secondaryReset = Math.floor((NOW + 7 * 24 * 60 * 60_000) / 1000);
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      version: '2.1.199',
      model: { display_name: 'Opus' },
      rate_limits: {
        five_hour: { used_percentage: 91.5, resets_at: primaryReset },
        seven_day: { used_percentage: 64, resets_at: secondaryReset },
      },
    }),
    { language: 'ru', now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'claude', percent: 91.5, limitName: '5-hour', language: 'ru' });
  expect(ev?.resetAt).toBe(primaryReset * 1000);
});

test('usage parser: Claude statusLine snapshot returns both 5-hour and weekly buckets', () => {
  const primaryReset = Math.floor((NOW + 2 * 60 * 60_000) / 1000);
  const secondaryReset = Math.floor((NOW + 5 * 24 * 60 * 60_000) / 1000);
  const events = extractUsageLimitEvents(
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 98, resets_at: primaryReset },
        seven_day: { used_percentage: 64, resets_at: secondaryReset },
      },
    }),
    { agent: 'claude', now: NOW },
  );
  expect(events.map((ev) => [ev.limitName, ev.percent, ev.resetAt])).toEqual([
    ['5-hour', 98, primaryReset * 1000],
    ['weekly', 64, secondaryReset * 1000],
  ]);
});

test('usage parser: Claude context_window is accepted only when the caller identifies Claude', () => {
  const payload = JSON.stringify({
    context_window: { used_percentage: 92, context_window_size: 200000 },
  });
  expect(extractUsageLimitEvent(payload)).toBeNull();
  expect(extractUsageLimitEvent(payload, { agent: 'claude' })).toMatchObject({
    agent: 'claude',
    percent: 92,
    limitName: 'context window',
  });
});

test('usage parser: Claude context_window competes with low rate_limits when agent is Claude', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: Math.floor((NOW + 60_000) / 1000) },
        seven_day: { used_percentage: 30, resets_at: Math.floor((NOW + 60_000) / 1000) },
      },
      context_window: { used_percentage: 95, context_window_size: 200000 },
    }),
    { agent: 'claude', now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'claude', percent: 95, limitName: 'context window' });
});

test('usage parser: Claude rate_limits are not attributed when caller identifies another agent', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 91, resets_at: Math.floor((NOW + 60_000) / 1000) },
      },
    }),
    { agent: 'codex', now: NOW },
  );
  expect(ev).toBeNull();
});

test('usage parser: Pi get_session_stats RPC context usage is recognized for the pi harness', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        sessionId: 'abc123',
        tokens: { input: 50000, output: 10000, total: 105000 },
        contextUsage: { tokens: 184000, contextWindow: 200000, percent: 92 },
      },
    }),
    { agent: 'pi' },
  );
  expect(ev).toMatchObject({ agent: 'pi', percent: 92, limitName: 'context window' });
});

test('usage parser: OpenCode requires the explicit tg-cli usage envelope', () => {
  const reset = new Date(NOW + 60 * 60_000).toISOString();
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      schema: 'tg-cli.usageLimit.v1',
      agent: 'opencode',
      usedPercent: 90,
      limitName: 'Go 5-hour',
      resetsAt: reset,
      locale: 'en-US',
    }),
    { now: NOW },
  );
  expect(ev).toMatchObject({ agent: 'opencode', percent: 90, limitName: 'Go 5-hour', language: 'en' });
  expect(ev?.resetAt).toBe(Date.parse(reset));
});

test('usage parser: generic percent/prose/token-only payloads are ignored', () => {
  const payloads = [
    JSON.stringify({ agent: 'claude', usage: { percent: 91, limit_name: 'daily' } }),
    JSON.stringify({ agent: 'opencode', usage: { percent: 91, limit_name: 'daily' } }),
    JSON.stringify({ name: 'claude_code.token.usage', value: 1234, attributes: { type: 'input' } }),
    JSON.stringify({ type: 'message.updated', properties: { info: { providerID: 'opencode', tokens: { input: 120000, output: 10 } } } }),
    'codex limit 91% resets 4pm',
  ];
  for (const payload of payloads) {
    expect(extractUsageLimitEvent(payload, { agent: 'opencode' })).toBeNull();
  }
});

test('usage notification: below 90% suppresses; 90% and above reports', () => {
  expect(buildUsageLimitNotification(usageEv({ percent: 89.9 }), NOW)).toBeNull();
  expect(buildUsageLimitNotification(usageEv({ percent: 90 }), NOW)).not.toBeNull();
});

test('usage notification: stale reset suppresses like the StopFailure path', () => {
  expect(buildUsageLimitNotification(usageEv({ percent: 95, resetAt: NOW - 1 }), NOW)).toBeNull();
});

test('usage notification: Russian and English copy for codex (the harness with real banked/earned resets)', () => {
  const ru = buildUsageLimitNotification(usageEv({ agent: 'codex', language: 'ru', percent: 92 }), NOW)!;
  expect(ru.text).toContain('использовано');
  expect(ru.text).toContain('92%');
  expect(ru.text).toContain('основного лимита');
  expect(ru.text).toContain('Сброс');
  expect(ru.text).toContain('/usage');
  expect(ru.text).toContain('не тратит');

  const en = buildUsageLimitNotification(usageEv({ agent: 'codex', language: 'en', percent: 93 }), NOW)!;
  expect(en.text).toContain('is at');
  expect(en.text).toContain('93%');
  expect(en.text).toContain('Resets');
  expect(en.text).toContain('natural reset');
  expect(en.text).toContain('banked/earned reset');
  expect(en.text).toContain('/usage');
  expect(en.text).toContain('does not auto-spend');
});

// The "banked/earned reset — redeem via /usage" advice is a CODEX-SPECIFIC mechanic
// (Codex genuinely has redeemable resets). Claude (and any other non-codex harness)
// has no such thing, so showing that sentence there is misleading — the advice must
// drop it entirely for a non-codex agent, keeping only the plan-around-it line.
test('usage notification: non-codex agents (e.g. claude) get plain advice with no banked-reset claim', () => {
  const ruClaude = buildUsageLimitNotification(usageEv({ agent: 'claude', language: 'ru', percent: 92 }), NOW)!;
  expect(ruClaude.text).toContain('использовано');
  expect(ruClaude.text).toContain('Запланируй паузу');
  expect(ruClaude.text).not.toContain('накопленный сброс');
  expect(ruClaude.text).not.toContain('/usage');

  const enClaude = buildUsageLimitNotification(usageEv({ agent: 'claude', language: 'en', percent: 93 }), NOW)!;
  expect(enClaude.text).toContain('is at');
  expect(enClaude.text).toContain('Plan around it or switch agents before the hard stop.');
  expect(enClaude.text).not.toContain('banked/earned reset');
  expect(enClaude.text).not.toContain('/usage');
});

test('usage notification: short Russian reset delta is HTML-escaped', () => {
  const ru = buildUsageLimitNotification(usageEv({ language: 'ru', resetAt: NOW + 30_000 }), NOW)!;
  expect(ru.text).toContain('&lt;1 мин');
  expect(ru.text).not.toContain('(<1 мин)');
});

test('usage parser: language falls back to process locale hints when payload lacks one', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 90, window_minutes: 300 },
      },
    }),
    { env: { LANG: 'ru_RU.UTF-8' } },
  );
  expect(ev?.language).toBe('ru');
});

test('usage parser: language detection ignores nested unrelated language fields', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      model: { language_code: 'ru' },
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 90, window_minutes: 300 },
      },
    }),
  );
  expect(ev?.language).toBe('en');
});

test('usage parser: language detection ignores top-level language_code and keeps env fallback', () => {
  const ev = extractUsageLimitEvent(
    JSON.stringify({
      language_code: 'ru',
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 90, window_minutes: 300 },
      },
    }),
    { env: { LANG: 'en_US.UTF-8' } },
  );
  expect(ev?.language).toBe('en');
});
