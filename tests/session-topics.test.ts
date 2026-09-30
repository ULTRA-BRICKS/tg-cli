import { expect, test } from 'bun:test';
import { emptyRegistry, reconcile, type LiveSession, type Registry, type SessionEntry } from '../features/tg-ctl/session-registry';
import {
  createTopicEnsurer,
  findSessionForCard,
  findSessionForLookup,
  noteTopicMiss,
  paneLocatorOf,
  parseResolveSessionRequest,
  TOPIC_MISS_RECREATE_AFTER_MS,
  TOPIC_RECREATE_COOLDOWN_MS,
  topicTitleFor,
} from '../features/tg-ctl/session-topics';
import { isTopicDeletedError } from '../features/transport/telegram';

// One bot-created topic per registry session (docs/specs/session-registry-and-topics.md
// §4.2, §4.3, §4.5; tg-cli#467).

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const SID = '01a0c543-1ac1-7433-903d-e98726bfda37';
const CC_SID = 'c0ffee00-0000-4000-8000-000000000001';

function live(over: Partial<LiveSession>): LiveSession {
  return {
    harness: 'omp',
    sessionId: SID,
    sessionFile: `/s/${SID}.jsonl`,
    pid: 100,
    tmux: { serverPid: 7, paneId: '%0', panePid: 50 },
    durableSession: null,
    windowName: 'gc-sme',
    paneTitle: null,
    harnessTitle: 'Recover commits',
    cwd: '/w/gc',
    ...over,
  };
}

// A registry holding an omp in tmux (%0), an omp outside tmux (pid 400) and a cc in %3.
function fleet(): Registry {
  return reconcile(
    emptyRegistry(),
    [
      live({}),
      live({ sessionId: 'out-of-tmux', sessionFile: '/s/out.jsonl', pid: 400, tmux: null, windowName: null, harnessTitle: 'Loose omp' }),
      live({ harness: 'cc', sessionId: CC_SID, sessionFile: null, pid: 200, tmux: { serverPid: 7, paneId: '%3', panePid: 60 }, windowName: 'rig', harnessTitle: null }),
    ],
    T0,
  ).next;
}

const keyOf = (e: SessionEntry | null): string | null => e?.key ?? null;

test('the topic title is primary · secondary, capped at 128 characters; an unnamed entry falls back to its key', () => {
  const e = fleet().sessions.find((s) => s.key === `omp:${SID}`)!;
  expect(topicTitleFor(e)).toBe('gc-sme · Recover commits');
  const long = { ...e, name: { primary: 'x'.repeat(200), secondary: null } };
  expect([...topicTitleFor(long)].length).toBe(128);
  expect(topicTitleFor({ ...e, name: { primary: '', secondary: null } })).toBe(`omp:${SID}`);
});

test('the pane locator is the tmux pane, or omp:<pid> for an omp outside tmux', () => {
  const reg = fleet();
  expect(reg.sessions.map((s) => paneLocatorOf(s))).toEqual(
    reg.sessions.map((s) => (s.locators.tmux ? s.locators.tmux.paneId : `omp:${s.locators.pid}`)),
  );
  expect(paneLocatorOf(reg.sessions.find((s) => s.key === 'omp:out-of-tmux')!)).toBe('omp:400');
});

test('resolve-session request: only the resolve-session kind parses; junk fields are dropped', () => {
  expect(parseResolveSessionRequest({ kind: 'resolve-session', tmuxPane: '%3', tmuxServerPid: 7, ancestorPids: [200, 'x', -1] })).toEqual({
    tmuxPane: '%3',
    tmuxServerPid: 7,
    ancestorPids: [200],
    sessionFile: null,
  });
  expect(parseResolveSessionRequest({ kind: 'resolve-session' })).toEqual({ tmuxPane: null, tmuxServerPid: null, ancestorPids: [], sessionFile: null });
  expect(parseResolveSessionRequest({ tgctl: 'verify-grant' })).toBeNull();
  expect(parseResolveSessionRequest({ kind: 'resolve-session', tmuxPane: 'rm -rf' })?.tmuxPane).toBeNull();
});

test('lookup matches the harness ancestor pid first, then the session file, then the tmux pane', () => {
  const reg = fleet();
  // tg run from an omp outside tmux: only the ancestor pid identifies it.
  expect(keyOf(findSessionForLookup(reg, { tmuxPane: null, tmuxServerPid: null, ancestorPids: [400], sessionFile: null }))).toBe('omp:out-of-tmux');
  // A pid wins over a pane that hosts another session (a shell split sharing the window).
  expect(keyOf(findSessionForLookup(reg, { tmuxPane: '%3', tmuxServerPid: 7, ancestorPids: [100], sessionFile: null }))).toBe(`omp:${SID}`);
  expect(keyOf(findSessionForLookup(reg, { tmuxPane: null, tmuxServerPid: null, ancestorPids: [], sessionFile: '/s/out.jsonl' }))).toBe('omp:out-of-tmux');
  expect(keyOf(findSessionForLookup(reg, { tmuxPane: '%3', tmuxServerPid: 7, ancestorPids: [], sessionFile: null }))).toBe(`cc:${CC_SID}`);
});

test('lookup never answers with a pane of another tmux server, a gone entry, or a guess', () => {
  const reg = fleet();
  // Same %3, different server (tmux restarted and reused the pane id): not that session.
  expect(findSessionForLookup(reg, { tmuxPane: '%3', tmuxServerPid: 8, ancestorPids: [], sessionFile: null })).toBeNull();
  expect(findSessionForLookup(reg, { tmuxPane: '%9', tmuxServerPid: 7, ancestorPids: [999], sessionFile: null })).toBeNull();
  const gone = reconcile(reg, [], T0 + 5_000).next;
  expect(findSessionForLookup(gone, { tmuxPane: '%3', tmuxServerPid: 7, ancestorPids: [200], sessionFile: null })).toBeNull();
});

test('a card resolves by its hook session id first, else by its pane', () => {
  const reg = fleet();
  expect(keyOf(findSessionForCard(reg, { agent: 'claude', sessionId: CC_SID, paneId: '%9' }))).toBe(`cc:${CC_SID}`);
  expect(keyOf(findSessionForCard(reg, { agent: 'claude', paneId: '%3' }))).toBe(`cc:${CC_SID}`);
  expect(keyOf(findSessionForCard(reg, { agent: 'omp', paneId: '%0' }))).toBe(`omp:${SID}`);
  expect(findSessionForCard(reg, { agent: 'claude' })).toBeNull();
  expect(findSessionForCard(reg, { agent: 'claude', paneId: '%9' })).toBeNull();
});

test('ensureTopic: two concurrent first sends create exactly one topic; later calls reuse it', async () => {
  let threadId: number | null = null;
  let creates = 0;
  let release: (id: number) => void = () => {};
  const ensure = createTopicEnsurer({
    threadIdOf: () => threadId,
    create: async () => {
      creates++;
      const id = await new Promise<number>((r) => (release = r));
      threadId = id;
      return id;
    },
  });
  const a = ensure('omp:a');
  const b = ensure('omp:a');
  release(42);
  expect(await Promise.all([a, b])).toEqual([42, 42]);
  expect(await ensure('omp:a')).toBe(42);
  expect(creates).toBe(1);
});

test('ensureTopic: a failed create is not cached, so the next outbound tries again', async () => {
  let calls = 0;
  const ensure = createTopicEnsurer({
    threadIdOf: () => null,
    create: async () => (++calls === 1 ? null : 7),
  });
  expect(await ensure('omp:a')).toBeNull();
  expect(await ensure('omp:a')).toBe(7);
  expect(calls).toBe(2);
});

test('ensureTopic: a create that throws resolves null instead of rejecting', async () => {
  const ensure = createTopicEnsurer({ threadIdOf: () => null, create: async () => { throw new Error('boom'); } });
  expect(await ensure('omp:a')).toBeNull();
});

test('ensureTopic: different sessions are not serialised behind each other', async () => {
  const pending: Array<(id: number) => void> = [];
  const ensure = createTopicEnsurer({
    threadIdOf: () => null,
    create: (key) => new Promise<number>((r) => pending.push((id) => r(key === 'omp:a' ? id : id + 1))),
  });
  const a = ensure('omp:a');
  const b = ensure('omp:b');
  expect(pending).toHaveLength(2);
  pending[1](10);
  pending[0](20);
  expect(await Promise.all([a, b])).toEqual([20, 11]);
});

test('thread-not-found misses: a burst of 3 within 10 min only falls back; a later miss recreates', () => {
  let m = noteTopicMiss(null, T0, { deleted: false, lastRecreatedAt: null });
  expect(m).toEqual({ misses: { count: 1, firstAt: '2026-09-30T10:00:00.000Z' }, recreate: false });
  m = noteTopicMiss(m.misses, T0 + 60_000, { deleted: false, lastRecreatedAt: null });
  m = noteTopicMiss(m.misses, T0 + 120_000, { deleted: false, lastRecreatedAt: null });
  expect(m).toEqual({ misses: { count: 3, firstAt: '2026-09-30T10:00:00.000Z' }, recreate: false });
  const later = noteTopicMiss(m.misses, T0 + TOPIC_MISS_RECREATE_AFTER_MS, { deleted: false, lastRecreatedAt: null });
  expect(later).toEqual({ misses: null, recreate: true });
});

test('two slow misses past 10 min are not enough: the 3rd consecutive miss is required', () => {
  const m = noteTopicMiss({ count: 1, firstAt: new Date(T0).toISOString() }, T0 + 2 * TOPIC_MISS_RECREATE_AFTER_MS, { deleted: false, lastRecreatedAt: null });
  expect(m.recreate).toBe(false);
  expect(m.misses?.count).toBe(2);
});

test('a topic Telegram reports deleted is recreated at once, but at most once per 24 h per entry', () => {
  expect(noteTopicMiss(null, T0, { deleted: true, lastRecreatedAt: null })).toEqual({ misses: null, recreate: true });
  const capped = noteTopicMiss(null, T0, { deleted: true, lastRecreatedAt: T0 - 60_000 });
  expect(capped.recreate).toBe(false);
  expect(capped.misses?.count).toBe(1);
  expect(noteTopicMiss(null, T0, { deleted: true, lastRecreatedAt: T0 - TOPIC_RECREATE_COOLDOWN_MS }).recreate).toBe(true);
});

test('deleted-topic errors are told apart from the transient private-topic "thread not found"', () => {
  expect(isTopicDeletedError('Bad Request: TOPIC_ID_INVALID')).toBe(true);
  expect(isTopicDeletedError('Bad Request: topic_deleted')).toBe(true);
  expect(isTopicDeletedError('Bad Request: message thread not found')).toBe(false);
  expect(isTopicDeletedError('Bad Request: chat not found')).toBe(false);
});
