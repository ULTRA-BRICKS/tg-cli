import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// End-to-end forum-topics SPAWN-ON-CREATE (docs/specs/tg-forum-topics.md §5, §9 increment 2):
// the real daemon, a fake Telegram server, and a fake tmux/ps. On `forum_topic_created` the
// daemon starts the /new flow (ask path → ask model via buttons → `tmux new-window` spawn →
// bind the returned pane). The fake tmux's `new-window` returns a pane id and LOGS its full
// argv so a test can assert the spawn shape (model argv, -c <path>, -n <slug>).
//
// The load-bearing guarantees (this is the CTO's daily lifeline daemon — none may regress):
//   1. A valid create → path → model-tap SPAWNS exactly one agent and binds the topic, with the
//      window name = the topic-name slug and the model's argv (`claude --model opus`).
//   2. A malformed path posts an error into the topic and does NOT spawn (no garbage agent).
//   3. A spawn FAILURE (tmux new-window exits non-zero) is caught: an error posts into the topic,
//      the binding stays awaiting-model (retryable), and the daemon keeps polling (next msg works).
//   4. A DUPLICATE forum_topic_created for an already-bound topic does NOT double-spawn.
//   5. With control.topics OFF, a forum_topic_created is ignored entirely — no binding, no spawn
//      (1:1 behaviour byte-identical).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

const SPAWNED_PANE = '%7'; // the pane id the fake tmux new-window returns

// A fake tmux that:
//  - list-panes: reports ONE pre-existing claude pane (%1, the flat default) so sessionForSpawn
//    has a session to target and discovery is happy.
//  - new-window: prints the SPAWNED_PANE id (the -P -F '#{pane_id}' contract) and logs the full
//    argv to $spawnLog so the test asserts the model argv + -c <path> + -n <slug>. When
//    $failSpawn exists it exits 1 (models a spawn failure) and prints an error to stderr.
//  - send-keys -l: logs '<pane>\t<text>' to $injectLog (a later message reaches the spawned pane).
function fakeTmux(cwd: string, spawnLog: string, injectLog: string, failFlag: string): string {
  // STATEFUL: a `set-option -w @tg_spawn_token <val>` writes <val> to a sidecar file (<spawnLog>.tok)
  // and list-panes reports it as the SPAWNED pane's @tg_spawn_token field (8-field row) — so the
  // token round-trip is actually exercised, not faked away (codex r19 P2).
  const tokFile = `${spawnLog}.tok`;
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    ${''}# %1 (flat) carries an empty token field; the spawned pane reports the recorded token (if any).
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    if [ -f '${spawnLog}' ]; then
      tok=''
      [ -f '${tokFile}' ] && tok=$(cat '${tokFile}')
      printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${SPAWNED_PANE}' '4277' 'claude' 'topicslug' "$tok" '${cwd}'
    fi
    ;;
  display-message)
    printf 'main\\n'
    ;;
  new-window)
    if [ -f '${failFlag}' ]; then
      echo 'no current session' >&2
      exit 1
    fi
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option)
    ${''}# tmux set-option -w -t <pane> @tg_spawn_token <value> — record the value for list-panes.
    val=''
    while [ $# -gt 0 ]; do
      if [ "$1" = '@tg_spawn_token' ]; then val="$2"; fi
      shift
    done
    printf '%s' "$val" > '${tokFile}'
    ;;
  send-keys)
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
esac
exit 0
`;
}

function fakePs(): string {
  // Both the flat pane (4241) and the spawned pane (4277) run claude.
  return `#!/bin/sh
printf '%s %s %s\\n' '4241' '1' 'claude'
printf '%s %s %s\\n' '4277' '1' 'claude'
exit 0
`;
}

interface CfgPaths {
  cfgDir: string;
  spawnLog: string;
  injectLog: string;
  failFlag: string;
}

function makeCfgDir(opts: { topics: boolean; seedTopics?: unknown[] }): CfgPaths {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-spawn-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  const failFlag = join(cfgDir, 'FAIL_SPAWN');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    `control:\n  enabled: true\n  topics: ${opts.topics}\n  private_topics: false\n`,
  );
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  if (opts.seedTopics) writeFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify(opts.seedTopics));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog, injectLog, failFlag), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return { cfgDir, spawnLog, injectLog, failFlag };
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

function spawnArgvLog(spawnLog: string): string[] {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

async function startDaemon(paths: CfgPaths, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(paths.cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: paths.cfgDir,
    env: {
      PATH: `${join(paths.cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: paths.cfgDir,
      TG_CTL_CONFIG_DIR: paths.cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(paths.cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

// A scripted Telegram server. updateQueue is drained one batch per getUpdates poll;
// sendMessage / answerCallbackQuery / editMessageReplyMarkup bodies are captured for assertions.
function makeServer(updateQueue: unknown[][]): {
  server: ReturnType<typeof Bun.serve>;
  sends: Array<Record<string, unknown>>;
  callbackAnswers: Array<Record<string, unknown>>;
  keyboardEdits: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const callbackAnswers: Array<Record<string, unknown>> = [];
  const keyboardEdits: Array<Record<string, unknown>> = [];
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
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        callbackAnswers.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) {
        keyboardEdits.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, sends, callbackAnswers, keyboardEdits };
}

function pathTap(updateId: number, threadId: number, index: number, nonce: number): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: updateId, chat: { id: 1 }, date: 0 },
      data: `tgp:${threadId}:${index}:${nonce}`,
    },
  };
}

function respawnTap(updateId: number, threadId: number): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: updateId, chat: { id: 1 }, date: 0 },
      data: `tgr:${threadId}`,
    },
  };
}

function topicCreated(messageId: number, threadId: number, name: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      message_thread_id: threadId,
      forum_topic_created: { name },
    },
  };
}

function topicTextMsg(messageId: number, threadId: number, text: string, nowSec: number): unknown {
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

function modelTap(updateId: number, threadId: number, modelId: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: updateId, chat: { id: 1 }, date: 0 },
      data: `tgm:${threadId}:${modelId}`,
    },
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

test('topics ON: create → path → model tap SPAWNS one agent, binds the topic, window=slug, model argv', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // 1) topic created → daemon asks for the path
  updateQueue.push([topicCreated(20, 88, 'API bot', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 88 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 88)?.status).toBe('awaiting-path');

  // 2) user sends the working dir (cfgDir exists + is a dir) → advance to awaiting-model
  updateQueue.push([topicTextMsg(21, 88, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 88 && t.status === 'awaiting-model'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 88)?.path).toBe(cfgDir);

  // 3) user taps the Opus button → spawn + bind
  updateQueue.push([modelTap(22, 88, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 88 && t.status === 'bound'));

  const binding = topicsStore(cfgDir).find((t) => t.threadId === 88);
  expect(binding?.status).toBe('bound');
  expect(binding?.paneId).toBe(SPAWNED_PANE);
  expect(binding?.model).toBe('claude-opus');

  // The spawn ran exactly once, with the model argv, the topic-name slug, -c <path>, and the
  // TG_TOPIC env (so the agent's plain `tg` threads back into THIS topic — codex r8 #1).
  const spawns = spawnArgvLog(paths.spawnLog);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toContain('claude --model opus');
  expect(spawns[0]).toContain('-c ' + cfgDir);
  expect(spawns[0]).toContain('-n api-bot'); // slugifyTopicName('API bot')
  expect(spawns[0]).toContain('-e TG_TOPIC=88'); // threadId stamped into the new window's env

  // The per-spawn token was actually STAMPED on the window via `set-option` (codex r19 P2): the
  // stateful fake recorded it, and it has the real `<threadId>-<unixSec>-<nonce>` shape.
  const tokFile = paths.spawnLog + '.tok';
  expect(existsSync(tokFile)).toBe(true);
  expect(readFileSync(tokFile, 'utf8')).toMatch(/^88-\d+-\d+$/);

  // A confirmation posted into the topic (threaded).
  await waitFor(() => sends.some((s) => s.message_thread_id === 88 && String(s.text).includes('spawned')));
  expect(sends.some((s) => s.message_thread_id === 88 && String(s.text).includes('spawned'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a malformed path posts an error and does NOT spawn; daemon survives', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(30, 90, 'broken', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 90 && t.status === 'awaiting-path'));

  // An absolute path that does not exist → re-asked, no advance, no spawn.
  updateQueue.push([topicTextMsg(31, 90, '/no/such/dir/at/all', nowSec + 1)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 90 && String(s.text).includes('existing directory')));
  expect(sends.some((s) => s.message_thread_id === 90 && String(s.text).includes('existing directory'))).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 90)?.status).toBe('awaiting-path'); // NOT advanced
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // nothing spawned

  // The daemon is still alive and polling — a valid path now advances it.
  updateQueue.push([topicTextMsg(32, 90, cfgDir, nowSec + 2)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 90 && t.status === 'awaiting-model'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 90)?.status).toBe('awaiting-model');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a spawn FAILURE is caught — error into the topic, binding stays awaiting-model, daemon keeps polling', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  // Arm the spawn-failure flag: tmux new-window will exit 1.
  writeFileSync(paths.failFlag, '1');
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(40, 91, 'fails', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 91 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(41, 91, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 91 && t.status === 'awaiting-model'));

  // Tap a model → the spawn fails; the daemon must NOT crash.
  updateQueue.push([modelTap(42, 91, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 91 && String(s.text).includes("couldn't start")));
  expect(sends.some((s) => s.message_thread_id === 91 && String(s.text).includes("couldn't start"))).toBe(true);
  // The binding stays awaiting-model (retryable) — never half-bound.
  await Bun.sleep(200);
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 91);
  expect(binding?.status).toBe('awaiting-model');
  expect(binding?.paneId).toBeUndefined();

  // CRITICAL: the daemon is still polling — a fresh topic-created is still handled.
  updateQueue.push([topicCreated(43, 92, 'survives', nowSec + 2)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 92 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 92)?.status).toBe('awaiting-path');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a DUPLICATE forum_topic_created for an already-bound topic does NOT double-spawn', async () => {
  // Seed the topic ALREADY bound, then send a duplicate create. stepUpdates filters it
  // (bound → no topic-new), so the entrypoint never re-spawns and the live pane is kept.
  const paths = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 93, name: 'api', status: 'bound', paneId: SPAWNED_PANE, ts: 1 }],
  });
  const { cfgDir } = paths;
  // The spawn log must show the pane as live for list-panes, so pre-create it empty? No —
  // a bound seed needs no spawn log. Touch it so the fake tmux reports the spawned pane.
  writeFileSync(paths.spawnLog, '');
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(50, 93, 'api', nowSec)]);
  // Give the daemon time to process the (ignored) duplicate.
  await Bun.sleep(600);

  // Still bound to the SAME pane; no new-window argv was logged (spawn log unchanged/empty).
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 93);
  expect(binding?.status).toBe('bound');
  expect(binding?.paneId).toBe(SPAWNED_PANE);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // no new-window ran

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

function injected(injectLog: string): Array<{ pane: string; text: string }> {
  if (!existsSync(injectLog)) return [];
  return readFileSync(injectLog, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab === -1 ? { pane: '', text: l } : { pane: l.slice(0, tab), text: l.slice(tab + 1) };
    });
}

test('topics ON: a DUPLICATE model tap does NOT double-spawn — second tap gets "already running", one new-window', async () => {
  // The central code claim ("a late/duplicate tap can't launch a second agent"). Drive the real
  // flow to bound, then tap the model button AGAIN: the bound-guard must refuse it with no spawn.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(70, 95, 'dup', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 95 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(71, 95, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 95 && t.status === 'awaiting-model'));
  updateQueue.push([modelTap(72, 95, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 95 && t.status === 'bound'));
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1); // one spawn so far
  // Wait for the spawn CONFIRMATION send too (it lands AFTER the store flips to bound — the bind
  // persists, then editMessageReplyMarkup clears the keyboard, then the confirmation posts), so the
  // snapshot below isn't taken mid-flight and miscount the duplicate-tap delta.
  await waitFor(() => sends.some((s) => s.message_thread_id === 95 && String(s.text).includes('spawned')));
  await Bun.sleep(100);
  const sendsAfterBind = sends.length;

  // The DUPLICATE tap (e.g. the human taps twice, or a stale message) → refused, no second spawn.
  // The bound-guard answers ONLY the transient callback toast — NOT a fresh topic message — so a
  // multi-tap can't flood the topic.
  updateQueue.push([modelTap(73, 95, 'claude-opus')]);
  await waitFor(() => callbackAnswers.some((c) => String(c.text).includes('already running')));
  expect(callbackAnswers.some((c) => String(c.text).includes('already running'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1); // STILL one — no double-spawn
  expect(topicsStore(cfgDir).find((t) => t.threadId === 95)?.paneId).toBe(SPAWNED_PANE); // same pane
  expect(sends.length).toBe(sendsAfterBind); // no extra topic message — toast only, no spam

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: spawn → bind → ROUTE — a follow-up message in the topic reaches the spawned pane', async () => {
  // The end-to-end seam: after a spawn binds %7, a normal topic message must inject into %7 (the
  // new agent), NOT the flat %1. Proves spawn-on-create ties into the #54 per-topic routing.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(80, 96, 'route', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 96 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(81, 96, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 96 && t.status === 'awaiting-model'));
  updateQueue.push([modelTap(82, 96, 'claude-default')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 96 && t.status === 'bound'));

  // Now a real message inside the topic → must route to the SPAWNED pane (%7).
  updateQueue.push([topicTextMsg(83, 96, 'hello new agent', nowSec + 2)]);
  await waitFor(() => injected(paths.injectLog).some((i) => i.pane === SPAWNED_PANE));
  const landed = injected(paths.injectLog).filter((i) => i.text.includes('hello new agent'));
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(SPAWNED_PANE); // the spawned agent, NOT the flat %1
  expect(landed[0].text).toContain('[TG from Alex'); // wrapped like a normal inbound

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics OFF: a forum_topic_created is ignored — no binding, no spawn (1:1 unchanged)', async () => {
  const paths = makeCfgDir({ topics: false });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(60, 94, 'ignored', nowSec)]);
  await Bun.sleep(600);

  // No topic store written, nothing spawned — the flag-off path never touches topics.
  expect(existsSync(join(cfgDir, 'tg-ctl.123.topics.json'))).toBe(false);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a FORGED/unknown modelId tap on an awaiting-model topic → "unknown model", no spawn, binding intact', async () => {
  // The only real path to handleTopicModel's unknown-model guard is a stale/forged callback (the
  // keyboard emits only valid ids). Drive to awaiting-model, then tap a bogus model id.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(100, 97, 'forged', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 97 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(101, 97, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 97 && t.status === 'awaiting-model'));

  updateQueue.push([modelTap(102, 97, 'bogus-model')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 97 && String(s.text).includes('unknown model')));
  expect(sends.some((s) => s.message_thread_id === 97 && String(s.text).includes('unknown model'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // nothing spawned
  // The binding stays awaiting-model with NO model recorded (a bad id never persisted) — retryable.
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 97);
  expect(binding?.status).toBe('awaiting-model');
  expect(binding?.model).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a model tap with NO binding → "not in setup", no spawn', async () => {
  // A stale tgm: tap into a topic the daemon has no binding for (e.g. created before the bot, or
  // the store was reset). Must refuse cleanly, never spawn.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  updateQueue.push([modelTap(110, 98, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 98 && String(s.text).includes("isn't in setup")));
  expect(sends.some((s) => s.message_thread_id === 98 && String(s.text).includes("isn't in setup"))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 98)).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a RELATIVE path is rejected (validation vs tmux -c resolve against different cwds)', async () => {
  // statSync resolves a relative path against the daemon cwd; tmux -c resolves it against the tmux
  // server cwd. They can differ → an absolute path is required so both see the same dir.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(130, 101, 'rel', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 101 && t.status === 'awaiting-path'));
  // `bin` exists under cfgDir (a relative path would resolve there from the daemon cwd) — but it
  // is not absolute, so it must be rejected regardless.
  updateQueue.push([topicTextMsg(131, 101, 'bin', nowSec + 1)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 101 && String(s.text).includes('absolute path')));
  expect(sends.some((s) => s.message_thread_id === 101 && String(s.text).includes('absolute path'))).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 101)?.status).toBe('awaiting-path'); // not advanced
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a TEXT message in awaiting-model re-shows the model buttons, does not spawn', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(140, 102, 'retext', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 102 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(141, 102, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 102 && t.status === 'awaiting-model'));
  const sendsBefore = sends.length;

  // Stray prose instead of a button tap → the daemon re-posts the model prompt (with buttons).
  updateQueue.push([topicTextMsg(142, 102, 'opus please', nowSec + 2)]);
  await waitFor(
    () =>
      sends.length > sendsBefore &&
      sends.some((s) => s.message_thread_id === 102 && (s.reply_markup as Record<string, unknown> | undefined) !== undefined),
  );
  expect(sends.some((s) => s.message_thread_id === 102 && (s.reply_markup as Record<string, unknown> | undefined) !== undefined)).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 102)?.status).toBe('awaiting-model'); // unchanged
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // prose never spawns

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: TWO model taps in ONE getUpdates batch spawn EXACTLY one agent (sequential dispatch invariant)', async () => {
  // The no-double-spawn guarantee depends on strictly sequential action dispatch: the first tap
  // reaches `bound` before the second's bound-guard reads the store. Both taps arrive in one batch.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(150, 103, 'batch', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 103 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(151, 103, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 103 && t.status === 'awaiting-model'));

  // Both taps in the SAME batch.
  updateQueue.push([modelTap(152, 103, 'claude-opus'), modelTap(153, 103, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 103 && t.status === 'bound'));
  await Bun.sleep(300);
  // Exactly one new-window ran despite two taps in one batch.
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 103)?.paneId).toBe(SPAWNED_PANE);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a model tap in awaiting-PATH (no dir yet) → "send the working directory first", no spawn', async () => {
  // A tap before the path is supplied (status awaiting-path) hits the wrong-state guard.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(120, 99, 'nopath', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 99 && t.status === 'awaiting-path'));

  updateQueue.push([modelTap(121, 99, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 99 && String(s.text).includes('working directory first')));
  expect(sends.some((s) => s.message_thread_id === 99 && String(s.text).includes('working directory first'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 99)?.status).toBe('awaiting-path'); // unchanged

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a model tap + a text message in ONE batch does NOT strand the bound pane (stale topic-answer race)', async () => {
  // codex P2 race: in awaiting-model, a model tap (-> topic-model) and a text message
  // (-> topic-answer) can land in the SAME getUpdates batch. topic-model runs first -> bound;
  // the stale topic-answer then reloads a BOUND binding. Without the awaiting-path guard,
  // applyPathAnswer would move the bound topic BACK to awaiting-model and strand the spawned
  // pane. The guard must drop the stale answer: the topic stays bound, pane intact.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(160, 104, 'race', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 104 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(161, 104, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 104 && t.status === 'awaiting-model'));

  // The model tap AND a text message (a valid absolute existing dir — the dangerous case) in ONE
  // batch. The tap binds; the stale answer must be ignored, NOT reset the binding.
  updateQueue.push([modelTap(162, 104, 'claude-opus'), topicTextMsg(163, 104, cfgDir, nowSec + 2)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 104 && t.status === 'bound'));
  await Bun.sleep(300);

  const binding = topicsStore(cfgDir).find((t) => t.threadId === 104);
  expect(binding?.status).toBe('bound'); // NOT reset to awaiting-model
  expect(binding?.paneId).toBe(SPAWNED_PANE); // pane preserved, not stranded
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1); // exactly one spawn

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// =========================== increment 4 — lifecycle polish ===========================

test('increment 4: recent-path button — the awaiting-path prompt offers the registered cwd, a tap fills the path', async () => {
  // The registration seeds cfgDir as a known cwd → gatherRecentPaths offers it as a tgp: button.
  // Tapping index 0 advances to awaiting-model with that path — no free-text needed.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(200, 110, 'recent', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 110 && t.status === 'awaiting-path'));
  // The awaiting-path prompt carried a path keyboard (callback tgp:110:0:<nonce>), and the offered
  // choice + nonce were persisted on the binding.
  const askProbe = sends.find((s) => s.message_thread_id === 110 && (s.reply_markup as any)?.inline_keyboard);
  expect(askProbe).toBeDefined();
  const kb = (askProbe!.reply_markup as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
  expect(kb[0][0].callback_data).toMatch(/^tgp:110:0:\d+$/);
  const nonce = Number(kb[0][0].callback_data.split(':')[3]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 110)?.pathChoices).toContain(cfgDir);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 110)?.pathChoicesNonce).toBe(nonce);

  // Tap the recent-path button (index 0 = cfgDir, matching nonce) → advance to awaiting-model.
  updateQueue.push([pathTap(201, 110, 0, nonce)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 110 && t.status === 'awaiting-model'));
  const advanced = topicsStore(cfgDir).find((t) => t.threadId === 110);
  expect(advanced?.path).toBe(cfgDir);
  expect(advanced?.pathChoices).toBeUndefined(); // dropped on advance
  expect(callbackAnswers.some((c) => c.callback_query_id === 'cb201')).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: the model keyboard is CLEARED (editMessageReplyMarkup) after the topic binds', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, keyboardEdits } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(210, 111, 'clearkb', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 111 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(211, 111, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 111 && t.status === 'awaiting-model'));
  // modelTap carries messageId = updateId (222) → that's the prompt message the daemon clears.
  updateQueue.push([modelTap(222, 111, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 111 && t.status === 'bound'));

  // The stale model keyboard was removed via editMessageReplyMarkup on the prompt message.
  await waitFor(() => keyboardEdits.some((e) => e.message_id === 222));
  const cleared = keyboardEdits.find((e) => e.message_id === 222);
  expect(cleared).toBeDefined();
  expect(cleared!.reply_markup).toBeUndefined(); // omitting reply_markup detaches the keyboard

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a dead bound-pane → a Re-spawn button is offered, and the tap re-spawns + re-binds', async () => {
  // Seed a topic BOUND to %9 (not in the fake tmux list) with a retained path (cfgDir, a real dir
  // so re-spawn's path re-validation passes) + model. A message marks it closed and offers re-spawn;
  // the tap re-runs the spawn and binds the new pane.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 112, name: 'respawn', status: 'bound', paneId: '%9', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // A message to the dead-pane topic → closed + a re-spawn offer (with a tgr: button).
  updateQueue.push([topicTextMsg(230, 112, 'are you there?', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 112 && (s.reply_markup as any)?.inline_keyboard));
  const offer = sends.find((s) => s.message_thread_id === 112 && (s.reply_markup as any)?.inline_keyboard);
  const offerKb = (offer!.reply_markup as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
  expect(offerKb[0][0].callback_data).toBe('tgr:112');
  expect(sends.some((s) => s.message_thread_id === 112 && String(s.text).includes('exited'))).toBe(true);
  // The binding flipped to closed (its pane is gone) — not still claiming a live agent.
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 112 && t.status === 'closed'));

  // Tap Re-spawn → the agent is re-launched and the topic re-binds to the new pane.
  updateQueue.push([respawnTap(231, 112)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 112 && t.status === 'bound'));
  const rebound = topicsStore(cfgDir).find((t) => t.threadId === 112);
  expect(rebound?.status).toBe('bound');
  expect(rebound?.paneId).toBe(SPAWNED_PANE);
  expect(rebound?.model).toBe('claude-opus'); // retained model re-used
  // Exactly one new-window ran for the re-spawn (the seed was pre-bound, never spawned here).
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1);
  expect(spawnArgvLog(paths.spawnLog)[0]).toContain('claude --model opus');
  expect(spawnArgvLog(paths.spawnLog)[0]).toContain('-e TG_TOPIC=112'); // re-spawn also stamps the topic env
  expect(callbackAnswers.some((c) => c.callback_query_id === 'cb231')).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// A tmux whose list-panes reports a LIVE claude pane in a window named `<winName>` — the
// crash-orphan window. new-window still works (a fallback path), send-keys logs injects.
// `token` (optional) is the TG_SPAWN_TOKEN the orphan pane's window reports via show-environment;
// pass '' for a window WITHOUT the token (a stranger pane that must NOT be adopted).
function fakeTmuxWithWindow(
  cwd: string,
  winName: string,
  paneId: string,
  spawnLog: string,
  injectLog: string,
  token = '',
): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    ${''}# 8-field PANE_FORMAT: …, window_name, @tg_spawn_token (field 7), path. The orphan pane
    ${''}# '${paneId}' carries the token '${token}'; %1 carries an empty token field.
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${paneId}' '4299' 'claude' '${winName}' '${token}' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window)
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${paneId}'
    ;;
  set-option) ;;  ${''}# stamps @tg_spawn_token on the spawned pane — a no-op for the fake
  send-keys)
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer) cat >> '${injectLog}'; printf '\\n' >> '${injectLog}' ;;
esac
exit 0
`;
}

function fakePsWith(pids: number[]): string {
  const lines = pids.map((p) => `printf '%s %s %s\\n' '${p}' '1' 'claude'`).join('\n');
  return `#!/bin/sh\n${lines}\nexit 0\n`;
}

test('increment 4: crash-orphan reconcile — a slug-window orphan with an awaiting-model binding is RE-BOUND on startup (no second spawn)', async () => {
  // Simulate the crash gap: a binding stuck at awaiting-model (a crash hit AFTER new-window but
  // BEFORE the bound write) while a LIVE claude pane (%5) runs in the topic-slug window `orphan`.
  // On startup the daemon must ADOPT %5 (re-bind), not leave the orphan for a re-tap to double-spawn.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-orphan-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // slugifyTopicName('orphan') === 'orphan' → the live window name to match. The orphan pane's
  // window carries the matching TG_SPAWN_TOKEN (the proof it's the one we launched).
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 113, name: 'orphan', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '113-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'orphan', '%5', spawnLog, injectLog, '113-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });

  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  // Startup reconcile must adopt the orphan pane %5 → bound, with NO new-window (no second spawn).
  await waitFor(() => {
    const t = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    return t.some((b) => b.threadId === 113 && b.status === 'bound');
  });
  const adopted = (JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>).find(
    (b) => b.threadId === 113,
  );
  expect(adopted?.status).toBe('bound');
  expect(adopted?.paneId).toBe('%5'); // adopted the live orphan, NOT a freshly spawned pane
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8') : '').toBe(''); // NO new-window ran

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('private_topics ON with topics OFF: startup reconcile adopts a private-topic spawnPending orphan', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-private-orphan-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n  private_topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([
      {
        threadId: 271,
        name: 'privorphan',
        status: 'awaiting-model',
        path: cfgDir,
        model: 'claude-opus',
        spawnPending: true,
        spawnToken: '271-1-1',
        ts: 1,
      },
    ]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'privorphan', '%5', spawnLog, injectLog, '271-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });

  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await waitFor(() => topicsStore(cfgDir).some((b) => b.threadId === 271 && b.status === 'bound'));
  expect(topicsStore(cfgDir).find((x) => x.threadId === 271)).toMatchObject({
    status: 'bound',
    paneId: '%5',
  });
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8') : '').toBe('');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: crash-orphan reconcile — a BOUND binding whose pane vanished while down is marked CLOSED on startup', async () => {
  // The other half of reconcile: a `bound` binding to %9 (gone) must flip to closed on startup so
  // the next message offers re-spawn instead of injecting into nothing.
  const paths = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 114, name: 'gone', status: 'bound', paneId: '%9', path: '/w', model: 'claude-opus', ts: 1 }],
  });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 114 && t.status === 'closed'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 114)?.status).toBe('closed');
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // reconcile NEVER spawns — it only adopts/closes

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: topics OFF — startup reconcile is a no-op (a stale bound binding is left untouched, 1:1 unchanged)', async () => {
  // With the flag off the reconcile must not touch the store at all. Seed a bound/dead binding and
  // assert it is NOT flipped to closed (the whole topics layer is inert when off).
  const paths = makeCfgDir({
    topics: false,
    seedTopics: [{ threadId: 115, name: 'off', status: 'bound', paneId: '%9', path: '/w', model: 'claude-opus', ts: 1 }],
  });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  await Bun.sleep(600);
  // Untouched — still bound (reconcile gated behind ctx.cfg.topics).
  expect(topicsStore(cfgDir).find((t) => t.threadId === 115)?.status).toBe('bound');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: re-spawn offer is THROTTLED — a burst of messages to a closed topic posts ONE offer (review #3)', async () => {
  // Seed a CLOSED topic with retained path+model. Two messages arrive; only the FIRST posts a
  // re-spawn offer (a button send) — the second is acked quietly (respawnOffered flag).
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 120, name: 'throttle', status: 'closed', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(300, 120, 'hello?', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 120 && (s.reply_markup as any)?.inline_keyboard));
  // The flag was stamped after the first offer.
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 120 && t.respawnOffered === true));
  const offersAfterFirst = sends.filter((s) => s.message_thread_id === 120 && (s.reply_markup as any)?.inline_keyboard).length;
  expect(offersAfterFirst).toBe(1);

  // A SECOND message → NO new offer (throttled).
  updateQueue.push([topicTextMsg(301, 120, 'still dead?', nowSec + 1)]);
  await Bun.sleep(500);
  const offersAfterSecond = sends.filter((s) => s.message_thread_id === 120 && (s.reply_markup as any)?.inline_keyboard).length;
  expect(offersAfterSecond).toBe(1); // STILL one — no spam

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: reconcile is a NO-OP on a flaky empty-procs read — a bound binding is NOT falsely closed (review #1)', async () => {
  // panes report fine but `ps` returns NOTHING (a flaky procs read). findAgentInPane then matches
  // nothing → zero live-agent panes. The reconcile must NOT mass-close the bound binding off that.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-flake-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // The bound binding points at %1 — a pane that IS in the list, but ps reports no procs.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 121, name: 'flake', status: 'bound', paneId: '%1', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // tmux lists %1 in a window; ps returns EMPTY → no agent matched anywhere.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'flake', '%1', spawnLog, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  // Give the startup reconcile time to run, then assert the binding is STILL bound (not closed).
  await waitFor(() => topicsStore(cfgDir).some((x) => x.threadId === 260 && x.status === 'bound'));
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(store.find((b) => b.threadId === 121)?.status).toBe('bound'); // NOT falsely closed

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: reconcile slug-collision — two same-slug orphan bindings do NOT both adopt the one pane (review #2)', async () => {
  // Two awaiting-model bindings with the SAME name (→ same slug `dup`). Only ONE live agent pane
  // (%6) runs in window `dup`. The first binding adopts it; the second must NOT also claim %6.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-collide-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // Both seed the SAME token (the one %6's window reports), so both pass the token check — the
  // claimed-set is what stops the SECOND from also adopting %6.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([
      { threadId: 122, name: 'dup', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '122-1-1', ts: 1 },
      { threadId: 123, name: 'dup', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '122-1-1', ts: 1 },
    ]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'dup', '%6', spawnLog, injectLog, '122-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await waitFor(() => {
    const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    const bound = store.filter((b) => (b.threadId === 122 || b.threadId === 123) && b.status === 'bound' && b.paneId === '%6');
    return bound.length === 1;
  });
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  const bound = store.filter((b) => (b.threadId === 122 || b.threadId === 123) && b.status === 'bound' && b.paneId === '%6');
  expect(bound).toHaveLength(1); // exactly ONE binding adopted %6 — never two on the same pane

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: re-spawn into a VANISHED dir restarts the /new flow (not stuck at awaiting-model) (codex #1)', async () => {
  // Seed a closed topic whose recorded path is a SUBDIR we then delete. Tapping Re-spawn must not
  // strand the binding at awaiting-model (where text only re-shows model buttons) — it restarts the
  // /new flow back to awaiting-path so the user can fix the dir.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const goneDir = join(cfgDir, 'project');
  mkdirSync(goneDir);
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 130, name: 'vanish', status: 'closed', path: goneDir, model: 'claude-opus', respawnOffered: true, ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // Delete the project dir, THEN tap Re-spawn → path re-validation fails → restart the /new flow.
  rmSync(goneDir, { recursive: true, force: true });
  updateQueue.push([respawnTap(330, 130)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 130 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 130)?.status).toBe('awaiting-path'); // NOT stuck
  expect(sends.some((s) => s.message_thread_id === 130 && String(s.text).includes('not an absolute existing directory'))).toBe(true);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // never spawned into a gone dir

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: reconcile does NOT adopt a same-slug window in a DIFFERENT project dir (codex #2)', async () => {
  // The orphan window matches the slug `proj` but its cwd is /other, while the binding's path is
  // cfgDir. The path guard must REFUSE adoption — leaving the binding awaiting-model (not bound to
  // a stranger's agent).
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-wrongdir-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // Token matches (isolates the cwd guard) — adoption must STILL be refused on the cwd mismatch.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 131, name: 'proj', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '131-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // The slug-window `proj` pane %7 runs in /other — a DIFFERENT project than the binding's cfgDir.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow('/other', 'proj', '%7', spawnLog, injectLog, '131-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await waitFor(() => {
    const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    return store.find((x) => x.threadId === 211)?.status === 'bound';
  });
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  const b = store.find((x) => x.threadId === 131);
  expect(b?.status).toBe('awaiting-model'); // NOT adopted — wrong project
  expect(b?.paneId).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: reconcile does NOT re-bind a deliberately CLOSED topic with a live same-slug agent (codex round-2 #2)', async () => {
  // A topic CLOSED by forum_topic_closed while its tmux agent (window `keep`, cwd cfgDir) is still
  // alive. Reconcile must NOT resurrect it to bound (only awaiting-model crash-gap bindings adopt).
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-closedkeep-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 140, name: 'keep', status: 'closed', path: cfgDir, model: 'claude-opus', paneId: '%8', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'keep', '%8', spawnLog, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await waitFor(() => {
    const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    return store.find((x) => x.threadId === 260)?.status === 'bound';
  });
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(store.find((x) => x.threadId === 140)?.status).toBe('closed'); // stays closed — NOT resurrected

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: TWO same-batch messages to a bound-but-dead topic → throttled recovery, NOT the "recreate" dead-end (codex round-2 #1)', async () => {
  // Seed a bound topic to %9 (gone). TWO messages arrive in ONE getUpdates batch. The first closes
  // the binding + offers re-spawn; the SECOND must NOT post the legacy "recreate the topic" text —
  // it routes through the same throttle (respawnOffered) and stays quiet.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 141, name: 'batch', status: 'bound', paneId: '%9', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // BOTH messages in ONE batch → both classified topic-route (bound) before the first closes it.
  updateQueue.push([topicTextMsg(400, 141, 'first', nowSec), topicTextMsg(401, 141, 'second', nowSec + 1)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 141 && (s.reply_markup as any)?.inline_keyboard));
  await Bun.sleep(400);
  // Exactly ONE re-spawn offer (button), and NO "recreate the topic" dead-end message anywhere.
  const offers = sends.filter((s) => s.message_thread_id === 141 && (s.reply_markup as any)?.inline_keyboard).length;
  expect(offers).toBe(1);
  expect(sends.some((s) => String(s.text).includes('recreate the topic'))).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: TWO same-batch messages to a dead topic with NO retained path/model → restart flow, NO dead-end (codex r3 P2)', async () => {
  // A bound topic to %9 (gone) WITHOUT a path/model. The first message closes it + restarts the
  // /new flow (awaiting-path); the SECOND same-batch message must NOT post "recreate the topic".
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 142, name: 'nopm', status: 'bound', paneId: '%9', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(410, 142, 'first', nowSec), topicTextMsg(411, 142, 'second', nowSec + 1)]);
  // The restart posts the awaiting-path prompt (exited notice + "which directory?").
  await waitFor(() => sends.some((s) => s.message_thread_id === 142 && String(s.text).includes('set it up again')));
  await Bun.sleep(400);
  // The topic restarted into the /new flow; NO legacy "recreate the topic" dead-end was posted.
  expect(topicsStore(cfgDir).find((t) => t.threadId === 142)?.status).toBe('awaiting-path');
  expect(sends.some((s) => String(s.text).includes('recreate the topic'))).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a STALE path button (superseded nonce) is rejected at awaiting-path, never selecting the wrong dir (codex r3 P1)', async () => {
  // A closed-with-no-path/model topic: message #1 restarts the /new flow → awaiting-path (prompt #1,
  // nonce N1). The agent is never set up; the topic is closed again and message #2 restarts AGAIN →
  // awaiting-path (prompt #2, nonce N2 != N1). Tapping prompt #1's OLD button (nonce N1) while the
  // binding now carries N2 must be REJECTED ("expired") — never resolve its index against N2's list.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 143, name: 'stale', status: 'closed', ts: 1 }]), // no path/model → restart on message
  );
  const updateQueue: unknown[][] = [];
  const { server, sends, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // Message #1 → restart flow → awaiting-path with prompt #1 (nonce N1).
  updateQueue.push([topicTextMsg(420, 143, 'hi', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 143 && (s.reply_markup as any)?.inline_keyboard));
  const kb1 = sends.find((s) => s.message_thread_id === 143 && (s.reply_markup as any)?.inline_keyboard);
  const oldNonce = Number(((kb1!.reply_markup as any).inline_keyboard[0][0].callback_data as string).split(':')[3]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 143 && t.status === 'awaiting-path'));

  // Force a SECOND awaiting-path prompt with a fresh nonce: close the topic again + message → restart.
  // The nonce is a monotonic COUNTER (not a wall-clock second), so N2 != N1 with no sleep needed.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 143, name: 'stale', status: 'closed', ts: 2 }]),
  );
  updateQueue.push([topicTextMsg(421, 143, 'hi again', nowSec + 2)]);
  await waitFor(() =>
    topicsStore(cfgDir).some((t) => t.threadId === 143 && t.status === 'awaiting-path' && t.pathChoicesNonce !== oldNonce),
  );
  const newNonce = topicsStore(cfgDir).find((t) => t.threadId === 143)?.pathChoicesNonce;
  expect(newNonce).not.toBe(oldNonce);

  // Tap prompt #1's OLD button (nonce N1) → REJECTED ("expired"), NOT advanced.
  updateQueue.push([pathTap(422, 143, 0, oldNonce)]);
  await waitFor(() => callbackAnswers.some((c) => c.callback_query_id === 'cb422'));
  expect(callbackAnswers.some((c) => c.callback_query_id === 'cb422' && String(c.text).includes('expired'))).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 143)?.status).toBe('awaiting-path'); // not advanced

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a STALE re-spawn tap on a non-closed topic is refused — never spawns out of flow (codex r4 P1)', async () => {
  // The re-spawn button is only ever offered for a CLOSED topic. Seed an AWAITING-MODEL topic (with
  // a retained path+model — the post-reopen state) and tap tgr: it must be refused as expired, NOT
  // re-spawn a second agent out of band.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 150, name: 'stalebtn', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  updateQueue.push([respawnTap(500, 150)]);
  await waitFor(() => callbackAnswers.some((c) => c.callback_query_id === 'cb500'));
  expect(callbackAnswers.some((c) => c.callback_query_id === 'cb500' && String(c.text).includes('expired'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // NOT spawned out of flow
  expect(topicsStore(cfgDir).find((t) => t.threadId === 150)?.status).toBe('awaiting-model'); // unchanged

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: two same-SECOND path-flow restarts get DISTINCT nonces (counter, not wall-clock) — stale button still rejected (codex r4 P1)', async () => {
  // Two restarts within one wall-clock second. With a second-granularity nonce both prompts would
  // share it and the stale-button guard would fail. The monotonic counter gives DISTINCT nonces.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 151, name: 'samesec', status: 'closed', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // First restart → prompt #1, nonce N1. Wait for the nonce to be persisted (not just the status).
  updateQueue.push([topicTextMsg(510, 151, 'a', nowSec)]);
  await waitFor(() =>
    topicsStore(cfgDir).some((t) => t.threadId === 151 && t.status === 'awaiting-path' && typeof t.pathChoicesNonce === 'number'),
  );
  const n1 = topicsStore(cfgDir).find((t) => t.threadId === 151)?.pathChoicesNonce as number;
  expect(typeof n1).toBe('number');

  // Immediately re-close + message → second restart in the SAME wall-clock second → prompt #2, N2.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 151, name: 'samesec', status: 'closed', ts: 1 }]),
  );
  updateQueue.push([topicTextMsg(511, 151, 'b', nowSec)]);
  await waitFor(() =>
    topicsStore(cfgDir).some(
      (t) => t.threadId === 151 && t.status === 'awaiting-path' && typeof t.pathChoicesNonce === 'number' && t.pathChoicesNonce !== n1,
    ),
  );
  const n2 = topicsStore(cfgDir).find((t) => t.threadId === 151)?.pathChoicesNonce as number;
  expect(typeof n2).toBe('number');
  expect(n2).not.toBe(n1); // DISTINCT despite the same wall-clock second (monotonic counter)

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: reconcile does NOT adopt an awaiting-model binding with NO model chosen (codex r5 #1)', async () => {
  // The NORMAL post-path/pre-model-tap state is awaiting-model + path + NO model. A same-slug/same-
  // cwd live pane must NOT be adopted here (no agent was spawned yet — it's a stranger).
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-nomodel-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // awaiting-model with a path but NO model — same slug `nm`, same cwd as the live pane.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 160, name: 'nm', status: 'awaiting-model', path: cfgDir, ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'nm', '%5', spawnLog, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await Bun.sleep(700);
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  const b = store.find((x) => x.threadId === 160);
  expect(b?.status).toBe('awaiting-model'); // NOT adopted — no model means no spawned agent to adopt
  expect(b?.paneId).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a FAILED re-spawn restores the topic to closed so the next message re-offers (codex r5 #2)', async () => {
  // Seed a closed topic with retained path+model. Arm the spawn-failure flag, tap Re-spawn → the
  // spawn fails; the binding must go back to `closed` (NOT stay awaiting-model with a stale button),
  // and a follow-up message must re-offer a fresh re-spawn button.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(paths.failFlag, '1'); // tmux new-window will exit 1
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 170, name: 'failresp', status: 'closed', path: cfgDir, model: 'claude-opus', respawnOffered: true, ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // Tap Re-spawn → the spawn fails → restore to closed.
  updateQueue.push([respawnTap(600, 170)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 170 && String(s.text).includes("couldn't start")));
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 170 && t.status === 'closed'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 170)?.status).toBe('closed'); // restored, not stuck
  expect(topicsStore(cfgDir).find((t) => t.threadId === 170)?.respawnOffered).toBeUndefined(); // can re-offer

  // A follow-up message → a FRESH re-spawn offer is posted (retry is obvious).
  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(601, 170, 'retry?', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 170 && (s.reply_markup as any)?.inline_keyboard));
  expect(sends.some((s) => s.message_thread_id === 170 && (s.reply_markup as any)?.inline_keyboard)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: recent-path buttons are NEWEST-registration-first (codex r5 #3)', async () => {
  // Registrations are appended newest-LAST. The path buttons must list the NEWEST registration's cwd
  // first, so an older session can't crowd out a newer project. PANELESS registrations (cwd-only) are
  // never tmux-pruned, so the array order on disk is what gatherRecentPaths reverses → newest first.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const oldDir = join(cfgDir, 'old');
  const newDir = join(cfgDir, 'new');
  mkdirSync(oldDir);
  mkdirSync(newDir);
  // Array order = chronological append: oldDir (older), newDir (newest). cwd-only = not pruned.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { cwd: oldDir, registeredAt: 1 },
      { cwd: newDir, registeredAt: 2 },
    ]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(700, 180, 'order', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 180 && (s.reply_markup as any)?.inline_keyboard));
  const kb = (sends.find((s) => s.message_thread_id === 180 && (s.reply_markup as any)?.inline_keyboard)!.reply_markup as any)
    .inline_keyboard as Array<Array<{ text: string }>>;
  const labels = kb.map((row) => row[0].text);
  // newDir (newest) appears BEFORE oldDir.
  expect(labels.indexOf(newDir)).toBeLessThan(labels.indexOf(oldDir));
  expect(labels.indexOf(newDir)).toBe(0);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: recent-path buttons merge routes + registrations by timestamp (a newer registration beats an older route, codex r25)', async () => {
  // A route to /old (ts 100) and a registration to /new (registeredAt 200). With per-source
  // concatenation the route would come first; the timestamp merge puts the NEWER /new first.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const oldDir = join(cfgDir, 'oldroute');
  const newDir = join(cfgDir, 'newreg');
  mkdirSync(oldDir);
  mkdirSync(newDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 1, paneId: '%2', cwd: oldDir, ts: 100 }]));
  // A paneless registration (cwd-only) is never tmux-pruned; registeredAt 200 > the route's 100.
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify([{ cwd: newDir, registeredAt: 200 }]));
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(701, 181, 'merge', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 181 && (s.reply_markup as any)?.inline_keyboard));
  const kb = (sends.find((s) => s.message_thread_id === 181 && (s.reply_markup as any)?.inline_keyboard)!.reply_markup as any)
    .inline_keyboard as Array<Array<{ text: string }>>;
  const labels = kb.map((row) => row[0].text);
  expect(labels.indexOf(newDir)).toBe(0); // the newer registration sorts before the older route
  expect(labels.indexOf(newDir)).toBeLessThan(labels.indexOf(oldDir));

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a message to a closed topic whose retained dir VANISHED restarts the /new flow, no dead button (codex r6)', async () => {
  // Seed a closed topic whose retained path is a subdir we then delete. A message must NOT post an
  // unusable Re-spawn button (which would then suppress further messages via the throttle) — it must
  // restart the /new flow (awaiting-path) so the human picks a live dir.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const goneDir = join(cfgDir, 'gone');
  mkdirSync(goneDir);
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 190, name: 'vanished', status: 'closed', path: goneDir, model: 'claude-opus', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // Delete the retained dir, THEN message the closed topic → restart flow, NOT a re-spawn button.
  rmSync(goneDir, { recursive: true, force: true });
  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(800, 190, 'you there?', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 190 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 190)?.status).toBe('awaiting-path'); // restarted, not dead-button
  // No re-spawn (tgr) button was offered; the "set it up again" notice was posted instead.
  await waitFor(() => sends.some((s) => s.message_thread_id === 190 && String(s.text).includes('set it up again')));
  const tgrOffered = sends.some(
    (s) =>
      s.message_thread_id === 190 &&
      ((s.reply_markup as any)?.inline_keyboard?.[0]?.[0]?.callback_data as string | undefined)?.startsWith('tgr:'),
  );
  expect(tgrOffered).toBe(false);
  expect(sends.some((s) => s.message_thread_id === 190 && String(s.text).includes('set it up again'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a reused-pane bound binding does NOT block a real spawnPending orphan from adopting that pane (codex r8 #2)', async () => {
  // Bound binding B1 recorded pane %5 + path /OTHER, but %5 now runs in cfgDir (tmux reused %5 for a
  // different project while down). A spawnPending orphan B2 (slug `dup`, path cfgDir) should ADOPT %5
  // — B1's stale (path-mismatched) claim must not block it.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-reuse-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([
      { threadId: 210, name: 'b1', status: 'bound', paneId: '%5', path: '/OTHER', model: 'claude-opus', ts: 1 },
      { threadId: 211, name: 'dup', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '211-1-1', ts: 1 },
    ]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // %5 is live in window `dup` with cwd cfgDir + B2's token — matches B2's path+token, mismatches B1.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'dup', '%5', spawnLog, injectLog, '211-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await waitFor(() => topicsStore(cfgDir).some((x) => x.threadId === 211 && x.status === 'bound'));
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  // B2 adopted %5 (its claim wasn't blocked by B1's stale reused-pane claim).
  expect(store.find((x) => x.threadId === 211)?.status).toBe('bound');
  expect(store.find((x) => x.threadId === 211)?.paneId).toBe('%5');
  // B1's pane is path-mismatched; it stays bound (routing-time guard handles the leak), NOT adopting.
  expect(store.find((x) => x.threadId === 210)?.status).toBe('bound');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a FAILED spawn (no spawnPending) is NOT adopted as a crash-orphan on restart (codex r7 P1)', async () => {
  // Models the post-failed-spawn state: awaiting-model + path + model but NO spawnPending (the spawn
  // failure cleared it — no orphan window was created). On restart, an UNRELATED live agent happens
  // to run in the same-slug/same-cwd window. Reconcile must NOT bind the topic to that stranger.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-failadopt-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // awaiting-model + path + model, but spawnPending ABSENT (failed spawn cleared it).
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 200, name: 'failadopt', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // A live agent runs in the same-slug `failadopt` window with the same cwd — an UNRELATED pane.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'failadopt', '%5', spawnLog, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await Bun.sleep(700);
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  const b = store.find((x) => x.threadId === 200);
  expect(b?.status).toBe('awaiting-model'); // NOT adopted — no spawnPending means no real orphan
  expect(b?.paneId).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: same-batch re-spawn tap + text message → the text is NOT lost, it reaches the re-bound pane (codex r9 #1)', async () => {
  // Seed a closed topic with path+model. ONE batch carries the tgr: tap AND a text message. Callbacks
  // run first (re-spawn → bound to SPAWNED_PANE), then the text's topic-dead action must route the
  // message to the now-bound pane instead of silently dropping it.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 220, name: 'batchroute', status: 'closed', path: cfgDir, model: 'claude-opus', respawnOffered: true, ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // ONE batch: the re-spawn tap (callback, runs first) + a text message (topic-dead, runs after).
  updateQueue.push([respawnTap(700, 220), topicTextMsg(701, 220, 'pick up where we left off', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 220 && t.status === 'bound'));
  // The text reached the freshly-bound pane (%7), NOT dropped.
  await waitFor(() => injected(paths.injectLog).some((i) => i.text.includes('pick up where we left off')));
  const landed = injected(paths.injectLog).filter((i) => i.text.includes('pick up where we left off'));
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(SPAWNED_PANE); // routed to the re-bound agent

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a closed binding with a RELATIVE retained path → restart flow, never spawns with -c . (codex r9 #2)', async () => {
  // A corrupt/old binding with path '.' (relative). A message must NOT offer a re-spawn button (which
  // would spawn `tmux new-window -c .`, resolving against the tmux server cwd) — it restarts the flow.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 230, name: 'rel', status: 'closed', path: '.', model: 'claude-opus', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(710, 230, 'hi', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 230 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 230)?.status).toBe('awaiting-path'); // restarted
  // No tgr re-spawn button offered for the relative path; nothing spawned with -c .
  const tgrOffered = sends.some(
    (s) =>
      s.message_thread_id === 230 &&
      ((s.reply_markup as any)?.inline_keyboard?.[0]?.[0]?.callback_data as string | undefined)?.startsWith('tgr:'),
  );
  expect(tgrOffered).toBe(false);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a spawnPending orphan whose window LACKS the matching token is NOT adopted (codex r10 P1)', async () => {
  // Models a crash BEFORE new-window ran (spawnPending + token persisted, but no window carries it),
  // OR a same-slug/same-cwd STRANGER pane. The live %5 window reports NO TG_SPAWN_TOKEN → no adopt.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-notoken-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // spawnPending + a token the binding expects, but the live window will report NO token.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 240, name: 'notok', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: 'EXPECTED', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // Pass token '' → the %5 window's show-environment reports NO TG_SPAWN_TOKEN (mismatch).
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'notok', '%5', spawnLog, injectLog, ''), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await Bun.sleep(700);
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  const b = store.find((x) => x.threadId === 240);
  expect(b?.status).toBe('awaiting-model'); // NOT adopted — the window's token didn't match
  expect(b?.paneId).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a binding with a recorded paneId but a window MISSING the token → adopted by paneId (codex r12 P1)', async () => {
  // Models the best-effort token-stamp FAILING while the paneId was still persisted (the paneId is
  // written alongside the token after a successful new-window): spawnPending + a RECORDED paneId (%5)
  // but the window carries NO @tg_spawn_token. Reconcile must adopt %5 by the recorded-paneId fallback
  // — so a later model tap can't double-spawn. (A crash BEFORE the token stamp leaves neither — the
  // documented irreducible residual, bounded by the JIT probe; not covered here.)
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-paneid-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // spawnPending + a recorded paneId %5, but the window will report NO token (stamp never ran).
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 260, name: 'paneid', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '260-1-1', paneId: '%5', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // %5 live in window `paneid` cwd cfgDir, but token '' (never stamped) → adopt by recorded paneId.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'paneid', '%5', spawnLog, injectLog, ''), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  await Bun.sleep(700);
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  const b = store.find((x) => x.threadId === 260);
  expect(b?.status).toBe('bound'); // adopted by the recorded paneId fallback
  expect(b?.paneId).toBe('%5');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a re-spawn into a VANISHED dir CLEARS the model keyboard so a stale model tap cannot spawn (codex r10 P2)', async () => {
  // A re-spawn restart (vanished dir) restarts the path flow. The previously-tapped model keyboard
  // must be CLEARED (editMessageReplyMarkup) so an old tgm button can't re-enter handleTopicModel.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const goneDir = join(cfgDir, 'gone2');
  mkdirSync(goneDir);
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 250, name: 'clearonrestart', status: 'closed', path: goneDir, model: 'claude-opus', respawnOffered: true, ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, keyboardEdits } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // Delete the dir, then tap Re-spawn (messageId 900 = the prompt) → restart + clear that keyboard.
  rmSync(goneDir, { recursive: true, force: true });
  updateQueue.push([respawnTap(900, 250)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 250 && t.status === 'awaiting-path'));
  // The re-spawn callback's message (900) had its keyboard cleared on the restart branch.
  await waitFor(() => keyboardEdits.some((e) => e.message_id === 900));
  expect(keyboardEdits.some((e) => e.message_id === 900)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a model tap on a spawnPending binding with a live orphan ADOPTS it (no double-spawn) — JIT probe (codex r13 P1)', async () => {
  // Reconcile missed the orphan at boot (flaky snapshot). The binding is awaiting-model + spawnPending
  // + token, and a live orphan pane (%5, window slug `jit`, matching token) exists. A model tap must
  // ADOPT the orphan via the just-in-time probe in spawnAndBindTopic — NOT run a second new-window.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-jit-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // awaiting-model + spawnPending + token, NO model yet (the tap supplies it). slug('jit')==='jit'.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 270, name: 'jit', status: 'awaiting-model', path: cfgDir, spawnPending: true, spawnToken: '270-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // %5 live in window `jit` with cwd cfgDir + the matching token.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'jit', '%5', spawnLog, injectLog, '270-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  // A model tap → handleTopicModel → spawnAndBindTopic → JIT probe finds %5 → adopt, NO new-window.
  updateQueue.push([modelTap(270, 270, 'claude-opus')]);
  await waitFor(() => {
    const t = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    return t.some((b) => b.threadId === 270 && b.status === 'bound');
  });
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(store.find((x) => x.threadId === 270)?.paneId).toBe('%5'); // adopted the orphan
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8') : '').toBe(''); // NO second new-window

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a no-path/model re-spawn restart CLEARS the stale tgr keyboard (codex r13 P2)', async () => {
  // A closed binding with NO path/model. Tapping the (stale) re-spawn button restarts the /new flow;
  // its keyboard must be cleared so the button doesn't linger producing only expired toasts.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 280, name: 'nopmrestart', status: 'closed', respawnOffered: true, ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, keyboardEdits } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // tgr tap with messageId 950 → restart flow + clear that keyboard.
  updateQueue.push([respawnTap(950, 280)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 280 && t.status === 'awaiting-path'));
  await waitFor(() => keyboardEdits.some((e) => e.message_id === 950));
  expect(keyboardEdits.some((e) => e.message_id === 950)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: the JIT probe adopts the orphan even with a stale reused-pane bound sibling (path-aware claim, codex r14 #1)', async () => {
  // A STALE bound topic (B1) records pane %5 + path /OTHER, but %5 now runs in cfgDir (reused). A
  // spawnPending orphan (B2, slug `jit2`) whose real orphan IS %5 must still adopt it on a model tap —
  // B1's path-mismatched claim must NOT block the JIT probe (else it double-spawns).
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-jit2-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([
      { threadId: 290, name: 'b1stale', status: 'bound', paneId: '%5', path: '/OTHER', model: 'claude-opus', ts: 1 },
      { threadId: 291, name: 'jit2', status: 'awaiting-model', path: cfgDir, spawnPending: true, spawnToken: '291-1-1', ts: 1 },
    ]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // %5 live in window `jit2` (B2's slug) with cwd cfgDir + B2's token.
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, 'jit2', '%5', spawnLog, injectLog, '291-1-1'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  // Startup reconcile leaves B1 bound (path-mismatch is recoverable, not closed). Then a model tap on
  // B2 → JIT probe adopts %5 despite B1's stale claim → NO second new-window.
  updateQueue.push([modelTap(291, 291, 'claude-opus')]);
  await waitFor(() => {
    const t = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    return t.some((b) => b.threadId === 291 && b.status === 'bound');
  });
  const store = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(store.find((x) => x.threadId === 291)?.paneId).toBe('%5'); // adopted despite the stale claim
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8') : '').toBe(''); // NO second new-window

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a DIFFERENT-model tap on a spawnPending binding is rejected — the in-flight model wins (codex r16 #1)', async () => {
  // A spawnPending binding launched with claude-opus. A stale tap of a DIFFERENT model (sonnet) must
  // NOT overwrite the model: the orphan was spawned with opus, so adopting it + recording sonnet would
  // lie. Reject the mismatched tap; the binding keeps opus.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-modelmismatch-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // spawnPending with model claude-opus (the spawn in flight). No live orphan needed — the tap is
  // rejected BEFORE any adoption/spawn.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 300, name: 'mm', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '300-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog, injectLog, join(cfgDir, 'NOFAIL')), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon({ cfgDir, spawnLog, injectLog, failFlag: join(cfgDir, 'NOFAIL') }, server.port);

  // Tap a DIFFERENT model (sonnet) → rejected, model stays opus, no spawn.
  updateQueue.push([modelTap(300, 300, 'claude-sonnet')]);
  await waitFor(() => callbackAnswers.some((c) => c.callback_query_id === 'cb300'));
  expect(callbackAnswers.some((c) => c.callback_query_id === 'cb300' && String(c.text).includes('already starting'))).toBe(true);
  await Bun.sleep(200);
  const b = topicsStore(cfgDir).find((t) => t.threadId === 300);
  expect(b?.model).toBe('claude-opus'); // unchanged — the in-flight model wins
  expect(spawnArgvLog(spawnLog)).toEqual([]); // no spawn from the rejected tap

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a model re-tap on a spawnPending binding with a FLAKY empty snapshot does NOT double-spawn (codex r17)', async () => {
  // The JIT probe gets an empty/flaky tmux read → the orphan may be alive but invisible. Re-tapping
  // the SAME model must NOT fall through to new-window (double-spawn); it refuses + asks to retry.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-flakejit-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 310, name: 'flakejit', status: 'awaiting-model', path: cfgDir, model: 'claude-opus', spawnPending: true, spawnToken: '310-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // tmux list-panes returns NOTHING (flaky/empty read); new-window/display-message still work.
  writeFileSync(
    join(cfgDir, 'bin', 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) ;;  # EMPTY → blind probe
  display-message) printf 'main\\n' ;;
  new-window) printf 'new-window %s\\n' "$*" >> '${spawnLog}'; printf '%s\\n' '%9' ;;
  set-option) ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(cfgDir, 'bin', 'ps'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 }); // no procs either
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon({ cfgDir, spawnLog, injectLog, failFlag: join(cfgDir, 'NOFAIL') }, server.port);

  // Re-tap the SAME model → flake guard refuses, NO new-window.
  updateQueue.push([modelTap(310, 310, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 310 && String(s.text).includes("couldn't read the session")));
  await Bun.sleep(200);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // NO spawn — would have double-spawned without the guard
  expect(topicsStore(cfgDir).find((t) => t.threadId === 310)?.status).toBe('awaiting-model'); // still pending, retryable

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a stale tgr tap on a MANUALLY-closed topic (no respawnOffered) is refused — never spawns (codex r18 #2)', async () => {
  // A topic CLOSED via forum_topic_closed (not a dead-pane offer) has path+model but NO respawnOffered.
  // A stale Re-spawn button tap must NOT launch an agent into the deliberately-closed topic.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 320, name: 'manualclose', status: 'closed', path: cfgDir, model: 'claude-opus', ts: 1 }]), // no respawnOffered
  );
  const updateQueue: unknown[][] = [];
  const { server, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  updateQueue.push([respawnTap(1000, 320)]);
  await waitFor(() => callbackAnswers.some((c) => c.callback_query_id === 'cb1000'));
  expect(callbackAnswers.some((c) => c.callback_query_id === 'cb1000' && String(c.text).includes('expired'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // NOT spawned into the manually-closed topic
  expect(topicsStore(cfgDir).find((t) => t.threadId === 320)?.status).toBe('closed'); // unchanged

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// A tmux whose slug window has TWO live panes both reporting the SAME @tg_spawn_token (a window
// option is shared by every pane in the window) — the multi-pane ambiguity case (codex r23 #2).
function fakeTmuxTwoPaneWindow(cwd: string, winName: string, token: string, spawnLog: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%5' '4299' 'claude' '${winName}' '${token}' '${cwd}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%6' '4300' 'claude' '${winName}' '${token}' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window) printf 'new-window %s\\n' "$*" >> '${spawnLog}'; printf '%s\\n' '%9' ;;
  set-option) ;;
  send-keys)
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer) cat >> '${injectLog}'; printf '\\n' >> '${injectLog}' ;;
esac
exit 0
`;
}

test('increment 4: a multi-pane window with an AMBIGUOUS token (no recorded paneId) is NOT adopted; a recorded paneId disambiguates (codex r23 #2)', async () => {
  // The slug window `multi` has TWO live panes (%5, %6) both exposing the same window-option token.
  // (a) With NO recorded paneId, token-only adoption is ambiguous → refuse (don't bind a guessed pane).
  const cfgA = mkdtempSync(join(tmpdir(), 'tgctl-ambig-'));
  const spawnLogA = join(cfgA, 'spawn.log');
  const injectLogA = join(cfgA, 'inject.log');
  writeFileSync(join(cfgA, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgA, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgA, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgA }));
  writeFileSync(
    join(cfgA, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 400, name: 'multi', status: 'awaiting-model', path: cfgA, model: 'claude-opus', spawnPending: true, spawnToken: '400-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgA, 'bin'));
  writeFileSync(join(cfgA, 'bin', 'tmux'), fakeTmuxTwoPaneWindow(cfgA, 'multi', '400-1-1', spawnLogA, injectLogA), { mode: 0o755 });
  writeFileSync(join(cfgA, 'bin', 'ps'), fakePsWith([4241, 4299, 4300]), { mode: 0o755 });
  const qA: unknown[][] = [];
  const { server: srvA } = makeServer(qA);
  servers.push(srvA);
  const fdA = openSync(join(cfgA, 'daemon.log'), 'a');
  const dA = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: cfgA,
    env: { PATH: `${join(cfgA, 'bin')}:/usr/bin:/bin`, HOME: cfgA, TG_CTL_CONFIG_DIR: cfgA, TG_API_BASE: `http://127.0.0.1:${srvA.port}` },
    logFd: fdA,
  });
  closeSync(fdA);
  await Bun.sleep(700);
  const storeA = JSON.parse(readFileSync(join(cfgA, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(storeA.find((x) => x.threadId === 400)?.status).toBe('awaiting-model'); // NOT adopted — ambiguous
  dA.kill('SIGTERM');
  await dA.exited;

  // (b) With a RECORDED paneId (%6), the exact pane is adopted despite the shared token.
  const cfgB = mkdtempSync(join(tmpdir(), 'tgctl-ambig2-'));
  const spawnLogB = join(cfgB, 'spawn.log');
  const injectLogB = join(cfgB, 'inject.log');
  writeFileSync(join(cfgB, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgB, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgB, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgB }));
  writeFileSync(
    join(cfgB, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 401, name: 'multi', status: 'awaiting-model', path: cfgB, model: 'claude-opus', spawnPending: true, spawnToken: '401-1-1', paneId: '%6', ts: 1 }]),
  );
  mkdirSync(join(cfgB, 'bin'));
  writeFileSync(join(cfgB, 'bin', 'tmux'), fakeTmuxTwoPaneWindow(cfgB, 'multi', '401-1-1', spawnLogB, injectLogB), { mode: 0o755 });
  writeFileSync(join(cfgB, 'bin', 'ps'), fakePsWith([4241, 4299, 4300]), { mode: 0o755 });
  const qB: unknown[][] = [];
  const { server: srvB } = makeServer(qB);
  servers.push(srvB);
  const fdB = openSync(join(cfgB, 'daemon.log'), 'a');
  const dB = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: cfgB,
    env: { PATH: `${join(cfgB, 'bin')}:/usr/bin:/bin`, HOME: cfgB, TG_CTL_CONFIG_DIR: cfgB, TG_API_BASE: `http://127.0.0.1:${srvB.port}` },
    logFd: fdB,
  });
  closeSync(fdB);
  await waitFor(() => {
    const storeB = JSON.parse(readFileSync(join(cfgB, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
    return storeB.find((x) => x.threadId === 401)?.status === 'bound';
  });
  const storeB = JSON.parse(readFileSync(join(cfgB, 'tg-ctl.123.topics.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(storeB.find((x) => x.threadId === 401)?.status).toBe('bound'); // adopted via the recorded paneId
  expect(storeB.find((x) => x.threadId === 401)?.paneId).toBe('%6'); // the EXACT recorded pane, not %5
  dB.kill('SIGTERM');
  await dB.exited;
}, 30_000);

test('increment 4: a route-time ps FLAKE (pane visible, no procs) does NOT falsely close a live bound topic (codex r24 P1a)', async () => {
  // A bound topic to %5 which IS in list-panes, but `ps` returns NOTHING (flaky read) → findAgentInPane
  // sees no agent. The route must NOT close + offer re-spawn (which a tap could double-spawn); it skips
  // with "try again" and stays bound.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-routeflake-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 410, name: 'routeflake', status: 'bound', paneId: '%5', path: cfgDir, model: 'claude-opus', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // list-panes reports %1 + the bound %5; ps returns NOTHING (flaky) → no agent matched anywhere.
  writeFileSync(
    join(cfgDir, 'bin', 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cfgDir}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%5' '4299' 'claude' 'routeflake' '' '${cfgDir}'
    ;;
  display-message) printf 'main\\n' ;;
  set-option) ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(cfgDir, 'bin', 'ps'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 }); // flaky: no procs
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon({ cfgDir, spawnLog, injectLog, failFlag: join(cfgDir, 'NOFAIL') }, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(420, 410, 'are you alive?', nowSec)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 410 && String(s.text).includes('try again')));
  await Bun.sleep(200);
  // NOT closed (would have offered a duplicatable re-spawn); stays bound, retryable.
  expect(topicsStore(cfgDir).find((t) => t.threadId === 410)?.status).toBe('bound');
  expect(sends.some((s) => String(s.text).includes('exited'))).toBe(false); // no dead-pane offer

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: the REAL dead case (agent exited to a shell, ps non-empty) DOES close + offer re-spawn (codex r26)', async () => {
  // The pane %5 IS visible but runs a SHELL (-zsh), and ps DOES return processes (non-empty) — none
  // under %5 is an agent. This is a genuine death (not a flake), so the route must close + offer a
  // re-spawn, NOT loop on "try again".
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-realdead-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 411, name: 'realdead', status: 'bound', paneId: '%5', path: cfgDir, model: 'claude-opus', respawnOffered: false, ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  // %5 runs pid 5000 (-zsh, a shell — NOT an agent); ps returns it (non-empty, no agent under %5).
  writeFileSync(
    join(cfgDir, 'bin', 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cfgDir}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%5' '5000' '-zsh' 'realdead' '' '${cfgDir}'
    ;;
  display-message) printf 'main\\n' ;;
  set-option) ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // ps NON-EMPTY: pid 4241 is the flat claude (%1), pid 5000 is the bare shell under %5 (no agent).
  writeFileSync(join(cfgDir, 'bin', 'ps'), `#!/bin/sh\nprintf '%s %s %s\\n' '4241' '1' 'claude'\nprintf '%s %s %s\\n' '5000' '1' '-zsh'\nexit 0\n`, { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon({ cfgDir, spawnLog, injectLog, failFlag: join(cfgDir, 'NOFAIL') }, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicTextMsg(421, 411, 'are you alive?', nowSec)]);
  // The agent genuinely exited → the binding closes and a re-spawn is offered (not a "try again" loop).
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 411 && t.status === 'closed'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 411)?.status).toBe('closed');
  await waitFor(() => sends.some((s) => s.message_thread_id === 411 && String(s.text).includes('exited')));
  expect(sends.some((s) => s.message_thread_id === 411 && String(s.text).includes('exited'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a JIT probe with AMBIGUOUS multi-pane token (no recorded paneId) REFUSES, does NOT double-spawn (codex r28)', async () => {
  // A spawnPending binding (no recorded paneId) + a model tap. The JIT probe sees the slug window with
  // TWO panes both exposing the token → ambiguous → reconcileOneTopic refuses. The JIT path must then
  // REFUSE (a candidate remains) rather than fall through to a second new-window.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-jitambig-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  // spawnPending + token, NO recorded paneId → token-only adoption, which is ambiguous in a 2-pane window.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 420, name: 'jitambig', status: 'awaiting-model', path: cfgDir, spawnPending: true, spawnToken: '420-1-1', ts: 1 }]),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxTwoPaneWindow(cfgDir, 'jitambig', '420-1-1', spawnLog, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWith([4241, 4299, 4300]), { mode: 0o755 });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon({ cfgDir, spawnLog, injectLog, failFlag: join(cfgDir, 'NOFAIL') }, server.port);

  updateQueue.push([modelTap(420, 420, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 420 && String(s.text).includes("can't confirm which pane")));
  await Bun.sleep(200);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // NO second new-window (would have double-spawned)
  expect(topicsStore(cfgDir).find((t) => t.threadId === 420)?.status).toBe('awaiting-model'); // still pending

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a spawnPending re-tap with NON-empty ps but NO orphan DOES spawn (no infinite "try again" loop, codex r29)', async () => {
  // spawnPending (e.g. crash BEFORE new-window) → no orphan window exists, but ps IS non-empty (the
  // flat %1 claude). The probe must NOT loop "couldn't read the session"; it falls through to a fresh
  // spawn (the genuine no-orphan case). The fake's normal spawn binds SPAWNED_PANE.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  // spawnPending + token, NO recorded paneId; the slug 'noorphan' has NO matching live window.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 430, name: 'noorphan', status: 'awaiting-model', path: cfgDir, spawnPending: true, spawnToken: '430-1-1', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // The default fakeTmux: list-panes reports %1 (claude) — no 'noorphan' window. ps is non-empty.
  updateQueue.push([modelTap(430, 430, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 430 && t.status === 'bound'));
  // It spawned (one new-window) and bound the returned pane — NOT stuck on "try again".
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 430)?.paneId).toBe(SPAWNED_PANE);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('increment 4: a spawnPending binding whose model is GONE from the catalog restarts the flow on a tap (codex r31)', async () => {
  // The pending model was removed/renamed since it was chosen. The mismatch guard would otherwise
  // reject every other valid tap and trap the binding. The catalog-validity check restarts the flow.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topics.json'),
    JSON.stringify([{ threadId: 440, name: 'goneModel', status: 'awaiting-model', path: cfgDir, model: 'removed-from-catalog', spawnPending: true, spawnToken: '440-1-1', ts: 1 }]),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  // Tap a VALID model → the pending model is invalid → restart the /new flow (awaiting-path), no spawn.
  updateQueue.push([modelTap(440, 440, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 440 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 440)?.status).toBe('awaiting-path'); // recovered
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // no spawn with the gone model
  await waitFor(() => sends.some((s) => s.message_thread_id === 440));
  expect(sends.some((s) => s.message_thread_id === 440)).toBe(true); // a fresh path prompt posted

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);
