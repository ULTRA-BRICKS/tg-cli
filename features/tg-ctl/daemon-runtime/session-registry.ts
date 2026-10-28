// daemon-runtime/session-registry: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { existsSync, readFileSync, unlinkSync } from "fs"
import { type Socket } from "net"
import { join } from "path"
import { findLiveOmpAgents, ompSessionFileFromBreadcrumb, ompTerminalId, parseLsofJsonlPaths, parseOmpSessionMeta, pickPrimaryOmpSessionFile, withOmpSession, type LiveOmpAgent } from "../omp"
import { defaultRegistryRoot, listLiveEndpoints } from "../omp-live-runtime.mjs"
import { type OriginalOmpEndpoint } from "../omp-live-routing"
import { bindHookSessions, hookSightingOf, listLiveSessions, migrationLivePanes, scanIsTrustworthy, serverPidAcross, type HookSessionSighting, type PendingHookSighting } from "../harness-sessions"
import { reconcile, RENAME_DEBOUNCE_MS, type PendingRenames, type Registry, type RegistryEvent, type SessionEntry, type SessionKey } from "../session-registry"
import { parseRegistry, rekeyStores, runMigration, serializeRegistry, type MigrationIo, type MigrationStore } from "../session-registry-store"
import { createTopicEnsurer, findSessionForLookup, HARNESS_AGENT, noteTopicMiss, paneLocatorOf, topicTitleFor, type SessionLookup } from "../session-topics"
import { createTopicRenamer, type TopicRenamer } from "../topic-rename"
import { isThreadRejection, isTopicDeletedError } from "../../transport/telegram"
import { type ButtonMessagePayload, type ButtonRequest } from "../questions"
import { fsRoutesLockIo, withRoutesLock } from "../routes"
import { appendTopic, attachTopic, findTopic, markBound, parseTopics, serializeTopics, topicForPane } from "../topics"
import type { CtlPaths, PaneInfo, ProcInfo, TopicBinding } from "../types"
import { atomicWrite, log, readFileOrNull, type Ctx } from "./ctx-io"
import { botPost, botPostResult, inboxThreadId, sendMessage } from "./telegram-api"
import { LSOF_TIMEOUT_MS, SUBPROC_ENV, UNREACHABLE_SCAN_TTL_MS, cwdOfPid, readPaneTitles, readPidTtyMap, readTmuxServerPid, snapshot } from "./tmux-probe"

// Shared by every initial-post call site so the parse_mode/reply_markup shape can't drift
// between them — a divergent copy is exactly how a hatch card's parse_mode threading silently
// stops matching between flows.
// `sessionKey`: the card's registry session, when the payload is threaded into its topic — the
// send then gets the §4.5 thread-not-found fallback to General.
export async function sendButtonCard(ctx: Ctx, payload: ButtonMessagePayload, sessionKey: SessionKey | null = null): Promise<number | null> {
  const extra: Record<string, unknown> = { reply_markup: payload.reply_markup }
  if (payload.parse_mode) extra.parse_mode = payload.parse_mode
  if (payload.message_thread_id !== undefined && sessionKey !== null) {
    return sendToSessionTopic(ctx, sessionKey, payload.message_thread_id, payload.text, extra)
  }
  return sendMessage(ctx, payload.text, extra)
}

// `lsof -Fn` n-paths for a pid — used to find omp's primary session jsonl.
export function jsonlPathsOfPid(pid: number): string[] {
  try {
    const lsof = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-Fn", "-n"], {
      stdout: "pipe",
      stderr: "pipe",
      env: SUBPROC_ENV,
      timeout: LSOF_TIMEOUT_MS,
      killSignal: "SIGKILL",
    })
    if (lsof.exitCode !== 0) return []
    return parseLsofJsonlPaths(lsof.stdout.toString())
  } catch {
    return []
  }
}

// omp's own per-terminal record of the session it is running (tg-cli#487): the
// fallback for an omp holding no session jsonl open at all.
export function ompBreadcrumbSessionFile(agent: LiveOmpAgent, cwd: string | null): string | null {
  const id = ompTerminalId(agent)
  if (!id) return null
  const home = process.env.HOME
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || (home ? join(home, ".omp", "agent") : null)
  if (!agentDir) return null
  try {
    const file = ompSessionFileFromBreadcrumb(readFileSync(join(agentDir, "terminal-sessions", id), "utf8"), cwd)
    return file && existsSync(file) ? file : null
  } catch {
    return null
  }
}

// `panes`/`procs`: the discovery snapshot the agents were derived from, kept so the
// session-registry scan reuses it instead of paying for its own ps/lsof pass.
// `serverPid`: the tmux server of exactly that pane list, read on both sides of it
// only while a registry scan is wanted (undefined = not read for this snapshot).
export let liveOmpCache: { at: number; agents: LiveOmpAgent[]; panes: PaneInfo[]; procs: ProcInfo[]; serverPid: number | null | undefined } | null = null

export function listLiveOmpAgents(): LiveOmpAgent[] {
  const now = Date.now()
  if (liveOmpCache && now - liveOmpCache.at < UNREACHABLE_SCAN_TTL_MS) return liveOmpCache.agents
  const ttyByPid = readPidTtyMap()
  const wantServerPid = sessionScanWanted()
  const serverPidBefore = wantServerPid ? readTmuxServerPid() : null
  const { panes, procs } = snapshot()
  const serverPid = wantServerPid ? serverPidAcross(serverPidBefore, readTmuxServerPid()) : undefined
  const agents = findLiveOmpAgents(panes, procs, ttyByPid).map((a) => {
    const host = originalHosts.find(h => h.pid === a.pid)
    if (host) return { ...a, ...host }
    const cwd = cwdOfPid(a.pid)
    // A subagent-derived main file is only a name; like the breadcrumb, trust it only if it exists.
    const openFile = pickPrimaryOmpSessionFile(jsonlPathsOfPid(a.pid))
    const sessionFile = (openFile && existsSync(openFile) ? openFile : null) ?? ompBreadcrumbSessionFile(a, cwd)
    let meta = null
    if (sessionFile) {
      try {
        meta = parseOmpSessionMeta(readFileSync(sessionFile, "utf8"))
      } catch {
        meta = null
      }
    }
    return withOmpSession(a, { cwd, sessionFile, meta })
  })
  for (const host of originalHosts) {
    if (!agents.some(a => a.pid === host.pid) && procs.some(p => p.pid === host.pid)) {
      agents.push({ ...host, paneId: null, tty: null })
    }
  }
  liveOmpCache = { at: now, agents, panes, procs, serverPid }
  return agents
}

// The original interactive OMP owns the endpoint. ACP session/load is NOT attach.
export let originalHosts: OriginalOmpEndpoint[] = []

export let originalProbe: Promise<void> | null = null

export let originalProbeAt = 0

export async function refreshOriginalHosts(): Promise<void> {
  if (originalProbe) return originalProbe
  if (Date.now() - originalProbeAt < 2000) return
  originalProbe = (async () => {
    try { originalHosts = await listLiveEndpoints(defaultRegistryRoot()) }
    catch { originalHosts = [] }
    originalProbeAt = Date.now()
    liveOmpCache = null
  })().finally(() => { originalProbe = null })
  return originalProbe
}

// --- Session registry (docs/specs/session-registry-and-topics.md §2, tg-cli#487) ---
// The daemon is the ONLY writer of sessions.json. Off the poll hot path: at most
// once per SESSION_SCAN_INTERVAL_MS (sooner when a hook sighting needs binding),
// deferred to run while the long-poll is in flight, one scan at a time. A scan
// reuses the tick's cached discovery (listLiveOmpAgents' snapshot + omp list) —
// no ps/lsof of its own — turns it into LiveSessions, reconciles them into the
// registry, runs any not-yet-done one-shot store migration, and persists only
// when the serialized registry changed. Delivery paths read it through
// currentSessionRegistry / refreshSessionRegistry (session-target.ts); a failure
// here is logged and never breaks the poll loop.
export const SESSION_SCAN_INTERVAL_MS = 30_000

export let sessionRegistry: Registry | null = null

export let sessionRegistryWritten: string | null = null

export let sessionScanAt = 0

// True once this daemon reconciled a scan of its own. Before that the registry
// is the persisted file, which may predate a tmux restart during downtime.
export let sessionRegistryScanned = false

export let sessionScanDue = true

export let sessionScanInFlight = false

// Set by the daemon's first kick: CLI one-shots that list omp never scan, so they
// never pay for the server-pid reads.
export let sessionScanEnabled = false

// The daemon's ctx, set by its first kick: the delivery-time readers below are
// module-level (executeInjectSteps, readRegistrations) and CLI one-shots have none.
export let sessionScanCtx: Ctx | null = null

// Bumped by every scan that ran; a queued tick scan whose discovery is older
// than a forced delivery-time scan is skipped instead of undoing it.
export let sessionScanGen = 0

export let sessionScanForced = false

export let sessionRefreshAt = 0

export const SESSION_REFRESH_MIN_MS = 2_000

// cc/codex `session_id`s seen on the hook socket, by pane. The pid is bound at
// the next scan (bindHookSessions), so a later process in the same pane never
// inherits the id.
export let pendingHookSessions: PendingHookSighting[] = []

export let hookSessions: HookSessionSighting[] = []

export const MAX_PENDING_HOOK_SESSIONS = 64

// Names seen but not yet stable for RENAME_DEBOUNCE_MS (spec §3.2); in memory only.
export let pendingRenames: PendingRenames = new Map()

// A pending rename wants the scan that can commit it as soon as its debounce ends,
// not a full SESSION_SCAN_INTERVAL_MS later.
export function renameCommitDue(now: number): boolean {
  for (const p of pendingRenames.values()) if (now - p.since >= RENAME_DEBOUNCE_MS) return true
  return false
}

export function sessionScanWanted(): boolean {
  if (sessionScanForced) return true
  if (!sessionScanEnabled || sessionScanInFlight) return false
  const now = Date.now()
  return sessionScanDue || now - sessionScanAt >= SESSION_SCAN_INTERVAL_MS || renameCommitDue(now)
}

// The registry as last scanned (or as persisted, before the first scan of this
// daemon). Null outside the daemon.
export function currentSessionRegistry(): Registry | null {
  if (sessionRegistry || !sessionScanCtx) return sessionRegistry
  sessionRegistry = parseRegistry(readFileOrNull(sessionScanCtx.paths.sessions))
  return sessionRegistry
}

// A fresh scan right before a delivery that depends on WHO a pane or pid hosts
// now (spec §2.5 re-adoption after a resume, §2.6 pane-reuse guard): a fresh
// ps/lsof/tmux discovery, reconciled synchronously. Rate-limited so a burst of
// deliveries (a deferred flush) shares one scan; `force` skips the limit.
export function refreshSessionRegistry(force = false): Registry | null {
  const ctx = sessionScanCtx
  if (!ctx || (!force && Date.now() - sessionRefreshAt < SESSION_REFRESH_MIN_MS)) return currentSessionRegistry()
  sessionRefreshAt = Date.now()
  liveOmpCache = null
  sessionScanForced = true
  try {
    listLiveOmpAgents()
  } finally {
    sessionScanForced = false
  }
  const discovery = liveOmpCache
  if (discovery && discovery.serverPid !== undefined) {
    sessionScanGen++
    scanSessionRegistry(ctx, { ...discovery, serverPid: discovery.serverPid })
  }
  return currentSessionRegistry()
}

export function recordHookSession(req: ButtonRequest): void {
  const sighting = hookSightingOf(req)
  if (!sighting) return
  pendingHookSessions.push(sighting)
  if (pendingHookSessions.length > MAX_PENDING_HOOK_SESSIONS) pendingHookSessions.shift()
  sessionScanDue = true // bind it while the asking process is still alive
}

export function sessionStoreIo(paths: CtlPaths): MigrationIo {
  const pathOf = (store: MigrationStore): string =>
    store === "routes" ? paths.routes : store === "registration" ? paths.registration : store === "lastUserTarget" ? paths.lastUserTarget : paths.topics
  return {
    read: (store) => readFileOrNull(pathOf(store)),
    write: (store, content) => {
      if (content !== null) return atomicWrite(pathOf(store), content)
      try {
        unlinkSync(pathOf(store))
      } catch {
        // already absent
      }
    },
    locked: (store, body) =>
      withRoutesLock(fsRoutesLockIo(`${pathOf(store)}.lock`), () => {
        body()
        return true
      }, { onContended: "skip" }) === true,
  }
}

export function describeRegistryEvent(ev: RegistryEvent): string {
  switch (ev.kind) {
    case "promoted":
      return `promoted ${ev.from} → ${ev.to}`
    case "paneReused":
      return `paneReused ${ev.paneId} ${ev.from} → ${ev.to}`
    case "readopted":
      return `readopted ${ev.key} thread=${ev.threadId ?? "-"}`
    case "renamed":
      return `renamed ${ev.key} ${JSON.stringify(ev.from.primary)} → ${JSON.stringify(ev.to.primary)}${ev.to.secondary ? ` (${JSON.stringify(ev.to.secondary)})` : ""}`
    default:
      return `${ev.kind} ${ev.key}`
  }
}

// Called once per poll tick, right after the tick refreshed listLiveOmpAgents.
// Never awaits: the scan is queued behind the getUpdates request it precedes. A
// snapshot taken while no scan was wanted carries no server pid; the next
// discovery refresh (UNREACHABLE_SCAN_TTL_MS) reads one.
export function kickSessionRegistryScan(ctx: Ctx): void {
  sessionScanEnabled = true
  sessionScanCtx = ctx
  if (!sessionScanWanted()) return
  const discovery = liveOmpCache
  if (!discovery || discovery.serverPid === undefined) return
  const { serverPid } = discovery
  sessionScanInFlight = true
  sessionScanDue = false
  sessionScanAt = Date.now()
  const gen = ++sessionScanGen
  setTimeout(() => {
    try {
      if (gen === sessionScanGen) scanSessionRegistry(ctx, { ...discovery, serverPid })
    } finally {
      sessionScanInFlight = false
    }
  }, 0)
}

export function scanSessionRegistry(ctx: Ctx, discovery: NonNullable<typeof liveOmpCache> & { serverPid: number | null }): void {
  const now = Date.now()
  try {
    const prev = sessionRegistry ?? parseRegistry(readFileOrNull(ctx.paths.sessions))
    sessionRegistry = prev
    const { panes, procs, agents, serverPid } = discovery
    if (!scanIsTrustworthy(prev, { panes, procs, serverPid })) return
    hookSessions = bindHookSessions(hookSessions, pendingHookSessions, panes, procs)
    pendingHookSessions = []
    const scan = listLiveSessions({ panes, procs, serverPid, paneTitles: readPaneTitles(), omp: agents, hookSessions })
    const { next, events, pending } = reconcile(prev, scan, now, pendingRenames)
    pendingRenames = pending
    const io = sessionStoreIo(ctx.paths)
    for (const ev of events) {
      log(`session-registry: ${describeRegistryEvent(ev)}`)
      if (ev.kind === "promoted") for (const line of rekeyStores(io, ev.from, ev.to)) log(`session-registry: ${line}`)
    }
    sessionRegistry = next
    sessionRegistryScanned = true
    // The one-shot migration drops rows whose pane is dead, so an empty pane list
    // from a live server (the launchd flake) waits for a later scan — it would read
    // every registered pane as dead. With no server at all pane liveness is
    // unknown: the migration runs and drops nothing for a dead pane.
    const livePaneIds = migrationLivePanes({ panes, serverPid })
    if (livePaneIds !== "wait") {
      const migration = runMigration(next, io, { now, livePaneIds })
      for (const line of migration.log) log(`session-registry: ${line}`)
      sessionRegistry = migration.registry
    }
    persistSessionRegistry(ctx)
    followSessionTopics(ctx, prev, events)
  } catch (err) {
    log(`session-registry: scan failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function persistSessionRegistry(ctx: Ctx): void {
  if (!sessionRegistry) return
  const serialized = serializeRegistry(sessionRegistry)
  if (serialized === sessionRegistryWritten) return
  atomicWrite(ctx.paths.sessions, serialized)
  sessionRegistryWritten = serialized
}

export function currentRegistry(ctx: Ctx): Registry {
  sessionRegistry ??= parseRegistry(readFileOrNull(ctx.paths.sessions))
  return sessionRegistry
}

// --- One forum topic per session (docs/specs/session-registry-and-topics.md §4.2–§4.5, tg-cli#467) ---
// The daemon is the ONLY caller of createForumTopic. A session's topic is created lazily on its
// first outbound — a `tg` send (the hook-socket `resolve-session` ask) or a question/permission
// card — so idle sessions open no topics. It is stored as the registry entry's `threadId` and
// mirrored into topics.json as a bound binding, which is what the inbound triage (§4.4) routes
// by. A resumed or restarted session keeps its topic and says "reattached" there.
// How long an outbound waits for its topic before posting to General (the create goes on, and
// the next outbound uses the topic): `tg` gives the lookup 2 s in all.
export const TOPIC_WAIT_MS = 1200

// Fresh private-chat topics reject bot writes for a moment (telegram-bot-api #905): retry once.
export const TOPIC_THREAD_RETRY_MS = 1000

// A bot without topic capability (or a failing createForumTopic) is re-asked at most this often.
export const TOPIC_CAPABILITY_TTL_MS = 10 * 60_000

// Per entry, when its topic was last recreated after a deletion (§4.2's 24 h cap). Held in
// memory: a daemon restart forgets it, which at worst allows one extra recreate (tg-cli#498).
export const topicRecreatedAt = new Map<SessionKey, number>()

export let topicCapability: { at: number; ok: boolean } | null = null

export let topicEnsurer: ((key: SessionKey) => Promise<number | null>) | null = null

export function liveEntry(ctx: Ctx, key: string): SessionEntry | null {
  return currentRegistry(ctx).sessions.find((e) => e.key === key && e.state === "live") ?? null
}

// Replace one entry's topic fields and persist (the daemon is sessions.json's only writer).
export function patchSessionEntry(ctx: Ctx, key: SessionKey, patch: Partial<Pick<SessionEntry, "threadId" | "topicMisses">>): SessionEntry | null {
  const reg = currentRegistry(ctx)
  const prev = reg.sessions.find((e) => e.key === key)
  if (!prev) return null
  // A topic that is replaced or dropped takes its pending retitle with it.
  if (patch.threadId !== undefined && prev.threadId !== null && prev.threadId !== patch.threadId) topicRenamer?.forget(prev.threadId)
  const next = { ...prev, ...patch }
  sessionRegistry = { ...reg, sessions: reg.sessions.map((e) => (e === prev ? next : e)) }
  try {
    persistSessionRegistry(ctx)
  } catch (err) {
    log(`session topics: registry write failed: ${err}`)
  }
  return next
}

// Mirror an entry's topic into topics.json as a bound binding on its current pane locator, so
// the inbound triage delivers the topic's messages to it. No write when already so bound.
export function bindTopicToEntry(ctx: Ctx, threadId: number, entry: SessionEntry): void {
  const locator = paneLocatorOf(entry)
  if (!locator) return
  const topics = parseTopics(readFileOrNull(ctx.paths.topics))
  const existing = findTopic(topics, threadId)
  if (existing?.status === "bound" && existing.paneId === locator && existing.path === entry.cwd) return
  const ts = Math.floor(Date.now() / 1000)
  const binding = existing
    ? { ...markBound(existing, locator, ts), path: entry.cwd }
    : attachTopic(threadId, { paneId: locator, name: topicTitleFor(entry), path: entry.cwd, harness: HARNESS_AGENT[entry.harness] }, ts)
  writeSessionTopics(ctx, appendTopic(topics, binding))
}

export function writeSessionTopics(ctx: Ctx, topics: TopicBinding[]): void {
  try {
    atomicWrite(ctx.paths.topics, serializeTopics(topics))
  } catch (err) {
    log(`session topics: topics.json write failed: ${err}`)
  }
}

// Private-chat topics need the bot's threaded mode (getMe.has_topics_enabled); a supergroup
// forum is not gated by it. Cached for TOPIC_CAPABILITY_TTL_MS either way.
export async function topicsCapable(ctx: Ctx): Promise<boolean> {
  if (ctx.chatId < 0) return true
  if (topicCapability && Date.now() - topicCapability.at < TOPIC_CAPABILITY_TTL_MS) return topicCapability.ok
  const result = (await botPost(ctx, "getMe", {}))?.result
  const ok = !(result && typeof result === "object" && "has_topics_enabled" in result && result.has_topics_enabled === false)
  topicCapability = { at: Date.now(), ok }
  if (!ok) log("session topics: getMe.has_topics_enabled=false — sessions stay in General")
  return ok
}

// A topic already bound to this session's pane (the attach picker, a flat /new spawn, a
// binding from before the registry) is adopted, never duplicated. Its cwd must match: a pane
// id is reused freely.
function adoptBoundTopic(ctx: Ctx, key: SessionKey, entry: SessionEntry): number | null {
  const locator = paneLocatorOf(entry)
  const own = locator ? topicForPane(parseTopics(readFileOrNull(ctx.paths.topics)), locator) : null
  if (!own || (own.path !== undefined && own.path !== entry.cwd)) return null
  patchSessionEntry(ctx, key, { threadId: own.threadId })
  log(`session topics: ${key} adopted topic ${own.threadId}`)
  return own.threadId
}

// createForumTopic for the session; the new thread id, or null on any failure.
async function requestForumTopic(ctx: Ctx, key: SessionKey, entry: SessionEntry): Promise<number | null> {
  const resp = await botPostResult(ctx, "createForumTopic", { chat_id: ctx.chatId, name: topicTitleFor(entry) })
  const result = resp.ok ? resp.json.result : undefined
  const threadId = result && typeof result === "object" && "message_thread_id" in result ? result.message_thread_id : undefined
  if (typeof threadId === "number") return threadId
  log(`session topics: createForumTopic for ${key} failed: ${resp.ok ? "no message_thread_id" : resp.description}`)
  // Only a capability answer (not a forum / topics off / no rights) holds every session in
  // General for the TTL; a transient failure (429, 5xx, network) retries on the next outbound.
  if (!resp.ok && (isThreadRejection(resp.description) || /not enough rights/i.test(resp.description))) {
    topicCapability = { at: Date.now(), ok: false }
  }
  return null
}

export async function createSessionTopic(ctx: Ctx, key: SessionKey): Promise<number | null> {
  const entry = liveEntry(ctx, key)
  if (!entry) return null
  const adopted = adoptBoundTopic(ctx, key, entry)
  if (adopted !== null) return adopted
  if (!(await topicsCapable(ctx))) return null
  const threadId = await requestForumTopic(ctx, key, entry)
  if (threadId === null) return null
  // Logged BEFORE the write: a crash in between leaves one orphan topic, findable here (§4.2).
  log(`topic created ${threadId} for ${key}`)
  const bound = patchSessionEntry(ctx, key, { threadId, topicMisses: null })
  if (bound) bindTopicToEntry(ctx, threadId, bound)
  return threadId
}

// The session's topic, created on first use; null when topics are off or unavailable, or when
// the create takes longer than TOPIC_WAIT_MS (the caller then posts to General).
export function sessionTopic(ctx: Ctx, key: SessionKey): Promise<number | null> {
  if (!ctx.cfg.topics && !ctx.cfg.privateTopics) return Promise.resolve(null)
  topicEnsurer ??= createTopicEnsurer({
    threadIdOf: (k) => currentRegistry(ctx).sessions.find((e) => e.key === k)?.threadId ?? null,
    create: (k) => createSessionTopic(ctx, k),
  })
  // The 📥 Inbox topic is never a session's topic (tg-cli#705): not for a card, not for a `tg`
  // send, not for `tg --session-topic`.
  return Promise.race([topicEnsurer(key), Bun.sleep(TOPIC_WAIT_MS).then(() => null)]).then((t) => (t === inboxThreadId ? null : t))
}

// A threaded send fell back to General (§4.5): count the miss, recreate the topic once it is
// proven gone, and tell the human why the session posts in General (once per miss run).
export async function noteSessionTopicMiss(ctx: Ctx, key: SessionKey, threadId: number, description: string): Promise<void> {
  const entry = liveEntry(ctx, key)
  if (!entry || entry.threadId !== threadId) return
  const now = Date.now()
  const { misses, recreate } = noteTopicMiss(entry.topicMisses, now, {
    deleted: isTopicDeletedError(description),
    lastRecreatedAt: topicRecreatedAt.get(key) ?? null,
  })
  const name = entry.name.primary || entry.key
  if (recreate) {
    topicRecreatedAt.set(key, now)
    patchSessionEntry(ctx, key, { threadId: null, topicMisses: null })
    writeSessionTopics(ctx, parseTopics(readFileOrNull(ctx.paths.topics)).filter((t) => t.threadId !== threadId))
    log(`session topics: topic ${threadId} of ${key} is gone (${description}) — recreating on the next outbound`)
    await sendMessage(ctx, `⚠️ [${name}] its topic is gone — posted here; a new topic opens with its next message`)
    return
  }
  patchSessionEntry(ctx, key, { topicMisses: misses })
  log(`session topics: topic ${threadId} of ${key} rejected a send (${description}) — miss ${misses?.count ?? 0}, posted to General`)
  if (misses?.count === 1) await sendMessage(ctx, `⚠️ [${name}] its topic is not accepting messages (${description}) — posting here in General for now`)
}

export function clearSessionTopicMisses(ctx: Ctx, key: SessionKey): void {
  if (liveEntry(ctx, key)?.topicMisses) patchSessionEntry(ctx, key, { topicMisses: null })
}

// Post into a session's topic with the private-topic fallback (§4.5): a thread rejection is
// retried once after 1 s; a second one posts to General (after the notice) and counts a miss.
// A threaded success clears the miss counter. Any other failure returns null, like sendMessage.
// The CLI side of the same fallback is `send()` in features/transport/telegram.ts
// (`threadRetryDelayMs`); a change to what counts as a rejection belongs in both.
export async function sendToSessionTopic(ctx: Ctx, key: SessionKey, threadId: number, text: string, extra: Record<string, unknown> = {}): Promise<number | null> {
  if (threadId === inboxThreadId) return sendMessage(ctx, text, extra) // never into the 📥 Inbox (tg-cli#705)
  const body = { chat_id: ctx.chatId, text, ...extra, message_thread_id: threadId }
  let resp = await botPostResult(ctx, "sendMessage", body)
  if (!resp.ok && isThreadRejection(resp.description) && !isTopicDeletedError(resp.description)) {
    await Bun.sleep(TOPIC_THREAD_RETRY_MS)
    resp = await botPostResult(ctx, "sendMessage", body)
  }
  if (resp.ok) {
    clearSessionTopicMisses(ctx, key)
    const result = resp.json.result
    const messageId = result && typeof result === "object" && "message_id" in result ? result.message_id : undefined
    return typeof messageId === "number" ? messageId : null
  }
  if (!isThreadRejection(resp.description) && !isTopicDeletedError(resp.description)) return null
  await noteSessionTopicMiss(ctx, key, threadId, resp.description)
  return sendMessage(ctx, text, extra)
}

// hook-socket `resolve-session` (§4.3): which live session is this `tg` in, and its topic.
export async function handleResolveSession(ctx: Ctx, socket: Socket, q: SessionLookup): Promise<void> {
  let entry = findSessionForLookup(currentRegistry(ctx), q)
  // A session that started since the last scan: scan now, off the 30 s cadence.
  if (!entry) {
    const fresh = refreshSessionRegistry()
    entry = fresh ? findSessionForLookup(fresh, q) : null
  }
  const threadId = entry ? await sessionTopic(ctx, entry.key) : null
  const answer = entry ? { key: entry.key, name: entry.name.primary, threadId } : { key: null, name: null, threadId: null }
  socket.end(`${JSON.stringify(answer)}\n`)
}

// Forget the recreate cap of entries the registry has dropped.
function forgetDroppedRecreateCaps(ctx: Ctx): void {
  const sessions = currentRegistry(ctx).sessions
  for (const key of topicRecreatedAt.keys()) {
    if (!sessions.some((e) => e.key === key)) topicRecreatedAt.delete(key)
  }
}

// A readopted/relocated session re-binds its topic to the new pane locator; a new process of
// it (or a readoption) announces "reattached" there.
function rebindMovedSessionTopic(ctx: Ctx, prev: Registry, ev: Extract<RegistryEvent, { kind: "readopted" | "relocated" }>): void {
  const entry = liveEntry(ctx, ev.key)
  if (!entry || entry.threadId === null) return
  const threadId = entry.threadId
  bindTopicToEntry(ctx, threadId, entry)
  const before = prev.sessions.find((e) => e.key === ev.key)
  if (ev.kind === "readopted" || before?.locators.pid !== entry.locators.pid) {
    log(`session topics: ${entry.key} reattached to topic ${threadId}`)
    void sendToSessionTopic(ctx, entry.key, threadId, `📂 ${entry.name.primary || entry.key} — reattached`)
  }
}

// Scan follow-up: a session that moved or came back keeps its topic — the binding follows its
// new pane locator — and a new process of it (resume, restart) posts "reattached" there. A
// tmux move of the same process says nothing. A committed rename retitles the topic.
export function followSessionTopics(ctx: Ctx, prev: Registry, events: RegistryEvent[]): void {
  if (!ctx.cfg.topics && !ctx.cfg.privateTopics) return
  forgetDroppedRecreateCaps(ctx)
  for (const ev of events) {
    if (ev.kind === "renamed") retitleSessionTopic(ctx, ev)
    else if (ev.kind === "pruned") {
      const threadId = prev.sessions.find((e) => e.key === ev.key)?.threadId
      if (threadId != null) topicRenamer?.forget(threadId)
    } else if (ev.kind === "readopted" || ev.kind === "relocated") rebindMovedSessionTopic(ctx, prev, ev)
  }
}

// Rename → editForumTopic (spec §4.7, tg-cli#466): a committed `renamed` event (§3.2, stable for
// 20 s) retitles the session's topic `primary · secondary`, at most once a minute per topic with
// the latest name winning (topic-rename.ts). Nothing flows back: a topic renamed in Telegram —
// including the echo of this very edit — is only logged (§4.4 row 5), never applied to tmux or
// the registry, so there is no rename loop.
export let topicRenamer: TopicRenamer | null = null

export function retitleSessionTopic(ctx: Ctx, ev: Extract<RegistryEvent, { kind: "renamed" }>): void {
  const entry = currentRegistry(ctx).sessions.find((e) => e.key === ev.key)
  if (!entry || entry.threadId === null) return
  topicRenamer ??= createTopicRenamer({
    now: Date.now,
    schedule: (fn, ms) => {
      const timer = setTimeout(() => void fn(), ms)
      return () => clearTimeout(timer)
    },
    edit: (threadId, title) => editSessionTopic(ctx, threadId, title),
  })
  void topicRenamer.rename(entry.threadId, topicTitleFor(entry), topicTitleFor({ key: entry.key, name: ev.from }))
}

export async function editSessionTopic(ctx: Ctx, threadId: number, title: string): Promise<boolean> {
  const resp = await botPostResult(ctx, "editForumTopic", { chat_id: ctx.chatId, message_thread_id: threadId, name: title })
  // TOPIC_NOT_MODIFIED: the topic already carries this title.
  if (!resp.ok && !/TOPIC_NOT_MODIFIED/.test(resp.description)) {
    log(`session topics: retitling topic ${threadId} failed: ${resp.description}`)
    return false
  }
  log(`session topics: topic ${threadId} retitled "${title}"`)
  return true
}
