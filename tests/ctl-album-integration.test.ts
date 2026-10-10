// Inbound albums end to end (tg-cli#280): the real `tg-ctl run` against a fake Bot API.
//
// Alex sent two screenshots with one caption as an album and the agent got two unrelated
// deliveries — the caption on one, nothing on the other. Telegram sends an album as one
// message per photo sharing a media_group_id, and the photos can arrive in separate
// getUpdates batches. The daemon must hold them and deliver ONE message listing every
// file plus the caption, exactly once, including across a restart.

import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PANE_ID = '%1';
const PANE_PID = 4242;

const reg = createDaemonRegistry();
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const c of cleanups.splice(0)) await c();
});

// A claude pane %1; everything typed into it is appended to <cfgDir>/inject.log.
function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-album-');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: PANE_ID, cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(
    join(cfgDir, 'bin', 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cfgDir}' ;;
  display-message) printf 'main\\n' ;;
  send-keys)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then printf '%s\\n' "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer) cat >> '${injectLog}'; printf '\\n' >> '${injectLog}' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(cfgDir, 'bin', 'ps'), `#!/bin/sh\nprintf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'\nexit 0\n`, { mode: 0o755 });
  return cfgDir;
}

const injectLog = (cfgDir: string): string => {
  const p = join(cfgDir, 'inject.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};
const deliveries = (cfgDir: string): number => injectLog(cfgDir).split('[TG from').length - 1;

function photoUpdate(updateId: number, messageId: number, caption?: string) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: Math.floor(Date.now() / 1000),
      media_group_id: '13106000',
      photo: [{ file_id: `thumb-${messageId}`, file_size: 10 }, { file_id: `photo-${messageId}`, file_size: 1000 }],
      ...(caption ? { caption } : {}),
    },
  };
}

function textUpdate(updateId: number, messageId: number, text: string) {
  return { update_id: updateId, message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text } };
}

type Api = { port: number; batches: unknown[][]; sent: string[]; fetched: string[]; reactions: number[] };

// One field of a fake-API request body, read without trusting its shape.
async function bodyField(req: Request, key: string): Promise<unknown> {
  const body: unknown = await req.json();
  return body && typeof body === 'object' && key in body ? Object.getOwnPropertyDescriptor(body, key)?.value : undefined;
}

function startApi(): Api {
  const api: Api = { port: 0, batches: [], sent: [], fetched: [], reactions: [] };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = api.batches.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/getFile')) {
        const fileId = url.searchParams.get('file_id') ?? '';
        api.fetched.push(fileId);
        return Response.json({ ok: true, result: { file_path: `photos/${fileId}.jpg` } });
      }
      if (url.pathname.includes('/file/bot')) return new Response('JPEGDATA');
      if (url.pathname.endsWith('/sendMessage')) {
        api.sent.push(String(await bodyField(req, 'text')));
        return Response.json({ ok: true, result: { message_id: 800 + api.sent.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) api.reactions.push(Number(await bodyField(req, 'message_id')));
      return Response.json({ ok: true, result: true });
    },
  });
  api.port = server.port;
  cleanups.push(() => server.stop(true));
  return api;
}

async function startDaemon(cfgDir: string, api: Api, extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${api.port}`,
      ...extraEnv,
    },
    logFd,
  });
  closeSync(logFd);
  return daemon;
}

async function stopDaemon(daemon: Subprocess): Promise<void> {
  daemon.kill('SIGTERM');
  await daemon.exited;
}

// The daemon is a separate process: its progress is observable only through the files
// and API calls it makes, so tests poll that state.
async function waitFor(what: string, cond: () => boolean, cfgDir: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      const log = existsSync(join(cfgDir, 'daemon.log')) ? readFileSync(join(cfgDir, 'daemon.log'), 'utf8') : '';
      throw new Error(`timed out waiting for ${what}\n--- inject.log ---\n${injectLog(cfgDir)}\n--- daemon.log ---\n${log}`);
    }
    await Bun.sleep(50);
  }
}

// Message ids the delivery ledger records `delivered`. The record follows the pane write, so a
// test waits on it, not on the inject log, before reading the ledger.
const ledgerDelivered = (cfgDir: string): number[] => {
  const path = join(cfgDir, 'tg-ctl.123.delivery.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l): unknown => JSON.parse(l))
    .flatMap((e) => (e && typeof e === 'object' && 'event' in e && e.event === 'delivered' && 'msg' in e && typeof e.msg === 'number' ? [e.msg] : []))
    .sort((a, b) => a - b);
};

const inbound = (cfgDir: string, messageId: number): string => join(cfgDir, '.cache', 'tg-cli', 'inbound', `${messageId}.jpg`);

test('a 3-photo album split across two getUpdates batches is ONE injected message listing all 3 files and the caption', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  api.batches.push([photoUpdate(700, 13106, 'two screenshots of one bug'), photoUpdate(701, 13107)]);
  await startDaemon(cfgDir, api);
  await waitFor('the first batch polled', () => api.batches.length === 0, cfgDir);
  // A real gap, not a guess at a race: the issue's albums arrive ~200-800 ms apart, and the
  // daemon's hold window is wall-clock time in another process no fake clock reaches.
  await Bun.sleep(500);
  api.batches.push([photoUpdate(702, 13108)]);
  await waitFor('the album delivery', () => deliveries(cfgDir) >= 1, cfgDir);
  // A later message proves nothing else was delivered for the album in between.
  api.batches.push([textUpdate(703, 13109, 'next')]);
  await waitFor('the next message', () => ledgerDelivered(cfgDir).includes(13109), cfgDir);

  const log = injectLog(cfgDir);
  expect(deliveries(cfgDir)).toBe(2);
  expect(log).toContain('tg#13106');
  expect(log).toContain('sent 3 photos:');
  for (const id of [700, 701, 702]) expect(log).toContain(join(cfgDir, '.cache', 'tg-cli', 'inbound', `${id}.jpg`));
  expect(log.split('two screenshots of one bug').length - 1).toBe(1);
  expect(log).not.toContain('tg#13107');
  expect(log).not.toContain('tg#13108');
  expect(api.fetched.sort()).toEqual(['photo-13106', 'photo-13107', 'photo-13108']);
  expect(ledgerDelivered(cfgDir)).toEqual([13106, 13107, 13108, 13109]);
  expect(api.reactions).toEqual([13106, 13109]);
  await waitFor('the album journal cleared', () => !existsSync(join(cfgDir, 'tg-ctl.123.pending-albums.json')), cfgDir);
}, 30_000);

test('an album interrupted by a restart is delivered once, with the photos from both runs', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  api.batches.push([photoUpdate(710, 13200, 'before and after'), photoUpdate(711, 13201)]);
  // A hold window far longer than the test: daemon 1 can only stop with the album held.
  const daemon1 = await startDaemon(cfgDir, api, { TG_CTL_ALBUM_QUIET_MS: '60000' });
  await waitFor('the album held in its journal', () => existsSync(join(cfgDir, 'tg-ctl.123.pending-albums.json')), cfgDir);
  await stopDaemon(daemon1);
  expect(deliveries(cfgDir)).toBe(0);

  api.batches.push([photoUpdate(712, 13202)]);
  await startDaemon(cfgDir, api);
  await waitFor('the album delivery', () => deliveries(cfgDir) >= 1, cfgDir);
  api.batches.push([textUpdate(713, 13203, 'next')]);
  await waitFor('the next message', () => ledgerDelivered(cfgDir).includes(13203), cfgDir);

  const log = injectLog(cfgDir);
  expect(deliveries(cfgDir)).toBe(2);
  expect(log).toContain('sent 3 photos:');
  expect(log.indexOf('tg#13200')).toBeLessThan(log.indexOf('tg#13203'));
  expect(ledgerDelivered(cfgDir)).toEqual([13200, 13201, 13202, 13203]);
}, 40_000);

test('a kill after the album went out, before its journals were cleared, does not deliver it again', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  const parts = [photoUpdate(720, 13300, 'once'), photoUpdate(721, 13301)];
  api.batches.push(parts, [textUpdate(722, 13302, 'closes the album')]);
  const daemon1 = await startDaemon(cfgDir, api);
  await waitFor('the text after the album', () => injectLog(cfgDir).includes('tg#13302'), cfgDir);
  await stopDaemon(daemon1);
  expect(deliveries(cfgDir)).toBe(2);

  // What a SIGKILL right after the delivery leaves: the album still journaled, its batch
  // still pending, and no `processed` record — only the ledger knows it went out.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.pending-albums.json'),
    `${JSON.stringify([{ chat: 1, groupId: '13106000', lastPartAtMs: Date.now(), updates: parts }])}\n`,
  );
  writeFileSync(join(cfgDir, 'tg-ctl.123.pending-batch.json'), `${JSON.stringify(parts)}\n`);
  const ledgerPath = join(cfgDir, 'tg-ctl.123.delivery.jsonl');
  writeFileSync(
    ledgerPath,
    readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => !l.includes('"processed"'))
      .join('\n'),
  );
  api.batches.push([textUpdate(723, 13303, 'after the restart')]);
  await startDaemon(cfgDir, api);
  await waitFor('the message after the restart', () => injectLog(cfgDir).includes('tg#13303'), cfgDir);
  // The restored album is stepped before the text that closes it, so the text's delivery
  // proves the replay already ran.
  expect(injectLog(cfgDir).split('tg#13300').length - 1).toBe(1);
  expect(existsSync(inbound(cfgDir, 720))).toBe(true);
}, 40_000);
