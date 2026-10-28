// The single TypeScript seam to the remote-ctl validation (docs/specs/2026-10-28-remote-ctl-server.md §3).
//
// The rules for control.server / control.machine / control.remote_machines live ONCE, in Python
// (`tg-remote config check --json`). TypeScript only reads the raw strings (config.ts) and, when
// at least one of them is present, asks that checker what the machine is. A machine with none of
// the keys never reaches the spawn: `resolveRemoteMode` returns {mode:'local'} synchronously, so
// the local path stays byte-identical (no process, no file).
//
// An unreachable or broken checker is NEVER read as "local": a client machine that silently fell
// back to local behaviour could start a second getUpdates poller, which is the hazard this whole
// feature exists to rule out. It becomes {mode:'invalid'} and every caller exits 78.

import { join } from 'path';
import { isRecord } from './guards';
import type { ControlConfig } from './types';

export type RemoteMode =
  | { mode: 'local' }
  | { mode: 'client'; server: string; alias: string; machine: string }
  | { mode: 'hub'; remoteMachines: { name: string; target: string }[] }
  | { mode: 'invalid'; errors: string[] };

export type RemoteKeys = Pick<ControlConfig, 'server' | 'machine' | 'remoteMachines'>;
type Env = Record<string, string | undefined>;

export interface RemoteSpawnResult {
  stdout: string;
  stderr: string;
  /** null when the child was killed (timeout) or never reported a code. */
  exitCode: number | null;
  timedOut: boolean;
}

export interface RemoteDeps {
  /** Run argv (no shell) with the given env and a hard deadline. Throws when the process cannot start. */
  spawn?: (argv: string[], env: Env, timeoutMs: number) => RemoteSpawnResult;
  /** The config dir the caller already resolved; forwarded to the checker as TG_CTL_CONFIG_DIR. */
  configDir?: string;
  /** Directory holding the default `tg-remote` launcher; defaults to this repository's root. */
  rootDir?: string;
}

/** Hard deadline for the offline checker; it only parses a few scalars. */
export const REMOTE_CHECK_TIMEOUT_MS = 3000;

const unavailable = (cause: string): RemoteMode => ({ mode: 'invalid', errors: [`tg-remote unavailable: ${cause}`] });

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseHubReport(list: unknown): RemoteMode {
  if (!Array.isArray(list) || list.length === 0) return unavailable('hub report has no remote_machines');
  const remoteMachines: { name: string; target: string }[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || !isString(entry.name) || !isString(entry.target)) {
      return unavailable('hub report has a malformed remote_machines entry');
    }
    remoteMachines.push({ name: entry.name, target: entry.target });
  }
  return { mode: 'hub', remoteMachines };
}

function parseOkReport(doc: Record<string, unknown>): RemoteMode {
  if (doc.mode === 'local') return { mode: 'local' };
  if (doc.mode === 'hub') return parseHubReport(doc.remote_machines);
  if (doc.mode !== 'client') return unavailable('config check reported an unknown mode');
  const { server, alias, machine } = doc;
  if (isString(server) && isString(alias) && isString(machine)) return { mode: 'client', server, alias, machine };
  return unavailable('client report is missing server, alias or machine');
}

/** Map the checker's stdout + exit code to a RemoteMode. Pure; every malformed shape is `invalid`. */
export function parseRemoteCheck(stdout: string, exitCode: number | null): RemoteMode {
  if (exitCode === null) return unavailable('check did not finish');
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    return unavailable(exitCode === 0 ? 'unparsable config check output' : `config check exited ${exitCode} without a report`);
  }
  if (!isRecord(doc) || typeof doc.ok !== 'boolean') return unavailable('unparsable config check output');

  if (!doc.ok) {
    const errors = Array.isArray(doc.errors) ? doc.errors.filter(isString) : [];
    return { mode: 'invalid', errors: errors.length > 0 ? errors : ['remote config is invalid'] };
  }
  // "ok" with a failing exit code is a contradiction: believe the exit code.
  if (exitCode !== 0) return unavailable(`config check reported ok but exited ${exitCode}`);
  return parseOkReport(doc);
}

function defaultSpawn(argv: string[], env: Env, timeoutMs: number): RemoteSpawnResult {
  const proc = Bun.spawnSync(argv, {
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
    timedOut: Boolean(proc.exitedDueToTimeout),
  };
}

// The checker ran only because a remote key WAS observed. A report that contradicts the role those
// keys imply (the file changed between our read and the check, or a checker bug) must never be
// believed as "local": that would let a client machine start a second getUpdates poller.
function expectedRole(cfg: RemoteKeys): 'client' | 'hub' | 'invalid' {
  if (cfg.remoteMachines !== undefined && (cfg.server !== undefined || cfg.machine !== undefined)) return 'invalid';
  if (cfg.server !== undefined) return 'client';
  return cfg.remoteMachines !== undefined ? 'hub' : 'invalid';
}

function confirmRole(cfg: RemoteKeys, mode: RemoteMode): RemoteMode {
  const expected = expectedRole(cfg);
  if (mode.mode === expected) return mode;
  return { mode: 'invalid', errors: [`remote config changed between read and check: expected ${expected}, checker reported ${mode.mode}`] };
}

/**
 * What is this machine: plain local (no remote keys), a ctl client, the daemon host of clients,
 * or misconfigured. Spawns the offline checker ONLY when a remote key is present.
 */
export function resolveRemoteMode(cfg: RemoteKeys, env: Env, deps: RemoteDeps = {}): RemoteMode {
  if (cfg.server === undefined && cfg.machine === undefined && cfg.remoteMachines === undefined) return { mode: 'local' };

  const launcher = env.TG_REMOTE_BIN || join(deps.rootDir ?? join(import.meta.dir, '..', '..'), 'tg-remote');
  const childEnv: Env = deps.configDir ? { ...env, TG_CTL_CONFIG_DIR: deps.configDir } : env;
  let result: RemoteSpawnResult;
  try {
    result = (deps.spawn ?? defaultSpawn)(// -I: isolated interpreter — no cwd on sys.path, no PYTHON* variables, no user site.
      ['python3', '-I', launcher, 'config', 'check', '--json'], childEnv, REMOTE_CHECK_TIMEOUT_MS);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  if (result.timedOut) return unavailable(`config check timed out after ${REMOTE_CHECK_TIMEOUT_MS} ms`);
  const mode = parseRemoteCheck(result.stdout, result.exitCode);
  if (mode.mode !== 'invalid') return confirmRole(cfg, mode);
  if (mode.errors.some((e) => !e.startsWith('tg-remote unavailable: '))) return mode;
  // No usable report: say why the checker itself failed (first stderr line), not just that it did.
  const detail = result.stderr.trim().split('\n')[0];
  return detail ? { mode: 'invalid', errors: [`${mode.errors[0]} (${detail})`] } : mode;
}
