// features/tg-ctl/concurrent-dispatch.ts — per-target concurrent action dispatch (tg-ctl#357).
//
// tg-ctl runs as ONE daemon process shared by the whole agent fleet. Before this module, the
// poll loop ran every batch's actions through a single strict `for (const action of
// step.actions) { await executeAction(action) }` loop — one action fully finished (including
// any network/IPC call inside it) before the next one even started. `executeAction` then reached
// omp agents over ACP (`promptOmpAcp` -> `acpCall(..., "session/prompt", timeoutMs)`, since
// removed — tg-cli#450/#469); a wedged omp process (stdin/stdout backed up, deadlocked, etc.)
// held that await for up to the call's full timeout. Because the daemon is single-threaded and
// shared, that one hung delivery froze delivery to EVERY other agent in the same batch --
// including perfectly healthy ones (e.g. a Claude Code session receiving messages fine) -- for
// as long as the stuck target took to time out. This is classic head-of-line blocking: one
// shared serial queue, no per-target isolation.
//
// The fix is a "serialization key" per unit of work. Work sharing a key (the same topic
// thread, the same pending-selection token, the same question requestId -- i.e. anything that
// reads-then-writes a shared Map keyed by that identifier) still runs strictly in enqueue
// order, exactly like the old fully-serial loop, so no new state race is introduced. Work with
// different keys (the common case: different messages routed to different agents) runs fully
// concurrently -- Promise.allSettled means one item timing out or rejecting can never delay or
// fail any other. `null` means "no shared state" and always runs immediately.

export type DispatchKey = string | null;

/** Per-key async queue: `run(key, fn)` chains onto whatever is already queued for that key (so
 *  same-key work stays strictly ordered) while different keys never block each other. */
export class TargetDispatchQueues {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: DispatchKey, fn: () => Promise<T>): Promise<T> {
    if (key === null) return fn();
    const prior = this.tails.get(key) ?? Promise.resolve();
    const started = prior.then(fn, fn);
    // Swallow so a rejection never poisons the chain for the NEXT item queued on this key --
    // the real result/rejection still reaches the caller through `started`.
    this.tails.set(key, started.catch(() => undefined));
    return started;
  }

  /** Number of keys with in-flight or queued work -- for tests/diagnostics only. */
  get size(): number {
    return this.tails.size;
  }
}

export class TargetTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TargetTimeoutError";
  }
}

/** Race `fn()` against `timeoutMs`; rejects with TargetTimeoutError instead of hanging forever,
 *  so a single stuck delivery can never wedge its caller past this bound. */
export async function withTargetTimeout<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TargetTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DispatchTask<T> {
  label: string;
  timeoutMs: number;
  run: () => Promise<T>;
}

export type DispatchOutcome<T> = { label: string; ok: true; value: T } | { label: string; ok: false; error: Error };

/** Run every task concurrently, each isolated by its own bounded timeout. Promise.allSettled
 *  means a rejecting/timing-out task never delays or fails any other task's outcome. */
export async function dispatchConcurrently<T>(tasks: Array<DispatchTask<T>>): Promise<DispatchOutcome<T>[]> {
  const settled = await Promise.allSettled(tasks.map((t) => withTargetTimeout(t.label, t.timeoutMs, t.run)));
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? { label: tasks[i].label, ok: true, value: s.value }
      : { label: tasks[i].label, ok: false, error: s.reason instanceof Error ? s.reason : new Error(String(s.reason)) },
  );
}

/** Actions for one inbound Telegram message are contiguous in a batch and end with that
 *  message's own `{kind:"ack"}` action (tg-ctl's executeAction reads the immediately preceding
 *  action's result to decide the message's reaction). Split a flat action array on that
 *  boundary so callers can dispatch each message's own action run as one atomic, internally
 *  ordered unit, while different runs are free to execute concurrently. A trailing run with no
 *  terminating ack (e.g. the batch ends mid-run) is still returned as its own final group. */
export function groupActionsByAckBoundary<A extends { kind: string }>(actions: readonly A[]): A[][] {
  const groups: A[][] = [];
  let current: A[] = [];
  for (const action of actions) {
    current.push(action);
    if (action.kind === "ack") {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
