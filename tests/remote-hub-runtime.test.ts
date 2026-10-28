import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveControlConfig } from '../features/tg-ctl/config';
import { ctlPaths } from '../features/tg-ctl/lock';
import { parseRemoteStatus } from '../features/tg-ctl/remote-hub-model';
import type { RemoteRouteEntry } from '../features/tg-ctl/remote-routes';
import { parseVoiceConfig, resolveVoiceConfig } from '../features/tg-ctl/voice';
import type { Ctx } from '../features/tg-ctl/daemon-runtime/ctx-io';
import { hubMachines, hubStatusLines, runRemote, sendRemoteDeliver } from '../features/tg-ctl/daemon-runtime/remote-hub';
import { fakeRemote } from './helpers/fake-remote';
import { fakeRemoteHub } from './helpers/fake-remote-hub';
import { TG_CTL, makeHubHarness } from './helpers/remote-hub-harness';
import { tempDir } from './helpers/test-temp';

// The impure daemon-host glue (daemon-runtime/remote-hub.ts) in-process, against a fake `tg-remote`
// (TG_REMOTE_BIN): which machines are served, the bounded spawns, delivery verdicts, the status block.

function ctxFor(remoteMachines: string | undefined): Ctx {
  const configDir = tempDir('tgctl-hub-runtime-');
  return {
    configDir,
    paths: ctlPaths(configDir, '123'),
    cfg: resolveControlConfig(remoteMachines === undefined ? {} : { remoteMachines }),
    voice: resolveVoiceConfig(parseVoiceConfig('')),
    token: '123:abc',
    chatId: 1,
    apiBase: 'http://127.0.0.1:1',
    botId: '123',
    home: configDir,
    cwd: configDir,
  };
}

const hit = (machine = 'clvm'): RemoteRouteEntry => ({
  machine,
  chat: '1',
  id: 700,
  route: { paneId: '%3', agentPid: 3003, serverPid: 4321, panePid: 5555, sessionKey: 'cc:pane:4321/%3/5555' },
  name: { primary: 'remoteproj', secondary: null },
  ts: 1_730_100_000_000,
});

test('hub OFF: no machines and no spawn at all', () => {
  const remote = fakeRemoteHub([]);

  expect(hubMachines(ctxFor(undefined), { TG_REMOTE_BIN: remote.bin })).toEqual([]);

  expect(remote.calls()).toEqual([]);
});

test('hub ON: the machines come from the config checker, asked once per process', () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'ultra@runtime-1' }]);
  const ctx = ctxFor('clvm=ultra@runtime-1');
  const env = { TG_REMOTE_BIN: remote.bin };

  expect(hubMachines(ctx, env)).toEqual([{ name: 'clvm', target: 'ultra@runtime-1' }]);
  expect(hubMachines(ctx, env)).toEqual([{ name: 'clvm', target: 'ultra@runtime-1' }]);

  expect(remote.calls().filter((c) => c.argv[0] === 'config')).toHaveLength(1);
});

test('hub ON with a checker that cannot answer: the names survive, so an unrecognised reply is still never auto-injected', () => {
  const broken = fakeRemote({ stdout: '', exit: 3 });

  const machines = hubMachines(ctxFor('clvm=ultra@runtime-2, lab=ultra@runtime-3'), { TG_REMOTE_BIN: broken.bin });

  expect(machines.map((m) => m.name)).toEqual(['clvm', 'lab']);
});

test('a spawn is bounded: a hanging tg-remote is killed at the deadline and reported as timed out', async () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'x' }]);
  remote.setDeliver('clvm', { stdout: '{"ok":true}\n', sleep: 30 });
  const started = Date.now();

  const run = await runRemote(ctxFor('clvm=x'), ['hub', 'deliver', 'clvm'], '{"idem":"1:2"}', 600, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH });

  expect(run.timedOut).toBe(true);
  expect(run.exitCode).toBeNull();
  expect(Date.now() - started).toBeLessThan(5000);
});

test('a tg-remote that cannot even start is not-started (nothing was handed over), not a timeout', async () => {
  const run = await runRemote(ctxFor('clvm=x'), ['hub', 'hello', 'clvm'], undefined, 2000, { PATH: '/nonexistent-dir' });

  expect(run).toEqual({ started: false, stdout: '', exitCode: null, timedOut: false });
});

test('the deliver is `python3 -I <launcher> hub deliver <machine>` with the request on stdin, and the verdict reaches the status facts', async () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'x' }]);
  const ctx = ctxFor('clvm=x');
  const env = { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH };

  const ok = await sendRemoteDeliver(ctx, hit(), 'hello', 77, env);

  expect(ok).toEqual({ ok: true });
  const [call] = remote.delivers();
  expect(call.isolated).toBe(1);
  expect(call.request).toEqual({ idem: '1:77', route: hit().route, text: 'hello', replyTo: { id: 700 } });
  expect(remote.calls()[0].configDir).toBe(ctx.configDir);
  const facts = parseRemoteStatus(await Bun.file(ctx.paths.remoteStatus).text());
  expect(facts.clvm.lastDeliver).toMatchObject({ result: 'delivered' });
});

test('every shape that leaves delivery open is uncertain, and a proven non-delivery is a failure', async () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'x' }]);
  const env = { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH };
  const cases: [string, number, 'uncertain' | 'failed'][] = [
    ['{"ok":false,"error":"ssh","uncertain":true}\n', 0, 'uncertain'],
    ['Traceback (most recent call last):\n', 1, 'uncertain'],
    ['', 0, 'uncertain'],
    ['{"ok":false,"duplicate":true,"outcome":"uncertain","uncertain":true}\n', 0, 'uncertain'],
    ['{"ok":true,"duplicate":true}\n', 0, 'uncertain'],
    ['{"ok":false,"error":"ssh","uncertain":false}\n', 0, 'failed'],
  ];
  for (const [stdout, exit, expected] of cases) {
    remote.setDeliver('clvm', { stdout, exit });
    const ctx = ctxFor('clvm=x');
    const res = await sendRemoteDeliver(ctx, hit(), 'hello', 77, env);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.uncertain === true).toBe(expected === 'uncertain');
    expect(parseRemoteStatus(await Bun.file(ctx.paths.remoteStatus).text()).clvm.lastDeliver?.result).toBe(expected);
  }
});

test('status block: every machine probed in parallel under a cap, a dead link shown as FAILED, the rest of the facts intact', async () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'ultra@status-1' }, { name: 'lab', target: 'ultra@status-2' }]);
  const ctx = ctxFor('clvm=ultra@status-1,lab=ultra@status-2');
  writeFileSync(ctx.paths.remoteStatus, JSON.stringify({ clvm: { records: 4, lastRecordAt: Date.now() - 5000, lastDeliver: { at: Date.now() - 60_000, result: 'uncertain' } } }));
  remote.setHello('lab', { stdout: '{"ok":false,"code":"PEER_UNKNOWN","detail":"not served"}\n', exit: 69 });

  const lines = await hubStatusLines(ctx, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH });
  const text = lines.join('\n');

  expect(text).toContain('remote machines: 2');
  expect(text).toContain('clvm → ultra@status-1');
  expect(text).toMatch(/hello: ok \(\d+ ms, tg-remote 1\.74\.0\)/);
  expect(text).toContain('records: 4, last 5s ago');
  expect(text).toContain('last deliver: uncertain');
  expect(text).toContain('lab → ultra@status-2');
  expect(text).toContain('hello: FAILED — PEER_UNKNOWN: not served');
  const hellos = remote.calls().filter((c) => c.argv[1] === 'hello');
  expect(hellos.map((c) => c.argv[2]).sort()).toEqual(['clvm', 'lab']);
  expect(hellos.every((c) => c.isolated === 1)).toBe(true);
});

test('status block: two hanging links both give up at the 6 s cap TOGETHER (parallel), never one after the other', async () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'ultra@status-3' }, { name: 'lab', target: 'ultra@status-4' }]);
  const ctx = ctxFor('clvm=ultra@status-3,lab=ultra@status-4');
  remote.setHello('clvm', { stdout: '{"ok":true}\n', sleep: 60 });
  remote.setHello('lab', { stdout: '{"ok":true}\n', sleep: 60 });
  const started = Date.now();

  const text = (await hubStatusLines(ctx, { TG_REMOTE_BIN: remote.bin, PATH: process.env.PATH })).join('\n');

  expect(text.match(/FAILED — no answer within 6 s/g)).toHaveLength(2);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

test('hub OFF: the status block is empty and nothing is spawned', async () => {
  const remote = fakeRemoteHub([]);

  expect(await hubStatusLines(ctxFor(undefined), { TG_REMOTE_BIN: remote.bin })).toEqual([]);

  expect(remote.calls()).toEqual([]);
});

// --- the real `tg-ctl status` CLI -------------------------------------------------------------------

async function cliStatus(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'status'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out;
}

const statusEnv = (cfgDir: string, bin: string): Record<string, string> => ({
  PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
  HOME: cfgDir,
  TG_CTL_CONFIG_DIR: cfgDir,
  TG_REMOTE_BIN: bin,
});

test('tg-ctl status prints the hub block on a hub with the machine, hello round trip, records and last deliver', async () => {
  const h = makeHubHarness({ remoteMachines: 'clvm=ultra@65.21.40.51' });
  mkdirSync(h.cfgDir, { recursive: true });
  writeFileSync(h.file('tg-ctl.123.remote-status.json'), JSON.stringify({ clvm: { records: 2, lastRecordAt: Date.now() - 3000, lastDeliver: { at: Date.now() - 9000, result: 'delivered' } } }));

  const out = await cliStatus(statusEnv(h.cfgDir, h.remote.bin));

  expect(out).toContain('remote machines: 1');
  expect(out).toContain('clvm → ultra@65.21.40.51');
  expect(out).toMatch(/hello: ok \(\d+ ms/);
  expect(out).toContain('records: 2');
  expect(out).toContain('last deliver: delivered');
  expect(h.remote.calls().filter((c) => c.argv[1] === 'hello')).toHaveLength(1);
}, 30_000);

test('tg-ctl status on a plain machine has no remote block and spawns no tg-remote', async () => {
  const h = makeHubHarness({});

  const out = await cliStatus(statusEnv(h.cfgDir, h.remote.bin));

  expect(out).not.toContain('remote machines');
  expect(h.remote.calls()).toEqual([]);
}, 30_000);

test('every tg-remote the hub starts is argv `python3 -I <launcher> hub deliver|hello <machine>`: a list, no shell, isolated', async () => {
  const remote = fakeRemoteHub([{ name: 'clvm', target: 'ultra@argv-1' }]);
  const ctx = ctxFor('clvm=ultra@argv-1');
  const python = Bun.which('python3');
  expect(python).not.toBeNull();
  const shims = tempDir('tg-python-shim-');
  const log = join(shims, 'argv.log');
  // A `python3` that records its argv, then hands over to the real interpreter.
  writeFileSync(join(shims, 'python3'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${python}' "$@"\n`, { mode: 0o755 });
  const env = { TG_REMOTE_BIN: remote.bin, PATH: `${shims}:${process.env.PATH}` };

  await sendRemoteDeliver(ctx, hit(), 'hello', 77, env);
  await hubStatusLines(ctx, env);

  // (The offline `config check` of remote-config.ts is a different seam, not asserted here.)
  const hubArgvs = (await Bun.file(log).text()).trim().split('\n').filter((a) => a.includes(' hub '));
  expect(hubArgvs.sort()).toEqual([`-I ${remote.bin} hub deliver clvm`, `-I ${remote.bin} hub hello clvm`]);
});
