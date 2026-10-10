import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// Integration coverage for the bare-`/agent` inline-keyboard PICKER (the CTO's
// "где кнопки?" bug). The daemon runs the real `tmux list-panes` + `ps` queries,
// so we put a FAKE tmux + ps on PATH that report THREE claude panes in the same
// numeric window "4" with DISTINCT user-set window names (rig / 3d / ext). We then:
//   1. assert a bare `/agent` posts an inline keyboard (not plain text) whose
//      buttons carry DISTINCT labels from the WINDOW NAMES (tg-cli#75 fix C) — not
//      the cwd basenames the daemon used to fall back to ("hyperide");
//   2. tap one button and assert the select-only confirmation arms the NEXT
//      ordinary message to that pane (with a Cancel button), not just a hint.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-picker-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

// Fake tmux: two list-panes shapes the daemon asks for, keyed by the -F format.
//   PANE_FORMAT  → session\twindow_index\tpane_id\tpane_pid\tcmd\tpath
//   pane→name    → pane_id\twindow_name   (window names are EMPTY → bare "4")
// Three claude panes in session/window "4", distinct cwds.
const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
// tmux log: every non-list-panes invocation (the inject's send-keys/paste) is
// appended here so the round-trip test can assert WHICH pane was injected into.
const tmuxLog = join(cfgDir, 'tmux-invocations.log');
const tmuxScript = `#!/bin/sh
# Only 'list-panes' is exercised by discovery; everything else is logged + no-op.
# 7-field core PANE_FORMAT now carries #{window_name} (field 6, BEFORE the path) so
# the picker labels by the user-set window name (tg-cli#75 fix C). Three claude
# panes in the SAME numeric window "4" but with DISTINCT user-set window names
# (rig / 3d / ext) — the CTO's exact setup ("rig", "3d") rather than the cwd dirs.
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

// Fake ps: each pane pid IS a claude process (findAgentInPane walks from pane_pid
// and matches the 'claude' argv0). A couple of system procs for realism.
const psScript = `#!/bin/sh
printf '    1     0 /sbin/launchd\\n'
printf ' 5001     1 claude --resume\\n'
printf ' 5002     1 claude --resume\\n'
printf ' 5003     1 claude --resume\\n'
exit 0
`;
writeFileSync(join(binDir, 'ps'), psScript, { mode: 0o755 });

let callbackData: string | null = null;
let callbackServed = false;
let plainMsgServed = false;
const sentMessages: Array<Record<string, unknown>> = [];
const editedMessages: Array<Record<string, unknown>> = [];
const answeredCallbacks: unknown[] = [];
const reactions: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      // Honour the long-poll `offset`: never re-serve an update the daemon has
      // already consumed (it advances offset to last_update_id + 1). This makes
      // the harness immune to a double poll re-delivering the same `/agent`.
      const offset = Number(url.searchParams.get('offset') ?? '0');
      // First poll: deliver the bare `/agent` text message. After the picker is
      // posted, deliver a tap on its first button.
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
      if (offset <= 200 && callbackData && !callbackServed) {
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
      // After the select-only tap is answered, deliver an ORDINARY message. The
      // selected agent must consume it; a visual "selected" hint is not enough.
      if (offset <= 300 && callbackServed && answeredCallbacks.length > 0 && !plainMsgServed) {
        plainMsgServed = true;
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
      const body = (await req.json()) as Record<string, unknown>;
      sentMessages.push(body);
      const markup = body.reply_markup as
        | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
        | undefined;
      const firstBtn = markup?.inline_keyboard?.[0]?.[0]?.callback_data;
      if (firstBtn) callbackData = firstBtn;
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      editedMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      answeredCallbacks.push(await req.json());
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

test('bare /agent button selection routes the next ordinary message and offers cancel', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      // Our fake tmux + ps MUST shadow the real ones → binDir first on PATH.
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);

  // Wait for the picker, the tap answer, AND the follow-up ordinary-message inject.
  const tEnd = Date.now() + 10000;
  const injected = (): boolean => {
    const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
    // Per-LINE match (the fake tmux logs one invocation per line): send-keys /
    // paste-buffer and `-t %5001` must be on the SAME line, not merely co-present.
    return /^(send-keys|paste-buffer)\b.*-t %5001\b/m.test(log);
  };
  while (
    Date.now() < tEnd &&
    (sentMessages.length === 0 ||
      answeredCallbacks.length === 0 ||
      !plainMsgServed ||
      !injected() ||
      editedMessages.length < 2 ||
      !reactions.some((r) => r.message_id === 30))
  ) {
    await Bun.sleep(80);
  }

  daemon.kill('SIGTERM');
  await daemon.exited;

  // 1. The bare `/agent` produced an inline keyboard — BUTTONS, not a text list.
  expect(sentMessages.length).toBeGreaterThanOrEqual(1);
  const picker = sentMessages[0];
  const markup = picker.reply_markup as
    | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    | undefined;
  expect(markup).toBeDefined();
  const buttons = markup!.inline_keyboard.flat();
  // one button per agent
  expect(buttons.length).toBe(3);
  // DISTINCT labels from the user-set WINDOW NAMES (tg-cli#75 fix C) — NOT the cwd
  // basenames (which would read "rig · claude", "3d-cli · claude", "hyperide ·
  // claude"). The window name "ext" proves it: its cwd basename is "hyperide", so a
  // cwd-derived label would say "hyperide", a window-name label says "ext".
  const labels = buttons.map((b) => b.text);
  expect(labels).toEqual(['rig · claude', '3d · claude', 'ext · claude']);
  expect(new Set(labels).size).toBe(3);
  // each button is a tga: callback
  expect(buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  // it is a PICKER prompt, NOT the old "address with /agent <window> <message>" text
  expect(String(picker.text)).toContain('Pick an agent');
  expect(String(picker.text)).not.toContain('address with /agent');
  // buttons-only (#63): the message text must NOT duplicate the buttons — no
  // `▸ <window>` group header and no per-agent label line in the body.
  expect(String(picker.text)).not.toContain('▸');
  for (const label of labels) expect(String(picker.text)).not.toContain(label);

  // 2. The tap was acknowledged as a selection and the prompt was edited to the
  //    next-message confirmation with a Cancel button. It must not tell the
  //    user to type `/agent rig <message>`; the selection itself is live state.
  expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb1', text: 'selected' }]);
  expect(editedMessages.length).toBeGreaterThanOrEqual(2);
  const edited = String(editedMessages[0].text);
  expect(edited).toContain('selected rig · claude');
  expect(edited).toContain('next message');
  expect(edited).not.toContain('/agent rig');
  const cancelMarkup = editedMessages[0].reply_markup as
    | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    | undefined;
  expect(cancelMarkup?.inline_keyboard).toEqual([[{ text: 'Cancel', callback_data: expect.stringMatching(/^tgac:/) }]]);

  // 3. The ordinary follow-up message routed to the selected cwd-`rig` pane
  //    %5001, proving the tap armed daemon state rather than only changing text.
  const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  // send-keys / paste-buffer targeting `-t %5001` on the SAME line (per-line, not
  // merely both-present-somewhere) — proves the inject hit the chosen pane.
  expect(/^(send-keys|paste-buffer)\b.*-t %5001\b/m.test(log)).toBe(true);
  // and NOT into a sibling pane
  expect(log).not.toContain('%5002');
  expect(log).not.toContain('%5003');
  expect(String(editedMessages.at(-1)?.text)).toBe('→ rig · claude');
  expect(editedMessages.at(-1)?.reply_markup).toBeUndefined();
  expect(reactions).toContainEqual({
    chat_id: 1,
    message_id: 30,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
}, 25_000);
