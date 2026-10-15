import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// End-to-end forum-topic inbound triage (docs/specs/session-registry-and-topics.md §4.4): the
// real daemon, a fake Telegram server, and a fake tmux/ps reporting TWO claude
// panes — %1 (the flat/1:1 default target, pinned via registration) and %2 (a pre-seeded
// BOUND topic's pane). Every injected payload is logged as `<paneId>\t<text>` so a test can
// assert WHICH pane each message reached.
//
// The load-bearing guarantees under test:
//   1. With control.topics OFF, a plain (non-topic) message injects into the flat pane %1 —
//      1:1 routing is byte-identical (tg-ctl is the CTO's daily lifeline; this must not move).
//   2. With control.topics ON, a plain (General / no message_thread_id) message STILL injects
//      into the flat pane %1 — turning topics on does not change non-topic routing.
//   3. With control.topics ON, a message inside a BOUND topic injects into THAT topic's pane
//      (%2), never the flat target.
//   4. A topic whose bound session is GONE does NOT leak into the flat agent: the daemon answers
//      "not running — resume with …" in the topic (message_thread_id = T) and injects nothing.
//   5. An UNKNOWN topic holds its messages and posts the attach picker there; a pick delivers
//      the queue to the chosen session in order, exactly once, and binds the topic.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

const FLAT_PANE = '%1'; // pinned as the registration target → the flat/1:1 default
const FLAT_PID = 4241;
const TOPIC_PANE = '%2'; // the bound topic's agent pane
const TOPIC_PID = 4242;

// A fake tmux reporting TWO claude-hosting panes and logging every send-keys -l payload as
// `<paneId>\t<text>` to $injectLog. The pane id is captured from the `-t %N` flag in the same
// invocation. load-buffer/paste-buffer (multi-line) is unused here (all test texts are single
// line) so it is logged verbatim without a pane prefix — never hit in these cases.
function fakeTmux(cwd: string, injectLog: string, fleet = true): string {
  const panes = fleet
    ? `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${FLAT_PANE}' '${FLAT_PID}' 'claude' 'main' '${cwd}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${TOPIC_PANE}' '${TOPIC_PID}' 'claude' 'main' '${cwd}'`
    : ':';
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    ${panes}
    ;;
  display-message)
    printf 'main\\n'
    ;;
  send-keys)
    # Capture the -t <pane> target and, if this is a literal (-l) injection, log '<pane>\\t<text>'.
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer)
    cat >> '${injectLog}'
    printf '\\n' >> '${injectLog}'
    ;;
  rename-window)
    printf 'rename-window\\t%s\\n' "$*" >> '${injectLog}'
    ;;
esac
exit 0
`;
}

// ps -axo pid=,ppid=,command= → both pane pids run claude, so findAgentInPane resolves both.
function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${FLAT_PID}' '1' 'claude'
printf '%s %s %s\\n' '${TOPIC_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(opts: {
  topics: boolean;
  seedTopics?: unknown[] | ((cfgDir: string) => unknown[]);
  fleet?: boolean; // false → tmux lists no panes: no session is running
}): string {
  const cfgDir = tempDir('tgctl-topics-');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  topics: ${opts.topics}\n`);
  // registration pins %1 as the flat default target so discovery is deterministic.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: FLAT_PANE, cwd: cfgDir }),
  );
  if (opts.seedTopics) {
    const seeds = typeof opts.seedTopics === 'function' ? opts.seedTopics(cfgDir) : opts.seedTopics;
    writeFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify(seeds));
  }
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, injectLog, opts.fleet ?? true), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return cfgDir;
}

// Parsed inject log: { pane, text } per logged literal injection.
function injected(cfgDir: string): Array<{ pane: string; text: string }> {
  const p = join(cfgDir, 'inject.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab === -1 ? { pane: '', text: l } : { pane: l.slice(0, tab), text: l.slice(tab + 1) };
    });
}

function topicsStore(cfgDir: string): Array<Record<string, unknown>> {
  const p = join(cfgDir, 'tg-ctl.123.topics.json');
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
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
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

// A scripted Telegram server: getUpdates drains updateQueue one batch at a time; sendMessage
// and setMessageReaction bodies are captured so the test can assert message_thread_id threading
// and delivery receipts.
// Callback answers and message/topic edits are captured in `calls` as `{ method, ...body }`.
const CAPTURED_METHODS = ['answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup', 'editForumTopic'];

function makeServer(updateQueue: unknown[][]): {
  server: ReturnType<typeof Bun.serve>;
  sends: Array<Record<string, unknown>>;
  reactions: Array<Record<string, unknown>>;
  calls: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const reactions: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sends.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      const method = url.pathname.split('/').at(-1) ?? '';
      if (CAPTURED_METHODS.includes(method)) {
        calls.push({ method, ...((await req.json()) as Record<string, unknown>) });
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, sends, reactions, calls };
}

function attachTap(updateId: number, threadId: number, paneId: string, pickerMessageId: number): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      data: `tgt:${threadId}:${paneId}`,
      message: { message_id: pickerMessageId, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), message_thread_id: threadId },
    },
  };
}

function holdsStore(cfgDir: string): { holds: Array<Record<string, unknown>> } {
  const p = join(cfgDir, 'tg-ctl.123.topic-holds.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { holds: Array<Record<string, unknown>> }) : { holds: [] };
}

function plainMsg(messageId: number, text: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text },
  };
}

function topicMsg(messageId: number, threadId: number, text: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      text,
      message_thread_id: threadId,
      is_topic_message: true,
    },
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

test('topics OFF: a plain (non-topic) message injects into the flat %1 pane — 1:1 routing unchanged', async () => {
  const cfgDir = makeCfgDir({ topics: false });
  const updateQueue: unknown[][] = [];
  const { server, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([plainMsg(10, 'flat hello', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(FLAT_PANE);
  expect(landed[0].text).toContain('flat hello');
  // No topic store is ever written with the flag off.
  expect(existsSync(join(cfgDir, 'tg-ctl.123.topics.json'))).toBe(false);
  // It still earns its 👀 delivery receipt.
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 10 });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a plain (General / no thread) message STILL injects into the flat %1 pane', async () => {
  // Seed a bound topic on %2 to prove the General message is NOT mis-attracted to it.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([plainMsg(11, 'general msg', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(FLAT_PANE); // flat, NOT the topic pane %2
  expect(landed[0].text).toContain('general msg');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a message in a BOUND topic injects into THAT topic pane (%2), not the flat target', async () => {
  // The binding records the same path the fake tmux reports for %2 (cfgDir), so the pane-reuse
  // guard (path-match) passes and the message routes.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: (dir) => [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, path: dir, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(12, 50, 'deploy now', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(TOPIC_PANE); // routed to the topic's pane, NOT %1
  expect(landed[0].text).toContain('deploy now');
  expect(landed[0].text).toContain('[TG from Alex'); // wrapped like a normal inbound
  // Its 👀 receipt targets the source message inside the topic.
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 12 });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: daemon slash commands in a BOUND topic reply inside that topic, not General', async () => {
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: (dir) => [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, path: dir, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(16, 50, '/status', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text ?? '').includes('tg-ctl: running')));
  expect(injected(cfgDir)).toEqual([]);
  const statusReplies = sends.filter((s) => String(s.text ?? '').includes('tg-ctl: running'));
  expect(statusReplies.length).toBeGreaterThan(0);
  expect(statusReplies.every((s) => s.message_thread_id === 50)).toBe(true);
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 16 });

  updateQueue.push([topicMsg(17, 50, '/limit codex', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text ?? '').includes('No recent limit telemetry for codex')));
  expect(injected(cfgDir)).toEqual([]);
  const limitReplies = sends.filter((s) => String(s.text ?? '').includes('No recent limit telemetry for codex'));
  expect(limitReplies.length).toBeGreaterThan(0);
  expect(limitReplies.every((s) => s.message_thread_id === 50)).toBe(true);
  await waitFor(() => reactions.length >= 2);
  expect(reactions.at(-1)).toMatchObject({ message_id: 17 });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a REUSED pane (binding path != live pane path) does NOT leak — message refused, binding NOT closed', async () => {
  // The bound pane %2 still hosts an agent in the fake tmux, but its path is cfgDir while the
  // binding recorded a DIFFERENT project path. tmux reuses pane ids after kill-pane, so this
  // models another project's agent inheriting %2. The path-match guard must refuse to inject (no
  // leak into the stranger). It must NOT close the binding — a path mismatch can also be a
  // transient empty-path read or a legit `cd`, so closing would irreversibly kill a live topic.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, path: '/some/other/project', ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(17, 50, 'deploy now', nowSec)]);

  await waitFor(() => sends.length >= 1);
  expect(injected(cfgDir)).toEqual([]); // refused — NOT injected into %2 (the reused stranger) NOR %1
  expect(sends[0].message_thread_id).toBe(50); // notice threaded into the topic
  await Bun.sleep(300);
  // The binding is left BOUND (recoverable) — a transient/cd self-heals on the next message; a
  // true reuse keeps failing the same harmless way. NOT irreversibly closed.
  expect(topicsStore(cfgDir).find((t) => t.threadId === 50)?.status).toBe('bound');
  expect(reactions).toEqual([]); // a refused route earns no 👀

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a BOUND topic whose session is GONE answers "not running" in the topic — no leak, no spawn, binding closed', async () => {
  // %9 is not in the fake tmux pane list → the bound session is gone.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: '%9', harness: 'omp', ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(13, 50, 'are you there?', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text).includes('not running')));
  const reply = sends.find((s) => String(s.text).includes('not running'));
  expect(reply).toMatchObject({ message_thread_id: 50, text: '`api` is not running — resume with `rig omp run --resume …`' });
  expect(injected(cfgDir)).toEqual([]); // nothing reached the flat %1 agent (or anywhere)
  expect(topicsStore(cfgDir).find((t) => t.threadId === 50)?.status).toBe('closed');
  // A second message to the gone topic gets the same answer — never silence, never a picker.
  updateQueue.push([topicMsg(14, 50, 'hello?', nowSec)]);
  await waitFor(() => sends.filter((s) => String(s.text).includes('not running')).length >= 2);
  expect(sends.some((s) => s.reply_markup !== undefined)).toBe(false);
  // An undelivered message earns no 👀 receipt.
  await Bun.sleep(300);
  expect(reactions).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// tg-cli#709: a REPLY to one of a gone session's reports is aimed at that report, so it is not
// left at "not running": like a flat-chat reply to a gone origin it gets the agent picker —
// posted inside the topic — and nothing is typed anywhere until the human picks.
test('topics ON: a REPLY in a BOUND topic whose session is GONE gets the agent picker in that topic, not "not running"', async () => {
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: '%9', harness: 'omp', ts: 1 }],
  });
  const nowSec = Math.floor(Date.now() / 1000);
  // The gone session's report the CTO replies to.
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 700, paneId: '%9', cwd: cfgDir, ts: nowSec - 60 }]));
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const reply = topicMsg(15, 50, 'what did you find?', nowSec) as { message: Record<string, unknown> };
  reply.message.reply_to_message = { message_id: 700, from: { id: 9, first_name: 'bot', is_bot: true }, chat: { id: 1 }, date: nowSec - 60, text: 'report', message_thread_id: 50 };
  updateQueue.push([reply]);

  await waitFor(() => sends.some((s) => s.reply_markup !== undefined));
  const picker = sends.find((s) => s.reply_markup !== undefined);
  expect(picker).toMatchObject({ message_thread_id: 50 });
  expect(String(picker?.text)).toContain('is no longer running');
  expect(sends.some((s) => String(s.text).includes('resume with'))).toBe(false);
  expect(injected(cfgDir)).toEqual([]);
  expect(readFileSync(join(cfgDir, 'daemon.log'), 'utf8')).toContain('warning: topic 50: reply to tg#700 reached a gone session');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: an UNKNOWN topic holds messages + posts the attach picker once; a pick delivers them in order, once, and binds the topic', async () => {
  const cfgDir = makeCfgDir({ topics: true }); // no bindings: topic 77 is unknown (user-created / implicit)
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions, calls } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 77, 'first held', nowSec), topicMsg(16, 77, 'second held', nowSec)]);

  await waitFor(() => holdsStore(cfgDir).holds.some((h) => (h.payloads as unknown[]).length === 2 && h.pickerMessageId !== null));
  const pickers = sends.filter((s) => s.reply_markup !== undefined);
  expect(pickers).toHaveLength(1); // posted once per hold, not per message
  expect(pickers[0].message_thread_id).toBe(77);
  const buttons = (pickers[0].reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat();
  expect(buttons.map((b) => b.callback_data).sort()).toEqual(['tgt:77:%1', 'tgt:77:%2']);
  expect(injected(cfgDir)).toEqual([]); // held, not delivered anywhere yet
  await waitFor(() => reactions.length >= 2);
  expect(reactions.map((r) => (r.reaction as Array<{ emoji: string }>)[0].emoji)).toEqual(['✍️', '✍️']);

  // Pick %2 — twice (a double tap). The queue is delivered exactly once, in order.
  const pickerId = holdsStore(cfgDir).holds[0].pickerMessageId as number;
  updateQueue.push([attachTap(17, 77, TOPIC_PANE, pickerId), attachTap(18, 77, TOPIC_PANE, pickerId)]);
  await waitFor(() => injected(cfgDir).length >= 2 && calls.filter((c) => c.method === 'answerCallbackQuery').length >= 2);
  await Bun.sleep(300);
  expect(injected(cfgDir)).toEqual([
    { pane: TOPIC_PANE, text: '[TG from Alex tg#15] first held' },
    { pane: TOPIC_PANE, text: '[TG from Alex tg#16] second held' },
  ]);
  expect(calls.some((c) => c.method === 'answerCallbackQuery' && String(c.text).startsWith('expired'))).toBe(true);
  expect(holdsStore(cfgDir).holds).toEqual([]);
  // %2 had no topic → topic 77 becomes its topic, renamed to the session's title.
  expect(topicsStore(cfgDir).find((t) => t.threadId === 77)).toMatchObject({ status: 'bound', paneId: TOPIC_PANE, harness: 'claude' });
  expect(calls.find((c) => c.method === 'editForumTopic')).toMatchObject({ message_thread_id: 77 });
  expect(sends.some((s) => s.message_thread_id === 77 && String(s.text).startsWith('this topic is now'))).toBe(true);

  // A later message in the now-bound topic routes straight to %2 — no second picker.
  updateQueue.push([topicMsg(19, 77, 'direct now', nowSec)]);
  await waitFor(() => injected(cfgDir).length >= 3);
  expect(injected(cfgDir)[2]).toEqual({ pane: TOPIC_PANE, text: '[TG from Alex tg#19] direct now' });
  expect(sends.filter((s) => s.reply_markup !== undefined)).toHaveLength(1);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a message right after a pick in the SAME batch routes to the just-bound session — no second picker', async () => {
  const cfgDir = makeCfgDir({ topics: true });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 77, 'held', nowSec)]);
  await waitFor(() => holdsStore(cfgDir).holds.some((h) => h.pickerMessageId !== null));
  const pickerId = holdsStore(cfgDir).holds[0].pickerMessageId as number;

  // Tap, then type before the next poll: both land in one getUpdates batch, triaged up front
  // while topic 77 was still unknown.
  updateQueue.push([attachTap(16, 77, TOPIC_PANE, pickerId), topicMsg(17, 77, 'typed after tap', nowSec)]);
  await waitFor(() => injected(cfgDir).length >= 2);
  expect(injected(cfgDir)).toEqual([
    { pane: TOPIC_PANE, text: '[TG from Alex tg#15] held' },
    { pane: TOPIC_PANE, text: '[TG from Alex tg#17] typed after tap' },
  ]);
  expect(sends.filter((s) => s.reply_markup !== undefined)).toHaveLength(1);
  expect(holdsStore(cfgDir).holds).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a tap on a session that has since exited retires that picker — the next message posts a fresh one', async () => {
  const cfgDir = makeCfgDir({ topics: true });
  const updateQueue: unknown[][] = [];
  const { server, sends, calls } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 77, 'held', nowSec)]);
  await waitFor(() => holdsStore(cfgDir).holds.some((h) => h.pickerMessageId !== null));
  const pickerId = holdsStore(cfgDir).holds[0].pickerMessageId as number;

  // %9 is not in the fake tmux fleet: the button's session exited after the picker was posted.
  updateQueue.push([attachTap(16, 77, '%9', pickerId)]);
  await waitFor(() => holdsStore(cfgDir).holds.some((h) => h.pickerMessageId === null));
  expect(calls.some((c) => c.method === 'answerCallbackQuery' && String(c.text).includes('no longer running'))).toBe(true);

  updateQueue.push([topicMsg(17, 77, 'still waiting', nowSec)]);
  await waitFor(() => sends.filter((s) => s.reply_markup !== undefined).length >= 2);
  expect(sends.filter((s) => s.reply_markup !== undefined)).toHaveLength(2);
  expect(holdsStore(cfgDir).holds[0].payloads as unknown[]).toHaveLength(2);
  expect(injected(cfgDir)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a pick onto a session that ALREADY has a topic delivers there but leaves this topic unbound', async () => {
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, calls } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(20, 77, 'for api', nowSec)]);
  await waitFor(() => holdsStore(cfgDir).holds.some((h) => h.pickerMessageId !== null));
  updateQueue.push([attachTap(21, 77, TOPIC_PANE, holdsStore(cfgDir).holds[0].pickerMessageId as number)]);

  await waitFor(() => sends.some((s) => String(s.text).includes('already has its own topic')));
  expect(injected(cfgDir)).toEqual([{ pane: TOPIC_PANE, text: '[TG from Alex tg#20] for api' }]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 77)).toBeUndefined();
  expect(topicsStore(cfgDir).find((t) => t.threadId === 50)?.paneId).toBe(TOPIC_PANE);
  expect(calls.some((c) => c.method === 'editForumTopic')).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: held messages survive a daemon restart — a restored hold is delivered on a pick, an expired one answered', async () => {
  const cfgDir = makeCfgDir({ topics: true });
  const nowSec = Math.floor(Date.now() / 1000);
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topic-holds.json'),
    JSON.stringify({
      version: 1,
      holds: [
        { threadId: 77, firstAt: nowSec - 60, pickerMessageId: 500, payloads: [{ type: 'text', text: '[TG from Alex #30] kept', from: 'Alex', messageId: 30 }] },
        {
          threadId: 88,
          firstAt: nowSec - 700,
          pickerMessageId: 501,
          payloads: [
            { type: 'text', text: 'a', from: 'Alex', messageId: 31 },
            { type: 'text', text: 'b', from: 'Alex', messageId: 32 },
          ],
        },
      ],
    }),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends, calls } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  // The hold that expired while the daemon was down still gets its reply, in its topic.
  await waitFor(() => sends.some((s) => s.message_thread_id === 88));
  expect(sends.find((s) => s.message_thread_id === 88)?.text).toBe('2 messages not delivered — send again to reach a session');
  expect(calls.some((c) => c.method === 'editMessageReplyMarkup' && c.message_id === 501)).toBe(true);
  expect(holdsStore(cfgDir).holds.map((h) => h.threadId)).toEqual([77]);

  updateQueue.push([attachTap(40, 77, FLAT_PANE, 500)]);
  await waitFor(() => injected(cfgDir).length >= 1);
  expect(injected(cfgDir)).toEqual([{ pane: FLAT_PANE, text: '[TG from Alex #30] kept' }]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: /status in an UNKNOWN topic is answered in that topic (daemon verbs work in any topic)', async () => {
  const cfgDir = makeCfgDir({ topics: true });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  updateQueue.push([topicMsg(50, 77, '/status', Math.floor(Date.now() / 1000))]);
  await waitFor(() => sends.length >= 1);
  expect(sends[0].message_thread_id).toBe(77);
  expect(sends.some((s) => s.reply_markup !== undefined)).toBe(false); // a verb is not held
  expect(holdsStore(cfgDir).holds).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: forum topic service messages are recorded only — no spawn, no binding change, nothing sent', async () => {
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, calls } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  const service = (id: number, thread: number, extra: Record<string, unknown>): unknown => ({
    update_id: id,
    message: { message_id: id, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, message_thread_id: thread, ...extra },
  });
  updateQueue.push([
    service(60, 90, { forum_topic_created: { name: 'New Topic' } }),
    service(61, 50, { forum_topic_edited: { name: 'renamed by user' } }),
    service(62, 50, { forum_topic_closed: {} }),
    service(63, 50, { forum_topic_reopened: {} }),
  ]);
  await waitFor(() => readFileSync(join(cfgDir, 'daemon.log'), 'utf8').includes('topic 50: reopened'));
  expect(sends).toEqual([]);
  // A topic rename by the user (or the echo of the bot's own editForumTopic) reaches neither tmux
  // (no rename-window) nor Telegram (no editForumTopic back): no rename loop (#466).
  expect(injected(cfgDir)).toEqual([]);
  expect(calls.filter((c) => c.method === 'editForumTopic')).toEqual([]);
  expect(topicsStore(cfgDir)).toEqual([{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: `/agent <gone>` inside a BOUND topic does NOT fall back to the flat last-user-target anchor', async () => {
  // The flat 1:1 anchor points at %1 (an earlier flat conversation), but the CTO
  // is typing inside topic 50, bound to %2 — a DIFFERENT project's pane. The flat
  // anchor must never override the topic's own (stronger, deliberately chosen)
  // routing signal; see tg-ctl's handleAgentRoute gone-agent fallback comment.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.last-user-target.json'),
    JSON.stringify({ paneId: FLAT_PANE, cwd: cfgDir, ts: Math.floor(Date.now() / 1000) }),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(18, 50, '/agent ghost do this', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text ?? '').includes("no agent matching 'ghost'")));
  // Never injected into the flat anchor pane (%1) — the topic guard held.
  expect(injected(cfgDir).some((l) => l.pane === FLAT_PANE)).toBe(false);
  expect(injected(cfgDir)).toEqual([]);
  const errorReplies = sends.filter((s) => String(s.text ?? '').includes("no agent matching 'ghost'"));
  expect(errorReplies.every((s) => s.message_thread_id === 50)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: two topics picking the SAME session concurrently — one binds, the other stays unlinked, nothing is lost', async () => {
  const cfgDir = makeCfgDir({ topics: true });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 77, 'from 77', nowSec), topicMsg(16, 78, 'from 78', nowSec)]);
  await waitFor(() => holdsStore(cfgDir).holds.filter((h) => h.pickerMessageId !== null).length === 2);
  const pickerOf = (t: number) => holdsStore(cfgDir).holds.find((h) => h.threadId === t)?.pickerMessageId as number;
  // Both taps land in one batch: different threads, so the dispatcher runs them concurrently.
  updateQueue.push([attachTap(17, 77, TOPIC_PANE, pickerOf(77)), attachTap(18, 78, TOPIC_PANE, pickerOf(78))]);

  await waitFor(() => injected(cfgDir).length >= 2 && sends.some((s) => String(s.text).includes('already has its own topic')));
  expect(injected(cfgDir).map((l) => l.text).sort()).toEqual(['[TG from Alex tg#15] from 77', '[TG from Alex tg#16] from 78']);
  const bindings = topicsStore(cfgDir).filter((t) => t.paneId === TOPIC_PANE);
  expect(bindings).toHaveLength(1); // a session has at most one topic
  expect(bindings[0].status).toBe('bound');
  const loser = bindings[0].threadId === 77 ? 78 : 77;
  expect(sends.some((s) => s.message_thread_id === loser && String(s.text).includes('already has its own topic'))).toBe(true);
  expect(holdsStore(cfgDir).holds).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a leftover awaiting-model binding (spawn never finished) drops on the next message — the attach picker appears, not "still starting"', async () => {
  // A crash-gap row reconcile could not adopt: no `web` window exists.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: (dir) => [
      { threadId: 60, name: 'web', status: 'awaiting-model', path: dir, model: 'claude-opus', harness: 'claude', spawnPending: true, spawnToken: '60-1-1', ts: 1 },
    ],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 60, 'hello?', nowSec)]);
  await waitFor(() => sends.some((s) => s.reply_markup !== undefined));
  expect(sends.some((s) => String(s.text).includes('still starting'))).toBe(false);
  expect(sends.find((s) => s.reply_markup !== undefined)?.message_thread_id).toBe(60);
  expect(holdsStore(cfgDir).holds.map((h) => h.threadId)).toEqual([60]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 60)).toBeUndefined();
  expect(injected(cfgDir)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: with no session running, the "no session" notice is posted once per hold, not once per message', async () => {
  const cfgDir = makeCfgDir({ topics: true, fleet: false });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 77, 'one', nowSec)]);
  await waitFor(() => sends.some((s) => String(s.text).includes('no session is running')));
  updateQueue.push([topicMsg(16, 77, 'two', nowSec), topicMsg(17, 77, 'three', nowSec)]);
  await waitFor(() => (holdsStore(cfgDir).holds[0]?.payloads as unknown[] | undefined)?.length === 3);
  // An ABSENT second notice has no event to await; give a stray send time to land.
  await Bun.sleep(300);
  expect(sends.filter((s) => String(s.text).includes('no session is running'))).toHaveLength(1);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: past the hold cap a new topic evicts the OLDEST hold and answers there — the newest is kept', async () => {
  const cfgDir = makeCfgDir({ topics: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const seeded = Array.from({ length: 200 }, (_, i) => ({
    threadId: 1000 + i,
    firstAt: nowSec - 60 + i,
    pickerMessageId: 5000 + i,
    payloads: [{ type: 'text', text: `held ${i}`, from: 'Alex', messageId: 3000 + i }],
  }));
  writeFileSync(join(cfgDir, 'tg-ctl.123.topic-holds.json'), JSON.stringify({ version: 1, holds: seeded }));
  const updateQueue: unknown[][] = [];
  const { server, sends, calls } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  updateQueue.push([topicMsg(15, 77, 'newest', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 1000));
  expect(sends.find((s) => s.message_thread_id === 1000)?.text).toBe('1 message not delivered — send again to reach a session');
  expect(calls.some((c) => c.method === 'editMessageReplyMarkup' && c.message_id === 5000)).toBe(true);
  await waitFor(() => holdsStore(cfgDir).holds.some((h) => h.threadId === 77));
  const threads = holdsStore(cfgDir).holds.map((h) => h.threadId);
  expect(threads).toHaveLength(200);
  expect(threads).toContain(77);
  expect(threads).not.toContain(1000);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);
