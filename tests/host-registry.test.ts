import { expect, test } from 'bun:test';
import {
  HOST_RECORD_VERSION,
  describeHost,
  hostNameFromOriginId,
  hostOfPid,
  hostOriginId,
  hostRecordPath,
  hostToCandidate,
  hostsDir,
  liveHosts,
  hostsNotShownElsewhere,
  parseHostRecord,
  type HostFileFacts,
  type HostRecord,
  type LiveHost,
} from '../features/tg-ctl/host-registry';
import type { ProcInfo } from '../features/tg-ctl/types';

// docs/specs/2026-09-30-harness-agnostic-control.md §3: the record a rig wrapper writes
// for each abduco session it hosts; tg-ctl only reads it, re-verifies it against the
// process table, and never trusts a record that does not name a live abduco server.

const UID = 501;
const FILE: HostFileFacts = { isRegularFile: true, isSymlink: false, uid: UID };
const SOCKET = '/Users/u/.local/state/rig/abduco/abduco/u/claude-3f9a0c1d2e4b@host.local';

function record(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    name: 'claude-3f9a0c1d2e4b',
    harness: 'claude',
    label: 'tg-cli',
    cwd: '/Users/u/xp/tg-cli',
    socket: SOCKET,
    serverPid: 100,
    harnessPid: 102,
    role: 'coordinator',
    startedAt: '2026-09-30T21:30:00Z',
    updatedAt: '2026-09-30T21:30:00Z',
    ...over,
  });
}

const parse = (raw: string, stem = 'claude-3f9a0c1d2e4b', file: HostFileFacts = FILE) => parseHostRecord(stem, raw, file, UID);

test('paths: hosts/<name>.json under the config dir; a name that is not a valid abduco session id has no path', () => {
  expect(hostsDir('/c')).toBe('/c/hosts');
  expect(hostRecordPath('/c', 'omp-6a830edb351d')).toBe('/c/hosts/omp-6a830edb351d.json');
  for (const bad of ['', '../x', 'a/b', '-lead', '.hidden', 'sp ace', 'a'.repeat(62)]) expect(hostRecordPath('/c', bad)).toBeNull();
});

test('a complete record parses; unknown extra fields (rig may add resume/restarts) are ignored', () => {
  const res = parse(record({ restarts: 3, resume: '/s.jsonl' }));
  expect(res).toEqual({
    ok: true,
    record: {
      name: 'claude-3f9a0c1d2e4b',
      harness: 'claude',
      label: 'tg-cli',
      cwd: '/Users/u/xp/tg-cli',
      socket: SOCKET,
      serverPid: 100,
      harnessPid: 102,
      startedAt: '2026-09-30T21:30:00Z',
      updatedAt: '2026-09-30T21:30:00Z',
    },
  });
  expect(HOST_RECORD_VERSION).toBe(1);
});

test('label, cwd, harnessPid and timestamps are optional', () => {
  const res = parse(JSON.stringify({ v: 1, name: 'codex-0a1b2c3d4e5f', harness: 'codex', socket: '/s/codex-0a1b2c3d4e5f', serverPid: 7, role: 'coordinator' }), 'codex-0a1b2c3d4e5f');
  expect(res.ok && res.record).toMatchObject({ label: null, cwd: null, harnessPid: null, startedAt: null, updatedAt: null });
});

test('an empty or whitespace label is no label', () => {
  const res = parse(record({ label: '   ' }));
  expect(res.ok && res.record.label).toBeNull();
});

test('a label is trimmed and capped so it cannot flood a header', () => {
  const res = parse(record({ label: `  ${'x'.repeat(200)}  ` }));
  expect(res.ok && res.record.label).toBe('x'.repeat(64));
});

test('rejected: anything but a version-1 record of a known harness naming its own session', () => {
  const cases: Array<[string, string, string?]> = [
    ['not JSON', '{nope'],
    ['not an object', '[1]'],
    ['version 2', record({ v: 2 })],
    ['no version', record({ v: undefined })],
    ['name is not the file stem', record({ name: 'claude-aaaaaaaaaaaa' })],
    ['invalid name', record({ name: '../evil' }), '../evil'],
    ['unknown harness', record({ harness: 'aider' })],
    ['relative socket', record({ socket: 'rel/sock' })],
    ['socket that is not this session\u2019s', record({ socket: '/s/omp-aaaaaaaaaaaa@host' })],
    ['serverPid zero', record({ serverPid: 0 })],
    ['serverPid fractional', record({ serverPid: 1.5 })],
    ['serverPid string', record({ serverPid: '100' })],
    ['harnessPid negative', record({ harnessPid: -3 })],
    ['cwd not a string', record({ cwd: 5 })],
  ];
  for (const [why, raw, stem] of cases) {
    const res = parse(raw, stem);
    expect([why, res.ok]).toEqual([why, false]);
  }
});

test('rejected: a record that is not a coordinator — a subagent is never a delivery target (role model §4.5)', () => {
  for (const role of ['subagent', 'detached', '', undefined, 7]) {
    const res = parse(record({ role }));
    expect([role, res.ok]).toEqual([role, false]);
  }
});

test('rejected: a symlink, a non-regular file, or a file another user owns', () => {
  expect(parse(record(), undefined, { ...FILE, isSymlink: true }).ok).toBe(false);
  expect(parse(record(), undefined, { ...FILE, isRegularFile: false }).ok).toBe(false);
  expect(parse(record(), undefined, { ...FILE, uid: UID + 1 }).ok).toBe(false);
});

test('the socket basename may be the bare session name or name@host (abduco decorates it with the host)', () => {
  expect(parse(record({ socket: '/s/claude-3f9a0c1d2e4b' })).ok).toBe(true);
  expect(parse(record({ socket: '/s/claude-3f9a0c1d2e4b@Ultras-MBP.local' })).ok).toBe(true);
  expect(parse(record({ socket: '/s/claude-3f9a0c1d2e4bXX@h' })).ok).toBe(false);
});

// --- liveness against the process table ---

const rec = (over: Partial<HostRecord> = {}): HostRecord => {
  const res = parse(record(over as Record<string, unknown>), over.name ?? 'claude-3f9a0c1d2e4b');
  if (!res.ok) throw new Error(res.reason);
  return res.record;
};
const proc = (pid: number, ppid: number, command: string): ProcInfo => ({ pid, ppid, command });
// abduco server re-parented to pid 1 keeps the client's argv; the harness argv is NOT in it.
const SERVER = proc(100, 1, 'abduco -n claude-3f9a0c1d2e4b rig host-run claude-3f9a0c1d2e4b');
const SUPERVISOR = proc(101, 100, '/opt/homebrew/bin/python3 /Users/u/bin/rig host-run claude-3f9a0c1d2e4b');
const HARNESS = proc(102, 101, '/Users/u/.local/bin/claude --name tg-cli');
const sock = () => true;

test('a record whose server runs the abduco session and whose tree holds one harness is live', () => {
  const { live, skipped } = liveHosts([rec()], [SERVER, SUPERVISOR, HARNESS], sock);
  expect(skipped).toEqual([]);
  expect(live).toEqual([{ ...rec(), agent: 'claude', harnessPid: 102 }]);
});

test('the harness pid comes from the process tree, not from a stale record', () => {
  const { live } = liveHosts([rec({ harnessPid: 4242 })], [SERVER, SUPERVISOR, HARNESS], sock);
  expect(live[0].harnessPid).toBe(102);
});

test('a relaunched harness (new pid under the same server) is found without a record rewrite', () => {
  const relaunched = proc(150, 101, '/Users/u/.local/bin/claude --resume abc');
  const { live } = liveHosts([rec()], [SERVER, SUPERVISOR, relaunched], sock);
  expect(live[0].harnessPid).toBe(150);
});

test('skipped: server pid is dead, or alive but is not the abduco server of this session', () => {
  expect(liveHosts([rec()], [SUPERVISOR, HARNESS], sock).skipped).toEqual([{ name: 'claude-3f9a0c1d2e4b', reason: 'server pid 100 is not running' }]);
  // pid reuse: the recorded pid now runs something else
  const reused = proc(100, 1, '/usr/bin/vim notes.md');
  expect(liveHosts([rec()], [reused, SUPERVISOR, HARNESS], sock).live).toEqual([]);
  // another abduco session took the pid
  const other = proc(100, 1, 'abduco -n omp-aaaaaaaaaaaa omp');
  expect(liveHosts([rec()], [other, HARNESS], sock).live).toEqual([]);
});

test('skipped: the socket is gone', () => {
  const { live, skipped } = liveHosts([rec()], [SERVER, SUPERVISOR, HARNESS], () => false);
  expect(live).toEqual([]);
  expect(skipped[0].reason).toMatch(/socket/);
});

test('skipped: no harness of the recorded kind under the server (mid-relaunch, or it exited)', () => {
  const { live, skipped } = liveHosts([rec()], [SERVER, SUPERVISOR], sock);
  expect(live).toEqual([]);
  expect(skipped[0].reason).toMatch(/no claude process/);
});

test('skipped: a different harness under the server is not the recorded one', () => {
  const codex = proc(102, 101, '/usr/local/bin/codex');
  expect(liveHosts([rec()], [SERVER, SUPERVISOR, codex], sock).live).toEqual([]);
});

test('skipped: two harnesses at the shallowest depth are ambiguous — fail closed', () => {
  const second = proc(103, 101, '/Users/u/.local/bin/claude --name other');
  const { live, skipped } = liveHosts([rec()], [SERVER, SUPERVISOR, HARNESS, second], sock);
  expect(live).toEqual([]);
  expect(skipped[0].reason).toMatch(/2 claude processes/);
});

test('a harness a deeper agent launched (claude -p from claude) does not make the session ambiguous', () => {
  const child = proc(200, 102, '/Users/u/.local/bin/claude -p task');
  const { live } = liveHosts([rec()], [SERVER, SUPERVISOR, HARNESS, child], sock);
  expect(live[0].harnessPid).toBe(102);
});

test('a harness started directly under the server (no supervisor) is found too', () => {
  const direct = proc(102, 100, 'claude');
  expect(liveHosts([rec()], [SERVER, direct], sock).live[0].harnessPid).toBe(102);
});

test('omp records are found by the omp binary, bun-from-source included', () => {
  const omp = rec({ name: 'omp-6a830edb351d', harness: 'omp', socket: '/s/omp-6a830edb351d@h' });
  const server = proc(100, 1, 'abduco -n omp-6a830edb351d rig host-run omp-6a830edb351d');
  const bin = proc(102, 100, '/opt/homebrew/bin/omp --resume /s.jsonl');
  expect(liveHosts([omp], [server, bin], sock).live[0]).toMatchObject({ agent: 'omp', harnessPid: 102 });
});

test('a pid cycle in a corrupt snapshot terminates', () => {
  const a = proc(100, 101, 'abduco -n claude-3f9a0c1d2e4b x');
  const b = proc(101, 100, 'sh');
  expect(liveHosts([rec()], [a, b], sock).live).toEqual([]);
});

// --- origin ids + selector matching ---

test('host:<name> is the synthetic origin/target id of a session hosted outside tmux', () => {
  expect(hostOriginId('claude-3f9a0c1d2e4b')).toBe('host:claude-3f9a0c1d2e4b');
  expect(hostNameFromOriginId('host:claude-3f9a0c1d2e4b')).toBe('claude-3f9a0c1d2e4b');
  for (const not of ['%3', 'omp:123', 'host:', 'host:../x', 'host:a b', 'hostx:abc']) expect(hostNameFromOriginId(not)).toBeNull();
});

const live = (over: Partial<HostRecord> = {}, agent: LiveHost['agent'] = 'claude', harnessPid = 102): LiveHost => ({ ...rec(over), agent, harnessPid });

// --- which host an arbitrary process belongs to ---

test('hostOfPid: a process below a live host server belongs to it; anything else belongs to none', () => {
  const h = live();
  const child = proc(300, 102, 'git status');
  const grandchild = proc(301, 300, 'sleep 1');
  const stranger = proc(400, 1, 'claude');
  const procs = [SERVER, SUPERVISOR, HARNESS, child, grandchild, stranger];
  expect(hostOfPid(102, procs, [h])).toBe(h);
  expect(hostOfPid(301, procs, [h])).toBe(h);
  expect(hostOfPid(400, procs, [h])).toBeNull();
  expect(hostOfPid(102, procs, [])).toBeNull();
});

test('hostOfPid terminates on a pid cycle', () => {
  const a = proc(100, 101, 'x');
  const b = proc(101, 100, 'y');
  expect(hostOfPid(101, [a, b], [live({ serverPid: 999 })])).toBeNull();
});

// --- picker rows + status ---

test('a host is an /agent candidate addressed host:<name>, named by its label', () => {
  const c = hostToCandidate(live({ label: 'landing', cwd: '/w/alpha' }, 'claude', 102));
  expect(c).toMatchObject({ paneId: 'host:claude-3f9a0c1d2e4b', agent: 'claude', windowName: 'landing', panePath: '/w/alpha', aliases: ['claude-3f9a0c1d2e4b'] });
});

test('an unlabelled host is named by its cwd project, then by harness and short id', () => {
  expect(hostToCandidate(live({ label: null, cwd: '/w/alpha' })).windowName).toBe('alpha');
  expect(hostToCandidate(live({ label: null, cwd: null })).windowName).toBe('claude · 3f9a0c1d');
});

test('hostsNotShownElsewhere: a host whose harness a pane or omp-live already shows is not listed a second time', () => {
  const shown = live({}, 'claude', 102);
  const hidden = live({ name: 'codex-bbbbbbbbbbbb', harness: 'codex', socket: '/s/codex-bbbbbbbbbbbb' }, 'codex', 103);
  expect(hostsNotShownElsewhere([shown, hidden], new Set([102])).map((h) => h.name)).toEqual(['codex-bbbbbbbbbbbb']);
  expect(hostsNotShownElsewhere([shown, hidden], new Set()).map((h) => h.name)).toEqual(['claude-3f9a0c1d2e4b', 'codex-bbbbbbbbbbbb']);
});

test('describeHost names the label, harness, session, cwd and that delivery is PTY injection', () => {
  expect(describeHost(live({ label: 'tg-cli' }))).toBe('tg-cli · claude — abduco claude-3f9a0c1d2e4b (cwd /Users/u/xp/tg-cli, pid 102) → PTY injection');
});
