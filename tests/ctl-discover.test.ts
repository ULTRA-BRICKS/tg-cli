import { expect, test } from 'bun:test';
import {
  parsePaneList,
  parseProcList,
  matchAgentCommand,
  findAgentInPane,
  findAgentInAncestry,
  pickTargetPane,
  pickTargetPaneFromSet,
  panesWithRetry,
  abducoSessionName,
  paneIdByPid,
  parsePaneTitles,
} from '../features/tg-ctl/discover';
import type { PaneInfo, ProcInfo } from '../features/tg-ctl/types';

// --- fixtures ---

function pane(
  sessionName: string,
  windowIndex: number,
  paneId: string,
  panePid: number,
  paneCommand: string,
  panePath: string,
  windowName = '',
  spawnToken = '',
): PaneInfo {
  return { sessionName, windowIndex, paneId, panePid, paneCommand, windowName, spawnToken, panePath };
}

function proc(pid: number, ppid: number, command: string): ProcInfo {
  return { pid, ppid, command };
}

// --- parsePaneList ---

test('parsePaneList parses tab-separated pane lines (incl. window_name)', () => {
  // 7 fields: …command \t window_name \t path. The window name carries the
  // user-set label ("rig", "3d") used by the /agent picker (tg-cli#75 fix C).
  const out = 'main\t0\t%0\t100\t-zsh\trig\t/Users/ultra/work\nside\t2\t%5\t200\topencode\t3d\t/tmp/x\n';
  expect(parsePaneList(out)).toEqual([
    pane('main', 0, '%0', 100, '-zsh', '/Users/ultra/work', 'rig'),
    pane('side', 2, '%5', 200, 'opencode', '/tmp/x', '3d'),
  ]);
});

test('parsePaneList keeps paths with spaces intact (tabs protect them)', () => {
  const out = 'main\t1\t%3\t4242\t2.1.150\tapi-bot\t/Users/ultra/my project/sub dir\n';
  const panes = parsePaneList(out);
  expect(panes).toHaveLength(1);
  expect(panes[0].panePath).toBe('/Users/ultra/my project/sub dir');
  expect(panes[0].paneCommand).toBe('2.1.150'); // cc reports its VERSION here
  expect(panes[0].windowName).toBe('api-bot'); // a fixed field BEFORE the greedy path
});

test('parsePaneList reads the 8-field @tg_spawn_token field (forum-topics increment 4)', () => {
  // 8 fields: …window_name \t @tg_spawn_token \t path. The token is '' when the option is unset.
  const out =
    'main\t0\t%0\t100\t-zsh\trig\t113-9-7\t/Users/ultra/work\n' + 'side\t2\t%5\t200\topencode\t3d\t\t/tmp/x\n';
  const panes = parsePaneList(out);
  expect(panes).toHaveLength(2);
  expect(panes[0].spawnToken).toBe('113-9-7');
  expect(panes[0].panePath).toBe('/Users/ultra/work');
  expect(panes[1].spawnToken).toBe(''); // unset → empty
  expect(panes[1].panePath).toBe('/tmp/x');
});

test('parsePaneList reads a flat /new spawn token without shifting the cwd', () => {
  const out = 'main\t1\t%7\t4277\tcodex\tnewwin\tnew-n1-1700000000\t/Users/ultra/project\n';
  const panes = parsePaneList(out);
  expect(panes).toHaveLength(1);
  expect(panes[0].spawnToken).toBe('new-n1-1700000000');
  expect(panes[0].panePath).toBe('/Users/ultra/project');
});

test('parsePaneList keeps a token + a path-with-tab intact (token fixed, path greedy)', () => {
  // Topic token shape is `<threadId>-<unixSec>-<nonce>` (digits + dashes); path is the greedy tail.
  const out = 'main\t1\t%3\t4242\t2.1.150\tapi-bot\t113-1700000000-5\t/Users/ultra/my\tproject\n';
  const panes = parsePaneList(out);
  expect(panes).toHaveLength(1);
  expect(panes[0].spawnToken).toBe('113-1700000000-5');
  expect(panes[0].panePath).toBe('/Users/ultra/my\tproject'); // greedy tail rejoins the tab
});

test('parsePaneList does NOT misread a legacy 7-field path-with-tab as a token (codex r12 P2)', () => {
  // Legacy 7-field shape (no token field) whose PATH contains a tab → 8 parts. parts[6] is a path
  // fragment ("/Users/a"), NOT a digit-dash token, so it must be treated as the path, not a token.
  const out = 'win\t0\t%1\t100\t-zsh\trig\t/Users/a\tb\n';
  const panes = parsePaneList(out);
  expect(panes).toHaveLength(1);
  expect(panes[0].spawnToken).toBe(''); // NOT "/Users/a"
  expect(panes[0].panePath).toBe('/Users/a\tb'); // greedy tail keeps the whole path
});

test('parsePaneList skips malformed lines', () => {
  const out = [
    '', // blank
    'too\tfew\tfields',
    'main\tNaN\t%1\t100\t-zsh\trig\t/home', // non-numeric window index
    'main\t0\t%1\tnope\t-zsh\trig\t/home', // non-numeric pane pid
    'now\t0\t%2\t100\t-zsh\t/home', // only 6 fields (no window_name) — rejected
    'good\t0\t%9\t900\tbash\trig\t/srv',
  ].join('\n');
  expect(parsePaneList(out)).toEqual([pane('good', 0, '%9', 900, 'bash', '/srv', 'rig')]);
});

// --- parseProcList ---

test('parseProcList parses ps -axo pid=,ppid=,command= output', () => {
  const out = [
    '    1     0 /sbin/launchd',
    '  100     1 -zsh',
    '  150   100 node /Users/ultra/.claude/local/claude --resume',
  ].join('\n');
  expect(parseProcList(out)).toEqual([
    proc(1, 0, '/sbin/launchd'),
    proc(100, 1, '-zsh'),
    proc(150, 100, 'node /Users/ultra/.claude/local/claude --resume'),
  ]);
});

test('parseProcList skips malformed and blank lines', () => {
  const out = ['', '   ', 'abc def ghi', '  42', '  7  3  sleep 100'].join('\n');
  expect(parseProcList(out)).toEqual([proc(7, 3, 'sleep 100')]);
});

// --- findAgentInPane ---

test('finds claude as a child of the pane shell (pane command is a VERSION string)', () => {
  // Real-world cc pane: pane_current_command is '2.1.150', not 'claude'.
  const p = pane('main', 0, '%0', 100, '2.1.150', '/Users/ultra/work');
  const procs = [proc(100, 1, '-zsh'), proc(150, 100, 'claude')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'claude', pid: 150 });
});

test('finds opencode running directly as the pane process', () => {
  const p = pane('main', 0, '%1', 200, 'opencode', '/tmp');
  const procs = [proc(200, 1, '/opt/homebrew/bin/opencode')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'opencode', pid: 200 });
});

test('finds claude nested two levels deep (claude under zsh under pane shell)', () => {
  const p = pane('main', 0, '%2', 300, '-zsh', '/home');
  const procs = [
    proc(300, 1, '-zsh'),
    proc(310, 300, 'zsh'),
    proc(320, 310, 'claude --continue'),
  ];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'claude', pid: 320 });
});

test('matches claude when the command is a node wrapper containing /claude ', () => {
  const p = pane('main', 0, '%3', 400, 'node', '/home');
  const procs = [proc(400, 1, 'node /Users/ultra/.claude/local/claude --resume')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'claude', pid: 400 });
});

test('matches codex and aider by argv0 basename', () => {
  const codexPane = pane('a', 0, '%4', 500, 'codex', '/x');
  const aiderPane = pane('a', 1, '%5', 600, 'aider', '/y');
  const procs = [
    proc(500, 1, '/opt/homebrew/bin/codex exec --json'),
    proc(600, 1, 'aider --model gpt-4o'),
  ];
  expect(findAgentInPane(codexPane, procs)).toEqual({ agent: 'codex', pid: 500 });
  expect(findAgentInPane(aiderPane, procs)).toEqual({ agent: 'aider', pid: 600 });
});

test('matches opencode.exe basename', () => {
  const p = pane('a', 0, '%6', 700, 'opencode', '/x');
  const procs = [proc(700, 1, 'C:/tools/opencode.exe serve')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'opencode', pid: 700 });
});

test('matches pi by argv0 basename', () => {
  const p = pane('a', 0, '%6', 710, 'pi', '/w');
  const procs = [proc(710, 1, '/opt/homebrew/bin/pi')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'pi', pid: 710 });
});

// omp (Oh My Pi) is a compiled Bun binary at /opt/homebrew/bin/omp — its argv0
// basename is literally 'omp'. The one matchAgentCommand row feeds BOTH
// directions: inbound pane discovery (findAgentInPane) and outbound branding
// (findAgentInAncestry).
test('matchAgentCommand classifies the omp binary by argv0 basename', () => {
  expect(matchAgentCommand('omp')).toBe('omp');
  expect(matchAgentCommand('/opt/homebrew/bin/omp')).toBe('omp');
  expect(matchAgentCommand('/opt/homebrew/bin/omp --print-session')).toBe('omp');
  // Never a prefix/substring match: an unrelated binary merely CONTAINING the
  // letters stays unmatched.
  expect(matchAgentCommand('/usr/local/bin/ompi-info')).toBeNull();
  expect(matchAgentCommand('compose up')).toBeNull();
});

test('finds omp running directly as the pane process', () => {
  const p = pane('a', 0, '%7', 720, 'omp', '/v');
  const procs = [proc(720, 1, '/opt/homebrew/bin/omp')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'omp', pid: 720 });
});

test('finds omp as a child of the pane shell (launched from zsh)', () => {
  const p = pane('a', 0, '%8', 730, 'zsh', '/u');
  const procs = [proc(730, 1, '-zsh'), proc(731, 730, 'omp')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'omp', pid: 731 });
});

test('shells and unrelated processes are traversed but never matched', () => {
  const p = pane('main', 0, '%7', 800, '-zsh', '/home');
  const procs = [
    proc(800, 1, '-zsh'),
    proc(810, 800, 'bash'),
    proc(820, 810, 'vim notes.md'),
    proc(830, 810, 'node server.js'), // not a claude wrapper
  ];
  expect(findAgentInPane(p, procs)).toBeNull();
});

test('returns the first match in BFS order (shallower process wins)', () => {
  const p = pane('main', 0, '%8', 900, '-zsh', '/home');
  const procs = [
    proc(900, 1, '-zsh'),
    proc(910, 900, 'opencode'), // depth 1
    proc(920, 910, 'claude'), // depth 2 — never reached
  ];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'opencode', pid: 910 });
});

test('survives a ppid cycle in the snapshot without hanging', () => {
  // ps snapshots can show pid-reuse artifacts; the BFS must not loop forever.
  const p = pane('main', 0, '%9', 50, '-zsh', '/home');
  const procs = [proc(50, 60, '-zsh'), proc(60, 50, 'bash')];
  expect(findAgentInPane(p, procs)).toBeNull();
});

// --- findAgentInAncestry ---
// Mirror of findAgentInPane but walking UP the ppid chain from a start pid.
// Used by outbound `tg` to learn which agent launched it as a subprocess
// (codex/aider/pi/omp export no env marker, unlike Claude Code's CLAUDECODE).

test('finds codex as the direct parent of tg (codex launched the shell command)', () => {
  // Real shape verified live: `codex exec` is the immediate parent of the shell
  // command it runs, so process.ppid points straight at a `codex` argv0.
  const procs = [
    proc(900, 800, '/opt/homebrew/bin/codex exec --json'),
    proc(950, 900, 'tg some report'),
  ];
  expect(findAgentInAncestry(procs, 900)).toEqual({ agent: 'codex', pid: 900 });
});

test('finds codex through an intermediate shell (codex → bash -lc → tg)', () => {
  const procs = [
    proc(700, 1, 'codex --dangerously-bypass-approvals-and-sandbox'),
    proc(710, 700, 'bash -lc tg ...'),
    proc(720, 710, 'bun run tg'),
  ];
  // tg's process.ppid is 710 (the shell); walk up past it to codex.
  expect(findAgentInAncestry(procs, 710)).toEqual({ agent: 'codex', pid: 700 });
});

test('finds omp through an intermediate shell (omp → bash -lc → tg)', () => {
  // omp exports no env marker (compiled Bun binary); the process tree is the
  // only signal. tg's ppid is the shell; walk up past it to omp.
  const procs = [
    proc(750, 1, '/opt/homebrew/bin/omp'),
    proc(760, 750, 'bash -lc tg "status"'),
    proc(770, 760, 'tg status'),
  ];
  expect(findAgentInAncestry(procs, 760)).toEqual({ agent: 'omp', pid: 750 });
});

test('finds omp run from source via bun --preload through an intermediate shell (tg-cli#413 follow-up)', () => {
  // Outbound branding for a bun-source-invoked omp session: `tg` running as a
  // subprocess of the session must still resolve the omp ancestor, not just
  // the compiled-binary shape.
  const procs = [
    proc(
      750,
      1,
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts',
    ),
    proc(760, 750, 'bash -lc tg "status"'),
    proc(770, 760, 'tg status'),
  ];
  expect(findAgentInAncestry(procs, 760)).toEqual({ agent: 'omp', pid: 750 });
});

test('a background ollama daemon is NOT in the ancestry, so it never matches', () => {
  // The whole point of the fix: ollama runs as a sibling daemon, not an
  // ancestor of tg, so ancestry returns null and the caller must NOT pick it.
  const procs = [
    proc(11196, 1, '/opt/homebrew/bin/ollama serve'), // background daemon
    proc(800, 1, '-zsh'),
    proc(850, 800, 'bun run tg report'),
  ];
  expect(findAgentInAncestry(procs, 800)).toBeNull();
});

test('returns the shallowest agent ancestor (nearest parent wins)', () => {
  const procs = [
    proc(100, 1, 'codex exec'),
    proc(110, 100, 'aider --model x'), // nearer to tg than codex
    proc(120, 110, 'tg ...'),
  ];
  expect(findAgentInAncestry(procs, 110)).toEqual({ agent: 'aider', pid: 110 });
});

test('survives a ppid cycle in the ancestry snapshot without hanging', () => {
  const procs = [proc(50, 60, '-zsh'), proc(60, 50, 'bash')];
  expect(findAgentInAncestry(procs, 50)).toBeNull();
});

test('stops cleanly at pid 1 / missing parent', () => {
  const procs = [proc(300, 1, '-zsh')];
  expect(findAgentInAncestry(procs, 300)).toBeNull();
  expect(findAgentInAncestry(procs, 999999)).toBeNull(); // unknown start pid
});

// --- pickTargetPane ---

// Two agent panes (claude in %0, opencode in %1) plus a plain shell pane.
const PANES = [
  pane('work', 0, '%0', 100, '2.1.150', '/Users/ultra/repo-a'),
  pane('side', 0, '%1', 200, 'opencode', '/Users/ultra/repo-b'),
  pane('work', 1, '%2', 300, '-zsh', '/Users/ultra'),
];
const PROCS = [
  proc(100, 1, '-zsh'),
  proc(150, 100, 'claude'),
  proc(200, 1, 'opencode'),
  proc(300, 1, '-zsh'),
];

test('tier 1: registration paneId wins when that pane still hosts an agent', () => {
  const r = pickTargetPane(PANES, PROCS, { paneId: '%1' });
  expect(r).toEqual({
    ok: true,
    target: { pane: PANES[1], agent: 'opencode', agentPid: 200 },
  });
});

test('tier 1 falls through when the registered pane no longer hosts an agent', () => {
  // %2 is a bare shell; with two other agent panes the result is ambiguous.
  const r = pickTargetPane(PANES, PROCS, { paneId: '%2' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('ambiguous');
});

test('tier 2: fixedSession picks the sole agent pane in that session', () => {
  const r = pickTargetPane(PANES, PROCS, null, 'work');
  expect(r).toEqual({
    ok: true,
    target: { pane: PANES[0], agent: 'claude', agentPid: 150 },
  });
});

test('tier 2: two agent panes in fixedSession → ambiguous with those candidates', () => {
  const panes = [
    pane('work', 0, '%0', 100, '2.1.150', '/a'),
    pane('work', 1, '%1', 200, 'opencode', '/b'),
    pane('other', 0, '%2', 400, 'aider', '/c'),
  ];
  const procs = [...PROCS, proc(400, 1, 'aider')];
  const r = pickTargetPane(panes, procs, null, 'work');
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates.map((c) => c.pane.paneId)).toEqual(['%0', '%1']);
  }
});

test('tier 2 falls through when fixedSession has no agent panes', () => {
  const panes = [
    pane('empty', 0, '%5', 300, '-zsh', '/home'),
    pane('side', 0, '%1', 200, 'opencode', '/Users/ultra/repo-b'),
  ];
  const r = pickTargetPane(panes, PROCS, null, 'empty');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.target.agent).toBe('opencode');
});

test('tier 3: registration cwd matches pane_current_path', () => {
  const r = pickTargetPane(PANES, PROCS, { cwd: '/Users/ultra/repo-b' });
  expect(r).toEqual({
    ok: true,
    target: { pane: PANES[1], agent: 'opencode', agentPid: 200 },
  });
});

test('tier 4: sole agent pane on the server wins with no registration at all', () => {
  const panes = [
    pane('work', 0, '%0', 100, '2.1.150', '/Users/ultra/repo-a'),
    pane('work', 1, '%2', 300, '-zsh', '/Users/ultra'),
  ];
  const r = pickTargetPane(panes, PROCS, null);
  expect(r).toEqual({
    ok: true,
    target: { pane: panes[0], agent: 'claude', agentPid: 150 },
  });
});

test('multiple agent panes and nothing to narrow → ambiguous with all candidates', () => {
  const r = pickTargetPane(PANES, PROCS, null);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates.map((c) => c.pane.paneId)).toEqual(['%0', '%1']);
  }
});

test('no agent anywhere → no-agent with empty candidates', () => {
  const panes = [pane('work', 0, '%2', 300, '-zsh', '/Users/ultra')];
  const r = pickTargetPane(panes, PROCS, { paneId: '%2', cwd: '/Users/ultra' }, 'work');
  expect(r).toEqual({ ok: false, reason: 'no-agent', candidates: [] });
});

// --- pickTargetPaneFromSet (tg-cli#67 — the per-pane registration SET) ---

test('set tier 1: exactly ONE registered pane still hosting an agent wins', () => {
  // %0 (claude) registered, %1 (opencode) NOT — the single live registered pane wins
  // even though two agent panes exist (the single-session happy path, unchanged).
  const r = pickTargetPaneFromSet(PANES, PROCS, [{ paneId: '%0', cwd: '/Users/ultra/repo-a' }]);
  expect(r).toEqual({ ok: true, target: { pane: PANES[0], agent: 'claude', agentPid: 150 } });
});

test('set tier 1: SEVERAL registered live agent panes → ambiguous (never silently pick)', () => {
  // Both agent panes registered concurrently — a FRESH non-reply inbound is
  // genuinely ambiguous; the picker must NOT auto-collapse onto one.
  const r = pickTargetPaneFromSet(PANES, PROCS, [
    { paneId: '%0', cwd: '/Users/ultra/repo-a' },
    { paneId: '%1', cwd: '/Users/ultra/repo-b' },
  ]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates.map((c) => c.pane.paneId)).toEqual(['%0', '%1']);
  }
});

test('set tier 1 falls through when no registered pane still hosts an agent', () => {
  // The only registered pane is a bare shell now; two OTHER agent panes remain →
  // ambiguous via the sole-agent tier (matches single-reg fall-through behavior).
  const r = pickTargetPaneFromSet(PANES, PROCS, [{ paneId: '%2', cwd: '/Users/ultra' }]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('ambiguous');
});

test('set tier 3: a paneless (cwd-only) entry routes by pane_current_path', () => {
  const r = pickTargetPaneFromSet(PANES, PROCS, [{ cwd: '/Users/ultra/repo-b' }]);
  expect(r).toEqual({ ok: true, target: { pane: PANES[1], agent: 'opencode', agentPid: 200 } });
});

test('set: empty registration set → sole-agent tier still applies', () => {
  const panes = [
    pane('work', 0, '%0', 100, '2.1.150', '/Users/ultra/repo-a'),
    pane('work', 1, '%2', 300, '-zsh', '/Users/ultra'),
  ];
  const r = pickTargetPaneFromSet(panes, PROCS, []);
  expect(r).toEqual({ ok: true, target: { pane: panes[0], agent: 'claude', agentPid: 150 } });
});

test('set tier 2: fixedSession picks the sole agent pane when no pane is registered', () => {
  // No registered paneId/cwd matches; the session pin narrows to the sole agent
  // pane in that session (the fixedSession tier, shared with single-reg).
  const r = pickTargetPaneFromSet(PANES, PROCS, [], 'work');
  expect(r).toEqual({ ok: true, target: { pane: PANES[0], agent: 'claude', agentPid: 150 } });
});

test('set: a registered pane whose agent is gone, plus a sole OTHER agent → that other wins', () => {
  // %5 is registered but its pane process (pid 500) has no agent descendant — a
  // bare shell; %1 is the only live agent and is NOT registered → tier 1 finds
  // nothing live, tier 3 cwd matches no AGENT pane, sole-agent (%1) wins.
  const panes = [
    pane('work', 0, '%5', 500, '-zsh', '/Users/ultra/repo-a'),
    pane('side', 0, '%1', 200, 'opencode', '/Users/ultra/repo-b'),
  ];
  const procs = [proc(500, 1, '-zsh'), proc(200, 1, 'opencode')];
  const r = pickTargetPaneFromSet(panes, procs, [{ paneId: '%5', cwd: '/Users/ultra/repo-a' }]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.target.pane.paneId).toBe('%1');
});

// --- panesWithRetry (tg-ctl discovery resilience) ---

const ONE_PANE = '4\t1\t%0\t10481\t2.1.181\text\t/Users/ultra/work/hyperide';

test('panesWithRetry: returns panes on the first successful non-empty read (no retry)', () => {
  let calls = 0;
  const panes = panesWithRetry(() => {
    calls++;
    return { exitCode: 0, stdout: ONE_PANE };
  });
  expect(panes).toHaveLength(1);
  expect(panes[0].paneId).toBe('%0');
  expect(calls).toBe(1); // happy path is a single call
});

test('panesWithRetry: retries a transient exit-0-but-EMPTY read, then succeeds', () => {
  const seq = ['', '', ONE_PANE]; // two empty reads (the launchd flake), then the real list
  let i = 0;
  const slept: number[] = [];
  const panes = panesWithRetry(
    () => ({ exitCode: 0, stdout: seq[i++] }),
    { sleep: (ms) => slept.push(ms) },
  );
  expect(panes).toHaveLength(1);
  expect(i).toBe(3); // it kept trying until non-empty
  expect(slept).toEqual([120, 120]); // a delay before each retry, not before the first attempt
});

test('panesWithRetry: ANY non-zero exit breaks immediately — not retried (no server / socket gone / connect failed)', () => {
  // The "no agent right now" steady state when tmux is unused exits non-zero; retrying it would
  // block the daemon ~240ms per message. Even when a LATER attempt would succeed, the non-zero
  // breaks first — non-zero is treated as "cannot reach a server", not a flake. Robust to tmux's
  // varying no-server stderr wording (we never read stderr).
  const seq = [{ exitCode: 1, stdout: '' }, { exitCode: 0, stdout: ONE_PANE }];
  let i = 0;
  const slept: number[] = [];
  const panes = panesWithRetry(() => seq[i++], { sleep: (ms) => slept.push(ms) });
  expect(panes).toEqual([]); // broke on the first (non-zero) read, never reached the success
  expect(i).toBe(1);
  expect(slept).toEqual([]); // no retry, no sleep
});

test('panesWithRetry: a persistent exit-0-but-EMPTY read retries to give-up, sleeping attempts-1 times', () => {
  let calls = 0;
  const slept: number[] = [];
  const panes = panesWithRetry(
    () => {
      calls++;
      return { exitCode: 0, stdout: '' }; // exit 0 but empty — the targeted wrong/empty-server flake
    },
    { attempts: 3, delayMs: 50, sleep: (ms) => slept.push(ms) },
  );
  expect(panes).toEqual([]); // empty parse never falsely registers as non-empty
  expect(calls).toBe(3); // this is the ONE retried branch
  expect(slept).toEqual([50, 50]); // delayMs honored, a delay only BETWEEN attempts (never trailing)
});

test('panesWithRetry: sleep is optional — exit-0-empty without a sleep fn loops bounded, no throw', () => {
  let calls = 0;
  const panes = panesWithRetry(() => {
    calls++;
    return { exitCode: 0, stdout: '' }; // the retried branch, exercised without a sleep fn
  }); // no opts at all — sleep undefined
  expect(panes).toEqual([]);
  expect(calls).toBe(3); // default attempts, tight loop, still bounded
});

test('panesWithRetry: a null run (tmux binary missing) breaks immediately — no pointless retries', () => {
  let calls = 0;
  const panes = panesWithRetry(
    () => {
      calls++;
      return null;
    },
    { sleep: () => {} },
  );
  expect(panes).toEqual([]);
  expect(calls).toBe(1);
});

// --- abduco-wrapped agents (tg-cli#454) ---
// Live shape (rig `omp run`, 2026-09-29, re-probed with a real abduco 0.6): the pane
// shell runs the abduco CLIENT; the abduco SERVER daemonizes (ppid 1) with the SAME
// argv, and omp is the SERVER's child — never a descendant of pane_pid.

const RIG_OMP =
  'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/../src/cli.ts --resume /s.jsonl';

function abducoPaneFixture(): { pane: PaneInfo; procs: ProcInfo[] } {
  return {
    pane: pane('main', 1, '%0', 2929, 'abduco', '/Users/u/xp/sme-archiving-gc', 'gc-sme-backlog'),
    procs: [
      proc(1, 0, '/sbin/launchd'),
      proc(2929, 1, '/bin/zsh -l'),
      proc(57614, 2929, 'abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl'),
      proc(57615, 1, 'abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl'),
      proc(57616, 57615, RIG_OMP),
    ],
  };
}

test('abducoSessionName reads the session name from getopt-style abduco argv', () => {
  expect(abducoSessionName('abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl')).toBe('omp-restored-01a0c5431ac1');
  expect(abducoSessionName('/opt/homebrew/bin/abduco -fA omp-restored-x omp')).toBe('omp-restored-x');
  expect(abducoSessionName('abduco -e ^q -a work')).toBe('work');
  expect(abducoSessionName('abduco -e^q -n work sleep 9')).toBe('work');
  expect(abducoSessionName('abduco -r -a -- -dashy')).toBe('-dashy');
  expect(abducoSessionName('abduco')).toBeNull(); // bare `abduco` lists sessions
  expect(abducoSessionName('abduco -l')).toBeNull(); // no action flag, no name
  expect(abducoSessionName('dtach -A /tmp/s omp')).toBeNull();
  expect(abducoSessionName('omp --resume abduco')).toBeNull();
});

test('an omp wrapped in abduco resolves to the tmux pane running its abduco client', () => {
  const { pane: p, procs } = abducoPaneFixture();
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'omp', pid: 57616 });
});

test('abduco resolution follows only the SAME session name — a detached session never joins another pane', () => {
  const p0 = pane('main', 1, '%0', 100, 'abduco', '/a');
  const p1 = pane('main', 2, '%1', 200, 'zsh', '/b');
  const procs = [
    proc(100, 1, '-zsh'),
    proc(101, 100, 'abduco -A sess-a omp'),
    proc(102, 1, 'abduco -A sess-a omp'),
    proc(103, 102, '/opt/homebrew/bin/omp'),
    proc(200, 1, '-zsh'),
    proc(202, 1, 'abduco -n sess-b omp'), // created detached, attached from no pane
    proc(203, 202, '/opt/homebrew/bin/omp'),
  ];
  expect(findAgentInPane(p0, procs)).toEqual({ agent: 'omp', pid: 103 });
  expect(findAgentInPane(p1, procs)).toBeNull();
  const byPid = paneIdByPid([p0, p1], procs);
  expect(byPid.get(103)).toBe('%0');
  expect(byPid.has(203)).toBe(false); // genuinely not shown in any pane
});

test('paneIdByPid maps an abduco-wrapped omp to its pane and keeps direct children mapped', () => {
  const { pane: p, procs } = abducoPaneFixture();
  const direct = pane('main', 7, '%5', 4786, 'bun', '/Users/u/xp/cal', 'cal-fix');
  const byPid = paneIdByPid([p, direct], [...procs, proc(4786, 1, '/bin/zsh -l'), proc(36698, 4786, RIG_OMP)]);
  expect(byPid.get(57616)).toBe('%0');
  expect(byPid.get(36698)).toBe('%5');
});

test('parsePaneTitles keeps the raw title per pane id (tabs inside a title survive) and skips junk lines', () => {
  const out = '%0\tπ ⠹ Recover orphaned commits, verify PRs\n%16\t[mosh] ultra@home: ~\n%3\ta\tb\nmain\t0\t%9\t5301\n\n';
  const titles = parsePaneTitles(out);
  expect(titles.get('%0')).toBe('π ⠹ Recover orphaned commits, verify PRs');
  expect(titles.get('%16')).toBe('[mosh] ultra@home: ~');
  expect(titles.get('%3')).toBe('a\tb');
  expect(titles.size).toBe(3);
});
