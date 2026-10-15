// tg-cli#705: the 📥 Inbox topic and the relevance signals that close a question, end to end —
// a real daemon, real `tg-ctl ask` clients, a fake Bot API and a fake tmux/ps reporting one
// claude pane (%1). Covers: the silent copy (same buttons + Dismiss) and its removal when the
// card closes; a tap on the copy answering the agent; the socket `withdraw` line; `tg-ctl
// withdraw --hook-id`; the asker's SIGTERM withdraw; a message typed in chat answering the only
// open card (and only asking which card when there are several); a newer hatch request
// superseding the older card; Dismiss on the copy; the one-shot migration of the old reminders.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PANE_ID = '%1';
const PANE_PID = 4242;
const INBOX_THREAD = 77;
const SESSION_THREAD = 501;

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
    # session, window index, pane, pane pid, command, window name, pane title, path
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '' '${cwd}'
    ;;
  # The server pid (session-registry locators, tg-cli#717); the session name otherwise.
  display-message) case "$*" in *'#{pid}'*) printf '4240\\n' ;; *) printf 'main\\n' ;; esac ;;
  send-keys)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then printf '%s\\n' "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer) cat >> '${injectLog}'; printf '\\n' >> '${injectLog}' ;;
esac
exit 0
`;
}

function makeCfgDir(topics = true): string {
  const cfgDir = tempDir('tgctl-qinbox-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  topics: ${topics}\n`);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: PANE_ID, cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, join(cfgDir, 'inject.log')), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), `#!/bin/sh\nprintf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'\nexit 0\n`, { mode: 0o755 });
  return cfgDir;
}

function env(cfgDir: string, apiPort: number): Record<string, string> {
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

function injected(cfgDir: string): string {
  const p = join(cfgDir, 'inject.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: env(cfgDir, apiPort), logFd });
  closeSync(logFd);
  return daemon;
}

// A scoped ask from pane %1 of the claude session `inbox-sess` (its hook names the session, so
// the card goes to that session's topic — tg-cli#717), or a paneless hatch ask no session owns
// (its card goes INTO the 📥 Inbox).
function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>, scoped = true): Subprocess {
  const e = env(cfgDir, apiPort);
  if (scoped) e.TMUX_PANE = PANE_ID;
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: e, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  const scope = scoped ? { paneId: PANE_ID, origin: { sessionId: 'inbox-sess' } } : {};
  ask.stdin.write(JSON.stringify({ cwd: cfgDir, ...scope, ...request }) + '\n');
  ask.stdin.end();
  return ask;
}

interface Sent {
  id: number;
  text: string;
  threadId: number | null;
  silent: boolean;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

function mockTelegram() {
  const updates: unknown[][] = [];
  const sent: Sent[] = [];
  const edits: Array<{ id: number; text: string }> = [];
  const deletes: Array<{ chat: number; id: number }> = [];
  const answered: string[] = [];
  const reactions: Array<{ id: number; emoji: string }> = [];
  const keyboardClears: number[] = [];
  let seq = 100;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split('/').at(-1);
      if (method === 'getUpdates') {
        const batch = updates.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      const body = (await req.json()) as Record<string, unknown>;
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123, is_bot: true, has_topics_enabled: true } });
      if (method === 'createForumTopic') {
        // The 📥 Inbox gets INBOX_THREAD; any session topic another id.
        const threadId = body.name === '📥 Inbox' ? INBOX_THREAD : SESSION_THREAD;
        return Response.json({ ok: true, result: { message_thread_id: threadId, name: body.name } });
      }
      if (method === 'sendMessage') {
        seq += 1;
        const markup = body.reply_markup as { inline_keyboard?: Sent['keyboard'] } | undefined;
        sent.push({
          id: seq,
          text: String(body.text ?? ''),
          threadId: typeof body.message_thread_id === 'number' ? body.message_thread_id : null,
          silent: body.disable_notification === true,
          keyboard: markup?.inline_keyboard ?? [],
        });
        return Response.json({ ok: true, result: { message_id: seq } });
      }
      if (method === 'editMessageText') edits.push({ id: Number(body.message_id), text: String(body.text ?? '') });
      if (method === 'deleteMessage') deletes.push({ chat: Number(body.chat_id), id: Number(body.message_id) });
      if (method === 'answerCallbackQuery') answered.push(String(body.text ?? ''));
      if (method === 'editMessageReplyMarkup') keyboardClears.push(Number(body.message_id));
      if (method === 'setMessageReaction') {
        const reaction = (body.reaction as Array<{ emoji?: string }> | undefined)?.[0];
        reactions.push({ id: Number(body.message_id), emoji: String(reaction?.emoji ?? '') });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  // A card in its session topic or General; a silent copy in the Inbox; a card posted INTO the
  // Inbox because no session topic exists for it (tg-cli#717).
  const cards = (): Sent[] => sent.filter((s) => s.threadId !== INBOX_THREAD && s.keyboard.length > 0);
  const mirrors = (): Sent[] => sent.filter((s) => s.threadId === INBOX_THREAD && s.text.startsWith('📥 '));
  const inboxCards = (): Sent[] => sent.filter((s) => s.threadId === INBOX_THREAD && s.keyboard.length > 0 && !s.text.startsWith('📥 '));
  const plain = (): Sent[] => sent.filter((s) => s.keyboard.length === 0);
  const tap = (messageId: number, data: string, updateId: number): void => {
    updates.push([
      {
        update_id: updateId,
        callback_query: { id: `cb${updateId}`, from: { id: 1, first_name: 'Alex' }, message: { message_id: messageId, chat: { id: 1 }, date: 0 }, data },
      },
    ]);
  };
  const say = (text: string, messageId: number, updateId: number): void => {
    updates.push([{ update_id: updateId, message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1, type: 'private' }, date: Math.floor(Date.now() / 1000), text } }]);
  };
  // A text reply to `toMessageId`, posted in the 📥 Inbox topic when `inInbox`.
  const reply = (text: string, toMessageId: number, messageId: number, updateId: number, inInbox: boolean): void => {
    const now = Math.floor(Date.now() / 1000);
    updates.push([
      {
        update_id: updateId,
        message: {
          message_id: messageId,
          from: { id: 1, first_name: 'Alex' },
          chat: { id: 1, type: 'private' },
          date: now,
          text,
          ...(inInbox ? { message_thread_id: INBOX_THREAD, is_topic_message: true } : {}),
          reply_to_message: { message_id: toMessageId, chat: { id: 1 }, date: now - 5, text: 'card' },
        },
      },
    ]);
  };
  // A plain (non-reply) message the human posts inside the 📥 Inbox topic.
  const inInbox = (text: string, messageId: number, updateId: number): void => {
    updates.push([
      {
        update_id: updateId,
        message: {
          message_id: messageId,
          from: { id: 1, first_name: 'Alex' },
          chat: { id: 1, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text,
          message_thread_id: INBOX_THREAD,
          is_topic_message: true,
        },
      },
    ]);
  };
  return {
    port: server.port,
    stop: (c?: boolean) => server.stop(c),
    cards,
    mirrors,
    inboxCards,
    plain,
    edits: () => edits,
    deletes: () => deletes,
    answered: () => answered,
    reactions: () => reactions,
    keyboardClears: () => keyboardClears,
    tap,
    say,
    reply,
    inInbox,
  };
}

async function until(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(40);
  }
  return cond();
}

// Not written yet → empty, so a wait can poll it.
function inboxState(cfgDir: string): { threadId: number | null; mirrors: Record<string, { messageId: number }> } {
  const path = join(cfgDir, 'tg-ctl.123.question-inbox.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { threadId: null, mirrors: {} };
}

// One line to the daemon socket, the way `tg-ctl ask`'s signal handler sends it.
function socketLine(cfgDir: string, line: Record<string, string>): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let raw = '';
  const socket = createConnection(join(cfgDir, 'tg-ctl.123.sock'));
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(`${JSON.stringify(line)}\n`));
  socket.on('data', (c) => {
    raw += c;
  });
  socket.on('close', () => resolve(raw));
  socket.on('error', reject);
  return promise;
}

const QUESTION = { requestId: 'q_inbox', agent: 'claude', kind: 'question', title: 'Deploy', question: 'Where should I deploy?', options: [{ label: 'Staging' }, { label: 'Production' }] };
const PERMISSION = { requestId: 'p_inbox', agent: 'claude', kind: 'permission', question: 'Allow bash command: rm -rf /tmp/x?', permissionEvent: 'PermissionRequest' };
const hatchAsk = (suffix: string, hookId = 'ship-skip-ci', cwd?: string): Record<string, unknown> => ({
  requestId: `hatch-${hookId}-${suffix.repeat(12)}`,
  agent: 'claude',
  kind: 'permission',
  question: `Allow rig hatch escalation: ${hookId}?`,
  permissionEvent: 'PermissionRequest',
  hookId,
  ...(cwd ? { cwd } : {}),
});

test('INBOX: an open card gets a SILENT copy in the 📥 Inbox topic with the same buttons + Dismiss; answering the card removes the copy', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1 && tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  const mirror = tg.mirrors()[0];
  expect(mirror.silent).toBe(true);
  expect(mirror.text).toContain('📥 ');
  expect(mirror.text).toContain('Where should I deploy?');
  const cardData = card.keyboard.flat().map((b) => b.callback_data);
  const mirrorData = mirror.keyboard.flat().map((b) => b.callback_data);
  expect(mirrorData.slice(0, cardData.length)).toEqual(cardData);
  expect(mirror.keyboard.at(-1)![0].text).toBe('✕ Dismiss');
  // The state file is written once the copy's send returns — a moment after the mock saw it.
  expect(await until(() => inboxState(cfgDir).mirrors.q_inbox?.messageId === mirror.id)).toBe(true);
  expect(inboxState(cfgDir).mirrors).toEqual({ q_inbox: { messageId: mirror.id, cardId: card.id } });
  // The card itself is never posted twice and nothing else lands in General.
  expect(tg.plain().filter((s) => s.text.startsWith('⏳'))).toHaveLength(0);

  tg.tap(card.id, card.keyboard[1][0].callback_data, 501);
  const out = await new Response(ask.stdout).text();
  expect(out).toContain('Production');
  expect(await until(() => tg.deletes().some((d) => d.id === mirror.id))).toBe(true);
  expect(await until(() => Object.keys(inboxState(cfgDir).mirrors).length === 0)).toBe(true);
}, 60_000);

test('INBOX: a tap on the COPY answers the agent exactly like a tap on the card', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.cards().length === 1 && tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  const mirror = tg.mirrors()[0];
  tg.tap(mirror.id, 'tgq:p_inbox:allow', 502);
  const out = await new Response(ask.stdout).text();
  expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  // The ORIGINAL card shows the answer; the copy goes away.
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('Selected answer: Approve')))).toBe(true);
  expect(await until(() => tg.deletes().some((d) => d.id === mirror.id))).toBe(true);
}, 60_000);

test('INBOX: a text reply to the COPY of a LIVE question answers the agent with that text', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  tg.reply('Canary first', tg.mirrors()[0].id, 950, 504, true);
  const out = JSON.parse(await new Response(ask.stdout).text());
  expect(out.hookSpecificOutput.updatedInput.answers).toEqual({ 'Where should I deploy?': 'Canary first' });
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('✓ answered in chat: Canary first')))).toBe(true);
}, 60_000);

test('INBOX: ✕ Dismiss on the copy closes the card (asker gets null) and removes the copy', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  const mirror = tg.mirrors()[0];
  tg.tap(mirror.id, mirror.keyboard.at(-1)![0].callback_data, 503);
  expect((await new Response(ask.stdout).text()).trim()).toBe('');
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('✕ dismissed')))).toBe(true);
  // The closed card keeps no button that could still answer it.
  expect(await until(() => tg.keyboardClears().includes(card.id))).toBe(true);
  expect(await until(() => tg.deletes().some((d) => d.id === mirror.id))).toBe(true);
}, 60_000);

test('WITHDRAW line: the socket `withdraw` closes the card with its reason and removes the copy', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  const mirror = tg.mirrors()[0];
  const reply = await socketLine(cfgDir, { withdraw: 'p_inbox', reason: 'answered in the terminal' });
  expect(JSON.parse(reply)).toEqual({ tgctl: 'withdrawn', closed: 1 });
  expect((await new Response(ask.stdout).text()).trim()).toBe('');
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('⏹ withdrawn: answered in the terminal')))).toBe(true);
  expect(await until(() => tg.deletes().some((d) => d.id === mirror.id))).toBe(true);
  // A second withdraw finds nothing open.
  expect(JSON.parse(await socketLine(cfgDir, { withdraw: 'p_inbox' }))).toEqual({ tgctl: 'withdrawn', closed: 0 });
}, 60_000);

test('WITHDRAW command: `tg-ctl withdraw --hook-id` closes the open hatch card; nothing left → exit 1', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  // No session owns this paneless hatch ask: its card itself is posted into the 📥 Inbox (#717).
  startAsk(cfgDir, tg.port, hatchAsk('a', 'ship-skip-ci', cfgDir), false);
  expect(await until(() => tg.inboxCards().length === 1)).toBe(true);
  const card = tg.inboxCards()[0];
  const run = (args: string[]) => Bun.spawnSync([process.execPath, TG_CTL, 'withdraw', ...args], { env: env(cfgDir, tg.port) });
  const first = run(['--hook-id', 'ship-skip-ci', '--cwd', cfgDir, '--reason', 'retried by hand']);
  expect(first.exitCode).toBe(0);
  expect(first.stdout.toString()).toContain('withdrawn: 1 card');
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('⏹ withdrawn: retried by hand')))).toBe(true);
  // The card IS the Inbox entry: closed in place, never deleted, and no copy was ever posted.
  expect(await until(() => !('hatch-ship-skip-ci-aaaaaaaaaaaa' in inboxState(cfgDir).mirrors))).toBe(true);
  expect(tg.deletes().some((d) => d.id === card.id)).toBe(false);
  expect(tg.mirrors()).toHaveLength(0);
  expect(run(['--hook-id', 'ship-skip-ci']).exitCode).toBe(1);
  expect(run([]).exitCode).toBe(2);
}, 60_000);

test('WITHDRAW on signal: a SIGTERM to the waiting `tg-ctl ask` withdraws its card before it exits', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  ask.kill('SIGTERM');
  expect(await ask.exited).toBe(143);
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('⏹ withdrawn: the asking process was stopped (SIGTERM)')))).toBe(true);
  expect(await until(() => tg.deletes().some((d) => d.id === tg.mirrors()[0].id))).toBe(true);
}, 60_000);

test('ANSWERED IN CHAT: a plain message to a session with exactly ONE open card answers it down the hook', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const ask = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);
  const card = tg.cards()[0];
  tg.say('no, use the staging db', 900, 601);
  const out = JSON.parse(await new Response(ask.stdout).text());
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no, use the staging db' } } });
  expect(await until(() => tg.edits().some((e) => e.id === card.id && e.text.includes('✓ answered in chat: no, use the staging db')))).toBe(true);
  expect(await until(() => tg.deletes().some((d) => d.id === tg.mirrors()[0].id))).toBe(true);
  // The message was the answer, not also typed into the pane.
  expect(injected(cfgDir)).not.toContain('staging db');
}, 60_000);

test('ANSWERED IN CHAT: with SEVERAL open cards nothing is guessed — one "which card" notice, no auto-answer', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  const askQ = startAsk(cfgDir, tg.port, QUESTION);
  const askP = startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.mirrors().length === 2)).toBe(true);
  tg.say('go ahead', 901, 602);
  expect(await until(() => tg.plain().some((s) => s.text === 'this session has 2 open questions — reply to the card you mean'))).toBe(true);
  // Neither asker was answered by it.
  expect(askQ.exitCode).toBeNull();
  expect(askP.exitCode).toBeNull();
  expect(tg.plain().filter((s) => s.text.includes('open questions'))).toHaveLength(1);
  expect(daemonLog(cfgDir)).not.toContain('ask-answered-in-chat');
  // Not an answer, and not typed into the pane behind the open prompt either: it waits in the
  // pane's defer queue (✍️) for the cards to be answered.
  expect(await until(() => tg.reactions().some((r) => r.id === 901 && r.emoji === '✍️'))).toBe(true);
  expect(injected(cfgDir)).not.toContain('go ahead');
}, 60_000);

test('HATCH SUPERSEDE: a newer request for the same (hookId, cwd) closes the older card', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  // No session owns these paneless asks, so each card lives in the 📥 Inbox itself (#717).
  const older = startAsk(cfgDir, tg.port, hatchAsk('a', 'ship-skip-ci', cfgDir), false);
  expect(await until(() => tg.inboxCards().length === 1)).toBe(true);
  const olderCard = tg.inboxCards()[0];
  // A different hook in the same directory is unrelated and stays open.
  startAsk(cfgDir, tg.port, hatchAsk('c', 'other-hook', cfgDir), false);
  expect(await until(() => tg.inboxCards().length === 2)).toBe(true);
  startAsk(cfgDir, tg.port, hatchAsk('b', 'ship-skip-ci', cfgDir), false);
  expect(await until(() => tg.inboxCards().length === 3)).toBe(true);
  expect(await until(() => tg.edits().some((e) => e.id === olderCard.id && e.text.includes('↻ superseded by a newer request')))).toBe(true);
  expect((await new Response(older.stdout).text()).trim()).toBe('');
  expect(await until(() => Object.keys(inboxState(cfgDir).mirrors).length === 2)).toBe(true);
  expect(Object.keys(inboxState(cfgDir).mirrors).some((k) => k.includes('other-hook'))).toBe(true);
  expect(tg.deletes().some((d) => d.id === olderCard.id)).toBe(false);
}, 60_000);

test('NO TOPICS: without topics mode nothing is mirrored anywhere', async () => {
  const cfgDir = makeCfgDir(false);
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  startAsk(cfgDir, tg.port, QUESTION);
  expect(await until(() => tg.cards().length === 1)).toBe(true);
  // Several poll ticks: the safety-net sync runs every tick and must still post nothing. A
  // genuine wait — the daemon is a separate process and the thing proved is an absence.
  await Bun.sleep(600);
  expect(tg.mirrors()).toHaveLength(0);
  expect(tg.plain()).toHaveLength(0);
}, 60_000);

test('MIGRATION: reminders the old #403/#464 sweeps left are retired once, in their own chats, and the old state goes', async () => {
  const cfgDir = makeCfgDir();
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.questions.json'),
    JSON.stringify({
      v: 1,
      questions: [
        {
          req: { ...hatchAsk('d', 'ship-skip-ci', cfgDir), critical: true },
          messageId: 40,
          at: Date.now() - 60_000,
          criticalState: { lastReminderAt: Date.now() - 1000, lastReminderMessageId: 501, lastReminderChatId: -100777 },
        },
      ],
      answered: [],
    }),
  );
  const legacy = join(cfgDir, 'tg-ctl.123.unanswered-reminder.json');
  writeFileSync(legacy, JSON.stringify({ version: 1, firstSeen: {}, remindedKeys: [], messageId: 555, chatId: 7 }));
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  expect(await until(() => tg.deletes().some((d) => d.id === 501 && d.chat === -100777))).toBe(true);
  expect(await until(() => tg.deletes().some((d) => d.id === 555 && d.chat === 7))).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(await until(() => !readFileSync(join(cfgDir, 'tg-ctl.123.questions.json'), 'utf8').includes('criticalState'))).toBe(true);
  // The orphan card itself stays open — now listed in the Inbox instead of pinged.
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);

  // Idempotent: a restart finds nothing left to retire.
  daemon.kill('SIGTERM');
  await daemon.exited;
  const deletesBefore = tg.deletes().filter((d) => d.id === 501 || d.id === 555).length;
  await startDaemon(cfgDir, tg.port);
  expect(await until(() => daemonLog(cfgDir).split('questions restored').length >= 3)).toBe(true);
  expect(tg.deletes().filter((d) => d.id === 501 || d.id === 555)).toHaveLength(deletesBefore);
  expect(daemonLog(cfgDir).match(/reminder migration: retiring/g)).toHaveLength(2);
}, 60_000);

test('INBOX ONLY HOLDS CARDS: a stray message, a /status and a non-answer reply in the Inbox get their replies in General', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  await startDaemon(cfgDir, tg.port);

  startAsk(cfgDir, tg.port, PERMISSION);
  expect(await until(() => tg.mirrors().length === 1)).toBe(true);
  const mirror = tg.mirrors()[0];
  // Plain prose posted into the Inbox, a daemon command posted there, and a reply to the
  // permission copy that is no decision word.
  tg.inInbox('what is this topic', 960, 701);
  tg.inInbox('/status', 961, 702);
  tg.reply('maybe later', mirror.id, 962, 703, true);
  // Three replies, all in General: the Inbox notice for the stray message, the /status answer,
  // and the Inbox notice again for the reply that was no decision.
  expect(await until(() => tg.plain().filter((s) => s.text.includes('the Inbox topic only lists open questions')).length === 2)).toBe(true);
  expect(await until(() => tg.plain().length >= 3)).toBe(true);
  expect(tg.plain().every((s) => s.threadId === null)).toBe(true);
  // Every message ever sent into the Inbox thread is a card copy: card text + the ✕ Dismiss row.
  for (const s of tg.mirrors()) {
    expect(s.text.startsWith('📥 ')).toBe(true);
    expect(s.keyboard.at(-1)?.[0]?.text).toBe('✕ Dismiss');
  }
  expect(tg.mirrors()).toHaveLength(1);
  // And nothing created a topic binding for the Inbox thread.
  const topicsPath = join(cfgDir, 'tg-ctl.123.topics.json');
  if (existsSync(topicsPath)) {
    const bound = (JSON.parse(readFileSync(topicsPath, 'utf8')) as Array<{ threadId: number }>).map((t) => t.threadId);
    expect(bound).not.toContain(INBOX_THREAD);
  }
}, 60_000);
