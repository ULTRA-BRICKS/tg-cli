// Alert subscriptions for live omp sessions (tg-cli#636): PURE store format, binding
// resolution, throttle protocol, message rendering and the `tg-ctl alert …` argv grammar.
// The entrypoint owns the file I/O (lockfile + atomicWrite + readFileOrNull), the `tg`
// spawn that posts to Telegram and the omp-live delivery.
//
// Why: a monitoring alert (rig sysmon, the omp-supervisor watcher) used to reach Telegram
// only, so the agent responsible for the machine never saw it in its own chat. A live omp
// session binds a TEMPORARY subscription; every alert is then posted to Telegram with a
// footer naming that session and delivered into the session with the Telegram message id
// (`tg#<id>`), so the agent can follow up on the very message once the issue is fixed.
//
// Lifecycle without events: the omp-live extension never calls the daemon — it publishes
// `<cfg>/omp-live/<pid>-<instanceId>.json` on session_start/session_switch and withdraws it
// on session_shutdown. A subscription is therefore keyed by the omp SESSION id (the
// persistent session-file id, identical across `omp --resume`; pid and instanceId change
// per process) and its state is resolved against the live registry at send/list time:
// a live endpoint with that sessionId → bound (pid/title refreshed from it, so a resumed
// session rebinds by itself); none → suspended (a closed session gets nothing) until the
// session comes back or the TTL expires and prunes the record.
//
// Throttle protocol (two sources fire together on an overloaded machine, so a send must be
// exactly-once per (source, key, severity) and window): under the store lock a sender
// CLAIMS the key (an entry with no message id yet), posts outside the lock, then SETTLES
// the claim with the Telegram id and the sessions it could not reach. A failed post drops
// the claim so a retry posts; a concurrent sender meets the claim and backs off; a later
// send inside the window re-delivers the posted alert to the sessions still pending
// instead of posting again. A claim its owner never settled expires after CLAIM_MAX_MS.

import { escapeHtml, decodeHtmlEntities, stripHtmlTags } from '../render/html';
import { isRecord } from './guards';
import type { OriginalOmpEndpoint } from './omp-live-routing';
import { formatAge } from './text-util';

export type AlertSeverity = 'info' | 'warning' | 'critical';
const SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical'];

export interface AlertSubscription {
  sessionId: string; // omp session id — the persistent identity across resume
  title: string | null; // last seen session title (refreshed from the live endpoint)
  pid: number | null; // last seen omp pid (refreshed from the live endpoint); null = subscribed by session id while closed
  cwd: string | null;
  sources: string[] | null; // null = every alert source
  createdAt: number; // ms epoch
  expiresAt: number | null; // ms epoch; null = no expiry
}

export interface AlertSubscriptionStore {
  subscriptions: AlertSubscription[];
}

export interface AlertThrottleEntry {
  key: string; // throttleKey(source, key, severity)
  at: number; // ms epoch of the claim
  messageId: number | null; // the Telegram message id once posted; null = claim in flight
  pending: string[]; // session ids the posted alert has not reached yet
}

export interface AlertThrottleStore {
  sent: AlertThrottleEntry[];
}

export interface AlertMessage {
  source: string;
  severity: AlertSeverity;
  key: string;
  text: string;
  html: boolean; // text is already Telegram HTML (the session copy is tag-stripped)
  title: string | null; // Telegram title badge; null = alertTitle()
}

export interface AlertBinding {
  subscription: AlertSubscription;
  endpoint: OriginalOmpEndpoint | null;
  state: 'bound' | 'suspended';
}

const STORE_VERSION = 1;
export const DEFAULT_ALERT_TTL_MS = 12 * 60 * 60_000;
export const DEFAULT_ALERT_WINDOW_MS = 10 * 60_000;
// A claim nobody settled (the sender died mid-post) stops blocking after this long.
export const CLAIM_MAX_MS = 2 * 60_000;
// Throttle entries older than this can never match a window a caller would pass.
const THROTTLE_RETAIN_MS = 24 * 60 * 60_000;
const MAX_THROTTLE_ENTRIES = 200;
const MAX_SUBSCRIPTIONS = 64;
const SOURCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const KEY_MAX = 256;
export const TITLE_MAX = 256;
// Telegram splits a long post; the omp-live transport refuses a body over 64 000 bytes, so
// the session copy (head + tail lines + the text) must stay well below that.
export const TEXT_MAX = 32_000;

// Type guards (narrowing is what makes them worth a name): a positive pid-like integer and
// a non-negative ms-epoch.
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// The envelope every store shares: a parse of a different version is an empty store (the
// caller logs it), never a silent reinterpretation.
function parseEnvelope(blob: string | null, listField: string): unknown[] | null {
  if (blob === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed[listField])) return null;
  return parsed[listField];
}

// --- subscription store ---

function validSubscription(v: unknown): AlertSubscription | null {
  if (!isRecord(v)) return null;
  if (typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 512) return null;
  if (!isMs(v.createdAt) || (v.pid !== null && !isPositiveInt(v.pid))) return null;
  if (v.expiresAt !== null && !isMs(v.expiresAt)) return null;
  if (v.title !== null && typeof v.title !== 'string') return null;
  if (v.cwd !== null && typeof v.cwd !== 'string') return null;
  const sources = v.sources;
  if (sources !== null && !(Array.isArray(sources) && sources.length > 0 && sources.every((s) => typeof s === 'string' && SOURCE_RE.test(s)))) return null;
  return {
    sessionId: v.sessionId,
    title: v.title as string | null,
    pid: v.pid as number | null,
    cwd: v.cwd as string | null,
    sources: sources as string[] | null,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt as number | null,
  };
}

const live = (s: AlertSubscription, now: number): boolean => s.expiresAt === null || s.expiresAt > now;

export function serializeAlertSubscriptions(store: AlertSubscriptionStore, now: number): string {
  const subscriptions = store.subscriptions.filter((s) => live(s, now)).slice(-MAX_SUBSCRIPTIONS);
  return JSON.stringify({ version: STORE_VERSION, subscriptions }, null, 1);
}

// Never throws: absent/malformed/other-version content is an empty store; expired records
// are dropped.
export function parseAlertSubscriptions(blob: string | null, now: number): AlertSubscriptionStore {
  const subscriptions: AlertSubscription[] = [];
  for (const raw of parseEnvelope(blob, 'subscriptions') ?? []) {
    const s = validSubscription(raw);
    if (s && live(s, now)) subscriptions.push(s);
  }
  return { subscriptions };
}

// One record per session: a re-subscribe replaces the earlier one (new TTL/sources).
export function upsertAlertSubscription(store: AlertSubscriptionStore, next: AlertSubscription): AlertSubscriptionStore {
  return { subscriptions: [...store.subscriptions.filter((s) => s.sessionId !== next.sessionId), next] };
}

export function removeAlertSubscription(store: AlertSubscriptionStore, sessionId: string): AlertSubscriptionStore {
  return { subscriptions: store.subscriptions.filter((s) => s.sessionId !== sessionId) };
}

// Resolve every live subscription against the omp-live registry. A subscription with a
// live endpoint of the same sessionId is bound and takes that endpoint's pid/title (a
// resumed session has a new pid); one without is suspended. `source` keeps only the
// subscriptions that want that source (or every source).
export function resolveAlertBindings(
  store: AlertSubscriptionStore,
  endpoints: readonly OriginalOmpEndpoint[],
  now: number,
  source?: string,
): AlertBinding[] {
  const out: AlertBinding[] = [];
  for (const s of store.subscriptions) {
    if (!live(s, now)) continue;
    if (source !== undefined && s.sources !== null && !s.sources.includes(source)) continue;
    const endpoint = endpoints.find((e) => e.sessionId === s.sessionId) ?? null;
    const subscription = endpoint ? { ...s, pid: endpoint.pid, title: endpoint.title ?? s.title, cwd: endpoint.cwd } : s;
    out.push({ subscription, endpoint, state: endpoint ? 'bound' : 'suspended' });
  }
  return out;
}

// The nearest ancestor (the chain is nearest-first) that is a live omp-live host: how a
// shell inside an omp session finds its own session without naming a pid.
export function nearestLiveAncestor(ancestorPids: readonly number[], endpoints: readonly OriginalOmpEndpoint[]): OriginalOmpEndpoint | null {
  for (const pid of ancestorPids) {
    const host = endpoints.find((e) => e.pid === pid);
    if (host) return host;
  }
  return null;
}

// --- throttle protocol ---

export function throttleKey(source: string, key: string, severity: AlertSeverity): string {
  return `${source}|${key}|${severity}`;
}

export type ThrottleVerdict =
  | { kind: 'send' } // no live entry: claim and post
  | { kind: 'in-flight'; entry: AlertThrottleEntry } // another sender holds a fresh claim
  | { kind: 'throttled'; entry: AlertThrottleEntry }; // posted inside the window; only re-deliver its pending sessions

export function throttleVerdict(store: AlertThrottleStore, key: string, now: number, windowMs: number): ThrottleVerdict {
  const entry = store.sent.find((e) => e.key === key);
  if (!entry) return { kind: 'send' };
  const elapsed = now - entry.at;
  if (elapsed < 0) return { kind: 'send' }; // a clock stepped back: the entry is from the future, never a block
  if (entry.messageId === null) return elapsed < CLAIM_MAX_MS ? { kind: 'in-flight', entry } : { kind: 'send' };
  return elapsed < windowMs ? { kind: 'throttled', entry } : { kind: 'send' };
}

export function claimAlert(store: AlertThrottleStore, key: string, now: number): AlertThrottleStore {
  return { sent: [...store.sent.filter((e) => e.key !== key), { key, at: now, messageId: null, pending: [] }] };
}

// Settle a claim: the posted id and the sessions still to reach; a failed post (null)
// releases the claim so the next send posts again.
export function settleAlert(store: AlertThrottleStore, key: string, messageId: number | null, pending: readonly string[]): AlertThrottleStore {
  const rest = store.sent.filter((e) => e.key !== key);
  const own = store.sent.find((e) => e.key === key);
  if (messageId === null || !own) return { sent: rest };
  return { sent: [...rest, { ...own, messageId, pending: [...new Set(pending)] }] };
}

export function markAlertDelivered(store: AlertThrottleStore, key: string, sessionIds: readonly string[]): AlertThrottleStore {
  return { sent: store.sent.map((e) => (e.key === key ? { ...e, pending: e.pending.filter((s) => !sessionIds.includes(s)) } : e)) };
}

export function serializeAlertThrottle(store: AlertThrottleStore, now: number): string {
  const sent = store.sent.filter((e) => now - e.at < THROTTLE_RETAIN_MS).slice(-MAX_THROTTLE_ENTRIES);
  return JSON.stringify({ version: STORE_VERSION, sent });
}

export function parseAlertThrottle(blob: string | null, now: number): AlertThrottleStore {
  const sent: AlertThrottleEntry[] = [];
  for (const raw of parseEnvelope(blob, 'sent') ?? []) {
    if (!isRecord(raw) || typeof raw.key !== 'string' || !isMs(raw.at) || now - raw.at >= THROTTLE_RETAIN_MS) continue;
    if (raw.messageId !== null && !isPositiveInt(raw.messageId)) continue;
    const pending = Array.isArray(raw.pending) ? raw.pending.filter((s): s is string => typeof s === 'string') : [];
    sent.push({ key: raw.key, at: raw.at, messageId: raw.messageId as number | null, pending });
  }
  return { sent };
}

// --- rendering ---

export function alertTitle(msg: AlertMessage): string {
  return msg.title ?? `${msg.source} ${msg.severity.toUpperCase()}: ${msg.key}`;
}

// `tg --tag`: a warning/critical alert is a problem; an info alert a report.
export function alertTag(severity: AlertSeverity): 'problem' | 'report' {
  return severity === 'info' ? 'report' : 'problem';
}

// The Telegram HTML body: the alert text, then one footer line per BOUND session so the
// reader sees which agent is also handling it. A suspended subscription is not named — the
// session is closed and gets nothing.
export function telegramAlertBody(msg: AlertMessage, bindings: readonly AlertBinding[]): string {
  const body = msg.html ? msg.text : escapeHtml(msg.text);
  const footer = bindings
    .filter((b) => b.state === 'bound')
    .map((b) => `<i>↳ также адресовано агенту: ${escapeHtml(b.subscription.title ?? '(untitled)')} (pid ${b.subscription.pid})</i>`);
  return footer.length === 0 ? body : `${body}\n\n${footer.join('\n')}`;
}

// The copy delivered into a session: the `tg#<id>` convention agents already know from
// inbound messages, so the follow-up is `tg --reply-to <id>` on the alert itself.
export function sessionAlertText(msg: AlertMessage, messageId: number): string {
  const text = msg.html ? decodeHtmlEntities(stripHtmlTags(msg.text)) : msg.text;
  return `[alert tg#${messageId} · ${msg.source} · ${msg.severity}] ${text}\n— when fixed, follow up on this alert: tg --reply-to ${messageId} "<status>"`;
}

// The first id of `tg`'s `OK tg#<id> …` line (a >4096 body splits into several ids; the
// first is the one a reply threads under). null when no id was printed.
export function parseTgSendOk(stdout: string): number | null {
  const m = /^OK tg#(\d+)/m.exec(stdout);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// One omp-live request id per (posted alert, session): the host deduplicates on it (plus
// the text's hash), so a pending re-delivery of the same alert into the same session —
// a retry after a timeout the host had in fact accepted — is accepted once.
export function alertRequestId(messageId: number, sessionId: string): string {
  return `alert:${messageId}:${sessionId.replace(/[^A-Za-z0-9:_.-]/g, '_').slice(0, 120)}`;
}

export function formatAlertList(bindings: readonly AlertBinding[], now: number): string {
  if (bindings.length === 0) return 'alert subscriptions: none';
  const lines = bindings.map((b) => {
    const s = b.subscription;
    const state = b.state === 'bound' ? 'bound' : 'suspended (no live omp-live endpoint)';
    const sources = s.sources === null ? 'all' : s.sources.join(',');
    const expiry = s.expiresAt === null ? 'no expiry' : `expires in ${formatAge(s.expiresAt - now)}`;
    return `  - ${state} · ${s.title ?? '(untitled)'} · pid ${s.pid ?? '?'} · session ${s.sessionId} · sources: ${sources} · ${expiry}`;
  });
  return [`alert subscriptions: ${bindings.length}`, ...lines].join('\n');
}

// --- argv ---

export type AlertCommand =
  | { cmd: 'send'; message: AlertMessage; windowMs: number; force: boolean }
  | { cmd: 'subscribe'; pid: number | null; sessionId: string | null; sources: string[] | null; ttlMs: number | null }
  | { cmd: 'unsubscribe'; pid: number | null; sessionId: string | null; all: boolean }
  | { cmd: 'list'; json: boolean }
  | { cmd: 'error'; error: string };

const UNITS = { '': 60_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// `10m`, `90s`, `2h`, `1d`; a bare number is minutes. null = not a duration.
export function parseDurationMs(raw: string): number | null {
  const m = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNITS[m[2] as keyof typeof UNITS];
  return Number.isSafeInteger(ms) ? ms : null;
}

const USAGE = 'usage: tg-ctl alert send|subscribe|unsubscribe|list';

type Flags = Record<string, string | true>;
type FlagsResult = { ok: true; flags: Flags } | { ok: false; error: string };

// Flags are `--name value` (or bare boolean flags); values are taken verbatim so a text
// that starts with a dash still works after its flag.
function readFlags(argv: readonly string[], booleans: readonly string[]): FlagsResult {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { ok: false, error: `unexpected argument: ${a}` };
    const name = a.slice(2);
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (i + 1 >= argv.length) return { ok: false, error: `missing value for --${name}` };
    flags[name] = argv[++i];
  }
  return { ok: true, flags };
}

const KNOWN: Record<string, readonly string[]> = {
  send: ['source', 'severity', 'key', 'text', 'title', 'html', 'window', 'force'],
  subscribe: ['pid', 'session', 'sources', 'ttl'],
  unsubscribe: ['pid', 'session', 'all'],
  list: ['json'],
};
const BOOLEANS = ['html', 'force', 'all', 'json'];

type PidResult = { ok: true; pid: number | null } | { ok: false; error: string };

export function parseAlertArgv(argv: readonly string[]): AlertCommand {
  const [cmd, ...rest] = argv;
  if (cmd !== 'send' && cmd !== 'subscribe' && cmd !== 'unsubscribe' && cmd !== 'list') return { cmd: 'error', error: USAGE };
  const read = readFlags(rest, BOOLEANS);
  if (!read.ok) return { cmd: 'error', error: read.error };
  const flags = read.flags;
  for (const name of Object.keys(flags)) if (!KNOWN[cmd].includes(name)) return { cmd: 'error', error: `unknown flag: --${name}` };
  const str = (name: string): string | null => (typeof flags[name] === 'string' ? (flags[name] as string) : null);
  const pidFlag = (): PidResult => {
    const raw = str('pid');
    if (raw === null) return { ok: true, pid: null };
    const pid = Number(raw);
    return isPositiveInt(pid) ? { ok: true, pid } : { ok: false, error: `invalid --pid: ${raw}` };
  };

  if (cmd === 'list') return { cmd, json: flags.json === true };

  if (cmd === 'unsubscribe' || cmd === 'subscribe') {
    const pid = pidFlag();
    if (!pid.ok) return { cmd: 'error', error: pid.error };
    const sessionId = str('session');
    if (pid.pid !== null && sessionId !== null) return { cmd: 'error', error: '--pid and --session are exclusive' };
    if (cmd === 'unsubscribe') return { cmd, pid: pid.pid, sessionId, all: flags.all === true };
    let ttlMs: number | null = DEFAULT_ALERT_TTL_MS;
    const ttlRaw = str('ttl');
    if (ttlRaw !== null) {
      const ms = parseDurationMs(ttlRaw);
      if (ms === null) return { cmd: 'error', error: `invalid --ttl: ${ttlRaw} (e.g. 12h, 30m, 0 = no expiry)` };
      ttlMs = ms === 0 ? null : ms;
    }
    let sources: string[] | null = null;
    const sourcesRaw = str('sources');
    if (sourcesRaw !== null) {
      sources = sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (sources.length === 0 || sources.some((s) => !SOURCE_RE.test(s))) return { cmd: 'error', error: `invalid --sources: ${sourcesRaw}` };
    }
    return { cmd, pid: pid.pid, sessionId, sources, ttlMs };
  }

  const source = str('source');
  const severity = str('severity');
  const key = str('key');
  const text = str('text');
  const title = str('title');
  if (source === null || severity === null || key === null || text === null) {
    return { cmd: 'error', error: 'send requires --source, --severity, --key and --text' };
  }
  if (!SOURCE_RE.test(source)) return { cmd: 'error', error: `invalid --source: ${source} (letters, digits, - _ . only)` };
  if (!(SEVERITIES as readonly string[]).includes(severity)) return { cmd: 'error', error: `invalid --severity: ${severity} (info|warning|critical)` };
  if (!text.trim()) return { cmd: 'error', error: 'empty --text' };
  if (text.length > TEXT_MAX) return { cmd: 'error', error: `--text longer than ${TEXT_MAX} chars` };
  if (key.length > KEY_MAX) return { cmd: 'error', error: `--key longer than ${KEY_MAX} chars` };
  if (title !== null && title.length > TITLE_MAX) return { cmd: 'error', error: `--title longer than ${TITLE_MAX} chars` };
  let windowMs = DEFAULT_ALERT_WINDOW_MS;
  const windowRaw = str('window');
  if (windowRaw !== null) {
    const ms = parseDurationMs(windowRaw);
    if (ms === null) return { cmd: 'error', error: `invalid --window: ${windowRaw}` };
    windowMs = ms;
  }
  return {
    cmd,
    message: { source, severity: severity as AlertSeverity, key: key.trim() || '-', text, html: flags.html === true, title },
    windowMs,
    force: flags.force === true,
  };
}
