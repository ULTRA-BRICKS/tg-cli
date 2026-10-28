// daemon-runtime/question-inbox-runtime: the Inbox topic sync (tg-cli#705), question/grant persistence and hatch grace.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { resolveSessionName } from "../session-name"
import { isThreadRejection, isTopicDeletedError } from "../../transport/telegram"
import { buildButtonMessage, hatchParseMode, isHatchRequest, parseHatchHookId, queuedDecisionCanAutoDeliver, queuedDecisionStillWaitingText, type ButtonRequest } from "../questions"
import { serializeQuestionStore, type QuestionStoreData } from "../question-store"
import { emptyInboxState, emptyMirrors, INBOX_TOPIC_NAME, inboxMirrorMessage, inboxEntryOf, parseInboxState, planInboxSync, serializeInboxState, type OpenCard } from "../question-inbox"
import { buildGraceRecord, dropSettledDecided, parseGrantStore, pruneGrantStore, routeForRequest, serializeGrantStore, upsertGraceRecord } from "../grants"
import { atomicWrite, log, readFileOrNull } from "./ctx-io"
import { GRACE_WINDOW_MS, QUEUED_DECISION_NOTICE_MS, describeAskRequest, normalizeButtonRequest, pruneAnsweredButtons, type PendingButton } from "./button-requests"
import { botPostResult, editMessageText, retireMessage, setInboxThreadId, type BotPostResult } from "./telegram-api"
import { topicsCapable } from "./session-registry"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { StartupApi } from "./daemon-startup"

export type QuestionInboxDeps = {
  ctx: Ctx
  state: DaemonState
  startup: StartupApi
}

type InboxOpenCard = OpenCard & { messageId: number }

// What the sync steps below need from the factory: the shared state, its persistence, the
// deleted-topic reset, and a way to ask the serialized runner for another pass.
interface InboxSyncContext {
  ctx: Ctx
  state: DaemonState
  persistInbox: () => void
  dropDeletedInbox: (threadId: number, why: string | undefined, force?: boolean) => boolean
  requestRerun: () => void
}

export function sentMessageId(resp: BotPostResult): number | undefined {
  const result = resp.ok ? resp.json.result : undefined
  const messageId = result && typeof result === "object" && "message_id" in result ? result.message_id : undefined
  return typeof messageId === "number" ? messageId : undefined
}

function postFailureText(resp: BotPostResult): string {
  return resp.ok ? "no message_id" : resp.description
}

// The card itself, with a notification (it is the card, not a silent copy).
function sendCardMessage(ctx: Ctx, req: ButtonRequest, threadId: number): Promise<BotPostResult> {
  const card = buildButtonMessage(ctx.chatId, req, threadId)
  return botPostResult(ctx, "sendMessage", {
    chat_id: ctx.chatId,
    message_thread_id: threadId,
    text: card.text,
    reply_markup: card.reply_markup,
    ...(card.parse_mode ? { parse_mode: card.parse_mode } : {}),
  })
}

function forgetClosedMirrors(sync: InboxSyncContext, keys: readonly string[]): void {
  const { state, persistInbox } = sync
  for (const key of keys) {
    const mirror = state.inboxState.mirrors[key]
    delete state.inboxState.mirrors[key]
    // A card posted INTO the Inbox (tg-cli#717) stays: closing it already edited it in place.
    const isCard = "card" in mirror
    if (!isCard) state.inboxState.removing.push(mirror.messageId)
    persistInbox()
    log(`inbox: ${isCard ? "dropped the Inbox card" : "removing the copy"} of ${key} (message ${mirror.messageId})`)
  }
}

// Every copy still owed — closed just now, or by an earlier sync or run Telegram did not
// answer (tg-cli#722). A transient failure ends the pass: the next sync tries again, and an
// outage costs one doomed request per sync, not one per owed copy.
async function retireOwedCopies(sync: InboxSyncContext): Promise<void> {
  const { ctx, state, persistInbox } = sync
  for (const messageId of [...state.inboxState.removing]) {
    if (!(await retireMessage(ctx, ctx.chatId, messageId, "✓ no longer open"))) {
      log(`inbox: copy ${messageId} not removed yet — retried next sync`)
      break
    }
    state.inboxState.removing = state.inboxState.removing.filter((id) => id !== messageId)
    persistInbox()
    log(`inbox: removed copy ${messageId}`)
  }
}

async function postMissingCopies(sync: InboxSyncContext, keys: readonly string[], open: ReadonlyMap<string, InboxOpenCard>, threadId: number): Promise<void> {
  const { ctx, state, persistInbox } = sync
  const now = Date.now()
  for (const key of keys) {
    const card = open.get(key)
    if (!card) continue
    const label = resolveSessionName({ tmuxWindow: card.req.windowName, cwd: card.req.cwd }).primary
    const message = inboxMirrorMessage(card, label, now)
    const resp = await botPostResult(ctx, "sendMessage", {
      chat_id: ctx.chatId,
      message_thread_id: threadId,
      text: message.text,
      reply_markup: message.reply_markup,
      disable_notification: true,
      ...(message.parse_mode ? { parse_mode: message.parse_mode } : {}),
    })
    const messageId = sentMessageId(resp)
    if (messageId !== undefined) {
      // The card may have closed while the copy was in flight: the next run removes it.
      state.inboxState.mirrors[key] = { messageId, cardId: card.messageId }
      persistInbox()
      log(`inbox: posted copy of ${key} (message ${messageId})`)
      continue
    }
    if (!resp.ok && (isThreadRejection(resp.description) || isTopicDeletedError(resp.description))) {
      // The topic is gone, and every copy with it: start over in a new topic, once.
      if (sync.dropDeletedInbox(threadId, resp.description)) sync.requestRerun()
      return
    }
    log(`inbox: copy of ${key} not posted: ${postFailureText(resp)} — retried next tick`)
  }
}

export function createQuestionInbox(d: QuestionInboxDeps) {
  const { ctx, state } = d
  const { pendingButtons, answeredButtons, abandonedButtons, openCards } = d.startup

  // --- 📥 Inbox (tg-cli#705): one forum topic holding a silent copy of every open card ---
  // Only in topics mode, where a topic can exist; otherwise nothing is posted anywhere. The
  // copies follow the open set: `syncInbox` runs after every questions write and once per poll
  // tick, posts a copy for each open card without one and removes the copy of each card that
  // closed. A failed send records nothing and is retried on the next run.
  const inboxEnabled = ctx.cfg.topics || ctx.cfg.privateTopics

  state.inboxState = parseInboxState(readFileOrNull(ctx.paths.questionInbox), ctx.chatId)

  setInboxThreadId(state.inboxState.threadId)

  // A deleted Inbox topic is recreated at most this often, so a bot that lost the right to
  // create topics does not create one per tick.
  const INBOX_RECREATE_MIN_MS = 10 * 60_000

  let inboxRecreatedAt = 0

  // Every Inbox state change goes through here, so it also arms the send guard (outsideInbox).
  const persistInbox = (): void => {
    setInboxThreadId(state.inboxState.threadId)
    try {
      atomicWrite(ctx.paths.questionInbox, serializeInboxState(state.inboxState))
    } catch (err) {
      log(`inbox persist failed: ${err}`)
    }
  }

  // The topic, created on first need; null when topics are unavailable or the create failed.
  // Single-flight: a sync and a card posted into the Inbox may both need it at once, and two
  // creates would leave an orphan topic holding live cards.
  let inboxCreating: Promise<number | null> | null = null

  const ensureInboxTopic = (): Promise<number | null> => {
    if (state.inboxState.threadId !== null) return Promise.resolve(state.inboxState.threadId)
    inboxCreating ??= (async (): Promise<number | null> => {
      if (!(await topicsCapable(ctx))) return null
      const resp = await botPostResult(ctx, "createForumTopic", { chat_id: ctx.chatId, name: INBOX_TOPIC_NAME })
      const result = resp.ok ? resp.json.result : undefined
      const threadId = result && typeof result === "object" && "message_thread_id" in result ? result.message_thread_id : undefined
      if (typeof threadId !== "number") {
        log(`inbox: createForumTopic failed: ${resp.ok ? "no message_thread_id" : resp.description}`)
        return null
      }
      log(`inbox: topic created ${threadId}`)
      state.inboxState = { chatId: ctx.chatId, threadId, mirrors: emptyMirrors(), removing: [] }
      persistInbox()
      return threadId
    })().finally(() => {
      inboxCreating = null
    })
    return inboxCreating
  }

  // The Inbox topic is gone (deleted by hand), and every copy with it: forget it so the next
  // ensureInboxTopic creates a new one. The background sync does this at most once per
  // INBOX_RECREATE_MIN_MS (false when the rate limit refuses); a card with nowhere else to go
  // (`force`) always may, or it would land in General.
  const dropDeletedInbox = (threadId: number, why: string | undefined, force = false): boolean => {
    // Another send already found it gone and a new topic replaced it: just use that one.
    if (state.inboxState.threadId !== threadId) return true
    if (!force && Date.now() - inboxRecreatedAt < INBOX_RECREATE_MIN_MS) return false
    inboxRecreatedAt = Date.now()
    log(`inbox: topic ${threadId} rejected a send (${why}) — recreating it`)
    state.inboxState = emptyInboxState(ctx.chatId)
    persistInbox()
    return true
  }

  // tg-cli#717: a card whose session has no topic is posted INTO the Inbox, with a notification
  // (it is the card, not a silent copy), and recorded as the key's Inbox entry so the sync never
  // copies it again. Posted directly: the send guard keeps everything else out of the Inbox.
  const postCardToInbox = async (req: ButtonRequest, key: string): Promise<{ messageId: number; threadId: number } | null> => {
    if (!inboxEnabled) return null
    // A second attempt only after the topic was found deleted and recreated.
    for (let attempt = 0; attempt < 2; attempt++) {
      const threadId = await ensureInboxTopic()
      if (threadId === null) return null
      const resp = await sendCardMessage(ctx, req, threadId)
      const messageId = sentMessageId(resp)
      if (messageId !== undefined) {
        state.inboxState.mirrors[key] = { messageId, card: true }
        persistInbox()
        return { messageId, threadId }
      }
      // Only a topic Telegram reports deleted is recreated: a private-topics "thread not found" is
      // transient, and recreating on it would orphan the Inbox and its open cards.
      const topicGone = !resp.ok && isTopicDeletedError(resp.description)
      if (topicGone && attempt === 0 && dropDeletedInbox(threadId, resp.description, true)) continue
      log(`inbox: card ${key} not posted in the Inbox (${postFailureText(resp)}) — General instead`)
      return null
    }
    return null
  }

  const syncInboxOnce = async (): Promise<void> => {
    // `tg auth` rebound the chat: the old topic and its copies are out of reach.
    if (state.inboxState.chatId !== ctx.chatId) {
      state.inboxState = emptyInboxState(ctx.chatId)
      persistInbox()
    }
    const open = new Map(openCards().map((c) => [c.key, c]))
    const plan = planInboxSync(open.values(), state.inboxState)
    forgetClosedMirrors(sync, plan.remove)
    await retireOwedCopies(sync)
    if (plan.post.length === 0) return
    const threadId = await ensureInboxTopic()
    if (threadId === null) return
    await postMissingCopies(sync, plan.post, open, threadId)
  }

  const sync: InboxSyncContext = {
    ctx,
    state,
    persistInbox,
    dropDeletedInbox,
    requestRerun: () => {
      inboxDirty = true
    },
  }

  // Serialized: a run requested while one is in flight runs once more after it.
  let inboxSyncing = false

  let inboxDirty = false

  const syncInbox = async (): Promise<void> => {
    if (!inboxEnabled) return
    if (inboxSyncing) {
      inboxDirty = true
      return
    }
    inboxSyncing = true
    try {
      do {
        inboxDirty = false
        await syncInboxOnce()
      } while (inboxDirty)
    } catch (err) {
      log(`inbox sync failed: ${err}`)
    } finally {
      inboxSyncing = false
    }
  }

  // The card a message id stands for: an Inbox copy maps to its card's own message, anything
  // else to itself. Taps on and replies to a copy go through this, so every per-card guard
  // (`action.messageId === entry.messageId`) and card edit works unchanged. A copy left from an
  // earlier card with the same request id maps to nothing current, so it answers no newer card.
  const cardMessageIdFor = (messageId: number): number => {
    const entry = inboxEntryOf(state.inboxState, messageId)
    if (entry === null) return messageId
    const card = pendingButtons.get(entry.key) ?? abandonedButtons.get(entry.key)
    return card && card.messageId === entry.cardId ? card.messageId : messageId
  }

  // A QUEUED permission decision past QUEUED_DECISION_NOTICE_MS with no reconnect
  // gets a ONE-TIME proactive "still waiting to reconnect" notice (Alex tg#9982:
  // a long-running uncertainty must be reported, but the queued tap itself must
  // NEVER be silently dropped/demoted on a timer). The queue is NOT cleared — it
  // stays eligible for automatic delivery (decideQueuedPermissionReconnect) until
  // a relevance signal closes the card. `notifiedAt` makes this idempotent.
  // Returns whether anything changed, so callers know whether a persist is warranted.
  const noticeStaleQueuedDecisions = (now: number): boolean => {
    let changed = false
    for (const entry of abandonedButtons.values()) {
      const qd = entry.queuedDecision
      if (!qd || qd.notifiedAt !== undefined || now - qd.at <= QUEUED_DECISION_NOTICE_MS) continue
      // An entry with no `promptTurnId` never auto-delivers on reconnect (see the
      // gate in handleHookSocketLine) — queuedDecisionStillWaitingText's "will
      // still be delivered automatically if it reconnects" would be a straight-up
      // lie for it (review finding: the notice text overpromised for exactly the
      // case the delivery gate carves out). Skip the still-waiting notice
      // entirely here.
      if (!queuedDecisionCanAutoDeliver(entry.req)) continue
      qd.notifiedAt = now
      changed = true
      const label = resolveSessionName({ tmuxWindow: entry.req.windowName, cwd: entry.req.cwd }).primary
      if (entry.messageId !== null) {
        void editMessageText(
          ctx,
          entry.messageId,
          queuedDecisionStillWaitingText(entry.req, label, qd.label),
          buildButtonMessage(ctx.chatId, entry.req).reply_markup,
          hatchParseMode(entry.req),
        )
      }
      log(`ask-permission-decision-queue-still-waiting-notice: ${describeAskRequest(entry.req)}`)
    }
    return changed
  }

  // Durable question state (this PR): persist pending + abandoned + answered to disk
  // on every mutation (atomic) so a daemon restart loses nothing — a late tap still
  // late-delivers and a reconnecting hook re-attaches instead of duplicating its card.
  // Every write is also the point the 📥 Inbox catches up with the open set (tg-cli#705).
  const persistQuestions = (): void => {
    try {
      const now = Date.now()
      // Fire the still-waiting notice for any queue past its notice threshold
      // BEFORE writing, so `notifiedAt` is durable the instant it fires (a restart
      // right after must not re-send the notice).
      noticeStaleQueuedDecisions(now)
      pruneAnsweredButtons(answeredButtons, now)
      const data: QuestionStoreData = {
        questions: [
          // A LIVE pending scoped question and an abandoned one are equivalent on
          // disk — both restore as "abandoned" (no live socket), recoverable by a
          // late tap or a reconnect. Unscoped (paneId-less) pending is skipped: it
          // can't be late-delivered (no pane) and must not resurrect to re-wedge —
          // except a hatch permission, whose card stays answerable through its grace
          // record: dropping it made every tap after a daemon restart "expired"
          // (tg-cli#403).
          ...[...pendingButtons.values()]
            .filter((e) =>
              e.req.kind === "permission"
                ? Boolean(e.req.paneId) || isHatchRequest(e.req)
                : Boolean(e.req.paneId && e.req.options?.length),
            )
            .map((e) => ({
              req: e.req as unknown as Record<string, unknown>,
              messageId: e.messageId,
              at: e.at,
              pending: true as const,
            })),
          ...[...abandonedButtons.values()].map((e) => ({
            req: e.req as unknown as Record<string, unknown>,
            messageId: e.messageId,
            at: e.at,
            // A queued permission decision MUST survive a restart (see
            // AbandonedButton.queuedDecision) — otherwise the card keeps claiming
            // "delivered automatically once the hook reconnects" for a decision
            // that a restart just silently threw away.
            ...(e.queuedDecision ? { queuedDecision: e.queuedDecision } : {}),
          })),
        ],
        answered: [...answeredButtons].map(([key, e]) => ({
          key,
          value: e.value,
          label: e.label,
          decision: e.decision,
          at: e.at,
          delivery: e.delivery,
        })),
      }
      atomicWrite(ctx.paths.questions, serializeQuestionStore(data))
      // The write above is the file without any card this process no longer holds, so a
      // decided card with no expiry (a critical one) has no stale copy left to guard:
      // drop its record now rather than only at the next restart (grants.ts dropSettledDecided).
      if (dropSettledDecided(grantsData, new Set([...pendingButtons.keys(), ...abandonedButtons.keys()]))) persistGrants()
    } catch (err) {
      // Best-effort, like routes/topics: a persist failure must never break the hot
      // forward/answer path. The state simply isn't durable until the next mutation.
      log(`question persist failed: ${err}`)
    }
    void syncInbox()
  }

  // --- Late-approval grant protocol v1.1 (tg-cli#398): the daemon-owned stores ---
  // Loaded BEFORE the question restore below: a hatch record that expired while the
  // daemon was DOWN upserts its grace record at restore time (the second of the two
  // retire paths), which needs this store live first. Each grace record's `req` is
  // re-run through the AUTHORITATIVE normalizeButtonRequest — one that no longer
  // validates (schema drift, corruption) is dropped fail-closed, never trusted from
  // disk (parseGrantStore only shape-sniffs `req`; see its doc comment).
  const grantsData = (() => {
    const parsed = parseGrantStore(readFileOrNull(ctx.paths.grants), Date.now())
    parsed.grace = parsed.grace.flatMap((g) => {
      const req = normalizeButtonRequest(g.req)
      if (!req || !(req.kind === "permission" && isHatchRequest(req))) return []
      return [{ ...g, req }]
    })
    return parsed
  })()

  // FAIL-CLOSED persistence (unlike persistQuestions above): every grant mutation
  // (mint/consume) MUST persist before it is confirmed, and a failed write means the
  // mutation is rolled back — otherwise a daemon restart could resurrect a consumed
  // grant as usable (single-use replay) or lose a confirmed one.
  const persistGrants = (): boolean => {
    try {
      const now = Date.now()
      // Prune the LIVE store too (serializeGrantStore only prunes its copy):
      // keeps in-memory scans bounded and memory/disk consistent.
      pruneGrantStore(grantsData, now)
      atomicWrite(ctx.paths.grants, serializeGrantStore(grantsData, now))
      return true
    } catch (err) {
      log(`grant persist failed: ${err}`)
      return false
    }
  }

  // THE one place a hatch card gets its grace record — a live expiry (both live retire
  // paths, the unscoped backstop timer and the hook socket close, converge on
  // retireAbandonedEntry, which calls onHatchExpired) and both restore paths below — so a
  // late Approve tap stays addressable for GRACE_WINDOW_MS (24h), outliving the 12h
  // abandoned retention. Only a hatch permission gets one, once: a card that already has
  // a record keeps it and its anchor (a second retire, a restore re-seeing the card).
  // Returns whether it wrote one.
  const ensureHatchGrace = (req: ButtonRequest, key: string, messageId: number | null, expiredAt: number): boolean => {
    const parsedHookId = req.kind === "permission" ? parseHatchHookId(req.requestId) : null
    if (parsedHookId === null || grantsData.grace.some((g) => g.key === key)) return false
    const hookId = req.hookId ?? parsedHookId
    upsertGraceRecord(grantsData.grace, buildGraceRecord(req, key, hookId, routeForRequest(req), messageId, expiredAt, GRACE_WINDOW_MS))
    return true
  }

  // Fail-soft with a loud log: losing grace degrades the feature but never authorizes anything.
  const onHatchExpired = (entry: PendingButton, pendingKey: string): void => {
    if (!ensureHatchGrace(entry.req, pendingKey, entry.messageId, Date.now())) return
    if (!persistGrants()) log(`grace persist failed for ${pendingKey} — late taps on this card will not be addressable`)
  }

  return { postCardToInbox, syncInbox, cardMessageIdFor, noticeStaleQueuedDecisions, persistQuestions, grantsData, persistGrants, ensureHatchGrace, onHatchExpired }
}

export type QuestionInboxApi = ReturnType<typeof createQuestionInbox>
