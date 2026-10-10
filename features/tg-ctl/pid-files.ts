// Open session files and cwd of a local process — how `tg` and `tg-ctl` find an omp's session
// jsonl and working directory (tg-cli#481).
//
// procfs answers both without a subprocess where it exists (Linux). lsof is the fallback (macOS),
// bounded by PROBE_SPAWN: listing every fd of a long-lived omp has taken lsof tens of seconds,
// which stalled every `tg` send. A timeout, a non-zero exit or a process that is gone all read as
// "unknown" (no paths / null). A MISSING lsof binary is the one error left to the caller (the
// real io lets Bun's ENOENT throw) so tg-ctl can say so once in its log.
import { readdirSync, readlinkSync } from 'fs';
import { PROBE_SPAWN } from '../util/spawn-timeout';
import { parseLsofJsonlPaths } from './omp';
import { parseLsofCwd } from './unreachable';

export interface PidFilesIo {
  /** Entries of a directory; throws when it cannot be read (no procfs, process gone, not ours). */
  readdir(dir: string): string[];
  /** Target of a symlink; throws when it cannot be read. */
  readlink(path: string): string;
  /** lsof stdout, or null on a non-zero exit or a timeout; throws when lsof is not installed. */
  lsof(args: string[]): string | null;
}

// `giveUpAfterTimeout`: once one lsof hits its bound, every later call answers null without
// spawning — for a one-shot `tg` asking about ONE omp, which would make lsof hang again.
export function pidFilesIo(opts: { env?: Record<string, string>; giveUpAfterTimeout?: boolean } = {}): PidFilesIo {
  let lsofTimedOut = false;
  return {
    readdir: (dir) => readdirSync(dir),
    readlink: (path) => readlinkSync(path),
    lsof: (args) => {
      if (lsofTimedOut) return null;
      const r = Bun.spawnSync(['lsof', ...args], { stdout: 'pipe', stderr: 'pipe', ...(opts.env ? { env: opts.env } : {}), ...PROBE_SPAWN });
      if (r.exitedDueToTimeout && opts.giveUpAfterTimeout) lsofTimedOut = true;
      return r.exitCode === 0 ? r.stdout.toString() : null;
    },
  };
}

/** Paths of the `.jsonl` files `pid` holds open (omp's session transcripts). */
export function jsonlPathsOfPid(pid: number, io: PidFilesIo): string[] {
  const fdDir = `/proc/${pid}/fd`;
  let fds: string[] | null;
  try {
    fds = io.readdir(fdDir);
  } catch {
    fds = null;
  }
  if (fds !== null) {
    const paths: string[] = [];
    for (const fd of fds) {
      let target: string;
      try {
        target = io.readlink(`${fdDir}/${fd}`);
      } catch {
        continue; // fd closed between readdir and readlink
      }
      if (target.endsWith('.jsonl')) paths.push(target);
    }
    return paths;
  }
  const out = io.lsof(['-a', '-p', String(pid), '-Fn', '-n', '-P']);
  return out === null ? [] : parseLsofJsonlPaths(out);
}

/** The working directory of `pid`, or null when it cannot be read. */
export function cwdOfPid(pid: number, io: PidFilesIo): string | null {
  try {
    return io.readlink(`/proc/${pid}/cwd`);
  } catch {
    // no procfs (macOS) or the process is gone — ask lsof
  }
  const out = io.lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn', '-n', '-P']);
  return out === null ? null : parseLsofCwd(out);
}
