// tg-cli#533, end to end: a real `tg-ctl run` discovers a (fake) opencode 2.x background
// service from its state file, subscribes to its `GET /api/event` stream, posts a Telegram card
// for each permission / form ask, and delivers the tapped answer back through opencode's reply
// route — also after the unscoped-ask bound and across a daemon restart (tg-cli#687). Event
// shapes are the ones recorded from opencode 2.0.20 (tests/fixtures/opencode).

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, mkdirSync, openSync, readFileSync, watch, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir, trackChild } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PROJECT = '/work/oc-project';
const PASSWORD = 'oc-secret';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

const cfgDir = tempDir('tgctl-ocsse-');
// The daemon's unscoped-ask bound, shortened so a tap can land past it (tg-cli#687).
const UNSCOPED_BOUND_MS = 500;
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: PROJECT }));
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

const recorded = readFileSync(join(import.meta.dir, 'fixtures', 'opencode', 'opencode-2.0.20-events.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const recordedOf = (type: string): Record<string, unknown> => structuredClone(recorded.find((e) => e.type === type)!);

// ---- fake opencode 2.x service -------------------------------------------------------------
const sessions: Record<string, Record<string, unknown>> = {
  ses_child: { id: 'ses_child', parentID: 'ses_main', title: 'Scan repo (@explore subagent)', location: { directory: PROJECT } },
  ses_main: { id: 'ses_main', title: 'Main work', location: { directory: PROJECT } },
  ses_nodir: { id: 'ses_nodir', title: 'No directory' },
  ses_emptydir: { id: 'ses_emptydir', title: 'Empty directory', location: { directory: ' ' } },
};
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
const streamWaiters: (() => void)[] = [];
const replies: { path: string; body: unknown }[] = [];
const replyWaiters: (() => void)[] = [];
// Replies still to answer 503 (opencode busy), and waiters on each such refusal.
let unavailableReplies = 0;
const unavailableWaiters: (() => void)[] = [];
const unauthorized: string[] = [];

const opencode = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('authorization') !== AUTH) {
      unauthorized.push(url.pathname);
      return Response.json({ _tag: 'UnauthorizedError' }, { status: 401 });
    }
    if (url.pathname === '/api/event') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          controller.enqueue(new TextEncoder().encode('data: {"id":"evt_0","type":"server.connected","data":{}}\n\n'));
          streamWaiters.splice(0).forEach((w) => w());
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    const session = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (session && req.method === 'GET') {
      if (session[1] === 'ses_broken') return Response.json({ _tag: 'InternalError' }, { status: 500 });
      const rec = sessions[session[1]];
      return rec ? Response.json({ data: rec }) : Response.json({ _tag: 'SessionNotFoundError' }, { status: 404 });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/reply')) {
      if (unavailableReplies > 0) {
        unavailableReplies--;
        unavailableWaiters.splice(0).forEach((w) => w());
        return Response.json({ _tag: 'ServiceUnavailable' }, { status: 503 });
      }
      replies.push({ path: url.pathname, body: await req.json() });
      replyWaiters.splice(0).forEach((w) => w());
      return new Response(null, { status: 204 });
    }
    return Response.json({ unexpected: url.pathname }, { status: 404 });
  },
});

function emit(event: Record<string, unknown>): void {
  const line = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  streams.at(-1)!.enqueue(line);
}
function waiter(list: (() => void)[]): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  list.push(resolve);
  return promise;
}
const nextStream = (): Promise<void> => waiter(streamWaiters);
const nextReply = (): Promise<void> => waiter(replyWaiters);

// ---- fake Telegram ----------------------------------------------------------------------------
interface Card { messageId: number; text: string; buttons: { text: string; callback_data: string }[] }
const cards: Card[] = [];
const cardWaiters: (() => void)[] = [];
const taps: string[] = [];
const tapWaiters: (() => void)[] = [];
let updateId = 500;

const telegram = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const data = taps.shift();
      if (data) {
        return Response.json({
          ok: true,
          result: [{
            update_id: ++updateId,
            callback_query: {
              id: `cb${updateId}`,
              from: { id: 1, first_name: 'Alex' },
              message: { message_id: tapMessageIds.shift(), chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
              data,
            },
          }],
        });
      }
      // Hold the long-poll until a tap is queued or the daemon drops it — no polling timer.
      const aborted = Promise.withResolvers<void>();
      req.signal.addEventListener('abort', () => aborted.resolve());
      await Promise.race([waiter(tapWaiters), aborted.promise]);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as { text: string; reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][] } };
      cards.push({ messageId: 4001 + cards.length, text: body.text, buttons: (body.reply_markup?.inline_keyboard ?? []).flat() });
      cardWaiters.splice(0).forEach((w) => w());
      return Response.json({ ok: true, result: { message_id: 4000 + cards.length } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      const body = (await req.json()) as { message_id: number; text: string };
      edits.push(body);
      editWaiters.splice(0).forEach((w) => w());
    }
    return Response.json({ ok: true, result: true });
  },
});
const nextCard = (): Promise<void> => waiter(cardWaiters);
const edits: { message_id: number; text: string }[] = [];
const editWaiters: (() => void)[] = [];
const nextEdit = (): Promise<void> => waiter(editWaiters);

const tapMessageIds: number[] = [];
function tap(card: Card, label: string): void {
  const button = card.buttons.find((b) => b.text.includes(label));
  expect(button).toBeDefined();
  tapMessageIds.push(card.messageId);
  taps.push(button!.callback_data);
  tapWaiters.splice(0).forEach((w) => w());
}

// Resolves true when `p` settles within `ms`, so a missing reply fails on its assertion
// instead of on the test timeout. A real clock: the awaited event happens in the daemon
// subprocess, out of reach of fake timers.
function within(p: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true), Bun.sleep(ms).then(() => false)]);
}

// Resolves once the daemon's question store holds `requestId` with its card id — written
// just after the card posts, so a restart from then on restores the card. Watched, not polled.
async function stored(requestId: string, messageId: number): Promise<void> {
  const path = join(cfgDir, 'tg-ctl.123.questions.json');
  const holds = (): boolean => {
    try {
      const store = JSON.parse(readFileSync(path, 'utf8')) as { questions?: { req?: { requestId?: string }; messageId?: number | null }[] };
      return store.questions?.some((q) => q.req?.requestId === requestId && q.messageId === messageId) ?? false;
    } catch {
      return false; // not written yet
    }
  };
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(cfgDir, () => {
    if (holds()) resolve();
  });
  if (holds()) resolve(); // written before the watch began
  await promise;
  watcher.close();
}

// ---- daemon ------------------------------------------------------------------------------------
const procs: Subprocess[] = [];
function startDaemon(): Subprocess {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const proc = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${telegram.port}`,
      TG_CTL_UNSCOPED_TIMEOUT_MS: String(UNSCOPED_BOUND_MS),
    },
    stdio: ['ignore', logFd, logFd],
  }));
  closeSync(logFd);
  procs.push(proc);
  return proc;
}

beforeAll(async () => {
  const stateDir = join(cfgDir, '.local', 'state', 'opencode');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'service.json'), JSON.stringify({
    id: 'svc', version: '2.0.20', url: `http://127.0.0.1:${opencode.port}`, pid: process.pid, password: PASSWORD,
  }));
  const subscribed = nextStream();
  startDaemon();
  // The bridge starts after the hook socket is listening, so a subscription proves both.
  await subscribed;
}, 15_000);

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  opencode.stop(true);
  telegram.stop(true);
});

test('a child-session permission ask posts a card labelled with the subagent, and Approve replies once', async () => {
  const event = recordedOf('permission.asked');
  event.data = { ...(event.data as object), id: 'per_child1', sessionID: 'ses_child' };
  const carded = nextCard();
  emit(event);
  await carded;
  const card = cards.at(-1)!;
  expect(card.text).toContain('external_directory');
  expect(card.text).toContain('subagent=Scan repo (@explore subagent)');

  const replied = nextReply();
  tap(card, 'Approve');
  await replied;
  expect(replies.at(-1)).toEqual({ path: '/api/session/ses_child/permission/per_child1/reply', body: { decision: 'once' } });
  expect(unauthorized).toEqual([]);
}, 15_000);

test('a top-level form ask posts option buttons without a subagent label, and the tap replies with the option value', async () => {
  const event = recordedOf('form.created');
  const data = event.data as { form: Record<string, unknown> };
  data.form = { ...data.form, id: 'frm_main1', sessionID: 'ses_main' };
  const carded = nextCard();
  emit(event);
  await carded;
  const card = cards.at(-1)!;
  expect(card.text).toContain('Which?');
  expect(card.text).not.toContain('subagent=');

  const replied = nextReply();
  tap(card, 'Beta');
  await replied;
  expect(replies.at(-1)).toEqual({ path: '/api/session/ses_main/form/frm_main1/reply', body: { answer: { choice: 'b' } } });
}, 15_000);

test('a dropped event stream is resubscribed and later asks still reach Telegram', async () => {
  const resubscribed = nextStream();
  streams.at(-1)!.close();
  await resubscribed;

  const event = recordedOf('permission.asked');
  event.data = { ...(event.data as object), id: 'per_after', sessionID: 'ses_main' };
  const carded = nextCard();
  emit(event);
  await carded;
  expect(cards.at(-1)!.text).toContain('external_directory');
}, 15_000);

test('an ask answered in the opencode TUI retires its Telegram card and sends no reply', async () => {
  const event = recordedOf('permission.asked');
  event.data = { ...(event.data as object), id: 'per_tui', sessionID: 'ses_main' };
  const carded = nextCard();
  emit(event);
  await carded;
  const messageId = 4000 + cards.length;
  const repliesBefore = replies.length;

  const settled = recordedOf('permission.replied');
  settled.data = { sessionID: 'ses_main', requestID: 'per_tui', reply: 'once' };
  emit(settled);
  while (!edits.some((e) => e.message_id === messageId)) await nextEdit();
  expect(replies.length).toBe(repliesBefore);
}, 15_000);

// tg-cli#687: opencode holds an ask until it is answered, so the daemon's unscoped bound must
// not end it — a bridge ask defers no pane, which is all that bound exists to release.
test('a tap after the unscoped-ask bound still replies to opencode', async () => {
  const event = recordedOf('permission.asked');
  event.data = { ...(event.data as object), id: 'per_late', sessionID: 'ses_main' };
  const carded = nextCard();
  emit(event);
  await carded;
  const card = cards.at(-1)!;
  // The bound is a real timer in the daemon subprocess; only waiting past it exercises it.
  await Bun.sleep(UNSCOPED_BOUND_MS * 3);

  const replied = nextReply();
  tap(card, 'Approve');
  expect(await within(replied, 5_000)).toBe(true);
  expect(replies.at(-1)).toEqual({ path: '/api/session/ses_main/permission/per_late/reply', body: { decision: 'once' } });
}, 15_000);

test('an ask whose session cannot be read, or has no directory, is reported to Telegram instead of dropped silently', async () => {
  for (const [sessionID, why] of [['ses_broken', 'HTTP 500'], ['ses_nodir', 'no directory'], ['ses_emptydir', 'no directory']]) {
    const event = recordedOf('permission.asked');
    event.data = { ...(event.data as object), id: `per_${sessionID}`, sessionID };
    const before = cards.length;
    const posted = nextCard();
    emit(event);
    expect(await within(posted, 10_000)).toBe(true);
    const notice = cards[before]!;
    expect(notice.buttons).toEqual([]);
    expect(notice.text).toContain(sessionID);
    expect(notice.text).toContain(why);
    expect(notice.text).toContain('answer it in opencode');
  }
}, 35_000);

// The durable question store carries a bridge card across a daemon restart: opencode still
// holds the ask, so a tap on the card the old daemon posted reaches it — and a tap opencode
// is too busy to take (503) keeps the card for another tap rather than expiring it.
test('a tap on a card posted before a daemon restart still replies to opencode, after a busy retry', async () => {
  const event = recordedOf('form.created');
  const data = event.data as { form: Record<string, unknown> };
  data.form = { ...data.form, id: 'frm_restart', sessionID: 'ses_main' };
  const carded = nextCard();
  emit(event);
  await carded;
  const card = cards.at(-1)!;
  await stored('oc_ses_main_frm_restart', card.messageId);

  const old = procs.at(-1)!;
  old.kill(9);
  await old.exited;
  const resubscribed = nextStream();
  startDaemon();
  await resubscribed;

  unavailableReplies = 1;
  const busy = waiter(unavailableWaiters);
  tap(card, 'Beta');
  expect(await within(busy, 5_000)).toBe(true);

  const replied = nextReply();
  tap(card, 'Beta');
  expect(await within(replied, 5_000)).toBe(true);
  expect(replies.at(-1)).toEqual({ path: '/api/session/ses_main/form/frm_restart/reply', body: { answer: { choice: 'b' } } });
}, 25_000);
