import { expect, test } from 'bun:test';
import {
  AWARENESS_MISSING_GRACE_MS,
  AWARENESS_NUDGE_THRESHOLD_MS,
  AWARENESS_STALLED_BUSY_MS,
  classifyActivity,
  lastTgSentAtByKey,
  markAwarenessNudgeSent,
  parseAwarenessNudgeStore,
  planAwarenessNudges,
  renderAwarenessStatus,
  serializeAwarenessNudgeStore,
  type AgentActivityFacts,
  type AwarenessNudgeStore,
  type LiveAgentObservation,
} from '../features/tg-ctl/tg-awareness-nudge';
import type { HistoryRecord } from '../features/replies/history';

const NOW = 1_720_000_000_000; // ms epoch, arbitrary fixed instant
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// A modern bridge reporting everything: a turn running, nothing else.
const WORKING: AgentActivityFacts = { busy: true, subagents: 0, awaitingUser: false, lastActivityAt: null };
const IDLE: AgentActivityFacts = { busy: false, subagents: 0, awaitingUser: false, lastActivityAt: null };

function obs(key: string, activity: AgentActivityFacts, over: Partial<LiveAgentObservation> = {}): LiveAgentObservation {
  return { key, sessionId: null, lastTgSentAt: undefined, activity, ...over };
}

// Drives sweeps on a fake clock: every `sweep` runs the planner at the current
// time with the given facts, persists the plan like the daemon does, and — like
// the daemon — marks due keys as nudged (a send that always succeeds).
function harness(initial: AwarenessNudgeStore = {}) {
  let store = initial;
  let now = NOW;
  const nudges: string[] = [];
  return {
    advance(ms: number) {
      now += ms;
    },
    sweep(live: LiveAgentObservation[]) {
      const plan = planAwarenessNudges(live, store, now);
      store = plan.store;
      for (const key of plan.due) nudges.push(key);
      store = markAwarenessNudgeSent(store, plan.due, now);
      return plan;
    },
    // Sweeps every 30 s for `ms`, with the same facts each time.
    run(ms: number, live: LiveAgentObservation[]) {
      for (let t = 0; t < ms; t += 30_000) {
        this.sweep(live);
        this.advance(30_000);
      }
    },
    get store() {
      return store;
    },
    nudges,
  };
}

// --- classifyActivity ---

test('classify: no turn and no jobs is idle', () => {
  expect(classifyActivity(IDLE, NOW).state).toBe('idle');
});

test('classify: a running turn is working', () => {
  expect(classifyActivity(WORKING, NOW).state).toBe('working');
});

test('classify: running subagents make an idle-turn session working', () => {
  const v = classifyActivity({ ...IDLE, subagents: 3 }, NOW);
  expect(v.state).toBe('working');
  expect(v.reason).toContain('3 subagent');
});

test('classify: a pending ask is waiting-for-user even though a turn is running', () => {
  expect(classifyActivity({ ...WORKING, awaitingUser: true }, NOW).state).toBe('waiting-for-user');
});

test('classify: an older bridge that cannot report jobs counts a fresh transcript write as working', () => {
  const old: AgentActivityFacts = { busy: false, subagents: null, awaitingUser: null, lastActivityAt: NOW - 30_000 };
  expect(classifyActivity(old, NOW).state).toBe('working');
  expect(classifyActivity({ ...old, lastActivityAt: NOW - 10 * MIN }, NOW).state).toBe('idle');
});

test('classify: a busy turn with no transcript write for 30+ min and no subagents is blocked on the human (approval prompt, hatch card), not working', () => {
  const stale = NOW - AWARENESS_STALLED_BUSY_MS - MIN;
  expect(classifyActivity({ busy: true, subagents: null, awaitingUser: null, lastActivityAt: stale }, NOW).state).toBe('waiting-for-user');
  expect(classifyActivity({ busy: true, subagents: 0, awaitingUser: false, lastActivityAt: stale }, NOW).state).toBe('waiting-for-user');
  expect(classifyActivity({ busy: true, subagents: 0, awaitingUser: false, lastActivityAt: NOW - 5 * MIN }, NOW).state).toBe('working');
});

test('classify: a quiet transcript does not make a session with running subagents wait', () => {
  expect(classifyActivity({ busy: true, subagents: 2, awaitingUser: false, lastActivityAt: NOW - 3 * HOUR }, NOW).state).toBe('working');
});

test('classify: a host that did not say whether a turn runs is unknown, never nudged', () => {
  expect(classifyActivity({ busy: null, subagents: null, awaitingUser: null, lastActivityAt: null }, NOW).state).toBe('unknown');
});

// --- the three acceptance scenarios (fake clock) ---

test('an idle session is never nudged, however long it stays silent', () => {
  const h = harness();
  h.run(6 * HOUR, [obs('omp:idle', IDLE)]);
  expect(h.nudges).toEqual([]);
  expect(h.store['omp:idle'].decision?.outcome).toBe('not-working');
});

test('a busy session with running subagents is nudged exactly once after the threshold', () => {
  const h = harness();
  const live = [obs('omp:orchestrator', { busy: false, subagents: 2, awaitingUser: false, lastActivityAt: null })];
  h.run(AWARENESS_NUDGE_THRESHOLD_MS - MIN, live);
  expect(h.nudges).toEqual([]);
  h.run(5 * HOUR, live);
  expect(h.nudges).toEqual(['omp:orchestrator']);
});

test('a finished session (gone from the live list) is dropped after the grace period', () => {
  const h = harness();
  h.run(2 * MIN, [obs('omp:done', WORKING)]);
  expect(Object.keys(h.store)).toEqual(['omp:done']);
  h.advance(AWARENESS_MISSING_GRACE_MS / 2);
  h.sweep([]);
  expect(Object.keys(h.store)).toEqual(['omp:done']); // grace: one failed probe must not wipe it
  h.advance(AWARENESS_MISSING_GRACE_MS + MIN);
  h.sweep([]);
  expect(h.store).toEqual({});
  expect(h.nudges).toEqual([]);
});

// --- the clock ---

test('a session idle for 3 hours that then starts a task is not nudged immediately', () => {
  const h = harness();
  h.run(3 * HOUR, [obs('omp:s', IDLE)]);
  h.run(5 * MIN, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual([]);
  expect(h.store['omp:s'].decision?.outcome).toBe('below-threshold');
  // ...and is nudged once a full hour of WORK has passed.
  h.run(HOUR, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
});

test('going idle between two working stretches resets the clock: 40 + 40 working minutes never nudge', () => {
  const h = harness();
  h.run(40 * MIN, [obs('omp:s', WORKING)]);
  h.run(10 * MIN, [obs('omp:s', IDLE)]);
  h.run(40 * MIN, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual([]);
});

test('waiting for the human resets the clock the same way idle does', () => {
  const h = harness();
  h.run(50 * MIN, [obs('omp:s', WORKING)]);
  h.run(20 * MIN, [obs('omp:s', { ...WORKING, awaitingUser: true })]);
  h.run(50 * MIN, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual([]);
});

test('one nudge per episode: a working session is not nudged again hour after hour', () => {
  const h = harness();
  h.run(6 * HOUR, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
});

test('the hourly loop is gone: nudge, the agent answers with a tg send, then it idles — no second nudge ever', () => {
  const h = harness();
  h.run(HOUR + MIN, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
  // The nudge woke it; it answers with a tg status and goes idle again.
  const answeredAt = NOW + HOUR + 2 * MIN;
  h.run(6 * HOUR, [obs('omp:s', IDLE, { lastTgSentAt: answeredAt })]);
  expect(h.nudges).toEqual(['omp:s']);
});

test('a real tg send inside a working stretch restarts the silence clock', () => {
  const h = harness();
  h.run(50 * MIN, [obs('omp:s', WORKING)]);
  const sentAt = NOW + 50 * MIN;
  h.run(50 * MIN, [obs('omp:s', WORKING, { lastTgSentAt: sentAt })]);
  expect(h.nudges).toEqual([]); // 100 min of work, but only 50 since the send
  h.run(15 * MIN, [obs('omp:s', WORKING, { lastTgSentAt: sentAt })]);
  expect(h.nudges).toEqual(['omp:s']);
});

test('a stale tg send under a reused key cannot backdate a just-started working stretch', () => {
  const h = harness();
  h.sweep([obs('omp:500', WORKING, { lastTgSentAt: NOW - 2 * HOUR })]);
  expect(h.nudges).toEqual([]);
  expect(h.store['omp:500'].lastTgSentAt).toBe(NOW - 2 * HOUR);
});

test('a one-sweep flap of the live list keeps the nudge marker — the nudge does not repeat', () => {
  const h = harness();
  h.run(HOUR + MIN, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
  h.sweep([]); // the probe missed it once
  h.advance(30_000);
  h.run(3 * HOUR, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
});

test('a 7-minute flap of the live list keeps both the stretch and the nudge marker', () => {
  const h = harness();
  h.run(HOUR + MIN, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
  h.advance(7 * MIN);
  h.sweep([]);
  h.advance(30_000);
  h.run(3 * HOUR, [obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual(['omp:s']);
});

test('sweeps further apart than the grace period do not credit the gap as work', () => {
  const h = harness();
  h.run(10 * MIN, [obs('omp:s', WORKING)]);
  h.advance(3 * HOUR); // the daemon was down
  h.sweep([obs('omp:s', WORKING)]);
  expect(h.nudges).toEqual([]);
  expect(h.store['omp:s'].activeSince).toBe(NOW + 3 * HOUR + 10 * MIN);
});

test('a FAILED nudge delivery does not consume the episode — stays due next sweep', () => {
  let store: AwarenessNudgeStore = {};
  const live = [obs('omp:501', WORKING)];
  let due: string[] = [];
  // Sweeps every 30 s; every send fails, so markAwarenessNudgeSent is never called.
  for (let t = 0; t <= HOUR + 2 * MIN; t += 30_000) {
    const plan = planAwarenessNudges(live, store, NOW + t);
    store = plan.store;
    due = plan.due;
  }
  expect(due).toEqual(['omp:501']);
});

test('a replacement session in the same key (e.g. a pane reused after Ctrl-C) does not inherit the old episode', () => {
  const h = harness();
  h.run(HOUR + MIN, [obs('tmux:%5', WORKING, { sessionId: 'session-A' })]);
  expect(h.nudges).toEqual(['tmux:%5']);
  h.sweep([obs('tmux:%5', WORKING, { sessionId: 'session-B' })]);
  expect(h.store['tmux:%5'].lastNudgedAt).toBeUndefined();
  expect(h.store['tmux:%5'].sessionId).toBe('session-B');
  expect(h.store['tmux:%5'].decision?.outcome).toBe('below-threshold');
});

test('an unknown (null) observed sessionId cannot disprove identity — the prior stretch carries on', () => {
  const h = harness();
  h.run(30 * MIN, [obs('omp:9', WORKING, { sessionId: 'session-A' })]);
  h.run(31 * MIN, [obs('omp:9', WORKING, { sessionId: null })]);
  expect(h.nudges).toEqual(['omp:9']);
});

// --- store ---

test('changed is false for a steady sweep and true when the verdict or key set moves', () => {
  const h = harness();
  h.sweep([obs('omp:1', WORKING)]);
  h.advance(30_000);
  expect(h.sweep([obs('omp:1', WORKING)]).changed).toBe(false); // only the heartbeat moved
  h.advance(30_000);
  expect(h.sweep([obs('omp:1', IDLE)]).changed).toBe(true);
  h.advance(30_000);
  expect(h.sweep([obs('omp:1', IDLE), obs('omp:2', IDLE)]).changed).toBe(true);
});

test('markAwarenessNudgeSent marks only the given keys, keyed off their current lastTgSentAt', () => {
  const store: AwarenessNudgeStore = {
    'omp:7': { lastTgSentAt: null },
    'omp:8': { lastTgSentAt: NOW - 90 * MIN },
  };
  const updated = markAwarenessNudgeSent(store, ['omp:7'], NOW);
  expect(updated['omp:7']).toEqual({ lastTgSentAt: null, lastNudgedAt: NOW, lastNudgedForTgSentAt: null });
  expect(updated['omp:8']).toEqual(store['omp:8']);
});

test('markAwarenessNudgeSent ignores a key no longer present and is a no-op with no keys', () => {
  expect(markAwarenessNudgeSent({}, ['omp:gone'], NOW)).toEqual({});
  const store: AwarenessNudgeStore = { 'omp:1': { lastTgSentAt: null } };
  expect(markAwarenessNudgeSent(store, [], NOW)).toBe(store);
});

test('round-trips a full store through serialize/parse', () => {
  const store: AwarenessNudgeStore = {
    'omp:1': {
      lastTgSentAt: NOW - 1000,
      lastNudgedAt: NOW,
      lastNudgedForTgSentAt: NOW - 1000,
      sessionId: 'sess-abc',
      activeSince: NOW - MIN,
      lastObservedAt: NOW,
      decision: { state: 'working', reason: 'a turn is running', outcome: 'already-nudged' },
    },
  };
  expect(parseAwarenessNudgeStore(serializeAwarenessNudgeStore(store))).toEqual(store);
});

test('parse: a pre-#789 store (no activity fields) still loads', () => {
  const legacy = '{"version":1,"agents":{"omp:1":{"firstSeenAt":5,"lastTgSentAt":null,"lastNudgedAt":6,"lastNudgedForTgSentAt":null}}}';
  expect(parseAwarenessNudgeStore(legacy)['omp:1'].lastNudgedAt).toBe(6);
});

test('parse: malformed / absent / non-object -> empty store', () => {
  expect(parseAwarenessNudgeStore(null)).toEqual({});
  expect(parseAwarenessNudgeStore('not json')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":"x"}')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":{"k":{"lastTgSentAt":"x"}}}')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":{"k":{"lastTgSentAt":null,"sessionId":5}}}')).toEqual({});
  expect(parseAwarenessNudgeStore('{"agents":{"k":{"lastTgSentAt":null,"decision":{"state":"x"}}}}')).toEqual({});
});

test('lastTgSentAtByKey: only agent-direction records with a pane count, latest wins', () => {
  const records: HistoryRecord[] = [
    { ts: 1000, message_id: 1, direction: 'agent', from: 'agent', text: 'a', pane: 'omp:5' },
    { ts: 2000, message_id: 2, direction: 'agent', from: 'agent', text: 'b', pane: 'omp:5' },
    { ts: 5000, message_id: 3, direction: 'user', from: 'Alex', text: 'c', pane: 'omp:5' },
    { ts: 3000, message_id: 4, direction: 'agent', from: 'agent', text: 'd', pane: null },
  ];
  const out = lastTgSentAtByKey(records);
  expect(out.get('omp:5')).toBe(2000 * 1000);
  expect(out.size).toBe(1);
});

test('threshold default is exactly one hour', () => {
  expect(AWARENESS_NUDGE_THRESHOLD_MS).toBe(60 * 60 * 1000);
});

// --- tg-ctl status --verbose ---

test('status --verbose says why each session was or was not nudged', () => {
  const h = harness();
  const live = [
    obs('omp:busy', WORKING),
    obs('omp:idle', IDLE),
    obs('omp:asking', { ...WORKING, awaitingUser: true }),
    obs('omp:gone', WORKING),
  ];
  h.run(HOUR + 2 * MIN, live);
  h.sweep(live.filter((o) => o.key !== 'omp:gone'));
  const labels = new Map([
    ['omp:busy', '🧵 TOPIC'],
    ['omp:idle', '🔍 REVIEW'],
  ]);
  const text = renderAwarenessStatus(h.store, h.nudges.length ? NOW + HOUR + 4 * MIN : NOW, labels).join('\n');
  expect(text).toContain('awareness nudge: after 60 min');
  expect(text).toContain('🧵 TOPIC: working');
  expect(text).toContain('nudged already this episode');
  expect(text).toContain('last nudge');
  expect(text).toContain('🔍 REVIEW: idle — not nudged: not working (silence clock reset)');
  expect(text).toContain('omp:asking: waiting-for-user');
  expect(text).toContain('an ask is waiting for the human');
  expect(text).toContain('omp:gone: gone');
});

test('status --verbose with nothing remembered says so', () => {
  expect(renderAwarenessStatus({}, NOW, new Map()).join('\n')).toContain('(no agents remembered)');
});
