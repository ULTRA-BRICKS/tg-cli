// tg-cli#403: critical/no-timeout hatch approval mode — the ASK CLIENT side.
// A `critical: true` ButtonRequest must ignore ASK_TOTAL_TIMEOUT_MS entirely and
// wait for a real decision no matter how long that takes, while a non-critical
// ask on the SAME (deliberately shortened, test-only) budget still times out
// exactly as before — critical is opt-in, not a behavior change for anyone who
// doesn't ask for it.
//
// This also regression-covers the setTimeout 32-bit overflow landmine
// (oneAskAttempt, tg-ctl root): a critical ask's deadline is Infinity, and
// Node/Bun's setTimeout silently clamps any delay > 2^31-1 ms to ~1ms and fires
// almost immediately — passing that straight through would flip "wait forever"
// into "time out instantly". Proven here by holding the critical ask open past
// what a NAIVE (unclamped) implementation would have fired at — the shortened
// TG_CTL_ASK_TOTAL_TIMEOUT_MS below stands in for that would-be-immediate
// firing, since actually waiting out 2^31-1 ms (~24.8 days) in a test is
// impractical; the pure-module test (hatch-critical-reminder.test.ts) covers
// the arithmetic at the scheduler layer directly.
//
// Harness mirrors ctl-hatch-approval-retry-integration.test.ts exactly (same
// mockTelegram/hermetic-host/daemon-lifecycle helpers) — hatch requests are
// structurally headless, so no real tmux pane is ever involved.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-hatch-critical-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  return cfgDir;
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

// Unlike ctl-hatch-approval-retry-integration.test.ts's startAsk, this accepts
// extra env — TG_CTL_ASK_TOTAL_TIMEOUT_MS is read by the ASK CLIENT process
// itself (askDaemon's module-scope const), not the daemon, so it must be set
// on THIS spawn, not the daemon's.
function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>, extraEnv: Record<string, string> = {}): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    ...extraEnv,
  };
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  ask.stdin.write(JSON.stringify({ cwd: cfgDir, ...request }) + '\n');
  ask.stdin.end();
  return ask;
}

interface MockTg {
  port: number;
  stop: (c?: boolean) => Promise<void> | void;
  push: (batch: unknown[]) => void;
  cards: () => unknown[];
  edits: () => string[];
  deletes: () => number[];
  answeredCbs: () => Array<{ callback_query_id: string; text: string }>;
  allowData: () => string | null;
}

function mockTelegram(): MockTg {
  const updateQueue: unknown[][] = [];
  const cards: unknown[] = [];
  const edits: string[] = [];
  const deletes: number[] = [];
  const answeredCbs: Array<{ callback_query_id: string; text: string }> = [];
  let lastKeyboard: Array<Array<{ callback_data: string }>> | null = null;
  let cardSeq = 900;

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
        cardSeq += 1;
        if (kb?.length) {
          cards.push(body);
          lastKeyboard = kb;
        }
        return Response.json({ ok: true, result: { message_id: cardSeq } });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        edits.push(String(((await req.json()) as Record<string, unknown>).text ?? ''));
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/deleteMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        deletes.push(Number(body.message_id));
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
    deletes: () => deletes,
    answeredCbs: () => answeredCbs,
    allowData: () => lastKeyboard?.[0]?.[0]?.callback_data ?? null,
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

const HOOK_ID = 'critical-hook';
const HATCH_REQUEST_ID = `hatch-${HOOK_ID}-cccccccccccc`;
const HATCH_ENV_VAR = 'RIG_HATCH_REQUEST_CRITICAL_HOOK';

function hatchRequest(critical: boolean): Record<string, unknown> {
  return {
    requestId: HATCH_REQUEST_ID,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
    critical,
  };
}

// The shortened budget stands in for ASK_TOTAL_TIMEOUT_MS's production 115s —
// short enough to keep the test fast, long enough to comfortably distinguish
// "timed out at ~this bound" from "still running well past it".
const SHORT_TIMEOUT_MS = '600';

test('CRITICAL BASELINE: a NON-critical ask on the same shortened budget DOES time out (proves the env override itself works)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, hatchRequest(false), { TG_CTL_ASK_TOTAL_TIMEOUT_MS: SHORT_TIMEOUT_MS });
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Nobody ever taps. The non-critical ask must give up and exit on its own,
  // printing "null" (no usable reply) once its shortened budget elapses.
  const out = await new Response(ask.stdout).text();
  const err = await new Response(ask.stderr).text();
  const exit = await ask.exited;
  expect(exit).toBe(0);
  expect(out.trim()).toBe('');
  expect(err).toContain('ask-forward timed-out');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 15_000);

test('CRITICAL WAIT (tg-cli#403): a critical-mode ask ignores the shortened budget, stays open well past it, and resolves only once a real decision lands', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, hatchRequest(true), { TG_CTL_ASK_TOTAL_TIMEOUT_MS: SHORT_TIMEOUT_MS });
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Wait well past the shortened budget (and past it again) with NO tap yet.
  // A naive (unguarded) implementation would have printed "null" and exited
  // around SHORT_TIMEOUT_MS; critical mode must still be blocked here. This
  // MUST be a genuine wall-clock wait, not a fake timer: the thing under
  // test is a REAL child process blocked on a REAL unix-domain-socket read
  // inside the daemon's own event loop (oneAskAttempt) — there is no virtual
  // clock to advance across a process boundary, only actually waiting proves
  // the process is still alive and un-timed-out at this real instant.
  await Bun.sleep(2000);
  expect(ask.killed).toBe(false);
  const stillRunning = await Promise.race([ask.exited.then(() => 'exited'), Bun.sleep(1).then(() => 'running')]);
  expect(stillRunning).toBe('running');
  // No timeout outcome was ever logged for this request while it stayed critical/pending.
  expect(daemonLog(cfgDir)).not.toContain('ask-forward timed-out');

  // Now a real decision lands.
  const allowData = tg.allowData()!;
  tg.push([tap(allowData, 701, tg.cards().length ? 901 : 1)]);

  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  // Still never timed out, even after resolving.
  expect(daemonLog(cfgDir)).not.toContain('ask-forward timed-out');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('CRITICAL REMINDER REPLACEMENT (tg-cli#403 acceptance criterion c): a new reminder deletes the previous reminder message, never the original card', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // Shrink the reminder interval so two reminders fire within the test window,
  // and force "never quiet" (start === end) so the cadence isn't at the mercy
  // of the CI runner's local clock landing inside the default 23-8 window.
  const daemon = await startDaemon(cfgDir, tg.port, {
    TG_CTL_CRITICAL_REMINDER_INTERVAL_MS: '500',
    TG_CTL_QUIET_HOURS_START_HOUR: '0',
    TG_CTL_QUIET_HOURS_END_HOUR: '0',
  });

  const ask = startAsk(cfgDir, tg.port, hatchRequest(true), { TG_CTL_ASK_TOTAL_TIMEOUT_MS: SHORT_TIMEOUT_MS });
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // Wait for at least TWO reminder sends (each a plain sendMessage with no
  // inline keyboard, so mockTelegram's `cards()` — keyboard-bearing sends only
  // — never counts them; every reminder increments cardSeq regardless).
  expect(await until(() => tg.deletes().length >= 1, 8000)).toBe(true);

  // The deleted message id must be a REMINDER's id, never the original card's.
  // The original card was the very first sendMessage (message_id 901, given
  // cardSeq starts at 900 and increments before assignment); nothing deletes it.
  expect(tg.deletes()).not.toContain(901);

  ask.kill(9);
  await ask.exited;
  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);
