// The real effects behind `runUserAccount` (the one impure module here, like
// tg-ctl/host-registry-fs.ts): the hash-locked sidecar venv, the spawn, stdin, the console.
import { parseRegistry, pinnedSession, callerSessionKey } from '../tg-ctl/session-registry-store';
import { botIdFromToken, ctlPaths } from '../tg-ctl/lock';
import { detectSenderAncestry } from '../branding/detect';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'fs';
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

/** Reuse only the completed, matching cache during offline inspection; never build. */
function cachedSidecarRuntime(repoDir: string, cacheHome: string): RuntimeCommand | null {
  try {
    const sha = new Bun.CryptoHasher('sha256')
      .update(readFileSync(join(repoDir, 'requirements-call.txt'))).digest('hex');
    const venv = runtimeDir(cacheHome, sha);
    const ready = join(venv, '.tg-ready');
    const python = join(venv, 'bin', 'python');
    // Open once: metadata and bounded content must refer to the same inode (#761).
    // Refuse redirected/nonregular markers; O_NONBLOCK prevents a FIFO from hanging.
    if (typeof constants.O_NOFOLLOW !== 'number') return null;
    const fd = openSync(ready, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let marker: string;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 128) return null;
      const buffer = Buffer.alloc(129);
      let used = 0;
      while (used < buffer.length) {
        const count = readSync(fd, buffer, used, buffer.length - used, used);
        if (count === 0) break;
        used += count;
      }
      if (used > 128) return null;
      marker = buffer.subarray(0, used).toString('utf8');
    } finally {
      closeSync(fd);
    }
    if (marker.trim() === sha && statSync(python).isFile()) return { argv: [python, ...MODULE] };
  } catch { /* Absent or incomplete cache: inspect with system Python, without writes. */ }
  return null;
}

export function userAccountDeps(configDir: string, repoDir: string, home: string): UserAccountDeps {
  let offline = false;
  return {
    configDir,
    callContext: (cmd) => {
      const token = process.env.TG_BOT_TOKEN || (cmd.dryRun ? '' : loadEnv(join(configDir, '.env')).TG_BOT_TOKEN) || '';
      let raw: string | null = null;
      try { raw = readFileSync(ctlPaths(configDir, botIdFromToken(token)).sessions, 'utf8'); } catch { /* No registry means unknown session metadata. */ }
      const registry = parseRegistry(raw);
      const pin = cmd.session ?? process.env.TG_SESSION;
      const ancestry = pin ? null : detectSenderAncestry();
      const key = pin ? pinnedSession(registry, pin)?.key : callerSessionKey(registry, { agentPid: ancestry?.agents[0]?.pid ?? null, locator: null });
      const entry = registry.sessions.find(item => item.key === key);
      return {
        ...(process.env.RIG_AGENT_ID ? { agent: process.env.RIG_AGENT_ID } : {}),
        ...(entry && !cmd.agent && !cmd.agentTitle && !process.env.RIG_AGENT_ID ? { agentTitle: entry.name.primary } : {}),
        ...(entry ? { session: entry.key, sessionTitle: entry.name.secondary ?? entry.name.primary } : pin ? { session: pin } : {}),
      };
    },
    exists: existsSync,
    sidecarCommand: async (offlineMode = false) => {
      offline = offlineMode;
      const override = process.env.TG_MTPROTO_SIDECAR;
      if (override) return { argv: [override] };
      if (offline) return cachedSidecarRuntime(repoDir, process.env.XDG_CACHE_HOME || join(home, '.cache'))
        ?? { argv: ['python3', ...MODULE] };
      return ensureSidecarRuntime(repoDir, process.env.XDG_CACHE_HOME || join(home, '.cache'));
    },
    spawn: async (argv, stdin) => {
      const dotenv = offline ? {} : loadEnv(join(configDir, '.env'));
      const env = { ...sidecarEnv(process.env, dotenv, configDir, join(repoDir, 'features')),
        ...(offline ? { PYTHONDONTWRITEBYTECODE: '1' } : {}) };
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
