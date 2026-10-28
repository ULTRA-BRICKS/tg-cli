import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { CLIENT_YAML, clientFixture, runEntry, type ClientFixture } from './helpers/client-send';
import { REMOTE_INVALID } from './helpers/fake-remote';
import { fakeRemoteClient } from './helpers/fake-remote-client';

// `tg-ctl` on a ctl-client machine (docs/specs/2026-10-28-remote-ctl-server.md §6): `status` reports the
// SERVER's measured health, the daemon-bound operations are refused with a typed line and exit 69, and
// `ask` — a harness hook — keeps exactly its no-daemon behaviour and only gains the line.

const ctl = (args: string[], f: ClientFixture, remoteBin: string, stdin?: string) =>
  runEntry('tg-ctl', args, f, { TG_REMOTE_BIN: remoteBin, TG_API_BASE: 'http://127.0.0.1:1' }, stdin);

const STATUS_OK = JSON.stringify({
  ok: true,
  peer: 'clvm',
  daemon: { up: true, pid: 4242, code: 'abc1234' },
  remote: { records: 12, lastRecordAt: Date.UTC(2026, 9, 28, 8, 30), lastDeliver: { at: Date.UTC(2026, 9, 28, 8, 31), result: 'delivered' } },
  journal: { depth: 0, oldest: null },
});

// --- status ---------------------------------------------------------------------------------------

test('status on a client prints the server block from a real tg-remote round trip, exit 0', async () => {
  const remote = fakeRemoteClient({ 'client status': { stdout: `${STATUS_OK}\n` } });
  const f = clientFixture();
  const r = await ctl(['status'], f, remote.bin);
  expect(r.code).toBe(0);
  expect(r.out).toBe(
    [
      'server: ssh://tg-ctl-ubuntu (ssh stdio, machine clvm)',
      '  link: ok (peer clvm)',
      '  daemon: up (pid 4242, code abc1234)',
      '  journal: empty',
      '  records: 12 recorded, last 2026-10-28T08:30:00.000Z',
      '  last deliver: delivered at 2026-10-28T08:31:00.000Z',
      '',
    ].join('\n'),
  );
  const [call] = remote.callsOf('client status');
  expect(call!.origArgv.slice(0, 2)).toEqual(['python3', '-I']);
  expect(remote.callsOf('client record')).toHaveLength(0);
}, 30_000);

test('status needs no Telegram credentials on a client (it never polls)', async () => {
  const remote = fakeRemoteClient({ 'client status': { stdout: `${STATUS_OK}\n` } });
  const f = clientFixture();
  rmSync(join(f.configDir, '.env'));
  expect((await ctl(['status'], f, remote.bin)).code).toBe(0);
}, 30_000);

test.each([
  ['the tool exits 69', { stderr: 'tg-remote: ssh: connection refused\n', exit: 69 }, 'server: unreachable (tg-remote exited 69: tg-remote: ssh: connection refused)'],
  ['the tool prints garbage', { stdout: 'nonsense\n' }, 'server: unreachable (unparsable output)'],
  ['the server refuses', { stdout: '{"ok":false,"code":"BOT_MISMATCH","detail":"other bot"}\n', exit: 69 }, 'server: unreachable (BOT_MISMATCH: other bot)'],
])('status on a client whose server is unreachable (%s) says so and exits 69', async (_name, reply, line) => {
  const remote = fakeRemoteClient({ 'client status': reply });
  const r = await ctl(['status'], clientFixture(), remote.bin);
  expect(r.code).toBe(69);
  expect(r.out).toContain(line);
  expect(r.out).toContain('server: ssh://tg-ctl-ubuntu (ssh stdio, machine clvm)');
  expect(r.out).not.toContain('link: ok');
}, 30_000);

test('status with an invalid remote config prints the diagnostics and exits 78 without asking any server', async () => {
  const remote = fakeRemoteClient({ 'config check': { stdout: REMOTE_INVALID, exit: 78 } });
  const r = await ctl(['status'], clientFixture('control:\n  server: ssh://u@h\n'), remote.bin);
  expect(r.code).toBe(78);
  expect(r.err).toContain('tg-ctl: invalid remote config: control.server: must match ^ssh://alias$\n');
  expect(remote.callsOf('client status')).toHaveLength(0);
}, 30_000);

test('status on a plain local machine: no tg-remote spawn, no server block', async () => {
  const remote = fakeRemoteClient();
  const r = await ctl(['status'], clientFixture(null), remote.bin);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('server:');
  expect(remote.calls()).toEqual([]);
}, 30_000);

// --- refusals ---------------------------------------------------------------------------------------

test.each(['withdraw', 'alert', 'inbox', 'audit-delivery', 'harness-event'])('%s on a client is refused: typed line, exit 69, no daemon, nothing started', async (op) => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  const r = await ctl([op], f, remote.bin);
  expect(r.code).toBe(69);
  expect(r.err).toContain(`tg-ctl: ctl server ssh://tg-ctl-ubuntu: ${op} is not supported for remote clients\n`);
  expect(r.out).toBe('');
  expect(remote.calls().map((c) => c.argv)).toEqual([['config', 'check', '--json']]);
  expect(existsSync(join(f.configDir, 'remote'))).toBe(false);
}, 30_000);

const hookRequest = JSON.stringify({
  requestId: 'req-client-1',
  agent: 'claude',
  kind: 'permission',
  question: 'Approve a one-time exception?',
  title: 'Hatch: no-long-inline-process',
  decisionLabels: { allow: 'Approve', deny: 'Deny' },
  cwd: '/some/dir',
});

test('ask (hook form) on a client keeps today\'s no-daemon exit and stdout; stderr only gains the refusal line', async () => {
  const remote = fakeRemoteClient();
  const asClient = await ctl(['ask'], clientFixture(`${CLIENT_YAML}  enabled: true\n`), remote.bin, `${hookRequest}\n`);
  const asLocal = await ctl(['ask'], clientFixture('control:\n  enabled: true\n'), remote.bin, `${hookRequest}\n`);
  const line = 'tg-ctl: ctl server ssh://tg-ctl-ubuntu: ask is not supported for remote clients\n';
  expect(asLocal.err).not.toContain('not supported for remote clients');
  expect(asClient.code).toBe(asLocal.code);
  expect(asClient.out).toBe(asLocal.out);
  expect(asClient.err).toContain(line);
  const untimed = (text: string) => text.replace(/^\[[^\]]+\] /gm, '');
  expect(untimed(asClient.err.replace(line, ''))).toBe(untimed(asLocal.err));
}, 30_000);

test('generic ask on a client keeps its own denial (exit 1, daemon unreachable) and only gains the line', async () => {
  const remote = fakeRemoteClient();
  const r = await ctl(['ask', 'may I?', '--timeout', '1'], clientFixture(`${CLIENT_YAML}  enabled: true\n`), remote.bin);
  expect(r.code).toBe(1);
  expect(r.out).toBe('');
  expect(r.err).toContain('tg-ctl: ctl server ssh://tg-ctl-ubuntu: ask is not supported for remote clients\n');
  expect(r.err).toContain('denied: daemon unreachable');
}, 30_000);

test('a plain local machine runs these operations exactly as before: no spawn, no refusal line', async () => {
  const remote = fakeRemoteClient();
  const r = await ctl(['inbox'], clientFixture('control:\n  enabled: true\n'), remote.bin);
  expect(r.err).not.toContain('not supported for remote clients');
  expect(r.code).not.toBe(69);
  expect(remote.calls()).toEqual([]);
}, 30_000);
