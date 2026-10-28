// Alert subscriptions for live omp sessions (tg-cli#636): PURE store format, binding
// resolution, throttle protocol, message rendering and the `tg-ctl alert …` argv grammar.
// The entrypoint owns the file I/O (lockfile + atomicWrite + readFileOrNull), the `tg`
// spawn that posts to Telegram and the omp-live delivery.
//
// Why: a monitoring alert (rig sysmon, the omp-supervisor watcher) used to reach Telegram
// only, so the agent responsible for the machine never saw it in its own chat. A live omp
// session binds a TEMPORARY subscription. Owner-ready reports are posted to Telegram and
// delivered with the Telegram message id (`tg#<id>`). Incomplete problem reports reach the
// exclusive source holder (or subscribers when vacant) as internal incidents only, so an
// agent can investigate and report actual remediation without inventing work in the alert.
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
import { createHash } from 'node:crypto';
import { DEFAULT_ALERT_TTL_MS, isMs, isPositiveInt, parseEnvelope, SOURCE_RE, STORE_VERSION, THROTTLE_RETAIN_MS, validSessionId } from './alert-remediation/alert-primitives';
import { unresolvedInternalReceipt } from './alert-remediation/throttle-records';
import { isRecord } from './guards';
import type { OriginalOmpEndpoint } from './omp-live-routing';
import { formatAge } from './text-util';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertSubscription {
  sessionId: string; // omp session id — the persistent identity across resume
  title: string | null; // last seen session title (refreshed from the live endpoint)
  pid: number | null; // last seen omp pid (refreshed from the live endpoint); null = subscribed by session id while closed
  cwd: string | null;
  sources: string[] | null; // null = every alert source
  createdAt: number; // ms epoch
  expiresAt: number | null; // ms epoch; null = no expiry
}

// A handoff request a non-holder left on the slot (tg-cli#747).
export interface HandoffRequest {
  sessionId: string;
  title: string | null;
  pid: number | null;
  at: number; // ms epoch of the request; HANDOFF_ANSWER_MS later the requester may take the slot
  reason: string | null;
}

// The EXCLUSIVE holder of one alert source (tg-cli#747): at most one omp session per source
// receives that source's `send --to-holder` alerts. Keyed by the omp session id, like a
// subscription, so a resumed session keeps the slot.
export interface AlertHolder {
  source: string;
  sessionId: string;
  title: string | null;
  pid: number | null;
  cwd: string | null;
  since: number; // ms epoch the session got the slot
  lastSeenLiveAt: number; // ms epoch its endpoint was last seen (or a delivery succeeded)
  failingSince: number | null; // ms epoch of the first failed delivery in a row; null = none
  expiresAt: number | null; // ms epoch; null = no expiry
  request: HandoffRequest | null;
}

export interface AlertSubscriptionStore {
  subscriptions: AlertSubscription[];
  holders: AlertHolder[]; // at most one per source
}

export interface AlertThrottleEntry {
  key: string; // throttleKey(source, key, severity)
  at: number; // ms epoch of the claim
  messageId: number | null; // positive = Telegram id, 0 = internal/holder only, null = post in flight
  pending: string[]; // session ids whose acceptance has not been confirmed
  internalText?: string; // immutable internal incident snapshot, persisted BEFORE delivery
  internalRecipients?: string[]; // current assignments + accepted identity history across subscription changes
  internalAttempts?: InternalAlertAttempt[]; // generations whose send frame may have reached a host
}

export interface InternalAlertAttempt { sessionId: string; pid: number; instanceId: string }

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

export { DEFAULT_ALERT_TTL_MS, DEFAULT_ALERT_WINDOW_MS, HOLDER_TEXT_MAX_BYTES, KEY_MAX, TEXT_MAX, TITLE_MAX } from './alert-remediation/alert-primitives';
// A holder whose endpoint vanished (or whose deliveries keep failing) loses the slot after this.
export const HOLDER_GRACE_MS = 10 * 60_000;
// An unanswered handoff request lets the requester take the slot after this.
export const HANDOFF_ANSWER_MS = 10 * 60_000;
// A claim nobody settled (the sender died mid-post) stops blocking after this long.
export const CLAIM_MAX_MS = 2 * 60_000;
const MAX_THROTTLE_ENTRIES = 200;
const MAX_UNRESOLVED_INTERNAL_RECEIPTS = MAX_THROTTLE_ENTRIES;
const MAX_SUBSCRIPTIONS = 64;

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

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

function validRequest(v: unknown): HandoffRequest | null {
  if (!isRecord(v) || !validSessionId(v.sessionId) || !isMs(v.at)) return null;
  if (!nullableString(v.title) || !nullableString(v.reason) || (v.pid !== null && !isPositiveInt(v.pid))) return null;
  return { sessionId: v.sessionId, title: v.title, pid: v.pid as number | null, at: v.at, reason: v.reason };
}

// A holder record with a missing or malformed field (its request included) is dropped.
function validHolder(v: unknown): AlertHolder | null {
  if (!isRecord(v) || typeof v.source !== 'string' || !SOURCE_RE.test(v.source) || !validSessionId(v.sessionId)) return null;
  if (!nullableString(v.title) || !nullableString(v.cwd) || (v.pid !== null && !isPositiveInt(v.pid))) return null;
  if (!isMs(v.since) || !isMs(v.lastSeenLiveAt)) return null;
  if ((v.failingSince !== null && !isMs(v.failingSince)) || (v.expiresAt !== null && !isMs(v.expiresAt))) return null;
  const request = v.request === null ? null : validRequest(v.request);
  if (v.request !== null && request === null) return null;
  return {
    source: v.source,
    sessionId: v.sessionId,
    title: v.title,
    pid: v.pid as number | null,
    cwd: v.cwd,
    since: v.since,
    lastSeenLiveAt: v.lastSeenLiveAt,
    failingSince: v.failingSince as number | null,
    expiresAt: v.expiresAt as number | null,
    request,
  };
}

const live = (s: { expiresAt: number | null }, now: number): boolean => s.expiresAt === null || s.expiresAt > now;

export function serializeAlertSubscriptions(store: AlertSubscriptionStore, now: number): string {
  const subscriptions = store.subscriptions.filter((s) => live(s, now)).slice(-MAX_SUBSCRIPTIONS);
  const holders = store.holders.filter((h) => live(h, now));
  return JSON.stringify({ version: STORE_VERSION, subscriptions, holders }, null, 1);
}

// Never throws: absent/malformed/other-version content is an empty store; expired records
// are dropped. A store written before holders existed has none (the field is additive).
export function parseAlertSubscriptions(blob: string | null, now: number): AlertSubscriptionStore {
  const envelope = parseEnvelope(blob, 'subscriptions');
  const subscriptions: AlertSubscription[] = [];
  for (const raw of (envelope?.subscriptions as unknown[] | undefined) ?? []) {
    const s = validSubscription(raw);
    if (s && live(s, now)) subscriptions.push(s);
  }
  // Two records for one source (a hand edit): the earliest claim keeps the slot.
  const bySource = new Map<string, AlertHolder>();
  const rawHolders = envelope?.holders;
  for (const raw of Array.isArray(rawHolders) ? rawHolders : []) {
    const h = validHolder(raw);
    const prior = h ? bySource.get(h.source) : undefined;
    if (h && live(h, now) && (!prior || h.since < prior.since)) bySource.set(h.source, h);
  }
  return { subscriptions, holders: [...bySource.values()] };
}

// One record per session: a re-subscribe replaces the earlier one (new TTL/sources).
// Holders change only through the holder functions below.
export function upsertAlertSubscription(store: AlertSubscriptionStore, next: AlertSubscription): AlertSubscriptionStore {
  return { ...store, subscriptions: [...store.subscriptions.filter((s) => s.sessionId !== next.sessionId), next] };
}

export function removeAlertSubscription(store: AlertSubscriptionStore, sessionId: string): AlertSubscriptionStore {
  return { ...store, subscriptions: store.subscriptions.filter((s) => s.sessionId !== sessionId) };
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

// --- exclusive holder (tg-cli#747) ---

export type HolderState = 'bound' | 'suspended' | 'vacant';

export type Claimant = { sessionId: string; title: string | null; pid: number | null; cwd: string | null };

export type HolderOutcome =
  | { ok: true; store: AlertSubscriptionStore; holder: AlertHolder }
  | { ok: false; code: 1 | 3; error: string; holder: AlertHolder | null };

const holderOf = (store: AlertSubscriptionStore, source: string): AlertHolder | null => store.holders.find((h) => h.source === source) ?? null;

const withHolder = (store: AlertSubscriptionStore, source: string, next: AlertHolder | null): AlertSubscriptionStore => ({
  ...store,
  holders: [...store.holders.filter((h) => h.source !== source), ...(next ? [next] : [])],
});

// Spec order: vacant (none / expired / failing for HOLDER_GRACE_MS) → bound (a live endpoint
// with the holder's session id) → suspended (seen live within HOLDER_GRACE_MS) → vacant.
// A vacant slot still reports the stale record so a caller can name the former holder.
export function holderState(
  store: AlertSubscriptionStore,
  source: string,
  endpoints: readonly OriginalOmpEndpoint[],
  now: number,
): { state: HolderState; holder: AlertHolder | null; endpoint: OriginalOmpEndpoint | null } {
  const holder = holderOf(store, source);
  if (!holder || !live(holder, now) || (holder.failingSince !== null && now - holder.failingSince >= HOLDER_GRACE_MS)) {
    return { state: 'vacant', holder, endpoint: null };
  }
  const endpoint = endpoints.find((e) => e.sessionId === holder.sessionId) ?? null;
  if (endpoint) return { state: 'bound', holder, endpoint };
  return { state: now - holder.lastSeenLiveAt < HOLDER_GRACE_MS ? 'suspended' : 'vacant', holder, endpoint: null };
}

// A fresh holder record for `who`, its pid/title/cwd taken from its live endpoint when it has one.
function newHolder(source: string, who: Claimant, endpoints: readonly OriginalOmpEndpoint[], now: number, expiresAt: number | null): AlertHolder {
  const ep = endpoints.find((e) => e.sessionId === who.sessionId);
  return {
    source,
    sessionId: who.sessionId,
    title: ep?.title ?? who.title,
    pid: ep?.pid ?? who.pid,
    cwd: ep?.cwd ?? who.cwd,
    since: now,
    lastSeenLiveAt: now,
    failingSince: null,
    expiresAt,
    request: null,
  };
}

const granted = (store: AlertSubscriptionStore, holder: AlertHolder): HolderOutcome => ({ ok: true, store: withHolder(store, holder.source, holder), holder });
const refused = (code: 1 | 3, error: string, holder: AlertHolder | null): HolderOutcome => ({ ok: false, code, error, holder });
// ttlMs null or 0 = no expiry.
const expiry = (now: number, ttlMs: number | null): number | null => (ttlMs === null || ttlMs === 0 ? null : now + ttlMs);

// Vacant or already ours → ok; else 3. A re-claim by the holder (bound, or suspended while it
// resumes) refreshes pid/title/cwd, lastSeenLiveAt and the TTL and keeps since/request.
export function claimHolder(store: AlertSubscriptionStore, source: string, claimant: Claimant, endpoints: readonly OriginalOmpEndpoint[], now: number, ttlMs: number | null): HolderOutcome {
  const st = holderState(store, source, endpoints, now);
  if (st.state !== 'vacant' && st.holder && st.holder.sessionId !== claimant.sessionId) return refused(3, `${source} is held by session ${st.holder.sessionId}`, st.holder);
  if (st.state !== 'vacant' && st.holder) {
    const fresh = newHolder(source, claimant, endpoints, now, expiry(now, ttlMs));
    return granted(store, { ...fresh, since: st.holder.since, failingSince: st.holder.failingSince, request: st.holder.request });
  }
  return granted(store, newHolder(source, claimant, endpoints, now, expiry(now, ttlMs)));
}

// Leave a request on a held slot. 3 when vacant (take it instead), when the requester holds
// it, or while another session's request is pending.
export function requestHandoff(store: AlertSubscriptionStore, source: string, requester: Claimant, endpoints: readonly OriginalOmpEndpoint[], now: number, reason: string | null): HolderOutcome {
  const st = holderState(store, source, endpoints, now);
  if (st.state === 'vacant' || !st.holder) return refused(3, `${source} has no holder: claim it with tg-ctl alert take --source ${source}`, st.holder);
  if (st.holder.sessionId === requester.sessionId) return refused(3, `session ${requester.sessionId} already holds ${source}`, st.holder);
  // One request at a time, whatever its age: the pending requester's `take` after
  // HANDOFF_ANSWER_MS can never be pre-empted by a later one.
  const prior = st.holder.request;
  if (prior && prior.sessionId !== requester.sessionId) {
    return refused(3, `${source} already has a pending handoff request from ${prior.title ?? '(untitled)'} (session ${prior.sessionId}); ask again once the holder answered it`, st.holder);
  }
  const ep = endpoints.find((e) => e.sessionId === requester.sessionId);
  const request: HandoffRequest = { sessionId: requester.sessionId, title: ep?.title ?? requester.title, pid: ep?.pid ?? requester.pid, at: now, reason };
  return granted(store, { ...st.holder, request });
}

// The holder hands the slot to a LIVE session: a fresh record; no expiry stays no expiry,
// otherwise the target gets the default TTL from now.
export function grantHandoff(store: AlertSubscriptionStore, source: string, callerSessionId: string, target: Claimant, endpoints: readonly OriginalOmpEndpoint[], now: number): HolderOutcome {
  const st = holderState(store, source, endpoints, now);
  if (st.state === 'vacant' || !st.holder || st.holder.sessionId !== callerSessionId) return refused(1, `session ${callerSessionId} does not hold ${source}`, st.holder);
  if (target.sessionId === callerSessionId) return refused(1, `session ${callerSessionId} already holds ${source}`, st.holder);
  if (!endpoints.some((e) => e.sessionId === target.sessionId)) return refused(1, `session ${target.sessionId} has no live omp-live endpoint`, st.holder);
  return granted(store, newHolder(source, target, endpoints, now, st.holder.expiresAt === null ? null : now + DEFAULT_ALERT_TTL_MS));
}

// Holder only, and only while the slot is not vacant (a lapsed holder has no say).
export function denyHandoff(store: AlertSubscriptionStore, source: string, callerSessionId: string, endpoints: readonly OriginalOmpEndpoint[], now: number): HolderOutcome & { denied?: HandoffRequest | null } {
  const { state, holder } = holderState(store, source, endpoints, now);
  if (state === 'vacant' || !holder || holder.sessionId !== callerSessionId) return refused(1, `session ${callerSessionId} does not hold ${source}`, holder);
  if (!holder.request) return refused(1, 'no pending handoff request', holder);
  return { ...granted(store, { ...holder, request: null }), denied: holder.request };
}

// Undo a request whose note never reached the holder: an unseen request must not ripen
// into a take. Fenced on the request's requester and `at`; anything else is left alone.
export function withdrawRequest(store: AlertSubscriptionStore, source: string, requesterSessionId: string, at: number): AlertSubscriptionStore {
  const holder = holderOf(store, source);
  if (!holder?.request || holder.request.sessionId !== requesterSessionId || holder.request.at !== at) return store;
  return withHolder(store, source, { ...holder, request: null });
}

// Vacant → anyone; held → only the requester whose request went unanswered HANDOFF_ANSWER_MS.
export function takeHolder(store: AlertSubscriptionStore, source: string, taker: Claimant, endpoints: readonly OriginalOmpEndpoint[], now: number, ttlMs: number | null): HolderOutcome {
  const st = holderState(store, source, endpoints, now);
  const request = st.holder?.request ?? null;
  const unanswered = request !== null && request.sessionId === taker.sessionId && now - request.at >= HANDOFF_ANSWER_MS;
  if (st.state !== 'vacant' && !unanswered) return refused(3, `${source} is held by session ${st.holder?.sessionId}`, st.holder);
  return granted(store, newHolder(source, taker, endpoints, now, expiry(now, ttlMs)));
}

export function releaseHolder(store: AlertSubscriptionStore, source: string, sessionId: string): HolderOutcome {
  const holder = holderOf(store, source);
  if (!holder || holder.sessionId !== sessionId) return refused(1, `session ${sessionId} does not hold ${source}`, holder);
  return { ok: true, store: withHolder(store, source, null), holder };
}

// While bound: the endpoint was seen now; pid/title/cwd follow it (a resume has a new pid).
export function refreshHolder(store: AlertSubscriptionStore, source: string, endpoints: readonly OriginalOmpEndpoint[], now: number): AlertSubscriptionStore {
  const st = holderState(store, source, endpoints, now);
  if (st.state !== 'bound' || !st.holder || !st.endpoint) return store;
  const ep = st.endpoint;
  return withHolder(store, source, { ...st.holder, lastSeenLiveAt: now, pid: ep.pid, title: ep.title ?? st.holder.title, cwd: ep.cwd });
}

// Record a `--to-holder` delivery result — only while the same tenure (`sessionId` + `since`)
// still holds the slot, so a delivery that finished after a handoff, or after a release and
// re-claim by the same session, never marks the newer tenure.
export function markHolderDelivery(store: AlertSubscriptionStore, source: string, sessionId: string, since: number, ok: boolean, now: number): AlertSubscriptionStore {
  const holder = holderOf(store, source);
  if (!holder || holder.sessionId !== sessionId || holder.since !== since) return store;
  const next = ok ? { ...holder, failingSince: null, lastSeenLiveAt: now } : { ...holder, failingSince: holder.failingSince ?? now };
  return withHolder(store, source, next);
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


export class InternalReceiptCapacityError extends Error {
  readonly code = 'internal_receipt_capacity';
  constructor() {
    super(`internal receipt capacity (${MAX_UNRESOLVED_INTERNAL_RECEIPTS}) reached; reconcile unresolved incidents before creating another internal claim`);
    this.name = 'InternalReceiptCapacityError';
  }
}

export function throttleVerdict(store: AlertThrottleStore, key: string, now: number, windowMs: number): ThrottleVerdict {
  const entry = store.sent.find((e) => e.key === key);
  if (!entry) return { kind: 'send' };
  const elapsed = now - entry.at;
  // An unresolved internal incident retains its original text/receipt identity across
  // retries, even when the normal repeat window elapsed. Pending never means delivered.
  if (unresolvedInternalReceipt(entry)) return { kind: 'throttled', entry };
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
  // messageId 0 = a holder send (settleHolderAlert); posted, with no Telegram id.
  return { sent: [...rest, { ...own, messageId, pending: [...new Set(pending)] }] };
}

// A delivered holder send has no Telegram id: it is recorded as posted with messageId 0.
// Fenced on the claim's `at`: a claim another sender replaced meanwhile is left alone.
export function settleHolderAlert(store: AlertThrottleStore, key: string, claimAt: number): AlertThrottleStore {
  return { sent: store.sent.map((e) => (e.key === key && e.at === claimAt && e.messageId === null ? { ...e, messageId: 0, pending: [] } : e)) };
}

// A holder send that delivered nothing drops its OWN claim (fenced like settleHolderAlert)
// so the monitor's retry delivers.
export function releaseHolderClaim(store: AlertThrottleStore, key: string, claimAt: number): AlertThrottleStore {
  return { sent: store.sent.filter((e) => !(e.key === key && e.at === claimAt && e.messageId === null)) };
}

export function markAlertDelivered(store: AlertThrottleStore, key: string, sessionIds: readonly string[]): AlertThrottleStore {
  return { sent: store.sent.map((e) => (e.key === key ? { ...e, pending: e.pending.filter((s) => !sessionIds.includes(s)) } : e)) };
}

// Internal receipts have a separate namespace, so observing a raw incident never
// throttles a later complete owner report. A new holder has its own delivery window.
export function internalThrottleKey(msg: AlertMessage, holderSessionId: string | null): string {
  return `internal:${JSON.stringify([holderSessionId, msg.source, msg.key, msg.severity])}`;
}

// Persist ALL pending recipients before I/O. Concurrent retries use the same request id
// and text. omp-live deduplicates only within one endpoint generation; pin it before send.
export function claimInternalAlert(store: AlertThrottleStore, key: string, now: number, text: string, pending: readonly string[]): AlertThrottleStore {
  // Admission happens under the caller's store lock, before delivery. Never make
  // room for a new incident by forgetting a possibly accepted earlier one.
  if (store.sent.filter((entry) => entry.key !== key && unresolvedInternalReceipt(entry)).length >= MAX_UNRESOLVED_INTERNAL_RECEIPTS) {
    throw new InternalReceiptCapacityError();
  }
  const prior = store.sent.find((entry) => entry.key === key);
  const at = Math.max(now, (prior?.at ?? -1) + 1);
  const recipients = [...new Set(pending)];
  return { sent: [...store.sent.filter((entry) => entry.key !== key), { key, at, messageId: 0, pending: recipients, internalText: text, internalRecipients: recipients, internalAttempts: [] }] };
}

// `pinned`: THIS call recorded the generation. `ready`: it was already recorded by an earlier
// attempt, which may have written a frame — only the caller that got `pinned` may release it.
export type InternalAttemptVerdict = 'pinned' | 'ready' | 'internal_delivery_uncertain' | 'internal_receipt_changed' | 'internal_receipt_acknowledged';

// Called under the store lock, after the socket connects but BEFORE its send frame.
// A lost ACK or failed acknowledgement write can be reconciled only by that generation's
// receipt cache. A restarted endpoint has no cache; automatic replay could duplicate work.
export function pinInternalAlertAttempt(store: AlertThrottleStore, key: string, claimAt: number, target: InternalAlertAttempt): { store: AlertThrottleStore; result: InternalAttemptVerdict } {
  const entry = store.sent.find((item) => item.key === key && item.at === claimAt && item.internalText !== undefined);
  if (!entry) return { store, result: 'internal_receipt_changed' };
  if (!entry.pending.includes(target.sessionId)) return { store,
    result: entry.internalRecipients?.includes(target.sessionId) ? 'internal_receipt_acknowledged' : 'internal_receipt_changed' };
  // Older/corrupt receipts cannot prove whether a frame was already written.
  if (entry.internalAttempts === undefined) return { store, result: 'internal_delivery_uncertain' };
  const prior = entry.internalAttempts.find((attempt) => attempt.sessionId === target.sessionId);
  if (prior) return { store, result: prior.pid === target.pid && prior.instanceId === target.instanceId ? 'ready' : 'internal_delivery_uncertain' };
  const attempt = { sessionId: target.sessionId, pid: target.pid, instanceId: target.instanceId };
  return { store: { sent: store.sent.map((item) => item === entry ? { ...item, internalAttempts: [...entry.internalAttempts!, attempt] } : item) }, result: 'pinned' };
}

// The host answered `stale_identity` before reading the frame, so nothing was accepted: drop
// exactly that generation's pin (fenced on the claim) and let the re-resolved endpoint be tried.
// A frame the host DID read (any other outcome) keeps its pin; that is the uncertainty rule.
export function releaseInternalAlertAttempt(store: AlertThrottleStore, key: string, claimAt: number, target: InternalAlertAttempt): AlertThrottleStore {
  return { sent: store.sent.map((entry) => entry.key === key && entry.at === claimAt && entry.internalText !== undefined && entry.internalAttempts !== undefined
    ? { ...entry, internalAttempts: entry.internalAttempts.filter((attempt) => !(attempt.sessionId === target.sessionId && attempt.pid === target.pid && attempt.instanceId === target.instanceId)) }
    : entry) };
}

// A withdrawn/expired subscription is no longer responsible for the incident. Assign
// its replacement the same snapshot without replaying sessions already acknowledged.
export function reconcileInternalAlertRecipients(store: AlertThrottleStore, key: string, claimAt: number, sessionIds: readonly string[]): AlertThrottleStore {
  const recipients = [...new Set(sessionIds)];
  return { sent: store.sent.map((entry) => {
    if (entry.key !== key || entry.at !== claimAt || entry.internalText === undefined) return entry;
    const prior = entry.internalRecipients ?? entry.pending;
    const accepted = prior.filter((session) => !entry.pending.includes(session));
    return { ...entry, internalRecipients: [...new Set([...accepted, ...recipients])], pending: recipients.filter((session) => !accepted.includes(session)) };
  }) };
}

// Remove only acknowledged recipients from this receipt; a concurrent forced send's
// replacement or another sender's progress must not be overwritten by a stale result.
export function markInternalAlertDelivered(store: AlertThrottleStore, key: string, claimAt: number, sessionIds: readonly string[]): AlertThrottleStore {
  return { sent: store.sent.map((entry) => entry.key === key && entry.at === claimAt && entry.internalText !== undefined
    ? { ...entry, pending: entry.pending.filter((session) => !sessionIds.includes(session)),
      internalRecipients: [...new Set([...(entry.internalRecipients ?? entry.pending), ...sessionIds])] } : entry) };
}

export function internalAlertRequestId(key: string, claimAt: number, sessionId: string): string {
  // Hash metadata only, never message content. No truncation/sanitization collisions.
  return `alert-internal-${createHash('sha256').update(JSON.stringify([key, claimAt, sessionId])).digest('hex')}`;
}

export function serializeAlertThrottle(store: AlertThrottleStore, now: number): string {
  const unresolved = store.sent.filter(unresolvedInternalReceipt);
  // An already over-capacity/corrupt store must also fail without truncating it.
  if (unresolved.length > MAX_UNRESOLVED_INTERNAL_RECEIPTS) throw new InternalReceiptCapacityError();
  // A just-acknowledged row was stored among the protected rows. Its prior array
  // position must not evict it behind older ordinary history when protection ends.
  const ordinary = store.sent.filter((entry) => !unresolvedInternalReceipt(entry) && now - entry.at < THROTTLE_RETAIN_MS)
    .sort((a, b) => a.at - b.at).slice(-MAX_THROTTLE_ENTRIES);
  const sent = [...unresolved, ...ordinary];
  return JSON.stringify({ version: STORE_VERSION, sent });
}

export { parseAlertThrottle } from './alert-remediation/throttle-records';

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

// Deliver to the holder's endpoint; when the session's process was replaced between listing
// and sending (`stale_identity`, or `endpoint_unavailable` for a resume under a new pid) the
// endpoint is re-resolved by session id once and retried. Returns null on success, else the
// failure reason.
export async function deliverWithStaleRetry(
  endpoint: OriginalOmpEndpoint,
  deliver: (endpoint: OriginalOmpEndpoint) => Promise<unknown>,
  relist: () => Promise<OriginalOmpEndpoint | null>,
): Promise<string | null> {
  const reason = (err: unknown): string => String((err as { code?: string }).code ?? err);
  try {
    await deliver(endpoint);
    return null;
  } catch (err) {
    const why = reason(err);
    if (why !== 'stale_identity' && why !== 'endpoint_unavailable') return why;
  }
  const fresh = await relist().catch(() => null);
  if (!fresh) return 'endpoint_unavailable';
  try {
    await deliver(fresh);
    return null;
  } catch (err) {
    return reason(err);
  }
}

// --- holder rendering (tg-cli#747) ---

// One omp-live request id per holder note/alert. The host rejects a reused id with other
// text (request_id_conflict), and two deliveries to one holder can start in the same
// millisecond (two monitors, or a note and an alert), so the caller's `nonce` (random per
// delivery) keeps them distinct. Bounded (≤ 256) and sanitized like alertRequestId.
export function holderRequestId(source: string, sessionId: string, now: number, nonce: string): string {
  const safe = (v: string, max: number): string => v.replace(/[^A-Za-z0-9:_.-]/g, '_').slice(0, max);
  return `alert-holder-${safe(source, 64)}-${safe(sessionId, 120)}-${now}-${safe(nonce, 32)}`;
}

// The throttle key of a holder send names the holder's session: a send that raced a handoff
// and reached the previous holder never throttles the new holder's first delivery.
export function holderThrottleKey(holderSessionId: string, source: string, key: string, severity: AlertSeverity): string {
  return `holder:${holderSessionId}:${throttleKey(source, key, severity)}`;
}

const who = (h: { title: string | null; pid: number | null; sessionId: string }): string => `${h.title ?? '(untitled)'} · pid ${h.pid ?? '?'} · session ${h.sessionId}`;

// What a refused claimant sees: who holds the slot and how to ask for it.
export function holderRefusal(source: string, holder: AlertHolder, state: HolderState, now: number): string {
  return [
    `held by ${who(holder)} · since ${formatAge(now - holder.since)} · ${state}`,
    `ask: tg-ctl alert handoff-request --source ${source} --reason '<why>'`,
  ].join('\n');
}

// The note a holder receives when another session asks for its slot. The commands name the
// holder by --session so they work from a tmux shell too.
export function handoffRequestNote(source: string, holder: AlertHolder, request: HandoffRequest): string {
  return [
    `[alert-holder ${source}] ${who(request)} asks for the ${source} alert slot you hold: ${request.reason ?? '(no reason given)'}`,
    `grant: tg-ctl alert handoff --source ${source} --to ${request.sessionId} --session ${holder.sessionId}`,
    `deny:  tg-ctl alert handoff --source ${source} --deny --reason '…' --session ${holder.sessionId}`,
    `Leaving it unanswered for 10 minutes lets it take the slot.`,
  ].join('\n');
}

export function handoffDeniedNote(source: string, holder: AlertHolder, reason: string | null): string {
  return `[alert-holder ${source}] ${who(holder)} denied your request for the ${source} alert slot: ${reason ?? '(no reason given)'}`;
}

export function handoffGrantedNote(source: string, from: AlertHolder): string {
  return `[alert-holder ${source}] you now hold the ${source} alerts (handed over by ${who(from)}); release with: tg-ctl alert release --source ${source}`;
}

export function holderTakenNote(source: string, taker: AlertHolder): string {
  return `[alert-holder ${source}] the ${source} alert slot was taken by ${who(taker)}; you no longer receive its alerts`;
}


// The copy a `send --to-holder` delivers: no Telegram id exists, so no `tg#` reference.
export function holderAlertText(msg: AlertMessage): string {
  const text = msg.html ? decodeHtmlEntities(stripHtmlTags(msg.text)) : msg.text;
  return `[alert ${msg.source} · ${msg.severity} · ${msg.key}] ${text}`;
}

export type InternalAlertOwnerStatus = 'withheld' | 'unconfirmed';

export function internalAlertText(msg: AlertMessage, owner: InternalAlertOwnerStatus): string {
  const status = owner === 'withheld'
    ? 'Owner problem report withheld: the incident does not yet describe actual attempts/results and current remediation.'
    : 'Owner delivery is unconfirmed: the owner post failed or returned no usable receipt.';
  return `${holderAlertText(msg)}\n\n${status}\nInvestigate within your authority. A problem report must describe actual actions already taken and observed results, plus the concrete remediation being attempted now. If blocked, state the exact dependency and the verification to run when it clears. Receipt of this incident does not mean remediation has started.`;
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
// The `tg-ctl alert …` grammar lives in alert-remediation/alert-argv.ts.
export { parseAlertArgv, parseDurationMs } from './alert-remediation/alert-argv';
export type { AlertCommand } from './alert-remediation/alert-argv';
