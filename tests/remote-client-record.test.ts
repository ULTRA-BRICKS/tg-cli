import { expect, test } from 'bun:test';
import { buildRemoteRecord, capHistoryText, describeRecordRun, HISTORY_TEXT_CAP_BYTES, type RemoteRecordInput } from '../features/cli/outbound-runtime/remote-record';

// Pure record shaping and result mapping of the client-side `tg-remote client record` seam
// (docs/specs/2026-10-28-remote-ctl-server.md §4.1, §5). No process, no file.

const SERVER = 'ssh://tg-ctl-ubuntu';

function input(over: Partial<RemoteRecordInput> = {}): RemoteRecordInput {
  return {
    chat: '-1001',
    ids: [{ id: 41, threadId: null }],
    route: { paneId: '%3', cwd: '/home/u/proj', agentPid: 11, serverPid: 22, panePid: 33, sessionKey: 'omp:abc', parentPaneId: 'omp:9' },
    history: { text: 'hello', targetAgent: 'tg-cli', groupToken: 'g-1', ts: 1730100000 },
    name: { primary: 'tg-cli', secondary: 'Fix it' },
    machine: 'clvm',
    ...over,
  };
}

test('the record carries exactly the spec §4.1 fields with the machine namespace on targetAgent', () => {
  expect(buildRemoteRecord(input())).toEqual({
    chat: '-1001',
    ids: [{ id: 41, threadId: null }],
    route: { paneId: '%3', cwd: '/home/u/proj', agentPid: 11, serverPid: 22, panePid: 33, sessionKey: 'omp:abc', parentPaneId: 'omp:9' },
    history: { text: 'hello', targetAgent: 'clvm/tg-cli', groupToken: 'g-1', truncated: false },
    name: { primary: 'tg-cli', secondary: 'Fix it' },
    ts: 1730100000000,
  });
});

test('route fields the local route lacks are omitted, not nulled', () => {
  const rec = buildRemoteRecord(input({ route: { paneId: 'omp:77', cwd: '/w' } }));
  expect(rec?.route).toEqual({ paneId: 'omp:77', cwd: '/w' });
});

test('a send with no resolvable agent name falls back to the session primary for targetAgent', () => {
  const rec = buildRemoteRecord(input({ history: { text: 'x', groupToken: 'g', ts: 1 } }));
  expect(rec?.history.targetAgent).toBe('clvm/tg-cli');
});

test('a record without a session name cannot be routed to: no record', () => {
  expect(buildRemoteRecord(input({ name: { primary: '', secondary: null } }))).toBeNull();
});

test('a missing groupToken is generated so a multi-part send still groups on the server', () => {
  const rec = buildRemoteRecord(input({ history: { text: 'x', ts: 1 }, ids: [{ id: 1, threadId: null }, { id: 2, threadId: 7 }] }));
  expect(rec?.history.groupToken).toMatch(/^[0-9a-f-]{36}$/);
  expect(rec?.ids).toEqual([{ id: 1, threadId: null }, { id: 2, threadId: 7 }]);
});

test('control characters, NUL and lone surrogates never reach the wire (the server rejects the whole record)', () => {
  const rec = buildRemoteRecord(
    input({
      route: { paneId: '%3', cwd: '/a\u0007b\nc' },
      history: { text: 'a\u0000b\ud800c', targetAgent: 'x\ty', groupToken: 'g', ts: 1 },
      name: { primary: 'pri\u0085mary', secondary: 'sec\u2028ond' },
    }),
  );
  expect(rec?.route.cwd).toBe('/a b c');
  expect(rec?.history.text).toBe('ab\ufffdc');
  expect(rec?.history.targetAgent).toBe('clvm/x y');
  expect(rec?.name).toEqual({ primary: 'pri mary', secondary: 'sec ond' });
});

test('labels are cut at their code-point limit, never inside an astral character', () => {
  const rec = buildRemoteRecord(input({ name: { primary: '😀'.repeat(300), secondary: null } }));
  expect([...(rec?.name.primary ?? '')]).toHaveLength(256);
});

test('text within the cap is untouched; Unicode (astral, RTL, combining) round-trips', () => {
  const text = 'a😀 שלום مرحبا e\u0301';
  expect(capHistoryText(text)).toEqual({ text, truncated: false });
});

test('text over 256 KiB is cut on a character boundary and flagged', () => {
  const text = '😀'.repeat(HISTORY_TEXT_CAP_BYTES / 4 + 10); // 4-byte chars: the cap lands exactly between two
  const exact = capHistoryText(text);
  expect(exact.truncated).toBe(true);
  expect(Buffer.byteLength(exact.text)).toBe(HISTORY_TEXT_CAP_BYTES);

  const straddle = capHistoryText('a' + '😀'.repeat(HISTORY_TEXT_CAP_BYTES / 4 + 10)); // the cap lands inside a character
  expect(straddle.truncated).toBe(true);
  expect(Buffer.byteLength(straddle.text)).toBe(HISTORY_TEXT_CAP_BYTES - 3);
  expect(straddle.text.includes('\ufffd')).toBe(false);
});

const run = (over: Partial<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError: string }>) => ({
  stdout: '',
  stderr: '',
  exitCode: 0 as number | null,
  timedOut: false,
  ...over,
});

test.each(['recorded', 'duplicate'])('%s is silent', (status) => {
  expect(describeRecordRun(run({ stdout: JSON.stringify({ status, detail: 'ok' }) + '\n' }), SERVER)).toBeNull();
});

test('journaled prints the tool stderr warning, every line prefixed tg:', () => {
  const warn = describeRecordRun(
    run({ stdout: '{"status":"journaled","detail":"ssh: timeout","journal":"/j/1.json"}\n', stderr: 'tg-remote: server unreachable (timeout)\njournal /j/1.json\n' }),
    SERVER,
  );
  expect(warn).toBe('tg: tg-remote: server unreachable (timeout)\ntg: journal /j/1.json');
});

test('journaled with a silent tool still says so, naming the detail and the journal path', () => {
  const warn = describeRecordRun(run({ stdout: '{"status":"journaled","detail":"ssh: timeout","journal":"/j/1.json"}\n' }), SERVER);
  expect(warn).toBe(`tg: ctl server ${SERVER}: record journaled (ssh: timeout) at /j/1.json`);
});

test.each([
  ['garbage stdout', run({ stdout: 'oops' }), 'unparsable output'],
  ['unknown status', run({ stdout: '{"status":"maybe"}' }), 'unparsable output'],
  ['non-zero exit', run({ stdout: '{"status":"recorded"}', exitCode: 64, stderr: 'usage: bad\nmore' }), 'tg-remote exited 64: usage: bad'],
  ['timeout', run({ timedOut: true, exitCode: null }), 'timed out after 12 s'],
  ['spawn failure', run({ spawnError: 'Executable not found in $PATH: "python3"', exitCode: null }), 'Executable not found in $PATH: "python3"'],
  ['oversized reply', run({ stdout: 'x'.repeat(70_000) }), 'unparsable output'],
])('%s: the send is out, the record is NOT journaled', (_name, r, cause) => {
  expect(describeRecordRun(r, SERVER)).toBe(`tg: ctl server ${SERVER} unreachable (${cause}); send is out, record NOT journaled`);
});

test('a send of more than 100 messages records the first 100 ids (the server limit) instead of losing the whole record', () => {
  const ids = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, threadId: null }));
  expect(buildRemoteRecord(input({ ids }))?.ids).toEqual(ids.slice(0, 100));
});
