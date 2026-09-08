import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// tg-cli#339: every inbound route into an omp with NO tmux pane must ACP
// session/load the live process-table session, then session/prompt. Never
// tmux send-keys, never an ephemeral session/new --no-session sibling.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SESSION_ID = '01a07d8e-c12c-7433-903d-e98726bfda37';
const OMP_PID = 7103;
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

function fakeOmpScript(acpLog: string): string {
  return `#!/usr/bin/env bun
const fs = require("fs");
const logPath = ${JSON.stringify(acpLog)};
if (!process.argv.includes("acp")) process.exit(0);
function encode(msg) {
  return JSON.stringify(msg) + "\\n";
}
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  while (true) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) break;
    const json = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!json.startsWith("{")) continue;
    let msg;
    try { msg = JSON.parse(json); } catch { continue; }
    fs.appendFileSync(logPath, json + "\\n");
    if (msg.method === "initialize") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "oh-my-pi" } } }));
    } else if (msg.method === "session/load") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
    } else if (msg.method === "session/new") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "01sibling-new-session" } }));
    } else if (msg.method === "session/prompt") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
}

function makeHarness(opts: { routes?: unknown[] } = {}) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-omp-reply-'));
  writeFileSync(join(cfgDir, '.env'), ['TG_BOT_TOKEN=123:abc', 'TG_CHAT_ID=1', ''].join('\n'));
  writeFileSync(join(cfgDir, 'config.yaml'), ['control:', '  enabled: true', ''].join('\n'));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify(opts.routes ?? []));

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

function assertLiveAcp(h: { acpLog: string; tmuxLog: string }, needle: string) {
  const log = acp(h);
  expect(log).toContain('"method":"initialize"');
  expect(log).toContain('"method":"session/load"');
  expect(log).toContain(SESSION_ID);
  expect(log).toContain('"method":"session/prompt"');
  expect(log).toContain(needle);
  expect(log).not.toContain('"method":"session/new"');
  expect(log).not.toContain('--no-session');
  expect(log).not.toContain('send-keys');
  const tmux = readFileSync(h.tmuxLog, 'utf8');
  expect(tmux).not.toContain('send-keys');
}

test('reply-to-bot-message injects via ACP session/load into the live out-of-tmux omp', async () => {
  const h = makeHarness({
    routes: [{ id: 50, paneId: `omp:${OMP_PID}`, cwd: OMP_CWD, ts: 1 }],
  });
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushReply(100, 11, 50, 'fix the inject path');
  await waitFor(() => acp(h).includes('session/prompt'));
  assertLiveAcp(h, 'fix the inject path');
  expect(acp(h)).toContain('[TG from Alex');
}, 20_000);

test('/agent pick then text injects via ACP into the chosen live out-of-tmux omp', async () => {
  const h = makeHarness();
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
  assertLiveAcp(h, 'hello from pick');
}, 20_000);

test('plain inbound with no tmux pane reaches the sole live omp via ACP session/load', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushText(300, 30, 'plain inbound no pane');
  await waitFor(() => acp(h).includes('session/prompt'));
  assertLiveAcp(h, 'plain inbound no pane');
}, 20_000);
