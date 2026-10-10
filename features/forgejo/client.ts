// Forgejo REST access shared by tg (autolink-prs) and tg-ctl (/tasks).
//
// fj 0.6.0 prints only human-readable text (no JSON mode), so parsing its output would bind
// tg-cli to fj's presentation. Instead the REST API is called directly with the credential fj
// already stores for the host — one login (`fj auth login`) covers both tools. The repo is the
// cwd's `origin` remote; github.com and unparseable remotes are "not a Forgejo repo" (silent).
// The credential goes only to the origin host and redirects are never followed, so a token is
// never forwarded to a host it was not issued for.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GITHUB_HOSTS: Record<string, true> = { 'github.com': true, 'www.github.com': true, 'ssh.github.com': true };
const LOOPBACK_HOSTS: Record<string, true> = { '127.0.0.1': true, localhost: true, '[::1]': true };
// The forge's CDN front rejects API requests that carry no User-Agent; send an explicit,
// attributable one.
const USER_AGENT = 'tg-cli-forgejo/1';

export interface ForgejoRepo {
  /** `https://host[:port]` (or loopback `http://` in tests) — the API and web origin. */
  origin: string;
  /** fj key-store key: `host` or `host:port`. */
  hostKey: string;
  owner: string;
  name: string;
}

export function repoSlug(repo: ForgejoRepo): string {
  return `${repo.owner}/${repo.name}`;
}

function splitRepoPath(path: string): { owner: string; name: string } | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/, '');
  if (!owner || !name) return null;
  return { owner, name };
}

/**
 * Parse a git remote URL into the Forgejo repo it names. SSH remotes map to HTTPS on the same
 * host, through fj's `aliases` table when the SSH host differs from the web host (fj records
 * `ssh-host:port → web-host`). Null for github.com, non-https/ssh schemes and odd paths.
 */
export function parseForgejoRemote(url: string, aliases: Record<string, string> = {}): ForgejoRepo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let scheme: 'https' | 'http';
  let hostKey: string;
  let path: string;
  if (trimmed.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (protocol === 'ssh' || protocol === 'git+ssh') {
      const sshKey = parsed.port ? `${host}:${parsed.port}` : host;
      scheme = 'https';
      hostKey = aliases[sshKey] ?? host;
    } else if (protocol === 'https') {
      scheme = 'https';
      hostKey = parsed.port ? `${host}:${parsed.port}` : host;
    } else if (protocol === 'http' && LOOPBACK_HOSTS[host]) {
      scheme = 'http';
      hostKey = parsed.port ? `${host}:${parsed.port}` : host;
    } else {
      return null;
    }
    path = parsed.pathname;
  } else {
    const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):([^/].*)$/);
    if (!scp) return null;
    const host = scp[1].toLowerCase();
    scheme = 'https';
    hostKey = aliases[host] ?? host;
    path = scp[2];
  }
  const hostname = hostKey.replace(/:\d+$/, '');
  if (!hostname || GITHUB_HOSTS[hostname]) return null;
  const repo = splitRepoPath(path);
  if (!repo) return null;
  return { origin: `${scheme}://${hostKey}`, hostKey, ...repo };
}

/** fj's key store: `directories::ProjectDirs("", "forgejo-cli", "forgejo-cli").data_dir()`. */
export function fjKeysPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'forgejo-cli.forgejo-cli', 'keys.json');
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'forgejo-cli', 'forgejo-cli', 'data', 'keys.json');
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'forgejo-cli', 'keys.json');
}

interface FjKeyEntry {
  type?: string;
  token?: string;
  expires_at?: unknown;
}

interface FjKeyStore {
  hosts: Record<string, FjKeyEntry>;
  aliases: Record<string, string>;
}

function readKeyStore(path: string): FjKeyStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as { hosts?: unknown; aliases?: unknown };
  const hosts = rec.hosts && typeof rec.hosts === 'object' ? (rec.hosts as Record<string, FjKeyEntry>) : {};
  const aliases: Record<string, string> = {};
  if (rec.aliases && typeof rec.aliases === 'object') {
    for (const [k, v] of Object.entries(rec.aliases as Record<string, unknown>)) if (typeof v === 'string') aliases[k] = v;
  }
  return { hosts, aliases };
}

/**
 * fj's OAuth `expires_at` is a Rust `time::OffsetDateTime` in its default serde form, a 9-tuple
 * `[year, ordinal_day, hour, minute, second, nanosecond, offset_h, offset_m, offset_s]`; an RFC
 * 3339 string or a unix timestamp are accepted too. Null when unrecognised.
 */
export function fjExpiresAtMs(value: unknown): number | null {
  if (Array.isArray(value) && value.length === 9 && value.every((v) => Number.isInteger(v))) {
    const [year, ordinal, hour, minute, second, nanos, offH, offM, offS] = value as number[];
    const local = Date.UTC(year, 0, ordinal, hour, minute, second, Math.floor(nanos / 1e6));
    return local - ((offH * 60 + offM) * 60 + offS) * 1000;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function authHeader(entry: FjKeyEntry | undefined, now: number): string | 'expired' | null {
  if (!entry || typeof entry.token !== 'string' || !entry.token) return null;
  if (entry.type === 'OAuth') {
    const expires = fjExpiresAtMs(entry.expires_at);
    if (expires === null || now >= expires) return 'expired';
    return `Bearer ${entry.token}`;
  }
  return `token ${entry.token}`;
}

export interface HttpResult {
  status: number;
  body: string;
}

/**
 * GET an API path (`/repos/...`); null = the request itself failed (network, per-request
 * timeout, or `signal` aborted).
 */
export type ForgejoGet = (path: string, signal?: AbortSignal) => Promise<HttpResult | null>;

export type ForgejoResolution =
  | { status: 'ok'; repo: ForgejoRepo; get: ForgejoGet }
  | { status: 'no-repo' }
  | { status: 'no-auth'; host: string };

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

// Async on purpose: tg-ctl calls this from the daemon's event loop, which must not stall on
// a slow git or an fj token refresh.
async function runQuiet(argv: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env, timeout: timeoutMs });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null; // binary missing
  }
}

function forgejoGetter(repo: ForgejoRepo, authorization: string, timeoutMs: number): ForgejoGet {
  return async (path, signal) => {
    try {
      const res = await fetch(`${repo.origin}/api/v1${path}`, {
        // The Authorization value is fj's stored token for exactly this host (read from fj's key
        // store by design); redirects are not followed, so it never reaches another host.
        // codeql[js/file-access-to-http]
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: authorization },
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.text() };
    } catch {
      return null;
    }
  };
}

/** Resolve the Forgejo repo of `cwd` and an authenticated GET bound to its host. */
export async function resolveForgejo(cwd: string, opts: ResolveOptions = {}): Promise<ForgejoResolution> {
  const env = opts.env ?? process.env;
  const remote = (await runQuiet(['git', '-C', cwd, 'remote', 'get-url', 'origin'], 5_000, env))?.trim();
  if (!remote) return { status: 'no-repo' };
  const keysPath = fjKeysPath(env);
  const store = readKeyStore(keysPath);
  const repo = parseForgejoRemote(remote, store?.aliases ?? {});
  if (!repo) return { status: 'no-repo' };
  let header = authHeader(store?.hosts[repo.hostKey], Date.now());
  if (header === 'expired') {
    // fj refreshes an expired OAuth token itself when it runs and rewrites its key store.
    await runQuiet(['fj', '-H', repo.hostKey, 'whoami'], opts.timeoutMs ?? 10_000, env);
    header = authHeader(readKeyStore(keysPath)?.hosts[repo.hostKey], Date.now());
  }
  if (header === null || header === 'expired') return { status: 'no-auth', host: repo.hostKey };
  return { status: 'ok', repo, get: forgejoGetter(repo, header, opts.timeoutMs ?? 10_000) };
}
