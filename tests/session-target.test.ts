import { expect, test } from 'bun:test';
import { emptyRegistry, reconcile, type LiveSession, type Registry } from '../features/tg-ctl/session-registry';
import {
  checkPaneSession,
  goneRouteSession,
  paneRefusalText,
  registryCurrentForPane,
  resolveAnchorTarget,
  resolveRegistrationsBySession,
  resolveRouteSession,
  sessionDeliveryTarget,
} from '../features/tg-ctl/session-target';

// Session-keyed delivery (spec §2.4–§2.6, tg-cli#459 #354 #100): routes,
// registrations and the last-user target resolve through the registry, and a pane
// delivery is refused unless the pane still hosts the addressed session.

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const SID = '01a0c543-1ac1-7433-903d-e98726bfda37';

function live(over: Partial<LiveSession>): LiveSession {
  return {
    harness: 'omp',
    sessionId: SID,
    sessionFile: null,
    pid: 100,
    tmux: { serverPid: 7, paneId: '%0', panePid: 50 },
    durableSession: null,
    windowName: 'gc',
    paneTitle: null,
    harnessTitle: null,
    cwd: '/w/gc',
    ...over,
  };
}

const scan = (prev: Registry, sessions: LiveSession[], at: number): Registry => reconcile(prev, sessions, at).next;

const OMP = `omp:${SID}` as const;

test('resolveRouteSession: the origin agent pid names the session, whatever pane it sent from', () => {
  const reg = scan(emptyRegistry(), [live({ tmux: null, pid: 4242 })], T0);
  expect(resolveRouteSession(reg, { paneId: 'omp:4242', agentPid: 4242 })).toBe(OMP);
  // No pid recorded and no pane locator: an `omp:<pid>` pane id is itself the pid.
  expect(resolveRouteSession(reg, { paneId: 'omp:4242' })).toBe(OMP);
  expect(resolveRouteSession(reg, { paneId: 'omp:9' })).toBeNull();
});

test('resolveRouteSession: a tmux origin needs the full (server, pane, panePid) triple', () => {
  const reg = scan(emptyRegistry(), [live({})], T0);
  expect(resolveRouteSession(reg, { paneId: '%0', serverPid: 7, panePid: 50 })).toBe(OMP);
  // A tmux server restart reused %0: different server pid → not the same pane.
  expect(resolveRouteSession(reg, { paneId: '%0', serverPid: 8, panePid: 50 })).toBeNull();
  // A pane id alone is never proof (pane ids are reused freely).
  expect(resolveRouteSession(reg, { paneId: '%0' })).toBeNull();
});

test('resolveRouteSession: a gone session is not an origin', () => {
  const first = scan(emptyRegistry(), [live({ tmux: null, pid: 4242 })], T0);
  const gone = scan(first, [], T0 + 1000);
  expect(resolveRouteSession(gone, { paneId: 'omp:4242', agentPid: 4242 })).toBeNull();
});

test('resolveRouteSession: a reused agent pid in another pane never claims a tmux route', () => {
  // Route sent from %1 by pid 100; that agent exited and pid 100 now runs B in %2.
  const reg = scan(emptyRegistry(), [live({ pid: 100, tmux: { serverPid: 7, paneId: '%2', panePid: 60 } })], T0);
  expect(resolveRouteSession(reg, { paneId: '%1', agentPid: 100, serverPid: 7, panePid: 55 })).toBeNull();
  // A new agent process in the same pane shell (same triple, new pid) is not the origin either.
  const restarted = scan(emptyRegistry(), [live({ pid: 101 })], T0);
  expect(resolveRouteSession(restarted, { paneId: '%0', agentPid: 100, serverPid: 7, panePid: 50 })).toBeNull();
  expect(resolveRouteSession(restarted, { paneId: '%0', agentPid: 101, serverPid: 7, panePid: 50 })).toBe(OMP);
});

test('goneRouteSession: an unkeyed route whose exact origin has left names the gone session', () => {
  const first = scan(emptyRegistry(), [live({})], T0);
  const gone = scan(first, [], T0 + 1000);
  expect(goneRouteSession(gone, { paneId: '%0', agentPid: 100, serverPid: 7, panePid: 50 })?.key).toBe(OMP);
  expect(goneRouteSession(first, { paneId: '%0', agentPid: 100, serverPid: 7, panePid: 50 })).toBeNull();
  expect(goneRouteSession(gone, { paneId: '%0' })).toBeNull();
});

test('registryCurrentForPane: a shared scan is stale once the pane holds another process', () => {
  const reg = scan(emptyRegistry(), [live({})], T0);
  expect(registryCurrentForPane(reg, '%0', 50, 100)).toBe(true);
  expect(registryCurrentForPane(reg, '%0', 50, 101)).toBe(false); // agent restarted in the shell
  expect(registryCurrentForPane(reg, '%0', 51, 100)).toBe(false); // respawned pane
  expect(registryCurrentForPane(reg, '%0', 50, undefined)).toBe(false);
  expect(registryCurrentForPane(reg, '%9', 50, 100)).toBe(false);
});

test('sessionDeliveryTarget: a resumed omp (new pid, same session id) is reached at its new locator', () => {
  const before = scan(emptyRegistry(), [live({ tmux: null, pid: 4242 })], T0);
  const exited = scan(before, [], T0 + 1000);
  expect(sessionDeliveryTarget(exited, OMP)).toEqual({ kind: 'gone', name: 'gc' });
  const resumed = scan(exited, [live({ tmux: null, pid: 5151 })], T0 + 2000);
  expect(sessionDeliveryTarget(resumed, OMP)).toEqual({ kind: 'live', paneId: null, pid: 5151, cwd: '/w/gc', name: 'gc' });
  const inTmux = scan(resumed, [live({ pid: 6000, tmux: { serverPid: 7, paneId: '%4', panePid: 70 } })], T0 + 3000);
  expect(sessionDeliveryTarget(inTmux, OMP)).toEqual({ kind: 'live', paneId: '%4', pid: 6000, cwd: '/w/gc', name: 'gc' });
});

test('sessionDeliveryTarget: an unknown key is unknown, not gone', () => {
  expect(sessionDeliveryTarget(emptyRegistry(), OMP)).toEqual({ kind: 'unknown' });
});

test('checkPaneSession: the pane must still host the addressed session', () => {
  const reg = scan(emptyRegistry(), [live({})], T0);
  expect(checkPaneSession(reg, OMP, '%0')).toEqual({ ok: true });

  // tmux kill-server; the new server's %0 hosts a different session.
  const reused = scan(reg, [live({ sessionId: 'other', pid: 300, windowName: 'rig', tmux: { serverPid: 9, paneId: '%0', panePid: 51 } })], T0 + 1000);
  const check = checkPaneSession(reused, OMP, '%0');
  expect(check).toEqual({ ok: false, targetName: 'gc', hostName: 'rig' });
  if (check.ok) throw new Error('unreachable');
  expect(paneRefusalText(check, '%0')).toBe('gc is no longer in pane %0 (now rig)');
});

test('checkPaneSession: an emptied pane and a moved session both refuse', () => {
  const reg = scan(emptyRegistry(), [live({})], T0);
  const moved = scan(reg, [live({ tmux: { serverPid: 7, paneId: '%2', panePid: 52 } })], T0 + 1000);
  const check = checkPaneSession(moved, OMP, '%0');
  expect(check).toEqual({ ok: false, targetName: 'gc', hostName: null });
  if (check.ok) throw new Error('unreachable');
  expect(paneRefusalText(check, '%0')).toBe('gc is no longer in pane %0 (now no agent)');
});

test('checkPaneSession: a provisional key matches the pane it was minted for, before and after promotion', () => {
  const cc = live({ harness: 'cc', sessionId: null, pid: 200, windowName: 'cc', tmux: { serverPid: 7, paneId: '%3', panePid: 60 } });
  const provisional = scan(emptyRegistry(), [cc], T0);
  const key = provisional.sessions[0].key;
  expect(checkPaneSession(provisional, key, '%3')).toEqual({ ok: true });
  const promoted = scan(provisional, [{ ...cc, sessionId: 'abc' }], T0 + 1000);
  expect(promoted.sessions[0].key).toBe('cc:abc');
  expect(checkPaneSession(promoted, key, '%3')).toEqual({ ok: true });
  // A respawned pane (new panePid) is a different pane even with the same id.
  const respawned = scan(promoted, [{ ...cc, sessionId: 'abc', tmux: { serverPid: 7, paneId: '%3', panePid: 61 } }], T0 + 2000);
  expect(checkPaneSession(respawned, key, '%3').ok).toBe(false);
});

test('resolveRegistrationsBySession: keyed rows follow their session, gone rows drop, unkeyed rows stay', () => {
  const base = scan(emptyRegistry(), [live({}), live({ sessionId: 'gone', pid: 9, tmux: { serverPid: 7, paneId: '%9', panePid: 90 } })], T0);
  const reg = scan(base, [live({ tmux: { serverPid: 7, paneId: '%5', panePid: 55 } })], T0 + 1000);
  const rows = [
    { paneId: '%0', cwd: '/w/gc', sessionKey: OMP },
    { paneId: '%9', cwd: '/w/gc', sessionKey: 'omp:gone' },
    { paneId: '%7', cwd: '/w/pi' },
    { paneId: '%8', cwd: '/w/x', sessionKey: 'omp:never-seen' },
  ];
  expect(resolveRegistrationsBySession(rows, reg)).toEqual([
    { paneId: '%5', cwd: '/w/gc', sessionKey: OMP },
    { paneId: '%7', cwd: '/w/pi' },
    { paneId: '%8', cwd: '/w/x', sessionKey: 'omp:never-seen' },
  ]);
  expect(resolveRegistrationsBySession(rows, null)).toBe(rows);
});

test('resolveAnchorTarget: a keyed anchor is proven by its session, never by a reused pane', () => {
  const reg = scan(emptyRegistry(), [live({ tmux: null, pid: 4242 })], T0);
  expect(resolveAnchorTarget({ paneId: 'omp:1', cwd: '/w/gc', ts: 1, sessionKey: OMP }, reg)).toEqual({ paneId: 'omp:4242', proven: true });
  const gone = scan(reg, [], T0 + 1000);
  expect(resolveAnchorTarget({ paneId: 'omp:4242', cwd: '/w/gc', ts: 1, sessionKey: OMP }, gone)).toBeNull();
  expect(resolveAnchorTarget({ paneId: '%1', cwd: '/w/gc', ts: 1 }, reg)).toEqual({ paneId: '%1', proven: false });
  expect(resolveAnchorTarget({ paneId: '%1', cwd: '/w/gc', ts: 1, sessionKey: 'omp:never-seen' }, reg)).toEqual({ paneId: '%1', proven: false });
});
