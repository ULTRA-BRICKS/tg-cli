import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../features/tg-ctl/omp-live-extension.mjs';
import { listLiveEndpoints, sendLiveMessage } from '../features/tg-ctl/omp-live-runtime.mjs';

async function setup(t) {
  const config = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const root = join(config, 'omp-live');
  const prior = process.env.TG_CTL_CONFIG_DIR;
  process.env.TG_CTL_CONFIG_DIR = config;
  const handlers = new Map(), received = [], notifications = [];
  extension({ on: (name, fn) => handlers.set(name, fn), sendUserMessage: (text, options) => received.push({ text, options, pid: process.pid }) });
  const ctx = { hasUI: true, mode: 'tui', getAgentId: () => null, cwd: config, getSessionFile: () => '/session/real.jsonl', isIdle: () => false,
    sessionManager: { getSessionId: () => 'ext-session', getHeader: () => ({ title: 'Original' }) },
    ui: { notify: (...args) => notifications.push(args) } };
  t.after(async () => {
    await handlers.get('session_shutdown')();
    if (prior === undefined) delete process.env.TG_CTL_CONFIG_DIR; else process.env.TG_CTL_CONFIG_DIR = prior;
    await rm(config, { recursive: true, force: true });
  });
  return { root, handlers, ctx, received, notifications };
}

test('extension enqueues a followUp into the existing busy context', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root))[0].busy, true);
  await sendLiveMessage({ root: f.root, pid: process.pid, requestId: 'ext', text: 'follow up' });
  assert.deepEqual(f.received, [{ text: 'follow up', options: { deliverAs: 'followUp' }, pid: process.pid }]);
});

test('print, ACP-like headless and subagent contexts never publish', async t => {
  const f = await setup(t);
  for (const override of [{ mode: 'print' }, { mode: 'rpc', hasUI: false }, { getAgentId: () => 'child-worker' }]) {
    await f.handlers.get('session_start')({}, { ...f.ctx, ...override });
    assert.deepEqual(await listLiveEndpoints(f.root), []);
  }
});

test('session switch withdraws the old registration and targets only the new context', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  const old = (await listLiveEndpoints(f.root))[0];
  const next = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => 'next' } };
  await f.handlers.get('session_switch')({}, next);
  const current = await listLiveEndpoints(f.root);
  assert.equal(current.length, 1);
  assert.equal(current[0].sessionId, 'next');
  assert.notEqual(current[0].instanceId, old.instanceId);
  await assert.rejects(sendLiveMessage({ root: f.root, pid: process.pid, instanceId: old.instanceId, requestId: 'old', text: 'old' }), /stale_identity/);
});

test('reload preserves one endpoint; late old shutdown cannot delete the new endpoint', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  const handlers2 = new Map();
  extension({ on: (event, fn) => handlers2.set(event, fn), sendUserMessage: () => {} });
  t.after(() => handlers2.get('session_shutdown')());
  await handlers2.get('session_start')({}, f.ctx);
  await f.handlers.get('session_shutdown')();
  assert.equal((await listLiveEndpoints(f.root)).length, 1);
});

test('unsafe registry error is contained and cannot terminate the host', async t => {
  const f = await setup(t);
  await mkdir(f.root, { mode: 0o755 });
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.received.length, 0);
});
test('idle delivery starts a turn and a concurrent newly-started turn is not interrupted', async t => {
  const f = await setup(t);
  f.ctx.isIdle = () => true;
  await f.handlers.get('session_start')({}, f.ctx);
  await sendLiveMessage({ root: f.root, pid: process.pid, requestId: 'idle', text: 'wake original' });
  // OMP's real implementation queues followUp even while idle. Aside starts idle
  // work and remains non-interrupting if another turn wins the admission race.
  assert.equal(f.received[0].options.deliverAs, 'aside');
});
