// daemon-runtime/defer-queue: defer-while-waiting queue, flush, and open-card close.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { driveFlush } from "../defer"
import { serializeDeferredStore, parseDeferredStore } from "../deferred-store"
import { buildTextInjectPlan } from "../inject"
import { sessionAtPane } from "../session-target"
import { closedQuestionText, hatchParseMode, isHatchPermissionRequest, isHatchRequest } from "../questions"
import { retireGraceRecord } from "../grants"
import { isGenericAskRequest } from "../generic-ask"
import { atomicWrite, log, readFileOrNull } from "./ctx-io"
import { deliverHostPane, injectInbound, recordHeld } from "./delivery"
import { describeAskRequest, dropAsk, type QuestionRuntime } from "./button-requests"
import { clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"
import { currentSessionRegistry } from "./session-registry"
import { listAgentCandidates } from "./pane-discovery"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { StartupApi } from "./daemon-startup"
import type { PickerApi } from "./picker-state"
import type { ReactionsApi } from "./ack-reactions"
import type { QuestionInboxApi } from "./question-inbox-runtime"
import type { LateApi } from "./late-api"
import type { DeferredInbound } from "./daemon-types"

export type DeferQueueDeps = {
  ctx: Ctx
  state: DaemonState
  startup: StartupApi
  picker: PickerApi
  reactions: ReactionsApi
  questionInbox: QuestionInboxApi
  late: Pick<LateApi, "postRoutePicker">
}

export function createDeferQueue(d: DeferQueueDeps) {
  const { ctx } = d
  const { pendingButtons, activeButtonKeys, answeredButtons, abandonedButtons, closableCards } = d.startup
  const { tellUndelivered, deferred, flushingPanes } = d.picker
  const { queueAckReaction, clearReaction, setSeenReactions, DEFER_REACTION } = d.reactions
  const { postCardToInbox, persistQuestions, grantsData, persistGrants, onHatchExpired } = d.questionInbox
  const { postRoutePicker } = d.late

  const paneHasPendingQuestion = (paneId: string): boolean => {
    for (const pb of pendingButtons.values()) {
      // tg#30: an UNSCOPED question — paneId undefined because the hook subprocess ran WITHOUT
      // TMUX_PANE (the common Claude Code case) — defers inbound for ANY pane (fail CLOSED). The
      // old guard required `pb.req.paneId && === paneId`, so a paneId-less question matched NO pane,
      // inbound was NOT deferred, and the next message was send-keys'd into the open prompt. We
      // can't prove an unscoped question is a DIFFERENT pane than the inject target, so don't paste.
      // This can NEVER wedge routing: every entry self-clears in ≤110s (the abandon timer above),
      // unlike a stale queue (which is intentionally NOT treated as a defer).
      //
      // tg-cli#403 EXCEPTION: a CRITICAL unscoped request (the common headless hatch
      // case) deliberately does NOT self-clear in ≤110s anymore — forwardAndPostQuestion
      // skips the UNSCOPED_ABANDON_MS backstop for it entirely, by design, so it can wait
      // indefinitely for a human decision. Without this carve-out, that same "fail closed,
      // never wedges because it always self-clears fast" reasoning above would silently
      // become FALSE the moment a critical hatch request is pending: it would defer EVERY
      // agent's inbound Telegram traffic — not just the (nonexistent) pane it's asking
      // from — for as long as the human hasn't tapped, which could be hours (multi-model
      // review finding on this exact feature). A critical unscoped entry was never asking
      // from any real pane in the first place (see parseHatchHookId's doc comment,
      // questions.ts — hatch is structurally headless), so there is no live prompt here
      // for an inbound message to actually collide with; excluding it restores the
      // original bounded-wedge invariant for everything else, unchanged.
      // tg-cli#149: a generic `tg-ctl ask "<question>"` is a shell command's
      // approval gate, not a prompt in any pane, and may wait up to 15 min — it
      // must never hold every agent's inbound behind it.
      if (isGenericAskRequest(pb.req)) continue
      // tg-cli#717: a hatch ask is a shell gate too — its TMUX_PANE is merely inherited, and no
      // prompt waits in that pane. Holding the pane's inbound behind it lost the user's messages
      // for as long as an (orphaned, critical) hatch card stayed open.
      if (isHatchPermissionRequest(pb.req)) continue
      if (!pb.req.paneId && pb.req.critical !== true) return true
      if (pb.req.paneId === paneId) return true
    }
    return false
  }

  // A live inbound message defers behind an OPEN question OR an in-flight flush
  // (which sets flushingPanes for its whole duration, incl. the 800ms settle and
  // every inter-paste gap). Those two cover every window where injecting now would
  // either hit an open prompt or jump ahead of older queued items.
  //
  // It deliberately does NOT defer merely because the queue is non-empty: a queue
  // can outlive its question (the Telegram prompt expires / its hook socket closes
  // WITHOUT a terminal answer — the agent is still blocked locally, so we must not
  // flush, but no future answer will arrive to drain it either). Treating a
  // non-empty queue as "defer" would then wedge EVERY later message to that pane
  // forever (review finding). FIFO during a real flush is preserved by
  // flushingPanes; a question (live or expired-in-terminal) is preserved by
  // paneHasPendingQuestion while the prompt is open.
  const shouldDeferInbound = (paneId: string): boolean =>
    paneHasPendingQuestion(paneId) || flushingPanes.has(paneId)

  // Persist the defer-while-waiting backlog to disk so a reload (a deliberate
  // `tg-ctl restart`, a launchd bootout/bootstrap, or a crash-relaunch) doesn't
  // silently drop the human's queued messages (graceful-reload). Best-effort like
  // routes/questions: a persist failure must never break the hot enqueue/flush
  // path — the backlog simply isn't durable until the next mutation. The runtime
  // `state` is dropped; a restored item is re-created as state "queued".
  const persistDeferred = (): void => {
    try {
      atomicWrite(
        ctx.paths.deferred,
        serializeDeferredStore({
          panes: deferred.snapshot().map(([paneId, items]) => ({
            paneId,
            items: items.map((i) => ({
              text: i.text,
              sourceMessageId: i.sourceMessageId,
              relatedReactionMessageId: i.relatedReactionMessageId,
              ...(i.sessionKey ? { sessionKey: i.sessionKey } : {}),
            })),
          })),
        }),
      )
    } catch (err) {
      log(`deferred backlog persist failed: ${err}`)
    }
  }

  // Restore the durable backlog on bootstrap. Items re-enter the SAME per-pane
  // queues; each pane's restored question (restored into abandonedButtons above)
  // flushes this backlog when it is answered (lateDeliver → onQuestionReleased).
  // Until then the items wait — never pasted into a still-open prompt. Malformed
  // state degrades to "no restored backlog" (parseDeferredStore never throws).
  {
    const restored = parseDeferredStore(readFileOrNull(ctx.paths.deferred))
    if (restored.panes.length) {
      deferred.restore(
        restored.panes.map(
          (p): [string, DeferredInbound[]] => [
            p.paneId,
            p.items.map((i) => ({
              text: i.text,
              sourceMessageId: i.sourceMessageId,
              relatedReactionMessageId: i.relatedReactionMessageId,
              ...(i.sessionKey ? { sessionKey: i.sessionKey } : {}),
              state: "queued",
            })),
          ],
        ),
      )
      const count = restored.panes.reduce((n, p) => n + p.items.length, 0)
      log(`deferred backlog restored: ${count} message(s) across ${restored.panes.length} pane(s)`)
    }
  }

  // Enqueue only — the caller queues the source-message ack reaction when this
  // came from a MESSAGE action (which earns a ⏳ ack); a button-callback defer
  // edits its prompt instead and must NOT leak onto the next message's ack.
  // `sessionKey`: the session the text is for; defaults to the pane's current
  // occupant in the registry (none for an untracked harness — no guard then).
  const enqueueDeferred = (
    paneId: string,
    wrappedText: string,
    sourceMessageId: number | null,
    relatedReactionMessageId: number | null = null,
    sessionKey?: string,
  ): DeferredInbound => {
    const reg = sessionKey === undefined ? currentSessionRegistry() : null
    const key = sessionKey ?? (reg ? sessionAtPane(reg, paneId)?.key : undefined)
    const item: DeferredInbound = { text: wrappedText, sourceMessageId, relatedReactionMessageId, state: "queued", ...(key ? { sessionKey: key } : {}) }
    deferred.enqueue(paneId, item)
    persistDeferred()
    recordHeld(sourceMessageId, paneId, "deferred")
    return item
  }

  const markDeferredForAck = (item: DeferredInbound): void => {
    queueAckReaction(item.sourceMessageId, DEFER_REACTION, () => item.state === "queued")
  }

  const injectDeferredOne = async (paneId: string, item: DeferredInbound): Promise<boolean> => {
    // Must NEVER throw: a throw here rejects driveFlush, which (a) loses the
    // already-taken batch and (b) becomes an unhandled rejection in the
    // fire-and-forget flushDeferred call. executeInjectSteps normally returns
    // {ok:false} on tmux errors, but a spawn/exception could still escape — treat
    // any throw as a failed paste, exactly like {ok:false}. A failed item is not
    // re-queued (no future answer may ever flush it), so the CTO is told (tg-cli#299).
    let error: string
    try {
      // A hosted session is typed into through its abduco PTY, never a tmux plan.
      const res = await (deliverHostPane(paneId, item.text, item.sourceMessageId) ??
        injectInbound(item.sourceMessageId, paneId, buildTextInjectPlan(paneId, item.text, { sessionKey: item.sessionKey })))
      if (res.ok) {
        item.state = "delivered"
        await setSeenReactions(item.sourceMessageId, item.relatedReactionMessageId)
        return true
      }
      log(`deferred flush into ${paneId} failed: ${res.error}`)
      // The pane hosts a different session now (§2.6): nothing was typed. Name
      // the move and hand the text back through the picker instead of dropping it.
      if ("sessionMismatch" in res && res.sessionMismatch) {
        await postRoutePicker(listAgentCandidates(), item.text, `${res.error} — pick where this goes:`, item.sourceMessageId, item.relatedReactionMessageId)
        return false
      }
      // Typed but still in the input box after the retry Enter (#463): the CTO
      // hears exactly that — the "resend it" notice below would type it twice.
      if (res.unsubmitted) {
        const reply = item.sourceMessageId === null ? {} : { reply_parameters: { message_id: item.sourceMessageId, allow_sending_without_reply: true } }
        await sendMessage(ctx, res.error, reply)
        return false
      }
      error = res.error
    } catch (err) {
      log(`deferred flush into ${paneId} threw: ${err}`)
      error = err instanceof Error ? err.message : String(err)
    }
    item.state = "dead-lettered"
    if (item.sourceMessageId !== null) {
      await Promise.all([
        clearReaction(item.sourceMessageId),
        tellUndelivered(item.sourceMessageId, `was not delivered to ${paneId}: ${error}. Resend it if it still matters.`),
      ])
    }
    return false
  }

  const flushDeferred = async (paneId: string): Promise<void> => {
    if (!deferred.has(paneId)) return
    // Re-entrancy guard: two answers for the same pane could both reach here (the
    // action loop awaits each, but flushDeferred is fire-and-forget). The flag
    // also routes new inbound into the queue for the whole flush (FIFO).
    if (flushingPanes.has(paneId)) return
    flushingPanes.add(paneId)
    try {
      // Let the agent consume the just-delivered answer before the first paste.
      await Bun.sleep(800)
      // Drain in rounds: each round takes the current queue and feeds it to
      // driveFlush (which re-checks paneHasPendingQuestion before EVERY paste).
      // A round can leave a tail only when a NEW question opens between pastes.
      // Re-defer that tail and pause until that question's answer/release runs
      // flushDeferred again. Fresh messages enqueued DURING a round are drained
      // next round while the pane stays free; otherwise they'd sit until the next
      // unrelated question. Inject FAILURES do NOT re-defer: there may be no
      // future question to flush them, so they are reported to the CTO rather
      // than wedging the queue forever (review finding, tg-cli#299).
      for (;;) {
        const queue = deferred.take(paneId)
        if (queue.length === 0) return
        const outcome = await driveFlush(
          queue,
          () => paneHasPendingQuestion(paneId),
          (item) => injectDeferredOne(paneId, item),
        )
        if (outcome.reDeferred.length > 0) {
          deferred.redefer(paneId, outcome.reDeferred)
          log(`deferred flush into ${paneId} paused — ${outcome.reDeferred.length} item(s) re-queued behind a new question`)
          return
        }
        // Stop if a question is now open (its answer re-triggers the flush) or the
        // queue is empty; else loop to drain anything enqueued during this round.
        if (paneHasPendingQuestion(paneId) || !deferred.has(paneId)) return
      }
    } finally {
      flushingPanes.delete(paneId)
      // The queue changed (drained and/or re-deferred) — keep the durable backlog
      // in sync so a reload restores exactly what is still queued. Persisting once
      // HERE (not per delivered item) means a hard SIGKILL mid-flush — after some
      // items typed into the pane but before this runs — leaves those already-
      // delivered items still on disk. The restart does not re-paste them: each
      // item's delivery is in the ledger, which the flush consults (tg-cli#299).
      // Persisting after each take instead would lose the not-yet-injected tail.
      persistDeferred()
    }
  }

  // A scoped question's hook socket closed while the agent may still be waiting in
  // its terminal fallback. Unlike a true abandon/dead card, the Telegram question
  // remains visible and answerable by reply-text, so the pane backlog should not be
  // reported as lost. Let the normal drain deliver queued messages in FIFO order.
  const releaseQueuedBacklog = (paneId: string, label: string, errorLabel: string): void => {
    // A flush is already draining this pane, so it owns the queue and will flip
    // source reactions on delivery. Nothing else to schedule here.
    if (flushingPanes.has(paneId)) {
      log(`${label} on ${paneId} mid-flush — drain already owns queued message(s)`)
      return
    }
    if (!deferred.has(paneId)) {
      log(`${label} on ${paneId} — no queued message(s)`)
      return
    }
    // Another question is still pending on this pane: its answer will flush the
    // queue legitimately, so leave it (the queue is keyed by PANE, not question).
    if (paneHasPendingQuestion(paneId)) {
      log(`${label} on ${paneId} — queued message(s) remain behind another live question`)
      return
    }
    log(`${label} on ${paneId} — flushing queued message(s)`)
    flushDeferred(paneId).catch((err) => log(`flushDeferred ${errorLabel} error: ${err}`))
  }

  const onQuestionTerminalFallback = (paneId: string): void =>
    releaseQueuedBacklog(paneId, "question terminal-fallback", "terminal-fallback")

  // A forwarded question was removed WITHOUT a Telegram answer (timeout / hook
  // socket close / send failure). Once the pending guard is gone, queued inbound
  // should be delivered in FIFO order rather than forcing the user to resend it.
  //
  // The queue is keyed by PANE, not by question, so it may hold items that belong
  // to a DIFFERENT outstanding handler on the same pane. Flush ONLY when the pane
  // is otherwise idle: skip if a flush is in flight (it owns + will deliver the
  // queue) or another question is still pending (its answer will flush). Flushing
  // in either case would disturb another handler's messages (review finding).
  const onQuestionReleased = (paneId: string): void =>
    releaseQueuedBacklog(paneId, "question released", "question-release")

  // An UNSCOPED question (no paneId — hook ran without TMUX_PANE) was removed
  // WITHOUT a Telegram answer (timeout / socket close / send failure). It defers
  // inbound for ANY pane (paneHasPendingQuestion's `if (!pb.req.paneId) return
  // true`), so its stranded backlog can sit on SEVERAL panes at once and there is
  // no single pane id on the question itself. Sweep every pane that still holds a
  // backlog through the SAME per-pane release guard: onQuestionReleased skips a
  // pane that has ANOTHER pending question (its answer flushes legitimately) or an
  // in-flight flush (it owns the queue), so this never disturbs a different live
  // question's items.
  //
  // CALLER CONTRACT: invoke this only AFTER the unscoped entry is removed from
  // `pendingButtons`. While it is still present, paneHasPendingQuestion returns
  // true for EVERY pane (its own `!paneId` arm), so every sweep call would skip.
  // Removing it first lets the guard see the real post-removal state (flush an
  // idle pane, leave one with a live question).
  const onUnscopedRelease = (): void => {
    for (const paneId of deferred.panesWithBacklog()) onQuestionReleased(paneId)
  }

  // Close an open card on a relevance signal (tg-cli#705) — the one place a withdraw, a newer
  // hatch request, a sibling's decision, an answer in chat or Dismiss retires a card. A live
  // asker gets the `null` reply (it stops waiting: the terminal or its caller takes over); the
  // card loses its buttons and shows `status`; a hatch card's grace record goes too, so no later
  // tap can mint a grant for it; the pane's queued inbound is released; the questions write
  // drops the Inbox copy. False when `key` names no card.
  const closeOpenCard = (key: string, status: string): boolean => {
    const pending = pendingButtons.get(key)
    const entry = pending ?? abandonedButtons.get(key)
    if (!entry) return false
    if (pending) {
      pendingButtons.delete(key)
      activeButtonKeys.delete(key)
      clearTimeout(pending.timer)
      dropAsk(pending.socket, "closed")
    }
    abandonedButtons.delete(key)
    if (isHatchRequest(entry.req) && retireGraceRecord(grantsData.grace, key)) persistGrants()
    if (entry.req.paneId) onQuestionReleased(entry.req.paneId)
    else onUnscopedRelease()
    persistQuestions()
    const text = closedQuestionText(entry.req, status)
    if (entry.messageId !== null) {
      // The card is closed: no button on it may answer anything any more.
      void clearMessageKeyboard(ctx, entry.messageId)
      void editMessageText(ctx, entry.messageId, text, undefined, hatchParseMode(entry.req))
    } else if (pending) {
      pending.finalText = text
    }
    log(`ask-closed: ${describeAskRequest(entry.req)} key=${key} status=${status}`)
    return true
  }

  const questionRuntime: QuestionRuntime = {
    pending: pendingButtons,
    activeKeys: activeButtonKeys,
    abandoned: abandonedButtons,
    answered: answeredButtons,
    persist: persistQuestions,
    onRelease: onQuestionReleased,
    onTerminalFallback: onQuestionTerminalFallback,
    onUnscopedRelease,
    grants: grantsData,
    persistGrants,
    onHatchExpired,
    closeCard: closeOpenCard,
    closableCards,
    postCardToInbox,
  }

  return { shouldDeferInbound, persistDeferred, enqueueDeferred, markDeferredForAck, flushDeferred, onQuestionReleased, onUnscopedRelease, closeOpenCard, questionRuntime }
}

export type DeferQueueApi = ReturnType<typeof createDeferQueue>
