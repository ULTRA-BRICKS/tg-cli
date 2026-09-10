// Active-silence nudge for agent sessions the daemon can reach live over ACP
// (features/tg-ctl/omp.ts's live omp discovery) — Alex's repeated ask: agents
// keep forgetting tg-cli exists mid-session because the `tg` skill's own
// triggers (finish a task, hit a question/blocker) only fire at a natural
// decision point. A long, heads-down working stretch never produces one, so
// passive skill discovery alone cannot close that gap — this is the ACTIVE
// side: the daemon reminds a session that has gone AWARENESS_NUDGE_THRESHOLD_MS
// with zero outbound `tg` traffic while it is still alive.
//
// PURE — the entrypoint supplies which agent keys are currently live, the
// shared history.jsonl records (both `tg`'s outbound writer and tg-ctl's own
// inbound writer append to it) to derive each key's last-outbound-tg-send
// time, and the persisted per-key nudge state; this module decides who is due
// and returns the updated state to persist. Dead keys (no longer live) are
// dropped from the returned store automatically — bounded growth, no separate
// prune pass needed.
//
// One nudge per silence EPISODE, never a repeat storm: a key becomes eligible
// again only once its `lastTgSentAt` actually advances (a real tg send) and
// then another full threshold of silence passes. Nudging on every sweep while
// an agent is simply quiet (working, tg-cli fully out of mind) would be the
// opposite of the "short nudge, not a lecture" contract.
//
// Population: `listLiveOmpAgents()` only. A tmux-only Claude/Codex pane has no
// equivalent live-control channel the daemon can message into out of band —
// tg-ctl can only inject text a human would otherwise have typed, which is
// not "a passive reminder" in the same sense. Extending this to non-omp panes
// is a real follow-up, not silently promised here.

import type { HistoryRecord } from '../replies/history';

export const AWARENESS_NUDGE_THRESHOLD_MS = 60 * 60 * 1000;

// Keep this SHORT — a nudge, not a lecture (filing ticket's contract).
export const AWARENESS_NUDGE_TEXT =
  "🔔 tg reminder: you've been active for over an hour with no Telegram update. " +
  'Use `tg` for a status report, a blocker, or a question that needs a human ' +
  "decision — it's async visibility without anyone polling the chat. Forgot " +
  'the usage? Run `tg --help`.';

export interface AwarenessNudgeAgentState {
  // ms epoch — when the daemon first observed this key live. Persisted so a
  // restart doesn't lose a long-running session's silence clock.
  firstSeenAt: number;
  // ms epoch of the most recent outbound tg send seen for this key, or null
  // if none has ever been observed.
  lastTgSentAt: number | null;
  // ms epoch of the most recent nudge sent for this key.
  lastNudgedAt?: number;
  // The `lastTgSentAt` value in effect at that nudge — the anti-spam key: a
  // key is due again only once the OBSERVED lastTgSentAt differs from this.
  lastNudgedForTgSentAt?: number | null;
  // The live agent's session identity the last time this key was observed.
  // A KEY (a tmux pane id, or in principle a reused pid) can survive an
  // agent being replaced in place — e.g. Ctrl-C, then a new omp session
  // started in the same tmux pane — while omp/claude-rotate assigns the new
  // process a fresh sessionId. When the currently-observed sessionId for a
  // key differs from the one recorded here, this state belongs to a
  // DIFFERENT session and must not be inherited: a stale nudge marker would
  // silently suppress the new session's own first nudge, and a stale
  // silence clock would nudge it immediately for time it was never actually
  // silent (review finding). `null`/`undefined` means "unknown" (no live
  // session jsonl yet) — carried forward as before since there is no signal
  // to compare against in that window.
  sessionId?: string | null;
}

export type AwarenessNudgeStore = Record<string, AwarenessNudgeAgentState>;

const STORE_VERSION = 1;

function isValidState(v: unknown): v is AwarenessNudgeAgentState {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.firstSeenAt !== 'number' || !Number.isFinite(r.firstSeenAt)) return false;
  if (r.lastTgSentAt !== null && typeof r.lastTgSentAt !== 'number') return false;
  if (r.lastNudgedAt !== undefined && typeof r.lastNudgedAt !== 'number') return false;
  if (r.lastNudgedForTgSentAt !== undefined && r.lastNudgedForTgSentAt !== null && typeof r.lastNudgedForTgSentAt !== 'number') {
    return false;
  }
  if (r.sessionId !== undefined && r.sessionId !== null && typeof r.sessionId !== 'string') return false;
  return true;
}

export function serializeAwarenessNudgeStore(store: AwarenessNudgeStore): string {
  return JSON.stringify({ version: STORE_VERSION, agents: store });
}

// Parse the on-disk blob → a live store. Never throws: malformed/legacy/absent
// content yields an empty store (equivalent to "never seen any of these keys
// before" — the safe default; worst case is one skipped nudge episode, never
// a spurious one).
export function parseAwarenessNudgeStore(blob: string | null): AwarenessNudgeStore {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob);
    const agents = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).agents : null;
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return {};
    const out: AwarenessNudgeStore = {};
    for (const [key, value] of Object.entries(agents as Record<string, unknown>)) {
      if (isValidState(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export interface AwarenessNudgePlan {
  // Next store to persist — contains ONLY still-live keys. Silence-clock
  // fields (firstSeenAt/lastTgSentAt/sessionId) are updated; `lastNudgedAt`/
  // `lastNudgedForTgSentAt` are carried forward UNCHANGED — this function
  // only decides who is due, it never marks a key as nudged (that would
  // record delivery before the send is even attempted). Call
  // `markAwarenessNudgeSent` after a `due` key's send actually succeeds.
  store: AwarenessNudgeStore;
  // Keys the caller must nudge THIS sweep.
  due: string[];
  // True iff the live key SET actually differs from `store`'s previous key
  // set (a key was added or dropped) — a real set comparison, not a length
  // check (two different keys can coincidentally leave the count unchanged
  // on simultaneous churn — review finding). Tells the caller whether the
  // baseline sweep result is worth persisting on its own, independent of
  // whether any nudge fired this sweep.
  keysChanged: boolean;
}

function keySetsDiffer(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return true;
  const setA = new Set(a);
  for (const k of b) if (!setA.has(k)) return true;
  return false;
}

// `lastTgSentAtByKey` — this sweep's freshly observed last-send time per live
// key (see the function of the same purpose below). A fresh observation
// always wins over a persisted one: history is the authoritative signal, the
// persisted value only carries a PRIOR observation forward across restarts
// when this sweep's scan found nothing newer to report (e.g. the log was
// trimmed).
export function planAwarenessNudges(
  liveKeys: readonly string[],
  lastTgSentAtByKey: ReadonlyMap<string, number>,
  store: AwarenessNudgeStore,
  now: number,
  sessionIdByKey: ReadonlyMap<string, string | null> = new Map(),
  thresholdMs: number = AWARENESS_NUDGE_THRESHOLD_MS,
): AwarenessNudgePlan {
  const next: AwarenessNudgeStore = {};
  const due: string[] = [];
  for (const key of liveKeys) {
    const observedSessionId = sessionIdByKey.get(key) ?? null;
    const storedEntry = store[key];
    // A replacement session in the same key (see the `sessionId` field doc
    // above) must not inherit the old session's clock/markers.
    const identityChanged =
      typeof storedEntry?.sessionId === 'string' &&
      typeof observedSessionId === 'string' &&
      storedEntry.sessionId !== observedSessionId;
    const prior = identityChanged ? undefined : storedEntry;
    const firstSeenAt = prior?.firstSeenAt ?? now;
    const observed = lastTgSentAtByKey.get(key);
    const lastTgSentAt = observed ?? prior?.lastTgSentAt ?? null;
    // A session's silence clock can never rationally start before the
    // daemon first observed it live. Without this clamp, a stale `tg` send
    // record under a reused key (a different session's old message, still
    // the newest history row for this pane/pid) would make a just-started
    // session look like it has been silently sitting on an old message for
    // hours, firing an immediate spurious nudge (review finding).
    const silenceStart = Math.max(firstSeenAt, lastTgSentAt ?? firstSeenAt);
    const silentMs = now - silenceStart;
    const lastNudgedAt = prior?.lastNudgedAt;
    const lastNudgedForTgSentAt = prior?.lastNudgedForTgSentAt;
    const alreadyNudgedThisEpisode = lastNudgedAt !== undefined && (lastNudgedForTgSentAt ?? null) === lastTgSentAt;
    if (silentMs >= thresholdMs && !alreadyNudgedThisEpisode) due.push(key);
    next[key] = { firstSeenAt, lastTgSentAt, lastNudgedAt, lastNudgedForTgSentAt, sessionId: observedSessionId };
  }
  return { store: next, due, keysChanged: keySetsDiffer(liveKeys, Object.keys(store)) };
}

// Commits the "nudged" markers for keys whose delivery actually SUCCEEDED —
// called AFTER the send attempt, never before (the bug this splits away
// from: marking a key nudged inside `planAwarenessNudges`, before the send
// even runs, means a failed/dropped delivery permanently forecloses the rest
// of that silence episode, since `alreadyNudgedThisEpisode` would already be
// true with no future send to flip it — exactly the busy/loaded-agent
// population this feature targets). A key missing from `store` (already
// dropped as no-longer-live between planning and send) is skipped, not
// resurrected.
export function markAwarenessNudgeSent(
  store: AwarenessNudgeStore,
  sentKeys: readonly string[],
  now: number,
): AwarenessNudgeStore {
  if (sentKeys.length === 0) return store;
  const next = { ...store };
  for (const key of sentKeys) {
    const prior = next[key];
    if (!prior) continue;
    next[key] = { ...prior, lastNudgedAt: now, lastNudgedForTgSentAt: prior.lastTgSentAt };
  }
  return next;
}

// Most recent OUTBOUND (`agent`-direction) tg-send timestamp per origin key,
// from the shared history log both `tg` (outbound) and tg-ctl (inbound) write
// to (features/replies/history.ts). ms epoch — HistoryRecord.ts is unix
// SECONDS. Only agent-direction rows are evidence the AGENT used tg; an
// inbound (`user`) row is Alex's own reply, not the agent's activity.
export function lastTgSentAtByKey(records: readonly HistoryRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const rec of records) {
    if (rec.direction !== 'agent' || !rec.pane) continue;
    const ms = rec.ts * 1000;
    const existing = out.get(rec.pane);
    if (existing === undefined || ms > existing) out.set(rec.pane, ms);
  }
  return out;
}
