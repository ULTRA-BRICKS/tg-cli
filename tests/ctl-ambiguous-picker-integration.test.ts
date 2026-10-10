import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// tg-cli#72: an ambiguous route / a reply to a GONE agent must post the inline-
// keyboard PICKER (tappable buttons, like /agent) — NOT the old plain-text
// "ambiguous target — candidates:" dump. When the addressed agent is gone the
// picker must SAY so ("That agent (<label>) is no longer running"). Tapping a
// button routes to the chosen pane. The recognized-single-target happy path still
// injects directly (no picker).
//
// Drives the REAL daemon against a fake Telegram + a fake tmux/ps. Two agents
// mirror the CTO's screenshot: %0 = hyperide, %2 = agent-tools.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const PANE_HYPER = '%0';
const PID_HYPER = 9000;
const PANE_TOOLS = '%2';
const PID_TOOLS = 2002;

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

// tmux shim. Pane visibility depends on <cfgDir>/tmux-mode:
//   "both"  → both agent panes visible (the ambiguous case)
//   "tools" → ONLY %2 visible (hyperide's pane %0 is GONE — the reply-to-gone case)
//   "hyper" → ONLY %0 visible (single agent → happy path direct inject)
// Every `send-keys -t <pane> -l <text>` and multi-line `paste-buffer -t <pane>`
// is logged as "<pane>\t…" so the test can assert WHICH pane received the inject.
function fakeTmux(cfgDir: string, dirHyper: string, dirTools: string, injectLog: string): string {
  const tmuxBuffer = join(cfgDir, 'tmux-buffer.txt');
  return `#!/bin/sh
sub="$1"; shift
mode=$(cat '${join(cfgDir, 'tmux-mode')}' 2>/dev/null || echo both)
case "$sub" in
  list-panes)
    show_hyper=0; show_tools=0; hyper_path='${dirHyper}'
    case "$mode" in
      both)  show_hyper=1; show_tools=1;;
      tools) show_tools=1;;
      hyper) show_hyper=1;;
      # hyper-nopath: hyperide live but reports NO pane_current_path (tmux gives
      # an empty field) — exercises recordLastUserTarget's no-cwd/invalidate
      # branch (review finding: untested).
      hyper-nopath) show_hyper=1; hyper_path='';;
    esac
    # 7-field core PANE_FORMAT carries #{window_name} (field 6, before the path) —
    # the daemon reads window names from the core snapshot now (tg-cli#75), not a
    # separate call. The CTO's screenshot window names: 'hyperide', 'agent-tools'.
    [ "$show_hyper" = "1" ] && printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'shyper' '4' '${PANE_HYPER}' '${PID_HYPER}' 'claude' 'hyperide' "$hyper_path"
    [ "$show_tools" = "1" ] && printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'stools' '4' '${PANE_TOOLS}' '${PID_TOOLS}' 'claude' 'agent-tools' '${dirTools}'
    ;;
  display-message)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ "$pane" = "${PANE_HYPER}" ]; then printf '%s\\n' '${dirHyper}'
    elif [ "$pane" = "${PANE_TOOLS}" ]; then printf '%s\\n' '${dirTools}'
    else printf 'main\\n'; fi
    ;;
  send-keys)
    pane=""; text=""; is_enter=0
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then text="$2"; fi
      if [ "$1" = "Enter" ]; then is_enter=1; fi
      shift
    done
    if [ "$is_enter" = "0" ] && [ -n "$pane" ]; then printf '%s\\t%s\\n' "$pane" "$text" >> '${injectLog}'; fi
    ;;
  load-buffer)
    cat > '${tmuxBuffer}'
    ;;
  paste-buffer)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ -n "$pane" ]; then
      printf '%s\\t' "$pane" >> '${injectLog}'
      cat '${tmuxBuffer}' >> '${injectLog}' 2>/dev/null || true
      printf '\\n' >> '${injectLog}'
    fi
    ;;
esac
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PID_HYPER}' '1' 'claude'
printf '%s %s %s\\n' '${PID_TOOLS}' '1' 'claude'
exit 0
`;
}

interface Harness {
  cfgDir: string;
  dirHyper: string;
  dirTools: string;
  injectLog: string;
  setMode: (m: 'both' | 'tools' | 'hyper' | 'hyper-nopath') => void;
}

// `regs` lets a test register one or both agents (the per-pane registration SET).
function makeHarness(regs: Array<{ paneId: string; cwd: string }>, routes: unknown[] = []): Harness {
  const cfgDir = tempDir('tgctl-ambig-');
  const dirHyper = join(cfgDir, 'hyperide');
  const dirTools = join(cfgDir, 'agent-tools');
  mkdirSync(dirHyper, { recursive: true });
  mkdirSync(dirTools, { recursive: true });
  const injectLog = join(cfgDir, 'inject.log');

  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify(regs));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify(routes));

  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, dirHyper, dirTools, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'tmux-mode'), 'both');

  return { cfgDir, dirHyper, dirTools, injectLog, setMode: (m) => writeFileSync(join(cfgDir, 'tmux-mode'), m) };
}

function injectedLines(injectLog: string): string[] {
  if (!existsSync(injectLog)) return [];
  return readFileSync(injectLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

interface SentMessage {
  text: string;
  hasMarkup: boolean;
  buttons: Array<{ text: string; callback_data: string }>;
}

interface FakeReaction {
  messageId: number;
  emoji: string;
}

interface FakeTg {
  port: number;
  pushText: (updateId: number, messageId: number, text: string) => void;
  pushReply: (updateId: number, messageId: number, replyToId: number, text: string) => void;
  pushPhoto: (updateId: number, messageId: number, caption?: string, replyToId?: number) => void;
  pushCallback: (updateId: number, data: string, onMessageId: number) => void;
  sends: SentMessage[];
  reactions: FakeReaction[];
  stop: () => void;
}

function startFakeTg(): FakeTg {
  const queue: unknown[][] = [];
  const sends: SentMessage[] = [];
  const reactions: FakeReaction[] = [];
  let delivered = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (delivered < queue.length) {
          const batch = queue[delivered];
          delivered += 1;
          return Response.json({ ok: true, result: batch });
        }
        await Bun.sleep(150);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as {
          text: string;
          reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
        };
        const rows = body.reply_markup?.inline_keyboard ?? [];
        sends.push({
          text: body.text,
          hasMarkup: body.reply_markup !== undefined,
          buttons: rows.flat(),
        });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        const body = (await req.json()) as {
          message_id: number;
          reaction?: Array<{ type: string; emoji?: string }>;
        };
        for (const r of body.reaction ?? []) {
          reactions.push({ messageId: body.message_id, emoji: r.emoji ?? '' });
        }
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getFile')) {
        return Response.json({ ok: true, result: { file_path: 'photos/shot.jpg' } });
      }
      if (url.pathname.includes('/file/bot')) {
        return new Response('JPEGDATA');
      }
      // answerCallbackQuery / editMessageText — all OK.
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const nowSec = (): number => Math.floor(Date.now() / 1000);
  return {
    port: server.port,
    sends,
    reactions,
    pushText: (updateId, messageId, text) => {
      queue.push([
        { update_id: updateId, message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec(), text } },
      ]);
    },
    pushReply: (updateId, messageId, replyToId, text) => {
      queue.push([
        {
          update_id: updateId,
          message: {
            message_id: messageId,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: nowSec(),
            text,
            reply_to_message: { message_id: replyToId, date: nowSec(), chat: { id: 1 }, text: 'orig' },
          },
        },
      ]);
    },
    pushPhoto: (updateId, messageId, caption, replyToId) => {
      queue.push([
        {
          update_id: updateId,
          message: {
            message_id: messageId,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: nowSec(),
            ...(caption !== undefined ? { caption } : {}),
            ...(replyToId !== undefined
              ? { reply_to_message: { message_id: replyToId, date: nowSec(), chat: { id: 1 }, text: 'orig' } }
              : {}),
            photo: [
              { file_id: 'photo-small', file_size: 100 },
              { file_id: 'photo-large', file_size: 1024 },
            ],
          },
        },
      ]);
    },
    pushCallback: (updateId, data, onMessageId) => {
      queue.push([
        {
          update_id: updateId,
          callback_query: {
            id: `cb${updateId}`,
            from: { id: 1, first_name: 'Alex' },
            message: { message_id: onMessageId, chat: { id: 1 }, date: nowSec() },
            data,
          },
        },
      ]);
    },
    stop: () => server.stop(true),
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await Bun.sleep(50);
  }
}

const pickerOf = (sends: SentMessage[]): SentMessage | undefined => sends.find((s) => s.hasMarkup);
const reactionEmojis = (reactions: FakeReaction[], messageId: number): string[] =>
  reactions.filter((r) => r.messageId === messageId).map((r) => r.emoji);

test('AMBIGUOUS plain message, NO last message → inline-keyboard picker (buttons, NO "candidates:" text dump)', async () => {
  // Two registered agents, both live, and routes.json is EMPTY (no last message in
  // the chat) → pickTargetPaneFromSet returns ambiguous and the no-reply last-message
  // bind has nothing to prefer, so the picker is the correct outcome (tg-cli#78).
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' }, // cwd empty so tier-3 cwd match can't collapse it
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(700, 20, 'do the thing');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(200);

  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  // It is a PICKER, not a text dump.
  expect(picker!.text).not.toContain('candidates:');
  expect(picker!.text).not.toContain('ambiguous target');
  // One button per live candidate, with distinct project labels.
  expect(picker!.buttons.length).toBe(2);
  const labels = picker!.buttons.map((b) => b.text).join(' | ');
  expect(labels).toContain('hyperide');
  expect(labels).toContain('agent-tools');
  // Buttons carry tga: callback data (the /agent picker callback path).
  expect(picker!.buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  // No silent inject while the human picks.
  expect(injectedLines(h.injectLog).length).toBe(0);
  await waitFor(() => tg.reactions.some((r) => r.messageId === 20));
  expect(reactionEmojis(tg.reactions, 20)).toEqual(['✍️']);
}, 15_000);

test('NO-REPLY plain message: an agent merely POSTING last (routes.json) is NOT an anchor — asks (tg-cli#78 anchor fix)', async () => {
  // Two registered live agents, and agent-tools (%2) sent the CTO an unprompted
  // outbound message (routes.json's newest entry — e.g. an agent proactively
  // reporting status). Before the anchor fix, this alone would silently bind the
  // CTO's next non-reply message to %2 — the exact live incident (an unrelated
  // agent's inbound-to-CTO message hijacking his very next message). With NO
  // last-user-target recorded, "who merely spoke last" is no longer a valid
  // signal at all: this must stay ambiguous and ask, never guess.
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness(
    [
      { paneId: PANE_HYPER, cwd: '' },
      { paneId: PANE_TOOLS, cwd: '' },
    ],
    [
      { id: 400, paneId: PANE_HYPER, cwd: '', ts: now - 60 },
      { id: 401, paneId: PANE_TOOLS, cwd: '', ts: now }, // agent-tools posted LAST (unprompted)
    ],
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(706, 30, 'continue where we left off');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(200);

  // Asked via the picker — NOT silently bound to whichever agent merely spoke last.
  expect(pickerOf(tg.sends)).toBeDefined();
  expect(injectedLines(h.injectLog).length).toBe(0);
}, 15_000);

test('NO-REPLY plain message binds to the CTO\'s OWN last-addressed pane, ignoring a MORE RECENT unrelated agent post (tg-cli#78 anchor fix)', async () => {
  // The exact reported incident: an unrelated agent (agent-tools, standing in for
  // "ext-cc") posts the newest routes.json entry — AFTER the CTO's own last
  // resolved delivery went to hyperide. A fresh non-reply message must still land
  // on hyperide (where the CTO was last addressing), never hijacked by the
  // just-arrived unrelated post, even though that post is objectively more recent.
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness(
    [
      { paneId: PANE_HYPER, cwd: '' },
      { paneId: PANE_TOOLS, cwd: '' },
    ],
    [
      { id: 410, paneId: PANE_HYPER, cwd: '', ts: now - 60 },
      { id: 411, paneId: PANE_TOOLS, cwd: '', ts: now }, // agent-tools posted MOST RECENTLY (unprompted)
    ],
  );
  // The CTO's own last resolved delivery went to hyperide, BEFORE agent-tools' post.
  writeFileSync(
    join(h.cfgDir, 'tg-ctl.123.last-user-target.json'),
    JSON.stringify({ paneId: PANE_HYPER, cwd: h.dirHyper, ts: now - 30 }),
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(707, 32, 'ship it');

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(200);

  expect(pickerOf(tg.sends)).toBeUndefined();
  const lines = injectedLines(h.injectLog);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(false);
  expect(lines.join('\n')).toContain('ship it');
}, 15_000);

test('PHOTO reply routes to the replied-to origin pane after download, not the last-message agent', async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  writeFileSync(
    join(h.cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([
      { id: 900, paneId: PANE_HYPER, cwd: h.dirHyper, ts: now - 60 },
      { id: 901, paneId: PANE_TOOLS, cwd: h.dirTools, ts: now },
    ]),
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushPhoto(710, 40, 'screenshot says route error', 900);

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await waitFor(() => tg.reactions.some((r) => r.messageId === 40 && r.emoji === '👀'));
  await Bun.sleep(200);

  expect(pickerOf(tg.sends)).toBeUndefined();
  const lines = injectedLines(h.injectLog);
  const joined = lines.join('\n');
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(false);
  expect(joined).toContain('↩ tg#900');
  expect(joined).toContain('sent photo:');
  expect(joined).toContain('screenshot says route error');
  expect(readFileSync(join(h.cfgDir, '.cache', 'tg-cli', 'inbound', '710.jpg'), 'utf8')).toBe('JPEGDATA');
  expect(reactionEmojis(tg.reactions, 40)).toEqual(['👀']);
}, 15_000);

test('PHOTO caption /agent routes media to the selected agent instead of the last-message agent', async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness(
    [
      { paneId: PANE_HYPER, cwd: '' },
      { paneId: PANE_TOOLS, cwd: '' },
    ],
    [{ id: 910, paneId: PANE_TOOLS, cwd: '', ts: now }],
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushPhoto(711, 41, '/agent hyperide\nlook at this route error');

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await waitFor(() => tg.reactions.some((r) => r.messageId === 41 && r.emoji === '👀'));
  await Bun.sleep(200);

  expect(pickerOf(tg.sends)).toBeUndefined();
  const lines = injectedLines(h.injectLog);
  const joined = lines.join('\n');
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(false);
  expect(joined).toContain('sent photo:');
  expect(joined).toContain('look at this route error');
  expect(joined).not.toContain('/agent hyperide');
  expect(reactionEmojis(tg.reactions, 41)).toEqual(['👀']);
}, 15_000);

test('PHOTO reply with /agent caption follows the selected agent, not the replied-to origin', async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  writeFileSync(
    join(h.cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 920, paneId: PANE_TOOLS, cwd: h.dirTools, ts: now }]),
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushPhoto(712, 42, '/agent hyperide\nlook at this route error', 920);

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await waitFor(() => tg.reactions.some((r) => r.messageId === 42 && r.emoji === '👀'));
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  const joined = lines.join('\n');
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(false);
  expect(joined).toContain('look at this route error');
  expect(joined).not.toContain('↩ tg#920');
  expect(joined).not.toContain('/agent hyperide');
  expect(reactionEmojis(tg.reactions, 42)).toEqual(['👀']);
}, 15_000);

test('PHOTO caption bare /agent opens a picker and the tap injects the prewrapped receipt once', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushPhoto(713, 43, '/agent');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  const picker = pickerOf(tg.sends)!;
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools'))!;
  expect(toolsBtn).toBeDefined();
  expect(injectedLines(h.injectLog).length).toBe(0);
  await waitFor(() => reactionEmojis(tg.reactions, 43).includes('✍️'));
  expect(reactionEmojis(tg.reactions, 43)).toEqual(['✍️']);

  tg.pushCallback(714, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);

  await waitFor(() => injectedLines(h.injectLog).length > 0);
  await waitFor(() => tg.reactions.some((r) => r.messageId === 43 && r.emoji === '👀'));
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  const joined = lines.join('\n');
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
  expect(joined).toContain('sent photo:');
  expect(joined).not.toContain('/agent');
  expect(joined.match(/\[TG from Alex tg#43\]/g) ?? []).toHaveLength(1);
  expect(reactionEmojis(tg.reactions, 43)).toEqual(['✍️', '👀']);
}, 15_000);

test('PHOTO caption /agent with no matching selector reports the miss and never falls back to another agent', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushPhoto(715, 44, '/agent missing-agent\nthis should not auto-bind');

  await waitFor(() => tg.sends.some((s) => s.text.includes("no agent matching 'missing-agent'")));
  await Bun.sleep(200);

  expect(injectedLines(h.injectLog).length).toBe(0);
  expect(pickerOf(tg.sends)).toBeUndefined();
  expect(reactionEmojis(tg.reactions, 44)).not.toContain('👀');
}, 15_000);

test('PHOTO caption /agent with a GONE selector falls back to the last-user-target anchor, never a silent drop', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  // The CTO's own last confirmed target: agent-tools (%2) — the closest available
  // proxy tg-ctl has for "whoever was addressing the now-gone 'ghost'" (see
  // agent-match.ts's "gone-agent (dead subagent) fallback" comment).
  writeFileSync(
    join(h.cfgDir, 'tg-ctl.123.last-user-target.json'),
    JSON.stringify({ paneId: PANE_TOOLS, cwd: h.dirTools, ts: Math.floor(Date.now() / 1000) }),
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushPhoto(716, 45, '/agent ghost please pick this up');

  await waitFor(() => injectedLines(h.injectLog).length > 0);
  await waitFor(() => tg.sends.some((s) => s.text.includes("agent 'ghost' is gone")));
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
  const reply = tg.sends.find((s) => s.text.includes('ghost'))!;
  expect(reply.text).toContain('your last active session');
}, 15_000);

test('NO-REPLY bind: last-message agent GONE → never guesses into the gone pane (no fabricated button)', async () => {
  // The last message came from hyperide (%0), but %0 is now GONE (mode "tools" → only
  // agent-tools %2 is live). The anchor bind must NOT inject into the gone %0 nor
  // fabricate a button for it. (resolveLastUserTarget's own pane-id-reuse guard —
  // a recorded cwd that no longer matches the live pane — is covered directly by
  // "PANE-ID REUSE GUARD" in ctl-reply-misroute-integration.test.ts; with a SINGLE
  // live agent the SET tier may legitimately resolve to %2 directly, so the
  // integration invariant here is only "never the gone pane", #49 safety.)
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness(
    [
      { paneId: PANE_HYPER, cwd: '' },
      { paneId: PANE_TOOLS, cwd: '' },
    ],
    [{ id: 420, paneId: PANE_HYPER, cwd: '', ts: now }], // last message from the now-gone %0
  );
  const tg = startFakeTg();
  h.setMode('tools'); // %0 gone, only %2 live
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(708, 34, 'where did everyone go');

  // With only ONE live agent the SET tier may resolve directly to %2 (a single live
  // registered pane is unambiguous) — that is acceptable; the invariant under test is
  // that the GUESS path never fabricates %0 and never injects into the gone pane.
  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(200);

  // Nothing was injected into the gone %0, and no button was ever offered for it.
  expect(injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
  const picker = pickerOf(tg.sends);
  if (picker) expect(picker.buttons.some((b) => b.text.includes('hyperide'))).toBe(false);
}, 15_000);

test('TAP a button → routes the pending message to the chosen pane', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(700, 20, 'route me');
  await waitFor(() => pickerOf(tg.sends) !== undefined);

  const picker = pickerOf(tg.sends)!;
  // Tap the agent-tools button.
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools'))!;
  expect(toolsBtn).toBeDefined();
  // The picker was sent as messageId 9001 (first send). The callback must come
  // from that same message (the daemon checks message_id equality).
  tg.pushCallback(701, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);

  await waitFor(() => injectedLines(h.injectLog).length > 0);
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  // The tap injected into %2 (agent-tools) and NOT %0 (hyperide)…
  const toolsLines = lines.filter((l) => l.startsWith(`${PANE_TOOLS}\t`));
  expect(toolsLines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
  // …carrying the ORIGINAL message text (deferText routed verbatim), not an empty
  // or wrong payload. The wrapped inject embeds the raw '{msg}' so 'route me' is
  // present in what reached the pane (guards a wrapping/content regression).
  expect(toolsLines.join('\n')).toContain('route me');
  await waitFor(() => tg.reactions.some((r) => r.messageId === 20 && r.emoji === '👀'));
  expect(reactionEmojis(tg.reactions, 20)).toEqual(['✍️', '👀']);
}, 15_000);

// Regression for GH-274: handleAgentCallback's NOT-prewrapped branch (a picker
// spawned from a plain ambiguous message, not a reply-quote) calls the same
// injectToPane(..., pending.sourceMessageId) as the confident-selector direct
// route — this proves the tg#<id> tag survives THAT call site too, not only
// the direct-route one covered by ctl-agent-route-message-id-integration.
test('TAP a button on an ambiguous picker → injected text still carries the tg#<id> wrap tag (GH-274)', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(700, 4242, 'route me');
  await waitFor(() => pickerOf(tg.sends) !== undefined);

  const picker = pickerOf(tg.sends)!;
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools'))!;
  expect(toolsBtn).toBeDefined();
  tg.pushCallback(701, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);

  await waitFor(() => injectedLines(h.injectLog).length > 0);
  await Bun.sleep(200);

  const toolsLines = injectedLines(h.injectLog).filter((l) => l.startsWith(`${PANE_TOOLS}\t`));
  expect(toolsLines.length).toBeGreaterThan(0);
  // The inbound message's own id (4242) must be threaded through the picker
  // tap, same as every other inbound path — this is what lets the agent
  // answer back with `tg --reply-to 4242`.
  expect(toolsLines.join('\n')).toContain('tg#4242');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 15_000);

test('PICKER TAP updates the anchor: the NEXT ambiguous message follows the tapped pane, no second picker', async () => {
  // Review finding (P1): explicit CTO routing via a picker tap previously never
  // updated the anchor, so an ambiguous fleet could ask forever even after the
  // CTO had already picked once. Confirm the tap now records last-user-target.
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(710, 36, 'first ambiguous message');
  await waitFor(() => pickerOf(tg.sends) !== undefined);
  const picker = pickerOf(tg.sends)!;
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools'))!;
  tg.pushCallback(711, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);
  await waitFor(() => injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_TOOLS}\t`)));
  await Bun.sleep(200);

  const pickerCountBefore = tg.sends.filter((s) => s.hasMarkup).length;

  // A SECOND, unrelated ambiguous message — must bind directly to %2 (agent-tools,
  // the tapped pane) via the anchor, with NO new picker.
  tg.pushText(712, 37, 'second message, same session please');
  await waitFor(() => injectedLines(h.injectLog).filter((l) => l.startsWith(`${PANE_TOOLS}\t`)).length >= 2);
  await Bun.sleep(200);

  const pickerCountAfter = tg.sends.filter((s) => s.hasMarkup).length;
  expect(pickerCountAfter).toBe(pickerCountBefore); // no additional picker posted
  const lines = injectedLines(h.injectLog);
  expect(lines.filter((l) => l.startsWith(`${PANE_TOOLS}\t`)).length).toBe(2);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
}, 15_000);

test('REPLY to a now-GONE agent → picker WITH "no longer running" notice naming the gone agent', async () => {
  // routes.json: outbound message 500 originated from the hyperide agent (%0).
  // mode "tools": %0 is GONE (only agent-tools %2 is live). The reply's recognized
  // origin is gone → the picker must say so and offer the live agent(s).
  const h = makeHarness(
    [{ paneId: PANE_TOOLS, cwd: '' }],
    [{ id: 500, paneId: PANE_HYPER, cwd: '', ts: Math.floor(Date.now() / 1000) }],
  );
  // Record the route with the hyperide cwd so the gone label reads "hyperide".
  writeFileSync(
    join(h.cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 500, paneId: PANE_HYPER, cwd: h.dirHyper, ts: Math.floor(Date.now() / 1000) }]),
  );
  const tg = startFakeTg();
  h.setMode('tools'); // hyperide gone, agent-tools live
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushReply(702, 22, 500, 'reply meant for the now-gone hyperide agent');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(200);

  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  // Says the agent is gone, and NAMES it (cwd basename → "hyperide").
  expect(picker!.text).toContain('no longer running');
  expect(picker!.text).toContain('hyperide');
  // No plain-text candidate dump.
  expect(picker!.text).not.toContain('candidates:');
  // The live agent is a button to pick.
  expect(picker!.buttons.some((b) => b.text.includes('agent-tools'))).toBe(true);
  // No silent inject into the surviving agent.
  expect(injectedLines(h.injectLog).length).toBe(0);

  await waitFor(() => tg.reactions.some((r) => r.messageId === 22));
  expect(reactionEmojis(tg.reactions, 22)).toEqual(['✍️']);

  const toolsBtn = picker!.buttons.find((b) => b.text.includes('agent-tools'))!;
  tg.pushCallback(703, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker!) + 1);

  await waitFor(() => injectedLines(h.injectLog).length > 0);
  await waitFor(() => tg.reactions.some((r) => r.messageId === 22 && r.emoji === '👀'));
  expect(reactionEmojis(tg.reactions, 22)).toEqual(['✍️', '👀']);
}, 15_000);

test('HAPPY PATH: a single registered live agent → direct inject, NO picker', async () => {
  // Only hyperide registered + visible → unambiguous, inject directly.
  const h = makeHarness([{ paneId: PANE_HYPER, cwd: '' }]);
  const tg = startFakeTg();
  h.setMode('hyper');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(703, 24, 'just do it');

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  // Injected straight into %0 — and NO picker posted.
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(true);
  expect(pickerOf(tg.sends)).toBeUndefined();
}, 15_000);

test('ORDINARY auto-bound delivery records the anchor: a later-ambiguous message follows it, no picker (recordIfAutoBound coverage)', async () => {
  // The MAIN write path (review finding: untested) — an everyday auto-bound
  // delivery, not a picker tap or a reply. Both agents are REGISTERED, but only
  // hyperide is visible at first, so message 1 resolves unambiguously (single
  // live registered pane) straight through injectViaTarget's ordinary success
  // path. Once agent-tools also comes up, message 2 is genuinely ambiguous at
  // the registration tier — it must follow message 1's anchor (hyperide),
  // proving the ordinary/unambiguous auto-bind path recorded it.
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('hyper'); // only hyperide live so far
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(720, 40, 'first message, only hyperide up');
  await waitFor(() => injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`)));
  await Bun.sleep(200);
  expect(pickerOf(tg.sends)).toBeUndefined();

  // Now agent-tools comes up too — a plain follow-up is genuinely ambiguous at
  // the registration tier.
  h.setMode('both');
  tg.pushText(721, 41, 'second message, now ambiguous');
  await waitFor(() => injectedLines(h.injectLog).filter((l) => l.startsWith(`${PANE_HYPER}\t`)).length >= 2);
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  expect(lines.filter((l) => l.startsWith(`${PANE_HYPER}\t`)).length).toBe(2);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`))).toBe(false);
  expect(pickerOf(tg.sends)).toBeUndefined();
}, 15_000);

test('auto-bound delivery to a pane with NO known cwd never checks the DAEMON\'s own git state for a banner (Fable review finding)', async () => {
  // withGitStateBanner must reject an empty panePath the same way routeMatchesPane
  // does: `git -C ''` leaves the daemon's OWN cwd unchanged, so without the guard
  // the banner would silently check THIS repo (not a Telegram pane) and could
  // prepend an unrelated "⚠ This pane currently has uncommitted work…" banner —
  // computed from the daemon's own checkout — to a message delivered to an
  // unrelated agent.
  const h = makeHarness([{ paneId: PANE_HYPER, cwd: '' }]);
  const tg = startFakeTg();
  h.setMode('hyper-nopath'); // single live agent, but tmux reports NO cwd for it
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(724, 44, 'go ahead');
  await waitFor(() => injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`)));

  const lines = injectedLines(h.injectLog).filter((l) => l.startsWith(`${PANE_HYPER}\t`));
  expect(lines.some((l) => l.includes('⚠'))).toBe(false);
}, 15_000);

test('auto-bound delivery to a pane with NO known cwd invalidates a STALE anchor pointing elsewhere (review finding: untested)', async () => {
  // recordLastUserTarget's no-cwd branch: a confirmed delivery whose live pane
  // reports an empty pane_current_path can't record a pane-id-reuse-safe
  // anchor. The prior anchor pointed at a DIFFERENT pane (agent-tools) — that
  // is now genuinely stale (the CTO's next message just went to hyperide
  // instead), so it must be invalidated rather than left in place (fail-closed:
  // the next ambiguous message should ask, not silently follow the stale pane).
  const h = makeHarness([{ paneId: PANE_HYPER, cwd: '' }]);
  const anchorFile = join(h.cfgDir, 'tg-ctl.123.last-user-target.json');
  writeFileSync(anchorFile, JSON.stringify({ paneId: PANE_TOOLS, cwd: h.dirTools, ts: Math.floor(Date.now() / 1000) - 30 }));
  const tg = startFakeTg();
  h.setMode('hyper-nopath'); // single live agent, but tmux reports NO cwd for it
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(722, 42, 'go ahead');
  await waitFor(() => injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`)));
  // Poll rather than guess a fixed delay for recordLastUserTarget's write.
  await waitFor(() => !existsSync(anchorFile), 8000);

  expect(existsSync(anchorFile)).toBe(false);
}, 15_000);

test('auto-bound delivery to a pane with NO known cwd does NOT wipe an anchor already pointing at that SAME pane (review finding: pure loss otherwise)', async () => {
  // Same no-cwd delivery as above, but the anchor ALREADY points at the pane
  // receiving this delivery (hyperide) — it still carries a good cwd from an
  // earlier delivery. Invalidating here would be pure loss, not a safety fix
  // (Opus review finding), so the anchor must survive unchanged.
  const h = makeHarness([{ paneId: PANE_HYPER, cwd: '' }]);
  const anchorFile = join(h.cfgDir, 'tg-ctl.123.last-user-target.json');
  const original = { paneId: PANE_HYPER, cwd: h.dirHyper, ts: Math.floor(Date.now() / 1000) - 30 };
  writeFileSync(anchorFile, JSON.stringify(original));
  const tg = startFakeTg();
  h.setMode('hyper-nopath'); // single live agent, but tmux reports NO cwd for it
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(723, 43, 'go ahead');
  await waitFor(() => injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`)));
  // Proving a NON-event (the anchor must NOT change) needs a bounded wait for
  // recordIfAutoBound's write path to have had a chance to run, rather than a
  // predicate to poll — there's nothing to poll FOR when nothing should happen.
  await Bun.sleep(1500);

  expect(existsSync(anchorFile)).toBe(true);
  expect(JSON.parse(readFileSync(anchorFile, 'utf8'))).toEqual(original);
}, 15_000);

test('AMBIGUOUS control verb (/stop, no routable text) → select-only picker, NO inject, NO 👀 receipt', async () => {
  // Two registered live agents + a /stop (Escape) — no text to route through a
  // tap. The old path dumped "ambiguous target — candidates: …" as plain text;
  // now it posts the live agents as a select-only picker. Because a select-only
  // tap does NOT re-run the control verb, the source message must earn NO 👀
  // (the finding-2 fix: injectViaTarget returns false on this branch).
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  const stopMsgId = 26;
  tg.pushText(704, stopMsgId, '/stop');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(300);

  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  // Buttons, not a plain-text candidate dump.
  expect(picker!.text).not.toContain('candidates:');
  expect(picker!.text).not.toContain('ambiguous target');
  expect(picker!.buttons.length).toBe(2);
  expect(picker!.buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  // /stop was NOT injected into either pane (no Escape sent).
  expect(injectedLines(h.injectLog).length).toBe(0);
  // And the source /stop message earned NO 👀 — it did not execute.
  expect(tg.reactions.some((r) => r.messageId === stopMsgId && r.emoji === '👀')).toBe(false);
}, 15_000);

test('AMBIGUOUS control picker tap does not arm the next message', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(710, 37, '/stop');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  const picker = pickerOf(tg.sends)!;
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools')) ?? picker.buttons[0]!;

  tg.pushCallback(711, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);
  await Bun.sleep(200);

  const sendsBeforeFollowup = tg.sends.length;
  tg.pushText(712, 38, 'after stop picker tap');

  await waitFor(() => tg.sends.length > sendsBeforeFollowup);

  expect(injectedLines(h.injectLog).length).toBe(0);
  const followupPicker = tg.sends.slice(sendsBeforeFollowup).find((s) => s.hasMarkup);
  expect(followupPicker).toBeDefined();
  expect(followupPicker!.text).toContain('Route to which agent?');
  expect(followupPicker!.text).toContain('after stop picker tap');
  daemon.kill('SIGTERM');
}, 15_000);

test('DESTRUCTIVE /kill NEVER auto-binds to the last-message agent (asks even WITH a last message)', async () => {
  // Two registered live agents AND a populated routes.json (agent-tools %2 posted last).
  // A harmless content message WOULD bind to %2 — but /kill is destructive and must NOT
  // guess: it uses the base discover() (not discoverForInject), so it ASKS via the
  // select-picker rather than killing the guessed last-message agent (tg-cli#78 safety).
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness(
    [
      { paneId: PANE_HYPER, cwd: '' },
      { paneId: PANE_TOOLS, cwd: '' },
    ],
    [{ id: 430, paneId: PANE_TOOLS, cwd: '', ts: now }], // %2 posted the last message
  );
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  const killMsgId = 36;
  tg.pushText(709, killMsgId, '/kill');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(300);

  // It posted a select-picker (asked), NOT killed the last-message agent.
  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  expect(picker!.buttons.length).toBe(2);
  // No inject of any kind, and the /kill earned no 👀 (it did not execute).
  expect(injectedLines(h.injectLog).length).toBe(0);
  expect(tg.reactions.some((r) => r.messageId === killMsgId && r.emoji === '👀')).toBe(false);
}, 15_000);

test('bare /agent selection routes the next standalone photo', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(713, 39, '/agent');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  const picker = pickerOf(tg.sends)!;
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools')) ?? picker.buttons[0]!;

  tg.pushCallback(714, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);
  await Bun.sleep(200);
  tg.pushPhoto(715, 40);

  await waitFor(() => injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_TOOLS}\t`) && l.includes('sent photo:')));

  const lines = injectedLines(h.injectLog);
  expect(lines.some((l) => l.startsWith(`${PANE_TOOLS}\t`) && l.includes('sent photo:'))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
  daemon.kill('SIGTERM');
}, 15_000);

test('candidatesForPicker drops a discovery pane that is NOT a live agent (no synthetic dead button)', async () => {
  // Registration set names BOTH panes, but the tmux shim shows ONLY agent-tools
  // (%0/hyperide is gone). A fresh non-reply message is ambiguous at the SET tier
  // (two registered ids) yet only ONE is a live agent. The picker must offer JUST
  // the live agent — never a synthetic button for the gone %0 (the finding-1 fix:
  // candidatesForPicker filters to live agent candidates, it does not fabricate).
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('tools'); // only %2 (agent-tools) is a live agent pane
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushText(705, 28, 'do the thing with one gone');

  // With a single live agent this resolves directly (inject) OR — if the set tier
  // narrows to the one registered live pane — injects without a picker. Either
  // way: exactly the live pane is addressed, and NO button is ever offered for
  // the gone %0.
  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(200);

  const picker = pickerOf(tg.sends);
  if (picker) {
    // If a picker did appear, it must NOT contain a button for the gone hyperide.
    expect(picker.buttons.some((b) => b.text.includes('hyperide'))).toBe(false);
    expect(picker.buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  }
  // Nothing was injected into the gone %0.
  expect(injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
}, 15_000);
