// daemon-runtime/topic-routing: forum-topic routing, holds and attach picker.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { writeFileSync } from "fs"
import { isAbsolute } from "path"
import { findAgentInPane } from "../discover"
import { wrapInbound } from "../inject"
import { liveOmpPaneId } from "../omp"
import { type SessionEntry } from "../session-registry"
import { resolveLocatorToSession } from "../session-registry-store"
import { sessionDeliveryTarget, type SessionDeliveryTarget } from "../session-target"
import { HARNESS_AGENT, sessionTopicTitle } from "../session-topics"
import { aggregateUsage, orderByLruMru, parseRoutes, routeMatchesPane } from "../routes"
import { appendTopic, attachPickerText, buildAttachKeyboard, capHolds, dropHold, findHold, findTopic, goneTopicReply, holdButtonMessages, holdExpiredReply, holdPayload, markClosed, markNoSessionNotice, parseHolds, parseTopics, removeTopic, restartHoldClock, returnHold, serializeHolds, serializeTopics, setHoldPicker, splitExpiredHolds, type TopicHold } from "../topics"
import { type NewSession } from "../new-command"
import { formatVoiceTranscript } from "../voice"
import type { Action, TopicBinding, TopicPayload, TopicStatus } from "../types"
import { heldLedgerEvent, payloadsNotPassed, planHeldTask, type TextPayload } from "./topic-routing-hold"
import { attachSummary, bindAndDeliver, isStalePicker, type AttachJob, type AttachProgress, type AttachRuntime } from "./topic-routing-attach"
import { atomicWrite, log, readFileOrNull } from "./ctx-io"
import { paneSessionRefusal, recordDelivery, recordFailed, recordHeld } from "./delivery"
import { answerCallbackQuery, clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"
import { currentSessionRegistry, editSessionTopic, listLiveOmpAgents, patchSessionEntry, refreshOriginalHosts, refreshSessionRegistry } from "./session-registry"
import { listAgentCandidates } from "./pane-discovery"
import { snapshot } from "./tmux-probe"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { TargetRoutingApi } from "./target-routing"
import type { MediaApi } from "./media-voice"
import type { InboundInjectApi } from "./inbound-inject"
import type { AgentRoutesApi } from "./agent-routes"
import type { PickerApi } from "./picker-state"
import type { ReactionsApi } from "./ack-reactions"
import type { LateApi } from "./late-api"

export type TopicRoutingDeps = {
  ctx: Ctx
  state: DaemonState
  targetRouting: TargetRoutingApi
  media: MediaApi
  inboundInject: InboundInjectApi
  agentRoutes: AgentRoutesApi
  picker: PickerApi
  reactions: ReactionsApi
  late: Pick<LateApi, "handleNewAnswer" | "askNewDir" | "spawnNewSessionWithTopic">
}

export function createTopicRouting(d: TopicRoutingDeps) {
  const { ctx, state } = d
  const { replyContext } = d.targetRouting
  const { downloadFileToCache, mediaReceipt, transcribeVoiceNote } = d.media
  const { answerOpenCardInChat, labelFor, injectPrewrappedToPane } = d.inboundInject
  const { handleReplyRoute } = d.agentRoutes
  const { pendingNew, reapNewSessions } = d.picker
  const { queueAckReaction, DEFER_REACTION, settleAckReaction } = d.reactions
  const { handleNewAnswer, askNewDir, spawnNewSessionWithTopic } = d.late

  // --- forum topics: inbound triage (docs/specs/session-registry-and-topics.md §4.4) ---
  // A topic is an ADDRESS for an existing session: messages in a bound topic reach that session,
  // messages in an unknown topic are held while the attach picker asks which live session gets
  // them. Nothing here spawns. The binding store is read fresh on each access (like routes) and
  // rewritten on every transition. It is only consulted when topics are on (control.topics /
  // control.private_topics); otherwise topicStatusOf is never wired into stepUpdates and topic
  // messages take the flat path unchanged.
  const loadTopics = (): TopicBinding[] => parseTopics(readFileOrNull(ctx.paths.topics))

  // A strictly-monotonic nonce for per-spawn tokens: unique even for two spawns in the same
  // second. Seeded above `Date.now()` ms so a daemon restart can't reuse a live token.
  let spawnNonceSeq = Date.now()

  const nextSpawnNonce = (): number => ++spawnNonceSeq

  const persistTopics = (topics: TopicBinding[]): void => {
    // Best-effort, off the inject path: a write error must never break the poll loop — it is
    // logged, not thrown. A lost transition self-heals: the next routed message re-checks the
    // session and records `closed` again.
    try {
      writeFileSync(ctx.paths.topics, serializeTopics(topics), { mode: 0o600 })
    } catch (err) {
      log(`topics persist failed: ${err}`)
    }
  }

  // THE way a handler changes bindings: load → mutate → persist in ONE synchronous call. Handlers
  // for different topics run concurrently (resource key `thread:<id>`), so a load held across an
  // `await` would let two of them persist over each other (e.g. two topics attaching to one
  // session). With no await inside, the event loop makes this the store's lock. `mutate` returns
  // the next binding list, or null to leave the store untouched; the result is the list as it
  // now stands.
  const updateTopics = (mutate: (topics: TopicBinding[]) => TopicBinding[] | null): TopicBinding[] => {
    const current = loadTopics()
    const next = mutate(current)
    if (next === null) return current
    persistTopics(next)
    return next
  }

  // The registry session that owns topic `threadId` (spec §4.2): the registry, not a topics.json
  // pane binding, is the truth for a session's topic. A live owner wins over a gone one.
  const topicOwner = (threadId: number): SessionEntry | null => {
    const owners = currentSessionRegistry()?.sessions.filter((e) => e.threadId === threadId) ?? []
    return owners.find((e) => e.state === "live") ?? owners[0] ?? null
  }

  // The registry session a topic message addresses (§4.4 rows 2–3): the topic's owner, else — a
  // binding the attach picker or a pre-registry spawn made — the ONE live session on the bound
  // pane locator with the binding's cwd. A closed binding is never re-resolved by its pane: that
  // `%N` may host a stranger now. null: the registry does not know the topic (no scan yet, or an
  // untracked harness), and the binding's own pane decides.
  const resolveTopicSession = (threadId: number, binding: TopicBinding | null): SessionEntry | null => {
    const owner = topicOwner(threadId)
    if (owner) return owner
    const reg = currentSessionRegistry()
    if (!reg || binding?.status !== "bound" || !binding.paneId) return null
    const key = resolveLocatorToSession(reg, binding.paneId, binding.path)
    return key === null ? null : (reg.sessions.find((e) => e.key === key) ?? null)
  }

  // threadId → current status (or null when unknown) for stepUpdates' pure triage. A topic the
  // registry gives to a session is known even without a topics.json binding, so a live session's
  // topic never lands behind the attach picker.
  const topicStatusOf = (threadId: number): TopicStatus | null => {
    const owner = topicOwner(threadId)
    if (owner) return owner.state === "live" ? "bound" : "closed"
    return findTopic(loadTopics(), threadId)?.status ?? null
  }

  // sendMessage threaded into a topic — all topic-originated daemon output MUST carry
  // message_thread_id or it lands in General.
  const sendToTopic = (threadId: number, text: string): Promise<number | null> =>
    sendMessage(ctx, text, { message_thread_id: threadId })

  // Is the session a bound topic addresses still running? `gone` is terminal (its pane closed or
  // its agent exited to a shell; an out-of-tmux omp whose pid is no longer live). `unconfirmed`
  // is NOT: a flaky empty `ps` read (the pane is visible but no process list came back) or a
  // live pane whose cwd no longer matches the binding — a tmux pane-id REUSE by another
  // project's agent must never receive this topic's message, while a transient empty
  // pane_current_path read or a legitimate `cd` self-heals on the next message.
  const topicSessionState = (
    binding: TopicBinding & { paneId: string },
  ): { state: "live"; cwd: string } | { state: "gone" } | { state: "unconfirmed"; reply: string } => {
    if (binding.paneId.startsWith("omp:")) {
      const pid = Number(binding.paneId.slice("omp:".length))
      const live = listLiveOmpAgents().find((a) => a.pid === pid)
      return live ? { state: "live", cwd: live.cwd ?? binding.path ?? "/" } : { state: "gone" }
    }
    const { panes, procs } = snapshot()
    const pane = panes.find((p) => p.paneId === binding.paneId)
    if (!pane) return { state: "gone" }
    if (findAgentInPane(pane, procs) === null) {
      return procs.length === 0
        ? { state: "unconfirmed", reply: "couldn't confirm this topic's session right now — try again" }
        : { state: "gone" }
    }
    if (binding.path !== undefined && !routeMatchesPane({ recognizedCwd: binding.path, panePath: pane.panePath })) {
      return { state: "unconfirmed", reply: "this topic's session pane can't be confirmed right now — try again" }
    }
    return { state: "live", cwd: pane.panePath || binding.path || "/" }
  }

  // The agent-facing text for one topic payload: text as-is; a photo/file is downloaded and a
  // voice note transcribed first, exactly as in the flat chat. Failures are answered in the
  // topic and return null.
  const renderTopicPayload = async (threadId: number, payload: TopicPayload): Promise<string | null> => {
    if (payload.type === "text") return payload.text
    const out = replyContext(threadId)
    let body: string
    if (payload.type === "media") {
      const dest = await downloadFileToCache(payload.fileId, payload.suggestedName, out)
      if (dest === null) return null
      body = mediaReceipt(payload.mediaKind, dest, payload.caption)
    } else {
      const transcript = await transcribeVoiceNote(payload.fileId, payload.suggestedName, payload.messageId, out)
      if (transcript === null) return null
      body = formatVoiceTranscript(transcript)
    }
    const wrapped = wrapInbound(ctx.cfg.injectWrap, payload.from, body, payload.messageId)
    return payload.anchor ? `${payload.anchor}\n${wrapped}` : wrapped
  }

  // Deliver one topic payload to a live session through the flat delivery path (omp endpoint →
  // in-tmux send-keys; deferred behind an open question). Errors answer in the topic, and a topic
  // delivery never moves the flat-chat last-user-target anchor. `sessionKey`: the registry session
  // the pane must still host (§2.6).
  const deliverTopicPayload = async (threadId: number, paneId: string, cwd: string, payload: TopicPayload, sessionKey?: string): Promise<boolean> => {
    if (payload.type === "text" && (await answerOpenCardInChat(paneId, payload.plain, payload.messageId, threadId, sessionKey))) return true
    const text = await renderTopicPayload(threadId, payload)
    if (text === null) return false
    return injectPrewrappedToPane(paneId, text, payload.messageId, cwd, { out: replyContext(threadId), recordAnchor: false, sessionKey })
  }

  const sessionStillAt = (key: string, target: Extract<SessionDeliveryTarget, { kind: "live" }>): boolean =>
    target.paneId !== null
      ? paneSessionRefusal(key, target.paneId) === null
      : target.pid === null || listLiveOmpAgents().some((a) => a.pid === target.pid)

  // THE delivery to a registry session (§4.4 row 2), shared by the bound-topic route and the
  // attach picker: a fresh scan says where the session lives NOW (a resumed omp keeps its key
  // under a new pid; a moved one keeps it in a new pane), then the flat path above delivers it —
  // the omp-live endpoint, the in-tmux send-keys fallback (#483), cc/codex send-keys, voice STT
  // and media download. Never a fallback to another session. `gone`: nothing was sent.
  const deliverToSession = async (
    key: string,
    threadId: number,
    payload: TopicPayload,
  ): Promise<{ kind: "sent"; ok: boolean } | { kind: "gone"; name: string | null }> => {
    // A resumed omp's new process publishes a new endpoint; pick it up before the scan.
    await refreshOriginalHosts()
    const reg = refreshSessionRegistry()
    if (!reg) return { kind: "gone", name: null }
    let target = sessionDeliveryTarget(reg, key)
    // That scan may be a rate-limited one from moments ago. Before rendering (STT, download),
    // confirm the session is still where it says — the §2.6 check rescans a pane that changed
    // hands; an out-of-tmux omp's pid must still be live — else a forced scan says where it went,
    // or that it is gone.
    if (target.kind === "live" && !sessionStillAt(key, target)) {
      target = sessionDeliveryTarget(refreshSessionRegistry(true) ?? reg, key)
    }
    if (target.kind !== "live") return { kind: "gone", name: target.kind === "gone" ? target.name : null }
    // A live cc/codex entry always has a pane and a live omp a pid; the `omp:<pid>` row is the
    // out-of-tmux omp's endpoint-only locator.
    const paneId = target.paneId ?? (target.pid !== null ? liveOmpPaneId(target.pid) : null)
    if (paneId === null) return { kind: "gone", name: target.name }
    log(`topic ${threadId}: → session ${key} at ${paneId}`)
    return { kind: "sent", ok: await deliverTopicPayload(threadId, paneId, target.cwd, payload, key) }
  }

  // A gone topic session (§4.4 row 3). A plain message gets the "not running — resume with …"
  // reply in the topic. A REPLY to one of the topic's messages takes the flat reply fallback
  // instead (tg-cli#709): the replied-to message's lineage parent when live, else the agent
  // picker — answered in this topic, never a dead end for a message aimed at a specific report.
  const answerGoneTopic = async (threadId: number, payload: TopicPayload, goneReply: string): Promise<boolean> => {
    if (payload.replyTo === undefined) {
      await sendToTopic(threadId, goneReply)
      return false
    }
    log(`warning: topic ${threadId}: reply to tg#${payload.replyTo} reached a gone session — reply fallback (lineage parent or picker)`)
    const injectText = await renderTopicPayload(threadId, payload)
    if (injectText === null) return false
    return handleReplyRoute({ kind: "reply-route", replyToMessageId: payload.replyTo, injectText, from: payload.from, messageId: payload.messageId, threadId })
  }

  // §4.4 rows 2–3 for a topic the registry knows: its session gets the message wherever it runs;
  // a gone one is answered by answerGoneTopic.
  const routeTopicToSession = async (threadId: number, entry: SessionEntry, payload: TopicPayload): Promise<boolean> => {
    const res = await deliverToSession(entry.key, threadId, payload)
    if (res.kind === "sent") return res.ok
    log(`topic ${threadId}: session ${entry.key} is not running`)
    return answerGoneTopic(threadId, payload, goneTopicReply({ name: res.name ?? entry.name.primary, harness: HARNESS_AGENT[entry.harness] }))
  }

  // §4.4 rows 2–3: a message in a known topic. A live session gets it; a gone one is answered by
  // answerGoneTopic. Never a spawn, never an automatic fallback to another session.
  const handleTopicRoute = async (action: Extract<Action, { kind: "topic-route" }>): Promise<boolean> => {
    const binding = findTopic(loadTopics(), action.threadId)
    const entry = resolveTopicSession(action.threadId, binding)
    if (entry) {
      // A topic bound by pane (the attach picker, a pre-registry spawn) becomes its session's
      // registry topic: it follows the session from now on and is renamed with it (§4.7).
      if (entry.threadId === null && entry.state === "live") patchSessionEntry(ctx, entry.key, { threadId: action.threadId })
      return routeTopicToSession(action.threadId, entry, action.payload)
    }
    // The binding vanished between triage and now (a same-batch store change): the topic is
    // unknown again, so it takes the unknown-topic path rather than dropping the message.
    if (!binding) return handleTopicHold({ kind: "topic-hold", threadId: action.threadId, payload: action.payload })
    // A `/new` spawn runs synchronously inside one handler, so any awaiting-model row seen here is
    // a spawn that never finished (a crash reconcile could not adopt). Nothing will ever bind it:
    // drop it, and the topic takes the unknown-topic path — the attach picker.
    if (binding.status === "awaiting-model") {
      log(`topic ${action.threadId}: dropping unfinished spawn binding — topic is unknown again`)
      updateTopics((topics) => removeTopic(topics, action.threadId))
      return holdUnknownTopicPayload({ kind: "topic-hold", threadId: action.threadId, payload: action.payload })
    }
    if (binding.status === "closed" || !binding.paneId) return answerGoneTopic(action.threadId, action.payload, goneTopicReply(binding))
    const session = topicSessionState({ ...binding, paneId: binding.paneId })
    if (session.state === "gone") {
      log(`topic ${action.threadId}: session ${binding.paneId} is gone — marking closed`)
      updateTopics((topics) => appendTopic(topics, markClosed(binding, Math.floor(Date.now() / 1000))))
      return answerGoneTopic(action.threadId, action.payload, goneTopicReply(binding))
    }
    if (session.state === "unconfirmed") {
      await sendToTopic(action.threadId, session.reply)
      return false
    }
    return deliverTopicPayload(action.threadId, binding.paneId, session.cwd, action.payload)
  }

  // --- unknown-topic hold + attach picker (§4.4 row 4) ---
  // The hold is its own store keyed by threadId, persisted on every mutation (atomic tmp+rename,
  // like the deferred backlog) and restored on bootstrap, so a restart neither loses held
  // messages nor skips their expiry reply. Holds live in memory between mutations; handlers for
  // one thread are serialized by the dispatcher's `thread:<id>` resource key.
  let topicHolds: TopicHold[] = parseHolds(readFileOrNull(ctx.paths.topicHolds))

  if (topicHolds.length) {
    const count = topicHolds.reduce((n, h) => n + h.payloads.length, 0)
    log(`topic holds restored: ${count} message(s) across ${topicHolds.length} topic(s)`)
  }

  const setTopicHolds = (next: TopicHold[]): void => {
    topicHolds = next
    try {
      atomicWrite(ctx.paths.topicHolds, serializeHolds(topicHolds))
    } catch (err) {
      log(`topic holds persist failed: ${err}`)
    }
  }

  // Holds dropped undelivered (expired, or evicted past MAX_TOPIC_HOLDS) are answered in their
  // topic, and their picker loses its buttons.
  const answerDroppedHolds = async (dropped: TopicHold[], why: string): Promise<void> => {
    for (const hold of dropped) {
      log(`topic ${hold.threadId}: hold ${why} with ${hold.payloads.length} undelivered message(s)`)
      for (const id of holdButtonMessages(hold)) void clearMessageKeyboard(ctx, id)
      for (const p of hold.payloads) recordFailed(p.messageId, `thread:${hold.threadId}`, `topic hold ${why}`)
      await sendToTopic(hold.threadId, holdExpiredReply(hold.payloads.length))
    }
  }

  // The picker's buttons: every live session, most recently messaged first.
  const attachSessions = (): Array<{ paneId: string; label: string }> => {
    const fleet = listAgentCandidates()
    const byPane = new Map(fleet.map((c) => [c.paneId, c]))
    const usage = aggregateUsage(parseRoutes(readFileOrNull(ctx.paths.routes)))
    return orderByLruMru(fleet.map((c) => c.paneId), usage).flatMap((paneId) => {
      const candidate = byPane.get(paneId)
      return candidate ? [{ paneId, label: labelFor(candidate, fleet) }] : []
    })
  }

  const handleTopicHold = async (action: Extract<Action, { kind: "topic-hold" }>): Promise<boolean> => {
    // The 📥 Inbox topic (tg-cli#705) belongs to no session: only a tap on, or a reply to, one
    // of its copies does anything there (those never reach this hold).
    if (state.inboxState.threadId === action.threadId) {
      // Answered in General: nothing but question-card copies ever goes into the Inbox.
      await sendMessage(ctx, "📥 the Inbox topic only lists open questions — tap a button on one, or reply to it, to answer it")
      return false
    }
    // The topic got a binding between triage and now (a same-batch picker tap bound it): route
    // instead of re-holding behind a second picker. Symmetric to handleTopicRoute's fallback.
    if (findTopic(loadTopics(), action.threadId) || topicOwner(action.threadId)) {
      return handleTopicRoute({ kind: "topic-route", threadId: action.threadId, payload: action.payload })
    }
    const dirAnswer = newSessionDirAnswer(action)
    if (dirAnswer) return handleNewAnswer(dirAnswer, action.threadId)
    return holdUnknownTopicPayload(action)
  }

  // A path typed in a topic whose ➕ New session flow awaits a directory (tg-cli#735) answers that
  // prompt — an existing directory advances it, anything else gets the "not a directory" reply —
  // and is not held for the new agent. That includes a bare `/word` and a path with spaces: the
  // topic has no agent a harness command could be meant for (daemon verbs were answered before the
  // topic rows). A reply counts too: card replies were answered before the topic rows. Topic
  // messages never reach the flat dir-answer gate in stepUpdates, so this is the topic's own.
  const newSessionDirAnswer = (action: Extract<Action, { kind: "topic-hold" }>): Extract<Action, { kind: "new-answer" }> | null => {
    const p = action.payload
    if (p.type !== "text") return null
    if (![...pendingNew.values()].some((s) => s.bindThreadId === action.threadId && s.status === "awaiting-dir")) return null
    const path = (p.plain ?? p.text).trim()
    return isAbsolute(path) ? { kind: "new-answer", text: path, from: p.from, messageId: p.messageId } : null
  }

  // The hold itself, without the "bound meanwhile?" re-check: handleTopicRoute's awaiting-model drop
  // calls this directly, so a failed store write can never bounce route ↔ hold forever.
  const holdUnknownTopicPayload = async (action: Extract<Action, { kind: "topic-hold" }>): Promise<boolean> => {
    const { kept, evicted } = capHolds(holdPayload(topicHolds, action.threadId, action.payload, Math.floor(Date.now() / 1000)))
    setTopicHolds(kept)
    log(`topic ${action.threadId}: unknown topic — held message ${action.payload.messageId}`)
    recordHeld(action.payload.messageId, `thread:${action.threadId}`, "topic-hold")
    // ✍️ ("noted, queued") instead of 👀: the message has not reached a session yet.
    queueAckReaction(action.payload.messageId, DEFER_REACTION)
    await answerDroppedHolds(evicted, "evicted (too many held topics)")
    const hold = findHold(topicHolds, action.threadId)
    if (!hold || hold.pickerMessageId !== null) return true
    const sessions = attachSessions()
    // With no live session there is nothing to attach to: that notice (with only ➕ New session) is
    // posted once per hold. A later message re-checks, and posts the full picker once a session
    // has started.
    if (sessions.length === 0 && hold.noSessionNoticeId !== undefined) return true
    const pickerId = await sendMessage(ctx, attachPickerText(sessions.length), {
      message_thread_id: action.threadId,
      reply_markup: { inline_keyboard: buildAttachKeyboard(action.threadId, sessions) },
    })
    // A failed send stays unrecorded, so the next message retries it.
    if (pickerId === null) return true
    setTopicHolds(
      sessions.length > 0 ? setHoldPicker(topicHolds, action.threadId, pickerId) : markNoSessionNotice(topicHolds, action.threadId, pickerId),
    )
    return true
  }

  const attachRuntime: AttachRuntime = { ctx, loadTopics, updateTopics, deliverToSession, deliverTopicPayload, topicSessionState, settleAckReaction }

  // A pick: deliver the whole queue to the chosen session in order, exactly once. When that
  // session has no topic yet this topic becomes its topic (renamed to its title); when it
  // already has one, this topic stays unbound and the reply links the session's own topic.
  const handleTopicAttach = async (action: Extract<Action, { kind: "topic-attach" }>): Promise<boolean> => {
    const hold = findHold(topicHolds, action.threadId)
    if (!hold || isStalePicker(hold, action.messageId)) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired — nothing is waiting here")
      if (action.messageId !== null) void clearMessageKeyboard(ctx, action.messageId)
      return true
    }
    const fleet = listAgentCandidates()
    const target = fleet.find((c) => c.paneId === action.paneId)
    if (!target) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "that session is no longer running — pick another")
      // Forget the stale picker so the next message in this topic posts a fresh one over the
      // sessions running then, instead of stranding the hold behind dead buttons until its TTL.
      if (hold.pickerMessageId !== null) {
        void clearMessageKeyboard(ctx, hold.pickerMessageId)
        setTopicHolds(setHoldPicker(topicHolds, action.threadId, null))
      }
      return false
    }
    const label = labelFor(target, fleet)
    const session = { paneId: target.paneId, name: label, path: target.panePath, harness: target.agent }
    // Take the queue BEFORE the first await: a second tap on the same picker then finds no hold,
    // so every payload is delivered exactly once.
    setTopicHolds(dropHold(topicHolds, action.threadId))
    const progress: AttachProgress = { outcome: "", delivered: 0, stopped: null }
    const job: AttachJob = { threadId: action.threadId, hold, target, session, label }
    // Everything after the drop is guarded: the queue is already taken, so a throw anywhere below
    // must still answer for the undelivered tail rather than drop it silently.
    try {
      await answerCallbackQuery(ctx, action.callbackQueryId, "sending…")
      await bindAndDeliver(attachRuntime, job, progress)
    } catch (err) {
      log(`topic ${action.threadId}: attach delivery interrupted: ${err}`)
      progress.stopped = "delivery interrupted"
    }
    const summary = attachSummary(label, progress.delivered, hold.payloads.length, progress.stopped)
    log(`topic ${action.threadId}: attach → ${target.paneId} (${summary}; ${progress.outcome})`)
    if (hold.pickerMessageId !== null) void editMessageText(ctx, hold.pickerMessageId, summary)
    else await sendToTopic(action.threadId, summary)
    if (progress.outcome) await sendToTopic(action.threadId, progress.outcome)
    return progress.delivered === hold.payloads.length
  }

  // The picker's ➕ New session tap (tg-cli#735): the /new directory → harness → model flow runs
  // in this topic, and its spawn takes the topic as the new session's own (spawnIntoHeldTopic).
  // The hold stays until that spawn, so the picker's other buttons keep working meanwhile; the tap
  // restarts its clock so it lasts as long as the prompts do. Only a button of the topic's current
  // hold works: a tap after that hold was delivered or expired starts nothing.
  const handleTopicNewSession = async (action: Extract<Action, { kind: "topic-new-session" }>): Promise<boolean> => {
    reapNewSessions()
    // Run the expiry sweep now, not on its next tick: a hold past its TTL is answered and gone, so a
    // late tap cannot revive it.
    await expireTopicHolds()
    const hold = findHold(topicHolds, action.threadId)
    if (!hold || (action.messageId !== null && !holdButtonMessages(hold).includes(action.messageId))) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired — nothing is waiting here")
      if (action.messageId !== null) void clearMessageKeyboard(ctx, action.messageId)
      return true
    }
    // A flow already open for this topic is answered, not restarted: the hold clock is extended
    // once per flow, so re-tapping cannot keep the hold alive forever.
    if ([...pendingNew.values()].some((s) => s.bindThreadId === action.threadId)) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "already started — answer the prompt below")
      return true
    }
    // An open private-topic fallback decision blocks replacing the pending /new, as in handleNewCommand.
    if (state.privateTopicFallbackState === "pending") {
      if ([...pendingNew.values()].some((s) => s.status === "awaiting-private-topic-fallback")) {
        await answerCallbackQuery(ctx, action.callbackQueryId, "finish the open /new first")
        return false
      }
      state.privateTopicFallbackState = "unknown"
    }
    const now = Math.floor(Date.now() / 1000)
    setTopicHolds(restartHoldClock(topicHolds, action.threadId, now))
    // One /new in flight at a time, the same rule a typed /new follows. A replaced flow's prompt
    // loses its buttons, so a second topic's tap never leaves a dead prompt that looks alive.
    for (const replaced of pendingNew.values()) if (replaced.promptMessageId != null) void clearMessageKeyboard(ctx, replaced.promptMessageId)
    pendingNew.clear()
    const session: NewSession = {
      token: `n${++state.newTokenSeq}`,
      name: "",
      status: "awaiting-dir",
      task: "",
      ts: now,
      threadId: action.threadId,
      bindThreadId: action.threadId,
      sourceChatId: ctx.chatId,
      sourceMessageId: action.messageId ?? 0,
    }
    pendingNew.set(session.token, session)
    log(`topic ${action.threadId}: ➕ new session — asking for a directory`)
    await answerCallbackQuery(ctx, action.callbackQueryId, "new session — pick a directory")
    await askNewDir(session)
    return true
  }

  // A refused ➕ New session spawn: the flow ends, its prompt loses its buttons, the topic is told why.
  const closeNewFlow = async (session: NewSession, promptMessageId: number | null, threadId: number, text: string): Promise<false> => {
    pendingNew.delete(session.token)
    if (promptMessageId !== null) await clearMessageKeyboard(ctx, promptMessageId)
    await sendMessage(ctx, text, replyContext(threadId))
    return false
  }

  // The spawn succeeded: settle the claimed texts, rename the topic, replace the picker buttons with
  // the outcome, and answer whatever could not ride the first task.
  const announceHeldSpawn = async (session: NewSession, threadId: number, hold: TopicHold, texts: TextPayload[]): Promise<void> => {
    const target = `thread:${threadId}`
    for (const p of texts) {
      recordDelivery(heldLedgerEvent("delivered", p.messageId, target))
      await settleAckReaction(p.messageId, true)
    }
    await editSessionTopic(ctx, threadId, sessionTopicTitle(session.name))
    const summary = `→ new session ${session.name}: ${texts.length} held message(s) as its first task`
    log(`topic ${threadId}: ${summary}`)
    for (const id of holdButtonMessages(hold)) void editMessageText(ctx, id, summary)
    const left = payloadsNotPassed(hold.payloads, texts)
    if (left.length > 0) {
      for (const p of left) recordFailed(p.messageId, target, "not part of a new session's first task (attachment, or past its size cap)")
      await sendToTopic(threadId, `${left.length} held message(s) not passed to ${session.name} — send them here again`)
    }
  }

  // Spawn a ➕ New session into the topic it was started from. The held text messages, in order,
  // are the agent's initial prompt: argv, so nothing races the agent's startup. The hold is taken
  // and the topic bound before the first await — the model tap runs under its own token lock, so
  // an attach tap on this topic may run concurrently — and it is put back if the spawn fails. Claims
  // reach the ledger before the spawn, so a restored hold can never send them a second time. Held
  // media and voice notes cannot ride an argv prompt and are answered in the topic. A topic whose
  // hold is gone (delivered by an attach tap, or expired) or that got linked spawns nothing.
  const spawnIntoHeldTopic = async (
    session: NewSession,
    threadId: number,
    modelId: string,
    slug: string,
    promptMessageId: number | null,
  ): Promise<boolean> => {
    const hold = findHold(topicHolds, threadId)
    if (!hold || findTopic(loadTopics(), threadId) || topicOwner(threadId)) {
      const why = hold ? "this topic was linked to a session meanwhile" : "nothing is waiting in this topic any more"
      return closeNewFlow(session, promptMessageId, threadId, `${why} — no new agent was spawned; send /new to start one`)
    }
    setTopicHolds(dropHold(topicHolds, threadId))
    const { texts, task } = planHeldTask(session.task, hold.payloads)
    const target = `thread:${threadId}`
    // The sink contract (deliverInboundOnce): a claim that cannot reach the disk sends nothing.
    const claimed = texts.map((p) => recordDelivery(heldLedgerEvent("claimed", p.messageId, target)))
    if (claimed.includes(false)) {
      for (const p of texts) recordFailed(p.messageId, target, "the delivery ledger could not be written")
      setTopicHolds(returnHold(topicHolds, hold))
      return closeNewFlow(session, promptMessageId, threadId, "the delivery ledger could not be written, so no agent was started — the messages are still held; pick again")
    }
    if (!(await spawnNewSessionWithTopic(session, modelId, threadId, slug, promptMessageId, task))) {
      // Unclaimed and held again: the Retry button, or a pick from the picker, still sends them.
      for (const p of texts) recordFailed(p.messageId, target, "the new session did not start")
      setTopicHolds(returnHold(topicHolds, hold))
      return false
    }
    await announceHeldSpawn(session, threadId, hold, texts)
    return true
  }

  // A hold older than TOPIC_HOLD_TTL_SEC is answered in its topic and discarded. Run on a timer
  // and once at bootstrap, so a hold that expired while the daemon was down still gets its reply.
  // The sweep also enforces MAX_TOPIC_HOLDS on a restored store, answering what it evicts. A hold
  // whose ➕ New session flow is still open is not expired: the flow's own TTL (reapNewSessions)
  // bounds it, and its spawn takes the hold.
  const expireTopicHolds = async (): Promise<void> => {
    reapNewSessions()
    const flowing = new Set([...pendingNew.values()].map((s) => s.bindThreadId))
    const { expired: due, open } = splitExpiredHolds(topicHolds, Math.floor(Date.now() / 1000))
    const expired = due.filter((h) => !flowing.has(h.threadId))
    open.push(...due.filter((h) => flowing.has(h.threadId)))
    const { kept, evicted } = capHolds(open)
    if (expired.length === 0 && evicted.length === 0) return
    setTopicHolds(kept)
    await answerDroppedHolds(expired, "expired")
    await answerDroppedHolds(evicted, "evicted (too many held topics)")
  }

  // §4.4 row 5: forum_topic_created / _edited / _closed / _reopened are recorded only. A user
  // topic rename is left alone; nothing is spawned and no tmux window is renamed.
  const handleTopicEvent = (action: Extract<Action, { kind: "topic-event" }>): boolean => {
    log(`topic ${action.threadId}: ${action.event}${action.name ? ` "${action.name}"` : ""}`)
    return true
  }

  return { loadTopics, nextSpawnNonce, persistTopics, updateTopics, topicOwner, topicStatusOf, handleTopicRoute, handleTopicHold, handleTopicAttach, handleTopicNewSession, spawnIntoHeldTopic, expireTopicHolds, handleTopicEvent }
}

export type TopicRoutingApi = ReturnType<typeof createTopicRouting>
