import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { writeOutboxEntry } from '../features/transport/outbox';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// tg-cli#710: the daemon replays a send `tg` queued while Telegram was failing. It tries on
// startup (still failing here: the entry stays) and again after a getUpdates round-trip
// succeeds; the replay carries the delay mark into the original thread and reply anchor,
// its message id gets a route, and the entry is removed.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-outbox-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const outboxDir = join(cfgDir, 'tg-ctl.123.outbox');

const replays: Array<Record<string, unknown>> = [];
let replayAttempts = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      // A real long-poll holds the request; without a short hold the daemon hot-loops.
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      if (String(body.text).includes('late report')) {
        replayAttempts++;
        // The startup flush still meets the outage.
        if (replayAttempts === 1) return Response.json({ ok: false, error_code: 502, description: 'Bad Gateway' }, { status: 502 });
        replays.push(body);
        return Response.json({ ok: true, result: { message_id: 4242 } });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

// The daemon is a real subprocess (no in-process clock to fake): poll for the observable
// condition, bounded, instead of guessing a duration.
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

test('the daemon flushes the outbox after a successful getUpdates, marked, into the original thread and anchor', async () => {
  const createdAt = Date.now() - 60 * 60 * 1000;
  const hhmm = new Date(createdAt).toISOString().slice(11, 16);
  await writeOutboxEntry(outboxDir, {
    sends: [
      {
        method: 'sendMessage',
        body: { chat_id: '1', text: '<b>late report</b>', parse_mode: 'HTML', message_thread_id: 9, reply_to_message_id: 77 },
        threadAdvisory: false,
      },
    ],
    // Relative to now: a fixed date ages past OUTBOX_LIMITS.maxAgeMs (24 h) and the entry is dropped.
    createdAt,
    route: { paneId: '%3', cwd: '/w/proj' },
  });
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: process.env.PATH ?? '', HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  expect(await until(() => replays.length > 0 && !readdirSync(outboxDir).some((n) => n.endsWith('.json')), 15_000)).toBe(true);
  expect(replayAttempts).toBe(2);
  expect(replays).toHaveLength(1);
  const text = String(replays[0].text);
  expect(text.startsWith('⏳ доставлено с задержкой')).toBe(true);
  expect(text).toContain(`${hhmm} UTC`);
  expect(text).toContain('<b>late report</b>');
  expect(replays[0].parse_mode).toBe('HTML');
  expect(replays[0].message_thread_id).toBe(9);
  expect(replays[0].reply_to_message_id).toBe(77);

  const routesPath = join(cfgDir, 'tg-ctl.123.routes.json');
  expect(await until(() => existsSync(routesPath) && readFileSync(routesPath, 'utf8').includes('4242'), 5000)).toBe(true);
  const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as Array<Record<string, unknown>>;
  expect(routes.find((r) => r.id === 4242)).toMatchObject({ paneId: '%3', cwd: '/w/proj' });

  const log = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(log).toContain('outbox:');
  expect(log).toContain('delivered');
}, 30_000);
