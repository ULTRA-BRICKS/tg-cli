import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { parseTopics } from '../features/tg-ctl/topics';

// End-to-end private-chat forum topics (Bot API 9.4): the REAL daemon + a fake Telegram server.
// Exercises the default-on private topic path where a flat `/new` spawn calls
// `createForumTopic`, writes a `bound` TopicBinding, and spawns with TG_TOPIC stamped.
//
// Two main scenarios:
//   1. createForumTopic SUCCEEDS → daemon spawns via spawnTopicWindow (TG_TOPIC in argv),
//      writes a `bound` binding in the topics store, and the forum_topic_created echo is
//      silently swallowed (no re-flow started).
//   2. createForumTopic FAILS (API error / unsupported account) → graceful fallback to plain
//      spawnNewWindow (no TG_TOPIC, no binding written, same success message).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SPAWNED_PANE = '%8';

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];
const cfgDirs: string[] = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
  for (const d of cfgDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeTmux(cwd: string, spawnLog: string, injectLog: string, failFlag = ''): string {
  return `#!/bin/sh
fail_flag='${failFlag}'
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window)
    if [ -n "$fail_flag" ] && [ -f "$fail_flag" ]; then
      rm -f "$fail_flag"
      echo 'no current session' >&2
      exit 1
    fi
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option) : ;;
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

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '4241' '1' 'claude'
exit 0
`;
}

function makeCfgDir(privateTopics?: boolean): { cfgDir: string; spawnLog: string; injectLog: string; failFlag: string } {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-pt-'));
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  const failFlag = join(cfgDir, 'FAIL_SPAWN');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  const privateTopicsLine =
    privateTopics === undefined ? '' : `  private_topics: ${privateTopics}\n`;
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n${privateTopicsLine}`);
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: '%1', cwd: cfgDir }),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog, injectLog, failFlag), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return { cfgDir, spawnLog, injectLog, failFlag };
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

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

const sent = (sends: Array<Record<string, unknown>>, needle: string): boolean =>
  sends.some((s) => String(s.text ?? '').includes(needle));

const injected = (injectLog: string): string =>
  existsSync(injectLog) ? readFileSync(injectLog, 'utf8') : '';

// --- Scenario 1: createForumTopic SUCCEEDS ---

test(
  'private_topics: createForumTopic succeeds → spawns with TG_TOPIC env, writes bound binding',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir();
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');

    // The server returns threadId=42 for createForumTopic; normal endpoints for spawn flow.
    const queue: unknown[][] = [[textMsg(10, `/new claude-default ${cfgDir} myproj --continue please`)]];
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
    expect(argv[0]).toContain('-- --continue please');

    // The `createForumTopic` call must have been made with the right chat_id + name.
    expect(creates.length).toBe(1);
    expect(creates[0].chat_id).toBe(1);
    expect(creates[0].name).toBe('myproj');

    // The topics store must carry a `bound` binding for threadId=42.
    await waitFor(() => existsSync(topicsFile), 4000);
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
    expect(sent(sends, 'with task: --continue please')).toBe(true);

    daemon.kill();
  },
);

test(
  'private_topics default: untracked forum-topic prose falls through to the flat pane',
  async () => {
    const { cfgDir, spawnLog, injectLog } = makeCfgDir();
    const queue: unknown[][] = [[topicTextMsg(15, 501, 'legacy forum text')]];
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
        if (url.pathname.endsWith('/createForumTopic')) {
          creates.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_thread_id: 99 } });
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

    await waitFor(() => injected(injectLog).includes('[TG from Alex tg#15] legacy forum text'));
    expect(injected(injectLog)).toContain('[TG from Alex tg#15] legacy forum text');
    expect(spawnArgvLog(spawnLog)).toEqual([]);
    expect(creates.length).toBe(0);

    daemon.kill();
  },
);

test(
  'private_topics: spawn failure retry reuses the created topic instead of creating another',
  async () => {
    const { cfgDir, spawnLog, failFlag } = makeCfgDir();
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');
    writeFileSync(failFlag, '1');

    const queue: unknown[][] = [
      [textMsg(16, `/new claude-default ${cfgDir} retryproj`)],
      [modelTap(17, 'n1', 'claude-default')],
    ];
    let nextThreadId = 42;
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
        if (url.pathname.endsWith('/createForumTopic')) {
          const body = (await req.json()) as Record<string, unknown>;
          creates.push(body);
          return Response.json({ ok: true, result: { message_thread_id: nextThreadId++, name: body.name } });
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

    await waitFor(() => sent(sends, "couldn't start the agent"));
    await waitFor(() => spawnArgvLog(spawnLog).length === 1);

    expect(creates).toHaveLength(1);
    expect(spawnArgvLog(spawnLog)[0]).toContain('TG_TOPIC=42');
    const bindings = parseTopics(existsSync(topicsFile) ? readFileSync(topicsFile, 'utf8') : null);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      threadId: 42,
      status: 'bound',
      paneId: SPAWNED_PANE,
      model: 'claude-default',
      name: 'retryproj',
    });

    daemon.kill();
  },
);

// --- Scenario 2: createForumTopic FAILS (graceful fallback) ---

test(
  'private_topics: createForumTopic fails → falls back to flat spawn, NO topic binding written',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir();
    const topicsFile = join(cfgDir, 'tg-ctl.123.topics.json');

    // The server returns an API error for createForumTopic.
    const queue: unknown[][] = [[textMsg(20, `/new claude-default ${cfgDir} flatproj`)]];
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
        if (url.pathname.endsWith('/createForumTopic')) {
          // Simulate Telegram rejecting createForumTopic → API error.
          return Response.json(
            { ok: false, description: 'FORUM_NOT_ENABLED' },
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

    // Wait for flat spawn to happen.
    await waitFor(() => spawnArgvLog(spawnLog).length > 0);
    const argv = spawnArgvLog(spawnLog);

    // Flat fallback: NO TG_TOPIC in the spawn argv.
    expect(argv.length).toBe(1);
    expect(argv[0]).not.toContain('TG_TOPIC');
    expect(argv[0]).toContain('-n flatproj');
    expect(argv[0]).toContain(`-c ${cfgDir}`);

    // NO binding written in the topics store.
    await Bun.sleep(300);
    if (existsSync(topicsFile)) {
      const bindings = parseTopics(readFileSync(topicsFile, 'utf8'));
      expect(bindings.length).toBe(0);
    }
    // (topics file may not exist at all if nothing was written — both outcomes are correct)

    // Confirmation message still sent (graceful — user gets their agent regardless).
    await waitFor(() => sent(sends, 'spawned `claude-default`'));
    expect(sent(sends, 'spawned `claude-default`')).toBe(true);

    daemon.kill();
  },
);

// --- Scenario 3: forum_topic_created echo is silently swallowed ---

test(
  'private_topics: forum_topic_created echo after createForumTopic does NOT restart /new flow',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir();

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

test(
  'private_topics: explicit false opts out of createForumTopic and keeps flat /new',
  async () => {
    const { cfgDir, spawnLog } = makeCfgDir(false);

    const queue: unknown[][] = [[textMsg(40, `/new claude-default ${cfgDir} explicitflat`)]];
    const creates: Array<Record<string, unknown>> = [];
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
        if (url.pathname.endsWith('/createForumTopic')) {
          creates.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, result: { message_thread_id: 42 } });
        }
        if (url.pathname.endsWith('/sendMessage')) {
          return Response.json({ ok: true, result: { message_id: 900 } });
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
    expect(argv[0]).not.toContain('TG_TOPIC');
    expect(creates.length).toBe(0);

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

test('resolveControlConfig: privateTopics defaults ON and an explicit false opts out', () => {
  expect(resolveControlConfig({}).privateTopics).toBe(true);
  expect(resolveControlConfig({ privateTopics: true }).privateTopics).toBe(true);
  expect(resolveControlConfig({ privateTopics: false }).privateTopics).toBe(false);
});

test('resolveControlConfig of an empty partial includes privateTopics: true', () => {
  expect(resolveControlConfig({})).toEqual(DEFAULT_CONTROL);
});
