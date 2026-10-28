// daemon-runtime/delivery: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, writeSync } from "fs"
import { dirname, join } from "path"
import { findAgentInPane, parseProcList } from "../discover"
import { buildTextInjectPlan, paneTypingKey, unsubmittedNotice } from "../inject"
import { messageStillTyped } from "../input-box"
import { permissionMenuUnchanged } from "../permission-menu"
import { defaultRegistryRoot, sendLiveMessage } from "../omp-live-runtime.mjs"
import { selectOriginalEndpoint, originalRequestId, type OriginalOmpTarget } from "../omp-live-routing"
import { connectAbducoSocket } from "../abduco-client"
import { injectIntoAbducoSession } from "../abduco-pty"
import { hostDisplayName, hostNameFromOriginId, hostOfPid, hostOriginId, hostsDir, hostsNotShownElsewhere, liveHosts, type HostRecord, type LiveHost } from "../host-registry"
import { readHostRecords } from "../host-registry-fs"
import { type Registry } from "../session-registry"
import { checkPaneSession, paneRefusalText, registryCurrentForPane } from "../session-target"
import { ancestorPidChain } from "../session-topics"
import { markAuthBound, markAuthFailed, serializePending, type AuthChat, type PendingAuth } from "../../auth/binding"
import { mergeEnvContent } from "../../auth/env-file"
import { fsRoutesLockIo, type RoutesLockIo, withRoutesLock } from "../routes"
import { parseHistory } from "../../replies/history"
import { applyLedgerEvents, compactLedger, decideDelivery, emptyLedgerState, ledgerKey, parseLedger, serializeLedgerEvents, sinkOutcomeEvent, type LedgerEvent, type SinkResult, type LedgerHold, type LedgerState } from "../delivery-ledger"
import { AUDIT_USAGE, buildAuditReport, formatAuditReport, logDeliveryIds, parseAuditArgs, transcriptCopies, type InjectedCopy } from "../delivery-audit"
import type { AgentKind, InjectStep, PaneInfo, ProcInfo } from "../types"
import { atomicWrite, fileMtimeMs, log, readFileOrNull, resolveConfigDir, type Ctx } from "./ctx-io"
import { SESSION_REFRESH_MIN_MS, listLiveOmpAgents, originalHosts, refreshOriginalHosts, refreshSessionRegistry, sessionRefreshAt } from "./session-registry"
import { SUBPROC_ENV, snapshot } from "./tmux-probe"
import { rootScriptPath } from "./root-script"

// --- Sessions a rig wrapper hosts in abduco OUTSIDE tmux (docs/specs/2026-09-30-harness-agnostic-control.md) ---
//
// The wrapper writes <config>/hosts/<name>.json; tg-ctl only READS it, and a record counts only
// while the process table still shows its abduco server with exactly one harness below it
// (liveHosts) — a crashed or exited session drops out without anything having to delete its record.
// Delivery types the message into the session's PTY through abduco's client socket.
export const hostIssuesLogged = new Set<string>()

export function logHostIssueOnce(key: string, message: string): void {
  if (hostIssuesLogged.has(key)) return
  hostIssuesLogged.add(key)
  log(message)
}

export function loadHostRecords(): HostRecord[] {
  const { records, rejected } = readHostRecords(hostsDir(resolveConfigDir(process.env.HOME ?? "~")), process.getuid?.() ?? -1)
  for (const r of rejected) logHostIssueOnce(`${r.file}:${r.reason}`, `host registry: ignoring ${r.file} — ${r.reason}`)
  return records
}

export function isUnixSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

// Every registered host the process table proves alive right now. `procs`: the discovery
// snapshot the caller already holds (this is called from inside hot paths, so it never scans).
export function listLiveHosts(procs: ProcInfo[]): LiveHost[] {
  const { live, skipped } = liveHosts(loadHostRecords(), procs, isUnixSocket)
  for (const s of skipped) logHostIssueOnce(`${s.name}:${s.reason}`, `host registry: ${s.name} is not live — ${s.reason}`)
  return live
}

// The live hosts whose PTY is the ONLY view of the session: one a tmux pane shows (through an
// `abduco -a` client) or omp-live already lists is reached through that row, not a second one.
export function ptyOnlyHosts(panes: PaneInfo[], procs: ProcInfo[]): LiveHost[] {
  const shown = new Set<number>(listLiveOmpAgents().map((a) => a.pid))
  for (const pane of panes) {
    const pid = findAgentInPane(pane, procs)?.pid
    if (pid !== undefined) shown.add(pid)
  }
  return hostsNotShownElsewhere(listLiveHosts(procs), shown)
}

// Types `text` into the PTY of the named host, after any earlier message for it has finished. The
// host is looked up in a FRESH process table only once its turn comes: during the wait it may
// have exited (the wrapper relaunching its harness leaves a live abduco server with nothing
// under it). `expectPid`: the harness must still be this exact process. No ledger here: the
// caller owns the claim.
export function typeIntoHost(name: string, text: string, logNote: string, expectPid?: number): Promise<SinkResult> {
  return serializeTyping(`host:${name}`, async (): Promise<SinkResult> => {
    const host = listLiveHosts(snapshot().procs).find((h) => h.name === name && (expectPid === undefined || h.harnessPid === expectPid))
    if (!host) return { ok: false, error: `${name} is no longer running under the rig wrapper — message not delivered` }
    log(`host-pty: ${logNote} → ${host.name} (${host.agent} pid ${host.harnessPid}, cwd ${host.cwd ?? "?"})`)
    return typeIntoHostNow(host, text)
  })
}

// Two messages for one typing target (a host's PTY, a tmux pane) are typed one after the other:
// interleaved, one's text would ride the other's Enter, and a pane's submit-check would read a
// box holding both. `key`: `host:<name>` or `pane:<paneId>`.
export const typingTail = new Map<string, Promise<unknown>>()

export function serializeTyping<T>(key: string, run: () => Promise<T>): Promise<T> {
  const result = (typingTail.get(key) ?? Promise.resolve()).then(run, run)
  const tail = result.catch(() => undefined)
  typingTail.set(key, tail)
  void tail.then(() => {
    if (typingTail.get(key) === tail) typingTail.delete(key)
  })
  return result
}

export async function typeIntoHostNow(host: LiveHost, text: string): Promise<SinkResult> {
  const res = await injectIntoAbducoSession({ connect: connectAbducoSocket, sleep: (ms) => Bun.sleep(ms) }, host.socket, text)
  if (res.ok) return { ok: true }
  const who = hostDisplayName(host)
  log(`host-pty: ${host.name} failed${res.uncertain ? " after the text was partly written" : ""}: ${res.error}`)
  return {
    ok: false,
    uncertain: res.uncertain,
    error: res.uncertain
      ? `${who}: ${res.error}. The message may already be in its prompt — check before resending; it was not sent again.`
      : `${who}: ${res.error} — message not delivered.`,
  }
}

// Types an inbound Telegram message into a wrapper-hosted session's PTY at most once
// (tg-cli#299). The host is re-verified against a fresh process table INSIDE the claim, right
// before typing: it may have exited, or been replaced, between picking the target and typing — and a replay
// of an already delivered message must be suppressed without touching the session at all.
export function deliverToHost(name: string, text: string, messageId: number | string | null | undefined): Promise<SinkResult> {
  return deliverInboundOnce(typeof messageId === "number" ? messageId : null, hostOriginId(name), () => typeIntoHost(name, text, `tg#${messageId ?? "-"}`))
}

// The one entry for a delivery addressed by route-origin / picker id: null when `paneId` is not a
// `host:<name>` address (the caller continues with its tmux/omp handling), else the exactly-once
// delivery into that host's PTY.
export function deliverHostPane(paneId: string, text: string, messageId: number | string | null | undefined): Promise<SinkResult> | null {
  const name = hostNameFromOriginId(paneId)
  return name === null ? null : deliverToHost(name, text, messageId)
}

// --- Inbound delivery ledger (tg-cli#299, features/tg-ctl/delivery-ledger.ts) ---
// Opened by runDaemon; null in every other process (ask, status, …), which never
// delivers an inbound message, so every gate below passes straight through there.
// Keyed by the daemon's one chat (TG_CHAT_ID): every route and reply goes to it.
export let deliveryLedger: { path: string; chat: number; state: LedgerState } | null = null

export function openDeliveryLedger(path: string, chat: number): LedgerState {
  const events = parseLedger(readFileOrNull(path))
  const kept = compactLedger(events)
  if (kept) {
    try {
      atomicWrite(path, serializeLedgerEvents(kept))
    } catch (err) {
      log(`delivery ledger compaction failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const state = applyLedgerEvents(emptyLedgerState(), kept ?? events)
  deliveryLedger = { path, chat, state }
  return state
}

// tg auth's `/start <nonce>` claim (docs/specs/tg-auth.md §4): persist the chat into the .env and
// report it to the waiting `tg auth` through the pending file. Returns whether the chat was
// saved; the caller switches to it (switchChat) only from the NEXT batch, so the batch that
// carried the tap is routed and ledgered against the one chat it was received for. A failed
// .env write is reported as `failed` and changes nothing.
export function claimAuthBinding(ctx: Ctx, claim: { chat: AuthChat; pending: PendingAuth }): boolean {
  const envPath = join(ctx.configDir, ".env")
  try {
    atomicWrite(envPath, mergeEnvContent(readFileOrNull(envPath), { TG_CHAT_ID: String(claim.chat.id) }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`tg auth: cannot save chat ${claim.chat.id} to ${envPath}: ${message}`)
    try {
      atomicWrite(ctx.paths.authPending, serializePending(markAuthFailed(claim.pending, message)))
    } catch (reportErr) {
      log(`tg auth: cannot report the failure: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`)
    }
    return false
  }
  try {
    atomicWrite(ctx.paths.authPending, serializePending(markAuthBound(claim.pending, claim.chat, Date.now())))
  } catch (err) {
    log(`tg auth: chat saved, but cannot report it to tg auth: ${err instanceof Error ? err.message : String(err)}`)
  }
  log(`tg auth: bound chat ${claim.chat.id}${claim.chat.id === ctx.chatId ? " (unchanged)" : ` (was ${ctx.chatId})`}`)
  return true
}

// The daemon keeps running on a chat `tg auth` just bound — no restart (tg-cli#561).
export function switchChat(ctx: Ctx, chatId: number): void {
  if (chatId === ctx.chatId) return
  log(`now serving chat ${chatId} (was ${ctx.chatId})`)
  ctx.chatId = chatId
  if (deliveryLedger) deliveryLedger.chat = chatId
}

// Folds `events` into the live state, then appends and fsyncs them: a claim must be
// on disk before the text leaves the daemon, or a kill right after the send would
// forget the send happened. Returns whether the events reached the disk.
export function recordDelivery(events: LedgerEvent[]): boolean {
  const ledger = deliveryLedger
  if (!ledger || events.length === 0) return true
  applyLedgerEvents(ledger.state, events)
  try {
    const fd = openSync(ledger.path, "a", 0o600)
    try {
      const buf = Buffer.from(serializeLedgerEvents(events))
      // codeql[js/http-to-file-access] Intentional: this appends the daemon's delivery-ledger events (message
      // ids, outcomes, JSON-serialized so no raw line break) to the fixed per-bot ledger path from CtlPaths,
      // never to a path derived from the message. fsync-before-send is the exactly-once guarantee. Covered by
      // tests/ctl-delivery-ledger.test.ts.
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    // The in-memory state still blocks a second send in this run; only a restart
    // could repeat a message whose record never reached the disk.
    log(`delivery ledger append failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export function recordHeld(messageId: number | null, target: string, hold: LedgerHold): void {
  if (messageId === null || !deliveryLedger) return
  recordDelivery([{ ts: Date.now(), event: "queued", chat: deliveryLedger.chat, msg: messageId, target, hold }])
}

// A held message the daemon gave up on outside any sink (an expired picker or topic
// hold, a picker lost by a restart) — the CTO is told separately.
export function recordFailed(messageId: number, target: string, error: string): void {
  if (!deliveryLedger) return
  recordDelivery([{ ts: Date.now(), event: "failed", chat: deliveryLedger.chat, msg: messageId, target, error }])
}

// THE gate every sink puts in front of an inbound Telegram message (the omp-live
// bridge, tmux send-keys, the Stop-hook inbox): a message already delivered, or in
// flight, is not sent again — it reports success, since it did arrive. Otherwise a
// durable claim, the send, then its outcome; a claim that cannot reach the disk sends
// nothing (a restart could not know it went out) and fails the delivery instead.
// `messageId` null: not an inbound message (a key press, a synthetic notice) — sent as is.
export async function deliverInboundOnce<R extends SinkResult>(
  messageId: number | null | undefined,
  target: string,
  send: () => Promise<R>,
): Promise<R | { ok: true } | { ok: false; error: string }> {
  const ledger = deliveryLedger
  if (!ledger || messageId === null || messageId === undefined) return send()
  const base = { chat: ledger.chat, msg: messageId, target }
  const decision = decideDelivery(ledger.state.messages.get(ledgerKey(ledger.chat, messageId)))
  if (decision.kind === "suppress") {
    log(`delivery: tg#${messageId} → ${target} suppressed — already ${decision.prior.state} to ${decision.prior.target}`)
    recordDelivery([{ ts: Date.now(), event: "duplicate", ...base, prior: decision.prior.state }])
    return { ok: true }
  }
  if (!recordDelivery([{ ts: Date.now(), event: "claimed", ...base }])) {
    const error = "the delivery ledger could not be written, so it was not sent"
    recordDelivery([{ ts: Date.now(), event: "failed", ...base, error }])
    return { ok: false, error }
  }
  let res: R
  try {
    res = await send()
  } catch (err) {
    recordDelivery([{ ts: Date.now(), event: "failed", ...base, error: err instanceof Error ? err.message : String(err) }])
    throw err
  }
  recordDelivery([sinkOutcomeEvent(Date.now(), base, res)])
  return res
}

// `paneId`: the tmux pane this exact OMP runs in, when known. An OMP with NO
// endpoint there is still the original process — typing into its own TUI is its
// normal input path, not a second history writer and not a spawn (#458).
// A numeric `messageId` is an inbound Telegram message: sent at most once (tg-cli#299).
export async function deliverOriginalOmp(target: OriginalOmpTarget, text: string, messageId?: number | string, paneId?: string | null): Promise<SinkResult> {
  if (typeof messageId !== "number") return sendOriginalOmp(target, text, messageId, paneId)
  return deliverInboundOnce(messageId, paneId ?? `omp:${target.pid ?? "?"}`, () => sendOriginalOmp(target, text, messageId, paneId))
}

// The live-endpoint attempt: the receipt on success, else the bridge's error code.
async function tryOriginalLiveSend(target: OriginalOmpTarget, text: string, messageId?: number | string): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    await refreshOriginalHosts()
    const host = selectOriginalEndpoint(target, originalHosts)
    const receipt = await sendLiveMessage({ root: defaultRegistryRoot(), pid: host.pid,
      instanceId: host.instanceId, sessionId: host.sessionId, requestId: originalRequestId(text, messageId), text })
    log(`omp-live: accepted pid=${receipt.pid} instance=${receipt.instanceId} session=${receipt.sessionId} request=${receipt.requestId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, code: err instanceof Error && /^[a-z_]+$/.test(err.message) ? err.message : 'delivery_failed' }
  }
}

// Only a proven-absent endpoint may fall back: any other code means the endpoint
// exists (or may have accepted the text), and typing it again would duplicate it.
// The fallback is the terminal that hosts this exact process — its tmux pane, else the
// abduco session the rig wrapper runs it in: its own TUI either way, no second writer.
async function typeIntoOriginalTerminal(pid: number, text: string, paneId?: string | null): Promise<SinkResult | null> {
  if (paneId && !paneId.startsWith("omp:")) {
    const res = await typeIntoOwnOmpPane(paneId, pid, text)
    if (res) return res
  }
  return typeIntoHostOfOmp(pid, text)
}

function originalBridgeRejection(code: string): SinkResult {
  log(`omp-live: rejected reason=${code} (no replacement process started)`)
  // A timed-out or dropped connection already handed the text to a live, busy host.
  if (code === 'endpoint_timeout' || code === 'endpoint_connection_lost') {
    return { ok: false, error: `Original OMP bridge: ${code}. The original OMP is busy; the text may still arrive when it frees up — check before resending. No second agent was started.` }
  }
  return { ok: false, error: `Original OMP bridge: ${code}. Run tg-ctl omp-live install. Save/stop the original before resuming it once to load the bridge; never start a second copy. No second agent was started.` }
}

export async function sendOriginalOmp(target: OriginalOmpTarget, text: string, messageId?: number | string, paneId?: string | null): Promise<SinkResult> {
  const live = await tryOriginalLiveSend(target, text, messageId)
  if (live.ok) return live
  if (live.code === 'endpoint_unavailable' && target.pid !== undefined) {
    const typed = await typeIntoOriginalTerminal(target.pid, text, paneId)
    if (typed) return typed
  }
  return originalBridgeRejection(live.code)
}

// null = the pane no longer hosts exactly this OMP pid; the caller fails closed.
export async function typeIntoOwnOmpPane(paneId: string, pid: number, text: string): Promise<SinkResult | null> {
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === paneId)
  const hosted = pane ? findAgentInPane(pane, procs) : null
  if (hosted?.agent !== "omp" || hosted.pid !== pid) return null
  log(`omp-live: no endpoint for pid=${pid} — tmux send-keys into its own pane ${paneId} (original process, no spawn)`)
  return executeInjectSteps(buildTextInjectPlan(paneId, text))
}

// null = no live rig-wrapper host runs exactly this omp pid; the caller fails closed.
export async function typeIntoHostOfOmp(pid: number, text: string): Promise<SinkResult | null> {
  const { procs } = snapshot()
  const host = hostOfPid(pid, procs, listLiveHosts(procs))
  if (!host || host.agent !== "omp" || host.harnessPid !== pid) return null
  log(`omp-live: no endpoint for pid=${pid} — abduco PTY of ${host.name} (original process, no spawn)`)
  return typeIntoHost(host.name, text, `omp pid ${pid}`, pid)
}

// `tg-ctl audit-delivery` (tg-cli#299): read-only report of inbound messages that never
// reached an agent, reached one twice, or never arrived (update-id gaps). See delivery-audit.ts.
export function runAuditDelivery(ctx: Ctx, argv: string[]): number {
  const args = parseAuditArgs(argv)
  if (args.kind === "help") {
    writeStdoutLine(AUDIT_USAGE)
    return 0
  }
  if (args.kind === "error") {
    console.error(`tg-ctl audit-delivery: ${args.message}\n${AUDIT_USAGE}`)
    return 2
  }
  const history = [ctx.paths.history, ...args.history].flatMap((p) => parseHistory(readFileOrNull(p)))
  const logs = [ctx.paths.log, join(ctx.configDir, "launchd.tg-ctl.err.log"), ...args.logs].map((p) => readFileOrNull(p) ?? "").join("\n")
  const roots = args.transcripts ?? [join(ctx.home, ".omp", "agent", "sessions"), join(ctx.home, ".claude", "projects"), join(ctx.home, ".codex", "sessions")]
  // Transcripts last written before the window cannot hold a delivery inside it. No inbound
  // history and no --since: no lower bound, every transcript is read.
  const oldest = args.since ?? history.reduce((min, r) => (r.direction === "user" ? Math.min(min, r.ts) : min), Infinity)
  const minMtimeMs = Number.isFinite(oldest) ? oldest * 1000 : 0
  const copies: InjectedCopy[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name.endsWith(".jsonl") && (fileMtimeMs(path) ?? -1) >= minMtimeMs) {
        const raw = readFileOrNull(path)
        if (raw) copies.push(...transcriptCopies(raw, path))
      }
    }
  }
  for (const root of roots) walk(root)
  const report = buildAuditReport({
    chatId: ctx.chatId,
    history,
    ledger: parseLedger(readFileOrNull(ctx.paths.deliveryLedger)),
    copies,
    logAttempts: logDeliveryIds(logs),
    sinceSec: args.since,
    untilSec: args.until,
  })
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatAuditReport(report))
  return 0
}

// The `tg` sender next to this tg-ctl (the same checkout — a worktree's alert posts with its
// own code), else the one on PATH.
export function tgBinary(): string {
  const sibling = join(dirname(realpathSync(rootScriptPath())), "tg")
  return existsSync(sibling) ? sibling : "tg"
}

// This process's ancestors, nearest first, from one `ps` snapshot — cut at an omp
// worker broker, whose parent omp does not own the jobs it hosts (tg-cli#709).
export function ancestorPids(pid: number): number[] {
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
    return ancestorPidChain(parseProcList(ps.stdout.toString()), pid)
  } catch {
    return []
  }
}

// A failed plan; `sessionMismatch`: the §2.6 guard refused (the pane hosts a
// different session now) and `error` is the named reply for the CTO;
// `unsubmitted`: the text WAS typed but is still in the input box (#463) — never
// re-type it, report it.
export type InjectFailure = { ok: false; error: string; sessionMismatch?: true; unsubmitted?: true }

// The registry as it describes pane `paneId` NOW (re-scanned first). A scan
// shared with an earlier delivery of the same burst is trusted only while the
// pane still holds the agent process that scan recorded; otherwise it rescans,
// so a pane that changed hands inside the rate-limit window is still caught.
export function registryForPane(paneId: string, observed?: { panes: PaneInfo[]; procs: ProcInfo[] }): Registry | null {
  const shared = Date.now() - sessionRefreshAt < SESSION_REFRESH_MIN_MS
  const reg = refreshSessionRegistry()
  if (!reg || !shared) return reg
  const { panes, procs } = observed ?? snapshot()
  const pane = panes.find((p) => p.paneId === paneId)
  const agentPid = pane ? findAgentInPane(pane, procs)?.pid : undefined
  return registryCurrentForPane(reg, paneId, pane?.panePid, agentPid) ? reg : (refreshSessionRegistry(true) ?? reg)
}

// The §2.6 guard's named refusal when pane `paneId` no longer hosts session
// `sessionKey` (registryForPane), else null. Unkeyed targets (an untracked
// harness, a pre-registry row) and a daemon without a registry pass.
export function paneSessionRefusal(sessionKey: string | undefined, paneId: string, observed?: { panes: PaneInfo[]; procs: ProcInfo[] }): string | null {
  if (sessionKey === undefined) return null
  const reg = registryForPane(paneId, observed)
  if (!reg) return null
  const check = checkPaneSession(reg, sessionKey, paneId)
  if (check.ok) return null
  log(`pane-guard: refused ${paneId} for ${sessionKey} (now ${check.hostName ?? "no agent"})`)
  return paneRefusalText(check, paneId)
}

// The agent process a verify-pane found in the pane (findAgentInPane).
export type HostedAgent = { agent: AgentKind; pid?: number }

// The verify-pane step, shared by both executors. It re-runs discovery on a
// CURRENT snapshot — the agent may have exited between picking the target and
// typing into it, and injecting into a bare shell would EXECUTE the text (spec
// §5.2). With a session key it also requires the pane to still host THAT
// session (spec §2.6, #354/#100): a tmux server restart or a respawned pane
// reuses `%N`, and a cwd match is never enough.
export function verifyPaneStep(step: Extract<InjectStep, { kind: "verify-pane" }>): InjectFailure | { ok: true; hosted: HostedAgent } {
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === step.paneId)
  const hosted = pane ? findAgentInPane(pane, procs) : null
  if (!hosted) {
    return { ok: false, error: `pane ${step.paneId} no longer hosts an agent — message not injected` }
  }
  const refusal = paneSessionRefusal(step.sessionKey, step.paneId, { panes, procs })
  return refusal === null ? { ok: true, hosted } : { ok: false, error: refusal, sessionMismatch: true }
}

// Does pane `paneId` still run the very agent process the text was typed into? A pane
// can change hands during the settle wait (the agent exits, tmux reuses `%N`).
export function paneStillHosts(paneId: string, hosted: HostedAgent): boolean {
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === paneId)
  const now = pane ? findAgentInPane(pane, procs) : null
  return now !== null && now.agent === hosted.agent && now.pid === hosted.pid
}

// The submit-check step (tg-cli#463), shared by both executors: `hosted` is what the
// plan's verify-pane found. Ends the plan as delivered (the text left the input box,
// or the box cannot be read, or the pane no longer runs that agent) or unsubmitted
// (still typed after the retry Enter); "retry-enter" runs the retry Enter that follows.
// The pane is re-checked before its box is read and again before the retry Enter:
// another agent's box says nothing about this text, and an Enter there would submit
// whatever that agent holds.
export function submitCheckStep(step: Extract<InjectStep, { kind: "submit-check" }>, hosted: HostedAgent | null): { ok: true } | InjectFailure | "retry-enter" {
  const agent = hosted?.agent ?? "unknown agent"
  const handedOver = (): { ok: true } => {
    log(`submit-check: pane ${step.paneId} no longer runs the ${agent} (pid ${hosted?.pid ?? "?"}) the message was typed into — submission not verified, no retry Enter`)
    return { ok: true }
  }
  if (hosted !== null && !paneStillHosts(step.paneId, hosted)) return handedOver()
  const screen = hosted === null ? null : capturePane(step.paneId)
  const typed = hosted === null || screen === null ? null : messageStillTyped(hosted.agent, screen, step.text)
  if (hosted === null || typed === null) {
    log(`submit-check: pane ${step.paneId} (${agent}) — input box not readable, submission not verified`)
    return { ok: true }
  }
  if (!typed) return { ok: true }
  if (!step.final) {
    if (!paneStillHosts(step.paneId, hosted)) return handedOver()
    log(`submit-check: pane ${step.paneId} (${agent}) still shows the message after Enter — retrying Enter once`)
    return "retry-enter"
  }
  log(`submit-check: pane ${step.paneId} (${agent}) still shows the message after the retry Enter — reporting it unsubmitted`)
  return { ok: false, unsubmitted: true, error: unsubmittedNotice(step.paneId, hosted.agent, step.text) }
}

// Execute an InjectStep plan (verify-pane: verifyPaneStep; submit-check: submitCheckStep). A plan
// owns its pane's input until it ends: a second message typed meanwhile would join the first in
// the box and the retry Enter would send both as one. EVERY plan on a pane takes the turn — a
// digit or key plan (a late button tap) types into the same pane as a text plan mid-check.
export function executeInjectSteps(steps: InjectStep[]): Promise<{ ok: true } | InjectFailure> {
  const key = paneTypingKey(steps)
  return key ? serializeTyping(key, () => runInjectStepsLocked(steps)) : runInjectSteps(steps)
}

// The in-process turn above cannot see the detached `auto-continue-once` process, which types into
// the same panes: a pane's typing turn is also a lock file in the config dir (a dead owner's lock
// is broken). A lock that stays held past the budget is typed through — a stuck owner must not
// swallow the message.
export const PANE_LOCK_ATTEMPTS = 400

export const PANE_LOCK_DELAY_MS = 50

export function paneLockIo(paneId: string): RoutesLockIo {
  const dir = join(resolveConfigDir(process.env.HOME ?? "~"), "pane-locks")
  mkdirSync(dir, { recursive: true })
  return fsRoutesLockIo(join(dir, `${paneId.replace(/[^A-Za-z0-9]/g, "_")}.lock`))
}

export async function runInjectStepsLocked(steps: InjectStep[]): Promise<{ ok: true } | InjectFailure> {
  const paneId = (steps.find((step) => step.kind === "verify-pane") as Extract<InjectStep, { kind: "verify-pane" }>).paneId
  const io = paneLockIo(paneId)
  let held = false
  for (let i = 0; i < PANE_LOCK_ATTEMPTS && !held; i++) {
    held = io.acquire()
    if (held) break
    if (io.ownerDead() === true) io.breakIfDead()
    else await Bun.sleep(PANE_LOCK_DELAY_MS)
  }
  if (!held) log(`pane ${paneId} typing lock still held after ${PANE_LOCK_ATTEMPTS * PANE_LOCK_DELAY_MS}ms — typing through`)
  try {
    return await runInjectSteps(steps)
  } finally {
    if (held) io.release()
  }
}

// tg-cli#309: the verify-permission-menu step found a different menu (or none) where
// the plan's target was — the digit is never sent.
export const PERMISSION_MENU_CHANGED: InjectFailure = {
  ok: false,
  error: "permission menu changed before the digit was sent — nothing typed",
}

// The non-timing steps shared by both executors. `end` stops the plan with that result;
// `sleepMs` asks the executor to wait (async vs sync differ only there).
type InjectStepVerdict = { end: { ok: true } | InjectFailure } | { sleepMs: number } | null

function runTmuxStep(step: Extract<InjectStep, { kind: "tmux" }>): InjectFailure | null {
  const proc = Bun.spawnSync(step.argv, {
    stdin: step.stdin !== undefined ? new TextEncoder().encode(step.stdin) : undefined,
    stdout: "ignore",
    stderr: "pipe",
  })
  if (proc.exitCode === 0) return null
  return { ok: false, error: `${step.argv.join(" ")} failed: ${proc.stderr.toString().trim()}` }
}

function applyInjectStep(step: InjectStep, plan: { hosted: HostedAgent | null }): InjectStepVerdict {
  switch (step.kind) {
    case "verify-pane": {
      const verified = verifyPaneStep(step)
      if (!verified.ok) return { end: verified }
      plan.hosted = verified.hosted
      return null
    }
    case "verify-permission-menu":
      return permissionMenuUnchanged(capturePane(step.paneId), step.target) ? null : { end: PERMISSION_MENU_CHANGED }
    case "submit-check": {
      const checked = submitCheckStep(step, plan.hosted)
      return checked === "retry-enter" ? null : { end: checked }
    }
    case "tmux": {
      const failed = runTmuxStep(step)
      return failed ? { end: failed } : null
    }
    default:
      return { sleepMs: step.ms }
  }
}

export async function runInjectSteps(steps: InjectStep[]): Promise<{ ok: true } | InjectFailure> {
  const plan = { hosted: null as HostedAgent | null }
  for (const step of steps) {
    const verdict = applyInjectStep(step, plan)
    if (verdict && "end" in verdict) return verdict.end
    if (verdict) await Bun.sleep(verdict.sleepMs)
  }
  return { ok: true }
}

// Types an inbound Telegram message (`messageId`) into a tmux pane at most once (tg-cli#299).
export function injectInbound(messageId: number | null, paneId: string, steps: InjectStep[]): Promise<{ ok: true } | InjectFailure> {
  return deliverInboundOnce(messageId, paneId, () => executeInjectSteps(steps))
}

export function executeInjectStepsSync(steps: InjectStep[]): { ok: true } | InjectFailure {
  const paneId = steps.find((step) => step.kind === "verify-pane")?.paneId
  if (paneId === undefined) return runInjectStepsSync(steps)
  return withRoutesLock(paneLockIo(paneId), () => runInjectStepsSync(steps), { attempts: PANE_LOCK_ATTEMPTS, delayMs: PANE_LOCK_DELAY_MS })!
}

export function runInjectStepsSync(steps: InjectStep[]): { ok: true } | InjectFailure {
  const plan = { hosted: null as HostedAgent | null }
  for (const step of steps) {
    const verdict = applyInjectStep(step, plan)
    if (verdict && "end" in verdict) return verdict.end
    if (verdict) Bun.sleepSync(verdict.sleepMs)
  }
  return { ok: true }
}

// Capture a pane's current visible text (`tmux capture-pane -pJ`), used to
// re-check whether a Claude Code numbered permission menu is STILL showing
// before late-delivering a decision into it (see the permission branch of
// lateDeliverAbandonedQuestion). `-J` joins tmux's internal line-wrap breaks
// back into logical lines — without it, a long command that hard-wraps
// mid-token gets a newline (→ a space, after permission-menu.ts's whitespace
// normalization) inserted INSIDE the token, which can turn a real identity
// match into a false negative for exactly the long commands most likely to
// hit the 120s hook budget in the first place (review finding). Never
// throws: a dead pane / missing tmux yields null, same fail-soft posture as
// the rest of this file's tmux calls.
export function capturePane(paneId: string): string | null {
  try {
    const proc = Bun.spawnSync(["tmux", "capture-pane", "-p", "-J", "-t", paneId], {
      stdout: "pipe",
      stderr: "pipe",
      env: SUBPROC_ENV,
    })
    if (proc.exitCode !== 0) return null
    return proc.stdout.toString()
  } catch {
    return null
  }
}
