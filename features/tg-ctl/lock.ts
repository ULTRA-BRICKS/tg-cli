// Singleton/lifecycle helpers for tg-ctl (spec §6, §7).
//
// Everything here is PURE — the actual flock(2) (bun:ffi), kill(2) and file
// reads live in the tg-ctl entrypoint, which feeds these helpers plain data.
// `kill0` is injected so pidStatus is testable without sending real signals.

import { join } from 'path';
import type { ControlConfig, CtlPaths } from './types';

// All daemon state files are keyed by bot id so two bots on one machine never
// collide (the flock guarantees one poller PER TOKEN, not per machine).
export function ctlPaths(configDir: string, botId: string): CtlPaths {
  const base = `tg-ctl.${botId}`;
  return {
    lock: join(configDir, `${base}.lock`),
    pid: join(configDir, `${base}.pid`),
    offset: join(configDir, `${base}.offset`),
    registration: join(configDir, `${base}.registration.json`),
    socket: join(configDir, `${base}.sock`),
    log: join(configDir, `${base}.log`),
    routes: join(configDir, `${base}.routes.json`),
    history: join(configDir, `${base}.history.jsonl`),
    topics: join(configDir, `${base}.topics.json`),
    questions: join(configDir, `${base}.questions.json`),
    schedules: join(configDir, `${base}.schedules.json`),
    overloadRetries: join(configDir, `${base}.overload-retries.json`),
    usageWarnings: join(configDir, `${base}.usage-warnings.json`),
    usageLatest: join(configDir, `${base}.usage-latest.json`),
    deferred: join(configDir, `${base}.deferred.json`),
    lastUserTarget: join(configDir, `${base}.last-user-target.json`),
    usageSchedule: join(configDir, `${base}.usage-schedule.json`),
    dailyPending: join(configDir, `${base}.daily-pending.txt`),
  };
}

// One-time migration plan (tg-cli#281): last-user-target.json replaces the
// last-alex-target.json filename PR #278 shipped hours earlier. A live daemon
// may already hold state under the old name — this only returns a plan
// (never touches disk) so it stays testable with an injected `exists`, same
// as `pidStatus`'s injected `kill0`.
//
// 'migrate': the new file is absent — rename the legacy one forward so the
// CTO's anchor survives the upgrade.
// 'remove-stale': the new file ALREADY exists (freshly written, or a prior
// invalidation deliberately cleared it — see recordLastUserTarget's fail-closed
// unlink) while the legacy file is STILL sitting there. Leaving it would let a
// FUTURE restart, after that same intentional invalidation removes the new
// file again, silently "migrate" the stale legacy copy back and resurrect the
// anchor the invalidation meant to clear (review finding). The legacy file is
// unconditionally redundant once an authoritative new-name file exists, so it
// is removed outright rather than left to linger.
// null: nothing to do (fresh install, or already fully migrated).
export function planLegacyLastUserTargetMigration(
  configDir: string,
  botId: string,
  exists: (path: string) => boolean,
): { kind: 'migrate'; from: string; to: string } | { kind: 'remove-stale'; path: string } | null {
  const base = `tg-ctl.${botId}`;
  const to = join(configDir, `${base}.last-user-target.json`);
  const from = join(configDir, `${base}.last-alex-target.json`);
  if (exists(to)) return exists(from) ? { kind: 'remove-stale', path: from } : null;
  return exists(from) ? { kind: 'migrate', from, to } : null;
}

// Bot tokens look like "123456:ABC-DEF…" — the numeric part is stable and safe
// to embed in filenames, the secret part never is. Anything malformed → ''
// (the caller treats that as "no usable token").
export function botIdFromToken(token: string): string {
  const colon = token.indexOf(':');
  if (colon <= 0) return '';
  const id = token.slice(0, colon);
  return /^\d+$/.test(id) ? id : '';
}

// Pidfile content → pid. Only positive integers qualify: pid 0 would signal
// the whole process group via kill(0, …), negatives target groups too.
export function readPidFile(content: string | null): number | null {
  if (content === null) return null;
  const trimmed = content.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 ? pid : null;
}

// The pidfile is purely informational (spec §6) — the flock is the real
// singleton. 'stale' means the file exists but kill -0 says the process died.
export function pidStatus(pid: number | null, kill0: (pid: number) => boolean): 'running' | 'stale' | 'absent' {
  if (pid === null) return 'absent';
  return kill0(pid) ? 'running' : 'stale';
}

// The launchd job found running this daemon, as the caller probed it (see autostart.ts's
// selectLaunchdDaemonJob). undefined when launchd runs no such job — or on a host without launchd.
export interface LaunchdDaemon {
  label: string;
  pid: number;
}

// What the pidfile says about a daemon launchd is already known to be running: nothing useful
// (absent, or the same pid), a pid that is dead, or a DIFFERENT live pid.
export type PidfileNote = { kind: 'stale'; pid: number } | { kind: 'other-live'; pid: number };

// Who owns the live daemon process.
//   'launchd' — a launchd job runs it; `note` carries any pidfile disagreement so `status` can
//               report a stale/mismatched pidfile WITHOUT calling the daemon down.
//   'process' — no supervisor job, but a live pidfile or the flock holder proves a process is up.
export type DaemonRunState =
  | { kind: 'running'; owner: 'launchd'; pid: number; label: string; note?: PidfileNote }
  | { kind: 'running'; owner: 'process'; pid: number }
  | { kind: 'stale-pidfile'; pid: number }
  | { kind: 'not-running' };

// Decide the daemon's run state from independent sources of truth. The pidfile is informational
// (spec §6); launchd and the flock holder are not. Precedence:
//   1. a live launchd job that supervises this binary (owns the process across relaunches)
//   2. a live pidfile pid
//   3. a live lock-holder pid (socket and pidfile may both be gone; the flock is the singleton)
//   4. a dead pidfile → stale
//   5. nothing → not-running
// Pure: the caller injects kill(0) as `pidAlive`, the launchd probe, and the lock-holder pid.
export function daemonRunState(
  pidfilePid: number | null,
  pidAlive: boolean,
  launchd: LaunchdDaemon | undefined,
  lockHolderPid: number | null = null,
): DaemonRunState {
  if (launchd) {
    const base = { kind: 'running' as const, owner: 'launchd' as const, pid: launchd.pid, label: launchd.label };
    if (pidfilePid === null || pidfilePid === launchd.pid) return base;
    return { ...base, note: pidAlive ? { kind: 'other-live', pid: pidfilePid } : { kind: 'stale', pid: pidfilePid } };
  }
  if (pidfilePid !== null && pidAlive) return { kind: 'running', owner: 'process', pid: pidfilePid };
  if (lockHolderPid !== null && lockHolderPid > 0) return { kind: 'running', owner: 'process', pid: lockHolderPid };
  if (pidfilePid !== null) return { kind: 'stale-pidfile', pid: pidfilePid };
  return { kind: 'not-running' };
}

// The first line of `tg-ctl status`. A live launchd-owned daemon is never "not running", even
// when the pidfile is missing or stale (tg-cli#316 — the 2026-09-08 pid 11062 lie).
export function daemonStatusLine(state: DaemonRunState, botId: string): string {
  const suffix = ` — bot ${botId}`;
  if (state.kind === 'not-running') return `tg-ctl: not running${suffix}`;
  if (state.kind === 'stale-pidfile') return `tg-ctl: not running (stale pidfile, pid ${state.pid})${suffix}`;
  if (state.owner === 'process') return `tg-ctl: running (pid ${state.pid})${suffix}`;
  const note =
    state.note === undefined
      ? ''
      : state.note.kind === 'stale'
        ? `; stale pidfile pid ${state.note.pid}`
        : `; pidfile points at a different live pid ${state.note.pid}`;
  return `tg-ctl: running (launchd, pid ${state.pid})${suffix} (job ${state.label}${note})`;
}


// Does the pidfile on disk belong to US? `cleanExit` (and any other shutdown
// path) MUST gate its `unlink(pidfile)` on this. The bug it guards (tg#93): on a
// launchd relaunch a daemon that is shutting down — or whose ownership a newer
// instance already took over by rewriting the pidfile with ITS pid — would
// otherwise unconditionally delete whatever pid is on disk, including the live
// successor's. That makes `tg-ctl status` (which reads the pidfile) falsely
// report "not running" while the real daemon is alive and long-polling. Only the
// instance whose own pid is written there may remove it.
//
// NOTE: read-then-unlink is NOT atomic — a successor that rewrites the pidfile in
// the sliver between this check and the caller's `unlink` is still vulnerable.
// This NARROWS the race to that sliver; it does not eliminate it. Full closure
// needs atomic semantics (O_EXCL token / rename), but the flock — not the pidfile
// — is the real singleton (spec §6), so the pidfile is informational and this
// guard is enough to keep `status` honest in practice. Same ownership idea as
// `unlinkIfOwner` in routes.ts, but that one guards the ROUTES lock (a different
// file + LockOwner model), so the two are kept separate deliberately.
export function ownsPidFile(content: string | null, ownPid: number): boolean {
  return readPidFile(content) === ownPid;
}

// Lazy auto-start gate (spec §7): inside tmux AND control.enabled. Deliberately
// NO TTY check — agents call tg through a piped Bash tool, so isatty is false
// in exactly the scenario that must fire; the TMUX check alone excludes
// CI/cron. Fire-and-forget: the daemon's flock makes double-starts a no-op.
export function shouldAutoStart(env: { TMUX?: string }, cfg: ControlConfig): boolean {
  return Boolean(env.TMUX) && cfg.enabled;
}
