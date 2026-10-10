// A real tg-ctl daemon against a fake Bot API with a seeded session registry, for the
// one-topic-per-session paths (docs/specs/session-registry-and-topics.md §4). tmux and `ps` are
// PATH shims fed from panes.txt / procs.txt, so a registry scan sees exactly what a test writes.
// A live entry whose pid is in procs.txt while tmux lists no panes stays as written: every scan
// is untrusted.
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server, Subprocess } from 'bun';
import { expect } from 'bun:test';
import { parseRegistry, serializeRegistry } from '../../features/tg-ctl/session-registry-store';
import type { SessionEntry } from '../../features/tg-ctl/session-registry';

export const TG_CTL = join(import.meta.dir, '..', '..', 'tg-ctl');
export const SERVER_PID = 4242;

export interface TopicFixture {
  cfgDir: string;
  sessionsPath: string;
  topicsPath: string;
}

const fixtureDirs: string[] = [];

// Removes every fixture dir this process made; call from the suite's afterAll, after its
// daemons are dead.
export function removeTopicFixtures(): void {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeTopicFixture(sessions: SessionEntry[], opts: { chatId?: number; config?: string } = {}): TopicFixture {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-topic-'));
  fixtureDirs.push(cfgDir);
  writeFileSync(join(cfgDir, '.env'), `TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=${opts.chatId ?? -100123}\n`);
  writeFileSync(join(cfgDir, 'config.yaml'), opts.config ?? 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  writeFileSync(join(cfgDir, 'panes.txt'), '');
  writeFileSync(join(cfgDir, 'procs.txt'), '');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  // tmux: the server pid, the pane list from panes.txt, a send-keys log, nothing else.
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/sh
echo "$*" >> "${cfgDir}/tmux.log"
case "$1" in
  display-message) echo ${SERVER_PID} ;;
  list-panes) case "$4" in *pane_title*) ;; *) cat "${cfgDir}/panes.txt" ;; esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const realPs = Bun.which('ps') ?? '/bin/ps';
  writeFileSync(
    join(bin, 'ps'),
    `#!/bin/sh
"${realPs}" "$@"
code=$?
if [ "$*" = "-axo pid=,ppid=,command=" ]; then cat "${cfgDir}/procs.txt"; fi
exit $code
`,
    { mode: 0o755 },
  );
  const sessionsPath = join(cfgDir, 'tg-ctl.123.sessions.json');
  const migrated = { routes: '2026-01-01T00:00:00.000Z', registration: '2026-01-01T00:00:00.000Z', lastUserTarget: '2026-01-01T00:00:00.000Z', topics: '2026-01-01T00:00:00.000Z' };
  writeFileSync(sessionsPath, serializeRegistry({ schemaVersion: 2, migrated, sessions }));
  return { cfgDir, sessionsPath, topicsPath: join(cfgDir, 'tg-ctl.123.topics.json') };
}

export function ccEntry(sessionId: string, over: Partial<SessionEntry>): SessionEntry {
  const now = new Date().toISOString();
  return {
    key: `cc:${sessionId}`,
    harness: 'cc',
    sessionId,
    sessionFile: null,
    locators: { pid: null, tmux: null, durableSession: null },
    cwd: '/tmp',
    name: { primary: 'alpha', secondary: null },
    aliases: [],
    threadId: null,
    topicMisses: null,
    state: 'live',
    firstSeen: now,
    lastSeen: now,
    ...over,
  };
}

export const entryOf = (fx: TopicFixture, key: string): SessionEntry | undefined =>
  parseRegistry(readFileSync(fx.sessionsPath, 'utf8')).sessions.find((e) => e.key === key);

export interface FakeTopicApi {
  port: number;
  // Every sendMessage body, and the ones the fake accepted.
  sent: Record<string, unknown>[];
  delivered: Record<string, unknown>[];
  // Every other method call, by method name.
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  createdTopics: number;
  // How a send INTO a thread answers: accepted, rejected as a missing thread, or the topic is deleted.
  threadMode: 'ok' | 'not-found' | 'deleted';
  // getUpdates batches, served in order.
  updates: unknown[][];
  stop: () => void;
}

export function startTopicApi(firstThreadId: number): FakeTopicApi {
  let nextMessageId = 100;
  let server: Server | null = null;
  const api: FakeTopicApi = {
    port: 0, sent: [], delivered: [], calls: [], createdTopics: 0, threadMode: 'ok', updates: [],
    stop: () => server?.stop(true),
  };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      if (method === 'getUpdates') {
        const batch = api.updates.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        // An idle long-poll: a real daemon polls again at once, so pace it.
        await Bun.sleep(50);
        return Response.json({ ok: true, result: [] });
      }
      const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (method === 'createForumTopic') {
        api.calls.push({ method, body });
        const threadId = firstThreadId + api.createdTopics;
        api.createdTopics++;
        return Response.json({ ok: true, result: { message_thread_id: threadId, name: 'x', icon_color: 0 } });
      }
      if (method === 'sendMessage') {
        api.sent.push(body);
        if (body.message_thread_id !== undefined && api.threadMode !== 'ok') {
          const description = api.threadMode === 'deleted' ? 'Bad Request: TOPIC_ID_INVALID' : 'Bad Request: message thread not found';
          return Response.json({ ok: false, error_code: 400, description }, { status: 400 });
        }
        api.delivered.push(body);
        return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
      }
      api.calls.push({ method, body });
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123, is_bot: true, first_name: 'bot', has_topics_enabled: true } });
      return Response.json({ ok: true, result: true });
    },
  });
  api.port = server.port;
  return api;
}

export function topicEnv(fx: TopicFixture, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${join(fx.cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: fx.cfgDir,
    TG_CTL_CONFIG_DIR: fx.cfgDir,
    TG_API_BASE: `http://127.0.0.1:${port}`,
    ...extra,
  };
}

export async function startTopicDaemon(fx: TopicFixture, port: number, procs: Subprocess[], extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  const logFd = openSync(join(fx.cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: topicEnv(fx, port, extraEnv),
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(fx.cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
  return daemon;
}

// Polls: the conditions are side effects of a separate daemon process, with no signal to await.
export async function waitFor<T>(what: string, probe: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const got = probe();
    if (got) return got;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
