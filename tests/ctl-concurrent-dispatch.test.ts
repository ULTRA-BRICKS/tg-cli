import { expect, test } from 'bun:test';
import {
  TargetDispatchQueues,
  TargetTimeoutError,
  withTargetTimeout,
  dispatchConcurrently,
  groupActionsByAckBoundary,
} from '../features/tg-ctl/concurrent-dispatch';

function neverResolves<T>(): Promise<T> {
  return new Promise(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- TargetDispatchQueues: different keys never block each other ---

test('TargetDispatchQueues lets independent keys settle without waiting on a stuck one', async () => {
  const queues = new TargetDispatchQueues();
  const start = Date.now();

  const stuck = queues.run('stuck-target', () => neverResolves<string>());
  const fast = Promise.all([
    queues.run('a', async () => 'a-done'),
    queues.run('b', async () => 'b-done'),
    queues.run('c', async () => 'c-done'),
    queues.run(null, async () => 'null-done'),
  ]);

  const results = await fast;
  const elapsed = Date.now() - start;

  expect(results).toEqual(['a-done', 'b-done', 'c-done', 'null-done']);
  // The 4 independent tasks must not have waited on the never-resolving 5th one.
  expect(elapsed).toBeLessThan(500);

  // Keep the reference alive so it isn't flagged as unused; it deliberately never settles.
  expect(typeof stuck.then).toBe('function');
});

// --- TargetDispatchQueues: same key stays strictly ordered ---

test('TargetDispatchQueues runs same-key work in strict enqueue order', async () => {
  const queues = new TargetDispatchQueues();
  const order: number[] = [];

  const first = queues.run('thread:7', async () => {
    await delay(30);
    order.push(1);
  });
  const second = queues.run('thread:7', async () => {
    order.push(2);
  });
  const third = queues.run('thread:7', async () => {
    order.push(3);
  });

  await Promise.all([first, second, third]);
  expect(order).toEqual([1, 2, 3]);
});

test('TargetDispatchQueues keeps queuing on a key after a prior task on that key rejects', async () => {
  const queues = new TargetDispatchQueues();
  const order: string[] = [];

  const failing = queues.run('token:x', async () => {
    order.push('fail-start');
    throw new Error('boom');
  });
  const after = queues.run('token:x', async () => {
    order.push('after');
    return 'ok';
  });

  await expect(failing).rejects.toThrow('boom');
  await expect(after).resolves.toBe('ok');
  expect(order).toEqual(['fail-start', 'after']);
});

// --- withTargetTimeout ---

test('withTargetTimeout rejects with TargetTimeoutError once the bound elapses, without blocking a sibling', async () => {
  const start = Date.now();
  const siblingDone = (async () => {
    await delay(20);
    return 'sibling-ok';
  })();

  const stuck = withTargetTimeout('stuck-call', 60, () => neverResolves<string>());

  const sibling = await siblingDone;
  expect(sibling).toBe('sibling-ok');
  expect(Date.now() - start).toBeLessThan(200);

  await expect(stuck).rejects.toBeInstanceOf(TargetTimeoutError);
  await expect(stuck).rejects.toThrow('stuck-call timed out after 60ms');
});

// --- dispatchConcurrently ---

test('dispatchConcurrently reports fast successes quickly while a stuck task times out independently', async () => {
  const start = Date.now();
  const outcomes = await dispatchConcurrently([
    { label: 'fast-1', timeoutMs: 5000, run: async () => 'r1' },
    { label: 'fast-2', timeoutMs: 5000, run: async () => 'r2' },
    { label: 'stuck', timeoutMs: 80, run: () => neverResolves<string>() },
  ]);
  const elapsed = Date.now() - start;

  // Total time is bounded by the stuck task's OWN short timeout, not by summing every task.
  expect(elapsed).toBeLessThan(500);

  expect(outcomes[0]).toEqual({ label: 'fast-1', ok: true, value: 'r1' });
  expect(outcomes[1]).toEqual({ label: 'fast-2', ok: true, value: 'r2' });
  expect(outcomes[2].ok).toBe(false);
  if (!outcomes[2].ok) {
    expect(outcomes[2].error).toBeInstanceOf(TargetTimeoutError);
  }
});

// --- groupActionsByAckBoundary ---

type FakeAction = { kind: string; messageId?: number };

test('groupActionsByAckBoundary splits a flat batch into per-message groups on the trailing ack', () => {
  const actions: FakeAction[] = [
    { kind: 'reply-route', messageId: 1 },
    { kind: 'ack', messageId: 1 },
    { kind: 'topic-route', messageId: 2 },
    { kind: 'reply', messageId: 2 },
    { kind: 'ack', messageId: 2 },
  ];

  const groups = groupActionsByAckBoundary(actions);

  expect(groups.length).toBe(2);
  expect(groups[0]).toEqual([
    { kind: 'reply-route', messageId: 1 },
    { kind: 'ack', messageId: 1 },
  ]);
  expect(groups[1]).toEqual([
    { kind: 'topic-route', messageId: 2 },
    { kind: 'reply', messageId: 2 },
    { kind: 'ack', messageId: 2 },
  ]);
});

test('groupActionsByAckBoundary keeps a trailing run with no ack as its own final group', () => {
  const actions: FakeAction[] = [
    { kind: 'reply', messageId: 1 },
    { kind: 'ack', messageId: 1 },
    { kind: 'agent-callback', messageId: 2 },
  ];

  const groups = groupActionsByAckBoundary(actions);

  expect(groups.length).toBe(2);
  expect(groups[0]).toEqual([
    { kind: 'reply', messageId: 1 },
    { kind: 'ack', messageId: 1 },
  ]);
  expect(groups[1]).toEqual([{ kind: 'agent-callback', messageId: 2 }]);
});

test('groupActionsByAckBoundary returns an empty array for an empty batch', () => {
  expect(groupActionsByAckBoundary([])).toEqual([]);
});
