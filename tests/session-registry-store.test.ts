import { expect, test } from 'bun:test';
import { appendRoute, LEGACY_ROUTE_TTL_SEC, parseRoutes } from '../features/tg-ctl/routes';
import { parseRegistrations } from '../features/tg-ctl/registration-store';
import { parseLastUserTarget } from '../features/tg-ctl/last-user-target';
import {
  callerSessionKey,
  parseRegistry,
  rekeyStores,
  resolveLocatorToSession,
  runMigration,
  serializeRegistry,
  type MigrationIo,
  type MigrationStore,
} from '../features/tg-ctl/session-registry-store';
import { emptyRegistry, reconcile, type LiveSession, type Registry } from '../features/tg-ctl/session-registry';

// sessions.json persistence and the one-shot migration of pane/pid-keyed stores
// (spec §2.4, tg-cli#487).

const NOW = Date.parse('2026-09-30T10:00:00.000Z');
const NOW_SEC = Math.floor(NOW / 1000);
const SID = '01a0c543-1ac1-7433-903d-e98726bfda37';

function live(over: Partial<LiveSession>): LiveSession {
  return {
    harness: 'omp',
    sessionId: SID,
    sessionFile: null,
    pid: 100,
    tmux: { serverPid: 7, paneId: '%0', panePid: 50 },
    durableSession: null,
    windowName: 'gc',
    paneTitle: null,
    harnessTitle: null,
    cwd: '/w/gc',
    ...over,
  };
}

// Live registry: omp in %0 (/w/gc), a provisional cc in %3 (/w/rig), a headless omp pid 600 (/w/h).
const REGISTRY: Registry = reconcile(
  emptyRegistry(),
  [
    live({}),
    live({ harness: 'cc', sessionId: null, pid: 200, tmux: { serverPid: 7, paneId: '%3', panePid: 60 }, cwd: '/w/rig' }),
    live({ sessionId: 'headless', pid: 600, tmux: null, cwd: '/w/h' }),
  ],
  NOW,
).next;

class MemIo implements MigrationIo {
  files: Partial<Record<MigrationStore, string>>;
  contended = new Set<MigrationStore>();
  constructor(files: Partial<Record<MigrationStore, string>>) {
    this.files = { ...files };
  }
  read(store: MigrationStore): string | null {
    return this.files[store] ?? null;
  }
  write(store: MigrationStore, content: string | null): void {
    if (content === null) delete this.files[store];
    else this.files[store] = content;
  }
  locked(store: MigrationStore, body: () => void): boolean {
    if (this.contended.has(store)) return false;
    body();
    return true;
  }
}

// Today's store shapes, as the live config dir holds them.
const FIXTURE: Partial<Record<MigrationStore, string>> = {
  routes: JSON.stringify([
    { id: 1, paneId: '%0', cwd: '/w/gc', ts: 10 },
    { id: 2, paneId: '%3', cwd: '/w/rig', ts: 11 },
    { id: 3, paneId: '%0', cwd: '/w/other', ts: 12 }, // pane reused by another project
    { id: 4, paneId: '%8', cwd: '/w/gone', ts: 13 }, // pane gone
    { id: 5, paneId: 'omp:600', cwd: '/w/h', ts: 14 }, // out-of-tmux omp origin
  ]),
  registration: JSON.stringify([
    { paneId: '%0', cwd: '/w/gc', registeredAt: 1 },
    { paneId: '%8', cwd: '/w/gone', registeredAt: 2 }, // dead pane
    { paneId: '%5', cwd: '/w/pi', registeredAt: 3 }, // live pane with a non-registry harness (pi)
    { cwd: '/w/fallback', registeredAt: 4 }, // paneless fallback slot
  ]),
  lastUserTarget: JSON.stringify({ paneId: '%3', cwd: '/w/rig', ts: 5 }),
  topics: JSON.stringify([
    { threadId: 70, name: 'gc', status: 'bound', paneId: '%0', ts: 1 },
    { threadId: 71, name: 'x', status: 'bound', paneId: '%8', ts: 1 },
    { threadId: 72, name: 'y', status: 'closed', ts: 1 },
  ]),
};
const LIVE_PANES = new Set(['%0', '%3', '%5']);

test('sessions.json round-trips byte-identically and orders entries by key', () => {
  const text = serializeRegistry(REGISTRY);
  expect(serializeRegistry(parseRegistry(text))).toBe(text);
  expect(parseRegistry(text).sessions.map((s) => s.key)).toEqual(['cc:pane:7/%3/60', `omp:${SID}`, 'omp:headless']);
});

test('an unreadable or foreign sessions.json degrades to an empty registry; a malformed entry is dropped', () => {
  expect(parseRegistry(null)).toEqual(emptyRegistry());
  expect(parseRegistry('{nope')).toEqual(emptyRegistry());
  expect(parseRegistry('[]')).toEqual(emptyRegistry());
  const text = JSON.parse(serializeRegistry(REGISTRY));
  text.sessions.push({ key: 'omp:x' });
  expect(parseRegistry(JSON.stringify(text)).sessions).toHaveLength(3);
});

test('a pane or omp:<pid> locator resolves only to exactly one live entry whose cwd matches', () => {
  expect(resolveLocatorToSession(REGISTRY, '%0', '/w/gc')).toBe(`omp:${SID}`);
  expect(resolveLocatorToSession(REGISTRY, '%0', '/w/other')).toBeNull();
  expect(resolveLocatorToSession(REGISTRY, '%0', undefined)).toBe(`omp:${SID}`);
  expect(resolveLocatorToSession(REGISTRY, 'omp:600', '/w/h')).toBe('omp:headless');
  expect(resolveLocatorToSession(REGISTRY, '%8', '/w/gone')).toBeNull();
  const gone = reconcile(REGISTRY, [], NOW + 1000).next;
  expect(resolveLocatorToSession(gone, '%0', '/w/gc')).toBeNull();
});

// tg-cli#460: `tg` stamps its history rows and scopes `tg replies` with the key of
// the session it runs under — found by its agent process first (exact), else by
// its pane / `omp:<pid>` origin (spec §3.3, until S6's resolve-session).
test('a tg caller resolves to its live session by agent pid first, then by its locator', () => {
  expect(callerSessionKey(REGISTRY, { agentPid: 600, locator: 'omp:600' })).toBe('omp:headless');
  expect(callerSessionKey(REGISTRY, { agentPid: 100, locator: '%9' })).toBe(`omp:${SID}`);
  expect(callerSessionKey(REGISTRY, { agentPid: null, locator: '%0' })).toBe(`omp:${SID}`);
  expect(callerSessionKey(REGISTRY, { agentPid: 999, locator: '%8' })).toBeNull();
  expect(callerSessionKey(REGISTRY, { agentPid: null, locator: null })).toBeNull();
  const gone = reconcile(REGISTRY, [], NOW + 1000).next;
  expect(callerSessionKey(gone, { agentPid: 100, locator: '%0' })).toBeNull();
});

test('routes: resolvable rows gain their sessionKey (paneId kept as a hint); the rest become legacy', () => {
  const io = new MemIo(FIXTURE);
  runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  const routes = parseRoutes(io.files.routes!);
  expect(routes).toEqual([
    { id: 1, paneId: '%0', cwd: '/w/gc', ts: 10, sessionKey: `omp:${SID}` },
    { id: 2, paneId: '%3', cwd: '/w/rig', ts: 11, sessionKey: 'cc:pane:7/%3/60' },
    { id: 3, paneId: '%0', cwd: '/w/other', ts: 12, legacySince: NOW_SEC },
    { id: 4, paneId: '%8', cwd: '/w/gone', ts: 13, legacySince: NOW_SEC },
    { id: 5, paneId: 'omp:600', cwd: '/w/h', ts: 14, sessionKey: 'omp:headless' },
  ]);
});

// A rig-wrapper host (`host:<name>`, docs/specs/2026-09-30-harness-agnostic-control.md §4) is not
// a registry session yet (#536), so the migration cannot resolve its route — but the session is
// alive. Marking the row legacy turned every reply to it into "that agent is no longer running".
test('routes: a host:<name> row the registry does not track is left as is, never legacy', () => {
  const io = new MemIo({ routes: JSON.stringify([{ id: 6, paneId: 'host:claude-3f9a0c1d2e4b', cwd: '/w/landing', ts: 15 }]) });
  runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(parseRoutes(io.files.routes!)).toEqual([{ id: 6, paneId: 'host:claude-3f9a0c1d2e4b', cwd: '/w/landing', ts: 15 }]);
});

test('routes: a legacy row is dropped 7 days after migration, on the next send', () => {
  const rows = [
    { id: 3, paneId: '%0', ts: 12, legacySince: NOW_SEC },
    { id: 1, paneId: '%0', ts: 10, sessionKey: 'omp:a' },
  ];
  const fresh = { id: 9, paneId: '%0', ts: NOW_SEC + LEGACY_ROUTE_TTL_SEC - 1 };
  expect(appendRoute(rows, fresh).map((r) => r.id)).toEqual([3, 1, 9]);
  const later = { id: 9, paneId: '%0', ts: NOW_SEC + LEGACY_ROUTE_TTL_SEC };
  expect(appendRoute(rows, later).map((r) => r.id)).toEqual([1, 9]);
});

test('registration: resolvable rows gain their sessionKey; dead-pane rows are dropped; live non-registry panes and the paneless slot stay', () => {
  const io = new MemIo(FIXTURE);
  const { log } = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(parseRegistrations(io.files.registration!)).toEqual([
    { paneId: '%0', cwd: '/w/gc', registeredAt: 1, sessionKey: `omp:${SID}` },
    { paneId: '%5', cwd: '/w/pi', registeredAt: 3 },
    { cwd: '/w/fallback', registeredAt: 4 },
  ]);
  expect(log).toContain('migrated registration 1/4 (1 dropped)');
});

test('last-user-target: resolved gains its sessionKey; an unresolved hint is dropped', () => {
  const io = new MemIo(FIXTURE);
  runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(parseLastUserTarget(io.files.lastUserTarget!)).toEqual({ paneId: '%3', cwd: '/w/rig', ts: 5, sessionKey: 'cc:pane:7/%3/60' });
  const stale = new MemIo({ lastUserTarget: JSON.stringify({ paneId: '%8', cwd: '/w/gone', ts: 5 }) });
  runMigration(REGISTRY, stale, { now: NOW, livePaneIds: LIVE_PANES });
  expect(stale.files.lastUserTarget).toBeUndefined();
});

test('last-user-target: an anchor whose pane is still live is kept when only its cwd drifted', () => {
  const raw = JSON.stringify({ paneId: '%0', cwd: '/w/other', ts: 5 });
  const io = new MemIo({ lastUserTarget: raw });
  const { log } = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(io.files.lastUserTarget).toBe(raw);
  expect(log).toContain('migrated lastUserTarget 0/1');
});

test('a key a live writer dropped (or that names no live session) is re-derived on a later scan despite the markers', () => {
  const io = new MemIo(FIXTURE);
  const first = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  // An older `tg start` / delivery rewrote the rows without the key, or kept a dead one.
  io.files.registration = JSON.stringify([
    { paneId: '%0', cwd: '/w/gc', registeredAt: 9 },
    { paneId: '%3', cwd: '/w/rig', registeredAt: 9, sessionKey: 'cc:gone' },
    { paneId: '%5', cwd: '/w/pi', registeredAt: 9 },
  ]);
  io.files.lastUserTarget = JSON.stringify({ paneId: '%3', cwd: '/w/rig', ts: 9 });
  const second = runMigration(first.registry, io, { now: NOW + 60_000, livePaneIds: LIVE_PANES });
  expect(second.registry).toBe(first.registry);
  expect(parseRegistrations(io.files.registration)).toEqual([
    { paneId: '%0', cwd: '/w/gc', registeredAt: 9, sessionKey: `omp:${SID}` },
    { paneId: '%3', cwd: '/w/rig', registeredAt: 9, sessionKey: 'cc:pane:7/%3/60' },
    { paneId: '%5', cwd: '/w/pi', registeredAt: 9 },
  ]);
  expect(parseLastUserTarget(io.files.lastUserTarget)?.sessionKey).toBe('cc:pane:7/%3/60');
});

test('an unkeyed route is stamped on a later scan only from exact origin locators; keyed and legacy rows are never rewritten', () => {
  const io = new MemIo(FIXTURE);
  const first = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  io.files.routes = JSON.stringify([
    { id: 20, paneId: 'omp:600', ts: 20, agentPid: 600 }, // headless omp, by pid
    { id: 21, paneId: '%0', cwd: '/w/gc', ts: 21, serverPid: 7, panePid: 50 }, // exact tmux triple
    { id: 22, paneId: '%0', cwd: '/w/gc', ts: 22, serverPid: 6, panePid: 50 }, // an older tmux server's %0
    { id: 23, paneId: '%0', cwd: '/w/gc', ts: 23 }, // a bare pane id is never proof
    { id: 24, paneId: '%0', ts: 24, agentPid: 100, sessionKey: 'omp:kept' },
    { id: 25, paneId: '%0', ts: 25, agentPid: 100, legacySince: NOW_SEC },
  ]);
  runMigration(first.registry, io, { now: NOW + 60_000, livePaneIds: LIVE_PANES });
  expect(parseRoutes(io.files.routes!).map((r) => [r.id, r.sessionKey ?? null])).toEqual([
    [20, 'omp:headless'],
    [21, `omp:${SID}`],
    [22, null],
    [23, null],
    [24, 'omp:kept'],
    [25, null],
  ]);
});

test('with no tmux server (pane liveness unknown) every store is marked and nothing is dropped', () => {
  const io = new MemIo({ ...FIXTURE, lastUserTarget: JSON.stringify({ paneId: '%8', cwd: '/w/gone', ts: 5 }) });
  const { registry } = runMigration(REGISTRY, io, { now: NOW, livePaneIds: null });
  expect(Object.keys(registry.migrated).sort()).toEqual(['lastUserTarget', 'registration', 'routes', 'topics']);
  expect(parseRegistrations(io.files.registration!).map((r) => r.paneId)).toEqual(['%0', '%8', '%5', undefined]);
  expect(parseLastUserTarget(io.files.lastUserTarget!)?.paneId).toBe('%8');
});

test('topics: a bound topic whose pane resolves becomes that entry\'s threadId; the rest are dropped and logged', () => {
  const io = new MemIo(FIXTURE);
  const { registry, log } = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(registry.sessions.find((s) => s.key === `omp:${SID}`)?.threadId).toBe(70);
  expect(registry.sessions.filter((s) => s.threadId !== null)).toHaveLength(1);
  expect(log).toContain('migrated topics 1/3 (2 dropped)');
});

test('each store migrates once: the markers make a second run a no-op', () => {
  const io = new MemIo(FIXTURE);
  const first = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(Object.keys(first.registry.migrated).sort()).toEqual(['lastUserTarget', 'registration', 'routes', 'topics']);
  const snapshot = { ...io.files };
  const second = runMigration(first.registry, io, { now: NOW + 60_000, livePaneIds: LIVE_PANES });
  expect(second.registry).toBe(first.registry);
  expect(io.files).toEqual(snapshot);
});

test('running the migration twice on a copy of the config dir gives byte-identical output, even without the markers', () => {
  const a = new MemIo(FIXTURE);
  const ra = runMigration(REGISTRY, a, { now: NOW, livePaneIds: LIVE_PANES });
  const once = { ...a.files, sessions: serializeRegistry(ra.registry) };
  // Re-run from scratch on the migrated files (markers lost): nothing changes.
  const b = new MemIo(a.files);
  const rb = runMigration({ ...ra.registry, migrated: {} }, b, { now: NOW + 3_600_000, livePaneIds: LIVE_PANES });
  expect({ ...b.files, sessions: serializeRegistry({ ...rb.registry, migrated: ra.registry.migrated }) }).toEqual(once);
});

test('a store whose writer lock is contended is not marked, so it migrates on a later tick', () => {
  const io = new MemIo(FIXTURE);
  io.contended.add('routes');
  const first = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(first.registry.migrated.routes).toBeUndefined();
  expect(io.files.routes).toBe(FIXTURE.routes!);
  io.contended.clear();
  expect(runMigration(first.registry, io, { now: NOW, livePaneIds: LIVE_PANES }).registry.migrated.routes).toBe(
    '2026-09-30T10:00:00.000Z',
  );
});

test('missing store files still get their marker (nothing to migrate)', () => {
  const io = new MemIo({});
  const { registry } = runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  expect(Object.keys(registry.migrated)).toHaveLength(4);
  expect(io.files).toEqual({});
});

test('promotion rewrites every store reference to the provisional key in the same pass', () => {
  const io = new MemIo(FIXTURE);
  runMigration(REGISTRY, io, { now: NOW, livePaneIds: LIVE_PANES });
  rekeyStores(io, 'cc:pane:7/%3/60', 'cc:cc-1');
  expect(parseRoutes(io.files.routes!).find((r) => r.id === 2)?.sessionKey).toBe('cc:cc-1');
  expect(parseLastUserTarget(io.files.lastUserTarget!)?.sessionKey).toBe('cc:cc-1');
  expect(io.files.routes!.includes('cc:pane:')).toBe(false);
});
