// #450 replaces removed ACP client implementation, preserving the underlying failure scenario.
import { expect, test } from 'bun:test';
import { originalFixture } from './helpers/original-omp';
test('callback failure is rejected, retained and never re-executed by retry', async () => {
  let attempts = 0; const f = await originalFixture(() => { attempts++; throw new Error('failed callback'); });
  try { await expect(f.send('tg:1', 'bad')).rejects.toThrow();
    await expect(f.send('tg:1', 'bad')).rejects.toThrow(); expect(attempts).toBe(1);
  } finally { await f.close(); }
});
test('failed input does not block a later DIFFERENT input in the same original', async () => {
  const f = await originalFixture(text => { if (text === 'bad') throw new Error('bad'); });
  try { await expect(f.send('tg:1', 'bad')).rejects.toThrow();
    expect((await f.send('tg:2', 'good')).pid).toBe(process.pid);
  } finally { await f.close(); }
});
