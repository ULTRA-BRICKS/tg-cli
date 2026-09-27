// #450 replaces removed ACP client implementation, preserving the underlying failure scenario.
import { expect, test } from 'bun:test';
import { originalFixture } from './helpers/original-omp';
test('queued acknowledgement is NOT completion; a busy original remains busy', async () => {
  const f = await originalFixture();
  try { const r = await f.send('tg:1', 'follow-up'); expect(r.accepted).toBe(true);
    expect((await f.status())[0].busy).toBe(true); expect(r.completed).toBeUndefined();
    await Bun.sleep(40); expect((await f.status())[0].pid).toBe(process.pid);
    expect((await f.status())[0].busy).toBe(true); expect(f.inputs).toEqual(['follow-up']);
  } finally { await f.close(); }
});
test('a later idle state is reported without replacing or restarting the original', async () => {
  const f = await originalFixture(); try {
    const before = (await f.status())[0]; f.state.busy = false; const after = (await f.status())[0];
    expect(after.instanceId).toBe(before.instanceId); expect(after.busy).toBe(false);
  } finally { await f.close(); }
});
