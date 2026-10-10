// The one way a test makes a temp dir or keeps a spawned process alive past its own `await`
// (tg-cli#486, #550). Every `mkdtempSync(join(tmpdir(), …))` used to be left behind — ~7000 dirs
// and 6.7 GB an hour on a RAM-backed /tmp under agent load — and every daemon/abduco server a
// failed or timed-out test spawned outlived the run. A guard test (temp-hygiene.test.ts) keeps
// direct `mkdtemp` calls out of tests/.
//
// Cleanup is run-scoped, not per-test: plenty of files create one config dir at module scope and
// share it across every test, so a per-test rm would pull it out from under them. The preload
// (hermetic-env.ts) calls `cleanupTestRun()` in a global afterAll and again on exit, after
// `sweepRunProcesses` has killed every process the run started — tracked or not (a detached
// `tg-ctl start` grandchild, an abduco server) — found by the run's unique shim dir on its PATH.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

const dirs = new Set<string>();
const children = new Set<Subprocess>();

/**
 * A fresh temp dir removed when the run ends. `short` puts it under /tmp instead of tmpdir():
 * for unix sockets, whose path holds ~104 bytes — macOS's /var/folders/… tmpdir is too long.
 * TG_TEST_SHORT_TMPDIR replaces that /tmp, so temp-hygiene's child run keeps its short dirs
 * apart from those of any other run on the host.
 */
export function tempDir(prefix: string, opts: { short?: boolean } = {}): string {
  const dir = mkdtempSync(join(opts.short ? process.env.TG_TEST_SHORT_TMPDIR || '/tmp' : tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

/** Kill `proc` — and its process group when it leads one — when the run ends. */
export function trackChild<T extends Subprocess>(proc: T): T {
  children.add(proc);
  return proc;
}

function killGroupAndPid(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Not a group leader, or already gone.
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function carriesMarker(pid: number, markers: string[], files: readonly string[]): boolean {
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(`/proc/${pid}/${file}`, 'latin1');
    } catch {
      // Exited, or not ours to read.
    }
    if (markers.some((marker) => marker && text.includes(marker))) return true;
  }
  return false;
}

function scanProc(markers: string[], files: readonly string[]): number[] {
  if (process.platform !== 'linux') return [];
  return readdirSync('/proc')
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid && carriesMarker(pid, markers, files));
}

/**
 * Pids of live processes whose environment or argv mentions one of `markers` (paths unique to
 * this run), excluding this process — the leak check's survivor detector. Linux reads /proc;
 * elsewhere it returns [].
 */
export function runProcesses(...markers: string[]): number[] {
  return scanProc(markers, ['environ', 'cmdline']);
}

/**
 * SIGKILL every live process the run started: those whose ENVIRONMENT carries a marker — inherited
 * from the run, so it is a real fingerprint. An argv mention alone is not (someone's
 * `tail -f <run dir>/daemon.log`), so such a process is never killed. Each pid is re-checked
 * right before its kill, and only that pid is signalled — never its group — so a pid that exited
 * and was reused by an unrelated process in between is left alone. Synchronous: safe on exit.
 * Elsewhere than Linux only tracked children are killed (`cleanupTestRun`).
 */
export function sweepRunProcesses(...markers: string[]): void {
  for (const pid of scanProc(markers, ['environ'])) {
    if (!carriesMarker(pid, markers, ['environ'])) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Kill tracked children, then remove every dir `tempDir` handed out. Synchronous, never throws. */
export function cleanupTestRun(): void {
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) killGroupAndPid(proc.pid);
  children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}
