import { expect, test } from 'bun:test';
import { clientRefusalLine, describeClientStatus, type ClientStatusRun } from '../features/tg-ctl/daemon-runtime/remote-client-status';

// Pure mapping of `tg-remote client status` output to the `server:` block of `tg-ctl status`
// (docs/specs/2026-10-28-remote-ctl-server.md §6). The health shown is whatever the tool measured;
// nothing here can invent an "ok".

const CLIENT = { server: 'ssh://tg-ctl-ubuntu', machine: 'clvm' };
const HEADER = 'server: ssh://tg-ctl-ubuntu (ssh stdio, machine clvm)';

const run = (over: Partial<ClientStatusRun> = {}): ClientStatusRun => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, ...over });

const OK_BODY = {
  ok: true,
  peer: 'clvm',
  daemon: { up: true, pid: 4242, code: 'abc1234' },
  remote: { records: 12, lastRecordAt: Date.UTC(2026, 9, 28, 8, 30, 0), lastDeliver: { at: Date.UTC(2026, 9, 28, 8, 31, 0), result: 'delivered' } },
  journal: { depth: 2, oldest: Date.UTC(2026, 9, 28, 7, 0, 0) },
};

test('a reachable server prints the transport, the real hello/daemon/journal/record health and exits 0', () => {
  const result = describeClientStatus(CLIENT, run({ stdout: `${JSON.stringify(OK_BODY)}\n` }));
  expect(result.exitCode).toBe(0);
  expect(result.lines).toEqual([
    HEADER,
    '  link: ok (peer clvm)',
    '  daemon: up (pid 4242, code abc1234)',
    '  journal: 2 pending, oldest 2026-10-28T07:00:00.000Z',
    '  records: 12 recorded, last 2026-10-28T08:30:00.000Z',
    '  last deliver: delivered at 2026-10-28T08:31:00.000Z',
  ]);
});

test('empty journal, no records yet, no deliver yet', () => {
  const body = { ok: true, peer: 'clvm', daemon: { up: true, pid: 1, code: 'x' }, remote: { records: 0, lastRecordAt: null, lastDeliver: null }, journal: { depth: 0, oldest: null } };
  const lines = describeClientStatus(CLIENT, run({ stdout: JSON.stringify(body) })).lines;
  expect(lines).toContain('  journal: empty');
  expect(lines).toContain('  records: 0 recorded, none yet');
  expect(lines).toContain('  last deliver: none yet');
});

test('the server reachable but its daemon down says so (records are journaled meanwhile), still exit 0', () => {
  const body = { ...OK_BODY, daemon: { up: false } };
  const result = describeClientStatus(CLIENT, run({ stdout: JSON.stringify(body) }));
  expect(result.exitCode).toBe(0);
  expect(result.lines).toContain('  daemon: DOWN (records are journaled until it is back)');
});

test('the tool nests the server reply under `reply` and reports the journal as a bare depth: both are read', () => {
  const body = { ok: true, journal: 3, reply: { ok: true, peer: 'clvm', daemon: { up: true, pid: 9, code: 'c' }, remote: { records: 1, lastRecordAt: null, lastDeliver: null } } };
  const lines = describeClientStatus(CLIENT, run({ stdout: JSON.stringify(body) })).lines;
  expect(lines).toContain('  daemon: up (pid 9, code c)');
  expect(lines).toContain('  journal: 3 pending');
});

test.each([
  ['the server says no', run({ stdout: '{"ok":false,"code":"BOT_MISMATCH","detail":"other bot"}', exitCode: 69 }), 'BOT_MISMATCH: other bot'],
  ['unreachable exit without a report', run({ exitCode: 69, stderr: 'tg-remote: ssh: connection refused\n' }), 'tg-remote exited 69: tg-remote: ssh: connection refused'],
  ['garbage', run({ stdout: 'nope' }), 'unparsable output'],
  ['ok:false even with exit 0', run({ stdout: '{"ok":false,"code":"NO_DAEMON","detail":"down"}' }), 'NO_DAEMON: down'],
  ['a timeout', run({ timedOut: true, exitCode: null }), 'timed out after 12 s'],
  ['a missing interpreter', run({ spawnError: 'python3: not found', exitCode: null }), 'python3: not found'],
  ['a body that is not an object', run({ stdout: '[]' }), 'unparsable output'],
])('unreachable: %s -> `server: unreachable (<cause>)`, exit 69', (_name, r, cause) => {
  const result = describeClientStatus(CLIENT, r);
  expect(result.exitCode).toBe(69);
  expect(result.lines).toEqual([HEADER, `server: unreachable (${cause})`]);
});

test('the refusal line names the server and the operation', () => {
  expect(clientRefusalLine('ssh://tg-ctl-ubuntu', 'withdraw')).toBe('tg-ctl: ctl server ssh://tg-ctl-ubuntu: withdraw is not supported for remote clients');
});
