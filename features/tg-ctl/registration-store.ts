// Per-pane registration SET, written by `tg start` (one entry per agent session)
// and read by the daemon to (a) forward EVERY live session's questions and
// (b) bias inbound/reply routing toward a registered pane.
//
// WHY A SET, NOT A SINGLE SLOT: tg-ctl used to keep ONE global registration
// naming a single pane/cwd. Every `tg` send from an agent session auto-runs
// `tg-ctl start --pane <TMUX_PANE> --cwd <cwd>`, which OVERWROTE that one file,
// so the registration migrated to whichever session sent last. A question from
// any OTHER live session then failed the forward gate (registrationAllowsHook)
// and never reached Telegram (tg-cli#67). The CTO runs several sessions at once,
// so this dropped real questions daily. Keying registrations by paneId lets
// concurrent sessions register side by side: a session's `tg start` upserts only
// ITS OWN entry, and the forward gate allows a question whose pane matches ANY
// entry — every registered session forwards, each scoped to its own pane.
//
// PURE: `tg start` and the daemon own the file I/O and the liveness probe (the
// live tmux pane set); these helpers parse / upsert / prune / query the plain
// JSON array. Liveness is "the pane still exists in the live tmux snapshot" —
// the pane analog of the routes lock's PID-liveness (routes.ts): a dead pane's
// entry is pruned, never aged out by a wall-clock timer.

import type { Registration } from './types';

// Cap the store so it can't grow unbounded if pruning is ever skipped (e.g. an
// empty/flaky tmux snapshot must NOT prune — see pruneRegistrations). Far above
// any realistic concurrent-session count; the oldest entries fall off first.
export const MAX_REGISTRATIONS = 100;

// Does this entry carry a usable pane key? A pane-keyed entry is the normal
// case (an agent session in tmux); a paneless entry (cwd/session only) is the
// fallback the old single-registration path and the cwd-only tests rely on.
export function registrationKey(reg: Registration): string | null {
  return reg.paneId && reg.paneId.length > 0 ? reg.paneId : null;
}

// Parse the on-disk store, tolerating BOTH shapes:
//   • the NEW array form: [{paneId,cwd,…}, …]
//   • the OLD single-object form: {paneId,cwd,…} (a daemon upgraded in place
//     must not lose the live registration written by the previous version).
// Anything malformed degrades to [] (same fail-soft contract as parseRoutes).
export function parseRegistrations(raw: string | null): Registration[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    const out: Registration[] = [];
    for (const r of parsed) {
      const reg = coerceRegistration(r);
      if (reg) out.push(reg);
    }
    return out;
  }
  // Legacy single-object form → wrap as a one-element set (back-compat migration).
  const single = coerceRegistration(parsed);
  return single ? [single] : [];
}

function coerceRegistration(value: unknown): Registration | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const reg: Registration = {};
  if (typeof rec.paneId === 'string') reg.paneId = rec.paneId;
  if (typeof rec.cwd === 'string') reg.cwd = rec.cwd;
  if (typeof rec.sessionName === 'string') reg.sessionName = rec.sessionName;
  if (typeof rec.registeredAt === 'number') reg.registeredAt = rec.registeredAt;
  if (typeof rec.sessionKey === 'string' && rec.sessionKey) reg.sessionKey = rec.sessionKey;
  // An entry with NO identifying field at all (no pane, cwd or session) can never
  // match a hook or a route — drop it rather than carry dead weight.
  if (!reg.paneId && !reg.cwd && !reg.sessionName) return null;
  return reg;
}

// Upsert THIS session's entry, keyed by paneId. Re-running `tg start` from the
// same pane replaces only that pane's entry (the newer cwd/session/timestamp
// wins) and leaves every OTHER session's entry untouched — the whole point of
// the set. A paneless entry (cwd/session only — the fallback / cwd-only-test
// path) has no stable key, so it collapses to a single fallback slot: a new
// paneless registration replaces the prior paneless one (the old single-slot
// behavior, preserved for the no-pane case). The replaced row's session registry
// key carries over while pane and cwd are unchanged (#487): the same session is
// re-registering, and its row must not go keyless until the next registry scan.
export function upsertRegistration(existing: Registration[], reg: Registration): Registration[] {
  const key = registrationKey(reg);
  const replaced = key === null ? undefined : existing.find((e) => registrationKey(e) === key);
  const kept = existing.filter((e) =>
    key !== null ? registrationKey(e) !== key : registrationKey(e) !== null,
  );
  kept.push(
    reg.sessionKey === undefined && replaced?.sessionKey !== undefined && replaced.cwd === reg.cwd
      ? { ...reg, sessionKey: replaced.sessionKey }
      : reg,
  );
  return kept.length > MAX_REGISTRATIONS ? kept.slice(kept.length - MAX_REGISTRATIONS) : kept;
}

// Drop pane-keyed entries whose pane is no longer live (gone from the tmux
// snapshot). Mirrors the routes lock's liveness pruning: an entry is removed
// because its owner (the pane) is DEAD, never because it is old.
//
// SAFETY — never prune on an empty/missing snapshot: the daemon's tmux read is a
// known transient-flake source (an exit-0-but-EMPTY `list-panes`, see
// panesWithRetry). Pruning on a momentarily-empty snapshot would wipe every live
// session's registration at once. So `null` (no snapshot available) prunes
// NOTHING, and the caller passes a non-empty live-pane set only when it actually
// has one. Paneless entries (cwd/session fallback) have no pane to probe and are
// always kept.
export function pruneRegistrations(
  existing: Registration[],
  livePaneIds: Set<string> | null,
): Registration[] {
  if (livePaneIds === null) return existing;
  return existing.filter((e) => {
    const key = registrationKey(e);
    if (key === null) return true; // paneless fallback — nothing to probe
    return livePaneIds.has(key);
  });
}

export function serializeRegistrations(regs: Registration[]): string {
  return JSON.stringify(regs);
}
