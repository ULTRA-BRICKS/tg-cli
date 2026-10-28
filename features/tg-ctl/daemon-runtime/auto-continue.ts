// daemon-runtime/auto-continue: auto-continue schedules and the awareness-nudge store.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { buildTextInjectPlan } from "../inject"
import { autoContinueDelayMs, formatClock } from "../limits"
import { reactionForStage } from "../reactions"
import { isDeadReset, parseSchedules, removeSchedule, serializeSchedules, upsertSchedule, type AutoContinueSchedule, type ScheduleStoreData } from "../schedule-store"
import { parseAwarenessNudgeStore, serializeAwarenessNudgeStore, type AwarenessNudgeStore } from "../tg-awareness-nudge"
import type { Action } from "../types"
import { atomicWrite, log, readFileOrNull } from "./ctx-io"
import { executeInjectSteps } from "./delivery"
import { answerCallbackQuery, clearMessageKeyboard, sendMessage, setMessageReaction } from "./telegram-api"
import { listAgentCandidates } from "./pane-discovery"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"

export type AutoContinueDeps = {
  ctx: Ctx
  state: DaemonState
}

export function createAutoContinue(d: AutoContinueDeps) {
  const { ctx, state } = d

  // --- auto-continue schedules (#113) — durable, re-armed on restart ---
  // A button tap arms a setTimeout to inject "continue" into the stalled pane at
  // reset time. The schedule is persisted so a daemon restart between the tap and
  // the reset re-arms it (a past reset fires immediately). One pending continue
  // per pane; on fire we inject, flip the card's reaction back to 👀, and drop it.
  let scheduleStore: ScheduleStoreData = parseSchedules(readFileOrNull(ctx.paths.schedules), Date.now())

  const continueTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const persistSchedules = (): void => {
    try {
      atomicWrite(ctx.paths.schedules, serializeSchedules(scheduleStore, Date.now()))
    } catch (err) {
      log(`persistSchedules failed: ${err}`)
    }
  }

  // --- tg-awareness-nudge (tg-cli#363) — durable per-agent silence-nudge state ---
  // Mirrors scheduleStore's own load/persist shape exactly (parse-on-load,
  // atomic-write-on-mutation, best-effort — a corrupt/unwritable file degrades
  // to "no nudges yet remembered", never breaks the poll loop).
  state.awarenessNudgeStore = parseAwarenessNudgeStore(readFileOrNull(ctx.paths.awarenessNudge))

  const persistAwarenessNudge = (): void => {
    try {
      atomicWrite(ctx.paths.awarenessNudge, serializeAwarenessNudgeStore(state.awarenessNudgeStore))
    } catch (err) {
      log(`persistAwarenessNudge failed: ${err}`)
    }
  }

  const fireAutoContinue = async (s: AutoContinueSchedule): Promise<void> => {
    // A reset > ~24.8 days out is clamped to MAX_TIMER_MS, so the timer can wake
    // BEFORE the real reset — re-arm instead of injecting early.
    if (Date.now() < s.resetAt) {
      armAutoContinue(s)
      return
    }
    continueTimers.delete(s.paneId)
    scheduleStore = removeSchedule(scheduleStore, s.paneId)
    persistSchedules()
    // A tmux restart recycles pane ids — %N may now host a DIFFERENT agent (or a
    // bare shell). If we knew the agent at arm time, refuse to inject "continue"
    // into a pane that no longer maps to it (executeInjectSteps only checks that
    // SOME agent is there, not WHICH). Skip quietly rather than poke the wrong one.
    if (s.agent) {
      const live = listAgentCandidates().find((c) => c.paneId === s.paneId)
      if (!live || (live.windowName && live.windowName !== s.agent)) {
        log(`auto-continue skipped: ${s.paneId} no longer hosts ${s.agent}`)
        return
      }
    }
    // Clear the card's button first so a stale card can't re-arm a second inject.
    if (s.cardMessageId !== null) await clearMessageKeyboard(ctx, s.cardMessageId)
    const res = await executeInjectSteps(buildTextInjectPlan(s.paneId, "continue"))
    if (!res.ok) {
      log(`auto-continue inject failed for ${s.paneId}: ${res.error}`)
      // Typed but still in the input box (#463): the CTO armed this — tell him.
      if (res.unsubmitted) {
        await sendMessage(ctx, res.error, s.sourceMessageId === null ? {} : { reply_parameters: { message_id: s.sourceMessageId, allow_sending_without_reply: true } })
      }
      // The agent did not resume: the source keeps its 😴, never a false 👀.
      return
    }
    log(`auto-continue fired for ${s.paneId} (agent=${s.agent})`)
    // Resume: flip the ORIGINAL inbound message (😴 → 👀), not the bot's card.
    if (s.sourceMessageId !== null) await setMessageReaction(ctx, s.sourceMessageId, reactionForStage("working"))
  }

  const armAutoContinue = (s: AutoContinueSchedule): void => {
    const existing = continueTimers.get(s.paneId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => void fireAutoContinue(s), autoContinueDelayMs(s.resetAt, Date.now()))
    continueTimers.set(s.paneId, timer)
  }

  const handleLimitContinue = async (action: Extract<Action, { kind: "limit-continue" }>): Promise<boolean> => {
    // Reject a stale FIRST-TIME tap before arming (PR #120 review): an inline
    // keyboard tapped long after its reset would otherwise upsert + arm with
    // autoContinueDelayMs() clamped to 0, injecting "continue" INSTANTLY into
    // whatever now occupies that pane id — possibly a different session. A
    // restart re-arm already drops resets this old via the schedule store's
    // own prune(); apply the identical threshold here so a first-time tap
    // (which never goes through prune) can't bypass it.
    if (isDeadReset(action.resetAt, Date.now())) {
      log(`limit-continue rejected: stale resetAt for ${action.paneId} (reset=${action.resetAt})`)
      await answerCallbackQuery(ctx, action.callbackQueryId, "This auto-continue has expired — continue manually.")
      return true
    }
    // The agent name isn't in the callback_data — recover it from the live pane.
    const agent = listAgentCandidates().find((c) => c.paneId === action.paneId)?.windowName ?? ""
    const schedule: AutoContinueSchedule = {
      paneId: action.paneId,
      resetAt: action.resetAt,
      agent,
      // The ORIGINAL inbound message (from the callback_data) is the reaction
      // target; action.messageId is the bot's card, whose button we clear on fire.
      sourceMessageId: action.sourceMessageId,
      cardMessageId: action.messageId,
      armedAt: Date.now(),
    }
    scheduleStore = upsertSchedule(scheduleStore, schedule)
    persistSchedules()
    armAutoContinue(schedule)
    await answerCallbackQuery(ctx, action.callbackQueryId, `auto-continue armed for ${formatClock(action.resetAt)}`)
    return true
  }

  // Re-arm any schedule that survived a restart (fires now if its reset passed).
  for (const s of scheduleStore.schedules) armAutoContinue(s)

  return { persistAwarenessNudge, handleLimitContinue }
}

export type AutoContinueApi = ReturnType<typeof createAutoContinue>
