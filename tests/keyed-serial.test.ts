// The per-topic serial queue behind a topic's exit / re-adoption steps (tg-cli#498).
import { expect, test } from 'bun:test';
import { createKeyedSerialQueue } from '../features/tg-ctl/keyed-serial';

// A step the test finishes by hand, standing in for a slow Bot API call.
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test('steps for one key run in order even when an earlier step is slower', async () => {
  const order: string[] = [];
  const slow = gate();
  const queue = createKeyedSerialQueue(() => {});
  queue.run(42, async () => {
    await slow.promise;
    order.push('close');
  });
  queue.run(42, async () => {
    order.push('reopen');
  });
  slow.open();
  await queue.idle(42);
  expect(order).toEqual(['close', 'reopen']);
});

test('different keys do not wait for each other', async () => {
  const order: string[] = [];
  const slow = gate();
  const queue = createKeyedSerialQueue(() => {});
  queue.run(1, async () => {
    await slow.promise;
    order.push('slow');
  });
  queue.run(2, async () => {
    order.push('fast');
  });
  await queue.idle(2);
  expect(order).toEqual(['fast']);
  slow.open();
  await queue.idle(1);
  expect(order).toEqual(['fast', 'slow']);
});

test('a failing step is reported and does not block the next one', async () => {
  const errors: unknown[] = [];
  const order: string[] = [];
  const queue = createKeyedSerialQueue((_key, err) => errors.push(err));
  queue.run(7, async () => {
    throw new Error('boom');
  });
  queue.run(7, async () => {
    order.push('next');
  });
  await queue.idle(7);
  expect(order).toEqual(['next']);
  expect(errors).toHaveLength(1);
});

test('a drained key holds no state', async () => {
  const queue = createKeyedSerialQueue(() => {});
  queue.run(9, async () => {});
  await queue.idle(9);
  expect(queue.size()).toBe(0);
});
