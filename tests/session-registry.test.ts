import { expect, test } from 'bun:test';
import {
  emptyRegistry,
  GONE_RETENTION_MS,
  provisionalKey,
  reconcile,
  RENAME_DEBOUNCE_MS,
  type LiveSession,
  type PendingRenames,
  type Registry,
  type RegistryEvent,
} from '../features/tg-ctl/session-registry';

// Session registry core (docs/specs/session-registry-and-topics.md §2.1, §2.3,
// tg-cli#487): one entry per harness session, keyed by the session id; pid and
// pane are locators re-resolved on every scan, never identity.

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const SID = '01a0c543-1ac1-7433-903d-e98726bfda37';
const SID2 = '99b0c543-1ac1-7433-903d-e98726bfda99';

function omp(over: Partial<LiveSession> = {}): LiveSession {
  return {
    harness: 'omp',
    sessionId: SID,
    sessionFile: `/s/2026-09-12T10-00-00-000Z_${SID}.jsonl`,
    pid: 100,
    tmux: { serverPid: 7, paneId: '%0', panePid: 50 },
    durableSession: null,
    windowName: 'gc-sme-backlog',
    paneTitle: null,
    harnessTitle: 'Recover orphaned commits',
    cwd: '/w/gc',
    ...over,
  };
}

function cc(over: Partial<LiveSession> = {}): LiveSession {
  return {
    harness: 'cc',
    sessionId: null,
    sessionFile: null,
    pid: 200,
    tmux: { serverPid: 7, paneId: '%3', panePid: 60 },
    durableSession: null,
    windowName: 'rig',
    paneTitle: '✳ Fix the hooks',
    harnessTitle: null,
    cwd: '/w/rig',
    ...over,
  };
}

const kinds = (events: RegistryEvent[]): string[] => events.map((e) => `${e.kind}:${'key' in e ? e.key : `${e.from}>${e.to}`}`);

function run(prev: Registry, scan: LiveSession[], now = T0) {
  return reconcile(prev, scan, now);
}

test('an unknown session becomes a live entry keyed <harness>:<sessionId> with its locators and resolved name', () => {
  const { next, events } = run(emptyRegistry(), [omp({ durableSession: 'omp-restored-01a0c5431ac1' })]);
  expect(kinds(events)).toEqual([`added:omp:${SID}`]);
  expect(next.sessions).toHaveLength(1);
  const e = next.sessions[0];
  expect(e.key).toBe(`omp:${SID}`);
  expect(e.sessionId).toBe(SID);
  expect(e.state).toBe('live');
  expect(e.locators).toEqual({
    pid: 100,
    tmux: { serverPid: 7, paneId: '%0', panePid: 50 },
    durableSession: 'omp-restored-01a0c5431ac1',
  });
  expect(e.name).toEqual({ primary: 'gc-sme-backlog', secondary: 'Recover orphaned commits' });
  expect(e.firstSeen).toBe('2026-09-30T10:00:00.000Z');
  expect(e.threadId).toBeNull();
});

test('the same session seen again with a new pid and pane keeps its key and is relocated, not re-added', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const { next, events } = run(first, [omp({ pid: 101, tmux: { serverPid: 7, paneId: '%4', panePid: 51 } })], T0 + 5_000);
  expect(kinds(events)).toEqual([`relocated:omp:${SID}`]);
  expect(next.sessions).toHaveLength(1);
  expect(next.sessions[0].locators.pid).toBe(101);
  expect(next.sessions[0].locators.tmux?.paneId).toBe('%4');
  expect(next.sessions[0].firstSeen).toBe('2026-09-30T10:00:00.000Z');
});

test('an unchanged rescan emits nothing', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  expect(run(first, [omp()], T0 + 2_000).events).toEqual([]);
});

test('a known session missing from the scan goes gone, keeping its locators for display', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const { next, events } = run(first, [], T0 + 2_000);
  expect(kinds(events)).toEqual([`gone:omp:${SID}`]);
  expect(next.sessions[0].state).toBe('gone');
  expect(next.sessions[0].locators.pid).toBe(100);
});

test('a gone session that comes back (resume: new process, same session file) is readopted with its threadId', () => {
  let reg = run(emptyRegistry(), [omp()]).next;
  reg = { ...reg, sessions: reg.sessions.map((s) => ({ ...s, threadId: 42 })) };
  reg = run(reg, [], T0 + 2_000).next;
  // rig omp run --resume: a new pid in a new abduco server, the same jsonl.
  const { next, events } = run(reg, [omp({ pid: 300, durableSession: 'omp-restored-01a0c5431ac1' })], T0 + 60_000);
  expect(events).toEqual([{ kind: 'readopted', key: `omp:${SID}`, threadId: 42 }]);
  expect(next.sessions).toHaveLength(1);
  expect(next.sessions[0].state).toBe('live');
  expect(next.sessions[0].locators.pid).toBe(300);
});

test('omp sightings are the same session when the session file matches even if the id differs', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const { next, events } = run(first, [omp({ sessionId: SID2, pid: 101 })], T0 + 2_000);
  expect(kinds(events)).toEqual([`relocated:omp:${SID}`]);
  expect(next.sessions.map((s) => s.key)).toEqual([`omp:${SID}`]);
});

test('a cc pane seen before its first hook gets a provisional pane key; the first hook promotes it in place', () => {
  const tmux = { serverPid: 7, paneId: '%3', panePid: 60 };
  const first = run(emptyRegistry(), [cc()]);
  expect(first.next.sessions[0].key).toBe(provisionalKey('cc', tmux));
  expect(first.next.sessions[0].key).toBe('cc:pane:7/%3/60');
  const withTopic: Registry = { ...first.next, sessions: first.next.sessions.map((s) => ({ ...s, threadId: 9 })) };
  const { next, events } = run(withTopic, [cc({ sessionId: 'cc-session-1' })], T0 + 3_000);
  expect(events).toEqual([{ kind: 'promoted', from: 'cc:pane:7/%3/60', to: 'cc:cc-session-1' }]);
  expect(next.sessions).toHaveLength(1);
  expect(next.sessions[0]).toMatchObject({ key: 'cc:cc-session-1', sessionId: 'cc-session-1', threadId: 9, firstSeen: '2026-09-30T10:00:00.000Z' });
});

test('a promoted cc keeps its key on later scans that carry no session id (daemon restart lost the hook map)', () => {
  const promoted = run(run(emptyRegistry(), [cc()]).next, [cc({ sessionId: 'cc-session-1' })], T0 + 1_000).next;
  const { next, events } = run(promoted, [cc()], T0 + 2_000);
  expect(events).toEqual([]);
  expect(next.sessions.map((s) => s.key)).toEqual(['cc:cc-session-1']);
});

test('a new cc process in the same pane (different pid) is a different session, not the old entry', () => {
  const promoted = run(run(emptyRegistry(), [cc()]).next, [cc({ sessionId: 'cc-session-1' })], T0 + 1_000).next;
  const { next, events } = run(promoted, [cc({ pid: 201 })], T0 + 2_000);
  expect(kinds(events).sort()).toEqual(['added:cc:pane:7/%3/60', 'gone:cc:cc-session-1', 'paneReused:cc:cc-session-1>cc:pane:7/%3/60'].sort());
  const old = next.sessions.find((s) => s.key === 'cc:cc-session-1');
  expect(old?.state).toBe('gone');
  expect(old?.locators.tmux).toBeNull();
});

test('a pane locator of entry A now hosting session B clears A\'s pane and hands it to B', () => {
  const a = run(emptyRegistry(), [omp()]).next;
  // A exited; the SAME pane (same server, same pane pid) now runs another omp session.
  const { next, events } = run(a, [omp({ sessionId: SID2, sessionFile: '/s/other.jsonl', pid: 900 })], T0 + 2_000);
  expect(events).toContainEqual({ kind: 'paneReused', from: `omp:${SID}`, to: `omp:${SID2}`, paneId: '%0' });
  const old = next.sessions.find((s) => s.key === `omp:${SID}`)!;
  const fresh = next.sessions.find((s) => s.key === `omp:${SID2}`)!;
  expect(old.state).toBe('gone');
  expect(old.locators.tmux).toBeNull();
  expect(fresh.locators.tmux).toEqual({ serverPid: 7, paneId: '%0', panePid: 50 });
});

test('a pane id reused after a tmux server restart (new server pid) is never matched to the old entry', () => {
  const promoted = run(run(emptyRegistry(), [cc()]).next, [cc({ sessionId: 'cc-session-1' })], T0 + 1_000).next;
  // kill-server; a new server's %3 hosts a new claude with the SAME pid by coincidence.
  const { next } = run(promoted, [cc({ tmux: { serverPid: 8, paneId: '%3', panePid: 60 } })], T0 + 2_000);
  expect(next.sessions.find((s) => s.key === 'cc:cc-session-1')?.state).toBe('gone');
  expect(next.sessions.find((s) => s.key === 'cc:pane:8/%3/60')?.state).toBe('live');
});

test('an out-of-tmux omp is registered with no tmux locator and a harness-title name', () => {
  const { next } = run(emptyRegistry(), [omp({ tmux: null, windowName: null, cwd: '/w/gc' })]);
  expect(next.sessions[0].locators.tmux).toBeNull();
  expect(next.sessions[0].name).toEqual({ primary: 'Recover orphaned commits', secondary: null });
});

test('a session with neither a session id nor a pane cannot be keyed and is not registered', () => {
  expect(run(emptyRegistry(), [omp({ sessionId: null, sessionFile: null, tmux: null })]).next.sessions).toEqual([]);
});

test('an omp that loses its session id for one scan (lsof flake) keeps its entry by pid', () => {
  const first = run(emptyRegistry(), [omp({ tmux: null })]).next;
  const { next, events } = run(first, [omp({ tmux: null, sessionId: null, sessionFile: null })], T0 + 2_000);
  expect(events).toEqual([]);
  expect(next.sessions.map((s) => s.key)).toEqual([`omp:${SID}`]);
});

test('two sightings of one session in the same scan (abduco attached twice) register it once', () => {
  const { next } = run(emptyRegistry(), [omp(), omp({ tmux: { serverPid: 7, paneId: '%9', panePid: 99 } })]);
  expect(next.sessions).toHaveLength(1);
  expect(next.sessions[0].locators.tmux?.paneId).toBe('%0');
});

test('gone entries are kept for 30 days, then pruned', () => {
  const gone = run(run(emptyRegistry(), [omp()]).next, [], T0 + 1_000).next;
  expect(run(gone, [], T0 + GONE_RETENTION_MS - 60_000).next.sessions).toHaveLength(1);
  const { next, events } = run(gone, [], T0 + GONE_RETENTION_MS + 60_000);
  expect(next.sessions).toEqual([]);
  expect(kinds(events)).toEqual([`pruned:omp:${SID}`]);
});

test('lastSeen advances at most once a minute while nothing else changes (no per-tick rewrite)', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  expect(run(first, [omp()], T0 + 30_000).next).toEqual(first);
  expect(run(first, [omp()], T0 + 61_000).next.sessions[0].lastSeen).toBe('2026-09-30T10:01:01.000Z');
});

// Rename debounce (spec §3.2, tg-cli#460): a resolved name that differs from the
// stored one is committed only after it stayed stable for RENAME_DEBOUNCE_MS.
// `ticks` threads the in-memory pending renames through consecutive scans.
function ticks(start: Registry, steps: Array<[number, LiveSession[]]>, pending: PendingRenames = new Map()) {
  let reg = start;
  let pend = pending;
  const events: RegistryEvent[] = [];
  for (const [at, scan] of steps) {
    const r = reconcile(reg, scan, at, pend);
    reg = r.next;
    pend = r.pending;
    events.push(...r.events);
  }
  return { reg, pending: pend, events };
}

const renames = (events: RegistryEvent[]) => events.filter((e) => e.kind === 'renamed');

test('a tmux window rename commits only after it stays stable for the debounce, in place and without re-keying', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const d = RENAME_DEBOUNCE_MS;
  const early = ticks(first, [[T0 + 2_000, [omp({ windowName: 'renamed' })]], [T0 + 2_000 + d - 1, [omp({ windowName: 'renamed' })]]]);
  expect(early.reg.sessions[0].name.primary).toBe('gc-sme-backlog');
  expect(renames(early.events)).toEqual([]);
  const done = ticks(early.reg, [[T0 + 2_000 + d, [omp({ windowName: 'renamed' })]]], early.pending);
  const e = done.reg.sessions[0];
  expect(e.key).toBe(`omp:${SID}`);
  expect(e.name).toEqual({ primary: 'renamed', secondary: 'Recover orphaned commits' });
  expect(e.aliases).toEqual(['gc-sme-backlog']);
  expect(done.events).toEqual([
    {
      kind: 'renamed',
      key: `omp:${SID}`,
      from: { primary: 'gc-sme-backlog', secondary: 'Recover orphaned commits' },
      to: { primary: 'renamed', secondary: 'Recover orphaned commits' },
    },
  ]);
  expect(done.pending.size).toBe(0);
});

test('a name that flip-flops inside the debounce commits nothing; the stable change then commits exactly once', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const d = RENAME_DEBOUNCE_MS;
  const churn = ticks(first, [
    [T0 + 1_000, [omp({ windowName: 'b' })]],
    [T0 + 1_000 + d / 2, [omp()]], // back to the stored name: pending dropped
    [T0 + 1_000 + d, [omp({ windowName: 'b' })]], // pending restarts here
    [T0 + 1_000 + d + d / 2, [omp({ windowName: 'c' })]], // a different name restarts it again
    [T0 + 1_000 + 2 * d, [omp({ windowName: 'c' })]],
  ]);
  expect(churn.reg.sessions[0].name.primary).toBe('gc-sme-backlog');
  expect(renames(churn.events)).toEqual([]);
  const settled = ticks(churn.reg, [[T0 + 1_000 + 2 * d + d / 2, [omp({ windowName: 'c' })]], [T0 + 1_000 + 5 * d, [omp({ windowName: 'c' })]]], churn.pending);
  expect(renames(settled.events)).toHaveLength(1);
  expect(settled.reg.sessions[0].name.primary).toBe('c');
});

test('an omp /rename (harness title only) commits as a rename of the secondary without adding an alias', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const r = ticks(first, [[T0 + 1_000, [omp({ harnessTitle: 'New title' })]], [T0 + 1_000 + RENAME_DEBOUNCE_MS, [omp({ harnessTitle: 'New title' })]]]);
  expect(r.reg.sessions[0].name).toEqual({ primary: 'gc-sme-backlog', secondary: 'New title' });
  expect(r.reg.sessions[0].aliases).toEqual([]);
  expect(r.events.map((e) => e.kind)).toEqual(['renamed']);
});

test('an out-of-tmux omp /rename changes its primary and keeps the old title as an alias', () => {
  const first = run(emptyRegistry(), [omp({ tmux: null })]).next;
  const scan = [omp({ tmux: null, harnessTitle: 'Deploy prod' })];
  const r = ticks(first, [[T0 + 1_000, scan], [T0 + 1_000 + RENAME_DEBOUNCE_MS, scan]]);
  expect(r.reg.sessions[0].name.primary).toBe('Deploy prod');
  expect(r.reg.sessions[0].aliases).toEqual(['Recover orphaned commits']);
});

test('aliases keep the newest previous primaries first, never the current name, capped at 5', () => {
  let reg = run(emptyRegistry(), [omp({ windowName: 'n0' })]).next;
  let at = T0;
  for (const name of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n3']) {
    const scan = [omp({ windowName: name })];
    reg = ticks(reg, [[(at += 1_000), scan], [(at += RENAME_DEBOUNCE_MS), scan]]).reg;
  }
  expect(reg.sessions[0].name.primary).toBe('n3');
  expect(reg.sessions[0].aliases).toEqual(['n6', 'n5', 'n4', 'n2', 'n1']);
});

test('a session that goes gone drops its pending rename', () => {
  const first = run(emptyRegistry(), [omp()]).next;
  const r = ticks(first, [[T0 + 1_000, [omp({ windowName: 'b' })]], [T0 + 2_000, []]]);
  expect(r.pending.size).toBe(0);
});

test('entries are ordered by key so the serialized store is deterministic', () => {
  const { next } = run(emptyRegistry(), [omp({ sessionId: SID2, sessionFile: null, pid: 5 }), omp()]);
  expect(next.sessions.map((s) => s.key)).toEqual([`omp:${SID}`, `omp:${SID2}`]);
});
