// Exactly-once inbound delivery across every replay path (tg-cli#299).
//
// The CTO saw one Telegram message typed into one omp session 7 times (tg#17641,
// 2026-09-21: the since-removed ACP watchdog re-sent its in-flight prompt on every
// eviction). The replay paths that remain — Telegram redelivering an update, the
// pending-batch journal replayed after a crash, a deferred backlog restored after
// a kill mid-flush, an omp restarting between two deliveries — must each reach the
// agent at most once, and a message the daemon cannot deliver must be reported to
// the CTO, never dropped silently.

import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { serializeDeferredStore } from '../features/tg-ctl/deferred-store';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
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

// A claude pane %1; `list-panes` reports no pane while `<cfgDir>/pane-gone` exists.
function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-exactly-once-');
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
  list-panes)
    [ -e '${cfgDir}/pane-gone' ] && exit 0
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cfgDir}'
    ;;
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

function injected(cfgDir: string): string[] {
  const p = join(cfgDir, 'inject.log');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0) : [];
}

function textUpdate(updateId: number, messageId: number, text: string) {
  return { update_id: updateId, message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text } };
}

type Api = { port: number; batches: unknown[][]; sent: Array<Record<string, unknown>>; buttons: string[] };

function startApi(): Api {
  const api: Api = { port: 0, batches: [], sent: [], buttons: [] };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = api.batches.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        // An empty long-poll: answer after a beat so the daemon does not spin.
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        api.sent.push(body);
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard;
        if (kb?.length) api.buttons.push(kb[0][0].callback_data);
        return Response.json({ ok: true, result: { message_id: 800 + api.sent.length } });
      }
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
// and API calls it makes, so tests poll that state (no fake clock reaches it).
async function waitFor(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const sentText = (api: Api): string[] => api.sent.map((m) => String(m.text));

test('an update Telegram delivers twice is typed into the pane once', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  const first = textUpdate(500, 900101, 'first instruction');
  api.batches.push([first], [first], [textUpdate(501, 900102, 'second instruction')]);
  await startDaemon(cfgDir, api);
  await waitFor('the second instruction', () => injected(cfgDir).some((l) => l.includes('tg#900102')));
  expect(injected(cfgDir).filter((l) => l.includes('tg#900101'))).toHaveLength(1);
}, 20_000);

test('a restart that replays the journal after the message went out does not type it again', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  const first = textUpdate(510, 900111, 'do the thing');
  api.batches.push([first]);
  const daemon1 = await startDaemon(cfgDir, api);
  await waitFor('the first delivery', () => injected(cfgDir).length === 1);
  await stopDaemon(daemon1);
  // The kill landed after the delivery, before the batch journal was cleared.
  writeFileSync(join(cfgDir, 'tg-ctl.123.pending-batch.json'), `${JSON.stringify([first])}\n`);
  api.batches.push([textUpdate(511, 900112, 'next')]);
  await startDaemon(cfgDir, api);
  await waitFor('the next message', () => injected(cfgDir).some((l) => l.includes('tg#900112')));
  expect(injected(cfgDir).filter((l) => l.includes('tg#900111'))).toHaveLength(1);
}, 25_000);

// The ledger must never swallow a legitimate message: the CTO resending the same text is a
// new message id, and another daemon (its own config dir) seeing the same ids is unrelated.
test('a resent text (new message id) is typed again, and another config dir keeps its own ledger', async () => {
  const cfgA = makeCfgDir();
  const cfgB = makeCfgDir();
  const apiA = startApi();
  const apiB = startApi();
  apiA.batches.push([textUpdate(520, 900131, 'deploy now')], [textUpdate(521, 900132, 'deploy now')]);
  apiB.batches.push([textUpdate(520, 900131, 'deploy now')]);
  await startDaemon(cfgA, apiA);
  await startDaemon(cfgB, apiB);
  await waitFor('the resend in A', () => injected(cfgA).some((l) => l.includes('tg#900132')));
  await waitFor('the same message id in B', () => injected(cfgB).some((l) => l.includes('tg#900131')));
  expect(injected(cfgA).filter((l) => l.includes('deploy now'))).toHaveLength(2);
  expect(injected(cfgB).filter((l) => l.includes('deploy now'))).toHaveLength(1);
  expect(readFileSync(join(cfgA, 'daemon.log'), 'utf8')).not.toContain('suppressed');
}, 25_000);

test('a delivery interrupted by a kill is reported to the CTO, never typed a second time', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  const first = textUpdate(520, 900121, 'maybe typed');
  // The previous daemon claimed the message and died before recording the outcome.
  writeFileSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'), `${JSON.stringify({ ts: Date.now(), event: 'claimed', chat: 1, msg: 900121, target: PANE_ID })}\n`);
  writeFileSync(join(cfgDir, 'tg-ctl.123.pending-batch.json'), `${JSON.stringify([first])}\n`);
  api.batches.push([textUpdate(521, 900122, 'next')]);
  await startDaemon(cfgDir, api);
  await waitFor('the next message', () => injected(cfgDir).some((l) => l.includes('tg#900122')));
  expect(injected(cfgDir).filter((l) => l.includes('tg#900121'))).toHaveLength(0);
  expect(sentText(api).some((t) => t.includes('tg#900121') && /may not have/.test(t))).toBe(true);
}, 20_000);

// Without a claim on disk a kill right after the send would let a replay type the message again.
test('a message whose ledger claim cannot be written is not typed, and the CTO is told', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  // A directory where the ledger file belongs: every append fails.
  mkdirSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'));
  api.batches.push([textUpdate(525, 900125, 'unrecorded')]);
  await startDaemon(cfgDir, api);
  await waitFor('the failure reply', () => sentText(api).some((t) => /ledger could not be written/.test(t)));
  expect(injected(cfgDir)).toEqual([]);
}, 20_000);

// Message ids are unique per chat only: another chat's 900126 must not reach the agent, nor be
// ledgered so that it could suppress this chat's own 900126.
test('a message from another chat is ignored and does not shadow the same id in this chat', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  allowed_senders: 7\n');
  const foreign = { update_id: 526, message: { message_id: 900126, from: { id: 7, first_name: 'Bob' }, chat: { id: 7 }, date: Math.floor(Date.now() / 1000), text: 'from elsewhere' } };
  api.batches.push([foreign], [textUpdate(527, 900126, 'from here')]);
  await startDaemon(cfgDir, api);
  await waitFor('this chat message', () => injected(cfgDir).some((l) => l.includes('from here')));
  expect(injected(cfgDir).filter((l) => l.includes('from elsewhere'))).toHaveLength(0);
}, 20_000);

test('a message waiting on the agent picker when the daemon restarted is reported to the CTO', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.delivery.jsonl'),
    `${JSON.stringify({ ts: Date.now(), event: 'queued', chat: 1, msg: 900131, target: 'picker', hold: 'picker' })}\n`,
  );
  await startDaemon(cfgDir, api);
  await waitFor('the notice', () => sentText(api).some((t) => t.includes('tg#900131')));
  expect(sentText(api).find((t) => t.includes('tg#900131'))).toMatch(/not delivered/);
}, 20_000);

function startAsk(cfgDir: string, api: Api): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${api.port}`, TMUX_PANE: PANE_ID },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  trackProc(reg, ask);
  ask.stdin.write(`${JSON.stringify({ cwd: cfgDir, paneId: PANE_ID, requestId: 'q_block', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] })}\n`);
  ask.stdin.end();
  return ask;
}

function tap(api: Api, updateId: number): void {
  api.batches.push([
    {
      update_id: updateId,
      callback_query: { id: `cb${updateId}`, from: { id: 1, first_name: 'Alex' }, message: { message_id: 801, chat: { id: 1 }, date: 1 }, data: api.buttons[0] },
    },
  ]);
}

function seedDeferred(cfgDir: string, ids: number[]): void {
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.deferred.json'),
    serializeDeferredStore({
      panes: [{ paneId: PANE_ID, items: ids.map((id) => ({ text: `[TG from Alex tg#${id}] queued ${id}`, sourceMessageId: id, relatedReactionMessageId: null })) }],
    }),
  );
}

test('a deferred backlog restored after a kill mid-flush types only what never went out', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  seedDeferred(cfgDir, [900141, 900142]);
  // 900141 was typed by the killed daemon's flush before it could persist the drained queue.
  writeFileSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'), `${JSON.stringify({ ts: Date.now(), event: 'delivered', chat: 1, msg: 900141, target: PANE_ID })}\n`);
  await startDaemon(cfgDir, api);
  const ask = startAsk(cfgDir, api);
  await waitFor('the question card', () => api.buttons.length > 0);
  tap(api, 530);
  await ask.exited;
  await waitFor('the flush', () => injected(cfgDir).some((l) => l.includes('tg#900142')));
  expect(injected(cfgDir).filter((l) => l.includes('tg#900141'))).toHaveLength(0);
}, 25_000);

test('a deferred message the flush cannot type is reported to the CTO', async () => {
  const cfgDir = makeCfgDir();
  const api = startApi();
  seedDeferred(cfgDir, [900151]);
  await startDaemon(cfgDir, api);
  const ask = startAsk(cfgDir, api);
  await waitFor('the question card', () => api.buttons.length > 0);
  writeFileSync(join(cfgDir, 'pane-gone'), '');
  tap(api, 540);
  await ask.exited;
  await waitFor('the failure notice', () => sentText(api).some((t) => t.includes('tg#900151')));
  expect(sentText(api).find((t) => t.includes('tg#900151'))).toMatch(/not delivered/);
  expect(injected(cfgDir)).toEqual([]);
}, 25_000);

test('an omp restarted between two deliveries of one message receives it once', async () => {
  const cfgDir = tempDir('tgctl-exactly-once-omp-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  const sessionId = '01a0ffff-0000-7000-8000-000000000299';
  const sessionFile = join(cfgDir, `2026-09-30T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: '/w/exactly-once', title: 'ExactlyOnce' })}\n`);
  writeFileSync(
    join(bin, 'ps'),
    `#!/bin/sh\ncase "$*" in\n  *tty*) printf '    1 ??\\n ${process.pid} ttys004\\n' ;;\n  *) printf '    1     0 /sbin/launchd\\n ${process.pid}     1 /opt/homebrew/bin/omp\\n' ;;\nesac\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p${process.pid}\\nfcwd\\nn/w/exactly-once\\nn${sessionFile}\\n'\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'omp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const received = join(cfgDir, 'received.log');
  const endpoint = () =>
    startLiveEndpoint({
      root: join(cfgDir, 'omp-live'),
      snapshot: () => ({ sessionId, sessionFile, cwd: '/w/exactly-once', title: 'ExactlyOnce', busy: false }),
      send: (text: string) => appendFileSync(received, `${text.replace(/\n/g, ' ')}\n`),
    });
  const lines = (): string[] => (existsSync(received) ? readFileSync(received, 'utf8').split('\n').filter(Boolean) : []);

  const api = startApi();
  const first = textUpdate(550, 900161, '/agent ExactlyOnce ship it');
  api.batches.push([first]);
  const omp1 = await endpoint();
  const env = { TMUX: '' };
  const daemon1 = await startDaemon(cfgDir, api, env);
  await waitFor('the first delivery', () => lines().length === 1);
  await stopDaemon(daemon1);
  await omp1.close();

  // The omp restarted (a new endpoint instance remembers no receipts) and the daemon replays its journal.
  const omp2 = await endpoint();
  cleanups.push(() => omp2.close());
  writeFileSync(join(cfgDir, 'tg-ctl.123.pending-batch.json'), `${JSON.stringify([first])}\n`);
  api.batches.push([textUpdate(551, 900162, '/agent ExactlyOnce and this')]);
  await startDaemon(cfgDir, api, env);
  await waitFor('the next message', () => lines().some((l) => l.includes('tg#900162')));
  expect(lines().filter((l) => l.includes('tg#900161'))).toHaveLength(1);
}, 30_000);
