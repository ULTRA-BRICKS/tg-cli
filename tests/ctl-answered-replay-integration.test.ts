import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

// Regression for tg-cli#97: a question whose stable requestId re-forwards AFTER it
// was answered must REPLAY the stored answer down the socket and post NO second
// card (within the replay window). The in-flight dedup (`activeButtonKeys`) is
// released the instant the question is answered, so without the answered-replay
// cache the re-fire would post a duplicate, superseded card whose tap reads as
// "expired". Past the window the cache entry is pruned, so a genuinely new question
// reusing the same hash still gets a fresh card.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const procs: Subprocess[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const s of servers) s.stop(true);
});

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-replay-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  return cfgDir;
}

async function startDaemon(cfgDir: string, port: number, extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
  return daemon;
}

const PAYLOAD = {
  requestId: 'q_replay',
  agent: 'claude',
  kind: 'question',
  title: 'Pick deploy target',
  question: 'Where should I deploy?',
  options: [{ label: 'Staging' }, { label: 'Production' }],
};

const EXPECTED_ANSWER = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: {
      questions: [
        { header: 'Pick deploy target', question: 'Where should I deploy?', options: [{ label: 'Staging' }, { label: 'Production' }] },
      ],
      answers: { 'Where should I deploy?': 'Production' },
    },
  },
};

function startAsk(cfgDir: string, port: number): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(ask);
  ask.stdin.write(JSON.stringify({ ...PAYLOAD, cwd: cfgDir }, null, 2) + '\n');
  ask.stdin.end();
  return ask;
}

test('a re-forwarded already-answered requestId replays the stored answer and posts no second card', async () => {
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let cb1Served = false;
  let cb2Served = false;
  const sentMessages: unknown[] = [];
  const answeredCallbacks: { callback_query_id: string; text: string }[] = [];

  const tap = (id: string, updateId: number): unknown => ({
    update_id: updateId,
    callback_query: {
      id,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
      data: callbackData,
    },
  });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !cb1Served) {
          cb1Served = true;
          return Response.json({ ok: true, result: [tap('cb1', 200)] });
        }
        // 2nd tap on the SAME (now answered) card → "already answered" toast.
        if (callbackData && cb1Served && !cb2Served && answeredCallbacks.length >= 1) {
          cb2Served = true;
          return Response.json({ ok: true, result: [tap('cb2', 201)] });
        }
        await Bun.sleep(50);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        sentMessages.push(body);
        callbackData = body.reply_markup.inline_keyboard[1][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // 1st forward: posts the card, the tap lands, the hook gets its answer.
  const ask1 = startAsk(cfgDir, server.port);
  const out1 = await new Response(ask1.stdout).text();
  await ask1.exited;
  expect(JSON.parse(out1)).toEqual(EXPECTED_ANSWER);
  expect(sentMessages).toHaveLength(1);

  // A 2nd TAP on the same (now answered) card → "already answered", NOT "expired".
  const t1 = Date.now();
  while (Date.now() - t1 < 5000 && answeredCallbacks.length < 2) await Bun.sleep(50);
  expect(answeredCallbacks).toEqual([
    { callback_query_id: 'cb1', text: '✓ sent to the agent' },
    { callback_query_id: 'cb2', text: 'already answered' },
  ]);

  // 2nd forward of the SAME requestId, AFTER the answer (still in window): REPLAY
  // the stored answer without posting a new card.
  const ask2 = startAsk(cfgDir, server.port);
  const out2 = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out2)).toEqual(EXPECTED_ANSWER);
  expect(sentMessages).toHaveLength(1); // STILL one card — no duplicate

  const log = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(log).toContain('ask-forward replayed-answer');
  expect(log).toContain('ask-answered:'); // the previously-silent answer trace

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('past the replay window the stale entry is pruned and a re-forward posts a FRESH card', async () => {
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let served = 0;
  const sentMessages: unknown[] = [];
  const answeredCallbacks: { callback_query_id: string; text: string }[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        // Serve exactly one tap per posted card, only once the previous tap landed,
        // so each `tg-ctl ask` (real card OR fresh re-forward) gets answered.
        if (callbackData && served === answeredCallbacks.length && served < sentMessages.length) {
          served += 1;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 199 + served,
                callback_query: {
                  id: `cb${served}`,
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(40);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        sentMessages.push(body);
        callbackData = body.reply_markup.inline_keyboard[1][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  // Tiny replay window so the test exercises the past-window prune without a wait.
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_ANSWERED_REPLAY_MS: '150' });

  const ask1 = startAsk(cfgDir, server.port);
  expect(JSON.parse(await new Response(ask1.stdout).text())).toEqual(EXPECTED_ANSWER);
  await ask1.exited;
  expect(sentMessages).toHaveLength(1);

  // Let the 150ms window lapse, then re-forward the SAME requestId. The cache entry
  // is now stale → pruned → a FRESH card is posted (not a silent stale replay).
  await Bun.sleep(400);
  const ask2 = startAsk(cfgDir, server.port);
  expect(JSON.parse(await new Response(ask2.stdout).text())).toEqual(EXPECTED_ANSWER);
  await ask2.exited;
  expect(sentMessages).toHaveLength(2); // stale window → a real second card

  const log = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(log).not.toContain('replayed-answer'); // past the window, nothing was replayed

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('an answered PERMISSION is never replayed — a re-forward posts a fresh card', async () => {
  // The replay cache is scoped to questions: a permission's requestId is also
  // stable, but silently re-applying a prior allow/deny without re-prompting would
  // be a behavioral/security change. Re-forwarding an answered permission must post
  // a FRESH card and re-ask, not replay the decision (tg-cli#97).
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let served = 0;
  const sentMessages: unknown[] = [];
  const answeredCallbacks: { callback_query_id: string; text: string }[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && served === answeredCallbacks.length && served < sentMessages.length) {
          served += 1;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 199 + served,
                callback_query: {
                  id: `cb${served}`,
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(40);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        sentMessages.push(body);
        // A permission card is one row: [Approve(allow), Reject(deny)]. Tap Approve.
        callbackData = body.reply_markup.inline_keyboard[0][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  const permPayload = {
    requestId: 'p_noreplay',
    cwd: cfgDir,
    agent: 'claude',
    kind: 'permission',
    title: 'Bash',
    question: 'Allow Bash? rm -rf /tmp/x',
    permissionEvent: 'PreToolUse',
    toolInput: { command: 'rm -rf /tmp/x' },
  };
  const ask = (): Subprocess => {
    const p = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
      env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(p);
    p.stdin.write(JSON.stringify(permPayload, null, 2) + '\n');
    p.stdin.end();
    return p;
  };

  // toolInput now SURVIVES the daemon's socket-side normalize (tg#5741 review
  // fix), so a PreToolUse allow echoes it back as updatedInput (the hooks docs:
  // "allow alone is not sufficient" for user-interactive tools). This test only
  // cares that the decision is re-asked (a fresh card), not replayed.
  const expectedPerm = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: 'rm -rf /tmp/x' },
    },
  };

  const ask1 = ask();
  expect(JSON.parse(await new Response(ask1.stdout).text())).toEqual(expectedPerm);
  await ask1.exited;
  expect(sentMessages).toHaveLength(1);

  // Re-forward the SAME permission requestId immediately (well within any window):
  // it must NOT replay — a fresh card is posted and the decision is asked again.
  const ask2 = ask();
  expect(JSON.parse(await new Response(ask2.stdout).text())).toEqual(expectedPerm);
  await ask2.exited;
  expect(sentMessages).toHaveLength(2); // re-asked, not replayed

  const log = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(log).not.toContain('replayed-answer');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('a tap on an aged-out already-answered card reads "expired", not "already answered"', async () => {
  // The toast path gates "already answered" on the same replay window as the hook
  // path: past the window the entry is treated as expired, so the two never
  // disagree on whether a key is still "answered" vs aged-out.
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let cb1Served = false;
  let cb2Served = false;
  let allowStaleTap = false;
  const sentMessages: unknown[] = [];
  const answeredCallbacks: { callback_query_id: string; text: string }[] = [];

  const tap = (id: string, updateId: number): unknown => ({
    update_id: updateId,
    callback_query: {
      id,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
      data: callbackData,
    },
  });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !cb1Served) {
          cb1Served = true;
          return Response.json({ ok: true, result: [tap('cb1', 200)] });
        }
        // A 2nd tap on the SAME card, but only AFTER the window has lapsed.
        if (callbackData && allowStaleTap && !cb2Served) {
          cb2Served = true;
          return Response.json({ ok: true, result: [tap('cb2', 201)] });
        }
        await Bun.sleep(40);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        sentMessages.push(body);
        callbackData = body.reply_markup.inline_keyboard[1][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_ANSWERED_REPLAY_MS: '150' });

  const ask1 = startAsk(cfgDir, server.port);
  expect(JSON.parse(await new Response(ask1.stdout).text())).toEqual(EXPECTED_ANSWER);
  await ask1.exited;
  const t1 = Date.now();
  while (Date.now() - t1 < 5000 && answeredCallbacks.length < 1) await Bun.sleep(50);

  // Let the window lapse, then tap the old card: no live prompt + an AGED entry →
  // "expired", not "already answered".
  await Bun.sleep(400);
  allowStaleTap = true;
  const t2 = Date.now();
  while (Date.now() - t2 < 5000 && answeredCallbacks.length < 2) await Bun.sleep(50);
  expect(answeredCallbacks).toEqual([
    { callback_query_id: 'cb1', text: '✓ sent to the agent' },
    { callback_query_id: 'cb2', text: 'expired' },
  ]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('both AskUserQuestion matchers firing yields exactly ONE card (the PermissionRequest copy is dropped)', async () => {
  // End-to-end stitch for Fix B: Claude fires both PreToolUse:AskUserQuestion AND
  // the PermissionRequest:* catch-all for the same question. The catch-all copy
  // must be dropped at normalize (no card, no socket connect); only the dedicated
  // PreToolUse copy forwards. Net: exactly one card.
  const cfgDir = makeCfgDir();
  let callbackData: string | null = null;
  let served = 0;
  const sentMessages: unknown[] = [];
  const answeredCallbacks: { callback_query_id: string; text: string }[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && served === answeredCallbacks.length && served < sentMessages.length) {
          served += 1;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 199 + served,
                callback_query: {
                  id: `cb${served}`,
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(40);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        sentMessages.push(body);
        callbackData = body.reply_markup.inline_keyboard[1][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // A RAW Claude hook payload for AskUserQuestion (tool_name + tool_input), as the
  // harness pipes it — normalize runs in the `tg-ctl ask` client.
  const rawAsk = (event: string): Subprocess => {
    const p = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
      env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(p);
    p.stdin.write(
      JSON.stringify({
        session_id: 'sess1234',
        cwd: cfgDir,
        hook_event_name: event,
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ header: 'Deploy', question: 'Where to deploy?', options: [{ label: 'Staging' }, { label: 'Prod' }] }] },
      }) + '\n',
    );
    p.stdin.end();
    return p;
  };

  // The PermissionRequest copy of the catch-all: dropped at normalize → emits
  // nothing, never posts a card.
  const dropped = rawAsk('PermissionRequest');
  expect((await new Response(dropped.stdout).text()).trim()).toBe('');
  await dropped.exited;
  expect(sentMessages).toHaveLength(0);

  // The dedicated PreToolUse copy of the SAME question forwards → posts the card,
  // the tap completes it.
  const forwarded = rawAsk('PreToolUse');
  const out = await new Response(forwarded.stdout).text();
  await forwarded.exited;
  expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  expect(sentMessages).toHaveLength(1); // exactly one card across both matchers

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);
