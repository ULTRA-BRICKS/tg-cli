// daemon-runtime/late-taps-question: late-delivery of a tap to an ABANDONED question/permission card.
// Split out of late-taps.ts (guardian-817): lateDeliverAbandonedQuestion's statements keep their original order and
// text, grouped into named steps (queue-first permission decision, pane-inject of a claude menu digit,
// question claim/inject/rollback). `LateTapsContext` carries what the original closure reached directly.
import { resolveSessionName } from "../session-name"
import { buildDigitInjectPlan, buildTextInjectPlan, wrapInbound } from "../inject"
import { classifyPostInjectPane, extractPermissionIdentity, findPermissionMenuTarget, type PermissionMenuLookup, type PostInjectPaneState } from "../permission-menu"
import { liveOmpForPane } from "../omp"
import { buildAnsweredQuestionText, buildButtonMessage, hatchParseMode, isHatchRequest, parseHatchHookId, queuedDecisionCanAutoDeliver, queuedPermissionDecisionText, resolveButtonCallback, type ButtonRequest } from "../questions"
import { log } from "./ctx-io"
import { capturePane, deliverOriginalOmp, executeInjectSteps, paneSessionRefusal } from "./delivery"
import { describeAskRequest, pruneAnsweredButtons, type AbandonedButton } from "./button-requests"
import { answerCallbackQuery, answerCallbackQueryOrNotify, clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"
import { listLiveOmpAgents } from "./session-registry"
import { handleHatchLateTap, type AnswerQuestionAction, type GivenAnswer, type LateTapsContext } from "./late-taps-hatch"

type MenuTarget = Extract<PermissionMenuLookup, { ok: true }>["target"]

/**
 * A hatch/RIG_HATCH_REQUEST_* permission (see parseHatchHookId) is retained with no paneId
 * (retainAbandonedQuestion's paneless carve-out) specifically so a late tap CAN still be recorded —
 * the "nothing to inject into" bail-out must not reject it before the permission branch runs.
 */
export function retainedEntryAcceptsLateTap(req: ButtonRequest): boolean {
  return Boolean(req.paneId) || (req.kind === "permission" && isHatchRequest(req))
}

/**
 * A tap must come from THIS retained entry's OWN Telegram message. Skipped only while either id is
 * still unknown (send in flight) — same as the live-prompt path.
 */
export function isForeignCardTap(ownMessageId: number | null, tappedMessageId: number | null): boolean {
  return ownMessageId !== null && tappedMessageId !== null && tappedMessageId !== ownMessageId
}

/**
 * A tmux exit-0 only proves the keypress was SENT, not consumed as the menu choice. classifyPostInjectPane
 * gates on the live cursor: a still-pending menu or an unreadable re-capture is NOT delivered (never
 * confirmed-by-default); a live menu for a DIFFERENT command ("next-menu") counts as delivered.
 */
export function postInjectFailure(after: PostInjectPaneState): string | null {
  if (after === "unreadable") return "post-inject re-capture failed — cannot confirm delivery"
  if (after === "still-pending") return "delivery not confirmed — the same menu is still showing after inject"
  return null
}

// QUEUE FIRST, unconditionally, BEFORE any pane-inject attempt — durable on disk before we ever touch
// tmux. A daemon crash between an inject attempt and its post-inject confirm (an await on a subprocess
// plus a pacing sleep — not a negligible window) must NEVER lose the tap (Alex tg#9982 requirement,
// the exact guarantee the queuedDecision mechanism exists to provide). Queuing first means the worst
// case of a crash mid-inject is simply the pre-existing, already-durable "queued" state — a pane-inject
// success UPGRADES this record to answered/delivered; it never has to roll one back.
function queuePermissionDecision(lc: LateTapsContext, retained: AbandonedButton, answer: GivenAnswer): void {
  const queuedAt = Date.now()
  retained.queuedDecision = { value: answer.value, label: answer.label, decision: answer.decision, at: queuedAt }
  // A fresh tap is itself activity worth restarting the retention clock for —
  // without this, a tap made near the end of the window would still expire on
  // the very next sweep seconds later, flipping the card from "queued …
  // delivered automatically" to "never delivered" despite the human just having
  // acted (review finding). Accepted (not a bug, review finding): a human who
  // keeps RE-tapping (last tap wins) keeps postponing the window indefinitely —
  // that's fine, each tap is genuine fresh activity re-confirming the decision,
  // the same way any other mutation legitimately resets other windows in this
  // file (e.g. ANSWERED_REPLAY_MS on a fresh answer).
  retained.at = queuedAt
  lc.persistQuestions() // durable NOW — a restart before any other mutation must not lose this tap
}

// Bun.spawnSync can throw (missing tmux binary, broken PATH) — this call site is the one explicitly
// claiming rollback-safe semantics, so it must not let a throw skip straight past the "already safely
// queued" fallback (review finding).
async function injectMenuDigit(paneId: string, target: MenuTarget, sessionKey: ButtonRequest["sessionKey"]): Promise<string | null> {
  try {
    const res = await executeInjectSteps(buildDigitInjectPlan(paneId, target, sessionKey))
    return res.ok ? null : res.error
  } catch (err) {
    return `inject threw: ${err instanceof Error ? err.message : String(err)}`
  }
}

// Re-capture after a short pace to confirm the digit was consumed (see postInjectFailure). A live menu
// for a DIFFERENT command means this one resolved and Claude Code moved on to the next tool call — the
// pre-send verify proved the digit went to this request's box, so that counts as delivered and is
// logged as `after=next-menu`.
async function sendDigitAndConfirm(
  paneId: string,
  target: MenuTarget,
  sessionKey: ButtonRequest["sessionKey"],
): Promise<{ failure: string | null; after: PostInjectPaneState | null }> {
  let failure = await injectMenuDigit(paneId, target, sessionKey)
  let after: PostInjectPaneState | null = null
  if (failure === null) {
    await Bun.sleep(400)
    after = classifyPostInjectPane(capturePane(paneId), target)
    failure = postInjectFailure(after)
  }
  return { failure, after }
}

// Confirmed delivered — UPGRADE the already-queued entry to answered/pane-delivered (never a rollback
// needed on this path: nothing was ever recorded as "answered" before this point).
// The answeredButtons record never replays: the hook-side replay read is question-only (a permission
// re-fire forwards a fresh card, see the `req.kind === "question"` guard in the ask forward path) — it
// exists so a re-tap on this card reports "already answered" instead of "expired".
async function recordPermissionPaneDelivery(
  lc: LateTapsContext,
  action: AnswerQuestionAction,
  retained: AbandonedButton,
  answer: GivenAnswer,
  paneId: string,
  target: MenuTarget,
  after: PostInjectPaneState | null,
): Promise<void> {
  const { ctx, abandonedButtons, answeredButtons } = lc
  abandonedButtons.delete(action.requestId)
  pruneAnsweredButtons(answeredButtons, Date.now())
  answeredButtons.set(action.requestId, { value: answer.value, label: answer.label, decision: answer.decision, at: Date.now(), delivery: "pane" })
  lc.persistQuestions()
  log(`ask-late-deliver-permission-pane: ${describeAskRequest(retained.req)} key=${action.requestId} label=${answer.label} pane=${paneId} digit=${target.digit} after=${after}`)
  await answerCallbackQuery(ctx, action.callbackQueryId, "✓ sent to the agent")
  const cardId = retained.messageId ?? action.messageId
  if (cardId !== null) {
    void clearMessageKeyboard(ctx, cardId)
    void editMessageText(ctx, cardId, buildAnsweredQuestionText(retained.req, answer.label), undefined, hatchParseMode(retained.req))
  }
}

// The CTO's spec (verbatim): "no waiting process — check via tmux
// whether the permission request is still showing, and send the
// keypresses." Claude Code's own numbered "Do you want to proceed?"
// menu is answerable directly this way — the harness has already
// fallen back to ITS OWN terminal prompt, so nothing causes a fresh
// hook to fire and reconnect; queuing-and-waiting can wait
// forever. Scoped to claude (tg-cli#267): its menu layout and
// bare-digit-submits-instantly behavior are the only ones verified
// live (tmux capture-pane test, 2026-08-18) — every other agent kind
// falls straight through to the existing queue-and-wait path,
// unchanged. KNOWN RESIDUAL LIMITATIONS, accepted rather than silently
// ignored (tg-cli#268 tracks broadening/verifying these further): a
// command containing a real newline (heredocs, multi-line strings) can
// never line-match in permissionMenuMatchesRequest and always falls
// through to queuing (tracked separately as tg-cli#283, needing live
// verification of how Claude Code actually renders a multi-line
// command's box before a fix can be trusted — see that issue).
//
// The first capture only SELECTS the target (findPermissionMenuTarget:
// a live cursor, the request's FULL identity as its own line in the
// menu's bounded context — never a prefix, tg-cli#309 — and an exact
// Yes/No option). The digit plan then re-captures INSIDE the pane's
// typing turn, directly before send-keys, and sends nothing unless the
// same box is still live (verify-permission-menu): the turn can wait
// seconds behind another plan, and the human may answer at the keyboard
// and let a different permission render in the same spot meanwhile.
// What stays open is the gap between that re-capture and send-keys —
// two tmux spawns, not closable from outside the app.
// Returns true when the decision was confirmed delivered into the pane.
async function tryPermissionPaneInject(
  lc: LateTapsContext,
  action: AnswerQuestionAction,
  retained: AbandonedButton,
  answer: GivenAnswer,
  paneId: string,
): Promise<boolean> {
  // A live question on this pane owns its prompt (shouldDeferInbound): a
  // digit typed now would answer THAT, so the tap stays queued (#268).
  const lookup: PermissionMenuLookup | { ok: false; reason: "pane-busy" } = lc.shouldDeferInbound(paneId)
    ? { ok: false, reason: "pane-busy" }
    : findPermissionMenuTarget(capturePane(paneId), extractPermissionIdentity(retained.req), answer.decision)
  if (!lookup.ok) {
    // No live, identity-matching menu to inject into right now — log
    // WHY, so a genuinely-dead pane-inject path (e.g. an unverified
    // real-world deny label, tg-cli#268) is distinguishable in the
    // field from "menu already resolved" instead of reading identical
    // to the ordinary queuing case (review finding).
    log(`ask-late-deliver-permission-pane-skip: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId} reason=${lookup.reason}`)
    return false
  }
  const { target } = lookup
  const { failure, after } = await sendDigitAndConfirm(paneId, target, retained.req.sessionKey)
  if (failure !== null) {
    // Not confirmed — the entry is ALREADY safely queued (queuePermissionDecision), so there is nothing
    // to roll back; just log why the optimization didn't apply and fall through to the normal
    // queued-decision UI.
    log(`ask-late-deliver-permission-pane-failed: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId} err=${failure}`)
    return false
  }
  await recordPermissionPaneDelivery(lc, action, retained, answer, paneId, target, after)
  return true
}

// Not delivered via pane-inject (unsupported agent kind, deferred pane,
// no live/identity-matching menu, or unconfirmed injection) — already
// durably queued; render the existing queued-decision UI. A HATCH
// entry never reaches here (the grant diversion returned first) —
// this is exclusively the scoped-permission reconnect queue.
async function renderQueuedPermissionDecision(
  lc: LateTapsContext,
  action: AnswerQuestionAction,
  retained: AbandonedButton,
  answer: GivenAnswer,
  label: string,
): Promise<void> {
  const { ctx } = lc
  const cardId = retained.messageId ?? action.messageId
  // The keyboard MUST ride along explicitly here too (see the disconnect-edit
  // comment in armPendingSocketClose) — "tap again to change it" is a lie if
  // THIS edit is what removes the buttons (review finding).
  if (cardId !== null) {
    void editMessageText(
      ctx,
      cardId,
      // Card text reads `retained.req` — the toast below MUST read the SAME
      // object (never the incoming `req`/`action`), or queuedDecisionCanAutoDeliver's
      // "single source of truth" guarantee is only nominal (review finding).
      queuedPermissionDecisionText(retained.req, label, answer.label),
      buildButtonMessage(ctx.chatId, retained.req).reply_markup,
      hatchParseMode(retained.req),
    )
  }
  // Hatch's proactive push lives entirely in routeGrantNotice, exercised via handleHatchLateTap.
  log(`ask-permission-decision-queued: ${describeAskRequest(retained.req)} key=${action.requestId} label=${answer.label}`)
  // The ephemeral toast must make the SAME promise as the card text — both
  // branch on the SAME shared predicate (queuedDecisionCanAutoDeliver)
  // instead of independently re-deriving the same truthiness check, so they
  // can never silently drift apart again (Codex review finding + follow-up
  // review finding on this fix itself).
  await answerCallbackQuery(
    ctx,
    action.callbackQueryId,
    queuedDecisionCanAutoDeliver(retained.req) ? "queued — will send once the hook reconnects" : "queued — tap again once it reconnects",
  )
}

// A permission's LIVE hook needs a structured JSON reply, not terminal text —
// but once that hook has closed, the harness has ALREADY fallen back to its own
// terminal prompt, and for claude that prompt is directly answerable by
// re-checking the pane and injecting the matching digit (tg-cli#267). That covers claude; every other agent kind,
// and claude when the menu can't be re-verified live, still can't be delivered
// to right now and must NOT be silently dropped either (Alex tg requirement:
// never lose a tapped decision) — QUEUE it on the retained entry so a
// reconnecting hook delivers it automatically the instant it re-attaches (see
// handleHookSocketLine's RECONNECT re-attach branch). A later re-tap overwrites
// the queued value (last tap wins, covers a misclick).
async function lateDeliverPermission(lc: LateTapsContext, action: AnswerQuestionAction, retained: AbandonedButton): Promise<boolean> {
  // `resolveButtonCallback` (features/tg-ctl/questions.ts) always sets a real
  // 'allow'|'deny' `decision` when it returns status:"answered" for a
  // permission — there is no answered-but-undefined-decision case — so
  // `answer.decision` below is never undefined here (verified: PermissionDecision
  // is exactly 'allow'|'deny', and both permission branches of
  // resolveButtonCallback set it alongside status:"answered"). This is the same
  // invariant question-store.ts's parseQueuedDecision enforces for the on-disk
  // path (review finding: the two paths must agree), so the queue is never
  // created with a decision the restore-time validator would reject.
  const answer = resolveButtonCallback(retained.req, { requestId: action.requestId, value: action.value })
  if (answer.status !== "answered") return false

  // HATCH DIVERSION (grant protocol v1.1, tg-cli#398): a late tap on a
  // retained hatch card mints a single-use, operation-bound GRANT and routes
  // the consume instructions to the origin — it must NEVER record a
  // queuedDecision (the removed mechanism authorized ANY later operation
  // behind the same hookId, exactly what v1.1 forbids). The entry is
  // resolved by the grant; drop it so a re-tap exercises the grace store
  // (idempotent re-route of the existing grant, handleHatchLateTap).
  if (parseHatchHookId(retained.req.requestId) !== null) {
    lc.abandonedButtons.delete(action.requestId)
    lc.persistQuestions()
    const graceAnchor = lc.grantsData.grace.find((g) => g.key === action.requestId)?.expiredAt ?? retained.at
    return handleHatchLateTap(lc, action, retained.req, retained.messageId ?? action.messageId, answer, graceAnchor)
  }
  const label = resolveSessionName({ tmuxWindow: retained.req.windowName, cwd: retained.req.cwd }).primary
  const paneId = retained.req.paneId

  queuePermissionDecision(lc, retained, answer)

  if (paneId && retained.req.agent === "claude" && (await tryPermissionPaneInject(lc, action, retained, answer, paneId))) return true

  await renderQueuedPermissionDecision(lc, action, retained, answer, label)
  return true
}

// The pane is BUSY (another live question, or a flush in progress) → do NOT
// deliver now. Injecting would hit the open prompt; ENQUEUING would risk the
// answer being delivered after that other question releases, while we'd already
// have claimed "sent". Keep the entry RETAINED and ask the user to re-tap once the agent is free; never
// falsely confirm delivery. The pane must also still host the ASKING session
// (spec §2.6, tg-cli#100): after a tmux restart or a pane respawn `%N` may host
// a different session, which gets nothing typed and the CTO a named refusal.
// Returns true when the tap was refused (already answered).
async function refuseLateDelivery(lc: LateTapsContext, action: AnswerQuestionAction, retained: AbandonedButton): Promise<boolean> {
  const { ctx } = lc
  const paneId = retained.req.paneId
  if (lc.shouldDeferInbound(paneId)) {
    log(`ask-late-deliver-busy: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId}`)
    await answerCallbackQueryOrNotify(ctx, action, "agent is busy — tap again shortly")
    return true
  }
  const refusal = paneSessionRefusal(retained.req.sessionKey, paneId)
  if (refusal === null) return false
  log(`ask-late-deliver-refused: session left pane ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId}`)
  await answerCallbackQueryOrNotify(ctx, action, "not delivered — that session left its pane")
  await sendMessage(ctx, refusal, lc.replyContext(action.threadId))
  return true
}

// Type the chosen option into the asking pane, wrapped like any inbound reply.
// We do NOT enqueue it on the pane's defer queue (see refuseLateDelivery).
function injectLateAnswer(lc: LateTapsContext, action: AnswerQuestionAction, retained: AbandonedButton, answer: GivenAnswer, paneId: string | undefined) {
  const { ctx } = lc
  const wrapped = wrapInbound(ctx.cfg.injectWrap, "tg", answer.label)
  return retained.req.agent === "omp"
    ? deliverOriginalOmp(liveOmpForPane(listLiveOmpAgents(), paneId) ?? { cwd: retained.req.cwd ?? "/" }, wrapInbound(ctx.cfg.injectWrap, "tg", answer.label), `answer:${action.requestId}`, paneId)
    : executeInjectSteps(buildTextInjectPlan(paneId, wrapped))
}

// The pane is unreachable (gone / no longer an agent). ROLL BACK the claim:
// restore the retained entry (with its ORIGINAL `at`, so a failed attempt doesn't
// look newer than it is) and drop the provisional answer — so a RE-TAP can
// retry and the answer isn't lost.
async function rollBackLateClaim(lc: LateTapsContext, action: AnswerQuestionAction, retained: AbandonedButton, paneId: string | undefined, error: string): Promise<void> {
  lc.answeredButtons.delete(action.requestId)
  lc.abandonedButtons.set(action.requestId, { req: retained.req, messageId: retained.messageId, at: retained.at })
  lc.persistQuestions()
  log(`ask-late-deliver-failed: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId} err=${error}`)
  await answerCallbackQueryOrNotify(lc.ctx, action, "could not reach the terminal — tap again")
}

async function confirmLateDelivery(lc: LateTapsContext, action: AnswerQuestionAction, retained: AbandonedButton, answer: GivenAnswer, paneId: string | undefined): Promise<void> {
  const { ctx } = lc
  log(`ask-late-delivered: ${describeAskRequest(retained.req)} key=${action.requestId} label=${answer.label} pane=${paneId}`)
  // The pane's question is now answered — flush any defer-while-waiting backlog
  // queued behind it (in FIFO order, after the agent consumes this answer). This
  // is what makes a RESTORED backlog deliverable after a reload: the restored
  // question lives in `abandonedButtons`, so only its late-delivery reaches here
  // to release the queue. (Also closes a latent gap: answering a socket-closed
  // question never used to flush its pane backlog.) onQuestionReleased self-guards
  // against an in-flight flush or another live question on the pane.
  if (paneId) lc.onQuestionReleased(paneId)
  await answerCallbackQuery(ctx, action.callbackQueryId, "✓ sent to the agent")
  const cardId = retained.messageId ?? action.messageId
  if (cardId !== null) {
    // Clear the keyboard now the answer landed: this card explicitly invited a tap
    // ("window closed — tap still delivers …"), so once delivered it must stop being
    // tappable — a re-tap after the answered-replay window (ANSWERED_REPLAY_MS, 5 min)
    // would otherwise find no entry and show a misleading "expired".
    void clearMessageKeyboard(ctx, cardId)
    void editMessageText(ctx, cardId, buildAnsweredQuestionText(retained.req, answer.label), undefined, hatchParseMode(retained.req))
  }
}

// A plain (non-permission) retained question: type the chosen option into its pane.
async function lateDeliverQuestion(lc: LateTapsContext, action: AnswerQuestionAction, retained: AbandonedButton): Promise<boolean> {
  const { ctx, abandonedButtons, answeredButtons } = lc
  // A multi-question SET MEMBER is retained ONLY for reconnect re-attach. Its
  // lone answer must never inject into the pane: the local multi-question
  // dialog that took over may be showing a DIFFERENT question, so the injected
  // text would answer the wrong prompt (all-or-nothing — see
  // ButtonRequest.multiQuestion). Refuse WITHOUT mutating state: the retained
  // entry and the card's keyboard survive, so a `tg-ctl ask` resend across a
  // daemon bounce still re-attaches to the original card (no duplicate), and
  // an in-window re-fire of the whole set replays normally. A genuinely-stale
  // member is cleaned up by the retention-window branch above.
  if (retained.req.multiQuestion) {
    log(`ask-late-deliver-refused: multi-question member ${describeAskRequest(retained.req)} key=${action.requestId}`)
    await answerCallbackQuery(ctx, action.callbackQueryId, "the terminal took over — answer all questions there")
    return true
  }
  const answer = resolveButtonCallback(retained.req, { requestId: action.requestId, value: action.value })
  if (answer.status !== "answered") return false
  const paneId = retained.req.paneId
  if (await refuseLateDelivery(lc, action, retained)) return true
  // CLAIM the entry BEFORE the inject await (consume it from `abandoned`, record the
  // answer as PANE-delivered) instead of after. A daemon restart can deliver a
  // queued tap and the reconnecting hook's resend at nearly the same instant; if we
  // claimed only AFTER the await, a reconnect landing mid-inject would still find the
  // entry in `abandoned` and either re-attach a LIVE socket (hanging the agent until
  // ASK_TOTAL_TIMEOUT_MS) or fresh-forward a DUPLICATE card — and a later re-tap would
  // inject the answer a SECOND time. Claiming first makes that concurrent reconnect
  // hit the `already-pane-delivered` branch (it returns null → the agent falls back to
  // the terminal where THIS injection lands), so the answer reaches the agent exactly
  // once. Rolled back below if the inject fails, so a re-tap can still retry.
  //
  // Accepted bound: a daemon CRASH in the sub-inject window between this persist and
  // the inject completing leaves the answer marked pane-delivered on disk though the
  // injection may not have landed — a re-fire/re-tap then sees already-pane-delivered
  // with no recovery. The window is shorter than one tmux send-keys (fast), and this
  // is strictly better than the pre-PR behavior (a tap after the socket closed was
  // dropped outright). A persisted "delivering" tri-state would close it but isn't
  // worth the complexity for a sub-50ms window.
  const answeredAt = Date.now()
  abandonedButtons.delete(action.requestId)
  pruneAnsweredButtons(answeredButtons, answeredAt)
  answeredButtons.set(action.requestId, { value: answer.value, label: answer.label, decision: answer.decision, at: answeredAt, delivery: "pane" })
  lc.persistQuestions()
  const res = await injectLateAnswer(lc, action, retained, answer, paneId)
  // Typed but still in the input box after the retry Enter (#463): keep the claim
  // — a re-tap would type the answer a second time — and tell the CTO in the chat.
  if (!res.ok && res.unsubmitted) {
    log(`ask-late-deliver-unsubmitted: ${describeAskRequest(retained.req)} key=${action.requestId} pane=${paneId}`)
    await answerCallbackQuery(ctx, action.callbackQueryId, "typed but not sent — see the chat")
    await sendMessage(ctx, res.error)
    return true
  }
  if (!res.ok) {
    await rollBackLateClaim(lc, action, retained, paneId, res.error)
    return true
  }
  await confirmLateDelivery(lc, action, retained, answer, paneId)
  return true
}

/**
 * Late-delivery: a Telegram tap arrived for a SCOPED question whose hook socket
 * already CLOSED (its 120s window elapsed → terminal fallback, OR a daemon restart
 * restored it from disk). The agent is no longer blocked on the socket, but the
 * chosen option can still reach the pane it asked from — inject it like any inbound
 * reply (the established voice/text-reply path). Record the answer so a hook that
 * reconnects with the SAME requestId replays it instead of re-forwarding, then drop
 * the retained entry. Returns false when there is nothing to late-deliver (no
 * retained entry, or the tap doesn't resolve to an option), so the caller falls
 * back to the expired/already-answered toast.
 */
export async function lateDeliverAbandonedQuestion(lc: LateTapsContext, action: AnswerQuestionAction): Promise<boolean> {
  const retained = lc.abandonedButtons.get(action.requestId)
  if (!retained) return false
  if (!retainedEntryAcceptsLateTap(retained.req)) return false
  // A tap must come from THIS retained entry's OWN Telegram message — mirrors the
  // live-prompt path's same guard (case "answer-question"). Without it, a
  // stale card reusing a deterministic callback key (callbackRequestId is a
  // stable hash of session+question) could queue or overwrite the decision for a
  // DIFFERENT, newer retained entry that happens to hash-collide (review
  // finding). Skipped only while the card's own messageId is still unknown
  // (send in flight) — same as the live path.
  if (isForeignCardTap(retained.messageId, action.messageId)) {
    await answerCallbackQueryOrNotify(lc.ctx, action, "expired")
    return true
  }
  if (retained.req.kind === "permission") return lateDeliverPermission(lc, action, retained)
  return lateDeliverQuestion(lc, action, retained)
}
