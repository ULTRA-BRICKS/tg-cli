import { expect, test } from 'bun:test';
import {
  TargetDispatchQueues,
  TargetTimeoutError,
  withTargetTimeout,
  dispatchConcurrently,
  deliveryDispatchKey,
  groupActionsByAckBoundary,
  type DeliveryDestinations,
} from '../features/tg-ctl/concurrent-dispatch';
import type { Action } from '../features/tg-ctl/types';

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

// One message's actions run as one group, and a group can touch several keys at once — a button
// tap's `req:` guard ahead of a delivery's `dest:` pane (tg-cli#280). It is ordered on every one.
test('TargetDispatchQueues: work under several keys waits for, and holds back, each of them', async () => {
  const queues = new TargetDispatchQueues();
  const seen: string[] = [];
  let releaseSlow: () => void = () => {};
  const slow = queues.run('dest:%1', () => new Promise<void>((r) => (releaseSlow = r)).then(() => void seen.push('album')));
  const both = queues.run(['req:x', 'dest:%1'], async () => void seen.push('tap+text'));
  const req = queues.run('req:x', async () => void seen.push('next tap'));
  const other = queues.run('dest:%2', async () => void seen.push('other pane'));
  await other;
  expect(seen).toEqual(['other pane']);
  releaseSlow();
  await Promise.all([slow, both, req]);
  expect(seen).toEqual(['other pane', 'album', 'tap+text', 'next tap']);
  expect(await queues.run([], async () => 7)).toBe(7);
});

// Keys name one-off request ids and tokens, so a long-lived daemon must not keep one per key forever.
test('TargetDispatchQueues: a key whose work all finished is forgotten; one still queued is kept', async () => {
  const queues = new TargetDispatchQueues();
  let release: () => void = () => {};
  const first = queues.run(['dest:reply:1', 'dest:%1'], () => new Promise<void>((r) => (release = r)));
  const second = queues.run('dest:%1', async () => {});
  await queues.run('dest:agent:typo', async () => {});
  expect(queues.size).toBe(2);
  release();
  await Promise.all([first, second]);
  expect(queues.size).toBe(0);
});

// A batch's groups start in the order they are enqueued: a keyed group whose keys are free must
// not lose its turn to a keyless one queued after it (the no-agent guard reply of a message, then
// the /status reply, tg-cli#280).
test('TargetDispatchQueues: work none of whose keys is busy starts in the caller turn, like keyless work', async () => {
  const queues = new TargetDispatchQueues();
  const started: string[] = [];
  const keyed = queues.run('dest:%1', async () => void started.push('message'));
  const keyless = queues.run(null, async () => void started.push('/status'));
  expect(started).toEqual(['message', '/status']);
  await Promise.all([keyed, keyless]);
  // An fn that throws before its first await rejects with its own error and holds no key back.
  const thrown = queues.run('dest:%1', () => {
    throw new Error('boom');
  });
  await expect(thrown).rejects.toThrow('boom');
  expect(queues.size).toBe(0);
  expect(await queues.run('dest:%1', async () => 7)).toBe(7);
});

// Starting at once must not open a gap: work that queues more work on its own key while it runs
// still finishes first.
test('TargetDispatchQueues: work queued on a key by the work holding it waits for it', async () => {
  const queues = new TargetDispatchQueues();
  const order: string[] = [];
  let inner: Promise<void> = Promise.resolve();
  await queues.run('pane:x', async () => {
    order.push('outer start');
    inner = queues.run('pane:x', async () => void order.push('inner'));
    await Promise.resolve();
    order.push('outer end');
  });
  await inner;
  expect(order).toEqual(['outer start', 'outer end', 'inner']);
});

// --- deliveryDispatchKey: deliveries to one destination share a key (tg-cli#280) ---

// Pane %1 is the default, the origin of replied-to messages 100 and 101, and agent `alpha`;
// pane %2 is the origin of 200 and agent `beta`. Message 300 and agent `gamma` resolve to none.
const DESTS: DeliveryDestinations = {
  replyPane: (id) => (id === 100 || id === 101 ? '%1' : id === 200 ? '%2' : null),
  agentPane: (selector) => (selector === 'alpha' ? '%1' : selector === 'beta' ? '%2' : null),
  defaultPane: () => '%1',
};
const media = (extra: Partial<Extract<Action, { kind: 'download-media' }>> = {}): Action => ({
  kind: 'download-media',
  files: [{ fileId: 'f', suggestedName: '1.jpg', mediaKind: 'photo' }],
  from: 'Alex',
  messageId: 1,
  ...extra,
});

test('deliveryDispatchKey: every way of reaching one pane — default, reply, /agent, media, voice — shares its key', () => {
  const keys = [
    deliveryDispatchKey({ kind: 'inject-text', text: 'x', messageId: 2 }, DESTS),
    deliveryDispatchKey({ kind: 'reply-route', replyToMessageId: 100, injectText: 'x', from: 'Alex', messageId: 3 }, DESTS),
    deliveryDispatchKey({ kind: 'reply-route', replyToMessageId: 101, injectText: 'x', from: 'Alex', messageId: 4 }, DESTS),
    deliveryDispatchKey({ kind: 'agent-route', selector: 'alpha', rest: 'x', all: 'alpha x', from: 'Alex', messageId: 5 }, DESTS),
    deliveryDispatchKey(media(), DESTS),
    deliveryDispatchKey(media({ replyToMessageId: 101 }), DESTS),
    deliveryDispatchKey(media({ agentRoute: { selector: 'alpha', rest: '', all: 'alpha' } }), DESTS),
    deliveryDispatchKey({ kind: 'transcribe-voice', fileId: 'v', suggestedName: '6.ogg', from: 'Alex', messageId: 6 }, DESTS),
    deliveryDispatchKey({ kind: 'transcribe-voice', fileId: 'v', suggestedName: '7.ogg', from: 'Alex', messageId: 7, replyToMessageId: 100 }, DESTS),
  ];
  expect(new Set(keys)).toEqual(new Set(['dest:%1']));
});

test('deliveryDispatchKey: another pane gets another key; a reply or /agent whose pane is unknown takes the default pane, where the delivery paths fall back', () => {
  expect(deliveryDispatchKey({ kind: 'reply-route', replyToMessageId: 200, injectText: 'x', from: 'Alex', messageId: 3 }, DESTS)).toBe('dest:%2');
  expect(deliveryDispatchKey(media({ agentRoute: { selector: 'beta', rest: '', all: 'beta' } }), DESTS)).toBe('dest:%2');
  // e.g. `/agent gone-worker` lands in the CTO's last target; an unknown reply with one agent, in it.
  expect(deliveryDispatchKey(media({ replyToMessageId: 300 }), DESTS)).toBe('dest:%1');
  expect(deliveryDispatchKey({ kind: 'agent-route', selector: 'gamma', rest: '', all: 'gamma', from: 'Alex', messageId: 5 }, DESTS)).toBe('dest:%1');
  const noDefault: DeliveryDestinations = { ...DESTS, defaultPane: () => null };
  expect(deliveryDispatchKey({ kind: 'inject-text', text: 'x', messageId: 2 }, noDefault)).toBe('dest:default');
  expect(deliveryDispatchKey(media({ replyToMessageId: 300 }), noDefault)).toBe('dest:default');
});

test('deliveryDispatchKey: a bare /agent goes by the sole agent it reaches, else (the picker) carries no key; a non-delivery action carries none', () => {
  const sole: DeliveryDestinations = { ...DESTS, agentPane: (selector) => (selector === null ? '%1' : null) };
  expect(deliveryDispatchKey(media({ agentRoute: { selector: null, rest: '', all: '' } }), sole)).toBe('dest:%1');
  expect(deliveryDispatchKey({ kind: 'agent-route', selector: null, rest: '', all: '', from: 'Alex', messageId: 5 }, DESTS)).toBeNull();
  expect(deliveryDispatchKey(media({ agentRoute: { selector: null, rest: '', all: '' } }), DESTS)).toBeNull();
  expect(deliveryDispatchKey({ kind: 'reply', text: 'x' }, DESTS)).toBeNull();
  expect(deliveryDispatchKey({ kind: 'ack', messageId: 1 }, DESTS)).toBeNull();
});

test('deliveryDispatchKey: destinations are resolved only for the actions that need them', () => {
  const calls: string[] = [];
  const spy: DeliveryDestinations = {
    replyPane: (id) => (calls.push(`reply:${id}`), null),
    agentPane: (s) => (calls.push(`agent:${s}`), null),
    defaultPane: () => (calls.push('default'), null),
  };
  deliveryDispatchKey({ kind: 'ack', messageId: 1 }, spy);
  deliveryDispatchKey(media({ replyToMessageId: 300 }), spy);
  expect(calls).toEqual(['reply:300', 'default']);
});
