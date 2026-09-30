// sessions.json persistence and the one-shot migration of pane/pid-keyed stores
// onto session keys (docs/specs/session-registry-and-topics.md §2.4, tg-cli#487).
//
// The daemon is the only writer of sessions.json. The migration runs after the
// first trusted scan and, per store, exactly once (a marker in sessions.json):
// resolvable rows gain the `sessionKey` of the live entry their locator resolves
// to, with `paneId` kept as a hint. Later scans only re-derive a key a live writer
// left missing or dead (registration, last-user target) or that `tg` could not
// stamp on a route (routes). The rows stay readable by older parsers.
// deferred.json and questions.json carry the key their daemon stamped at enqueue
// / ask time (S3), and awareness-nudge.json is keyed by session in memory, so
// neither needs a rewrite here.
//
// PURE — reads, writes and writer locks are injected (MigrationIo).

import { parseLastUserTarget, serializeLastUserTarget } from './last-user-target';
import { resolveRouteSession } from './session-target';
import { parseRegistrations, serializeRegistrations } from './registration-store';
import { parseRoutes, serializeRoutes } from './routes';
import type { MigrationMarkers, Registry, SessionEntry, SessionKey } from './session-registry';
import { emptyRegistry, isProvisionalKey } from './session-registry';
import { parseTopics } from './topics';

export type MigrationStore = keyof MigrationMarkers;
const STORES: MigrationStore[] = ['routes', 'registration', 'lastUserTarget', 'topics'];

export function serializeRegistry(reg: Registry): string {
  const sessions = [...reg.sessions].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return `${JSON.stringify({ schemaVersion: 2, migrated: reg.migrated, sessions }, null, 2)}\n`;
}

// The on-disk shape before validation: every field present-or-not, of unknown type.
type Wire<T> = { [K in keyof T]?: unknown };

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseTmux(raw: unknown): SessionEntry['locators']['tmux'] {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Wire<NonNullable<SessionEntry['locators']['tmux']>>;
  const serverPid = num(v.serverPid);
  const panePid = num(v.panePid);
  const paneId = str(v.paneId);
  return serverPid === null || panePid === null || paneId === null ? null : { serverPid, paneId, panePid };
}

function parseEntry(raw: unknown): SessionEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Wire<SessionEntry>;
  const key = str(v.key);
  const harness = v.harness === 'omp' || v.harness === 'cc' || v.harness === 'codex' ? v.harness : null;
  const firstSeen = str(v.firstSeen);
  const lastSeen = str(v.lastSeen);
  if (!key || !harness || !key.startsWith(`${harness}:`) || !firstSeen || !lastSeen) return null;
  if (v.state !== 'live' && v.state !== 'gone') return null;
  if (typeof v.locators !== 'object' || v.locators === null || typeof v.name !== 'object' || v.name === null) return null;
  const locators = v.locators as Wire<SessionEntry['locators']>;
  const name = v.name as Wire<SessionEntry['name']>;
  const misses = typeof v.topicMisses === 'object' && v.topicMisses !== null ? (v.topicMisses as Wire<NonNullable<SessionEntry['topicMisses']>>) : null;
  const missCount = num(misses?.count);
  const missAt = str(misses?.firstAt);
  return {
    key: key as SessionKey,
    harness,
    sessionId: str(v.sessionId),
    sessionFile: str(v.sessionFile),
    locators: { pid: num(locators.pid), tmux: parseTmux(locators.tmux), durableSession: str(locators.durableSession) },
    cwd: str(v.cwd) ?? '',
    name: { primary: str(name.primary) ?? '', secondary: str(name.secondary) },
    aliases: Array.isArray(v.aliases) ? v.aliases.filter((a): a is string => typeof a === 'string') : [],
    threadId: num(v.threadId),
    topicMisses: missCount !== null && missAt !== null ? { count: missCount, firstAt: missAt } : null,
    state: v.state,
    firstSeen,
    lastSeen,
  };
}

// Tolerant: an unreadable file is an empty registry and a malformed entry is
// dropped (it is re-added by the next scan if the session is live).
export function parseRegistry(raw: string | null): Registry {
  if (!raw) return emptyRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRegistry();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyRegistry();
  const v = parsed as Wire<Registry>;
  if (v.schemaVersion !== 2 || !Array.isArray(v.sessions)) return emptyRegistry();
  const markers = typeof v.migrated === 'object' && v.migrated !== null ? (v.migrated as Wire<MigrationMarkers>) : {};
  const migrated: MigrationMarkers = {};
  for (const store of STORES) {
    const at = str(markers[store]);
    if (at) migrated[store] = at;
  }
  const sessions = v.sessions.map(parseEntry).filter((e): e is SessionEntry => e !== null);
  sessions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { schemaVersion: 2, migrated, sessions };
}

// A stored locator (`%N` pane or `omp:<pid>` origin) → the key of the ONE live
// entry it resolves to. When the row recorded a cwd it must match: a pane id is
// reused freely, so a pane alone is never proof across projects.
export function resolveLocatorToSession(reg: Registry, paneId: string, cwd: string | undefined): SessionKey | null {
  const ompPid = /^omp:(\d+)$/.exec(paneId);
  const hits = reg.sessions.filter(
    (e) =>
      e.state === 'live' &&
      (ompPid ? e.harness === 'omp' && e.locators.pid === Number(ompPid[1]) : e.locators.tmux?.paneId === paneId),
  );
  if (hits.length !== 1) return null;
  return cwd === undefined || hits[0].cwd === cwd ? hits[0].key : null;
}

export interface MigrationIo {
  read(store: MigrationStore): string | null;
  // null deletes the file.
  write(store: MigrationStore, content: string | null): void;
  // Run `body` under the store's cross-process writer lock; false = contended.
  locked(store: MigrationStore, body: () => void): boolean;
}

interface StoreResult {
  content: string | null;
  log: string;
}

function migrateRoutes(raw: string | null, reg: Registry, nowSec: number): StoreResult {
  const rows = parseRoutes(raw);
  let migrated = 0;
  let legacy = 0;
  const out = rows.map((r) => {
    if (r.sessionKey !== undefined || r.legacySince !== undefined) return r;
    const key = resolveLocatorToSession(reg, r.paneId, r.cwd);
    if (key) {
      migrated++;
      return { ...r, sessionKey: key };
    }
    legacy++;
    return { ...r, legacySince: nowSec };
  });
  return { content: serializeRoutes(out), log: `migrated routes ${migrated}/${rows.length} (${legacy} legacy)` };
}

// A row the scan cannot resolve is dropped only when its pane is known dead
// (`livePaneIds` null = pane liveness unknown: no tmux server answered). A live
// pane running a harness the registry does not track (pi, aider, opencode) keeps
// its row — dropping it would stop that session's question forwarding — and so
// does the paneless fallback slot.
function migrateRegistrations(raw: string | null, reg: Registry, livePaneIds: ReadonlySet<string> | null): StoreResult {
  const rows = parseRegistrations(raw);
  let migrated = 0;
  let dropped = 0;
  const out = rows.flatMap((r) => {
    if (r.sessionKey !== undefined || !r.paneId) return [r];
    const key = resolveLocatorToSession(reg, r.paneId, r.cwd);
    if (key) {
      migrated++;
      return [{ ...r, sessionKey: key }];
    }
    if (livePaneIds === null || livePaneIds.has(r.paneId)) return [r];
    dropped++;
    return [];
  });
  return { content: serializeRegistrations(out), log: `migrated registration ${migrated}/${rows.length} (${dropped} dropped)` };
}

// Same liveness rule as migrateRegistrations: an unresolved anchor (e.g. its pane's
// cwd drifted from the entry's) is dropped only when its pane is known dead.
function migrateLastUserTarget(raw: string | null, reg: Registry, livePaneIds: ReadonlySet<string> | null): StoreResult {
  const target = parseLastUserTarget(raw);
  if (!target) return { content: null, log: 'migrated lastUserTarget 0/0' };
  if (target.sessionKey !== undefined) return { content: serializeLastUserTarget(target), log: 'migrated lastUserTarget 0/1' };
  const key = resolveLocatorToSession(reg, target.paneId, target.cwd);
  if (key) return { content: serializeLastUserTarget({ ...target, sessionKey: key }), log: 'migrated lastUserTarget 1/1' };
  if (livePaneIds === null || livePaneIds.has(target.paneId)) return { content: raw, log: 'migrated lastUserTarget 0/1' };
  return { content: null, log: 'migrated lastUserTarget 0/1 (dropped)' };
}

// The key for a row that has none, or whose key names no live session, when its
// locator now resolves to a live entry; null leaves the row as it is.
function rederivedKey(reg: Registry, paneId: string | undefined, cwd: string | undefined, key: string | undefined): SessionKey | null {
  if (!paneId) return null;
  if (key !== undefined && reg.sessions.some((e) => e.key === key && e.state === 'live')) return null;
  const next = resolveLocatorToSession(reg, paneId, cwd);
  return next !== null && next !== key ? next : null;
}

// After its one-shot migration, a store's live writers (`tg start`, a confirmed
// delivery) may still rewrite a row without its key, or keep a key whose session
// ended while a new one took the pane. Every trusted scan re-derives those keys —
// never dropping a row. A route row is different: its key is the historic truth
// of who sent it, so only a row `tg` could not stamp gains one, and only from its
// exact origin locators (resolveRouteSession) while that session is still live.
// Returns the new content, or null when nothing changed.
function backfillKeys(store: 'routes' | 'registration' | 'lastUserTarget', raw: string | null, reg: Registry): string | null {
  if (raw === null) return null;
  if (store === 'routes') {
    let changed = false;
    const rows = parseRoutes(raw).map((r) => {
      if (r.sessionKey !== undefined || r.legacySince !== undefined) return r;
      const key = resolveRouteSession(reg, r);
      if (key === null) return r;
      changed = true;
      return { ...r, sessionKey: key };
    });
    return changed ? serializeRoutes(rows) : null;
  }
  if (store === 'registration') {
    let changed = false;
    const rows = parseRegistrations(raw).map((r) => {
      const key = rederivedKey(reg, r.paneId, r.cwd, r.sessionKey);
      if (key === null) return r;
      changed = true;
      return { ...r, sessionKey: key };
    });
    return changed ? serializeRegistrations(rows) : null;
  }
  const target = parseLastUserTarget(raw);
  const key = target ? rederivedKey(reg, target.paneId, target.cwd, target.sessionKey) : null;
  return target && key ? serializeLastUserTarget({ ...target, sessionKey: key }) : null;
}

// topics.json (spawn-wizard bindings) → the bound entry's threadId. The file itself
// stays until the wizard that reads it is deleted (S5).
function migrateTopics(raw: string | null, reg: Registry): { registry: Registry; log: string } {
  const rows = parseTopics(raw);
  const threadByKey = new Map<SessionKey, number>();
  for (const t of rows) {
    if (t.status !== 'bound' || !t.paneId) continue;
    const key = resolveLocatorToSession(reg, t.paneId, undefined);
    if (key && !threadByKey.has(key)) threadByKey.set(key, t.threadId);
  }
  const sessions = reg.sessions.map((e) => {
    const threadId = threadByKey.get(e.key);
    return threadId !== undefined && e.threadId === null ? { ...e, threadId } : e;
  });
  const changed = sessions.some((e, i) => e !== reg.sessions[i]);
  return {
    registry: changed ? { ...reg, sessions } : reg,
    log: `migrated topics ${threadByKey.size}/${rows.length}${rows.length > threadByKey.size ? ` (${rows.length - threadByKey.size} dropped)` : ''}`,
  };
}

// Run every not-yet-migrated store's one-shot migration against the registry of
// a trusted scan; already-migrated routes/registration/lastUserTarget stores get
// their missing keys re-derived instead (backfillKeys). A store whose lock is
// contended keeps no marker and is retried by the next call. Returns the same
// registry object when no migration ran.
export function runMigration(
  reg: Registry,
  io: MigrationIo,
  opts: { now: number; livePaneIds: ReadonlySet<string> | null },
): { registry: Registry; log: string[] } {
  const nowIso = new Date(opts.now).toISOString();
  const nowSec = Math.floor(opts.now / 1000);
  let registry = reg;
  const log: string[] = [];
  for (const store of STORES) {
    if (reg.migrated[store] !== undefined) {
      if (store === 'topics') continue;
      // Unlocked peek first: the common case (nothing to re-derive) takes no lock.
      if (backfillKeys(store, io.read(store), registry) === null) continue;
      io.locked(store, () => {
        const content = backfillKeys(store, io.read(store), registry);
        if (content === null) return;
        io.write(store, content);
        log.push(`re-derived ${store} sessionKey`);
      });
      continue;
    }
    const ok = io.locked(store, () => {
      const raw = io.read(store);
      if (store === 'topics') {
        const res = migrateTopics(raw, registry);
        registry = res.registry;
        log.push(res.log);
        return;
      }
      const res =
        store === 'routes'
          ? migrateRoutes(raw, registry, nowSec)
          : store === 'registration'
            ? migrateRegistrations(raw, registry, opts.livePaneIds)
            : migrateLastUserTarget(raw, registry, opts.livePaneIds);
      if (raw !== null && res.content !== raw) io.write(store, res.content);
      log.push(res.log);
    });
    if (ok) registry = { ...registry, migrated: { ...registry.migrated, [store]: nowIso } };
  }
  return { registry, log };
}

function rekeyRows<T extends { sessionKey?: string }>(rows: T[], from: string, to: string): T[] {
  return rows.map((r) => (r.sessionKey === from ? { ...r, sessionKey: to } : r));
}

function rekeyStore(store: Exclude<MigrationStore, 'topics'>, raw: string, from: string, to: string): string {
  if (store === 'routes') return serializeRoutes(rekeyRows(parseRoutes(raw), from, to));
  if (store === 'registration') return serializeRegistrations(rekeyRows(parseRegistrations(raw), from, to));
  const target = parseLastUserTarget(raw);
  return target ? serializeLastUserTarget(rekeyRows([target], from, to)[0]) : raw;
}

// A provisional key promoted in the registry (reconcile's `promoted` event) is
// rewritten in every store row that references it, so no row is left pointing at
// a key that no longer exists.
export function rekeyStores(io: MigrationIo, from: SessionKey, to: SessionKey): string[] {
  if (!isProvisionalKey(from)) return [];
  const log: string[] = [];
  for (const store of STORES) {
    if (store === 'topics') continue;
    io.locked(store, () => {
      const raw = io.read(store);
      if (raw === null || !raw.includes(from)) return;
      io.write(store, rekeyStore(store, raw, from, to));
      log.push(`rekeyed ${store} ${from} → ${to}`);
    });
  }
  return log;
}
