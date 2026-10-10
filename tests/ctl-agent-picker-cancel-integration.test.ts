import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-picker-cancel-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux-invocations.log');
writeFileSync(
  join(binDir, 'tmux'),
  `#!/bin/sh
case "$*" in
  *list-panes*)
    printf 's\\t0\\t%%5001\\t5001\\tclaude\\trig\\t/Users/u/xp/rig\\n'
    printf 's\\t1\\t%%5002\\t5002\\tclaude\\text\\t/Users/u/work/hyperide\\n'
    ;;
  *)
    echo "$*" >> "${tmuxLog}"
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
printf ' 5001     1 claude --resume\\n'
printf ' 5002     1 claude --resume\\n'
exit 0
`,
  { mode: 0o755 },
);

let selectCallbackData: string | null = null;
let cancelCallbackData: string | null = null;
let selectServed = false;
let cancelServed = false;
let plainMsgServed = false;
const sentMessages: Array<Record<string, unknown>> = [];
const editedMessages: Array<Record<string, unknown>> = [];
const answeredCallbacks: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && sentMessages.length === 0) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 10,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: Math.floor(Date.now() / 1000),
                text: '/agent',
              },
            },
          ],
        });
      }
      if (offset <= 200 && selectCallbackData && !selectServed) {
        selectServed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 200,
              callback_query: {
                id: 'cb-select',
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: selectCallbackData,
              },
            },
          ],
        });
      }
      if (offset <= 300 && cancelCallbackData && !cancelServed) {
        cancelServed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 300,
              callback_query: {
                id: 'cb-cancel',
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: cancelCallbackData,
              },
            },
          ],
        });
      }
      if (offset <= 400 && cancelServed && answeredCallbacks.some((a) => a.text === 'cancelled') && !plainMsgServed) {
        plainMsgServed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 400,
              message: {
                message_id: 40,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: Math.floor(Date.now() / 1000),
                text: 'hello after cancel',
              },
            },
          ],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sentMessages.push(body);
      if (sentMessages.length === 1) {
        const markup = body.reply_markup as
          | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
          | undefined;
        selectCallbackData = markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? null;
      }
      return Response.json({ ok: true, result: { message_id: 77 + sentMessages.length - 1 } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      const body = (await req.json()) as Record<string, unknown>;
      editedMessages.push(body);
      const markup = body.reply_markup as
        | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
        | undefined;
      cancelCallbackData = markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? cancelCallbackData;
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      answeredCallbacks.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const reg = createDaemonRegistry();

afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('Cancel after bare /agent selection removes the one-shot route', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);

  const tEnd = Date.now() + 10000;
  while (
    Date.now() < tEnd &&
    (sentMessages.length < 2 || !plainMsgServed || !answeredCallbacks.some((a) => a.text === 'cancelled'))
  ) {
    await Bun.sleep(80);
  }

  daemon.kill('SIGTERM');
  await daemon.exited;

  expect(answeredCallbacks.map((a) => a.text)).toContain('selected');
  expect(answeredCallbacks.map((a) => a.text)).toContain('cancelled');
  expect(String(editedMessages.at(-1)?.text)).toContain('cancelled rig · claude');

  const followUpPicker = sentMessages[1];
  expect(String(followUpPicker.text)).toContain('Route to which agent?');
  expect(String(followUpPicker.text)).toContain('hello after cancel');

  const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  expect(log).not.toMatch(/^(send-keys|paste-buffer)\b/m);
}, 25_000);
