// Is the running tg-ctl daemon executing the code its checkout now holds? (tg-cli#279)
//
// `tg-ctl` is a live-symlink Bun script: a merge + pull updates the files on disk, but
// the resident `tg-ctl run` process keeps the modules it loaded at start until it is
// restarted — merged fixes sat inert for weeks. The daemon therefore records which
// commit it loaded (the run-info file, written right after it takes the flock), and
// `tg-ctl status` / `tg-ctl restart --if-stale` compare that commit with the checkout's
// current HEAD. Pure: the entrypoint does the git spawns and file reads.

// What the daemon records about itself at start. `pid` ties the record to one process:
// a record whose pid is not the running daemon's describes an earlier process.
export interface DaemonRunInfo {
  pid: number;
  commit: string; // full sha of the checkout HEAD when the daemon loaded its code
  codeDir: string; // realpath of the directory the daemon's entrypoint was loaded from
  startedAt: number; // ms epoch
}

export function serializeRunInfo(info: DaemonRunInfo): string {
  return `${JSON.stringify(info)}\n`;
}

export function parseRunInfo(raw: string | null): DaemonRunInfo | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const { pid, commit, codeDir, startedAt } = v;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof commit !== 'string' || !commit) return null;
    if (typeof codeDir !== 'string' || !codeDir) return null;
    if (typeof startedAt !== 'number') return null;
    return { pid, commit, codeDir, startedAt };
  } catch {
    return null;
  }
}

// Does a change to this repo-relative path change what the daemon runs? Deliberately an
// EXCLUDE list: an unknown new file counts as daemon code, so the error is an extra
// graceful restart, never a silently stale daemon. Excluded: prose (*.md), docs, tests,
// CI/ops config, screenshots, the deploy script, and `tg` (the one-shot sender — the
// daemon never imports it; each `tg` run reads the new file anyway).
const NON_DAEMON_PREFIXES = ['docs/', 'tests/', 'screenshots/', 'scripts/', 'ci/', '.github/', '.forgejo/'];
const NON_DAEMON_FILES: Record<string, true> = {
  tg: true,
  LICENSE: true,
  '.gitignore': true,
  '.env.example': true,
  '.ship-config': true,
  'task.yaml': true,
  'rig.yaml': true,
  'install.sh': true,
};

export function isDaemonCodePath(path: string): boolean {
  if (path.endsWith('.md')) return false;
  if (Object.hasOwn(NON_DAEMON_FILES, path)) return false;
  return !NON_DAEMON_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type CodeFreshness =
  | { kind: 'current'; commit: string }
  // HEAD moved, but nothing the daemon runs changed (a docs/tests merge).
  | { kind: 'current-code'; running: string; head: string }
  // `changedFiles` null: the diff could not be computed (e.g. the loaded commit no longer
  // exists after a force-push) — treated as stale.
  | { kind: 'stale'; running: string; head: string; codeDir: string; changedFiles: number | null }
  | { kind: 'unknown'; reason: string };

// `diffPaths`: `git diff --name-only <runInfo.commit> <head>` in runInfo.codeDir, or null
// when it failed. `head`: that checkout's HEAD now, or null when unreadable.
export function assessCodeFreshness(
  runInfo: DaemonRunInfo | null,
  daemonPid: number,
  head: string | null,
  diffPaths: string[] | null,
): CodeFreshness {
  if (runInfo === null || runInfo.pid !== daemonPid) {
    return { kind: 'unknown', reason: `the running daemon (pid ${daemonPid}) did not record which commit it loaded (started by an older tg-ctl)` };
  }
  if (head === null) return { kind: 'unknown', reason: `cannot read the HEAD of ${runInfo.codeDir}` };
  if (head === runInfo.commit) return { kind: 'current', commit: head };
  if (diffPaths !== null && !diffPaths.some(isDaemonCodePath)) {
    return { kind: 'current-code', running: runInfo.commit, head };
  }
  return {
    kind: 'stale',
    running: runInfo.commit,
    head,
    codeDir: runInfo.codeDir,
    changedFiles: diffPaths === null ? null : diffPaths.filter(isDaemonCodePath).length,
  };
}

// `restart --if-stale` restarts on stale AND unknown: when the loaded code cannot be
// proven current, a graceful restart is the cheap way to make it so.
export function shouldRestartForFreshness(f: CodeFreshness): boolean {
  return f.kind === 'stale' || f.kind === 'unknown';
}

const short = (sha: string): string => sha.slice(0, 7);

// The `code:` line of `tg-ctl status` (the caller appends the restart hint when one is due).
export function codeFreshnessLine(f: CodeFreshness): string {
  switch (f.kind) {
    case 'current':
      return `code: ${short(f.commit)} (current)`;
    case 'current-code':
      return `code: ${short(f.running)} (checkout at ${short(f.head)} — no daemon code changed)`;
    case 'stale': {
      const changed = f.changedFiles === null ? 'daemon code changed' : `${f.changedFiles} daemon file(s) changed`;
      return `code: STALE — daemon runs ${short(f.running)} but ${f.codeDir} is at ${short(f.head)} (${changed})`;
    }
    case 'unknown':
      return `code: unknown — ${f.reason}`;
  }
}
