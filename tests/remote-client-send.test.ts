import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { botIdFromToken, ctlPaths } from '../features/tg-ctl/lock';
import { CLIENT_YAML, clientFixture, runTg, startFakeApi, type ClientFixture } from './helpers/client-send';
import { fakeRemoteClient } from './helpers/fake-remote-client';

// The REAL `tg` on a ctl-client machine (control.server + control.machine) against a fake Bot API and a
// fake `tg-remote` (docs/specs/2026-10-28-remote-ctl-server.md §5, §6): the direct post is unchanged,
// then ONE record per send goes through `python3 -I <tg-remote> client record`; every failure of that
// step is a stderr line, never an exit code.

const api = startFakeApi();
afterAll(() => api.stop());
beforeEach(() => {
  api.calls.length = 0;
  api.script = [];
  api.nextId = 100;
  api.fallback = 200;
});

function env(remoteBin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { TG_REMOTE_BIN: remoteBin, TG_API_BASE: api.url, ...extra };
}

const sends = () => api.calls.filter((c) => c.method === 'sendMessage');
// The header brackets are rendered in mathematical bold; NFKC folds them back to ASCII.
const headerOf = (call: { body: Record<string, unknown> }) => String(call.body.text).normalize('NFKC');

test('a send posts directly, then records route + history on the server with the machine namespace', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  const r = await runTg(['hello from clvm'], f, env(remote.bin));

  expect(r.code).toBe(0);
  expect(r.out).toBe('OK tg#100\n');
  expect(r.err).toBe('');
  expect(sends()).toHaveLength(1);
  expect(headerOf(sends()[0]!)).toContain('[clvm/proj-x]');

  const [call] = remote.callsOf('client record');
  expect(call!.origArgv.slice(0, 2)).toEqual(['python3', '-I']);
  expect(call!.argv).toEqual(['client', 'record']);
  expect(call!.configDir).toBe(f.configDir);

  const [record] = remote.records();
  expect(Object.keys(record!).sort()).toEqual(['chat', 'history', 'ids', 'name', 'route', 'ts']);
  expect(record).toMatchObject({
    chat: '1',
    ids: [{ id: 100, threadId: null }],
    history: { text: 'hello from clvm', targetAgent: 'clvm/proj-x', truncated: false },
    name: { primary: 'proj-x' },
  });
  expect(record!.route.paneId).toMatch(/^omp:\d+$/);
  expect(record!.route.cwd).toBe(f.cwd);
  expect(record!.route.agentPid).toBeGreaterThan(0);
  expect(record!.history.groupToken.length).toBeGreaterThan(0);
  expect(Math.abs(record!.ts - Date.now())).toBeLessThan(60_000);

  // The local files are this machine's own state and are still written.
  const routes = JSON.parse(readFileSync(join(f.configDir, 'tg-ctl.123.routes.json'), 'utf8')) as { id: number; paneId: string }[];
  expect(routes.map((x) => x.id)).toEqual([100]);
  expect(routes[0]!.paneId).toBe(record!.route.paneId);
}, 30_000);

// --- body shapes ---------------------------------------------------------------------------

test('a body over 4096 characters splits into several messages and ONE record carries every id and the whole text', async () => {
  const remote = fakeRemoteClient();
  const body = `${'a'.repeat(2500)}\n\n${'b'.repeat(2500)}`;
  const r = await runTg(['-'], clientFixture(), env(remote.bin), body);
  expect(r.code).toBe(0);
  expect(sends().length).toBeGreaterThan(1);
  expect(remote.callsOf('client record')).toHaveLength(1);
  const [record] = remote.records();
  expect(record!.ids.map((x) => x.id)).toEqual(sends().map((_, i) => 100 + i));
  expect(record!.history.text).toBe(body);
  expect(record!.history.truncated).toBe(false);
  expect(record!.history.groupToken.length).toBeGreaterThan(0);
}, 30_000);

test('Unicode survives byte for byte: astral emoji, RTL scripts, combining marks, a NUL-free control mix', async () => {
  const remote = fakeRemoteClient();
  const body = 'Ünï 😀 שלום עולם مرحبا بالعالم e\u0301 \u200f';
  const r = await runTg([body], clientFixture(), env(remote.bin));
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(remote.records()[0]!.history.text).toBe(body);
}, 30_000);

test('history text over 256 KiB is cut on a character boundary with truncated: true; the send itself is complete', async () => {
  const remote = fakeRemoteClient();
  const body = '😀'.repeat(70_000); // 280 000 bytes, 4 bytes per character
  const r = await runTg(['--no-feature', 'flood-cap', '-'], clientFixture(), env(remote.bin), body);
  expect(r.code).toBe(0);
  const [record] = remote.records();
  expect(record!.history.truncated).toBe(true);
  expect(Buffer.byteLength(record!.history.text)).toBe(256 * 1024);
  expect(record!.history.text).not.toContain('\ufffd');
  expect(record!.ids.length).toBe(sends().length);
}, 60_000);

// --- attachments are read on THIS machine ----------------------------------------------------

test('--file uploads a local file straight to the Bot API and records the document id with the body', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  const file = join(f.cwd, 'notes.txt');
  writeFileSync(file, 'local-only contents\n');
  const r = await runTg(['--file', file, 'see attached'], f, env(remote.bin));
  expect(r.code).toBe(0);
  const docs = api.calls.filter((c) => c.method === 'sendDocument');
  expect(docs).toHaveLength(1);
  expect(docs[0]!.body.document).toBe(`<blob:${Buffer.byteLength('local-only contents\n')}b>`);
  const [record] = remote.records();
  expect(record!.history.text).toBe('see attached');
  expect(record!.ids.length).toBe(api.calls.length);
}, 30_000);

test('a missing attachment path is skipped as on any machine; the text is sent and recorded', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  const r = await runTg(['--file', join(f.cwd, 'nope.txt'), 'still here'], f, env(remote.bin));
  expect(r.code).toBe(0);
  expect(api.calls.filter((c) => c.method === 'sendDocument')).toHaveLength(0);
  expect(r.err).toMatch(/not found|skipp/i);
  expect(remote.records()[0]!.history.text).toBe('still here');
}, 30_000);

// --- identity ----------------------------------------------------------------------------------

test('the namespace prefixes the primary bracket only; the --subagent bracket is unchanged', async () => {
  const remote = fakeRemoteClient();
  const r = await runTg(['--subagent', 'reviewer', 'x'], clientFixture(), env(remote.bin));
  expect(r.code).toBe(0);
  expect(headerOf(sends()[0]!)).toContain('[clvm/proj-x] [reviewer]');
  expect(remote.records()[0]!.history.targetAgent).toBe('clvm/proj-x');
}, 30_000);

// --- the record step never changes the exit code ---------------------------------------------

test.each([
  ['journaled', { stdout: '{"status":"journaled","detail":"ssh timeout","journal":"/cfg/remote/journal/1_100.json"}\n', stderr: 'tg-remote: ssh timeout; record journaled at /cfg/remote/journal/1_100.json\n' }, 'tg: tg-remote: ssh timeout; record journaled at /cfg/remote/journal/1_100.json'],
  ['garbage stdout', { stdout: 'not json at all\n' }, 'tg: ctl server ssh://tg-ctl-ubuntu unreachable (unparsable output); send is out, record NOT journaled'],
  ['a failing tool', { stdout: '', stderr: 'boom\nmore\n', exit: 70 }, 'tg: ctl server ssh://tg-ctl-ubuntu unreachable (tg-remote exited 70: boom); send is out, record NOT journaled'],
])('%s: stderr says so, the send stays OK, exit 0, one attempt', async (_name, reply, line) => {
  const remote = fakeRemoteClient({ 'client record': reply });
  const r = await runTg(['x'], clientFixture(), env(remote.bin));
  expect(r.code).toBe(0);
  expect(r.out).toBe('OK tg#100\n');
  expect(r.err).toContain(line);
  expect(remote.callsOf('client record')).toHaveLength(1);
}, 30_000);

test('a record that hangs is killed after 12 s with its whole process group; the send is out, exit 0', async () => {
  const remote = fakeRemoteClient({ 'client record': { sleepMs: 60_000, child: true } });
  const started = Date.now();
  const r = await runTg(['x'], clientFixture(), env(remote.bin));
  const elapsed = Date.now() - started;
  expect(r.code).toBe(0);
  expect(r.out).toBe('OK tg#100\n');
  expect(r.err).toContain('tg: ctl server ssh://tg-ctl-ubuntu unreachable (timed out after 12 s); send is out, record NOT journaled');
  expect(elapsed).toBeGreaterThan(11_000);
  expect(elapsed).toBeLessThan(25_000);
  const child = remote.childPid();
  expect(child).not.toBeNull();
  expect(() => process.kill(child!, 0)).toThrow(); // the ssh-like grandchild died with the group
  expect(remote.callsOf('client record')).toHaveLength(1);
}, 60_000);

test('a process that escaped the group and holds the pipes open cannot keep tg waiting: the record is abandoned 2 s after the kill', async () => {
  const remote = fakeRemoteClient({ 'client record': { sleepMs: 60_000, escape: true } });
  const started = Date.now();
  const r = await runTg(['x'], clientFixture(), env(remote.bin));
  const elapsed = Date.now() - started;
  const escaped = remote.escapedPid();
  if (escaped !== null) process.kill(escaped, 9); // the 35 s sleeper must not outlive the test
  expect(escaped).not.toBeNull();
  expect(r.code).toBe(0);
  expect(r.out).toBe('OK tg#100\n');
  expect(r.err).toContain('unreachable (timed out after 12 s); send is out, record NOT journaled');
  expect(elapsed).toBeLessThan(25_000);
}, 60_000);

test('python runs isolated: a planted ./tgcli in the sender cwd is never importable and the cwd is not on sys.path', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  mkdirSync(join(f.cwd, 'tgcli'));
  // The planted package names the tg-remote operation that imported it.
  writeFileSync(join(f.cwd, 'tgcli', '__init__.py'), `import sys\nopen(${JSON.stringify(join(f.home, 'PWNED-'))} + '_'.join(sys.argv[1:3]), 'w').write('x')\n`);
  const r = await runTg(['x'], f, env(remote.bin, { PYTHONPATH: f.cwd }));
  expect(r.code).toBe(0);
  // Both spawns of a send — the offline `config check` and the `client record` — run isolated.
  const calls = remote.calls();
  expect(calls.map((c) => c.argv.slice(0, 2).join(' '))).toEqual(['config check', 'client record']);
  for (const call of calls) {
    expect(call.origArgv.slice(0, 2)).toEqual(['python3', '-I']);
    expect(call.isolated).toBe(true);
    expect(call.tgcliImported).toBe(false);
    expect(call.cwdOnSysPath).toBe(false);
  }
  expect(readdirSync(f.home).filter((name) => name.startsWith('PWNED-'))).toEqual([]);
}, 30_000);

// --- no topics, no daemon ---------------------------------------------------------------------

async function countSocketConnections(f: ClientFixture, run: () => Promise<unknown>): Promise<number> {
  let connections = 0;
  const listener = Bun.listen({ unix: ctlPaths(f.configDir, botIdFromToken('123:abc')).socket, socket: { open: () => void connections++, data() {} } });
  try {
    await run();
  } finally {
    listener.stop(true);
  }
  return connections;
}

const TOPICS_CLIENT_YAML = `${CLIENT_YAML}  topics: true\n  private_topics: true\n`;

test('a client never asks the daemon socket (topics are on in config); posts to General', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture(TOPICS_CLIENT_YAML, { short: true });
  const connections = await countSocketConnections(f, async () => {
    const r = await runTg(['hello'], f, env(remote.bin));
    expect(r.code).toBe(0);
  });
  expect(connections).toBe(0);
  expect(sends()[0]!.body.message_thread_id).toBeUndefined();
}, 30_000);

test('the sentinel works: the same setup on a plain local machine DOES ask the daemon socket', async () => {
  const f = clientFixture('control:\n  topics: true\n  private_topics: true\n', { short: true });
  const connections = await countSocketConnections(f, async () => {
    await runTg(['hello'], f, { TG_API_BASE: api.url });
  });
  expect(connections).toBeGreaterThan(0);
}, 30_000);

test('--session-topic on a client prints nothing, exits 0 and never touches the socket', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture(TOPICS_CLIENT_YAML, { short: true });
  let result: { code: number; out: string } | undefined;
  const connections = await countSocketConnections(f, async () => {
    result = await runTg(['--session-topic'], f, env(remote.bin));
  });
  expect(connections).toBe(0);
  expect(result).toMatchObject({ code: 0, out: '' });
  expect(remote.callsOf('client record')).toHaveLength(0);
}, 30_000);

test('--reply-to threads by reply_to_message_id; the anchor row topic in local history is NOT inferred; --topic is honoured as given', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture(TOPICS_CLIENT_YAML);
  writeFileSync(
    join(f.configDir, 'tg-ctl.123.history.jsonl'),
    `${JSON.stringify({ ts: 1, message_id: 55, chat_id: 1, direction: 'user', from: 'u', text: 'q', pane: null, threadId: 7 })}\n`,
  );
  expect((await runTg(['--reply-to', '55', 'answer'], f, env(remote.bin))).code).toBe(0);
  expect(sends()[0]!.body.reply_to_message_id).toBe(55);
  expect(sends()[0]!.body.message_thread_id).toBeUndefined();

  api.calls.length = 0;
  api.nextId = 100;
  expect((await runTg(['--topic', '9', 'topical'], f, env(remote.bin))).code).toBe(0);
  expect(sends()[0]!.body.message_thread_id).toBe(9);
  expect(remote.records().at(-1)!.ids).toEqual([{ id: 100, threadId: 9 }]);
}, 60_000);

// --- outbox -------------------------------------------------------------------------------------

test('Telegram unreachable: no outbox on a client — refusal text, exit 1, nothing queued, no record for an unsent message', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  api.fallback = 502;
  const r = await runTg(['queued report'], f, env(remote.bin, { TG_SEND_RETRY_BUDGET_MS: '1500' }));
  expect(r.code).toBe(1);
  expect(r.err).toContain('tg: Telegram unreachable; client machines have no outbox replay — nothing queued, retry the send');
  expect(r.err).not.toContain('queued 1 part');
  expect(readdirSync(f.configDir).filter((n) => n.includes('outbox'))).toEqual([]);
  expect(remote.callsOf('client record')).toHaveLength(0);
}, 30_000);

// --- --dry-run is offline -------------------------------------------------------------------------

test('--dry-run prints the role line, contacts nothing: only the offline config check ran, no journal, no API call', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture();
  const r = await runTg(['--dry-run', 'draft'], f, env(remote.bin));
  expect(r.code).toBe(0);
  expect(r.out).toContain('tg --dry-run: OK');
  expect(r.out).toContain('remote: client of ssh://tg-ctl-ubuntu as clvm (not contacted)\n');
  expect(remote.calls().map((c) => c.argv)).toEqual([['config', 'check', '--json']]);
  expect(existsSync(join(f.configDir, 'remote'))).toBe(false);
  expect(api.calls).toEqual([]);
}, 30_000);

// --- a plain local machine is byte-identical -----------------------------------------------------

test('no remote keys: no namespace, no tg-remote spawn at all, no remote dir, same OK line', async () => {
  const remote = fakeRemoteClient();
  const f = clientFixture(null);
  const r = await runTg(['hello local'], f, env(remote.bin));
  expect(r.code).toBe(0);
  expect(r.out).toBe('OK tg#100\n');
  expect(headerOf(sends()[0]!)).toContain('[proj-x]');
  expect(headerOf(sends()[0]!)).not.toContain('clvm');
  expect(remote.calls()).toEqual([]);
  expect(existsSync(join(f.configDir, 'remote'))).toBe(false);
  const dry = await runTg(['--dry-run', 'hello local'], f, env(remote.bin));
  expect(dry.out).not.toContain('remote:');
  expect(remote.calls()).toEqual([]);
}, 30_000);
