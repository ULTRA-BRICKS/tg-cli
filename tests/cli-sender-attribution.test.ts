import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// tg-cli#709: omp runs background jobs under ONE shared `__omp_worker_daemon_broker`
// whose parent is whichever omp started it. A watchdog launched by session MODEL ran
// under a broker owned by session FREEZE, and its `tg` posted with FREEZE's topic and
// session key — so the CTO's reply went to FREEZE. The process tree above a broker
// names nobody: such a send carries no session unless `--session` / TG_SESSION pins it.

const TG = join(import.meta.dir, '..', 'tg');
const dirs: string[] = [];
const servers: Server[] = [];
const apis: Array<{ stop(force?: boolean): void }> = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const a of apis) a.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Fake pids: FREEZE's omp owns the broker; MODEL's omp is unrelated to this process tree.
const FREEZE_PID = 914610;
const BROKER_PID = 922222;
const MODEL_PID = 933553;
const FREEZE = { key: 'omp:01a11af0-freeze', sessionId: '01a11af0-freeze', pid: FREEZE_PID, threadId: 194999, title: 'FREEZE: Diagnose freezes' };
const MODEL = { key: 'omp:01a12cd6-model', sessionId: '01a12cd6-model', pid: MODEL_PID, threadId: 195091, title: 'MODEL: Finish 3D model' };

function entry(s: typeof FREEZE): Record<string, unknown> {
  return {
    key: s.key,
    harness: 'omp',
    sessionId: s.sessionId,
    sessionFile: null,
    locators: { pid: s.pid, tmux: null, durableSession: null },
    cwd: '/tmp',
    name: { primary: s.title, secondary: null },
    aliases: [],
    threadId: s.threadId,
    topicMisses: null,
    state: 'live',
    firstSeen: '2026-10-14T00:00:00.000Z',
    lastSeen: '2026-10-14T00:00:00.000Z',
  };
}

interface Fixture {
  env: Record<string, string>;
  configDir: string;
  asks: Array<{ kind: string; ancestorPids: number[] }>;
  sent: Array<Record<string, unknown>>;
}

// `tree`: what runs `tg` — a job under FREEZE's broker, or a plain bash of MODEL's omp.
function fixture(tree: 'broker' | 'model-bash'): Fixture {
  const home = tempDir('tg-attr-home-');
  const configDir = join(home, '.config', 'tg-cli');
  const binDir = tempDir('tg-attr-bin-');
  dirs.push(home, binDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(configDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(configDir, 'tg-ctl.123.sessions.json'), JSON.stringify({ schemaVersion: 2, migrated: {}, sessions: [entry(FREEZE), entry(MODEL)] }));
  // tg's parent (the test runner) is the job; above it the real-incident chain.
  const chain =
    tree === 'broker'
      ? `echo "$TGPPID ${BROKER_PID + 1} /venv/bin/python -u watchdog.py"\necho "${BROKER_PID + 1} ${BROKER_PID} /bin/zsh -l -c python watchdog.py"\n` +
        `echo "${BROKER_PID} ${FREEZE_PID} /home/u/.local/lib/omp/omp __omp_worker_daemon_broker"\necho "${FREEZE_PID} 1 /home/u/.local/lib/omp/omp -r"\n`
      : `echo "$TGPPID ${MODEL_PID} bash -lc tg"\necho "${MODEL_PID} 1 /home/u/.local/lib/omp/omp"\n`;
  writeFileSync(
    join(binDir, 'ps'),
    '#!/bin/sh\nTG="$PPID"\nTGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n[ -z "$TGPPID" ] && TGPPID=900000\necho "$TG $TGPPID bun run tg"\n' + chain,
    { mode: 0o755 },
  );
  // No lsof: the omp title/cwd lookups find nothing, so a header can only name a session
  // through the registry.
  writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  // The daemon's resolve-session, as findSessionForLookup answers it: by ancestor pid.
  const asks: Fixture['asks'] = [];
  const server = createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d: string) => {
      const q = JSON.parse(d.trim()) as { kind: string; ancestorPids: number[] };
      asks.push(q);
      if (q.kind !== 'resolve-session') return void c.end();
      const hit = [FREEZE, MODEL].find((s) => q.ancestorPids.includes(s.pid));
      c.end(`${JSON.stringify(hit ? { key: hit.key, name: hit.title, threadId: hit.threadId } : { key: null, name: null, threadId: null })}\n`);
    });
  });
  server.listen(join(configDir, 'tg-ctl.123.sock'));
  servers.push(server);

  const sent: Fixture['sent'] = [];
  let nextId = 500;
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body);
        return Response.json({ ok: true, result: { message_id: ++nextId, ...(body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}) } });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  apis.push(api);
  return {
    configDir,
    asks,
    sent,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TG_CTL_CONFIG_DIR: configDir, TG_API_BASE: `http://127.0.0.1:${api.port}` },
  };
}

async function run(f: Fixture, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', TG, ...args], { env: { ...f.env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

function routes(f: Fixture): Array<Record<string, unknown>> {
  const p = join(f.configDir, 'tg-ctl.123.routes.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Array<Record<string, unknown>>) : [];
}

function history(f: Fixture): Array<Record<string, unknown>> {
  const p = join(f.configDir, 'tg-ctl.123.history.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

// The header styles names in Unicode bold (prefix-style); NFKC folds it back to ASCII.
function plain(text: unknown): string {
  return String(text).normalize('NFKC');
}

test('a job under the shared omp broker never takes the broker owner\'s topic, header or session (General, warning)', async () => {
  const f = fixture('broker');
  const r = await run(f, ['⚠ U1 vision: possible spaghetti']);
  expect(r.code).toBe(0);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].message_thread_id).toBeUndefined();
  expect(plain(f.sent[0].text)).not.toContain('FREEZE');
  expect(f.asks.some((q) => q.ancestorPids?.includes(FREEZE_PID))).toBe(false);
  for (const row of [...routes(f), ...history(f)]) {
    expect(row.sessionKey).toBeUndefined();
    expect(String(row.paneId ?? row.pane ?? '')).not.toBe(`omp:${FREEZE_PID}`);
  }
  expect(r.err).toContain('TG_SESSION');
}, 20_000);

// The job inherits its launcher's $TMUX / $TMUX_PANE through the broker; an unpinned broker job
// trusts neither: no topic ask by pane, no route or history row a reply could resolve later.
test('an unpinned broker job with an inherited tmux pane asks no topic and records no route a reply could follow', async () => {
  const f = fixture('broker');
  const r = await run(f, ['alert'], { TMUX: '/tmp/x,4242,0', TMUX_PANE: '%5' });
  expect(r.code).toBe(0);
  expect(f.sent[0].message_thread_id).toBeUndefined();
  expect(f.asks.filter((q) => q.kind === 'resolve-session')).toEqual([]);
  expect(routes(f).map((row) => [row.paneId, row.sessionKey, row.serverPid])).toEqual([['system', undefined, undefined]]);
  expect(history(f).map((row) => [row.pane, row.sessionKey])).toEqual([['system', undefined]]);
}, 20_000);

test('TG_SESSION pins a broker job to its real session: that topic, header title, route and history session', async () => {
  const f = fixture('broker');
  const r = await run(f, ['⚠ U1 vision: possible spaghetti'], { TG_SESSION: MODEL.sessionId });
  expect(r.code).toBe(0);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].message_thread_id).toBe(MODEL.threadId);
  expect(plain(f.sent[0].text)).toContain('[MODEL: Finish 3D model]');
  expect(plain(f.sent[0].text)).not.toContain('FREEZE');
  expect(routes(f).map((row) => row.sessionKey)).toEqual([MODEL.key]);
  expect(history(f).map((row) => row.sessionKey)).toEqual([MODEL.key]);
  expect(r.err).not.toContain('TG_SESSION');
}, 20_000);

test('--session wins over TG_SESSION and takes the registry key form', async () => {
  const f = fixture('broker');
  const r = await run(f, ['--session', MODEL.key, 'status'], { TG_SESSION: FREEZE.sessionId });
  expect(r.code).toBe(0);
  expect(f.sent[0].message_thread_id).toBe(MODEL.threadId);
  expect(routes(f).map((row) => row.sessionKey)).toEqual([MODEL.key]);
}, 20_000);

// A topic window exports TG_TOPIC to its shell; a broker job inherits FREEZE's. Neither an
// unpinned broker job nor a pinned one may post into that inherited topic.
test('an inherited TG_TOPIC never routes a broker job, pinned or not, into another session\'s topic', async () => {
  const loose = fixture('broker');
  expect((await run(loose, ['alert'], { TG_TOPIC: String(FREEZE.threadId) })).code).toBe(0);
  expect(loose.sent[0].message_thread_id).toBeUndefined();
  const pinned = fixture('broker');
  expect((await run(pinned, ['alert'], { TG_TOPIC: String(FREEZE.threadId), TG_SESSION: MODEL.sessionId })).code).toBe(0);
  expect(pinned.sent[0].message_thread_id).toBe(MODEL.threadId);
}, 20_000);

test('a pin naming no live session warns and sends with no session — never the process tree\'s or the pane\'s', async () => {
  const f = fixture('model-bash');
  const r = await run(f, ['status'], { TG_SESSION: 'nope-not-a-session', TMUX: '/tmp/x,4242,0', TMUX_PANE: '%5' });
  expect(r.code).toBe(0);
  expect(r.err).toContain("TG_SESSION 'nope-not-a-session'");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].message_thread_id).toBeUndefined();
  expect(f.asks.filter((q) => q.kind === 'resolve-session')).toEqual([]);
  expect(routes(f).map((row) => [row.paneId, row.sessionKey])).toEqual([['system', undefined]]);
  expect(history(f).map((row) => [row.pane, row.sessionKey])).toEqual([['system', undefined]]);
}, 20_000);

test('a plain bash of an omp session still posts into that session\'s topic (no pin needed)', async () => {
  const f = fixture('model-bash');
  const r = await run(f, ['status']);
  expect(r.code).toBe(0);
  expect(f.sent[0].message_thread_id).toBe(MODEL.threadId);
  expect(r.err).not.toContain('TG_SESSION');
}, 20_000);

test('tg --session-id prints the session key a launcher hands to TG_SESSION, and nothing under the broker', async () => {
  expect(await run(fixture('model-bash'), ['--session-id'])).toMatchObject({ code: 0, out: `${MODEL.key}\n` });
  expect(await run(fixture('broker'), ['--session-id'])).toMatchObject({ code: 0, out: '' });
}, 20_000);
