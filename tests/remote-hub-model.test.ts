import { expect, test } from 'bun:test';
import {
  anchorMachine,
  buildDeliverRequest,
  formatHubStatus,
  linkMaybeDownLine,
  noteDeliver,
  noteRecordApplied,
  parseHelloRun,
  parseRemoteStatus,
  sinkResultOf,
  verdictOfHubRun,
  type HubRun,
} from '../features/tg-ctl/remote-hub-model';

const run = (stdout: string, over: Partial<HubRun> = {}): HubRun => ({ started: true, stdout, exitCode: 0, timedOut: false, ...over });
const verdict = (doc: unknown, over: Partial<HubRun> = {}) => verdictOfHubRun(run(`${JSON.stringify(doc)}\n`, over));

test('an ok answer is delivered, carrying the sink', () => {
  expect(verdict({ ok: true, sink: 'tmux' })).toEqual({ outcome: 'delivered', sink: 'tmux' });
  expect(verdict({ ok: true })).toEqual({ outcome: 'delivered' });
});

test('only an explicit uncertain:false is a plain failure', () => {
  expect(verdict({ ok: false, error: 'no-session', uncertain: false })).toMatchObject({ outcome: 'failed', error: 'no-session' });
  expect(verdict({ ok: false, error: 'unsubmitted', uncertain: true }).outcome).toBe('uncertain');
  // A missing or malformed flag proves nothing: never a failure that could be re-sent.
  expect(verdict({ ok: false, error: 'x' }).outcome).toBe('uncertain');
  expect(verdict({ ok: false, error: 'x', uncertain: 'no' }).outcome).toBe('uncertain');
});

test('a replay is mapped by its ORIGINAL outcome: only delivered is delivered', () => {
  expect(verdict({ ok: true, duplicate: true, outcome: 'delivered' }).outcome).toBe('delivered');
  expect(verdict({ ok: false, duplicate: true, outcome: 'uncertain', uncertain: true }).outcome).toBe('uncertain');
  // Anything that does not say "delivered" is open, whatever else it claims.
  expect(verdict({ ok: true, duplicate: true }).outcome).toBe('uncertain');
  expect(verdict({ ok: true, duplicate: true, outcome: 'claimed' }).outcome).toBe('uncertain');
  expect(verdict({ ok: true, duplicate: true, outcome: 'uncertain' }).outcome).toBe('uncertain');
  expect(verdict({ ok: false, duplicate: true, outcome: 'failed', uncertain: false }).outcome).toBe('uncertain');
});

test('a timeout, garbage, an empty answer and an unknown shape are uncertain; a process that never started is not', () => {
  expect(verdictOfHubRun(run('', { timedOut: true, exitCode: null })).outcome).toBe('uncertain');
  expect(verdictOfHubRun(run('Traceback (most recent call last)\n', { exitCode: 1 })).outcome).toBe('uncertain');
  expect(verdictOfHubRun(run('', { exitCode: 0 })).outcome).toBe('uncertain');
  expect(verdictOfHubRun(run('[1,2]\n')).outcome).toBe('uncertain');
  expect(verdict({ hello: 1 }).outcome).toBe('uncertain');
  expect(verdictOfHubRun({ started: false, stdout: '', exitCode: null, timedOut: false })).toEqual({ outcome: 'failed', error: 'spawn' });
});

test('the last non-empty stdout line is the answer (a stray warning line before it is ignored)', () => {
  expect(verdictOfHubRun(run('warning: something\n{"ok":true}\n\n')).outcome).toBe('delivered');
});

test('sink results: delivered, unreachable, gone, uncertain', () => {
  expect(sinkResultOf({ outcome: 'delivered' }, 'clvm', 7)).toEqual({ ok: true });
  expect(sinkResultOf({ outcome: 'failed', error: 'ssh' }, 'clvm', 7)).toEqual({ ok: false, error: 'clvm unreachable; tg#7 not delivered' });
  const gone = sinkResultOf({ outcome: 'failed', error: 'no-session' }, 'clvm', 7);
  expect(gone.ok === false && gone.error).toContain('no longer running');
  expect(gone.ok === false && gone.uncertain).toBeUndefined();
  const open = sinkResultOf({ outcome: 'uncertain' }, 'clvm', 7);
  expect(open).toMatchObject({ ok: false, uncertain: true });
  expect(open.ok === false && open.error).toContain('NOT sent again');
});

test('the deliver request is exactly what tg-remote hub deliver reads', () => {
  expect(buildDeliverRequest('1', 77, { paneId: '%3', sessionKey: 'omp:a' }, 'hi', 500)).toEqual({
    idem: '1:77',
    route: { paneId: '%3', sessionKey: 'omp:a' },
    text: 'hi',
    replyTo: { id: 500 },
  });
});

test('anchorMachine reads the header of the replied-to message from the quote anchor only', () => {
  const names = ['clvm', 'other'];
  expect(anchorMachine('↩ tg#5 «[2026-10-28 08:00] [clvm/proj] done…»\n[TG from Alex tg#9] ok', names)).toBe('clvm');
  expect(anchorMachine('↩ tg#5 «[2026-10-28 08:00] [other/x] done…»\nrest', names)).toBe('other');
  // Unknown machine, a local header, no bracket, a machine named only in the reply body.
  expect(anchorMachine('↩ tg#5 «[2026-10-28 08:00] [ubuntu/proj] done…»\nx', names)).toBeNull();
  expect(anchorMachine('↩ tg#5 «[2026-10-28 08:00] [proj] done…»\nx', names)).toBeNull();
  expect(anchorMachine('↩ tg#5\n[TG from Alex tg#9] «[2026-10-28 08:00] [clvm/proj]»', names)).toBeNull();
  expect(anchorMachine('!git status', names)).toBeNull();
});

test('the picker line names every machine', () => {
  expect(linkMaybeDownLine(['clvm'])).toBe('if this was for a clvm agent, its link may be down');
});

test('status facts: notes, parse and tolerance of junk', () => {
  let facts = noteRecordApplied({}, 'clvm', true, 1000);
  facts = noteRecordApplied(facts, 'clvm', false, 2000);
  facts = noteDeliver(facts, 'clvm', 'uncertain', 3000);
  expect(facts).toEqual({ clvm: { records: 1, lastRecordAt: 2000, lastDeliver: { at: 3000, result: 'uncertain' } } });
  expect(parseRemoteStatus(JSON.stringify(facts))).toEqual(facts);
  expect(parseRemoteStatus(null)).toEqual({});
  expect(parseRemoteStatus('nope')).toEqual({});
  expect(parseRemoteStatus(JSON.stringify({ 'Bad Name': {}, clvm: { records: -3, lastDeliver: { at: 1, result: 'weird' } } }))).toEqual({
    clvm: { records: 0, lastRecordAt: null, lastDeliver: null },
  });
});

test('hello probes: ok, error answers, timeout, garbage', () => {
  expect(parseHelloRun(run('{"ok":true,"peer":"clvm","version":"1.74.0"}\n'), 42)).toEqual({ ok: true, ms: 42, version: '1.74.0' });
  expect(parseHelloRun(run('{"ok":false,"code":"BOT_MISMATCH","detail":"other bot"}\n'), 5)).toEqual({ ok: false, reason: 'BOT_MISMATCH: other bot' });
  expect(parseHelloRun(run('', { timedOut: true, exitCode: null }), 6000)).toMatchObject({ ok: false });
  expect(parseHelloRun(run('???', { exitCode: 69 }), 1)).toEqual({ ok: false, reason: 'no answer (exit 69)' });
  expect(parseHelloRun({ started: false, stdout: '', exitCode: null, timedOut: false }, 0)).toMatchObject({ ok: false });
});

test('the hub status block lists every machine with hello, records and last deliver', () => {
  const lines = formatHubStatus(
    [{ name: 'clvm', target: 'ultra@65.21.40.51' }, { name: 'lab', target: 'lab-host' }],
    { clvm: { records: 4, lastRecordAt: 90_000, lastDeliver: { at: 60_000, result: 'delivered' } } },
    { clvm: { ok: true, ms: 120, version: '1.74.0' }, lab: { ok: false, reason: 'ssh: timed out' } },
    100_000,
  );
  const text = lines.join('\n');
  expect(text).toContain('remote machines: 2');
  expect(text).toContain('clvm → ultra@65.21.40.51');
  expect(text).toContain('hello: ok (120 ms, tg-remote 1.74.0)');
  expect(text).toContain('records: 4, last 10s ago');
  expect(text).toContain('last deliver: delivered 40s ago');
  expect(text).toContain('lab → lab-host');
  expect(text).toContain('hello: FAILED — ssh: timed out');
  expect(text).toContain('records: 0, last never');
  expect(text).toContain('last deliver: never');
});
