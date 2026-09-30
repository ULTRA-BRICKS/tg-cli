// Outbound message → pane routes, written by `tg` on every send and read by the
// daemon to recognize replies and order the /agent picker by LRU+MRU
// (docs/specs/reply-quotes.md, item: reply routing).
//
// PURE: `tg` and `tg-ctl` own the file I/O; these helpers parse/append/query the
// plain JSON array. A reply to a message whose id is in the map routes straight
// to that pane; an unrecognized reply falls back to the picker, whose candidates
// are ordered by how recently + how often each pane was last messaged — both
// derived from this same map (no separate usage state).

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export interface Route {
  id: number; // Telegram message_id of an outbound message
  paneId: string; // tmux pane, or omp:<pid> for an out-of-tmux omp origin
  cwd?: string;
  ts: number; // unix seconds (send time)
  // The session registry key the origin resolved to (session-registry-and-topics
  // §2.4). Set by the one-shot migration today; `paneId` stays as a hint.
  sessionKey?: string;
  // Unix seconds the migration found this row unresolvable. A legacy row is kept
  // only for "that session is gone" answers and dropped LEGACY_ROUTE_TTL_SEC later.
  legacySince?: number;
}

// Keep the tail only — recency is what matters for both recognition and LRU/MRU,
// and the file must not grow unbounded across a long-lived session.
export const MAX_ROUTES = 300;

export const LEGACY_ROUTE_TTL_SEC = 7 * 24 * 60 * 60;

export function parseRoutes(raw: string | null): Route[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Route[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.id !== 'number' || typeof rec.paneId !== 'string' || typeof rec.ts !== 'number') continue;
    out.push({
      id: rec.id,
      paneId: rec.paneId,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
      ts: rec.ts,
      ...(typeof rec.sessionKey === 'string' && rec.sessionKey ? { sessionKey: rec.sessionKey } : {}),
      ...(typeof rec.legacySince === 'number' && Number.isFinite(rec.legacySince) ? { legacySince: rec.legacySince } : {}),
    });
  }
  return out;
}

// Append a route, dropping any prior entry for the same message id and any legacy
// row past its TTL (measured against the new route's send time), capped to the
// last MAX_ROUTES (first-in-first-out by position = chronological by send).
export function appendRoute(existing: Route[], route: Route): Route[] {
  const kept = existing.filter(
    (r) => r.id !== route.id && (r.legacySince === undefined || route.ts - r.legacySince < LEGACY_ROUTE_TTL_SEC),
  );
  kept.push(route);
  return kept.length > MAX_ROUTES ? kept.slice(kept.length - MAX_ROUTES) : kept;
}

export function serializeRoutes(routes: Route[]): string {
  return JSON.stringify(routes);
}

// Cross-process mutex around the routes-file read-modify-write (`tg recordRoute`).
//
// WHY: two agents racing a `tg` send each do read→appendRoute→write with NO
// coordination, so the second writer overwrites the first's just-added entry
// (last-writer-wins). The losing entry is exactly the origin→message_id mapping
// the daemon needs to recognize a reply — its loss is a second way a reply
// silently falls through to the wrong pane. Serializing the RMW makes every
// concurrent send's route survive (no lost updates).
//
// HOW: an O_EXCL lockfile is the cross-process mutex (atomic create, no bun:ffi
// needed — the daemon's flock binds to a long-lived fd, but `tg` is a short-lived
// CLI that holds the lock for ~1ms). `acquire` returns false when the lock is
// already held (O_EXCL EEXIST); we spin a bounded number of times with a small
// sleep. The body runs under `try/finally`, so a `tg` that completes ALWAYS
// releases — the only way a lock outlives its writer is a SIGKILL mid-RMW.
//
// STALENESS BY PID-LIVENESS, NOT MTIME: a stale lock is one whose OWNER PROCESS
// IS DEAD — never "older than N seconds". This is what makes break-then-acquire
// race-free: a LIVE writer's pid is alive, so its lock is never classified stale
// and never broken out from under it (the mtime-age approach had exactly that
// race — a slow-but-alive writer past the age window could be clobbered). The io
// reports the lock owner's liveness; only a dead owner's lock is removed.
//
// PURE/INJECTABLE: every effect (the RMW body, acquire/release, owner-liveness
// probe, break, sleep) is passed in, so this is unit-testable with no real files
// and the concurrency behavior is asserted deterministically. `tg` wires the real
// fs + `process.kill(pid, 0)`.
export interface RoutesLockIo {
  // Try to create the lock EXCLUSIVELY, recording OUR pid. true = acquired,
  // false = already held by someone else.
  acquire: () => boolean;
  // Release ONLY if we still own the lock (the `tg` impl unlinks only when the
  // file still carries our pid token), so a release never deletes a lock a
  // different writer took after ours was broken.
  release: () => void;
  // Is the CURRENT lockfile's owner process DEAD? true → safe to break. false →
  // owner alive (or unknowable: treated as alive, i.e. NOT broken — conservative).
  // null → no lockfile present.
  ownerDead: () => boolean | null;
  // Remove the lock IFF its owner is (still) dead — re-checks ownership/liveness
  // so it can't delete a fresh lock a racing live writer just created.
  breakIfDead: () => void;
  sleep: (ms: number) => void;
}

export interface RoutesLockOpts {
  attempts?: number; // spin attempts (default 50)
  delayMs?: number; // sleep between attempts (default 10ms)
  // What to do when the lock can't be acquired within the budget (sustained
  // contention from LIVE writers):
  //   'skip'         → do NOT run body; return undefined. SAFE for a read-modify-
  //                    write of a shared file: running it unlocked could clobber a
  //                    concurrent writer's good entry (the lost-update the lock is
  //                    meant to prevent — review #55 / codex P2). The current
  //                    writer's own entry is dropped, but no OTHER writer's is.
  //   'run-unlocked' → run body anyway (default; legacy, for bodies that are NOT a
  //                    shared-file RMW and just must not be blocked).
  onContended?: 'skip' | 'run-unlocked';
}

// Run `body` while holding the routes lock. The lock is ALWAYS released (even if
// body throws). Returns body's value, or `undefined` when the lock could not be
// acquired AND onContended is 'skip'.
export function withRoutesLock<T>(io: RoutesLockIo, body: () => T, opts: RoutesLockOpts = {}): T | undefined {
  const attempts = Math.max(1, opts.attempts ?? 50);
  const delayMs = Math.max(0, opts.delayMs ?? 10);
  const onContended = opts.onContended ?? 'run-unlocked';

  let held = false;
  for (let i = 0; i < attempts; i++) {
    if (io.acquire()) {
      held = true;
      break;
    }
    // Held by someone else. Break it ONLY if its owner process is dead (a
    // SIGKILLed `tg`); a live owner is left strictly alone — no clobber.
    if (io.ownerDead() === true) {
      io.breakIfDead();
      if (io.acquire()) {
        held = true;
        break;
      }
    }
    if (i < attempts - 1) io.sleep(delayMs); // no sleep after the last attempt
  }
  // Never acquired (sustained contention from live writers). For a shared-file
  // RMW the caller passes onContended:'skip' — running unlocked here would let
  // this writer clobber the entry a concurrent holder is about to write. Skipping
  // loses only THIS send's own route bookkeeping, never another writer's.
  if (!held && onContended === 'skip') return undefined;
  try {
    return body();
  } finally {
    if (held) io.release();
  }
}

// Real-fs RoutesLockIo backing withRoutesLock for `tg`. The lockfile content is
// the owner pid; liveness is `process.kill(pid, 0)` (injectable for tests). All
// removals are ownership-checked: release/breakIfDead unlink ONLY when the file
// still holds the pid they expect, so no removal can ever nuke a fresh lock a
// racing live writer just created. `isAlive` defaults to a real kill(0) probe;
// `now` is unused here (kept out — staleness is liveness, not age).
export function fsRoutesLockIo(
  lockPath: string,
  deps: { ownPid?: number; isAlive?: (pid: number) => boolean } = {},
): RoutesLockIo {
  const ownPid = deps.ownPid ?? process.pid;
  const isAlive =
    deps.isAlive ??
    ((pid: number): boolean => {
      try {
        process.kill(pid, 0); // signal 0 = liveness probe, never actually signals
        return true;
      } catch (e) {
        // ESRCH = no such process (dead). EPERM = alive but not ours to signal.
        return (e as NodeJS.ErrnoException)?.code === 'EPERM';
      }
    });

  // THREE states, not two — the missing distinction caused a permanent wedge: a
  // SIGKILL in the narrow window between openSync('wx') (file created, empty) and
  // writeFileSync(pid) leaves a present-but-EMPTY lockfile. Treating "unreadable
  // pid" the same as "no file" meant such a lock was NEVER breakable (no owner to
  // probe) — every later send then spun the full budget and ran unlocked forever.
  //   'absent'      → no lockfile at all
  //   'unparseable' → file exists but holds no valid pid (the SIGKILL-window orphan)
  //   <number>      → the owner pid
  type LockOwner = 'absent' | 'unparseable' | number;
  const readOwner = (): LockOwner => {
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch {
      return 'absent';
    }
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 'unparseable';
  };

  // A lock is breakable (its owner effectively gone) when the file holds an
  // unparseable owner OR a dead pid. 'absent' is never "dead" — there is nothing.
  const ownerGone = (o: LockOwner): boolean => o === 'unparseable' || (typeof o === 'number' && !isAlive(o));

  // Unlink ONLY if the file still holds `expected` (our pid, or the exact orphan
  // we just observed). The re-read makes the remove atomic w.r.t. ownership: a
  // writer that re-took the lock meanwhile has a different owner, so we leave it.
  const unlinkIfOwner = (expected: LockOwner): void => {
    try {
      if (readOwner() === expected) unlinkSync(lockPath);
    } catch {
      // already gone / unreadable — fine
    }
  };

  return {
    acquire: (): boolean => {
      let fd: number;
      try {
        fd = openSync(lockPath, 'wx'); // O_CREAT|O_EXCL — EEXIST if already held
      } catch (e) {
        // Only EEXIST means "held, spin/break". Any other errno (ENOENT dir gone,
        // EACCES no perm) is a hard failure: signal it by THROWING so withRoutesLock
        // doesn't waste the full spin budget — recordRoute's outer try swallows it
        // and the send proceeds without route bookkeeping (best-effort, unchanged).
        if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
        throw e;
      }
      // fd is open: ALWAYS close it, and on a write failure remove the empty lock
      // we just created (else it would wedge until a liveness break).
      try {
        writeFileSync(fd, String(ownPid));
      } catch {
        try {
          unlinkSync(lockPath);
        } catch {
          /* best-effort cleanup */
        }
        return false;
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* fd cleanup */
        }
      }
      return true;
    },
    release: () => unlinkIfOwner(ownPid),
    ownerDead: (): boolean | null => {
      const o = readOwner();
      if (o === 'absent') return null; // no lockfile
      return ownerGone(o);
    },
    breakIfDead: () => {
      const o = readOwner();
      if (o !== 'absent' && ownerGone(o)) unlinkIfOwner(o); // re-checked
    },
    sleep: (ms) => Bun.sleepSync(ms),
  };
}

// The pane that produced `messageId`, or null when unrecognized. The LAST entry
// wins (ids are unique after appendRoute, but be defensive).
export function recognizeRoute(routes: Route[], messageId: number): Route | null {
  for (let i = routes.length - 1; i >= 0; i--) {
    if (routes[i].id === messageId) return routes[i];
  }
  return null;
}

// The project-identity stamped into a route's `cwd` at SEND time. It must be the
// SAME quantity the daemon compares against at REPLY time — the origin pane's
// `pane_current_path` — NOT `process.cwd()`. Agents run `tg` from /tmp, so
// process.cwd() (e.g. /private/tmp) never equals the pane's path and every reply
// fell through to the picker (the bug fixed here). Inject the pane-path query so
// this stays pure & testable; fall back to `fallbackCwd` (process.cwd()) when not
// in tmux or the query fails — that matches a daemon whose snapshot also can't
// read the pane, so the conservative picker fallback (04cb6e5) is preserved.
export function resolveRouteCwd(opts: { queryPanePath: () => string | null; fallbackCwd: string }): string {
  const panePath = opts.queryPanePath();
  return panePath && panePath.length > 0 ? panePath : opts.fallbackCwd;
}

// Does a recognized route still belong to the SAME project as the live pane?
// Compares the recorded send-path against the pane's current path, both resolved
// to absolute form. A tmux pane id is reused after kill-pane, so this guard
// (04cb6e5) stops a stale message_id→%N map from injecting project A's reply into
// project B's agent. An absent recorded cwd (old route) or absent pane → no match,
// so the daemon falls through to the picker rather than risk mis-routing.
export function routeMatchesPane(opts: { recognizedCwd: string | undefined; panePath: string | undefined }): boolean {
  // An EMPTY panePath (tmux reporting no pane_current_path) is rejected the same
  // as `undefined`, not just checked against recognizedCwd alone (review
  // finding): `resolve('')` resolves to the DAEMON's own process.cwd(), so an
  // empty panePath would otherwise falsely MATCH any recognizedCwd that happens
  // to equal wherever the daemon was launched from — bypassing the pane-id-reuse
  // guard this function exists to enforce.
  if (!opts.recognizedCwd || !opts.panePath) return false;
  return resolve(opts.panePath) === resolve(opts.recognizedCwd);
}

export interface PaneUsage {
  lastTs: number; // most recent send to this pane (MRU)
  count: number; // number of sends to this pane in the window (MFU)
}

// Aggregate the routes per pane into recency + frequency.
export function aggregateUsage(routes: Route[]): Map<string, PaneUsage> {
  const usage = new Map<string, PaneUsage>();
  for (const r of routes) {
    const u = usage.get(r.paneId);
    if (u) {
      u.count += 1;
      if (r.ts > u.lastTs) u.lastTs = r.ts;
    } else {
      usage.set(r.paneId, { lastTs: r.ts, count: 1 });
    }
  }
  return usage;
}

// Order pane ids by LRU+MRU: most-recently-messaged first, frequency as the
// tiebreaker, then panes with no history last (stable by their input order).
export function orderByLruMru(paneIds: string[], usage: Map<string, PaneUsage>): string[] {
  return paneIds
    .map((paneId, idx) => ({ paneId, idx, u: usage.get(paneId) }))
    .sort((a, b) => {
      if (a.u && b.u) {
        if (b.u.lastTs !== a.u.lastTs) return b.u.lastTs - a.u.lastTs;
        if (b.u.count !== a.u.count) return b.u.count - a.u.count;
        return a.idx - b.idx;
      }
      if (a.u) return -1;
      if (b.u) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.paneId);
}
