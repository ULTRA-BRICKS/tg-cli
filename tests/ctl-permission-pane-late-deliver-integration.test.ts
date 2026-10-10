// tg-cli#267: a PERMISSION whose hook socket has closed (Claude Code's ~120s
// hook budget elapsed, harness fell back to its OWN terminal "Do you want to
// proceed?" menu) is answerable directly by re-checking the pane and
// injecting the matching digit — the CTO's spec, verbatim: "no waiting
// process — check via tmux whether the permission request is still showing,
// and send the keypresses." No hook reconnect is required (and for a
// terminal-fallback permission, none may ever come).
//
// Mirrors ctl-question-durable-integration's harness: a real daemon, a fake
// Telegram, and a fake tmux/ps reporting one claude pane (%1). The fake tmux
// additionally answers `capture-pane` from a sentinel file the test controls,
// so a test can simulate "the menu is still showing" vs "already resolved".
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { DANGEROUS_LONG, permissionBoxFor as menuFor, SAFE_LONG, SHARED_99 } from './fixtures/permission-menu';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PANE_ID = '%1';
const PANE_PID = 4242;

const TWO_OPTION_MENU = [
  ' Bash command',
  '',
  '   pkill -f nonexistent-process-xyz-test',
  '',
  ' Permission rule Bash(pkill:*) requires',
  ' confirmation for this command.',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
].join('\n');

const ALREADY_RESOLVED = ['⏺ Bash(pkill -f nonexistent-process-xyz-test)', '  ⎿  Error: Exit code 1', '', '✵ Cooked for 10s'].join('\n');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

function fakeTmux(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    [ -f '${cwd}/pane-gone' ] && exit 0
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  capture-pane)
    # 'fail-post-capture' makes the RE-capture (the one taken after the digit
    # already resolved the menu, i.e. once menu-text has been removed by
    # send-keys below) fail with a non-zero exit — simulating a tmux/pane
    # error on the confirmation step specifically, distinct from the
    # PRE-inject capture (which must succeed for the test to reach the inject
    # branch at all).
    if [ -f '${cwd}/fail-post-capture' ] && [ ! -f '${cwd}/menu-text' ]; then exit 1; fi
    if [ -f '${cwd}/menu-text' ]; then cat '${cwd}/menu-text'; fi
    # 'swap-menu-text' models the TOCTOU of tg-cli#309: the pane shows menu-text
    # to THIS capture, then a different menu takes its place before anything else
    # reads the pane (the human answered at the keyboard and the next permission
    # rendered in the same spot).
    if [ -f '${cwd}/swap-menu-text' ]; then mv '${cwd}/swap-menu-text' '${cwd}/menu-text'; fi
    ;;
  send-keys)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then
        printf '%s\\n' "$2" >> '${injectLog}'
        # Simulate the menu resolving once a digit lands, so the daemon's
        # post-inject re-capture sees it gone (confirmed delivery). A test
        # simulating a swallowed keypress (e.g. tmux copy-mode) writes the
        # 'keep-menu' sentinel to keep menu-text showing afterward too.
        # 'resolve-strip-cursor' models the OTHER real possibility (review
        # finding): Claude Code leaves the resolved box visible in scrollback
        # instead of erasing it — text and options stay, only the cursor goes.
        # 'next-menu-text' models Claude Code asking for the NEXT tool call at
        # once: the digit resolves this menu and a different one takes its spot.
        if [ -f '${cwd}/next-menu-text' ]; then
          mv '${cwd}/next-menu-text' '${cwd}/menu-text'
        elif [ -f '${cwd}/resolve-strip-cursor' ]; then
          sed -i.bak 's/❯ /  /' '${cwd}/menu-text' && rm -f '${cwd}/menu-text.bak'
        elif [ ! -f '${cwd}/keep-menu' ]; then
          rm -f '${cwd}/menu-text'
        fi
        break;
      fi
      shift
    done
    ;;
  load-buffer) cat >> '${injectLog}'; printf '\\n' >> '${injectLog}' ;;
esac
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-permpane-');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: PANE_ID, cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return cfgDir;
}

function injected(cfgDir: string): string[] {
  const p = join(cfgDir, 'inject.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0);
}

function daemonLog(cfgDir: string): string {
  const p = join(cfgDir, 'daemon.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
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
  return daemon;
}

function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    TMUX_PANE: PANE_ID,
  };
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  ask.stdin.write(JSON.stringify({ cwd: cfgDir, paneId: PANE_ID, ...request }) + '\n');
  ask.stdin.end();
  return ask;
}

interface MockTg {
  port: number;
  stop: (c?: boolean) => Promise<void> | void;
  push: (batch: unknown[]) => void;
  cards: () => unknown[];
  edits: () => string[];
  answeredCbs: () => Array<{ callback_query_id: string; text: string }>;
  allowData: () => string | null;
  denyData: () => string | null;
}

function mockTelegram(): MockTg {
  const updateQueue: unknown[][] = [];
  const cards: unknown[] = [];
  const edits: string[] = [];
  const answeredCbs: Array<{ callback_query_id: string; text: string }> = [];
  let lastKeyboard: Array<Array<{ callback_data: string }>> | null = null;
  let cardSeq = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard;
        if (kb?.length) {
          cardSeq += 1;
          cards.push(body);
          lastKeyboard = kb;
          return Response.json({ ok: true, result: { message_id: cardSeq } });
        }
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        edits.push(String(((await req.json()) as Record<string, unknown>).text ?? ''));
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCbs.push((await req.json()) as { callback_query_id: string; text: string });
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });

  return {
    port: server.port,
    stop: (c) => server.stop(c),
    push: (b) => updateQueue.push(b),
    cards: () => cards,
    edits: () => edits,
    answeredCbs: () => answeredCbs,
    allowData: () => lastKeyboard?.[0]?.[0]?.callback_data ?? null, // row 0 = [Approve, Reject]
    denyData: () => lastKeyboard?.[0]?.[1]?.callback_data ?? null,
  };
}

function tap(callbackData: string, updateId: number, messageId = 1): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: messageId, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
      data: callbackData,
    },
  };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(40);
  }
  return cond();
}

const PERMISSION = {
  requestId: 'p_pane',
  agent: 'claude',
  kind: 'permission',
  question: 'Allow bash command: pkill -f nonexistent-process-xyz-test?',
  // A real Claude Code PermissionRequest always carries the original
  // tool_input (hook-normalize.ts's `build()` includes it whenever the raw
  // payload has one) — toolInput.command is what extractPermissionIdentity
  // actually binds against, matching production shape rather than relying on
  // the free-text `question` sentence.
  toolInput: { command: 'pkill -f nonexistent-process-xyz-test' },
  permissionEvent: 'PermissionRequest',
};

async function abandon(cfgDir: string, tg: MockTg, request: Record<string, unknown>): Promise<Subprocess> {
  const ask = startAsk(cfgDir, tg.port, request);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 6000)).toBe(true);
  return ask;
}

test('PANE-INJECT allow: menu still showing → injects digit "1" alone (no Enter), no queuing', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  tg.push([tap(allowData, 800, 1)]);

  expect(await until(() => injected(cfgDir).includes('1'), 6000)).toBe(true);
  expect(injected(cfgDir)).toEqual(['1']); // exactly the digit — no "Enter" line, no other payload
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane:'), 4000)).toBe(true);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-permission-decision-queued');
  // The initial "hook disconnected" card (from abandon()) mentions "queued" as
  // part of its own generic disconnect text — that's expected and unrelated.
  // What must NOT happen is a SECOND edit re-labelling the card as queued.
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Approve')), 4000)).toBe(true);
  expect(tg.edits().filter((e) => e.includes('queued "Approve"')).length).toBe(0);
}, 25_000);

test('PANE-INJECT deny: menu still showing → injects digit "2"', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const denyData = tg.denyData()!;

  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  tg.push([tap(denyData, 801, 1)]);

  expect(await until(() => injected(cfgDir).includes('2'), 6000)).toBe(true);
  expect(injected(cfgDir)).toEqual(['2']);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane:'), 4000)).toBe(true);
}, 25_000);

test('UNCONFIRMED DELIVERY (e.g. tmux copy-mode swallows the digit): keypress sent but the SAME menu is still showing after → never claims delivery, falls through to queuing', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  // tmux exit code alone is not proof of delivery — a pane in copy-mode
  // (scrolled up) swallows a literal digit into its own key table instead of
  // passing it to Claude Code underneath. Simulate that: the digit gets
  // "sent" (recorded in the inject log, tmux exits 0) but the menu-text
  // sentinel is deliberately kept showing (see fakeTmux's 'keep-menu' guard),
  // so the daemon's post-inject re-capture still finds the same live menu.
  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  writeFileSync(join(cfgDir, 'keep-menu'), '1');
  tg.push([tap(allowData, 850, 1)]);

  // The digit WAS sent (tmux "succeeded")...
  expect(await until(() => injected(cfgDir).includes('1'), 6000)).toBe(true);
  // ...but delivery must NEVER be claimed, since the menu never actually
  // resolved — this is the whole point of the post-inject re-verify.
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane-failed'), 6000)).toBe(true);
  expect(tg.answeredCbs().some((c) => c.text === '✓ sent to the agent')).toBe(false);
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane:');
  // Falls through to the safe queuing fallback instead — the decision is
  // never silently lost even though the pane-inject attempt failed silently.
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  rmSync(join(cfgDir, 'keep-menu'));
}, 25_000);

test('CONFIRMED DELIVERY when the resolved box stays visible as scrollback (cursor gone, text retained) — review finding: text presence alone must not read as still-pending', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  // Nothing confirms Claude Code erases a resolved menu from the pane rather
  // than leaving it as static history — the OTHER real possibility this
  // integration harness must also cover, not just the "text vanishes"
  // shape every other test here uses. Simulate it: 'resolve-strip-cursor'
  // strips the ❯ cursor from menu-text on send-keys instead of deleting the
  // file, so the marker/options are still literally present in the capture.
  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  writeFileSync(join(cfgDir, 'resolve-strip-cursor'), '1');
  tg.push([tap(allowData, 860, 1)]);

  expect(await until(() => injected(cfgDir).includes('1'), 6000)).toBe(true);
  // Delivery IS confirmed — the cursor is gone even though the marker/option
  // text is still sitting in the capture.
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane:'), 6000)).toBe(true);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane-failed');
}, 25_000);

test('FAIL-OPEN GUARD: the digit lands but the post-inject re-capture itself fails (tmux/pane error) → NEVER treated as confirmed delivery', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  // The digit genuinely lands and resolves the menu (menu-text gets removed
  // by send-keys, same as a real success) — but the RE-capture that's
  // supposed to CONFIRM that fails outright (tmux error / pane gone at that
  // exact moment). A null capture proves nothing either way and must be
  // treated as "not confirmed", never silently as "menu is gone → success"
  // (review finding: an earlier version was fail-open here).
  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  writeFileSync(join(cfgDir, 'fail-post-capture'), '1');
  tg.push([tap(allowData, 851, 1)]);

  expect(await until(() => injected(cfgDir).includes('1'), 6000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane-failed'), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('post-inject re-capture failed');
  expect(tg.answeredCbs().some((c) => c.text === '✓ sent to the agent')).toBe(false);
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane:');
  // Still safely queued, never silently lost.
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  rmSync(join(cfgDir, 'fail-post-capture'));
}, 25_000);

test('DURABILITY: the decision is queued on disk BEFORE any pane-inject attempt, so a crash mid-inject can never lose it', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  // Keep the menu showing (simulates a slow/never-resolving inject) so the
  // daemon stays in the "attempting pane-inject" window long enough to
  // observe the intermediate on-disk state.
  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  writeFileSync(join(cfgDir, 'keep-menu'), '1');
  tg.push([tap(allowData, 852, 1)]);

  // Even while the pane-inject path is still "in flight" (menu kept showing,
  // eventual outcome is unconfirmed-delivery), the decision must ALREADY be
  // durably queued on disk — not only after the pane-inject attempt gives up.
  await until(() => {
    if (!existsSync(join(cfgDir, 'tg-ctl.123.questions.json'))) return false;
    const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8')) as {
      questions?: Array<{ req?: { requestId?: string }; queuedDecision?: { decision?: string } }>;
    };
    return state.questions?.some((q) => q.req?.requestId === 'p_pane' && q.queuedDecision?.decision === 'allow') ?? false;
  }, 6000);
  const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8')) as {
    questions: Array<{ req: { requestId: string }; queuedDecision?: { decision: string } }>;
  };
  expect(state.questions.find((q) => q.req.requestId === 'p_pane')?.queuedDecision?.decision).toBe('allow');
  rmSync(join(cfgDir, 'keep-menu'));
}, 25_000);

test('STALE FALLBACK: menu already resolved (no live "Do you want to proceed?") → falls through to queuing, no injection', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  writeFileSync(join(cfgDir, 'menu-text'), ALREADY_RESOLVED);
  tg.push([tap(allowData, 802, 1)]);

  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-permission-decision-queued');
  expect(injected(cfgDir)).toEqual([]); // nothing was ever sent to the pane
}, 25_000);

test('NO MENU FILE (pane never captured anything): falls through to queuing, same as before this change', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  // No menu-text sentinel written at all — capture-pane returns empty output.
  tg.push([tap(allowData, 803, 1)]);

  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  expect(injected(cfgDir)).toEqual([]);
}, 25_000);

test('SCOPE GUARD: a non-claude agent kind never attempts pane injection, even with a live menu', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, { ...PERMISSION, requestId: 'p_pane_codex', agent: 'codex' });
  const allowData = tg.allowData()!;

  // Even though the pane shows a live-looking menu, codex's layout/submit
  // behavior is unverified (tg-cli#49) — must never attempt injection.
  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  tg.push([tap(allowData, 804, 1)]);

  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  expect(injected(cfgDir)).toEqual([]);
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane:');
}, 25_000);

test('INJECTION FAILURE: pane gone at inject time → rolls back to a re-tappable retained entry, not silently lost', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  writeFileSync(join(cfgDir, 'pane-gone'), '1'); // verify-pane will now fail
  tg.push([tap(allowData, 805, 1)]);

  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane-failed'), 6000)).toBe(true);
  expect(injected(cfgDir)).toEqual([]);
  // Falls through to queuing (still recoverable) rather than dropping the tap.
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  // The queued decision must actually PERSIST on the SAME retained entry the
  // rollback restored — a rollback that inserts a fresh copy (instead of the
  // original `retained` object the queuing code goes on to mutate) would
  // leave the map's real entry with no queuedDecision, so a later hook
  // reconnect would find nothing to deliver despite the card claiming
  // "queued … delivered automatically" (review finding this pins down).
  await until(() => {
    const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8')) as {
      questions?: Array<{ req?: { requestId?: string }; queuedDecision?: { decision?: string } }>;
    };
    return state.questions?.some((q) => q.req?.requestId === 'p_pane' && q.queuedDecision?.decision === 'allow') ?? false;
  }, 6000);
  const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8')) as {
    questions: Array<{ req: { requestId: string }; queuedDecision?: { decision: string; value: string } }>;
  };
  const entry = state.questions.find((q) => q.req.requestId === 'p_pane');
  expect(entry?.queuedDecision).toMatchObject({ decision: 'allow', value: 'allow' });
  rmSync(join(cfgDir, 'pane-gone'));
}, 25_000);

test('MISMATCHED IDENTITY: live menu showing a DIFFERENT command → never injects, falls through to queuing', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION); // PERMISSION's command is "pkill -f nonexistent-process-xyz-test"
  const allowData = tg.allowData()!;

  // The pane shows a LIVE, real menu — but for a DIFFERENT, newer command the
  // harness has since moved on to within the retention window. Injecting here
  // would approve something the human never saw (review finding).
  const DIFFERENT_COMMAND_MENU = [
    ' Bash command',
    '',
    '   rm -rf /some/totally/different/path',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n');
  writeFileSync(join(cfgDir, 'menu-text'), DIFFERENT_COMMAND_MENU);
  tg.push([tap(allowData, 806, 1)]);

  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  expect(injected(cfgDir)).toEqual([]);
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane:');
}, 25_000);

// tg-cli#309: a long command whose card carries a truncated summary; DANGEROUS_LONG
// shares its first 99 characters (tests/fixtures/permission-menu.ts).
const LONG_PERMISSION = {
  requestId: 'p_long',
  agent: 'claude',
  kind: 'permission',
  question: `Allow Bash? ${SHARED_99}…`,
  toolInput: { command: SAFE_LONG },
  permissionEvent: 'PermissionRequest',
};

test('TOCTOU #309: the menu is swapped for a DIFFERENT command sharing a 99-char prefix between the capture and send-keys → no digit is sent, the decision stays queued', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, LONG_PERMISSION);
  const allowData = tg.allowData()!;

  // The first capture sees the request's own menu; every later read sees the
  // DANGEROUS command's menu in the same spot. Sending "1" now would approve a
  // command the human never saw.
  writeFileSync(join(cfgDir, 'menu-text'), menuFor(SAFE_LONG));
  writeFileSync(join(cfgDir, 'swap-menu-text'), menuFor(DANGEROUS_LONG));
  tg.push([tap(allowData, 870, 1)]);

  const queuedOrSent = (): boolean =>
    tg.edits().some((e) => e.includes('queued') && e.includes('Approve')) || daemonLog(cfgDir).includes('ask-late-deliver-permission-pane:');
  await until(queuedOrSent, 8000);
  expect(injected(cfgDir)).toEqual([]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('permission menu changed before the digit was sent');
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane:');
  expect(tg.answeredCbs().some((c) => c.text === '✓ sent to the agent')).toBe(false);
}, 25_000);

test('TRUNCATED IDENTITY #309: no toolInput, only a "…"-truncated question summary → never injects into a live menu sharing that prefix', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  const { toolInput: _dropped, ...noToolInput } = LONG_PERMISSION;
  await abandon(cfgDir, tg, noToolInput);
  const allowData = tg.allowData()!;

  writeFileSync(join(cfgDir, 'menu-text'), menuFor(DANGEROUS_LONG));
  tg.push([tap(allowData, 871, 1)]);

  await until(
    () => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')) || daemonLog(cfgDir).includes('ask-late-deliver-permission-pane:'),
    8000,
  );
  expect(injected(cfgDir)).toEqual([]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('reason=identity-unverifiable');
}, 25_000);

test('BUSY-PANE GUARD #268: a live pending question on the same pane → the late permission tap never injects, it stays queued', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, PERMISSION);
  const allowData = tg.allowData()!;

  // A second hook is now LIVE on %1 (socket open, card posted): the agent is
  // blocked on that prompt, so a digit typed into the pane would answer IT.
  const live = startAsk(cfgDir, tg.port, { requestId: 'q_live', agent: 'claude', kind: 'question', question: 'Restart service?', options: [{ label: 'Yes' }] });
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);

  writeFileSync(join(cfgDir, 'menu-text'), TWO_OPTION_MENU);
  tg.push([tap(allowData, 872, 1)]);

  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 8000)).toBe(true);
  expect(injected(cfgDir)).toEqual([]);
  expect(daemonLog(cfgDir)).toContain('reason=pane-busy');
  expect(daemonLog(cfgDir)).not.toContain('ask-late-deliver-permission-pane:');
  live.kill(9);
  await live.exited;
}, 25_000);

test('NEXT MENU #309: the digit resolves the request and a DIFFERENT permission (same 99-char prefix) takes the spot → delivered, logged as after=next-menu, never re-answered', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);
  await abandon(cfgDir, tg, LONG_PERMISSION);
  const allowData = tg.allowData()!;

  writeFileSync(join(cfgDir, 'menu-text'), menuFor(SAFE_LONG));
  writeFileSync(join(cfgDir, 'next-menu-text'), menuFor(DANGEROUS_LONG));
  tg.push([tap(allowData, 873, 1)]);

  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-permission-pane:'), 8000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('after=next-menu');
  expect(injected(cfgDir)).toEqual(['1']); // exactly one digit — the next menu is never touched
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
}, 25_000);
