// tg-cli#349: a RIG_HATCH_REQUEST_* approval (agent-tools' agenttools_hatch_escalation,
// cross-repo) is a ONE-SHOT, HEADLESS `permission` ButtonRequest — no paneId (no tmux
// session to inject into or reconnect from) and no promptTurnId (never normalized from a
// live harness hook, see parseHatchHookId's doc comment, features/tg-ctl/questions.ts).
// Before this fix, retainAbandonedQuestion's `if (!req.paneId) return false` meant the
// entry was NEVER retained once its one-shot `tg-ctl ask` socket closed — it was expired
// outright (expireDeadCard) and dropped from memory. A human tap that landed even a
// moment later hit nothing: the approval was silently lost (Alex tg: "a decision must not
// be silently lost even when expired ... relay to the agent that the user approved, set a
// flag/marker allowing one retry, and tell it the exact command + a caveat to only use it
// if still relevant").
//
// This reproduces that exact race end-to-end: the requesting process exits before any
// tap, a LATE tap is still durably recorded, and a RETRY (a fresh `tg-ctl ask` carrying a
// NEW requestId but the SAME hookId — exactly what agent-tools' documented
// RIG_HATCH_REQUEST_<HOOK_ID> retry produces, since request_hatch_approval mints a fresh
// random requestId suffix on every attempt) is answered automatically with no new
// Telegram prompt.
//
// Mirrors ctl-question-durable-integration's harness: a real daemon, a fake Telegram. No
// tmux pane is ever involved (a hatch request has none) — the fake tmux/ps below exist
// only so the daemon's own pane-discovery code paths never hit a missing binary.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

function fakeTmux(): string {
  return `#!/bin/sh
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
exit 0
`;
}

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-hatch-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // A hatch request has no paneId, so it forwards via the CWD-match branch of
  // registrationAllowsHook — register the SAME cwd every `ask` payload below carries.
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
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
// Python hook script, never a live tmux session.
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

// A retained/persisted question record's `queuedDecision` — see
// AbandonedButton.queuedDecision (tg-ctl) and RetainedQuestionRecord.queuedDecision
// (features/tg-ctl/question-store.ts). Read straight off disk so this proves the
// approval is DURABLY recorded, not merely held in the daemon's live memory.
function queuedDecisionOf(cfgDir: string, requestId: string): { decision?: string } | null {
  const statePath = join(cfgDir, 'tg-ctl.123.questions.json');
  if (!existsSync(statePath)) return null;
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    questions?: Array<{ req?: { requestId?: string }; queuedDecision?: { decision?: string } }>;
  };
  return state.questions?.find((q) => q.req?.requestId === requestId)?.queuedDecision ?? null;
}

// hatch-<hookId>-<12 lowercase hex> — the EXACT shape agent_tools' request_hatch_approval
// mints (`f"hatch-{hook_id}-{uuid.uuid4().hex[:12]}"`, see parseHatchHookId's doc comment,
// features/tg-ctl/questions.ts). Two different hex suffixes for the SAME hookId model two
// attempts of the SAME hatch command — a fresh random suffix every attempt, per
// agent-tools, is exactly why a retry can never be found by exact requestId equality.
const HOOK_ID = 'test-hook';
const HATCH_REQUEST_ID_1 = `hatch-${HOOK_ID}-aaaaaaaaaaaa`;
const HATCH_REQUEST_ID_2 = `hatch-${HOOK_ID}-bbbbbbbbbbbb`;
const HATCH_ENV_VAR = 'RIG_HATCH_REQUEST_TEST_HOOK';

// Base hatch fixture — kind: permission, deliberately NO paneId, NO promptTurnId (a hatch
// request structurally can never carry either — see parseHatchHookId's doc comment,
// features/tg-ctl/questions.ts). `agent: 'claude'` + `permissionEvent: 'PermissionRequest'`
// so the reply envelope is asserted the same way ctl-question-durable-integration's
// PERMISSION fixture tests do (formatAgentHookOutput's PermissionRequest branch).
function hatchRequest(requestId: string): Record<string, unknown> {
  return {
    requestId,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
  };
}

test('HATCH RETRY (tg-cli#349): a tap after the requesting process exited is recorded, and a retry with the same hookId is answered automatically with no new card', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  // The requesting `tg-ctl ask` process exits (its own client-side timeout, or the
  // harness killing it) BEFORE any Telegram tap lands — the exact race Alex reported.
  const ask1 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_1));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask1.kill(9);
  await ask1.exited;

  // Before this fix: retainAbandonedQuestion's `if (!req.paneId) return false` meant this
  // entry was expired outright (expireDeadCard), never retained — the card would read
  // EXPIRED_TERMINAL_TEXT ("expired — answer in terminal") instead of the hatch-specific
  // disconnect text, and a tap below would hit "expired" rather than being recorded.
  expect(await until(() => tg.edits().some((e) => e.includes(HATCH_ENV_VAR)), 5000)).toBe(true);
  expect(tg.edits().some((e) => e.includes('expired — answer in terminal'))).toBe(false);

  // A human taps Approve after the process is already gone.
  const allowData = tg.allowData()!;
  tg.push([tap(allowData, 701, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('recorded')), 6000)).toBe(true);
  const toast = tg.answeredCbs().findLast((c) => c.text.includes('recorded'));
  expect(toast?.text).toContain('applied automatically the next time the same hatch command is retried');
  expect(await until(() => tg.edits().some((e) => e.includes('recorded') && e.includes('Approve')), 4000)).toBe(true);
  // The recorded-decision edit is a SEPARATE editMessageText call from the initial abandon
  // edit above -- it must carry its own parse_mode or the card flips back to literal tags
  // the instant a human taps (review finding: this is a distinct call site from the
  // HATCH ABANDONED test's coverage of the abandon-edit alone).
  const recordedEditIndex = tg.edits().findIndex((e) => e.includes('recorded') && e.includes('Approve'));
  expect(tg.editParseModes()[recordedEditIndex]).toBe('HTML');

  // The approval is DURABLY recorded — not silently dropped — with decision 'allow' for
  // the ORIGINAL requestId. This is the exact step that fails before the fix: the entry
  // was already deleted from `abandonedButtons` the moment the socket closed, so the tap
  // would hit "expired" and never even get recorded.
  expect(await until(() => queuedDecisionOf(cfgDir, HATCH_REQUEST_ID_1)?.decision === 'allow', 4000)).toBe(true);

  // The agent retries the exact same command with the same RIG_HATCH_REQUEST_TEST_HOOK
  // env var — a brand-new requestId (agent-tools mints a fresh random suffix every
  // attempt) but the SAME hookId. The daemon must recognize this as a retry of the same
  // hatch and answer it immediately, with NO new human interaction.
  const ask2 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_2));
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });

  // No second card was ever posted — the retry is answered silently against the
  // existing card, not by asking the human again.
  expect(tg.cards()).toHaveLength(1);
  // The retry-delivered edit (buildAnsweredQuestionText, a THIRD distinct editMessageText
  // call beyond the abandon and recorded edits above) must also carry parse_mode, or the
  // card renders literal tags the instant the retry lands.
  const deliveredEditIndex = tg.edits().findIndex((e) => e.includes('Selected answer: Approve'));
  expect(deliveredEditIndex).toBeGreaterThanOrEqual(0);
  expect(tg.editParseModes()[deliveredEditIndex]).toBe('HTML');
  expect(daemonLog(cfgDir)).toContain('ask-forward hatch-queued-decision-delivered');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// tg-cli#349 review finding: #350's original fix made retainAbandonedQuestion reachable
// ONLY from armPendingSocketClose's socket 'close' handler. But forwardAndPostQuestion
// arms a SEPARATE raw UNSCOPED_ABANDON_MS setTimeout for every unscoped (paneless) entry
// — hatch requests included — that ALSO retires the entry, and before the fix it called
// expireDeadCard directly, bypassing retention entirely. A hatch request's own process
// stays connected for ~120s (its own hook budget), comfortably longer than the 110s
// default abandon window, so in the DEFAULT production scenario the raw timer fires
// FIRST while the socket is still open — the fix above only ever protects the edge case
// where the process exits/gets killed early. This test is the mirror image of 'HATCH
// RETRY' above: `ask1` is NEVER killed by the test and its socket is never closed by a
// client-side/premature death — retirement is driven purely by the raw timer (shrunk via
// TG_CTL_UNSCOPED_TIMEOUT_MS), whose own socket.end() call closes the connection only
// AFTER retireAbandonedEntry has already run (see forwardAndPostQuestion). Against the
// pre-fix code this fails at the very first assertion below: the raw timer's unconditional
// expireDeadCard call produces the generic EXPIRED_TERMINAL_TEXT card instead of the
// hatch-specific disconnect text, before a human ever gets to tap anything.
test('HATCH ABANDON-TIMER RACE (tg-cli#349, default scenario, process never killed): the raw UNSCOPED_ABANDON_MS backstop retains the entry, not just a client-initiated socket close', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: '300' });

  // ask1's process is deliberately never killed and its stdin is never closed by the
  // test — the ONLY thing that can end this connection is the raw abandon timer itself,
  // which retires the entry FIRST and only then closes the socket via socket.end().
  const ask1 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_1));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);

  // The raw UNSCOPED_ABANDON_MS timer (300ms here) fires well before any socket close.
  // Pre-fix, this edit is EXPIRED_TERMINAL_TEXT ("expired — answer in terminal"), never
  // the hatch-specific text — the assertion below is the one that traps the regression.
  expect(await until(() => tg.edits().some((e) => e.includes(HATCH_ENV_VAR)), 5000)).toBe(true);
  expect(tg.edits().some((e) => e.includes('expired — answer in terminal'))).toBe(false);

  // A human taps Approve after the backstop timer retired the entry. By now the timer's
  // own socket.end() call has already run (see forwardAndPostQuestion) — the tap lands on
  // the retained/persisted record, not on a socket the test itself is holding open.
  const allowData = tg.allowData()!;
  tg.push([tap(allowData, 801, 1)]);
  expect(await until(() => tg.answeredCbs().some((c) => c.text.includes('recorded')), 6000)).toBe(true);
  const toast = tg.answeredCbs().findLast((c) => c.text.includes('recorded'));
  expect(toast?.text).toContain('applied automatically the next time the same hatch command is retried');

  // The approval is DURABLY recorded for the ORIGINAL requestId.
  expect(await until(() => queuedDecisionOf(cfgDir, HATCH_REQUEST_ID_1)?.decision === 'allow', 4000)).toBe(true);

  // A retry with the same hookId is answered automatically, with no second card.
  const ask2 = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_2));
  const out = await new Response(ask2.stdout).text();
  await ask2.exited;
  expect(JSON.parse(out)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(tg.cards()).toHaveLength(1);
  expect(daemonLog(cfgDir)).toContain('ask-forward hatch-queued-decision-delivered');

  // ask1 exits on its own once the daemon ends its socket after retiring the entry —
  // never killed by the test, matching the default (no forced process death) scenario.
  await ask1.exited;

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('HATCH ABANDONED (no tap): the card names the concrete retry command instead of the impossible "tap again"/"answer in the terminal" promises', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, hatchRequest(HATCH_REQUEST_ID_1));
  expect(await until(() => tg.cards().length === 1, 5000)).toBe(true);
  ask.kill(9);
  await ask.exited;

  expect(await until(() => tg.edits().some((e) => e.includes(HATCH_ENV_VAR)), 5000)).toBe(true);
  const cardText = tg.edits().find((e) => e.includes(HATCH_ENV_VAR))!;
  expect(cardText).toContain('retry');
  // The original post carries parse_mode: 'HTML' (buildButtonMessage gates it on
  // isHatchPermissionRequest) — and, critically, so must THIS abandon-edit: Telegram
  // edits a message with no formatting unless parse_mode rides the SAME call, so if the
  // abandon-edit's parse_mode were dropped the card would flip from a rendered HTML card
  // to literal `<b>`/`<code>` tags the instant it abandons (review finding).
  expect(tg.cardParseModes()[0]).toBe('HTML');
  const abandonEditIndex = tg.edits().findIndex((e) => e.includes(HATCH_ENV_VAR));
  expect(tg.editParseModes()[abandonEditIndex]).toBe('HTML');
  // Neither impossible promise a headless, one-shot hatch request can never keep: there
  // is no live hook to "tap again once it reconnects" for, and no terminal to "answer
  // directly in the terminal" in.
  expect(cardText).not.toContain('tap again once it reconnects');
  expect(cardText).not.toContain('answer directly in the terminal');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);
