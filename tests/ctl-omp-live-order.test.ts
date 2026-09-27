// #450 replaces removed ACP client implementation, preserving the underlying failure scenario.
import { expect, test } from 'bun:test';
import { originalFixture } from './helpers/original-omp';
test('concurrent prompts are accepted serially by the SAME original process', async () => {
  const entered: string[] = []; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = await originalFixture(async text => { entered.push(text); if (text === 'first') await gate; });
  try {
    const first = f.send('tg:1', 'first');
    while (!entered.length) await Bun.sleep(5);
    const second = f.send('tg:2', 'second');
    await Bun.sleep(30); expect(entered).toEqual(['first']);
    release(); const receipts = await Promise.all([first, second]);
    expect(entered).toEqual(['first', 'second']);
    expect(receipts.map(r => r.pid)).toEqual([process.pid, process.pid]);
  } finally { release(); await f.close(); }
});
test('two retries share the same acceptance without running the callback twice', async () => {
  const f = await originalFixture();
  try { const replies = await Promise.all([f.send('tg:1', 'one'), f.send('tg:1', 'one')]);
    expect(f.inputs).toEqual(['one']); expect(replies[0]).toEqual(replies[1]);
  } finally { await f.close(); }
});
