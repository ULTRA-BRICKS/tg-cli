// #450: exercise the real daemon, original receiver, and local sockets; never clone ACP.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { createDaemonRegistry, spawnDaemon, reapDaemons } from './helpers/daemon-lifecycle';
const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const reg = createDaemonRegistry();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { await reapDaemons(reg); for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(publish: boolean) {
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-original-'));
  const bin = join(cfg, 'bin'); mkdirSync(bin);
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n');
  const spawnLog = join(cfg, 'spawn.log'); writeFileSync(spawnLog, '');
  const sessionFile = join(cfg, '2026-09-27T01-00-00-000Z_01a0d2d7-6202-702d-b9e8-006b656b0798.jsonl');
  const sid = '01a0d2d7-6202-702d-b9e8-006b656b0798';
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: sid, cwd: '/work/original', title: 'OriginalReceiver' }) + '\n');
  const scripts: Record<string, string> = {
    ps: `#!/bin/sh\ncase "$*" in *tty*) printf '${process.pid} ??\\n';; *) printf '${process.pid} 1 /opt/homebrew/bin/omp\\n';; esac\n`,
    lsof: `#!/bin/sh\nprintf 'p${process.pid}\\nfcwd\\nn/work/original\\nn${sessionFile}\\n'\n`,
    tmux: '#!/bin/sh\nexit 0\n',
    omp: `#!/bin/sh\nprintf 'FORBIDDEN ACP CLONE\\n' >> '${spawnLog}'\nexit 1\n`,
  };
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(bin, name), text, { mode: 0o755 });
  const received: string[] = [];
  if (publish) {
    const endpoint = await startLiveEndpoint({ root: join(cfg, 'omp-live'),
      snapshot: () => ({ sessionId: sid, sessionFile, cwd: '/work/original', title: 'OriginalReceiver', busy: false }),
      send: (text: string) => { received.push(text); },
    });
    cleanup.push(() => endpoint.close());
  }
  const notices: string[] = []; let served = false;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      if (!served) { served = true; return Response.json({ ok: true, result: [{ update_id: 100,
        message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1,
          text: `/agent ${process.pid} preserve-original-pid` } }] }); }
      await Bun.sleep(50); return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) { const body = await req.json(); notices.push(String(body.text)); }
    return Response.json({ ok: true, result: { message_id: 77 } });
  } }); cleanup.push(() => { server.stop(true); });
  const fd = openSync(join(cfg, 'daemon.log'), 'w');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir: cfg, logFd: fd,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: cfg, TG_CTL_CONFIG_DIR: cfg,
      TG_API_BASE: `http://127.0.0.1:${server.port}`, TMUX: '' } }); closeSync(fd);
  return { cfg, received, notices, spawnLog };
}
async function until(check: () => boolean, limit = 4500) {
  const end = Date.now() + limit;
  while (!check() && Date.now() < end) await Bun.sleep(25);
}
test('real daemon sends to the already-running original PID, never ACP', async () => {
  const f = await fixture(true);
  await until(() => f.received.length > 0 || readFileSync(f.spawnLog, 'utf8').length > 0);
  expect(readFileSync(f.spawnLog, 'utf8')).toBe('');
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toContain('preserve-original-pid');
  expect(f.received[0]).toContain('tg#10');
}, 15000);
test('missing original endpoint reports unavailable instead of spawning a replacement', async () => {
  const f = await fixture(false);
  await until(() => f.notices.some(t => /bridge|endpoint|original/i.test(t)) || readFileSync(f.spawnLog, 'utf8').length > 0);
  expect(readFileSync(f.spawnLog, 'utf8')).toBe('');
  expect(f.received).toHaveLength(0);
  expect(f.notices.join('\n')).toMatch(/bridge|endpoint|original/i);
}, 15000);
test('omp-live status is a credential-free public CLI returning a JSON array', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-status-original-'));
  const p = Bun.spawn([process.execPath, TG_CTL, 'omp-live', 'status', '--json'], {
    env: { ...process.env, HOME: cfg, TG_CTL_CONFIG_DIR: cfg, TG_BOT_TOKEN: '', TG_CHAT_ID: '' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const text = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(JSON.parse(text)).toEqual([]);
}, 10000);
