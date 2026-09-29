import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) s.stop(true);
});

test('tg-ctl ask returns no decision immediately when the Telegram prompt cannot be sent', async () => {
  const cfgDir = makeCfgDir();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        return Response.json({ ok: false, description: 'bad callback_data' }, { status: 400 });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_fail',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  expect(stdout).toBe('');
}, 10_000);

test('tg-ctl ask exits 0 with no output when credentials are absent', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-buttons-nocreds-'));
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  trackProc(reg, ask);
  ask.stdin.write(JSON.stringify({
    requestId: 'q_no_creds',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
  }) + '\n');
  ask.stdin.end();

  const stdout = await new Response(ask.stdout).text();
  const stderr = await new Response(ask.stderr).text();
  await ask.exited;

  expect(ask.exitCode).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toBe('');
});

test('tg-ctl ask does not create inline buttons for unsupported Codex question hooks', async () => {
  const cfgDir = makeCfgDir();
  const sentMessages: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        sentMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 + sentMessages.length } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'codex_question',
    agent: 'codex',
    kind: 'question',
    question: 'Pick a value',
    options: [{ label: 'A' }],
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && sentMessages.length === 0) await Bun.sleep(50);
  expect(stdout).toBe('');
  expect(sentMessages).toEqual([
    {
      chat_id: 1,
      text: "native question forwarding isn't available for `codex` — answer in the terminal",
    },
  ]);
}, 10_000);

test('tg-ctl ask fast-passes unsupported hooks before slow Telegram notices finish', async () => {
  const cfgDir = makeCfgDir();
  let noticeDone = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        // The notice send is deliberately slow. The ask MUST return before it
        // resolves — `noticeDone` flips only after this 3s block completes, so
        // asserting it's still false at ask-exit is a deterministic proof the
        // ask did not wait for the send (no wall-clock budget to flake under load).
        await Bun.sleep(3000);
        noticeDone = true;
        return Response.json({ ok: true, result: { message_id: 92 } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'codex_question_slow_notice',
    agent: 'codex',
    kind: 'question',
    question: 'Pick a value',
    options: [{ label: 'A' }],
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  expect(noticeDone).toBe(false);
  expect(stdout).toBe('');
}, 10_000);

test('tg-ctl ask fast-passes when the hook cwd does not match the active registration', async () => {
  const cfgDir = makeCfgDir();
  const sentMessages: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        sentMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 91 } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_wrong_cwd',
    cwd: join(cfgDir, 'unregistered-session'),
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
    options: [{ label: 'A' }],
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  expect(stdout).toBe('');
  expect(sentMessages).toEqual([]);
}, 10_000);

test('tg-ctl ask carries tmux session/window from the hook pane environment', async () => {
  const cfgDir = makeCfgDir();
  writeFileSync(
    join(cfgDir, 'bin', 'tmux'),
    `#!/bin/sh
[ "$TMUX" = "tmux-sock,1,0" ] || exit 2
[ "$TMUX_PANE" = "%77" ] || exit 3
case "$3" in
  '#{session_name}') printf 'tmux-session\\n' ;;
  '#{window_name}') printf 'tmux-window\\n' ;;
  *) exit 4 ;;
esac
`,
    { mode: 0o755 },
  );
  const sentMessages: Array<{ text?: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        sentMessages.push((await req.json()) as { text?: string });
        return Response.json({ ok: true, result: { message_id: 93 } });
      }
      if (url.pathname.endsWith('/editMessageText') || url.pathname.endsWith('/editMessageReplyMarkup')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  await startDaemon(cfgDir, server.port);

  const ask = startAsk(
    cfgDir,
    server.port,
    {
      session_id: 'sid',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            header: 'Decision',
            question: 'Continue?',
            options: [{ label: 'A' }],
          },
        ],
      },
    },
    {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      TMUX: 'tmux-sock,1,0',
      TMUX_PANE: '%77',
    },
  );

  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && sentMessages.length === 0) await Bun.sleep(50);
  if (ask.exitCode === null) {
    ask.kill(9);
    await ask.exited;
  }

  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('Source: agent=claude · window=tmux-window · pane=%77 · session=tmux-session');
}, 10_000);

test('tg-ctl ask rejects duplicate active callback ids without replacing the first pending hook', async () => {
  const cfgDir = makeCfgDir();
  let sendCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        sendCount += 1;
        return Response.json({ ok: true, result: { message_id: 90 + sendCount } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const first = startAsk(cfgDir, server.port, {
    requestId: 'q_duplicate',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && sendCount === 0) await Bun.sleep(50);
  expect(sendCount).toBe(1);
  await Bun.sleep(50);

  const second = startAsk(cfgDir, server.port, {
    requestId: 'q_duplicate',
    agent: 'claude',
    kind: 'question',
    question: 'Continue again?',
  });
  const stdout = await new Response(second.stdout).text();
  await second.exited;

  expect(stdout).toBe('');
  expect(sendCount).toBe(1);
}, 10_000);

test('tg-ctl ask reserves callback ids while sendMessage is still in flight', async () => {
  const cfgDir = makeCfgDir();
  let sendCount = 0;
  let firstSendStarted = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
      if (url.pathname.endsWith('/sendMessage')) {
        sendCount += 1;
        firstSendStarted = true;
        await Bun.sleep(300);
        return Response.json({ ok: true, result: { message_id: 100 + sendCount } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const first = startAsk(cfgDir, server.port, {
    requestId: 'q_duplicate_inflight',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !firstSendStarted) await Bun.sleep(25);
  expect(firstSendStarted).toBe(true);

  const second = startAsk(cfgDir, server.port, {
    requestId: 'q_duplicate_inflight',
    agent: 'claude',
    kind: 'question',
    question: 'Continue again?',
  });
  const stdout = await new Response(second.stdout).text();
  await second.exited;

  expect(stdout).toBe('');
  expect(sendCount).toBe(1);
}, 10_000);

test('daemon resolves a callback that arrives before sendMessage returns', async () => {
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let callbackServed = false;
  const edited: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !callbackServed) {
          callbackServed = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 250,
                callback_query: {
                  id: 'cb_fast',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 101, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(25);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        callbackData = body.reply_markup.inline_keyboard[0][0].callback_data;
        await Bun.sleep(300);
        return Response.json({ ok: true, result: { message_id: 101 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/editMessageText')) {
        edited.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_fast_callback',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
    options: [{ label: 'A' }],
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  expect(JSON.parse(stdout)).toMatchObject({
    hookSpecificOutput: {
      updatedInput: {
        answers: { 'Continue?': 'A' },
      },
    },
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && edited.length === 0) await Bun.sleep(50);
  expect(edited).toEqual([
    { chat_id: 1, message_id: 101, text: `Question from claude\n\nSource: agent=claude\nCwd: ${cfgDir}\n\nContinue?\n\nSelected answer: A` },
  ]);
}, 10_000);

test('daemon rejects a stale tap from a different Telegram message and accepts the matching one', async () => {
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let staleServed = false;
  let freshServed = false;
  const answered: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !staleServed) {
          staleServed = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 300,
                callback_query: {
                  id: 'cb_stale',
                  from: { id: 1, first_name: 'Alex' },
                  // Same callback key, but the tap belongs to an EARLIER
                  // Telegram message (e.g. an expired prompt that reused the id).
                  message: { message_id: 12, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        if (callbackData && staleServed && !freshServed && answered.length >= 1) {
          freshServed = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 301,
                callback_query: {
                  id: 'cb_fresh',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 130, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(25);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        callbackData = body.reply_markup.inline_keyboard[0][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 130 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answered.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_stale_tap',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
    options: [{ label: 'A' }],
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  // The stale tap was answered "expired" and did NOT resolve the hook; only
  // the tap from the prompt's own message did.
  expect(JSON.parse(stdout)).toMatchObject({
    hookSpecificOutput: {
      updatedInput: {
        answers: { 'Continue?': 'A' },
      },
    },
  });
  expect(answered).toEqual([
    { callback_query_id: 'cb_stale', text: 'expired' },
    { callback_query_id: 'cb_fresh', text: '✓ sent to the agent' },
  ]);
}, 10_000);

test('daemon returns hook output before slow Telegram callback cleanup finishes', async () => {
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let callbackServed = false;
  let cleanupDone = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !callbackServed) {
          callbackServed = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 260,
                callback_query: {
                  id: 'cb_slow_cleanup',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 102, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(25);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        callbackData = body.reply_markup.inline_keyboard[0][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 102 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        // The callback cleanup (acking the tap) is deliberately slow. The ask
        // MUST return the hook answer before this resolves — `cleanupDone` flips
        // only after the 3s block, so asserting it's still false at ask-exit is a
        // deterministic proof the ask did not block on cleanup (no flaky budget).
        await Bun.sleep(3000);
        cleanupDone = true;
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_slow_cleanup',
    agent: 'claude',
    kind: 'question',
    question: 'Continue?',
    options: [{ label: 'A' }],
  });
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  expect(cleanupDone).toBe(false);
  expect(JSON.parse(stdout)).toMatchObject({
    hookSpecificOutput: {
      updatedInput: {
        answers: { 'Continue?': 'A' },
      },
    },
  });
}, 10_000);

// The real daemon owns send completion and socket retirement. HTTP receipt alone
// cannot distinguish a posted card from an in-flight send.
for (const phase of ['posted', 'in-flight'] as const) {
  test(`daemon expires the Telegram prompt when the hook disconnects (${phase})`, async () => {
    const cfgDir = makeCfgDir();
    const edited: unknown[] = [];
    const keyboards: unknown[] = [];
    const sendResponse = Promise.withResolvers<void>();
    let sendStarted = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
        if (url.pathname.endsWith('/sendMessage')) {
          sendStarted = true;
          if (phase === 'in-flight') await sendResponse.promise;
          return Response.json({ ok: true, result: { message_id: 77 } });
        }
        if (url.pathname.endsWith('/editMessageText')) {
          edited.push(await req.json());
          return Response.json({ ok: true, result: true });
        }
        if (url.pathname.endsWith('/editMessageReplyMarkup')) {
          keyboards.push(await req.json());
          return Response.json({ ok: true, result: true });
        }
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);
    try {
      await startDaemon(cfgDir, server.port);
      const ask = startAsk(cfgDir, server.port, {
        requestId: 'q_disconnect',
        agent: 'claude',
        kind: 'question',
        question: 'Continue?',
      });
      const posted = () => readFileSync(join(cfgDir, 'daemon.log'), 'utf8')
        .includes('ask-forward posted: agent=claude kind=question req=q_disconnect');
      const questionsFile = join(cfgDir, 'tg-ctl.123.questions.json');

      if (phase === 'posted') {
        // This acknowledgement is emitted only after the daemon accepts the API response.
        await waitForEvent(posted);
      } else {
        await waitForEvent(() => sendStarted);
        expect(posted()).toBe(false);
        expect(existsSync(questionsFile)).toBe(false);
      }
      ask.kill(9);
      await ask.exited;
      expect(ask.signalCode).toBe('SIGKILL');

      if (phase === 'in-flight') {
        // Retirement persists the question store even for an unscoped dead card.
        // Observe it before releasing HTTP so this exercises post-send reconciliation.
        await waitForEvent(() => existsSync(questionsFile));
        expect(posted()).toBe(false);
        expect(edited).toEqual([]);
        sendResponse.resolve();
      }
      await waitForEvent(() => edited.length > 0 && keyboards.length > 0);
      expect(edited).toEqual([
        { chat_id: 1, message_id: 77, text: 'expired — answer in terminal' },
      ]);
      expect(keyboards).toEqual([
        { chat_id: 1, message_id: 77 },
      ]);
    } finally {
      sendResponse.resolve();
    }
  }, 10_000);
}

async function waitForEvent(observed: () => boolean): Promise<void> {
  const started = Date.now();
  while (!observed() && Date.now() - started < 5000) await Bun.sleep(25);
  expect(observed()).toBe(true);
}

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-buttons-fail-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return cfgDir;
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  // spawnDaemon tracks the proc + cfgDir BEFORE the socket wait, so a missing
  // socket can never leak the spawned daemon.
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
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

function startAsk(cfgDir: string, apiPort: number, request: unknown, extraEnv: Record<string, string> = {}): Subprocess {
  const body = request && typeof request === 'object' && !Array.isArray(request)
    ? { cwd: cfgDir, ...(request as Record<string, unknown>) }
    : request;
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      ...extraEnv,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  trackProc(reg, ask);
  ask.stdin.write(JSON.stringify(body) + '\n');
  ask.stdin.end();
  return ask;
}
