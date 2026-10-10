import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { appendFileSync } from 'node:fs';
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tmuxNoServerShim } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// tg-cli regression (reply-to-agent routing, tg-cli#78 anchor): a non-reply
// inbound must bind to the pane of the CTO's OWN last resolved delivery — the
// #78 fix, wired via resolveLastUserTarget() into discoverForInject()'s
// "ambiguous" branch. But that branch only ever sees TMUX PaneInfo candidates
// (discoverTarget/pickTargetPaneFromSet, tg-cli#67/#78). The out-of-tmux omp
// support added afterward (tg-cli#306/#339/#342) reaches injectViaTarget's
// SEPARATE `found.reason === "no-agent"` branch, which picks purely by
// `listAgentCandidates().length` — 1 candidate injects, 2+ ALWAYS posts the
// picker — and never consults resolveLastUserTarget/the last-user-target.json
// anchor at all. So with two or more live omp agents running OUTSIDE tmux, a
// fresh non-reply message never auto-binds to "whoever I was just talking
// to" — it re-shows the picker every time, the #78/#69 regression pattern, on
// the newer no-tmux code path that never inherited the anchor fix.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SESSION_A = '01a07d8e-c12c-7433-903d-e98726bfda37';
const SESSION_B = '01b18e9f-d23d-8544-a14e-f98837cfeb48';
const OMP_PID_A = process.pid;
const OMP_PID_B = 7203;
const OMP_CWD_A = '/Users/u/work/review-cli';
const OMP_CWD_B = '/Users/u/work/task-cli';

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

function fakeOmpScript(log: string): string {
  return `#!/bin/sh\nprintf 'FORBIDDEN\\n' >> '${log}.spawned'\nexit 1\n`;
}

async function makeHarness() {
  const cfgDir = tempDir('tgctl-omp-anchor-');
  writeFileSync(join(cfgDir, '.env'), ['TG_BOT_TOKEN=123:abc', 'TG_CHAT_ID=1', ''].join('\n'));
  writeFileSync(join(cfgDir, 'config.yaml'), ['control:', '  enabled: true', ''].join('\n'));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([]));

  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);
  const tmuxLog = join(cfgDir, 'tmux.log');
  writeFileSync(tmuxLog, '');
  writeFileSync(
    join(binDir, 'tmux'),
    tmuxNoServerShim(`echo "$0 $*" >> ${JSON.stringify(tmuxLog).slice(1, -1)}\n`),
    { mode: 0o755 },
  );

  const sessionDir = join(cfgDir, 'sessions');
  mkdirSync(sessionDir);
  const sessionFileA = join(sessionDir, `2026-09-07T20-28-22-700Z_${SESSION_A}.jsonl`);
  writeFileSync(
    sessionFileA,
    [
      '{"type":"title","v":1,"title":"ReviewFix","source":"auto"}',
      `{"type":"session","version":3,"id":"${SESSION_A}","cwd":"${OMP_CWD_A}","title":"ReviewFix"}`,
      '',
    ].join('\n'),
  );
  const sessionFileB = join(sessionDir, `2026-09-07T20-30-05-100Z_${SESSION_B}.jsonl`);
  writeFileSync(
    sessionFileB,
    [
      '{"type":"title","v":1,"title":"TaskFix","source":"auto"}',
      `{"type":"session","version":3,"id":"${SESSION_B}","cwd":"${OMP_CWD_B}","title":"TaskFix"}`,
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(binDir, 'ps'),
    `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' ${OMP_PID_A} ttys004\\n'
    printf ' ${OMP_PID_B} ttys005\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' ${OMP_PID_A}     1 /opt/homebrew/bin/omp\\n'
    printf ' ${OMP_PID_B}     1 /opt/homebrew/bin/omp\\n'
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, 'lsof'),
    `#!/bin/sh
pid=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then pid="$arg"; fi
  prev="$arg"
done
if [ "$pid" = "${OMP_PID_A}" ]; then
  printf 'p${OMP_PID_A}\\n'
  printf 'fcwd\\n'
  printf 'n${OMP_CWD_A}\\n'
  printf 'n${sessionFileA}\\n'
elif [ "$pid" = "${OMP_PID_B}" ]; then
  printf 'p${OMP_PID_B}\\n'
  printf 'fcwd\\n'
  printf 'n${OMP_CWD_B}\\n'
  printf 'n${sessionFileB}\\n'
fi
exit 0
`,
    { mode: 0o755 },
  );

  const acpLog = join(cfgDir, 'acp.log');
  writeFileSync(acpLog, '');
  writeFileSync(join(binDir, 'omp'), fakeOmpScript(acpLog), { mode: 0o755 });

  const ep = await startLiveEndpoint({ root: join(cfgDir, 'omp-live'),
    snapshot: () => ({ sessionId: SESSION_A, sessionFile: sessionFileA, cwd: OMP_CWD_A, title: 'ReviewFix', busy: false }),
    send: (text: string) => appendFileSync(acpLog, JSON.stringify({ event: 'original-input', sessionId: SESSION_A, text }) + '\n'),
  }); servers.push({ stop: () => ep.close() });
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

test('REGRESSION (tg-cli#78 anchor, no-tmux path): a non-reply message after an explicit /agent pick auto-binds to that same live omp, never re-asks', async () => {
  const h = await makeHarness();
  const tg = startFakeTg();
  await startDaemon(h, tg.port);

  tg.pushText(200, 20, '/agent');
  await waitFor(() => tg.sends.some((s) => s.buttons.length > 0));
  const picker = tg.sends.find((s) => s.buttons.length > 0)!;
  expect(picker.buttons.length).toBe(2);
  const btnA = picker.buttons.find((b) => b.text.includes('ReviewFix'))!;
  expect(btnA).toBeDefined();
  const pickerId = 9000 + tg.sends.indexOf(picker) + 1;

  tg.pushCallback(201, btnA.callback_data, pickerId);
  await Bun.sleep(400);
  tg.pushText(202, 21, 'hello A, please review');
  await waitFor(() => acp(h).includes('hello A, please review'));
  expect(acp(h)).toContain(SESSION_A);

  const sendsBefore = tg.sends.length;
  tg.pushText(203, 22, 'now check the tests too');
  await waitFor(() => acp(h).includes('now check the tests too') || tg.sends.length > sendsBefore);

  const log = acp(h);
  const idx = log.indexOf('now check the tests too');
  const wentToA = idx >= 0 && (() => {
    const before = log.slice(0, idx);
    const lastLoadA = before.lastIndexOf(`"sessionId":"${SESSION_A}"`);
    const lastLoadB = before.lastIndexOf(`"sessionId":"${SESSION_B}"`);
    return lastLoadA > lastLoadB;
  })();
  const rePicked = tg.sends.length > sendsBefore && tg.sends[tg.sends.length - 1].buttons.length > 0;

  expect(rePicked).toBe(false);
  expect(wentToA).toBe(true);
  expect(existsSync(h.acpLog + ".spawned")).toBe(false);
}, 20_000);
