import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// docs/specs/tg-auth.md — the REAL `tg auth …` (and, for the daemon path, a real
// `tg-ctl run`) against a fake Bot API over HTTP (TG_API_BASE). The test learns
// the one-time nonce the way a human does: from the deep link tg auth prints.
// Real delays are unavoidable here: separate processes (tg, tg-ctl) poll a real HTTP server,
// so the fake's empty long-poll paces itself and the test polls the child's observable state.

const TG = join(import.meta.dir, '..', 'tg');
const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const BOT = { id: 123, is_bot: true, username: 'my_bot', first_name: 'My Bot' };
const ALEX = { id: 42, type: 'private', first_name: 'Alex', username: 'alex' };

interface Call {
  method: string;
  http: string;
  params: Record<string, unknown>;
}

// One fake Bot API per test. `startNonce` is set by the test once it has read the
// link; the next getUpdates then carries `/start <nonce>` from Alex's DM.
function fakeApi(opts: { conflictPost?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { startNonce: null as string | null, served: false, nextUpdateId: 500, extra: [] as unknown[] };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split('/').pop() ?? '';
      let params: Record<string, unknown> = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') {
        const text = await req.text();
        try {
          params = { ...params, ...(JSON.parse(text) as Record<string, unknown>) };
        } catch {
          params = { ...params, ...Object.fromEntries(new URLSearchParams(text)) };
        }
      }
      calls.push({ method, http: req.method, params });
      if (method === 'getMe') return Response.json({ ok: true, result: BOT });
      if (method === 'getChat') return Response.json({ ok: true, result: { ...ALEX, id: Number(params.chat_id) } });
      if (method === 'getUpdates') {
        if (opts.conflictPost && req.method === 'POST') {
          return Response.json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, { status: 409 });
        }
        if (state.startNonce && !state.served) {
          state.served = true;
          const id = state.nextUpdateId++;
          return Response.json({
            ok: true,
            result: [{ update_id: id, message: { message_id: id, from: { id: 42, first_name: 'Alex' }, chat: ALEX, date: Math.floor(Date.now() / 1000), text: `/start ${state.startNonce}` } }],
          });
        }
        if (state.extra.length > 0) return Response.json({ ok: true, result: state.extra.splice(0) });
        await Bun.sleep(100);
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  return { server, calls, state, base: `http://127.0.0.1:${server.port}` };
}

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  for (const s of servers) s.stop(true);
});

function tempDirs(prefix: string): { home: string; cfg: string } {
  const home = mkdtempSync(join(tmpdir(), `tgctl-${prefix}-`));
  const cfg = join(home, 'cfg');
  return { home, cfg };
}

function spawnTg(args: string[], env: Record<string, string>) {
  return Bun.spawn(['bun', TG, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
}

// Read a child's stdout incrementally until `re` matches (the deep link), then
// keep draining in the background so the child never blocks on a full pipe.
async function waitForStdout(stream: ReadableStream<Uint8Array>, re: RegExp, ms: number): Promise<{ match: RegExpMatchArray | null; all: () => string }> {
  let buf = '';
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + ms;
  let match: RegExpMatchArray | null = null;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
    }
  })();
  while (Date.now() < deadline) {
    match = buf.match(re);
    if (match) break;
    await Bun.sleep(25);
  }
  void pump;
  return { match, all: () => buf };
}

const LINK = /https:\/\/t\.me\/my_bot\?start=([A-Za-z0-9_-]{32})/;

test('tg auth login binds a fresh config end-to-end in one command; tg auth status shows bot and chat', async () => {
  const api = fakeApi();
  servers.push(api.server);
  const { home, cfg } = tempDirs('auth-fresh');
  const env = { HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: api.base };

  const proc = spawnTg(['auth', 'login', '--token', '123:abcdef', '--timeout', '20'], env);
  const stdout = await waitForStdout(proc.stdout, LINK, 10_000);
  expect(stdout.match).not.toBeNull();
  api.state.startNonce = stdout.match?.[1] ?? null;
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });

  const envPath = join(cfg, '.env');
  expect(readFileSync(envPath, 'utf8')).toBe('TG_BOT_TOKEN=123:abcdef\nTG_CHAT_ID=42\n');
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
  expect(existsSync(join(cfg, 'tg-ctl.123.auth-pending.json'))).toBe(false);
  expect(stdout.all()).toContain('chat:   Alex (@alex) · private · id 42');
  // Default: nothing is sent to the chat.
  expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  // First-time setup confirms the /start update so a daemon started later never sees it.
  const lastPoll = api.calls.filter((c) => c.method === 'getUpdates').at(-1);
  expect(Number(lastPoll?.params.offset)).toBe(501);

  const status = spawnTg(['auth', 'status'], env);
  const statusOut = await new Response(status.stdout).text();
  expect(await status.exited).toBe(0);
  expect(statusOut).toContain('bot:    @my_bot (My Bot) · id 123');
  expect(statusOut).toContain('chat:   Alex (@alex) · private · id 42');
  expect(statusOut).toContain(`config: ${envPath}`);
  expect(statusOut).toContain('daemon: not running');
}, 30_000);

test('tg without credentials prints the tg auth hint and exits 78', async () => {
  const { home, cfg } = tempDirs('auth-nocreds');
  const proc = spawnTg(['hello'], { HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: 'http://127.0.0.1:9' });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(78);
  expect(stderr).toContain('TG_BOT_TOKEN and TG_CHAT_ID must be set');
  expect(stderr).toContain('tg auth');
});

test('tg auth status with nothing configured exits 78; `tg "auth is broken"` is still a message', async () => {
  const { home, cfg } = tempDirs('auth-status-empty');
  const env = { HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: 'http://127.0.0.1:9' };
  const status = spawnTg(['auth', 'status'], env);
  expect(await status.exited).toBe(78);
  // A message that merely starts with "auth" reaches the send gate (78 = no creds), not tg auth.
  const prose = spawnTg(['auth', 'is', 'broken'], env);
  const proseErr = await new Response(prose.stderr).text();
  expect(await prose.exited).toBe(78);
  expect(proseErr).toContain('must be set');
});

test('a 409 from another consumer (no local daemon) stops tg auth with exit 5 and writes nothing', async () => {
  const api = fakeApi({ conflictPost: true });
  servers.push(api.server);
  const { home, cfg } = tempDirs('auth-409');
  const proc = spawnTg(['auth', 'login', '--token', '123:abcdef', '--timeout', '20'], { HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: api.base });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(5);
  expect(stderr).toMatch(/another/i);
  expect(existsSync(join(cfg, '.env'))).toBe(false);
  expect(existsSync(join(cfg, 'tg-ctl.123.auth-pending.json'))).toBe(false);
}, 30_000);

test('with tg-ctl running, tg auth never polls: the daemon claims /start, persists TG_CHAT_ID and keeps serving the new chat', async () => {
  // tg auth would long-poll with POST; any POST getUpdates here is a 409, as Telegram
  // answers a second consumer — the test fails if tg auth competes with the daemon.
  const api = fakeApi({ conflictPost: true });
  servers.push(api.server);
  const { home, cfg } = tempDirs('auth-daemon');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), '# daemon config\nTG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n');
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'ps'), "#!/bin/sh\nprintf '    1     0 /sbin/launchd\\n'\nexit 0\n", { mode: 0o755 });
  const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: api.base };

  const logPath = join(cfg, 'daemon.log');
  const logFd = openSync(logPath, 'a');
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir: cfg, env, logFd });
  closeSync(logFd);
  expect(existsSync(join(cfg, 'tg-ctl.123.sock'))).toBe(true);

  const proc = Bun.spawn(['bun', TG, 'auth', 'login', '--timeout', '20'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const stdout = await waitForStdout(proc.stdout, LINK, 10_000);
  expect(stdout.match).not.toBeNull();
  api.state.startNonce = stdout.match?.[1] ?? null;
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });

  expect(api.calls.some((c) => c.method === 'getUpdates' && c.http === 'POST')).toBe(false);
  expect(readFileSync(join(cfg, '.env'), 'utf8')).toBe('# daemon config\nTG_BOT_TOKEN=123:abc\nTG_CHAT_ID=42\n');
  expect(existsSync(join(cfg, 'tg-ctl.123.auth-pending.json'))).toBe(false);
  expect(stdout.all()).toContain('chat:   Alex (@alex) · private · id 42');

  // Same daemon, now serving chat 42: a /status from Alex's DM is answered in chat 42.
  expect(daemon.exitCode).toBeNull();
  const before = api.calls.length;
  api.state.extra.push({
    update_id: 900,
    message: { message_id: 900, from: { id: 42, first_name: 'Alex' }, chat: ALEX, date: Math.floor(Date.now() / 1000), text: '/status' },
  });
  const deadline = Date.now() + 8000;
  const answered = () => api.calls.slice(before).some((c) => c.method === 'sendMessage' && String(c.params.chat_id) === '42');
  while (Date.now() < deadline && !answered()) await Bun.sleep(80);
  expect(answered()).toBe(true);
  // The Start tap itself was never routed to an agent / logged as a message.
  expect(readFileSync(logPath, 'utf8')).toContain('tg auth: bound chat 42');
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);
