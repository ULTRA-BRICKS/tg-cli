import { expect, test } from 'bun:test';
import {
  agentInboxKey,
  describeUnreachable,
  findUnreachableAgents,
  isInteractiveAgentCommand,
  matchUnreachable,
  noAgentReplyText,
  outsideTmuxRefusalText,
  parseAgentNameFromCommand,
  parseLsofCwd,
  parsePidTtyList,
  sanitizeAgentName,
  tmuxStartCommand,
  unreachableLabel,
  type UnreachableAgent,
} from '../features/tg-ctl/unreachable';
import type { PaneInfo, ProcInfo } from '../features/tg-ctl/types';

function pane(panePid: number, paneId = `%${panePid}`): PaneInfo {
  return {
    sessionName: 'main',
    windowIndex: 0,
    paneId,
    panePid,
    paneCommand: 'zsh',
    windowName: 'rig',
    spawnToken: '',
    panePath: '/Users/u/xp/rig',
  };
}
function proc(pid: number, ppid: number, command: string): ProcInfo {
  return { pid, ppid, command };
}
function ua(over: Partial<UnreachableAgent> = {}): UnreachableAgent {
  return { pid: 7103, agent: 'claude', tty: 'ttys004', command: 'claude --name landing', name: 'landing', cwd: '/Users/u/work/landing', ...over };
}

// --- shared key contract (vectors MUST match agent-tools tests/test_tg_inbox.py) ---

test('agentInboxKey: --name wins and is sanitized', () => {
  expect(agentInboxKey('landing', '/x')).toBe('landing');
  expect(agentInboxKey('my agent/1', '/x')).toBe('my_agent_1');
  expect(agentInboxKey('rig-fable.v2', '/x')).toBe('rig-fable.v2');
  expect(agentInboxKey('x'.repeat(100), '/x')).toBe('x'.repeat(64));
});

test('agentInboxKey: no name → cwd sha256 prefix, trailing slash normalized', () => {
  expect(agentInboxKey(null, '/Users/ultra/work/landing')).toBe('cwd-ccfe64bae2f277d7');
  expect(agentInboxKey(undefined, '/Users/ultra/work/landing/')).toBe('cwd-ccfe64bae2f277d7');
  expect(agentInboxKey('', '/')).toBe('cwd-8a5edab282632443');
});

test('sanitizeAgentName: empty and dots-only results are null (never a path escape)', () => {
  expect(sanitizeAgentName('')).toBeNull();
  expect(sanitizeAgentName('.')).toBeNull();
  expect(sanitizeAgentName('..')).toBeNull();
  expect(sanitizeAgentName('ok-1')).toBe('ok-1');
  expect(agentInboxKey('..', '/')).toBe('cwd-8a5edab282632443');
});

test('parseAgentNameFromCommand: ps flattens argv, so a multi-word --name yields its first word (same on the Python side)', () => {
  expect(parseAgentNameFromCommand('claude --name my agent/1')).toBe('my');
});

// --- parsers ---

test('parsePidTtyList drops tty-less rows and ignores 3-column legacy fake ps output', () => {
  const out = ' 7103 ttys004\n64363 ??\n  42 ?\n 100 pts/1\n    1     0 /sbin/launchd\n 5001     1 claude --resume\n';
  const m = parsePidTtyList(out);
  expect([...m.entries()]).toEqual([
    [7103, 'ttys004'],
    [100, 'pts/1'],
  ]);
});

test('parseLsofCwd reads the n field', () => {
  expect(parseLsofCwd('p7103\nfcwd\nn/Users/u/work/landing\n')).toBe('/Users/u/work/landing');
  expect(parseLsofCwd('')).toBeNull();
});

test('parseAgentNameFromCommand handles --name X, --name=X and a missing value', () => {
  expect(parseAgentNameFromCommand('claude --permission-mode bypassPermissions --name rig-fable')).toBe('rig-fable');
  expect(parseAgentNameFromCommand('claude --name=landing --resume')).toBe('landing');
  expect(parseAgentNameFromCommand('claude --name --resume')).toBeNull();
  expect(parseAgentNameFromCommand('claude')).toBeNull();
});

test('isInteractiveAgentCommand excludes print/exec/daemon/mcp shapes', () => {
  expect(isInteractiveAgentCommand('claude --name x', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('/Users/u/.local/bin/claude --print --output-format text', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('claude -p "hi"', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('node /opt/homebrew/bin/codex exec -s read-only', 'codex')).toBe(false);
  expect(isInteractiveAgentCommand('claude daemon run --json-path x', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('claude bg-spare --bg-spare /tmp/x', 'claude')).toBe(false);
  // claude mcp serve/list — a one-shot/server subcommand, never the interactive TUI,
  // now load-bearing for headless-aware kinds since findUnreachableAgents no longer
  // falls back to a tty requirement for claude (tg-cli#413 follow-up review finding).
  expect(isInteractiveAgentCommand('claude mcp serve', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('claude mcp list', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('opencode run "do it"', 'opencode')).toBe(false);
  expect(isInteractiveAgentCommand('opencode', 'opencode')).toBe(true);
});

test('isInteractiveAgentCommand ignores prompt words and values that merely look like helper tokens', () => {
  expect(isInteractiveAgentCommand('claude -- please exec tests', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('claude "please exec tests and -p"', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('claude --name daemon', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('claude --name landing please exec', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('node /Users/u/.claude/local/claude --name exec-runner', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('node /Users/u/.claude/local/claude daemon run', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('claude --name x -- -p', 'claude')).toBe(true);
});

test('isInteractiveAgentCommand keys its tables on the harness: codex -p is a profile, -c takes a value', () => {
  expect(isInteractiveAgentCommand('codex -p work', 'codex')).toBe(true);
  expect(isInteractiveAgentCommand('codex -c model=o3 exec "run tests"', 'codex')).toBe(false);
  expect(isInteractiveAgentCommand('codex -m o3 exec', 'codex')).toBe(false);
  expect(isInteractiveAgentCommand('codex --full-auto exec', 'codex')).toBe(false);
  expect(isInteractiveAgentCommand('codex resume', 'codex')).toBe(true);
  expect(isInteractiveAgentCommand('codex "please exec"', 'codex')).toBe(true);
  expect(isInteractiveAgentCommand('claude -p x', 'claude')).toBe(false);
});

test('isInteractiveAgentCommand: the launcher --name is skipped for every harness, optional-value flags never hide a subcommand', () => {
  expect(isInteractiveAgentCommand('opencode --name web', 'opencode')).toBe(true);
  expect(isInteractiveAgentCommand('codex --name debug', 'codex')).toBe(true);
  expect(isInteractiveAgentCommand('opencode --name web run "x"', 'opencode')).toBe(false);
  expect(isInteractiveAgentCommand('opencode -m gpt-4 run "x"', 'opencode')).toBe(false);
  expect(isInteractiveAgentCommand('opencode --port 4096', 'opencode')).toBe(true);
  expect(isInteractiveAgentCommand('claude -w daemon', 'claude')).toBe(false); // -w's value is optional: the subcommand still counts
  expect(isInteractiveAgentCommand('claude -w feature-x', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('claude -r', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('aider -p', 'aider')).toBe(true);
  expect(isInteractiveAgentCommand('omp', 'omp')).toBe(true);
});

// --- discovery ---

test('findUnreachableAgents passes the harness through: codex -p <profile> is listed, claude -p is not', () => {
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(6000, 1, 'login'),
    proc(6001, 6000, '-zsh'),
    proc(7200, 6001, 'codex -p work'),
    proc(7300, 6001, 'claude -p "one-shot"'),
  ];
  const tty = new Map([
    [7200, 'ttys010'],
    [7300, 'ttys011'],
  ]);
  const found = findUnreachableAgents([], procs, tty);
  expect(found.map((a) => [a.pid, a.agent])).toEqual([[7200, 'codex']]);
});

test('findUnreachableAgents: an interactive claude with a tty and no tmux pane is unreachable', () => {
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(5000, 1, 'tmux'),
    proc(5001, 5000, '-zsh'),
    proc(5002, 5001, 'claude --resume'), // in the pane → reachable
    proc(6000, 1, 'login'),
    proc(6001, 6000, '-zsh'),
    proc(7103, 6001, 'claude --name landing'), // plain terminal → unreachable
    proc(7118, 7103, 'python serena start-mcp-server'),
    proc(8000, 1, '/Users/u/.local/bin/claude --print --output-format text'), // headless, no tty anyway
    proc(9000, 1, 'claude daemon run'),
  ];
  const tty = new Map<number, string>([
    [5001, 'ttys001'],
    [5002, 'ttys001'],
    [6001, 'ttys004'],
    [7103, 'ttys004'],
    [7118, 'ttys004'],
  ]);
  const out = findUnreachableAgents([pane(5001)], procs, tty);
  expect(out).toEqual([
    { pid: 7103, agent: 'claude', tty: 'ttys004', command: 'claude --name landing', name: 'landing', cwd: null },
  ]);
});

test('findUnreachableAgents: a bun-source-invoked omp with a tty and no tmux pane classifies as omp (tg-cli#413 follow-up)', () => {
  // Before the matchAgentCommand fix this classified as null (unrecognized), so
  // this process was invisible to BOTH findUnreachableAgents and
  // findLiveOmpAgents. tg-ctl's entrypoint filters agent !== 'omp' out of the
  // unreachable list (omp coverage is exclusively findLiveOmpAgents's job), so
  // this pins the classification half of the fix, not the final routing list.
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(6000, 1, 'login'),
    proc(6001, 6000, '-zsh'),
    proc(
      7300,
      6001,
      'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/src/cli.ts',
    ),
  ];
  const tty = new Map<number, string>([[6001, 'ttys004'], [7300, 'ttys004']]);
  const out = findUnreachableAgents([], procs, tty);
  expect(out.map((a) => [a.pid, a.agent])).toEqual([[7300, 'omp']]);
});

test('findUnreachableAgents: a wrapper + real binary pair folds into one agent; a nested session under another agent stays distinct', () => {
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(300, 1, 'node /Users/u/.claude/local/claude --name a'),
    proc(301, 300, 'claude --name a'),
    // an agent's Bash tool → script → a SECOND interactive claude (the live-proof shape)
    proc(310, 301, '/bin/zsh -c script -q /tmp/t claude --name tgtest'),
    proc(311, 310, 'script -q /tmp/t claude --name tgtest'),
    proc(312, 311, 'claude --name tgtest'),
  ];
  const tty = new Map<number, string>([
    [300, 'ttys002'],
    [301, 'ttys002'],
    [312, 'ttys030'],
  ]);
  const out = findUnreachableAgents([], procs, tty);
  expect(out.map((a) => [a.pid, a.name])).toEqual([
    [300, 'a'],
    [312, 'tgtest'],
  ]);
  expect(out[0].agent).toBe('claude');
  // an empty tty map (fully headless, no controlling terminal anywhere) still finds the
  // same agents — only the display tty degrades to null, never the whole agent (tg-cli#413
  // follow-up: this used to assert `[]` here, pinning the bug).
  const outNoTty = findUnreachableAgents([], procs, new Map());
  expect(outNoTty.map((a) => [a.pid, a.name])).toEqual([
    [300, 'a'],
    [312, 'tgtest'],
  ]);
  expect(outNoTty.every((a) => a.tty === null)).toBe(true);
});

test('a fully headless claude session (no tty, no pane) is still discovered', () => {
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(7103, 1, 'claude --name landing'), // parented directly under launchd, no tty at all
  ];
  const out = findUnreachableAgents([], procs, new Map());
  expect(out).toEqual([
    { pid: 7103, agent: 'claude', tty: null, command: 'claude --name landing', name: 'landing', cwd: null },
  ]);
});

test('a fully headless codex/opencode session (no tty, no pane) is also discovered — headlessAware is not claude-only', () => {
  const codexProcs = [proc(1, 0, '/sbin/launchd'), proc(8100, 1, 'codex')];
  expect(findUnreachableAgents([], codexProcs, new Map())).toEqual([
    { pid: 8100, agent: 'codex', tty: null, command: 'codex', name: null, cwd: null },
  ]);
  const opencodeProcs = [proc(1, 0, '/sbin/launchd'), proc(8200, 1, 'opencode')];
  expect(findUnreachableAgents([], opencodeProcs, new Map())).toEqual([
    { pid: 8200, agent: 'opencode', tty: null, command: 'opencode', name: null, cwd: null },
  ]);
});

test('a headless `claude mcp serve` is never falsely listed as unreachable (unlike a real interactive session)', () => {
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(7200, 1, 'claude mcp serve'), // one-shot server subcommand, no controlling tty
  ];
  expect(findUnreachableAgents([], procs, new Map())).toEqual([]);
});

test('a headless pi/aider (no per-shape headless detection) is still dropped without a tty, unlike claude/codex/opencode', () => {
  const procs = [
    proc(1, 0, '/sbin/launchd'),
    proc(9100, 1, 'pi --message "summarize"'), // no controlling terminal at all
    proc(9200, 1, 'aider --yes'),
  ];
  expect(findUnreachableAgents([], procs, new Map())).toEqual([]);
  // a raw, un-parsed sentinel value ('??'/'?'/'-') in the map must be treated exactly
  // like a missing entry — the gate normalizes before checking, not just before display
  // (a caller can hand findUnreachableAgents a raw map, same as the omp sibling's tests do).
  expect(findUnreachableAgents([], procs, new Map([[9100, '??']]))).toEqual([]);
  const withTty = new Map([[9100, 'ttys020']]);
  expect(findUnreachableAgents([], procs, withTty).map((a) => [a.pid, a.agent])).toEqual([[9100, 'pi']]);
});

// --- labels, keys, matching, texts ---

test('unreachableLabel: name first, cwd basename fallback, pid when neither', () => {
  expect(unreachableLabel(ua())).toBe('landing');
  expect(unreachableLabel(ua({ name: null, command: 'claude', cwd: '/Users/ultra/work/landing' }))).toBe('landing');
  expect(unreachableLabel(ua({ name: null, command: 'claude', cwd: null }))).toBe('pid 7103');
});

test('matchUnreachable is strict: exact name (case-insensitive), then exact cwd basename', () => {
  const named = ua();
  const anon = ua({ pid: 8, name: null, cwd: '/Users/u/work/rig-cli' });
  expect(matchUnreachable('Landing', [named, anon])).toEqual([named]);
  expect(matchUnreachable('rig-cli', [named, anon])).toEqual([anon]);
  expect(matchUnreachable('land', [named, anon])).toEqual([]);
  expect(matchUnreachable('', [named])).toEqual([]);
});

// --- tmux-only (tg-cli#456): nothing is queued for an agent outside tmux ---

test('status line names the reason, tty, cwd, name and pid — and no inbox queue', () => {
  const line = describeUnreachable(ua());
  expect(line).toBe('landing · claude — unreachable: not in tmux (tty ttys004, cwd /Users/u/work/landing, name landing, pid 7103)');
  expect(describeUnreachable(ua({ tty: null }))).toContain('(tty none,');
});

test('no-agent listing says the agents outside tmux are tmux-only and how to restart them — never promises a queue', () => {
  expect(noAgentReplyText('legacy', [])).toBe('legacy');
  const listing = noAgentReplyText('legacy', [ua()]);
  expect(listing).toContain('OUTSIDE tmux');
  expect(listing).toContain('landing · claude — unreachable: not in tmux');
  expect(listing).toContain('claude-rotate --tmux <name>');
  expect(listing).not.toMatch(/queue|inbox|turn end/i);
});

test('tmuxStartCommand: claude-rotate for Claude Code, a named tmux window for the other harnesses', () => {
  expect(tmuxStartCommand(ua())).toBe('claude-rotate --tmux landing');
  expect(tmuxStartCommand(ua({ agent: 'codex', command: 'codex', name: null, cwd: '/Users/u/work/api' }))).toBe('tmux new-window -n api codex');
  expect(tmuxStartCommand(ua({ agent: 'opencode', command: 'opencode', name: null, cwd: '/w/web' }))).toBe('tmux new-window -n web opencode');
  // A label a shell would split or expand is single-quoted, embedded quotes escaped.
  expect(tmuxStartCommand(ua({ name: null, command: 'claude', cwd: "/w/it's mine" }))).toBe("claude-rotate --tmux 'it'\\''s mine'");
  // No --name and no cwd: a placeholder, never the synthetic "pid N" label.
  expect(tmuxStartCommand(ua({ name: null, command: 'claude', cwd: null }))).toBe('claude-rotate --tmux <name>');
});

test('outsideTmuxRefusalText: ONE line naming the agent, that nothing was sent or queued, and how to start it in tmux', () => {
  const cc = outsideTmuxRefusalText('landing', [ua()]);
  expect(cc).not.toContain('\n');
  expect(cc).toContain('landing · claude runs outside tmux');
  expect(cc).toContain('nothing was sent or queued');
  expect(cc.endsWith('Start it in tmux: claude-rotate --tmux landing')).toBe(true);

  const codex = outsideTmuxRefusalText('api', [ua({ pid: 9, agent: 'codex', command: 'codex', name: null, cwd: '/w/api' })]);
  expect(codex).not.toContain('\n');
  expect(codex).toContain('api · codex runs outside tmux');
  expect(codex.endsWith('Start it in tmux: tmux new-window -n api codex')).toBe(true);

  // Several sessions answer to one selector: still one line, every one named, every distinct start command.
  const both = outsideTmuxRefusalText('landing', [ua(), ua({ pid: 9, agent: 'codex', command: 'codex', name: null })]);
  expect(both).not.toContain('\n');
  expect(both).toContain("'landing' matches 2 sessions outside tmux (landing · claude pid 7103, landing · codex pid 9)");
  expect(both.endsWith('Start it in tmux: claude-rotate --tmux landing or tmux new-window -n landing codex')).toBe(true);
});
