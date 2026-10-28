import { expect, test } from 'bun:test';
import { answerOfSink, parseSatelliteRequest, resolveSatelliteTarget } from '../features/tg-ctl/remote-satellite';
import { emptyRegistry, reconcile, type LiveSession } from '../features/tg-ctl/session-registry';

const NOW = Date.parse('2026-10-28T08:00:00Z');

const live = (over: Partial<LiveSession>): LiveSession => ({
  harness: 'cc',
  sessionId: null,
  sessionFile: null,
  pid: 4242,
  tmux: { serverPid: 99, paneId: '%3', panePid: 100 },
  durableSession: null,
  windowName: 'proj',
  paneTitle: null,
  harnessTitle: null,
  cwd: '/srv/proj',
  ...over,
});

const registryOf = (...sessions: LiveSession[]) => reconcile(emptyRegistry(), sessions, NOW).next;

test('request parsing: closed schema, idem shape, NUL and oversize rejected', () => {
  const ok = parseSatelliteRequest(JSON.stringify({ idem: '1:77', route: { paneId: '%3' }, text: 'hi', replyTo: { id: 5 } }));
  expect(ok).toEqual({ ok: true, request: { idem: '1:77', route: { paneId: '%3' }, text: 'hi', replyTo: { id: 5 } } });
  expect(parseSatelliteRequest(JSON.stringify({ idem: '-100:7', route: { paneId: null, sessionKey: 'omp:x' }, text: 't' })).ok).toBe(true);
  const bad = [
    'not json',
    '[]',
    JSON.stringify({ idem: '1:77', route: {}, text: 'x', extra: 1 }),
    JSON.stringify({ idem: 'x', route: {}, text: 'x' }),
    JSON.stringify({ idem: '1:77', route: { paneId: '%3', unknown: 1 }, text: 'x' }),
    JSON.stringify({ idem: '1:77', route: {}, text: 'a\u0000b' }),
    JSON.stringify({ idem: '1:77', route: {}, text: 'x', replyTo: { id: 1.5 } }),
    JSON.stringify({ idem: '1:77', route: {}, text: 'x'.repeat(256 * 1024 + 1) }),
    JSON.stringify({ idem: '1:77', route: {} }),
  ];
  for (const raw of bad) expect(parseSatelliteRequest(raw).ok).toBe(false);
});

test('the exact origin triple + agent pid names the tmux session', () => {
  const reg = registryOf(live({}));
  expect(resolveSatelliteTarget(reg, { paneId: '%3', serverPid: 99, panePid: 100, agentPid: 4242 })).toEqual({
    kind: 'tmux',
    paneId: '%3',
    sessionKey: 'cc:pane:99/%3/100',
  });
});

test('a reused pane id is refused: another agent pid, another pane process, another server', () => {
  const reg = registryOf(live({ pid: 5555, tmux: { serverPid: 99, paneId: '%3', panePid: 100 } }));
  // The route's agent is gone; a different process now sits in %3.
  expect(resolveSatelliteTarget(reg, { paneId: '%3', serverPid: 99, panePid: 100, agentPid: 4242 })).toBeNull();
  const respawned = registryOf(live({ tmux: { serverPid: 99, paneId: '%3', panePid: 777 } }));
  expect(resolveSatelliteTarget(respawned, { paneId: '%3', serverPid: 99, panePid: 100, agentPid: 4242 })).toBeNull();
  const restarted = registryOf(live({ tmux: { serverPid: 1234, paneId: '%3', panePid: 100 } }));
  expect(resolveSatelliteTarget(restarted, { paneId: '%3', serverPid: 99, panePid: 100, agentPid: 4242 })).toBeNull();
});

test('a bare pane id is never enough, with or without a cwd', () => {
  const reg = registryOf(live({}));
  expect(resolveSatelliteTarget(reg, { paneId: '%3' })).toBeNull();
  expect(resolveSatelliteTarget(reg, { paneId: '%3', cwd: '/srv/proj' })).toBeNull();
});

test('a provisional session key names a PANE: the same key with a different agent pid in it is refused', () => {
  // The agent (pid 4242) exited and a new claude (pid 5555) started in the same shell: same server, pane
  // and pane process, so the provisional key is unchanged — but it is not the agent the route recorded.
  const replaced = registryOf(live({ pid: 5555 }));
  const route = { paneId: '%3', serverPid: 99, panePid: 100, agentPid: 4242, sessionKey: 'cc:pane:99/%3/100' };
  expect(replaced.sessions.map((e) => e.key)).toEqual(['cc:pane:99/%3/100']);
  expect(resolveSatelliteTarget(replaced, route)).toBeNull();
  // The same key with the agent the route recorded is the session.
  expect(resolveSatelliteTarget(registryOf(live({})), route)).toEqual({ kind: 'tmux', paneId: '%3', sessionKey: 'cc:pane:99/%3/100' });
  // A key-only route (no recorded pid) keeps working: there is nothing to contradict.
  expect(resolveSatelliteTarget(replaced, { paneId: null, sessionKey: 'cc:pane:99/%3/100' })).toEqual({ kind: 'tmux', paneId: '%3', sessionKey: 'cc:pane:99/%3/100' });
});

test('a route whose session key is live follows the session to its new pane (resumed omp)', () => {
  const reg = registryOf(live({ harness: 'omp', sessionId: 'abc', pid: 7001, tmux: { serverPid: 99, paneId: '%8', panePid: 200 } }));
  expect(resolveSatelliteTarget(reg, { paneId: '%3', sessionKey: 'omp:abc', serverPid: 99, panePid: 100 })).toEqual({ kind: 'omp', originId: '%8' });
});

test('an omp outside tmux is reached by its omp:<pid> origin', () => {
  const reg = registryOf(live({ harness: 'omp', sessionId: 'abc', pid: 7001, tmux: null }));
  expect(resolveSatelliteTarget(reg, { paneId: 'omp:7001' })).toEqual({ kind: 'omp', originId: 'omp:7001' });
  expect(resolveSatelliteTarget(reg, { paneId: 'omp:7002' })).toBeNull();
  expect(resolveSatelliteTarget(reg, { paneId: null, sessionKey: 'omp:abc' })).toEqual({ kind: 'omp', originId: 'omp:7001' });
});

test('a rig-wrapper host origin goes to that host, pinned to the recorded agent pid', () => {
  expect(resolveSatelliteTarget(emptyRegistry(), { paneId: 'host:alpha', agentPid: 31 })).toEqual({ kind: 'host', name: 'alpha', pid: 31 });
});

test('no live session, or a key that never lived here: no-session', () => {
  expect(resolveSatelliteTarget(emptyRegistry(), { paneId: '%3', serverPid: 99, panePid: 100, agentPid: 4242 })).toBeNull();
  expect(resolveSatelliteTarget(registryOf(live({})), { paneId: null, sessionKey: 'cc:pane:1/%9/2' })).toBeNull();
});

test('sink results map to wire answers; every maybe-typed shape is uncertain', () => {
  expect(answerOfSink({ ok: true }, 'tmux')).toEqual({ ok: true, sink: 'tmux' });
  expect(answerOfSink({ ok: false, error: 'x', unsubmitted: true }, 'tmux')).toEqual({ ok: false, error: 'unsubmitted', uncertain: true });
  expect(answerOfSink({ ok: false, error: 'x', sessionMismatch: true }, 'tmux')).toEqual({ ok: false, error: 'no-session', uncertain: false });
  expect(answerOfSink({ ok: false, error: 'x', uncertain: true }, 'host')).toEqual({ ok: false, error: 'uncertain', uncertain: true });
  expect(answerOfSink({ ok: false, error: 'pane %3 no longer hosts an agent — message not injected' }, 'tmux')).toEqual({ ok: false, error: 'gone', uncertain: false });
  expect(answerOfSink({ ok: false, error: 'alpha is no longer running under the rig wrapper — message not delivered' }, 'host')).toEqual({
    ok: false,
    error: 'gone',
    uncertain: false,
  });
  expect(answerOfSink({ ok: false, error: 'Original OMP bridge: endpoint_timeout. The original OMP is busy' }, 'omp-live')).toEqual({
    ok: false,
    error: 'endpoint-busy',
    uncertain: true,
  });
  expect(answerOfSink({ ok: false, error: 'Original OMP bridge: endpoint_unavailable. Run tg-ctl omp-live install.' }, 'omp-live')).toEqual({
    ok: false,
    error: 'unavailable',
    uncertain: false,
  });
  expect(answerOfSink({ ok: false, error: 'tmux send-keys -t %3 failed: boom' }, 'tmux')).toEqual({ ok: false, error: 'inject-failed', uncertain: true });
});
