// daemon-runtime/new-session: the /new command flow and topic reconciliation on startup.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { isAbsolute } from "path"
import { findAgentInPane } from "../discover"
import { buildTextInjectPlan } from "../inject"
import { sessionTopicTitle } from "../session-topics"
import { isLikelySlashCommand } from "../updates"
import { appendTopic, findTopicCreatedBy, markBound, markSpawnPending, removeTopic, slugifyTopicName } from "../topics"
import { findModel, harnessLabel, modelsForHarness } from "../models"
import { buildNewPrivateTopicFallbackKeyboard, NEW_PRIVATE_TOPIC_FALLBACK_CANCEL, NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE, nameCollides, type NewSession } from "../new-command"
import type { Action } from "../types"
import { newSessionFromCommand, planCommandDir, replayedNewReply } from "./new-session-plan"
import { log } from "./ctx-io"
import { answerCallbackQuery, clearMessageKeyboard, sendMessage } from "./telegram-api"
import { snapshot } from "./tmux-probe"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { TargetRoutingApi } from "./target-routing"
import type { TopicSpawnApi } from "./topic-spawn"
import type { TopicRoutingApi } from "./topic-routing"
import type { PickerApi } from "./picker-state"
import type { InboundInjectApi } from "./inbound-inject"

export type NewSessionDeps = {
  ctx: Ctx
  state: DaemonState
  targetRouting: TargetRoutingApi
  topicSpawn: TopicSpawnApi
  topicRouting: TopicRoutingApi
  picker: PickerApi
  inboundInject: InboundInjectApi
}

export function createNewSession(d: NewSessionDeps) {
  const { ctx, state } = d
  const { replyContext } = d.targetRouting
  const { isExistingDirectory, spawnTopicWindow, stampSpawnToken, legitimatelyClaimedPanes, reconcileOneTopic, liveWindowNames, createPrivateTopic, spawnNewWindow, askNewDir, askNewModel, advanceNewAfterDir, offerNewRetry } = d.topicSpawn
  const { loadTopics, nextSpawnNonce, persistTopics, updateTopics, spawnIntoHeldTopic } = d.topicRouting
  const { pendingNew, reapNewSessions } = d.picker
  const { injectViaTarget } = d.inboundInject

  // The dir vanished between the prompt and now → back to awaiting-dir so the user re-picks.
  // Clear the stale MODEL keyboard first (review #6) so the user isn't left with two live sets.
  const reaskVanishedDir = async (session: NewSession, promptMessageId: number | null): Promise<boolean> => {
    if (promptMessageId !== null) await clearMessageKeyboard(ctx, promptMessageId)
    session.status = "awaiting-dir"
    session.ts = Math.floor(Date.now() / 1000)
    await sendMessage(ctx, `\`${session.dir ?? "(none)"}\` is not an absolute existing directory — send a full path like /Users/you/project.`, replyContext(session.threadId))
    await askNewDir(session)
    return false
  }

  // Private topics are on but unavailable: ask whether to continue flat. The session parks in
  // awaiting-private-topic-fallback; if the question itself cannot be sent, re-ask the model.
  const askPrivateTopicFallback = async (session: NewSession, modelId: string, promptMessageId: number | null, message: string): Promise<boolean> => {
    session.model = modelId
    session.ts = Math.floor(Date.now() / 1000)
    if (promptMessageId !== null) await clearMessageKeyboard(ctx, promptMessageId)
    const fallbackPromptMessageId = await sendMessage(ctx, message, {
      ...replyContext(session.threadId),
      reply_markup: { inline_keyboard: buildNewPrivateTopicFallbackKeyboard(session.token) },
    })
    if (fallbackPromptMessageId === null) {
      state.privateTopicFallbackState = "unknown"
      session.status = "awaiting-model"
      await askNewModel(session)
      return false
    }
    session.status = "awaiting-private-topic-fallback"
    session.promptMessageId = fallbackPromptMessageId
    return false
  }

  // Do the actual spawn for a session that has name + dir + model, then DELETE the session (the
  // agent is now a plain pane). On a spawn failure the session moves to `awaiting-retry` (all
  // answers preserved) and offers a Retry button — it never re-asks. Clears the prompt keyboard on
  // success so it can't be re-tapped.
  const spawnNewSession = async (session: NewSession, modelId: string, promptMessageId: number | null): Promise<boolean> => {
    const out = replyContext(session.threadId)
    if (!session.dir || !isAbsolute(session.dir) || !isExistingDirectory(session.dir)) return reaskVanishedDir(session, promptMessageId)
    const slug = slugifyTopicName(session.name, 0)
    if (session.bindThreadId !== undefined) return spawnIntoHeldTopic(session, session.bindThreadId, modelId, slug, promptMessageId)
    const spawnToken = `new-${session.token}-${Math.floor(Date.now() / 1000)}`
    // Private-chat topic: try to create a per-session topic BEFORE spawning so the window is born
    // with TG_TOPIC already set. Failure (capability/API error) → graceful flat fallback.
    const privateTopic = ctx.cfg.privateTopics ? await createPrivateTopic(sessionTopicTitle(session.name)) : null
    if (privateTopic?.kind === "topic") {
      return spawnNewSessionWithTopic(session, modelId, privateTopic.threadId, slug, promptMessageId)
    }
    if (privateTopic?.kind === "ask") return askPrivateTopicFallback(session, modelId, promptMessageId, privateTopic.message)
    if (privateTopic?.kind === "fallback" && privateTopic.message) {
      await sendMessage(ctx, privateTopic.message, out)
    }
    if (privateTopic?.kind === "waiting") {
      await sendMessage(ctx, "private-topic fallback choice is already open — tap Continue without topics or Cancel this spawn.", out)
      return false
    }
    // Flat spawn path (no private topic, or createForumTopic failed gracefully).
    const spawned = spawnNewWindow(slug, session.dir, modelId, session.task, spawnToken)
    if (!spawned.ok) {
      // Spawn FAILED → report the error once and offer a Retry button (answers preserved), NEVER
      // re-ask the model. See offerNewRetry.
      return offerNewRetry(session, spawned.error, promptMessageId)
    }
    stampSpawnToken(spawned.paneId, spawnToken)
    pendingNew.delete(session.token)
    if (promptMessageId !== null) await clearMessageKeyboard(ctx, promptMessageId)
    const taskNote = session.task.trim().length > 0 ? ` with task: ${session.task.trim()}` : ""
    await sendMessage(ctx, `spawned \`${modelId}\` in \`${session.dir}\` (window \`${slug}\`)${taskNote} — use \`/agent ${slug}\` to talk to it`, out)
    return true
  }

  // Private-chat topic spawn path: topic was created (threadId known), now spawn and bind. Extracted
  // from spawnNewSession to keep it under ~50 lines each. Handles the full lifecycle:
  //   - Write a spawnPending awaiting-model binding BEFORE `tmux new-window`, so a crash between a
  //     successful new-window and the `bound` write leaves a row startup reconcile can adopt.
  //   - On spawn FAILURE: drop that binding — the topic is unknown again, so a message there gets
  //     the attach picker (the Retry button re-runs this whole path).
  //   - On spawn SUCCESS: upgrade to a `bound` binding; call stampSpawnToken for log greppability.
  // Supergroup topic /new has no task tail, but private-chat flat /new can pass one through here.
  // `task` is the agent's initial prompt: the /new tail, or a ➕ New session's held text.
  const spawnNewSessionWithTopic = async (
    session: NewSession,
    modelId: string,
    threadId: number,
    slug: string,
    promptMessageId: number | null,
    task = session.task,
  ): Promise<boolean> => {
    const out = replyContext(session.threadId)
    const ts = Math.floor(Date.now() / 1000)
    // `harness` makes a later "not running" reply name this harness's resume command.
    const preliminary = { threadId, name: session.name, status: "awaiting-model" as const, path: session.dir, model: modelId, harness: findModel(modelId)?.kind, sourceChatId: session.sourceChatId, sourceMessageId: session.sourceMessageId, ts }
    const spawnToken = `${threadId}-${ts}-${nextSpawnNonce()}`
    updateTopics((topics) => appendTopic(topics, markSpawnPending(preliminary, spawnToken, ts)))
    const spawned = spawnTopicWindow(threadId, slug, session.dir, modelId, task)
    if (!spawned.ok) {
      updateTopics((topics) => removeTopic(topics, threadId))
      // Report the error once and offer a Retry button (answers preserved), never re-ask the model.
      return offerNewRetry(session, spawned.error, promptMessageId)
    }
    // Upgrade the preliminary binding to `bound` now that the pane exists. Do not persist a
    // spawnPending record with paneId: a crash between that write and markBound would leave a
    // contradictory durable state.
    stampSpawnToken(spawned.paneId, spawnToken)
    const boundTs = Math.floor(Date.now() / 1000)
    updateTopics((topics) => appendTopic(topics, markBound(preliminary, spawned.paneId, boundTs)))
    pendingNew.delete(session.token)
    if (promptMessageId !== null) await clearMessageKeyboard(ctx, promptMessageId)
    const taskNote = session.task.trim().length > 0 ? ` with task: ${session.task.trim()}` : ""
    await sendMessage(ctx, `spawned \`${modelId}\` in \`${session.dir}\` (window \`${slug}\`)${taskNote} — use \`/agent ${slug}\` to talk to it`, out)
    return true
  }

  // An open private-topic fallback decision is a live user decision: it blocks replacing the
  // pending /new until Continue/Cancel or expiry. A stale "pending" with no such session left is reset.
  const openFallbackBlocksNew = (): boolean => {
    if (state.privateTopicFallbackState !== "pending") return false
    if ([...pendingNew.values()].some((s) => s.status === "awaiting-private-topic-fallback")) return true
    state.privateTopicFallbackState = "unknown"
    return false
  }

  // A `/new [<harness>|<model>] [<dir>] name [<task>]` command → start (or short-circuit) the
  // flow. With a name+dir+model all supplied the agent spawns immediately; otherwise the missing
  // piece is asked via buttons. A name collision with a live window is a non-fatal WARNING (tmux
  // allows dup names).
  const handleNewCommand = async (action: Extract<Action, { kind: "new-command" }>): Promise<boolean> => {
    reapNewSessions()
    // A crash mid-spawn leaves this `/new` in the pending-batch journal and the restarted daemon
    // replays it — AFTER startup reconcile already adopted (or can adopt) the orphan its first run
    // spawned. A private-topic binding carrying this chat + message id proves the first run got as
    // far as creating the topic, so re-running would create a second topic + a second agent. (The
    // flat fallback spawn writes no binding, so it has no such guard — #500.) The first run may
    // have died before its "spawned …" reply, so the skip is acknowledged.
    const out = replyContext(action.threadId)
    const alreadyCreated = findTopicCreatedBy(loadTopics(), action.chatId, action.messageId)
    if (alreadyCreated) {
      log(`new-command: message ${action.chatId}/${action.messageId} already created topic ${alreadyCreated.threadId} (${alreadyCreated.status}) before a restart — replayed /new not re-run`)
      await sendMessage(ctx, replayedNewReply(alreadyCreated), out)
      return true
    }
    if (!action.name) {
      await sendMessage(ctx, "usage: /new [<harness>|<model>] [<dir>] <name> [<task>] — e.g. `/new codex /Users/you/app api fix the build`", out)
      return false
    }
    if (openFallbackBlocksNew()) {
      await sendMessage(ctx, "private-topic fallback choice is already open — tap Continue without topics or Cancel this spawn.", out)
      return false
    }
    // Name-uniqueness WARNING (issue #27): warn if the resulting window slug collides, don't block.
    const slug = slugifyTopicName(action.name, 0)
    if (nameCollides(slug, liveWindowNames())) {
      await sendMessage(ctx, `⚠️ a window named \`${slug}\` already exists — the new agent will share the name. Continuing.`, out)
    }
    // A flat chat has at most ONE /new in flight (review #2): a second /new normally REPLACES any
    // prior pending session, so a typed path can never be mis-applied to a stale earlier session.
    // Exception: an open private-topic fallback confirmation is a live user decision, so it blocks
    // replacement until Continue/Cancel or expiry (handled above).
    pendingNew.clear()
    const plan = planCommandDir(action.dir, action.task, action.dirAfterName, action.dir ? isAbsolute(action.dir) && isExistingDirectory(action.dir) : false)
    if (plan.rejected) await sendMessage(ctx, `\`${plan.rejected}\` is not an absolute existing directory — pick one below or send a full path.`, out)
    const token = `n${++state.newTokenSeq}`
    const session = newSessionFromCommand(token, action, plan, Math.floor(Date.now() / 1000))
    pendingNew.set(token, session)
    // Model already supplied AND dir resolved → spawn straight away (no buttons).
    if (plan.dir && session.model) return spawnNewSession(session, session.model, null)
    // Model supplied but dir missing → ask dir; we'll spawn with the supplied model once dir lands.
    if (plan.dir) return advanceNewAfterDir(session)
    await askNewDir(session)
    return true
  }

  // A typed path answer to an awaiting-dir /new session. Matches the SINGLE awaiting-dir session
  // (a flat chat has at most one /new in flight). Validates the abs path, then advances: if a model
  // was already supplied on the command line, spawn now; else ask the model.
  // `bindThreadId`: the topic a ➕ New session answer was typed in — it answers that topic's flow
  // only; a flat answer (undefined) answers only a flat /new. Neither picks the other's prompt, even
  // when a tap elsewhere replaced the pending /new between triage and here.
  const handleNewAnswer = async (action: Extract<Action, { kind: "new-answer" }>, bindThreadId?: number): Promise<boolean> => {
    reapNewSessions()
    // The NEWEST awaiting-dir session owns the typed path (review #2): even though handleNewCommand
    // clears prior sessions on a fresh /new, take the newest as a belt-and-suspenders so the path
    // always lands on the prompt the user is actually answering.
    const session = [...pendingNew.values()]
      .filter((s) => s.status === "awaiting-dir" && s.bindThreadId === bindThreadId)
      .sort((a, b) => b.ts - a.ts)[0]
    if (!session) return false // no /new awaiting a dir — defensive (stepUpdates only emits when one is)
    const out = replyContext(session.threadId)
    const path = action.text.trim()
    // Reject the filesystem ROOT as a typed cwd (review #4): the dir BUTTONS already exclude `/`
    // (parentDirs stops above root — spawning an agent at `/` is never the intent), so mirror that
    // guard for a typed `/` instead of letting it slip past `isExistingDirectory('/')`.
    if (path === "/") {
      await sendMessage(ctx, "the filesystem root `/` isn't a project directory — send a real project path like /Users/you/project.", out)
      return false
    }
    if (!path || !isAbsolute(path) || !isExistingDirectory(path)) {
      // The text isn't a usable directory. A BARE `/word` (isLikelySlashCommand) is most likely a
      // HARNESS passthrough command — `/compact`, `/clear` — meant for the live 1:1 agent, NOT a
      // path attempt (review #1, second pass): so inject it through instead of erroring, preserving
      // 1:1 passthrough even mid-/new. The session stays awaiting-dir (the user can still answer the
      // dir prompt). A `/path/with/slashes` that doesn't exist IS a genuine bad-path attempt → the
      // dir error. An empty / non-slash answer (the stepUpdates gate only emits slash text, but be
      // defensive) also re-asks.
      // A ➕ New session's topic has no agent to pass a command to: the bare word is a bad path there.
      if (path.startsWith("/") && isLikelySlashCommand(path) && session.bindThreadId === undefined) {
        // A harness control-command passthrough (/compact, /clear), not new content — no
        // git-state banner (see withGitStateBanner's scope note).
        return injectViaTarget((target) => buildTextInjectPlan(target.pane.paneId, path), path, true, action.messageId)
      }
      await sendMessage(ctx, `\`${path || "(empty)"}\` is not an absolute path to an existing directory — send a full path like /Users/you/project.`, out)
      return false
    }
    session.dir = path
    session.ts = Math.floor(Date.now() / 1000)
    if (session.promptMessageId != null) await clearMessageKeyboard(ctx, session.promptMessageId)
    // If a model was supplied on the /new line, spawn immediately; else ask harness/model.
    return advanceNewAfterDir(session)
  }

  // A recent-dir button tap (tnp:<token>:<index>) → resolve the index against the session's
  // dirChoices and advance like a typed path. A stale/forged tap (no session, wrong state, bad
  // index, vanished dir) re-asks rather than spawning into a guessed dir.
  const handleNewDir = async (action: Extract<Action, { kind: "new-dir" }>): Promise<boolean> => {
    reapNewSessions()
    const session = pendingNew.get(action.token)
    if (!session || session.status !== "awaiting-dir") {
      await answerCallbackQuery(ctx, action.callbackQueryId, "that menu expired — send a directory")
      return false
    }
    const path = session.dirChoices?.[action.index]
    if (!path || !isAbsolute(path) || !isExistingDirectory(path)) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "that path is gone — send one")
      await sendMessage(ctx, `\`${path ?? "(unknown)"}\` is no longer an existing directory — send an absolute path.`, replyContext(session.threadId))
      return false
    }
    await answerCallbackQuery(ctx, action.callbackQueryId, "ok")
    session.dir = path
    session.ts = Math.floor(Date.now() / 1000)
    if (action.messageId !== null) await clearMessageKeyboard(ctx, action.messageId)
    return advanceNewAfterDir(session)
  }

  // A harness button tap (tnh:<token>:<harness>) → ask the model picker for that harness only.
  const handleNewHarness = async (action: Extract<Action, { kind: "new-harness" }>): Promise<boolean> => {
    reapNewSessions()
    const session = pendingNew.get(action.token)
    if (!session) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired — run /new again")
      return false
    }
    if (session.status !== "awaiting-harness" || !session.dir) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "pick a directory first")
      return false
    }
    const catalog = modelsForHarness(action.harness)
    if (catalog.length === 0) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "no models")
      await sendMessage(ctx, `no models configured for \`${harnessLabel(action.harness)}\``, replyContext(session.threadId))
      return false
    }
    await answerCallbackQuery(ctx, action.callbackQueryId, "ok")
    session.harness = action.harness
    session.ts = Math.floor(Date.now() / 1000)
    if (action.messageId !== null) await clearMessageKeyboard(ctx, action.messageId)
    await askNewModel(session)
    return true
  }

  // A model button tap (tnm:<token>:<modelId>) → spawn the agent with that model. Refuses an
  // unknown model id (stale/forged callback) and an out-of-state session (already spawned / gone).
  const handleNewModel = async (action: Extract<Action, { kind: "new-model" }>): Promise<boolean> => {
    reapNewSessions()
    const session = pendingNew.get(action.token)
    if (!session) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired — run /new again")
      return false
    }
    if (session.status !== "awaiting-model" || !session.dir) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "send a directory first")
      return false
    }
    const modelEntry = findModel(action.modelId)
    if (!modelEntry) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "unknown model")
      await sendMessage(ctx, `unknown model \`${action.modelId}\` — pick a model again`, replyContext(session.threadId))
      return false
    }
    if (session.harness && modelEntry.kind !== session.harness) {
      await answerCallbackQuery(ctx, action.callbackQueryId, `pick a ${harnessLabel(session.harness)} model`)
      return false
    }
    await answerCallbackQuery(ctx, action.callbackQueryId, "starting…")
    session.model = action.modelId
    session.harness = modelEntry.kind
    return spawnNewSession(session, action.modelId, action.messageId)
  }

  // A "Retry spawn" tap (tnr:<token>) after a spawn failure → re-run the spawn with the session's
  // preserved name/dir/harness/model. Refuses a stale/forged tap (no session, wrong state, or a
  // model that vanished from the catalog). NEVER re-asks — the whole point of the retry button.
  const handleNewRetry = async (action: Extract<Action, { kind: "new-retry" }>): Promise<boolean> => {
    reapNewSessions()
    const session = pendingNew.get(action.token)
    if (!session) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired — run /new again")
      return false
    }
    if (session.status !== "awaiting-retry" || !session.model || !findModel(session.model)) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "nothing to retry — run /new again")
      return false
    }
    await answerCallbackQuery(ctx, action.callbackQueryId, "retrying…")
    return spawnNewSession(session, session.model, action.messageId)
  }

  const handleNewPrivateTopicFallback = async (action: Extract<Action, { kind: "new-private-topic-fallback" }>): Promise<boolean> => {
    reapNewSessions()
    const session = pendingNew.get(action.token)
    if (!session || session.status !== "awaiting-private-topic-fallback" || !session.dir || !session.model) {
      // A stale/reaped token must NOT clobber a DIFFERENT session's live pending fallback
      // decision -- only fall back to "unknown" when nothing is actually awaiting an answer
      // (mirrors the `hasPendingFallback` guard in handleNewCommand, tg-cli#181).
      if (state.privateTopicFallbackState === "pending") {
        const hasPendingFallback = [...pendingNew.values()].some((s) => s.status === "awaiting-private-topic-fallback")
        if (!hasPendingFallback) state.privateTopicFallbackState = "unknown"
      }
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired — run /new again")
      return false
    }
    if (action.choice === NEW_PRIVATE_TOPIC_FALLBACK_CANCEL) {
      state.privateTopicFallbackState = "unknown"
      pendingNew.delete(action.token)
      await answerCallbackQuery(ctx, action.callbackQueryId, "cancelled")
      if (action.messageId !== null) await clearMessageKeyboard(ctx, action.messageId)
      await sendMessage(ctx, "cancelled — no agent was spawned", replyContext(session.threadId))
      return false
    }
    if (action.choice === NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE) {
      state.privateTopicFallbackState = "accepted"
      await answerCallbackQuery(ctx, action.callbackQueryId, "starting without topics…")
      if (action.messageId !== null) await clearMessageKeyboard(ctx, action.messageId)
      return spawnNewSession(session, session.model, action.messageId)
    }
    await answerCallbackQuery(ctx, action.callbackQueryId, "expired — run /new again")
    return false
  }

  // --- crash-window orphan reconcile ---
  // CRASH GAP: a flat /new private-topic spawn persists awaiting-model → `tmux new-window` →
  // persists `bound`. A daemon crash BETWEEN a successful new-window and the `bound` write leaves
  // a LIVE orphan pane plus an `awaiting-model` binding. On startup, reconcile each non-bound
  // binding against the live tmux windows by SLUG: if the topic-slug window already hosts the
  // spawned agent, RE-BIND that pane (adopt the orphan); also mark any `bound` binding whose
  // session is gone as `closed` (it exited while the daemon was down), so the next message in
  // that topic gets the "not running" reply instead of injecting into nothing.
  // Runs ONCE at startup when either public forum topics or private-chat topics use the TopicBinding
  // store, fully guarded (never aborts startup).
  const reconcileTopicsOnStartup = (): void => {
    if (!ctx.cfg.topics && !ctx.cfg.privateTopics) return
    try {
      const topics = loadTopics()
      if (topics.length === 0) return
      const { panes, procs } = snapshot()
      // An empty/flaky snapshot (the known launchd no-locale read) must NOT trigger reconciliation:
      // it would mass-close every live binding. Skip when no panes are visible.
      if (panes.length === 0) return
      const liveAgentPanes = panes.filter((p) => findAgentInPane(p, procs) !== null)
      // SECOND flake guard: a non-empty `panes` but ZERO live-agent panes most likely means the
      // `procs` (ps) read flaked (panesWithRetry resilience is per-source). Closing every `bound`
      // binding off that empty procs read would falsely kill live topics. So when we have bound
      // bindings to reconcile yet found NO agent anywhere, treat it as a flaky read and skip — a
      // genuinely all-dead fleet self-heals on the next message (handleTopicRoute re-probes per pane).
      const hasBound = topics.some((t) => t.status === "bound")
      if (liveAgentPanes.length === 0 && hasBound) return
      const ts = Math.floor(Date.now() / 1000)
      // Panes a `bound` binding LEGITIMATELY holds — never adopt one for an orphan. Mutated as we
      // adopt (a pane adopted by one binding can't ALSO be adopted by a slug-colliding sibling).
      const claimed = legitimatelyClaimedPanes(topics, liveAgentPanes)
      let changed = false
      const reconciled = topics.map((binding) => {
        const next = reconcileOneTopic(binding, liveAgentPanes, claimed, ts)
        if (next !== binding) {
          changed = true
          if (next.status === "bound" && next.paneId) claimed.add(next.paneId) // reserve the adopted pane
        }
        return next
      })
      if (changed) persistTopics(reconciled)
    } catch (err) {
      log(`reconcileTopicsOnStartup failed: ${err}`)
    }
  }

  return { spawnNewSession, spawnNewSessionWithTopic, handleNewCommand, handleNewAnswer, handleNewDir, handleNewHarness, handleNewModel, handleNewRetry, handleNewPrivateTopicFallback, reconcileTopicsOnStartup }
}

export type NewSessionApi = ReturnType<typeof createNewSession>
