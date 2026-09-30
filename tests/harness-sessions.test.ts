import { expect, test } from 'bun:test';
import {
  bindHookSessions,
  hookSightingOf,
  listLiveSessions,
  migrationLivePanes,
  scanIsTrustworthy,
  serverPidAcross,
  type HarnessScanInput,
} from '../features/tg-ctl/harness-sessions';
import { emptyRegistry, reconcile } from '../features/tg-ctl/session-registry';
import type { PaneInfo, ProcInfo } from '../features/tg-ctl/types';

// The harness adapter boundary (spec §2.2): discovery panes + live omp + hook-captured
// cc/codex ids → one LiveSession per top-level session. Fixture shapes mirror the
// live 2026-09-29 process table (tg-cli#454).

const SID = '01a0c543-1ac1-7433-903d-e98726bfda37';

function pane(paneId: string, panePid: number, windowName: string, panePath: string): PaneInfo {
  return { sessionName: 'main', windowIndex: 1, paneId, panePid, paneCommand: 'zsh', windowName, spawnToken: '', panePath };
}

const procs: ProcInfo[] = [
  { pid: 1, ppid: 0, command: '/sbin/launchd' },
  // %0: abduco client → pid-1 abduco server → omp
  { pid: 2929, ppid: 1, command: '/bin/zsh -l' },
  { pid: 57614, ppid: 2929, command: 'abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl' },
  { pid: 57615, ppid: 1, command: 'abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl' },
  { pid: 57616, ppid: 57615, command: 'omp --resume /s.jsonl' },
  // %3: claude code
  { pid: 3000, ppid: 1, command: '/bin/zsh -l' },
  { pid: 3001, ppid: 3000, command: 'claude --dangerously-skip-permissions' },
  // %4: codex
  { pid: 4000, ppid: 1, command: '/bin/zsh -l' },
  { pid: 4001, ppid: 4000, command: 'codex' },
  // %5: a plain shell (no agent)
  { pid: 5000, ppid: 1, command: '/bin/zsh -l' },
  // out-of-tmux omp and an out-of-tmux claude
  { pid: 6001, ppid: 1, command: 'omp' },
  { pid: 7001, ppid: 1, command: 'claude' },
];

function input(over: Partial<HarnessScanInput> = {}): HarnessScanInput {
  return {
    panes: [
      pane('%0', 2929, 'gc-sme-backlog', '/w/gc'),
      pane('%3', 3000, 'rig', '/w/rig'),
      pane('%4', 4000, '2.1.150', '/w/codex-proj'),
      pane('%5', 5000, 'zsh', '/w'),
    ],
    procs,
    serverPid: 77,
    paneTitles: new Map([['%3', '✳ Fix the hooks']]),
    omp: [
      { pid: 57616, cwd: '/w/gc', sessionFile: `/s/x_${SID}.jsonl`, sessionId: SID, title: 'Recover orphaned commits', paneId: '%0', tty: null },
      { pid: 6001, cwd: '/w/headless', sessionFile: '/s/h.jsonl', sessionId: 'headless-sid', title: null, paneId: null, tty: null, durableSession: null },
    ],
    hookSessions: [],
    ...over,
  };
}

test('every tmux omp/cc/codex and every out-of-tmux omp is listed once; plain shells and out-of-tmux cc are not', () => {
  const out = listLiveSessions(input());
  expect(out.map((s) => `${s.harness}:${s.pid}`)).toEqual(['omp:57616', 'cc:3001', 'codex:4001', 'omp:6001']);
});

test('an abduco-wrapped omp carries both its tmux locator and its durable abduco session', () => {
  const [abduco] = listLiveSessions(input());
  expect(abduco).toMatchObject({
    harness: 'omp',
    sessionId: SID,
    tmux: { serverPid: 77, paneId: '%0', panePid: 2929 },
    durableSession: 'omp-restored-01a0c5431ac1',
    windowName: 'gc-sme-backlog',
    harnessTitle: 'Recover orphaned commits',
    cwd: '/w/gc',
  });
});

test('the endpoint durableSession wins over the abduco walk', () => {
  const i = input();
  i.omp[0] = { ...i.omp[0], durableSession: 'from-endpoint' };
  expect(listLiveSessions(i)[0].durableSession).toBe('from-endpoint');
});

test('a cc pane has no session id until a hook from that exact process names it', () => {
  expect(listLiveSessions(input()).find((s) => s.harness === 'cc')?.sessionId).toBeNull();
  const hooked = listLiveSessions(input({ hookSessions: [{ harness: 'cc', paneId: '%3', pid: 3001, sessionId: 'cc-1' }] }));
  expect(hooked.find((s) => s.harness === 'cc')).toMatchObject({ sessionId: 'cc-1', paneTitle: '✳ Fix the hooks' });
});

test('a hook sighting from an earlier process in the same pane does not name the new one', () => {
  const out = listLiveSessions(input({ hookSessions: [{ harness: 'cc', paneId: '%3', pid: 2999, sessionId: 'cc-old' }] }));
  expect(out.find((s) => s.harness === 'cc')?.sessionId).toBeNull();
});

test('the out-of-tmux omp has no tmux locator', () => {
  expect(listLiveSessions(input()).find((s) => s.pid === 6001)).toMatchObject({ tmux: null, windowName: null, cwd: '/w/headless' });
});

test('an abduco session attached from two panes is listed once (first pane wins)', () => {
  const i = input();
  i.panes.push(pane('%9', 9000, 'second', '/w/gc'));
  i.procs = [...procs, { pid: 9000, ppid: 1, command: '/bin/zsh' }, { pid: 9001, ppid: 9000, command: 'abduco -A omp-restored-01a0c5431ac1' }];
  const out = listLiveSessions(i).filter((s) => s.pid === 57616);
  expect(out).toHaveLength(1);
  expect(out[0].tmux?.paneId).toBe('%0');
});

test('the listing reconciles into one registry entry per session (S1 acceptance shape)', () => {
  const { next } = reconcile(emptyRegistry(), listLiveSessions(input()), Date.parse('2026-09-30T10:00:00Z'));
  expect(next.sessions.map((s) => s.key)).toEqual([
    'cc:pane:77/%3/3000',
    'codex:pane:77/%4/4000',
    `omp:${SID}`,
    'omp:headless-sid',
  ]);
});

test('scan trust: an empty ps read, or panes without a tmux server pid, is not a scan', () => {
  const reg = emptyRegistry();
  expect(scanIsTrustworthy(reg, { panes: input().panes, procs: [], serverPid: 77 })).toBe(false);
  expect(scanIsTrustworthy(reg, { panes: input().panes, procs, serverPid: null })).toBe(false);
  expect(scanIsTrustworthy(reg, { panes: input().panes, procs, serverPid: 77 })).toBe(true);
});

test('scan trust: zero panes while a registered tmux session\'s process is still alive is a tmux flake', () => {
  const { next } = reconcile(emptyRegistry(), listLiveSessions(input()), 0);
  expect(scanIsTrustworthy(next, { panes: [], procs, serverPid: null })).toBe(false);
  // Every tmux-hosted process is gone too: the tmux server really went away.
  const survivors = procs.filter((p) => ![57616, 3001, 4001].includes(p.pid));
  expect(scanIsTrustworthy(next, { panes: [], procs: survivors, serverPid: null })).toBe(true);
});

test('a cc/codex ask carrying a session id and a pane is a hook sighting; nothing else is', () => {
  expect(hookSightingOf({ agent: 'claude', paneId: '%3', origin: { sessionId: 'cc-1' } })).toEqual({ harness: 'cc', sessionId: 'cc-1', paneId: '%3' });
  expect(hookSightingOf({ agent: 'codex', paneId: '%4', origin: { sessionId: 'cx-1' } })).toEqual({ harness: 'codex', sessionId: 'cx-1', paneId: '%4' });
  expect(hookSightingOf({ agent: 'omp', paneId: '%0', origin: { sessionId: SID } })).toBeNull();
  expect(hookSightingOf({ agent: 'claude', paneId: '%3' })).toBeNull();
  expect(hookSightingOf({ agent: 'claude', origin: { sessionId: 'cc-1' } })).toBeNull();
});

test('a pending sighting binds to the agent pid its pane hosts now; a pane with no agent (or no pane) binds nothing', () => {
  const bound = bindHookSessions([], [
    { harness: 'cc', sessionId: 'cc-1', paneId: '%3' },
    { harness: 'codex', sessionId: 'cx-1', paneId: '%4' },
    { harness: 'cc', sessionId: 'shell', paneId: '%5' },
    { harness: 'cc', sessionId: 'gone', paneId: '%42' },
  ], input().panes, procs);
  expect(bound).toEqual([
    { harness: 'cc', sessionId: 'cc-1', paneId: '%3', pid: 3001 },
    { harness: 'codex', sessionId: 'cx-1', paneId: '%4', pid: 4001 },
  ]);
});

test('a bound sighting is forgotten once its process exits; the newest sighting per pane+pid wins', () => {
  const earlier = [
    { harness: 'cc' as const, sessionId: 'cc-exited', paneId: '%3', pid: 2999 },
    { harness: 'cc' as const, sessionId: 'cc-1', paneId: '%3', pid: 3001 },
  ];
  expect(bindHookSessions(earlier, [], input().panes, procs)).toEqual([earlier[1]]);
  expect(bindHookSessions(earlier, [{ harness: 'cc', sessionId: 'cc-2', paneId: '%3' }], input().panes, procs)).toEqual([
    { harness: 'cc', sessionId: 'cc-2', paneId: '%3', pid: 3001 },
  ]);
});

test('migration pane liveness: live panes, unknown with no tmux server, wait on an empty answer from a live server', () => {
  expect(migrationLivePanes({ panes: input().panes, serverPid: 77 })).toEqual(new Set(['%0', '%3', '%4', '%5']));
  expect(migrationLivePanes({ panes: [], serverPid: null })).toBeNull();
  expect(migrationLivePanes({ panes: [], serverPid: 77 })).toBe('wait');
});

test('the tmux server pid read on both sides of the pane snapshot names that snapshot only when both reads agree', () => {
  expect(serverPidAcross(77, 77)).toBe(77);
  expect(serverPidAcross(77, 91)).toBeNull(); // the server restarted mid-snapshot
  expect(serverPidAcross(null, 91)).toBeNull(); // a server came up mid-snapshot
  expect(serverPidAcross(null, null)).toBeNull(); // no server
});
