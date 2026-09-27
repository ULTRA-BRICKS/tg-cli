// #450 replaces removed ACP client implementation, preserving the underlying failure scenario.
import { expect, test } from 'bun:test';
import { originalFixture } from './helpers/original-omp';
test('same delivery ID with different text is rejected, not mistaken for a reply', async () => {
  const f = await originalFixture(); try { await f.send('tg:1', 'approved text');
    await expect(f.send('tg:1', 'different text')).rejects.toThrow();
    expect(f.inputs).toEqual(['approved text']);
  } finally { await f.close(); }
});
test('an instance identity cannot be reused to target a different process generation', async () => {
  const f = await originalFixture(); try {
    await expect(f.send('tg:1', 'stale', { instanceId: '0'.repeat(32) })).rejects.toThrow();
    expect(f.inputs).toEqual([]);
  } finally { await f.close(); }
});
