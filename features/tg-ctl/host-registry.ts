// Sessions a rig wrapper hosts in abduco OUTSIDE tmux — the registration record, its
// validation, liveness against the process table, and the synthetic `host:<name>` id
// (docs/specs/2026-09-30-harness-agnostic-control.md §3–§5).
//
// A wrapper-hosted harness is reachable through the terminal that hosts it: tg-ctl
// writes into the abduco session's PTY (abduco-pty.ts), the same bytes a human types
// into an attached terminal, so the harness stays the only writer of its own history.
// The wrapper writes `<config>/hosts/<name>.json`; tg-ctl only READS it, and trusts it
// only while the process table agrees: a record is live iff its `serverPid` runs the
// abduco server of exactly that session, its socket exists, and ONE harness of the
// recorded kind runs below the server.
//
// PURE — the entrypoints read the files / `ps` / stat the socket and hand the facts in.

import { basename, isAbsolute, join } from 'path';
import type { AgentKind, ProcInfo } from './types';
import type { AgentCandidate } from './agent-match';
import { abducoSessionName, matchAgentCommand } from './discover';
import { resolveSessionName } from './session-name';

export const HOST_RECORD_VERSION = 1;

// The abduco session id the wrapper mints (`<harness>-<12 hex>`); also the record's file
// stem, the delivery address and a path component, so it is validated everywhere it is used.
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
const HOST_HARNESSES = ['omp', 'claude', 'codex', 'opencode'] as const;
export type HostHarness = (typeof HOST_HARNESSES)[number];
const LABEL_MAX = 64;
const ORIGIN_PREFIX = 'host:';

export interface HostRecord {
  name: string;
  harness: HostHarness;
  // The human name the `[window]` bracket shows outside tmux; null = fall back to the
  // harness title, then the cwd basename.
  label: string | null;
  cwd: string | null;
  // ABSOLUTE socket path: the daemon runs under launchd with a different environment.
  socket: string;
  serverPid: number;
  harnessPid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
}

// A record proven live against the process table; `harnessPid` is the pid under the
// server NOW (the record's own may be stale right after a relaunch).
export interface LiveHost extends HostRecord {
  agent: AgentKind;
  harnessPid: number;
}

// What the entrypoint learned from the record file's open descriptor (open, fstat).
export interface HostFileFacts {
  isRegularFile: boolean;
  isSymlink: boolean;
  uid: number;
}

export type HostParse = { ok: true; record: HostRecord } | { ok: false; reason: string };

export function hostsDir(configDir: string): string {
  return join(configDir, 'hosts');
}

// null for a name that is not a valid abduco session id — never build a path from one.
export function hostRecordPath(configDir: string, name: string): string | null {
  return HOST_NAME.test(name) ? join(hostsDir(configDir), `${name}.json`) : null;
}

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function optString(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : undefined;
}

// Validates a wrapper-written record (spec §3): version 1, the file stem IS the session
// name, a known harness, an absolute socket that belongs to this session, a positive
// serverPid, role `coordinator` (a subagent is never a delivery target), and a regular
// non-symlink file owned by the daemon's own user. A bad record is skipped, never fatal.
export function parseHostRecord(stem: string, raw: string, file: HostFileFacts, ownUid: number): HostParse {
  if (file.isSymlink || !file.isRegularFile) return { ok: false, reason: 'not a regular file' };
  if (file.uid !== ownUid) return { ok: false, reason: `owned by uid ${file.uid}, not ${ownUid}` };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, reason: 'not an object' };
  const r = data as Record<string, unknown>;
  if (r.v !== HOST_RECORD_VERSION) return { ok: false, reason: `unsupported version ${String(r.v)}` };
  if (typeof r.name !== 'string' || !HOST_NAME.test(r.name)) return { ok: false, reason: 'invalid name' };
  if (r.name !== stem) return { ok: false, reason: `name ${r.name} is not the file stem ${stem}` };
  const harness = HOST_HARNESSES.find((h) => h === r.harness);
  if (harness === undefined) return { ok: false, reason: `unknown harness ${String(r.harness)}` };
  if (r.role !== 'coordinator') return { ok: false, reason: `role ${JSON.stringify(r.role)} is not coordinator` };
  if (typeof r.socket !== 'string' || !isAbsolute(r.socket)) return { ok: false, reason: 'socket is not an absolute path' };
  const socketBase = basename(r.socket);
  if (socketBase !== r.name && !socketBase.startsWith(`${r.name}@`)) return { ok: false, reason: `socket ${socketBase} is not this session's` };
  const serverPid = posInt(r.serverPid);
  if (serverPid === null) return { ok: false, reason: 'serverPid is not a positive integer' };
  // Absent/null = the wrapper has not recorded the harness pid yet; anything else must be valid.
  const harnessPid = r.harnessPid == null ? null : posInt(r.harnessPid);
  if (r.harnessPid != null && harnessPid === null) return { ok: false, reason: 'harnessPid is not a positive integer' };
  const label = optString(r.label);
  const cwd = optString(r.cwd);
  const startedAt = optString(r.startedAt);
  const updatedAt = optString(r.updatedAt);
  if (label === undefined || cwd === undefined || startedAt === undefined || updatedAt === undefined) {
    return { ok: false, reason: 'label/cwd/startedAt/updatedAt must be strings' };
  }
  const trimmed = label === null ? '' : label.trim().slice(0, LABEL_MAX).trim();
  return {
    ok: true,
    record: {
      name: r.name,
      harness,
      label: trimmed === '' ? null : trimmed,
      cwd,
      socket: r.socket,
      serverPid,
      harnessPid,
      startedAt,
      updatedAt,
    },
  };
}

// Agent processes of `kind` at the SHALLOWEST depth below `rootPid` (the abduco server):
// the harness the wrapper started, never one that harness launched in turn (`claude -p`).
function shallowestAgents(rootPid: number, kind: AgentKind, children: ReadonlyMap<number, ProcInfo[]>): ProcInfo[] {
  const seen = new Set<number>([rootPid]);
  let level = children.get(rootPid) ?? [];
  while (level.length > 0) {
    for (const p of level) seen.add(p.pid);
    const hits = level.filter((p) => matchAgentCommand(p.command) === kind);
    if (hits.length > 0) return hits;
    level = level.flatMap((p) => children.get(p.pid) ?? []).filter((p) => !seen.has(p.pid));
  }
  return [];
}

// Re-verifies each record against the process table right now. A record is skipped (with
// the reason, for the log) rather than trusted when its server pid is dead or reused, its
// socket is gone, or the server holds no — or an ambiguous — harness of the recorded kind.
export function liveHosts(
  records: readonly HostRecord[],
  procs: readonly ProcInfo[],
  socketExists: (path: string) => boolean,
): { live: LiveHost[]; skipped: Array<{ name: string; reason: string }> } {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const siblings = children.get(p.ppid);
    if (siblings) siblings.push(p);
    else children.set(p.ppid, [p]);
  }
  const live: LiveHost[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const rec of records) {
    const server = byPid.get(rec.serverPid);
    if (!server) {
      skipped.push({ name: rec.name, reason: `server pid ${rec.serverPid} is not running` });
      continue;
    }
    if (abducoSessionName(server.command) !== rec.name) {
      skipped.push({ name: rec.name, reason: `pid ${rec.serverPid} is not the abduco server of ${rec.name}` });
      continue;
    }
    if (!socketExists(rec.socket)) {
      skipped.push({ name: rec.name, reason: `socket ${rec.socket} is missing` });
      continue;
    }
    const hits = shallowestAgents(rec.serverPid, rec.harness, children);
    if (hits.length !== 1) {
      skipped.push({ name: rec.name, reason: hits.length === 0 ? `no ${rec.harness} process under the server` : `${hits.length} ${rec.harness} processes under the server` });
      continue;
    }
    live.push({ ...rec, agent: rec.harness, harnessPid: hits[0].pid });
  }
  return { live, skipped };
}

// `host:<name>` — the synthetic pane-id-shaped address of a session hosted outside tmux,
// as the delivery-ledger target, the picker id and the `tg` route origin (like `omp:<pid>`).
export function hostOriginId(name: string): string {
  return `${ORIGIN_PREFIX}${name}`;
}

export function hostNameFromOriginId(id: string): string | null {
  if (!id.startsWith(ORIGIN_PREFIX)) return null;
  const name = id.slice(ORIGIN_PREFIX.length);
  return HOST_NAME.test(name) ? name : null;
}

// The name this host is shown under everywhere: label → cwd project → `<harness> · <short id>`
// (the resolver's not-in-tmux tiers, session-name.ts).
export function hostDisplayName(h: Pick<HostRecord, 'name' | 'harness' | 'label' | 'cwd'>): string {
  // The wrapper names sessions `<harness>-<hex>`, but the record's name is only validated as a
  // path-safe id: do not assume the prefix is there.
  const prefix = `${h.harness}-`;
  const short = (h.name.startsWith(prefix) ? h.name.slice(prefix.length) : h.name).slice(0, 8) || h.name;
  return resolveSessionName({ hostLabel: h.label, cwd: h.cwd, fallback: `${h.harness} · ${short}` }).primary;
}

// The live host whose abduco server a process runs under, walking up the ppid chain; null
// for a process no host owns. Used to keep hosted agents out of the "unreachable" listing and
// to find the host behind an omp whose endpoint is absent.
export function hostOfPid(pid: number, procs: readonly ProcInfo[], hosts: readonly LiveHost[]): LiveHost | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  for (let cur = byPid.get(pid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
    seen.add(cur.pid);
    const here = cur.pid;
    const owner = hosts.find((h) => h.serverPid === here);
    if (owner) return owner;
  }
  return null;
}

export function hostToCandidate(h: LiveHost): AgentCandidate {
  return {
    paneId: hostOriginId(h.name),
    sessionName: h.harness,
    windowIndex: h.harnessPid,
    windowName: hostDisplayName(h),
    agent: h.agent,
    panePath: h.cwd ?? undefined,
    aliases: [h.name],
  };
}

// The hosts that are the ONLY view of their session: one whose harness a tmux pane or omp-live
// already shows is dropped — that row wins and keeps the window name (a pane shows the session
// through an `abduco -a` client: same address, never two rows).
export function hostsNotShownElsewhere(hosts: readonly LiveHost[], coveredAgentPids: ReadonlySet<number>): LiveHost[] {
  return hosts.filter((h) => !coveredAgentPids.has(h.harnessPid));
}

// One `tg-ctl status` line.
export function describeHost(h: LiveHost): string {
  return `${hostDisplayName(h)} · ${h.agent} — abduco ${h.name} (cwd ${h.cwd ?? '?'}, pid ${h.harnessPid}) → PTY injection`;
}
