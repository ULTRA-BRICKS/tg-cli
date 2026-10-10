// Session registry core (docs/specs/session-registry-and-topics.md §2.1, §2.3;
// tg-cli#487). One entry per harness session, keyed `<harness>:<sessionId>`.
// A pid, a tmux pane or an abduco name is a LOCATOR, re-resolved on every scan
// and never identity: pids churn on restart/resume and pane ids are reused, which
// is what made pane/pid-keyed routes die (#459) and deliver into the wrong pane
// (#354). PURE — the daemon feeds `reconcile` the adapter's scan
// (harness-sessions.ts) and persists the result (session-registry-store.ts).

import { resolveSessionName } from './session-name';

export type Harness = 'omp' | 'cc' | 'codex';
export type SessionKey = `${Harness}:${string}`;

// A pane counts as the same locator only when all three match: a tmux server
// restart changes `serverPid` (#{pid}) and a respawned pane changes `panePid`,
// while the `%N` pane id itself is reused freely (spec §2.6).
export interface TmuxLocator {
  serverPid: number;
  paneId: string;
  panePid: number;
}

export interface SessionLocators {
  pid: number | null;
  tmux: TmuxLocator | null;
  durableSession: string | null; // abduco session name from `rig harness run`
}

export interface SessionEntry {
  key: SessionKey;
  harness: Harness;
  // The harness session id; null while the key is still provisional (a cc/codex
  // pane seen before its first hook).
  sessionId: string | null;
  sessionFile: string | null;
  locators: SessionLocators;
  cwd: string;
  name: { primary: string; secondary: string | null };
  aliases: string[];
  threadId: number | null;
  topicMisses: { count: number; firstAt: string } | null;
  // ISO time the daemon last recreated this entry's topic (§4.2's at-most-once-per-24h cap,
  // persisted so a daemon restart keeps it, tg-cli#498). Absent: never recreated.
  topicRecreatedAt?: string | null;
  state: 'live' | 'gone';
  firstSeen: string;
  lastSeen: string;
}

// Per-store one-shot migration markers (§2.4): store name → ISO time it was
// migrated. A store's migration never runs twice.
export type MigrationMarkers = Partial<Record<'routes' | 'registration' | 'lastUserTarget' | 'topics', string>>;

export interface Registry {
  schemaVersion: 2;
  migrated: MigrationMarkers;
  sessions: SessionEntry[];
}

// One live session as the harness adapter reports it (spec §2.2).
export interface LiveSession {
  harness: Harness;
  sessionId: string | null;
  sessionFile: string | null;
  pid: number;
  tmux: TmuxLocator | null;
  durableSession: string | null;
  windowName: string | null;
  paneTitle: string | null;
  harnessTitle: string | null;
  cwd: string;
}

export type SessionName = SessionEntry['name'];

export type RegistryEvent =
  | { kind: 'added'; key: SessionKey }
  | { kind: 'relocated'; key: SessionKey }
  | { kind: 'readopted'; key: SessionKey; threadId: number | null }
  | { kind: 'gone'; key: SessionKey }
  | { kind: 'pruned'; key: SessionKey }
  // `droppedThreadId`: the provisional entry's topic, when the promoted-to entry already had its
  // own (a resumed session). The entry keeps its own; the daemon unbinds the dropped one.
  | { kind: 'promoted'; from: SessionKey; to: SessionKey; droppedThreadId?: number }
  | { kind: 'paneReused'; from: SessionKey; to: SessionKey; paneId: string }
  | { kind: 'renamed'; key: SessionKey; from: SessionName; to: SessionName };

// A resolved name that differs from the stored one, and since when it has been
// seen unchanged (spec §3.2). Held in daemon memory only: a restart restarts the
// clock, which at worst delays a rename by one debounce.
export type PendingRenames = ReadonlyMap<SessionKey, { name: SessionName; since: number }>;

// How long a new name must stay stable before it is committed: absorbs omp's
// auto-title on first input and spinner / `π >` churn normalisation misses.
export const RENAME_DEBOUNCE_MS = 20_000;
export const MAX_ALIASES = 5;

export const GONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// lastSeen of an otherwise-unchanged live entry advances at most this often, so a
// 2 s scan does not rewrite sessions.json every tick.
export const LAST_SEEN_RESOLUTION_MS = 60_000;

export function emptyRegistry(): Registry {
  return { schemaVersion: 2, migrated: {}, sessions: [] };
}

export function sessionKey(harness: Harness, sessionId: string): SessionKey {
  return `${harness}:${sessionId}`;
}

// The key of a cc/codex (or id-less omp) pane seen before its session id is known
// (§2.1). Promoted in place once the id arrives.
export function provisionalKey(harness: Harness, tmux: TmuxLocator): SessionKey {
  return `${harness}:pane:${tmux.serverPid}/${tmux.paneId}/${tmux.panePid}`;
}

export function isProvisionalKey(key: string): boolean {
  return /^[a-z]+:pane:/.test(key);
}

export function sameTmuxLocator(a: TmuxLocator | null, b: TmuxLocator | null): boolean {
  if (a === null || b === null) return a === b;
  return a.serverPid === b.serverPid && a.paneId === b.paneId && a.panePid === b.panePid;
}

function sameLocators(a: SessionLocators, b: SessionLocators): boolean {
  return a.pid === b.pid && a.durableSession === b.durableSession && sameTmuxLocator(a.tmux, b.tmux);
}

function nameOf(s: LiveSession): SessionEntry['name'] {
  const short = s.sessionId ? s.sessionId.replace(/-/g, '').slice(0, 8) : String(s.pid);
  return resolveSessionName({
    tmuxWindow: s.tmux ? s.windowName ?? '' : null,
    cwd: s.cwd,
    harnessTitle: s.harnessTitle,
    paneTitle: s.paneTitle,
    fallback: `${s.harness} · ${short}`,
  });
}

// Which existing entry (if any) this sighting is, and under which key.
function resolveKey(s: LiveSession, entries: Map<SessionKey, SessionEntry>): SessionKey | null {
  const all = [...entries.values()].filter((e) => e.harness === s.harness);
  if (s.sessionId) {
    const key = sessionKey(s.harness, s.sessionId);
    if (entries.has(key)) return key;
    // omp-telegram's sameSession: the same session file is the same session.
    const byFile = s.sessionFile ? all.find((e) => e.sessionFile === s.sessionFile) : undefined;
    return byFile ? byFile.key : key;
  }
  // No id this scan (hook not seen yet, or an lsof flake): the entry whose process
  // this exactly is — same pid in the same pane (or both out of tmux).
  const byPid = all.find((e) => e.locators.pid === s.pid && sameTmuxLocator(e.locators.tmux, s.tmux));
  if (byPid) return byPid.key;
  return s.tmux ? provisionalKey(s.harness, s.tmux) : null;
}

function sameName(a: SessionName, b: SessionName): boolean {
  return a.primary === b.primary && a.secondary === b.secondary;
}

// The committed name after this scan, or null to keep the stored one. A new
// candidate (re)starts its clock in `pending`; one stable for the debounce commits.
function debounceName(
  key: SessionKey,
  stored: SessionName,
  seen: SessionName,
  now: number,
  before: { name: SessionName; since: number } | undefined,
  pending: Map<SessionKey, { name: SessionName; since: number }>,
): SessionName | null {
  if (sameName(stored, seen)) return null;
  const since = before && sameName(before.name, seen) ? before.since : now;
  if (now - since >= RENAME_DEBOUNCE_MS) return seen;
  pending.set(key, { name: seen, since });
  return null;
}

// Previous primaries, newest first, never the current name, at most MAX_ALIASES.
function nextAliases(prior: SessionEntry, to: SessionName): string[] {
  const olds = prior.name.primary === to.primary ? prior.aliases : [prior.name.primary, ...prior.aliases];
  return [...new Set(olds.filter((a) => a !== '' && a !== to.primary))].slice(0, MAX_ALIASES);
}

export function reconcile(
  prev: Registry,
  scan: readonly LiveSession[],
  now: number,
  prevPending: PendingRenames = new Map(),
): { next: Registry; events: RegistryEvent[]; pending: PendingRenames } {
  const nowIso = new Date(now).toISOString();
  const entries = new Map<SessionKey, SessionEntry>(prev.sessions.map((e) => [e.key, e]));
  const seen = new Set<SessionKey>();
  const events: RegistryEvent[] = [];
  const panes: Array<{ key: SessionKey; tmux: TmuxLocator }> = [];
  const pending = new Map<SessionKey, { name: SessionName; since: number }>();

  for (const s of scan) {
    const key = resolveKey(s, entries);
    if (key === null || seen.has(key)) continue;
    // A provisional entry for this exact process (same pane triple + pid) is this
    // session seen before its id was known: promote it in place.
    const provisional = s.tmux
      ? [...entries.values()].find(
          (e) =>
            e.key !== key &&
            e.harness === s.harness &&
            isProvisionalKey(e.key) &&
            e.locators.pid === s.pid &&
            sameTmuxLocator(e.locators.tmux, s.tmux),
        )
      : undefined;
    let prior = entries.get(key);
    if (provisional) {
      entries.delete(provisional.key);
      const dropped = prior && prior.threadId !== null && provisional.threadId !== null && provisional.threadId !== prior.threadId ? provisional.threadId : null;
      events.push({ kind: 'promoted', from: provisional.key, to: key, ...(dropped !== null ? { droppedThreadId: dropped } : {}) });
      prior = prior
        ? { ...prior, threadId: prior.threadId ?? provisional.threadId }
        : { ...provisional, key, sessionId: s.sessionId };
    }
    seen.add(key);
    const locators: SessionLocators = { pid: s.pid, tmux: s.tmux, durableSession: s.durableSession };
    const name = nameOf(s);
    if (s.tmux) panes.push({ key, tmux: s.tmux });
    if (!prior) {
      entries.set(key, {
        key,
        harness: s.harness,
        sessionId: s.sessionId,
        sessionFile: s.sessionFile,
        locators,
        cwd: s.cwd,
        name,
        aliases: [],
        threadId: null,
        topicMisses: null,
        state: 'live',
        firstSeen: nowIso,
        lastSeen: nowIso,
      });
      events.push({ kind: 'added', key });
      continue;
    }
    const moved = !sameLocators(prior.locators, locators);
    if (prior.state === 'gone') events.push({ kind: 'readopted', key, threadId: prior.threadId });
    else if (moved) events.push({ kind: 'relocated', key });
    const renamed = debounceName(key, prior.name, name, now, prevPending.get(key) ?? (provisional && prevPending.get(provisional.key)), pending);
    if (renamed) events.push({ kind: 'renamed', key, from: prior.name, to: renamed });
    const changed =
      moved ||
      prior.state === 'gone' ||
      prior.cwd !== s.cwd ||
      renamed !== null ||
      (s.sessionFile !== null && prior.sessionFile !== s.sessionFile) ||
      (prior.sessionId === null && s.sessionId !== null) ||
      provisional !== undefined;
    const stale = now - Date.parse(prior.lastSeen) >= LAST_SEEN_RESOLUTION_MS;
    if (!changed && !stale) continue;
    entries.set(key, {
      ...prior,
      sessionId: prior.sessionId ?? s.sessionId,
      sessionFile: s.sessionFile ?? prior.sessionFile,
      locators,
      cwd: s.cwd,
      // Nothing re-keys on a rename; the old primary becomes the newest alias.
      ...(renamed ? { name: renamed, aliases: nextAliases(prior, renamed) } : {}),
      state: 'live',
      lastSeen: nowIso,
    });
  }

  for (const e of [...entries.values()]) {
    if (seen.has(e.key)) continue;
    // Pane reuse: another session now holds this entry's exact pane triple.
    const taker = e.locators.tmux ? panes.find((p) => sameTmuxLocator(p.tmux, e.locators.tmux)) : undefined;
    let next = e;
    if (taker) {
      events.push({ kind: 'paneReused', from: e.key, to: taker.key, paneId: taker.tmux.paneId });
      next = { ...next, locators: { ...next.locators, tmux: null } };
    }
    if (next.state === 'live') {
      events.push({ kind: 'gone', key: e.key });
      next = { ...next, state: 'gone' };
    } else if (now - Date.parse(next.lastSeen) > GONE_RETENTION_MS) {
      entries.delete(e.key);
      events.push({ kind: 'pruned', key: e.key });
      continue;
    }
    if (next !== e) entries.set(e.key, next);
  }

  const sessions = [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const unchanged = sessions.length === prev.sessions.length && sessions.every((e, i) => e === prev.sessions[i]);
  return { next: unchanged ? prev : { ...prev, sessions }, events, pending };
}
