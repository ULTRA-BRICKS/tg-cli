import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { parseTopics } from '../features/tg-ctl/topics';

// End-to-end private-chat forum topics (Bot API 9.4): the REAL daemon + a fake Telegram server.
// Exercises the `control.private_topics: true` path where a flat `/new` spawn calls
// `createForumTopic`, writes a `bound` TopicBinding, and spawns with TG_TOPIC stamped.
//
// Two main scenarios:
//   1. createForumTopic SUCCEEDS → daemon spawns via spawnTopicWindow (TG_TOPIC in argv),
//      writes a `bound` binding in the topics store, and the forum_topic_created echo is
//      silently swallowed (no re-flow started).
//   2. private topics are disabled for the bot (`getMe.has_topics_enabled=false`) → ask once
//      before falling back to plain spawnNewWindow.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SPAWNED_PANE = '%8';

// Every scenario boots at least one real daemon (two for the crash-adoption case) and waits on its
// lifecycle with 8s `waitFor` bounds; bun's 5s default would cut a slow-but-correct run short on a
// loaded CI runner before those waits could ever resolve.
setDefaultTimeout(30_000);

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];
const cfgDirs: string[] = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
  for (const d of cfgDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeTmux(cwd: string, spawnLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window)
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option) : ;;
  send-keys) : ;;
  load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

function fakeTmuxCrashAfterStamp(cwd: string, spawnLog: string, tokenFile: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    if [ -f '${tokenFile}' ]; then
      token="$(cat '${tokenFile}')"
      printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${SPAWNED_PANE}' '4248' 'claude' 'crashpt' "$token" '${cwd}'
    fi
    ;;
  display-message) printf 'main\\n' ;;
  new-window)
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option)
    if [ "$4" = '@tg_spawn_token' ]; then
      printf '%s' "$5" > '${tokenFile}'
      kill -9 "$PPID"
    fi
    ;;
  send-keys) : ;;
  load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '4241' '1' 'claude'
exit 0
`;
}

function fakePsWithOrphan(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '4241' '1' 'claude'
printf '%s %s %s\\n' '4248' '1' 'claude'
exit 0
`;
}

function makeCfgDir(privateTopics: boolean): { cfgDir: string; spawnLog: string } {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-pt-'));
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    `control:\n  enabled: true\n  private_topics: ${privateTopics}\n`,
  );
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: '%1', cwd: cfgDir }),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return { cfgDir, spawnLog };
}

function spawnArgvLog(spawnLog: string): string[] {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function textMsg(id: number, text: string): unknown {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec(),
      text,
    },
  };
}

function topicTextMsg(id: number, threadId: number, text: string): unknown {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec(),
      message_thread_id: threadId,
      is_topic_message: true,
      text,
    },
  };
}

function modelTap(id: number, token: string, modelId: string): unknown {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: id, chat: { id: 1 }, date: 0 },
      data: `tnm:${token}:${modelId}`,
    },
  };
}

function callbackTap(id: number, messageId: number, data: string, threadId?: number): unknown {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: 1, first_name: 'Alex' },
      message: {
        message_id: messageId,
        chat: { id: 1 },
        date: 0,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      },
      data,
    },
  };
}

// A forum_topic_created service message (Telegram echo after createForumTopic).
function forumTopicCreatedMsg(id: number, threadId: number, name: string): unknown {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec(),
      message_thread_id: threadId,
      is_topic_message: true,
      forum_topic_created: { name },
    },
  };
}

// Poll `pred` until it holds; THROW on timeout. A silent return let a timed-out wait fall through to
// the assertion after it, which reported a misleading "Received: <stale state>" instead of the wait
// that actually expired. `diag` appends context (e.g. the daemon log) to the timeout error.
async function waitFor(pred: () => boolean, ms = 8000, diag?: () => string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 >= ms) {
      throw new Error(`waitFor timed out after ${ms}ms: ${pred.toString()}${diag ? `\n${diag()}` : ''}`);
    }
    await Bun.sleep(50);
  }
}

const sent = (sends: Array<Record<string, unknown>>, needle: string): boolean =>
  sends.some((s) => String(s.text ?? '').includes(needle));

// --- Scenario 1: createForumTopic SUCCEEDS ---

test(
  'private_topics: createForumTopic succeeds → spawns with TG_TOPIC env, writes bound binding',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');
    writeFileSync(topicsFile, JSON.stringify([{ threadId: 77, name: 'source', status: 'bound', paneId: '%1', ts: nowSec() }]));

    // The server returns threadId=42 for createForumTopic; normal endpoints for spawn flow.
    const queue: unknown[][] = [[topicTextMsg(10, 77, `/new claude-default ${cfgDir} myproj`)]];
    const creates: Array<Record<string, unknown>> = [];
    const sends: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: true } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          const body = (await req.json()) as Record<string, unknown>;
          creates.push(body);
          return Response.json({ ok: true, result: { message_thread_id: 42, name: body.name } });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    // Wait for the spawn to happen (immediate: all args supplied).
    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    const argv = spawnArgvLog(spawnLog);

    // Should have spawned via spawnTopicWindow → TG_TOPIC in the argv.
    expect(argv.length).toBe(1);
    expect(argv[0]).toContain(`-e TG_TOPIC=42`);
    expect(argv[0]).toContain('-n myproj');
    expect(argv[0]).toContain(`-c ${cfgDir}`);

    // The `createForumTopic` call must have been made with the right chat_id + name.
    expect(creates.length).toBe(1);
    expect(creates[0].chat_id).toBe(1);
    expect(creates[0].name).toBe('myproj');

    // The topics store must carry a `bound` binding for threadId=42.
    await waitFor(
      () => existsSync(topicsFile) && parseTopics(readFileSync(topicsFile, 'utf8')).some((x) => x.threadId === 42 && x.status === 'bound'),
      4000,
    );
    const bindings = parseTopics(existsSync(topicsFile) ? readFileSync(topicsFile, 'utf8') : null);
    const b = bindings.find((x) => x.threadId === 42);
    expect(b).toBeDefined();
    expect(b?.status).toBe('bound');
    expect(b?.paneId).toBe(SPAWNED_PANE);
    expect(b?.name).toBe('myproj');
    expect(b?.model).toBe('claude-default');

    // Confirmation message sent.
    await waitFor(() => sent(sends, 'spawned `claude-default`'));
    expect(sent(sends, 'spawned `claude-default`')).toBe(true);
    const confirmations = sends.filter((s) => String(s.text ?? '').includes('spawned `claude-default`'));
    expect(confirmations.length).toBeGreaterThan(0);
    expect(confirmations.every((s) => s.message_thread_id === 77)).toBe(true);

    daemon.kill();
  },
);

test(
  'private_topics: opencode spawn keeps the initial task via --prompt',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const queue: unknown[][] = [[textMsg(15, `/new opencode-zai-glm-5.2 ${cfgDir} ocproj fix blank preview`)]];
    const sends: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: true } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({ ok: true, result: { message_thread_id: 43, name: body.name } });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    const argv = spawnArgvLog(spawnLog);
    expect(argv.length).toBe(1);
    expect(argv[0]).toContain('-e TG_TOPIC=43');
    expect(argv[0]).toContain('-n ocproj');
    expect(argv[0]).toContain('opencode --model zai/glm-5.2 --prompt=fix blank preview');

    daemon.kill();
  },
);

test(
  'private_topics: crash after new-window is adopted on restart, not double-spawned',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const tokenFile = join(cfgDir, 'spawn-token.txt');
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');
    writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxCrashAfterStamp(cfgDir, spawnLog, tokenFile), { mode: 0o755 });
    writeFileSync(join(cfgDir, 'bin', 'ps'), fakePsWithOrphan(), { mode: 0o755 });

    const queue: unknown[][] = [[textMsg(17, `/new claude-default ${cfgDir} crashpt`)]];
    const sends: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: true } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          return Response.json({ ok: true, result: { message_thread_id: 44, name: 'crashpt' } });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const crashed: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    const pendingBatchFile = join(cfgDir, 'tg-ctl.123.pending-batch.json');
    const readOr = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '(none)');
    const diag = (): string =>
      [`--- daemon.log ---`, readOr(join(cfgDir, 'daemon.log')), `--- spawn.log ---`, readOr(spawnLog), `--- topics ---`, readOr(topicsFile)].join('\n');

    // The fake tmux SIGKILLs the daemon right after stamping the spawn token (a crash between
    // new-window and the binding write). Wait for that death itself, not a sleep: the topics store
    // is only final once the crashed daemon is gone.
    await waitFor(() => crashed.signalCode !== null || crashed.exitCode !== null, 15_000, diag);
    expect(existsSync(tokenFile)).toBe(true);
    // The crash landed mid-batch, so the `/new` update is still journaled for replay on restart.
    expect(existsSync(pendingBatchFile)).toBe(true);

    const pending = parseTopics(readFileSync(topicsFile, 'utf8')).find((b) => b.threadId === 44);
    expect(pending?.status).toBe('awaiting-model');
    expect(pending?.spawnPending).toBe(true);
    expect(pending?.spawnToken).toBe(readFileSync(tokenFile, 'utf8'));
    expect(pending?.sourceChatId).toBe(1);
    expect(pending?.sourceMessageId).toBe(17);
    expect(pending?.paneId).toBeUndefined();

    const restartedLogFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const restarted: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd: restartedLogFd,
    });
    closeSync(restartedLogFd);

    // Startup reconcile adopts the orphan, THEN the restarted daemon replays the journaled batch —
    // which still holds the `/new` that crashed. The journal is unlinked only once that replay has
    // fully run, so its disappearance is the end-of-recovery event. Asserting at the first `bound`
    // sighting instead raced the replay: a re-run `/new` re-created the topic and spawned again.
    const restartDiag = (): string => `restarted exitCode=${restarted.exitCode} signal=${restarted.signalCode}\n${diag()}`;
    await waitFor(() => readOr(join(cfgDir, 'daemon.log')).includes('topic 44: adopting orphan pane %8'), 8000, restartDiag);
    await waitFor(() => !existsSync(pendingBatchFile), 8000, restartDiag);
    expect(readOr(join(cfgDir, 'daemon.log'))).toContain('already created topic 44');
    // The crash beat the first run's "spawned …" reply; the skipped replay still tells the user.
    await waitFor(() => sends.some((s) => String(s.text).includes('recovered after a daemon restart')), 8000, restartDiag);

    const rebound = parseTopics(readFileSync(topicsFile, 'utf8')).find((b) => b.threadId === 44);
    expect(rebound?.status).toBe('bound');
    expect(rebound?.paneId).toBe(SPAWNED_PANE);
    expect(spawnArgvLog(spawnLog)).toHaveLength(1);
    expect(restarted.signalCode).toBeNull();

    restarted.kill();
  },
);

// --- Scenario 2: private topics disabled (ask once before graceful fallback) ---

test(
  'private_topics: getMe.has_topics_enabled=false → asks once before flat fallback',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');
    writeFileSync(topicsFile, JSON.stringify([{ threadId: 77, name: 'source', status: 'bound', paneId: '%1', ts: nowSec() }]));

    // The first probe reports private-topic mode disabled, exactly like the live bot did.
    // Later probes would report true: after the user explicitly taps Continue without topics,
    // that choice must still be honored for this daemon run instead of racing into topic creation.
    const queue: unknown[][] = [[topicTextMsg(20, 77, `/new claude-default ${cfgDir} flatproj`)]];
    const sends: Array<Record<string, unknown>> = [];
    let getMeCalls = 0;
    let createTopicCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          getMeCalls += 1;
          return Response.json({
            ok: true,
            result: {
              id: 123,
              is_bot: true,
              username: 'bot',
              has_topics_enabled: getMeCalls === 1 ? false : true,
              allows_users_to_create_topics: false,
            },
          });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          createTopicCalls += 1;
          return Response.json({ ok: false, description: 'unexpected createForumTopic' }, { status: 500 });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    await waitFor(() => sent(sends, 'Continue without topic routing?'));
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);
    const prompts = sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].message_thread_id).toBe(77);
    const promptMarkup = prompts[0].reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const continueData = promptMarkup?.inline_keyboard?.flat().find((b) => b.callback_data?.includes(':continue'))?.callback_data;
    expect(continueData).toBeTruthy();

    queue.push([topicTextMsg(21, 77, `/new claude-default ${cfgDir} pending-second`)]);
    await waitFor(() => sent(sends, 'private-topic fallback choice is already open'));
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);
    expect(sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'))).toHaveLength(1);

    queue.push([callbackTap(22, Number(prompts[0].message_id ?? 901), continueData!, 77)]);

    // Answering the one-time prompt continues the original /new as a flat spawn.
    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    const argv = spawnArgvLog(spawnLog);

    // Flat fallback: NO TG_TOPIC in the spawn argv.
    expect(argv.length).toBe(1);
    expect(argv[0]).not.toContain('TG_TOPIC');
    expect(argv[0]).toContain('-n flatproj');
    expect(argv[0]).toContain(`-c ${cfgDir}`);

    // NO new binding written in the topics store.
    const bindings = parseTopics(readFileSync(topicsFile, 'utf8'));
    expect(bindings.filter((b) => b.threadId !== 77)).toHaveLength(0);
    expect(getMeCalls).toBe(1);
    expect(createTopicCalls).toBe(0);

    // Confirmation message still sent (graceful — user gets their agent regardless).
    await waitFor(() => sent(sends, 'spawned `claude-default`'));
    expect(sent(sends, 'spawned `claude-default`')).toBe(true);
    const confirmations = sends.filter((s) => String(s.text ?? '').includes('spawned `claude-default`'));
    expect(confirmations.every((s) => s.message_thread_id === 77)).toBe(true);

    queue.push([topicTextMsg(23, 77, `/new claude-default ${cfgDir} second`)]);
    await waitFor(() => spawnArgvLog(spawnLog).length === 2);
    expect(spawnArgvLog(spawnLog)).toHaveLength(2);
    expect(getMeCalls).toBe(1);
    const promptsAfterSecond = sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'));
    expect(promptsAfterSecond).toHaveLength(1);

    daemon.kill();
  },
);

test(
  'private_topics: cancelling disabled-topic fallback does not authorize later flat spawn',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const queue: unknown[][] = [[textMsg(24, `/new claude-default ${cfgDir} cancelme`)]];
    const sends: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: false } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          return Response.json({ ok: false, description: 'unexpected createForumTopic' }, { status: 500 });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    await waitFor(() => sent(sends, 'Continue without topic routing?'));
    const prompts = sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'));
    const promptMarkup = prompts[0].reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const cancelData = promptMarkup?.inline_keyboard?.flat().find((b) => b.callback_data?.includes(':cancel'))?.callback_data;
    expect(cancelData).toBeTruthy();
    queue.push([callbackTap(25, Number(prompts[0].message_id ?? 901), cancelData!)]);

    await waitFor(() => sent(sends, 'cancelled — no agent was spawned'));
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);

    queue.push([textMsg(26, `/new claude-default ${cfgDir} retry`)]);
    await waitFor(() => sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?')).length === 2);
    expect(sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'))).toHaveLength(2);
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);

    daemon.kill();
  },
);

test(
  'private_topics: a stale (already-consumed) fallback tap does not clobber a different session\'s live pending choice',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const queue: unknown[][] = [[textMsg(30, `/new claude-default ${cfgDir} first`)]];
    const sends: Array<Record<string, unknown>> = [];
    const answers: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: false } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          return Response.json({ ok: false, description: 'unexpected createForumTopic' }, { status: 500 });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) {
          const body = (await req.json()) as Record<string, unknown>;
          answers.push(String(body.text ?? ''));
          return Response.json({ ok: true, result: true });
        }
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    // Session A: fallback prompt, then CANCELLED (the legitimate way a token stops being live).
    await waitFor(() => sent(sends, 'Continue without topic routing?'));
    const promptA = sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'))[0];
    const markupA = promptA.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const staleContinueData = markupA?.inline_keyboard?.flat().find((b) => b.callback_data?.includes(':continue'))?.callback_data;
    const cancelDataA = markupA?.inline_keyboard?.flat().find((b) => b.callback_data?.includes(':cancel'))?.callback_data;
    expect(staleContinueData).toBeTruthy();
    expect(cancelDataA).toBeTruthy();

    queue.push([callbackTap(31, Number(promptA.message_id ?? 901), cancelDataA!)]);
    await waitFor(() => sent(sends, 'cancelled — no agent was spawned'));
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);
    expect(answers).toEqual(['cancelled']);

    // Session B: a FRESH /new re-asks (state reset to "unknown" by the cancel above) and is now
    // the one legitimate pending fallback decision.
    queue.push([textMsg(32, `/new claude-default ${cfgDir} second`)]);
    await waitFor(() => sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?')).length === 2);
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);

    // Replay the STALE token from the already-cancelled session A (e.g. a duplicate Telegram
    // delivery, or the user tapping session A's dangling keyboard). Its session is gone, so this
    // must hit the "expired" branch WITHOUT touching session B's live "pending" decision.
    queue.push([callbackTap(33, Number(promptA.message_id ?? 901), staleContinueData!)]);
    await waitFor(() => answers.length === 2);
    expect(answers[1]).toBe('expired — run /new again');
    expect(spawnArgvLog(spawnLog)).toHaveLength(0);

    // Session B must STILL be protected: a third /new must see "already open", not silently
    // clobber B (the bug: the stale tap wrongly reset the global state, so this guard was
    // skipped and B's live prompt was discarded out from under the user).
    queue.push([textMsg(34, `/new claude-default ${cfgDir} third`)]);
    await waitFor(() => sent(sends, 'private-topic fallback choice is already open'));
    expect(sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'))).toHaveLength(2);

    // Session B's own prompt still answers normally afterwards — it was never corrupted.
    const promptB = sends.filter((s) => String(s.text ?? '').includes('Continue without topic routing?'))[1];
    const markupB = promptB.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const continueDataB = markupB?.inline_keyboard?.flat().find((b) => b.callback_data?.includes(':continue'))?.callback_data;
    expect(continueDataB).toBeTruthy();
    queue.push([callbackTap(35, Number(promptB.message_id ?? 902), continueDataB!)]);
    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    expect(spawnArgvLog(spawnLog)).toHaveLength(1);
    expect(spawnArgvLog(spawnLog)[0]).toContain('-n second');

    daemon.kill();
  },
);

test(
  'private_topics: createForumTopic failure warning does not invent has_topics_enabled=false',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');
    const queue: unknown[][] = [[textMsg(21, `/new claude-default ${cfgDir} apierr`)]];
    const sends: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: true } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          return Response.json(
            { ok: false, error_code: 400, description: 'Bad Request: topic quota exceeded' },
            { status: 400 },
          );
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    await waitFor(() => sent(sends, 'topic quota exceeded'));
    expect(sent(sends, 'Telegram Bot API rejected `createForumTopic`: Bad Request: topic quota exceeded')).toBe(true);
    expect(sent(sends, '{"ok":false')).toBe(false);
    expect(sent(sends, 'getMe.has_topics_enabled=false')).toBe(false);
    expect(sent(sends, 'This chat does not need to be converted to a forum')).toBe(true);
    await waitFor(() => sent(sends, 'spawned `claude-default`'));
    expect(sent(sends, 'spawned `claude-default`')).toBe(true);
    if (existsSync(topicsFile)) {
      expect(parseTopics(readFileSync(topicsFile, 'utf8'))).toHaveLength(0);
    }

    daemon.kill();
  },
);

test(
  'private_topics: getMe failure still tries createForumTopic and reports that API error',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');
    const queue: unknown[][] = [[textMsg(22, `/new claude-default ${cfgDir} getme-fails`)]];
    const sends: Array<Record<string, unknown>> = [];
    let createTopicCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' }, { status: 500 });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          createTopicCalls += 1;
          return Response.json(
            { ok: false, error_code: 400, description: 'Bad Request: private topics not available' },
            { status: 400 },
          );
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 950 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    await waitFor(() => sent(sends, 'private topics not available'));
    expect(createTopicCalls).toBe(1);
    expect(sent(sends, 'Telegram Bot API rejected `createForumTopic`: Bad Request: private topics not available')).toBe(true);
    expect(sent(sends, 'getMe.has_topics_enabled=false')).toBe(false);
    await waitFor(() => sent(sends, 'spawned `claude-default`'));
    expect(sent(sends, 'spawned `claude-default`')).toBe(true);
    if (existsSync(topicsFile)) {
      expect(parseTopics(readFileSync(topicsFile, 'utf8'))).toHaveLength(0);
    }

    daemon.kill();
  },
);

// --- Scenario 3: forum_topic_created echo is silently swallowed ---

test(
  'private_topics: forum_topic_created echo after createForumTopic does NOT restart /new flow',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(true);

    // First: /new + immediate spawn; then: the Telegram echo arrives.
    const queue: unknown[][] = [
      [textMsg(30, `/new claude-default ${cfgDir} echotest`)],
    ];
    const sends: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/getUpdates')) {
          const batch = queue.shift();
          if (batch) return Response.json({ ok: true, result: batch });
          await Bun.sleep(60);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith('/getMe')) {
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: true } });
        }
        if (url.pathname.endsWith('/createForumTopic')) {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({ ok: true, result: { message_thread_id: 77, name: body.name } });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          sends.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
        }
        if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
        if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
        return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(server);

    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    const daemon: Subprocess = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    // Wait for spawn.
    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    expect(spawnArgvLog(spawnLog)[0]).toContain('TG_TOPIC=77');

    // Now deliver the forum_topic_created echo as a subsequent poll batch.
    queue.push([forumTopicCreatedMsg(31, 77, 'echotest')]);

    // Wait for the "spawned" send to land (the main flow reply).
    await waitFor(() => sent(sends, 'spawned `claude-default`'));

    // Wait a bit more for the echo batch to be processed.
    await Bun.sleep(500);

    // The echo must NOT trigger a second spawn or a "path" question.
    expect(spawnArgvLog(spawnLog).length).toBe(1); // only ONE spawn
    expect(sends.every((s) => !String(s.text ?? '').includes('Which directory'))).toBe(true);

    daemon.kill();
  },
);

// --- Unit-level: parseControlConfig + resolveControlConfig handles private_topics ---

import { parseControlConfig, resolveControlConfig } from '../features/tg-ctl/config';
import { DEFAULT_CONTROL } from '../features/tg-ctl/types';

test('parseControlConfig parses private_topics flag with the same token sets as topics', () => {
  for (const v of ['true', 'yes', 'on', '1']) {
    expect(parseControlConfig(`control:\n  private_topics: ${v}\n`)).toEqual({
      privateTopics: true,
    });
  }
  for (const v of ['false', 'no', 'off', '0']) {
    expect(parseControlConfig(`control:\n  private_topics: ${v}\n`)).toEqual({
      privateTopics: false,
    });
  }
  expect(parseControlConfig('control:\n  private_topics: maybe\n')).toEqual({}); // unrecognized → ignore
});

test('resolveControlConfig: privateTopics defaults OFF and an explicit true flows through', () => {
  expect(resolveControlConfig({}).privateTopics).toBe(false);
  expect(resolveControlConfig({ privateTopics: true }).privateTopics).toBe(true);
});

test('resolveControlConfig of an empty partial includes privateTopics: false', () => {
  expect(resolveControlConfig({})).toEqual(DEFAULT_CONTROL);
});
