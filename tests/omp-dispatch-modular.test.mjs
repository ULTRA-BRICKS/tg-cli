// Admission-order contract of the omp-live endpoint dispatcher (tg-cli#817). The checks
// were split into helpers; this pins the precedence a client can observe through the real
// Unix socket: protocol → credential → process generation → operation → session →
// request id → body, and that nothing reaches the host before all of them pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { tempDir } from './helpers/test-temp.ts';

async function fixture(t, send) {
  const root = tempDir('omp-dispatch-modular-');
  const received = [];
  const endpoint = await startLiveEndpoint({
    root,
    snapshot: () => ({ sessionId: 's-live', sessionFile: null, cwd: '/same/cwd', busy: false, title: 'Live' }),
    send: send ?? (text => { received.push(text); }),
  });
  t.after(async () => { await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  const meta = JSON.parse(await readFile(endpoint.metadataPath, 'utf8'));
  return { meta, received };
}

function exchange(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = '';
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(JSON.parse(data)));
    socket.on('connect', () => socket.write(`${JSON.stringify(frame)}\n`));
  });
}

const valid = meta => ({ v: 1, op: 'send', pid: meta.pid, instanceId: meta.instanceId, token: meta.token, sessionId: 's-live', requestId: 'r1', text: 'hello' });
const errorOf = async (meta, override) => (await exchange(meta.socket, { ...valid(meta), ...override })).error;

test('protocol, credential and process generation are checked in that order, before any operation', async t => {
  const { meta, received } = await fixture(t);
  assert.equal(await errorOf(meta, { v: 2, token: 'wrong', pid: 1, op: 'bogus' }), 'unsupported_protocol');
  assert.equal(await errorOf(meta, { token: 'wrong', pid: 1, op: 'bogus' }), 'authentication_failed');
  assert.equal(await errorOf(meta, { token: undefined }), 'authentication_failed');
  assert.equal(await errorOf(meta, { pid: meta.pid + 1, op: 'bogus' }), 'stale_identity');
  assert.equal(await errorOf(meta, { instanceId: 'b'.repeat(32), op: 'bogus' }), 'stale_identity');
  assert.deepEqual(received, []);
});

test('an unknown operation is refused before the send fields are read; status needs no send fields', async t => {
  const { meta } = await fixture(t);
  assert.equal(await errorOf(meta, { op: 'bogus', sessionId: 'other', requestId: '', text: '' }), 'invalid_operation');
  const status = await exchange(meta.socket, { ...valid(meta), op: 'status', sessionId: 'other', requestId: undefined, text: undefined });
  assert.equal(status.ok, true);
  assert.equal(status.sessionId, 's-live');
  assert.equal(status.token, undefined);
});

test('send fields are validated session → request id → body type → body size, never reaching the host', async t => {
  const { meta, received } = await fixture(t);
  assert.equal(await errorOf(meta, { sessionId: 'other', requestId: '', text: '' }), 'stale_session');
  assert.equal(await errorOf(meta, { requestId: '', text: '' }), 'invalid_request_id');
  assert.equal(await errorOf(meta, { requestId: 'x'.repeat(257), text: '' }), 'invalid_request_id');
  assert.equal(await errorOf(meta, { text: '   ' }), 'invalid_message');
  assert.equal(await errorOf(meta, { text: 5 }), 'invalid_message');
  assert.equal(await errorOf(meta, { text: 'я'.repeat(32_001) }), 'message_too_large');
  assert.deepEqual(received, []);
});

test('an accepted send is receipted once; a failed host delivery is retained, never retried', async t => {
  let calls = 0;
  const { meta } = await fixture(t, () => { calls++; throw new Error('host exploded'); });
  const first = await exchange(meta.socket, valid(meta));
  assert.deepEqual(first, { ok: false, v: 1, error: 'delivery_failed' });
  const again = await exchange(meta.socket, valid(meta));
  assert.deepEqual(again, first);
  assert.equal(await errorOf(meta, { text: 'different text' }), 'request_id_conflict');
  assert.equal(calls, 1);
});
