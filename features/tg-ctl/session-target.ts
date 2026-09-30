// Session-keyed delivery (docs/specs/session-registry-and-topics.md §2.4–§2.6;
// tg-cli#459, #354, #100). Routes, registrations and the last-user target name a
// SESSION (registry key), and the registry says where that session lives now: a
// resumed omp keeps its key under a new pid (§2.5), so a reply to a pre-restart
// message still reaches it. The reverse question — "is pane %N still the session
// this late delivery was meant for?" — is the §2.6 pane-reuse guard: a tmux
// server restart or a respawned pane reuses `%N`, and a cwd match is never proof.
//
// PURE — the daemon passes in the registry of its latest trusted scan.

import type { Registration } from './types';
import type { LastUserTarget } from './last-user-target';
import { isProvisionalKey, provisionalKey, sameTmuxLocator, type Registry, type SessionEntry, type SessionKey } from './session-registry';
import { liveOmpPidFromOriginId } from './omp';

function entryOf(reg: Registry, key: string): SessionEntry | null {
  return reg.sessions.find((e) => e.key === key) ?? null;
}

function onlyOne<T>(hits: T[]): T | null {
  return hits.length === 1 ? hits[0] : null;
}

// The live session whose pane locator is `paneId` (exactly one), or null.
export function sessionAtPane(reg: Registry, paneId: string): SessionEntry | null {
  return onlyOne(reg.sessions.filter((e) => e.state === 'live' && e.locators.tmux?.paneId === paneId));
}

// The picker/candidate id of a live session: its tmux pane, else the `omp:<pid>`
// row every paneless session rides in the agent picker (agent-match.ts).
function candidateIdOf(e: SessionEntry): string | null {
  if (e.locators.tmux) return e.locators.tmux.paneId;
  return e.locators.pid !== null ? `${e.harness}:${e.locators.pid}` : null;
}

// Where a `tg` send came from, as the route row records it: the pane id (`%N`, or
// `omp:<pid>` outside tmux), the agent process that ran `tg`, and the tmux
// server/pane pids of the origin pane.
export interface RouteOrigin {
  paneId: string;
  agentPid?: number;
  serverPid?: number;
  panePid?: number;
}

// The entries a route's origin names exactly. With the tmux triple recorded, the
// entry on that exact pane — and, when the agent pid is known, that same process
// (an omp restarted in the same shell keeps the triple; a reused pid elsewhere
// fails the triple). Without it, the agent pid or the `omp:<pid>` pane id. A bare
// `%N` is never enough.
function originMatches(entries: SessionEntry[], origin: RouteOrigin): SessionEntry[] {
  const pid = origin.agentPid ?? liveOmpPidFromOriginId(origin.paneId) ?? undefined;
  if (origin.serverPid !== undefined && origin.panePid !== undefined) {
    const tmux = { serverPid: origin.serverPid, paneId: origin.paneId, panePid: origin.panePid };
    return entries.filter((e) => sameTmuxLocator(e.locators.tmux, tmux) && (pid === undefined || e.locators.pid === pid));
  }
  if (pid === undefined) return [];
  return entries.filter((e) => e.locators.pid === pid);
}

// The live session a route's origin was, or null when none matches exactly once.
export function resolveRouteSession(reg: Registry, origin: RouteOrigin): SessionKey | null {
  return onlyOne(originMatches(reg.sessions.filter((e) => e.state === 'live'), origin))?.key ?? null;
}

// The session a route's origin was when it has since left the registry's live
// set: a reply to it gets the picker, never a same-project pane guess.
export function goneRouteSession(reg: Registry, origin: RouteOrigin): SessionEntry | null {
  return onlyOne(originMatches(reg.sessions.filter((e) => e.state !== 'live'), origin));
}

// Whether `reg` still describes pane `paneId` as observed now: its live occupant
// is the same agent process under the same pane process. A shared (rate-limited)
// scan that fails this is stale for the §2.6 guard.
export function registryCurrentForPane(reg: Registry, paneId: string, panePid: number | undefined, agentPid: number | undefined): boolean {
  const host = sessionAtPane(reg, paneId);
  return host !== null && panePid !== undefined && agentPid !== undefined && host.locators.tmux?.panePid === panePid && host.locators.pid === agentPid;
}

export type SessionDeliveryTarget =
  | { kind: 'live'; paneId: string | null; pid: number | null; cwd: string; name: string }
  | { kind: 'gone'; name: string }
  | { kind: 'unknown' };

// Where to deliver to a session now. `unknown`: the registry never saw the key
// (pruned, or a key from a store the registry has not caught up with).
export function sessionDeliveryTarget(reg: Registry, key: string): SessionDeliveryTarget {
  const e = entryOf(reg, key);
  if (!e) return { kind: 'unknown' };
  if (e.state !== 'live') return { kind: 'gone', name: e.name.primary };
  return { kind: 'live', paneId: e.locators.tmux?.paneId ?? null, pid: e.locators.pid, cwd: e.cwd, name: e.name.primary };
}

export type PaneSessionCheck = { ok: true } | { ok: false; targetName: string; hostName: string | null };

// The §2.6 guard: pane `paneId` may receive a delivery meant for `key` only when
// its live occupant IS that session. A provisional key (a cc/codex pane seen
// before its first hook) also matches the session it was promoted to, as long as
// it still sits on the exact pane the key was minted for.
export function checkPaneSession(reg: Registry, key: string, paneId: string): PaneSessionCheck {
  const host = sessionAtPane(reg, paneId);
  if (host && (host.key === key || (isProvisionalKey(key) && host.locators.tmux && provisionalKey(host.harness, host.locators.tmux) === key))) {
    return { ok: true };
  }
  return { ok: false, targetName: entryOf(reg, key)?.name.primary ?? key, hostName: host?.name.primary ?? null };
}

export function paneRefusalText(check: Extract<PaneSessionCheck, { ok: false }>, paneId: string): string {
  return `${check.targetName} is no longer in pane ${paneId} (now ${check.hostName ?? 'no agent'})`;
}

// Registrations as delivery should read them: a keyed row follows its session to
// the pane it lives in now, and is dropped once that session is gone (a reused
// pane must not inherit it, #354). Unkeyed rows (an untracked harness) and keys
// the registry has never seen stay as stored. Without a registry nothing changes.
export function resolveRegistrationsBySession<R extends Pick<Registration, 'paneId' | 'sessionKey'>>(rows: R[], reg: Registry | null): R[] {
  if (!reg) return rows;
  return rows.flatMap((r) => {
    if (r.sessionKey === undefined) return [r];
    const e = entryOf(reg, r.sessionKey);
    if (!e) return [r];
    if (e.state !== 'live') return [];
    const paneId = e.locators.tmux?.paneId;
    return [paneId && paneId !== r.paneId ? { ...r, paneId } : r];
  });
}

// The candidate id the last-user anchor points at. `proven`: the registry vouched
// for it by session key, so no cwd check is needed; otherwise the caller keeps the
// pane+cwd guard. Null: the anchored session is gone — never fall back to its pane.
export function resolveAnchorTarget(anchor: LastUserTarget, reg: Registry | null): { paneId: string; proven: boolean } | null {
  const e = reg && anchor.sessionKey ? entryOf(reg, anchor.sessionKey) : null;
  if (!e) return { paneId: anchor.paneId, proven: false };
  if (e.state !== 'live') return null;
  const paneId = candidateIdOf(e);
  return paneId ? { paneId, proven: true } : null;
}
