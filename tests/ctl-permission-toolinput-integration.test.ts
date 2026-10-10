// PreToolUse permission round trip (tg#5741 review finding): the original
// tool_input must SURVIVE the daemon socket boundary, so an ExitPlanMode
// "Proceed" tap replies allow + `updatedInput` (the live hooks docs: "allow
// alone is not sufficient" for the user-interactive tools). The daemon-side
// normalizeButtonRequest used to drop `toolInput`, silently downgrading the
// reply to a bare allow.
//
// Runs against a LOCAL fake Telegram server (Bun.serve, token `123:abc`,
// chat 1) — nothing ever reaches a real chat.
import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-perm-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

let allowData: string | null = null;
let tapServed = false;
const sentMessages: unknown[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      if (allowData && !tapServed) {
        tapServed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 300,
              callback_query: {
                id: 'cb1',
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 91, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: allowData,
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
      // A permission card is ONE row with [allow, deny] — tap the allow button.
      allowData = body.reply_markup.inline_keyboard[0][0].callback_data;
      return Response.json({ ok: true, result: { message_id: 91 } });
    }
    if (url.pathname.endsWith('/answerCallbackQuery') || url.pathname.endsWith('/editMessageText')) {
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

test('PreToolUse plan-approval Proceed tap replies allow + updatedInput (tool_input survives the socket)', async () => {
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
  // The RAW Claude Code ExitPlanMode PreToolUse payload — hook-normalize turns
  // it into a plan-approval permission carrying the original tool_input.
  ask.stdin.write(
    JSON.stringify({
      session_id: 'abcdef123456',
      cwd: cfgDir,
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do the thing' },
    }) + '\n',
  );
  ask.stdin.end();

  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  // allow + the ECHOED original tool_input — a bare allow is not sufficient for
  // the user-interactive tools per the live hooks docs.
  expect(JSON.parse(stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { plan: 'do the thing' },
    },
  });
  expect(sentMessages).toHaveLength(1);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 15_000);
