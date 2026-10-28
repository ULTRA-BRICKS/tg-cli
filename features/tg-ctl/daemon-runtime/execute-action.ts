// daemon-runtime/execute-action: per-action resource keys and executeAction.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`. executeAction itself is a
// normalise → owner-only gate → per-kind handler table dispatch; the multi-step kinds (answer-question,
// kill-agent, inject-text, post-timeout reply) are named closures below.
import { buildKeyInjectPlan, buildTextInjectPlan } from "../inject"
import { buildAnsweredQuestionText, closedQuestionText, formatAgentHookOutput, hatchParseMode, isHatchRequest, resolveButtonCallback, type ButtonAnswer, type ButtonRequest } from "../questions"
import { CLOSE_STATUS, freeTextAnswer, hatchSiblingsOf } from "../question-inbox"
import { closeDecidedCard } from "../grants"
import { ownerOnlyAnswerAllowed } from "../generic-ask"
import type { Action } from "../types"
import { log } from "./ctx-io"
import { ANSWERED_REPLAY_MS, decidedRetainMs, describeAskRequest, pruneAnsweredButtons, type AnsweredButton, type PendingButton } from "./button-requests"
import { answerCallbackQuery, answerCallbackQueryOrNotify, clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"
import { composeStatus, topicSettingsLine } from "./status-command"
import { composeLimitStatus, composeUsageReport, deliverDailyReport, sendReportChunks } from "./usage-records"
import { runTasksCommand } from "./tasks-board"
import { runChatgptCallback, runChatgptMenu } from "./chatgpt-command"
import { isForeignCardTap } from "./late-taps-question"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { QuestionInboxApi } from "./question-inbox-runtime"
import type { StartupApi } from "./daemon-startup"
import type { TargetRoutingApi } from "./target-routing"
import type { LateTapsApi } from "./late-taps"
import type { DeferQueueApi } from "./defer-queue"
import type { AutoContinueApi } from "./auto-continue"
import type { AgentRoutesApi } from "./agent-routes"
import type { InboundInjectApi } from "./inbound-inject"
import type { MediaApi } from "./media-voice"
import type { TopicRoutingApi } from "./topic-routing"
import type { NewSessionApi } from "./new-session"
import type { ReactionsApi } from "./ack-reactions"

export type ExecuteDeps = {
  ctx: Ctx
  state: DaemonState
  questionInbox: QuestionInboxApi
  startup: StartupApi
  targetRouting: TargetRoutingApi
  lateTaps: LateTapsApi
  deferQueue: DeferQueueApi
  autoContinue: AutoContinueApi
  agentRoutes: AgentRoutesApi
  inboundInject: InboundInjectApi
  media: MediaApi
  topicRouting: TopicRoutingApi
  newSession: NewSessionApi
  reactions: ReactionsApi
}

type ActionOfKind = { [A in Action as A["kind"]]: A }
type ActionKind = keyof ActionOfKind
type ActionHandlers = { [K in ActionKind]: (action: ActionOfKind[K], precedingOk: boolean) => boolean | Promise<boolean> }
type AnswerQuestionAction = ActionOfKind["answer-question"]
type CardAnswerAction = ActionOfKind["answer-question" | "close-question-card" | "post-timeout-question-reply"]
type GivenAnswer = Extract<ButtonAnswer, { status: "answered" }>

// The shared-state key for actions that read-then-write a Map keyed by a shared identifier
// (tg-cli#357): actions carrying the same key still run strictly in enqueue order via
// dispatchQueues below (preserving every existing double-tap/race guard); `null` means the
// action touches no shared keyed state and is always safe to run fully concurrently.
export function actionResourceKey(action: Action): string | null {
  switch (action.kind) {
    case "topic-route":
    case "topic-hold":
    case "topic-attach":
    case "topic-event":
      return `thread:${action.threadId}`
    // Every /new step — a typed /new, a ➕ New session tap, a dir/harness/model/retry tap — reads
    // or replaces the one global pending /new: they run one at a time, so a tap can never act on
    // a flow another step is replacing.
    case "topic-new-session":
    case "new-command":
    case "new-dir":
    case "new-harness":
    case "new-model":
    case "new-retry":
      return "new-session"
    case "agent-callback":
    case "agent-cancel":
      return `token:${action.token}`
    case "answer-question":
    case "close-question-card":
    case "post-timeout-question-reply":
      return `req:${action.requestId}`
    case "limit-continue":
      return `pane:${action.paneId}`
    default:
      return null
  }
}

// A tap on — or a reply to — a card's 📥 Inbox copy acts on the card itself (tg-cli#705):
// every guard and edit below compares and edits the card's own message id.
export function withCardMessageId(action: Action, cardMessageIdFor: (messageId: number) => number): Action {
  if ((action.kind === "answer-question" || action.kind === "close-question-card") && action.messageId !== null) {
    return { ...action, messageId: cardMessageIdFor(action.messageId) }
  }
  if (action.kind === "post-timeout-question-reply") return { ...action, questionMessageId: cardMessageIdFor(action.questionMessageId) }
  return action
}

export function isCardAnswerAction(action: Action): action is CardAnswerAction {
  return action.kind === "answer-question" || action.kind === "close-question-card" || action.kind === "post-timeout-question-reply"
}

// We ANSWERED it WITHIN the replay window: the tap is on an already-resolved card, not a truly-expired
// prompt (tg-cli#97). Gated on the same window as the hook-path replay so the two never disagree on
// whether an entry is still "answered" vs aged-out.
export function isStillAnswered(prior: AnsweredButton | undefined, now: number): boolean {
  return prior !== undefined && now - prior.at <= ANSWERED_REPLAY_MS
}

// Remember a QUESTION's answer briefly so a re-forward of the SAME requestId
// (the AskUserQuestion double-cover / re-fire race) replays it instead of
// posting a second card (tg-cli#97). Scoped to questions on purpose: a
// permission's requestId is also stable, but silently replaying a prior
// allow/deny without re-prompting would be a behavioral/security change the
// bug never asked for — and permissions have no double-card problem (they
// forward via a single catch-all matcher, not a dedicated + catch-all pair).
//
// A multi-question SET MEMBER is never cached: the group is
// all-or-nothing — if a later member aborts, the whole call is re-asked,
// and a replayed member would silently stitch a STALE answer into the
// NEW round without ever showing its card (review finding). The cost is
// symmetric honesty: a re-fired identical set re-posts its cards.
export function shouldCacheAnswerForReplay(req: ButtonRequest): boolean {
  return req.kind === "question" && !req.multiQuestion
}

// What the card reads once answered: the typed chat answer (tg-cli#705) or the tapped option's label.
export function liveAnswerFinalText(req: ButtonRequest, label: string, freeText: string | undefined): string {
  return freeText !== undefined ? closedQuestionText(req, CLOSE_STATUS.answeredInChat(freeText.trim())) : buildAnsweredQuestionText(req, label)
}

export function createExecute(d: ExecuteDeps) {
  const { ctx, state } = d
  const { cardMessageIdFor, persistQuestions, grantsData, persistGrants } = d.questionInbox
  const { pendingButtons, activeButtonKeys, answeredButtons, abandonedButtons, closableCards } = d.startup
  const { discover, withGitStateBanner, replyContext, candidatesForPicker, replyNoAgent } = d.targetRouting
  const { handleGraceStoreTap, lateDeliverAbandonedQuestion, handlePostTimeoutQuestionReply, handleCloseQuestionCard } = d.lateTaps
  const { flushDeferred, onUnscopedRelease, closeOpenCard } = d.deferQueue
  const { handleLimitContinue } = d.autoContinue
  const { injectIntoSelectedAgent, handleAgentRoute, handleAgentCallback, handleAgentCancelCallback, handleReplyRoute } = d.agentRoutes
  const { injectViaTarget, postSelectPicker } = d.inboundInject
  const { downloadMedia, transcribeVoice } = d.media
  const { handleTopicRoute, handleTopicHold, handleTopicAttach, handleTopicNewSession, handleTopicEvent } = d.topicRouting
  const { handleNewCommand, handleNewAnswer, handleNewDir, handleNewHarness, handleNewModel, handleNewRetry, handleNewPrivateTopicFallback } = d.newSession
  const { settleAckReaction } = d.reactions

  // ownerOnly cards: one predicate for every answer path (tap, close, text reply). Returns true when the
  // action was refused (and the tapper told).
  const refuseNonOwnerAnswer = async (action: CardAnswerAction): Promise<boolean> => {
    const card = pendingButtons.get(action.requestId) ?? abandonedButtons.get(action.requestId)
    if (!card?.req.ownerOnly || ownerOnlyAnswerAllowed(ctx.chatId, action.actor)) return false
    log(`ask-answer-refused: req=${action.requestId} kind=${action.kind} reason=owner-only`)
    if ("callbackQueryId" in action && action.callbackQueryId) await answerCallbackQuery(ctx, action.callbackQueryId, "not allowed")
    return true
  }

  // A text reply to a LIVE question card (or its Inbox copy) answers it down the hook
  // socket, like a tap; a retained card's answer is typed into its pane.
  const replyToQuestionCard = (action: ActionOfKind["post-timeout-question-reply"], precedingOk: boolean): boolean | Promise<boolean> => {
    const live = pendingButtons.get(action.requestId)
    if (live && live.messageId === action.questionMessageId) {
      return executeAction(
        {
          kind: "answer-question",
          callbackQueryId: "",
          requestId: action.requestId,
          value: "",
          messageId: action.questionMessageId,
          freeText: action.text,
          ...(action.threadId !== undefined ? { threadId: action.threadId } : {}),
          ...(action.actor ? { actor: action.actor } : {}),
        },
        precedingOk,
      )
    }
    return handlePostTimeoutQuestionReply(action)
  }

  // No LIVE prompt for this key. FIRST try late-delivery: a tap on a still-
  // retained (abandoned) question injects the chosen option into its pane
  // instead of being dropped (this PR). Only if there is nothing to deliver
  // do we fall back to the toasts below.
  const answerWithoutLivePrompt = async (action: AnswerQuestionAction): Promise<boolean> => {
    if (await lateDeliverAbandonedQuestion(action)) return true
    // Grant protocol v1.1 (tg-cli#398): a tap on an expired HATCH card whose
    // retained entry is gone (a decision closed it / daemon restarted) —
    // the 24h grace store keeps it addressable, so a late Approve can still
    // mint a grant. Non-hatch taps fall straight through.
    if (await handleGraceStoreTap(action)) return true
    // If we ANSWERED it WITHIN the replay window the tap is on an already-
    // resolved card, not a truly-expired prompt — say so plainly instead of the
    // misleading "expired" (tg-cli#97).
    const stillAnswered = isStillAnswered(answeredButtons.get(action.requestId), Date.now())
    // Nothing answers for this card any more (e.g. a hatch card whose 24h grace
    // window closed): retire its
    // buttons so they never outlive what a tap can do (tg-cli#403).
    if (!stillAnswered && action.messageId !== null) void clearMessageKeyboard(ctx, action.messageId)
    await answerCallbackQueryOrNotify(ctx, action, stillAnswered ? "already answered" : "expired")
    return true
  }

  // A live answer on a hatch card is final: it retires the card's grace record (a
  // restored ask has one while live again — a raced tap must not mint) and records
  // the card as decided, so a restart that still finds it in the best-effort
  // questions store — this answer's write of it can fail — does not re-open it
  // (tg-cli#433). Durable BEFORE the answer goes out, like a late Deny: a lost write
  // refuses the answer and the card stays live for another tap, never confirmed on
  // memory alone. Returns false when the write failed (the tapper has been told).
  const recordHatchDecision = async (action: AnswerQuestionAction, pending: PendingButton, answer: GivenAnswer): Promise<boolean> => {
    const decision = answer.decision === "deny" ? "deny" : "allow"
    const undoClose = closeDecidedCard(grantsData, action.requestId, decision, Date.now(), decidedRetainMs(pending.req))
    if (persistGrants()) return true
    undoClose()
    log(`ask-answer-refused: ${describeAskRequest(pending.req)} key=${action.requestId} — grant store write failed`)
    await answerCallbackQueryOrNotify(ctx, action, "could not record the answer — tap again")
    return false
  }

  // The live entry is consumed: out of pendingButtons / the in-flight key set, and (for a question) in the replay cache.
  const retireLiveEntry = (action: AnswerQuestionAction, pending: PendingButton, answer: GivenAnswer): void => {
    pendingButtons.delete(action.requestId)
    activeButtonKeys.delete(action.requestId)
    // A stale abandoned twin (a reconnect re-attach raced a tap) must not linger
    // and resurrect on the next restart — the live answer below supersedes it.
    abandonedButtons.delete(action.requestId)
    // Recorded AFTER the in-flight key is released, so the replay cache takes
    // over exactly where the in-flight dedup leaves off. Sweep stale entries on
    // each record so the cache can't grow unbounded.
    if (shouldCacheAnswerForReplay(pending.req)) {
      const answeredAt = Date.now()
      pruneAnsweredButtons(answeredButtons, answeredAt)
      answeredButtons.set(action.requestId, {
        value: answer.value,
        label: answer.label,
        decision: answer.decision,
        at: answeredAt,
        delivery: "socket", // answered down the live hook socket → re-fire replays (#98)
      })
    }
  }

  // The agent is unblocked → deliver anything queued behind this question.
  // Fire-and-forget, but guard the promise: an error here must never become
  // an unhandled rejection that takes down the daemon.
  // A paneless (unscoped) question deferred EVERY pane, so its answer must
  // release them all — the entry is already out of pendingButtons above, as
  // onUnscopedRelease's caller contract requires (tg-cli#127).
  const releaseDeferredBehind = (req: ButtonRequest): void => {
    if (req.paneId) {
      flushDeferred(req.paneId).catch((err) => log(`flushDeferred error: ${err}`))
    } else onUnscopedRelease()
  }

  // The answer is accepted: retire the entry, persist, answer down the hook socket, update the card.
  const commitLiveAnswer = (action: AnswerQuestionAction, pending: PendingButton, answer: GivenAnswer): void => {
    retireLiveEntry(action, pending, answer)
    // Persist the answer so a hook that reconnects after a restart replays it
    // (no duplicate card) instead of re-forwarding the now-answered question.
    persistQuestions()
    // A decided hatch card makes every other open card of the same (hookId, cwd) moot.
    if (isHatchRequest(pending.req)) {
      for (const key of hatchSiblingsOf(closableCards(), pending.req, action.requestId)) closeOpenCard(key, CLOSE_STATUS.decided)
    }
    clearTimeout(pending.timer)
    const finalText = liveAnswerFinalText(pending.req, answer.label, action.freeText)
    if (pending.messageId === null) pending.finalText = finalText
    const output = formatAgentHookOutput(pending.req, answer)
    pending.socket.end(output === null ? "null\n" : `${JSON.stringify(output)}\n`)
    // Previously silent — a question reaching the agent left no daemon trace,
    // making the duplicate-card report impossible to confirm from logs.
    log(`ask-answered: ${describeAskRequest(pending.req)} key=${action.requestId} label=${answer.label} messageId=${pending.messageId ?? "-"}`)
    void answerCallbackQuery(ctx, action.callbackQueryId, "✓ sent to the agent")
    if (pending.messageId !== null) void editMessageText(ctx, pending.messageId, finalText, undefined, hatchParseMode(pending.req))
    releaseDeferredBehind(pending.req)
  }

  const answerQuestion = async (action: AnswerQuestionAction): Promise<boolean> => {
    const pending = pendingButtons.get(action.requestId)
    if (!pending) return answerWithoutLivePrompt(action)
    // A tap must come from THIS prompt's Telegram message: a stale tap on
    // an earlier prompt that reused the callback key must not answer this
    // one. Skipped only while sendMessage is still in flight (messageId
    // unknown) — that race is resolved in the tap's favor by design.
    if (isForeignCardTap(pending.messageId, action.messageId)) {
      await answerCallbackQueryOrNotify(ctx, action, "expired")
      return true
    }
    // An answer typed in chat (tg-cli#705) instead of a tapped option.
    const answer = action.freeText !== undefined ? freeTextAnswer(pending.req, action.freeText) : resolveButtonCallback(pending.req, { requestId: action.requestId, value: action.value })
    if (answer.status !== "answered") {
      await answerCallbackQueryOrNotify(ctx, action, "expired")
      return true
    }
    if (pending.req.kind === "permission" && isHatchRequest(pending.req) && !(await recordHatchDecision(action, pending, answer))) return true
    commitLiveAnswer(action, pending, answer)
    return true
  }

  // /kill sends SIGINT — a DESTRUCTIVE verb. It must NOT auto-bind to a
  // guessed agent (killing the wrong one is unrecoverable); on an ambiguous
  // fleet it asks (the select-picker below) rather than the no-reply auto-bind
  // that resolves a harmless content inject. So this uses the base discover(),
  // not discoverForInject (tg-cli#75 review).
  const killAgent = async (): Promise<boolean> => {
    const found = discover()
    if (!found.ok) {
      // Ambiguous /kill (several live agents) → show the live agents as a
      // select-only picker (buttons) instead of a plain-text candidate dump;
      // no-agent → the no-agent reply. (A tap on the picker hands back the
      // selector to re-issue against one agent — kill-on-tap is out of scope.)
      if (found.reason === "ambiguous") {
        await postSelectPicker(candidatesForPicker(found.candidates))
      } else {
        await replyNoAgent()
      }
      return false
    }
    if (found.target.agentPid === undefined) {
      await sendMessage(ctx, "agent pid unknown — not killed")
      return false
    }
    try {
      // SIGINT kills the interactive agent (~1s) — spec §5.2 reserves it
      // for the explicit /kill verb. /stop is the survivable Escape.
      process.kill(found.target.agentPid, "SIGINT")
      await sendMessage(ctx, "session killed — restore via `claude --resume`")
      return true
    } catch (err) {
      await sendMessage(ctx, `kill failed: ${err}`)
      return false
    }
  }

  const injectText = async (action: ActionOfKind["inject-text"]): Promise<boolean> => {
    if (state.selectedAgentRoute) {
      const selectedResult = await injectIntoSelectedAgent(action.text, action.messageId)
      if (selectedResult !== null) return selectedResult
    }
    // A plain non-reply message → opt into the no-reply auto-bind (fix B). This is the exact
    // HYP-915 shape (a fresh, unrelated message silently landing in an occupied pane), so the
    // git-state-check banner (withGitStateBanner) is prepended here when that pane is
    // mid-flight.
    return injectViaTarget(
      (target) => buildTextInjectPlan(target.pane.paneId, withGitStateBanner(target.pane.panePath, action.text)),
      action.text,
      true,
      action.messageId,
      action.plain,
    )
  }

  const sendStatus = async (action: ActionOfKind["status"]): Promise<boolean> => {
    const topicSettings = topicSettingsLine(ctx)
    await sendMessage(ctx, composeStatus(ctx, null, topicSettings ? await topicSettings : null), replyContext(action.threadId))
    return true
  }

  // One handler per action kind. Wrappers pass only the action (never `precedingOk`) so no handler's
  // optional second parameter can pick the verdict up by accident; only `ack` reads it.
  const handlers: ActionHandlers = {
    reply: async (action) => {
      await sendMessage(ctx, action.text, replyContext(action.threadId))
      return true
    },
    "answer-callback": async (action) => {
      await answerCallbackQuery(ctx, action.callbackQueryId, action.text)
      return true
    },
    "close-question-card": (action) => handleCloseQuestionCard(action),
    "post-timeout-question-reply": replyToQuestionCard,
    "answer-question": answerQuestion,
    status: sendStatus,
    "limit-status": async (action) => {
      await sendMessage(ctx, composeLimitStatus(ctx, action.agent), replyContext(action.threadId))
      return true
    },
    "daily-report": async (action) => {
      await deliverDailyReport(ctx, replyContext(action.threadId))
      return true
    },
    "usage-report": async (action) => {
      await sendReportChunks(ctx, (await composeUsageReport(action.period)).text, replyContext(action.threadId))
      return true
    },
    tasks: async (action) => {
      await runTasksCommand(ctx, action)
      return true
    },
    "chatgpt-menu": (action) => {
      runChatgptMenu(ctx, action).catch((err) => log(`chatgpt menu error: ${err}`))
      return true
    },
    "chatgpt-callback": (action) => {
      runChatgptCallback(ctx, action).catch((err) => log(`chatgpt callback error: ${err}`))
      return true
    },
    "limit-continue": (action) => handleLimitContinue(action),
    "agent-route": (action) => handleAgentRoute(action),
    "agent-callback": (action) => handleAgentCallback(action),
    "agent-cancel": (action) => handleAgentCancelCallback(action),
    "inject-text": injectText,
    "reply-route": (action) => handleReplyRoute(action),
    // A control verb (Escape/`/stop`) — no text to bank a banner into.
    "inject-key": (action) => injectViaTarget((target) => buildKeyInjectPlan(target.pane.paneId, action.key)),
    "kill-agent": killAgent,
    "download-media": (action) => downloadMedia(action),
    "transcribe-voice": (action) => transcribeVoice(action),
    "topic-route": (action) => handleTopicRoute(action),
    "topic-hold": (action) => handleTopicHold(action),
    "topic-attach": (action) => handleTopicAttach(action),
    "topic-new-session": (action) => handleTopicNewSession(action),
    "topic-event": (action) => handleTopicEvent(action),
    "new-command": (action) => handleNewCommand(action),
    "new-answer": (action) => handleNewAnswer(action),
    "new-dir": (action) => handleNewDir(action),
    "new-harness": (action) => handleNewHarness(action),
    "new-model": (action) => handleNewModel(action),
    "new-retry": (action) => handleNewRetry(action),
    "new-private-topic-fallback": (action) => handleNewPrivateTopicFallback(action),
    ack: async (action, precedingOk) => {
      await settleAckReaction(action.messageId, precedingOk)
      return true
    },
  }

  const dispatchAction = <K extends ActionKind>(kind: K, action: ActionOfKind[K], precedingOk: boolean) => handlers[kind](action, precedingOk)

  // Returns true when the action was handled successfully — the 'ack' case
  // reads the PRECEDING action's verdict (passed in, not a shared mutable variable — tg-cli#357:
  // concurrent dispatch across different resource keys means a closure variable updated by another
  // in-flight group could otherwise leak across groups) to decide whether the source message earns
  // its 👀 receipt (actions for one message are contiguous, ack last).
  const executeAction = async (incoming: Action, precedingOk: boolean): Promise<boolean> => {
    const action = withCardMessageId(incoming, cardMessageIdFor)
    if (isCardAnswerAction(action) && (await refuseNonOwnerAnswer(action))) return true
    return dispatchAction(action.kind, action, precedingOk)
  }

  return { actionResourceKey, executeAction }
}

export type ExecuteApi = ReturnType<typeof createExecute>
