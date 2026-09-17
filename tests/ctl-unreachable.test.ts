import { expect, test } from 'bun:test';
import {
  agentInboxKey,
  describeUnreachable,
  findUnreachableAgents,
  inboxKeyCollisions,
  isInteractiveAgentCommand,
  matchUnreachable,
  noAgentReplyText,
  parseAgentNameFromCommand,
  parseLsofCwd,
  parsePidTtyList,
  queuedReplyText,
  sanitizeAgentName,
  unreachableKey,
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

test('isInteractiveAgentCommand excludes print/exec/daemon shapes', () => {
  expect(isInteractiveAgentCommand('claude --name x', 'claude')).toBe(true);
  expect(isInteractiveAgentCommand('/Users/u/.local/bin/claude --print --output-format text', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('claude -p "hi"', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('node /opt/homebrew/bin/codex exec -s read-only', 'codex')).toBe(false);
  expect(isInteractiveAgentCommand('claude daemon run --json-path x', 'claude')).toBe(false);
  expect(isInteractiveAgentCommand('claude bg-spare --bg-spare /tmp/x', 'claude')).toBe(false);
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

test('findUnreachableAgents: a wrapper + real binary pair folds into one agent; a nested session under another agent stays distinct; empty tty map → none', () => {
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
  expect(findUnreachableAgents([], procs, new Map())).toEqual([]);
});

// --- labels, keys, matching, texts ---

test('unreachableLabel/unreachableKey: name first, cwd basename fallback, pid when neither', () => {
  expect(unreachableLabel(ua())).toBe('landing');
  expect(unreachableKey(ua())).toBe('landing');
  const anon = ua({ name: null, command: 'claude', cwd: '/Users/ultra/work/landing' });
  expect(unreachableLabel(anon)).toBe('landing');
  expect(unreachableKey(anon)).toBe('cwd-ccfe64bae2f277d7');
  // unnamed + cwd unresolved: the label falls to the pid and the key is honestly UNKNOWN
  const blind = ua({ name: null, command: 'claude', cwd: null });
  expect(unreachableLabel(blind)).toBe('pid 7103');
  expect(unreachableKey(blind)).toBeNull();
  // a named agent needs no cwd for its key
  expect(unreachableKey(ua({ cwd: null }))).toBe('landing');
});

test('inboxKeyCollisions: distinct names that sanitize alike, or two unnamed sessions in one cwd, share a key', () => {
  const a = ua({ pid: 1, name: 'a/b', command: 'claude --name a/b' });
  const b = ua({ pid: 2, name: 'a?b', command: 'claude --name a?b' });
  const c = ua({ pid: 3, name: 'other', command: 'claude --name other' });
  expect(inboxKeyCollisions(a, [a, b, c]).map((x) => x.pid)).toEqual([2]);
  expect(inboxKeyCollisions(c, [a, b, c])).toEqual([]);
  const u1 = ua({ pid: 4, name: null, command: 'claude', cwd: '/w/x' });
  const u2 = ua({ pid: 5, name: null, command: 'claude', cwd: '/w/x/' });
  const blind = ua({ pid: 6, name: null, command: 'claude', cwd: null });
  expect(inboxKeyCollisions(u1, [u1, u2, blind]).map((x) => x.pid)).toEqual([5]);
  expect(inboxKeyCollisions(blind, [u1, u2, blind])).toEqual([]);
});

test('matchUnreachable is strict: exact name (case-insensitive), then exact cwd basename', () => {
  const named = ua();
  const anon = ua({ pid: 8, name: null, cwd: '/Users/u/work/rig-cli' });
  expect(matchUnreachable('Landing', [named, anon])).toEqual([named]);
  expect(matchUnreachable('rig-cli', [named, anon])).toEqual([anon]);
  expect(matchUnreachable('land', [named, anon])).toEqual([]);
  expect(matchUnreachable('', [named])).toEqual([]);
});

test('status/reply texts name the reason, tty, cwd and name', () => {
  const line = describeUnreachable(ua(), 2);
  expect(line).toContain('landing · claude — unreachable: not in tmux');
  expect(line).toContain('tty ttys004');
  expect(line).toContain('cwd /Users/u/work/landing');
  expect(line).toContain('name landing');
  expect(line).toContain('2 queued');
  expect(noAgentReplyText('legacy', [])).toBe('legacy');
  const listing = noAgentReplyText('legacy', [ua()]);
  expect(listing).toContain('OUTSIDE tmux');
  expect(listing).toContain('landing · claude');
  expect(listing).toContain('/agent <name> <text>');
  expect(queuedReplyText(ua())).toContain('landing is running outside tmux');
  expect(queuedReplyText(ua())).toContain('Stop-hook inbox');
});
