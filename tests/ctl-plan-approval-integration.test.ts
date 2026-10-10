// Full round-trip: a Claude Code ExitPlanMode (plan-approval) BLOCKING prompt is
// piped RAW into `tg-ctl ask` (the installed hook command), forwarded by the live
// daemon to Telegram as Proceed/Keep-planning inline buttons, the CTO taps one,
// and the daemon returns the matching hook output. This is the real path the
// ROADMAP "Forward harness confirmation / permission prompts to TG" item asks for
// — it exercises normalizeHookPayload (raw payload → request) AND the daemon-side
// normalizeButtonRequest (wire → stored request), proving decisionLabels +
// permissionEvent survive both hops, not just the pure helpers.

import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-plan-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

let callbackData: string | null = null;
let callbackServed = false;
const sentMessages: Array<{
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}> = [];

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
      // Permission/plan-approval keyboard is ONE row [allow, deny]; tap deny
      // ("Keep planning") — index [0][1].
      callbackData = body.reply_markup.inline_keyboard[0][1].callback_data;
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
    if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
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

test('raw ExitPlanMode PermissionRequest payload → Proceed/Keep-planning buttons → Keep planning tap returns deny', async () => {
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
  // The RAW Claude Code ExitPlanMode payload as the `PermissionRequest *`
  // catch-all delivers it (the production path — the installer adds no dedicated
  // ExitPlanMode matcher). cwd matches the registration so the guard allows it.
  ask.stdin.write(
    JSON.stringify({
      session_id: 'sess1234',
      cwd: cfgDir,
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '1. Add the route\n2. Wire the handler\n3. Test it' },
    }) + '\n',
  );
  ask.stdin.end();

  const stdout = await new Response(ask.stdout).text();
  await ask.exited;

  // PermissionRequest reply shape (decision.behavior + required hookEventName),
  // deny — we tapped "Keep planning"; the intent rides decision.message, the
  // documented model-facing deny reason, so Claude resumes planning.
  expect(JSON.parse(stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Keep planning' } },
  });
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('Plan ready');
  expect(sentMessages[0].text).toContain('1. Add the route');
  // The buttons read Proceed / Keep planning (not Approve / Reject), single row.
  const row = sentMessages[0].reply_markup.inline_keyboard[0];
  expect(row.map((b) => b.text)).toEqual(['Proceed', 'Keep planning']);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 15_000);
