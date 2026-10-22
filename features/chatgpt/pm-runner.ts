// The ONE impure module of features/chatgpt: really spawns `pm`. Used by `tg` and by the tg-ctl
// daemon (async, so the poll loop is never blocked).
//
// The child runs detached (its own session and process group), so a timeout or an oversize
// stdout kills the WHOLE group — the child and anything it spawned — and no descendant is left
// behind. The group is also swept after a normal exit. stdout is capped at `maxBytes`; stderr is
// kept only as a small diagnostic tail.

import { spawn } from 'node:child_process';
import type { PmRunner, RunnerResult } from './pm-client';

const STDERR_KEEP_BYTES = 8 * 1024;

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

export const spawnPmRunner: PmRunner = (argv, opts) =>
  new Promise<RunnerResult>((resolve) => {
    let settled = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: RunnerResult, pid: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(pid);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: process.env });
    } catch {
      resolve({ kind: 'spawn-error' });
      return;
    }
    const pid = child.pid;
    child.on('error', () => finish({ kind: 'spawn-error' }, pid));
    timer = setTimeout(() => finish({ kind: 'timeout' }, pid), opts.timeoutMs);
    if (opts.stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.stdin);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxBytes) {
        finish({ kind: 'oversize' }, pid);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_KEEP_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });
    child.on('close', (code) => {
      finish({ kind: 'exit', code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8').slice(0, STDERR_KEEP_BYTES) }, pid);
    });
  });
