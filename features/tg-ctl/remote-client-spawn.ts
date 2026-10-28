// The one place TypeScript starts `tg-remote client <op>` (docs/specs/2026-10-28-remote-ctl-server.md §4.3).
//
// TS never builds an ssh argv: the Python tool owns the transport, the journal and every ssh option.
// What is fixed here is how THIS process starts it:
//   * `python3 -I <launcher> client <op>` — argv list, no shell; -I (isolated) keeps the sender's cwd
//     and every PYTHON* variable out of the interpreter, so a planted ./tgcli/ never runs;
//   * its own process group and a hard wall-clock cap that includes interpreter start: on timeout
//     the whole group (python and the ssh it started) is killed;
//   * never retried — the caller decides what a failure means.
// The launcher is `$TG_REMOTE_BIN` (the test seam) else `<repo root>/tg-remote`.
import { join } from "path"

export interface RemoteClientRun {
  stdout: string
  stderr: string
  /** null when the process was killed (timeout) or never reported a code. */
  exitCode: number | null
  timedOut: boolean
}

export type RemoteClientOp = "record" | "hello" | "status"

type Env = Record<string, string | undefined>

export function remoteLauncher(env: Env): string {
  return env.TG_REMOTE_BIN || join(import.meta.dir, "..", "..", "tg-remote")
}

export function remoteClientArgv(op: RemoteClientOp, env: Env): string[] {
  return ["python3", "-I", remoteLauncher(env), "client", op]
}

/** Read a pipe to its end; `cancel` abandons it (the pending read then ends with what arrived so far). */
function collect(stream: ReadableStream<Uint8Array>): { text: Promise<string>; cancel: () => void } {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const text = (async () => {
    let collected = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return collected + decoder.decode()
      collected += decoder.decode(chunk.value, { stream: true })
    }
  })()
  return { text, cancel: () => void reader.cancel().catch(() => undefined) }
}

/** After the kill, how long the pipes get to close before their contents are given up on. */
const TIMEOUT_GRACE_MS = 2000

function killGroup(proc: { pid: number; kill: (signal: "SIGKILL") => void }): void {
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    proc.kill("SIGKILL")
  }
}

/**
 * Run `tg-remote client <op>` with `stdin` (when given) and a hard deadline. Rejects only when the
 * process cannot be started at all; a timeout is a normal result with `timedOut: true`.
 */
export async function runRemoteClient(
  op: RemoteClientOp,
  opts: { stdin?: string; timeoutMs: number; configDir: string; env?: Env },
): Promise<RemoteClientRun> {
  const env = { ...(opts.env ?? process.env), TG_CTL_CONFIG_DIR: opts.configDir }
  const proc = Bun.spawn(remoteClientArgv(op, env), {
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    detached: true, // own session: `-pid` below reaches python AND the ssh it spawned
  })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let abandon: ReturnType<typeof setTimeout> | undefined
  const out = collect(proc.stdout)
  const err = collect(proc.stderr)
  const gaveUp = new Promise<RemoteClientRun>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      killGroup(proc)
      // A process that escaped the group could still hold the pipes open: stop waiting for them, and
      // let go of them so they cannot keep this process alive either.
      abandon = setTimeout(() => {
        out.cancel()
        err.cancel()
        proc.unref()
        resolve({ stdout: "", stderr: "", exitCode: null, timedOut: true })
      }, TIMEOUT_GRACE_MS)
    }, opts.timeoutMs)
  })
  const finished = Promise.all([out.text, err.text, proc.exited]).then(
    ([stdout, stderr, exitCode]): RemoteClientRun => ({ stdout, stderr, exitCode: timedOut ? null : exitCode, timedOut }),
  )
  try {
    return await Promise.race([finished, gaveUp])
  } finally {
    clearTimeout(timer)
    clearTimeout(abandon)
  }
}
