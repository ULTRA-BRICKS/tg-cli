import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createConnection } from 'net';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// End-to-end defer-while-waiting (spec tg#30): the real daemon, a fake Telegram
// server, and a fake tmux/ps that reports ONE claude pane (%1) and LOGS every
// injected payload. The danger under test: an inbound message that arrives while
// pane %1 has an OPEN question must NOT be pasted into that prompt — it is
// queued (✍️ reaction) and flushed only once the question is answered.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  // await stop: with active connections Bun returns a Promise; not awaiting it
  // leaks the listener into the next test (port/listener race).
  for (const s of servers.splice(0)) await s.stop(true);
});

const PANE_ID = '%1';
const PANE_PID = 4242;

// A fake tmux that: answers list-panes with one claude-hosting pane rooted at
// $TG_TEST_CWD; logs every send-keys -l / load-buffer payload to $TG_INJECT_LOG
// (one line per injected text) so the test can assert WHAT landed and WHEN; and
// exits 0 for everything else (Enter, paste-buffer, verify side-effects).
function fakeTmux(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    # Fields passed as %s args — the pane id is literally '%1', which must NOT
    # reach the printf FORMAT string (printf would read it as a directive).
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message)
    printf 'main\\n'
    ;;
  send-keys)
    # Scan for the literal flag: 'send-keys -t %1 -l <text>' logs <text>. A bare
    # 'send-keys -t %1 Enter' (no -l) is the submit keystroke — never logged.
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then printf '%s\\n' "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer)
    # multi-line paste payload arrives on stdin
    cat >> '${injectLog}'
    printf '\\n' >> '${injectLog}'
    ;;
esac
exit 0
`;
}

// ps -axo pid=,ppid=,command= → the pane pid runs claude, so findAgentInPane
// resolves %1 to a claude agent.
function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-defer-');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // registration pins the target pane so discovery is deterministic.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: PANE_ID, cwd: cfgDir }),
  );
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

// The daemon's stdout/stderr log (markers like release / re-defer lines)
// — polled by tests to gate on an async handler having run, rather than sleeping
// a fixed time that a loaded CI runner can outrun.
function daemonLogText(cfgDir: string): string {
  const p = join(cfgDir, 'daemon.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function reactionEmoji(reaction: Record<string, unknown>): string | undefined {
  return (reaction.reaction as Array<{ emoji?: string }> | undefined)?.[0]?.emoji;
}

function reactionSequence(reactions: Array<Record<string, unknown>>, messageId: number): Array<string | undefined> {
  return reactions.filter((r) => r.message_id === messageId).map(reactionEmoji);
}

function expectReactionSequence(
  reactions: Array<Record<string, unknown>>,
  messageId: number,
  expected: string[],
): void {
  expect(reactionSequence(reactions, messageId)).toEqual(expected);
}

async function waitForTelegramReaction(
  reactions: Array<Record<string, unknown>>,
  messageId: number,
  emoji: string,
  timeoutMs = 8000,
): Promise<void> {
  const matched = (): Record<string, unknown> | undefined =>
    reactions.filter((r) => r.message_id === messageId).find((r) => reactionEmoji(r) === emoji);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !matched()) await Bun.sleep(50);
  expect(matched()).toMatchObject({ message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
}

async function waitForInjected(cfgDir: string, text: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !injected(cfgDir).some((l) => l.includes(text))) await Bun.sleep(100);
  expect(injected(cfgDir).some((l) => l.includes(text))).toBe(true);
}

async function startDaemon(
  cfgDir: string,
  apiPort: number,
  extraEnv: Record<string, string> = {},
): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      // ONLY the fake bin dir on PATH for tmux/ps; node/bun resolve via execPath.
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      ...extraEnv,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

function startAsk(
  cfgDir: string,
  apiPort: number,
  request: Record<string, unknown>,
  opts: { unscoped?: boolean } = {},
): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
  };
  // ask reads TMUX_PANE for the request's paneId; pin it to our pane — UNLESS we're
  // simulating the tg#30 case where the hook runs WITHOUT TMUX_PANE (paneId arrives
  // undefined and the daemon must resolve it via discovery).
  if (!opts.unscoped) env.TMUX_PANE = PANE_ID;
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const payload = opts.unscoped ? { cwd: cfgDir, ...request } : { cwd: cfgDir, paneId: PANE_ID, ...request };
  ask.stdin.write(JSON.stringify(payload) + '\n');
  ask.stdin.end();
  return ask;
}

test('inbound text deferred while a question is open, flushed (and not lost) after the answer', async () => {
  const cfgDir = makeCfgDir();

  // A scripted Telegram server. updateQueue feeds getUpdates one batch at a
  // time; the test drives the sequence by pushing updates between assertions.
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
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

  // 1) Open a question on pane %1 (hook → inline buttons). It blocks until the
  //    callback answers it.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_block',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  trackProc(reg, ask);

  // Wait for the button message to be posted.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // 2) TWO inbound texts arrive WHILE the question is open → both DEFERRED, in
  //    order. The second message tests both deferral AND that flush preserves
  //    FIFO across multiple queued items.
  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 10,
      message: {
        message_id: 11,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        text: 'first thing',
      },
    },
  ]);
  // Wait for the first to be deferred (its ✍️ reaction) before sending the
  // second, so the daemon enqueues them in a deterministic order.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // nothing pasted into the open prompt
  expect(reactions.at(-1)).toMatchObject({ message_id: 11, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  updateQueue.push([
    {
      update_id: 11,
      message: {
        message_id: 12,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        text: 'second thing',
      },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length < 2) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // still nothing pasted
  expect(reactions.at(-1)).toMatchObject({ message_id: 12, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // 3) Answer the question via the inline button → unblocks the agent → flush.
  //    The callback's source message_id must match the button message the daemon
  //    posted (captured above), else the daemon rejects a stale tap.
  updateQueue.push([
    {
      update_id: 12,
      callback_query: {
        id: 'cb1',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: buttonMessageId, chat: { id: 1 }, date: nowSec },
        data: questionCallbackData,
      },
    },
  ]);

  // ask resolves with the hook output once the callback lands.
  const askOut = await new Response(ask.stdout).text();
  await ask.exited;
  expect(askOut.length).toBeGreaterThan(0);

  // 4) Both deferred messages flush into the pane in FIFO order (flushDeferred
  //    sleeps 800ms before the first paste). Exactly two, first then second.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 2) await Bun.sleep(100);
  }
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(2);
  expect(landed[0]).toContain('first thing');
  expect(landed[1]).toContain('second thing');
  {
    const t0 = Date.now();
    while (
      Date.now() - t0 < 8000 &&
      !(
        reactions.some((r) => r.message_id === 11 && (r.reaction as Array<{ emoji?: string }>)[0]?.emoji === '👀') &&
        reactions.some((r) => r.message_id === 12 && (r.reaction as Array<{ emoji?: string }>)[0]?.emoji === '👀')
      )
    ) {
      await Bun.sleep(50);
    }
  }
  const reactionEmojis = (messageId: number): string[] =>
    reactions
      .filter((r) => r.message_id === messageId)
      .map((r) => (r.reaction as Array<{ emoji?: string }>)[0]?.emoji)
      .filter((emoji): emoji is string => typeof emoji === 'string');
  expect(reactionEmojis(11)).toEqual(['✍️', '👀']);
  expect(reactionEmojis(12)).toEqual(['✍️', '👀']);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a follow-up scoped question socket close during a flush drains through terminal fallback', async () => {
  // Regression coverage for the concurrent-flush race under the post-timeout
  // terminal-fallback contract. Sequence:
  //   1. Q1 is answered → flushDeferred(%1) starts and sleeps 800ms (flushing).
  //   2. DURING that settle a follow-up Q2 opens on the SAME pane; an inbound
  //      message defers behind it (the pane is flushing AND has a pending
  //      question, so it queues — strict FIFO).
  //   3. Q2's hook socket closes. This is NOT a dead card anymore: Telegram keeps
  //      the question visible and the terminal fallback may still be waiting.
  //   4. The flush loop drains both queued messages in FIFO order and does NOT send
  //      the old misleading "were NOT delivered" notice.
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const plainMessages: string[] = []; // sendMessage bodies without inline buttons
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
        plainMessages.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      // answerCallbackQuery / editMessageText
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // 1) Open Q1 and defer one message behind it so the flush has a backlog to
  //    drain when Q1 is answered (flushDeferred early-returns on an empty queue).
  const ask1 = startAsk(cfgDir, server.port, {
    requestId: 'q1',
    agent: 'claude',
    kind: 'question',
    question: 'First?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask1);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  const q1Callback = questionCallbackData;
  const q1MessageId = buttonMessageId;

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 30,
      message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q1 backlog' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(reactions.at(-1)).toMatchObject({ message_id: 31, reaction: [{ type: 'emoji', emoji: '✍️' }] });
  expect(injected(cfgDir)).toEqual([]);

  // 2) Answer Q1 → flushDeferred(%1) starts and immediately sleeps 800ms. The
  //    flush is now IN FLIGHT (flushingPanes has %1) for the whole settle window.
  questionCallbackData = '';
  updateQueue.push([
    {
      update_id: 31,
      callback_query: {
        id: 'cbq1',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: q1MessageId, chat: { id: 1 }, date: nowSec },
        data: q1Callback,
      },
    },
  ]);
  await new Response(ask1.stdout).text();
  await ask1.exited;

  // 3) DURING the 800ms settle, a follow-up Q2 opens on the same pane.
  const ask2 = startAsk(cfgDir, server.port, {
    requestId: 'q2',
    agent: 'claude',
    kind: 'question',
    question: 'Second?',
    options: [{ label: 'Ok' }],
  });
  trackProc(reg, ask2);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // ...and an inbound arrives behind Q2 (pane is flushing AND has a pending
  // question → it defers, strict FIFO).
  updateQueue.push([
    {
      update_id: 32,
      message: { message_id: 33, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q2 orphan' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !reactions.some((r) => r.message_id === 33)) await Bun.sleep(50);
  }
  expect(reactions.find((r) => r.message_id === 33)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // 4) Close Q2's hook. The daemon enters terminal fallback for this scoped
  //    question and drains the queued text instead of requiring a resend.
  ask2.kill(9);
  await ask2.exited;

  const q1Pasted = (): boolean => injected(cfgDir).some((l) => l.includes('q1 backlog'));
  const q2Pasted = (): boolean => injected(cfgDir).some((l) => l.includes('q2 orphan'));
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && (!q1Pasted() || !q2Pasted())) await Bun.sleep(50);
  }

  expect(q1Pasted()).toBe(true);
  expect(q2Pasted()).toBe(true);
  expect(plainMessages.some((m) => m.includes('were NOT delivered'))).toBe(false);

  // 5) A later, legitimate question on the same pane must still flush normally.
  //    Open Q3, defer a message behind it, answer it, and assert the message lands.
  questionCallbackData = '';
  const ask3 = startAsk(cfgDir, server.port, {
    requestId: 'q3',
    agent: 'claude',
    kind: 'question',
    question: 'Third?',
    options: [{ label: 'Go' }],
  });
  trackProc(reg, ask3);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  const q3Callback = questionCallbackData;
  const q3MessageId = buttonMessageId;
  updateQueue.push([
    {
      update_id: 33,
      message: { message_id: 34, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q3 good' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !reactions.some((r) => r.message_id === 34)) await Bun.sleep(50);
  }
  expect(reactions.find((r) => r.message_id === 34)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '✍️' }] });
  updateQueue.push([
    {
      update_id: 34,
      callback_query: {
        id: 'cbq3',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: q3MessageId, chat: { id: 1 }, date: nowSec },
        data: q3Callback,
      },
    },
  ]);
  await new Response(ask3.stdout).text();
  await ask3.exited;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !injected(cfgDir).some((l) => l.includes('q3 good'))) await Bun.sleep(100);
  }
  // The legitimate Q3 backlog flushed after the later question answered.
  expect(injected(cfgDir).some((l) => l.includes('q3 good'))).toBe(true);
  // ...and the fallback message was delivered once, not replayed by Q3's flush.
  expect(injected(cfgDir).filter((l) => l.includes('q2 orphan'))).toHaveLength(1);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a release racing a NEW live question re-defers (does not drop the live question backlog)', async () => {
  // Regression for review finding #1: a pane can host a second LIVE question whose
  // backlog must still be delivered. Sequence:
  //   1. Q1 answered → flushDeferred(%1) starts, sleeps 800ms (flushing).
  //   2. During the settle Q2 opens; m2 defers behind it; Q2 is released.
  //   3. ALSO during the settle Q3 opens (a real, still-pending question); m3 defers.
  //   4. The flush wakes, sees Q3 pending, and must RE-DEFER the residual
  //      (Q3's answer will flush it), NOT drop it — dropping here
  //      would silently lose m3, a legitimately-queued message of a live question.
  //   5. Answer Q3 → m3 lands. (m2 rides along; per the per-pane design that is the
  //      accepted lesser evil vs. dropping the live question's message.)
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const plainMessages: string[] = [];
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
        plainMessages.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  const waitForButton = async (): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  };
  const waitForReaction = async (id: number): Promise<void> => {
    await waitForTelegramReaction(reactions, id, '✍️');
  };
  const nowSec = Math.floor(Date.now() / 1000);

  // Q1 + its backlog so the flush has work.
  const ask1 = startAsk(cfgDir, server.port, { requestId: 'q1', agent: 'claude', kind: 'question', question: 'First?', options: [{ label: 'Y' }] });
  trackProc(reg, ask1);
  await waitForButton();
  const q1Cb = questionCallbackData;
  const q1Msg = buttonMessageId;
  updateQueue.push([{ update_id: 40, message: { message_id: 41, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q1 backlog' } }]);
  await waitForReaction(41);

  // Answer Q1 → flush starts and sleeps 800ms.
  questionCallbackData = '';
  updateQueue.push([{ update_id: 41, callback_query: { id: 'c1', from: { id: 1, first_name: 'Alex' }, message: { message_id: q1Msg, chat: { id: 1 }, date: nowSec }, data: q1Cb } }]);
  await new Response(ask1.stdout).text();
  await ask1.exited;

  // During the settle: Q2 opens, m2 defers, Q2 releases.
  const ask2 = startAsk(cfgDir, server.port, { requestId: 'q2', agent: 'claude', kind: 'question', question: 'Second?', options: [{ label: 'Y' }] });
  trackProc(reg, ask2);
  await waitForButton();
  questionCallbackData = '';
  updateQueue.push([{ update_id: 42, message: { message_id: 43, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q2 orphan' } }]);
  await waitForReaction(43);

  // Q3 opens (a real, still-pending question) and m3 defers behind it — BEFORE we
  // release Q2, so the flush is guaranteed to see Q3 pending when it wakes.
  const ask3 = startAsk(cfgDir, server.port, { requestId: 'q3', agent: 'claude', kind: 'question', question: 'Third?', options: [{ label: 'Go' }] });
  trackProc(reg, ask3);
  await waitForButton();
  const q3Cb = questionCallbackData;
  const q3Msg = buttonMessageId;
  updateQueue.push([{ update_id: 43, message: { message_id: 44, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q3 live' } }]);
  await waitForReaction(44);

  // Now close Q2's hook. The terminal-fallback flush wakes while Q3 is pending,
  // so it must re-defer behind that live question, not drop the queue.
  ask2.kill(9);
  await ask2.exited;

  // Wait for the daemon to log the re-defer decision BEFORE answering Q3. This is
  // the deterministic proof the flush woke while Q3 was still pending and chose to
  // preserve the residual queue. Answering Q3 earlier could race the 800ms settle
  // and remove Q3 before the flush evaluates the gate.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !daemonLogText(cfgDir).includes('re-queued behind a new question')) await Bun.sleep(50);
  }
  // The flush re-deferred because a live question was pending.
  expect(daemonLogText(cfgDir)).toContain('re-queued behind a new question');
  // ...and it must NOT have dropped the queue.
  expect(daemonLogText(cfgDir)).not.toContain('were NOT delivered');
  // Re-defer is still "queued", not "delivered": no 👀 should appear until the
  // live Q3 question is answered and the residual queue actually flushes.
  expectReactionSequence(reactions, 43, ['✍️']);
  expectReactionSequence(reactions, 44, ['✍️']);

  // Answer Q3 → its flush delivers m3 (the live question's message). The fix is
  // proven by m3 landing; with the bug (drop-everything) m3 would be lost.
  questionCallbackData = '';
  updateQueue.push([{ update_id: 44, callback_query: { id: 'c3', from: { id: 1, first_name: 'Alex' }, message: { message_id: q3Msg, chat: { id: 1 }, date: nowSec }, data: q3Cb } }]);
  await new Response(ask3.stdout).text();
  await ask3.exited;

  {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !injected(cfgDir).some((l) => l.includes('q3 live'))) await Bun.sleep(100);
  }
  // The live question's message was delivered, NOT dropped (review finding #1).
  expect(injected(cfgDir).some((l) => l.includes('q3 live'))).toBe(true);
  await waitForTelegramReaction(reactions, 44, '👀', 4000);
  expectReactionSequence(reactions, 44, ['✍️', '👀']);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a scoped question hook socket close drains queued text and does not wedge later inbound', async () => {
  // Regression for the post-timeout fallback path: a scoped socket close means the
  // terminal may still be waiting, so queued text should be flushed, not reported as
  // lost. After the fallback drain, a NEW inbound must inject normally.
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
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
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      // answerCallbackQuery / editMessageText
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // Open a question; an inbound arrives and is deferred behind it.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_expire',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 20,
      message: { message_id: 21, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'deferred one' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(reactions.at(-1)).toMatchObject({ message_id: 21, reaction: [{ type: 'emoji', emoji: '✍️' }] });
  expect(injected(cfgDir)).toEqual([]);

  // The question's hook socket closes. The daemon keeps the Telegram card visible
  // as post-timeout and flushes the queued message into the terminal fallback.
  questionCallbackData = '';
  ask.kill(9);
  await ask.exited;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !daemonLogText(cfgDir).includes('question terminal-fallback on %1')) {
      await Bun.sleep(50);
    }
    expect(daemonLogText(cfgDir)).toContain('question terminal-fallback on %1');
  }
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !injected(cfgDir).some((l) => l.includes('deferred one'))) await Bun.sleep(100);
  }
  expect(injected(cfgDir).some((l) => l.includes('deferred one'))).toBe(true);

  // A NEW inbound now arrives. With the bug it would be deferred (queue non-empty
  // → ✍️, stuck forever). Fixed: no pending question, no flush in flight → it
  // injects live and earns a 👀.
  updateQueue.push([
    {
      update_id: 21,
      message: { message_id: 22, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'after expiry' },
    },
  ]);
  // Wait for the new message to actually land in the pane (the real proof it was
  // NOT wedged). Injection runs verify-pane + paced send-keys, so allow time.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !injected(cfgDir).some((l) => l.includes('after expiry'))) {
      await Bun.sleep(100);
    }
  }
  // Both the fallback-drained message and the later live message landed.
  expect(injected(cfgDir)).toContain('[TG from Alex tg#22] after expiry');
  expect(injected(cfgDir).some((l) => l.includes('deferred one'))).toBe(true);
  // It eventually reaches DELIVERED (👀). It may briefly show ✍️ if it arrived
  // during the fallback flush window, but it must not stay there.
  {
    const t0 = Date.now();
    const got22 = (): Record<string, unknown> | undefined =>
      reactions.find((r) => r.message_id === 22 && (r.reaction as Array<{ emoji?: string }>)[0]?.emoji === '👀');
    while (Date.now() - t0 < 4000 && !got22()) await Bun.sleep(50);
    expect(got22()).toMatchObject({ message_id: 22, reaction: [{ type: 'emoji', emoji: '👀' }] });
  }

  // The definitive regression: open a SECOND, unrelated question and answer it.
  // The fallback-drained message from Q1 must NOT resurface again.
  const ask2 = startAsk(cfgDir, server.port, {
    requestId: 'q_second',
    agent: 'claude',
    kind: 'question',
    question: 'Second?',
    options: [{ label: 'Ok' }],
  });
  trackProc(reg, ask2);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  updateQueue.push([
    {
      update_id: 22,
      callback_query: {
        id: 'cb2',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: buttonMessageId, chat: { id: 1 }, date: nowSec },
        data: questionCallbackData,
      },
    },
  ]);
  await new Response(ask2.stdout).text();
  await ask2.exited;
  // Give a would-be stale flush ample time to (wrongly) fire, then assert it did not.
  await Bun.sleep(1500);
  expect(injected(cfgDir).filter((l) => l.includes('deferred one'))).toHaveLength(1);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// tg#30 regression: a question forwarded from a hook WITHOUT TMUX_PANE arrives with paneId
// undefined. Before the fix the defer guard (keyed on exact pane) never matched it, so inbound
// text was send-keys'd straight into the open prompt (fail OPEN). The daemon now resolves the
// pane via discovery (Layer 1) — and an unscoped question defers ANY pane as a backstop (Layer 2)
// — so the inbound is DEFERRED, not pasted into the prompt.
test('tg#30: an UNSCOPED question (hook had no TMUX_PANE) still DEFERS inbound, never pastes it', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
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
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: 1 } });
        }
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

  // Open a question with NO TMUX_PANE and NO paneId in the payload — the daemon must resolve the
  // pane itself (the registration + fake tmux both point at PANE_ID).
  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // Inbound arrives WHILE the unscoped question is open → must be DEFERRED, not pasted.
  updateQueue.push([
    { update_id: 20, message: { message_id: 21, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'inject me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // NOT send-keys'd into the open prompt (the fail-open bug)
  expect(reactions.at(-1)).toMatchObject({ message_id: 21, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// tg-cli#127: answering an UNSCOPED question (no paneId) must release the inbound it
// deferred. The answer path only flushed `pending.req.paneId`, so a paneless answer
// released nothing and the CTO's text stayed ✍️ forever.
test('tg-cli#127: answering an UNSCOPED question delivers the inbound deferred behind it', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped_answer', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    { update_id: 60, message: { message_id: 61, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'release me' } },
  ]);
  await waitForTelegramReaction(reactions, 61, '✍️', 8000);
  expect(injected(cfgDir)).toEqual([]);

  updateQueue.push([
    {
      update_id: 62,
      callback_query: {
        id: 'cb127',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: 1, chat: { id: 1 }, date: nowSec },
        data: server.cb(),
      },
    },
  ]);
  await ask.exited;

  await waitForInjected(cfgDir, 'release me', 8000);
  await waitForTelegramReaction(reactions, 61, '👀', 4000);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// tg-cli#127: a deferred message whose flush fails is dead-lettered — the CTO is told to
// resend it — so its ✍️ ("noted, queued") must be cleared, not left claiming it still waits.
test('tg-cli#127: a deferred message whose flush fails loses its ✍️ and the CTO is told', async () => {
  const cfgDir = makeCfgDir();
  // Wrap the fake tmux so typing or pasting the marked text fails, like a dead pane.
  const bin = join(cfgDir, 'bin');
  renameSync(join(bin, 'tmux'), join(bin, 'tmux-real'));
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/sh
real="$(dirname "$0")/tmux-real"
if [ "$1" = send-keys ]; then for a in "$@"; do case "$a" in *undeliverable*) exit 1;; esac; done; fi
if [ "$1" = load-buffer ]; then buf=$(cat); case "$buf" in *undeliverable*) exit 1;; esac; printf '%s' "$buf" | exec "$real" "$@"; fi
exec "$real" "$@"
`,
    { mode: 0o755 },
  );
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const plainMessages: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits, plainMessages);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_dead_letter', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    { update_id: 90, message: { message_id: 91, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'undeliverable text' } },
  ]);
  await waitForTelegramReaction(reactions, 91, '✍️', 8000);

  updateQueue.push([
    {
      update_id: 92,
      callback_query: {
        id: 'cb127dead',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: 1, chat: { id: 1 }, date: nowSec },
        data: server.cb(),
      },
    },
  ]);
  await ask.exited;

  const notified = (): boolean => plainMessages.some((m) => m.includes('tg#91 was not delivered'));
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !notified()) await Bun.sleep(50);
  }
  expect(notified()).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('undeliverable'))).toBe(false);
  // ✍️ then the cleared reaction (an empty list); never 👀.
  expect(reactions.filter((r) => r.message_id === 91).map((r) => r.reaction)).toEqual([
    [{ type: 'emoji', emoji: '✍️' }],
    [],
  ]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// --- "wait indefinitely" (#N): a SCOPED forwarded question must not expire on a timer ---
//
// The CTO's daily lifeline: a forwarded question whose pane is known (the normal,
// answerable case) must stay open until the human taps an answer in Telegram OR
// the agent process dies (socket close) — it must NEVER auto-expire to
// "expired — answer in terminal". The no-wedge guarantee is preserved by keeping
// the abandon timer for the UNSCOPED case only (an unscoped question defers ALL
// panes; a scoped one defers only its own pane, whose agent is itself blocked on
// this very question, so waiting forever there starves nothing).
//
// We shorten the unscoped bound to 1.5s via TG_CTL_UNSCOPED_TIMEOUT_MS so the
// tests exercise the expiry/no-expiry split without a real 110s wait; production
// never sets that env, so the bound stays 110s there.
const SHORT_UNSCOPED_MS = '1500';

// A Telegram server that records editMessageText bodies (so a test can assert the
// prompt was — or was NOT — rewritten to "expired"), tracks the question's
// callback data, and feeds getUpdates from a caller-owned queue.
function recordingServer(
  updateQueue: unknown[][],
  reactions: Array<Record<string, unknown>>,
  edits: string[],
  // Optional collector for plain (button-less) sendMessage bodies. Omitted by
  // callers that don't assert on them.
  plainMessages?: string[],
  sendMessageOverride?: (
    body: Record<string, unknown>,
    hasQuestionKeyboard: boolean,
  ) => Response | null | undefined | Promise<Response | null | undefined>,
): {
  port: number;
  cb: () => string;
  stop: (closeActiveConnections?: boolean) => Promise<void> | void;
} {
  let questionCallbackData = '';
  let buttonMessageId = 0;
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
        const override = await sendMessageOverride?.(body, Boolean(kb?.length));
        if (override) return override;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        plainMessages?.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        const body = (await req.json()) as Record<string, unknown>;
        edits.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { port: server.port, cb: () => questionCallbackData, stop: (c) => server.stop(c) };
}

test('a SCOPED question stays open PAST the abandon bound — no "expired", the callback still answers it, deferred inbound flushes', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);

  // 1.5s unscoped bound — if a SCOPED question were (wrongly) armed with it, it
  // would expire well within this test. It must not.
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  // Scoped question on %1 (startAsk pins TMUX_PANE=%1 by default).
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_scoped_forever',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Inbound arrives while the question is open → DEFERRED (not pasted).
  updateQueue.push([
    { update_id: 30, message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'queued while waiting' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]);
  expect(reactions.at(-1)).toMatchObject({ message_id: 31, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // Wait WELL past the (shortened) unscoped bound. A scoped question has NO timer,
  // so it must still be open: no "expired" edit, the ask subprocess still blocked,
  // the inbound still NOT pasted.
  await Bun.sleep(Number(SHORT_UNSCOPED_MS) + 1500);
  expect(edits).not.toContain('expired — answer in terminal');
  expect(ask.exitCode).toBeNull(); // ask is still blocked — the question never expired
  expect(injected(cfgDir)).toEqual([]); // nothing pasted into the still-open prompt

  // NOW the human answers via the inline button → the question resolves and the
  // deferred inbound flushes (proves the wait-forever path still reaches the
  // normal answer/flush machinery).
  updateQueue.push([
    { update_id: 31, callback_query: { id: 'cb1', from: { id: 1, first_name: 'Alex' }, message: { message_id: 1, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) }, data: server.cb() } },
  ]);
  const askOut = await new Response(ask.stdout).text();
  await ask.exited;
  expect(askOut.length).toBeGreaterThan(0); // the hook got its answer, not "expired"

  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 1) await Bun.sleep(100);
  }
  expect(injected(cfgDir)).toHaveLength(1);
  expect(injected(cfgDir)[0]).toContain('queued while waiting');
  expect(edits.at(-1)).toContain('Selected answer: Yes'); // prompt kept context, never "expired"

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a SCOPED question socket close keeps the Telegram card answerable and flushes its backlog', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const plainMessages: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits, plainMessages);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_scoped_diesocket',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Queue an inbound behind the (scoped) open question.
  updateQueue.push([
    { update_id: 40, message: { message_id: 41, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'orphan me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }

  // The hook socket closes while the terminal fallback may still be waiting.
  // The card must remain visible/answerable in Telegram, and the queued text is
  // flushed instead of producing a misleading "resend them" notice.
  ask.kill(9);
  await ask.exited;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !edits.some((e) => e.includes('Time-out expired.'))) await Bun.sleep(50);
  }
  expect(edits.some((e) => e.includes('Question from claude'))).toBe(true);
  expect(edits.some((e) => e.includes('Proceed?'))).toBe(true);
  expect(edits.some((e) => e.includes('Reply to this message with your answer'))).toBe(true);
  expect(plainMessages.some((m) => m.includes('were NOT delivered'))).toBe(false);
  await waitForInjected(cfgDir, 'orphan me');
  expect(injected(cfgDir)[0]).toContain('orphan me');
  await waitForTelegramReaction(reactions, 41, '👀', 4000);
  expectReactionSequence(reactions, 41, ['✍️', '👀']);

  // Pane is free again: a fresh inbound on %1 injects directly (no ghost defer).
  updateQueue.push([
    { update_id: 41, message: { message_id: 42, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'after the death' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !injected(cfgDir).some((l) => l.includes('after the death'))) await Bun.sleep(100);
  }
  expect(injected(cfgDir).some((l) => l.includes('after the death'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a SCOPED question send failure releases and flushes its deferred backlog', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const plainMessages: string[] = [];
  let questionSendStarted = false;
  let failQuestionSend!: () => void;
  const failGate = new Promise<void>((resolve) => {
    failQuestionSend = resolve;
  });

  const server = recordingServer(updateQueue, reactions, edits, plainMessages, async (_body, hasQuestionKeyboard) => {
    if (!hasQuestionKeyboard) return null;
    questionSendStarted = true;
    await failGate;
    return Response.json({ ok: false, description: 'send failed' }, { status: 500 });
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_scoped_send_fails',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !questionSendStarted) await Bun.sleep(50);
    expect(questionSendStarted).toBe(true);
  }

  updateQueue.push([
    { update_id: 80, message: { message_id: 81, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'send failure backlog' } },
  ]);
  await waitForTelegramReaction(reactions, 81, '✍️', 4000);
  expect(injected(cfgDir)).toEqual([]);

  failQuestionSend();
  await ask.exited;
  await waitForInjected(cfgDir, 'send failure backlog');
  expect(plainMessages.some((m) => m.includes('were NOT delivered'))).toBe(false);
  await waitForTelegramReaction(reactions, 81, '👀', 4000);
  expectReactionSequence(reactions, 81, ['✍️', '👀']);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('NO-WEDGE guard: an UNSCOPED question never answered still self-clears at the bound, freeing ALL-pane routing', async () => {
  // The safety invariant the timer protects. An unscoped question defers EVERY
  // pane (fail-closed Layer-2 match). If it could wait forever it would wedge
  // routing for the whole daemon. The bound MUST still fire for the unscoped case:
  // after it elapses the question is gone, the prompt is rewritten to "expired",
  // and inbound flows again. This is the mutation that would catch a regression
  // removing the unscoped bound (it would hang here, injected stays empty).
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const plainMessages: string[] = []; // collector so the test can assert no resend notice is emitted
  const server = recordingServer(updateQueue, reactions, edits, plainMessages);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  // Unscoped question (hook had no TMUX_PANE) → defers ANY pane.
  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped_wedge', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Inbound arrives — deferred while the unscoped question is open (correct; the
  // tg#30 fail-closed backstop). It must NOT stay deferred forever.
  updateQueue.push([
    { update_id: 50, message: { message_id: 51, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'unwedge me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // deferred for now (question still open)

  // NO answer is ever sent. The unscoped bound elapses → the question self-clears
  // (prompt → "expired"), the ask subprocess unblocks with null, and routing is
  // free again. A regression that drops the unscoped bound would never reach here.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !edits.includes('expired — answer in terminal')) await Bun.sleep(50);
  }
  expect(edits).toContain('expired — answer in terminal');
  await ask.exited; // the blocked hook is released (null) when its question expires

  // Routing un-wedged: a NEW inbound now also reaches the pane. It may queue
  // behind the release flush for a moment, but it must not get stuck.
  updateQueue.push([
    { update_id: 51, message: { message_id: 52, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'routing alive' } },
  ]);
  await waitForInjected(cfgDir, 'unwedge me', 12000);
  await waitForInjected(cfgDir, 'routing alive', 12000);

  // Fate of the message deferred behind the EXPIRED unscoped question ('unwedge
  // me'): once the blocking question is gone, the daemon must flush the queued
  // message instead of asking the user to resend it. The no-wedge guarantee still
  // holds because later inbound ('routing alive') also gets through.
  expect(plainMessages.some((m) => m.includes('were NOT delivered'))).toBe(false);
  await waitForTelegramReaction(reactions, 51, '👀', 4000);
  expectReactionSequence(reactions, 51, ['✍️', '👀']);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

// tg-cli#403 (multi-model review finding): a CRITICAL unscoped hatch request
// deliberately NEVER self-clears — forwardAndPostQuestion skips the
// UNSCOPED_ABANDON_MS backstop for it entirely, by design, so it can wait
// indefinitely for a human decision. Without a carve-out in
// paneHasPendingQuestion, the "an unscoped entry defers ALL panes, but that's
// safe because it always self-clears within ≤110s" invariant the NO-WEDGE
// guard test above pins would silently become FALSE the moment a critical
// hatch request is pending: it would defer every agent's inbound Telegram
// traffic for as long as the human hasn't tapped, potentially hours. This
// test proves the carve-out holds: routing stays live WHILE the critical
// request is still open (never self-cleared, never answered).
test('NO-WEDGE guard, CRITICAL exception (tg-cli#403): an UNSCOPED CRITICAL hatch request never self-clears, but it must NOT wedge routing to other inbound the way a non-critical unscoped question does', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const plainMessages: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits, plainMessages);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(
    cfgDir,
    server.port,
    {
      requestId: 'hatch-wedge-guard-aaaaaaaaaaaa',
      agent: 'claude',
      kind: 'permission',
      question: 'Allow rig hatch escalation: wedge-guard?',
      permissionEvent: 'PermissionRequest',
      critical: true,
    },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Inbound to the (only) agent pane arrives while the critical hatch request is
  // still open. Unlike the ordinary unscoped case (which defers until it
  // self-clears), it must reach the pane PROMPTLY — never deferred behind a
  // request with no bound at all.
  updateQueue.push([
    { update_id: 80, message: { message_id: 81, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'do not wedge me' } },
  ]);
  await waitForInjected(cfgDir, 'do not wedge me', 8000);

  // The hatch request is STILL pending the whole time — proof this isn't merely
  // "it happened to expire first" (the exact regression the NO-WEDGE guard test
  // above pins for the non-critical case). No expiry text, process still alive.
  expect(edits).not.toContain('expired — answer in terminal');
  expect(ask.killed).toBe(false);

  ask.kill(9);
  await ask.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

// tg-cli#149: a generic `tg-ctl ask "<question>"` is a shell command's approval
// gate, not a prompt open in any pane, and it may wait up to 15 minutes. It must
// not defer every agent pane's inbound the way an unscoped HOOK question does
// (that rule is safe only because a hook question self-clears within ~110 s).
test('a generic `tg-ctl ask "<question>"` does not defer inbound to agent panes while it waits', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = trackProc(
    reg,
    Bun.spawn([process.execPath, TG_CTL, 'ask', 'deploy the release?', '--timeout', '30'], {
      cwd: cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  updateQueue.push([
    { update_id: 90, message: { message_id: 91, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'keep working meanwhile' } },
  ]);
  await waitForInjected(cfgDir, 'keep working meanwhile', 8000);
  // Still waiting for the human: the ask was not merely expired first.
  expect(ask.exitCode).toBeNull();

  ask.kill(9);
  await ask.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

// tg-cli#533: an opencode ask arrives from the daemon's own opencode bridge — paneless, its
// prompt lives in opencode, not in any tmux pane we inject into. Like a generic ask it must
// not defer every agent pane's inbound while its card is open.
test('an opencode bridge ask does not defer inbound to agent panes while its card is open', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const socket = createConnection(join(cfgDir, 'tg-ctl.123.sock'));
  socket.on('connect', () => socket.write(JSON.stringify({
    requestId: 'oc_ses_1_per_1',
    agent: 'opencode',
    kind: 'permission',
    title: 'external_directory',
    question: 'external_directory\nresources: /opt/zz/*',
    cwd: cfgDir,
    // The bridge stamps the server it got the ask from (tg-cli#687).
    opencode: { sessionId: 'ses_1', requestId: 'per_1', replyKind: 'permission-api', serverUrl: 'http://127.0.0.1:4096' },
  }) + '\n'));
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  updateQueue.push([
    { update_id: 95, message: { message_id: 96, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'keep going in claude' } },
  ]);
  await waitForInjected(cfgDir, 'keep going in claude', 8000);

  socket.destroy();
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

// The dangerous failure mode of the #58 sweep: an unscoped question's expiry must
// NOT flush/drop a backlog that belongs to a DIFFERENT, still-live question on
// the same pane. The deferred queue is keyed by PANE, not question, so a naive
// "flush every pane's backlog on the unscoped expiry" would disturb the scoped
// question's legitimately-queued messages. The per-pane guard
// (onQuestionReleased skips a pane that still has a pending question) is what
// prevents this; this test pins that guard so a regression in it is caught.
test('an UNSCOPED expiry does NOT flush a backlog held behind a still-live SCOPED question on the same pane (tg-cli#58 guard)', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const plainMessages: string[] = [];
  let scopedCb = '';
  let scopedMsg = 0;
  let buttonMessageId = 0;

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
          // The FIRST question posted is the scoped one; capture its callback +
          // message id so the test can answer it later. The unscoped question
          // posts second and is never answered (it expires).
          if (scopedCb === '') {
            scopedCb = kb[0][0].callback_data;
            scopedMsg = buttonMessageId;
          }
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        plainMessages.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. A SCOPED question on PANE_ID — it has no timer (waits forever) and defers
  //    only its own pane.
  const askScoped = startAsk(cfgDir, server.port, {
    requestId: 'q_scoped_safe',
    agent: 'claude',
    kind: 'question',
    question: 'Scoped?',
    options: [{ label: 'Y' }],
  });
  trackProc(reg, askScoped);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && scopedCb === '') await Bun.sleep(50);
    expect(scopedCb).not.toBe('');
  }

  // 2. A message deferred behind the scoped question (this is the backlog the
  //    sweep must NOT touch).
  updateQueue.push([
    { update_id: 60, message: { message_id: 61, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'keep me safe' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // deferred, not pasted

  // 3. An UNSCOPED question opens too (defers ALL panes) and is NEVER answered, so
  //    it expires on the short bound — triggering the #58 sweep.
  const askUnscoped = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped_expires', agent: 'claude', kind: 'question', question: 'Unscoped?', options: [{ label: 'Y' }] },
    { unscoped: true },
  );
  trackProc(reg, askUnscoped);
  await askUnscoped.exited; // the unscoped hook is released (null) when it expires

  // 4. The sweep ran, but PANE_ID still has a pending (scoped) question, so the
  //    guard SKIPPED it — no flush of the scoped backlog. The negative window
  //    below is sound because the sweep (onUnscopedRelease) runs SYNCHRONOUSLY in
  //    the expiry timer BEFORE the hook's `socket.end("null\n")` that unblocks the
  //    ask subprocess — so by the time `askUnscoped.exited` above resolves, the
  //    sweep has already happened; a (wrongly) sent notice would already be in
  //    plainMessages. The extra 3s only absorbs the daemon→fake-server round trip.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !plainMessages.some((m) => m.includes('were NOT delivered'))) await Bun.sleep(50);
  }
  expect(plainMessages.some((m) => m.includes('were NOT delivered'))).toBe(false);
  expect(injected(cfgDir)).toEqual([]); // 'keep me safe' is still queued, not lost, not pasted

  // 5. Answer the SCOPED question → its backlog flushes intact (the proof the
  //    sweep left it alone).
  updateQueue.push([
    { update_id: 61, callback_query: { id: 'cbsafe', from: { id: 1, first_name: 'Alex' }, message: { message_id: scopedMsg, chat: { id: 1 }, date: nowSec }, data: scopedCb } },
  ]);
  await askScoped.exited;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 1) await Bun.sleep(100);
  }
  expect(injected(cfgDir).some((l) => l.includes('keep me safe'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

// The unscoped sweep is wired into THREE removal paths (timeout / socket close /
// send failure); the tests above exercise the timeout path. This one covers the
// SOCKET-CLOSE path: an unscoped question whose hook process dies (fd closed)
// BEFORE its bound elapses must still release and flush its idle-pane backlog.
test('an UNSCOPED question abandoned by SOCKET CLOSE (process dies) flushes its idle backlog', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const plainMessages: string[] = [];
  // A long bound so the SOCKET CLOSE — not the timer — is unambiguously the path
  // that fires the sweep (the kill below happens well before 60s elapses).
  const server = recordingServer(updateQueue, reactions, edits, plainMessages);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: '60000' });

  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped_close', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Inbound defers behind the open unscoped question.
  updateQueue.push([
    { update_id: 70, message: { message_id: 71, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'die with me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // deferred

  // The agent process dies (socket close) with NO answer, WELL before the 60s
  // bound. The close handler must run the unscoped sweep and flush the pane.
  ask.kill(9);
  await ask.exited;
  await waitForInjected(cfgDir, 'die with me');
  expect(plainMessages.some((m) => m.includes('were NOT delivered'))).toBe(false);
  await waitForTelegramReaction(reactions, 71, '👀', 4000);
  expectReactionSequence(reactions, 71, ['✍️', '👀']);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('SIGTERM during an in-flight deferred flush drains the backlog before exiting (codex #198)', async () => {
  // The race #194 opened: answering a question starts flushDeferred(%1)
  // fire-and-forget — it sleeps 800ms, THEN pastes the queued backlog and
  // re-persists the store. A SIGTERM that lands in that settle window must not let
  // the graceful loop-top exit run process.exit before the flush drains: the
  // queued message would be snapshotted with no pending question left to release
  // it (wedged after restart) or dropped while the flush had taken ownership. The
  // daemon must WAIT for the in-flight flush, so the backlog lands in the pane.
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
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
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // Open Q1 and defer one inbound behind it (✍️ queued, nothing injected yet).
  const ask1 = startAsk(cfgDir, server.port, {
    requestId: 'q1',
    agent: 'claude',
    kind: 'question',
    question: 'First?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask1);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 30,
      message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'sigterm backlog' },
    },
  ]);
  await waitForTelegramReaction(reactions, 31, '✍️');
  expect(injected(cfgDir)).toEqual([]);

  // Answer Q1 → flushDeferred(%1) starts and sleeps 800ms (in flight). ask1 exits
  // once the daemon delivers the answer, which is AFTER flushDeferred was armed —
  // so by here the flush is reliably mid-settle.
  updateQueue.push([
    {
      update_id: 31,
      callback_query: {
        id: 'cbq1',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: buttonMessageId, chat: { id: 1 }, date: nowSec },
        data: questionCallbackData,
      },
    },
  ]);
  await new Response(ask1.stdout).text();
  await ask1.exited;

  // SIGTERM DURING the settle window. The graceful exit must drain the flush.
  daemon.kill('SIGTERM');

  // The queued backlog must still land in the pane before the daemon exits — the
  // proof the flush drained rather than the process exiting out from under it.
  await waitForInjected(cfgDir, 'sigterm backlog', 8000);
  await daemon.exited;
}, 30_000);
