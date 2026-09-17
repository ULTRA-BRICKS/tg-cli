// tg-cli#403: pure unit tests for the critical-mode reminder scheduler
// (features/tg-ctl/hatch-critical-reminder.ts). Mirrors tg-awareness-nudge.test.ts's
// style — no daemon, no Telegram, just the scheduling decision in isolation.
//
// Local-time note: isQuietHours/nextQuietHoursEnd operate on the HOST's local
// clock (by design — see that module's own header comment: the same machine
// the Telegram bot/human's phone relationship already assumes). Every fixed
// instant below is built with `new Date(y, m, d, hh, mm)` (the LOCAL-time
// constructor), never a raw UTC ms literal, so these tests are correct
// regardless of the runner's timezone.
import { expect, test } from 'bun:test';
import {
  CRITICAL_REMINDER_INTERVAL_MS,
  QUIET_HOURS_END_HOUR,
  QUIET_HOURS_START_HOUR,
  isQuietHours,
  markCriticalReminderSent,
  nextQuietHoursEnd,
  planCriticalReminder,
  type CriticalReminderState,
} from '../features/tg-ctl/hatch-critical-reminder';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function at(hh: number, mm = 0, day = 15): number {
  return new Date(2026, 5, day, hh, mm, 0, 0).getTime(); // 2026-06-15, an arbitrary Monday
}

test('defaults match the ticket-specified values', () => {
  expect(CRITICAL_REMINDER_INTERVAL_MS).toBe(15 * 60_000);
  expect(QUIET_HOURS_START_HOUR).toBe(23);
  expect(QUIET_HOURS_END_HOUR).toBe(8);
});

test('isQuietHours: default wrap-around window (23-8) covers both sides of midnight', () => {
  expect(isQuietHours(at(23, 30))).toBe(true);
  expect(isQuietHours(at(0, 30))).toBe(true);
  expect(isQuietHours(at(7, 59))).toBe(true);
  expect(isQuietHours(at(8, 0))).toBe(false); // end hour itself is NOT quiet (exclusive)
  expect(isQuietHours(at(12, 0))).toBe(false);
  expect(isQuietHours(at(22, 59))).toBe(false);
  expect(isQuietHours(at(23, 0))).toBe(true); // start hour itself IS quiet (inclusive)
});

test('isQuietHours: a non-wrapping same-day window (e.g. 1-6) is quiet only inside that range', () => {
  expect(isQuietHours(at(0, 30), 1, 6)).toBe(false);
  expect(isQuietHours(at(1, 0), 1, 6)).toBe(true);
  expect(isQuietHours(at(5, 59), 1, 6)).toBe(true);
  expect(isQuietHours(at(6, 0), 1, 6)).toBe(false);
  expect(isQuietHours(at(12, 0), 1, 6)).toBe(false);
});

test('isQuietHours: a degenerate zero-width window (start === end) is never quiet', () => {
  expect(isQuietHours(at(3, 0), 9, 9)).toBe(false);
  expect(isQuietHours(at(9, 0), 9, 9)).toBe(false);
});

test('nextQuietHoursEnd: today\'s boundary when still before it', () => {
  const now = at(2, 0);
  expect(nextQuietHoursEnd(now, 8)).toBe(at(8, 0));
});

test('nextQuietHoursEnd: tomorrow\'s boundary when already past it today', () => {
  const now = at(10, 0);
  expect(nextQuietHoursEnd(now, 8)).toBe(at(8, 0, 16)); // next day
});

test('a fresh critical request (never reminded) is due once the interval elapses, not before', () => {
  const postedAt = at(12, 0);
  const state: CriticalReminderState = { lastReminderAt: postedAt };
  const tooSoon = planCriticalReminder(state, postedAt + CRITICAL_REMINDER_INTERVAL_MS - MIN);
  expect(tooSoon.due).toBe(false);
  const dueNow = planCriticalReminder(state, postedAt + CRITICAL_REMINDER_INTERVAL_MS);
  expect(dueNow.due).toBe(true);
});

test('a reminder that fires resets the cadence clock for the next one', () => {
  const t0 = at(12, 0);
  const sent = markCriticalReminderSent(t0, 501);
  expect(sent.lastReminderAt).toBe(t0);
  expect(sent.lastReminderMessageId).toBe(501);
  const next = planCriticalReminder(sent, t0 + CRITICAL_REMINDER_INTERVAL_MS - MIN);
  expect(next.due).toBe(false);
  const nextDue = planCriticalReminder(sent, t0 + CRITICAL_REMINDER_INTERVAL_MS);
  expect(nextDue.due).toBe(true);
});

test('a FAILED send does not consume the reminder — replanning the same state stays due', () => {
  const state: CriticalReminderState = { lastReminderAt: at(12, 0) };
  const due = at(12, 15);
  const first = planCriticalReminder(state, due);
  expect(first.due).toBe(true);
  // The caller's send attempt failed and never called markCriticalReminderSent —
  // state is unchanged, so replanning at the same (or a later) instant must
  // still report due, exactly like markAwarenessNudgeSent's "stays due on
  // failure/drop" discipline.
  const retry = planCriticalReminder(first.nextState, due + MIN);
  expect(retry.due).toBe(true);
});

test('a reminder due DURING quiet hours defers to exactly one reminder at the boundary — not silently dropped, not fired overnight', () => {
  // Last reminder at 22:50; the next cadence tick (23:05, 15 min later) lands
  // inside the default 23-8 quiet window.
  const lastReminderAt = at(22, 50);
  const tickInsideQuietHours = at(23, 5);
  const deferred = planCriticalReminder({ lastReminderAt }, tickInsideQuietHours);
  expect(deferred.due).toBe(false);
  expect(deferred.nextState.quietHoursDeferredUntil).toBe(at(8, 0, 16)); // next day's 08:00

  // A later sweep tick, still inside quiet hours, before the boundary: still not due.
  const stillQuiet = planCriticalReminder(deferred.nextState, at(3, 0, 16));
  expect(stillQuiet.due).toBe(false);
  expect(stillQuiet.nextState.quietHoursDeferredUntil).toBe(at(8, 0, 16));

  // The boundary itself: fires exactly once.
  const atBoundary = planCriticalReminder(deferred.nextState, at(8, 0, 16));
  expect(atBoundary.due).toBe(true);

  // The send succeeds — commit it. The deferral is cleared and normal cadence resumes.
  const committed = markCriticalReminderSent(at(8, 0, 16), 900);
  expect(committed.quietHoursDeferredUntil).toBeUndefined();

  // Immediately after the boundary fire: not due again until a full interval passes —
  // this is the "then normal cyclic reminders resume" half of the contract, not a
  // second immediate fire.
  const rightAfter = planCriticalReminder(committed, at(8, 1, 16));
  expect(rightAfter.due).toBe(false);
  const nextCycle = planCriticalReminder(committed, at(8, 0, 16) + CRITICAL_REMINDER_INTERVAL_MS);
  expect(nextCycle.due).toBe(true);
});

test('quiet hours in the OTHER wrap direction (a reminder due just before midnight, boundary the next morning) also defers to exactly one', () => {
  const lastReminderAt = at(20, 0);
  // 15 minutes later would be 20:15 - still not due by cadence; instead simulate a
  // longer gap landing well inside quiet hours.
  const tickAtOneAm = at(1, 0, 16);
  const deferred = planCriticalReminder({ lastReminderAt }, tickAtOneAm);
  expect(deferred.due).toBe(false);
  expect(deferred.nextState.quietHoursDeferredUntil).toBe(at(8, 0, 16));
  const atBoundary = planCriticalReminder(deferred.nextState, at(8, 0, 16));
  expect(atBoundary.due).toBe(true);
});

test('a reminder due exactly when NOT quiet hours fires immediately — no deferral computed', () => {
  const state: CriticalReminderState = { lastReminderAt: at(9, 0) };
  const due = at(9, 15);
  const plan = planCriticalReminder(state, due);
  expect(plan.due).toBe(true);
  expect(plan.nextState.quietHoursDeferredUntil).toBeUndefined();
});

test('a stale quietHoursDeferredUntil left over from a resolved episode does not leak into a later, unrelated quiet-hours episode', () => {
  // Simulate a record that (through some restore/edge path) still carries a
  // deferral boundary from a PRIOR fire, alongside a `lastReminderAt` newer
  // than that boundary (i.e. the deferred reminder already fired and reset
  // the clock, but the deferral field itself was never cleared upstream).
  const stale: CriticalReminderState = { lastReminderAt: at(9, 0), quietHoursDeferredUntil: at(8, 0) };
  // Not yet due by cadence — the stale deferral must not force an early fire.
  const plan = planCriticalReminder(stale, at(9, 10));
  expect(plan.due).toBe(false);
  expect(plan.nextState.quietHoursDeferredUntil).toBeUndefined();
});

test('a deferred reminder whose boundary was passed WHILE STILL/AGAIN quiet (e.g. the sweep was missed for so long that now wrapped into a LATER quiet-hours window — the host slept through the whole boundary day) re-defers instead of paging overnight', () => {
  // Deferred at 23:05 to fire at day+1 08:00 (the ordinary case, see the test
  // above). Now simulate the sweep NEVER running again until deep inside the
  // FOLLOWING night — day+1 23:30 — which is >= the stored boundary (day+1
  // 08:00) but is ALSO, independently, quiet hours again. Firing here would
  // page overnight, exactly the "never at night" guarantee this feature exists
  // for; the correct behavior is to re-defer to the NEW boundary.
  const deferredState: CriticalReminderState = { lastReminderAt: at(22, 50), quietHoursDeferredUntil: at(8, 0, 16) };
  const missedFarIntoTheNextQuietWindow = at(23, 30, 16);
  const plan = planCriticalReminder(deferredState, missedFarIntoTheNextQuietWindow);
  expect(plan.due).toBe(false);
  // Re-deferred to the NEXT quiet-hours-end boundary from NOW, not the stale one.
  expect(plan.nextState.quietHoursDeferredUntil).toBe(at(8, 0, 17));

  // And once THAT new boundary is actually reached in daylight, it fires normally.
  const atNewBoundary = planCriticalReminder(plan.nextState, at(8, 0, 17));
  expect(atNewBoundary.due).toBe(true);
});

// tg-cli#403 setTimeout-overflow landmine regression: this scheduler is PURELY
// timestamp-comparison based (Date.now()/new Date(ms) arithmetic) and never
// itself calls setTimeout with a caller-controlled delay, so the 32-bit
// overflow clamp this ticket warns about cannot originate here — it lives in
// tg-ctl root's oneAskAttempt (the ASK CLIENT socket wait), which is exercised
// by the integration test instead (ctl-hatch-critical-wait-integration.test.ts).
// This test only pins the invariant this module's CONTRACT relies on to stay
// safe even under an absurdly long-pending critical request: a request that
// has been waiting far longer than 2^31-1 ms (~24.8 days) is still handled by
// ordinary finite arithmetic here, never by feeding a delay to setTimeout.
test('a request pending far longer than 2^31-1 ms (the 32-bit setTimeout overflow bound) still schedules normally, no special-casing needed', () => {
  const TIMEOUT_MAX_MS = 2_147_483_647;
  const lastReminderAt = at(12, 0);
  const now = at(12, 0, 15 + 75); // 75 days later, same time-of-day — safely outside quiet hours
  expect(now - lastReminderAt).toBeGreaterThan(TIMEOUT_MAX_MS);
  const plan = planCriticalReminder({ lastReminderAt }, now);
  expect(plan.due).toBe(true);
});
