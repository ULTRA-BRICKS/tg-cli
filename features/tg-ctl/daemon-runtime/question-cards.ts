// daemon-runtime/question-cards: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { type Socket } from "net"
import { resolveSessionName } from "../session-name"
import { type SessionEntry } from "../session-registry"
import { findSessionForAsker, findSessionForCard } from "../session-topics"
import { abandonedMultiText, abandonedPermissionText, buildButtonMessage, buildPostTimeoutQuestionMessage, clampRequestTimeoutMs, hatchAbandonedPermissionText, hatchParseMode, isHatchRequest, parseHatchHookId, type ButtonRequest } from "../questions"
import { CLOSE_STATUS, arrivalClock, ANY_CWD, hatchSiblingKeys, hatchSiblingsOf, type OpenCard, type WithdrawRequest } from "../question-inbox"
import { UNSCOPED_ABANDON_MS, describeAskRequest, dropAsk, type PendingButton, type QuestionRuntime, writeAskStatus } from "./button-requests"
import { log, type Ctx } from "./ctx-io"
import { clearMessageKeyboard, editMessageText } from "./telegram-api"
import { currentRegistry, liveEntry, refreshSessionRegistry, sendButtonCard, sessionTopic } from "./session-registry"

// A genuinely dead card: an UNSCOPED question (no pane to late-deliver to) that
// timed out, or a send-failed forward. Its keyboard is cleared so it can't be tapped.
export const EXPIRED_TERMINAL_TEXT = "expired — answer in terminal"

// A SCOPED question (with options) or a SCOPED permission can survive socket close:
// a question still injects into its pane (late-delivery); a permission re-attaches
// when the hook reconnects. Retain both when paneId is set. Returns true when
// retained (caller keeps the keyboard live); unscoped or option-less questions
// fall through to expiry.
export function retainAbandonedQuestion(rt: QuestionRuntime, entry: PendingButton, pendingKey: string): boolean {
  const { req } = entry
  if (!req.paneId) {
    // A hatch/RIG_HATCH_REQUEST_* permission has no pane to inject into or
    // reconnect from (see parseHatchHookId's doc comment, questions.ts) — but
    // a human decision on it must still survive the socket closing, so a
    // LATER retry of the same hookId can consume it (handleHookSocketLine's
    // hatch short-circuit) instead of the tap being thrown away. Every other
    // unscoped kind (a plain question with no pane, or a multi-question set
    // member) has no consumer for a retained entry at all and stays
    // fall-through-to-expiry, unchanged.
    if (req.kind !== "permission" || !isHatchRequest(req)) return false
  } else if (req.kind === "question" && !req.options?.length) {
    return false
  }
  rt.abandoned.set(pendingKey, {
    req,
    messageId: entry.messageId,
    at: Date.now(),
  })
  return true
}

// A dead card (unscoped / no options) can never be late-delivered: clear its keyboard
// so it isn't tappable and mark it expired. messageId may still be null mid-send —
// stash the text so the post-send reconciliation applies it.
export function expireDeadCard(ctx: Ctx, entry: PendingButton): void {
  if (entry.messageId !== null) {
    void clearMessageKeyboard(ctx, entry.messageId)
    void editMessageText(ctx, entry.messageId, EXPIRED_TERMINAL_TEXT)
  } else {
    entry.finalText = EXPIRED_TERMINAL_TEXT
  }
}

// Both retirement paths — the raw UNSCOPED_ABANDON_MS backstop timer (the
// requesting process is STILL CONNECTED, just past its abandon window — the
// DOMINANT production case for a hatch permission, since a hook process's own
// budget is ~120s, comfortably longer than the 110s default abandon window) and
// the hook socket's 'close' handler (the process already exited) — must retire
// a PendingButton through the SAME retain-or-expire decision. Before this was
// unified, the raw timer called expireDeadCard(ctx, entry) unconditionally, so
// for a still-connected hatch request it always won the race and destroyed the
// card before the socket ever closed and retention could run — silently
// re-breaking tg-cli#349 in the default scenario (review finding on #350,
// which had only fixed the already-exited/socket-close case).
export function retireAbandonedEntry(ctx: Ctx, rt: QuestionRuntime, entry: PendingButton, pendingKey: string): void {
  // Grant protocol v1.1 (tg-cli#398): an expiring HATCH permission becomes
  // addressable for a late tap through its 24h grace record REGARDLESS of the
  // retained/expired decision below (a retained card can be closed by a relevance signal
  // — tg-cli#705 — and a daemon restart; grace still lets a late tap mint). Fail-soft with a loud
  // log: grace loss degrades the feature but never authorizes anything.
  if (entry.req.kind === "permission" && isHatchRequest(entry.req)) rt.onHatchExpired(entry, pendingKey)
  if (!retainAbandonedQuestion(rt, entry, pendingKey)) {
    releasePaneBacklog(rt, entry.req)
    expireDeadCard(ctx, entry)
    return
  }
  if (entry.req.kind === "question" && !entry.req.multiQuestion) retainQuestionCard(ctx, rt, entry)
  else retainPermissionOrMultiCard(ctx, rt, entry)
}

// A scoped pane releases its own deferred backlog; a paneless (unscoped / hatch) entry sweeps
// every pane instead. A hatch entry's paneId is always undefined (see parseHatchHookId's
// doc comment, questions.ts) — rt.onRelease expects a REAL paneId, so calling it for a hatch
// entry would release a pane that was never deferred in the first place.
function releasePaneBacklog(rt: QuestionRuntime, req: ButtonRequest): void {
  if (req.paneId) rt.onRelease(req.paneId)
  else rt.onUnscopedRelease()
}

// Edit the card to its abandoned text now, or — when the send is still in flight and the
// card id is not known yet — stash it for the post-send reconciliation.
function applyAbandonedCardText(
  ctx: Ctx,
  entry: PendingButton,
  text: string,
  markup: PendingButton["finalReplyMarkup"],
  parseMode?: ReturnType<typeof hatchParseMode>,
): void {
  if (entry.messageId !== null) {
    void editMessageText(ctx, entry.messageId, text, markup, parseMode)
    return
  }
  entry.finalText = text
  entry.finalReplyMarkup = markup
}

function retainQuestionCard(ctx: Ctx, rt: QuestionRuntime, entry: PendingButton): void {
  rt.onTerminalFallback(entry.req.paneId as string)
  const abandoned = buildPostTimeoutQuestionMessage(ctx.chatId, entry.req)
  applyAbandonedCardText(ctx, entry, abandoned.text, abandoned.reply_markup)
}

function abandonedCardText(req: ButtonRequest): string {
  const label = resolveSessionName({ tmuxWindow: req.windowName, cwd: req.cwd }).primary
  if (req.kind !== "permission") return abandonedMultiText(req, label)
  const hookId = parseHatchHookId(req.requestId)
  return hookId !== null ? hatchAbandonedPermissionText(req, hookId) : abandonedPermissionText(req, label)
}

function retainPermissionOrMultiCard(ctx: Ctx, rt: QuestionRuntime, entry: PendingButton): void {
  releasePaneBacklog(rt, entry.req)
  const abandonedText = abandonedCardText(entry.req)
  // The keyboard MUST ride along explicitly (see editMessageText's own doc
  // comment: omitting reply_markup DETACHES the current keyboard, it is not
  // preserved) — otherwise this very edit removes the buttons the text just
  // invited a tap on, breaking the whole abandoned-tap/queue feature at the
  // moment it's needed (review finding). Mirrors retainQuestionCard, which
  // already passes `abandoned.reply_markup` for the same reason.
  const abandonedMarkup = buildButtonMessage(ctx.chatId, entry.req).reply_markup
  applyAbandonedCardText(ctx, entry, abandonedText, abandonedMarkup, hatchParseMode(entry.req))
}

// Arm the hook socket's 'close' handler for a freshly-forwarded or revived pending
// question. On close (the agent's hook process exits, or its 120s budget elapses)
// the entry leaves `pending` so it stops deferring the pane, then retireAbandonedEntry
// converges it through the same retain-or-expire decision the raw UNSCOPED_ABANDON_MS
// backstop timer uses. The pane's deferred backlog is released either way. Returns a
// getter the caller uses to avoid double-ending a socket it still owns.
export function armPendingSocketClose(
  ctx: Ctx,
  rt: QuestionRuntime,
  entry: PendingButton,
  pendingKey: string,
): { closed: () => boolean } {
  let socketClosed = false
  entry.socket.on("close", () => {
    socketClosed = true
    if (rt.pending.get(pendingKey) !== entry) return
    clearTimeout(entry.timer)
    rt.pending.delete(pendingKey)
    rt.activeKeys.delete(pendingKey)
    retireAbandonedEntry(ctx, rt, entry, pendingKey)
    rt.persist()
  })
  return { closed: () => socketClosed }
}

// Each ask's `at`: strictly increasing, so two hatch asks in one millisecond still supersede in
// arrival order (tg-cli#723).
export const askArrivedAt = arrivalClock()

// Fresh forward: register the pending entry, arm its socket-close handler, post the
// inline-keyboard card, and reconcile against a socket that closed mid-send. Split
// out of handleHookSocketLine so the dispatcher stays a readable parse→guard→route.
export async function forwardAndPostQuestion(
  ctx: Ctx,
  rt: QuestionRuntime,
  req: ButtonRequest,
  socket: Socket,
  pendingKey: string,
): Promise<void> {
  rt.activeKeys.add(pendingKey)
  const entry: PendingButton = { req, socket, messageId: null, at: askArrivedAt() }
  // An UNSCOPED question defers EVERY pane (fail-closed), so it MUST self-clear on a
  // timer or it wedges all routing. A SCOPED question waits forever (no timer): only
  // its socket close releases it (see armPendingSocketClose).
  //
  // tg-cli#403: a CRITICAL unscoped (paneless — the headless hatch case) request
  // is the ONE exception: this timer is exactly what would otherwise force-close
  // its live socket after UNSCOPED_ABANDON_MS (110s default) with a bare "null"
  // reply, defeating "wait indefinitely" for the very use case critical mode
  // exists for (a headless RIG_HATCH_REQUEST_* ask). No timer is armed at all —
  // the entry stays in `pending`, live socket open, until either a real answer
  // arrives (the ordinary tap path, unaffected) or the socket itself closes
  // (the underlying process actually exits/gets killed — armPendingSocketClose's
  // 'close' handler still retires it exactly as for any other request).
  if (!req.paneId && req.critical !== true) armUnscopedAbandonTimer(ctx, rt, entry, pendingKey)
  rt.pending.set(pendingKey, entry)
  const conn = armPendingSocketClose(ctx, rt, entry, pendingKey)

  const { messageId, cardThread, cardSession } = await postQuestionCard(ctx, rt, req, pendingKey)
  if (messageId === null) {
    // botPost already logged the low-level send failure; tie it to THIS abandoned
    // forward so the drop is greppable. No card posted → nothing to late-deliver.
    log(`ask-forward dropped: reason=send-failed ${describeAskRequest(req)}`)
    discardUnpostedForward(rt, entry, pendingKey)
    rt.persist()
    if (!conn.closed()) dropAsk(socket, "send-failed")
    return
  }
  log(`ask-forward posted: ${describeAskRequest(req)} messageId=${messageId} thread=${cardThread} session=${cardSession?.key ?? "-"}`)
  if (!conn.closed()) writeAskStatus(socket, { tgctl: "ask-status", state: "posted", messageId })
  entry.messageId = messageId
  // If the socket closed DURING the send, the close handler may have retained an
  // abandoned entry with a null card id — backfill it now so late-delivery can edit
  // the right message.
  const ab = rt.abandoned.get(pendingKey)
  if (ab && ab.req.requestId === req.requestId && ab.messageId === null) ab.messageId = messageId
  // Accepted bound: a SIGKILL in the sub-ms window between the card posting above and
  // this persist (the atomicWrite included) leaves a card in Telegram with no on-disk
  // record — a reconnect-resend after restart then finds no retained entry and posts a
  // SECOND card. Same nature as the sub-inject window in lateDeliverAbandonedQuestion;
  // full closure would need a write-ahead marker BEFORE the send, not worth it for a
  // sub-ms window on a crash-relaunch.
  rt.persist() // the card id is now known — persist so a restart can late-deliver/reattach
  supersedeOlderHatchCards(rt, entry, pendingKey)
  applyCloseRaceText(ctx, rt, entry, pendingKey, messageId)
}

function armUnscopedAbandonTimer(ctx: Ctx, rt: QuestionRuntime, entry: PendingButton, pendingKey: string): void {
  const { req, socket } = entry
  // Contract §1 (tg-cli#398): a per-request timeoutMs (hatch asks carry
  // 600000) overrides the unscoped-abandon default, clamped to the 15-min
  // cap (clampRequestTimeoutMs). Absent → UNSCOPED_ABANDON_MS unchanged.
  const abandonMs = clampRequestTimeoutMs(req.timeoutMs, UNSCOPED_ABANDON_MS)
  log(`unscoped-abandon-armed: req=${req.requestId} ms=${abandonMs}`)
  entry.timer = setTimeout(() => {
    if (rt.pending.get(pendingKey) !== entry) return
    rt.pending.delete(pendingKey)
    rt.activeKeys.delete(pendingKey)
    retireAbandonedEntry(ctx, rt, entry, pendingKey)
    rt.persist()
    writeAskStatus(socket, {
      tgctl: "ask-status", state: "expired", messageId: entry.messageId, ageMs: Date.now() - entry.at,
    })
    socket.end("null\n")
  }, abandonMs)
}

// The asking session's live registry entry: by the daemon-resolved session key, else the
// asker's explicit identity, else the origin/pane the hook ran from.
function findCardSession(ctx: Ctx, req: ButtonRequest): SessionEntry | null {
  return (req.sessionKey ? liveEntry(ctx, req.sessionKey) : null)
    ?? (req.asker ? findSessionForAsker(currentRegistry(ctx), req.asker) : null)
    ?? findSessionForCard(currentRegistry(ctx), { agent: req.agent, sessionId: req.origin?.sessionId, paneId: req.paneId, tmuxServerPid: req.asker?.tmuxServerPid })
}

// The card goes into the ASKING session's topic (spec §4.3, tg-cli#717), created on this first
// card if need be, WITH a notification. The asking session is req.sessionKey (resolved on
// arrival from the hook's session id, the asker's explicit session / pid chain / pane, §2.6),
// else looked up by origin/pane. With topics on and no topic for it, the card itself goes to
// the 📥 Inbox — never silently to General, never to another session's topic.
async function postQuestionCard(
  ctx: Ctx,
  rt: QuestionRuntime,
  req: ButtonRequest,
  pendingKey: string,
): Promise<{ messageId: number | null; cardThread: string; cardSession: SessionEntry | null }> {
  let cardSession = findCardSession(ctx, req)
  // A session that asked before the registry's next scan saw it (its first hook, a fresh
  // process): scan now rather than send its card to the Inbox.
  if (!cardSession && (ctx.cfg.topics || ctx.cfg.privateTopics)) {
    refreshSessionRegistry(true)
    cardSession = findCardSession(ctx, req)
  }
  const threadId = cardSession ? await sessionTopic(ctx, cardSession.key) : null
  const inboxCard = threadId === null ? await rt.postCardToInbox(req, pendingKey) : null
  const messageId = inboxCard?.messageId
    ?? (await sendButtonCard(ctx, buildButtonMessage(ctx.chatId, req, threadId), threadId !== null && cardSession ? cardSession.key : null))
  const cardThread = inboxCard ? `inbox:${inboxCard.threadId}` : threadId === null ? "general" : String(threadId)
  return { messageId, cardThread, cardSession }
}

// The send failed: retire whatever the forward registered so nothing waits on a card that
// does not exist.
function discardUnpostedForward(rt: QuestionRuntime, entry: PendingButton, pendingKey: string): void {
  const { req } = entry
  if (rt.pending.get(pendingKey) === entry) {
    rt.pending.delete(pendingKey)
    rt.activeKeys.delete(pendingKey)
    clearTimeout(entry.timer)
    releasePaneBacklog(rt, req)
    return
  }
  // The socket closed DURING the failed send, so the close handler already
  // removed the pending entry — and, for a scoped question, RETAINED an abandoned
  // entry with a null card id. But the card never posted, so drop that phantom:
  // left in place it would persist, survive a restart, and let a reconnect
  // re-attach to a card the human never saw (the agent blocked blind).
  const phantom = rt.abandoned.get(pendingKey)
  if (phantom && phantom.req.requestId === req.requestId && phantom.messageId === null) {
    rt.abandoned.delete(pendingKey)
  }
}

// A newer hatch request for the same (hookId, cwd) makes every older open card for it
// irrelevant (tg-cli#705): the retry is what the human should decide on. Done only once the
// new card is live, so a failed post never leaves the hook with no card at all — and only for
// cards that arrived before this one: an older request whose post was slower must not close
// the newer card that beat it to Telegram. An older card still being posted is closed too
// (tg-cli#723): its post applies the close text when it returns, so two racing posts leave
// one open card, not two.
function supersedeOlderHatchCards(rt: QuestionRuntime, entry: PendingButton, pendingKey: string): void {
  const olderCards = [
    ...rt.closableCards(),
    ...[...rt.pending].filter(([, e]) => e.messageId === null).map(([key, e]) => ({ key, req: e.req, at: e.at })),
  ].filter((c) => c.at <= entry.at)
  for (const key of hatchSiblingsOf(olderCards, entry.req, pendingKey)) rt.closeCard(key, CLOSE_STATUS.superseded)
}

// The socket (or unscoped timer) closed DURING the send: the close handler set
// finalText but, with messageId still null, couldn't touch the card. Apply it now —
// and for a genuinely-dead card (EXPIRED_TERMINAL_TEXT) clear the keyboard too, so
// the "dead card → not tappable" guarantee holds even on this race (a scoped
// ABANDONED_TAP_TEXT card deliberately keeps its keyboard for late-delivery).
function applyCloseRaceText(ctx: Ctx, rt: QuestionRuntime, entry: PendingButton, pendingKey: string, messageId: number): void {
  if (rt.pending.get(pendingKey) === entry && !entry.finalText) return
  const finalText = entry.finalText ?? EXPIRED_TERMINAL_TEXT
  if (finalText === EXPIRED_TERMINAL_TEXT) void clearMessageKeyboard(ctx, messageId)
  void editMessageText(ctx, messageId, finalText, entry.finalReplyMarkup, finalText === EXPIRED_TERMINAL_TEXT ? undefined : hatchParseMode(entry.req))
}

// Close the cards a withdraw line names (tg-cli#705): one request by its requestId (or its
// callback key), or every hatch card of a hook id, optionally narrowed to one directory.
// Covers every card the daemon still holds — also a retained one whose tap is queued, which
// the Inbox does not list. Returns how many closed.
export function withdrawCards(rt: QuestionRuntime, w: WithdrawRequest): number {
  const open: OpenCard[] = [...rt.pending, ...rt.abandoned].map(([key, e]) => ({ key, req: e.req, at: e.at }))
  const keys =
    w.kind === "request"
      ? open.filter((c) => c.req.requestId === w.requestId || c.key === w.requestId).map((c) => c.key)
      : hatchSiblingKeys(open, w.hookId, w.cwd ?? ANY_CWD, null)
  const status = CLOSE_STATUS.withdrawn(w.reason)
  return keys.filter((key) => rt.closeCard(key, status)).length
}
