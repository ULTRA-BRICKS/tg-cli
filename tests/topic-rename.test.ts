import { expect, test } from 'bun:test';
import { createTopicRenamer, TOPIC_RENAME_MIN_INTERVAL_MS } from '../features/tg-ctl/topic-rename';

// Session rename → editForumTopic (docs/specs/session-registry-and-topics.md §4.7; tg-cli#466):
// at most one edit per topic per 60 s, trailing (the latest name wins), nothing sent for an
// unchanged title.

// A fake clock: `advance` fires due timers in order and awaits each edit they start.
function harness(opts: { editOk?: boolean } = {}) {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => Promise<void>; cancelled: boolean }> = [];
  const edits: Array<{ threadId: number; title: string; at: number }> = [];
  const renamer = createTopicRenamer({
    now: () => now,
    schedule: (fn, ms) => {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    edit: async (threadId, title) => {
      edits.push({ threadId, title, at: now });
      return opts.editOk ?? true;
    },
  });
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      now = due.at;
      await due.fn();
    }
    now = until;
  };
  return { renamer, edits, advance, pendingTimers: () => timers.filter((t) => !t.cancelled).length };
}

test('the first rename of a topic edits it at once', async () => {
  const h = harness();
  await h.renamer.rename(42, 'gc-sme · Recover commits', 'old · Recover commits');
  expect(h.edits).toEqual([{ threadId: 42, title: 'gc-sme · Recover commits', at: 1_000_000 }]);
});

test('renames inside the 60 s window collapse into one trailing edit with the latest title', async () => {
  const h = harness();
  await h.renamer.rename(42, 'b', 'a');
  await h.renamer.rename(42, 'c', 'b');
  await h.renamer.rename(42, 'd', 'c');
  await h.advance(TOPIC_RENAME_MIN_INTERVAL_MS - 1);
  expect(h.edits.map((e) => e.title)).toEqual(['b']);
  await h.advance(1);
  expect(h.edits.map((e) => e.title)).toEqual(['b', 'd']);
  expect(h.edits[1].at - h.edits[0].at).toBe(TOPIC_RENAME_MIN_INTERVAL_MS);
});

test('an unchanged title sends nothing', async () => {
  const h = harness();
  await h.renamer.rename(42, 'same', 'same');
  expect(h.edits).toEqual([]);
});

test('a rename that flips back to the title already sent is dropped at the trailing edge', async () => {
  const h = harness();
  await h.renamer.rename(42, 'b', 'a');
  await h.renamer.rename(42, 'c', 'b');
  await h.renamer.rename(42, 'b', 'c');
  await h.advance(TOPIC_RENAME_MIN_INTERVAL_MS);
  expect(h.edits.map((e) => e.title)).toEqual(['b']);
  expect(h.pendingTimers()).toBe(0);
});

test('topics are rate-limited independently', async () => {
  const h = harness();
  await Promise.all([h.renamer.rename(1, 'x', 'w'), h.renamer.rename(2, 'y', 'v')]);
  expect(h.edits.map((e) => [e.threadId, e.title])).toEqual([
    [1, 'x'],
    [2, 'y'],
  ]);
});

test('a failed edit is not remembered as the topic title: the next rename sends it again', async () => {
  const h = harness({ editOk: false });
  await h.renamer.rename(42, 'b', 'a');
  await h.advance(TOPIC_RENAME_MIN_INTERVAL_MS);
  await h.renamer.rename(42, 'b', 'a');
  expect(h.edits.map((e) => e.title)).toEqual(['b', 'b']);
});

test('forget cancels a trailing edit', async () => {
  const h = harness();
  await h.renamer.rename(42, 'b', 'a');
  await h.renamer.rename(42, 'c', 'b');
  h.renamer.forget(42);
  await h.advance(TOPIC_RENAME_MIN_INTERVAL_MS);
  expect(h.edits.map((e) => e.title)).toEqual(['b']);
});

test('a rename that lands while an edit is still in flight gets its own trailing edit', async () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => Promise<void> }> = [];
  const edits: string[] = [];
  let settle: (ok: boolean) => void = () => {};
  const renamer = createTopicRenamer({
    now: () => now,
    schedule: (fn, ms) => {
      timers.push({ at: now + ms, fn });
      return () => {};
    },
    edit: (_threadId, title) => {
      edits.push(title);
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    },
  });
  const first = renamer.rename(42, 'b', 'a');
  await renamer.rename(42, 'c', 'b'); // `b` is still being sent
  settle(true);
  await first;
  expect(edits).toEqual(['b']);
  expect(timers.map((t) => t.at)).toEqual([TOPIC_RENAME_MIN_INTERVAL_MS]);
  now = TOPIC_RENAME_MIN_INTERVAL_MS;
  const trailing = timers[0].fn();
  settle(true);
  await trailing;
  expect(edits).toEqual(['b', 'c']);
});
