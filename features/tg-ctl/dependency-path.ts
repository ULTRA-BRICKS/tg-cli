// The daemon inherits a service PATH (launchd's default is /usr/bin:/bin:/usr/sbin:/sbin), not the
// owner's interactive PATH. Resolve only the two known optional CLI dependencies, with no shell,
// repo search or installation. The pure policy (`resolveKnownCli`) takes an injected executable
// check; `findKnownCli` is its real-filesystem binding, evaluated on EVERY call so a tool installed
// or repaired while the daemon runs is found by the next command without a restart (tg-cli#804).
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { KnownCli } from './dependency-problem';

export interface CliResolution {
  path?: string;
  home?: string;
  isExecutable: (candidate: string) => boolean;
}

// Directories searched after the daemon PATH, in order: the owner's user bins (only with an
// absolute, non-root HOME), then the system-wide installs a service PATH omits (Apple Silicon
// Homebrew, Intel Homebrew / manual).
export function fallbackDirs(home: string | undefined): string[] {
  const userBins = home && isAbsolute(home) && home !== '/' ? [join(home, '.local', 'bin'), join(home, '.files', 'bin')] : [];
  return [...userBins, '/opt/homebrew/bin', '/usr/local/bin'];
}

export function resolveKnownCli(name: KnownCli, options: CliResolution): string | null {
  if (name !== 'pm' && name !== 'rig') return null;
  const dirs = [...(options.path ?? '').split(delimiter), ...fallbackDirs(options.home)];
  const checked = new Set<string>();
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (checked.has(candidate)) continue;
    checked.add(candidate);
    try {
      if (options.isExecutable(candidate)) return candidate;
    } catch {
      // A disappearing symlink or inaccessible file is not an executable dependency.
    }
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export type DaemonEnv = Readonly<Record<string, string | undefined>>;

export function findKnownCli(name: KnownCli, env: DaemonEnv = process.env): string | null {
  return resolveKnownCli(name, { path: env.PATH, home: env.HOME, isExecutable: isExecutableFile });
}

// The child's environment: the daemon's own PATH stays first (nothing it already resolves changes);
// the tool's directory (an interpreter or helper may live beside it) and the fallback dirs are
// appended once, so the tool's own helpers (`gh`, `git`) are found under a service PATH too.
export function serviceChildEnv(env: DaemonEnv, toolPath: string): Record<string, string | undefined> {
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  for (const dir of [dirname(toolPath), ...fallbackDirs(env.HOME)]) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return { ...env, PATH: dirs.join(delimiter) };
}
