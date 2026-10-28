// daemon-runtime/reminders-restore: retired-reminder cleanup and restoring persisted question cards on startup.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { unlinkSync } from "fs"
import { join } from "path"
import { callbackRequestId, isHatchRequest } from "../questions"
import { parseQuestionStore, type RetainedQuestionRecord } from "../question-store"
import { addRetireTargets, legacyReminderMessages, hasLegacyCriticalState, parseRetireQueue, serializeRetireQueue } from "../question-inbox"
import { dropSettledDecided } from "../grants"
import { atomicWrite, log, readFileOrNull } from "./ctx-io"
import { ANSWERED_REPLAY_MS, ASK_LIVE_MAX_MS, normalizeButtonRequest } from "./button-requests"
import { retireMessage } from "./telegram-api"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { QuestionInboxApi } from "./question-inbox-runtime"
import type { StartupApi } from "./daemon-startup"

export type RemindersDeps = {
  ctx: Ctx
  state: DaemonState
  questionInbox: QuestionInboxApi
  startup: StartupApi
}

// What the startup restore reads and writes: the stores it fills and the persistence it triggers.
export interface RestoreContext {
  ctx: Ctx
  grantsData: QuestionInboxApi["grantsData"]
  abandonedButtons: StartupApi["abandonedButtons"]
  answeredButtons: StartupApi["answeredButtons"]
  ensureHatchGrace: QuestionInboxApi["ensureHatchGrace"]
  persistGrants: QuestionInboxApi["persistGrants"]
  persistQuestions: QuestionInboxApi["persistQuestions"]
  reminderRetirePath: string
}

interface RestoredCard {
  decided: boolean
  pending: boolean
  grace: boolean
}

const NOT_RESTORED: RestoredCard = { decided: false, pending: false, grace: false }

// Restores one stored card into `abandonedButtons` (and its hatch grace record); reports which
// restore-time changes the files must catch up with. Everything not restorable is skipped.
export function restoreCard(rc: RestoreContext, rec: RetainedQuestionRecord, nowRestore: number): RestoredCard {
  const { grantsData, abandonedButtons, ensureHatchGrace } = rc
  const req = normalizeButtonRequest(rec.req)
  if (!req) return NOT_RESTORED
  if (!req.paneId && !(req.kind === "permission" && isHatchRequest(req))) return NOT_RESTORED
  if (req.kind === "question" && !req.options?.length) return NOT_RESTORED
  // A card a human already decided stays closed (grants.ts DecidedCard): the
  // best-effort questions write of that decision may have been lost, and restoring
  // the card — retained, with a fresh grace record — would let a later Approve tap or
  // "да" reply undo a Deny (tg-cli#433). Dropped here, it leaves the file below.
  if (grantsData.decided.some((d) => d.key === callbackRequestId(req))) return { ...NOT_RESTORED, decided: true }
  // When this card expired — the start of its grace window. An entry still pending
  // when the old process wrote it lost its live socket with that process, so it
  // expired at this restart; `rec.at` is only when it was posted (a 14-minute-old
  // ask would otherwise get a grace window 14 minutes short). A non-critical ask
  // cannot have been live longer than ASK_LIVE_MAX_MS, so an older pending mark is a
  // stale copy and its window starts no later than that (a critical ask waits without
  // limit). An abandoned entry's `rec.at` is already its expiry moment
  // (retainAbandonedQuestion).
  let expiredAt = rec.at
  if (rec.pending) expiredAt = req.critical ? nowRestore : Math.min(nowRestore, rec.at + ASK_LIVE_MAX_MS)
  // Only a PERMISSION can carry a queued decision (see AbandonedButton.queuedDecision) —
  // a stray one on a non-permission record (corrupt/foreign write) is dropped rather
  // than silently auto-answering a question it was never meant for.
  const queuedDecision = req.kind === "permission" ? rec.queuedDecision : undefined
  abandonedButtons.set(callbackRequestId(req), { req, messageId: rec.messageId, at: rec.at, queuedDecision })
  // A restored hatch ask lost its live socket with the old process — a paneless
  // requester can never reconnect — so it has EXPIRED just like a socket-close
  // retire: give it the grace record that retire would have written, so a late
  // Approve can still mint a grant (tg-cli#403). A pane-scoped ask that does reconnect
  // is then answered live, which retires the record again (executeAction's
  // answer-question case).
  const grace = ensureHatchGrace(req, callbackRequestId(req), rec.messageId, expiredAt)
  return { decided: false, pending: Boolean(rec.pending), grace }
}

// One-shot migration (tg-cli#705): the removed #403 / #464 reminders recorded the "⏳ still
// waiting" pings they left in the chat — in each critical card's `criticalState` and in
// `tg-ctl.<bot>.unanswered-reminder.json`. Their ids move to the retire queue FIRST, then the
// old state file goes and the questions file is rewritten without the old field, so a restart
// finds nothing to migrate (idempotent) — and a ping Telegram cannot retire right now (an
// outage at upgrade time) stays queued until it is (tg-cli#723). A failed queue write keeps
// the old sources for the next start. Returns whether the queue write succeeded.
function migrateLegacyReminders(rc: RestoreContext, questionsRaw: string | null): boolean {
  const { ctx, reminderRetirePath } = rc
  const legacyUnansweredPath = join(ctx.configDir, `tg-ctl.${ctx.botId}.unanswered-reminder.json`)
  const legacyReminders = legacyReminderMessages(questionsRaw, readFileOrNull(legacyUnansweredPath), ctx.chatId)
  let legacyQueued = true
  if (legacyReminders.length > 0) {
    try {
      atomicWrite(reminderRetirePath, serializeRetireQueue(addRetireTargets(parseRetireQueue(readFileOrNull(reminderRetirePath)), legacyReminders)))
      log(`reminder migration: queued ${legacyReminders.length} old reminder message(s) to retire`)
    } catch (err) {
      legacyQueued = false
      log(`reminder migration: queue write failed (${err}) — the old state stays for the next start`)
    }
  }
  if (legacyQueued) {
    try {
      unlinkSync(legacyUnansweredPath)
      log("reminder migration: removed the unanswered-reminder state file")
    } catch {
      // absent — nothing to migrate
    }
  }
  return legacyQueued
}

// Restore durable state on bootstrap. A restored scoped question lands in
// `abandonedButtons` (no live socket) — a late tap injects to its pane, a reconnect
// re-attaches. Restored scoped permissions land there too so a reconnecting hook can
// re-attach to its existing card instead of posting a duplicate. Re-normalize each
// `req` through the AUTHORITATIVE validator and drop anything that isn't scoped (and
// for questions: carrying options). Answered entries restore the replay cache.
// Questions are read with no age window and no count cap: a card stays open, however long the
// daemon was down and however many are open, until a relevance signal closes it (tg-cli#705,
// #707). Only the answered-replay cache is capped (question-store.ts MAX_ANSWERED_RECORDS).
function restoreQuestionsFromDisk(rc: RestoreContext): void {
  const { ctx, grantsData, abandonedButtons, answeredButtons, persistGrants, persistQuestions } = rc
  const nowRestore = Date.now()
  const questionsRaw = readFileOrNull(ctx.paths.questions)
  const raw = parseQuestionStore(questionsRaw, nowRestore, Number.MAX_SAFE_INTEGER, ANSWERED_REPLAY_MS)
  const keysOnDisk = new Set<string>()
  for (const rec of raw.questions) {
    const req = normalizeButtonRequest(rec.req)
    if (req) keysOnDisk.add(callbackRequestId(req))
  }
  // A decided critical card's record is kept while a stale copy of it is on disk; one
  // whose copy is gone guards nothing any more (grants.ts dropSettledDecided).
  const decidedSettled = dropSettledDecided(grantsData, keysOnDisk)
  let graceOnRestore = false
  let decidedOnRestore = false
  let pendingOnRestore = false
  for (const rec of raw.questions) {
    const restored = restoreCard(rc, rec, nowRestore)
    graceOnRestore ||= restored.grace
    decidedOnRestore ||= restored.decided
    pendingOnRestore ||= restored.pending
  }
  for (const a of raw.answered) {
    answeredButtons.set(a.key, { value: a.value, label: a.label, decision: a.decision, at: a.at, delivery: a.delivery })
  }
  if (abandonedButtons.size || answeredButtons.size) {
    log(`questions restored: ${abandonedButtons.size} retained, ${answeredButtons.size} answered`)
  }
  // A record dropped above as already decided was never added to `abandonedButtons`, so
  // it is gone from MEMORY — but the on-disk file still holds it. Persist once now so the
  // file matches memory immediately — and the grants file with it (the restore-time grace
  // upserts above). The questions write also drops a restored entry's `pending` mark: its
  // grace window is anchored now, and a later restart must not re-anchor it (re-opening a
  // card whose window closed) — so the grace records it anchored go to disk first.
  // The questions file is the only durable copy of a card the restore just dropped or
  // re-anchored, so a failed grants write (fail-closed) leaves it untouched: writing it
  // anyway would lose the card with no grace record to carry it on the next restart.
  const legacyQueued = migrateLegacyReminders(rc, questionsRaw)
  const legacyFieldGoes = legacyQueued && hasLegacyCriticalState(questionsRaw)
  const grantsDurable = !(graceOnRestore || decidedSettled) || persistGrants()
  if (grantsDurable && (decidedOnRestore || pendingOnRestore || legacyFieldGoes)) persistQuestions()
}

export function createReminders(d: RemindersDeps) {
  const { ctx } = d
  const { persistQuestions, grantsData, persistGrants, ensureHatchGrace } = d.questionInbox
  const { answeredButtons, abandonedButtons } = d.startup

  // tg-cli#723: the old reminder pings the startup migration below queued to retire. Retired
  // at startup, then — while any stays queued because Telegram did not answer — retried from
  // the poll loop at most once per REMINDER_RETIRE_RETRY_MS. A transient failure ends the pass.
  const reminderRetirePath = join(ctx.configDir, `tg-ctl.${ctx.botId}.reminder-retire.json`)

  const REMINDER_RETIRE_RETRY_MS = 60_000

  let reminderRetireDone = false

  let reminderRetiring = false

  let reminderRetireAt = 0

  const retireQueuedReminders = async (): Promise<void> => {
    if (reminderRetireDone || reminderRetiring || Date.now() - reminderRetireAt < REMINDER_RETIRE_RETRY_MS) return
    reminderRetiring = true
    reminderRetireAt = Date.now()
    try {
      let queue = parseRetireQueue(readFileOrNull(reminderRetirePath))
      for (const r of [...queue]) {
        log(`reminder migration: retiring old reminder message ${r.messageId} in chat ${r.chatId}`)
        if (!(await retireMessage(ctx, r.chatId, r.messageId, "⏰ reminders were replaced by the 📥 Inbox topic"))) {
          log(`reminder migration: message ${r.messageId} not retired yet — retried later`)
          break
        }
        queue = queue.filter((q) => q.chatId !== r.chatId || q.messageId !== r.messageId)
        if (queue.length > 0) atomicWrite(reminderRetirePath, serializeRetireQueue(queue))
      }
      if (queue.length === 0) {
        reminderRetireDone = true
        try {
          unlinkSync(reminderRetirePath)
        } catch {
          // absent — nothing was queued
        }
      }
    } catch (err) {
      log(`reminder migration: retire pass failed: ${err}`)
    } finally {
      reminderRetiring = false
    }
  }

  const restoreCtx: RestoreContext = {
    ctx,
    grantsData,
    abandonedButtons,
    answeredButtons,
    ensureHatchGrace,
    persistGrants,
    persistQuestions,
    reminderRetirePath,
  }
  restoreQuestionsFromDisk(restoreCtx)

  void retireQueuedReminders()

  return { retireQueuedReminders }
}

export type RemindersApi = ReturnType<typeof createReminders>
