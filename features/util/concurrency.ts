// Bounded fan-out helpers shared by the Forgejo readers (autolink-prs lookups, /tasks
// status/review lookups), so a burst of refs never fans out unboundedly against the forge and
// a stalling forge holds a send or a board render for a bounded time only.

/**
 * Map `items` through `fn`, at most `limit` calls in flight, results in input order. Once
 * `signal` aborts, no further item is started (an entry for an item never started stays
 * undefined); calls already running get the same signal to abort their own I/O.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, signal: AbortSignal | undefined) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      results[i] = await fn(items[i], signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const OVER_BUDGET = Symbol('over-budget');

/**
 * Run `work` with a signal that aborts after `ms`: its value, or OVER_BUDGET when the budget
 * ran out first. The abort reaches `work`'s own I/O, so nothing keeps running (or keeps a CLI
 * process alive) past the budget.
 */
export async function withinBudget<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | typeof OVER_BUDGET> {
  const controller = new AbortController();
  const { promise: over, resolve } = Promise.withResolvers<typeof OVER_BUDGET>();
  const timer = setTimeout(() => {
    controller.abort();
    resolve(OVER_BUDGET);
  }, ms);
  try {
    const pending = work(controller.signal);
    // The race loser keeps running after the budget; a late rejection must not go unhandled.
    pending.catch(() => {});
    return await Promise.race([pending, over]);
  } finally {
    clearTimeout(timer);
  }
}
