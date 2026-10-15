import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat, symlink, chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { startLiveEndpoint, listLiveEndpoints, sendLiveMessage, requestEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { tempDir } from './helpers/test-temp.ts';
import { stubKill0 } from './helpers/kill0-stub.ts';

async function fixture(t, send) {
  const root = tempDir('omp-live-test-');
  let state = { sessionId: 's-original', sessionFile: '/not/opened/session.jsonl', cwd: '/same/cwd', busy: false, title: 'Original' };
  const received = [];
  const endpoint = await startLiveEndpoint({ root, snapshot: () => state, send: send ?? (text => { received.push(text); }) });
  t.after(async () => { await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  return { root, endpoint, received, setState: s => { state = { ...state, ...s }; } };
}

test('a real Unix socket sends to the existing host and returns an acceptance receipt', async t => {
  const f = await fixture(t);
  const rows = await listLiveEndpoints(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, process.pid);
  assert.equal(rows[0].sessionId, 's-original');
  assert.equal(rows[0].token, undefined);
  const receipt = await sendLiveMessage({ root: f.root, pid: process.pid, sessionId: 's-original', requestId: 'tg:123', text: 'hello' });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.pid, process.pid);
  assert.equal(receipt.status, 'accepted');
  assert.deepEqual(f.received, ['hello']);
});

test('concurrent retries are idempotent, conflicting reuse is rejected', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; await new Promise(r => setTimeout(r, 25)); });
  const req = { root: f.root, pid: process.pid, requestId: 'tg:repeat', text: 'once' };
  const responses = await Promise.all(Array.from({ length: 8 }, () => sendLiveMessage(req)));
  assert.equal(calls, 1);
  assert(responses.every(r => r.accepted));
  await assert.rejects(sendLiveMessage({ ...req, text: 'different' }), /request_id_conflict/);
  assert.equal(calls, 1);
});

test('missing endpoint fails rather than creating or resuming an agent', async t => {
  const root = tempDir('omp-live-none-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(sendLiveMessage({ root, pid: process.pid, requestId: 'missing', text: 'hello' }), /endpoint_unavailable/);
  assert.deepEqual(await readdir(root), []);
});

test('invalid token and stale process instance are rejected before callback', async t => {
  const f = await fixture(t);
  const meta = JSON.parse(await readFile(f.endpoint.metadataPath, 'utf8'));
  await assert.rejects(requestEndpoint({ ...meta, token: 'wrong' }, { op: 'send', sessionId: 's-original', requestId: 'bad', text: 'bad' }), /authentication_failed/);
  await assert.rejects(requestEndpoint({ ...meta, instanceId: 'a'.repeat(32) }, { op: 'send', sessionId: 's-original', requestId: 'old', text: 'old' }), /stale_identity/);
  assert.deepEqual(f.received, []);
});

test('session switches invalidate old destination even before metadata refresh', async t => {
  const f = await fixture(t);
  const old = JSON.parse(await readFile(f.endpoint.metadataPath, 'utf8'));
  f.setState({ sessionId: 's-new' });
  await assert.rejects(requestEndpoint(old, { op: 'send', sessionId: 's-original', requestId: 'stale', text: 'not here' }), /stale_session/);
  await f.endpoint.refresh();
  const rows = await listLiveEndpoints(f.root);
  assert.equal(rows[0].sessionId, 's-new');
  await sendLiveMessage({ root: f.root, pid: process.pid, sessionId: 's-new', requestId: 'new', text: 'new session' });
  assert.deepEqual(f.received, ['new session']);
});

test('metadata and socket are private; public list cannot leak tokens', async t => {
  const f = await fixture(t);
  const meta = JSON.parse(await readFile(f.endpoint.metadataPath, 'utf8'));
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(f.endpoint.metadataPath)).mode & 0o777, 0o600);
  assert.equal((await stat(meta.socket)).mode & 0o777, 0o600);
  assert(!JSON.stringify(await listLiveEndpoints(f.root)).includes(meta.token));
  await chmod(f.endpoint.metadataPath, 0o644);
  assert.deepEqual(await listLiveEndpoints(f.root), []);
});

test('symlinked registry and metadata are refused', async t => {
  const f = await fixture(t);
  const parent = tempDir('omp-live-links-');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await symlink(f.root, join(parent, 'registry'));
  await assert.rejects(listLiveEndpoints(join(parent, 'registry')), /unsafe_registry/);
  await symlink(f.endpoint.metadataPath, join(f.root, 'planted.json'));
  assert.equal((await listLiveEndpoints(f.root)).length, 1);
});

test('ambiguous process identity cannot choose an arbitrary same-cwd endpoint', async t => {
  const f = await fixture(t);
  const second = await startLiveEndpoint({ root: f.root, snapshot: () => ({ sessionId: 'other', sessionFile: null, cwd: '/same/cwd', busy: false }), send: () => { throw new Error('must not deliver'); } });
  t.after(() => second.close());
  await assert.rejects(sendLiveMessage({ root: f.root, pid: process.pid, requestId: 'ambiguous', text: 'x' }), /ambiguous_endpoint/);
  assert.deepEqual(f.received, []);
});

test('oversized input is rejected and a callback failure is never claimed accepted', async t => {
  const f = await fixture(t, () => { throw new Error('private internal detail'); });
  await assert.rejects(sendLiveMessage({ root: f.root, pid: process.pid, requestId: 'large', text: 'x'.repeat(70_000) }), /message_too_large/);
  await assert.rejects(sendLiveMessage({ root: f.root, pid: process.pid, requestId: 'throw', text: 'normal' }), /delivery_failed/);
});

test('closing an endpoint removes only its own registration', async t => {
  const f = await fixture(t);
  await f.endpoint.close();
  await f.endpoint.close();
  assert.deepEqual(await listLiveEndpoints(f.root), []);
  assert.deepEqual(await readdir(f.root), []);
});

test('long metadata root uses a private short socket, not an invalid macOS-length path', async t => {
  const parent = tempDir('omp-live-long-');
  const root = join(parent, 'x'.repeat(95), 'registry');
  const ep = await startLiveEndpoint({ root, snapshot: () => ({ sessionId: 'long', sessionFile: null, cwd: parent, busy: true }), send: () => {} });
  t.after(async () => { await ep.close(); await rm(parent, { recursive: true, force: true }); });
  const meta = JSON.parse(await readFile(ep.metadataPath, 'utf8'));
  assert(Buffer.byteLength(meta.socket) <= 100);
  assert.equal((await listLiveEndpoints(root))[0].busy, true);
});

test('cross-process delivery preserves the original receiver PID and does not start another receiver', async t => {
  const root = tempDir('omp-live-child-');
  const child = fork(new URL('./omp-live-fixture.mjs', import.meta.url), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(root, { recursive: true, force: true }); });
  const [ready] = await once(child, 'message');
  assert.equal(ready.pid, child.pid);
  const responseEvent = once(child, 'message');
  const receipt = await sendLiveMessage({ root, pid: child.pid, sessionId: 'child-original', requestId: 'cross-process', text: 'handoff' });
  const [observed] = await responseEvent;
  assert.equal(receipt.pid, child.pid);
  assert.deepEqual(observed, { pid: child.pid, text: 'handoff' });
});

test('#458: a host too busy to answer the status probe is listed alive-busy; a send times out, never "unavailable"', { timeout: 20_000 }, async t => {
  const root = tempDir('omp-live-slow-');
  const child = fork(new URL('./omp-live-fixture.mjs', import.meta.url), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let socketDir = null;
  t.after(async () => {
    // The blocked host cannot run its SIGTERM cleanup; kill it and remove its private socket dir.
    if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    if (socketDir?.startsWith('/tmp/ol-')) await rm(socketDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await once(child, 'message');
  const [name] = (await readdir(root)).filter(n => n.endsWith('.json'));
  socketDir = dirname(JSON.parse(await readFile(join(root, name), 'utf8')).socket);
  const blocking = once(child, 'message');
  child.send({ blockMs: 60_000 });
  await blocking;
  const started = Date.now();
  const rows = await listLiveEndpoints(root);
  assert(Date.now() - started < 2_000, 'status probe stays bounded');
  assert.deepEqual(rows.map(r => [r.pid, r.sessionId, r.busy]), [[child.pid, 'child-original', true]]);
  // The endpoint exists: a caller must never read this as "no endpoint" and type into the TUI too.
  await assert.rejects(sendLiveMessage({ root, pid: child.pid, requestId: 'while-blocked', text: 'queued' }), /endpoint_timeout/);
});


test('oversized metadata is rejected through real discovery without hiding other hosts', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'oversized.json'), 'x'.repeat(32001), { mode: 0o600 });
  assert.equal((await listLiveEndpoints(f.root)).length, 1);
  await writeFile(f.endpoint.metadataPath, 'x'.repeat(32001));
  assert.deepEqual(await listLiveEndpoints(f.root), []);
});

// tg-cli#748: signal 0 answers EPERM for a live process the caller may not signal (another uid,
// a Landlock signal domain — rig-cli#704). Discovery must not read that as death and prune the
// session's bridge; only ESRCH (or a pid kill(2) cannot take) proves the pid is gone.
async function registrationPaths(f) {
  const metadata = f.endpoint.metadataPath;
  return { metadata, socket: JSON.parse(await readFile(metadata, 'utf8')).socket };
}

// EINVAL cannot come back for signal 0; it stands for any other kill(2) errno, which must not
// read as death either.
for (const code of ['EPERM', 'EINVAL']) {
  test(`#748: kill(pid, 0) failing with ${code} keeps the record and socket — the session stays listed and steerable`, async t => {
    const f = await fixture(t);
    const reg = await registrationPaths(f);
    t.after(stubKill0({ code, syscall: 'kill' }));
    assert.deepEqual((await listLiveEndpoints(f.root)).map(r => [r.pid, r.sessionId]), [[process.pid, 's-original']]);
    assert((await stat(reg.metadata)).isFile(), 'record not pruned');
    assert((await stat(reg.socket)).isSocket(), 'socket not pruned');
    const receipt = await sendLiveMessage({ root: f.root, pid: process.pid, sessionId: 's-original', requestId: `eperm-${code}`, text: 'still here' });
    assert.equal(receipt.accepted, true);
  });
}

const gone = [
  ['ESRCH from kill(2)', { code: 'ESRCH', syscall: 'kill' }],
  ['an argument error thrown before kill(2) ran', { code: 'ERR_INVALID_ARG_TYPE' }],
];
for (const [label, error] of gone) {
  test(`#748: ${label} still prunes the dead record and its socket`, async t => {
    const f = await fixture(t);
    const reg = await registrationPaths(f);
    t.after(stubKill0(error));
    assert.deepEqual(await listLiveEndpoints(f.root), []);
    await assert.rejects(stat(reg.metadata), { code: 'ENOENT' });
    await assert.rejects(stat(reg.socket), { code: 'ENOENT' });
  });
}

test('#748: the runtime tags real kill(2) errors with syscall "kill" — the stubs above use that shape', async () => {
  const child = spawn('true', { stdio: 'ignore' });
  await once(child, 'exit');
  assert.throws(() => process.kill(child.pid, 0), e => e.syscall === 'kill' && e.code === 'ESRCH');
  assert.throws(() => process.kill(2 ** 31, 0), e => e.syscall === undefined);
});
