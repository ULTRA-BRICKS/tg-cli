import { appendFileSync } from 'node:fs';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
// tg-cli#403 acceptance criterion (d): the moment a CRITICAL hatch decision
// lands for a request whose underlying process has already exited (the exact
// original incident — a tap landing after the requesting command gave up
// waiting), it is pushed PROACTIVELY into a still-LIVE agent session via
// promptOmpAcp, not merely left discoverable on the Telegram card. Reuses
// ctl-omp-acp-integration.test.ts's fake-omp-binary + Bun.serve mock Telegram
// technique (a real ACP JSON-RPC child process, not a mock function) so the
// assertion is on the actual wire protocol frame, not an internal call spy.
//
// Hatch requests divert to the grant path (routeGrantNotice, tg-ctl) before
// reaching the older scoped-permission reconnect-queue UI, so the proactive
// push for hatch is routeGrantNotice's origin.agent === 'omp' branch, and the
// daemon logs `hatch-grant-notice-delivered`/`-failed` (not `hatch-critical-
// proactive-*` — nothing emits those anymore). The request payload carries
// `origin: { agent: 'omp' }` so routeGrantNotice's cwd-basename match finds
// the fixture's live session, matching what a real hatch escalation from
// inside a live omp session sends.
//
// The single most important safety property under test here (both tests
// below): promptOmpAcp/ensureOmpAcp is NEVER called for a cwd with no LIVE
// match — see tg-awareness-nudge.ts's own "Population" doc comment on why
// (ensureOmpAcp's attach path can itself SPAWN a session).
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const LIVE_CWD = '/Users/u/work/review-cli';
const SESSION_ID = '01a07d8e-c12c-7433-903d-e98726bfda37';

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

// Same fake `ps`/`lsof`/`omp` triplet as ctl-omp-acp-integration.test.ts: pid
// ${process.pid} is a live omp process whose cwd (via lsof) is LIVE_CWD and whose
// session jsonl (also via lsof) carries SESSION_ID.
function writeFakeBins(cfgDir: string, sessionFile: string, acpLog: string): string {
  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'tmux'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  writeFileSync(
    join(binDir, 'ps'),
    `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' ${process.pid} ttys004\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' ${process.pid}     1 /opt/homebrew/bin/omp\\n'
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, 'lsof'),
    `#!/bin/sh
printf 'p${process.pid}\\n'
printf 'fcwd\\n'
printf 'n${LIVE_CWD}\\n'
printf 'n${sessionFile}\\n'
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(binDir, 'omp'), `#!/bin/sh\nprintf 'FORBIDDEN\\n' >> '${acpLog}.spawned'\nexit 1\n`, { mode: 0o755 });
  return binDir;
}

async function makeCfgDir() {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-hatch-proactive-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // registration is irrelevant here — hatch bypasses the registration gate — but
  // harmless to include for parity with the other hatch fixtures.
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  const sessionDir = join(cfgDir, 'sessions');
  mkdirSync(sessionDir);
  const sessionFile = join(sessionDir, `2026-09-07T20-28-22-700Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      '{"type":"title","v":1,"title":"ReviewFix","source":"auto"}',
      `{"type":"session","version":3,"id":"${SESSION_ID}","cwd":"${LIVE_CWD}","title":"ReviewFix"}`,
      '',
    ].join('\n'),
  );
  const acpLog = join(cfgDir, 'acp.log');
  writeFileSync(acpLog, '');
  const binDir = writeFakeBins(cfgDir, sessionFile, acpLog);
  const ep = await startLiveEndpoint({ root: join(cfgDir, 'omp-live'),
    snapshot: () => ({ sessionId: SESSION_ID, sessionFile, cwd: LIVE_CWD, title: 'ReviewFix', busy: false }),
    send: (text: string) => { appendFileSync(acpLog, JSON.stringify({ event: 'original-input', sessionId: SESSION_ID, text }) + '\n'); },
  }); servers.push({ stop: () => ep.close() });
  return { cfgDir, binDir, acpLog, sessionFile };
}

async function startDaemon(cfgDir: string, binDir: string, acpLog: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      // The fake `omp` binary is `#!/usr/bin/env bun` — env needs bun's real
      // install dir on PATH to resolve it, hence appending process.env.PATH
      // (not just /usr/bin:/bin) — mirrors ctl-omp-acp-integration.test.ts.
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      OMP_ACP_LOG: acpLog,
      TMUX: '',
    },
    logFd,
  });
  closeSync(logFd);
  return daemon;
}

function startAsk(cfgDir: string, binDir: string, apiPort: number, request: Record<string, unknown>): Subprocess {
  const env: Record<string, string> = {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
  };
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  ask.stdin.write(JSON.stringify(request) + '\n');
  ask.stdin.end();
  return ask;
}

interface MockTg {
  port: number;
  stop: (c?: boolean) => Promise<void> | void;
  push: (batch: unknown[]) => void;
  cards: () => unknown[];
  edits: () => string[];
  editParseModes: () => Array<string | undefined>;
  allowData: () => string | null;
}

function mockTelegram(): MockTg {
  const updateQueue: unknown[][] = [];
  const cards: unknown[] = [];
  const edits: string[] = [];
  const editParseModes: Array<string | undefined> = [];
  let lastKeyboard: Array<Array<{ callback_data: string }>> | null = null;
  let cardSeq = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(50);
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
        const body = (await req.json()) as Record<string, unknown>;
        edits.push(String(body.text ?? ''));
        editParseModes.push(typeof body.parse_mode === 'string' ? body.parse_mode : undefined);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/deleteMessage')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
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
    editParseModes: () => editParseModes,
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

function daemonLog(cfgDir: string): string {
  const p = join(cfgDir, 'daemon.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

test('a late Deny on a disconnected hatch card carries parse_mode HTML', async () => {
  const { cfgDir, binDir, acpLog } = await makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, binDir, acpLog, tg.port);

  const hookId = 'deny-hook';
  const requestId = `hatch-${hookId}-ffffffffffff`;
  const ask = startAsk(cfgDir, binDir, tg.port, {
    requestId,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${hookId}?`,
    permissionEvent: 'PermissionRequest',
    critical: true,
    cwd: LIVE_CWD,
    hookId,
    operation: { kind: 'bash', fingerprint: 'sha256:fp-deny-1', cwd: LIVE_CWD },
  });

  expect(await until(() => tg.cards().length === 1, 6000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('disconnected')), 5000)).toBe(true);

  // Deny is the SECOND button in a permission's [Approve, Reject] row —
  // buildButtonMessage renders it as `tgq:<requestId>:deny`.
  tg.push([tap(`tgq:${requestId}:deny`, 601, 1)]);
  expect(await until(() => tg.edits().some((e) => e.includes('Selected answer: Reject')), 5000)).toBe(true);
  const denyIndex = tg.edits().findIndex((e) => e.includes('Selected answer: Reject'));
  // The deny edit embeds the same original hatch HTML (buildAnsweredQuestionText
  // → buildQuestionText) as the approve edit — must carry the same parse_mode
  // fix, or Telegram renders it as literal tag soup.
  expect(tg.editParseModes()[denyIndex]).toBe('HTML');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);

test('a late CRITICAL hatch decision reaches a LIVE omp session via its exact original-process session identity', async () => {
  const { cfgDir, binDir, acpLog } = await makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, binDir, acpLog, tg.port);

  const hookId = 'proactive-hook';
  const ask = startAsk(cfgDir, binDir, tg.port, {
    requestId: `hatch-${hookId}-dddddddddddd`,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${hookId}?`,
    permissionEvent: 'PermissionRequest',
    critical: true,
    cwd: LIVE_CWD,
    origin: { agent: 'omp', sessionId: SESSION_ID },
    paneId: '%99', // A stale pane must not outrank the exact original session.
    // Grant protocol v1.1 (tg-cli#398) fields — a current agent-tools lib
    // always sends these; isGrantableRequest fail-closes without them.
    hookId,
    operation: { kind: 'bash', fingerprint: 'sha256:fp-proactive-1', cwd: LIVE_CWD },
  });

  expect(await until(() => tg.cards().length === 1, 6000)).toBe(true);

  // The requesting process exits (its own external kill/reboot — critical mode
  // means the DAEMON never forces this, but the process itself can still die)
  // BEFORE any tap lands, moving the entry into abandonedButtons.
  ask.kill(9);
  await ask.exited;
  // Grant protocol v1.1 (tg-cli#398) replaced the env-var retry hint with a
  // generic "disconnected ... 24h grace" status — wait on that instead.
  expect(await until(() => tg.edits().some((e) => e.includes('disconnected')), 5000)).toBe(true);

  // A human taps Approve well after the process is gone.
  const allowData = tg.allowData()!;
  tg.push([tap(allowData, 501, 1)]);

  expect(await until(() => existsSync(acpLog) && readFileSync(acpLog, 'utf8').includes('"event":"original-input"'), 15_000)).toBe(true);
  const acp = readFileSync(acpLog, 'utf8');
  expect(existsSync(acpLog + '.spawned')).toBe(false);
  expect(acp).not.toContain('session/load');
  expect(acp).toContain(SESSION_ID);
  // Never session/new for a MATCHED live session — attaching to the existing one.
  expect(acp).not.toContain('"method":"session/new"');
  expect(acp).toContain(hookId);
  // The grant-notice text (hatchGrantNoticeText) says "APPROVED belatedly"
  // and carries the approval id — the new proactive-push payload, replacing
  // the older hatchProactiveDecisionText's literal button-label echo.
  expect(acp).toContain('APPROVED belatedly');
  expect(acp).toContain('Approval ID');

  expect(await until(() => daemonLog(cfgDir).includes('hatch-grant-notice-delivered'), 5000)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);

test('a late CRITICAL hatch decision for a cwd with NO live session never calls promptOmpAcp/spawns anything — durable record only', async () => {
  const { cfgDir, binDir, acpLog } = await makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, binDir, acpLog, tg.port);

  const hookId = 'no-live-hook';
  const ask = startAsk(cfgDir, binDir, tg.port, {
    requestId: `hatch-${hookId}-eeeeeeeeeeee`,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${hookId}?`,
    permissionEvent: 'PermissionRequest',
    critical: true,
    // Deliberately NOT the live omp's cwd — no session anywhere matches this.
    cwd: '/Users/u/work/some-unrelated-project',
    origin: { agent: 'omp' },
    // Grant protocol v1.1 (tg-cli#398) fields — a current agent-tools lib
    // always sends these; isGrantableRequest fail-closes without them.
    hookId,
    operation: { kind: 'bash', fingerprint: 'sha256:fp-no-live-1', cwd: '/Users/u/work/some-unrelated-project' },
  });

  expect(await until(() => tg.cards().length === 1, 6000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  // Grant protocol v1.1 (tg-cli#398) replaced the env-var retry hint with a
  // generic "disconnected ... 24h grace" status — wait on that instead.
  expect(await until(() => tg.edits().some((e) => e.includes('disconnected')), 5000)).toBe(true);

  const allowData = tg.allowData()!;
  tg.push([tap(allowData, 502, 1)]);

  // The decision still lands normally (card updated with the grant-protocol
  // "approved belatedly" text) — this is only about the PROACTIVE push
  // channel being correctly refused. queueToInbox succeeds even with no live
  // session, so routeGrantNotice reports delivered.
  expect(await until(() => tg.edits().some((e) => e.includes('approved belatedly') && e.includes('grant')), 5000)).toBe(true);
  // The card embeds the original request's HTML (`<b>Hatch approval
  // request</b>` etc.) — the final edit MUST carry parse_mode: 'HTML' or
  // Telegram renders that markup as literal tag soup.
  const approvedIndex = tg.edits().findIndex((e) => e.includes('approved belatedly') && e.includes('grant'));
  expect(tg.editParseModes()[approvedIndex]).toBe('HTML');
  expect(await until(() => daemonLog(cfgDir).includes('hatch-grant-notice-delivered'), 3000)).toBe(true);

  // Genuine real-clock wait (not a fake-timer stand-in): proving an ABSENCE — no
  // wrongly-fired ACP call — across a real OS subprocess/daemon boundary that
  // an in-process fake-timer harness cannot advance. Already confirmed the
  // daemon reached and logged its skip decision above; this only guards
  // against a delayed/fire-and-forget call landing slightly later.
  await Bun.sleep(500);
  const acp = existsSync(acpLog) ? readFileSync(acpLog, 'utf8') : '';
  expect(acp).not.toContain(hookId);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);
