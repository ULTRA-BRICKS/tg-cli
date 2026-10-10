import { expect, test } from 'bun:test';
import { LOOKUP_CONCURRENCY, probeRefsInRepo } from '../features/autolink-prs/resolve';
import type { ForgejoRepo } from '../features/forgejo/client';

const FORGE: ForgejoRepo = { origin: 'https://git.hyperide.ai', hostKey: 'git.hyperide.ai', owner: 'ultrabricks', name: 'tg-cli' };
const issue1 = JSON.stringify({ number: 1, title: 'Example', state: 'open', html_url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/1', pull_request: null });

test('partial network failure is not returned as complete verified absence', async () => {
  let count = 0;
  const result = await probeRefsInRepo(FORGE, [1, 2], async () => (++count === 1 ? { status: 200, body: issue1 } : null));
  expect(result.status).toBe('error');
});

test('an unrelated 404 number in an error body does not mean issue not found', async () => {
  const result = await probeRefsInRepo(FORGE, [1], async () => ({ status: 429, body: 'rate limited, retry in 404 seconds' }));
  expect(result.status).toBe('error');
});

test('lookups past the budget fail the batch, abort what is in flight and start nothing more', async () => {
  // The budget IS a wall-clock ceiling, so this exercises a real (short) timer.
  const started: number[] = [];
  const aborted: number[] = [];
  const t0 = Date.now();
  const result = await probeRefsInRepo(
    FORGE,
    Array.from({ length: 20 }, (_, i) => i + 1),
    (path, signal) => {
      const n = Number(path.split('/').at(-1));
      started.push(n);
      const { promise, resolve } = Promise.withResolvers<null>();
      signal?.addEventListener('abort', () => {
        aborted.push(n);
        resolve(null);
      });
      return promise;
    },
    50,
  );
  expect(result).toEqual({ status: 'error', message: 'Forgejo lookups exceeded 50ms' });
  expect(Date.now() - t0).toBeLessThan(1_000);
  await Promise.resolve();
  expect(started).toEqual([1, 2, 3, 4, 5, 6]);
  expect(aborted.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
});

test('the first failure stops the batch: nothing further is looked up', async () => {
  const started: number[] = [];
  const result = await probeRefsInRepo(FORGE, Array.from({ length: 20 }, (_, i) => i + 1), async (path) => {
    const n = Number(path.split('/').at(-1));
    started.push(n);
    return { status: 500, body: 'boom' };
  });
  expect(result).toEqual({ status: 'error', message: 'Forgejo answered HTTP 500 for #1' });
  expect(started.length).toBeLessThanOrEqual(LOOKUP_CONCURRENCY);
});

test('a 401 reports no-auth (the actionable failure)', async () => {
  expect(await probeRefsInRepo(FORGE, [1, 2], async () => ({ status: 401, body: '' }))).toEqual({ status: 'no-auth' });
});

test('a long range is looked up concurrently, bounded, in input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  const result = await probeRefsInRepo(FORGE, numbers, async (path) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve(); // yield, so every worker is in flight before any finishes
    inFlight--;
    const n = Number(path.split('/').at(-1));
    return { status: 200, body: JSON.stringify({ number: n, title: `T${n}`, state: 'open', html_url: `https://git.hyperide.ai/o/r/issues/${n}`, pull_request: null }) };
  });
  expect(result.status).toBe('ok');
  if (result.status === 'ok') expect([...result.refs.keys()]).toEqual(numbers);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(LOOKUP_CONCURRENCY);
});
