// Client side of the remote ctl record (docs/specs/2026-10-28-remote-ctl-server.md §4.1, §5): PURE.
//
// After the local send the sender's route + history go to the ctl server so a Telegram reply to
// the message is typed into this machine's session. This module only shapes the record that
// `tg-remote client record` reads on stdin and maps that tool's result to a stderr warning; the
// spawn lives in the caller. The Python server validates every string against closed rules
// (labels: no control characters, bounded length; text: no NUL, no lone surrogate) and rejects the
// WHOLE record on one violation, so what a local file tolerates is cleaned here instead of
// losing the route of an otherwise delivered message.
import { randomUUID } from "node:crypto"
import type { OutboxRoute } from "../../transport/outbox"

/** history.text cap, UTF-8 bytes (spec §4.1); the same cap the Python client enforces. */
export const HISTORY_TEXT_CAP_BYTES = 256 * 1024
/** Hard cap on one `tg-remote client record` process, python start included (never retried). */
export const RECORD_TIMEOUT_MS = 12_000
/** The server reply cap (spec §4): anything longer is not a reply line. */
const REPLY_CAP_BYTES = 64 * 1024
const LABEL_LIMIT = 256
const CWD_LIMIT = 4096
/** The server rejects a record naming more ids; the first ones keep their route rather than losing all of them. */
const MAX_RECORD_IDS = 100

export interface RemoteRecordInput {
  chat: string
  ids: { id: number; threadId: number | null }[]
  route: OutboxRoute
  /** `ts` is the local history row's unix SECONDS. `targetAgent` is the local, un-namespaced agent name. */
  history: { text: string; targetAgent?: string; groupToken?: string; ts: number }
  /** The session's own names, WITHOUT the machine namespace. */
  name: { primary: string; secondary: string | null }
  machine: string
}

export interface RemoteRecord {
  chat: string
  ids: { id: number; threadId: number | null }[]
  route: Record<string, string | number>
  history: { text: string; targetAgent?: string; groupToken: string; truncated: boolean }
  name: { primary: string; secondary: string | null }
  /** Unix MILLISECONDS (the wire unit). */
  ts: number
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu

/** A single-line label: control characters become spaces, lone surrogates U+FFFD, cut at `limit` code points. */
function cleanLabel(value: string, limit: number): string {
  return [...value.toWellFormed().replace(CONTROL, " ")].slice(0, limit).join("")
}

/** Free text: NUL removed and lone surrogates replaced (the wire rejects both), cut at 256 KiB on a character boundary. */
export function capHistoryText(text: string): { text: string; truncated: boolean } {
  const clean = text.replaceAll("\u0000", "").toWellFormed()
  const bytes = new TextEncoder().encode(clean)
  if (bytes.length <= HISTORY_TEXT_CAP_BYTES) return { text: clean, truncated: false }
  // The byte at the cut starts a character, or continues one that began before it: back up to its start.
  let end = HISTORY_TEXT_CAP_BYTES
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true }
}

function routeBody(route: OutboxRoute): RemoteRecord["route"] {
  const body: RemoteRecord["route"] = {}
  const paneId = cleanLabel(route.paneId ?? "", 64)
  if (paneId) body.paneId = paneId
  const cwd = cleanLabel(route.cwd ?? "", CWD_LIMIT)
  if (cwd) body.cwd = cwd
  for (const key of ["agentPid", "serverPid", "panePid"] as const) {
    const pid = route[key]
    if (typeof pid === "number" && Number.isInteger(pid) && pid >= 0) body[key] = pid
  }
  const sessionKey = cleanLabel(route.sessionKey ?? "", 512)
  if (sessionKey) body.sessionKey = sessionKey
  const parent = cleanLabel(route.parentPaneId ?? "", 64)
  if (parent) body.parentPaneId = parent
  return body
}

/**
 * The record for one send, or null when it has no routable identity (no session name: a reply
 * could be typed nowhere, and the server requires `name.primary`).
 */
export function buildRemoteRecord(input: RemoteRecordInput): RemoteRecord | null {
  const primary = cleanLabel(input.name.primary, LABEL_LIMIT)
  if (!primary) return null
  const secondary = input.name.secondary === null ? "" : cleanLabel(input.name.secondary, LABEL_LIMIT)
  const text = capHistoryText(input.history.text)
  const agent = cleanLabel(`${input.machine}/${input.history.targetAgent || primary}`, LABEL_LIMIT)
  return {
    chat: input.chat,
    ids: input.ids.slice(0, MAX_RECORD_IDS),
    route: routeBody(input.route),
    history: {
      text: text.text,
      targetAgent: agent,
      groupToken: cleanLabel(input.history.groupToken || randomUUID(), LABEL_LIMIT),
      truncated: text.truncated,
    },
    name: { primary, secondary: secondary || null },
    ts: input.history.ts * 1000,
  }
}

export interface RemoteRunResult {
  stdout: string
  stderr: string
  /** null when the process was killed (timeout) or never reported a code. */
  exitCode: number | null
  timedOut: boolean
  /** Set when the process could not be started at all (python3 or the launcher is missing). */
  spawnError?: string
}

type RecordStatus = "recorded" | "duplicate" | "journaled"

function parseRecordLine(stdout: string): { status: RecordStatus; detail: string; journal: string } | null {
  if (Buffer.byteLength(stdout) > REPLY_CAP_BYTES) return null
  let doc: unknown
  try {
    doc = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (typeof doc !== "object" || doc === null) return null
  const { status, detail, journal } = doc as Record<string, unknown>
  if (status !== "recorded" && status !== "duplicate" && status !== "journaled") return null
  return { status, detail: typeof detail === "string" ? detail : "", journal: typeof journal === "string" ? journal : "" }
}

function failureCause(run: RemoteRunResult): string {
  if (run.spawnError !== undefined) return run.spawnError
  if (run.timedOut) return `timed out after ${RECORD_TIMEOUT_MS / 1000} s`
  if (run.exitCode !== 0) {
    const first = run.stderr.trim().split("\n")[0]
    return `tg-remote exited ${run.exitCode}${first ? `: ${first}` : ""}`
  }
  return "unparsable output"
}

/**
 * What a send prints about its record: null when the server took it (`recorded`/`duplicate`), the
 * tool's own stderr warning (every line prefixed `tg:`) when it journaled it, and the honest
 * "send is out, record NOT journaled" line when the tool could not even say that. Always exit 0:
 * the message is already in Telegram.
 */
export function describeRecordRun(run: RemoteRunResult, server: string): string | null {
  const reply = run.spawnError !== undefined || run.timedOut || run.exitCode !== 0 ? null : parseRecordLine(run.stdout)
  if (reply === null) return `tg: ctl server ${server} unreachable (${failureCause(run)}); send is out, record NOT journaled`
  if (reply.status !== "journaled") return null
  const lines = run.stderr.split("\n").filter((line) => line.trim() !== "")
  if (lines.length > 0) return lines.map((line) => `tg: ${line}`).join("\n")
  const where = reply.journal ? ` at ${reply.journal}` : ""
  return `tg: ctl server ${server}: record journaled${reply.detail ? ` (${reply.detail})` : ""}${where}`
}
