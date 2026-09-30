import { expect, test } from 'bun:test';
import { distinctLabels } from '../features/tg-ctl/agent-match';
import { questionCapability } from '../features/tg-ctl/questions';
import { findAgentInPane, matchAgentCommand } from '../features/tg-ctl/discover';
import type { PaneInfo, ProcInfo } from '../features/tg-ctl/types';
import {
  describeLiveOmp,
  isLiveOmpOriginId,
  liveOmpPidFromOriginId,
  matchLiveOmpOrigin,
  ompReplyOriginMatches,
  outboundOriginPaneId,
  findLiveOmpAgents,
  isPrimaryOmpSessionFile,
  isOmpLiveSessionCommand,
  liveOmpLabel,
  liveOmpPaneId,
  matchLiveOmp,
  mergeLiveOmpCandidates,
  ompSessionFileFromBreadcrumb,
  ompTerminalId,
  parseLsofJsonlPaths,
  parseOmpSessionMeta,
  pickPrimaryOmpSessionFile,
  preferOmpApiOverTmux,
  type LiveOmpAgent,
} from '../features/tg-ctl/omp';

function pane(
  paneId: string,
  panePid: number,
  paneCommand: string,
  panePath = '/Users/u/work/review-cli',
): PaneInfo {
  return {
    sessionName: 's',
    windowIndex: 1,
    paneId,
    panePid,
    paneCommand,
    windowName: 'review',
    spawnToken: '',
    panePath,
  };
}

function proc(pid: number, ppid: number, command: string): ProcInfo {
  return { pid, ppid, command };
}

// --- 243 still classifies omp, including version-string pane_current_command ---

test('matchAgentCommand still classifies the omp TUI binary (243)', () => {
  expect(matchAgentCommand('/opt/homebrew/bin/omp')).toBe('omp');
  expect(matchAgentCommand('omp')).toBe('omp');
});

test('matchAgentCommand does not treat omp worker helpers as the user session', () => {
  expect(matchAgentCommand('/opt/homebrew/Cellar/omp/18.1.14/bin/omp __omp_worker_daemon_broker')).toBeNull();
  expect(matchAgentCommand('/opt/homebrew/bin/omp __omp_worker_js_eval_process')).toBeNull();
});

test('matchAgentCommand recognizes omp run from source via bun --preload (tg-cli#413 follow-up)', () => {
  expect(
    matchAgentCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/../src/cli.ts',
    ),
  ).toBe('omp');
});

test('matchAgentCommand recognizes bun --preload=value (equals form, verified bun accepts it)', () => {
  expect(
    matchAgentCommand(
      'bun --preload=/Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts',
    ),
  ).toBe('omp');
});

test('matchAgentCommand recognizes a bun-invoked omp PATH shim (test fixture shape)', () => {
  expect(
    matchAgentCommand(
      'bun /var/folders/xyz/T/tgctl-omp-anchor-Abc123/bin/omp acp --allow-home --cwd=/Users/u/work/review-cli',
    ),
  ).toBe('omp');
});

test('matchAgentCommand still excludes omp worker helpers when launched via bun', () => {
  // Fixtures must actually reach isBunOmpLaunch's true branch first (real
  // preload/shim shape) so the assertion exercises the !isOmpWorker guard
  // itself, not just "this doesn't look like an omp launch at all".
  expect(
    matchAgentCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts __omp_worker_daemon_broker',
    ),
  ).toBeNull();
  expect(
    matchAgentCommand(
      'bun /var/folders/xyz/T/tgctl-omp-anchor-Abc123/bin/omp __omp_worker_js_eval_process',
    ),
  ).toBeNull();
});

test('matchAgentCommand does not misclassify an unrelated bun script', () => {
  expect(matchAgentCommand('bun /Users/u/some/project/scripts/build.ts')).toBeNull();
});

test('matchAgentCommand does not misclassify a bun command with a bare "omp" argument elsewhere in argv', () => {
  // Only --preload's value or bun's direct script argument (tokens[1]) count — a
  // bare 'omp' token anywhere else in argv must never trigger a false positive
  // (caught in review: an early draft scanned every whitespace token).
  expect(matchAgentCommand('bun run scripts/deploy.ts --target omp')).toBeNull();
  expect(matchAgentCommand('bun test --grep omp')).toBeNull();
  expect(matchAgentCommand('bun x omp --help')).toBeNull();
});

test('matchAgentCommand does not misclassify a LATER --preload flag pointing at an unrelated omp-named file (review round 2)', () => {
  // bun's own --preload flag works on subcommands too (e.g. `bun test --preload
  // <file>`) — at a position OTHER than tokens[1]. Only a --preload immediately
  // at tokens[1] (the real omp launcher's exact shape) counts; a --preload
  // appearing later, pointing at an unrelated file that happens to be named
  // omp.ts, must never trigger a false positive.
  expect(matchAgentCommand('bun test --preload ./test/omp.ts')).toBeNull();
  expect(matchAgentCommand('bun run deploy.ts --preload omp.ts')).toBeNull();
});

test('matchAgentCommand recognizes the PI_TIMING chained double --preload (omp.ts stays at tokens[2])', () => {
  // scripts/omp in the oh-my-pi repo, under PI_TIMING, emits
  // `run_bun --preload "$preload" --preload "$timing_preload" "$cli" "$@"` —
  // omp's own --preload is always FIRST, so omp.ts stays at tokens[2] and the
  // timing preload at tokens[4] is never (and need not be) inspected.
  expect(
    matchAgentCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts --preload /Users/u/xp/oh-my-pi/utils/src/module-timer.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts',
    ),
  ).toBe('omp');
});

test('matchAgentCommand still finds the omp preload even if a chained --preload precedes it', () => {
  // Robustness beyond the currently-observed launcher order: the whole LEADING
  // run of --preload flags is scanned (never past the first non-preload
  // token), so a hypothetical future reordering of chained preloads still
  // resolves — without reopening the later-position false-positive class
  // (bun test --preload ./test/omp.ts stays null: tokens[1] is 'test', not
  // '--preload', so the scan never starts).
  expect(
    matchAgentCommand(
      'bun --preload /Users/u/xp/oh-my-pi/utils/src/module-timer.ts --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts',
    ),
  ).toBe('omp');
});

test('finds omp in a pane whose pane_current_command is a version string, not omp', () => {
  // Claude Code panes report a version as pane_current_command; omp TUI may too.
  // Discovery walks the process tree, not the pane command string.
  const p = pane('%9', 100, '18.1.14');
  const procs = [proc(100, 1, '-zsh'), proc(101, 100, '/opt/homebrew/bin/omp')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'omp', pid: 101 });
});

// --- live discovery without tmux; name from omp itself ---

test('isOmpLiveSessionCommand keeps the interactive TUI and drops acp/print/workers', () => {
  expect(isOmpLiveSessionCommand('/opt/homebrew/bin/omp')).toBe(true);
  expect(isOmpLiveSessionCommand('omp --cwd /tmp')).toBe(true);
  expect(isOmpLiveSessionCommand('omp acp')).toBe(false);
  expect(isOmpLiveSessionCommand('omp acp --no-session')).toBe(false);
  expect(isOmpLiveSessionCommand('omp -p "hi"')).toBe(false);
  expect(isOmpLiveSessionCommand('omp --print hi')).toBe(false);
  expect(isOmpLiveSessionCommand('omp __omp_worker_daemon_broker')).toBe(false);
});

test('isOmpLiveSessionCommand drops bun-invoked acp/print/workers too (tg-cli#413 follow-up)', () => {
  // The daemon spawns its own ACP child as exactly one of these bun shapes on a
  // machine where omp runs from source or via a PATH shim. Now that
  // matchAgentCommand classifies them as 'omp', this exclusion is the ONLY thing
  // stopping findLiveOmpAgents from listing the daemon's own ACP child as a live
  // agent and routing inbound Telegram messages into it.
  expect(
    isOmpLiveSessionCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts acp --no-session',
    ),
  ).toBe(false);
  expect(
    isOmpLiveSessionCommand(
      'bun /var/folders/xyz/T/tgctl-omp-anchor-Abc123/bin/omp acp --allow-home --cwd=/Users/u/work/review-cli',
    ),
  ).toBe(false);
  expect(
    isOmpLiveSessionCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts -p --auto-approve',
    ),
  ).toBe(false);
  expect(
    isOmpLiveSessionCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts __omp_worker_daemon_broker',
    ),
  ).toBe(false);
  // The interactive bun-source shape itself DOES count as a live session.
  expect(
    isOmpLiveSessionCommand(
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts',
    ),
  ).toBe(true);
});

test('isPrimaryOmpSessionFile matches the session jsonl, never a nested subagent transcript', () => {
  const primary =
    '/Users/u/.omp/agent/sessions/-xp-review-cli/2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl';
  const nested =
    '/Users/u/.omp/agent/sessions/-xp-review-cli/2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37/Review309.jsonl';
  expect(isPrimaryOmpSessionFile(primary)).toBe(true);
  expect(isPrimaryOmpSessionFile(nested)).toBe(false);
  expect(isPrimaryOmpSessionFile('/tmp/notes.jsonl')).toBe(false);
});

test('parseOmpSessionMeta reads title and id from omp session jsonl, not cwd', () => {
  const jsonl = [
    '{"type":"title","v":1,"title":"Fix review-cli from omp","source":"auto"}',
    '{"type":"session","version":3,"id":"01a07d8e-c12c-7433-903d-e98726bfda37","cwd":"/Users/u/xp/review-cli","title":"Fix review-cli session issues"}',
    '{"type":"title_change","title":"Fix review-cli from omp"}',
  ].join('\n');
  const meta = parseOmpSessionMeta(jsonl);
  expect(meta.title).toBe('Fix review-cli from omp');
  expect(meta.sessionId).toBe('01a07d8e-c12c-7433-903d-e98726bfda37');
  expect(meta.cwd).toBe('/Users/u/xp/review-cli');
});


test('parseOmpSessionMeta reads title_change after the former 64KB truncation boundary', () => {
  const padding = '{"type":"message","content":"' + 'x'.repeat(70000) + '"}\n';
  const jsonl = [
    '{"type":"title","v":1,"title":"Stale Title","source":"auto"}',
    padding,
    '{"type":"title_change","title":"Fresh Title After Boundary"}',
  ].join('\n');
  expect(jsonl.length).toBeGreaterThan(64_000);
  const meta = parseOmpSessionMeta(jsonl);
  expect(meta.title).toBe('Fresh Title After Boundary');
});

test('parseLsofJsonlPaths collects n-paths ending in .jsonl', () => {
  const out = [
    'p7103',
    'fcwd',
    'n/Users/u/work/landing',
    'n/Users/u/.omp/agent/sessions/x/2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl',
    'n/Users/u/.omp/agent/sessions/x/2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37/Review.jsonl',
  ].join('\n');
  const paths = parseLsofJsonlPaths(out);
  expect(paths).toHaveLength(2);
  expect(paths[0]).toContain('01a07d8e');
});

// tg-cli#487: an omp whose main jsonl is not held open (only subagent transcripts
// are) must still resolve its session, or the registry keys it omp:pane:… forever.
const SESSIONS = '/Users/u/.omp/agent/sessions/-xp-cal';
const MAIN = `${SESSIONS}/2026-09-27T11-50-27-262Z_01a0e2b3-c4be-7358-abce-5cb0666dc692.jsonl`;
const SUBDIR = `${SESSIONS}/2026-09-27T11-50-27-262Z_01a0e2b3-c4be-7358-abce-5cb0666dc692`;

test('pickPrimaryOmpSessionFile derives the main session from open subagent transcripts', () => {
  expect(pickPrimaryOmpSessionFile([`${SUBDIR}/FixAboutMe.jsonl`, `${SUBDIR}/Ship745/Ship745.Fix741Findings.jsonl`])).toBe(MAIN);
});

test('pickPrimaryOmpSessionFile prefers a held-open main jsonl over a derived one', () => {
  const other = `${SESSIONS}/2026-09-28T01-00-00-000Z_01a0ffff-0000-7000-8000-000000000000.jsonl`;
  expect(pickPrimaryOmpSessionFile([`${SUBDIR}/FixAboutMe.jsonl`, other])).toBe(other);
});

test('pickPrimaryOmpSessionFile fails closed when subagent transcripts span two sessions', () => {
  const otherDir = `${SESSIONS}/2026-09-28T01-00-00-000Z_01a0ffff-0000-7000-8000-000000000000`;
  expect(pickPrimaryOmpSessionFile([`${SUBDIR}/A.jsonl`, `${otherDir}/B.jsonl`])).toBeNull();
  expect(pickPrimaryOmpSessionFile(['/tmp/notes.jsonl'])).toBeNull();
});

test('ompTerminalId mirrors omp getTerminalId: the tty first, tmux pane only without one', () => {
  expect(ompTerminalId({ tty: 'ttys009', paneId: '%5' })).toBe('ttys009');
  expect(ompTerminalId({ tty: 'pts/3', paneId: null })).toBe('pts-3');
  expect(ompTerminalId({ tty: null, paneId: '%5' })).toBe('tmux-%5');
  expect(ompTerminalId({ tty: null, paneId: null })).toBeNull();
});

test('ompSessionFileFromBreadcrumb returns the recorded session only for the same cwd', () => {
  const crumb = `/Users/u/xp/cal\n${MAIN}\ncwdstat 16777230 141596355\n`;
  expect(ompSessionFileFromBreadcrumb(crumb, '/Users/u/xp/cal')).toBe(MAIN);
  // Another omp later ran from a different directory on this terminal: not ours.
  expect(ompSessionFileFromBreadcrumb(crumb, '/Users/u/xp/other')).toBeNull();
  // Unknown process cwd: the breadcrumb cannot be tied to this process.
  expect(ompSessionFileFromBreadcrumb(crumb, null)).toBeNull();
  expect(ompSessionFileFromBreadcrumb('/Users/u/xp/cal\n/tmp/notes.jsonl\n', '/Users/u/xp/cal')).toBeNull();
  expect(ompSessionFileFromBreadcrumb('', '/Users/u/xp/cal')).toBeNull();
  // `--session <relative>`: omp records the file relative to the breadcrumb's cwd.
  const rel = MAIN.slice(MAIN.lastIndexOf('/') + 1);
  expect(ompSessionFileFromBreadcrumb(`/Users/u/xp/cal\n${rel}\n`, '/Users/u/xp/cal')).toBe(`/Users/u/xp/cal/${rel}`);
});

test('findLiveOmpAgents lists interactive omp both in and out of tmux; workers and acp are dropped', () => {
  const panes = [pane('%1', 200, 'omp', '/Users/u/work/in-tmux')];
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(200, 1, '/opt/homebrew/bin/omp'), // in tmux
    proc(300, 1, '/opt/homebrew/bin/omp'), // outside tmux
    proc(301, 300, '/opt/homebrew/bin/omp __omp_worker_daemon_broker'),
    proc(400, 1, '/opt/homebrew/bin/omp acp --no-session'),
    proc(500, 1, '/opt/homebrew/bin/omp -p hi'),
  ];
  const ttyByPid = new Map<number, string>([
    [200, 'ttys001'],
    [300, 'ttys004'],
    [400, '?'],
    [500, 'ttys009'],
  ]);
  const agents = findLiveOmpAgents(panes, procs, ttyByPid);
  const pids = agents.map((a) => a.pid).sort((a, b) => a - b);
  expect(pids).toEqual([200, 300]);
  expect(agents.find((a) => a.pid === 200)?.paneId).toBe('%1');
  expect(agents.find((a) => a.pid === 300)?.paneId).toBeNull();
});

test('findLiveOmpAgents includes a headless omp session with neither a tty nor a tmux pane (tg-cli#405 follow-up)', () => {
  const panes: PaneInfo[] = [];
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(700, 1, '/opt/homebrew/bin/omp'), // headless: no tty, no tmux pane
  ];
  const ttyByPid = new Map<number, string>([[700, '??']]);
  const agents = findLiveOmpAgents(panes, procs, ttyByPid);
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ pid: 700, paneId: null, tty: null });
});

test('findLiveOmpAgents includes a headless omp session entirely absent from the tty map', () => {
  const panes: PaneInfo[] = [];
  const procs = [proc(701, 1, '/opt/homebrew/bin/omp')];
  const agents = findLiveOmpAgents(panes, procs, new Map());
  expect(agents).toHaveLength(1);
  expect(agents[0].paneId).toBeNull();
});

test('findLiveOmpAgents discovers omp run from source via bun --preload, no tty, no tmux pane (tg-cli#413 follow-up)', () => {
  const panes: PaneInfo[] = [];
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(
      73711,
      1,
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/../src/cli.ts',
    ),
  ];
  const agents = findLiveOmpAgents(panes, procs, new Map());
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ pid: 73711, paneId: null, tty: null });
});

test('liveOmpLabel (omp in no tmux pane): title, else cwd project, else a short session id/pid (tg-cli#455)', () => {
  const titled: LiveOmpAgent = {
    pid: 7,
    cwd: '/Users/u/xp/review-cli',
    sessionFile: '/tmp/s.jsonl',
    sessionId: '01abc',
    title: 'Fix review-cli from omp',
    paneId: null,
    tty: 'ttys004',
  };
  expect(liveOmpLabel(titled)).toBe('Fix review-cli from omp');
  expect(liveOmpLabel({ ...titled, title: null })).toBe('review-cli');
  expect(liveOmpLabel({ ...titled, title: null, cwd: null })).toBe('omp · 01abc');
  expect(liveOmpLabel({ ...titled, title: null, cwd: null, sessionId: null })).toBe('omp · 7');
});

test('matchLiveOmp matches the omp title, not a coincidental other cwd', () => {
  const a: LiveOmpAgent = {
    pid: 7,
    cwd: '/Users/u/xp/review-cli',
    sessionFile: null,
    sessionId: '01a07d8e-c12c-7433-903d-e98726bfda37',
    title: 'Fix review-cli from omp',
    paneId: null,
    tty: 'ttys004',
  };
  const other: LiveOmpAgent = {
    pid: 8,
    cwd: '/Users/u/work/landing',
    sessionFile: null,
    sessionId: '01ffff',
    title: 'Ship landing',
    paneId: '%2',
    tty: 'ttys001',
  };
  expect(matchLiveOmp('Fix review-cli from omp', [a, other]).map((x) => x.pid)).toEqual([7]);
  expect(matchLiveOmp('01a07d8e', [a, other]).map((x) => x.pid)).toEqual([7]);
});

test('matchLiveOmp matches untitled omp by pid and unique cwd basename', () => {
  const untitled: LiveOmpAgent = {
    pid: 33378,
    cwd: '/Users/u/xp/tg-cli',
    sessionFile: null,
    sessionId: null,
    title: null,
    paneId: null,
    tty: 'ttys022',
  };
  expect(matchLiveOmp('33378', [untitled]).map((x) => x.pid)).toEqual([33378]);
  expect(matchLiveOmp('pid 33378', [untitled]).map((x) => x.pid)).toEqual([33378]);
  expect(matchLiveOmp('tg-cli', [untitled]).map((x) => x.pid)).toEqual([33378]);
});

test('matchLiveOmp: /agent landing hits unique conloca-landing cwd despite unrelated title', () => {
  // Ask 108 / tg-cli#342: live Hyper omp is titled "Save requests…" in
  // /Users/ultra/work/conloca-landing. Alex types /agent landing — exact title
  // and exact basename both miss.
  const landing: LiveOmpAgent = {
    pid: 99240,
    cwd: '/Users/u/work/conloca-landing',
    sessionFile: null,
    sessionId: '01land',
    title: 'Save requests to memory/TodoList',
    paneId: null,
    tty: 'ttys021',
  };
  const rig: LiveOmpAgent = {
    pid: 89653,
    cwd: '/Users/u/xp/rig-cli',
    sessionFile: null,
    sessionId: '01rig',
    title: 'Finish rig-zerobug session work',
    paneId: null,
    tty: 'ttys051',
  };
  const review: LiveOmpAgent = {
    pid: 61335,
    cwd: '/Users/u/xp/review-cli',
    sessionFile: null,
    sessionId: '01rev',
    title: 'Fix rig ecosystem issues autonomously',
    paneId: null,
    tty: 'ttys032',
  };
  const fleet = [landing, rig, review];
  expect(matchLiveOmp('landing', fleet).map((x) => x.pid)).toEqual([99240]);
  expect(matchLiveOmp('conloca-landing', fleet).map((x) => x.pid)).toEqual([99240]);
  expect(matchLiveOmp('rig-fable', fleet).map((x) => x.pid)).toEqual([89653]);
  expect(matchLiveOmp('rig-cli', fleet).map((x) => x.pid)).toEqual([89653]);
  // prefix of an undivided basename still must not route (dev → development)
  const dev: LiveOmpAgent = { ...review, pid: 1, cwd: '/x/development', title: 'Working on tests' };
  expect(matchLiveOmp('dev', [dev, landing]).map((x) => x.pid)).toEqual([]);
  // two rig-* cwds: rig-fable is ambiguous, must not guess
  const rigTools: LiveOmpAgent = { ...rig, pid: 2, cwd: '/Users/u/xp/rig-tools', title: 'Other rig' };
  expect(matchLiveOmp('rig-fable', [rig, rigTools]).map((x) => x.pid)).toEqual([]);
});

test('matchLiveOmp: --name wins over title and cwd token', () => {
  const named: LiveOmpAgent = {
    pid: 9,
    cwd: '/Users/u/work/conloca-landing',
    sessionFile: null,
    sessionId: null,
    title: 'Save requests to memory/TodoList',
    paneId: null,
    tty: 'ttys021',
    name: 'landing',
  };
  const other: LiveOmpAgent = {
    pid: 10,
    cwd: '/Users/u/work/landing-site',
    sessionFile: null,
    sessionId: null,
    title: 'Other',
    paneId: null,
    tty: 'ttys022',
  };
  expect(matchLiveOmp('landing', [named, other]).map((x) => x.pid)).toEqual([9]);
});

test('mergeLiveOmpCandidates adds out-of-tmux omp to the picker; skips ones already in a pane', () => {
  const tmux = [
    {
      paneId: '%1',
      sessionName: 's',
      windowIndex: 1,
      windowName: 'claude',
      agent: 'claude' as const,
      panePath: '/Users/u/work/a',
    },
  ];
  const live: LiveOmpAgent[] = [
    {
      pid: 200,
      cwd: '/Users/u/work/in-tmux',
      sessionFile: null,
      sessionId: null,
      title: 'In tmux omp',
      paneId: '%1',
      tty: 'ttys001',
    },
    {
      pid: 33378,
      cwd: '/Users/u/xp/tg-cli',
      sessionFile: null,
      sessionId: null,
      title: null,
      paneId: null,
      tty: 'ttys022',
    },
  ];
  const merged = mergeLiveOmpCandidates(tmux, live);
  expect(merged.some((c) => c.agent === 'omp' && c.paneId === 'omp:33378')).toBe(true);
  expect(merged.filter((c) => c.agent === 'omp')).toHaveLength(1);
  const untitled = merged.find((c) => c.paneId === 'omp:33378')!;
  expect(untitled.windowName).toBe('tg-cli');
  expect(untitled.panePath).toBe('/Users/u/xp/tg-cli');
  expect(distinctLabels([untitled])).toEqual(['tg-cli · omp']);
});

test('mergeLiveOmpCandidates: an omp in a tmux pane keeps the tmux window name; its title is the secondary label (tg-cli#455)', () => {
  const tmux = [
    {
      paneId: '%0',
      sessionName: 'main',
      windowIndex: 1,
      windowName: 'gc-sme-backlog',
      agent: 'omp' as const,
      panePath: '/Users/u/xp/sme-archiving-gc',
      paneTitle: 'π ⠹ Stale pane title',
    },
  ];
  const live: LiveOmpAgent[] = [
    {
      pid: 57616,
      cwd: '/Users/u/xp/sme-archiving-gc',
      sessionFile: null,
      sessionId: '01a0c543-1ac1-7000-8000-000000000000',
      title: 'Recover orphaned commits, verify PRs',
      paneId: '%0',
      tty: null,
    },
  ];
  const merged = mergeLiveOmpCandidates(tmux, live);
  expect(merged).toHaveLength(1);
  expect(merged[0].windowName).toBe('gc-sme-backlog');
  expect(distinctLabels(merged)).toEqual(['gc-sme-backlog · Recover orphaned commits, verify PRs']);
});

test('findLiveOmpAgents: an omp under `abduco -A omp-restored-*` gets the pane of its abduco client, not "no tmux" (tg-cli#454)', () => {
  const panes = [pane('%0', 2929, 'abduco', '/Users/u/xp/sme-archiving-gc')];
  const rigOmp =
    'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/../src/cli.ts --resume /s.jsonl';
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(2929, 1, '/bin/zsh -l'),
    proc(57614, 2929, 'abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl'),
    proc(57615, 1, 'abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl'),
    proc(57616, 57615, rigOmp),
  ];
  const agents = findLiveOmpAgents(panes, procs, new Map());
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ pid: 57616, paneId: '%0' });
  // The reply-route origin check keyed on the pane now finds it (was null → false "gone" picker).
  expect(matchLiveOmpOrigin('%0', agents)?.pid).toBe(57616);
});

test('preferOmpApiOverTmux is true for omp even when a pane exists — never send-keys', () => {
  expect(preferOmpApiOverTmux('omp')).toBe(true);
  expect(preferOmpApiOverTmux('claude')).toBe(false);
  expect(preferOmpApiOverTmux('opencode')).toBe(false);
});

test('questionCapability(omp) is buttons — native hook forwarding, not the tmux floor', () => {
  expect(questionCapability('omp')).toBe('buttons');
});

test('describeLiveOmp names the real transport: bridge only with a verified original-process endpoint (tg-cli#469)', () => {
  const base: LiveOmpAgent = { pid: 7103, cwd: '/p', sessionFile: null, sessionId: null, title: 'Fix', paneId: null, tty: null };
  expect(describeLiveOmp({ ...base, instanceId: 'gen-1' })).toContain('omp — bridge (');
  expect(describeLiveOmp(base)).toContain('omp — NO bridge (');
  expect(describeLiveOmp(base)).not.toContain('ACP');
});

// --- out-of-tmux reply origin (tg-cli#339): routes must stamp omp:<pid> ---

test('outboundOriginPaneId stamps omp:<pid> when there is no tmux pane', () => {
  expect(outboundOriginPaneId({ tmuxPane: null, ompAncestorPid: 7103 })).toBe('omp:7103');
  expect(outboundOriginPaneId({ tmuxPane: '', ompAncestorPid: 7103 })).toBe('omp:7103');
  expect(outboundOriginPaneId({ tmuxPane: '%4', ompAncestorPid: 7103 })).toBe('%4');
  expect(outboundOriginPaneId({ tmuxPane: null, ompAncestorPid: null })).toBeNull();
  expect(outboundOriginPaneId({})).toBeNull();
});

test('isLiveOmpOriginId / liveOmpPidFromOriginId parse the synthetic origin', () => {
  expect(isLiveOmpOriginId('omp:7103')).toBe(true);
  expect(liveOmpPidFromOriginId('omp:7103')).toBe(7103);
  expect(isLiveOmpOriginId('%4')).toBe(false);
  expect(liveOmpPidFromOriginId('%4')).toBeNull();
  expect(liveOmpPidFromOriginId('omp:nope')).toBeNull();
  expect(liveOmpPaneId(7103)).toBe('omp:7103');
});

test('matchLiveOmpOrigin finds the live process for an omp:<pid> reply origin', () => {
  const live: LiveOmpAgent[] = [
    {
      pid: 7103,
      cwd: '/Users/u/work/review-cli',
      sessionFile: '/tmp/s.jsonl',
      sessionId: '01a07d8e-c12c-7433-903d-e98726bfda37',
      title: 'ReviewFix',
      paneId: null,
      tty: 'ttys004',
    },
    {
      pid: 9000,
      cwd: '/Users/u/other',
      sessionFile: null,
      sessionId: null,
      title: 'Other',
      paneId: '%1',
      tty: 'ttys001',
    },
  ];
  expect(matchLiveOmpOrigin('omp:7103', live)?.title).toBe('ReviewFix');
  expect(matchLiveOmpOrigin('%1', live)?.pid).toBe(9000);
  expect(matchLiveOmpOrigin('omp:1', live)).toBeNull();
});

test('ompReplyOriginMatches trusts omp:<pid> even when recorded cwd is /tmp', () => {
  const live = {
    pid: 7103,
    cwd: '/Users/u/work/review-cli',
    sessionFile: null,
    sessionId: null,
    title: 'ReviewFix',
    paneId: null,
    tty: 'ttys004',
  };
  expect(ompReplyOriginMatches({ paneId: 'omp:7103', cwd: '/tmp' }, live)).toBe(true);
  expect(ompReplyOriginMatches({ paneId: 'omp:9999', cwd: '/tmp' }, live)).toBe(false);
  expect(ompReplyOriginMatches({ paneId: '%1', cwd: '/Users/u/work/review-cli' }, { ...live, paneId: '%1' })).toBe(true);
  expect(ompReplyOriginMatches({ paneId: '%1', cwd: '/tmp' }, { ...live, paneId: '%1' })).toBe(false);
});

