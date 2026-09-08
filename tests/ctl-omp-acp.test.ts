import { expect, test } from 'bun:test';
import { distinctLabels } from '../features/tg-ctl/agent-match';
import { wrapInbound } from '../features/tg-ctl/inject';
import { questionCapability } from '../features/tg-ctl/questions';
import { findAgentInPane, matchAgentCommand } from '../features/tg-ctl/discover';
import type { PaneInfo, ProcInfo } from '../features/tg-ctl/types';
import {
  acpPermissionReply,
  acpPermissionToButtonRequest,
  acpSessionTitleFromUpdate,
  buildAcpInitialize,
  buildAcpSessionLoad,
  buildAcpSessionNew,
  buildAcpSessionPrompt,
  isLiveOmpOriginId,
  liveOmpPidFromOriginId,
  matchLiveOmpOrigin,
  ompReplyOriginMatches,
  ompAcpSpawnArgv,
  outboundOriginPaneId,
  decodeAcpFrames,
  encodeAcpFrame,
  findLiveOmpAgents,
  isPrimaryOmpSessionFile,
  isOmpLiveSessionCommand,
  liveOmpLabel,
  liveOmpPaneId,
  matchLiveOmp,
  mergeLiveOmpCandidates,
  parseLsofJsonlPaths,
  parseOmpSessionMeta,
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

test('liveOmpLabel prefers omp session title over cwd basename', () => {
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
  const untitled: LiveOmpAgent = { ...titled, title: null, sessionId: null };
  expect(liveOmpLabel(untitled)).not.toBe('review-cli'); // must not silently become a cwd guess as THE name source
  expect(liveOmpLabel(untitled)).toBe('omp · 7');
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
  expect(untitled.windowName).toBe('omp · 33378');
  expect(untitled.panePath).toBe('/Users/u/xp/tg-cli');
  expect(distinctLabels([untitled])).toEqual(['omp · 33378']);
});

test('preferOmpApiOverTmux is true for omp even when a pane exists — never send-keys', () => {
  expect(preferOmpApiOverTmux('omp')).toBe(true);
  expect(preferOmpApiOverTmux('claude')).toBe(false);
  expect(preferOmpApiOverTmux('opencode')).toBe(false);
});

test('questionCapability(omp) is buttons — ACP request_permission, not the tmux floor', () => {
  expect(questionCapability('omp')).toBe('buttons');
});

// --- ACP JSON-RPC (proven on omp 18.1.14: initialize, session/new, session/prompt) ---

test('encodeAcpFrame / decodeAcpFrames round-trip Content-Length JSON-RPC', () => {
  const req = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };
  const framed = encodeAcpFrame(req);
  expect(framed.startsWith('Content-Length:')).toBe(true);
  const { messages, rest } = decodeAcpFrames(framed);
  expect(rest).toBe('');
  expect(messages).toEqual([req]);
});

test('buildAcpSessionPrompt is session/prompt with text parts — never a tmux argv', () => {
  const wrapped = wrapInbound('[TG from {name} {id}] {msg}', 'Alex', 'deploy now', 10);
  const req = buildAcpSessionPrompt(2, '01sess', wrapped);
  expect(req.method).toBe('session/prompt');
  expect(JSON.stringify(req)).not.toContain('send-keys');
  expect(JSON.stringify(req)).not.toContain('tmux');
  expect(req.params).toEqual({
    sessionId: '01sess',
    prompt: [{ type: 'text', text: wrapped }],
  });
  expect(wrapped).toContain('[TG from Alex tg#10]');
  expect(wrapped).toContain('deploy now');
});

test('buildAcpInitialize and buildAcpSessionNew match the live omp 18.1.14 handshake', () => {
  expect(buildAcpInitialize(1).method).toBe('initialize');
  expect(buildAcpSessionNew(2, '/tmp/proj').method).toBe('session/new');
  expect(buildAcpSessionNew(2, '/tmp/proj').params).toEqual({ cwd: '/tmp/proj', mcpServers: [] });
});

test('acpSessionTitleFromUpdate reads session_info_update title from omp itself', () => {
  expect(
    acpSessionTitleFromUpdate({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: '01s',
        update: { sessionUpdate: 'session_info_update', title: 'Fix review-cli from omp' },
      },
    }),
  ).toBe('Fix review-cli from omp');
  expect(acpSessionTitleFromUpdate({ jsonrpc: '2.0', method: 'session/prompt' })).toBeNull();
});

test('acpPermissionToButtonRequest maps session/request_permission to Telegram buttons', () => {
  const req = acpPermissionToButtonRequest({
    jsonrpc: '2.0',
    id: 9,
    method: 'session/request_permission',
    params: {
      sessionId: '01s',
      toolCall: { toolCallId: 'call-1', title: 'Run tests?', kind: 'execute' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  expect(req).not.toBeNull();
  expect(req!.agent).toBe('omp');
  expect(req!.kind).toBe('permission');
  expect(req!.question).toContain('Run tests?');
  expect(req!.options?.map((o) => o.label)).toEqual(['Allow', 'Reject']);
  expect(req!.omp).toEqual({ sessionId: '01s', rpcId: 9 });
  const reply = acpPermissionReply(req!, 'allow-once');
  expect(reply).toEqual({
    jsonrpc: '2.0',
    id: 9,
    result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
  });
  expect(JSON.stringify(reply)).not.toContain('send-keys');
});

test('acpPermissionToButtonRequest maps a question-shaped option list (ask tool)', () => {
  const req = acpPermissionToButtonRequest({
    jsonrpc: '2.0',
    id: 'q1',
    method: 'session/request_permission',
    params: {
      sessionId: '01s',
      toolCall: { toolCallId: 'ask-1', title: 'Which target?', kind: 'other' },
      options: [
        { optionId: 'a', name: 'staging', kind: 'allow_once' },
        { optionId: 'b', name: 'prod', kind: 'allow_once' },
      ],
    },
  });
  expect(req!.kind).toBe('question');
  expect(req!.options?.map((o) => o.label)).toEqual(['staging', 'prod']);
});

// --- out-of-tmux reply origin (tg-cli#339): routes must stamp omp:<pid>, ACP session/load ---

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

test('buildAcpSessionLoad addresses the live session id, not session/new', () => {
  const req = buildAcpSessionLoad(3, '/Users/u/work/review-cli', '01a07d8e-c12c-7433-903d-e98726bfda37');
  expect(req.method).toBe('session/load');
  expect(req.params).toEqual({
    cwd: '/Users/u/work/review-cli',
    mcpServers: [],
    sessionId: '01a07d8e-c12c-7433-903d-e98726bfda37',
  });
  expect(JSON.stringify(req)).not.toContain('session/new');
  expect(JSON.stringify(req)).not.toContain('send-keys');
});

test('ompAcpSpawnArgv drops --no-session when loading a live session', () => {
  expect(ompAcpSpawnArgv({ cwd: '/proj', loadSession: true })).toEqual([
    'acp',
    '--allow-home',
    '--cwd=/proj',
  ]);
  expect(ompAcpSpawnArgv({ cwd: '/proj', loadSession: false })).toEqual([
    'acp',
    '--no-session',
    '--allow-home',
    '--cwd=/proj',
  ]);
  expect(ompAcpSpawnArgv({ cwd: '/proj', loadSession: true }).includes('--no-session')).toBe(false);
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

