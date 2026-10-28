import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { parseHistory } from '../features/replies/history';
import { parseRemoteRoutes } from '../features/tg-ctl/remote-routes';
import { LOCAL_PANE, createHubKit, makeHubHarness, recordLine, socketRequest, waitFor, type HubHarness } from './helpers/remote-hub-harness';

// `{"kind":"remote-record"|"remote-status",…}` on the daemon hook socket — what `tg-remote server`
// relays for a client machine (docs/specs/2026-10-28-remote-ctl-server.md §4.1, §5 "Apply"). A real
// daemon, the real 0600 socket, a fake Bot API that never receives anything.

const kit = createHubKit();
afterEach(kit.cleanup);

const MACHINES = [{ name: 'clvm', target: 'ultra@h1' }, { name: 'lab', target: 'ultra@h2' }];

async function boot(opts: Parameters<typeof makeHubHarness>[0] = { remoteMachines: 'clvm=ultra@h1,lab=ultra@h2', machines: MACHINES }): Promise<HubHarness> {
  const h = makeHubHarness({ localRoutes: [500], ...opts });
  await kit.daemon(h, kit.tg());
  expect(await waitFor(() => existsSync(h.file('tg-ctl.123.sock')))).toBe(true);
  return h;
}

const ask = async (h: HubHarness, line: string): Promise<Record<string, unknown>> => JSON.parse(await socketRequest(h, line)) as Record<string, unknown>;
const remoteRoutes = (h: HubHarness) => parseRemoteRoutes(h.read('tg-ctl.123.remote-routes.json'));
const remoteHistory = (h: HubHarness) => parseHistory(h.read('tg-ctl.123.history.jsonl')).filter((r) => r.machine !== undefined);

test('a record is applied: one remote route, one namespaced history row, and nothing local is touched', async () => {
  const h = await boot();
  const routesBefore = h.read('tg-ctl.123.routes.json');

  expect(await ask(h, recordLine())).toEqual({ ok: true, applied: true, routes: 1, history: 1 });

  expect(remoteRoutes(h)).toEqual([
    {
      machine: 'clvm',
      chat: '1',
      id: 700,
      route: { paneId: LOCAL_PANE, cwd: '/srv/remote-proj', agentPid: 3003, serverPid: 4321, panePid: 5555, sessionKey: `cc:pane:4321/${LOCAL_PANE}/5555` },
      name: { primary: 'remoteproj', secondary: null },
      ts: 1_730_100_000_000,
    },
  ]);
  expect(remoteHistory(h)).toEqual([
    {
      ts: 1_730_100_000,
      message_id: 700,
      chat_id: 1,
      direction: 'agent',
      from: 'agent',
      text: 'report from the remote machine',
      pane: `clvm/${LOCAL_PANE}`,
      targetAgent: 'clvm/remoteproj',
      sessionKey: `clvm/cc:pane:4321/${LOCAL_PANE}/5555`,
      threadId: null,
      machine: 'clvm',
    },
  ]);
  // routes.json is the LOCAL agents' map; last-user-target.json is the local anchor; sessions.json the local registry.
  expect(h.read('tg-ctl.123.routes.json')).toBe(routesBefore);
  expect(h.read('tg-ctl.123.last-user-target.json')).toBeNull();
  expect(h.read('tg-ctl.123.sessions.json') ?? '').not.toContain('remoteproj');
}, 30_000);

test('applying twice is one route and one history group; the replay says applied:false and writes nothing', async () => {
  const h = await boot();
  const record = { ids: [{ id: 700, threadId: null }, { id: 701, threadId: null }] };

  expect(await ask(h, recordLine({}, 'clvm', record))).toMatchObject({ ok: true, applied: true, routes: 2, history: 2 });
  const stored = h.read('tg-ctl.123.remote-routes.json');
  const history = h.read('tg-ctl.123.history.jsonl');
  expect(await ask(h, recordLine({}, 'clvm', record))).toEqual({ ok: true, applied: false, routes: 2, history: 0 });

  expect(h.read('tg-ctl.123.remote-routes.json')).toBe(stored);
  expect(h.read('tg-ctl.123.history.jsonl')).toBe(history);
  const rows = remoteHistory(h);
  expect(rows.map((r) => r.message_id)).toEqual([700, 701]);
  expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
}, 30_000);

test('hostile lines are refused with a code and leave no trace: spoofed machine, unknown peer, unknown fields, NUL', async () => {
  const h = await boot();
  const cases: [string, string][] = [
    [recordLine({}, 'clvm', { machine: 'ubuntu' }), 'BAD_REQUEST'], // payload machine is not the authenticated peer
    [recordLine({}, 'ubuntu'), 'PEER_UNKNOWN'], // the peer is re-resolved from config, not trusted from the line
    [recordLine({ extra: 1 }), 'BAD_REQUEST'],
    [recordLine({}, 'clvm', { extra: 1 }), 'BAD_REQUEST'],
    [recordLine({}, 'clvm', { history: { text: 'a\u0000b' } }), 'BAD_REQUEST'],
    [recordLine({}, 'clvm', { ids: [] }), 'BAD_REQUEST'],
    [recordLine({}, 'clvm', { route: { paneId: '%3', cwd: 'a\nb' } }), 'BAD_REQUEST'],
    [recordLine({ peer: 7 }), 'BAD_REQUEST'],
    [JSON.stringify({ kind: 'remote-record', peer: 'clvm' }), 'BAD_REQUEST'],
  ];
  for (const [line, code] of cases) expect(await ask(h, line)).toMatchObject({ ok: false, code });

  expect(existsSync(h.file('tg-ctl.123.remote-routes.json'))).toBe(false);
  expect(remoteHistory(h)).toEqual([]);
}, 40_000);

test('a peer can never overwrite a route another machine recorded', async () => {
  const h = await boot();
  expect(await ask(h, recordLine())).toMatchObject({ ok: true, applied: true });
  const stored = h.read('tg-ctl.123.remote-routes.json');

  expect(await ask(h, recordLine({}, 'lab', { history: { text: 'hijack', targetAgent: 'lab/x' } }))).toMatchObject({ ok: false, code: 'BAD_REQUEST' });

  expect(h.read('tg-ctl.123.remote-routes.json')).toBe(stored);
  expect(remoteRoutes(h).map((r) => r.machine)).toEqual(['clvm']);
}, 30_000);

test('large and Unicode text: 256 KiB passes the socket, one byte more is refused; astral, RTL and combining marks survive', async () => {
  const h = await boot();
  const edge = 'x'.repeat(256 * 1024);

  expect(await ask(h, recordLine({}, 'clvm', { history: { text: edge, truncated: true } }))).toMatchObject({ ok: true, applied: true });
  expect((await ask(h, recordLine({}, 'clvm', { ids: [{ id: 701 }], history: { text: `${edge}x` } })))).toMatchObject({ ok: false });
  const odd = 'emoji 😀🧑‍💻 rtl שלום עולם e\u0301';
  expect(await ask(h, recordLine({}, 'clvm', { ids: [{ id: 702 }], history: { text: odd } }))).toMatchObject({ ok: true, applied: true });
  // JSON escaping doubles every quote: 256 KiB of text is a 512 KiB line, still inside the 1 MiB wire cap.
  const quotes = '"'.repeat(256 * 1024);
  expect(await ask(h, recordLine({}, 'clvm', { ids: [{ id: 703 }], history: { text: quotes } }))).toMatchObject({ ok: true, applied: true });

  const rows = remoteHistory(h);
  expect(rows.find((r) => r.message_id === 700)?.text).toBe(edge);
  expect(rows.find((r) => r.message_id === 702)?.text).toBe(odd);
  expect(rows.find((r) => r.message_id === 703)?.text).toBe(quotes);
  expect(remoteRoutes(h).map((r) => r.id)).toEqual([700, 702, 703]);
}, 40_000);

test('remote-status answers the daemon facts and what this peer recorded; an unknown peer is refused', async () => {
  const h = await boot();
  expect(await ask(h, JSON.stringify({ kind: 'remote-status', peer: 'clvm' }))).toMatchObject({
    ok: true,
    daemon: { up: true },
    remote: { records: 0, lastRecordAt: null, lastDeliver: null },
  });

  await ask(h, recordLine());
  const status = await ask(h, JSON.stringify({ kind: 'remote-status', peer: 'clvm' }));
  expect(status).toMatchObject({ ok: true, remote: { records: 1, lastDeliver: null } });
  expect(typeof (status.daemon as { pid: number }).pid).toBe('number');
  expect(typeof (status.remote as { lastRecordAt: number }).lastRecordAt).toBe('number');
  // The other machine has recorded nothing.
  expect(await ask(h, JSON.stringify({ kind: 'remote-status', peer: 'lab' }))).toMatchObject({ ok: true, remote: { records: 0 } });

  expect(await ask(h, JSON.stringify({ kind: 'remote-status', peer: 'ubuntu' }))).toMatchObject({ ok: false, code: 'PEER_UNKNOWN' });
  expect(await ask(h, JSON.stringify({ kind: 'remote-status', peer: 'clvm', extra: 1 }))).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
}, 30_000);

test('a host that serves no machine refuses every remote line and writes nothing', async () => {
  const h = await boot({});

  expect(await ask(h, recordLine())).toMatchObject({ ok: false, code: 'PEER_UNKNOWN' });
  expect(await ask(h, JSON.stringify({ kind: 'remote-status', peer: 'clvm' }))).toMatchObject({ ok: false, code: 'PEER_UNKNOWN' });
  for (const name of ['tg-ctl.123.remote-routes.json', 'tg-ctl.123.remote-status.json']) expect(existsSync(h.file(name))).toBe(false);
  expect(h.remote.calls()).toEqual([]);
}, 30_000);
