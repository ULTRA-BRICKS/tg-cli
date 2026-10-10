import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fjExpiresAtMs, fjKeysPath, parseForgejoRemote, resolveForgejo } from '../features/forgejo/client';
import { tempDir } from './helpers/test-temp';

// --- origin parsing ---

test('parseForgejoRemote: https remote names host, owner and repo (.git stripped)', () => {
  expect(parseForgejoRemote('https://git.hyperide.ai/ultrabricks/tg-cli.git')).toEqual({
    origin: 'https://git.hyperide.ai',
    hostKey: 'git.hyperide.ai',
    owner: 'ultrabricks',
    name: 'tg-cli',
  });
});

test('parseForgejoRemote: ssh remotes map to the web host through fj aliases', () => {
  const aliases = { 'bread.eu-hel1.hyperide.ai:2223': 'git.hyperide.ai' };
  expect(parseForgejoRemote('ssh://git@bread.eu-hel1.hyperide.ai:2223/ultrabricks/tg-cli.git', aliases)).toMatchObject({
    origin: 'https://git.hyperide.ai',
    hostKey: 'git.hyperide.ai',
    owner: 'ultrabricks',
    name: 'tg-cli',
  });
  // scp-style, no alias: same host over https
  expect(parseForgejoRemote('git@git.hyperide.ai:ultrabricks/tg-cli.git')).toMatchObject({ origin: 'https://git.hyperide.ai', owner: 'ultrabricks' });
});

test('parseForgejoRemote: github.com, plain http and odd paths are not Forgejo repos', () => {
  expect(parseForgejoRemote('https://github.com/alex-mextner/tg-cli.git')).toBeNull();
  expect(parseForgejoRemote('git@github.com:alex-mextner/tg-cli.git')).toBeNull();
  expect(parseForgejoRemote('http://git.hyperide.ai/ultrabricks/tg-cli.git')).toBeNull();
  expect(parseForgejoRemote('https://git.hyperide.ai/only-owner')).toBeNull();
  expect(parseForgejoRemote('')).toBeNull();
  // loopback http is allowed (tests run a fake forge there)
  expect(parseForgejoRemote('http://127.0.0.1:3999/o/r.git')).toMatchObject({ origin: 'http://127.0.0.1:3999', hostKey: '127.0.0.1:3999' });
});

test('fjExpiresAtMs: reads fj’s OffsetDateTime tuple, RFC 3339 and unix seconds', () => {
  // 2026-10-10 (ordinal day 283) 12:00:00 at +02:00 = 10:00 UTC
  expect(fjExpiresAtMs([2026, 283, 12, 0, 0, 0, 2, 0, 0])).toBe(Date.UTC(2026, 9, 10, 10, 0, 0));
  expect(fjExpiresAtMs('2026-10-10T10:00:00Z')).toBe(Date.UTC(2026, 9, 10, 10, 0, 0));
  expect(fjExpiresAtMs(1_800_000_000)).toBe(1_800_000_000_000);
  expect(fjExpiresAtMs('nope')).toBeNull();
  expect(fjExpiresAtMs(undefined)).toBeNull();
});

test('fjKeysPath: XDG data dir on Linux, Application Support on macOS', () => {
  expect(fjKeysPath({ HOME: '/h' }, 'linux')).toBe('/h/.local/share/forgejo-cli/keys.json');
  expect(fjKeysPath({ HOME: '/h', XDG_DATA_HOME: '/x' }, 'linux')).toBe('/x/forgejo-cli/keys.json');
  expect(fjKeysPath({ HOME: '/h' }, 'darwin')).toBe('/h/Library/Application Support/forgejo-cli.forgejo-cli/keys.json');
});

// --- resolveForgejo against a real git checkout and a fake forge ---

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function checkout(originUrl: string | null): { home: string; repo: string } {
  const home = tempDir('forgejo-client-');
  const repo = join(home, 'repo');
  mkdirSync(repo);
  Bun.spawnSync(['git', 'init', '-q', repo]);
  if (originUrl) Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', originUrl]);
  return { home, repo };
}

function writeKeys(home: string, hosts: Record<string, unknown>): void {
  const dir = join(home, '.local', 'share', 'forgejo-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keys.json'), JSON.stringify({ hosts, aliases: {}, default_ssh: [] }));
}

interface SeenRequest {
  path: string;
  authorization: string | null;
  userAgent: string | null;
}

function fakeForge(): { port: number; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, authorization: req.headers.get('authorization'), userAgent: req.headers.get('user-agent') });
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { port: server.port, seen };
}

test('resolveForgejo: authenticated GET carries the fj token and a User-Agent, to the origin host only', async () => {
  const forge = fakeForge();
  const { home, repo } = checkout(`http://127.0.0.1:${forge.port}/ultrabricks/tg-cli.git`);
  writeKeys(home, { [`127.0.0.1:${forge.port}`]: { type: 'Application', name: 'x', token: 'sekret' } });
  const r = await resolveForgejo(repo, { env: { HOME: home, PATH: process.env.PATH ?? '' } });
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  expect(r.repo).toMatchObject({ owner: 'ultrabricks', name: 'tg-cli' });
  expect(await r.get('/repos/ultrabricks/tg-cli/issues/1')).toEqual({ status: 200, body: '{"ok":true}' });
  expect(forge.seen[0]).toEqual({ path: '/api/v1/repos/ultrabricks/tg-cli/issues/1', authorization: 'token sekret', userAgent: 'tg-cli-forgejo/1' });
});

test('resolveForgejo: no credential for the host → no-auth; github/no origin → no-repo', async () => {
  const a = checkout('https://git.hyperide.ai/ultrabricks/tg-cli.git');
  writeKeys(a.home, { 'other.example': { type: 'Application', token: 't' } });
  expect(await resolveForgejo(a.repo, { env: { HOME: a.home, PATH: process.env.PATH ?? '' } })).toEqual({ status: 'no-auth', host: 'git.hyperide.ai' });

  const b = checkout('https://github.com/alex-mextner/tg-cli.git');
  writeKeys(b.home, { 'github.com': { type: 'Application', token: 't' } });
  expect((await resolveForgejo(b.repo, { env: { HOME: b.home, PATH: process.env.PATH ?? '' } })).status).toBe('no-repo');

  const c = checkout(null);
  expect((await resolveForgejo(c.repo, { env: { HOME: c.home, PATH: process.env.PATH ?? '' } })).status).toBe('no-repo');
});

test('resolveForgejo: an expired fj OAuth token is refreshed by running fj once, then used', async () => {
  const forge = fakeForge();
  const host = `127.0.0.1:${forge.port}`;
  const { home, repo } = checkout(`http://${host}/o/r.git`);
  writeKeys(home, { [host]: { type: 'OAuth', token: 'stale', expires_at: '2000-01-01T00:00:00Z' } });
  // fake fj: `fj -H <host> whoami` rewrites the key store with a fresh token, as real fj does
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const fresh = JSON.stringify({ hosts: { [host]: { type: 'OAuth', token: 'fresh', expires_at: '2999-01-01T00:00:00Z' } }, aliases: {} });
  writeFileSync(join(bin, 'fj'), `#!/bin/sh\n[ "$1 $2 $3" = "-H ${host} whoami" ] || exit 9\nprintf '%s' '${fresh}' > "$HOME/.local/share/forgejo-cli/keys.json"\n`, { mode: 0o755 });
  const r = await resolveForgejo(repo, { env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  await r.get('/x');
  expect(forge.seen[0].authorization).toBe('Bearer fresh');
});

test('resolveForgejo: an expired OAuth token fj cannot refresh → no-auth', async () => {
  const { home, repo } = checkout('https://git.hyperide.ai/o/r.git');
  writeKeys(home, { 'git.hyperide.ai': { type: 'OAuth', token: 'stale', expires_at: '2000-01-01T00:00:00Z' } });
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'fj'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = await resolveForgejo(repo, { env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  expect(r).toEqual({ status: 'no-auth', host: 'git.hyperide.ai' });
});

test('resolveForgejo: a redirect is returned as-is, never followed with the token', async () => {
  const target = fakeForge();
  const redirector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/steal` } }) });
  servers.push(redirector);
  const host = `127.0.0.1:${redirector.port}`;
  const { home, repo } = checkout(`http://${host}/o/r.git`);
  writeKeys(home, { [host]: { type: 'Application', token: 'sekret' } });
  const r = await resolveForgejo(repo, { env: { HOME: home, PATH: process.env.PATH ?? '' } });
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  expect((await r.get('/x'))?.status).toBe(302);
  expect(target.seen).toHaveLength(0);
});
