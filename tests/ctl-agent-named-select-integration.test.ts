import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// Regression for `/agent <name>` WITHOUT a message body (tg#6880, tg#7108, repair
// of #158). A confident named selector with no message must SELECT that agent as
// the routing target so the NEXT ordinary message is delivered to it — no button
// tap required. Before the fix the daemon only replied "matched rig — add a
// message: /agent rig <message>" and never armed a route, so the follow-up
// message fell through to the auto-bind discovery instead of the chosen agent.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-named-select-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

// Three claude panes in window "4" with DISTINCT window names (rig / 3d / ext).
const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux-invocations.log');
const tmuxScript = `#!/bin/sh
case "$*" in
  *list-panes*)
    printf '4\\t0\\t%%5001\\t5001\\tnode\\trig\\t/Users/u/xp/rig\\n'
    printf '4\\t0\\t%%5002\\t5002\\tnode\\t3d\\t/Users/u/xp/3d-cli\\n'
    printf '4\\t0\\t%%5003\\t5003\\tnode\\text\\t/Users/u/work/hyperide\\n'
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
printf ' 5002     1 claude --resume\\n'
printf ' 5003     1 claude --resume\\n'
exit 0
`;
writeFileSync(join(binDir, 'ps'), psScript, { mode: 0o755 });

let plainMsgServed = false;
const sentMessages: Array<Record<string, unknown>> = [];
const editedMessages: Array<Record<string, unknown>> = [];
const reactions: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      // First: the bare-body named `/agent rig` (no message).
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
                text: '/agent rig',
              },
            },
          ],
        });
      }
      // After the "selected" card is posted, deliver an ORDINARY message. The
      // selected agent must consume it — a visual hint is not enough.
      if (offset <= 200 && sentMessages.length > 0 && !plainMsgServed) {
        plainMsgServed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 200,
              message: {
                message_id: 20,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: Math.floor(Date.now() / 1000),
                text: 'hello there',
              },
            },
          ],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      editedMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push((await req.json()) as Record<string, unknown>);
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

test('/agent <name> with no message arms the route so the next message reaches that agent', async () => {
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
  const injected = (): boolean => {
    const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
    return /^(send-keys|paste-buffer)\b.*-t %5001\b/m.test(log);
  };
  while (
    Date.now() < tEnd &&
    (sentMessages.length === 0 || !plainMsgServed || !injected() || !reactions.some((r) => r.message_id === 20))
  ) {
    await Bun.sleep(80);
  }

  daemon.kill('SIGTERM');
  await daemon.exited;

  // 1. The named `/agent rig` posted a "selected" confirmation with a Cancel
  //    button — it must NOT be the old "add a message: /agent rig <message>" hint.
  expect(sentMessages.length).toBeGreaterThanOrEqual(1);
  const confirm = sentMessages[0];
  const confirmOrEdited = editedMessages.length > 0 ? String(editedMessages[0].text) : String(confirm.text);
  expect(confirmOrEdited).toContain('selected rig · claude');
  expect(confirmOrEdited).toContain('next message');
  const allTexts = [...sentMessages, ...editedMessages].map((m) => String(m.text)).join('\n');
  expect(allTexts).not.toContain('add a message');
  // The Cancel keyboard is present on the confirmation (sent or subsequently edited on).
  const markups = [...sentMessages, ...editedMessages]
    .map((m) => m.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
    .filter((mk): mk is NonNullable<typeof mk> => !!mk);
  const hasCancel = markups.some((mk) =>
    (mk.inline_keyboard ?? []).flat().some((b) => (b.callback_data ?? '').startsWith('tgac:')),
  );
  expect(hasCancel).toBe(true);

  // 2. The follow-up ordinary message routed to the selected rig pane %5001,
  //    proving the named selection armed daemon state.
  const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  expect(/^(send-keys|paste-buffer)\b.*-t %5001\b/m.test(log)).toBe(true);
  expect(log).not.toContain('%5002');
  expect(log).not.toContain('%5003');
  expect(reactions).toContainEqual({
    chat_id: 1,
    message_id: 20,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
}, 25_000);
