// Harness failure notifications + auto-continue scheduling (tg-cli#113).
//
// Runtime path: Claude Code 2.1.x fires a `StopFailure` hook when a turn ends on
// an API failure (matchers: rate_limit, overloaded, billing_error, …) OR the
// usage/session limit is hit; the exact failure text — including the reset time
// ("… resets 4:10am (Europe/Belgrade)") — is a synthetic assistant message at
// the tail of the transcript. `tg-ctl harness-event` reads that payload on stdin
// (the entrypoint owns the stdin + transcript file I/O), normalizes it into a
// HarnessFailureEvent, and this PURE module decides the Telegram notification and
// the auto-continue schedule. No I/O here — the daemon sends/persists/schedules.
//
// Two bugs this module fixes by construction (a previous WIP leaked a real,
// stale "session limit" alert to the operator's chat with an unrendered "%0"
// placeholder):
//   - Staleness guard: buildLimitNotification returns null when the reset time
//     is already in the PAST — a limit whose window already elapsed is not worth
//     alerting (the agent could just continue), and re-emitting it is the leak.
//   - Templating: every string is built with template literals + escapeHtml,
//     never a printf-style "%s"/"%0" placeholder that can render literally.

import { escapeHtml } from '../render/html';
import { truncateWithEllipsis } from './text-util';

// setTimeout clamps a delay > 2^31-1 ms to ~1ms (fires immediately) — the same
// trap the daemon already documents for its other timers. Clamp so a reset far
// in the future schedules at the max instead of firing at once.
export const MAX_TIMER_MS = 2 ** 31 - 1;

// Telegram callback_data is capped at 64 bytes. `lc:<paneId>:<resetAtMs>` fits
// easily (a tmux paneId is `%<n>`, the epoch is ~13 digits).
export const LIMIT_CONTINUE_PREFIX = 'lc';

export type HarnessFailureKind = 'session-limit' | 'api-error';

// A normalized harness failure. The entrypoint builds this from the StopFailure
// payload + transcript prose; every field the notification needs is explicit so
// this module stays pure and testable. The entrypoint resolves `agent` from the
// live pane and `paneId` from TMUX_PANE. `sourceMessageId` is supplied via the
// --source-message-id flag when known (a caller that tracks the last inbound
// message per pane); auto-resolving it from the daemon is a follow-up, so the
// reaction lifecycle degrades gracefully to "no source flip" when it is null.
export interface HarnessFailureEvent {
  kind: HarnessFailureKind;
  agent: string; // tmux window / session name the failed pane belongs to
  paneId: string | null; // originating pane — required to arm auto-continue
  sessionId?: string | null; // harness session id, when the StopFailure payload carries one
  reason: string; // the StopFailure matcher (rate_limit, overloaded, session_limit, …)
  detail: string; // human-readable tail (trimmed synthetic message)
  resetAt: number | null; // ms epoch when the limit resets; null = unknown/not a limit
  sourceMessageId: number | null; // inbound message to flip 👀→😴→👀 (null = skip)
}

export interface LimitNotification {
  text: string; // HTML body (basic tags only — valid inside a plain sendMessage)
  button: { label: string; data: string } | null; // present iff auto-continue is armable
  resetAt: number | null;
}

export interface LimitNotificationOptions {
  diagnostic?: string | null;
}

export type UsageReportLanguage = 'en' | 'ru';

const USAGE_AGENTS = ['claude', 'codex', 'pi', 'opencode'] as const;
export type UsageAgent = (typeof USAGE_AGENTS)[number];

export interface UsageLimitEvent {
  kind: 'usage-warning';
  agent: UsageAgent;
  percent: number;
  limitName: string | null;
  resetAt: number | null;
  language: UsageReportLanguage;
  detail: string;
}

export interface UsageLimitOptions {
  agent?: string | null;
  language?: string | null;
  env?: Record<string, string | undefined>;
  now?: number;
}

interface UsageSample {
  agent: 'claude' | 'codex' | 'pi' | 'opencode';
  percent: number;
  limitName: string | null;
  resetAt: number | null;
}

const USAGE_REPORT_THRESHOLD_PERCENT = 90;
const OVERLOAD_AUTO_CONTINUE_MIN_DELAY_MS = 30_000;
const OVERLOAD_AUTO_CONTINUE_MAX_DELAY_MS = 15 * 60_000;
interface CodexRateLimitRoot {
  value: Record<string, unknown>;
  trustedDirect: boolean;
}
const LANGUAGE_KEYS = ['language', 'locale', 'user_language', 'userLanguage'];
const NON_RETRYABLE_API_FAILURE_RE = /\b(authentication_failed|oauth_org_not_allowed|billing_error|invalid_request|model_not_found|max_output_tokens|permission|auth(?:entication)?|billing|invalid api key)\b/i;
const TRANSIENT_OVERLOAD_RE = /\b(529|overload(?:ed)?|temporarily overloaded|temporarily unavailable|service unavailable)\b/i;
const CODEX_HARD_USAGE_LIMIT_RE = /\b(you['’]ve hit your usage limit|hit your usage limit|usage limit)\b/i;
const CODEX_RESET_REDEMPTION_NOTE =
  'The reset time shown is the natural reset. Banked/earned resets are not auto-consumed by tg-cli; redeem one explicitly with /usage if available.';

// Map a StopFailure matcher to a notification kind. A matcher naming a limit
// (session/usage/rate) is a schedulable stop; anything else (overloaded,
// billing_error, api_error, …) is a plain error alert. The presence of a reset
// time — not this label — is what actually decides whether a button is offered.
export function classifyFailure(reason: string): HarnessFailureKind {
  return /limit/i.test(reason) ? 'session-limit' : 'api-error';
}

/**
 * Normalize proactive usage/rate-limit telemetry into one high-usage candidate.
 * Deliberately not generic: accepted shapes are Claude Code statusLine limits,
 * Codex rate-limit telemetry, Pi `get_session_stats`, or tg-cli's explicit
 * `tg-cli.usageLimit.v1` envelope. Generic token/cost payloads are ignored
 * because they do not carry a quota percentage/reset contract. `opts.agent` is
 * only a hint: it must normalize to a supported usage agent before agent-specific
 * payloads such as Claude context or Pi stats are accepted. Extracted details are
 * truncated before rendering.
 */
export function extractUsageLimitEvent(payloadText: string, opts: UsageLimitOptions = {}): UsageLimitEvent | null {
  const events = extractUsageLimitEvents(payloadText, opts);
  if (events.length === 0) return null;
  events.sort((a, b) => b.percent - a.percent);
  return events[0];
}

export function extractUsageLimitEvents(payloadText: string, opts: UsageLimitOptions = {}): UsageLimitEvent[] {
  const parsed = parseJsonOrNull(payloadText);
  if (parsed === null) return [];
  const now = opts.now ?? Date.now();
  const samples = collectContractUsageSamples(parsed, { ...opts, now }).filter((sample) => sample.resetAt === null || sample.resetAt > now);
  if (samples.length === 0) return [];
  const language =
    normalizeReportLanguage(opts.language) ??
    findLanguage(parsed) ??
    languageFromEnv(opts.env) ??
    'en';
  const detail = truncateDetail(detailFromUsagePayload(parsed));
  return samples.map((sample) => ({
    kind: 'usage-warning',
    agent: sample.agent,
    percent: sample.percent,
    limitName: sample.limitName,
    resetAt: sample.resetAt,
    language,
    detail,
  }));
}

function parseJsonOrNull(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectContractUsageSamples(value: unknown, opts: UsageLimitOptions): UsageSample[] {
  return [
    ...usageSamplesFromNormalizedEnvelope(value),
    ...usageSamplesFromClaudeStatusLine(value, opts),
    ...usageSamplesFromCodex(value, opts.now ?? Date.now()),
    ...usageSamplesFromPiStats(value, opts),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function recordField(rec: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return asRecord(rec?.[key]);
}

function stringField(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function usageSamplesFromNormalizedEnvelope(value: unknown): UsageSample[] {
  const rec = asRecord(value);
  if (!rec || rec.schema !== 'tg-cli.usageLimit.v1') return [];
  const agent = normalizeUsageAgent(rec.agent);
  const percent = percentFromUnknown(rec.usedPercent);
  if (!agent || percent === null) return [];
  return [{ agent, percent, limitName: stringField(rec, 'limitName'), resetAt: timeFromUnknown(rec.resetsAt) }];
}

function usageSamplesFromClaudeStatusLine(value: unknown, opts: UsageLimitOptions): UsageSample[] {
  const rec = asRecord(value);
  if (!rec) return [];
  const agent = normalizeUsageAgent(opts.agent);
  if (agent && agent !== 'claude') return [];
  const samples: UsageSample[] = [];
  const rateLimits = recordField(rec, 'rate_limits');
  for (const [key, label] of [
    ['five_hour', '5-hour'],
    ['seven_day', 'weekly'],
  ] as const) {
    const win = recordField(rateLimits, key);
    const percent = percentFromUnknown(win?.used_percentage);
    if (percent !== null) {
      samples.push({ agent: 'claude', percent, limitName: label, resetAt: timeFromUnknown(win?.resets_at) });
    }
  }

  if (agent === 'claude') {
    const contextWindow = recordField(rec, 'context_window');
    const percent = percentFromUnknown(contextWindow?.used_percentage);
    if (percent !== null) {
      samples.push({ agent: 'claude', percent, limitName: 'context window', resetAt: null });
    }
  }
  return samples;
}

function usageSamplesFromCodex(value: unknown, now: number): UsageSample[] {
  const roots = codexRateLimitRoots(value);
  const samples: UsageSample[] = [];
  for (const root of roots) {
    const normalizedRoot = normalizeCodexRateLimitRoot(root);
    if (!normalizedRoot) continue;
    for (const [key, rec] of normalizedRoot) {
      const percent = percentFromUnknown(rec.usedPercent ?? rec.used_percent);
      if (percent === null) continue;
      const windowMins = numberFromUnknown(rec.windowDurationMins ?? rec.window_minutes);
      samples.push({
        agent: 'codex',
        percent,
        limitName: codexLimitLabel(key, windowMins),
        resetAt: codexResetAt(rec, now),
      });
    }
  }
  return samples;
}

function codexRateLimitRoots(value: unknown): CodexRateLimitRoot[] {
  const rec = asRecord(value);
  if (!rec) return [];
  const roots: CodexRateLimitRoot[] = [];
  const payload = recordField(rec, 'payload');
  const msg = recordField(rec, 'msg');
  const params = recordField(rec, 'params');
  const result = recordField(rec, 'result');

  if (payload?.type === 'token_count') pushCodexRoot(roots, payload.rate_limits, true);
  if (msg?.type === 'token_count') pushCodexRoot(roots, msg.rate_limits, true);
  if (rec.type === 'token_count') pushCodexRoot(roots, rec.rate_limits, true);
  if (typeof rec.method === 'string' && rec.method.startsWith('account/rateLimits/')) pushCodexRoot(roots, params, false);
  pushCodexRoot(roots, result, false);
  pushCodexRoot(roots, rec, false);
  return roots;
}

function normalizeCodexRateLimitRoot(root: CodexRateLimitRoot): [string, Record<string, unknown>][] | null {
  const { value, trustedDirect } = root;
  const byId = recordField(value, 'rateLimitsByLimitId');
  const codexById = recordField(byId, 'codex');
  const directCamel = recordField(value, 'rateLimits');
  const directSnake = trustedDirect || value.limit_id === 'codex' || value.limitId === 'codex' ? value : null;
  const candidate =
    codexById ??
    (directCamel && (directCamel.limitId === 'codex' || directCamel.limit_id === 'codex') ? directCamel : null) ??
    directSnake;
  if (!candidate) return null;
  const out: [string, Record<string, unknown>][] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const rec = recordField(candidate, key);
    if (rec) out.push([key, rec]);
  }
  return out;
}

function pushCodexRoot(out: CodexRateLimitRoot[], value: unknown, trustedDirect: boolean): void {
  const rec = asRecord(value);
  if (rec) out.push({ value: rec, trustedDirect });
}

function codexLimitLabel(key: string, windowMins: number | null): string {
  if (windowMins === 300) return '5-hour';
  if (windowMins === 10080) return 'weekly';
  return key;
}

function codexResetAt(rec: Record<string, unknown>, now: number): number | null {
  const absolute = timeFromUnknown(rec.resetsAt ?? rec.resets_at);
  if (absolute !== null) return absolute;
  const rel = numberFromUnknown(rec.resetsInSeconds ?? rec.resets_in_seconds);
  return rel !== null && rel >= 0 ? now + rel * 1000 : null;
}

function usageSamplesFromPiStats(value: unknown, opts: UsageLimitOptions): UsageSample[] {
  const rec = asRecord(value);
  if (!rec) return [];
  const agent = normalizeUsageAgent(opts.agent) ?? normalizeUsageAgent(rec.agent) ?? normalizeUsageAgent(rec.harness);
  if (agent !== 'pi') return [];
  if (rec.type !== 'response' || rec.command !== 'get_session_stats' || rec.success !== true) return [];
  const data = recordField(rec, 'data');
  const contextUsage = recordField(data, 'contextUsage');
  const percent = percentFromUnknown(contextUsage?.percent);
  if (percent === null) return [];
  return [{ agent: 'pi', percent, limitName: 'context window', resetAt: null }];
}

function normalizeUsageAgent(raw: unknown): UsageAgent | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return (USAGE_AGENTS as readonly string[]).includes(s) ? (s as UsageAgent) : null;
}

function numberFromUnknown(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/%$/, '');
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function percentFromUnknown(v: unknown): number | null {
  const n = numberFromUnknown(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}

function timeFromUnknown(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1_000_000_000_000 ? v * 1000 : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = numberFromUnknown(v);
  if (n !== null && n > 0) return n < 1_000_000_000_000 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function findLanguage(value: unknown): UsageReportLanguage | null {
  return normalizeReportLanguage(findStringByKeys(value, LANGUAGE_KEYS));
}

function languageFromEnv(env: Record<string, string | undefined> | undefined): UsageReportLanguage | null {
  if (!env) return null;
  return normalizeReportLanguage(env.LC_ALL) ?? normalizeReportLanguage(env.LC_MESSAGES) ?? normalizeReportLanguage(env.LANG);
}

function normalizeReportLanguage(raw: unknown): UsageReportLanguage | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('ru') || s.includes('russian') || s.includes('рус')) return 'ru';
  if (s.startsWith('en') || s.includes('english')) return 'en';
  return null;
}

export interface TransientAutoContinuePlan {
  attempt: number;
  delayMs: number;
  text: string;
}

export interface TransientAutoContinueOptions {
  attempt: number;
  language?: string | null;
}

export interface CodexHardLimitDiagnosticOptions {
  hasSupportedUsageTelemetry: boolean;
  latestSupportedUsagePercent?: number | null;
  latestSupportedUsageLimitName?: string | null;
  hadExpiredSupportedUsageTelemetry?: boolean;
}

export interface ExtractFailureOptions {
  agent?: string | null;
}

// Logarithmic delay for transient overload StopFailure recovery. This is
// separate from timer scheduling for known reset times (`autoContinueDelayMs`):
// overloads have no reset timestamp, so repeated failures back off by attempt.
export function overloadAutoContinueDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const delay = Math.ceil(OVERLOAD_AUTO_CONTINUE_MIN_DELAY_MS * Math.log2(n + 1));
  return Math.min(OVERLOAD_AUTO_CONTINUE_MAX_DELAY_MS, delay);
}

export function buildTransientAutoContinue(
  ev: HarnessFailureEvent,
  opts: TransientAutoContinueOptions,
): TransientAutoContinuePlan | null {
  if (ev.kind !== 'api-error' || ev.resetAt !== null) return null;
  const haystack = `${ev.reason}\n${ev.detail}`;
  if (NON_RETRYABLE_API_FAILURE_RE.test(haystack)) return null;
  if (!TRANSIENT_OVERLOAD_RE.test(haystack)) return null;
  const language = normalizeReportLanguage(opts.language) ?? 'en';
  const attempt = Number.isFinite(opts.attempt) ? Math.max(1, Math.floor(opts.attempt)) : 1;
  return {
    attempt,
    delayMs: overloadAutoContinueDelayMs(attempt),
    text: language === 'ru' ? 'продолжи' : 'continue',
  };
}

export function buildCodexHardLimitDiagnostic(
  ev: HarnessFailureEvent,
  opts: CodexHardLimitDiagnosticOptions,
): string | null {
  if (ev.agent.trim().toLowerCase() !== 'codex') return null;
  if (!CODEX_HARD_USAGE_LIMIT_RE.test(`${ev.reason}\n${ev.detail}`)) return null;
  if (opts.hasSupportedUsageTelemetry) {
    const percent = opts.latestSupportedUsagePercent;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      const label = opts.latestSupportedUsageLimitName ? ` ${opts.latestSupportedUsageLimitName}` : '';
      if (percent < USAGE_REPORT_THRESHOLD_PERCENT) {
        return `Supported Codex usage telemetry was seen before this hard stop, but the latest${label} sample was ${formatUsageDiagnosticPercent(percent)}%, below the 90% warning threshold. ${CODEX_RESET_REDEMPTION_NOTE}`;
      }
      return `Supported Codex usage telemetry was seen before this hard stop, and the latest${label} sample was ${formatUsageDiagnosticPercent(percent)}%, at or above the 90% warning threshold. If no proactive warning was visible, the warning may have been shadowed, deduped for the active reset window, or failed to deliver. ${CODEX_RESET_REDEMPTION_NOTE}`;
    }
    return `Supported Codex usage telemetry was seen before this hard stop, but tg-cli could not identify a current warning percent. If no proactive warning was visible, the warning may have been shadowed, deduped for the active reset window, or failed to deliver. ${CODEX_RESET_REDEMPTION_NOTE}`;
  }
  if (opts.hadExpiredSupportedUsageTelemetry) {
    return `Supported Codex usage telemetry was seen before this hard stop, but the latest stored sample was stale or its reset window had already elapsed, so tg-cli could not send a current 90% warning. ${CODEX_RESET_REDEMPTION_NOTE}`;
  }
  return `No supported Codex usage telemetry was seen before this hard stop, so tg-cli could not send a 90% warning. Check that a Codex token_count/account/rateLimits collector is installed, not shadowed by a local hook/statusline override, or previously deduped. ${CODEX_RESET_REDEMPTION_NOTE}`;
}

function formatUsageDiagnosticPercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, '');
}

function findStringByKeys(value: unknown, keys: string[]): string | null {
  const rec = asRecord(value);
  if (!rec) return null;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function detailFromUsagePayload(value: unknown): string {
  const rec = asRecord(value);
  return stringField(rec, 'detail') ?? '';
}

// Parse a reset time out of failure text → next future ms epoch, or null.
// Handles an explicit ISO/absolute timestamp and the wall-clock forms Claude
// emits ("resets 4:10am", "reset at 3pm", "resets 16:10"). A bare wall clock is
// resolved to its NEXT occurrence in the daemon's local timezone (which is the
// operator's — the reset text's "(Europe/Belgrade)" is that same zone).
export function parseResetTime(text: string, now: number): number | null {
  return parseAnchoredTime(text, now, /reset/gi, /reset[s]?\s+(at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
}

function parseTryAgainTime(text: string, now: number): number | null {
  return parseAnchoredTime(text, now, /try\s+again/gi, /try\s+again\s+(at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
}

function parseAnchoredTime(text: string, now: number, anchorRe: RegExp, clockRe: RegExp): number | null {
  // Scan EVERY "reset" mention (not just the first) and return the first that
  // yields a real time. Anchoring to a mention keeps an unrelated transcript ISO
  // stamp out; scanning all of them means a bare count ("resets 3 times") ahead
  // of the real "resets 4:10am" doesn't shadow it.
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(text)) !== null) {
    const parsed = parseResetWindow(text.slice(m.index, m.index + 120), now, clockRe);
    if (parsed !== null) return parsed;
  }
  return null;
}

// Parse a single "reset …" window → ms epoch, or null. An explicit ISO wins; else
// a wall clock, guarded against a bare count (a lone integer with no am/pm, no
// ":MM", and no "at/by" is NOT a time).
function parseResetWindow(window: string, now: number, clockRe: RegExp): number | null {
  const isoMatch = window.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (isoMatch) {
    const t = Date.parse(isoMatch[0].replace(' ', 'T'));
    if (Number.isFinite(t)) return t;
  }
  const clockMatch = window.match(clockRe);
  if (!clockMatch) return null;
  const [, atBy, hStr, mStr, ampm] = clockMatch;
  if (!atBy && !mStr && !ampm) return null; // a bare "resets 3" is not a time
  const clock = parseClock(hStr, mStr, ampm);
  return clock ? nextWallClock(now, clock.hour, clock.minute) : null;
}

// Extract the last ASSISTANT message text from a Claude Code JSONL transcript.
// StopFailure hands a transcript_path, not clean text; scanning the raw JSONL
// would pick up per-line ISO timestamps and dump raw JSON into the alert. This
// pulls the synthetic session-limit / error message (the last assistant turn) so
// the reset time + detail come from real prose. Empty when nothing parses.
export function extractAssistantText(transcript: string): string {
  let last = '';
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const text = assistantTextOf(obj);
    if (text) last = text;
  }
  return last;
}

function assistantTextOf(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  const msg = (rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : rec) as Record<string, unknown>;
  const role = rec.role ?? msg.role ?? rec.type;
  if (role !== 'assistant') return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text' && typeof (c as Record<string, unknown>).text === 'string')
      .map((c) => (c as Record<string, unknown>).text as string)
      .join('\n');
  }
  return '';
}

// A 12h ("4:10am"/"3pm") or 24h ("16:10") clock → {hour, minute}, or null on an
// out-of-range value (13pm, 24:00, minute 60). am/pm normalizes 12h→24h.
function parseClock(hStr: string, mStr: string | undefined, ampm: string | undefined): { hour: number; minute: number } | null {
  let hour = Number(hStr);
  const minute = mStr ? Number(mStr) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  const suffix = ampm?.toLowerCase().replace(/\./g, '');
  if (suffix === 'am' || suffix === 'pm') {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return { hour, minute };
}

// The next future instant matching a local wall clock. Today's occurrence if it
// is still ahead of `now`, else the same time tomorrow.
function nextWallClock(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60 * 1000;
  return t;
}

// Extract the text-derived parts of a failure from the StopFailure `reason`
// matcher plus the failure text (the synthetic transcript tail / hook message).
// PURE: the entrypoint concatenates the reason + transcript tail and supplies the
// pane/agent/source-message from tmux + the routes file. `detail` is the last
// non-empty line of the failure text, trimmed to a phone-readable length.
// Codex hard usage-limit prose is the only supported `try again at ...` reset
// source; generic API errors with the same words stay unscheduled.
export function extractFailure(
  reason: string,
  failureText: string,
  now: number,
  opts: ExtractFailureOptions = {},
): { kind: HarnessFailureKind; reason: string; detail: string; resetAt: number | null } {
  const agent = opts.agent?.trim().toLowerCase() ?? '';
  const allowCodexTryAgainReset =
    agent === 'codex' &&
    CODEX_HARD_USAGE_LIMIT_RE.test(failureText) &&
    !NON_RETRYABLE_API_FAILURE_RE.test(`${reason}\n${failureText}`);
  const resetAt = parseResetTime(failureText, now) ?? (allowCodexTryAgainReset ? parseTryAgainTime(failureText, now) : null);
  // A parseable reset time means it IS a limit even if the matcher was vague.
  const kind = resetAt !== null ? 'session-limit' : classifyFailure(reason);
  const lines = failureText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const detail = truncateDetail(lines.length ? lines[lines.length - 1] : '');
  return { kind, reason: reason.trim(), detail, resetAt };
}

function truncateDetail(s: string): string {
  return truncateWithEllipsis(s, 240);
}

// Build the operator notification, or null to SUPPRESS it. Suppressed when the
// reset time is already in the past (stale — the leak this module prevents).
export function buildLimitNotification(ev: HarnessFailureEvent, now: number, opts: LimitNotificationOptions = {}): LimitNotification | null {
  if (ev.resetAt !== null && ev.resetAt <= now) return null; // staleness guard
  const agent = escapeHtml(ev.agent || 'agent');
  const head =
    ev.kind === 'session-limit'
      ? `⚠️ <b>${agent}</b> hit its session limit.`
      : `⚠️ <b>${agent}</b> stopped on an API error (${escapeHtml(ev.reason || 'unknown')}).`;
  const when = resetLine(ev, now);
  const detail = ev.detail ? `\n<blockquote>${escapeHtml(ev.detail)}</blockquote>` : '';
  const diagnostic = opts.diagnostic ? `\n<blockquote>${escapeHtml(opts.diagnostic)}</blockquote>` : '';
  const button =
    ev.resetAt !== null && ev.paneId
      ? { label: `▶️ Auto-continue at ${formatClock(ev.resetAt)}`, data: continueCallbackData(ev.paneId, ev.resetAt, ev.sourceMessageId) }
      : null;
  return { text: `${head}${when}${detail}${diagnostic}`, button, resetAt: ev.resetAt };
}

export function buildUsageLimitNotification(ev: UsageLimitEvent, now: number): LimitNotification | null {
  if (ev.percent < USAGE_REPORT_THRESHOLD_PERCENT) return null;
  if (ev.resetAt !== null && ev.resetAt <= now) return null;
  const agent = escapeHtml(ev.agent || 'agent');
  const pct = formatPercent(ev.percent);
  const limit = usageLimitPhrase(ev.limitName, ev.language);
  const detail = ev.detail ? `\n<blockquote>${escapeHtml(ev.detail)}</blockquote>` : '';
  const when =
    ev.resetAt !== null
      ? ev.language === 'ru'
        ? `\nСброс: <b>${formatClock(ev.resetAt)}</b> (через ${escapeHtml(formatDeltaLocalized(ev.resetAt - now, ev.language))}).`
        : `\nResets at <b>${formatClock(ev.resetAt)}</b> (in ${escapeHtml(formatDeltaLocalized(ev.resetAt - now, ev.language))}).`
      : '';
  const head =
    ev.language === 'ru'
      ? `⚠️ <b>${agent}</b>: использовано <b>${pct}%</b> ${limit}.`
      : `⚠️ <b>${agent}</b> is at <b>${pct}%</b> of ${limit}.`;
  // The "banked/earned reset — redeem via /usage" claim is a CODEX-SPECIFIC
  // mechanic (Codex genuinely has redeemable resets that tg-cli won't auto-spend).
  // No other harness (claude included) has this, so showing it there is a false
  // claim, not just noise — gate it on the actual agent instead of assuming codex.
  const advice =
    ev.agent === 'codex'
      ? ev.language === 'ru'
        ? '\nЗапланируй паузу или переключи агента до жёсткой остановки. Показанный сброс — естественный; если доступен накопленный сброс, активируй его вручную через /usage. tg-cli не тратит такие сбросы автоматически.'
        : '\nPlan around it or switch agents before the hard stop. The reset shown is the natural reset; if a banked/earned reset is available, redeem it explicitly with /usage. tg-cli does not auto-spend it.'
      : ev.language === 'ru'
        ? '\nЗапланируй паузу или переключи агента до жёсткой остановки.'
        : '\nPlan around it or switch agents before the hard stop.';
  return { text: `${head}${when}${advice}${detail}`, button: null, resetAt: ev.resetAt };
}

function resetLine(ev: HarnessFailureEvent, now: number): string {
  if (ev.resetAt !== null) return `\nResets at <b>${formatClock(ev.resetAt)}</b> (in ${escapeHtml(formatDelta(ev.resetAt - now))}).`;
  return ev.kind === 'session-limit' ? `\nReset time unknown — continue manually.` : '';
}

// Delay until an armed auto-continue should fire: never negative (a past reset
// fires immediately), never above the setTimeout ceiling.
export function autoContinueDelayMs(resetAt: number, now: number): number {
  return Math.max(0, Math.min(resetAt - now, MAX_TIMER_MS));
}

// Encode the auto-continue tap: pane + reset + (optionally) the inbound message
// to flip 👀 back onto when it fires. A tmux paneId is `%N` (no colon), the epoch
// is ~13 digits, an id is small — well inside Telegram's 64-byte callback_data cap.
export function continueCallbackData(paneId: string, resetAt: number, sourceMessageId?: number | null): string {
  const base = `${LIMIT_CONTINUE_PREFIX}:${paneId}:${resetAt}`;
  return sourceMessageId != null ? `${base}:${sourceMessageId}` : base;
}

// Inverse of continueCallbackData. Returns null for anything that is not a
// well-formed auto-continue tap (a foreign or truncated callback). paneId is
// matched as a non-colon run so the optional trailing source id can't be
// swallowed into it.
export function parseContinueCallback(data: string): { paneId: string; resetAt: number; sourceMessageId: number | null } | null {
  const m = data.match(/^lc:([^:]+):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  return { paneId: m[1], resetAt: Number(m[2]), sourceMessageId: m[3] ? Number(m[3]) : null };
}

// Local HH:MM (24h) for a ms epoch — stable, locale-independent formatting.
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A coarse human delta ("2h 5m", "45m", "<1m") for "in …" copy.
export function formatDelta(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDeltaLocalized(ms: number, language: UsageReportLanguage): string {
  if (language !== 'ru') return formatDelta(ms);
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1 мин';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function formatPercent(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function usageLimitPhrase(limitName: string | null, language: UsageReportLanguage): string {
  if (language === 'ru') {
    if (limitName === '5-hour') return '5-часового лимита';
    if (limitName === 'weekly') return 'недельного лимита';
    if (limitName === 'context window') return 'контекстного окна';
    if (limitName === 'primary') return 'основного лимита';
    if (limitName === 'secondary') return 'дополнительного лимита';
    return limitName ? `${escapeHtml(limitName)} лимита` : 'лимита';
  }
  if (limitName === 'context window') return 'its context window';
  return limitName ? `its ${escapeHtml(limitName)} limit` : 'its limit';
}
