import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// Integration test: /agent <selector> when the selector matches NO agent must
// send an error reply and NEVER inject into a random "lone remaining" agent.
// This guards the regression where `subset = candidates` + `subset.length === 1`
// silently re-routed to the only visible agent (the [rig]/%2 misroute incident).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-nomatch-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux-invocations.log');

// Fake tmux: exactly ONE agent pane named "rig" in window "4".
// When /agent ext is sent, "ext" should NOT match "rig" → error, no inject.
const tmuxScript = `#!/bin/sh
case "$*" in
  *list-panes*)
    printf '4\\t0\\t%%5001\\t5001\\tnode\\trig\\t/Users/u/xp/agent-tools\\n'
    ;;
  *)
    echo "$*" >> "${tmuxLog}"
    ;;
esac
exit 0
`;
writeFileSync(join(binDir, 'tmux'), tmuxScript, { mode: 0o755 });

// Fake ps: pane 5001 (rig) is claude.
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
      // Deliver /agent ext <message> exactly once.
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
                text: '/agent ext полоски не исправлены',
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
    if (url.pathname.endsWith('/setMyCommands')) {
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

test('/agent ext with no matching agent → error reply, no inject into rig', async () => {
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

  // Wait for the error reply to arrive.
  const tEnd = Date.now() + 8000;
  while (Date.now() < tEnd && sentMessages.length === 0) {
    await Bun.sleep(100);
  }

  expect(daemon.exitCode).toBeNull();

  // Must have sent an error reply (not a picker, not an inject confirmation).
  expect(sentMessages.length).toBeGreaterThanOrEqual(1);
  const reply = sentMessages[0];
  const text = (reply.text as string | undefined) ?? '';
  expect(text).toMatch(/no agent matching ['"]?ext['"]?/i);

  // Must NOT have injected into rig (%5001).
  const tmuxInvocations = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  expect(tmuxInvocations).not.toMatch(/-t %5001/);

  // Must NOT have a picker (inline_keyboard = routing buttons).
  // An error reply has no reply_markup, or reply_markup is null.
  const hasInlineKeyboard = sentMessages.some((m) => {
    const markup = m.reply_markup as { inline_keyboard?: unknown } | undefined;
    return Array.isArray(markup?.inline_keyboard) && (markup.inline_keyboard as unknown[]).length > 0;
  });
  expect(hasInlineKeyboard).toBe(false);
});
