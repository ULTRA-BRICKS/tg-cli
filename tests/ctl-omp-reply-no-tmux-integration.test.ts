import { appendFileSync } from 'node:fs';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { serializeRegistry } from '../features/tg-ctl/session-registry-store';
import type { SessionEntry } from '../features/tg-ctl/session-registry';
import { tempDir } from './helpers/test-temp';

// #339 / #450: preserve every no-tmux route, but deliver to the original process.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SESSION_ID = '01a07d8e-c12c-7433-903d-e98726bfda37';
const OMP_PID = process.pid;
const OMP_CWD = '/Users/u/work/review-cli';

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

interface SentMessage {
  text: string;
  hasMarkup: boolean;
  buttons: Array<{ text: string; callback_data: string }>;
}

interface FakeTg {
  port: number;
  sends: SentMessage[];
  pushText: (updateId: number, messageId: number, text: string) => void;
  pushReply: (updateId: number, messageId: number, replyToId: number, text: string) => void;
  pushCallback: (updateId: number, data: string, onMessageId: number) => void;
  stop: () => void;
}

function startFakeTg(): FakeTg {
  const queue: unknown[][] = [];
  const sends: SentMessage[] = [];
  let delivered = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (delivered < queue.length) {
          const batch = queue[delivered];
          delivered += 1;
          return Response.json({ ok: true, result: batch });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as {
          text: string;
          reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
        };
        const rows = body.reply_markup?.inline_keyboard ?? [];
        sends.push({ text: body.text, hasMarkup: body.reply_markup !== undefined, buttons: rows.flat() });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  return {
    port: server.port,
    sends,
    pushText: (updateId, messageId, text) => {
      queue.push([{ update_id: updateId, message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec(), text } }]);
    },
    pushReply: (updateId, messageId, replyToId, text) => {
      queue.push([
        {
          update_id: updateId,
          message: {
            message_id: messageId,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: nowSec(),
            text,
            reply_to_message: { message_id: replyToId, date: nowSec(), chat: { id: 1 }, text: 'orig report' },
          },
        },
      ]);
    },
    pushCallback: (updateId, data, onMessageId) => {
      queue.push([
        {
          update_id: updateId,
          callback_query: {
            id: `cb${updateId}`,
            from: { id: 1, first_name: 'Alex' },
            message: { message_id: onMessageId, chat: { id: 1 }, date: nowSec() },
            data,
          },
        },
      ]);
    },
    stop: () => server.stop(true),
  };
}

async function waitFor(pred: () => boolean, ms = 12_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await Bun.sleep(80);
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

function fakeOmpScript(spawnLog: string): string {
  return `#!/bin/sh\nprintf 'FORBIDDEN ACP CLONE\\n' >> '${spawnLog}.spawned'\nexit 1\n`;
}

async function makeHarness(opts: { routes?: unknown[]; sessions?: SessionEntry[] } = {}) {
  const cfgDir = tempDir('tgctl-omp-reply-');
  writeFileSync(join(cfgDir, '.env'), ['TG_BOT_TOKEN=123:abc', 'TG_CHAT_ID=1', ''].join('\n'));
  writeFileSync(join(cfgDir, 'config.yaml'), ['control:', '  enabled: true', ''].join('\n'));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify(opts.routes ?? []));
  if (opts.sessions) {
    const at = '2026-01-01T00:00:00.000Z';
    const migrated = { routes: at, registration: at, lastUserTarget: at, topics: at };
    writeFileSync(join(cfgDir, 'tg-ctl.123.sessions.json'), serializeRegistry({ schemaVersion: 2, migrated, sessions: opts.sessions }));
  }

  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);
  const tmuxLog = join(cfgDir, 'tmux.log');
  writeFileSync(tmuxLog, '');
  writeFileSync(
    join(binDir, 'tmux'),
    `#!/bin/sh
echo "$0 $*" >> ${JSON.stringify(tmuxLog).slice(1, -1)}
exit 0
`,
    { mode: 0o755 },
  );

  const sessionDir = join(cfgDir, 'sessions');
  mkdirSync(sessionDir);
  const sessionFile = join(sessionDir, `2026-09-07T20-28-22-700Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      '{"type":"title","v":1,"title":"ReviewFix","source":"auto"}',
      `{"type":"session","version":3,"id":"${SESSION_ID}","cwd":"${OMP_CWD}","title":"ReviewFix"}`,
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(binDir, 'ps'),
    `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' ${OMP_PID} ttys004\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' ${OMP_PID}     1 /opt/homebrew/bin/omp\\n'
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, 'lsof'),
    `#!/bin/sh
printf 'p${OMP_PID}\\n'
printf 'fcwd\\n'
printf 'n${OMP_CWD}\\n'
printf 'n${sessionFile}\\n'
exit 0
`,
    { mode: 0o755 },
  );

  const acpLog = join(cfgDir, 'acp.log');
  writeFileSync(acpLog, '');
  writeFileSync(join(binDir, 'omp'), fakeOmpScript(acpLog), { mode: 0o755 });

  const endpoint = await startLiveEndpoint({ root: join(cfgDir, 'omp-live'),
    snapshot: () => ({ sessionId: SESSION_ID, cwd: OMP_CWD, sessionFile, title: 'ReviewFix', busy: false }),
    send: (text: string) => { appendFileSync(acpLog, JSON.stringify({ event: 'original-input', pid: process.pid, sessionId: SESSION_ID, text }) + '\n'); },
  });
  servers.push({ stop: () => endpoint.close() });
  return { cfgDir, binDir, tmuxLog, acpLog };
}

async function startDaemon(h: { cfgDir: string; binDir: string }, apiPort: number) {
  const logFd = openSync(join(h.cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: h.cfgDir,
    env: {
      PATH: `${h.binDir}:${process.env.PATH ?? ''}`,
      HOME: h.cfgDir,
      TG_CTL_CONFIG_DIR: h.cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      TMUX: '',
    },
    logFd,
  });
  closeSync(logFd);
}

function acp(h: { acpLog: string }): string {
  return existsSync(h.acpLog) ? readFileSync(h.acpLog, 'utf8') : '';
}

function assertOriginal(h: { acpLog: string; tmuxLog: string }, needle: string) {
  const log = acp(h);
  expect(log).toContain('"event":"original-input"');
  expect(existsSync(h.acpLog + '.spawned')).toBe(false);
  expect(log).toContain(SESSION_ID);
  expect(log).toContain('"event":"original-input"');
  expect(log).toContain(needle);
  expect(log).not.toContain('"method":"session/new"');
  expect(log).not.toContain('--no-session');
  expect(log).not.toContain('send-keys');
  const tmux = readFileSync(h.tmuxLog, 'utf8');
  expect(tmux).not.toContain('send-keys');
}

test('reply-to-bot-message injects via the original-process bridge into the live out-of-tmux omp', async () => {
  const h = await makeHarness({
    routes: [{ id: 50, paneId: `omp:${OMP_PID}`, cwd: OMP_CWD, ts: 1 }],
  });
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushReply(100, 11, 50, 'fix the inject path');
  await waitFor(() => acp(h).includes('original-input'));
  assertOriginal(h, 'fix the inject path');
  expect(acp(h)).toContain('[TG from Alex');
}, 20_000);

test('/agent pick then text injects into the chosen live out-of-tmux omp', async () => {
  const h = await makeHarness();
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushText(200, 20, '/agent');
  await waitFor(() => tg.sends.some((s) => s.buttons.length > 0));
  const picker = tg.sends.find((s) => s.buttons.length > 0)!;
  expect(picker.buttons.some((b) => b.text.includes('ReviewFix'))).toBe(true);
  const btn = picker.buttons.find((b) => b.callback_data.startsWith('tga:'))!;
  const pickerId = 9000 + tg.sends.indexOf(picker) + 1;
  tg.pushCallback(201, btn.callback_data, pickerId);
  await Bun.sleep(400);
  tg.pushText(202, 21, 'hello from pick');
  await waitFor(() => acp(h).includes('hello from pick'));
  assertOriginal(h, 'hello from pick');
}, 20_000);

test('plain inbound with no tmux pane reaches the sole live omp via the original-process bridge', async () => {
  const h = await makeHarness();
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushText(300, 30, 'plain inbound no pane');
  await waitFor(() => acp(h).includes('original-input'));
  assertOriginal(h, 'plain inbound no pane');
}, 20_000);

// #503: a disposable nested omp (`omp --print` started by this live
// orchestrator) sent a report from /tmp and exited. `tg` recorded the
// orchestrator as the route's lineage parent from the process tree; the reply
// reaches it, and the chat says where it went.
const DEAD_CHILD = 942424;

test('reply to an exited nested omp reaches its recorded lineage parent, with a visible reroute notice', async () => {
  const h = await makeHarness({
    routes: [{ id: 60, paneId: `omp:${DEAD_CHILD}`, cwd: '/tmp', parentPaneId: `omp:${OMP_PID}`, ts: 1 }],
  });
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushReply(400, 40, 60, 'answer for the dead child');
  await waitFor(() => acp(h).includes('answer for the dead child'));
  assertOriginal(h, 'answer for the dead child');
  await waitFor(() => tg.sends.some((s) => /is gone/.test(s.text) && /routed to/.test(s.text)));
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
}, 20_000);

test('reply to a registered nested omp that has since gone reaches its recorded lineage parent, not the picker', async () => {
  const childKey = 'omp:child-session';
  const at = new Date().toISOString();
  const child: SessionEntry = {
    key: childKey,
    harness: 'omp',
    sessionId: 'child-session',
    sessionFile: null,
    locators: { pid: DEAD_CHILD, tmux: null, durableSession: null },
    cwd: '/tmp',
    name: { primary: 'child', secondary: null },
    aliases: [],
    threadId: null,
    topicMisses: null,
    state: 'gone',
    firstSeen: at,
    lastSeen: at,
  };
  const h = await makeHarness({
    routes: [{ id: 61, paneId: `omp:${DEAD_CHILD}`, cwd: '/tmp', parentPaneId: `omp:${OMP_PID}`, sessionKey: childKey, ts: 1 }],
    sessions: [child],
  });
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushReply(401, 41, 61, 'answer for the gone child');
  await waitFor(() => acp(h).includes('answer for the gone child'));
  assertOriginal(h, 'answer for the gone child');
  // The registry knows the child's name, so the notice says which agent left.
  await waitFor(() => tg.sends.some((s) => /^↩️ child is gone — routed to /.test(s.text)));
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
}, 20_000);
