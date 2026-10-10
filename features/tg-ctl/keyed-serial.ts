// Runs async steps one at a time per key, in the order they were queued; different keys run
// independently. The daemon uses it per topic so a session's exit (post + close) and its
// re-adoption (reopen + post) reach Telegram in event order (tg-cli#498).

export interface KeyedSerialQueue<K> {
  run(key: K, step: () => Promise<void>): void;
  // Resolves once every step queued for `key` so far has settled.
  idle(key: K): Promise<void>;
  // Keys with steps still queued or running.
  size(): number;
}

export function createKeyedSerialQueue<K>(onError: (key: K, err: unknown) => void): KeyedSerialQueue<K> {
  const tails = new Map<K, Promise<void>>();
  return {
    run(key, step) {
      const next = (tails.get(key) ?? Promise.resolve()).then(step).catch((err: unknown) => onError(key, err));
      const tail = next.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
    },
    idle: (key) => tails.get(key) ?? Promise.resolve(),
    size: () => tails.size,
  };
}
