// daemon-runtime/remote-hub: the daemon-host side of the remote ctl feature (hub mode =
// `control.remote_machines` non-empty; docs/specs/2026-10-28-remote-ctl-server.md §4, §5, §6).
//
// What lives here is the impure glue around the pure model in ../remote-routes.ts and
// ../remote-hub-model.ts: the `remote-record`/`remote-status` socket answers, the bounded
// `tg-remote hub …` spawns, and the small status facts file. A machine without
// `control.remote_machines` never reaches any of it: `hubMachines` answers [] synchronously
// (no spawn, no file read), so the local path stays byte-identical.
//
// Hub replies never touch routes.json, sessions.json or last-user-target.json: remote locators are
// machine-local and are never compared with local ones.

import { join } from "path"
import { parseHistory, type HistoryRecord } from "../../replies/history"
import { appendHistoryFile } from "../../replies/history-file"
import { parseRunInfo } from "../code-freshness"
import type { SinkResult } from "../delivery-ledger"
import { resolveRemoteMode } from "../remote-config"
import {
  buildDeliverRequest,
  factsOf,
  formatHubStatus,
  HUB_DELIVER_TIMEOUT_MS,
  HUB_HELLO_TIMEOUT_MS,
  noteDeliver,
  noteRecordApplied,
  parseHelloRun,
  parseRemoteStatus,
  sinkResultOf,
  verdictOfHubRun,
  type HubHello,
  type HubMachine,
  type HubRun,
  type RemoteStatusFacts,
} from "../remote-hub-model"
import { applyRemoteRoutes, MACHINE_RE, newHistoryRows, parseRemoteRecord, remoteHistoryRows, type RemoteRouteEntry, type RemoteStoreIo } from "../remote-routes"
import { fsRoutesLockIo } from "../routes"
import { atomicWrite, log, readFileOrNull, type Ctx } from "./ctx-io"

type Env = Record<string, string | undefined>

// --- Which machines does this daemon serve? -----------------------------------------------------

const resolvedMachines = new Map<string, HubMachine[]>()

// `name=target` names only, for the moment the offline checker itself cannot answer: a hub whose
// config cannot be re-checked must still refuse to auto-inject a reply, so it keeps the names.
function namesOnly(raw: string): HubMachine[] {
  return raw
    .split(",")
    .map((entry) => entry.split("=", 2).map((s) => s.trim()))
    .filter(([name]) => MACHINE_RE.test(name ?? ""))
    .map(([name, target]) => ({ name, target: target ?? "?" }))
}

/**
 * The machines `control.remote_machines` names, resolved from CONFIG (never from a socket line).
 * [] and no side effect when the key is absent. The first answer of the offline checker is kept for
 * the life of the process, like every other config value the daemon loaded at start.
 */
export function hubMachines(ctx: Ctx, env: Env = process.env): HubMachine[] {
  const raw = ctx.cfg.remoteMachines
  if (raw === undefined) return []
  const known = resolvedMachines.get(raw)
  if (known) return known
  const mode = resolveRemoteMode(ctx.cfg, env, { configDir: ctx.configDir })
  if (mode.mode !== "hub") return namesOnly(raw)
  resolvedMachines.set(raw, mode.remoteMachines)
  return mode.remoteMachines
}

// --- tg-remote spawns ----------------------------------------------------------------------------

// The launcher next to this checkout, else the test seam. `python3 -I`: isolated mode, so nothing in
// the daemon's cwd or PYTHON* environment can shadow the package (spec §4.3).
function remoteArgv(env: Env, rest: string[]): string[] {
  const launcher = env.TG_REMOTE_BIN || join(import.meta.dir, "..", "..", "..", "tg-remote")
  return ["python3", "-I", launcher, ...rest]
}

function childEnv(ctx: Ctx, env: Env): Record<string, string> {
  const merged = { ...env, TG_CTL_CONFIG_DIR: ctx.configDir }
  return Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined))
}

function trySpawn(ctx: Ctx, rest: string[], env: Env) {
  try {
    return Bun.spawn(remoteArgv(env, rest), { env: childEnv(ctx, env), stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true })
  } catch (err) {
    log(`remote: cannot start tg-remote ${rest[0] ?? ""}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Run one `tg-remote` command with a hard deadline: own process group, killed whole on timeout.
 * `stdin`: the single JSON request line (none: closed at once). Never throws.
 */
export async function runRemote(ctx: Ctx, rest: string[], stdin: string | undefined, timeoutMs: number, env: Env = process.env): Promise<HubRun> {
  const proc = trySpawn(ctx, rest, env)
  if (proc === null) return { started: false, stdout: "", exitCode: null, timedOut: false }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill(9)
    }
  }, timeoutMs)
  try {
    if (stdin !== undefined) proc.stdin.write(stdin)
    await proc.stdin.end()
  } catch {
    // The child may have exited before reading: its answer (or lack of one) decides.
  }
  try {
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    return { started: true, stdout, exitCode: timedOut ? null : exitCode, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

// --- Status facts --------------------------------------------------------------------------------

function readFacts(ctx: Ctx): RemoteStatusFacts {
  return parseRemoteStatus(readFileOrNull(ctx.paths.remoteStatus))
}

function updateFacts(ctx: Ctx, change: (facts: RemoteStatusFacts) => RemoteStatusFacts): void {
  try {
    atomicWrite(ctx.paths.remoteStatus, JSON.stringify(change(readFacts(ctx))))
  } catch (err) {
    // Informational only: a status file that cannot be written never fails a record or a reply.
    log(`remote: status facts not written: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- Socket lines --------------------------------------------------------------------------------

export type RemoteReply = { ok: true; [key: string]: unknown } | { ok: false; code: string; detail: string }

const badRequest = (detail: string): RemoteReply => ({ ok: false, code: "BAD_REQUEST", detail })

function storeIo(ctx: Ctx): RemoteStoreIo {
  return {
    read: () => readFileOrNull(ctx.paths.remoteRoutes),
    write: (content) => atomicWrite(ctx.paths.remoteRoutes, content),
    lock: fsRoutesLockIo(`${ctx.paths.remoteRoutes}.lock`),
  }
}

// The peer is re-resolved from this host's own config: the line is only a claim.
function checkPeer(ctx: Ctx, peer: unknown): string | RemoteReply {
  if (typeof peer !== "string") return badRequest("peer must be a string")
  if (!hubMachines(ctx).some((m) => m.name === peer)) return { ok: false, code: "PEER_UNKNOWN", detail: "this peer is not in control.remote_machines" }
  return peer
}

// Rows appended (0 for a replay), or null when the history file could not be written.
function appendRemoteHistory(ctx: Ctx, rows: HistoryRecord[]): number | null {
  try {
    const fresh = newHistoryRows(rows, parseHistory(readFileOrNull(ctx.paths.history)))
    return appendHistoryFile(ctx.paths.history, fresh) ? fresh.length : null
  } catch (err) {
    log(`remote: history not written: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Apply `{kind:'remote-record',peer,record}`: upsert the remote route and append its history rows. */
export function applyRemoteRecordLine(ctx: Ctx, line: Record<string, unknown>, now = Date.now()): RemoteReply {
  const extra = Object.keys(line).find((k) => !["kind", "peer", "record"].includes(k))
  if (extra !== undefined) return badRequest(`unknown field ${extra.slice(0, 40)}`)
  const peer = checkPeer(ctx, line.peer)
  if (typeof peer !== "string") return peer
  const parsed = parseRemoteRecord(line.record, peer)
  if (!parsed.ok) return badRequest(parsed.error)
  const { record } = parsed
  const routes = applyRemoteRoutes(storeIo(ctx), record, peer)
  if (!routes.ok) return { ok: false, code: routes.busy ? "INTERNAL" : "BAD_REQUEST", detail: routes.error }
  // History after the routes, deduped against what is stored: a replayed record (the client journals
  // anything it did not see acknowledged) heals a history append that failed the first time.
  const history = appendRemoteHistory(ctx, remoteHistoryRows(record, peer))
  if (history === null) return { ok: false, code: "INTERNAL", detail: "history could not be written" }
  updateFacts(ctx, (facts) => noteRecordApplied(facts, peer, routes.applied, now))
  log(`remote: record from ${peer}: ids=${record.ids.map((i) => i.id).join(",")} applied=${routes.applied} history=${history}`)
  return { ok: true, applied: routes.applied, routes: routes.routes, history }
}

/** Answer `{kind:'remote-status',peer}` with the daemon facts and what this peer has recorded. */
export function remoteStatusReply(ctx: Ctx, line: Record<string, unknown>): RemoteReply {
  const extra = Object.keys(line).find((k) => !["kind", "peer"].includes(k))
  if (extra !== undefined) return badRequest(`unknown field ${extra.slice(0, 40)}`)
  const peer = checkPeer(ctx, line.peer)
  if (typeof peer !== "string") return peer
  const info = parseRunInfo(readFileOrNull(ctx.paths.runInfo))
  const code = info !== null && info.pid === process.pid ? info.commit : null
  return { ok: true, daemon: { up: true, pid: process.pid, code }, remote: factsOf(readFacts(ctx), peer) }
}

// --- Reply delivery ------------------------------------------------------------------------------

/**
 * Type `text` into the session that sent remote message `hit`, through `tg-remote hub deliver`. The
 * ledger claim is the caller's (deliverInboundOnce); this only maps the answer. The request, the
 * reply text included, is never logged.
 */
export async function sendRemoteDeliver(ctx: Ctx, hit: RemoteRouteEntry, text: string, inboundId: number, env: Env = process.env): Promise<SinkResult> {
  const request = buildDeliverRequest(hit.chat, inboundId, hit.route, text, hit.id)
  const run = await runRemote(ctx, ["hub", "deliver", hit.machine], JSON.stringify(request), HUB_DELIVER_TIMEOUT_MS, env)
  const verdict = verdictOfHubRun(run)
  log(`remote: deliver tg#${inboundId} → ${hit.machine}: ${verdict.outcome}${"detail" in verdict && verdict.detail ? ` (${verdict.detail})` : ""}`)
  updateFacts(ctx, (facts) => noteDeliver(facts, hit.machine, verdict.outcome, Date.now()))
  return sinkResultOf(verdict, hit.machine, inboundId)
}

// --- `tg-ctl status` -----------------------------------------------------------------------------

async function probeHello(ctx: Ctx, machine: string, env: Env): Promise<HubHello> {
  const started = Date.now()
  const run = await runRemote(ctx, ["hub", "hello", machine], undefined, HUB_HELLO_TIMEOUT_MS, env)
  return parseHelloRun(run, Date.now() - started)
}

/** The hub block of `tg-ctl status`: [] on a machine that serves no remote machine. Probes run in parallel. */
export async function hubStatusLines(ctx: Ctx, env: Env = process.env): Promise<string[]> {
  const machines = hubMachines(ctx, env)
  if (machines.length === 0) return []
  const probes = await Promise.all(machines.map(async (m) => [m.name, await probeHello(ctx, m.name, env)] as const))
  return formatHubStatus(machines, readFacts(ctx), Object.fromEntries(probes), Date.now())
}
