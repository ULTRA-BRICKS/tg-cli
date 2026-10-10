// docs/specs/tg-auth.md §2, §5, §9 + docs/specs/independent-telegram-clients.md §1 — the
// COMBINED `tg auth` surface: the REAL `tg` against a fake Bot API (TG_API_BASE) and a fake
// MTProto sidecar (TG_MTPROTO_SIDECAR) at once, so every test can see which of the two a
// command reached — and that the other was never touched.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TG = join(import.meta.dir, '..', 'tg');
const BOT = { id: 123, is_bot: true, username: 'my_bot', first_name: 'My Bot' };
const ALEX = { id: 42, type: 'private', first_name: 'Alex', username: 'alex' };

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

interface FakeBotApi {
  methods: string[];
  base: string;
}

function fakeBotApi(): FakeBotApi {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      methods.push(method);
      if (method === 'getMe') return Response.json({ ok: true, result: BOT });
      if (method === 'getChat') return Response.json({ ok: true, result: ALEX });
      return Response.json({ ok: false, description: `unexpected ${method}` }, { status: 400 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { methods, base: `http://127.0.0.1:${server.port}` };
}

interface World {
  cfg: string;
  capture: string;
  env: Record<string, string>;
  api: FakeBotApi;
}

function world(opts: { bot?: boolean } = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'tg-auth-ua-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cfg = join(home, 'cfg');
  const capture = join(home, 'capture');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(capture);
  if (opts.bot) writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abcdef\nTG_CHAT_ID=42\n', { mode: 0o600 });
  const fake = join(home, 'fake-sidecar');
  writeFileSync(
    fake,
    ['#!/bin/sh', 'printf "%s\\n" "$@" > "$TG_FAKE_CAPTURE/argv"', 'printf "%s\\n" "$TG_FAKE_STDOUT"', 'exit "${TG_FAKE_EXIT:-0}"', ''].join('\n'),
  );
  chmodSync(fake, 0o755);
  const api = fakeBotApi();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    TG_API_BASE: api.base,
    TG_MTPROTO_SIDECAR: fake,
    TG_FAKE_CAPTURE: capture,
  };
  return { cfg, capture, env, api };
}

function session(w: World, role: 'personal' | 'caller', body: Record<string, unknown>): void {
  mkdirSync(join(w.cfg, 'mtproto'), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.cfg, 'mtproto', `${role}.json`), JSON.stringify(body), { mode: 0o600 });
}

async function tg(w: World, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', TG, ...args], { env: { ...w.env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const sidecarRan = (w: World): boolean => existsSync(join(w.capture, 'argv'));

describe('tg auth — one command for the bot and both accounts', () => {
  test('tg auth status: bot, chat, daemon AND user/caller in one view, offline for the accounts', async () => {
    const w = world({ bot: true });
    session(w, 'personal', { expected_id: 777, api_id: 5, api_hash: 'h', session: 'SECRET-SESSION', origin: 'login' });
    const r = await tg(w, ['auth', 'status']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('bot:    @my_bot (My Bot) · id 123');
    expect(r.stdout).toContain('chat:   Alex (@alex) · private · id 42');
    expect(r.stdout).toContain('user:   id 777 (logged in by tg)');
    expect(r.stdout).toContain('caller: not logged in — run `tg auth caller`');
    expect(r.stdout + r.stderr).not.toContain('SECRET-SESSION');
    expect(w.api.methods).toEqual(['getMe', 'getChat']);
    expect(sidecarRan(w)).toBe(false); // account lines need no Python
  });

  test('tg auth status without a bot: exit 78, accounts still listed, no network', async () => {
    const w = world();
    session(w, 'caller', { expected_id: 555, api_id: 5, api_hash: 'h', session: 's' });
    const r = await tg(w, ['auth', 'status']);
    expect(r.exitCode).toBe(78);
    expect(r.stdout).toContain('bot:    not connected — run `tg auth`');
    expect(r.stdout).toContain('caller: id 555 (imported — online use needs --source-idle-confirmed)');
    expect(w.api.methods).toEqual([]);
    expect(sidecarRan(w)).toBe(false);
  });

  test('tg help auth, tg auth --help and tg auth user --help print the same one help', async () => {
    const w = world();
    const [a, b, c] = await Promise.all([tg(w, ['help', 'auth']), tg(w, ['auth', '--help']), tg(w, ['auth', 'user', '--help'])]);
    for (const r of [a, b, c]) expect(r.exitCode).toBe(0);
    for (const s of ['tg auth login', 'tg auth status', 'tg auth logout', 'tg auth user', 'tg auth caller', '--qr', '--import-session']) {
      expect(b.stdout).toContain(s);
    }
    expect(c.stdout).toBe(b.stdout);
    expect(a.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toBe(b.stdout);
    expect(sidecarRan(w)).toBe(false);
    expect(w.api.methods).toEqual([]);
  });

  test('tg auth user|caller reach only the sidecar; tg auth login|status|logout only the Bot API', async () => {
    const w = world({ bot: true });
    const user = await tg(w, ['auth', 'user', 'status'], {
      TG_FAKE_STDOUT: '{"role": "personal", "configured": false, "reason": "SESSION_MISSING"}',
      TG_FAKE_EXIT: '3',
    });
    expect(user.exitCode).toBe(3);
    expect(readFileSync(join(w.capture, 'argv'), 'utf8').trimEnd().split('\n')).toEqual(['personal', `--store=${join(w.cfg, 'mtproto')}`, 'status']);
    expect(user.stdout).toContain('tg auth user: not logged in');
    expect(w.api.methods).toEqual([]);

    const caller = await tg(w, ['auth', 'caller', 'status', '--online'], {
      TG_FAKE_STDOUT: '{"role": "caller", "configured": true, "expected_id": 9, "origin": "login", "online_verified": true, "username": "ring"}',
    });
    expect(caller.exitCode).toBe(0);
    expect(readFileSync(join(w.capture, 'argv'), 'utf8').trimEnd().split('\n')).toEqual(['caller', `--store=${join(w.cfg, 'mtproto')}`, 'status', '--online']);
    expect(caller.stdout).toContain('online as @ring');
    expect(w.api.methods).toEqual([]);
  });

  test('flag-swallowing argv is a usage error on both halves: nothing reaches Telegram or the sidecar', async () => {
    const w = world({ bot: true });
    session(w, 'personal', { expected_id: 777, api_id: 5, api_hash: 'h', session: 's', origin: 'login' });
    session(w, 'caller', { expected_id: 9, api_id: 5, api_hash: 'h', session: 's', origin: 'login' });
    for (const argv of [
      ['auth', 'login', '--token', '--test'],
      ['auth', 'login', '--timeout', '--test'],
      ['auth', 'user', '--import-session', '--qr'],
      ['auth', 'caller', '--expected-id', '--qr'],
      ['call', '@a', '--say', '--dry-run'],
      ['call', 'me', '--audio', '--dry-run'],
    ]) {
      const r = await tg(w, argv);
      expect({ argv, exitCode: r.exitCode }).toEqual({ argv, exitCode: 2 });
    }
    expect(w.api.methods).toEqual([]);
    expect(sidecarRan(w)).toBe(false);
  });

  test('prose that starts with "auth" is still a message, not either half', async () => {
    const w = world();
    const r = await tg(w, ['auth', 'users', 'are', 'confused']);
    expect(r.exitCode).toBe(78); // the send gate: no bot configured
    expect(r.stderr).toContain('must be set');
    expect(sidecarRan(w)).toBe(false);
  });
});
