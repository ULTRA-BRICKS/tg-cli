// Late-approval grant protocol v1.1 (tg-cli#398) — the verify-grant consume forms
// and the grace/pull paths, end-to-end against a real daemon + fake Telegram.
// The retained-entry tap paths live in tests/ctl-hatch-approval-retry-integration.test.ts;
// everything here is about CONSUMING a minted grant and the windows that bound it:
//   (a) grace-only late tap (retained entry gone after a daemon restart) → grant
//       minted; a paneless Claude Code origin gets NO inbox write (cc/codex are
//       tmux-only, tg-cli#456) — the card names the token path instead
//   (b) token path allows EXACTLY once (second consume denies)
//   (c) wrong --hook denies
//   (d) wrong-command denies WITHOUT consuming; a following correct verify allows
//   (e) wrong-cwd denies
//   (f) expired grant denies (TG_CTL_GRANT_TTL_MS shrunk)
//   (g) per-request timeoutMs honored (overriding the unscoped abandon default)
//   (h) an OLD payload without the v1.1 additive fields still normalizes; its late
//       tap fails closed (no grant can be bound)
//   (i) pull-model: same-route pull consumes once, different-route pull denies
//       WITHOUT consuming, no-route pull denies naming the token path, token path
//       consumes cross-route
//   (j) verify-grant replies carry requestId (and approvalId on allow) at TOP level
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-grant-'));
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

const BASE_ENV_KEYS = (cfgDir: string, apiPort: number): Record<string, string> => ({
  PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
  HOME: cfgDir,
  TG_CTL_CONFIG_DIR: cfgDir,
  TG_API_BASE: `http://127.0.0.1:${apiPort}`,
});

async function startDaemon(cfgDir: string, apiPort: number, extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { ...BASE_ENV_KEYS(cfgDir, apiPort), ...extraEnv },
    logFd,
  });
  closeSync(logFd);
  return daemon;
}

function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>): Subprocess {
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: BASE_ENV_KEYS(cfgDir, apiPort), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  ask.stdin.write(JSON.stringify(request) + '\n');
  ask.stdin.end();
  return ask;
}

// Run `tg-ctl ask --verify-grant …` and collect (exit code, parsed stdout JSON).
// The payload is piped VERBATIM (no cwd injection — the pull-model's route is
// computed from the payload's own routing fields, which these tests must control).
async function runVerify(
  cfgDir: string,
  apiPort: number,
  args: string[],
  payload: Record<string, unknown> | null,
): Promise<{ code: number; stdout: unknown }> {
  const proc = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask', ...args], { env: BASE_ENV_KEYS(cfgDir, apiPort), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  if (payload !== null) proc.stdin.write(JSON.stringify(payload) + '\n');
  proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = out;
  }
  return { code, stdout: parsed };
}

interface MockTg {
  port: number;
  stop: (c?: boolean) => Promise<void> | void;
  push: (batch: unknown[]) => void;
  cards: () => unknown[];
  edits: () => string[];
  answeredCbs: () => Array<{ callback_query_id: string; text: string }>;
  allowData: () => string | null;
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

function grantStoreOf(cfgDir: string): { grants?: Array<Record<string, unknown>>; grace?: Array<Record<string, unknown>> } {
  const p = join(cfgDir, 'tg-ctl.123.grants.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')) as { grants?: Array<Record<string, unknown>>; grace?: Array<Record<string, unknown>> };
}

const HOOK_ID = 'grant-hook';
const HATCH_REQUEST_ID = `hatch-${HOOK_ID}-aaaaaaaaaaaa`;
const SUBAGENT = 'hatch-worker';
const FINGERPRINT = 'sha256:fp-grant-1';
const OPERATION = { kind: 'bash', fingerprint: FINGERPRINT, cwd: '/repo' };
const INBOX_ROUTE = `inbox:${SUBAGENT}`;

// The hatch ask exactly as the agent-tools lib sends it (v1.1 additive fields included).
function hatchAsk(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: HATCH_REQUEST_ID,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
    hookId: HOOK_ID,
    origin: { agent: 'claude', subagent: SUBAGENT },
    operation: OPERATION,
    ...extra,
  };
}

// The verify-grant query payload: the normalized ask shape carrying the recomputed
// `operation`. Routing fields (origin/cwd) are per-call — the pull-model's route is
// derived from them, which is exactly what these tests vary.
function verifyPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `hatch-${HOOK_ID}-cccccccccccc`,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
    hookId: HOOK_ID,
    origin: { agent: 'claude', subagent: SUBAGENT },
    operation: OPERATION,
    ...extra,
  };
}

// Mint a grant through the real flow: post the ask, kill the requesting process
// (socket-close retire), tap Approve on the expired card, wait for the durable grant.
async function mintGrant(cfgDir: string, tg: MockTg, askExtra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const ask = startAsk(cfgDir, tg.port, hatchAsk(askExtra));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('24h')), 5000)).toBe(true);
  tg.push([tap(tg.allowData()!, 901, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('grant issued')), 6000)).toBe(true);
  expect(await until(() => (grantStoreOf(cfgDir).grants?.length ?? 0) === 1, 5000)).toBe(true);
  return grantStoreOf(cfgDir).grants![0]!;
}

const TOKEN_ARGS = (approvalId: string): string[] => ['--verify-grant', approvalId, '--hook', HOOK_ID];
const PULL_ARGS: string[] = ['--verify-grant', '--pull', '--hook', HOOK_ID];

function allowEnvelope(): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
}

test('(a)+(j) GRACE-ONLY tap after a daemon restart: grant minted from the grace store, a paneless claude origin gets no inbox write, reply envelope shapes pinned', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' });

  // The ask retires (grace written durably); the tiny retention window + a daemon
  // restart removes the retained ENTRY, so the tap below can only be addressed
  // through the grace store — the restart ALSO proves the grace store is durable.
  const ask = startAsk(cfgDir, tg.port, hatchAsk());
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => (grantStoreOf(cfgDir).grace?.length ?? 0) === 1, 5000)).toBe(true);
  const grace = grantStoreOf(cfgDir).grace![0]!;
  expect(grace.hookId).toBe(HOOK_ID);
  expect(grace.graceExpiresAt).toBeGreaterThan(Number(grace.expiredAt));

  daemon.kill('SIGTERM');
  await daemon.exited;
  await Bun.sleep(500); // the retention window (300ms) closes while the daemon is down
  await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' });

  // The late tap: no pending, no retained entry → the grace store answers.
  tg.push([tap(tg.allowData()!, 911, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('grant issued')), 8000)).toBe(true);
  expect(await until(() => (grantStoreOf(cfgDir).grants?.length ?? 0) === 1, 5000)).toBe(true);
  const grant = grantStoreOf(cfgDir).grants![0]!;
  expect(grant.request_id).toBe(HATCH_REQUEST_ID);
  expect(grant.hook_id).toBe(HOOK_ID);
  // The daemon-observed route identity the pull model binds to: derived from the
  // ask's routing fields (a name, not a delivery channel).
  expect(grant.route).toBe(INBOX_ROUTE);

  // A Claude Code origin with no tmux pane is tmux-only (tg-cli#456): nothing is
  // queued to the Stop-hook inbox; the card says the notice could not be delivered
  // and names the token path.
  expect(await until(() => daemonLog(cfgDir).includes('hatch-grant-notice-failed'), 5000)).toBe(true);
  expect(existsSync(join(cfgDir, 'inbox', SUBAGENT))).toBe(false);
  expect(await until(() => tg.edits().some((e) => e.includes('could NOT be delivered') && e.includes(`approved:${String(grant.approval_id)}`)), 5000)).toBe(true);
  const logText = daemonLog(cfgDir);
  expect(logText).toContain('hatch-grant-minted');
  expect(logText).not.toContain('ask-late-deliver-permission-pane-skip reason=no-menu');

  // (j) the token consume reply carries requestId + approvalId at TOP level, in the
  // standard hookSpecificOutput allow shape, exit 0.
  const res = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload());
  expect(res.code).toBe(0);
  expect(res.stdout).toMatchObject({
    approvalId: String(grant.approval_id),
    requestId: HATCH_REQUEST_ID,
    ...allowEnvelope(),
  });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 60_000);

test('(b) token path allows EXACTLY once — the second consume denies, still exit 0', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const grant = await mintGrant(cfgDir, tg);

  const first = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload());
  expect(first.code).toBe(0);
  expect(first.stdout).toMatchObject({ approvalId: String(grant.approval_id), ...allowEnvelope() });
  // DURABLY consumed.
  expect(await until(() => grantStoreOf(cfgDir).grants?.[0]?.consumed_at != null, 3000)).toBe(true);

  const second = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload());
  expect(second.code).toBe(0);
  expect(second.stdout).toMatchObject({
    requestId: HATCH_REQUEST_ID,
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
  });
  const denyMsg = String(
    (second.stdout as { hookSpecificOutput?: { decision?: { message?: string } } }).hookSpecificOutput?.decision?.message ?? '',
  );
  expect(denyMsg).toContain('single-use');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('(c)+(d) wrong --hook and wrong-command deny WITHOUT consuming — a following CORRECT verify still allows', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const grant = await mintGrant(cfgDir, tg);

  // (c) wrong hook_id: denied.
  const wrongHook = await runVerify(cfgDir, tg.port, ['--verify-grant', String(grant.approval_id), '--hook', 'other-hook'], verifyPayload());
  expect(wrongHook.code).toBe(0);
  expect(wrongHook.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });

  // (d) wrong command (fingerprint): denied WITHOUT consuming — a typo must not burn
  // the grant.
  const wrongCmd = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload({ operation: { kind: 'bash', fingerprint: 'sha256:DIFFERENT', cwd: '/repo' } }));
  expect(wrongCmd.code).toBe(0);
  expect(wrongCmd.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(
    String((wrongCmd.stdout as { hookSpecificOutput?: { decision?: { message?: string } } }).hookSpecificOutput?.decision?.message ?? ''),
  ).toContain('NOT consumed');
  expect(grantStoreOf(cfgDir).grants?.[0]?.consumed_at).toBeNull();

  // The correct verify still allows.
  const ok = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload());
  expect(ok.stdout).toMatchObject({ approvalId: String(grant.approval_id), ...allowEnvelope() });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('(e) wrong-cwd denies', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const grant = await mintGrant(cfgDir, tg);

  const wrongCwd = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload({ operation: { kind: 'bash', fingerprint: FINGERPRINT, cwd: '/elsewhere' } }));
  expect(wrongCwd.code).toBe(0);
  expect(wrongCwd.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(grantStoreOf(cfgDir).grants?.[0]?.consumed_at).toBeNull();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('(f) an expired grant denies (shrunk TTL via TG_CTL_GRANT_TTL_MS)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_GRANT_TTL_MS: '500' });
  const grant = await mintGrant(cfgDir, tg);

  await Bun.sleep(700); // the grant's TTL elapses
  const expired = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload());
  expect(expired.code).toBe(0);
  expect(expired.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(
    String((expired.stdout as { hookSpecificOutput?: { decision?: { message?: string } } }).hookSpecificOutput?.decision?.message ?? ''),
  ).toContain('expired');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('(g) per-request timeoutMs is honored: the entry outlives the (shrunk) unscoped abandon default by the requested amount', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  // The unscoped-abandon default is shrunk to 300ms; the ask's timeoutMs (1500ms)
  // must OVERRIDE it (clamped by the 15-min cap on the daemon side). The
  // DETERMINISTIC signal is server-side on one clock: the daemon's own
  // `ask-forward arrived` log timestamp (written at timer-arm time) vs the grace
  // record's expiredAt (the retire moment, durably recorded). A regression to the
  // 300ms default retires ~300ms after arrival; honoring timeoutMs retires
  // ~1500ms after. Wall-clock deltas around the CARD are not usable (the
  // editMessageText fetch latency varies ~1s under load, and the timer can even
  // fire while the send is still in flight).
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: '300' });
  // Wait out the daemon's synchronous STARTUP probe (the unreachable-agent scan
  // shells out to lsof/ps and blocks the event loop for ~1s on a cold start):
  // the client's own deadline clock starts at ITS stdin-parse, so skew between
  // the two clocks must stay well under the timeout under test.
  expect(await until(() => daemonLog(cfgDir).includes('no-agent reply'), 10_000)).toBe(true);

  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 3000 }));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  await ask.exited; // the client leaves at its own (same) 3000ms deadline
  expect(await until(() => (grantStoreOf(cfgDir).grace?.length ?? 0) === 1, 5000)).toBe(true);
  const expiredAt = Number(grantStoreOf(cfgDir).grace![0]!.expiredAt);
  const arrived = new RegExp(`^\\[(.+?)Z\\] ask-forward arrived: .*req=${HATCH_REQUEST_ID} `, 'm').exec(daemonLog(cfgDir));
  expect(arrived).not.toBeNull();
  const lifetime = expiredAt - Date.parse(`${arrived![1]}Z`);
  expect(lifetime).toBeGreaterThanOrEqual(2000); // 3000 honored, not the 300 default
  expect(lifetime).toBeLessThanOrEqual(8000); // ...and not the 115s/15-min ceilings either

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('(h) an OLD payload without the additive fields still normalizes (card posts) and its late tap fails closed — no grant can be bound', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, {
    requestId: HATCH_REQUEST_ID,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
  });
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.edits().some((e) => e.includes('24h')), 5000)).toBe(true);

  tg.push([tap(tg.allowData()!, 921, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('cannot grant')), 6000)).toBe(true);
  // Fail-closed: NO grant was minted for the unbindable old-payload ask.
  await Bun.sleep(300);
  expect(grantStoreOf(cfgDir).grants ?? []).toHaveLength(0);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('(i) pull-model: same-route pull consumes once; different-route and no-route pulls deny WITHOUT consuming; the token path consumes cross-route', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  // Grant minted with the daemon-observed route inbox:hatch-worker.
  const grant = await mintGrant(cfgDir, tg);
  expect(grant.route).toBe(INBOX_ROUTE);

  // Different-route pull (origin.subagent=other-worker → inbox:other-worker): denied,
  // NOT consumed.
  const otherRoute = await runVerify(cfgDir, tg.port, PULL_ARGS, verifyPayload({ origin: { agent: 'claude', subagent: 'other-worker' } }));
  expect(otherRoute.code).toBe(0);
  expect(otherRoute.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(grantStoreOf(cfgDir).grants?.[0]?.consumed_at).toBeNull();

  // No-route pull (no pane, no omp session, no subagent, no cwd on the query): denied
  // and the denial NAMES the token path (the env-var form stays available). The
  // payload keeps its requestId (a shape the daemon can normalize) while omitting
  // every routing field — origin dropped by JSON (undefined) and no top-level cwd.
  const noRoute = await runVerify(cfgDir, tg.port, PULL_ARGS, {
    ...verifyPayload({ origin: undefined }),
    operation: OPERATION,
  });
  expect(noRoute.code).toBe(0);
  expect(noRoute.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  const noRouteMsg = String((noRoute.stdout as { hookSpecificOutput?: { decision?: { message?: string } } }).hookSpecificOutput?.decision?.message ?? '');
  expect(noRouteMsg).toContain('RIG_HATCH_REQUEST_GRANT_HOOK');
  expect(noRouteMsg).toContain('approved:');
  expect(grantStoreOf(cfgDir).grants?.[0]?.consumed_at).toBeNull();

  // Token path consumes CROSS-ROUTE (the id was told to the agent out-of-band).
  const crossRouteToken = await runVerify(cfgDir, tg.port, TOKEN_ARGS(String(grant.approval_id)), verifyPayload({ origin: { agent: 'claude', subagent: 'someone-else' } }));
  expect(crossRouteToken.stdout).toMatchObject({ approvalId: String(grant.approval_id), ...allowEnvelope() });

  // After the token consume, a same-route pull finds nothing left to allow.
  const postConsumePull = await runVerify(cfgDir, tg.port, PULL_ARGS, verifyPayload());
  expect(postConsumePull.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('(i cont) same-route pull consumes EXACTLY once (second pull denies)', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const grant = await mintGrant(cfgDir, tg);

  // Same-route pull (identical routing fields → inbox:hatch-worker): allow, carrying
  // approvalId + the ORIGINAL ask's requestId at TOP level.
  const first = await runVerify(cfgDir, tg.port, PULL_ARGS, verifyPayload());
  expect(first.code).toBe(0);
  expect(first.stdout).toMatchObject({ approvalId: String(grant.approval_id), requestId: HATCH_REQUEST_ID, ...allowEnvelope() });
  expect(await until(() => grantStoreOf(cfgDir).grants?.[0]?.consumed_at != null, 3000)).toBe(true);

  // Second identical pull: denied (single-use).
  const second = await runVerify(cfgDir, tg.port, PULL_ARGS, verifyPayload());
  expect(second.code).toBe(0);
  expect(second.stdout).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);
