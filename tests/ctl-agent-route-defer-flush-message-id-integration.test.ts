import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

// Regression for tg-cli#274 (agent-route message-id wrap fix), covering the
// highest-risk path the fix touches: a `/agent <selector> <text>` message that
// arrives while the target pane has an OPEN question gets DEFERRED (queued
// verbatim, already wrapped) and later FLUSHED into the pane once the question
// is answered. `injectToPane` now wraps with the id BEFORE calling
// `enqueueDeferred`, and the flush path (`injectDeferredOne`) injects the
// stored text unmodified — it must NOT re-wrap it. This test proves the
// flushed text carries `tg#<id>` exactly ONCE, ruling out a double-tag
// regression (`[TG from Alex tg#<id> tg#<id>] …`).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

const PANE_ID = '%1';
const PANE_PID = 4242;

function fakeTmux(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message)
    printf 'main\\n'
    ;;
  send-keys)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then printf '%s\\n' "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer)
    cat >> '${injectLog}'
    printf '\\n' >> '${injectLog}'
    ;;
  capture-pane)
    # With an 'enter-lost' marker every Enter is dropped: the last injected text
    # stays in a Claude Code input box (#463).
    [ -f '${cwd}/enter-lost' ] || exit 0
    printf 'transcript\\n\\n────────────────────\\n❯ %s\\n────────────────────\\n  footer\\n' "$(tail -n 1 '${injectLog}')"
    ;;
esac
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-agent-route-defer-'));
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: PANE_ID, cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return cfgDir;
}

function injected(cfgDir: string): string[] {
  const p = join(cfgDir, 'inject.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0);
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    TMUX_PANE: PANE_ID,
  };
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  ask.stdin.write(JSON.stringify({ cwd: cfgDir, paneId: PANE_ID, ...request }) + '\n');
  ask.stdin.end();
  return ask;
}

// Opens a question on the pane, defers `/agent main deploy now` (tg#4321) behind it,
// answers the question and waits for the flush to type it.
async function deferAndFlush(cfgDir: string): Promise<{ landed: string[]; sent: string[] }> {

  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  let buttonMessageId = 0;
  let questionCallbackData = '';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        sent.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery') || url.pathname.endsWith('/editMessageText')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // 1) Open a question on pane %1 — blocks the pane so the next inbound defers.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_block',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // 2) A confident `/agent main <text>` route arrives while the question is
  //    open → deferred (✍️), not pasted into the open prompt.
  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 10,
      message: {
        message_id: 4321,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        text: '/agent main deploy now',
      },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // nothing pasted into the open prompt yet
  expect(reactions.at(-1)).toMatchObject({ message_id: 4321, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // 3) Answer the question → unblocks the pane → the deferred /agent message flushes.
  updateQueue.push([
    {
      update_id: 11,
      callback_query: {
        id: 'cb1',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: buttonMessageId, chat: { id: 1 }, date: nowSec },
        data: questionCallbackData,
      },
    },
  ]);
  const askOut = await new Response(ask.stdout).text();
  await ask.exited;
  expect(askOut.length).toBeGreaterThan(0);

  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 1) await Bun.sleep(100);
  }
  // The submit check and any report follow the typed text.
  await Bun.sleep(1500);
  daemon.kill('SIGTERM');
  await daemon.exited;
  return { landed: injected(cfgDir), sent };
}

test('/agent <selector> <text> deferred behind an open question flushes with tg#<id> exactly once (no double-tag)', async () => {
  const { landed } = await deferAndFlush(makeCfgDir());
  expect(landed).toHaveLength(1);
  // Exactly one `tg#4321` — a re-wrap-at-flush regression would double it to
  // `tg#4321 tg#4321` (or similar); confirms injectDeferredOne injects the
  // already-wrapped deferred text verbatim, never re-wrapping it.
  expect(landed[0].match(/tg#4321/g)).toHaveLength(1);
  expect(landed[0]).toContain('deploy now');
}, 30_000);

test('a deferred message typed but never submitted is reported once as unsubmitted, never as "resend it" (#463)', async () => {
  const cfgDir = makeCfgDir();
  writeFileSync(join(cfgDir, 'enter-lost'), '');
  const { landed, sent } = await deferAndFlush(cfgDir);
  expect(landed).toHaveLength(1);
  const reports = sent.filter((t) => t.includes(`pane ${PANE_ID} (claude)`) && t.includes('deploy now'));
  expect(reports).toHaveLength(1);
  // The text is already in the box: a "resend it" notice would get it typed twice.
  expect(sent.some((t) => /not delivered/.test(t))).toBe(false);
  // …and so would a replay of the update: the ledger records it final, not failed.
  const ledger = readFileSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'), 'utf8');
  expect(ledger.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.msg === 4321).map((e) => e.event)).toEqual(['received', 'queued', 'claimed', 'unsubmitted']);
}, 30_000);
