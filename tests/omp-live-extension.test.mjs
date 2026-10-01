import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, lstat, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../features/tg-ctl/omp-live-extension.mjs';
import { listLiveEndpoints, sendLiveMessage } from '../features/tg-ctl/omp-live-runtime.mjs';

async function setup(t, pi = {}) {
  const config = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const root = join(config, 'omp-live');
  const prior = process.env.TG_CTL_CONFIG_DIR;
  process.env.TG_CTL_CONFIG_DIR = config;
  const handlers = new Map(), received = [], notifications = [];
  extension({ on: (name, fn) => handlers.set(name, fn), sendUserMessage: (text, options) => received.push({ text, options, pid: process.pid }), ...pi });
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

test('a message arriving mid-turn steers the busy context (wakes a wait tool); followUp would starve until the run ends', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root))[0].busy, true);
  await sendLiveMessage({ root: f.root, pid: process.pid, requestId: 'ext', text: 'follow up' });
  assert.deepEqual(f.received, [{ text: 'follow up', options: { deliverAs: 'steer' }, pid: process.pid }]);
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

async function endpointFiles(root, row) {
  const metadataPath = join(root, `${row.pid}-${row.instanceId}.json`);
  const meta = JSON.parse(await readFile(metadataPath, 'utf8'));
  return { metadataPath, socketPath: meta.socket };
}
const present = async path => { try { await lstat(path); return true; } catch { return false; } };

test('#462: an in-process subagent bind, start and shutdown never withdraw the main endpoint', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  const [main] = await listLiveEndpoints(f.root);
  const files = await endpointFiles(f.root, main);
  // OMP 18.3 re-binds the SAME prepared factory for every in-process task subagent.
  const sub = new Map();
  extension({ on: (name, fn) => sub.set(name, fn), sendUserMessage: () => { throw new Error('a subagent must never receive Telegram input'); } });
  const subCtx = { ...f.ctx, hasUI: false, getAgentId: () => 'TaskWorker',
    sessionManager: { getSessionId: () => 'sub-session', getHeader: () => ({ title: 'Worker' }) } };
  await sub.get('session_start')({}, subCtx);
  await sub.get('turn_end')?.({}, subCtx);
  await sub.get('agent_end')?.({}, subCtx);
  await sub.get('session_shutdown')({}, subCtx);

  const after = await listLiveEndpoints(f.root);
  assert.deepEqual(after.map(r => [r.instanceId, r.sessionId]), [[main.instanceId, 'ext-session']]);
  assert.equal(await present(files.metadataPath), true);
  assert.equal((await lstat(files.socketPath)).isSocket(), true);
  const receipt = await sendLiveMessage({ root: f.root, pid: process.pid, instanceId: main.instanceId, sessionId: 'ext-session', requestId: 'after-subagent', text: 'still reachable' });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(f.received.map(r => r.text), ['still reachable']);

  // The main session still owns (and on shutdown removes) its own endpoint.
  await f.handlers.get('session_shutdown')();
  assert.deepEqual(await listLiveEndpoints(f.root), []);
  assert.equal(await present(files.metadataPath), false);
  assert.equal(await present(files.socketPath), false);
});

test('#458: turn_end/agent_end republish a missing main endpoint and keep a present one stable', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  const [first] = await listLiveEndpoints(f.root);
  await f.handlers.get('turn_end')({}, f.ctx);
  assert.deepEqual((await listLiveEndpoints(f.root)).map(r => r.instanceId), [first.instanceId]);

  // Registration withdrawn behind the session's back (registry wiped, pruned, …).
  await rm(f.root, { recursive: true, force: true });
  assert.deepEqual(await listLiveEndpoints(f.root), []);
  await f.handlers.get('agent_end')({}, f.ctx);
  const healed = await listLiveEndpoints(f.root);
  assert.equal(healed.length, 1);
  assert.notEqual(healed[0].instanceId, first.instanceId);
  await sendLiveMessage({ root: f.root, pid: process.pid, instanceId: healed[0].instanceId, requestId: 'healed', text: 'after heal' });
  assert.deepEqual(f.received.map(r => r.text), ['after heal']);
});

test('#458: a failed startup publish is retried at turn_end without repeating the warning', async t => {
  const f = await setup(t);
  await mkdir(f.root, { mode: 0o755 });
  await f.handlers.get('session_start')({}, f.ctx);
  await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(await listLiveEndpoints(f.root).catch(() => []), []);
  await chmod(f.root, 0o700);
  await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root)).length, 1);
});

test('#458: a stale reloaded binding never re-claims from the current owner at turn_end', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  const handlers2 = new Map();
  extension({ on: (event, fn) => handlers2.set(event, fn), sendUserMessage: () => {} });
  t.after(() => handlers2.get('session_shutdown')());
  await handlers2.get('session_start')({}, f.ctx);
  const [current] = await listLiveEndpoints(f.root);
  await f.handlers.get('turn_end')({}, f.ctx);
  assert.deepEqual((await listLiveEndpoints(f.root)).map(r => r.instanceId), [current.instanceId]);
});

// #460: the endpoint reports the session's CURRENT name at status time, so an
// omp `/rename` reaches tg-ctl's registry without a republish; the header title
// is the name the session started with.
test('#460: status reports the live session name after /rename, not the header title', async t => {
  let name = 'Original';
  const f = await setup(t, { getSessionName: () => name });
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root))[0].title, 'Original');
  name = 'Renamed';
  assert.equal((await listLiveEndpoints(f.root))[0].title, 'Renamed');
});

test('#460: an omp without getSessionName still reports the header title', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root))[0].title, 'Original');
});

// A session `rig harness run omp` hosts exports RIG_SESSION (the abduco name) and scrubs
// RIG_OMP_SESSION; `rig omp save-panes` matches a pane to its omp-live host by this field.
test('#538: the descriptor carries the abduco session name from RIG_SESSION, not the retired RIG_OMP_SESSION', async t => {
  const priorNew = process.env.RIG_SESSION, priorOld = process.env.RIG_OMP_SESSION;
  process.env.RIG_SESSION = 'omp-0123456789ab';
  process.env.RIG_OMP_SESSION = 'omp-retired-name';
  t.after(() => {
    for (const [key, value] of [['RIG_SESSION', priorNew], ['RIG_OMP_SESSION', priorOld]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root))[0].durableSession, 'omp-0123456789ab');
});

test('#538: an omp with only the retired RIG_OMP_SESSION reports no durableSession (matched by abduco ancestry instead)', async t => {
  const priorNew = process.env.RIG_SESSION, priorOld = process.env.RIG_OMP_SESSION;
  delete process.env.RIG_SESSION;
  process.env.RIG_OMP_SESSION = 'omp-retired-name';
  t.after(() => {
    for (const [key, value] of [['RIG_SESSION', priorNew], ['RIG_OMP_SESSION', priorOld]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal((await listLiveEndpoints(f.root))[0].durableSession, null);
});
