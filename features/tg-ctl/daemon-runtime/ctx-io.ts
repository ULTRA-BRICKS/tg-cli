// daemon-runtime/ctx-io: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { isBareWindowName } from "../session-name"
import { type HistoryRecord } from "../../replies/history"
import { appendHistoryFile } from "../../replies/history-file"
import { type VoiceConfig } from "../voice"
import type { ControlConfig, CtlPaths, TargetPane } from "../types"

// --- Pure helpers (exported for tests) ---

// Same .env shape `tg` reads (KEY=VALUE lines, # comments). Reimplemented
// locally on purpose: importing from ./tg would drag the entire sender module
// graph into the daemon for a 15-line parser.
export function loadEnv(filePath: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const lines = readFileSync(filePath, "utf8").split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (key) env[key] = value
    }
  } catch {
    // file doesn't exist — skip
  }
  return env
}

export interface StartFlags {
  paneId?: string
  cwd?: string
  session?: string
}

// `tg` passes `--pane ''` when TMUX_PANE is unset — empty values are skipped,
// not stored, so the registration never carries hollow fields.
export function parseStartFlags(args: string[]): StartFlags {
  const out: StartFlags = {}
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1]
    if (!value) continue
    if (args[i] === "--pane") {
      out.paneId = value
      i++
    } else if (args[i] === "--cwd") {
      out.cwd = value
      i++
    } else if (args[i] === "--session") {
      out.session = value
      i++
    }
  }
  return out
}

// Offset file content → next getUpdates offset. Malformed/absent → 0
// (Telegram treats 0 as "no confirmed updates yet").
export function readOffset(content: string | null): number {
  if (content === null) return 0
  const trimmed = content.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 0
}

// One line per candidate so the ambiguity reply names realistic choices.
export function formatCandidates(candidates: TargetPane[]): string {
  return candidates
    .map((c) => {
      // Lead with the user-set window name — the label the CTO recognizes
      // (tg-cli#75) — but ONLY when it's a real name, not a bare default
      // (a number / shell command / version string). Applying the picker's
      // isBareWindowName keeps this diagnostic line in sync with the buttons.
      const win = isBareWindowName(c.pane.windowName) ? "" : `${c.pane.windowName} `
      return `${win}${c.pane.sessionName}:${c.pane.windowIndex} ${c.pane.paneId} (${c.agent}, ${c.pane.panePath})`
    })
    .join("\n")
}

// --- Effectful plumbing (only ever invoked from the import.meta.main block) ---

export interface Ctx {
  configDir: string
  paths: CtlPaths
  cfg: ControlConfig
  voice: VoiceConfig
  token: string
  chatId: number
  apiBase: string
  botId: string
  home: string
  cwd: string
}

// Log text can carry untrusted values (hook payload lines, Telegram descriptions). A line
// break would let it forge a second, timestamped record, so every line terminator is escaped.
function escapeLineBreaks(msg: string): string {
  return msg.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/[\u2028\u2029]/g, "?")
}

export function log(msg: string): void {
  // codeql[js/log-injection] Fixed, not waived: escapeLineBreaks above rewrites every CR, LF, U+2028 and U+2029 to visible text, so
  // an untrusted hook line or Telegram description cannot start a forged record (tests/codeql-hardening.test.ts).
  // The query only models a replace(/\n/, "") deletion as a sanitizer, and deleting would lose the break marker.
  console.error(`[${new Date().toISOString()}] ${escapeLineBreaks(msg)}`)
}

export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export function readFileTailOrNull(path: string, maxBytes: number): string | null {
  let fd: number | null = null
  try {
    // O_NONBLOCK keeps a FIFO from stalling the open; the type/size are checked on the OPENED
    // descriptor (identity is fixed there; the content itself can still change afterwards).
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    const size = stat.size
    const length = Math.min(Math.max(0, maxBytes), size)
    const offset = Math.max(0, size - length)
    const buf = Buffer.allocUnsafe(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const chunkBytes = readSync(fd, buf, bytesRead, length - bytesRead, offset + bytesRead)
      if (chunkBytes <= 0) break
      bytesRead += chunkBytes
    }
    return buf.subarray(0, bytesRead).toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore close failure on best-effort hook telemetry
      }
    }
  }
}

export function readJsonObjectOrNull(path: string): Record<string, unknown> | null {
  const raw = readFileOrNull(path)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function hasClaudeStatusLineCommand(settings: Record<string, unknown>): boolean {
  const statusLine = settings.statusLine
  if (!statusLine || typeof statusLine !== "object" || Array.isArray(statusLine)) return false
  const command = (statusLine as Record<string, unknown>).command
  return typeof command === "string" && command.trim().length > 0
}

// Crash-safe write: stage into a sibling temp file then rename(2) over the target.
// rename is atomic on the same filesystem, so a reader (or a daemon that died
// mid-write) sees either the old file or the new one whole — never a torn JSON the
// next startup would fail to parse. Used for the durable question state, which is
// rewritten on every mutation of a hot path.
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`
  // codeql[js/http-to-file-access] Intentional: atomicWrite is the daemon's own state-file writer. Every caller passes a fixed
  // CtlPaths path (questions, deferred, auth-pending, ...) and content it serialized itself; no remote
  // value chooses the path. 0600 temp file + rename. Covered by ctl-question-durable-integration.
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

// Append history records to the JSONL log, trimmed to the bound, under the
// history lock it shares with `tg`'s outbound writer (tg-cli#136). BEST-EFFORT:
// the recall log is purely informational (like routes), so a read/write error
// must never break the inbound inject path.
export function appendHistory(path: string, records: HistoryRecord[]): void {
  try {
    if (!appendHistoryFile(path, records)) log(`history: lock contended, ${records.length} inbound row(s) not recorded`)
  } catch {
    // best-effort: never let history bookkeeping break an inject
  }
}

export function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

// Alive unless kill(2) answers ESRCH. EPERM means the pid exists but this process may not signal it
// (another uid, a Landlock signal domain) — reading that as dead made `status` call a running daemon
// a stale pidfile (#748). An error with no `syscall` was thrown before kill(2) ran (a pid outside
// pid_t): no process has that pid.
export function kill0(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err instanceof Error && "syscall" in err && err.syscall === "kill" && "code" in err && err.code !== "ESRCH"
  }
}

export function api(ctx: Ctx): string {
  return `${ctx.apiBase}/bot${ctx.token}`
}

// Spawn a binary ASYNCHRONOUSLY (Bun.spawn, not spawnSync) with a timeout +
// pipes, NEVER throwing. Async is the key: ffmpeg/whisper can take many seconds,
// and spawnSync would BLOCK the daemon's single event loop — freezing the
// Telegram poll loop AND the Unix hook server (q→buttons) until the child exits.
// `await proc.exited` yields the loop so hooks and other control messages keep
// flowing during a long transcription. The timeout kills the child (and so the
// awaited promise resolves) instead of wedging. A missing executable makes
// Bun.spawn throw ENOENT, which — uncaught — would bubble to the poll loop AFTER
// the offset was persisted and silently lose the note; caught here → exit 127.
export async function spawnGuarded(
  argv: string[],
  timeoutMs: number,
  opts: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    const proc = child
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGKILL")
    }, timeoutMs)
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (timedOut) return { exitCode: 124, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` }
      return { exitCode: proc.exitCode ?? 1, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: `spawn ${argv[0]} failed: ${err}` }
  }
}

// The resolved tg-cli config dir. SINGLE source of truth so the sentinel that
// `install-hooks` writes and the one the daemon self-heal reads resolve identically
// under the same environment (a `TG_CTL_CONFIG_DIR` set in only one of the two
// process contexts would still send them to different dirs — that is a launch-env
// mismatch, not a code divergence). Absolute so `enable` can pin it into the
// launchd/systemd unit.
export function resolveConfigDir(home: string): string {
  return resolve(process.env.TG_CTL_CONFIG_DIR || join(home, ".config", "tg-cli"))
}

export function codexConfigDir(home: string): string {
  const override = process.env.CODEX_HOME?.trim()
  return override ? override : join(home, ".codex")
}

export async function readStdinText(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let out = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      out += chunk
    })
    process.stdin.on("end", () => resolve(out))
    process.stdin.on("error", reject)
  })
}
