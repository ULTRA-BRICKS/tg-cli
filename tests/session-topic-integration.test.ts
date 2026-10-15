import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Server, Subprocess } from 'bun';
import { parseRegistry, serializeRegistry } from '../features/tg-ctl/session-registry-store';
import type { SessionEntry } from '../features/tg-ctl/session-registry';
import { tempDir, trackChild } from './helpers/test-temp';
import { parseTopics } from '../features/tg-ctl/topics';
import { INBOX_TOPIC_NAME } from '../features/tg-ctl/question-inbox';

// End-to-end paths of one-topic-per-session (tg-cli#467, docs/specs/session-registry-and-topics.md
// §4.2–§4.5) against a real daemon and a fake Bot API: a question card creates its session's topic
// on first use and is threaded into it; a rejected thread falls back to General with a notice; a
// deleted topic is recreated on the next card; and a session that comes back (resume) is re-adopted
// into its old topic with a "reattached" post. tmux and `ps` are PATH shims fed from files, so the
// registry scan sees exactly the panes and processes each test writes.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SERVER_PID = 4242;

const procs: Subprocess[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const s of servers) s.stop(true);
});

interface Fixture {
  cfgDir: string;
  sessionsPath: string;
  topicsPath: string;
}

function makeFixture(sessions: SessionEntry[]): Fixture {
  const cfgDir = tempDir('tgctl-session-topic-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=-100123\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  writeFileSync(join(cfgDir, 'panes.txt'), '');
  writeFileSync(join(cfgDir, 'procs.txt'), '');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  // tmux: the server pid, the pane list from panes.txt, nothing else (no titles).
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/sh
case "$1" in
  display-message) echo ${SERVER_PID} ;;
  list-panes) case "$4" in *pane_title*) ;; *) cat "${cfgDir}/panes.txt" ;; esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // ps: the real process table plus the fake agent processes in procs.txt.
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

function ccEntry(sessionId: string, over: Partial<SessionEntry>): SessionEntry {
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

interface FakeApi {
  port: number;
  // Every sendMessage body, and the ones the fake accepted.
  sent: Record<string, unknown>[];
  delivered: Record<string, unknown>[];
  createdTopics: number;
  // How a send INTO a thread answers: accepted, rejected as a missing thread, or the topic is deleted.
  threadMode: 'ok' | 'not-found' | 'deleted';
  // Every send into the 📥 Inbox topic (tg-cli#705/#717), kept apart from the session-topic ones.
  inbox: Record<string, unknown>[];
  // The Inbox topic was deleted by hand: sends into it fail until the daemon creates it again.
  inboxDeleted: boolean;
  inboxCreates: number;
}

const INBOX_THREAD = 9_999;

function startApi(firstThreadId: number): FakeApi {
  const api: FakeApi = { port: 0, sent: [], delivered: [], createdTopics: 0, threadMode: 'ok', inbox: [], inboxDeleted: false, inboxCreates: 0 };
  let nextMessageId = 100;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop();
      if (method === 'getUpdates') {
        // An idle long-poll: a real daemon polls again at once, so pace it.
        await Bun.sleep(50);
        return Response.json({ ok: true, result: [] });
      }
      if (method === 'createForumTopic') {
        // The 📥 Inbox topic (tg-cli#705) is not a session topic: it is answered but never
        // counted, and what is posted into it never reaches the session-topic bookkeeping below.
        const body = (await req.json()) as Record<string, unknown>;
        if (body.name === INBOX_TOPIC_NAME) {
          api.inboxCreates++;
          api.inboxDeleted = false;
          return Response.json({ ok: true, result: { message_thread_id: INBOX_THREAD, name: body.name, icon_color: 0 } });
        }
        const threadId = firstThreadId + api.createdTopics;
        api.createdTopics++;
        return Response.json({ ok: true, result: { message_thread_id: threadId, name: 'x', icon_color: 0 } });
      }
      if (method === 'sendMessage') {
        const body = (await req.json()) as Record<string, unknown>;
        if (body.message_thread_id === INBOX_THREAD) {
          if (api.inboxDeleted) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: TOPIC_ID_INVALID' }, { status: 400 });
          api.inbox.push(body);
          return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
        }
        api.sent.push(body);
        if (body.message_thread_id !== undefined && api.threadMode !== 'ok') {
          const description = api.threadMode === 'deleted' ? 'Bad Request: TOPIC_ID_INVALID' : 'Bad Request: message thread not found';
          return Response.json({ ok: false, error_code: 400, description }, { status: 400 });
        }
        api.delivered.push(body);
        return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  api.port = server.port;
  return api;
}

async function startDaemon(fx: Fixture, port: number): Promise<void> {
  const logFd = openSync(join(fx.cfgDir, 'daemon.log'), 'a');
  const daemon = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(fx.cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: fx.cfgDir,
      TG_CTL_CONFIG_DIR: fx.cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', logFd, logFd],
  }));
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(fx.cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
}

// A cc question hook from pane `paneId` of session `sessionId`. It blocks for the answer; the
// caller kills it once the card is out.
function startAsk(fx: Fixture, port: number, requestId: string, sessionId: string, paneId: string): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: fx.cfgDir, TG_CTL_CONFIG_DIR: fx.cfgDir, TG_API_BASE: `http://127.0.0.1:${port}`, TMUX_PANE: paneId },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  procs.push(ask);
  ask.stdin.write(
    `${JSON.stringify({
      requestId,
      agent: 'claude',
      kind: 'question',
      title: `Question ${requestId}`,
      question: `Pick one for ${requestId}?`,
      options: [{ label: 'A' }, { label: 'B' }],
      origin: { sessionId },
      cwd: fx.cfgDir,
    })}\n`,
  );
  ask.stdin.end();
  return ask;
}

// Polls: the conditions are side effects of a separate daemon process, with no signal to await.
async function waitFor<T>(what: string, probe: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const got = probe();
    if (got) return got;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const cards = (api: FakeApi): Record<string, unknown>[] => api.delivered.filter((m) => m.reply_markup !== undefined);
const cardFor = (api: FakeApi, requestId: string): Record<string, unknown> | undefined =>
  cards(api).find((m) => String(m.text).includes(`Pick one for ${requestId}?`));
const entryOf = (fx: Fixture, key: string): SessionEntry | undefined =>
  parseRegistry(readFileSync(fx.sessionsPath, 'utf8')).sessions.find((e) => e.key === key);

async function askAndGetCard(fx: Fixture, api: FakeApi, requestId: string, sessionId: string, paneId: string): Promise<Record<string, unknown>> {
  const ask = startAsk(fx, api.port, requestId, sessionId, paneId);
  const card = await waitFor(`card ${requestId}`, () => cardFor(api, requestId));
  ask.kill(9);
  await ask.exited;
  return card;
}

test('a session card creates its topic once, threads into it, falls back to General, and recreates a deleted topic', async () => {
  // The session's agent (pid 99991) is alive in the fake process table while tmux lists no panes,
  // so every registry scan is untrusted and the seeded live entry stays as written.
  const fx = makeFixture([
    ccEntry('sess1', { locators: { pid: 99991, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99990 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  const api = startApi(42);
  await startDaemon(fx, api.port);

  // First card: the topic is created and the card goes into it; registry + topics.json follow.
  const first = await askAndGetCard(fx, api, 'q1', 'sess1', '%5');
  expect(first.message_thread_id).toBe(42);
  expect(api.createdTopics).toBe(1);
  expect(entryOf(fx, 'cc:sess1')?.threadId).toBe(42);
  const binding = parseTopics(readFileSync(fx.topicsPath, 'utf8')).find((t) => t.threadId === 42);
  expect(binding?.status).toBe('bound');
  expect(binding?.paneId).toBe('%5');

  // Second card: same topic, no second create.
  const second = await askAndGetCard(fx, api, 'q2', 'sess1', '%5');
  expect(second.message_thread_id).toBe(42);
  expect(api.createdTopics).toBe(1);

  // The topic stops accepting posts: one retry, then a General notice and the card in General.
  api.threadMode = 'not-found';
  const fallback = await askAndGetCard(fx, api, 'q3', 'sess1', '%5');
  expect(fallback.message_thread_id).toBeUndefined();
  const attempts = api.sent.filter((m) => String(m.text).includes('Pick one for q3?'));
  expect(attempts.map((m) => m.message_thread_id)).toEqual([42, 42, undefined]);
  expect(api.sent.some((m) => m.message_thread_id === undefined && String(m.text).includes('its topic is not accepting messages'))).toBe(true);
  expect(entryOf(fx, 'cc:sess1')?.topicMisses?.count).toBe(1);

  // Telegram reports the topic deleted: the card goes to General, the binding is dropped, and
  // the next card opens a new topic.
  api.threadMode = 'deleted';
  const deleted = await askAndGetCard(fx, api, 'q4', 'sess1', '%5');
  expect(deleted.message_thread_id).toBeUndefined();
  expect(api.sent.some((m) => String(m.text).includes('its topic is gone'))).toBe(true);
  expect(entryOf(fx, 'cc:sess1')?.threadId).toBeNull();
  expect(parseTopics(readFileSync(fx.topicsPath, 'utf8')).some((t) => t.threadId === 42)).toBe(false);

  api.threadMode = 'ok';
  const recreated = await askAndGetCard(fx, api, 'q5', 'sess1', '%5');
  expect(recreated.message_thread_id).toBe(43);
  expect(api.createdTopics).toBe(2);
  expect(entryOf(fx, 'cc:sess1')?.threadId).toBe(43);
}, 60_000);

test('a resumed session is re-adopted into its old topic with a "reattached" post', async () => {
  // The session exited earlier (gone, from an old pid) but kept its topic 77.
  const fx = makeFixture([
    ccEntry('sess2', {
      state: 'gone',
      threadId: 77,
      locators: { pid: 99981, tmux: { serverPid: SERVER_PID, paneId: '%3', panePid: 99980 }, durableSession: null },
    }),
  ]);
  const api = startApi(500);
  await startDaemon(fx, api.port);

  // It is resumed in another pane, by a new process. Its first hook names the session id, and
  // the next registry scan binds that id to the new process and re-adopts the entry.
  writeFileSync(join(fx.cfgDir, 'panes.txt'), `main\t0\t%7\t99990\tclaude\tagent\t\t${fx.cfgDir}\n`);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  const ask = startAsk(fx, api.port, 'r1', 'sess2', '%7');
  const reattached = await waitFor('reattached post', () => api.delivered.find((m) => String(m.text).includes('reattached')));
  ask.kill(9);
  await ask.exited;
  expect(reattached.message_thread_id).toBe(77);
  expect(String(reattached.text).startsWith('📂 ')).toBe(true);
  expect(api.createdTopics).toBe(0);

  const entry = entryOf(fx, 'cc:sess2');
  expect(entry?.state).toBe('live');
  expect(entry?.threadId).toBe(77);
  expect(entry?.locators.tmux?.paneId).toBe('%7');
  const binding = parseTopics(readFileSync(fx.topicsPath, 'utf8')).find((t) => t.threadId === 77);
  expect(binding?.status).toBe('bound');
  expect(binding?.paneId).toBe('%7');

  // The resumed session's next card lands in its old topic.
  const card = await askAndGetCard(fx, api, 'r2', 'sess2', '%7');
  expect(card.message_thread_id).toBe(77);
  expect(api.createdTopics).toBe(0);
}, 60_000);

// tg-cli#717: a hatch ask (agent-tools' request_hatch_approval) is headless — no harness session
// id, and an inherited TMUX_PANE that hosts no live session — so its card fell into General,
// where nobody saw it. The asker's TG_SESSION pin now names the session whose topic gets it.
test('a headless hatch card goes, with its buttons, into the topic of the TG_SESSION-pinned session', async () => {
  const fx = makeFixture([
    ccEntry('sess3', { threadId: 88, locators: { pid: 99993, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99992 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99992 1 -zsh\n99993 99992 claude\n');
  writeFileSync(join(fx.cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 88, name: 'alpha', status: 'bound', path: '/tmp', paneId: '%5', ts: 1 }]));
  const api = startApi(50);
  await startDaemon(fx, api.port);
  const run = (pin: string | null): Subprocess => {
    const ask = Bun.spawn([process.execPath, TG_CTL, 'ask', '--agent', 'claude'], {
      env: { HOME: fx.cfgDir, TG_CTL_CONFIG_DIR: fx.cfgDir, TG_API_BASE: `http://127.0.0.1:${api.port}`, TMUX_PANE: '%0', ...(pin ? { TG_SESSION: pin } : {}) },
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    });
    procs.push(ask);
    ask.stdin.write(`${JSON.stringify({ requestId: `hatch-ship-skip-ci-${pin ? 'pinned' : 'loose'}`, agent: 'claude', kind: 'permission', question: `Pick one for ${pin ? 'h1' : 'h2'}?`, critical: true, cwd: '/x' })}\n`);
    ask.stdin.end();
    return ask;
  };
  const pinned = run('cc:sess3');
  const card = await waitFor('pinned hatch card', () => cardFor(api, 'h1'));
  pinned.kill(9);
  expect(card.message_thread_id).toBe(88);
  expect(JSON.stringify(card.reply_markup)).toContain('inline_keyboard');
  // Without a pin no session owns the ask: its card, with buttons, goes into the 📥 Inbox —
  // never silently to General (tg-cli#717).
  const loose = run(null);
  const inboxCard = await waitFor('unpinned hatch card', () => api.inbox.find((m) => String(m.text).includes('Pick one for h2?')));
  loose.kill(9);
  expect(JSON.stringify(inboxCard.reply_markup)).toContain('inline_keyboard');
  expect(cardFor(api, 'h2')).toBeUndefined();
}, 60_000);

// tg-cli#717: a critical hatch ask waits without a deadline. When the process that asked dies
// (gh ship killed by its timeout), the orphaned `tg-ctl ask` exits, so its card is released. It
// is not withdrawn: a hatch card keeps its late-approval grace (tg-cli#398) for the retry.
test('an orphaned hatch ask exits once its asker dies, releasing the card', async () => {
  const fx = makeFixture([]);
  const api = startApi(60);
  await startDaemon(fx, api.port);
  const reqPath = join(fx.cfgDir, 'req.json');
  writeFileSync(reqPath, JSON.stringify({ requestId: 'hatch-ship-skip-ci-orphan', agent: 'claude', kind: 'permission', question: 'Pick one for h3?', critical: true, cwd: '/x' }));
  const pidPath = join(fx.cfgDir, 'ask.pid');
  // The asker: a shell that starts the ask in the background and exits at once.
  const asker = Bun.spawn(['sh', '-c', `"${process.execPath}" "${TG_CTL}" ask --agent claude < "${reqPath}" >/dev/null 2>/dev/null & echo $! > "${pidPath}"`], {
    env: { HOME: fx.cfgDir, TG_CTL_CONFIG_DIR: fx.cfgDir, TG_API_BASE: `http://127.0.0.1:${api.port}`, TMUX_PANE: '%0' },
  });
  await asker.exited;
  // No session owns it, so the card sits in the 📥 Inbox.
  await waitFor('orphan hatch card', () => api.inbox.find((m) => String(m.text).includes('Pick one for h3?')));
  const askPid = Number(readFileSync(pidPath, 'utf8'));
  const alive = (): boolean => {
    try {
      process.kill(askPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await waitFor('orphaned ask to exit', () => !alive(), 10_000);
  await waitFor('card released', () => readFileSync(join(fx.cfgDir, 'daemon.log'), 'utf8').includes('hatch-ship-skip-ci-orphan') && !readFileSync(join(fx.cfgDir, 'tg-ctl.123.questions.json'), 'utf8').includes('"pending":true'), 10_000);
}, 60_000);

// --- tg-cli#717: a card goes to the ASKING session's topic; unresolvable → the 📥 Inbox ---

function ompEntry(sessionId: string, pid: number, over: Partial<SessionEntry> = {}): SessionEntry {
  return ccEntry(sessionId, { key: `omp:${sessionId}`, harness: 'omp', name: { primary: `omp-${sessionId}`, secondary: null }, locators: { pid, tmux: null, durableSession: null }, ...over });
}

// A paneless hatch ask (agent-tools' RIG_HATCH_REQUEST_* shape) from this test process — whose
// pid is the ask client's parent, i.e. its first ancestor. No TMUX_PANE, no harness session id.
function startHatch(fx: Fixture, port: number, hookId: string, extraEnv: Record<string, string> = {}): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { PATH: `${join(fx.cfgDir, 'bin')}:${process.env.PATH ?? ''}`, HOME: fx.cfgDir, TG_CTL_CONFIG_DIR: fx.cfgDir, TG_API_BASE: `http://127.0.0.1:${port}`, ...extraEnv },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  procs.push(ask);
  ask.stdin.write(
    `${JSON.stringify({
      requestId: `hatch-${hookId}-aaaaaaaaaaaa`,
      agent: 'claude',
      kind: 'permission',
      question: `Allow rig hatch escalation: ${hookId}?`,
      permissionEvent: 'PermissionRequest',
      hookId,
      cwd: fx.cfgDir,
    })}\n`,
  );
  ask.stdin.end();
  return ask;
}

const hatchCardIn = (msgs: Record<string, unknown>[], hookId: string): Record<string, unknown> | undefined =>
  msgs.find((m) => m.reply_markup !== undefined && String(m.text).includes(`Allow rig hatch escalation: ${hookId}?`) && !String(m.text).startsWith('📥 '));
const daemonLog = (fx: Fixture): string => readFileSync(join(fx.cfgDir, 'daemon.log'), 'utf8');

test('#717: a hatch ask from an omp session goes to THAT session\'s topic, with a notification, never a foreign topic', async () => {
  // Our omp owns this test process (its pid is the ask's parent); a cc session elsewhere already
  // has topic 55. tmux lists no panes, so the seeded live entries stay as written.
  const fx = makeFixture([
    ompEntry('own', process.pid),
    ccEntry('other', { threadId: 55, locators: { pid: 99991, tmux: null, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  const api = startApi(42);
  await startDaemon(fx, api.port);

  const ask = startHatch(fx, api.port, 'ship');
  const card = await waitFor('hatch card', () => hatchCardIn(api.delivered, 'ship'));
  expect(card.message_thread_id).toBe(42);
  expect(card.disable_notification).toBeUndefined();
  expect(api.delivered.some((m) => m.message_thread_id === 55)).toBe(false);
  await waitFor('log line', () => daemonLog(fx).includes('thread=42 session=omp:own'));
  // Plus its silent copy in the 📥 Inbox.
  const copy = await waitFor('inbox copy', () => api.inbox.find((m) => String(m.text).startsWith('📥 ')));
  expect(copy.disable_notification).toBe(true);
  ask.kill(9);
  await ask.exited;
}, 60_000);

test('#717: an explicit TG_SESSION wins: the card goes to the named session\'s topic, not the ancestor\'s', async () => {
  const fx = makeFixture([ompEntry('named', 99995), ompEntry('ancestor', process.pid)]);
  const api = startApi(60);
  await startDaemon(fx, api.port);
  const ask = startHatch(fx, api.port, 'deploy', { TG_SESSION: 'omp:named' });
  await waitFor('log line', () => /thread=\d+ session=omp:named/.test(daemonLog(fx)));
  expect(entryOf(fx, 'omp:named')?.threadId).toBe(60);
  expect(entryOf(fx, 'omp:ancestor')?.threadId).toBeNull();
  ask.kill(9);
  await ask.exited;
}, 60_000);

test('#717: an ask no session owns goes INTO the 📥 Inbox with a notification — never General, never a foreign topic', async () => {
  const fx = makeFixture([ccEntry('other', { threadId: 55, locators: { pid: 99991, tmux: null, durableSession: null } })]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  const api = startApi(42);
  await startDaemon(fx, api.port);

  const ask = startHatch(fx, api.port, 'orphan');
  const card = await waitFor('inbox card', () => hatchCardIn(api.inbox, 'orphan'));
  expect(card.disable_notification).toBeUndefined();
  await waitFor('log line', () => daemonLog(fx).includes(`thread=inbox:${INBOX_THREAD} session=-`));
  expect(hatchCardIn(api.delivered, 'orphan')).toBeUndefined(); // not General, not topic 55
  expect(api.createdTopics).toBe(0);
  // The card IS the Inbox entry: no second, silent copy is posted next to it. A genuine wait
  // over a few sync ticks of a separate daemon process, for the absence of a send.
  await Bun.sleep(600);
  expect(api.inbox.filter((m) => String(m.text).includes('Allow rig hatch escalation: orphan?'))).toHaveLength(1);
  ask.kill(9);
  await ask.exited;
}, 60_000);

test('#717: a card for an Inbox topic deleted by hand recreates the topic and lands there — never General', async () => {
  const fx = makeFixture([]);
  // The daemon remembers an Inbox topic that the user has since deleted.
  writeFileSync(join(fx.cfgDir, 'tg-ctl.123.question-inbox.json'), JSON.stringify({ version: 1, chatId: -100123, threadId: INBOX_THREAD, mirrors: {} }));
  const api = startApi(42);
  api.inboxDeleted = true;
  await startDaemon(fx, api.port);

  const ask = startHatch(fx, api.port, 'gone');
  const card = await waitFor('inbox card', () => hatchCardIn(api.inbox, 'gone'));
  expect(card.disable_notification).toBeUndefined();
  expect(api.inboxCreates).toBe(1);
  expect(hatchCardIn(api.delivered, 'gone')).toBeUndefined();
  await waitFor('log line', () => daemonLog(fx).includes('rejected a send'));
  ask.kill(9);
  await ask.exited;
}, 60_000);
