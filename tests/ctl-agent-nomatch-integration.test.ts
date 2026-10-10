import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// Integration coverage for the /agent no-match guard:
// When `/agent <selector> <message>` matches NO running agent, the daemon must:
//   1. Send an error reply naming the unmatched selector + the running agents.
//   2. NOT inject the message into any other agent.
//   3. NOT fall through to a picker.
//
// Pre-fix: the message fell through to `postAgentPicker(all, message)` — when
// only one agent was visible (e.g. only `rig` running), `subset.length === 1`
// auto-injected into that unrelated agent. This test would have failed before
// the fix.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-nomatch-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

// Fake tmux + ps: ONE agent pane (rig/%5001). The user will send `/agent ext
// hello` — "ext" matches nothing, so the daemon must reply with an error and
// never inject into rig.
const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux-invocations.log');
const tmuxScript = `#!/bin/sh
case "$*" in
  *list-panes*)
    printf '4\\t0\\t%%5001\\t5001\\tnode\\trig\\t/Users/u/xp/rig\\n'
    ;;
  *)
    echo "$*" >> "${tmuxLog}"
    ;;
esac
exit 0
`;
writeFileSync(join(binDir, 'tmux'), tmuxScript, { mode: 0o755 });

const psScript = `#!/bin/sh
printf '    1     0 /sbin/launchd\\n'
printf ' 5001     1 claude --resume\\n'
exit 0
`;
writeFileSync(join(binDir, 'ps'), psScript, { mode: 0o755 });

const sentMessages: Array<Record<string, unknown>> = [];
let updateServed = false;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && !updateServed) {
        updateServed = true;
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
                text: '/agent ext hello world',
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
      return Response.json({ ok: true, result: { message_id: 77 } });
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

test('/agent <no-match> sends error reply, never injects into another agent', async () => {
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

  // Wait for the error reply to be sent.
  const tEnd = Date.now() + 8000;
  while (Date.now() < tEnd && sentMessages.length === 0) {
    await Bun.sleep(80);
  }

  daemon.kill('SIGTERM');
  await daemon.exited;

  // 1. Exactly one error message was sent — no picker, no second message.
  expect(sentMessages.length).toBe(1);
  const reply = sentMessages[0];
  // Must be a plain text reply, not an inline keyboard.
  expect(reply.reply_markup).toBeUndefined();
  const text = String(reply.text);
  expect(text).toContain("no agent matching 'ext'");
  // Must name the running agent so the user knows what to type.
  expect(text).toContain('rig');

  // 2. Nothing was injected into the rig pane (%5001).
  const tmuxInvocations = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  expect(tmuxInvocations).not.toContain('%5001');
}, 20_000);
