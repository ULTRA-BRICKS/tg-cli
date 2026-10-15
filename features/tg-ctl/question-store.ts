// PURE (de)serialization for the daemon's durable forwarded-question state
// (CtlPaths.questions). The tg-ctl entrypoint owns the file I/O (atomic write +
// readFileOrNull) and the AUTHORITATIVE request normalization
// (normalizeButtonRequest); this module owns only the on-disk FORMAT — the
// versioned envelope, answered-record validation, age pruning and the answered-cache cap. `req` is
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

// One retained question: a LIVE pending OR a socket-closed (abandoned) one — both
// are equivalent on disk, a SCOPED question whose chosen answer can still reach its
// pane. The entrypoint normalizes `req` via normalizeButtonRequest and re-keys by
// callbackRequestId.
export interface RetainedQuestionRecord {
  req: Record<string, unknown>; // a scoped question ButtonRequest (entrypoint re-validates)
  messageId: number | null; // the Telegram card id (edit/answer target)
  at: number; // ms epoch when posted/abandoned (overflow ordering; the Inbox copy's age)
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

// The answered-replay cache holds CLOSED records only, so it is bounded by count: a burst of
// answers inside the replay window can't grow the file without limit. On overflow the FRESHEST
// are kept (the likeliest to be replayed). Applied at BOTH serialize (the file is bounded the
// moment it is written) and parse (defense in depth on read).
//
// The `questions` array is NEVER count-capped: every record there is an OPEN card (live pending
// or abandoned), which closes only on a relevance signal, never by age or count (tg-cli#705). A
// cap evicted the oldest open cards on every restart — their Inbox copies vanished and a tap
// said "expired" with no visible close reason (tg-cli#707). The open set is bounded by the cards
// actually posted and not yet closed.
export const MAX_ANSWERED_RECORDS = 200;

export function serializeQuestionStore(data: QuestionStoreData): string {
  return JSON.stringify({
    v: STORE_VERSION,
    questions: [...data.questions].sort((a, b) => b.at - a.at),
    answered: [...data.answered].sort((a, b) => b.at - a.at).slice(0, MAX_ANSWERED_RECORDS),
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
    // A `criticalState` field written before tg-cli#705 (the removed reminder cadence) is
    // ignored here; the daemon's startup migration reads it raw to retire its last reminder.
    const queuedDecision = parseQueuedDecision(rec.queuedDecision, now);
    out.push({
      req: rec.req as Record<string, unknown>,
      messageId,
      at: rec.at,
      ...(queuedDecision ? { queuedDecision } : {}),
      ...(rec.pending === true ? { pending: true as const } : {}),
    });
  }
  // Newest first, every one kept: an open card is never dropped for count (tg-cli#707).
  return out.sort((a, b) => b.at - a.at);
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
  // Closed records only, so capped (see MAX_ANSWERED_RECORDS); the freshest are kept.
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_ANSWERED_RECORDS);
}
