import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseHistory } from '../features/replies/history';
import { appendHistoryFile } from '../features/replies/history-file';
import { fsRoutesLockIo } from '../features/tg-ctl/routes';
import {
  applyRemoteRoutes,
  MAX_REMOTE_ROUTES,
  newHistoryRows,
  parseRemoteRecord,
  parseRemoteRoutes,
  recognizeRemoteRoute,
  remoteHistoryRows,
  upsertRemoteRecord,
  type RemoteRecord,
} from '../features/tg-ctl/remote-routes';
import { tempDir } from './helpers/test-temp';

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  chat: '1',
  ids: [{ id: 500, threadId: null }],
  route: { paneId: '%3', cwd: '/srv/proj', agentPid: 4242, serverPid: 99, panePid: 100, sessionKey: 'cc:pane:99/%3/100' },
  history: { text: 'hello from clvm', targetAgent: 'clvm/proj', groupToken: 'g1', truncated: false },
  name: { primary: 'proj', secondary: 'a title' },
  ts: 1_730_100_000_000,
  ...over,
});

function record(over: Record<string, unknown> = {}): RemoteRecord {
  const parsed = parseRemoteRecord(body(over), 'clvm');
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.record;
}

test('a well-formed record parses; v/op/machine heads the server leaves on the relayed request are accepted', () => {
  const ok = parseRemoteRecord({ ...body(), v: 1, op: 'record', machine: 'clvm' }, 'clvm');
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.record.ids).toEqual([{ id: 500, threadId: null }]);
    expect(ok.record.route.paneId).toBe('%3');
    expect(ok.record.history.truncated).toBe(false);
    expect(ok.record).not.toHaveProperty('machine');
  }
});

test('closed schema: unknown fields anywhere are rejected, not ignored', () => {
  const bad: Record<string, unknown>[] = [
    body({ extra: 1 }),
    body({ route: { paneId: '%3', extra: 1 } }),
    body({ history: { text: 'x', extra: 1 } }),
    body({ name: { primary: 'p', extra: 1 } }),
    body({ ids: [{ id: 1, extra: 1 }] }),
  ];
  for (const b of bad) expect(parseRemoteRecord(b, 'clvm').ok).toBe(false);
});

test('spoof: a payload machine that is not the authenticated peer is refused, never re-attributed', () => {
  const spoofed = parseRemoteRecord({ ...body(), machine: 'ubuntu' }, 'clvm');
  expect(spoofed.ok).toBe(false);
  expect(parseRemoteRecord({ ...body(), peer: 'other' }, 'clvm').ok).toBe(false);
  // The peer itself must be a machine-shaped name (it comes from config, but is checked anyway).
  expect(parseRemoteRecord(body(), '../etc').ok).toBe(false);
});

test('types and sizes are enforced', () => {
  const rejects: Record<string, unknown>[] = [
    body({ chat: 'abc' }),
    body({ chat: 1 }),
    body({ chat: '99999999999999999999' }),
    body({ ts: -1 }),
    body({ ts: 1.5 }),
    body({ ids: [] }),
    body({ ids: Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })) }),
    body({ ids: [{ id: 0 }] }),
    body({ ids: [{ id: 5 }, { id: 5 }] }),
    body({ route: { paneId: 'x'.repeat(65) } }),
    body({ route: { paneId: '%3', agentPid: -4 } }),
    body({ route: { paneId: '%3', agentPid: 1.5 } }),
    body({ route: { paneId: '%3', cwd: 'a\nb' } }),
    body({ route: { paneId: '%3', sessionKey: 'x'.repeat(513) } }),
    body({ history: { text: 5 } }),
    body({ history: { text: 'ok', truncated: 'yes' } }),
    body({ name: { primary: '' } }),
    body({ name: { primary: 'p', secondary: 'a\u0007b' } }),
  ];
  for (const b of rejects) expect(parseRemoteRecord(b, 'clvm').ok).toBe(false);
});

test('NUL is rejected in free text and in labels', () => {
  expect(parseRemoteRecord(body({ history: { text: 'a\u0000b' } }), 'clvm').ok).toBe(false);
  expect(parseRemoteRecord(body({ route: { paneId: '%3\u0000' } }), 'clvm').ok).toBe(false);
  expect(parseRemoteRecord(body({ name: { primary: 'p\u0000' } }), 'clvm').ok).toBe(false);
});

test('a label is limited in code points like the Python validator: 256 emoji pass, 257 do not', () => {
  const named = (n: number) => body({ name: { primary: '😀'.repeat(n) }, history: { text: 'x', targetAgent: `clvm/${'😀'.repeat(n - 5)}` } });
  expect(parseRemoteRecord(named(256), 'clvm').ok).toBe(true);
  expect(parseRemoteRecord(named(257), 'clvm').ok).toBe(false);
  expect(parseRemoteRecord(body({ route: { paneId: '😀'.repeat(64) } }), 'clvm').ok).toBe(true);
  expect(parseRemoteRecord(body({ route: { paneId: '😀'.repeat(65) } }), 'clvm').ok).toBe(false);
});

test('huge text: 256 KiB is the cap in UTF-8 bytes, not characters', () => {
  const edge = 'a'.repeat(256 * 1024);
  expect(parseRemoteRecord(body({ history: { text: edge } }), 'clvm').ok).toBe(true);
  expect(parseRemoteRecord(body({ history: { text: `${edge}a` } }), 'clvm').ok).toBe(false);
  // 4-byte astral characters: 65537 of them is 262148 bytes although only 131074 UTF-16 units.
  expect(parseRemoteRecord(body({ history: { text: '😀'.repeat(65537) } }), 'clvm').ok).toBe(false);
  expect(parseRemoteRecord(body({ history: { text: '😀'.repeat(65536), truncated: true } }), 'clvm').ok).toBe(true);
});

test('null optional route fields and a null paneId are accepted and normalised away', () => {
  const parsed = parseRemoteRecord(
    body({ route: { paneId: null, cwd: null, agentPid: null, serverPid: 0, panePid: null, sessionKey: 'omp:abc', parentPaneId: null } }),
    'clvm',
  );
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.record.route).toEqual({ paneId: null, sessionKey: 'omp:abc' });
});

test('upsert is idempotent on (chat, id): applying twice leaves one route', () => {
  const rec = record();
  const first = upsertRemoteRecord([], rec, 'clvm');
  expect(first.ok && first.applied).toBe(true);
  if (!first.ok) throw new Error(first.error);
  const second = upsertRemoteRecord(first.store, rec, 'clvm');
  expect(second.ok && second.applied).toBe(false);
  if (!second.ok) throw new Error(second.error);
  expect(second.store).toHaveLength(1);
  expect(second.store[0]).toMatchObject({ machine: 'clvm', chat: '1', id: 500, name: { primary: 'proj' } });
});

test('a replay never rewrites what was recorded first', () => {
  const first = upsertRemoteRecord([], record(), 'clvm');
  if (!first.ok) throw new Error(first.error);
  const second = upsertRemoteRecord(first.store, record({ route: { paneId: '%9' } }), 'clvm');
  if (!second.ok) throw new Error(second.error);
  expect(second.store[0].route.paneId).toBe('%3');
});

test('a peer can never overwrite a route another machine recorded', () => {
  const first = upsertRemoteRecord([], record(), 'clvm');
  if (!first.ok) throw new Error(first.error);
  const clash = upsertRemoteRecord(first.store, record(), 'other');
  expect(clash.ok).toBe(false);
});

test('a record with several ids stores each; partly new ids store only the new ones', () => {
  const first = upsertRemoteRecord([], record({ ids: [{ id: 10 }, { id: 11 }] }), 'clvm');
  if (!first.ok) throw new Error(first.error);
  expect(first.store.map((e) => e.id)).toEqual([10, 11]);
  const second = upsertRemoteRecord(first.store, record({ ids: [{ id: 11 }, { id: 12 }] }), 'clvm');
  if (!second.ok) throw new Error(second.error);
  expect(second.applied).toBe(true);
  expect(second.store.map((e) => e.id)).toEqual([10, 11, 12]);
});

test('the store is capped at 300, newest kept', () => {
  let store = [] as ReturnType<typeof parseRemoteRoutes>;
  for (let i = 1; i <= MAX_REMOTE_ROUTES + 5; i++) {
    const r = upsertRemoteRecord(store, record({ ids: [{ id: i }] }), 'clvm');
    if (!r.ok) throw new Error(r.error);
    store = r.store;
  }
  expect(store).toHaveLength(MAX_REMOTE_ROUTES);
  expect(store[0].id).toBe(6);
  expect(store.at(-1)?.id).toBe(MAX_REMOTE_ROUTES + 5);
});

test('recognizeRemoteRoute finds by (chat, id) and only there', () => {
  const stored = upsertRemoteRecord([], record(), 'clvm');
  if (!stored.ok) throw new Error(stored.error);
  expect(recognizeRemoteRoute(stored.store, 1, 500)?.machine).toBe('clvm');
  expect(recognizeRemoteRoute(stored.store, '1', 500)?.route.paneId).toBe('%3');
  expect(recognizeRemoteRoute(stored.store, 2, 500)).toBeNull();
  expect(recognizeRemoteRoute(stored.store, 1, 501)).toBeNull();
});

test('parseRemoteRoutes drops torn, foreign and invalid rows', () => {
  const stored = upsertRemoteRecord([], record(), 'clvm');
  if (!stored.ok) throw new Error(stored.error);
  const raw = JSON.stringify([...stored.store, { machine: 'Bad Name', chat: '1', id: 7, route: {}, name: { primary: 'x' }, ts: 1 }, 'junk', { id: 'x' }]);
  expect(parseRemoteRoutes(raw)).toEqual(stored.store);
  expect(parseRemoteRoutes('not json')).toEqual([]);
  expect(parseRemoteRoutes(null)).toEqual([]);
  expect(parseRemoteRoutes('{}')).toEqual([]);
});

test('history rows are namespaced under the machine and carry the thread of each id', () => {
  const rows = remoteHistoryRows(record({ ids: [{ id: 10, threadId: 7 }, { id: 11, threadId: null }] }), 'clvm');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    ts: 1_730_100_000,
    message_id: 10,
    chat_id: 1,
    direction: 'agent',
    pane: 'clvm/%3',
    targetAgent: 'clvm/proj',
    sessionKey: 'clvm/cc:pane:99/%3/100',
    machine: 'clvm',
    threadId: 7,
    groupId: 'g1',
  });
  expect(rows[1].threadId).toBeNull();
  expect(rows[1].text).toBe('hello from clvm');
});

test('history rows: a bare name gets the machine prefix once; a single id carries no group', () => {
  const rec = record({ history: { text: 't' }, name: { primary: 'proj' }, route: { paneId: null, sessionKey: 'omp:zz' } });
  const [row] = remoteHistoryRows(rec, 'clvm');
  expect(row.targetAgent).toBe('clvm/proj');
  expect(row.pane).toBe('clvm/omp:zz');
  expect(row).not.toHaveProperty('groupId');
});

test('newHistoryRows dedupes on (chat, message, agent)', () => {
  const rows = remoteHistoryRows(record({ ids: [{ id: 10 }, { id: 11 }] }), 'clvm');
  expect(newHistoryRows(rows, [])).toHaveLength(2);
  expect(newHistoryRows(rows, [rows[0]])).toEqual([rows[1]]);
  expect(newHistoryRows(rows, rows)).toEqual([]);
  // A local row with the same ids is not a remote duplicate.
  expect(newHistoryRows(rows, [{ ...rows[0], machine: undefined }])).toHaveLength(2);
});

test('parseHistory preserves the machine field and drops a malformed one', () => {
  const row = remoteHistoryRows(record(), 'clvm')[0];
  expect(parseHistory(JSON.stringify(row))[0].machine).toBe('clvm');
  expect(parseHistory(JSON.stringify({ ...row, machine: 'Bad Name' }))[0].machine).toBeUndefined();
  expect(parseHistory(JSON.stringify({ ...row, machine: undefined }))[0].machine).toBeUndefined();
});

test('applyRemoteRoutes: twice = one route, written once, replay writes nothing', () => {
  const dir = tempDir('tg-remote-routes-');
  const file = join(dir, 'remote-routes.json');
  const io = {
    read: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    write: (content: string) => writeFileSync(file, content),
    lock: fsRoutesLockIo(`${file}.lock`),
  };
  const first = applyRemoteRoutes(io, record(), 'clvm');
  expect(first).toEqual({ ok: true, applied: true, routes: 1 });
  const before = readFileSync(file, 'utf8');
  expect(applyRemoteRoutes(io, record(), 'clvm')).toEqual({ ok: true, applied: false, routes: 1 });
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(applyRemoteRoutes(io, record(), 'other').ok).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('twice through the real history writer = one history group', () => {
  const dir = tempDir('tg-remote-history-');
  const file = join(dir, 'history.jsonl');
  const rec = record({ ids: [{ id: 10 }, { id: 11 }] });
  for (let i = 0; i < 2; i++) {
    const fresh = newHistoryRows(remoteHistoryRows(rec, 'clvm'), parseHistory(existsSync(file) ? readFileSync(file, 'utf8') : null));
    expect(appendHistoryFile(file, fresh)).toBe(true);
  }
  expect(parseHistory(readFileSync(file, 'utf8'))).toHaveLength(2);
});
