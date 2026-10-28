// Routes and history of messages SENT FROM another machine (docs/specs/2026-10-28-remote-ctl-server.md
// §4.1, §5 "Apply"). PURE: the daemon feeds plain strings/objects in and persists what comes out.
//
// The store `tg-ctl.<bot>.remote-routes.json` is deliberately NOT routes.json: pane ids, pids and
// provisional session keys are machine-local, so a remote locator that sat next to a local one could
// be matched against it (the `%3`-on-both-machines hazard this whole feature exists to rule out).
// Nothing here knows how to compare a remote locator with a local one; a remote route is only ever
// looked up by its Telegram message id and then handed back to the machine that sent it.
//
// `machine` is ALWAYS the authenticated peer the daemon was told about by its own config, never a
// field of the payload: a record that names another machine is rejected, not re-attributed.

import type { HistoryRecord } from '../replies/history';
import { isRecord } from './guards';
import { withRoutesLock, type RoutesLockIo } from './routes';

/** Newest routes kept; recency is all recognition needs (same bound as routes.json). */
export const MAX_REMOTE_ROUTES = 300;
export const MAX_REMOTE_IDS = 100;
export const MAX_REMOTE_TEXT_BYTES = 256 << 10;

/** The machine-name shape every layer shares (config, peer, stored rows, history rows). */
export const MACHINE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CHAT_RE = /^-?[0-9]{1,19}$/;
const MAX_SAFE = 2 ** 53;
const MAX_PID = 2 ** 31;

export interface RemoteRouteBody {
  paneId: string | null;
  cwd?: string;
  agentPid?: number;
  serverPid?: number;
  panePid?: number;
  sessionKey?: string;
  parentPaneId?: string;
}

export interface RemoteName {
  primary: string;
  secondary: string | null;
}

export interface RemoteRouteEntry {
  machine: string;
  chat: string;
  id: number;
  route: RemoteRouteBody;
  name: RemoteName;
  /** The sender's clock, unix milliseconds, as recorded. */
  ts: number;
}

export interface RemoteRecord {
  chat: string;
  ids: { id: number; threadId: number | null }[];
  route: RemoteRouteBody;
  history: { text: string; targetAgent?: string; groupToken?: string; truncated: boolean };
  name: RemoteName;
  ts: number;
}

type Fail = { ok: false; error: string };
export type RemoteRecordParse = { ok: true; record: RemoteRecord } | Fail;

const fail = (where: string, why: string): Fail => ({ ok: false, error: `${where}: ${why}` });

// Keys the Python server leaves on the request it relays (`v`, `op`, `machine`); they carry no data
// of their own and are validated, never stored. Anything else outside the schema is rejected.
const HEAD_KEYS = ['v', 'op', 'machine'];
const RECORD_KEYS = ['chat', 'ids', 'route', 'history', 'name', 'ts'];

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f]/;

// The limit counts code points, like the Python endpoint that validated the same record first (`_label`):
// 200 emoji are 200 characters, not 400 UTF-16 units, and must not be rejected here.
function label(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || CONTROL.test(value)) return false;
  return value.length <= limit || [...value].length <= limit;
}

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function parseHead(obj: Record<string, unknown>, peer: string): Fail | null {
  if ('v' in obj && obj.v !== 1) return fail('v', 'protocol version 1 only');
  if ('op' in obj && obj.op !== 'record') return fail('op', 'must be record');
  // The authenticated peer is the only machine there is: a payload that disagrees is a spoof.
  if ('machine' in obj && obj.machine !== peer) return fail('machine', 'payload machine is not the authenticated peer');
  return null;
}

type PidKey = 'agentPid' | 'serverPid' | 'panePid';

function optionalPid(obj: Record<string, unknown>, key: PidKey, out: RemoteRouteBody): Fail | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!intIn(value, 0, MAX_PID)) return fail(`route.${key}`, 'must be a pid');
  if (value > 0) out[key] = value;
  return null;
}

type LabelKey = 'cwd' | 'sessionKey' | 'parentPaneId';

function optionalLabel(obj: Record<string, unknown>, key: LabelKey, limit: number, out: RemoteRouteBody): Fail | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!label(value, limit)) return fail(`route.${key}`, `must be a single-line string of 1..${limit} characters`);
  out[key] = value;
  return null;
}

/** Closed schema of a route body: strict types and sizes, absent/null fields are omitted. */
export function parseRemoteRouteBody(value: unknown): { ok: true; route: RemoteRouteBody } | Fail {
  if (!isRecord(value)) return fail('route', 'must be an object');
  const extra = unknownKey(value, ['paneId', 'cwd', 'agentPid', 'serverPid', 'panePid', 'sessionKey', 'parentPaneId']);
  if (extra !== undefined) return fail('route', `unknown field ${extra.slice(0, 40)}`);
  const paneId = value.paneId ?? null;
  if (paneId !== null && !label(paneId, 64)) return fail('route.paneId', 'must be null or a single-line string of 1..64 characters');
  const route: RemoteRouteBody = { paneId };
  const errors = [
    optionalLabel(value, 'cwd', 4096, route),
    optionalLabel(value, 'sessionKey', 512, route),
    optionalLabel(value, 'parentPaneId', 64, route),
    optionalPid(value, 'agentPid', route),
    optionalPid(value, 'serverPid', route),
    optionalPid(value, 'panePid', route),
  ];
  return errors.find((e): e is Fail => e !== null) ?? { ok: true, route };
}

function parseIdEntry(entry: unknown): { ok: true; id: number; threadId: number | null } | Fail {
  if (!isRecord(entry) || unknownKey(entry, ['id', 'threadId']) !== undefined) return fail('ids', 'entries are {id, threadId?}');
  const { id } = entry;
  if (!intIn(id, 1, MAX_SAFE)) return fail('ids', 'id must be a positive message id');
  const thread = entry.threadId ?? null;
  if (thread !== null && !intIn(thread, 0, MAX_SAFE)) return fail('ids', 'threadId must be null or a topic id');
  // 0 is how a General post may be spelled; the history reader's "no thread" is null.
  return { ok: true, id, threadId: thread === 0 ? null : thread };
}

function parseIds(value: unknown): { ok: true; ids: RemoteRecord['ids'] } | Fail {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REMOTE_IDS) return fail('ids', `must be a list of 1..${MAX_REMOTE_IDS} entries`);
  const seen = new Set<number>();
  const ids: RemoteRecord['ids'] = [];
  for (const entry of value) {
    const parsed = parseIdEntry(entry);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.id)) return fail('ids', 'duplicate id');
    seen.add(parsed.id);
    ids.push({ id: parsed.id, threadId: parsed.threadId });
  }
  return { ok: true, ids };
}

function parseHistoryBody(value: unknown): { ok: true; history: RemoteRecord['history'] } | Fail {
  if (!isRecord(value)) return fail('history', 'must be an object');
  const extra = unknownKey(value, ['text', 'targetAgent', 'groupToken', 'truncated']);
  if (extra !== undefined) return fail('history', `unknown field ${extra.slice(0, 40)}`);
  const { text, targetAgent, groupToken } = value;
  if (typeof text !== 'string') return fail('history.text', 'must be a string');
  if (text.includes('\u0000')) return fail('history.text', 'must not contain NUL');
  if (Buffer.byteLength(text, 'utf8') > MAX_REMOTE_TEXT_BYTES) return fail('history.text', `exceeds ${MAX_REMOTE_TEXT_BYTES} bytes`);
  if (targetAgent !== undefined && !label(targetAgent, 256)) return fail('history.targetAgent', 'must be a single-line string of 1..256 characters');
  if (groupToken !== undefined && !label(groupToken, 256)) return fail('history.groupToken', 'must be a single-line string of 1..256 characters');
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') return fail('history.truncated', 'must be a boolean');
  return {
    ok: true,
    history: {
      text,
      ...(targetAgent !== undefined ? { targetAgent } : {}),
      ...(groupToken !== undefined ? { groupToken } : {}),
      truncated: value.truncated === true,
    },
  };
}

function parseName(value: unknown): { ok: true; name: RemoteName } | Fail {
  if (!isRecord(value) || unknownKey(value, ['primary', 'secondary']) !== undefined) return fail('name', 'must be {primary, secondary?}');
  if (!label(value.primary, 256)) return fail('name.primary', 'must be a single-line string of 1..256 characters');
  const secondary = value.secondary ?? null;
  if (secondary !== null && !label(secondary, 256)) return fail('name.secondary', 'must be null or a single-line string of 1..256 characters');
  return { ok: true, name: { primary: value.primary, secondary } };
}

/**
 * Validate one record body against the closed schema. `peer`: the machine the daemon's own
 * configuration says is on the other end of the socket line; a payload that names any other machine
 * is refused.
 */
export function parseRemoteRecord(raw: unknown, peer: string): RemoteRecordParse {
  if (!MACHINE_RE.test(peer)) return fail('peer', 'not a machine name');
  if (!isRecord(raw)) return fail('record', 'must be an object');
  const extra = unknownKey(raw, [...HEAD_KEYS, ...RECORD_KEYS]);
  if (extra !== undefined) return fail('record', `unknown field ${extra.slice(0, 40)}`);
  const head = parseHead(raw, peer);
  if (head) return head;
  if (typeof raw.chat !== 'string' || !CHAT_RE.test(raw.chat) || !Number.isSafeInteger(Number(raw.chat))) return fail('chat', 'must be a decimal chat id string');
  if (!intIn(raw.ts, 0, MAX_SAFE)) return fail('ts', 'must be unix milliseconds');
  const ids = parseIds(raw.ids);
  if (!ids.ok) return ids;
  const route = parseRemoteRouteBody(raw.route);
  if (!route.ok) return route;
  const history = parseHistoryBody(raw.history);
  if (!history.ok) return history;
  const name = parseName(raw.name);
  if (!name.ok) return name;
  return { ok: true, record: { chat: raw.chat, ids: ids.ids, route: route.route, history: history.history, name: name.name, ts: raw.ts } };
}

/** Stored entries back from disk; a torn or foreign row is dropped, never trusted. */
export function parseRemoteRoutes(raw: string | null): RemoteRouteEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RemoteRouteEntry[] = [];
  for (const row of parsed) {
    if (!isRecord(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) continue;
    if (typeof row.chat !== 'string' || !CHAT_RE.test(row.chat) || !intIn(row.id, 1, MAX_SAFE) || !intIn(row.ts, 0, MAX_SAFE)) continue;
    const route = parseRemoteRouteBody(row.route);
    const name = parseName(row.name);
    if (!route.ok || !name.ok) continue;
    out.push({ machine: row.machine, chat: row.chat, id: row.id, route: route.route, name: name.name, ts: row.ts });
  }
  return out;
}

// `(chat, id)` already recorded for ANOTHER machine is a failure: a message id has one sender, and a
// peer must never overwrite what a different peer recorded.
export type UpsertResult = { ok: true; store: RemoteRouteEntry[]; applied: boolean } | Fail;

/**
 * Record `record` for `machine`. Idempotent on `(chat, id)`: a replay changes nothing and reports
 * `applied:false`; a record whose ids are partly new stores the new ones.
 */
export function upsertRemoteRecord(store: RemoteRouteEntry[], record: RemoteRecord, machine: string): UpsertResult {
  const owners = new Map(store.map((e) => [`${e.chat}:${e.id}`, e.machine]));
  const fresh: RemoteRouteEntry[] = [];
  for (const { id } of record.ids) {
    const owner = owners.get(`${record.chat}:${id}`);
    if (owner === undefined) fresh.push({ machine, chat: record.chat, id, route: record.route, name: record.name, ts: record.ts });
    else if (owner !== machine) return { ok: false, error: `message ${id} is already recorded for another machine` };
  }
  if (fresh.length === 0) return { ok: true, store, applied: false };
  const next = [...store, ...fresh];
  return { ok: true, store: next.length > MAX_REMOTE_ROUTES ? next.slice(next.length - MAX_REMOTE_ROUTES) : next, applied: true };
}

/** The route of the remote message `replyTo` in `chatId`, or null. The newest entry wins. */
export function recognizeRemoteRoute(store: RemoteRouteEntry[], chatId: number | string, replyTo: number): RemoteRouteEntry | null {
  const chat = String(chatId);
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].id === replyTo && store[i].chat === chat) return store[i];
  }
  return null;
}

/** The pane column of a remote message's rows: `<machine>/<pane>`, else its session key, so a remote `%3` never equals a local one. */
export function remotePaneLabel(machine: string, route: RemoteRouteBody): string {
  return `${machine}/${route.paneId ?? route.sessionKey ?? '-'}`;
}

/**
 * The history rows of a record: one per message id (a >4096 split shares the whole text, exactly as
 * `tg` writes its own), namespaced under `machine`.
 */
export function remoteHistoryRows(record: RemoteRecord, machine: string): HistoryRecord[] {
  const { route, history, name } = record;
  const pane = remotePaneLabel(machine, route);
  const named = history.targetAgent ?? name.primary;
  const targetAgent = named.startsWith(`${machine}/`) ? named : `${machine}/${named}`;
  const groupId = record.ids.length > 1 && history.groupToken ? history.groupToken : undefined;
  return record.ids.map(({ id, threadId }) => ({
    ts: Math.floor(record.ts / 1000),
    message_id: id,
    chat_id: Number(record.chat),
    direction: 'agent',
    from: 'agent',
    text: history.text,
    pane,
    ...(groupId !== undefined ? { groupId } : {}),
    targetAgent,
    ...(route.sessionKey ? { sessionKey: `${machine}/${route.sessionKey}` } : {}),
    threadId,
    machine,
  }));
}

/** Rows not yet stored, deduped on (chat, message, agent) so a replayed record never doubles a group. */
export function newHistoryRows(rows: HistoryRecord[], existing: HistoryRecord[]): HistoryRecord[] {
  const have = new Set(existing.filter((r) => r.machine !== undefined).map((r) => `${r.chat_id}:${r.message_id}:${r.targetAgent}`));
  return rows.filter((r) => !have.has(`${r.chat_id}:${r.message_id}:${r.targetAgent}`));
}

/** File effects, injected: the same O_EXCL lock protocol routes.json uses, supplied by the daemon. */
export interface RemoteStoreIo {
  read: () => string | null;
  write: (content: string) => void;
  lock: RoutesLockIo;
}

// `busy`: the store lock stayed contended (retry later), as opposed to a record the store refuses.
export type ApplyResult = { ok: true; applied: boolean; routes: number } | (Fail & { busy?: true });

/** Locked read-modify-write of the store; a write happens only when something changed. */
export function applyRemoteRoutes(io: RemoteStoreIo, record: RemoteRecord, machine: string): ApplyResult {
  const result = withRoutesLock(
    io.lock,
    (): ApplyResult => {
      const upsert = upsertRemoteRecord(parseRemoteRoutes(io.read()), record, machine);
      if (!upsert.ok) return upsert;
      if (upsert.applied) io.write(JSON.stringify(upsert.store));
      return { ok: true, applied: upsert.applied, routes: upsert.store.length };
    },
    { attempts: 100, delayMs: 10, onContended: 'skip' },
  );
  return result ?? { ok: false, error: 'remote-routes store is busy', busy: true };
}
