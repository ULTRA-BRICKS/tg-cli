import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-picker-stale-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux-invocations.log');
const modeFile = join(cfgDir, 'tmux-mode');
writeFileSync(modeFile, 'both');
writeFileSync(
  join(binDir, 'tmux'),
  `#!/bin/sh
mode=$(cat '${modeFile}' 2>/dev/null || echo both)
case "$*" in
  *list-panes*)
    if [ "$mode" = "both" ]; then printf 's\\t0\\t%%5001\\t5001\\tclaude\\trig\\t/Users/u/xp/rig\\n'; fi
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
let selectServed = false;
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
      if (offset <= 300 && answeredCallbacks.some((a) => a.text === 'selected') && !plainMsgServed) {
        plainMsgServed = true;
        writeFileSync(modeFile, 'ext');
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 300,
              message: {
                message_id: 30,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: Math.floor(Date.now() / 1000),
                text: 'hello after rig died',
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
      editedMessages.push((await req.json()) as Record<string, unknown>);
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

test('selected agent disappearing falls back to normal routing instead of dropping the message', async () => {
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
  const injectedExt = (): boolean => {
    const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
    return /^(send-keys|paste-buffer)\b.*-t %5002\b/m.test(log);
  };
  while (Date.now() < tEnd && (!plainMsgServed || !injectedExt())) {
    await Bun.sleep(80);
  }

  daemon.kill('SIGTERM');
  await daemon.exited;

  const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  expect(/^(send-keys|paste-buffer)\b.*-t %5002\b/m.test(log)).toBe(true);
  expect(log).not.toContain('%5001');
  expect(sentMessages.some((m) => String(m.text).includes('selected rig · claude is no longer running — routing this message normally'))).toBe(true);
  expect(editedMessages.some((m) => String(m.text).includes('selected rig · claude — agent is no longer running'))).toBe(true);
}, 25_000);
