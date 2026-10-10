import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, trackCfgDir, trackProc } from './helpers/daemon-lifecycle';
import { BOT_COMMANDS } from '../features/tg-ctl/bot-commands';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

// The daemon must self-provision its command menu on startup: POST setMyCommands
// once, with the published BOT_COMMANDS, before entering the poll loop. And it
// must do so resiliently — a failing setMyCommands cannot crash or block startup
// (the daemon's job is routing, not the menu).
//
// Pattern mirrors ctl-daemon-integration.test.ts: a real daemon subprocess
// against a local Bot-API fake, tmux PATH-shimmed to an empty pane list so no
// real tmux server is touched and the daemon stays alive on the long-poll.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

interface SetMyCommandsBody {
  commands: { command: string; description: string }[];
}

function makeFake(opts: { failSetMyCommands: boolean }) {
  const setMyCommandsBodies: SetMyCommandsBody[] = [];
  let getUpdatesHits = 0;
  const unexpectedPaths: string[] = []; // any endpoint other than setMyCommands/getUpdates
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMyCommands')) {
        setMyCommandsBodies.push((await req.json()) as SetMyCommandsBody);
        if (opts.failSetMyCommands) {
          // A real Bot-API rejection shape; botPost logs and returns null.
          return Response.json({ ok: false, error_code: 400, description: 'Bad Request: simulated' }, { status: 400 });
        }
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getUpdates')) {
        getUpdatesHits += 1;
        await Bun.sleep(1500); // pace like the real long-poll; keeps the daemon alive
        return Response.json({ ok: true, result: [] });
      }
      // Any other call would mean the daemon tried to send something unexpected
      // on startup — record it so a stray call can't hide behind a bland 404.
      unexpectedPaths.push(url.pathname);
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, setMyCommandsBodies, getUpdatesHits: () => getUpdatesHits, unexpectedPaths };
}

function spawnDaemon(cfgDir: string, shimDir: string, port: number): Subprocess {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  // Track BEFORE returning so teardown reaps it even if the caller throws before
  // it pushes; record the temp cfgDir for the scoped backstop sweep.
  trackProc(reg, daemon);
  trackCfgDir(reg, cfgDir);
  closeSync(logFd);
  return daemon;
}

function setupConfigDir(): { cfgDir: string; shimDir: string } {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-smc-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const shimDir = join(cfgDir, 'bin');
  mkdirSync(shimDir);
  // tmux shim: empty pane list, never touches the real server, exits 0.
  writeFileSync(join(shimDir, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  return { cfgDir, shimDir };
}

const reg = createDaemonRegistry();
const servers: { stop: (force?: boolean) => void }[] = [];

afterAll(async () => {
  await reapDaemons(reg);
  for (const s of servers) s.stop(true);
});

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

test('startup POSTs setMyCommands with the published command list', async () => {
  const { cfgDir, shimDir } = setupConfigDir();
  const fake = makeFake({ failSetMyCommands: false });
  servers.push(fake.server);
  const daemon = spawnDaemon(cfgDir, shimDir, fake.server.port);

  const got = await waitFor(() => fake.setMyCommandsBodies.length >= 1, 10_000);
  expect(got).toBe(true);

  // Exactly one publish on startup (not per-poll).
  await waitFor(() => fake.getUpdatesHits() >= 2, 5_000); // a couple of poll rounds
  expect(fake.setMyCommandsBodies.length).toBe(1);

  const body = fake.setMyCommandsBodies[0];
  expect(Array.isArray(body.commands)).toBe(true);
  // The payload is EXACTLY BOT_COMMANDS, order preserved.
  expect(body.commands).toEqual(BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })));

  // The headline command the CTO asked for is present, named WITHOUT a slash,
  // with a non-empty description.
  const agent = body.commands.find((c) => c.command === 'agent');
  expect(agent).toBeDefined();
  expect(agent?.command).not.toStartWith('/');
  expect((agent?.description.length ?? 0) > 0).toBe(true);
  for (const c of body.commands) {
    expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(c.description.length).toBeGreaterThanOrEqual(1);
    expect(c.description.length).toBeLessThanOrEqual(256);
  }

  // No stray startup calls hid behind a 404 — the publish path touched ONLY
  // setMyCommands + the poll loop.
  expect(fake.unexpectedPaths).toEqual([]);

  daemon.kill('SIGTERM');
  const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => 'timeout' as const)]);
  expect(exited).not.toBe('timeout');
}, 20_000);

test('a failing setMyCommands does NOT crash or block startup', async () => {
  const { cfgDir, shimDir } = setupConfigDir();
  const fake = makeFake({ failSetMyCommands: true });
  servers.push(fake.server);
  const daemon = spawnDaemon(cfgDir, shimDir, fake.server.port);

  // setMyCommands was attempted (and rejected by the fake)...
  const attempted = await waitFor(() => fake.setMyCommandsBodies.length >= 1, 10_000);
  expect(attempted).toBe(true);

  // ...yet the daemon proceeds into the poll loop (getUpdates keeps firing) and
  // stays alive — the failure was swallowed, not fatal.
  const polled = await waitFor(() => fake.getUpdatesHits() >= 2, 8_000);
  expect(polled).toBe(true);
  expect(daemon.exitCode).toBe(null); // still running

  daemon.kill('SIGTERM');
  const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => 'timeout' as const)]);
  expect(exited).not.toBe('timeout');
  expect(daemon.exitCode).toBe(0); // clean shutdown, never crashed
}, 20_000);

test('a transport failure (Telegram unreachable) does NOT crash startup', async () => {
  // The HTTP-400 test above proves the daemon survives a REJECTED setMyCommands.
  // This covers the harsher path the 400 test cannot: the fetch itself rejecting
  // (connection refused) — i.e. botPost's catch + publishBotCommands' guard. Point
  // the daemon at a port with NO server listening: setMyCommands AND getUpdates
  // both fail, yet the daemon must enter the poll loop and stay alive (the loop's
  // own 5s-backoff catch), never crashing on the unreachable menu publish.
  const { cfgDir, shimDir } = setupConfigDir();
  // Grab-then-release a port so nothing is listening on it.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const deadPort = probe.port;
  probe.stop(true);

  const daemon = spawnDaemon(cfgDir, shimDir, deadPort);

  // Wait on a POSITIVE liveness signal, not a blind sleep (review #68): runDaemon
  // writes its pidfile early — BEFORE publishBotCommands — so the file appearing
  // proves the process got past startup setup and reached the menu-publish path.
  const pidFile = join(cfgDir, 'tg-ctl.123.pid');
  const started = await waitFor(() => existsSync(pidFile), 8_000);
  expect(started).toBe(true);
  // Then give it a beat to attempt the (failing) publish + first (failing) poll
  // and confirm it is STILL alive — the unreachable Telegram never crashed it.
  await waitFor(() => daemon.exitCode !== null, 2_000); // resolves false (stays alive) — that's the point
  expect(daemon.exitCode).toBe(null); // survived the unreachable publish + first poll

  daemon.kill('SIGTERM');
  const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => 'timeout' as const)]);
  expect(exited).not.toBe('timeout');
  expect(daemon.exitCode).toBe(0); // clean shutdown, never crashed
}, 20_000);
