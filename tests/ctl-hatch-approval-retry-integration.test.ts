// tg-cli#349 → tg-cli#398: a RIG_HATCH_REQUEST_* approval (agent-tools'
// agenttools_hatch_escalation, cross-repo) is a ONE-SHOT, HEADLESS `permission`
// ButtonRequest — no paneId and no promptTurnId. The ORIGINAL fix (#349/#350)
// retained the entry and recorded a silent queuedDecision that ANY later retry
// behind the same hookId auto-consumed. The late-approval grant protocol v1.1
// REPLACES that mechanism: a late Approve mints a single-use, operation-bound
// GRANT (features/tg-ctl/grants.ts) and routes the consume instructions to the
// ask's origin — which for a paneless Claude Code ask is NOTHING (cc/codex are
// tmux-only, tg-cli#456: no Stop-hook inbox write); the card names the token
// path instead — and a plain retry WITHOUT a grant-consume simply posts a FRESH card.
//
// These are the RETAINED-ENTRY tap paths (both retire routes: the client
// process dying, and the raw UNSCOPED_ABANDON_MS backstop timer). The
// grace-store-only tap path (entry pruned past its 12h retention) and the
// verify-grant consume forms live in tests/ctl-hatch-late-grant-integration.test.ts.
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
  const cfgDir = tempDir('tgctl-hatch-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // A hatch request has no paneId, so it forwards via the CWD-match branch of
  // registrationAllowsHook — register the SAME cwd every `ask` payload below carries.
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

// A hatch request is HEADLESS: no TMUX_PANE env, no paneId field — mirrors agent-tools'
// request_hatch_approval, which pipes a hand-built ButtonRequest into `tg-ctl ask` from a
// Python hook script, never a live tmux session. The v1.1 additive fields (hookId,
// timeoutMs, origin, operation) ride the payload exactly as the agent-tools lib sends
// them — `operation` is opaque to tg-ctl (the fingerprint is what a grant binds to).
function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
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
  cardParseModes: () => Array<string | undefined>;
  edits: () => string[];
  // Telegram edits a message with NO formatting unless `parse_mode` rides the SAME edit
  // call — the original post's parse_mode is not "sticky" across an edit. A hatch card's
  // `buildQuestionText` output is raw HTML, so every status edit re-sending it (answered/
  // abandoned/queued-decision/long-outage) must carry 'HTML' again or Telegram renders the
  // tags literally (review finding on the parse_mode threading this fixture exercises).
  editParseModes: () => Array<string | undefined>;
  answeredCbs: () => Array<{ callback_query_id: string; text: string }>;
  allowData: () => string | null;
}

function mockTelegram(): MockTg {
  const updateQueue: unknown[][] = [];
  const cards: unknown[] = [];
  const cardParseModes: Array<string | undefined> = [];
  const edits: string[] = [];
  const editParseModes: Array<string | undefined> = [];
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
          cardParseModes.push(typeof body.parse_mode === 'string' ? body.parse_mode : undefined);
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
    cardParseModes: () => cardParseModes,
    edits: () => edits,
    editParseModes: () => editParseModes,
    answeredCbs: () => answeredCbs,
    allowData: () => lastKeyboard?.[0]?.[0]?.callback_data ?? null, // row 0 = [Approve, Reject]
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

// The daemon-owned grant store (tg-ctl.123.grants.json, 0600) — read straight off
// disk so a test proves the grant is DURABLY recorded, not merely held in the
// daemon's live memory.
function grantStoreOf(cfgDir: string): { grants?: Array<Record<string, unknown>>; grace?: Array<Record<string, unknown>> } {
  const p = join(cfgDir, 'tg-ctl.123.grants.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')) as { grants?: Array<Record<string, unknown>>; grace?: Array<Record<string, unknown>> };
}

// hatch-<hookId>-<12 lowercase hex> — the EXACT shape agent_tools' request_hatch_approval
// mints. Two different hex suffixes for the SAME hookId model two attempts of the SAME
// hatch command — a fresh random suffix every attempt is exactly why a retry can never be
// found by exact requestId equality.
const HOOK_ID = 'test-hook';
const HATCH_REQUEST_ID_1 = `hatch-${HOOK_ID}-aaaaaaaaaaaa`;
const HATCH_REQUEST_ID_2 = `hatch-${HOOK_ID}-bbbbbbbbbbbb`;
const SUBAGENT = 'hatch-worker';
const FINGERPRINT = 'sha256:fp-test-1';

// Base hatch fixture — kind: permission, deliberately NO paneId, NO promptTurnId (a hatch
// request structurally can never carry either). `agent: 'claude'` + `permissionEvent:
// 'PermissionRequest'` so the reply envelope is asserted like the PERMISSION fixtures in
// ctl-question-durable-integration. The v1.1 additive fields are exactly what the
// agent-tools lib sends: hookId (the stable hatch id), operation (fingerprint + cwd the
// grant binds to), origin (subagent the routed notice targets).
function hatchRequest(requestId: string): Record<string, unknown> {
  return {
    requestId,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
    hookId: HOOK_ID,
    origin: { agent: 'claude', subagent: SUBAGENT },
    operation: { kind: 'bash', fingerprint: FINGERPRINT, cwd: '/repo' },
  };
}

// The shared core of both retained-tap tests: the ask retires (retention), a late
// Approve tap mints a grant, and — the origin being a paneless Claude Code — nothing
// is queued anywhere (tg-cli#456); never a permission menu/pane either (the
// production no-menu skip this replaces).
async function exerciseRetainedLateTap(cfgDir: string, tg: MockTg): Promise<void> {
  const allowData = tg.allowData()!;
  tg.push([tap(allowData, 701, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('grant issued')), 6000)).toBe(true);

  // The grant is DURABLY recorded with the contract §4 field names, bound to the
  // ask's hookId + operation, unconsumed.
  expect(await until(() => (grantStoreOf(cfgDir).grants?.length ?? 0) === 1, 5000)).toBe(true);
  const grant = grantStoreOf(cfgDir).grants![0]!;
  expect(grant.approval_id).toMatch(/^hgr-[0-9a-f]{12}$/);
  expect(grant.request_id).toBe(HATCH_REQUEST_ID_1);
  expect(grant.hook_id).toBe(HOOK_ID);
  expect(grant.consumed_at).toBeNull();
  expect((grant.operation as Record<string, unknown>)?.fingerprint).toBe(FINGERPRINT);

  // The card confirms the approval id AND names the token path, since a paneless
  // Claude Code origin cannot be told (tmux-only, tg-cli#456).
  expect(await until(() => tg.edits().some((e) => e.includes('could NOT be delivered') && e.includes(`approved:${String(grant.approval_id)}`)), 5000)).toBe(true);

  // No Stop-hook inbox write for it.
  expect(await until(() => daemonLog(cfgDir).includes('hatch-grant-notice-failed'), 5000)).toBe(true);
  expect(existsSync(join(cfgDir, 'inbox'))).toBe(false);
  const logText = daemonLog(cfgDir);
  expect(logText).toContain('hatch-grant-minted');
  expect(logText).not.toContain('ask-late-deliver-permission-pane-skip reason=no-menu');

  // A plain retry WITHOUT a grant consume is NOT silently auto-allowed any more — it
  // posts a FRESH card (the human decides again); the removed short-circuit would have
  // answered it allow with no new card (exactly the over-broad authorization v1.1
  // forbids).
  const ask2 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_2));
  expect(await until(() => tg.cards().length === 2, 5000)).toBe(true);
  ask2.kill(9);
  await ask2.exited;
}

test('HATCH LATE GRANT (tg-cli#398): a tap after the requesting process exited mints an operation-bound grant — no inbox write for a paneless claude — and a plain retry re-asks, never auto-allows', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  // The requesting `tg-ctl ask` process exits (its own client-side timeout, or the
  // harness killing it) BEFORE any Telegram tap lands — the exact race the original
  // tg-cli#349 report described.
  const ask1 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_1));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;

  // Retention keeps the hatch card addressable (the paneless carve-out) with the
  // grant-flow wording — not the generic dead-card text.
  expect(await until(() => tg.edits().some((e) => e.includes('24h')), 5000)).toBe(true);
  expect(tg.edits().some((e) => e.includes('expired — answer in terminal'))).toBe(false);

  await exerciseRetainedLateTap(cfgDir, tg);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

// tg-cli#349 review finding (mirror of the first test): retirement driven purely by the
// raw UNSCOPED_ABANDON_MS backstop timer (the DEFAULT production scenario — a hatch
// process's own ~120s budget outlives the 110s abandon window), never by a client death.
test('HATCH LATE GRANT via the raw abandon timer (default scenario, process never killed): the backstop retire path mints the same grant', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: '300' });

  // ask1's process is deliberately never killed — the ONLY thing that can retire this
  // entry is the raw abandon timer itself (300ms here).
  const ask1 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_1));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.includes('24h')), 5000)).toBe(true);
  expect(tg.edits().some((e) => e.includes('expired — answer in terminal'))).toBe(false);

  await exerciseRetainedLateTap(cfgDir, tg);

  // ask1 exits on its own once the daemon ends its socket after retiring the entry —
  // never killed by the test, matching the default (no forced process death) scenario.
  await ask1.exited;

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

test('HATCH ABANDONED (no tap): the card advertises the 24h grant window instead of the impossible "tap again"/"answer in the terminal" promises', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_1));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;

  expect(await until(() => tg.edits().some((e) => e.includes('24h')), 5000)).toBe(true);
  const cardText = tg.edits().find((e) => e.includes('24h'))!;
  expect(cardText).toContain('one-time grant');
  // The original post carries parse_mode: 'HTML' (buildButtonMessage gates it on
  // isHatchPermissionRequest) — and, critically, so must THIS abandon-edit: Telegram
  // edits a message with no formatting unless parse_mode rides the SAME call, so if the
  // abandon-edit's parse_mode were dropped the card would flip from a rendered HTML card
  // to literal `<b>`/`<code>` tags the instant it abandons (review finding).
  expect(tg.cardParseModes()[0]).toBe('HTML');
  const abandonEditIndex = tg.edits().findIndex((e) => e.includes('24h'));
  expect(tg.editParseModes()[abandonEditIndex]).toBe('HTML');
  // Neither impossible promise a headless, one-shot hatch request can never keep: there
  // is no live hook to "tap again once it reconnects" for, and no terminal to "answer
  // directly in the terminal" in.
  expect(cardText).not.toContain('tap again once it reconnects');
  expect(cardText).not.toContain('answer directly in the terminal');
  expect(cardText).not.toContain('answer in terminal');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

