// tg-cli#533: the opencode bridge — server discovery, the bounded SSE decoder, and the
// subscribe → ask → reply loop for the 1.x wire (the daemon test covers 2.x end to end).
import { afterAll, expect, test } from 'bun:test';
import {
  createSseDecoder,
  DEFAULT_BRIDGE_OPTIONS,
  discoverOpencodeServers,
  opencodeServiceFromState,
  parseLsofListenUrls,
  startOpencodeBridge,
  type DiscoveryIo,
  type OpencodeServer,
} from '../features/tg-ctl/opencode-bridge';
import type { ButtonRequest } from '../features/tg-ctl/questions';

const alive = (): boolean => true;

test('the 2.x service state file yields the shared server with Basic auth', () => {
  const state = JSON.stringify({ id: 'x', version: '2.0.20', url: 'http://127.0.0.1:49374/', pid: 42, password: 'pw' });
  expect(opencodeServiceFromState(state, alive)).toEqual({
    url: 'http://127.0.0.1:49374',
    protocol: 'api',
    authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
  });
});

test('a stale, missing or malformed service state file yields no server', () => {
  const state = JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 42, password: 'pw' });
  expect(opencodeServiceFromState(state, () => false)).toBeNull();
  expect(opencodeServiceFromState(null, alive)).toBeNull();
  expect(opencodeServiceFromState('{nope', alive)).toBeNull();
  expect(opencodeServiceFromState(JSON.stringify({ url: 'file:///etc/passwd' }), alive)).toBeNull();
});

test('lsof name lines give loopback URLs: IPv4/wildcard on 127.0.0.1, IPv6 on [::1]', () => {
  const out = ['p123', 'f20', 'n127.0.0.1:4096', 'f21', 'n*:5000', 'n[::1]:6000', 'n10.0.0.5:7000', 'n0.0.0.0:7100', 'n127.0.0.1:4096'].join('\n');
  expect(parseLsofListenUrls(out)).toEqual([
    'http://127.0.0.1:4096',
    'http://127.0.0.1:5000',
    'http://[::1]:6000',
    'http://127.0.0.1:7100',
  ]);
});

// A legacy (1.x) server lists sessions as a JSON array at GET /session; a 2.x UI port does not.
const legacy = Bun.serve({ port: 0, fetch: () => Response.json([{ id: 'ses_1' }]) });
const html = (): Response => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
const service = Bun.serve({ port: 0, fetch: html });
const standaloneUi = Bun.serve({ port: 0, fetch: html });
afterAll(() => {
  legacy.stop(true);
  service.stop(true);
  standaloneUi.stop(true);
});

test('per-session 1.x servers are found from opencode listening ports; the service port and 2.x UI ports are not', async () => {
  const probed: string[] = [];
  const io: DiscoveryIo = {
    readServiceState: async () => JSON.stringify({ url: `http://127.0.0.1:${service.port}`, pid: 1, password: 'pw' }),
    pidAlive: alive,
    opencodePids: async () => [101, 102],
    listenUrls: async (pids) => {
      expect(pids).toEqual([101, 102]);
      return [`http://127.0.0.1:${legacy.port}`, `http://[::1]:${service.port}`, `http://127.0.0.1:${standaloneUi.port}`];
    },
    fetch: (url, init) => {
      probed.push(url);
      return fetch(url, init);
    },
  };
  const servers = await discoverOpencodeServers(io, 2_000);
  expect(servers.map((s) => [s.url, s.protocol])).toEqual([
    [`http://127.0.0.1:${service.port}`, 'api'],
    [`http://127.0.0.1:${legacy.port}`, 'legacy'],
  ]);
  expect(probed).toEqual([`http://127.0.0.1:${legacy.port}/session`, `http://127.0.0.1:${standaloneUi.port}/session`]);
});

test('no opencode process means no port probe', async () => {
  const io: DiscoveryIo = {
    readServiceState: async () => null,
    pidAlive: alive,
    opencodePids: async () => [],
    listenUrls: async () => {
      throw new Error('must not run lsof without opencode processes');
    },
    fetch: () => {
      throw new Error('must not probe');
    },
  };
  expect(await discoverOpencodeServers(io, 2_000)).toEqual([]);
});

test('the SSE decoder joins data lines across chunk boundaries and ignores comments', () => {
  const seen: string[] = [];
  const decode = createSseDecoder((d) => seen.push(d), 1_000);
  decode(': heartbeat\n\ndata: {"type":');
  decode('"a"}\r\n\ndata: x\ndata: y\n');
  decode('\n');
  expect(seen).toEqual(['{"type":"a"}', 'x\ny']);
});

test('the SSE decoder drops an oversized event whole and recovers on the next one', () => {
  const seen: string[] = [];
  const decode = createSseDecoder((d) => seen.push(d), 16);
  decode(`data: ${'x'.repeat(40)}\ndata: tail\n\n`);
  decode(`data: ${'y'.repeat(40)}`);
  decode('\n\ndata: ok\n\n');
  expect(seen).toEqual(['ok']);
});

// A fake opencode server: SSE at `eventPath`, session records, reply capture. `accept` decides
// which Authorization header it answers (401 otherwise); replies answer `replyStatus`.
function fakeOpencode(eventPath: string, accept: (auth: string | null) => boolean, replyStatus = 200) {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const subscribed: (() => void)[] = [];
  const replies: { path: string; body: unknown }[] = [];
  const replied: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!accept(req.headers.get('authorization'))) return new Response('unauthorized', { status: 401 });
      if (url.pathname === eventPath) {
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            streams.push(c);
            subscribed.splice(0).forEach((w) => w());
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === '/session/ses_child') return Response.json({ id: 'ses_child', parentID: 'ses_main', title: 'Fix lint (@general subagent)', directory: '/work/legacy' });
      if (req.method === 'POST') {
        replies.push({ path: url.pathname, body: await req.json() });
        replied.splice(0).forEach((w) => w());
        return Response.json(true, { status: replyStatus });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    replies,
    nextSubscription: () => nextOf(subscribed),
    nextReply: () => nextOf(replied),
    emit: (event: unknown) => streams.at(-1)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    stop: () => server.stop(true),
  };
}

function nextOf(list: (() => void)[]): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  list.push(resolve);
  return promise;
}

const FAST = { ...DEFAULT_BRIDGE_OPTIONS, rescanMs: 20, reconnectMinMs: 20, reconnectMaxMs: 40 };

test('1.x wire: a child-session permission ask is asked with its subagent and cwd, and Approve replies once', async () => {
  const oc = fakeOpencode('/event', () => true);
  let servers: OpencodeServer[] = [{ url: oc.url, protocol: 'legacy' }];
  const asked: ButtonRequest[] = [];
  const subscribed = oc.nextSubscription();
  startOpencodeBridge({
    discover: async () => servers,
    fetch: (url, init) => fetch(url, init),
    ask: async (req) => {
      asked.push(req);
      return JSON.stringify({ answer: 'allow' });
    },
    log: () => {},
    notify: () => {
      throw new Error('a successful reply must not notify');
    },
  }, FAST);
  await subscribed;
  const replied = oc.nextReply();
  oc.emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_child', permission: 'bash', patterns: ['rm -rf dist'] } });
  await replied;
  expect(asked[0]).toMatchObject({ kind: 'permission', subagent: 'Fix lint (@general subagent)', cwd: '/work/legacy' });
  expect(oc.replies).toEqual([{ path: '/permission/per_1/reply', body: { reply: 'once' } }]);
  servers = [];
  oc.stop();
});

test('a service restarted on the same URL with a new password is resubscribed with the new credentials', async () => {
  const auth = (pw: string): string => `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}`;
  const oc = fakeOpencode('/api/event', (header) => header === auth('new'));
  let servers: OpencodeServer[] = [{ url: oc.url, protocol: 'api', authorization: auth('old') }];
  const rejectedLogs: (() => void)[] = [];
  const rejected = nextOf(rejectedLogs);
  startOpencodeBridge({
    discover: async () => servers,
    fetch: (url, init) => fetch(url, init),
    ask: async () => null,
    log: (line) => {
      if (line.includes('HTTP 401')) rejectedLogs.splice(0).forEach((w) => w());
    },
    notify: () => {},
  }, FAST);
  await rejected; // the stale password was tried and refused
  const subscribed = oc.nextSubscription();
  servers = [{ url: oc.url, protocol: 'api', authorization: auth('new') }];
  await subscribed;
  servers = [];
  oc.stop();
});

test('a reply opencode refuses is reported to Telegram, since the card already said "sent"', async () => {
  const oc = fakeOpencode('/event', () => true, 404);
  let servers: OpencodeServer[] = [{ url: oc.url, protocol: 'legacy' }];
  const notices: string[] = [];
  const notified: (() => void)[] = [];
  const noticed = nextOf(notified);
  const subscribed = oc.nextSubscription();
  startOpencodeBridge({
    discover: async () => servers,
    fetch: (url, init) => fetch(url, init),
    ask: async () => JSON.stringify({ answer: 'allow' }),
    log: () => {},
    notify: (text) => {
      notices.push(text);
      notified.splice(0).forEach((w) => w());
    },
  }, FAST);
  await subscribed;
  oc.emit({ type: 'permission.asked', properties: { id: 'per_gone', sessionID: 'ses_child', permission: 'edit' } });
  await noticed;
  expect(notices).toEqual(['opencode did not take the answer to "edit" (HTTP 404) — answer it in opencode.']);
  servers = [];
  oc.stop();
});
