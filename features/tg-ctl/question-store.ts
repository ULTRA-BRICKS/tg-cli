// PURE (de)serialization for the daemon's durable forwarded-question state
// (CtlPaths.questions). The tg-ctl entrypoint owns the file I/O (atomic write +
// readFileOrNull) and the AUTHORITATIVE request normalization
// (normalizeButtonRequest); this module owns only the on-disk FORMAT — the
// versioned envelope, answered-record validation, and age/count pruning. `req` is
// kept un-normalized here (returned as a plain object the entrypoint re-validates)
// so normalizeButtonRequest stays the single source of truth for what a
// ButtonRequest is.
//
// Why persist at all: the daemon held question state ONLY in memory, so a hook
// socket close (the agent's 120s hook budget) or a daemon restart (crash-relaunch
// by launchd, or a deliberate stop+start) lost it — a late Telegram tap was
// dropped and a restart orphaned the human's pending card. Persisting scoped
// questions + the answered-replay cache lets a restored daemon late-deliver a tap
// to the asking pane and re-attach a reconnecting hook instead of posting a
// duplicate card.

import type { PermissionDecision } from './questions';
import type { DaemonCriticalState } from './hatch-critical-reminder';

// One retained question: a LIVE pending OR a socket-closed (abandoned) one — both
// are equivalent on disk, a SCOPED question whose chosen answer can still reach its
// pane. The entrypoint normalizes `req` via normalizeButtonRequest and re-keys by
// callbackRequestId.
export interface RetainedQuestionRecord {
  req: Record<string, unknown>; // a scoped question ButtonRequest (entrypoint re-validates)
  messageId: number | null; // the Telegram card id (edit/answer target)
  at: number; // ms epoch when posted/abandoned (age window + overflow ordering)
  // A PERMISSION decision already tapped in Telegram while the hook was
  // disconnected, awaiting delivery to a reconnecting hook (tg-ctl's
  // AbandonedButton.queuedDecision). MUST be persisted: a daemon restart between
  // the tap and the reconnect would otherwise silently lose the human's decision
  // while the card still claims it is "queued … delivered automatically" — the
  // agent then hangs forever waiting for a tap the text says already happened.
  // `decision` is REQUIRED (not optional): the delivery path (formatAgentHookOutput)
  // needs a real 'allow'|'deny' to build the hook's reply, and parseQueuedDecision
  // already drops the whole queue rather than admit one with no valid decision — a
  // typed write surface that ALLOWED decision:undefined would let state onto disk
  // that the read side can never actually deliver (review finding).
  // `notifiedAt`: when the one-time "still waiting to reconnect" notice
  // (tg-ctl's noticeStaleQueuedDecisions, QUEUED_DECISION_NOTICE_MS) fired for
  // this queued tap — undefined until it does. Persisted so a restart between
  // the notice and the eventual reconnect doesn't re-fire it.
  queuedDecision?: { value: string; label: string; decision: PermissionDecision; at: number; notifiedAt?: number };
  // tg-cli#403: scheduling state for the critical-mode reminder cadence
  // (features/tg-ctl/hatch-critical-reminder.ts's planCriticalReminder/
  // markCriticalReminderSent) — only ever populated when `req.critical ===
  // true`. `lastReminderMessageId` is the daemon's own bookkeeping (which
  // Telegram message to delete/edit-away when the NEXT reminder posts, tg-cli#403
  // acceptance criterion (c)) — kept OUTSIDE the pure scheduler module's own
  // state shape because it's a Telegram artifact id, not a scheduling decision.
  // Shares its shape with hatch-critical-reminder.ts's exported DaemonCriticalState
  // (imported, not re-declared — review finding: two independently-maintained
  // copies of the same shape would silently drift the moment either is edited).
  criticalState?: DaemonCriticalState;
  // Written for a LIVE pending entry — its requester was still waiting on the socket, and
  // `at` is when the card was POSTED. The restore marks the moment it expired (the restart
  // itself) as the start of a hatch card's grace window, not the posting time (tg-cli#510).
  pending?: true;
}

export interface RetainedAnswerRecord {
  key: string; // callbackRequestId — NOT derivable from value/label, so stored
  value: string;
  label: string;
  decision?: PermissionDecision;
  at: number; // ms epoch when answered (replay-window age)
  // HOW the answer was delivered. `socket` → it went down the hook socket, so a
  // re-fire of the same question REPLAYS it (#98). `pane` → it was late-delivered by
  // injecting into the asking pane, so a reconnecting hook must NOT also replay it
  // (that would deliver twice). Legacy/missing defaults to `socket`.
  delivery: 'socket' | 'pane';
}

export interface QuestionStoreData {
  questions: RetainedQuestionRecord[];
  answered: RetainedAnswerRecord[];
}

const STORE_VERSION = 1;

// Far above any plausible concurrent-question count; bounds the on-disk file on a
// long-lived bot so a flood (or a never-tapped backlog) can't grow it without limit.
// On overflow the FRESHEST entries are kept (most likely to still be tapped). The cap
// is applied at BOTH serialize (so the persisted file is bounded the moment it is
// written, not only after the next restart's parse) and parse (defense in depth on
// read), to BOTH retained questions and the answered-replay cache. The in-memory maps
// the entrypoint holds are bounded by the age-prune it runs before every persist.
//
// Accepted divergence (memory vs disk): this cap bounds the FILE by count, but the
// in-memory maps are bounded only by AGE, not count. In the implausible case of >200
// questions live inside the retention window at once, all stay tappable in memory
// while the daemon runs, yet only the 200 freshest survive a restart (the rest expire
// post-restart). This is accepted because the realistic concurrent-question count on a
// single human's channel is tiny — far below 200; bounding the maps by count too would
// drop a still-deliverable entry from memory before its age window, for no real gain.
export const MAX_RETAINED_QUESTIONS = 200;

// Keep the freshest MAX_RETAINED_QUESTIONS records (newest `at` first). Shared by
// serialize (bound the file on write) and parse (bound on read).
function capByRecency<T extends { at: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => b.at - a.at).slice(0, MAX_RETAINED_QUESTIONS);
}

export function serializeQuestionStore(data: QuestionStoreData): string {
  return JSON.stringify({
    v: STORE_VERSION,
    questions: capByRecency(data.questions),
    answered: capByRecency(data.answered),
  });
}

// Parse + age-filter the on-disk state. The two record kinds get SEPARATE windows
// (`questionMaxAgeMs` for retained questions, `answerMaxAgeMs` for the replay cache)
// so an answered entry isn't restored past its real replay window. Anything
// malformed, an unknown format version, or a too-old entry is skipped — never
// thrown: a corrupt state file degrades to "no restored state", never wedges
// daemon startup.
export function parseQuestionStore(
  raw: string | null,
  now: number,
  questionMaxAgeMs: number,
  answerMaxAgeMs: number,
): QuestionStoreData {
  const empty: QuestionStoreData = { questions: [], answered: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const rec = parsed as Record<string, unknown>;
  // Forward-compat guard: only the version we wrote is understood. A future format
  // bump that this daemon can't read is ignored (no restored state) rather than
  // mis-parsed — the in-memory maps simply start empty.
  if (rec.v !== STORE_VERSION) return empty;
  return {
    questions: parseQuestions(rec.questions, now, questionMaxAgeMs),
    answered: parseAnswered(rec.answered, now, answerMaxAgeMs),
  };
}

function withinWindow(at: unknown, now: number, maxAgeMs: number): at is number {
  return typeof at === 'number' && Number.isFinite(at) && now - at <= maxAgeMs;
}

function parseQuestions(value: unknown, now: number, maxAgeMs: number): RetainedQuestionRecord[] {
  if (!Array.isArray(value)) return [];
  const out: RetainedQuestionRecord[] = [];
  for (const r of value) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (!rec.req || typeof rec.req !== 'object') continue;
    if (!withinWindow(rec.at, now, maxAgeMs)) continue;
    const messageId = typeof rec.messageId === 'number' ? rec.messageId : rec.messageId === null ? null : undefined;
    if (messageId === undefined) continue; // a number|null is required; anything else is corrupt
    const queuedDecision = parseQueuedDecision(rec.queuedDecision, now);
    const criticalState = parseCriticalState(rec.criticalState, now);
    out.push({
      req: rec.req as Record<string, unknown>,
      messageId,
      at: rec.at,
      ...(queuedDecision ? { queuedDecision } : {}),
      ...(criticalState ? { criticalState } : {}),
      ...(rec.pending === true ? { pending: true as const } : {}),
    });
  }
  // Newest first, capped: on overflow keep the freshest (most likely still tappable).
  return capByRecency(out);
}

// A malformed criticalState must never corrupt the whole retained-question record
// (the req/messageId/at/queuedDecision are still worth restoring) — drop just the
// scheduling state, same fail-soft posture as parseQueuedDecision. Every field is
// individually optional (a fresh critical entry has none of them yet), so this
// degrades field-by-field rather than all-or-nothing: a corrupt `lastReminderAt`
// alongside a valid `lastReminderMessageId` still restores the message id (worth
// keeping — it's what the next reminder needs to delete/replace) while simply
// resetting the reminder clock (worst case: one reminder fires sooner than the
// full interval after a restore, never a lost reminder).
function parseCriticalState(value: unknown, now: number): RetainedQuestionRecord['criticalState'] {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const lastReminderAt =
    typeof rec.lastReminderAt === 'number' && Number.isFinite(rec.lastReminderAt) && rec.lastReminderAt <= now
      ? rec.lastReminderAt
      : undefined;
  const lastReminderMessageId =
    typeof rec.lastReminderMessageId === 'number'
      ? rec.lastReminderMessageId
      : rec.lastReminderMessageId === null
        ? null
        : undefined;
  const lastReminderChatId =
    typeof rec.lastReminderChatId === 'number' && Number.isInteger(rec.lastReminderChatId) ? rec.lastReminderChatId : undefined;
  // A future-dated deferral is nonsensical (same reasoning as parseQueuedDecision's
  // `at > now` rejection) but, unlike that field, dropping it is harmless: the next
  // sweep's planCriticalReminder just re-derives a fresh deferral if it's still
  // quiet hours, or fires normally if not.
  const quietHoursDeferredUntil =
    typeof rec.quietHoursDeferredUntil === 'number' && Number.isFinite(rec.quietHoursDeferredUntil) && rec.quietHoursDeferredUntil > now
      ? rec.quietHoursDeferredUntil
      : undefined;
  if (lastReminderAt === undefined && lastReminderMessageId === undefined && quietHoursDeferredUntil === undefined) {
    return undefined;
  }
  return {
    ...(lastReminderAt !== undefined ? { lastReminderAt } : {}),
    ...(lastReminderMessageId !== undefined ? { lastReminderMessageId } : {}),
    ...(lastReminderChatId !== undefined ? { lastReminderChatId } : {}),
    ...(quietHoursDeferredUntil !== undefined ? { quietHoursDeferredUntil } : {}),
  };
}

// A malformed queuedDecision must never corrupt the whole retained-question record
// (the req/messageId/at are still worth restoring) — drop just the queue, same
// fail-soft posture as every other field here. `decision` is REQUIRED (not
// defaulted to undefined like the answered-record's optional `decision`): a
// queuedDecision only ever exists for a permission, and the reconnect delivery
// path (formatAgentHookOutput) needs a real 'allow'|'deny' to build the hook's
// {behavior} reply — a corrupt/legacy record with no valid decision must be
// dropped wholesale, not survive to be auto-delivered as a malformed or silently
// wrong permission reply.
function parseQueuedDecision(value: unknown, now: number): RetainedQuestionRecord['queuedDecision'] {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.value !== 'string' || typeof rec.label !== 'string') return undefined;
  if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return undefined;
  // A future-dated `at` would make `now - at` negative — always "within" any
  // delivery/retention window, so tg-ctl's demote/expire sweeps would treat a
  // corrupted future timestamp as permanently fresh. Reject it outright rather
  // than let a bad clock value defeat both TTLs (review finding).
  if (rec.at > now) return undefined;
  if (rec.decision !== 'allow' && rec.decision !== 'deny') return undefined;
  // For a permission, `value` IS `decision` — resolveButtonCallback always sets
  // them identically ('allow'/'allow' or 'deny'/'deny'). A record where they
  // DISAGREE (e.g. {value:'deny', decision:'allow'}) would deliver the hook one
  // decision while the card displays the other's label — drop it wholesale rather
  // than deliver a decision that contradicts what the human sees (review finding).
  if (rec.value !== rec.decision) return undefined;
  // `notifiedAt` is optional and best-effort: a malformed or future-dated value
  // just means the one-time notice may fire again (harmless — a duplicate notice
  // is not a lost decision), so it degrades to undefined rather than dropping the
  // whole queuedDecision the way a bad `at`/`decision` does.
  const notifiedAt =
    typeof rec.notifiedAt === 'number' && Number.isFinite(rec.notifiedAt) && rec.notifiedAt <= now
      ? rec.notifiedAt
      : undefined;
  return { value: rec.value, label: rec.label, decision: rec.decision, at: rec.at, ...(notifiedAt !== undefined ? { notifiedAt } : {}) };
}

function parseAnswered(value: unknown, now: number, maxAgeMs: number): RetainedAnswerRecord[] {
  if (!Array.isArray(value)) return [];
  const out: RetainedAnswerRecord[] = [];
  for (const r of value) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.key !== 'string' || !rec.key) continue;
    if (typeof rec.value !== 'string' || typeof rec.label !== 'string') continue;
    if (!withinWindow(rec.at, now, maxAgeMs)) continue;
    const decision = rec.decision === 'allow' || rec.decision === 'deny' ? rec.decision : undefined;
    const delivery = rec.delivery === 'pane' ? 'pane' : 'socket';
    out.push({ key: rec.key, value: rec.value, label: rec.label, decision, at: rec.at, delivery });
  }
  // Same recency cap as questions: a burst of answers inside the replay window can't
  // grow the file (or the in-memory map) without limit.
  return capByRecency(out);
}
