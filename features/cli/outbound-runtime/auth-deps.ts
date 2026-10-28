// Real I/O for `tg auth` (features/auth/cli.ts owns the flow) — tg-cli#817: moved out of the
// `tg` entrypoint; split into small factories so each stays simple.
import { writeStdoutLine } from "../stdout-line"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname } from "path"
import { randomBytes } from "node:crypto"
import type { AuthDeps } from "../../auth/cli"
import { fsRoutesLockIo, withRoutesLock } from "../../tg-ctl/routes"
import { ctlPaths, readPidFile } from "../../tg-ctl/lock"

type InterruptDeps = Pick<AuthDeps, "onInterrupt">

// Ctrl-C runs the cleanups runAuth registered (its guarded pending-file release) — runAuth's own
// `finally` never runs on SIGINT.
function interruptDeps(): InterruptDeps {
  const interruptCleanups = new Set<() => void>()
  process.on("SIGINT", () => {
    for (const cleanup of interruptCleanups) {
      try {
        cleanup()
      } catch {
        // best effort on the way out — an expired record is harmless
      }
    }
    process.exit(130)
  })
  return {
    onInterrupt: (cleanup) => {
      interruptCleanups.add(cleanup)
      return () => void interruptCleanups.delete(cleanup)
    },
  }
}

function stdinLineReader(): AuthDeps["readLine"] {
  const lines = (async function* () {
    for await (const line of console) yield line
  })()
  return async () => {
    const next = await lines.next()
    return next.done ? null : next.value
  }
}

function fileDeps(): Pick<AuthDeps, "readFile" | "writeFileAtomic" | "removeFile"> {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8")
      } catch {
        return null
      }
    },
    writeFileAtomic: (p, content) => {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, content, { mode: 0o600 })
      renameSync(tmp, p)
    },
    removeFile: (p) => rmSync(p, { force: true }),
  }
}

// Same O_EXCL + pid-liveness lock as routes/history; a live holder → undefined (busy).
const lockDeps: Pick<AuthDeps, "withLock"> = {
  withLock: (lockPath, body) => {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
    return withRoutesLock(fsRoutesLockIo(lockPath), body, { onContended: "skip" })
  },
}

function readDaemonPidFile(configDir: string, botId: string): number | null {
  try {
    return readPidFile(readFileSync(ctlPaths(configDir, botId).pid, "utf8"))
  } catch {
    return null
  }
}

function pidIsAlive(pid: number): number | null {
  try {
    process.kill(pid, 0)
    return pid
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM" ? pid : null
  }
}

// The daemon's pidfile names a live pid → it is polling that bot (same probe as tg-ctl status's cheap path).
function daemonPidProbe(configDir: string): AuthDeps["daemonPid"] {
  return (botId) => {
    if (!botId) return null
    const pid = readDaemonPidFile(configDir, botId)
    if (pid === null) return null
    return pidIsAlive(pid)
  }
}

// A phone-scannable QR of the deep link, only when `qrencode` is installed and a human is looking.
const renderQr: AuthDeps["renderQr"] = (text) => {
  if (!process.stdout.isTTY || !Bun.which("qrencode")) return null
  const r = Bun.spawnSync(["qrencode", "-t", "UTF8", "-m", "1", text], { stdout: "pipe", stderr: "ignore", timeout: 5000 })
  return r.exitCode === 0 ? r.stdout.toString().trimEnd() : null
}

export function authDeps(configDir: string): AuthDeps {
  const interrupt = interruptDeps()
  const readLine = stdinLineReader()
  return {
    configDir,
    env: process.env,
    apiBase: process.env.TG_API_BASE || "https://api.telegram.org",
    fetch: (url, init) => fetch(url, init),
    ...fileDeps(),
    ...lockDeps,
    ...interrupt,
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readLine,
    daemonPid: daemonPidProbe(configDir),
    renderQr,
    out: (line) => writeStdoutLine(line),
    err: (line) => console.error(line),
  }
}
