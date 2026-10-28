// tg-cli#636: the `tg-ctl alert` lifecycle against a real omp-live endpoint and a mock
// Bot API — subscribe, a send that posts to Telegram with the footer and delivers the
// `[alert tg#<id> …]` copy into the session, the throttle, unbind when the session's
// endpoint is gone, rebind when a NEW process publishes the SAME session id (a resume).
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { tempDir, trackChild } from './helpers/test-temp';
import { COMPLETE_PROBLEM } from './fixtures/intent-gate/problem-remediation';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SESSION = '01a0d2d7-6202-702d-b9e8-006b656b0799';

const sent: Array<Record<string, unknown>> = [];
let nextId = 500;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: nextId++ } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const home = tempDir('tgctl-alert-');
const cfg = join(home, '.config', 'tg-cli');
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
const receivedLog = join(home, 'received.jsonl');
writeFileSync(receivedLog, '');
const procs: Subprocess[] = [];
afterAll(async () => {
  server.stop(true);
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
});

const env = { ...process.env, HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: `http://127.0.0.1:${server.port}` };

// A stand-in original omp: publishes an endpoint for `session` from its OWN process (so a
// "resume" is a new pid) and appends every delivered text to receivedLog; `failSend` makes
// it answer every delivery with an error receipt while staying live.
async function startHost(title: string, session = SESSION, failSend = false): Promise<Subprocess> {
  const script = `
    import { startLiveEndpoint } from ${JSON.stringify(join(import.meta.dir, '..', 'features', 'tg-ctl', 'omp-live-runtime.mjs'))};
    import { appendFileSync } from 'node:fs';
    const ep = await startLiveEndpoint({ root: ${JSON.stringify(join(cfg, 'omp-live'))},
      snapshot: () => ({ sessionId: ${JSON.stringify(session)}, sessionFile: null, cwd: ${JSON.stringify(home)}, title: ${JSON.stringify(title)}, busy: false }),
      send: (text) => { if (${failSend}) throw new Error('refused'); appendFileSync(${JSON.stringify(receivedLog)}, JSON.stringify({ pid: process.pid, text }) + '\\n'); } });
    process.on('SIGTERM', async () => { await ep.close(); process.exit(0); });
    console.log('ready');
  `;
  const proc = trackChild(Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'pipe' }));
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain('ready');
  return proc;
}

async function ctl(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = trackChild(Bun.spawn(['bun', TG_CTL, 'alert', ...args], { env, stdout: 'pipe', stderr: 'pipe' }));
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

const received = (): Array<{ pid: number; text: string }> =>
  readFileSync(receivedLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; text: string });

test('subscribe → send (footer + session copy) → throttle → unbind on close → rebind on resume', async () => {
  const first = await startHost('Supervisor');
  expect((await ctl('list')).out).toBe('alert subscriptions: none\n');

  const subscribed = await ctl('subscribe', '--pid', String(first.pid), '--sources', 'sysmon,supervisor', '--ttl', '1h');
  expect(subscribed.code).toBe(0);
  expect(subscribed.out).toContain(`subscribed (bound): Supervisor · pid ${first.pid} · session ${SESSION} · sources: sysmon,supervisor · ttl 1 h 0 min`);
  expect((await ctl('list')).out).toContain(`  - bound · Supervisor · pid ${first.pid} · session ${SESSION} · sources: sysmon,supervisor · expires in `);

  const sendArgs = ['send', '--source', 'sysmon', '--severity', 'critical', '--key', 'load', '--text', COMPLETE_PROBLEM];
  const posted = await ctl(...sendArgs);
  expect(posted.err).toBe('');
  expect(posted.code).toBe(0);
  expect(posted.out).toBe(`OK tg#500 sessions=1 (Supervisor (pid ${first.pid}))\n`);
  expect(sent).toHaveLength(1);
  expect(String(sent[0].text)).toEndWith(`${COMPLETE_PROBLEM}\n\n<i>↳ также адресовано агенту: Supervisor (pid ${first.pid})</i>`);
  expect(received()).toEqual([{ pid: first.pid, text: `[alert tg#500 · sysmon · critical] ${COMPLETE_PROBLEM}\n— when fixed, follow up on this alert: tg --reply-to 500 "<status>"` }]);

  // The same (source,key,severity) inside the window: nothing posted, nothing delivered.
  const repeat = await ctl(...sendArgs);
  expect(repeat.code).toBe(0);
  expect(repeat.out).toStartWith('throttled tg#500 ');
  expect(sent).toHaveLength(1);
  // An escalation (different severity) and a source nobody subscribed to.
  const warning = await ctl('send', '--source', 'sysmon', '--severity', 'warning', '--key', 'load', '--text', COMPLETE_PROBLEM);
  expect(warning.out).toBe(`OK tg#501 sessions=1 (Supervisor (pid ${first.pid}))\n`);
  const other = await ctl('send', '--source', 'other', '--severity', 'warning', '--key', 'x', '--text', COMPLETE_PROBLEM);
  expect(other.out).toBe('OK tg#502 sessions=0\n');
  expect(String(sent[2].text)).not.toContain('адресовано');
  expect(received()).toHaveLength(2);

  // The session closes: its endpoint is withdrawn, the subscription stays but is suspended.
  first.kill('SIGTERM');
  await first.exited;
  expect((await ctl('list')).out).toContain(`  - suspended (no live omp-live endpoint) · Supervisor · pid ${first.pid} · session ${SESSION}`);
  const unbound = await ctl('send', '--source', 'sysmon', '--severity', 'critical', '--key', 'mem', '--text', COMPLETE_PROBLEM);
  expect(unbound.out).toBe('OK tg#503 sessions=0\n');
  expect(received()).toHaveLength(2);

  // Resume: a new process publishes the same session id → bound again, new pid, new title.
  const second = await startHost('Supervisor (resumed)');
  expect(second.pid).not.toBe(first.pid);
  expect((await ctl('list')).out).toContain(`  - bound · Supervisor (resumed) · pid ${second.pid} · session ${SESSION}`);
  const rebound = await ctl('send', '--source', 'supervisor', '--severity', 'critical', '--key', 'OVERLOAD', '--text', COMPLETE_PROBLEM);
  expect(rebound.out).toBe(`OK tg#504 sessions=1 (Supervisor (resumed) (pid ${second.pid}))\n`);
  expect(received().at(-1)).toEqual({ pid: second.pid, text: `[alert tg#504 · supervisor · critical] ${COMPLETE_PROBLEM}\n— when fixed, follow up on this alert: tg --reply-to 504 "<status>"` });

  // Unsubscribe by the recorded pid; list is empty again.
  expect((await ctl('unsubscribe', '--pid', String(second.pid))).out).toBe(`unsubscribed session ${SESSION}\n`);
  expect((await ctl('list')).out).toBe('alert subscriptions: none\n');
}, 30_000);

// --- exclusive holder (tg-cli#747) ---

const A = '01a0d2d7-6202-702d-b9e8-0000000000aa';
const B = '01a0d2d7-6202-702d-b9e8-0000000000bb';
const storePath = (): string => join(cfg, readdirSync(cfg).find((f) => f.endsWith('.alert-subscriptions.json'))!);
const readStore = (): { subscriptions: unknown[]; holders: Array<Record<string, unknown>> } => JSON.parse(readFileSync(storePath(), 'utf8'));
const receivedBy = (pid: number): string[] => received().filter((r) => r.pid === pid).map((r) => r.text);
const holderJson = async (source: string): Promise<{ state: string; holder: { sessionId: string } | null }> => JSON.parse((await ctl('holder', '--source', source, '--json')).out);
async function stop(proc: Subprocess): Promise<void> {
  proc.kill('SIGTERM');
  await proc.exited;
}

test('exclusive: first session claims, second is refused naming the first', async () => {
  const a = await startHost('Holder A', A);
  const b = await startHost('Asker B', B);
  const first = await ctl('subscribe', '--exclusive', '--source', 'ex1', '--pid', String(a.pid));
  expect(first.code).toBe(0);
  const second = await ctl('subscribe', '--exclusive', '--source', 'ex1', '--pid', String(b.pid));
  expect(second.code).toBe(3);
  expect(second.out).toContain(`held by Holder A · pid ${a.pid} · session ${A} · since `);
  expect(second.out).toContain(`ask: tg-ctl alert handoff-request --source ex1 --reason '<why>'`);
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('handoff: request reaches the holder, deny clears it, grant moves the slot', async () => {
  const a = await startHost('Holder A', A);
  const b = await startHost('Asker B', B);
  expect((await ctl('subscribe', '--exclusive', '--source', 'ex2', '--pid', String(a.pid))).code).toBe(0);
  expect((await ctl('handoff-request', '--source', 'ex2', '--pid', String(b.pid), '--reason', 'I own sysmon now')).code).toBe(0);
  const note = receivedBy(a.pid).at(-1)!;
  expect(note).toContain(`Asker B`);
  expect(note).toContain(`session ${B}`);
  expect(note).toContain('I own sysmon now');
  expect(note).toContain(`tg-ctl alert handoff --source ex2 --to ${B}`);
  expect(note).toContain(`tg-ctl alert handoff --source ex2 --deny --reason '…'`);
  expect(note).toContain('unanswered for 10 minutes lets it take the slot');

  expect((await ctl('handoff', '--source', 'ex2', '--deny', '--reason', 'still on it', '--pid', String(a.pid))).code).toBe(0);
  expect(receivedBy(b.pid).at(-1)).toContain('still on it');
  expect(readStore().holders.find((h) => h.source === 'ex2')?.request).toBeNull();
  const nothing = await ctl('handoff', '--source', 'ex2', '--deny', '--pid', String(a.pid));
  expect(nothing.code).toBe(1);
  expect(nothing.err).toContain('no pending handoff request');
  expect((await holderJson('ex2')).holder?.sessionId).toBe(A);

  expect((await ctl('handoff-request', '--source', 'ex2', '--pid', String(b.pid))).code).toBe(0);
  expect((await ctl('handoff', '--source', 'ex2', '--to', B, '--pid', String(a.pid))).code).toBe(0);
  const shown = await holderJson('ex2');
  expect(shown.state).toBe('bound');
  expect(shown.holder?.sessionId).toBe(B);
  expect(receivedBy(b.pid).at(-1)).toContain('ex2');
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('handoff-request whose note cannot reach the holder is withdrawn (exit 5)', async () => {
  const a = await startHost('Deaf A', A, true);
  const b = await startHost('Asker B', B);
  expect((await ctl('subscribe', '--exclusive', '--source', 'ex7', '--pid', String(a.pid))).code).toBe(0);
  const r = await ctl('handoff-request', '--source', 'ex7', '--pid', String(b.pid));
  expect(r.code).toBe(5);
  expect(readStore().holders.find((h) => h.source === 'ex7')?.request).toBeNull();
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('take: only after 10 minutes unanswered or when vacant', async () => {
  const a = await startHost('Holder A', A);
  const b = await startHost('Asker B', B);
  expect((await ctl('subscribe', '--exclusive', '--source', 'ex3', '--pid', String(a.pid))).code).toBe(0);
  const withRequest = (ageMs: number): void => {
    const store = readStore();
    for (const h of store.holders) if (h.source === 'ex3') h.request = { sessionId: B, title: 'Asker B', pid: b.pid, at: Date.now() - ageMs, reason: null };
    writeFileSync(storePath(), JSON.stringify(store));
  };
  withRequest(9 * 60_000);
  expect((await ctl('take', '--source', 'ex3', '--pid', String(b.pid))).code).toBe(3);
  withRequest(11 * 60_000);
  expect((await ctl('take', '--source', 'ex3', '--pid', String(b.pid))).code).toBe(0);
  expect((await holderJson('ex3')).holder?.sessionId).toBe(B);
  expect(receivedBy(a.pid).at(-1)).toContain('taken');
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('release by the holder only; holder exits 3 once vacant; handoff to a dead session is refused', async () => {
  const a = await startHost('Holder A', A);
  const b = await startHost('Asker B', B);
  expect((await ctl('subscribe', '--exclusive', '--source', 'ex4', '--pid', String(a.pid))).code).toBe(0);
  for (const args of [['subscribe', '--exclusive'], ['handoff-request'], ['take']]) {
    const notLive = await ctl(...args, '--source', 'ex4', '--session', 'closed-session');
    expect(notLive.code).toBe(1);
    expect(notLive.err).toContain('session closed-session is not live');
  }
  const dead = await ctl('handoff', '--source', 'ex4', '--to', 'no-such-session', '--pid', String(a.pid));
  expect(dead.code).toBe(1);
  expect(dead.err).toContain('no-such-session');
  expect((await holderJson('ex4')).holder?.sessionId).toBe(A);
  expect((await ctl('release', '--source', 'ex4', '--pid', String(b.pid))).code).toBe(1);
  expect((await ctl('release', '--source', 'ex4', '--pid', String(a.pid))).code).toBe(0);
  const vacant = await ctl('holder', '--source', 'ex4');
  expect(vacant.code).toBe(3);
  expect(JSON.parse((await ctl('holder', '--source', 'ex4', '--json')).out)).toEqual({ source: 'ex4', state: 'vacant', holder: null, request: null });
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('concurrent exclusive subscribes: exactly one wins', async () => {
  const a = await startHost('Holder A', A);
  const b = await startHost('Asker B', B);
  const [ra, rb] = await Promise.all([
    ctl('subscribe', '--exclusive', '--source', 'ex5', '--pid', String(a.pid)),
    ctl('subscribe', '--exclusive', '--source', 'ex5', '--pid', String(b.pid)),
  ]);
  expect([ra.code, rb.code].sort()).toEqual([0, 3]);
  expect((await holderJson('ex5')).holder?.sessionId).toBe(ra.code === 0 ? A : B);
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('unsubscribe --all keeps the exclusive holder', async () => {
  const a = await startHost('Holder A', A);
  expect((await ctl('subscribe', '--exclusive', '--source', 'ex6', '--pid', String(a.pid))).code).toBe(0);
  expect((await ctl('unsubscribe', '--all')).code).toBe(0);
  expect(readStore().holders.find((h) => h.source === 'ex6')?.sessionId).toBe(A);
  expect((await holderJson('ex6')).holder?.sessionId).toBe(A);
  await stop(a);
}, 30_000);

const holderSend = (source: string, key = 'swap', ...extra: string[]) =>
  ctl('send', '--to-holder', '--source', source, '--severity', 'warning', '--key', key, '--text', 'swap 9 GB', ...extra);

test('send --to-holder: only into the bound holder, never to Telegram; throttled inside the window', async () => {
  const a = await startHost('Holder A', A);
  const b = await startHost('Bystander B', B);
  expect((await ctl('subscribe', '--exclusive', '--source', 'th1', '--pid', String(a.pid))).code).toBe(0);
  expect((await ctl('subscribe', '--pid', String(b.pid))).code).toBe(0); // a non-exclusive all-sources subscriber
  const before = sent.length;
  const first = await holderSend('th1');
  expect(first.code).toBe(0);
  expect(first.out).toBe(`OK holder ${A} pid ${a.pid}\n`);
  expect(receivedBy(a.pid)).toContain('[alert th1 · warning · swap] swap 9 GB');
  expect(receivedBy(b.pid)).toEqual([]); // the non-exclusive subscriber gets nothing
  const again = await holderSend('th1');
  expect(again.code).toBe(0);
  expect(again.out).toStartWith('throttled holder');
  expect(receivedBy(a.pid).filter((x) => x.startsWith('[alert th1'))).toHaveLength(1);
  expect(sent.length).toBe(before);
  // After a handoff the same (source,key,severity) reaches the new holder: its window is its own.
  expect((await ctl('handoff', '--source', 'th1', '--to', B, '--pid', String(a.pid))).code).toBe(0);
  const moved = await holderSend('th1');
  expect(moved.out).toBe(`OK holder ${B} pid ${b.pid}\n`);
  expect(receivedBy(b.pid)).toContain('[alert th1 · warning · swap] swap 9 GB');

  const huge = await ctl('send', '--to-holder', '--source', 'th1', '--severity', 'warning', '--key', 'big', '--text', '😀'.repeat(16_000));
  expect(huge.code).toBe(1);
  expect(huge.err).toContain('omp-live limit');
  for (let i = 0; i < 2; i++) {
    const none = await holderSend('th-nobody');
    expect(none.code).toBe(3);
    expect(none.out).toBe('VACANT th-nobody\n');
  }
  const throttle = readFileSync(join(cfg, readdirSync(cfg).find((f) => f.endsWith('.alert-throttle.json'))!), 'utf8');
  expect(throttle).not.toContain('th-nobody');
  expect(sent.length).toBe(before);
  expect((await ctl('unsubscribe', '--pid', String(b.pid))).code).toBe(0);
  await Promise.all([stop(a), stop(b)]);
}, 30_000);

test('send --to-holder: a suspended holder → 5 and the claim is released for the retry', async () => {
  const a = await startHost('Holder A', A);
  expect((await ctl('subscribe', '--exclusive', '--source', 'th2', '--pid', String(a.pid))).code).toBe(0);
  await stop(a);
  const store = readStore();
  for (const h of store.holders) if (h.source === 'th2') h.lastSeenLiveAt = Date.now() - 60_000;
  writeFileSync(storePath(), JSON.stringify(store));
  const first = await holderSend('th2');
  expect(first.code).toBe(5);
  expect(first.out).toBe(`SUSPENDED th2 ${A}\n`);
  const retry = await holderSend('th2');
  expect(retry.code).toBe(5);
  expect(retry.out).not.toContain('throttled');
  const throttle = readFileSync(join(cfg, readdirSync(cfg).find((f) => f.endsWith('.alert-throttle.json'))!), 'utf8');
  expect(throttle).not.toContain(':th2|');
}, 30_000);

test('send --to-holder: a live holder that rejects the delivery → 5 with failingSince; failing 10 min → vacant (3)', async () => {
  const a = await startHost('Holder A', A, true);
  expect((await ctl('subscribe', '--exclusive', '--source', 'th3', '--pid', String(a.pid))).code).toBe(0);
  const failed = await holderSend('th3');
  expect(failed.code).toBe(5);
  expect(failed.out).toStartWith(`FAILED holder ${A}: `);
  const failingSince = readStore().holders.find((h) => h.source === 'th3')?.failingSince;
  expect(typeof failingSince).toBe('number');
  const retry = await holderSend('th3');
  expect(retry.code).toBe(5); // the claim was released: delivery is attempted again
  const store = readStore();
  for (const h of store.holders) if (h.source === 'th3') h.failingSince = Date.now() - 10 * 60_000;
  writeFileSync(storePath(), JSON.stringify(store));
  const vacant = await holderSend('th3');
  expect(vacant.code).toBe(3);
  expect(vacant.out).toBe('VACANT th3\n');
  await stop(a);
}, 30_000);
