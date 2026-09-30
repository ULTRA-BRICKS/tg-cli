// The harness adapter boundary (docs/specs/session-registry-and-topics.md §2.2,
// tg#16810): tg-ctl's registry consumes `listLiveSessions()` and nothing outside
// this file branches on a harness name for identity. Today it wraps discover.ts
// (panes, including the #485 abduco walk), omp.ts (ps/lsof + live endpoints) and
// the cc/codex session ids captured from hook payloads; when harness-cli
// (`harness agents`, #377) reports these fields this becomes a thin client.
// PURE — the daemon runs the tmux/ps/lsof reads and passes their results in.

import { abducoSessionName, findAgentInPane } from './discover';
import type { LiveOmpAgent } from './omp';
import type { Harness, LiveSession, Registry, TmuxLocator } from './session-registry';
import type { ButtonRequest } from './questions';
import type { AgentKind, PaneInfo, ProcInfo } from './types';

// A cc/codex hook seen on the daemon's hook socket: the payload's `session_id`,
// the hook process's TMUX_PANE, and the agent pid that pane hosted when the hook
// arrived — so a later process in the same pane never inherits the id.
export interface HookSessionSighting {
  harness: 'cc' | 'codex';
  sessionId: string;
  paneId: string;
  pid: number;
}

export type PendingHookSighting = Omit<HookSessionSighting, 'pid'>;

// A cc/codex ask names its session (`origin.sessionId`, the hook payload's
// `session_id`) and its pane; anything else carries no registry identity.
export function hookSightingOf(req: Pick<ButtonRequest, 'agent' | 'paneId' | 'origin'>): PendingHookSighting | null {
  const harness = req.agent === 'claude' ? 'cc' : req.agent === 'codex' ? 'codex' : null;
  const sessionId = req.origin?.sessionId;
  if (!harness || !sessionId || !req.paneId) return null;
  return { harness, sessionId, paneId: req.paneId };
}

// Bind pending sightings to the agent pid their pane hosts in this snapshot (the
// asker is alive, blocking on its hook), so a later process in the same pane never
// inherits the id. Bound sightings whose process exited are forgotten; the newest
// sighting per (pane, pid) wins.
export function bindHookSessions(
  bound: readonly HookSessionSighting[],
  pending: readonly PendingHookSighting[],
  panes: PaneInfo[],
  procs: ProcInfo[],
): HookSessionSighting[] {
  const alive = new Set(procs.map((p) => p.pid));
  const byLocator = new Map<string, HookSessionSighting>();
  for (const s of bound) if (alive.has(s.pid)) byLocator.set(`${s.paneId}/${s.pid}`, s);
  for (const s of pending) {
    const pane = panes.find((p) => p.paneId === s.paneId);
    const pid = pane ? findAgentInPane(pane, procs)?.pid : undefined;
    if (pid !== undefined) byLocator.set(`${s.paneId}/${pid}`, { ...s, pid });
  }
  return [...byLocator.values()];
}

export interface HarnessScanInput {
  panes: PaneInfo[];
  procs: ProcInfo[];
  // tmux `#{pid}` of the server that listed `panes`; part of every pane locator.
  serverPid: number | null;
  paneTitles: ReadonlyMap<string, string>;
  // Live omp, already enriched from endpoints / session jsonl (listLiveOmpAgents).
  omp: ReadonlyArray<LiveOmpAgent & { durableSession?: string | null }>;
  hookSessions: readonly HookSessionSighting[];
}

const HARNESS_BY_AGENT: Partial<Record<AgentKind, Harness>> = { omp: 'omp', claude: 'cc', codex: 'codex' };

// The abduco session a process runs under: its nearest abduco ancestor (the
// pid-1 abduco server `rig omp run` starts).
function durableSessionOf(pid: number, procs: readonly ProcInfo[]): string | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  let cur = byPid.get(pid);
  while (cur && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    const name = abducoSessionName(cur.command);
    if (name !== null) return name;
    cur = byPid.get(cur.ppid);
  }
  return null;
}

// cc/codex outside tmux are not registered (spec §2.1): they are listed by
// `tg-ctl status` only and answered by the #456 refusal.
export function listLiveSessions(input: HarnessScanInput): LiveSession[] {
  const out: LiveSession[] = [];
  const emitted = new Set<number>();
  for (const pane of input.panes) {
    const found = findAgentInPane(pane, input.procs);
    const harness = found ? HARNESS_BY_AGENT[found.agent] : undefined;
    if (!found || found.pid === undefined || harness === undefined || input.serverPid === null) continue;
    const pid = found.pid;
    if (emitted.has(pid)) continue;
    emitted.add(pid);
    const tmux: TmuxLocator = { serverPid: input.serverPid, paneId: pane.paneId, panePid: pane.panePid };
    const omp = harness === 'omp' ? input.omp.find((a) => a.pid === pid) : undefined;
    const hook =
      harness === 'omp' ? undefined : input.hookSessions.find((h) => h.harness === harness && h.paneId === pane.paneId && h.pid === pid);
    out.push({
      harness,
      sessionId: omp?.sessionId ?? hook?.sessionId ?? null,
      sessionFile: omp?.sessionFile ?? null,
      pid,
      tmux,
      durableSession: omp?.durableSession ?? durableSessionOf(pid, input.procs),
      windowName: pane.windowName,
      paneTitle: input.paneTitles.get(pane.paneId) ?? null,
      harnessTitle: omp?.title ?? null,
      cwd: pane.panePath || omp?.cwd || '',
    });
  }
  for (const a of input.omp) {
    if (emitted.has(a.pid) || a.paneId !== null) continue;
    emitted.add(a.pid);
    out.push({
      harness: 'omp',
      sessionId: a.sessionId,
      sessionFile: a.sessionFile,
      pid: a.pid,
      tmux: null,
      durableSession: a.durableSession ?? durableSessionOf(a.pid, input.procs),
      windowName: null,
      paneTitle: null,
      harnessTitle: a.title,
      cwd: a.cwd ?? '',
    });
  }
  return out;
}

// Whether a discovery snapshot may be reconciled at all. A missing session in a
// trusted scan marks the entry gone, so the known launchd flakes must not count:
// an empty `ps` read, panes with no readable server pid (no pane locator can be
// formed), and an empty `tmux list-panes` while a registered tmux-hosted process
// is still alive (the server did not really go away).
export function scanIsTrustworthy(
  prev: Registry,
  snap: { panes: readonly PaneInfo[]; procs: readonly ProcInfo[]; serverPid: number | null },
): boolean {
  if (snap.procs.length === 0) return false;
  if (snap.panes.length > 0) return snap.serverPid !== null;
  const alive = new Set(snap.procs.map((p) => p.pid));
  return !prev.sessions.some((e) => e.state === 'live' && e.locators.tmux !== null && e.locators.pid !== null && alive.has(e.locators.pid));
}

// Which panes the one-shot store migration may treat as live, from a trusted scan:
// the listed panes; `null` when no tmux server answered (pane liveness unknown —
// the migration still runs and marks every store, but drops nothing for a dead
// pane); 'wait' when a live server answered with no panes (the launchd empty-read
// flake — a real server always has a pane), so a later scan migrates.
export function migrationLivePanes(snap: { panes: readonly PaneInfo[]; serverPid: number | null }): ReadonlySet<string> | null | 'wait' {
  if (snap.panes.length > 0) return new Set(snap.panes.map((p) => p.paneId));
  return snap.serverPid === null ? null : 'wait';
}

// The tmux `#{pid}` read just before and just after the pane snapshot. It names
// that snapshot's server only when both reads agree: a restart in between would
// pair the old server's `%N` ids with the new server's pid (spec §2.6).
export function serverPidAcross(before: number | null, after: number | null): number | null {
  return before !== null && before === after ? before : null;
}
