// Make every signal-0 liveness probe (`process.kill(pid, 0)`) throw `error` instead of asking the
// kernel; real signals pass through. Models a caller that cannot signal live pids (EPERM: another
// uid, a Landlock signal domain — tg-cli#748) or a pid the kernel no longer knows (ESRCH).
// Returns the restore function.
export function stubKill0(error: { code: string; syscall?: string }): () => void {
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: string | number): true => {
    if (signal === 0) throw Object.assign(new Error(`kill(${pid}, 0): ${error.code}`), error);
    return realKill.call(process, pid, signal);
  }) as typeof process.kill;
  return () => {
    process.kill = realKill;
  };
}
