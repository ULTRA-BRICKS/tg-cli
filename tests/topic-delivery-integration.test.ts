import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server, Subprocess } from 'bun';
import { parseRegistry, serializeRegistry } from '../features/tg-ctl/session-registry-store';
import type { SessionEntry } from '../features/tg-ctl/session-registry';
import { parseHistory } from '../features/replies/history';

// A session's forum topic follows its registry session (docs/specs/session-registry-and-topics.md
// §4.4 rows 2–3, §4.7; tg-cli#465, #466), against a real daemon and a fake Bot API. The registry —
// not a topics.json pane binding — says which session a topic addresses and where it lives now, so
// a live session is never answered "not running", never held behind the attach picker, and a gone
// one gets the resume hint; a session rename retitles its topic. tmux and `ps` are PATH shims fed
// from files; tmux logs every literal send-keys as `<pane>\t<text>` and any rename-window call.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SERVER_PID = 4242;
const THREAD = 50;

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
  injectLog: string;
}

function makeFixture(sessions: SessionEntry[]): Fixture {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-topic-delivery-'));
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(cfgDir, 'panes.txt'), '');
  writeFileSync(join(cfgDir, 'procs.txt'), '');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/sh
case "$1" in
  display-message) echo ${SERVER_PID} ;;
  list-panes) case "$4" in *pane_title*) ;; *) cat "${cfgDir}/panes.txt" ;; esac ;;
  send-keys)
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  rename-window) printf 'rename-window\\t%s\\n' "$*" >> '${injectLog}' ;;
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
if [ "$*" = "-axo pid=,ppid=,command=" ]; then cat "${cfgDir}/procs.txt"; echo >> "${cfgDir}/ps.calls"; fi
exit $code
`,
    { mode: 0o755 },
  );
  const sessionsPath = join(cfgDir, 'tg-ctl.123.sessions.json');
  const migrated = { routes: '2026-01-01T00:00:00.000Z', registration: '2026-01-01T00:00:00.000Z', lastUserTarget: '2026-01-01T00:00:00.000Z', topics: '2026-01-01T00:00:00.000Z' };
  writeFileSync(sessionsPath, serializeRegistry({ schemaVersion: 2, migrated, sessions }));
  return { cfgDir, sessionsPath, topicsPath: join(cfgDir, 'tg-ctl.123.topics.json'), injectLog };
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
  sent: Record<string, unknown>[];
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  updates: unknown[][];
}

function startApi(): FakeApi {
  const api: FakeApi = { port: 0, sent: [], calls: [], updates: [] };
  let nextMessageId = 100;
  const server = Bun.serve({
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
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      api.calls.push({ method, body });
      if (method === 'createForumTopic') return Response.json({ ok: true, result: { message_thread_id: 900, name: 'x', icon_color: 0 } });
      if (method === 'sendMessage') {
        api.sent.push(body);
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
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(fx.cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: fx.cfgDir,
      TG_CTL_CONFIG_DIR: fx.cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(fx.cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
}

// A cc question hook from pane `paneId` of session `sessionId`: the way a cc session id reaches
// the daemon. It blocks for the answer, so the caller kills it once the session is registered.
function startAsk(fx: Fixture, port: number, sessionId: string, paneId: string): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: fx.cfgDir, TG_CTL_CONFIG_DIR: fx.cfgDir, TG_API_BASE: `http://127.0.0.1:${port}`, TMUX_PANE: paneId },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  procs.push(ask);
  ask.stdin.write(
    `${JSON.stringify({
      requestId: 'r1',
      agent: 'claude',
      kind: 'question',
      title: 'Question',
      question: 'Pick one?',
      options: [{ label: 'A' }, { label: 'B' }],
      origin: { sessionId },
      cwd: fx.cfgDir,
    })}\n`,
  );
  ask.stdin.end();
  return ask;
}

// Polls: the conditions are side effects of a separate daemon process, with no signal to await.
async function waitFor<T>(what: string, probe: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const got = probe();
    if (got) return got;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const injected = (fx: Fixture): string[] => (existsSync(fx.injectLog) ? readFileSync(fx.injectLog, 'utf8').split('\n').filter(Boolean) : []);
const entryOf = (fx: Fixture, key: string): SessionEntry | undefined =>
  parseRegistry(readFileSync(fx.sessionsPath, 'utf8')).sessions.find((e) => e.key === key);

let nextUpdate = 1000;
function topicMsg(text: string): unknown {
  const id = nextUpdate++;
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: Math.floor(Date.now() / 1000),
      text,
      message_thread_id: THREAD,
      is_topic_message: true,
    },
  };
}

// A cc session `alpha` that exited earlier but owns topic 50 comes back in pane %5, in a tmux
// window named `windowName`, and is re-adopted: its first hook names the session id, the next
// scan binds it to the new process. `afterFirstScan`: the session appears only once the daemon
// has read the (empty) process table; `within`: how soon the re-adoption must land.
async function readoptedSession(windowName = 'alpha', opts: { afterFirstScan?: boolean; within?: number } = {}): Promise<{ fx: Fixture; api: FakeApi }> {
  const fx = makeFixture([
    ccEntry('sess1', {
      state: 'gone',
      threadId: THREAD,
      locators: { pid: 99971, tmux: { serverPid: SERVER_PID, paneId: '%3', panePid: 99970 }, durableSession: null },
    }),
  ]);
  const api = startApi();
  await startDaemon(fx, api.port);
  if (opts.afterFirstScan) await waitFor('first discovery pass', () => existsSync(join(fx.cfgDir, 'ps.calls')));
  writeFileSync(join(fx.cfgDir, 'panes.txt'), `main\t0\t%5\t99990\tclaude\t${windowName}\t\t${fx.cfgDir}\n`);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  const ask = startAsk(fx, api.port, 'sess1', '%5');
  await waitFor('re-adoption', () => {
    const e = entryOf(fx, 'cc:sess1');
    return e?.state === 'live' && e.locators.tmux?.paneId === '%5';
  }, opts.within);
  ask.kill(9);
  await ask.exited;
  return { fx, api };
}

test('a bound topic follows its registry session: delivered while live (whatever topics.json says), "not running" once gone', async () => {
  const { fx, api } = await readoptedSession();

  // No topics.json binding at all: the registry alone makes topic 50 known — the message is
  // delivered, never held behind the attach picker.
  rmSync(fx.topicsPath, { force: true });
  api.updates.push([topicMsg('first')]);
  await waitFor('first delivery', () => injected(fx).find((l) => l.includes('first')));
  // A binding left closed on a stale pane (a session once misread as dead) does not stop it either.
  writeFileSync(fx.topicsPath, JSON.stringify([{ threadId: THREAD, name: 'alpha', status: 'closed', paneId: '%3', harness: 'claude', ts: 1 }]));
  api.updates.push([topicMsg('second')]);
  await waitFor('second delivery', () => injected(fx).find((l) => l.includes('second')));
  expect(injected(fx).filter((l) => !l.startsWith('%5\t'))).toEqual([]);
  expect(api.sent.some((m) => m.reply_markup !== undefined && m.message_thread_id === THREAD)).toBe(false);
  expect(api.sent.some((m) => String(m.text).includes('not running'))).toBe(false);

  // The session exits (another pane keeps the tmux list trusted): the topic answers with its
  // resume hint, in the topic, and nothing is typed anywhere.
  writeFileSync(join(fx.cfgDir, 'panes.txt'), `main\t1\t%6\t99980\tzsh\tshell\t\t${fx.cfgDir}\n`);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99980 1 -zsh\n');
  const before = injected(fx).length;
  api.updates.push([topicMsg('third')]);
  const reply = await waitFor('gone reply', () => api.sent.find((m) => String(m.text).includes('not running')));
  expect(reply).toMatchObject({ message_thread_id: THREAD, text: '`alpha` is not running — resume with `claude --resume`' });
  expect(injected(fx).length).toBe(before);
  expect(entryOf(fx, 'cc:sess1')?.state).toBe('gone');
}, 120_000);

test('a tmux rename retitles the session topic once; nothing reaches back into tmux', async () => {
  // The window was renamed `beta` while the session was away: the re-adopting scan sees the new
  // name, and after its 20 s debounce the rename commits and retitles the topic.
  const { fx, api } = await readoptedSession('beta');
  const edit = await waitFor('editForumTopic', () => api.calls.find((c) => c.method === 'editForumTopic'), 40_000);
  expect(edit.body).toMatchObject({ message_thread_id: THREAD, name: 'beta' });
  expect(entryOf(fx, 'cc:sess1')).toMatchObject({ name: { primary: 'beta' }, aliases: ['alpha'], threadId: THREAD });
  expect(api.calls.filter((c) => c.method === 'editForumTopic')).toHaveLength(1);
  expect(injected(fx).filter((l) => l.startsWith('rename-window'))).toEqual([]);
}, 90_000);

test('a topic message is logged for `tg replies` under the topic\'s session, with the thread it came from', async () => {
  const { fx, api } = await readoptedSession();
  api.updates.push([topicMsg('hello topic')]);
  await waitFor('delivery', () => injected(fx).find((l) => l.includes('hello topic')));
  const rows = parseHistory(readFileSync(join(fx.cfgDir, 'tg-ctl.123.history.jsonl'), 'utf8')).filter((r) => r.direction === 'user' && r.text === 'hello topic');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ pane: '%5', targetAgent: 'alpha', sessionKey: 'cc:sess1', threadId: THREAD });
}, 120_000);

test('a hook sighting right after a discovery pass is bound by the next scan, not the 30 s periodic one', async () => {
  // The daemon's first discovery pass read no panes and is still young enough to be reused when
  // the session's pane appears and its hook names the session id. The scan that sighting asks for
  // must read the panes again: with the stale pass it binds nothing, and the sighting then waits
  // for the periodic scan, 30 s later.
  await readoptedSession('alpha', { afterFirstScan: true, within: 10_000 });
}, 60_000);

// A permission hook of the live session in pane %5. Its stdout is the hook's reply to the agent.
function startPermissionAsk(fx: Fixture, port: number): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: fx.cfgDir, TG_CTL_CONFIG_DIR: fx.cfgDir, TG_API_BASE: `http://127.0.0.1:${port}`, TMUX_PANE: '%5' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  procs.push(ask);
  ask.stdin.write(
    `${JSON.stringify({
      requestId: 'p1',
      agent: 'claude',
      kind: 'permission',
      question: 'Allow bash command: rm -rf /tmp/test?',
      permissionEvent: 'PermissionRequest',
      promptTurnId: 'turn1',
      origin: { sessionId: 'sess1' },
      cwd: fx.cfgDir,
    })}\n`,
  );
  ask.stdin.end();
  return ask;
}

test('a text reply inside the topic answers the permission card posted there, instead of reaching the agent as prose', async () => {
  const { fx, api } = await readoptedSession();
  // The daemon forwards cards of registered panes only (the first, session-naming hook above is
  // dropped as unregistered by design).
  writeFileSync(join(fx.cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: fx.cfgDir }));
  const ask = startPermissionAsk(fx, api.port);
  const card = await waitFor('permission card', () => api.sent.find((m) => m.reply_markup !== undefined && String(m.text).includes('rm -rf')));
  // Posted into the session's topic; the fake Bot API numbers its messages from 100 in send order.
  expect(card.message_thread_id).toBe(THREAD);
  const cardMessageId = 100 + api.sent.indexOf(card);

  const id = nextUpdate++;
  api.updates.push([
    {
      update_id: id,
      message: {
        message_id: id,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: Math.floor(Date.now() / 1000),
        text: 'yes',
        message_thread_id: THREAD,
        is_topic_message: true,
        reply_to_message: { message_id: cardMessageId, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) - 30, text: 'Permission from claude' },
      },
    },
  ]);

  const out = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  // Never typed into the agent as chat.
  expect(injected(fx).filter((l) => l.includes('yes'))).toEqual([]);
}, 120_000);
