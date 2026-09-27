// #450 replaces removed ACP client implementation, preserving the underlying failure scenario.
import { expect, test } from 'bun:test';
import { originalFixture } from './helpers/original-omp';
test('an unavailable endpoint fails closed, never starts a replacement agent', async () => {
  const f = await originalFixture(); await f.endpoint.close();
  try { await expect(f.send('tg:1', 'must not replay')).rejects.toThrow();
    expect(await f.status()).toEqual([]); expect(f.inputs).toEqual([]);
  } finally { await f.close(); }
});
test('a session switch in the original rejects delivery addressed to the old history', async () => {
  const f = await originalFixture(); try { f.state.sessionId = 'new-history';
    await expect(f.send('tg:1', 'old input', { sessionId: 'original' })).rejects.toThrow();
    expect(f.inputs).toEqual([]); expect((await f.send('tg:2', 'new input')).pid).toBe(process.pid);
  } finally { await f.close(); }
});
