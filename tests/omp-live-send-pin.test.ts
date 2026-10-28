import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLiveEndpoint, sendLiveMessage, requestEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { tempDir } from './helpers/test-temp';

test('a failed durable send pin aborts before the host receives the message', async () => {
  const root = tempDir('omp-live-send-pin-');
  const received: string[] = [];
  const endpoint = await startLiveEndpoint({ root, snapshot: () => ({ sessionId: 'pinned', cwd: root }), send: (text: string) => { received.push(text); } });
  try {
    await expect(sendLiveMessage({ root, pid: endpoint.pid, instanceId: endpoint.instanceId, sessionId: 'pinned', requestId: 'pin-fails', text: 'incident',
      beforeSend: () => { throw new Error('receipt_store_unavailable'); } })).rejects.toThrow('receipt_store_unavailable');
    expect(received).toEqual([]);
  } finally { await endpoint.close(); }
});

test('a connection failure before writing does not pin a generation; a resumed endpoint remains eligible', async () => {
  const root = tempDir('omp-live-send-unavailable-');
  const received: string[] = [];
  const first = await startLiveEndpoint({ root, snapshot: () => ({ sessionId: 'resumed', cwd: root }), send: (text: string) => { received.push(text); } });
  const old = JSON.parse(readFileSync(first.metadataPath, 'utf8'));
  await first.close();
  const generations: string[] = [];
  await expect(requestEndpoint({ ...old, socket: join(root, 'missing.sock') },
    { op: 'send', sessionId: 'resumed', requestId: 'missing', text: 'incident' }, 2000,
    () => { generations.push(old.instanceId); })).rejects.toThrow('endpoint_unavailable');
  expect(generations).toEqual([]);
  const resumed = await startLiveEndpoint({ root, snapshot: () => ({ sessionId: 'resumed', cwd: root }), send: (text: string) => { received.push(text); } });
  try {
    await sendLiveMessage({ root, pid: resumed.pid, instanceId: resumed.instanceId, sessionId: 'resumed', requestId: 'new-instance', text: 'incident',
      beforeSend: (identity: { instanceId: string }) => { generations.push(identity.instanceId); } });
    expect(generations).toEqual([resumed.instanceId]);
    expect(received).toEqual(['incident']);
  } finally { await resumed.close(); }
});
