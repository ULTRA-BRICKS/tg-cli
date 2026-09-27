import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { decideQueuedPermissionReconnect, isAbandonedExpired, retainMsFor } from '../tg-ctl';

// End-to-end durability for the CTO's question channel (issue #99). Three guarantees,
// one mechanism (persist scoped questions + answered-replay to disk on every mutation):
//   A. a Telegram tap that lands AFTER the hook socket closed (the 120s window /
//      agent death) is LATE-DELIVERED into the asking pane, never dropped.
//   B. a daemon restart loses nothing: the reconnecting `tg-ctl ask` re-attaches its
//      pending card (no duplicate) and the eventual answer flows down the new socket.
//   C. a genuinely-dead (unscoped) card has its keyboard CLEARED on expiry.
//
// Mirrors ctl-defer-integration: a real daemon, a fake Telegram, and a fake tmux/ps
// that reports one claude pane (%1) and LOGS every injected payload.
//
// PROOF BOUNDARY (late-delivery): the fake tmux LOGS the injected bytes, so these
// tests prove the chosen option's label REACHES the asking pane as an attributed
// "[TG from …] <label>" inbound message — exactly the established voice/typed-reply
// inject path. They do NOT (and a fake tmux cannot) prove that a live agent's terminal
// AskUserQuestion fallback then INTERPRETS that text as selecting the option: that is
// the LLM agent reading its pane, identical to how it consumes any tg reply, and is
// out of this harness's scope. "Delivered to the pane" is the guarantee under test;
// "consumed as the choice" is the agent's own semantics, asserted only by the design.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PANE_ID = '%1';
const PANE_PID = 4242;

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
    # Test hook: when the sentinel exists the pane is "gone" — verify-pane then fails,
    # exercising the inject-failure (late-deliver retry) path.
    [ -f '${cwd}/pane-gone' ] && exit 0
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  send-keys)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then
        # Test hook: when the sentinel exists, hold the literal inject open so a test
        # can race a concurrent hook reconnect against the in-flight late-delivery.
        [ -f '${cwd}/inject-slow' ] && sleep 1.5
        printf '%s\\n' "$2" >> '${injectLog}'; break;
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
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-qdur-'));
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

async function startDaemon(cfgDir: string, apiPort: number, extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      ...extraEnv,
    },
    logFd,
  });
  closeSync(logFd);
  return daemon;
}

function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>, opts: { unscoped?: boolean } = {}): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
  };
  if (!opts.unscoped) env.TMUX_PANE = PANE_ID;
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  const payload = opts.unscoped ? { cwd: cfgDir, ...request } : { cwd: cfgDir, paneId: PANE_ID, ...request };
  ask.stdin.write(JSON.stringify(payload) + '\n');
  ask.stdin.end();
  return ask;
}

// A scripted Telegram: getUpdates drains a caller-owned queue; it records cards (a
// sendMessage carrying an inline keyboard), plain edits, keyboard-clears
// (editMessageReplyMarkup), and answered callbacks, and exposes the captured
// callback_data for a chosen option ROW (questions render one option per row).
interface MockTg {
  port: number;
  stop: (c?: boolean) => Promise<void> | void;
  push: (batch: unknown[]) => void;
  cards: () => unknown[];
  edits: () => string[];
  keyboardClears: () => number;
  answeredCbs: () => Array<{ callback_query_id: string; text: string }>;
  optionData: (row: number) => string | null;
  // Every sendMessage carrying NO inline keyboard — the plain-chat-reply fallback
  // (answerCallbackQueryOrNotify) a toast-only failure branch uses for a
  // text-reply-synthesized decision, which has no callback query to toast.
  plainMessages: () => string[];
  // Hold every card-bearing sendMessage open for `ms` AFTER recording the card, so a
  // test can close the asking socket mid-send and exercise the messageId-null race.
  delaySend: (ms: number) => void;
}

function mockTelegram(callbackDelayMs = 0): MockTg {
  const updateQueue: unknown[][] = [];
  const cards: unknown[] = [];
  const edits: string[] = [];
  const answeredCbs: Array<{ callback_query_id: string; text: string }> = [];
  const plainMessages: string[] = [];
  let keyboardClears = 0;
  let lastKeyboard: Array<Array<{ callback_data: string }>> | null = null;
  let cardSeq = 0;
  let sendDelayMs = 0;

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
          const id = cardSeq;
          // Record the card immediately, then optionally stall the RESPONSE so the
          // daemon's `entry.messageId` stays null while a test closes the socket.
          if (sendDelayMs) await Bun.sleep(sendDelayMs);
          return Response.json({ ok: true, result: { message_id: id } });
        }
        plainMessages.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        edits.push(String(((await req.json()) as Record<string, unknown>).text ?? ''));
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) {
        keyboardClears += 1;
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        if (callbackDelayMs) await Bun.sleep(callbackDelayMs);
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
    keyboardClears: () => keyboardClears,
    answeredCbs: () => answeredCbs,
    optionData: (row) => lastKeyboard?.[row]?.[0]?.callback_data ?? null,
    plainMessages: () => plainMessages,
    delaySend: (ms) => {
      sendDelayMs = ms;
    },
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

const QUESTION = {
  requestId: 'q_durable',
  agent: 'claude',
  kind: 'question',
  title: 'Deploy',
  question: 'Where should I deploy?',
  options: [{ label: 'Staging' }, { label: 'Production' }],
};

// Permission fixture — uses PermissionRequest so no toolInput round-trip is needed.
// callbackRequestId('p_durable') === 'p_durable' (short, clean string), so the
// callback_data values are the literal strings constructed below. `promptTurnId`
// is the per-invocation identity proof (for a real raw-harness payload, sourced
// from hook-normalize.ts's env.invocationNonce — a per-process nonce, not just
// prompt_id/turn_id) that a QUEUED decision's automatic, no-time-bound delivery
// on reconnect now requires — this fixture (an already-normalized ButtonRequest
// JSON, the manual/back-compat path) stands in for a real invocation that got
// one.
const PERMISSION = {
  requestId: 'p_durable',
  agent: 'claude',
  kind: 'permission',
  question: 'Allow bash command: rm -rf /tmp/test?',
  permissionEvent: 'PermissionRequest',
  promptTurnId: 'turn_durable',
};

const RESTORE_WAIT_MS = 15_000;

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(40);
  }
  return cond();
}

function hasPersistedQuestion(cfgDir: string, requestId: string): boolean {
  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  if (!existsSync(statePath)) return false;
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    questions?: Array<{ req?: { requestId?: string } }>;
  };
  return Boolean(state.questions?.some((q) => q.req?.requestId === requestId));
}

test('INTRA-TURN IDENTITY (tg#9982 follow-up): two DISTINCT tool invocations with byte-identical raw payload + prompt_id in the SAME turn get DIFFERENT requestIds, never collide', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  // A RAW harness-shaped payload (no explicit requestId — this exercises
  // hook-normalize.ts's actual hashing, unlike the already-normalized PERMISSION
  // fixture used elsewhere in this file). Two SEPARATE `tg-ctl ask` processes
  // send the identical session_id + prompt_id + tool + tool_input — modeling the
  // agent calling the exact same command twice within ONE prompt turn (prompt_id
  // is stable for the whole turn, not per tool call). Each process generates its
  // OWN env.invocationNonce, which is what must keep them from colliding.
  const rawPermission = {
    session_id: 'sess_intraturn',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    prompt_id: 'prompt-same-turn',
  };

  const ask1 = startAsk(cfgDir, tg.port, rawPermission);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const approveData = tg.optionData(0)!; // row 0, first button = Approve
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  // Tap Approve on invocation #1 — queued (no live hook to deliver to).
  tg.push([tap(approveData, 825, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // Invocation #2: a SEPARATE process, byte-identical payload. If it collided
  // with #1's requestId, this would either auto-deliver the queued "Approve"
  // (WRONG — the human never saw or decided on THIS invocation) or reconnect to
  // the SAME card. Instead it must be treated as a genuinely new, unrelated
  // request: a SECOND card.
  const ask2 = startAsk(cfgDir, tg.port, rawPermission);
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');

  ask2.kill(9);
  await ask2.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('persist: a forwarded scoped question is written to the durable state file', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  expect(await until(() => existsSync(statePath), 3000)).toBe(true);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  expect(state.questions).toHaveLength(1);
  expect(state.questions[0].req.requestId).toBe('q_durable');
  expect(state.questions[0].req.paneId).toBe(PANE_ID);
  expect(state.questions[0].messageId).toBe(1);
}, 20_000);

test('LATE-DELIVER: a tap after the hook socket closed injects the chosen option into the pane', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1); // row 1 = "Production"
  expect(productionData).not.toBeNull();

  // The agent's hook process dies → socket closes → the question is abandoned but
  // RETAINED (card keyboard kept). Confirm the card was re-labelled, not cleared.
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);
  expect(tg.keyboardClears()).toBe(0); // a retained card stays tappable — NOT cleared

  // A LATE tap now lands. It must inject the chosen option into pane %1, not drop.
  tg.push([tap(productionData!, 700, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Production')), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-late-delivered');
  // Once delivered the card stops being tappable — the keyboard is cleared, so a re-tap
  // in the 5–30 min answered/retention gap can't show a misleading "expired".
  expect(await until(() => tg.keyboardClears() >= 1, 4000)).toBe(true);
}, 25_000);

test('POST-TIMEOUT REPLY: a text reply to the retained question card injects the answer into the pane', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  tg.push([
    {
      update_id: 705,
      message: {
        message_id: 706,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'Production',
        reply_to_message: {
          message_id: 1,
          chat: { id: 1 },
          date: Math.floor(Date.now() / 1000) - 30,
          text: 'Question from claude\n\nWhere should I deploy?',
        },
      },
    },
  ]);

  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-post-timeout-reply-delivered'), 4000)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Production')), 4000)).toBe(true);
  expect(await until(() => tg.keyboardClears() >= 1, 4000)).toBe(true);
}, 25_000);

test('LATE-DELIVER failure: an unreachable pane keeps the entry retained for a re-tap (answer not lost)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram(150);
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // The pane is now GONE → the inject fails. The entry must NOT be consumed.
  writeFileSync(join(cfgDir, 'pane-gone'), '1');
  tg.push([tap(productionData, 710, 1)]);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-failed'), 6000)).toBe(true);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('tap again')), 6000)).toBe(true);
  expect(tg.edits().some((e) => e.includes('Selected answer: Production'))).toBe(false); // NOT marked answered
  // The retained entry is still on disk (recoverable by a re-tap).
  const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8'));
  expect(state.questions.some((q: { req: { requestId: string } }) => q.req.requestId === 'q_durable')).toBe(true);

  // Pane back → a RE-TAP now delivers the answer.
  const { unlinkSync } = await import('fs');
  unlinkSync(join(cfgDir, 'pane-gone'));
  tg.push([tap(productionData, 711, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Production')), 4000)).toBe(true);
}, 25_000);

test('SINGLE-DELIVERY: after a late pane-delivery, a hook re-fire returns null (no replay) — answer not delivered twice', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask1 = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // Late tap → pane-delivered once.
  tg.push([tap(productionData, 720, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-delivered'), 4000)).toBe(true);
  const injectedAfterDeliver = injected(cfgDir).filter((l) => l.includes('Production')).length;

  // A hook now RE-FIRES the same requestId (the reconnect/race). It must get NULL —
  // NOT a replay — so the agent doesn't receive the answer a second time, and no new
  // injection lands in the pane.
  const ask2 = startAsk(cfgDir, tg.port, QUESTION);
  const out2 = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(out2.trim()).toBe(''); // no replay payload — the hook fell back to terminal
  expect(daemonLog(cfgDir)).toContain('already-pane-delivered');
  expect(tg.cards()).toHaveLength(1); // no duplicate card
  // No SECOND pane injection from the re-fire.
  expect(injected(cfgDir).filter((l) => l.includes('Production')).length).toBe(injectedAfterDeliver);
}, 25_000);

test('PANE-DELIVERY survives a restart: after a late pane-delivery + daemon bounce, a re-fire of the same requestId gets null (no replay, no duplicate)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // Late tap → pane-delivered once; the answer is persisted with delivery:"pane".
  tg.push([tap(productionData, 770, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-delivered'), 4000)).toBe(true);
  const injectedAfterDeliver = injected(cfgDir).filter((l) => l.includes('Production')).length;

  // Bounce the daemon. The delivery:"pane" answer must survive the restore.
  daemon1.kill(9);
  await daemon1.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);

  // A re-fire of the SAME requestId AFTER the restart must hit already-pane-delivered
  // (null) — NOT replay the answer down the socket and NOT post a second card. This is
  // the whole reason the delivery channel is persisted.
  const ask2 = startAsk(cfgDir, tg.port, QUESTION);
  const out2 = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(out2.trim()).toBe('');
  expect(daemonLog(cfgDir)).toContain('already-pane-delivered');
  expect(tg.cards()).toHaveLength(1); // no duplicate card across the bounce
  // No SECOND pane injection from the re-fire.
  expect(injected(cfgDir).filter((l) => l.includes('Production')).length).toBe(injectedAfterDeliver);
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('LATE-DELIVER race: a hook re-fire DURING the inject sees the claim (already-pane-delivered) — no reattach, no duplicate, single delivery', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask1 = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // Hold the pane inject open so the late-delivery await stays in flight long enough
  // for a concurrent reconnect to race it.
  writeFileSync(join(cfgDir, 'inject-slow'), '1');

  // The tap → lateDeliver CLAIMS the entry (abandoned→answered:pane, persisted to disk)
  // BEFORE the slow inject await. Wait for the claim to land while the inject still runs.
  tg.push([tap(productionData, 760, 1)]);
  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  const claimed = (): boolean => {
    if (!existsSync(statePath)) return false;
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    const answeredPane = (s.answered ?? []).some((a: { key: string; delivery: string }) => a.key === 'q_durable' && a.delivery === 'pane');
    const stillRetained = (s.questions ?? []).some((q: { req: { requestId: string } }) => q.req.requestId === 'q_durable');
    return answeredPane && !stillRetained;
  };
  expect(await until(claimed, 6000)).toBe(true);
  // The slow inject has NOT landed yet — confirms we are genuinely mid-await.
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false);

  // A hook RE-FIRES the same requestId DURING the inject. With the claim taken before
  // the await, it must hit already-pane-delivered (null) — NOT reattach a live socket
  // (which would hang the agent) and NOT post a duplicate card.
  const ask2 = startAsk(cfgDir, tg.port, QUESTION);
  const out2 = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(out2.trim()).toBe('');
  expect(daemonLog(cfgDir)).toContain('already-pane-delivered');
  expect(daemonLog(cfgDir)).not.toContain('ask-forward reattached');
  expect(tg.cards()).toHaveLength(1); // no duplicate card

  // The inject lands EXACTLY once — the answer is delivered a single time.
  expect(await until(() => injected(cfgDir).filter((l) => l.includes('Production')).length === 1, 6000)).toBe(true);
  await Bun.sleep(300);
  expect(injected(cfgDir).filter((l) => l.includes('Production')).length).toBe(1);
}, 30_000);

test('LATE-DELIVER busy pane: a tap while another question is live is NOT falsely confirmed — entry retained for a re-tap', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  // Q1 forwarded then abandoned (socket closed) — retained.
  const ask1 = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const q1Data = tg.optionData(1)!; // "Production" on Q1
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // Q2 is now LIVE-pending on the SAME pane (the agent is blocked on it).
  const ask2 = startAsk(cfgDir, tg.port, { requestId: 'q2_busy', agent: 'claude', kind: 'question', question: 'Restart service?', options: [{ label: 'Yes' }] });
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);
  const q2Data = tg.optionData(0)!; // Q2's only option

  // A late tap on Q1 must NOT inject (the pane is busy) and must NOT claim "sent".
  tg.push([tap(q1Data, 730, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('busy')), 6000)).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false); // NOT delivered
  expect(tg.edits().some((e) => e.includes('Selected answer: Production'))).toBe(false);
  // Q1 still retained on disk (recoverable).
  const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8'));
  expect(state.questions.some((q: { req: { requestId: string } }) => q.req.requestId === 'q_durable')).toBe(true);

  // Answer Q2 → the pane frees up; a RE-TAP on Q1 now delivers.
  tg.push([tap(q2Data, 731, 2)]);
  await new Response(ask2.stdout).text();
  await ask2.exited;
  tg.push([tap(q1Data, 732, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
}, 25_000);

test('RETENTION prune: an abandoned question past TG_CTL_ABANDONED_RETAIN_MS is dropped (a later tap → expired, not delivered)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // Tiny retention window so the prune fires without a 30-min wait.
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const q1Data = tg.optionData(1)!;
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // Wait past the retention window, then a NEW forward triggers a persist → prune.
  await Bun.sleep(900);
  startAsk(cfgDir, tg.port, { requestId: 'q2_prune', agent: 'claude', kind: 'question', question: 'Other?', options: [{ label: 'Ok' }] });
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);

  // The stale Q1 is pruned: a late tap on it is NOT delivered — it falls to "expired".
  tg.push([tap(q1Data, 740, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 6000)).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false);
}, 25_000);

// --- deterministic unit coverage for retainMsFor/isAbandonedExpired (tg-cli#182
// round 6 review finding — Codex, repeated round 5 and round 6): every prior
// test proving the reconnect-time expiry check exercises it through a REAL
// daemon process racing a REAL periodic sweep, which the sweep can win before
// the check ever runs, so the check's own boolean logic had no test that
// FAILS if the check is deleted. These call the pure exported functions
// directly — no daemon, no timing race, no sweep to race against. ---

test('retainMsFor: permission gets the long window, question gets the short one', () => {
  expect(retainMsFor('permission')).toBeGreaterThan(retainMsFor('question'));
});

test('isAbandonedExpired: a permission just inside its own (longer) window is NOT expired, even though it is already past the question window', () => {
  const permissionWindow = retainMsFor('permission');
  const questionWindow = retainMsFor('question');
  expect(permissionWindow).toBeGreaterThan(questionWindow);
  const at = 0;
  const now = questionWindow + 1; // past the SHORT window, still inside the long one
  expect(isAbandonedExpired('permission', at, now)).toBe(false);
  expect(isAbandonedExpired('question', at, now)).toBe(true);
});

test('isAbandonedExpired: a permission past its OWN window IS expired (this is the exact boolean the reconnect-time check in tg-ctl depends on)', () => {
  const permissionWindow = retainMsFor('permission');
  const at = 0;
  const now = permissionWindow + 1;
  expect(isAbandonedExpired('permission', at, now)).toBe(true);
});

test('isAbandonedExpired: exactly AT the window boundary is not yet expired (strict >, matching pruneAbandonedButtons)', () => {
  const window = retainMsFor('permission');
  expect(isAbandonedExpired('permission', 0, window)).toBe(false);
  expect(isAbandonedExpired('permission', 0, window + 1)).toBe(true);
});

// --- deterministic unit coverage for decideQueuedPermissionReconnect (tg-cli#182
// round 8 review finding — Codex, five straight rounds): the pure decision
// function the reconnect branch in handleHookSocketLine calls. No daemon, no
// sweep, no timing race — this directly tests the exact predicate the branch
// depends on, including the specific "expired but the periodic sweep hasn't
// caught it yet" case no integration test can reliably force. ---

const RECONNECT_REQ = {
  requestId: 'p_reconnect',
  agent: 'claude',
  kind: 'permission',
  question: 'Allow bash command: rm -rf /tmp/test?',
  permissionEvent: 'PermissionRequest',
  promptTurnId: 'turn_reconnect',
} as const;

const QUEUED_DECISION = { value: 'allow', label: 'Approve', decision: 'allow', at: 0 } as const;

test('decideQueuedPermissionReconnect: no queued decision at all -> no-queued-decision (ordinary ask reconnect, nothing to log)', () => {
  const retained = { req: RECONNECT_REQ, at: 0, queuedDecision: undefined };
  expect(decideQueuedPermissionReconnect(retained, RECONNECT_REQ, 1000).kind).toBe('no-queued-decision');
});

test('decideQueuedPermissionReconnect: queued decision, reconnect well within the retention window, identity matches -> deliver', () => {
  const retained = { req: RECONNECT_REQ, at: 0, queuedDecision: QUEUED_DECISION };
  const outcome = decideQueuedPermissionReconnect(retained, RECONNECT_REQ, 1000);
  expect(outcome.kind).toBe('deliver');
  if (outcome.kind === 'deliver') expect(outcome.queuedDecision).toEqual(QUEUED_DECISION);
});

test('decideQueuedPermissionReconnect: queued decision PAST its own retention window -> expired (THE exact race Codex round 4-8 asked to cover)', () => {
  const window = retainMsFor('permission');
  const retained = { req: RECONNECT_REQ, at: 0, queuedDecision: QUEUED_DECISION };
  // The entry is logically expired (now - at > window) regardless of whether
  // any periodic sweep has run yet — this function has no notion of "swept",
  // only "expired", which is exactly the property the reconnect branch needs.
  const outcome = decideQueuedPermissionReconnect(retained, RECONNECT_REQ, window + 1);
  expect(outcome.kind).toBe('expired');
});

test('decideQueuedPermissionReconnect: SECURITY — expired takes priority over every other check (deleting this branch would silently re-deliver a stale decision)', () => {
  const window = retainMsFor('permission');
  const retained = { req: RECONNECT_REQ, at: 0, queuedDecision: QUEUED_DECISION };
  // Everything else about this reconnect is a PERFECT match (same req object,
  // same promptTurnId, payload matches) — the ONLY thing wrong is that it's
  // past the window. If the expiry check were removed or reordered after the
  // match checks, this would incorrectly return "deliver".
  const outcome = decideQueuedPermissionReconnect(retained, RECONNECT_REQ, window + 1);
  expect(outcome.kind).toBe('expired');
  expect(outcome.kind).not.toBe('deliver');
});

test('decideQueuedPermissionReconnect: no promptTurnId proof -> no-turn-proof, never delivers on session-scoped identity alone', () => {
  const reqNoProof = { ...RECONNECT_REQ, promptTurnId: undefined };
  const retained = { req: reqNoProof, at: 0, queuedDecision: QUEUED_DECISION };
  expect(decideQueuedPermissionReconnect(retained, reqNoProof, 1000).kind).toBe('no-turn-proof');
});

test('decideQueuedPermissionReconnect: reconnecting promptTurnId differs from the retained one -> turn-mismatch, never delivers onto a different invocation', () => {
  const retained = { req: RECONNECT_REQ, at: 0, queuedDecision: QUEUED_DECISION };
  const differentTurn = { ...RECONNECT_REQ, promptTurnId: 'turn_DIFFERENT' };
  expect(decideQueuedPermissionReconnect(retained, differentTurn, 1000).kind).toBe('turn-mismatch');
});

test('decideQueuedPermissionReconnect: reconnecting toolInput differs from the retained one -> payload-mismatch, never delivers onto a materially different action', () => {
  const retained = { req: { ...RECONNECT_REQ, toolInput: { command: 'rm -rf /tmp/a' } }, at: 0, queuedDecision: QUEUED_DECISION };
  const mutatedPayload = { ...RECONNECT_REQ, toolInput: { command: 'rm -rf /' } };
  expect(decideQueuedPermissionReconnect(retained, mutatedPayload, 1000).kind).toBe('payload-mismatch');
});

test('RETENTION prune: a permission survives past TG_CTL_ABANDONED_RETAIN_MS on its own longer TG_CTL_ABANDONED_PERMISSION_RETAIN_MS window (tg-cli#182)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // The QUESTION window is tiny; the PERMISSION window is deliberately much
  // longer — this is the whole point of tg-cli#182 (Alex reported a permission
  // going stale and being told "never delivered" long before he'd had a
  // realistic chance to check his phone).
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '30000' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 6000)).toBe(true);

  // Past the QUESTION window but still well inside the PERMISSION window: a
  // fresh question forward triggers a persist -> prune sweep, but the
  // permission must NOT be pruned yet, and a tap on it must still be honored
  // (queued for reconnect), never "expired".
  await Bun.sleep(900);
  startAsk(cfgDir, tg.port, { requestId: 'q_after_perm', agent: 'claude', kind: 'question', question: 'Other?', options: [{ label: 'Ok' }] });
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 812, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  expect(tg.answeredCbs().some((c) => c.text === 'expired')).toBe(false);
}, 25_000);

test('RETENTION prune (unequal windows, full round trip): a permission is pruned/notified at its OWN window, not the shorter question one, and not never (tg-cli#182 round-1 review finding)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // Permission window intentionally longer than the question one, with a wide
  // margin on both sides of the mid-point sleep (review finding, round 4: the
  // original 400/1200/600ms timings left only a few hundred ms of margin
  // against poll/disconnect-detection latency, flaking the "tap honored"
  // assertion under CI load) — proves the permission's OWN longer window is
  // what actually gates its give-up (not the shorter question window, and not
  // an unbounded/never-fires window either).
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '800', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '4000' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 6000)).toBe(true);

  // Past the QUESTION window (800ms) but not yet the PERMISSION window
  // (4000ms): still fully alive, a tap is honored, never "expired".
  await Bun.sleep(1500);
  tg.push([tap('tgq:p_durable:allow', 833, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);
  expect(tg.answeredCbs().some((c) => c.text === 'expired')).toBe(false);

  // Now past its OWN (longer) window too — the daemon must eventually give up
  // and report it, exactly like the question case, just on its own timer.
  expect(await until(() => tg.edits().some((e) => e.includes('still no connection')), 8000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-abandoned-long-outage');
}, 25_000);

test('RESTORE (unequal windows): a permission queued across a daemon-down window survives past the QUESTION window but is still tappable, restored correctly on restart (tg-cli#182 round 4 review finding)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '20000' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);
  expect(await until(() => hasPersistedQuestion(cfgDir, 'p_durable'), 4000)).toBe(true);

  // Kill the daemon, then wait past the QUESTION window (600ms) but well
  // inside the PERMISSION window (20s) — this is specifically the RESTORE
  // path (tg-ctl:4124's restoreRetainMs), not the live sweep, since the
  // daemon is fully down for this whole wait.
  daemon1.kill(9);
  await daemon1.exited;
  await Bun.sleep(1500);

  const daemon2 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '20000' });

  // Must NOT have been given up on during restore — no "still no connection"
  // notice, and a tap right after restart must still be honored (queued),
  // never "expired". If the restore path used the QUESTION window instead of
  // the permission's own, this entry would have already been dropped.
  expect(tg.edits().some((e) => e.includes('still no connection'))).toBe(false);
  tg.push([tap('tgq:p_durable:allow', 861, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 6000)).toBe(true);
  expect(tg.answeredCbs().some((c) => c.text === 'expired')).toBe(false);

  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 25_000);

test('LONG OUTAGE: an abandoned question past the retention window is proactively reported, never left silent', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // Tiny retention window. The daemon's poll loop sweeps every iteration (this
  // repo's fake Telegram returns an empty getUpdates batch every ~60ms when idle),
  // so the past-window entry is dropped and its card proactively re-edited WITHOUT
  // any tap or other mutation — closing the "connection lost and nobody was ever
  // told" gap (Alex tg requirement: a long-running uncertainty must eventually be
  // reported, not left on a stale card forever).
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const q1Data = tg.optionData(1)!;
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // No tap, no other mutation — the daemon must still proactively surface the
  // outage once the retention window elapses.
  expect(await until(() => tg.edits().some((e) => e.includes('still no connection')), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-abandoned-long-outage');
  expect(tg.keyboardClears()).toBeGreaterThanOrEqual(1); // the now-dead card is retired

  // A later tap on the now-gone entry gets a plain "expired" toast — never silently
  // dropped, never falsely claims delivery.
  tg.push([tap(q1Data, 745, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 6000)).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false);
}, 25_000);

test('LONG OUTAGE (queued permission): a queued decision that never reconnects gets the same proactive notice', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  // Tap Approve — queued, refreshing the retention clock (see the LAST-TAP-WINS
  // test for the overwrite semantics; here we prove the clock refresh itself).
  tg.push([tap('tgq:p_durable:allow', 815, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // No reconnect ever comes. Even with a QUEUED decision sitting on the entry, the
  // daemon must still eventually give up and say so plainly — a queued card is not
  // exempt from the "long silence must be reported" guarantee. The give-up text
  // must NAME the queued decision ("Approve") rather than implying nothing was
  // ever chosen — that's the whole point of threading queuedDecisionLabel through
  // abandonedLongOutageText (a tapped decision that never got delivered is a
  // materially different situation from a card nobody ever touched).
  expect(await until(() => tg.edits().some((e) => e.includes('still no connection')), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-abandoned-long-outage');
  const giveUpEdit = tg.edits().find((e) => e.includes('still no connection'));
  expect(giveUpEdit).toContain('queued "Approve"');
  expect(giveUpEdit).toContain('never delivered');
}, 25_000);

test('LONG OUTAGE (daemon down across the window): the notice still fires on restore, never silently discarded', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);
  expect(await until(() => hasPersistedQuestion(cfgDir, 'p_durable'), 4000)).toBe(true);

  // Kill the daemon itself BEFORE the retention window elapses, then wait past the
  // window with the daemon fully DOWN — this is the case the sweep and the
  // persist-time prune can never see (they only run while the daemon is alive).
  daemon1.kill(9);
  await daemon1.exited;
  await Bun.sleep(900);

  // Restart. The entry is now past its retention window — it must NOT just vanish
  // from `abandonedButtons` silently: the human tapped nothing wrong and deserves
  // the same "still no connection" notice as the daemon-stays-up case, not an
  // unexplained gap where the card is simply never touched again.
  const daemon2 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });
  expect(await until(() => tg.edits().some((e) => e.includes('still no connection')), 8000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-abandoned-long-outage');
  const noticeCountAfterFirstRestore = (daemonLog(cfgDir).match(/ask-abandoned-long-outage/g) ?? []).length;
  expect(noticeCountAfterFirstRestore).toBe(1);

  daemon2.kill('SIGTERM');
  await daemon2.exited;

  // The notified entry must have been written OUT of the on-disk file (not just
  // dropped from memory) — otherwise a THIRD restart would re-notify the identical
  // stale record forever. daemonLog() accumulates across restarts (append mode), so
  // a stable count proves it. startDaemon already blocks until the new daemon's
  // socket exists, which happens AFTER the restore block runs, so restore (and its
  // persistQuestions() call) has already completed by the time it returns.
  const daemon3 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });
  const noticeCountAfterSecondRestore = (daemonLog(cfgDir).match(/ask-abandoned-long-outage/g) ?? []).length;
  expect(noticeCountAfterSecondRestore).toBe(1);

  daemon3.kill('SIGTERM');
  await daemon3.exited;
}, 35_000);

test('LONG OUTAGE (both thresholds crossed while the daemon was DOWN): the restore path gives up and names the queued decision, no "still waiting" notice', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // Both thresholds tiny and equal-ish, so the daemon-down gap below crosses BOTH
  // before restore even runs — this exercises the RESTORE-loop give-up branch
  // (tg-ctl's bootstrap block, `nowRestore - rec.at > ABANDONED_RETAIN_MS`), which
  // never adds the entry to `abandonedButtons` at all, so `noticeStaleQueuedDecisions`
  // never sees it. It's a DIFFERENT code path from the live-sweep skip guard (see
  // "LONG OUTAGE (live sweep crosses both thresholds together)" below) — this one
  // proves the restore path's own give-up correctly threads queuedDecision through
  // to notifyAbandonedLongOutage (a real bug this diff also fixed: the restore-time
  // give-up used to construct an AbandonedButton with no queuedDecision at all).
  const daemon1 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600', TG_CTL_QUEUED_DECISION_NOTICE_MS: '300' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 820, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // Kill the daemon RIGHT after the tap (notifiedAt still unset) and wait past
  // BOTH thresholds with the daemon fully down.
  daemon1.kill(9);
  await daemon1.exited;
  await Bun.sleep(900);

  const daemon2 = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600', TG_CTL_QUEUED_DECISION_NOTICE_MS: '300' });
  expect(await until(() => tg.edits().some((e) => e.includes('still no connection')), 8000)).toBe(true);

  // The give-up notice must name the queued decision, and the "still waiting to
  // reconnect" notice must NEVER have fired for this entry (it's being pruned in
  // the very same sweep that would have fired it).
  const lastEdit = tg.edits().at(-1);
  expect(lastEdit).toContain('queued "Approve"');
  expect(daemonLog(cfgDir)).not.toContain('ask-permission-decision-queue-still-waiting-notice');
  expect(daemonLog(cfgDir)).toContain('ask-abandoned-long-outage');

  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 35_000);

test('LONG OUTAGE (live sweep crosses both thresholds together): the running daemon\'s own poll-loop sweep skips the "still waiting" notice for an entry it is about to give up on', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // NOTICE_MS === RETAIN_MS (not merely "tiny and close"): with a single value,
  // the FIRST live sweep to observe the entry past that shared threshold sees
  // BOTH `now - qd.at > NOTICE_MS` (notice-eligible) AND `now - entry.at >=
  // RETAIN_MS` (skip-guard-active) true at once — this is the actual
  // noticeStaleQueuedDecisions skip-guard race (no daemon restart involved),
  // proving the LIVE sweep — not just the restore path — never lets a
  // since-pruned card keep claiming "still waiting … will still be delivered"
  // with a live keyboard.
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '500', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '500', TG_CTL_QUEUED_DECISION_NOTICE_MS: '500' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 822, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // No reconnect, no further tap — the daemon stays UP and running the whole
  // time, so its own poll-loop sweep (not a restart/restore) is what has to get
  // this right.
  expect(await until(() => daemonLog(cfgDir).includes('ask-abandoned-long-outage'), 8000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-permission-decision-queue-still-waiting-notice');
  const lastEdit = tg.edits().at(-1);
  expect(lastEdit).toContain('queued "Approve"');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);

test('QUEUED DECISION NOTICE survives a daemon restart (notifiedAt persisted): the notice never re-fires after a bounce', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // A generous retention window (the notice must survive well within it) but a
  // tiny notice threshold, so the notice fires while the daemon is still up.
  const daemon1 = await startDaemon(cfgDir, tg.port, { TG_CTL_QUEUED_DECISION_NOTICE_MS: '300' });

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 821, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-permission-decision-queue-still-waiting-notice'), 4000)).toBe(true);

  // Bounce the daemon RIGHT after the notice fired — `notifiedAt` must have been
  // persisted immediately (not only on the next unrelated mutation), the same
  // durability guarantee the queue itself gets.
  daemon1.kill(9);
  await daemon1.exited;

  const daemon2 = await startDaemon(cfgDir, tg.port, { TG_CTL_QUEUED_DECISION_NOTICE_MS: '300' });
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);

  // Give the poll-loop sweep a chance to run — the notice must NOT re-fire.
  await Bun.sleep(600);
  const noticeCount = (daemonLog(cfgDir).match(/ask-permission-decision-queue-still-waiting-notice/g) ?? []).length;
  expect(noticeCount).toBe(1);

  // And the queued decision itself must still be fully alive and deliverable.
  const ask2 = startAsk(cfgDir, tg.port, PERMISSION);
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });

  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 35_000);

test('RESTORE→TAP→LATE-DELIVER (headline): a SIGKILLed daemon restores a pending question and a tap after restart injects it into the pane', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;
  // The live pending scoped question is persisted on forward.
  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  expect(await until(() => existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).questions.length === 1, 4000)).toBe(true);

  // SIGKILL the daemon (no close handler runs) AND the hook process (the agent's 120s
  // budget elapsed — it will NOT reconnect). The only record of the question is now the
  // persisted file.
  daemon1.kill(9);
  await daemon1.exited;
  ask.kill(9);
  await ask.exited;

  // Restart: the daemon restores the pending question into `abandoned` (no live socket).
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);
  expect(tg.cards()).toHaveLength(1); // nothing re-posted

  // The human taps AFTER the restart. With no hook to answer, the chosen option is
  // late-delivered into the asking pane — the whole point of persisting the question.
  tg.push([tap(productionData, 810, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-delivered'), 4000)).toBe(true);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('RECONNECT: a daemon bounce mid-block re-attaches the card (no duplicate) and the answer flows', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1);
  expect(productionData).not.toBeNull();

  // Crash the daemon (SIGKILL — no clean exit). The blocked `tg-ctl ask` socket drops
  // and its reconnect loop begins resending the SAME requestId.
  daemon1.kill(9);
  await daemon1.exited;

  // Relaunch against the SAME config dir + mock: it restores the question from disk.
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);
  // The reconnecting ask re-attaches to the existing card — no second card posted.
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward reattached'), 8000)).toBe(true);
  expect(tg.cards()).toHaveLength(1);

  // Now the human taps. The answer must flow down the RECONNECTED socket and unblock ask.
  tg.push([tap(productionData!, 800, 1)]);
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { answers: { 'Where should I deploy?': 'Production' } } },
  });
  expect(tg.cards()).toHaveLength(1); // STILL one card across the whole bounce
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('RECONNECT replay: a question ANSWERED before the bounce replays its answer to the resend (no duplicate card)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;

  // Answer it — the hook gets its answer and exits; the answer is persisted.
  tg.push([tap(productionData, 900, 1)]);
  const out1 = await new Response(ask1.stdout).text();
  await ask1.exited;
  expect(JSON.parse(out1)).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { 'Where should I deploy?': 'Production' } } } });

  // Bounce the daemon. The answered-replay cache must survive on disk.
  daemon1.kill(9);
  await daemon1.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);

  // A re-fire of the SAME requestId after the restart must REPLAY (no second card).
  const ask2 = startAsk(cfgDir, tg.port, QUESTION);
  const out2 = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out2)).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { 'Where should I deploy?': 'Production' } } } });
  expect(daemonLog(cfgDir)).toContain('ask-forward replayed-answer');
  expect(tg.cards()).toHaveLength(1); // no duplicate card across the bounce
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('MID-SEND race: an unscoped socket that closes WHILE the card is still sending still clears the keyboard + expires it', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  // Hold the card's sendMessage RESPONSE open so the daemon's messageId stays null
  // when we close the socket — the post-send reconciliation branch must then apply the
  // dead-card text AND clear the keyboard (the `finalText === EXPIRED ? clear` path).
  tg.delaySend(900);
  const ask = startAsk(
    cfgDir,
    tg.port,
    { requestId: 'q_unscoped_midsend', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  // The card is recorded by the mock the moment the daemon calls sendMessage; the
  // response is still stalled (messageId not yet known to the daemon).
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Close the asking socket mid-send → the close handler stashes the dead-card text
  // with messageId still null; when sendMessage finally resolves the reconciliation
  // clears the keyboard and expires the card.
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().includes('expired — answer in terminal'), 8000)).toBe(true);
  expect(await until(() => tg.keyboardClears() >= 1, 4000)).toBe(true);
}, 20_000);

test('SAFETY: an unscoped question pending at SIGKILL is NOT persisted and NOT resurrected (it would wedge ALL pane routing)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);

  // An UNSCOPED question (no paneId) defers EVERY pane while pending — restoring it
  // would wedge all routing. Forward one and leave it pending.
  startAsk(
    cfgDir,
    tg.port,
    { requestId: 'q_unscoped_safety', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const yesData = tg.optionData(0)!;

  // The persist filter must EXCLUDE the unscoped question from disk (no paneId).
  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  expect(await until(() => existsSync(statePath), 4000)).toBe(true);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  expect(state.questions.some((q: { req: { requestId: string } }) => q.req.requestId === 'q_unscoped_safety')).toBe(false);

  // SIGKILL (no close handler) → restart. The unscoped question must NOT come back.
  daemon1.kill(9);
  await daemon1.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);

  // A tap on the dead unscoped card after restart resolves to "expired" — it was not
  // resurrected as deliverable — and nothing is injected. (The mock's getUpdates queue
  // holds the tap until daemon2 starts polling, so no readiness wait is needed.)
  tg.push([tap(yesData, 830, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 8000)).toBe(true);
  expect(injected(cfgDir).length).toBe(0);

  // Routing is NOT wedged: a fresh SCOPED question still posts its card normally.
  startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('MID-SEND scoped backfill: a socket closing WHILE the card sends still records the card id, so a later tap late-delivers to the RIGHT card', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  // Hold the card's sendMessage RESPONSE open so the daemon's messageId stays null
  // while we close the scoped ask socket — exercising the abandoned-entry backfill that
  // runs once the send finally resolves.
  tg.delaySend(900);
  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;

  // Close the socket mid-send: the close handler retains an abandoned entry with
  // messageId null; when sendMessage resolves the backfill must stamp the real card id.
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('Time-out expired.')), 6000)).toBe(true);

  // The persisted abandoned entry now carries the REAL messageId (1), not null.
  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  expect(
    await until(() => {
      if (!existsSync(statePath)) return false;
      const s = JSON.parse(readFileSync(statePath, 'utf8'));
      const q = (s.questions ?? []).find((x: { req: { requestId: string }; messageId: number | null }) => x.req.requestId === 'q_durable');
      return Boolean(q) && q.messageId === 1;
    }, 4000),
  ).toBe(true);

  // A late tap late-delivers and edits the RIGHT card (message_id 1) to answered.
  tg.push([tap(productionData, 820, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Production')), 4000)).toBe(true);
}, 25_000);

test('EXPIRY clears the keyboard for a genuinely-dead unscoped card', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: '1200' });

  startAsk(cfgDir, tg.port, { requestId: 'q_unscoped_dead', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] }, { unscoped: true });
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // No answer → the unscoped bound elapses → the card is dead: keyboard CLEARED + expired.
  expect(await until(() => tg.edits().includes('expired — answer in terminal'), 8000)).toBe(true);
  expect(tg.keyboardClears()).toBeGreaterThanOrEqual(1);
}, 20_000);

// ---------------------------------------------------------------------------
// Permission durability (tg-cli#57) — three guarantees for permission-kind prompts:
//   A. Socket close keeps the permission card live for reconnect (not expired).
//   B. Daemon bounce re-attaches the card; eventual tap delivers via the new socket.
//   C. A tap with NO live socket shows "expired" (no pane-inject path for permissions).
// ---------------------------------------------------------------------------

test('PERM RETAIN: scoped permission keeps card live after socket close (not expired)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Kill the hook socket (hook's 120s budget elapsed or process died).
  ask.kill(9);
  await ask.exited;

  // Card must show "hook disconnected" AND identify which pane it disconnected for
  // (the cwd project basename, since this fixture sends no windowName) so a fleet
  // with several agents can tell which one needs a terminal answer; keyboard must
  // stay live (no expire, no clear).
  const paneLabel = basename(cfgDir);
  expect(
    await until(
      () => tg.edits().some((e) => e.includes('hook disconnected') && e.includes(paneLabel)),
      5000,
    ),
  ).toBe(true);
  expect(tg.edits().some((e) => e.includes('expired'))).toBe(false);
  expect(tg.keyboardClears()).toBe(0);
}, 20_000);

test('PERM RECONNECT: daemon bounce mid-block re-attaches the permission card and answer flows', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  expect(await until(() => hasPersistedQuestion(cfgDir, 'p_durable'), 4000)).toBe(true);

  // SIGKILL the daemon (socket drops; hook reconnect loop begins resending the same requestId).
  daemon1.kill(9);
  await daemon1.exited;

  // Restart — daemon restores the permission from disk.
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);
  // The hook reconnects and re-attaches to the existing card — no second card posted.
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward reattached'), 8000)).toBe(true);
  expect(tg.cards()).toHaveLength(1);

  // Tap approve — answer must flow down the reconnected socket and unblock ask.
  tg.push([tap('tgq:p_durable:allow', 801, 1)]);
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(tg.cards()).toHaveLength(1); // still one card across the whole bounce
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 35_000);

test('PERM QUEUE: a tap on a retained-but-disconnected permission card is queued, never silently dropped', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  expect(await until(() => hasPersistedQuestion(cfgDir, 'p_durable'), 4000)).toBe(true);

  // Kill BOTH daemon and hook (hook budget expired — won't reconnect on its own).
  daemon1.kill(9);
  await daemon1.exited;
  ask.kill(9);
  await ask.exited;

  // Restart — daemon restores the permission as abandoned.
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);
  expect(tg.cards()).toHaveLength(1); // nothing re-posted

  // User taps Approve with no live socket. A permission can't be delivered via
  // terminal-text injection, but per the CTO's requirement a tap must NEVER be
  // silently discarded either — it is QUEUED on the retained entry (see
  // lateDeliverAbandonedQuestion) and both the toast and the card say so plainly,
  // instead of the old "expired" wording that implied the tap did nothing at all.
  tg.push([tap('tgq:p_durable:allow', 802, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('queued')), 6000)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);
  // PERMISSION carries promptTurnId, so this is the case where auto-delivery is
  // genuinely possible -- the toast AND the card must BOTH make the "will
  // deliver automatically" promise, and they must AGREE with each other
  // (mirror of the no-promptTurnId disagreement review finding, positive path).
  const toast = tg.answeredCbs().findLast((c) => c.text.includes('queued'));
  expect(toast?.text).toContain('will send once the hook reconnects');
  const cardEdit = tg.edits().find((e) => e.includes('queued') && e.includes('Approve'));
  expect(cardEdit).toContain('delivered automatically once the hook reconnects');
  // Still nothing injected into the pane (no text-inject path for permissions).
  expect(injected(cfgDir).length).toBe(0);
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('PERM QUEUE DELIVER: a queued decision reaches the agent automatically once the hook reconnects', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // The hook socket disconnects (harness's own hook budget, or a crash) while the
  // daemon stays up — this is the case that structurally CANNOT "reconnect and
  // deliver" through the closed process, so the queue is the only honest path.
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  // Tap Approve while disconnected — queued, not delivered yet.
  tg.push([tap('tgq:p_durable:allow', 803, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('queued')), 6000)).toBe(true);

  // A fresh hook invocation for the SAME requestId reconnects (e.g. the harness or
  // the human retries the same permission prompt). The daemon must deliver the
  // QUEUED decision immediately down the new socket, with no further tap needed.
  const ask2 = startAsk(cfgDir, tg.port, PERMISSION);
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Approve')), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-forward queued-decision-delivered');
  expect(tg.cards()).toHaveLength(1); // still just the one original card

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE LAST-TAP-WINS: a second tap overwrites the queued decision (covers a misclick)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  // Misclick Approve, then correct to Reject before the hook ever reconnects.
  tg.push([tap('tgq:p_durable:allow', 810, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);
  tg.push([tap('tgq:p_durable:deny', 811, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Reject')), 4000)).toBe(true);

  // Reconnect must deliver the LATEST (deny), not the first tap.
  const ask2 = startAsk(cfgDir, tg.port, PERMISSION);
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
  });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE EXPIRE: a tap past the retention window is refused (expired), never queued', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // Tiny retention window so the delivery-time check (not just the periodic sweep)
  // is what rejects a too-late tap.
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600', TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '600' });
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  await Bun.sleep(900);
  tg.push([tap('tgq:p_durable:allow', 812, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 6000)).toBe(true);
  expect(tg.answeredCbs().some((c) => c.text.includes('queued'))).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE RESTART: a queued decision survives a daemon crash and still delivers on reconnect', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 813, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // SIGKILL the daemon right after the tap — the queued decision must have been
  // persisted immediately (not only on the next unrelated mutation).
  daemon1.kill(9);
  await daemon1.exited;

  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), RESTORE_WAIT_MS)).toBe(true);

  const ask2 = startAsk(cfgDir, tg.port, PERMISSION);
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(daemonLog(cfgDir)).toContain('ask-forward queued-decision-delivered');

  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 35_000);

test('PERM QUEUE EXPIRED AT RECONNECT: a queued decision past its own window is NOT auto-delivered on a late reconnect (tg-cli#182 round 4 review finding — Codex High)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // Tiny permission window so the entry is genuinely past it by the time the
  // reconnect (ask2) lands — proves the synchronous age check at the
  // reconnect-delivery point, not just the periodic sweep, since the sweep
  // could otherwise race a reconnect arriving in the same tick.
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '700' });
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 863, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // Wait past the permission's own window, then reconnect. In this daemon's
  // real timing the periodic sweep (running on the same ~60ms idle-poll
  // cadence used elsewhere in this file) is very likely to have already
  // pruned the entry via the ordinary abandoned-long-outage path before the
  // reconnect lands — that's a SAFE outcome too, not a test bug: either that
  // sweep OR this diff's new synchronous check (queued-decision-expired-at-
  // reconnect, exercised when a reconnect genuinely races the sweep) must
  // prevent the stale delivery. The property under test is the OUTCOME
  // (never deliver a decision past its own window), not which of the two
  // safety nets caught it — deterministically forcing the exact race window
  // between "expired" and "swept" from outside the process isn't reliable.
  await Bun.sleep(1200);
  const ask2 = startAsk(cfgDir, tg.port, PERMISSION);

  // Must NOT receive the stale queued "allow" under ANY code path: whichever
  // safe path fired (reattached to a fresh live prompt, or a genuinely new
  // card because the sweep already pruned the old entry), ask2 stays BLOCKED
  // waiting for a real decision — it must NOT resolve immediately with the
  // stale answer. Give the daemon a moment to have processed the reconnect
  // either way, then confirm ask2 is still running (never exited/resolved).
  await Bun.sleep(1500);
  expect(ask2.exitCode).toBeNull();
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');

  ask2.kill(9);
  await ask2.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE MISMATCH GUARD: a reconnect with a DIFFERENT question under the same requestId does not auto-approve', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 814, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // A harness reusing the SAME requestId against a MUTATED payload (a different
  // command the human never saw) must NOT have the stale queued "allow" silently
  // rubber-stamped onto it — it must fall through to a fresh live prompt instead.
  const mutated = { ...PERMISSION, question: 'Allow bash command: rm -rf /home?' };
  const ask2 = startAsk(cfgDir, tg.port, mutated);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward queued-decision-discarded'), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');
  // The card is restored to a LIVE prompt (re-attached), not silently answered.
  expect(await until(() => tg.edits().some((e) => e.includes('Allow bash command: rm -rf /home?')), 4000)).toBe(true);

  ask2.kill(9);
  await ask2.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE MISMATCH GUARD (toolInput): a reconnect with the SAME question but a DIFFERENT toolInput does not auto-approve', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const withInput = { ...PERMISSION, toolInput: { file_path: '/etc/passwd', content: 'v1' } };
  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, withInput);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 816, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // SAME displayed question, but the tool_input (what actually gets written) is
  // different — a bare question-text match would wrongly rubber-stamp this.
  const mutatedInput = { ...PERMISSION, toolInput: { file_path: '/etc/passwd', content: 'MALICIOUS v2' } };
  const ask2 = startAsk(cfgDir, tg.port, mutatedInput);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward queued-decision-discarded'), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');

  ask2.kill(9);
  await ask2.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE MISMATCH GUARD (no promptTurnId): a reconnect with the SAME requestId AND matching payload but NO turn-level identity proof never auto-approves', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // Without prompt_id/turn_id (an older Claude Code, a harness with no
  // equivalent field, or a manual/back-compat caller), requestId is only
  // SESSION-scoped -- a same-session re-run of an identical command is a
  // routine, non-malicious occurrence, so auto-delivery must be refused
  // entirely, not merely time-bounded. This must NOT be a silent drop either:
  // the card is restored to a LIVE, freshly-buttoned prompt (not left dead, not
  // left falsely claiming "queued") -- visibly pending again so the human can
  // explicitly re-decide, rather than a stale tap being silently reapplied.
  const { promptTurnId, ...noTurnId } = PERMISSION;
  void promptTurnId;

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, noTurnId);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 817, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // BOTH the CARD text (queuedPermissionDecisionText) and the ephemeral tap
  // TOAST (answerCallbackQuery) must make the SAME honest promise -- neither
  // may claim "will send once the hook reconnects" / "delivered automatically"
  // when this exact entry can never auto-deliver (Codex review finding on the
  // PR: the toast and the card text must not disagree with each other).
  const cardEdit = tg.edits().find((e) => e.includes('queued') && e.includes('Approve'));
  expect(cardEdit).not.toContain('delivered automatically once the hook reconnects');
  expect(cardEdit).toContain("won't auto-deliver");

  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('queued')), 4000)).toBe(true);
  const tapToast = tg.answeredCbs().findLast((c) => c.text.includes('queued'));
  expect(tapToast?.text).not.toContain('will send once the hook reconnects');
  expect(tapToast?.text).toContain('tap again');

  // Byte-identical payload "reconnects" immediately -- exact requestId match,
  // exact payload match -- yet must NOT auto-deliver: there is no proof this is
  // the SAME invocation rather than a routine same-session re-run.
  const ask2 = startAsk(cfgDir, tg.port, noTurnId);
  expect(await until(() => daemonLog(cfgDir).includes('no promptTurnId'), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');

  // The card must come back LIVE with fresh buttons (buildButtonMessage's own
  // text, no "queued"/"disconnected" wording) -- proving the tap wasn't just
  // silently thrown away with no visible trace.
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward reattached'), 4000)).toBe(true);
  const lastEdit = tg.edits().at(-1);
  expect(lastEdit).not.toContain('queued');
  expect(lastEdit).not.toContain('hook disconnected');
  expect(lastEdit).toContain('Allow bash command: rm -rf /tmp/test?');

  // And it must be genuinely re-tappable: a fresh Approve on THIS live prompt
  // still resolves the reconnecting hook's own request normally (not stuck,
  // not silently ignored).
  tg.push([tap('tgq:p_durable:allow', 823, 1)]);
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE NOTICE (no promptTurnId): a queued decision with no turn-level identity proof gets NO "still be delivered automatically" notice — that promise would be false for it', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // The "still waiting to reconnect ... will still be delivered automatically"
  // notice must never fire for an entry that CAN'T actually auto-deliver on
  // reconnect (the promptTurnId gate in handleHookSocketLine refuses it) --
  // saying so anyway would tell the human to sit on their hands about a
  // decision that, in fact, needs a fresh re-tap (review finding).
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_QUEUED_DECISION_NOTICE_MS: '300' });
  const { promptTurnId, ...noTurnId } = PERMISSION;
  void promptTurnId;

  const ask = startAsk(cfgDir, tg.port, noTurnId);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 824, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // The TAP-TIME text itself (queuedPermissionDecisionText) must not make the
  // unconditional "delivered automatically once the hook reconnects" promise
  // either — that's exactly as false at tap time as it is at notice time for a
  // no-promptTurnId entry (review finding: the notice text was fixed but the
  // tap-time text made the same overclaim).
  const tapTimeEdit = tg.edits().find((e) => e.includes('queued') && e.includes('Approve'));
  expect(tapTimeEdit).not.toContain('delivered automatically once the hook reconnects');
  expect(tapTimeEdit).toContain("won't auto-deliver");

  // Well past the notice threshold — give the poll loop several chances to fire
  // the notice, and confirm it never does for this entry.
  await Bun.sleep(900);
  expect(daemonLog(cfgDir)).not.toContain('ask-permission-decision-queue-still-waiting-notice');
  const lastEdit = tg.edits().at(-1);
  expect(lastEdit).toContain('queued') ; // still the original tap-time edit, untouched
  expect(lastEdit).not.toContain('will still be delivered automatically');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE NOTICE IS NOT AN EXPIRY (tg#9982): crossing the proactive notice threshold does not clear the queue or block a later genuine reconnect (still well inside the real retention window)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // Tiny NOTICE threshold (distinct from the daemon's real, much longer
  // default ABANDONED_PERMISSION_RETAIN_MS, left at its default 12h here —
  // this test's reconnect lands seconds later, nowhere near it) — proves the
  // NOTICE threshold specifically is notice-only: crossing IT must not clear
  // the queue or block a later genuine reconnect from delivering it, within
  // the real (longer, tg-cli#182) retention window. Delivery safety comes
  // from requestId itself being scoped to the prompt TURN (hook-normalize.ts's
  // invocationSeed) — this test uses the SAME requestId throughout, i.e. the
  // "genuine reconnect" case — not from the notice threshold.
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_QUEUED_DECISION_NOTICE_MS: '500' });
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 818, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // Well past the notice threshold — the proactive "still waiting" notice should
  // have fired by now, but the queue itself must survive it.
  expect(await until(() => daemonLog(cfgDir).includes('ask-permission-decision-queue-still-waiting-notice'), 4000)).toBe(true);

  // The SAME payload reconnects, long after the notice — still a genuine
  // reconnect (identical requestId + matching payload), so it MUST deliver.
  const ask2 = startAsk(cfgDir, tg.port, PERMISSION);
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(daemonLog(cfgDir)).toContain('ask-forward queued-decision-delivered');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE LATER UNRELATED REQUEST: a DIFFERENT requestId (a materially later, unrelated turn) never receives the stale queued decision', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // In production a later, unrelated turn gets a DIFFERENT requestId because
  // requestId is scoped to the prompt turn (hook-normalize.ts's invocationSeed:
  // Claude's prompt_id / Codex's turn_id) — even when it asks an identical
  // question with identical toolInput. Modeled here directly at the daemon
  // level: PERMISSION_LATER is byte-identical to PERMISSION except its
  // requestId, standing in for "the same-looking command in a new turn".
  const PERMISSION_LATER = { ...PERMISSION, requestId: 'p_durable_later' };

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 818, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  // A DIFFERENT requestId "reconnects" immediately — it must never see the
  // queued decision at all: it doesn't even reach the reconnect/matching branch
  // (no retained entry under this key), so it just posts an ordinary fresh card.
  const ask2 = startAsk(cfgDir, tg.port, PERMISSION_LATER);
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');

  ask2.kill(9);
  await ask2.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE MISMATCH GUARD (promptTurnId): a reconnect with the SAME requestId AND matching payload but a DIFFERENT promptTurnId does not auto-approve', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // requestId alone (djb2, a SHORT hash) is not collision-proof — the actual
  // defense against a hash collision (or a manual/back-compat caller reusing a
  // requestId with a mutated identity) is permissionPayloadMatches's explicit
  // promptTurnId comparison, independent of the requestId match. Model that
  // directly: same requestId, same everything else, but a DIFFERENT promptTurnId.
  const daemon = await startDaemon(cfgDir, tg.port);
  const ask1 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 828, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  const mismatchedTurnId = { ...PERMISSION, promptTurnId: 'turn_different' };
  const ask2b = startAsk(cfgDir, tg.port, mismatchedTurnId);
  expect(await until(() => daemonLog(cfgDir).includes('promptTurnId does not match'), 6000)).toBe(true);
  expect(daemonLog(cfgDir)).not.toContain('ask-forward queued-decision-delivered');

  ask2b.kill(9);
  await ask2b.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('PERM QUEUE STILL WAITING NOTICE: past the notice threshold with no reconnect, the human gets a proactive notice but the queue is NEVER cleared', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // A queued decision must stay queued past QUEUED_DECISION_NOTICE_MS — the
  // threshold only triggers a proactive "still waiting to reconnect" notice
  // (Alex tg#9982: report a long outage, never silently drop the tap), and the
  // card must keep claiming the decision is still deliverable, not "hook
  // disconnected" with no memory of the tap.
  const daemon2 = await startDaemon(cfgDir, tg.port, { TG_CTL_QUEUED_DECISION_NOTICE_MS: '500' });
  const ask3 = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask3.kill(9);
  await ask3.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 819, 1)]);
  expect(
    await until(() => tg.edits().some((e) => e.includes('delivered automatically once the hook reconnects')), 4000),
  ).toBe(true);

  // No reconnect, no further tap — just wait past the notice threshold. The
  // daemon's own poll-loop sweep must proactively NOTIFY (same cadence as the
  // long-outage sweep) — but the card must still say the decision is queued and
  // deliverable, NOT fall back to the plain "hook disconnected" text with no
  // memory of the tap.
  expect(await until(() => daemonLog(cfgDir).includes('ask-permission-decision-queue-still-waiting-notice'), 6000)).toBe(true);
  const editsAfterNotice = tg.edits();
  expect(editsAfterNotice.at(-1)).toContain('still waiting to reconnect');
  expect(editsAfterNotice.at(-1)).toContain('NOT been discarded');
  expect(editsAfterNotice.at(-1)).toContain('Approve');

  // The notice must fire only ONCE (idempotent via queuedDecision.notifiedAt),
  // not spam on every subsequent sweep.
  await Bun.sleep(600);
  const noticeCount = (daemonLog(cfgDir).match(/ask-permission-decision-queue-still-waiting-notice/g) ?? []).length;
  expect(noticeCount).toBe(1);

  // A genuine reconnect AFTER the notice must still deliver the queued decision —
  // the notice is informational only, it never disables delivery.
  const ask4 = startAsk(cfgDir, tg.port, PERMISSION);
  const out = await new Response(ask4.stdout).text();
  await ask4.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });

  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);

test('PERM QUEUE RE-TAP RESETS NOTICE: after the still-waiting notice fires, a re-tap (last tap wins) gets its OWN fresh notice cycle for the NEW decision', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  // The tap handler builds a FRESH queuedDecision object on every tap (never
  // mutates the existing one in place), so notifiedAt is implicitly cleared —
  // this proves that end-to-end: tap Approve, let the notice fire and consume
  // its one-shot, then re-tap Reject and confirm the notice fires AGAIN for
  // the NEW decision (not permanently suppressed by the first notice).
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_QUEUED_DECISION_NOTICE_MS: '500' });
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);

  tg.push([tap('tgq:p_durable:allow', 826, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Approve')), 4000)).toBe(true);

  expect(await until(() => daemonLog(cfgDir).includes('ask-permission-decision-queue-still-waiting-notice'), 4000)).toBe(true);
  expect(tg.edits().at(-1)).toContain('queued "Approve"');
  const noticeCountAfterFirst = (daemonLog(cfgDir).match(/ask-permission-decision-queue-still-waiting-notice/g) ?? []).length;
  expect(noticeCountAfterFirst).toBe(1);

  // Re-tap: the human changes their mind to Reject. This also refreshes
  // retained.at (PERM QUEUE LAST-TAP-WINS's fresh-activity semantics), so the
  // notice threshold is measured again from THIS tap.
  tg.push([tap('tgq:p_durable:deny', 827, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('queued') && e.includes('Reject')), 4000)).toBe(true);

  // A SECOND still-waiting notice must fire, naming the NEW decision — proving
  // notifiedAt was reset by the re-tap, not stuck from the first notice.
  expect(
    await until(() => (daemonLog(cfgDir).match(/ask-permission-decision-queue-still-waiting-notice/g) ?? []).length >= 2, 6000),
  ).toBe(true);
  const lastEdit = tg.edits().at(-1);
  expect(lastEdit).toContain('still waiting to reconnect');
  expect(lastEdit).toContain('queued "Reject"');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// ---------------------------------------------------------------------------
// Plain-text-reply-as-decision (human-requested live feature): a plain-text
// reply to a PENDING permission card resolves it exactly the same as tapping
// a button — same 'answer-question' Action, same downstream code, with an
// empty callbackQueryId sentinel that answerCallbackQuery silently no-ops on
// (the card's own edit is the visible feedback; there is no real Telegram
// callback query to acknowledge).
// ---------------------------------------------------------------------------

test('TEXT-REPLY DECISION: a plain-text reply to a LIVE permission card resolves it exactly like a button tap', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // A plain-text reply to the card's message (id 1, per mockTelegram's fixed
  // message_id) with an affirmative token — no button tap involved.
  tg.push([
    {
      update_id: 900,
      message: {
        message_id: 901,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'yes',
        reply_to_message: {
          message_id: 1,
          chat: { id: 1 },
          date: Math.floor(Date.now() / 1000) - 30,
          text: 'Permission from claude\n\nAllow bash command: rm -rf /tmp/test?',
        },
      },
    },
  ]);

  // The decision reaches the hook exactly like a real button tap would.
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  // The card is edited to the SAME answered text a real tap produces.
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Approve')), 4000)).toBe(true);
  // No real Telegram callback query existed for this text reply — the empty
  // callbackQueryId sentinel must never reach answerCallbackQuery's HTTP call.
  expect(tg.answeredCbs().length).toBe(0);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);

test('TEXT-REPLY DECISION: an unrelated plain-text reply to the same card does NOT resolve it', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  tg.push([
    {
      update_id: 902,
      message: {
        message_id: 903,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'sounds good, thanks',
        reply_to_message: {
          message_id: 1,
          chat: { id: 1 },
          date: Math.floor(Date.now() / 1000) - 30,
          text: 'Permission from claude\n\nAllow bash command: rm -rf /tmp/test?',
        },
      },
    },
  ]);

  // No positive event to await here (the whole point is that nothing happens):
  // a real daemon process racing a real HTTP mock has no fake-timer seam, so a
  // bounded real wait is the deliberate exception (matches this file's own
  // "prove nothing happened" tests, e.g. PERM QUEUE EXPIRE) — then confirm the
  // card is STILL pending/unanswered: the hook has not received a decision,
  // and no "Selected answer" edit was ever posted.
  await Bun.sleep(800);
  expect(ask.exitCode).toBeNull();
  expect(tg.edits().some((e) => e.includes('Selected answer'))).toBe(false);

  ask.kill(9);
  await ask.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('TEXT-REPLY DECISION: a multiQuestion permission card is NOT resolved by a text reply (excluded by design)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  // A multi-question SET MEMBER's lone answer must never be resolvable via the
  // text-reply shortcut (permissionRequestIdForMessage excludes multiQuestion) —
  // the local dialog may be showing a DIFFERENT question of the set.
  const ask = startAsk(cfgDir, tg.port, { ...PERMISSION, multiQuestion: true });
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  tg.push([
    {
      update_id: 910,
      message: {
        message_id: 911,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'yes',
        reply_to_message: {
          message_id: 1,
          chat: { id: 1 },
          date: Math.floor(Date.now() / 1000) - 30,
          text: 'Permission from claude\n\nAllow bash command: rm -rf /tmp/test?',
        },
      },
    },
  ]);

  // No positive event to await for "excluded, nothing resolved" — see the
  // sibling negative test above for the same real-daemon-timing rationale.
  await Bun.sleep(800);
  expect(ask.exitCode).toBeNull();
  expect(tg.edits().some((e) => e.includes('Selected answer'))).toBe(false);

  ask.kill(9);
  await ask.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('TEXT-REPLY DECISION: a question-kind card is NOT resolved by a text reply (permission-only scope)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // "yes" is a recognized decision token, but the card is a QUESTION, not a
  // PERMISSION — permissionRequestIdForMessage must never match it.
  tg.push([
    {
      update_id: 912,
      message: {
        message_id: 913,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'yes',
        reply_to_message: {
          message_id: 1,
          chat: { id: 1 },
          date: Math.floor(Date.now() / 1000) - 30,
          text: 'Question from claude\n\nWhere should I deploy?',
        },
      },
    },
  ]);

  // The pane has an OPEN question, so this reply is deferred (queued behind it,
  // features/tg-ctl's defer-while-waiting model) rather than injected immediately
  // — either way, the important property is that it never resolves the question
  // card itself via the decision path.
  await Bun.sleep(800);
  expect(ask.exitCode).toBeNull();
  expect(tg.edits().some((e) => e.includes('Selected answer'))).toBe(false);

  ask.kill(9);
  await ask.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('TEXT-REPLY DECISION: a same-batch race (button tap resolves the card a moment before a text reply lands) notifies via plain chat reply, not silence', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Both updates land in the SAME poll batch: a button tap AND a text-reply
  // decision for the SAME card. stepUpdates computes both actions against the
  // pre-apply state (pending still present for both), but callback-derived
  // actions dispatch before message-derived ones sharing the same requestId key
  // — so the tap resolves the card first, and the text-reply's answer-question
  // action then finds it already gone. The empty-sentinel no-op in
  // answerCallbackQuery would otherwise swallow this outcome entirely; the
  // fallback (answerCallbackQueryOrNotify) must send a plain chat reply instead.
  tg.push([
    tap('tgq:p_durable:allow', 920, 1),
    {
      update_id: 921,
      message: {
        message_id: 922,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'yes',
        reply_to_message: {
          message_id: 1,
          chat: { id: 1 },
          date: Math.floor(Date.now() / 1000) - 30,
          text: 'Permission from claude\n\nAllow bash command: rm -rf /tmp/test?',
        },
      },
    },
  ]);

  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Approve')), 4000)).toBe(true);
  // The real tap gets its normal "✓ sent to the agent" toast; the losing
  // text-reply has no callback query to toast, so it must get a plain chat
  // message instead of vanishing silently. A PERMISSION's answer is never
  // cached in answeredButtons (question-only replay cache — see the
  // "case answer-question" comment on why: silently replaying a prior
  // allow/deny would be a behavioral/security change), so the loser sees
  // "expired", not "already answered".
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
  expect(await until(() => tg.plainMessages().includes('expired'), 4000)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);
