// tg-cli#403 / #433: every way a human can resolve a hatch approval card, driven end to
// end against a real daemon and a fake Bot API that models Telegram's KEYBOARD STATE —
// the property the older hatch fixtures never tracked. Telegram's editMessageText and
// editMessageReplyMarkup REPLACE the inline keyboard (omitting reply_markup removes the
// buttons), so a card's Approve is tappable only while its CURRENT keyboard carries it.
// `tapIfShown` refuses a tap on a button the card no longer shows; `raceTap` deliberately
// ignores the keyboard, modelling a tap already in flight when the card was edited (the
// #433 deny-then-approve flip).
//
// Paths covered (each was a tap the CTO could make that did not take effect):
//   1. a late Deny on a retained card is FINAL — the grace record is retired, a raced
//      Approve mints nothing, and the requester is told proactively (#433 item 1);
//   2. past the 12h retention the card keeps Approve/Reject (the long-outage edit used to
//      strip them while its own text promised a tap works until the 24h grace closes),
//      and the tap mints the grant;
//   3. a text reply ("да") to such a grace-only card is a decision, like on a live card;
//   4. a Deny on a grace-only card is final too;
//   5. a Deny after the Approve already minted a grant revokes the unconsumed grant;
//   6. a daemon restart while a paneless hatch ask is LIVE keeps the card answerable
//      (the pending entry used to be dropped, so every tap on it answered "expired");
//   7. the same restart past the retention window keeps the card tappable;
//   8. a pane-scoped ask that re-attaches after a restart and is answered LIVE cannot be
//      re-opened by a raced tap on its restored grace record;
//   9. once the grace window has closed, a tap on the card retires its buttons (they no
//      longer outlive what a tap can do) and mints nothing;
//  10. a Deny stays final across a restart, even when the questions store (best-effort)
//      still holds the card: the restore must not re-open it;
//  11. a live answer whose grace-record close cannot be made durable is refused, never
//      confirmed on memory alone (a restart would re-open the card);
//  12. a Deny after the grace window closed still revokes a grant the card's Approve
//      minted and the agent has not used (the grant lives 24h from the Approve);
//  13. a hatch ask still waiting when the daemon restarts gets its full grace window from
//      the restart, not from when the card was posted;
//  14. a live Deny on a hatch card stays final across a restart even when its questions
//      write failed, leaving the card on disk as still waiting;
//  15. a card on disk still marked waiting but posted longer ago than any ask can wait is
//      a stale copy: the restart gives it no fresh grace window;
//  16. a live Deny on a critical card stays final a day later, and its no-expiry record is
//      dropped with the card's last stored copy;
//  17. that record is dropped as soon as the card leaves the questions store, without a restart;
//  18. a restore whose grace record cannot be written leaves the card in the questions store.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

// Upper bound for any daemon-side effect; a machine running several agents makes the
// daemon slow to schedule, and a wait returns as soon as its condition holds.
const WAIT_MS = 20_000;

function makeCfgDir(): string {
  const cfgDir = tempDir('tgctl-taps-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // A hatch ask forwards through the cwd-match branch of the registration gate.
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  // No tmux server and no process list: a non-zero exit is a hard "nothing there", which
  // discovery accepts at once. An exit-0 EMPTY read is instead retried behind a blocking
  // sleep, stalling every poll-loop iteration for about a second.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return cfgDir;
}

function baseEnv(cfgDir: string, apiPort: number): Record<string, string> {
  return {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
  };
}

function daemonLog(cfgDir: string): string {
  const p = join(cfgDir, 'daemon.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

async function startDaemon(cfgDir: string, apiPort: number, extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: { ...baseEnv(cfgDir, apiPort), ...extraEnv }, logFd });
  closeSync(logFd);
  return daemon;
}

async function stopDaemon(daemon: Subprocess): Promise<void> {
  daemon.kill('SIGTERM');
  await daemon.exited;
}

function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>, extraEnv: Record<string, string> = {}): Subprocess {
  const ask = trackProc(
    reg,
    Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: { ...baseEnv(cfgDir, apiPort), ...extraEnv }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }),
  );
  ask.stdin.write(`${JSON.stringify({ cwd: cfgDir, ...request })}\n`);
  ask.stdin.end();
  return ask;
}

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;

interface Card {
  text: string;
  keyboard: Keyboard | null;
  // The keyboard the card was POSTED with — what a raced tap still carries after an edit.
  postedKeyboard: Keyboard;
}

interface MockTg {
  port: number;
  stop: (c?: boolean) => Promise<void> | void;
  push: (batch: unknown[]) => void;
  cards: Map<number, Card>;
  toasts: Map<string, string>;
}

function mockTelegram(): MockTg {
  const updateQueue: unknown[][] = [];
  const cards = new Map<number, Card>();
  const toasts = new Map<string, string>();
  let cardSeq = 0;
  let plainSeq = 900;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split('/').pop();
      if (method === 'getUpdates') {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const markup = (body.reply_markup as { inline_keyboard?: Keyboard } | undefined)?.inline_keyboard ?? null;
      if (method === 'sendMessage') {
        if (markup?.length) {
          cardSeq += 1;
          cards.set(cardSeq, { text: String(body.text ?? ''), keyboard: markup, postedKeyboard: markup });
          return Response.json({ ok: true, result: { message_id: cardSeq } });
        }
        plainSeq += 1;
        return Response.json({ ok: true, result: { message_id: plainSeq } });
      }
      if (method === 'editMessageText') {
        const card = cards.get(Number(body.message_id));
        if (card) {
          card.text = String(body.text ?? '');
          card.keyboard = markup?.length ? markup : null; // Telegram: no reply_markup ⇒ buttons removed
        }
        return Response.json({ ok: true, result: true });
      }
      if (method === 'editMessageReplyMarkup') {
        const card = cards.get(Number(body.message_id));
        if (card) card.keyboard = markup?.length ? markup : null;
        return Response.json({ ok: true, result: true });
      }
      if (method === 'answerCallbackQuery') {
        toasts.set(String(body.callback_query_id), String(body.text ?? ''));
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  return { port: server.port, stop: (c) => server.stop(c), push: (b) => updateQueue.push(b), cards, toasts };
}

type Choice = 'approve' | 'deny';

// Row 0 of a permission card is [Approve, Reject].
function buttonData(kb: Keyboard | null, choice: Choice): string | null {
  return kb?.[0]?.[choice === 'approve' ? 0 : 1]?.callback_data ?? null;
}

function callbackUpdate(updateId: number, messageId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: messageId, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
      data,
    },
  };
}

// A tap the human can actually make: the button must be on the card RIGHT NOW.
function tapIfShown(tg: MockTg, messageId: number, choice: Choice, updateId: number): void {
  const data = buttonData(tg.cards.get(messageId)?.keyboard ?? null, choice);
  expect(data).not.toBeNull();
  tg.push([callbackUpdate(updateId, messageId, data!)]);
}

// A tap already in flight when the card was edited — it carries the POSTED button.
function raceTap(tg: MockTg, messageId: number, choice: Choice, updateId: number): void {
  const data = buttonData(tg.cards.get(messageId)?.postedKeyboard ?? null, choice);
  expect(data).not.toBeNull();
  tg.push([callbackUpdate(updateId, messageId, data!)]);
}

function textReply(tg: MockTg, messageId: number, text: string, updateId: number): void {
  tg.push([
    {
      update_id: updateId,
      message: {
        message_id: 5000 + updateId,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text,
        reply_to_message: { message_id: messageId, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) - 30, text: tg.cards.get(messageId)?.text ?? '' },
      },
    },
  ]);
}

async function until(cond: () => boolean, ms = WAIT_MS): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(40);
  }
  return cond();
}

async function toastFor(tg: MockTg, updateId: number): Promise<string> {
  expect(await until(() => tg.toasts.has(`cb${updateId}`))).toBe(true);
  return tg.toasts.get(`cb${updateId}`)!;
}

interface GrantStore {
  grants: Array<Record<string, unknown>>;
  grace: Array<Record<string, unknown>>;
  decided: Array<Record<string, unknown>>;
}

function grantStore(cfgDir: string): GrantStore {
  const p = join(cfgDir, 'tg-ctl.123.grants.json');
  if (!existsSync(p)) return { grants: [], grace: [], decided: [] };
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<GrantStore>;
  return { grants: raw.grants ?? [], grace: raw.grace ?? [], decided: raw.decided ?? [] };
}

function inbox(cfgDir: string): string {
  const p = join(cfgDir, 'inbox', SUBAGENT, 'pending.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

// The ask's card is durable (questions store, with its message id): a crash from here on
// restores it, so the reconnecting ask re-attaches instead of posting a second card.
function cardPersisted(cfgDir: string, messageId: number): boolean {
  const p = join(cfgDir, 'tg-ctl.123.questions.json');
  if (!existsSync(p)) return false;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as { questions?: Array<{ req?: { requestId?: string }; messageId?: number | null }> };
  return raw.questions?.some((q) => q.req?.requestId === REQUEST_ID && q.messageId === messageId) ?? false;
}

// Move every stored card's posting time `ms` into the past while no daemon runs — the
// daemon is a separate process on the wall clock, so a long wait is simulated on disk.
function backdateQuestions(cfgDir: string, ms: number): void {
  const p = join(cfgDir, 'tg-ctl.123.questions.json');
  const store = JSON.parse(readFileSync(p, 'utf8')) as { questions: Array<{ at: number }> };
  for (const q of store.questions) q.at -= ms;
  writeFileSync(p, JSON.stringify(store));
}

// Inject a write failure into a daemon store: atomicWrite writes `<path>.tmp` and renames
// it, so a directory at that temp path makes every write of the store throw. Returns the
// undo.
function blockWrites(cfgDir: string, store: 'questions' | 'grants'): () => void {
  const tmp = join(cfgDir, `tg-ctl.123.${store}.json.tmp`);
  mkdirSync(tmp);
  return () => rmSync(tmp, { recursive: true });
}

const HOOK_ID = 'tap-hook';
const REQUEST_ID = `hatch-${HOOK_ID}-aaaaaaaaaaaa`;
const SUBAGENT = 'hatch-worker';
const OPERATION = { kind: 'bash', fingerprint: 'sha256:fp-tap-1', cwd: '/repo' };

// The hatch ask exactly as agent-tools' request_hatch_approval sends it (v1.1 fields). omp by
// default: the only harness a paneless grant notice still reaches (its Stop-hook inbox) —
// Claude Code and Codex are tmux-only (tg-cli#456), so theirs is never queued. A test that
// reads the live answer's hook envelope asks as Claude Code, whose envelope that is.
function hatchAsk(extra: Record<string, unknown> = {}, agent: 'omp' | 'claude' = 'omp'): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    agent,
    kind: 'permission',
    question: `Allow rig hatch escalation: ${HOOK_ID}?`,
    permissionEvent: 'PermissionRequest',
    hookId: HOOK_ID,
    origin: { agent, subagent: SUBAGENT },
    operation: OPERATION,
    ...extra,
  };
}

// Post the ask and let the requesting process die (the hook's own budget elapsed): the
// daemon retires it into the retained map + a 24h grace record. Returns the card id.
async function expiredCard(cfgDir: string, tg: MockTg): Promise<number> {
  const ask = startAsk(cfgDir, tg.port, hatchAsk());
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  ask.kill(9);
  await ask.exited;
  expect(await until(() => tg.cards.get(1)!.text.includes('stays answerable for 24h'))).toBe(true);
  expect(await until(() => grantStore(cfgDir).grace.length === 1)).toBe(true);
  return 1;
}

// Past the (shrunk) 12h retention the running daemon's sweep prunes the retained entry;
// only the grace record still answers for the card.
async function graceOnlyCard(cfgDir: string, tg: MockTg): Promise<number> {
  const cardId = await expiredCard(cfgDir, tg);
  expect(await until(() => daemonLog(cfgDir).includes('ask-abandoned-long-outage'))).toBe(true);
  expect(await until(() => tg.cards.get(cardId)!.text.includes('a long wait has passed'))).toBe(true);
  return cardId;
}

async function expectMintedAndDelivered(cfgDir: string, tg: MockTg, cardId: number): Promise<Record<string, unknown>> {
  expect(await until(() => grantStore(cfgDir).grants.length === 1)).toBe(true);
  const grant = grantStore(cfgDir).grants[0]!;
  expect(grant.request_id).toBe(REQUEST_ID);
  expect(grant.consumed_at).toBeNull();
  expect(await until(() => inbox(cfgDir).includes(String(grant.approval_id)))).toBe(true);
  expect(await until(() => tg.cards.get(cardId)!.text.includes(String(grant.approval_id)))).toBe(true);
  return grant;
}

async function verifyToken(cfgDir: string, apiPort: number, approvalId: string): Promise<unknown> {
  const proc = trackProc(
    reg,
    Bun.spawn([process.execPath, TG_CTL, 'ask', '--verify-grant', approvalId, '--hook', HOOK_ID], {
      env: baseEnv(cfgDir, apiPort),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  // The retry of the blocked operation is a new invocation with a fresh requestId; the
  // token path binds to hook + operation, never to the original requestId.
  proc.stdin.write(`${JSON.stringify(hatchAsk({ requestId: `hatch-${HOOK_ID}-cccccccccccc` }))}\n`);
  proc.stdin.end();
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return JSON.parse(out);
}

const DENY_ENVELOPE = { hookSpecificOutput: { decision: { behavior: 'deny' } } };

test('1. a late Deny on a retained card is FINAL: grace retired, a raced Approve mints nothing, the requester is told', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const cardId = await expiredCard(cfgDir, tg);

  tapIfShown(tg, cardId, 'deny', 701);
  expect(await toastFor(tg, 701)).toContain('denied');
  expect(await until(() => grantStore(cfgDir).grace.length === 0)).toBe(true);
  // The requester learns the outcome instead of waiting on an approval that never comes.
  expect(await until(() => inbox(cfgDir).includes('DENIED'))).toBe(true);
  expect(inbox(cfgDir)).toContain(REQUEST_ID);

  raceTap(tg, cardId, 'approve', 702);
  expect(await toastFor(tg, 702)).not.toContain('grant issued');
  expect(grantStore(cfgDir).grants).toHaveLength(0);
  expect(daemonLog(cfgDir)).not.toContain('hatch-grant-minted');

  await stopDaemon(daemon);
}, 90_000);

test('2. past the 12h retention the long-outage edit keeps Approve/Reject on the card, and the tap mints the grant', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' });
  const cardId = await graceOnlyCard(cfgDir, tg);

  tapIfShown(tg, cardId, 'approve', 711);
  expect(await toastFor(tg, 711)).toContain('grant issued');
  await expectMintedAndDelivered(cfgDir, tg, cardId);

  await stopDaemon(daemon);
}, 90_000);

test('3. a text reply "да" to a grace-only card approves it like a tap', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' });
  const cardId = await graceOnlyCard(cfgDir, tg);

  textReply(tg, cardId, 'да', 721);
  await expectMintedAndDelivered(cfgDir, tg, cardId);

  await stopDaemon(daemon);
}, 90_000);

test('4. a Deny on a grace-only card is final: the grace record is retired and a raced Approve mints nothing', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port, { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' });
  const cardId = await graceOnlyCard(cfgDir, tg);

  tapIfShown(tg, cardId, 'deny', 731);
  expect(await toastFor(tg, 731)).toContain('denied');
  expect(await until(() => grantStore(cfgDir).grace.length === 0)).toBe(true);

  raceTap(tg, cardId, 'approve', 732);
  expect(await toastFor(tg, 732)).not.toContain('grant issued');
  expect(grantStore(cfgDir).grants).toHaveLength(0);

  await stopDaemon(daemon);
}, 90_000);

test('5. a Deny after the Approve minted a grant REVOKES the unconsumed grant — its token no longer allows', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const cardId = await expiredCard(cfgDir, tg);

  tapIfShown(tg, cardId, 'approve', 741);
  expect(await toastFor(tg, 741)).toContain('grant issued');
  const grant = await expectMintedAndDelivered(cfgDir, tg, cardId);

  raceTap(tg, cardId, 'deny', 742);
  expect(await toastFor(tg, 742)).toContain('revoked');
  expect(await until(() => grantStore(cfgDir).grants.length === 0)).toBe(true);
  expect(await until(() => tg.cards.get(cardId)!.text.includes('revoked'))).toBe(true);
  expect(await until(() => inbox(cfgDir).includes('REVOKED'))).toBe(true);
  expect(await verifyToken(cfgDir, tg.port, String(grant.approval_id))).toMatchObject(DENY_ENVELOPE);

  await stopDaemon(daemon);
}, 90_000);

test('6. a daemon restart while a paneless hatch ask is LIVE keeps its card answerable: the tap mints the grant', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 600_000 }));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward posted'))).toBe(true);

  // The deploy/idle-exit restart lands while the ask is still waiting on its socket.
  await stopDaemon(daemon1);
  await ask.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'))).toBe(true);

  tapIfShown(tg, 1, 'approve', 751);
  expect(await toastFor(tg, 751)).toContain('grant issued');
  await expectMintedAndDelivered(cfgDir, tg, 1);

  await stopDaemon(daemon2);
}, 90_000);

test('7. a restart past the retention window keeps the restored card tappable: the tap mints the grant', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const env = { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' };
  const daemon1 = await startDaemon(cfgDir, tg.port, env);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 600_000 }));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward posted'))).toBe(true);

  await stopDaemon(daemon1);
  await ask.exited;
  // Down for longer than the (shrunk) retention: the restore itself retires the card.
  await Bun.sleep(500); // real clock on purpose — the retention window elapses while no daemon runs
  const daemon2 = await startDaemon(cfgDir, tg.port, env);
  expect(await until(() => daemonLog(cfgDir).includes('ask-abandoned-long-outage'))).toBe(true);
  expect(await until(() => tg.cards.get(1)!.text.includes('a long wait has passed'))).toBe(true);

  tapIfShown(tg, 1, 'approve', 761);
  expect(await toastFor(tg, 761)).toContain('grant issued');
  await expectMintedAndDelivered(cfgDir, tg, 1);

  await stopDaemon(daemon2);
}, 90_000);

test('8. a pane-scoped ask that re-attaches after a restart and is denied LIVE cannot be re-opened by a raced Approve', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ paneId: '%9', timeoutMs: 600_000 }, 'claude'), { TMUX_PANE: '%9' });
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward posted'))).toBe(true);

  // A crash: the ask's reconnect loop resends the same request to the next daemon.
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);
  daemon1.kill(9);
  await daemon1.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward reattached'))).toBe(true);

  tapIfShown(tg, 1, 'deny', 771);
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject(DENY_ENVELOPE);

  raceTap(tg, 1, 'approve', 772);
  expect(await toastFor(tg, 772)).not.toContain('grant issued');
  expect(grantStore(cfgDir).grants).toHaveLength(0);

  await stopDaemon(daemon2);
}, 90_000);

test('9. after the grace window closed, a tap mints nothing and retires the card buttons', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const env = { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300', TG_CTL_GRACE_MS: '15000' };
  const daemon1 = await startDaemon(cfgDir, tg.port, env);
  const cardId = await graceOnlyCard(cfgDir, tg);
  expect(buttonData(tg.cards.get(cardId)!.keyboard, 'approve')).not.toBeNull();
  const graceExpiresAt = Number(grantStore(cfgDir).grace[0]!.graceExpiresAt);

  // Down across the end of the grace window: the restarted daemon loads the store
  // without the closed record, so nothing is left to answer for the card.
  await stopDaemon(daemon1);
  await Bun.sleep(Math.max(0, graceExpiresAt - Date.now()) + 200); // real clock on purpose — the window must close
  const daemon2 = await startDaemon(cfgDir, tg.port, env);

  tapIfShown(tg, cardId, 'approve', 781);
  expect(await toastFor(tg, 781)).not.toContain('grant issued');
  expect(await until(() => tg.cards.get(cardId)!.keyboard === null)).toBe(true);
  expect(grantStore(cfgDir).grants).toHaveLength(0);

  await stopDaemon(daemon2);
}, 90_000);

test('10. a Deny stays final across a restart: neither an Approve tap nor a "да" reply mints', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);
  const cardId = await expiredCard(cfgDir, tg);

  // The questions store is best-effort: a lost write leaves the denied card retained on
  // disk, and the next daemon restores it. Only the grant store's record of the Deny
  // stands between that restore and a fresh grace record.
  const unblock = blockWrites(cfgDir, 'questions');
  tapIfShown(tg, cardId, 'deny', 801);
  expect(await toastFor(tg, 801)).toContain('denied');
  expect(await until(() => daemonLog(cfgDir).includes('question persist failed'))).toBe(true);
  await stopDaemon(daemon1);
  unblock();

  const daemon2 = await startDaemon(cfgDir, tg.port);
  textReply(tg, cardId, 'да', 802);
  // Updates are handled in order: once this tap's toast is out, the reply was handled too.
  raceTap(tg, cardId, 'approve', 803);
  expect(await toastFor(tg, 803)).not.toContain('grant issued');
  expect(grantStore(cfgDir).grants).toHaveLength(0);
  expect(daemonLog(cfgDir)).not.toContain('hatch-grant-minted');

  await stopDaemon(daemon2);
}, 90_000);

test('11. a live answer whose grace close cannot be written is refused; the re-tap then decides it', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ paneId: '%9', timeoutMs: 600_000 }, 'claude'), { TMUX_PANE: '%9' });
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward posted'))).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);
  daemon1.kill(9);
  await daemon1.exited;
  const daemon2 = await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).includes('ask-forward reattached'))).toBe(true);
  expect(await until(() => grantStore(cfgDir).grace.length === 1)).toBe(true);

  const unblock = blockWrites(cfgDir, 'grants');
  tapIfShown(tg, 1, 'deny', 811);
  expect(await toastFor(tg, 811)).toContain('could not record');
  expect(daemonLog(cfgDir)).not.toContain('ask-answered');
  unblock();

  // The card is still live: the re-tap answers the waiting agent and closes the card.
  tapIfShown(tg, 1, 'deny', 812);
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject(DENY_ENVELOPE);
  expect(await until(() => grantStore(cfgDir).grace.length === 0)).toBe(true);

  await stopDaemon(daemon2);
}, 90_000);

test('12. past the grace window, a Deny still revokes the unused grant the card minted', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const env = { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300', TG_CTL_GRACE_MS: '8000' };
  const daemon1 = await startDaemon(cfgDir, tg.port, env);
  const cardId = await graceOnlyCard(cfgDir, tg);
  tapIfShown(tg, cardId, 'approve', 821);
  expect(await toastFor(tg, 821)).toContain('grant issued');
  const grant = await expectMintedAndDelivered(cfgDir, tg, cardId);
  const graceExpiresAt = Number(grantStore(cfgDir).grace[0]!.graceExpiresAt);

  // Down across the end of the grace window: the restarted daemon loads the store with it
  // closed, while the grant (24h from the Approve) is still valid and unused.
  await stopDaemon(daemon1);
  // Real clock on purpose (as in test 9): the daemon is a separate process reading the
  // wall clock, so its grace window can only close in real time.
  await Bun.sleep(Math.max(0, graceExpiresAt - Date.now()) + 200);
  const daemon2 = await startDaemon(cfgDir, tg.port, env);

  raceTap(tg, cardId, 'deny', 822);
  expect(await toastFor(tg, 822)).toContain('revoked');
  expect(await until(() => grantStore(cfgDir).grants.length === 0)).toBe(true);
  expect(await verifyToken(cfgDir, tg.port, String(grant.approval_id))).toMatchObject(DENY_ENVELOPE);

  await stopDaemon(daemon2);
}, 90_000);

test('13. an ask pending longer than the grace window before a restart is still tappable after it', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const env = { TG_CTL_GRACE_MS: '60000' };
  const daemon1 = await startDaemon(cfgDir, tg.port, env);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 600_000 }));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);
  await stopDaemon(daemon1);
  await ask.exited;

  // The ask had been waiting on its socket for two minutes — longer than the (shrunk)
  // grace window — when the restart ended it: backdate its posting time on disk.
  backdateQuestions(cfgDir, 120_000);

  const restartAt = Date.now();
  const daemon2 = await startDaemon(cfgDir, tg.port, env);
  expect(await until(() => grantStore(cfgDir).grace.length === 1)).toBe(true);
  expect(Number(grantStore(cfgDir).grace[0]!.graceExpiresAt)).toBeGreaterThanOrEqual(restartAt + 60_000);

  tapIfShown(tg, 1, 'approve', 831);
  expect(await toastFor(tg, 831)).toContain('grant issued');
  await expectMintedAndDelivered(cfgDir, tg, 1);

  await stopDaemon(daemon2);
}, 90_000);

test('14. a live Deny stays final across a restart when its questions write failed', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 600_000 }, 'claude'));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);

  // The questions store is best-effort: the answer's write is lost, and the file still
  // holds the card as waiting. Only the grant store's record of the decision stands
  // between the next restore and a fresh grace window.
  const unblock = blockWrites(cfgDir, 'questions');
  tapIfShown(tg, 1, 'deny', 841);
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject(DENY_ENVELOPE);
  expect(await until(() => daemonLog(cfgDir).includes('question persist failed'))).toBe(true);
  await stopDaemon(daemon1);
  unblock();
  expect(cardPersisted(cfgDir, 1)).toBe(true);

  const daemon2 = await startDaemon(cfgDir, tg.port);
  textReply(tg, 1, 'да', 842);
  // Updates are handled in order: once this tap's toast is out, the reply was handled too.
  raceTap(tg, 1, 'approve', 843);
  expect(await toastFor(tg, 843)).not.toContain('grant issued');
  expect(grantStore(cfgDir).grants).toHaveLength(0);
  expect(daemonLog(cfgDir)).not.toContain('hatch-grant-minted');

  await stopDaemon(daemon2);
}, 90_000);

test('15. a card still marked waiting but older than any ask can wait gets no fresh grace window', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const env = { TG_CTL_GRACE_MS: '60000' };
  const daemon1 = await startDaemon(cfgDir, tg.port, env);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 600_000 }));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);
  await stopDaemon(daemon1);
  await ask.exited;

  // Posted 20 minutes ago: past the 15-minute cap on any ask's wait, so the "waiting" mark
  // is a stale copy, and the (shrunk) grace window counted from that cap has closed.
  backdateQuestions(cfgDir, 20 * 60_000);
  const daemon2 = await startDaemon(cfgDir, tg.port, env);
  expect(await until(() => daemonLog(cfgDir).includes('questions restored'))).toBe(true);

  tapIfShown(tg, 1, 'approve', 851);
  expect(await toastFor(tg, 851)).toContain('too late');
  expect(grantStore(cfgDir).grants).toHaveLength(0);

  await stopDaemon(daemon2);
}, 90_000);

// Move every decided-card record in the grant store `ms` into the past (see
// backdateQuestions): a day of wall clock is simulated on disk.
function backdateDecided(cfgDir: string, ms: number): void {
  const p = join(cfgDir, 'tg-ctl.123.grants.json');
  const store = JSON.parse(readFileSync(p, 'utf8')) as { decided: Array<{ decidedAt: number; expiresAt: number | null }> };
  for (const d of store.decided) {
    d.decidedAt -= ms;
    if (d.expiresAt !== null) d.expiresAt -= ms;
  }
  writeFileSync(p, JSON.stringify(store));
}

test('16. a live Deny on a CRITICAL card stays final across a restart a day later when its questions write failed', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon1 = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ critical: true }, 'claude'));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);

  const unblock = blockWrites(cfgDir, 'questions');
  tapIfShown(tg, 1, 'deny', 861);
  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject(DENY_ENVELOPE);
  expect(await until(() => daemonLog(cfgDir).includes('question persist failed'))).toBe(true);
  await stopDaemon(daemon1);
  unblock();
  expect(cardPersisted(cfgDir, 1)).toBe(true);

  // A critical ask waits without limit, so its stale "waiting" copy would get a fresh
  // grace window from any later restart: the record of the Deny must outlive the copy,
  // not a fixed retention (25h here, past the 24h15m a non-critical card needs).
  const day = 25 * 60 * 60_000;
  backdateQuestions(cfgDir, day);
  backdateDecided(cfgDir, day);
  const daemon2 = await startDaemon(cfgDir, tg.port);
  textReply(tg, 1, 'да', 862);
  raceTap(tg, 1, 'approve', 863);
  expect(await toastFor(tg, 863)).not.toContain('grant issued');
  expect(grantStore(cfgDir).grants).toHaveLength(0);
  expect(daemonLog(cfgDir)).not.toContain('hatch-grant-minted');
  await stopDaemon(daemon2);

  // The restart dropped the stale copy from the questions store and the record of the
  // Deny with it: it guards nothing once no copy is left.
  expect(cardPersisted(cfgDir, 1)).toBe(false);
  expect(grantStore(cfgDir).decided).toHaveLength(0);
}, 90_000);

test('17. the record of a live Deny on a CRITICAL card is dropped once the card leaves the questions store, with no restart', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ critical: true }, 'claude'));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);

  tapIfShown(tg, 1, 'deny', 871);
  await new Response(ask.stdout).text();
  await ask.exited;
  expect(await until(() => !cardPersisted(cfgDir, 1))).toBe(true);
  // A record with no expiry would otherwise stay until the next restart: a busy daemon
  // would grow the grant store with every critical card it ever answered.
  expect(await until(() => grantStore(cfgDir).decided.length === 0)).toBe(true);

  await stopDaemon(daemon);
}, 90_000);

test('18. a restart whose grace record cannot be written leaves the card in the questions store', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const env = { TG_CTL_ABANDONED_PERMISSION_RETAIN_MS: '300' };
  const daemon1 = await startDaemon(cfgDir, tg.port, env);
  const ask = startAsk(cfgDir, tg.port, hatchAsk({ timeoutMs: 600_000 }));
  expect(await until(() => tg.cards.size === 1)).toBe(true);
  expect(await until(() => cardPersisted(cfgDir, 1))).toBe(true);
  await stopDaemon(daemon1);
  await ask.exited;

  // The restore retires the card past its retention and anchors its grace record in memory;
  // the grant store cannot take it. The questions store is then the only durable copy of
  // the card, so the restore must not write it away: the next restart still has the card.
  await Bun.sleep(500); // real clock on purpose — the retention window elapses while no daemon runs
  const unblock = blockWrites(cfgDir, 'grants');
  const daemon2 = await startDaemon(cfgDir, tg.port, env);
  expect(await until(() => daemonLog(cfgDir).includes('grant persist failed'))).toBe(true);
  await stopDaemon(daemon2);
  unblock();

  expect(cardPersisted(cfgDir, 1)).toBe(true);
}, 90_000);
