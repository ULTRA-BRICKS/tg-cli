import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-buttons-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

let callbackData: string | null = null;
let callbackServed = false;
const sentMessages: unknown[] = [];
const answeredCallbacks: unknown[] = [];
const allowedUpdates: string[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      allowedUpdates.push(url.searchParams.get('allowed_updates') ?? '');
      if (callbackData && !callbackServed) {
        callbackServed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 200,
              callback_query: {
                id: 'cb1',
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: callbackData,
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
      sentMessages.push(body);
      callbackData = body.reply_markup.inline_keyboard[1][0].callback_data;
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      answeredCallbacks.push(await req.json());
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/editMessageText')) {
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

test('tg-ctl ask forwards a Claude question to inline buttons and returns hook output after callback', async () => {
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
  ask.stdin.write(
    JSON.stringify({
      requestId: 'q_123',
      cwd: cfgDir,
      agent: 'claude',
      kind: 'question',
      title: 'Pick deploy target',
      question: 'Where should I deploy?',
      options: [{ label: 'Staging' }, { label: 'Production' }],
    }, null, 2) + '\n',
  );
  ask.stdin.end();

  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  expect(JSON.parse(stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions: [
          {
            header: 'Pick deploy target',
            question: 'Where should I deploy?',
            options: [{ label: 'Staging' }, { label: 'Production' }],
          },
        ],
        answers: { 'Where should I deploy?': 'Production' },
      },
    },
  });
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]).toMatchObject({
    chat_id: 1,
    text: expect.stringContaining('Question from claude'),
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Staging', callback_data: 'tgq:q_123:o0' }],
        [{ text: 'Production', callback_data: 'tgq:q_123:o1' }],
      ],
    },
  });
  expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb1', text: '✓ sent to the agent' }]);
  expect(allowedUpdates.some((v) => decodeURIComponent(v).includes('callback_query'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 15_000);
