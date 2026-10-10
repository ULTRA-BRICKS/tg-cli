// tg-cli#403: quiet-hours-aware reminder cadence for CRITICAL hatch/permission
// requests — a request that opts into `ButtonRequest.critical === true` never
// times out (askDaemon's ASK_TOTAL_TIMEOUT_MS bound is skipped for it, and the
// daemon's own UNSCOPED_ABANDON_MS backstop never force-closes its socket
// either), so a human decision it's waiting on can otherwise sit silently
// forgotten in the Telegram chat for hours. This module decides WHEN to remind.
//
// This is the SANCTIONED EXCEPTION to tg-cli#360/#380's standing "no new
// timers — timers are a workaround 99% of the time" rule: Alex asked for this
// exact cadence, verbatim, in the tg-cli#403 ticket body ("таймауты надо иметь
// возможность выключать... В таком случае должны приходить повторы, но не
// ночью" — timeouts must be disableable for a critical decision, and in that
// case repeat reminders should arrive, but never at night). Cite tg-cli#403
// wherever this module's cadence is questioned; it is not a regression of
// #360/#380's rule.
//
// PURE — the daemon supplies `now` and the persisted per-request scheduling
// state (RetainedQuestionRecord.criticalState / the mirrored in-memory field on
// PendingButton/AbandonedButton); this module decides whether a reminder is due
// right now and returns the updated scheduling state to persist. Deliberately
// operates on ONE request's state at a time (unlike tg-awareness-nudge.ts's
// planAwarenessNudges, which owns a whole per-agent-key store): a critical
// entry's state already lives inside the daemon's EXISTING per-request maps
// (pendingButtons / abandonedButtons), not a parallel store keyed by agent —
// there is no separate "which requests are live" population to iterate here,
// the daemon's own sweep loop already has that.
//
// Message-id bookkeeping (which Telegram message to delete/edit-away when the
// NEXT reminder posts — acceptance criterion (c), "never let reminders pile
// up") is intentionally OUTSIDE this module's state shape (CriticalReminderState
// has no `lastReminderMessageId`): it is a Telegram artifact the daemon owns
// after a real network call, not a pure scheduling decision. The daemon's own
// persisted `criticalState` widens this module's shape with that field.

export const CRITICAL_REMINDER_INTERVAL_MS = Number(process.env.TG_CTL_CRITICAL_REMINDER_INTERVAL_MS) || 15 * 60_000;

// Hour-of-day bounds (0-23, daemon host local time — the same machine the
// Telegram bot/human's phone relationship already assumes). Unlike a plain
// millisecond duration, `0` is a legitimate override (midnight) that the usual
// `Number(env) || default` idiom would silently reject as falsy — validated
// range-checked instead, same as this file's other non-duration env knobs.
// Review finding: `Number('')` is `0`, which — under a bare `Number(x)` check —
// would make an accidentally-EMPTY env var (e.g. an unresolved variable in a
// `.env`/compose file, `TG_CTL_QUIET_HOURS_START_HOUR=`) indistinguishable from
// an explicit "quiet hours start at midnight" override, silently discarding the
// documented default. Require a genuinely non-empty string AND an integer
// (rejects `''`, whitespace-only, and fractional hours like `8.5` alike) before
// even attempting to parse it as an override.
function envHour(name: string, fallback: number): number {
  const rawStr = process.env[name];
  if (rawStr === undefined || rawStr.trim() === '') return fallback;
  const raw = Number(rawStr);
  return Number.isInteger(raw) && raw >= 0 && raw < 24 ? raw : fallback;
}
export const QUIET_HOURS_START_HOUR = envHour('TG_CTL_QUIET_HOURS_START_HOUR', 23);
export const QUIET_HOURS_END_HOUR = envHour('TG_CTL_QUIET_HOURS_END_HOUR', 8);

// Local host time, `now` in ms epoch. Handles the default wrap-around window
// (23 -> 8, crossing midnight) as well as an ordinary same-day window (e.g. an
// operator configuring 1-6): wrap-around iff `startHour > endHour`. A
// degenerate `startHour === endHour` (a 0-length or 24h window, however
// configured) is defined as never-quiet — "quiet hours" is meaningless once it
// spans either none or the whole day, and never-quiet is the fail-safe
// direction (a reminder can be late to defer, never late to fire).
export function isQuietHours(now: number, startHour: number = QUIET_HOURS_START_HOUR, endHour: number = QUIET_HOURS_END_HOUR): boolean {
  if (startHour === endHour) return false;
  const hour = new Date(now).getHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

// The ms epoch of the next occurrence of `endHour:00:00.000` local time AT OR
// AFTER `now` — today's if `now` is still before it, otherwise tomorrow's.
// This is the boundary a reminder that became due DURING quiet hours defers
// to, so it fires the moment quiet hours end rather than at some arbitrary
// later sweep tick.
export function nextQuietHoursEnd(now: number, endHour: number = QUIET_HOURS_END_HOUR): number {
  const d = new Date(now);
  d.setHours(endHour, 0, 0, 0);
  if (d.getTime() < now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Pure scheduling state for ONE pending critical request. Shape-compatible
// with (a subset of) question-store.ts's RetainedQuestionRecord.criticalState —
// see this module's file header for why `lastReminderMessageId` lives only on
// the daemon's wider persisted type, not here.
export interface CriticalReminderState {
  lastReminderAt?: number;
  quietHoursDeferredUntil?: number;
}

export interface CriticalReminderPlan {
  due: boolean;
  nextState: CriticalReminderState;
}

// Decide whether a reminder for this request is due at `now`. Never commits a
// firing decision into `nextState` itself (see markCriticalReminderSent's own
// doc comment for why) — `nextState` only ever carries bookkeeping that is
// true regardless of whether the caller's send attempt succeeds (namely: "a
// quiet-hours deferral boundary was computed").
export function planCriticalReminder(
  state: CriticalReminderState,
  now: number,
  intervalMs: number = CRITICAL_REMINDER_INTERVAL_MS,
  startHour: number = QUIET_HOURS_START_HOUR,
  endHour: number = QUIET_HOURS_END_HOUR,
): CriticalReminderPlan {
  const elapsedSinceLast = state.lastReminderAt === undefined ? Infinity : now - state.lastReminderAt;
  if (elapsedSinceLast < intervalMs) {
    // Not due on the ordinary cadence. A quiet-hours deferral from a PRIOR
    // episode (the reminder it was deferring already fired, cadence restarted)
    // is stale here — drop it so a LATER, unrelated quiet-hours episode starts
    // clean instead of inheriting a boundary from a fire that already happened.
    if (state.quietHoursDeferredUntil !== undefined) {
      return { due: false, nextState: { lastReminderAt: state.lastReminderAt } };
    }
    return { due: false, nextState: state };
  }

  if (!isQuietHours(now, startHour, endHour)) {
    // Not quiet hours and past the interval: fire normally. Any stale deferral
    // is dropped by markCriticalReminderSent once the send actually succeeds.
    return { due: true, nextState: state };
  }

  if (state.quietHoursDeferredUntil === undefined) {
    // First sweep to find this reminder due WHILE quiet hours are active:
    // defer to the single boundary reminder instead of firing now (never page
    // overnight) or silently dropping it (never lose it either).
    return { due: false, nextState: { lastReminderAt: state.lastReminderAt, quietHoursDeferredUntil: nextQuietHoursEnd(now, endHour) } };
  }
  if (now >= state.quietHoursDeferredUntil) {
    // The deferred boundary has passed. Re-check quiet hours at THIS instant
    // before firing: if the sweep was missed for so long that `now` has
    // wrapped all the way into a LATER quiet-hours window (e.g. the host slept
    // through the entire boundary day and woke up the following night), firing
    // here would page overnight — exactly what this feature promises never to
    // do. Re-defer to the NEW boundary instead of firing (review finding).
    if (isQuietHours(now, startHour, endHour)) {
      return { due: false, nextState: { lastReminderAt: state.lastReminderAt, quietHoursDeferredUntil: nextQuietHoursEnd(now, endHour) } };
    }
    // Fire the ONE deferred reminder.
    return { due: true, nextState: state };
  }
  // Still waiting for the deferred boundary — a later, still-quiet sweep tick.
  return { due: false, nextState: state };
}

// The daemon's persisted/in-memory scheduling state widened with the Telegram-artifact
// fields this module intentionally excludes from CriticalReminderState — see the file
// header for why. `lastReminderChatId` is the chat the reminder was posted in, so the
// next one deletes it THERE even after TG_CHAT_ID changed (tg-cli#518); absent on state
// written before it was stored (the daemon then falls back to its current chat).
export interface DaemonCriticalState extends CriticalReminderState {
  lastReminderMessageId?: number | null;
  lastReminderChatId?: number;
}

// Commits a reminder as SENT — called ONLY after the daemon's actual Telegram
// send succeeds, never before (the same discipline as
// tg-awareness-nudge.ts's markAwarenessNudgeSent: baking `lastReminderAt` into
// planCriticalReminder's own returned state, before the send even runs, would
// mean a failed/dropped delivery permanently loses that reminder — the cadence
// would silently skip ahead a full interval for a ping the human never saw).
// Always clears `quietHoursDeferredUntil`: whether this commit is the ordinary
// interval fire or the single deferred boundary fire, the deferral it may have
// been tracking is now resolved. `messageId` (in `chatId`) is the JUST-POSTED
// reminder's own Telegram message — what the NEXT reminder will delete/edit-away.
export function markCriticalReminderSent(now: number, messageId: number | null, chatId: number): DaemonCriticalState {
  return { lastReminderAt: now, lastReminderMessageId: messageId, lastReminderChatId: chatId };
}
