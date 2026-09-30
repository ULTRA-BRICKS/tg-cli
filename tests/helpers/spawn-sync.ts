// Bounded `Bun.spawnSync` for tests that shell out to a real child (git, bash scripts, tg-ctl).
//
// A synchronous spawn blocks bun's event loop, so bun's per-test timeout can never fire while it
// runs: a child that hangs (a git credential prompt, a held lock, a stuck daemon probe) stalls the
// WHOLE CI job until the job-level limit instead of failing one test. Every such spawn gets a hard
// deadline; on expiry the child is SIGKILLed and the test fails with the command that hung.
import type { SpawnOptions } from 'bun';

export const SPAWN_SYNC_TIMEOUT_MS = 30_000;

type BoundedOptions = Omit<SpawnOptions.SpawnSyncOptions<'ignore', 'pipe', 'pipe'>, 'timeout' | 'killSignal'>;

export function spawnSyncBounded(cmd: string[], opts: BoundedOptions = {}, timeoutMs = SPAWN_SYNC_TIMEOUT_MS) {
  const proc = Bun.spawnSync(cmd, { ...opts, timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (proc.exitedDueToTimeout) {
    throw new Error(`spawnSync timed out after ${timeoutMs}ms and was killed: ${cmd.join(' ')}`);
  }
  return proc;
}
