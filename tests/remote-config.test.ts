import { expect, test } from 'bun:test';
import { parseControlConfig, resolveControlConfig } from '../features/tg-ctl/config';
import { ctlPaths, shouldAutoStart } from '../features/tg-ctl/lock';
import { parseRemoteCheck, resolveRemoteMode, type RemoteSpawnResult } from '../features/tg-ctl/remote-config';
import { DEFAULT_CONTROL } from '../features/tg-ctl/types';
import { fakeRemote, REMOTE_INVALID, REMOTE_OK_CLIENT, REMOTE_OK_HUB } from './helpers/fake-remote';

// --- raw keys -----------------------------------------------------------------------------

test('control.server / machine / remote_machines are parsed as raw trimmed strings', () => {
  const yaml = [
    'control:',
    '  server: "ssh://tg-ctl-ubuntu"',
    "  machine: 'clvm'",
    '  remote_machines:   clvm=ultra@65.21.40.51, other=h2  ',
  ].join('\n');
  expect(parseControlConfig(yaml)).toEqual({
    server: 'ssh://tg-ctl-ubuntu',
    machine: 'clvm',
    remoteMachines: 'clvm=ultra@65.21.40.51, other=h2',
  });
});

test('no validation in TypeScript: an invalid value is carried through verbatim', () => {
  expect(parseControlConfig('control:\n  server: ssh://-oProxyCommand=x\n').server).toBe('ssh://-oProxyCommand=x');
});

test('absent or empty remote keys are undefined and defaults stay untouched', () => {
  for (const yaml of ['', 'control:\n  enabled: true\n', 'control:\n  server:\n  machine: ""\n  remote_machines: "  "\n']) {
    const cfg = resolveControlConfig(parseControlConfig(yaml));
    expect(cfg.server).toBeUndefined();
    expect(cfg.machine).toBeUndefined();
    expect(cfg.remoteMachines).toBeUndefined();
    expect(cfg).not.toHaveProperty('server');
  }
  expect(resolveControlConfig({})).toEqual(DEFAULT_CONTROL);
});

test('resolveControlConfig keeps the three keys and every other default', () => {
  const cfg = resolveControlConfig({ server: 'ssh://a', machine: 'm', remoteMachines: 'x=y' });
  expect(cfg).toEqual({ ...DEFAULT_CONTROL, server: 'ssh://a', machine: 'm', remoteMachines: 'x=y' });
});

// --- lock.ts ------------------------------------------------------------------------------

test('shouldAutoStart is false for a ctl client even inside tmux with control enabled', () => {
  const env = { TMUX: '/tmp/tmux-1/default,1,0' };
  expect(shouldAutoStart(env, { ...DEFAULT_CONTROL })).toBe(true);
  expect(shouldAutoStart(env, { ...DEFAULT_CONTROL, server: 'ssh://tg-ctl-ubuntu' })).toBe(false);
  // The daemon host keeps today's behaviour.
  expect(shouldAutoStart(env, { ...DEFAULT_CONTROL, remoteMachines: 'clvm=ultra@h' })).toBe(true);
});

test('ctlPaths names the remote state: dir plus per-bot routes and status files', () => {
  const p = ctlPaths('/home/u/.config/tg-cli', '8574086668');
  expect(p.remoteDir).toBe('/home/u/.config/tg-cli/remote');
  expect(p.remoteRoutes).toBe('/home/u/.config/tg-cli/tg-ctl.8574086668.remote-routes.json');
  expect(p.remoteStatus).toBe('/home/u/.config/tg-cli/tg-ctl.8574086668.remote-status.json');
});

// --- parseRemoteCheck ---------------------------------------------------------------------

const CLIENT = { mode: 'client', server: 'ssh://tg-ctl-ubuntu', alias: 'tg-ctl-ubuntu', machine: 'clvm' } as const;
const HUB = { mode: 'hub', remoteMachines: [{ name: 'clvm', target: 'ultra@65.21.40.51' }] } as const;

const hubWith = (remote_machines: object) => JSON.stringify({ ok: true, mode: 'hub', remote_machines });

test.each([
  ['ok client', REMOTE_OK_CLIENT, 0, CLIENT],
  ['ok hub', REMOTE_OK_HUB, 0, HUB],
  ['ok local', '{"ok":true,"mode":"local","errors":[]}\n', 0, { mode: 'local' }],
  ['invalid report keeps every error line', REMOTE_INVALID, 78, { mode: 'invalid', errors: ['control.server: must match ^ssh://alias$', 'control.machine: required when control.server is set'] }],
  ['invalid report with no error text still invalid', '{"ok":false,"errors":[]}', 78, { mode: 'invalid', errors: ['remote config is invalid'] }],
  ['ok:false with exit 0 is still invalid', '{"ok":false,"errors":["control.machine: x"]}', 0, { mode: 'invalid', errors: ['control.machine: x'] }],
  ['garbage', 'Traceback (most recent call last):', 0, { mode: 'invalid', errors: ['tg-remote unavailable: unparsable config check output'] }],
  ['empty output', '', 0, { mode: 'invalid', errors: ['tg-remote unavailable: unparsable config check output'] }],
  ['garbage with a crash code', 'boom', 1, { mode: 'invalid', errors: ['tg-remote unavailable: config check exited 1 without a report'] }],
  ['json but not an object', '[1]', 0, { mode: 'invalid', errors: ['tg-remote unavailable: unparsable config check output'] }],
  ['ok without exit 0', REMOTE_OK_CLIENT, 1, { mode: 'invalid', errors: ['tg-remote unavailable: config check reported ok but exited 1'] }],
  ['killed (null exit code)', REMOTE_OK_CLIENT, null, { mode: 'invalid', errors: ['tg-remote unavailable: check did not finish'] }],
  ['client missing machine', '{"ok":true,"mode":"client","server":"ssh://a","alias":"a","machine":null}', 0, { mode: 'invalid', errors: ['tg-remote unavailable: client report is missing server, alias or machine'] }],
  ['hub without machines', hubWith([]), 0, { mode: 'invalid', errors: ['tg-remote unavailable: hub report has no remote_machines'] }],
  ['hub with malformed entry', hubWith([{ name: 'clvm' }]), 0, { mode: 'invalid', errors: ['tg-remote unavailable: hub report has a malformed remote_machines entry'] }],
  ['unknown mode', '{"ok":true,"mode":"proxy"}', 0, { mode: 'invalid', errors: ['tg-remote unavailable: config check reported an unknown mode'] }],
])('parseRemoteCheck: %s', (_name, stdout, exit, expected) => {
  expect(parseRemoteCheck(stdout, exit)).toEqual(expected);
});

// --- resolveRemoteMode --------------------------------------------------------------------

const never = (): RemoteSpawnResult => {
  throw new Error('spawn must not run');
};

test('no remote key: local without spawning anything', () => {
  expect(resolveRemoteMode(resolveControlConfig({}), {}, { spawn: never })).toEqual({ mode: 'local' });
});

test('any single remote key triggers exactly one check: python3 -I <TG_REMOTE_BIN> config check --json', () => {
  for (const [cfg, reply, expected] of [
    [{ server: 'ssh://x' }, REMOTE_OK_CLIENT, CLIENT],
    [{ server: 'ssh://x', machine: 'm' }, REMOTE_OK_CLIENT, CLIENT],
    [{ remoteMachines: 'a=b' }, REMOTE_OK_HUB, HUB],
  ] as const) {
    const seen: { argv: string[]; env: Record<string, string | undefined>; timeoutMs: number }[] = [];
    const mode = resolveRemoteMode(cfg, { TG_REMOTE_BIN: '/opt/tg-remote', PATH: '/bin' }, {
      configDir: '/cfg/dir',
      spawn: (argv, env, timeoutMs) => {
        seen.push({ argv, env, timeoutMs });
        return { stdout: reply, stderr: '', exitCode: 0, timedOut: false };
      },
    });
    expect(mode).toEqual(expected);
    expect(seen).toHaveLength(1);
    expect(seen[0].argv).toEqual(['python3', '-I', '/opt/tg-remote', 'config', 'check', '--json']);
    expect(seen[0].env.TG_CTL_CONFIG_DIR).toBe('/cfg/dir');
    expect(seen[0].timeoutMs).toBe(3000);
  }
});

test('the default launcher is <repo root>/tg-remote when TG_REMOTE_BIN is unset', () => {
  let argv: string[] = [];
  resolveRemoteMode({ server: 'ssh://x' }, {}, {
    rootDir: '/repo',
    spawn: (a) => {
      argv = a;
      return { stdout: REMOTE_OK_CLIENT, stderr: '', exitCode: 0, timedOut: false };
    },
  });
  expect(argv.slice(0, 3)).toEqual(['python3', '-I', '/repo/tg-remote']);
});

test('spawn failure, timeout and unparsable output are invalid — never silently local', () => {
  const cfg = { server: 'ssh://x' };
  expect(resolveRemoteMode(cfg, {}, { spawn: () => { throw new Error('ENOENT: python3'); } }))
    .toEqual({ mode: 'invalid', errors: ['tg-remote unavailable: ENOENT: python3'] });
  expect(resolveRemoteMode(cfg, {}, { spawn: () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }) }))
    .toEqual({ mode: 'invalid', errors: ['tg-remote unavailable: config check timed out after 3000 ms'] });
  expect(resolveRemoteMode(cfg, {}, { spawn: () => ({ stdout: 'nope', stderr: "can't open file\nmore", exitCode: 2, timedOut: false }) }))
    .toEqual({ mode: 'invalid', errors: ["tg-remote unavailable: config check exited 2 without a report (can't open file)"] });
});

test('a real child process: the fake launcher answers and receives the resolved config dir', () => {
  const remote = fakeRemote({ stdout: REMOTE_OK_HUB, exit: 0 });
  const mode = resolveRemoteMode({ remoteMachines: 'clvm=ultra@65.21.40.51' }, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH }, { configDir: '/tmp/cfg-x' });
  expect(mode).toEqual(HUB);
  expect(remote.calls()).toEqual([{ argv: ['config', 'check', '--json'], configDir: '/tmp/cfg-x', isolated: true }]);
});

test('a real child process: exit 78 + ok:false is invalid with the diagnostics', () => {
  const remote = fakeRemote({ stdout: REMOTE_INVALID, exit: 78 });
  const mode = resolveRemoteMode({ server: 'ssh://x' }, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH });
  expect(mode.mode).toBe('invalid');
  expect(mode.mode === 'invalid' && mode.errors).toHaveLength(2);
});

test('a missing launcher file is invalid, not local', () => {
  const mode = resolveRemoteMode({ server: 'ssh://x' }, { TG_REMOTE_BIN: '/nonexistent/tg-remote', PATH: process.env.PATH });
  expect(mode.mode).toBe('invalid');
});

// --- contradiction invariant: the checker may only confirm the role the observed keys imply ---

const LOCAL_OK = '{"ok":true,"mode":"local","errors":[]}\n';

test.each([
  ['server set, checker says local', { server: 'ssh://x', machine: 'm' }, LOCAL_OK, 'client', 'local'],
  ['server set, checker says hub', { server: 'ssh://x', machine: 'm' }, REMOTE_OK_HUB, 'client', 'hub'],
  ['remote_machines set, checker says local', { remoteMachines: 'a=b' }, LOCAL_OK, 'hub', 'local'],
  ['remote_machines set, checker says client', { remoteMachines: 'a=b' }, REMOTE_OK_CLIENT, 'hub', 'client'],
  ['machine alone, checker says local', { machine: 'm' }, LOCAL_OK, 'invalid', 'local'],
  ['machine alone, checker says hub', { machine: 'm' }, REMOTE_OK_HUB, 'invalid', 'hub'],
  ['machine alone, checker says client', { machine: 'm' }, REMOTE_OK_CLIENT, 'invalid', 'client'],
  ['both roles set, checker says client', { server: 'ssh://x', machine: 'm', remoteMachines: 'a=b' }, REMOTE_OK_CLIENT, 'invalid', 'client'],
])('contradiction: %s is invalid, never local', (_name, cfg, stdout, expected, reported) => {
  const mode = resolveRemoteMode(cfg, {}, { spawn: () => ({ stdout, stderr: '', exitCode: 0, timedOut: false }) });
  expect(mode).toEqual({
    mode: 'invalid',
    errors: [`remote config changed between read and check: expected ${expected}, checker reported ${reported}`],
  });
});

test('the confirmed roles still pass: server => client, remote_machines => hub', () => {
  const ok = (stdout: string) => () => ({ stdout, stderr: '', exitCode: 0, timedOut: false });
  expect(resolveRemoteMode({ server: 'ssh://x', machine: 'm' }, {}, { spawn: ok(REMOTE_OK_CLIENT) })).toEqual(CLIENT);
  expect(resolveRemoteMode({ remoteMachines: 'a=b' }, {}, { spawn: ok(REMOTE_OK_HUB) })).toEqual(HUB);
});

test('a real child process reporting local while control.server is set is invalid', () => {
  const remote = fakeRemote({ stdout: LOCAL_OK, exit: 0 });
  const mode = resolveRemoteMode({ server: 'ssh://x', machine: 'm' }, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH });
  expect(mode.mode).toBe('invalid');
});

test('the checker runs under an isolated interpreter (python3 -I)', () => {
  const remote = fakeRemote({ stdout: REMOTE_OK_CLIENT, exit: 0 });
  resolveRemoteMode({ server: 'ssh://x', machine: 'm' }, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH });
  expect(remote.calls()).toHaveLength(1);
  expect(remote.calls()[0].isolated).toBe(true);
});
