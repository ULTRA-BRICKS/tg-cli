import { appendFileSync } from 'node:fs';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { NO_AGENT_REPLY } from '../tg-ctl';

// tg-cli#454 — the live shape of a rig `omp run` session (2026-09-29, panes %0–%4):
// the tmux pane's shell runs the abduco CLIENT (`abduco -f -A omp-restored-<id> omp
// --resume …`); the abduco SERVER re-parented to pid 1 and omp is ITS child, so omp is
// never a descendant of pane_pid. Discovery used to stop at abduco: the pane had "no
// agent", a reply to that omp's message got a false "That agent … is no longer running"
// picker, and `/agent <window>` found nothing. The daemon runs its REAL tmux/ps/lsof
// discovery against PATH shims of that exact process table; delivery goes through a
// real original-process endpoint owned by this test process (pid = the fake omp pid).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SESSION_ID = '01a0c543-1ac1-7433-903d-e98726bfda37';
const OMP_PID = process.pid;
const PANE_CWD = '/Users/u/xp/sme-archiving-gc';
const WINDOW = 'gc-sme-backlog';
const TITLE = 'Recover orphaned commits';

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

interface SentMessage {
  text: string;
  buttons: Array<{ text: string; callback_data: string }>;
}

function startFakeTg() {
  const queue: unknown[][] = [];
  const sends: SentMessage[] = [];
  let delivered = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (delivered < queue.length) return Response.json({ ok: true, result: queue[delivered++] });
        await Bun.sleep(80); // an empty long-poll answer, paced so the real daemon process does not spin
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as {
          text: string;
          reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
        };
        sends.push({ text: body.text, buttons: (body.reply_markup?.inline_keyboard ?? []).flat() });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  const message = (messageId: number, text: string, replyToId?: number) => ({
    message_id: messageId,
    from: { id: 1, first_name: 'Alex' },
    chat: { id: 1 },
    date: nowSec(),
    text,
    ...(replyToId ? { reply_to_message: { message_id: replyToId, date: nowSec(), chat: { id: 1 }, text: 'report' } } : {}),
  });
  return {
    port: server.port,
    sends,
    pushText: (updateId: number, messageId: number, text: string) => queue.push([{ update_id: updateId, message: message(messageId, text) }]),
    pushReply: (updateId: number, messageId: number, replyToId: number, text: string) =>
      queue.push([{ update_id: updateId, message: message(messageId, text, replyToId) }]),
  };
}

// Polls a side effect of a SEPARATE daemon process (its Bot API calls / the endpoint's
// input log); no in-process signal exists to await, so fake timers cannot drive it.
async function waitFor(pred: () => boolean, ms = 12_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await Bun.sleep(80);
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

async function makeHarness(routes: unknown[] = []) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-omp-abduco-'));
  writeFileSync(join(cfgDir, '.env'), ['TG_BOT_TOKEN=123:abc', 'TG_CHAT_ID=1', ''].join('\n'));
  writeFileSync(join(cfgDir, 'config.yaml'), ['control:', '  enabled: true', ''].join('\n'));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify(routes));
  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);

  // tmux: one pane %0 whose process is the abduco CLIENT's shell; pane titles on request.
  const tmuxLog = join(cfgDir, 'tmux.log');
  writeFileSync(tmuxLog, '');
  writeFileSync(
    join(binDir, 'tmux'),
    `#!/bin/sh
echo "$*" >> '${tmuxLog}'
case "$*" in
  *pane_title*) printf '%%0\\tπ > ${TITLE}\\n' ;;
  *display-message*) printf '4242\\n' ;;
  *list-panes*) printf 'main\\t1\\t%%0\\t2929\\tabduco\\t${WINDOW}\\t\\t${PANE_CWD}\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const rigOmp =
    'bun --preload /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/xp/oh-my-pi/packages/coding-agent/scripts/../src/cli.ts --resume /s.jsonl';
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
    printf ' 2929     1 /bin/zsh -l\\n'
    printf '57614  2929 abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl\\n'
    printf '57615     1 abduco -f -A omp-restored-01a0c5431ac1 omp --resume /s.jsonl\\n'
    printf ' ${OMP_PID} 57615 ${rigOmp}\\n'
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const sessionDir = join(cfgDir, 'sessions');
  mkdirSync(sessionDir);
  const sessionFile = join(sessionDir, `2026-09-12T10-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    sessionFile,
    `{"type":"session","version":3,"id":"${SESSION_ID}","cwd":"${PANE_CWD}","title":"${TITLE}"}\n`,
  );
  writeFileSync(
    join(binDir, 'lsof'),
    `#!/bin/sh
printf 'p${OMP_PID}\\nfcwd\\nn${PANE_CWD}\\nn${sessionFile}\\n'
exit 0
`,
    { mode: 0o755 },
  );
  const inputLog = join(cfgDir, 'original-input.log');
  writeFileSync(inputLog, '');
  const endpoint = await startLiveEndpoint({
    root: join(cfgDir, 'omp-live'),
    snapshot: () => ({ sessionId: SESSION_ID, cwd: PANE_CWD, sessionFile, title: TITLE, busy: false }),
    send: (text: string) => {
      appendFileSync(inputLog, `${JSON.stringify({ text })}\n`);
    },
  });
  servers.push({ stop: () => endpoint.close() });
  return { cfgDir, binDir, tmuxLog, inputLog };
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

const inputs = (h: { inputLog: string }): string => (existsSync(h.inputLog) ? readFileSync(h.inputLog, 'utf8') : '');

function expectNoFalseGone(sends: SentMessage[]): void {
  expect(sends.some((s) => /no longer running|is gone/.test(s.text))).toBe(false);
  expect(sends.some((s) => s.text === NO_AGENT_REPLY || s.text.includes('Claude Code not in tmux'))).toBe(false);
}

test('a reply to an abduco-wrapped omp message routes to that omp — no false "no longer running" picker', async () => {
  const h = await makeHarness([{ id: 50, paneId: '%0', cwd: PANE_CWD, ts: 1 }]);
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushReply(100, 11, 50, 'continue with the PR audit');
  await waitFor(() => inputs(h).includes('continue with the PR audit'));
  expectNoFalseGone(tg.sends);
  expect(tg.sends.some((s) => s.buttons.length > 0)).toBe(false);
  expect(readFileSync(h.tmuxLog, 'utf8')).not.toContain('send-keys');
}, 20_000);

test('/agent <tmux window name> selects the abduco-wrapped omp', async () => {
  const h = await makeHarness();
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushText(200, 20, `/agent ${WINDOW} ship the audit`);
  await waitFor(() => inputs(h).includes('ship the audit'));
  expectNoFalseGone(tg.sends);
}, 20_000);

test('the /agent picker names the abduco pane by its tmux window, omp title as the secondary name', async () => {
  const h = await makeHarness();
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  tg.pushText(300, 30, '/agent');
  await waitFor(() => tg.sends.some((s) => s.buttons.length > 0));
  const picker = tg.sends.find((s) => s.buttons.length > 0)!;
  expect(picker.buttons.map((b) => b.text)).toContain(`${WINDOW} · ${TITLE}`);
}, 20_000);

test('sessions.json lists the abduco omp once, with its tmux locator AND durable session, and its route migrates (#487)', async () => {
  const h = await makeHarness([{ id: 50, paneId: '%0', cwd: PANE_CWD, ts: 1 }]);
  const tg = startFakeTg();
  await startDaemon(h, tg.port);
  const sessionsPath = join(h.cfgDir, 'tg-ctl.123.sessions.json');
  const registry = (): { migrated: Record<string, string>; sessions: unknown[] } => JSON.parse(readFileSync(sessionsPath, 'utf8'));
  await waitFor(() => existsSync(sessionsPath) && registry().migrated.routes !== undefined);
  expect(registry().sessions).toEqual([
    expect.objectContaining({
      key: `omp:${SESSION_ID}`,
      state: 'live',
      locators: { pid: OMP_PID, tmux: { serverPid: 4242, paneId: '%0', panePid: 2929 }, durableSession: 'omp-restored-01a0c5431ac1' },
    }),
  ]);
  expect(JSON.parse(readFileSync(join(h.cfgDir, 'tg-ctl.123.routes.json'), 'utf8'))).toEqual([
    { id: 50, paneId: '%0', cwd: PANE_CWD, ts: 1, sessionKey: `omp:${SESSION_ID}` },
  ]);
}, 20_000);
