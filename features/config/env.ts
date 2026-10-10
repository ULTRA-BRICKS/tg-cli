// --- Config `.env` loader (shared) ---
//
// The single `.env` parser used across `tg`: a flat KEY=VALUE file at
// ~/.config/tg-cli/.env. Comments (`#`) and blank lines are skipped; values are
// read verbatim after the first `=` (no quoting/expansion). It NEVER throws —
// a missing file yields {} so credential-free paths still work.
//
// The canonical precedence everywhere is `{ ...loadEnv(path), ...process.env }`
// (config file first, real environment wins) — see `resolveConfigEnv` below and
// the `tg` entrypoint. Tooling that needs the same config (e.g. the emoji-set
// upload scripts) imports from here instead of re-implementing the parser, so a
// token set ONLY in the config `.env` (no transient shell export) is honored.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Parse `.env` content (the rules above). Pure — `tg auth` parses content it already read. */
export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

export function loadEnv(filePath: string): Record<string, string> {
  try {
    return parseEnvContent(readFileSync(filePath, 'utf8'));
  } catch {
    // file doesn't exist — skip
    return {};
  }
}

/** Absolute path to the tg config `.env` (respects $HOME). */
export function configEnvPath(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, '.config', 'tg-cli', '.env');
}

/**
 * The merged config env every tg code path uses: config `.env` first, real
 * `process.env` overriding it (an explicit shell export always wins). Read this
 * — not bare `process.env` — so a key present only in the config file is seen.
 */
export function resolveConfigEnv(): Record<string, string> {
  return { ...loadEnv(configEnvPath()), ...process.env };
}
