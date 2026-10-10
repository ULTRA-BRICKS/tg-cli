// How `tg` hands a user-account command to the Python MTProto sidecar. PURE: argv, env,
// paths and the one-time runtime setup steps as data; the entrypoint spawns them.
// Contract: docs/specs/independent-telegram-clients.md §1 "Sidecar runtime and handoff".
import { join } from 'path';
import type { Role, UserAccountCommand } from './args';

export interface SidecarInvocation {
  /** Everything after `python -m telegram_client` (or after TG_MTPROTO_SIDECAR). */
  args: string[];
  /**
   * Text for the sidecar's stdin (`tg user send`), so message text never sits in argv.
   * Absent: the sidecar inherits tg's stdin (login prompts read the terminal).
   */
  stdin?: string;
}

export function storeDir(configDir: string): string {
  return join(configDir, 'mtproto');
}

export function sessionPath(configDir: string, role: Role): string {
  return join(storeDir(configDir), `${role}.json`);
}

export type SessionState = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; id: number; origin: 'login' | 'import' };

/**
 * What a session file says about its account, for the offline `tg auth status` lines: only
 * `expected_id` and `origin` are read (never echoed: the `session` key). A file without
 * `origin` predates it and counts as an import, like the sidecar's `auth_origin`.
 */
export function sessionState(raw: string | null): SessionState {
  if (raw === null) return { kind: 'missing' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  if (typeof data !== 'object' || data === null || !('expected_id' in data)) return { kind: 'unreadable' };
  const id = data.expected_id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return { kind: 'unreadable' };
  return { kind: 'ok', id, origin: 'origin' in data && data.origin === 'login' ? 'login' : 'import' };
}

/**
 * Sessions that must exist before spawning, so "not logged in" is instant and needs no
 * Python. Login, import and status handle a missing session themselves.
 */
export function requiredSessions(cmd: UserAccountCommand): Role[] {
  switch (cmd.kind) {
    case 'call':
      return cmd.peer === 'me' ? ['caller', 'personal'] : [cmd.role];
    case 'send':
      return ['personal'];
    case 'logout':
      return [cmd.role];
    default:
      return [];
  }
}

// Every value goes over as ONE `--flag=value` token: argparse would read a separate
// dash-leading value (`--say -5 °C`, `--peer -100123`) as an option.
export function sidecarInvocation(cmd: UserAccountCommand, store: string): SidecarInvocation {
  const role: Role = cmd.kind === 'send' ? 'personal' : cmd.role;
  const head = [role, `--store=${store}`];
  const idle = cmd.kind !== 'login' && cmd.kind !== 'import' && cmd.kind !== 'logout' && cmd.sourceIdle
    ? ['--source-session-idle-confirmed']
    : [];
  const expected = 'expectedId' in cmd && cmd.expectedId ? [`--expected-id=${cmd.expectedId}`] : [];
  switch (cmd.kind) {
    case 'login':
      return { args: [...head, 'login', ...(cmd.qr ? ['--qr'] : []), ...expected] };
    case 'import':
      return {
        args: [...head, 'import-session', `--source-session=${cmd.session}`, `--source-config=${cmd.config}`, ...expected],
      };
    case 'status':
      return { args: [...head, 'status', ...(cmd.online ? ['--online'] : []), ...idle] };
    case 'logout':
      return { args: [...head, 'logout'] };
    case 'call':
      return {
        args: [
          ...head,
          'call',
          `--peer=${cmd.peer}`,
          cmd.say !== undefined ? `--say=${cmd.say}` : `--audio=${cmd.audio ?? ''}`,
          ...(cmd.timeout ? [`--timeout=${cmd.timeout}`] : []),
          ...(cmd.dryRun ? ['--dry-run'] : []),
          ...idle,
        ],
      };
    case 'send':
      return {
        args: [...head, 'send', `--peer=${cmd.peer}`, ...(cmd.dryRun ? ['--dry-run'] : []), ...idle],
        stdin: cmd.text ?? '',
      };
  }
}

/** A venv per lock content: a changed lock never reuses a venv built from the old one. */
export function runtimeDir(cacheHome: string, lockSha256: string): string {
  return join(cacheHome, 'tg-cli', `mtproto-runtime-${lockSha256.slice(0, 12)}`);
}

/** Each install step is killed after this long (sidecar-fs `build`). */
export const BUILD_STEP_TIMEOUT_MS = 10 * 60_000;

/**
 * Hash-enforced install. `uv run --with-requirements` is not used: it installed a
 * requirement whose pinned hash did not match (uv 0.12.24), which defeats the lock.
 */
export function runtimeSetupSteps(uv: string, venv: string, lockPath: string): string[][] {
  return [
    [uv, 'venv', '--quiet', '--python', '3.12', venv],
    [uv, 'pip', 'install', '--quiet', '--python', join(venv, 'bin', 'python'), '--require-hashes', '-r', lockPath],
  ];
}

/**
 * How long a waiter waits for another tg's build: as long as a live build can legitimately
 * take (every step at its timeout) plus slack — so a slow but healthy build is never cut off.
 */
export function buildWaitMs(steps: number): number {
  return steps * BUILD_STEP_TIMEOUT_MS + 2 * 60_000;
}

/**
 * The waiter gave up while the lock's owner is still alive. Its lock is never taken over or
 * deleted (two builders would delete each other's venv); a dead owner's lock is cleared
 * automatically, so the only advice is to let the owner finish or stop it.
 */
export function buildBusyError(ownerPid: number | null, venv: string, waitedMs: number): string {
  const who = ownerPid === null ? 'Another tg' : `Another tg (pid ${ownerPid})`;
  return (
    `Error: ${who} is still building the Telegram user-account runtime at ${venv} ` +
    `(waited ${Math.round(waitedMs / 60_000)} min). Let it finish, then run this again; or stop ` +
    'that process — tg clears its lock by itself once the owner has exited.'
  );
}

/**
 * The sidecar sees the caller's env plus the config dir and the sidecar sources; from the
 * config `.env` only the MTProto app registration is added — never the bot token.
 */
export function sidecarEnv(
  processEnv: Record<string, string | undefined>,
  dotenv: Record<string, string>,
  configDir: string,
  featuresDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(processEnv)) if (val !== undefined) env[key] = val;
  for (const key of ['TG_API_ID', 'TG_API_HASH']) {
    if (!env[key] && dotenv[key]) env[key] = dotenv[key];
  }
  delete env.TG_BOT_TOKEN; // the bot credential is another trust domain, even if exported
  env.TG_CTL_CONFIG_DIR = configDir;
  env.PYTHONPATH = env.PYTHONPATH ? `${featuresDir}:${env.PYTHONPATH}` : featuresDir;
  return env;
}
