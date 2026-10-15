// The real effects behind `runUserAccount` (the one impure module here, like
// tg-ctl/host-registry-fs.ts): the hash-locked sidecar venv, the spawn, stdin, the console.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadEnv } from '../config/env';
import type { UserAccountDeps } from './cli';
import { BUILD_STEP_TIMEOUT_MS, buildBusyError, buildWaitMs, runtimeDir, runtimeSetupSteps, sidecarEnv } from './sidecar';

const MODULE = ['-m', 'telegram_client'];

type RuntimeCommand = { argv: string[] } | { error: string };

// The pid recorded in a build lock, or null when none was written yet.
function buildLockOwner(lockDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// A build lock is stale when its owner is gone. A live owner is never overridden, however
// slow its install; age only decides for a lock whose pid never got written (a crash
// between mkdir and the pid write).
function buildLockStale(lockDir: string, owner: number | null): boolean {
  if (owner === null) {
    try {
      return Date.now() - statSync(lockDir).mtimeMs > 60_000;
    } catch {
      return false; // lock just released
    }
  }
  try {
    process.kill(owner, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'; // EPERM: alive, another user
  }
}

function build(uv: string, venv: string, lockPath: string, ready: string, sha: string): { error: string } | null {
  console.error(`Setting up the Telegram user-account runtime (one time): ${venv}`);
  rmSync(venv, { recursive: true, force: true });
  for (const step of runtimeSetupSteps(uv, venv, lockPath)) {
    const result = Bun.spawnSync(step, { stdout: 'ignore', stderr: 'inherit', timeout: BUILD_STEP_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      return { error: `Error: building the runtime failed at \`uv ${step[1]}\` (exit ${result.exitCode}); see the output above.` };
    }
  }
  writeFileSync(ready, `${sha}\n`);
  return null;
}

export interface RuntimeBuildOptions {
  /** The `uv` executable; default: looked up on PATH, and only when a build is needed. */
  uv?: string;
  /** How long to wait for another live builder; default `buildWaitMs`. Tests shrink it. */
  waitMs?: number;
}

/**
 * `<venv>/bin/python -m telegram_client`, building the venv from requirements-call.txt on first use.
 * One builder at a time (an atomic `mkdir` lock beside the venv, like role_lock on the
 * Python side): two agents' first `tg call` must not delete each other's half-built venv.
 * The `.tg-ready` marker is written only after every install step succeeded, so a half
 * build is redone, never used. A waiter waits as long as a live build may take
 * (`buildWaitMs`).
 */
export async function ensureSidecarRuntime(
  repoDir: string,
  cacheHome: string,
  opts: RuntimeBuildOptions = {},
): Promise<RuntimeCommand> {
  const lockPath = join(repoDir, 'requirements-call.txt');
  const sha = new Bun.CryptoHasher('sha256').update(readFileSync(lockPath)).digest('hex');
  const venv = runtimeDir(cacheHome, sha);
  const ready = join(venv, '.tg-ready');
  const runtime = { argv: [join(venv, 'bin', 'python'), ...MODULE] };
  if (existsSync(ready)) return runtime;
  const uv = opts.uv ?? Bun.which('uv');
  if (!uv) {
    return {
      error:
        'Error: `uv` is needed once to build the Telegram user-account runtime. Install it ' +
        '(https://docs.astral.sh/uv/), or set TG_MTPROTO_SIDECAR to an existing runtime.',
    };
  }
  const lockDir = `${venv}.building`;
  mkdirSync(dirname(venv), { recursive: true });
  const wait = opts.waitMs ?? buildWaitMs(runtimeSetupSteps(uv, venv, lockPath).length);
  const started = Date.now();
  let waiting = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (existsSync(ready)) return runtime;
    const owner = buildLockOwner(lockDir);
    if (buildLockStale(lockDir, owner)) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > wait) return { error: buildBusyError(owner, venv, Date.now() - started) };
    if (!waiting) console.error('Waiting for another tg to finish building the Telegram user-account runtime…');
    waiting = true;
    await Bun.sleep(Math.min(500, wait));
  }
  try {
    return (existsSync(ready) ? null : build(uv, venv, lockPath, ready, sha)) ?? runtime;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function userAccountDeps(configDir: string, repoDir: string, home: string): UserAccountDeps {
  const env = sidecarEnv(process.env, loadEnv(join(configDir, '.env')), configDir, join(repoDir, 'features'));
  return {
    configDir,
    exists: existsSync,
    sidecarCommand: async () => {
      const override = process.env.TG_MTPROTO_SIDECAR;
      if (override) return { argv: [override] };
      return ensureSidecarRuntime(repoDir, process.env.XDG_CACHE_HOME || join(home, '.cache'));
    },
    spawn: async (argv, stdin) => {
      const proc = Bun.spawn(argv, {
        env,
        stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : 'inherit',
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { exitCode, stdout };
    },
    readStdin: async () => (process.stdin.isTTY ? null : await Bun.stdin.text()),
    log: (line) => console.log(line),
    errlog: (line) => console.error(line),
  };
}
