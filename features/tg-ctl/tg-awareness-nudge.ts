// Active-silence nudge for agent sessions the daemon can reach live over ACP
// (features/tg-ctl/omp.ts's live omp discovery) — Alex's repeated ask: agents
// keep forgetting tg-cli exists mid-session because the `tg` skill's own
// triggers (finish a task, hit a question/blocker) only fire at a natural
// decision point. A long, heads-down working stretch never produces one, so
// passive skill discovery alone cannot close that gap — this is the ACTIVE
// side: the daemon reminds a session that has worked for
// AWARENESS_NUDGE_THRESHOLD_MS with zero outbound `tg` traffic.
//
// WORKING, not merely alive (tg-cli#789). The reminder used to fire at every
// live session silent for an hour, idle ones included: the nudge woke the idle
// session, it answered with a `tg` status, that restarted its silence clock, and
// an hour later it was nudged again — an hourly loop on a session doing nothing.
// A session is now eligible only while `classifyActivity` says it is WORKING
// (a turn is running, or background jobs / subagents are running); idle,
// waiting-for-the-user and unknown sessions are never nudged, and every sweep
// that sees one of them resets its silence clock, so a session that sat idle
// for three hours and then starts a task is not nudged at once.
//
// PURE — the entrypoint supplies, per live agent key, a `LiveAgentObservation`
// (session identity, last `tg` send time from the shared history.jsonl, and the
// live activity facts) plus the persisted per-key state; this module decides who
// is due, records WHY each key was or was not nudged (`decision`, shown by
// `tg-ctl status --verbose`) and returns the updated state to persist.
//
// One nudge per silence EPISODE, never a repeat storm. An episode is one
// continuous working stretch (`activeSince`) without a `tg` send; a key becomes
// eligible again only after a real `tg` send (lastTgSentAt advances) or a new
// stretch (the session went idle in between), and then another full threshold
// of working silence. A key that vanishes from the live list keeps its state for
// AWARENESS_MISSING_GRACE_MS: a single failed probe must not wipe its nudge
// marker (the other half of the old hourly repeat).
//
// Population: `listLiveOmpAgents()` only. A tmux-only Claude/Codex pane has no
// equivalent live-control channel the daemon can message into out of band —
// tg-ctl can only inject text a human would otherwise have typed, which is
// not "a passive reminder" in the same sense. Extending this to non-omp panes
// is a real follow-up (tg-cli#792), not silently promised here.

import type { HistoryRecord } from '../replies/history';

export const AWARENESS_NUDGE_THRESHOLD_MS = 60 * 60 * 1000;

// A key absent from the live list keeps its state this long before it is
// dropped (a probe timeout or a pane reshuffle is not the session finishing),
// and a key that comes back within it continues its working stretch and keeps
// its nudge marker. Past it — or after a daemon outage that long — the stretch
// restarts: the gap is never credited as work.
export const AWARENESS_MISSING_GRACE_MS = 10 * 60 * 1000;
// A turn that claims to be running but wrote nothing to the session or subagent
// transcripts for this long (with no subagents running) is blocked on the human
// — a tool-approval prompt, a hatch card, an `ask` an older bridge cannot see —
// or on one very long tool call: either way not nudged.
export const AWARENESS_STALLED_BUSY_MS = 30 * 60 * 1000;
// A host that cannot report subagents (an older bridge) is treated as working
// while a transcript (its own or a subagent's) was written this recently.
export const AWARENESS_FRESH_TRANSCRIPT_MS = 2 * 60 * 1000;

function minutes(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 60_000))} min`;
}

// Keep this SHORT — a nudge, not a lecture (filing ticket's contract).
export const AWARENESS_NUDGE_TEXT =
  "🔔 tg reminder: you've been active for over an hour with no Telegram update. " +
  'Use `tg` for a status report, a blocker, or a question that needs a human ' +
  "decision — it's async visibility without anyone polling the chat. Forgot " +
  'the usage? Run `tg --help`.';

// Live facts about one agent, all observed this sweep. `null` = the host did
// not say (an older bridge, a probe that gave nothing) — never read as "no".
export interface AgentActivityFacts {
  // A turn is running (omp `!ctx.isIdle()`); a timed-out status probe reads as true.
  busy: boolean | null;
  // Running task subagents (omp `getAsyncJobSnapshot().running` of type task); other
  // background jobs do not count — they outlive the agent's own work.
  subagents: number | null;
  // An `ask` tool call is waiting for the human.
  awaitingUser: boolean | null;
  // ms epoch of the newest write to the session transcript or a subagent
  // transcript, when readable.
  lastActivityAt: number | null;
}

const ACTIVITY_STATES = ['working', 'idle', 'waiting-for-user', 'unknown'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export interface ActivityVerdict {
  state: ActivityState;
  // Stable text: a decision is persisted only when it changes, so the reason holds
  // no ages or timers — only the subagent count, whose change is worth a write.
  reason: string;
}

export function classifyActivity(f: AgentActivityFacts, now: number): ActivityVerdict {
  if (f.awaitingUser === true) return { state: 'waiting-for-user', reason: 'an ask is waiting for the human' };
  if (f.subagents !== null && f.subagents > 0) {
    return { state: 'working', reason: `${f.subagents} subagent(s) running` };
  }
  if (f.busy === null) return { state: 'unknown', reason: 'the host did not report whether a turn is running' };
  const transcriptAge = f.lastActivityAt === null ? null : now - f.lastActivityAt;
  if (!f.busy) {
    if (f.subagents === null && transcriptAge !== null && transcriptAge <= AWARENESS_FRESH_TRANSCRIPT_MS) {
      return { state: 'working', reason: `a transcript was written within ${minutes(AWARENESS_FRESH_TRANSCRIPT_MS)} (this host cannot report subagents)` };
    }
    return { state: 'idle', reason: 'no turn running, no subagents' };
  }
  if (transcriptAge !== null && transcriptAge > AWARENESS_STALLED_BUSY_MS) {
    return { state: 'waiting-for-user', reason: `turn running but nothing written for over ${minutes(AWARENESS_STALLED_BUSY_MS)} (blocked on the human?)` };
  }
  return { state: 'working', reason: 'a turn is running' };
}

const OUTCOMES = ['not-working', 'below-threshold', 'already-nudged', 'due'] as const;
export type NudgeOutcome = (typeof OUTCOMES)[number];

// Why this key was (not) nudged — persisted so `tg-ctl status --verbose`, a
// separate process, can show it.
export interface NudgeDecision {
  state: ActivityState;
  reason: string;
  outcome: NudgeOutcome;
}

export interface AwarenessNudgeAgentState {
  // ms epoch of the most recent outbound tg send seen for this key, or null
  // if none has ever been observed.
  lastTgSentAt: number | null;
  // ms epoch of the most recent nudge sent for this key.
  lastNudgedAt?: number;
  // The `lastTgSentAt` value in effect at that nudge — the anti-spam key: a
  // key is due again only once the OBSERVED lastTgSentAt differs from this
  // (or a new working stretch began, which clears both fields).
  lastNudgedForTgSentAt?: number | null;
  // The live agent's session identity the last time this key was observed.
  // A KEY (a tmux pane id, or in principle a reused pid) can survive an
  // agent being replaced in place — e.g. Ctrl-C, then a new omp session
  // started in the same tmux pane — while the harness assigns the new
  // process a fresh sessionId. When the currently-observed sessionId for a
  // key differs from the one recorded here, this state belongs to a
  // DIFFERENT session and must not be inherited: a stale nudge marker would
  // silently suppress the new session's own first nudge, and a stale
  // silence clock would nudge it immediately for time it was never actually
  // silent (review finding). `null`/`undefined` means "unknown" (no live
  // session jsonl yet) — carried forward as before since there is no signal
  // to compare against in that window.
  sessionId?: string | null;
  // Start of the current continuous WORKING stretch; absent while the session
  // is not working. The silence clock runs from here (or the last tg send).
  activeSince?: number;
  // The last sweep that saw this key live (in memory every sweep; persisted
  // with the next state write).
  lastObservedAt?: number;
  // First sweep this key was absent from the live list; the state is dropped
  // AWARENESS_MISSING_GRACE_MS later.
  missingSince?: number;
  decision?: NudgeDecision;
}

export type AwarenessNudgeStore = Record<string, AwarenessNudgeAgentState>;

const STORE_VERSION = 1;


function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidDecision(v: unknown): v is NudgeDecision {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    ACTIVITY_STATES.includes(r.state as ActivityState) &&
    typeof r.reason === 'string' &&
    OUTCOMES.includes(r.outcome as NudgeOutcome)
  );
}

function isValidState(v: unknown): v is AwarenessNudgeAgentState {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.lastTgSentAt !== null && typeof r.lastTgSentAt !== 'number') return false;
  if (r.lastNudgedAt !== undefined && typeof r.lastNudgedAt !== 'number') return false;
  if (r.lastNudgedForTgSentAt !== undefined && r.lastNudgedForTgSentAt !== null && typeof r.lastNudgedForTgSentAt !== 'number') {
    return false;
  }
  if (r.sessionId !== undefined && r.sessionId !== null && typeof r.sessionId !== 'string') return false;
  for (const f of ['activeSince', 'lastObservedAt', 'missingSince'] as const) {
    if (r[f] !== undefined && !isFiniteNumber(r[f])) return false;
  }
  if (r.decision !== undefined && !isValidDecision(r.decision)) return false;
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

// One live agent as seen this sweep.
export interface LiveAgentObservation {
  key: string;
  // The harness session id when known (guards a key reused by a new session).
  sessionId: string | null;
  // Freshly observed last outbound tg send for this key (see lastTgSentAtByKey).
  // A fresh observation always wins over a persisted one: history is the
  // authoritative signal, the persisted value only carries a PRIOR observation
  // forward across restarts when this sweep's scan found nothing newer.
  lastTgSentAt: number | undefined;
  activity: AgentActivityFacts;
}

export interface AwarenessNudgePlan {
  // Next store to persist. Silence-clock fields are updated; `lastNudgedAt` /
  // `lastNudgedForTgSentAt` are carried forward UNCHANGED while a stretch
  // lasts — this function only decides who is due, it never marks a key as
  // nudged (that would record delivery before the send is even attempted).
  // Call `markAwarenessNudgeSent` after a `due` key's send actually succeeds.
  store: AwarenessNudgeStore;
  // Keys the caller must nudge THIS sweep.
  due: string[];
  // True iff the next store differs from the previous one in anything worth a
  // disk write — a key added/dropped/marked missing, or a changed activity
  // verdict or outcome — ignoring the per-sweep `lastObservedAt` heartbeat.
  changed: boolean;
}

function comparable(store: AwarenessNudgeStore): string {
  const keys = Object.keys(store).sort();
  return JSON.stringify(
    keys.map((k) => {
      const { lastObservedAt: _heartbeat, ...rest } = store[k];
      return [k, rest];
    }),
  );
}

function decideOutcome(working: boolean, alreadyNudged: boolean, silentMs: number, thresholdMs: number): NudgeOutcome {
  if (!working) return 'not-working';
  if (alreadyNudged) return 'already-nudged';
  return silentMs >= thresholdMs ? 'due' : 'below-threshold';
}

export function planAwarenessNudges(
  live: readonly LiveAgentObservation[],
  store: AwarenessNudgeStore,
  now: number,
  thresholdMs: number = AWARENESS_NUDGE_THRESHOLD_MS,
): AwarenessNudgePlan {
  const next: AwarenessNudgeStore = {};
  const due: string[] = [];
  const liveKeys = new Set<string>();
  for (const obs of live) {
    liveKeys.add(obs.key);
    const storedEntry = store[obs.key];
    // A replacement session in the same key (see the `sessionId` field doc
    // above) must not inherit the old session's clock/markers.
    const identityChanged =
      typeof storedEntry?.sessionId === 'string' &&
      typeof obs.sessionId === 'string' &&
      storedEntry.sessionId !== obs.sessionId;
    const prior = identityChanged ? undefined : storedEntry;
    const verdict = classifyActivity(obs.activity, now);
    const working = verdict.state === 'working';
    const lastTgSentAt = obs.lastTgSentAt ?? prior?.lastTgSentAt ?? null;

    // The working stretch continues only while the session keeps working AND the
    // sweeps were contiguous. Anything else starts a new episode: the clock restarts
    // and the previous episode's nudge marker no longer applies.
    const carried =
      working &&
      prior?.activeSince !== undefined &&
      prior.lastObservedAt !== undefined &&
      now - prior.lastObservedAt <= AWARENESS_MISSING_GRACE_MS
        ? prior
        : undefined;
    const activeSince = working ? (carried?.activeSince ?? now) : undefined;
    const lastNudgedAt = carried?.lastNudgedAt;
    const lastNudgedForTgSentAt = carried?.lastNudgedForTgSentAt;

    // The clock starts at the later of the stretch start and the last tg send:
    // an old send under a reused key can never backdate a just-started stretch.
    const silentMs = activeSince === undefined ? 0 : now - Math.max(activeSince, lastTgSentAt ?? activeSince);
    const alreadyNudged = lastNudgedAt !== undefined && (lastNudgedForTgSentAt ?? null) === lastTgSentAt;
    const outcome = decideOutcome(working, alreadyNudged, silentMs, thresholdMs);
    if (outcome === 'due') due.push(obs.key);

    next[obs.key] = {
      lastTgSentAt,
      lastNudgedAt,
      lastNudgedForTgSentAt,
      sessionId: obs.sessionId,
      activeSince,
      lastObservedAt: now,
      decision: { state: verdict.state, reason: verdict.reason, outcome },
    };
  }
  // Keys that are not live this sweep: keep them for the grace period.
  for (const [key, entry] of Object.entries(store)) {
    if (liveKeys.has(key)) continue;
    const missingSince = entry.missingSince ?? now;
    if (now - missingSince > AWARENESS_MISSING_GRACE_MS) continue;
    next[key] = { ...entry, missingSince };
  }
  // Field order differs between a parsed store and a built one, so the first sweep after a
  // load can report `changed` once; the compare is by content, never a cause of repeat writes.
  return { store: next, due, changed: comparable(next) !== comparable(store) };
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
    next[key] = {
      ...prior,
      lastNudgedAt: now,
      lastNudgedForTgSentAt: prior.lastTgSentAt,
      ...(prior.decision && { decision: { ...prior.decision, outcome: 'already-nudged' as const } }),
    };
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

const OUTCOME_TEXT: Record<NudgeOutcome, string> = {
  'not-working': 'not nudged: not working (silence clock reset)',
  'below-threshold': 'not nudged yet: under the threshold',
  'already-nudged': 'nudged already this episode',
  due: 'nudge due',
};

// The `tg-ctl status --verbose` block: one line per remembered agent saying why
// it was or was not nudged. `labels` names the keys the daemon can see live;
// `statusNow` is the time the status runs (silence is derived from it, so the
// persisted decision need not change every minute).
export function renderAwarenessStatus(
  store: AwarenessNudgeStore,
  statusNow: number,
  labels: ReadonlyMap<string, string>,
  thresholdMs: number = AWARENESS_NUDGE_THRESHOLD_MS,
): string[] {
  const keys = Object.keys(store).sort();
  const lines = [
    `awareness nudge: after ${minutes(thresholdMs)} of continuous work with no tg send; idle and waiting sessions are never nudged`,
  ];
  if (keys.length === 0) {
    lines.push('  (no agents remembered)');
    return lines;
  }
  for (const key of keys) {
    const e = store[key];
    const name = labels.get(key) ?? key;
    if (e.missingSince !== undefined) {
      lines.push(`  ${name}: gone ${minutes(statusNow - e.missingSince)} ago — state kept for ${minutes(AWARENESS_MISSING_GRACE_MS)}`);
      continue;
    }
    const d = e.decision;
    if (!d) {
      lines.push(`  ${name}: no sweep has judged it yet`);
      continue;
    }
    const silent =
      d.state === 'working' && e.activeSince !== undefined
        ? `, silent ${minutes(statusNow - Math.max(e.activeSince, e.lastTgSentAt ?? e.activeSince))}`
        : '';
    const nudged = e.lastNudgedAt !== undefined ? `; last nudge ${minutes(statusNow - e.lastNudgedAt)} ago` : '';
    lines.push(`  ${name}: ${d.state}${silent} — ${OUTCOME_TEXT[d.outcome]} (${d.reason})${nudged}`);
  }
  return lines;
}
