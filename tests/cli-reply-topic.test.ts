import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server as NetServer } from 'net';
import { join } from 'path';
import { parseHistory, serializeHistoryRecord, type HistoryRecord } from '../features/replies/history';
import { tempDir } from './helpers/test-temp';

// tg-cli#551: an agent answers a message the CTO wrote inside a topic with `tg --reply-to <id>`.
// Telegram does not put such a reply into the topic of its anchor in a private chat with topics —
// without message_thread_id it lands in General — so `tg` must name the thread itself: the topic
// the anchor message sits in (recorded on its history row), else the session's own topic.
// The REAL `tg` runs against a fake Bot API and a fake daemon socket.

const TG = join(import.meta.dir, '..', 'tg');
const CHAT = 5153477378;
const TOPIC = 192230;
const SESSION_TOPIC = 9001;

let sent: Array<Record<string, unknown>> = [];
let nextMessageId = 500;
// Whether the fake Bot API refuses threaded sends as "message thread not found", and how many
// threaded sends it accepts first.
let rejectThreaded = false;
let acceptThreadedFirst = 0;

const api = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/sendMessage')) return Response.json({ ok: false, description: 'unexpected' }, { status: 404 });
    const body = (await req.json()) as Record<string, unknown>;
    sent.push(body);
    if (rejectThreaded && 'message_thread_id' in body && acceptThreadedFirst-- <= 0) return Response.json({ ok: false, description: 'Bad Request: message thread not found' }, { status: 400 });
    return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
  },
});

const dirs: string[] = [];
const daemons: NetServer[] = [];
afterAll(() => {
  api.stop(true);
  for (const d of daemons) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Home {
  home: string;
  cfg: string;
}

// /tmp, not tmpdir(): the daemon socket path must stay under the 104-byte unix limit.
function makeHome(history: HistoryRecord[]): Home {
  const home = tempDir('tgrt-', { short: true });
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), `TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=${CHAT}\n`);
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  topics: true\n  private_topics: true\n');
  writeFileSync(join(cfg, 'tg-ctl.123.history.jsonl'), history.map(serializeHistoryRecord).join('\n') + (history.length ? '\n' : ''));
  // A tmux that knows nothing: the send's session identity comes from $TMUX alone.
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'tmux'), 0o755);
  return { home, cfg };
}

// A daemon that answers every resolve-session with `answer` and records what it was asked.
function startDaemon(cfg: string, answer: { key: string; name: string; threadId: number | null }): Array<Record<string, unknown>> {
  const asked: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      asked.push(line);
      if (line.kind === 'resolve-session') socket.end(`${JSON.stringify(answer)}\n`);
      else socket.end();
    });
    socket.on('error', () => {});
  });
  server.listen(join(cfg, 'tg-ctl.123.sock'));
  daemons.push(server);
  return asked;
}

const userRow = (message_id: number, threadId?: number | null): HistoryRecord => ({
  ts: 1,
  message_id,
  chat_id: CHAT,
  direction: 'user',
  from: 'Alex',
  text: 'Какой статус?',
  pane: null,
  ...(threadId !== undefined ? { threadId } : {}),
});

async function tg(h: Home, args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stderr: string }> {
  sent = [];
  const proc = Bun.spawn(['bun', TG, ...args], {
    env: {
      PATH: `${join(h.home, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: h.home,
      TG_API_BASE: `http://127.0.0.1:${api.port}`,
      TMUX: '/tmp/none,4242,0',
      TMUX_PANE: '%9',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

const outboundRows = (h: Home): HistoryRecord[] => parseHistory(readFileSync(join(h.cfg, 'tg-ctl.123.history.jsonl'), 'utf8')).filter((r) => r.direction === 'agent');

test('a reply to a message written inside a topic posts into that topic, anchor kept', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  const asked = startDaemon(h.cfg, { key: 'cc:x', name: 'alpha', threadId: SESSION_TOPIC });
  const { exitCode } = await tg(h, ['--tag', 'answer', '--reply-to', '19000', 'status ok']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].message_thread_id).toBe(TOPIC);
  expect(sent[0].reply_to_message_id).toBe(19000);
  // The anchor's own topic wins over the session's: no daemon round trip is needed for it.
  expect(asked.filter((a) => a.kind === 'resolve-session')).toHaveLength(0);
});

test('every chunk of a split reply stays in the anchor topic', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  const paragraph = `${'слово '.repeat(150)}\n\n`;
  const { exitCode } = await tg(h, ['--reply-to', '19000', paragraph.repeat(8)]);
  expect(exitCode).toBe(0);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.map((b) => b.message_thread_id)).toEqual(sent.map(() => TOPIC));
  expect(sent.map((b) => b.reply_to_message_id)).toEqual([19000, ...sent.slice(1).map(() => undefined)]);
});

test('the reply row is recorded with the thread it was posted into, so a reply to the reply stays there too', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  await tg(h, ['--reply-to', '19000', 'first']);
  const [row] = outboundRows(h);
  expect(row.threadId).toBe(TOPIC);
});

test('a reply to a message that sits in General stays in General', async () => {
  const h = makeHome([userRow(19010, null)]);
  const asked = startDaemon(h.cfg, { key: 'cc:x', name: 'alpha', threadId: SESSION_TOPIC });
  const { exitCode } = await tg(h, ['--reply-to', '19010', 'in general']);
  expect(exitCode).toBe(0);
  expect('message_thread_id' in sent[0]).toBe(false);
  expect(sent[0].reply_to_message_id).toBe(19010);
  // No lookup either: asking would open a topic for a session that posted nothing into one.
  expect(asked).toHaveLength(0);
  expect(outboundRows(h)[0].threadId).toBeNull();
});

test('an anchor the history does not know falls back to the session\'s own topic', async () => {
  const h = makeHome([]);
  const asked = startDaemon(h.cfg, { key: 'cc:x', name: 'alpha', threadId: SESSION_TOPIC });
  const { exitCode } = await tg(h, ['--reply-to', '123', 'old anchor']);
  expect(exitCode).toBe(0);
  expect(sent[0].message_thread_id).toBe(SESSION_TOPIC);
  expect(sent[0].reply_to_message_id).toBe(123);
  expect(asked.filter((a) => a.kind === 'resolve-session')).toHaveLength(1);
});

test('a legacy row without a thread is an unknown anchor too', async () => {
  const h = makeHome([userRow(19000)]);
  startDaemon(h.cfg, { key: 'cc:x', name: 'alpha', threadId: SESSION_TOPIC });
  await tg(h, ['--reply-to', '19000', 'legacy']);
  expect(sent[0].message_thread_id).toBe(SESSION_TOPIC);
});

test('an unknown anchor with no daemon posts the reply alone, as before', async () => {
  const h = makeHome([]);
  const { exitCode } = await tg(h, ['--reply-to', '123', 'no daemon']);
  expect(exitCode).toBe(0);
  expect('message_thread_id' in sent[0]).toBe(false);
  expect(sent[0].reply_to_message_id).toBe(123);
});

test('an explicit --topic still wins over the anchor\'s topic', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  await tg(h, ['--topic', '7', '--reply-to', '19000', 'explicit']);
  expect(sent[0].message_thread_id).toBe(7);
});

test('an anchor topic that Telegram refuses falls back to General without the anchor, send still succeeds', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  const asked = startDaemon(h.cfg, { key: 'cc:x', name: 'alpha', threadId: TOPIC });
  rejectThreaded = true;
  try {
    const { exitCode, stderr } = await tg(h, ['--reply-to', '19000', 'topic is gone']);
    expect(exitCode).toBe(0);
    expect(sent.map((b) => b.message_thread_id)).toEqual([TOPIC, undefined]);
    expect(stderr).toContain('resending to General');
    expect(outboundRows(h)[0].threadId).toBeNull();
    // No lookup is made for a refused anchor topic: a lookup would lazily open a topic for a
    // session that posted nothing into one. Its own sends report the miss to the daemon.
    expect(asked).toHaveLength(0);
  } finally {
    rejectThreaded = false;
  }
});

test('topics off: a reply stays exactly as before, no thread', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  writeFileSync(join(h.cfg, 'config.yaml'), 'control:\n  topics: false\n');
  await tg(h, ['--reply-to', '19000', 'topics off']);
  expect('message_thread_id' in sent[0]).toBe(false);
});

test('a topic that is lost midway through a split reply leaves the chunks already posted labelled with their topic', async () => {
  const h = makeHome([userRow(19000, TOPIC)]);
  rejectThreaded = true;
  acceptThreadedFirst = 1;
  try {
    const paragraph = `${'слово '.repeat(150)}\n\n`;
    const { exitCode } = await tg(h, ['--reply-to', '19000', paragraph.repeat(8)]);
    expect(exitCode).toBe(0);
    const rows = outboundRows(h);
    expect(rows.length).toBeGreaterThan(1);
    // Chunk 1 went into the topic before it was lost; every later chunk fell back to General.
    expect(rows.map((r) => r.threadId)).toEqual([TOPIC, ...rows.slice(1).map(() => null)]);
  } finally {
    rejectThreaded = false;
    acceptThreadedFirst = 0;
  }
});
