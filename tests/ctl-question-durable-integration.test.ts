import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

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

function isProductionAnsweredEdit(text: string): boolean {
  return text.includes('Question answered') &&
    text.includes('Agent: claude') &&
    text.includes(`Subagent: pane ${PANE_ID}`) &&
    text.includes('Asked:\nWhere should I deploy?') &&
    text.includes('Selected:\nProduction') &&
    text !== 'answered: Production';
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
  // Hold every card-bearing sendMessage open for `ms` AFTER recording the card, so a
  // test can close the asking socket mid-send and exercise the messageId-null race.
  delaySend: (ms: number) => void;
}

function mockTelegram(): MockTg {
  const updateQueue: unknown[][] = [];
  const cards: unknown[] = [];
  const edits: string[] = [];
  const answeredCbs: Array<{ callback_query_id: string; text: string }> = [];
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
// callback_data values are the literal strings constructed below.
const PERMISSION = {
  requestId: 'p_durable',
  agent: 'claude',
  kind: 'permission',
  question: 'Allow bash command: rm -rf /tmp/test?',
  permissionEvent: 'PermissionRequest',
};

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(40);
  }
  return cond();
}

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
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);
  expect(tg.keyboardClears()).toBe(0); // a retained card stays tappable — NOT cleared

  // A LATE tap now lands. It must inject the chosen option into pane %1, not drop.
  tg.push([tap(productionData!, 700, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === '✓ sent to the agent'), 4000)).toBe(true);
  expect(await until(() => tg.edits().some(isProductionAnsweredEdit), 4000)).toBe(true);
  expect(daemonLog(cfgDir)).toContain('ask-late-delivered');
  // Once delivered the card stops being tappable — the keyboard is cleared, so a re-tap
  // in the 5–30 min answered/retention gap can't show a misleading "expired".
  expect(await until(() => tg.keyboardClears() >= 1, 4000)).toBe(true);
}, 25_000);

test('LATE-DELIVER failure: an unreachable pane keeps the entry retained for a re-tap (answer not lost)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const productionData = tg.optionData(1)!;
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

  // The pane is now GONE → the inject fails. The entry must NOT be consumed.
  writeFileSync(join(cfgDir, 'pane-gone'), '1');
  tg.push([tap(productionData, 710, 1)]);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-deliver-failed'), 6000)).toBe(true);
  expect(tg.answeredCbs().some((c) => c.text.includes('tap again'))).toBe(true);
  expect(tg.edits().some(isProductionAnsweredEdit)).toBe(false); // NOT marked answered
  // The retained entry is still on disk (recoverable by a re-tap).
  const state = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8'));
  expect(state.questions.some((q: { req: { requestId: string } }) => q.req.requestId === 'q_durable')).toBe(true);

  // Pane back → a RE-TAP now delivers the answer.
  const { unlinkSync } = await import('fs');
  unlinkSync(join(cfgDir, 'pane-gone'));
  tg.push([tap(productionData, 711, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => tg.edits().some(isProductionAnsweredEdit), 4000)).toBe(true);
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
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

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
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

  // Late tap → pane-delivered once; the answer is persisted with delivery:"pane".
  tg.push([tap(productionData, 770, 1)]);
  expect(await until(() => injected(cfgDir).some((l) => l.includes('Production')), 6000)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-late-delivered'), 4000)).toBe(true);
  const injectedAfterDeliver = injected(cfgDir).filter((l) => l.includes('Production')).length;

  // Bounce the daemon. The delivery:"pane" answer must survive the restore.
  daemon1.kill(9);
  await daemon1.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), 6000)).toBe(true);

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
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

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
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

  // Q2 is now LIVE-pending on the SAME pane (the agent is blocked on it).
  const ask2 = startAsk(cfgDir, tg.port, { requestId: 'q2_busy', agent: 'claude', kind: 'question', question: 'Restart service?', options: [{ label: 'Yes' }] });
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);
  const q2Data = tg.optionData(0)!; // Q2's only option

  // A late tap on Q1 must NOT inject (the pane is busy) and must NOT claim "sent".
  tg.push([tap(q1Data, 730, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('busy')), 6000)).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false); // NOT delivered
  expect(tg.edits().some(isProductionAnsweredEdit)).toBe(false);
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
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600' });

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const q1Data = tg.optionData(1)!;
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

  // Wait past the retention window, then a NEW forward triggers a persist → prune.
  await Bun.sleep(900);
  startAsk(cfgDir, tg.port, { requestId: 'q2_prune', agent: 'claude', kind: 'question', question: 'Other?', options: [{ label: 'Ok' }] });
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);

  // The stale Q1 is pruned: a late tap on it is NOT delivered — it falls to "expired".
  tg.push([tap(q1Data, 740, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 6000)).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false);
}, 25_000);

test('RETENTION enforced at DELIVERY time: a tap past the window on a quiet daemon (NO intervening mutation) is not delivered', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // Tiny retention window. Unlike the prune test above, NOTHING else is forwarded — so
  // the only thing that can drop the stale entry is the delivery-time age check (the
  // persist-time prune never runs without a mutation).
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_RETAIN_MS: '600' });

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  const q1Data = tg.optionData(1)!;
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

  // Wait past the window — NO new forward, NO other mutation — then tap. The
  // delivery-time check must reject it ("expired"), retire the card, and NOT inject.
  await Bun.sleep(900);
  tg.push([tap(q1Data, 745, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 6000)).toBe(true);
  expect(injected(cfgDir).some((l) => l.includes('Production'))).toBe(false);
  expect(daemonLog(cfgDir)).toContain('ask-late-deliver-expired');
  expect(tg.keyboardClears()).toBeGreaterThanOrEqual(1); // the now-dead card is retired
}, 25_000);

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
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), 6000)).toBe(true);
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
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), 6000)).toBe(true);
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
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), 6000)).toBe(true);

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
  expect(await until(() => tg.edits().some((e) => e.includes('tap still delivers')), 6000)).toBe(true);

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
  expect(await until(() => tg.edits().some(isProductionAnsweredEdit), 4000)).toBe(true);
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

  // Card must show "hook disconnected"; keyboard must stay live (no expire, no clear).
  expect(await until(() => tg.edits().some((e) => e.includes('hook disconnected')), 5000)).toBe(true);
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

  // SIGKILL the daemon (socket drops; hook reconnect loop begins resending the same requestId).
  daemon1.kill(9);
  await daemon1.exited;

  // Restart — daemon restores the permission from disk.
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), 6000)).toBe(true);
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

test('PERM LATE-TAP: a tap on a retained-but-dead permission card shows "expired"', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);

  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Kill BOTH daemon and hook (hook budget expired — won't reconnect).
  daemon1.kill(9);
  await daemon1.exited;
  ask.kill(9);
  await ask.exited;

  // Restart — daemon restores the permission as abandoned.
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'), 6000)).toBe(true);
  expect(tg.cards()).toHaveLength(1); // nothing re-posted

  // User taps Approve with no live socket. Permissions can't be delivered via
  // terminal-text injection — the callback gets "expired" so the user knows to
  // wait for the agent's own reconnect or retry.
  tg.push([tap('tgq:p_durable:allow', 802, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text === 'expired'), 6000)).toBe(true);
  // Nothing injected into the pane (no text-inject path for permissions).
  expect(injected(cfgDir).length).toBe(0);
  daemon2.kill('SIGTERM');
  await daemon2.exited;
}, 30_000);
