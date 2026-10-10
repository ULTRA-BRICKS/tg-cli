// Multi-question AskUserQuestion end-to-end (tg#5741): a RAW Claude Code
// PreToolUse payload with TWO questions must become TWO sequential Telegram
// cards (the second posts only after the first is answered), and the ask client
// must print ONE combined PreToolUse reply — original tool_input echoed, both
// answers in the `answers` record, `hookEventName` present — so the tool
// completes with no local dialog and no manual Enter.
//
// Everything runs against a LOCAL fake Telegram server (Bun.serve, token
// `123:abc`, chat 1) — nothing ever reaches a real chat.
import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-multiq-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

const sentMessages: Array<{ message_id: number; text: string; callback_data: string }> = [];
const answeredCallbacks: unknown[] = [];
// Each posted card queues a tap on its SECOND option row; getUpdates serves them
// one at a time, so the flow is strictly card → tap → next card → tap.
const pendingTaps: Array<{ update_id: number; message_id: number; data: string }> = [];
let nextMessageId = 77;
let nextUpdateId = 200;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const tap = pendingTaps.shift();
      if (tap) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: tap.update_id,
              callback_query: {
                id: `cb${tap.update_id}`,
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: tap.message_id, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: tap.data,
              },
            },
          ],
        });
      }
      await Bun.sleep(100);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = await req.json();
      const messageId = nextMessageId++;
      const data = body.reply_markup.inline_keyboard[1][0].callback_data;
      sentMessages.push({ message_id: messageId, text: body.text, callback_data: data });
      pendingTaps.push({ update_id: nextUpdateId++, message_id: messageId, data });
      return Response.json({ ok: true, result: { message_id: messageId } });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      answeredCallbacks.push(await req.json());
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/editMessageText') || url.pathname.endsWith('/editMessageReplyMarkup')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const procs: Subprocess[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  server.stop(true);
});

const TOOL_INPUT = {
  questions: [
    {
      header: 'Deploy',
      question: 'Where should I deploy?',
      options: [
        { label: 'Staging', description: 'Safe validation environment' },
        { label: 'Production', description: 'Customer-facing environment' },
      ],
      multiSelect: false,
    },
    {
      header: 'Timing',
      question: 'Deploy when?',
      options: [
        { label: 'Now', description: 'Immediately' },
        { label: 'Tonight', description: 'During the low-traffic window' },
      ],
      multiSelect: false,
    },
  ],
};

test('multi-question AskUserQuestion → two sequential cards → ONE combined hook reply', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);

  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);

  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(ask);
  // The RAW Claude Code hook payload — exactly what the harness pipes in.
  ask.stdin.write(
    JSON.stringify({
      session_id: 'abcdef123456',
      cwd: cfgDir,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: TOOL_INPUT,
    }) + '\n',
  );
  ask.stdin.end();

  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  // ONE combined reply: original tool_input echoed wholesale, both answers
  // present, hookEventName stamped (Claude Code discards the output without it).
  expect(JSON.parse(stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...TOOL_INPUT,
        answers: {
          'Where should I deploy?': 'Production',
          'Deploy when?': 'Tonight',
        },
      },
    },
  });

  // Two cards, in question order, with (i/N) progress titles.
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0].text).toContain('Deploy (1/2)');
  expect(sentMessages[0].text).toContain('Where should I deploy?');
  expect(sentMessages[1].text).toContain('Timing (2/2)');
  expect(sentMessages[1].text).toContain('Deploy when?');
  // Both taps acknowledged as delivered.
  expect(answeredCallbacks).toEqual([
    { callback_query_id: 'cb200', text: '✓ sent to the agent' },
    { callback_query_id: 'cb201', text: '✓ sent to the agent' },
  ]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);
