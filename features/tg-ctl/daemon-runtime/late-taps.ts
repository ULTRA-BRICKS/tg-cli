// daemon-runtime/late-taps: late taps on hatch/question cards and post-timeout replies.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { buildAnsweredQuestionText, closedQuestionText, resolveButtonCallback } from "../questions"
import { CLOSE_STATUS } from "../question-inbox"
import { buildTextInjectPlan } from "../inject"
import type { Action } from "../types"
import { log } from "./ctx-io"
import { injectInbound } from "./delivery"
import { describeAskRequest, pruneAnsweredButtons } from "./button-requests"
import { answerCallbackQuery, clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { QuestionInboxApi } from "./question-inbox-runtime"
import type { StartupApi } from "./daemon-startup"
import type { DeferQueueApi } from "./defer-queue"
import type { TargetRoutingApi } from "./target-routing"
import { handleHatchLateTap, type LateTapsContext } from "./late-taps-hatch"
import { lateDeliverAbandonedQuestion } from "./late-taps-question"

export type LateTapsDeps = {
  ctx: Ctx
  state: DaemonState
  questionInbox: QuestionInboxApi
  startup: StartupApi
  deferQueue: DeferQueueApi
  targetRouting: TargetRoutingApi
}

export function createLateTaps(d: LateTapsDeps) {
  const { ctx } = d
  const { persistQuestions, grantsData, persistGrants } = d.questionInbox
  const { pendingButtons, answeredButtons, abandonedButtons, closableCards } = d.startup
  const { shouldDeferInbound, flushDeferred, onQuestionReleased, closeOpenCard } = d.deferQueue
  const { replyContext } = d.targetRouting
  const lc: LateTapsContext = { ctx, persistQuestions, grantsData, persistGrants, answeredButtons, abandonedButtons, closableCards, shouldDeferInbound, onQuestionReleased, closeOpenCard, replyContext }


  // A tap on an expired hatch card whose abandoned entry is GONE (closed by a decision, or
  // the daemon restarted since) — the grace store (grants.ts)
  // is what keeps it addressable through 24h. Only hatch asks ever grow grace
  // records, so a non-hatch tap falls straight through to the existing toasts.
  const handleGraceStoreTap = async (action: Extract<Action, { kind: "answer-question" }>): Promise<boolean> => {
    const rec = grantsData.grace.find((g) => g.key === action.requestId)
    if (!rec) return false
    // Same own-card guard as the retained path: a stale card must not resolve a
    // different record that happens to share the callback key.
    if (rec.messageId !== null && action.messageId !== null && action.messageId !== rec.messageId) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired")
      return true
    }
    const answer = resolveButtonCallback(rec.req, { requestId: action.requestId, value: action.value })
    if (answer.status !== "answered") {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired")
      return true
    }
    return handleHatchLateTap(lc, action, rec.req, action.messageId ?? rec.messageId, answer, rec.expiredAt)
  }

  // A text reply to a retained question card — or, with `status`, a plain message typed to the
  // session whose only open card it is (tg-cli#705) — is typed into the asking pane as the answer.
  const handlePostTimeoutQuestionReply = async (
    action: Extract<Action, { kind: "post-timeout-question-reply" }>,
    status?: string,
  ): Promise<boolean> => {
    const retained = abandonedButtons.get(action.requestId)
    if (
      !retained ||
      !retained.req.paneId ||
      retained.req.kind !== "question" ||
      retained.req.multiQuestion ||
      retained.messageId !== action.questionMessageId
    ) {
      await sendMessage(ctx, "that question is no longer waiting — resend if needed", replyContext(action.threadId))
      return false
    }
    const paneId = retained.req.paneId
    if (shouldDeferInbound(paneId)) {
      log(`ask-post-timeout-reply-busy: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId}`)
      await sendMessage(ctx, "agent is busy — reply to the question again shortly", replyContext(action.threadId))
      return false
    }

    const answer = action.text.trim()
    const answeredAt = Date.now()
    abandonedButtons.delete(action.requestId)
    pruneAnsweredButtons(answeredButtons, answeredAt)
    answeredButtons.set(action.requestId, { value: answer, label: answer, at: answeredAt, delivery: "pane" })
    persistQuestions()

    const res = await injectInbound(action.messageId, paneId, buildTextInjectPlan(paneId, answer, { sessionKey: retained.req.sessionKey }))
    // Typed but still in the input box after the retry Enter (#463): keep the claim
    // — a second reply would type the answer again — and tell the CTO.
    if (!res.ok && res.unsubmitted) {
      log(`ask-post-timeout-reply-unsubmitted: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId}`)
      await sendMessage(ctx, res.error)
      return false
    }
    if (!res.ok) {
      answeredButtons.delete(action.requestId)
      abandonedButtons.set(action.requestId, { req: retained.req, messageId: retained.messageId, at: retained.at })
      persistQuestions()
      log(`ask-post-timeout-reply-failed: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId} err=${res.error}`)
      await sendMessage(ctx, res.sessionMismatch ? res.error : "could not reach the terminal — reply to the question again", replyContext(action.threadId))
      return false
    }

    log(`ask-post-timeout-reply-delivered: ${describeAskRequest(retained.req)} key=${action.requestId} answer=${answer} pane=${paneId}`)
    void clearMessageKeyboard(ctx, action.questionMessageId)
    void editMessageText(ctx, action.questionMessageId, status ? closedQuestionText(retained.req, status) : buildAnsweredQuestionText(retained.req, answer))
    flushDeferred(paneId).catch((err) => log(`flushDeferred post-timeout-reply error: ${err}`))
    return true
  }

  // Close / ✕ Dismiss (tg-cli#705): the human says the question is no longer relevant, on the
  // card or its Inbox copy. Any open card closes — a live one too (its asker gets `null` and
  // falls back to its terminal). A tap from a stale card that shares the key only loses its
  // buttons.
  const handleCloseQuestionCard = async (
    action: Extract<Action, { kind: "close-question-card" }>,
  ): Promise<boolean> => {
    const entry = pendingButtons.get(action.requestId) ?? abandonedButtons.get(action.requestId)
    const ownCard = entry && (action.messageId === null || entry.messageId === null || entry.messageId === action.messageId)
    if (!ownCard || !closeOpenCard(action.requestId, CLOSE_STATUS.dismissed)) {
      if (action.messageId !== null) void clearMessageKeyboard(ctx, action.messageId)
    }
    await answerCallbackQuery(ctx, action.callbackQueryId, "closed")
    return true
  }

  // Late-delivery of a tap to an abandoned question/permission card lives in late-taps-question.ts.
  return {
    handleGraceStoreTap,
    lateDeliverAbandonedQuestion: (action: Extract<Action, { kind: "answer-question" }>) => lateDeliverAbandonedQuestion(lc, action),
    handlePostTimeoutQuestionReply,
    handleCloseQuestionCard,
  }
}

export type LateTapsApi = ReturnType<typeof createLateTaps>
