// daemon-runtime/daemon-lock: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, openSync, readdirSync, readFileSync, statSync, type BigIntStats } from "fs"
import { flockPidsForInode } from "../lock"
import { kill0 } from "./ctx-io"

// Pid holding THIS config dir's flock, if any. The flock is the real singleton (spec §6); when
// the pidfile and even the unix socket are gone, the lock holder is still the live daemon.
// Linux reads the kernel's lock table (procFlockHolders); elsewhere lsof -t names a process with
// the file open. Do NOT skip process.pid: Telegram `/status` runs composeStatus inside the daemon,
// so the holder IS us — that is the pid to report (review finding).
export function lockHolderPid(lockPath: string): number | null {
  const holders = procFlockHolders(lockPath) ?? lsofOpeners(lockPath)
  return holders?.[0] ?? null
}

// Live pids with THIS lock file open per `lsof -t` — exit 1 with no output means nobody has it
// open. null when lsof cannot answer (missing, or any other failure).
export function lsofOpeners(lockPath: string): number[] | null {
  try {
    const r = Bun.spawnSync(["lsof", "-t", lockPath], { stdout: "pipe", stderr: "ignore" })
    const out = r.stdout ? new TextDecoder().decode(r.stdout).trim() : ""
    if (r.exitCode !== 0 && !(r.exitCode === 1 && out === "")) return null
    return out
      .split(/\s+/)
      .map(Number)
      .filter((pid) => pid > 0 && kill0(pid))
  } catch {
    return null
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT"
}

// Run `read`; a vanished target (ENOENT) yields `onMissing`, any other failure yields undefined.
function readOrMissing<T>(read: () => T, onMissing: T): T | undefined {
  try {
    return read()
  } catch (err) {
    return isENOENT(err) ? onMissing : undefined
  }
}

// Does one of `pid`'s open fds IS the lock file (same dev + ino)? A pid or fd that vanished meanwhile
// holds nothing (false); undefined = the pid cannot be inspected (e.g. EACCES).
function pidHasLockFileOpen(pid: number, lock: BigIntStats): boolean | undefined {
  const fds = readOrMissing(() => readdirSync(`/proc/${pid}/fd`), [])
  if (fds === undefined) return undefined
  for (const fd of fds) {
    const open = readOrMissing(() => statSync(`/proc/${pid}/fd/${fd}`, { bigint: true }), null)
    if (open === undefined) return undefined
    if (open && open.ino === lock.ino && open.dev === lock.dev) return true
  }
  return false
}

// Live pids holding a flock on THIS config dir's lock file, read WITHOUT taking it (tg-cli#490):
// /proc/locks names each flock's pid and inode, and a candidate counts only when one of its open
// fds IS the lock file (same dev + ino through /proc/<pid>/fd), which rules out an inode-number
// twin on another filesystem. A candidate that vanished meanwhile (ENOENT) holds nothing. No lock
// file means no holder. null = no confident answer, callers fall back: not Linux, /proc unreadable,
// or a holder this reader cannot inspect — another user's process (EACCES) or one the kernel
// cannot name here (pid 0) — never reported as "free".
export function procFlockHolders(lockPath: string): number[] | null {
  if (process.platform !== "linux") return null
  const lock = readOrMissing(() => statSync(lockPath, { bigint: true }), null)
  if (lock === undefined) return null
  if (lock === null) return []
  let table: string
  try {
    table = readFileSync("/proc/locks", "utf8")
  } catch {
    return null
  }
  const holders: number[] = []
  for (const pid of flockPidsForInode(table, lock.ino.toString())) {
    if (pid === 0) return null
    const hasOpen = pidHasLockFileOpen(pid, lock)
    if (hasOpen === undefined) return null
    if (hasOpen) holders.push(pid)
  }
  return holders
}

// Does `pid` hold THIS config dir's flock? On Linux a read of the kernel's lock table that never
// contends with a starting daemon. Elsewhere (macOS has no /proc/locks) `pid` must have the file
// open (lsof), and then the only exact "is it held" test is daemonLockFree — taking the lock for an
// instant; runDaemon's DAEMON_LOCK_GRACE_MS keeps that instant from costing a starting daemon its
// run. Without lsof this degrades to "held by anyone".
export function daemonLockHeldBy(lockPath: string, pid: number): boolean {
  const holders = procFlockHolders(lockPath)
  if (holders !== null) return holders.includes(pid)
  const openers = lsofOpeners(lockPath)
  if (openers !== null && !openers.includes(pid)) return false
  return !daemonLockFree(lockPath)
}

// flock(2) through bun:ffi — neither Bun nor Node expose it and macOS has no flock(1). The
// library is opened on first use, so CLI subcommands that never touch the lock never dlopen it.
export const LOCK_EX_NB = 6

// LOCK_EX (2) | LOCK_NB (4)
export const LOCK_UN = 8

export let flockSymbol: ((fd: number, op: number) => number) | undefined

export function flock(fd: number, op: number): number {
  if (!flockSymbol) {
    const lib = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6"
    flockSymbol = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock
  }
  return flockSymbol(fd, op)
}

// Is THIS config dir's flock free — provably no daemon holds it? Without a kernel lock table
// (daemonLockHeldBy's fallback) taking it for an instant is the only exact test: lsof lists any
// process with the file open, and an exited-but-unreaped child keeps answering kill(0) while the
// kernel has already dropped its lock. A daemon starting in that instant finds the lock taken and
// retries through DAEMON_LOCK_GRACE_MS (tg-cli#490). Read-only open: never creates or truncates the
// lock file; no file means no daemon ever took it. Any other failure (EACCES, fd exhaustion, flock
// unavailable via FFI) is NOT proof of "free" — it answers false, so callers fall back to trusting
// the live pid. TG_CTL_LOCK_PROBE_TEST_HOLD_MS (tests only) stretches the instant so that race is
// reproducible.
export function daemonLockFree(lockPath: string): boolean {
  let fd: number
  try {
    fd = openSync(lockPath, "r")
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "ENOENT"
  }
  try {
    if (flock(fd, LOCK_EX_NB) !== 0) return false
    const holdMs = Number(process.env.TG_CTL_LOCK_PROBE_TEST_HOLD_MS)
    if (holdMs > 0) Bun.sleepSync(holdMs)
    flock(fd, LOCK_UN)
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}
