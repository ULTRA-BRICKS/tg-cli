// `tg-ctl status` on a ctl client (docs/specs/2026-10-28-remote-ctl-server.md §6) and the typed
// refusals of the operations that need the daemon this machine does not run.
//
// The `server:` block is built ONLY from what `tg-remote client status` measured — a real round trip
// to the server (SSH, the forced `tg-remote server --peer`, the daemon hook socket behind it). A tool
// that cannot be started, times out, exits non-zero, or answers with anything but `ok:true` is an
// unreachable server (exit 69); there is no canned "ok" anywhere in this file.
import { isRecord } from "../guards"
import { runRemoteClient, type RemoteClientRun } from "../remote-client-spawn"

export type ClientStatusRun = RemoteClientRun & { spawnError?: string }

/** Hard cap on one `tg-remote client status` process (the tool's own deadline is shorter). */
export const STATUS_TIMEOUT_MS = 12_000
/** EX_UNAVAILABLE: the ctl server cannot be reached. */
export const EXIT_SERVER_UNREACHABLE = 69

interface ClientTarget {
  server: string
  machine: string
}

export interface ClientStatusReport {
  lines: string[]
  exitCode: 0 | 69
}

const iso = (ms: number): string => new Date(ms).toISOString()
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** `ctl server <server>: <op> is not supported for remote clients` (stderr, exit 69 — except `ask`, which keeps its own exit). */
export function clientRefusalLine(server: string, op: string): string {
  return `tg-ctl: ctl server ${server}: ${op} is not supported for remote clients`
}

function failureCause(run: ClientStatusRun, body: Record<string, unknown> | null): string {
  if (run.spawnError !== undefined) return run.spawnError
  if (run.timedOut) return `timed out after ${STATUS_TIMEOUT_MS / 1000} s`
  if (body && body.ok === false && typeof body.code === "string") return `${body.code}: ${typeof body.detail === "string" ? body.detail : "no detail"}`
  if (run.exitCode !== 0) {
    const first = run.stderr.trim().split("\n")[0]
    return `tg-remote exited ${run.exitCode}${first ? `: ${first}` : ""}`
  }
  return "unparsable output"
}

function parseBody(stdout: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(stdout.trim())
    return isRecord(doc) ? doc : null
  } catch {
    return null
  }
}

// The tool may report the server's reply flat or nested under `reply`; the journal as a bare depth
// or `{depth, oldest}`. Either shape is read, the first one that carries the field wins.
function pick(body: Record<string, unknown>, key: string): unknown {
  if (body[key] !== undefined) return body[key]
  return isRecord(body.reply) ? body.reply[key] : undefined
}

function daemonLine(daemon: unknown): string {
  if (!isRecord(daemon) || typeof daemon.up !== "boolean") return "  daemon: unknown (the server did not report it)"
  if (!daemon.up) return "  daemon: DOWN (records are journaled until it is back)"
  const detail = [isNumber(daemon.pid) ? `pid ${daemon.pid}` : null, typeof daemon.code === "string" ? `code ${daemon.code}` : null].filter(Boolean)
  return `  daemon: up${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`
}

function journalLine(journal: unknown): string {
  const depth = isNumber(journal) ? journal : isRecord(journal) && isNumber(journal.depth) ? journal.depth : null
  if (depth === null) return "  journal: unknown (the tool did not report it)"
  if (depth === 0) return "  journal: empty"
  const oldest = isRecord(journal) && isNumber(journal.oldest) ? `, oldest ${iso(journal.oldest)}` : ""
  return `  journal: ${depth} pending${oldest}`
}

function recordLines(remote: unknown): string[] {
  if (!isRecord(remote)) return ["  records: unknown (the server did not report them)"]
  const last = isNumber(remote.lastRecordAt) ? `last ${iso(remote.lastRecordAt)}` : "none yet"
  const lines = [`  records: ${isNumber(remote.records) ? remote.records : "?"} recorded, ${last}`]
  const deliver = remote.lastDeliver
  lines.push(isRecord(deliver) && isNumber(deliver.at) ? `  last deliver: ${String(deliver.result)} at ${iso(deliver.at)}` : "  last deliver: none yet")
  return lines
}

/** The `server:` block and exit code for one finished `tg-remote client status` run. Pure. */
export function describeClientStatus(target: ClientTarget, run: ClientStatusRun): ClientStatusReport {
  const header = `server: ${target.server} (ssh stdio, machine ${target.machine})`
  const body = run.spawnError !== undefined || run.timedOut ? null : parseBody(run.stdout)
  if (!body || body.ok !== true || run.exitCode !== 0) {
    return { lines: [header, `server: unreachable (${failureCause(run, body)})`], exitCode: EXIT_SERVER_UNREACHABLE }
  }
  const peer = pick(body, "peer")
  return {
    lines: [
      header,
      `  link: ok${typeof peer === "string" ? ` (peer ${peer})` : ""}`,
      daemonLine(pick(body, "daemon")),
      journalLine(body.journal),
      ...recordLines(pick(body, "remote")),
    ],
    exitCode: 0,
  }
}

/** Ask the server (through the tool) and describe the answer. Never throws: a start failure is an unreachable server. */
export async function reportClientStatus(target: ClientTarget, configDir: string): Promise<ClientStatusReport> {
  try {
    return describeClientStatus(target, await runRemoteClient("status", { timeoutMs: STATUS_TIMEOUT_MS, configDir }))
  } catch (error) {
    return describeClientStatus(target, { stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) })
  }
}
