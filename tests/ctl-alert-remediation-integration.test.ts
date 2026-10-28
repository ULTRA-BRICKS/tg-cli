// Exercise the real alert -> tg gate / original omp-live delivery chain. Every network
// endpoint is a private test fixture; symptom-only incidents must never reach Bot API.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { tempDir, trackChild } from './helpers/test-temp';
import { COMPLETE_PROBLEM } from './fixtures/intent-gate/problem-remediation';
import { claimInternalAlert, internalThrottleKey, type AlertThrottleStore } from '../features/tg-ctl/alert-subscriptions';
import { ctlPaths } from '../features/tg-ctl/lock';

const ROOT = join(import.meta.dir, '..');
const raw = 'Memory usage 97%; swap nearly full.';
const sent: Array<Record<string, unknown>> = [];
let rejectPost = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/sendMessage')) return new Response('unexpected', { status: 404 });
    sent.push(await req.json() as Record<string, unknown>);
    return rejectPost
      ? Response.json({ ok: false, description: 'fixture rejects owner post' }, { status: 400 })
      : Response.json({ ok: true, result: { message_id: 800 + sent.length } });
  },
});
const home = tempDir('tgctl-alert-remediation-');
const cfg = join(home, '.config', 'tg-cli');
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
const log = join(home, 'received.jsonl');
writeFileSync(log, '');
const procs: Subprocess[] = [];
const env = { ...process.env, HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: `http://127.0.0.1:${server.port}`, TG_LAYA: '0' };

afterAll(async () => {
  server.stop(true);
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
});

async function host(session: string, fail = false, delayMs = 0, lockAck = false): Promise<Subprocess> {
  const script = `
    import { startLiveEndpoint } from ${JSON.stringify(join(ROOT, 'features/tg-ctl/omp-live-runtime.mjs'))};
    import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
    const ep = await startLiveEndpoint({ root: ${JSON.stringify(join(cfg, 'omp-live'))},
      snapshot: () => ({ sessionId: ${JSON.stringify(session)}, sessionFile: null, cwd: ${JSON.stringify(home)}, title: ${JSON.stringify(session)}, busy: false }),
      send: (text) => {
        if (${fail}) throw new Error('refused');
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ session: ${JSON.stringify(session)}, text }) + '\\n');
        if (${lockAck}) {
          const file = readdirSync(${JSON.stringify(cfg)}).find(name => name.endsWith('.alert-throttle.json'));
          writeFileSync(${JSON.stringify(cfg + '/')} + file + '.lock', String(process.pid), { flag: 'wx' });
        }
        if (${delayMs}) return new Promise(resolve => setTimeout(resolve, ${delayMs}));
      } });
    process.on('SIGTERM', async () => { await ep.close(); process.exit(0); });
    process.stdout.write('ready\\n');
  `;
  const proc = trackChild(Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'pipe' }));
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain('ready');
  return proc;
}

async function command(script: string, ...args: string[]) {
  const proc = trackChild(Bun.spawn(['bun', join(ROOT, script), ...args], { env, stdout: 'pipe', stderr: 'pipe' }));
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}
const ctl = (...args: string[]) => command('tg-ctl', 'alert', ...args);
const send = (source: string, text = raw) => ctl('send', '--source', source, '--severity', 'critical', '--key', 'memory', '--text', text);
const received = (session: string): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as { session: string; text: string }).filter((row) => row.session === session).map((row) => row.text);
const throttles = (): Array<{ key: string; at: number; messageId: number | null; pending: string[]; internalText?: string; internalAttempts?: Array<{ sessionId: string; pid: number; instanceId: string }> }> => {
  const file = readdirSync(cfg).find((name) => name.endsWith('.alert-throttle.json'));
  return file ? JSON.parse(readFileSync(join(cfg, file), 'utf8')).sent : [];
};
async function stop(proc: Subprocess): Promise<void> { proc.kill('SIGTERM'); await proc.exited; }

test('lost acceptance acknowledgement does not replay an internal incident after endpoint restart', async () => {
  const session = 'lost-ack-restarted';
  const first = await host(session, false, 2500);
  expect((await ctl('subscribe', '--pid', String(first.pid), '--sources', 'restart-memory')).code).toBe(0);
  const before = sent.length;
  const attempted = await send('restart-memory');
  expect(attempted.code).toBe(1);
  expect(received(session)).toHaveLength(1);
  const original = throttles().find(entry => entry.key.includes('restart-memory'))!;
  expect(original.pending).toEqual([session]);
  await Bun.sleep(700); // the accepted callback finishes after the caller's 2 s receipt deadline
  await stop(first);
  const resumed = await host(session);
  const retry = await send('restart-memory', 'Updated memory sample 98%.');
  expect(retry.code).toBe(1);
  expect(retry.out).toContain('UNCERTAIN owner=withheld sessions=0 pending=1');
  expect(retry.err).toContain('internal_delivery_uncertain');
  expect(received(session)).toHaveLength(1);
  const retained = throttles().find(entry => entry.key === original.key)!;
  expect(retained.at).toBe(original.at);
  expect(retained.pending).toEqual([session]);
  expect(retained.internalText).toBe(original.internalText);
  expect(retained.internalAttempts?.[0].pid).toBe(first.pid);
  expect(sent).toHaveLength(before);
  await stop(resumed);
}, 30_000);

test('lost acceptance acknowledgement can still be reconciled by the same endpoint receipt', async () => {
  const session = 'lost-ack-same-endpoint';
  const agent = await host(session, false, 2500);
  expect((await ctl('subscribe', '--pid', String(agent.pid), '--sources', 'same-endpoint-memory')).code).toBe(0);
  expect((await send('same-endpoint-memory')).code).toBe(1);
  await Bun.sleep(700);
  expect((await send('same-endpoint-memory', 'Changed caller sample.')).code).toBe(0);
  expect(received(session)).toHaveLength(1);
  expect(throttles().find(entry => entry.key.includes('same-endpoint-memory'))?.pending).toEqual([]);
  await stop(agent);
}, 30_000);

test('failure to save an accepted receipt does not replay it after endpoint restart', async () => {
  const session = 'save-ack-restarted';
  const first = await host(session, false, 0, true);
  expect((await ctl('subscribe', '--pid', String(first.pid), '--sources', 'save-ack-memory')).code).toBe(0);
  const attempted = await send('save-ack-memory');
  expect(attempted.code).toBe(1);
  expect(attempted.err).toContain('original pending receipt retained');
  expect(received(session)).toHaveLength(1);
  const original = throttles().find(entry => entry.key.includes('save-ack-memory'))!;
  const lock = readdirSync(cfg).find(name => name.endsWith('.alert-throttle.json.lock'))!;
  unlinkSync(join(cfg, lock));
  await stop(first);
  const resumed = await host(session);
  const retry = await send('save-ack-memory');
  expect(retry.code).toBe(1);
  expect(retry.out).toContain('UNCERTAIN owner=withheld sessions=0 pending=1');
  expect(received(session)).toHaveLength(1);
  expect(throttles().find(entry => entry.key === original.key)?.pending).toEqual([session]);
  await stop(resumed);
}, 30_000);

test('retention age and ordinary history pressure cannot replay a lost-ACK incident after restart', async () => {
  const session = 'retention-restarted';
  const first = await host(session, false, 2500);
  expect((await ctl('subscribe', '--pid', String(first.pid), '--sources', 'retention-memory')).code).toBe(0);
  const before = sent.length;
  expect((await send('retention-memory')).code).toBe(1);
  expect(received(session)).toHaveLength(1);
  await Bun.sleep(700);
  await stop(first);
  const path = ctlPaths(cfg, '123').alertThrottle;
  const store = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sent: Array<Record<string, unknown>> };
  const original = store.sent.find(entry => String(entry.key).includes('retention-memory'))!;
  // Advance this receipt past the normal expiry boundary without a wall-clock sleep.
  original.at = Date.now() - 25 * 60 * 60_000;
  for (let i = 0; i < 200; i++) store.sent.push({ key: `ordinary-pressure-${i}`, at: Date.now(), messageId: i + 1, pending: [] });
  writeFileSync(path, JSON.stringify(store));
  const resumed = await host(session);
  const result = await send('retention-memory');
  expect(result.code).toBe(1);
  expect(result.out).toContain('UNCERTAIN owner=withheld sessions=0 pending=1');
  expect(received(session)).toHaveLength(1);
  expect(throttles().find(entry => entry.key === original.key)?.at).toBe(original.at as number);
  expect(sent).toHaveLength(before);
  await stop(resumed);
}, 30_000);

test('full unresolved receipt capacity refuses a new internal claim before delivering anything', async () => {
  const agent = await host('capacity-recipient');
  expect((await ctl('subscribe', '--pid', String(agent.pid), '--sources', 'capacity-memory')).code).toBe(0);
  const path = ctlPaths(cfg, '123').alertThrottle;
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let store: AlertThrottleStore = { sent: [] };
  for (let i = 0; i < 200; i++) {
    const key = internalThrottleKey({ source: 'retained', severity: 'critical', key: `pending-${i}`, text: 'incident', html: false, title: null }, null);
    store = claimInternalAlert(store, key, Date.now(), 'incident', ['unresolved']);
  }
  const before = sent.length;
  writeFileSync(path, JSON.stringify({ version: 1, sent: store.sent }));
  try {
    const result = await send('capacity-memory');
    expect(result.code).toBe(1);
    expect(result.err).toContain('internal receipt capacity');
    expect(result.out).toContain('FAILED owner=withheld sessions=0');
    expect(received('capacity-recipient')).toHaveLength(0);
    expect(throttles().map(entry => entry.key)).toEqual(store.sent.map(entry => entry.key));
    expect(sent).toHaveLength(before);
    const complete = await send('capacity-memory', COMPLETE_PROBLEM);
    expect(complete.code).toBe(0);
    expect(complete.out).toContain('OK tg#');
    expect(sent).toHaveLength(before + 1);
    expect(throttles().filter(entry => entry.internalText !== undefined).map(entry => entry.key)).toEqual(store.sent.map(entry => entry.key));
  } finally {
    if (prior === null) unlinkSync(path); else writeFileSync(path, prior);
    await stop(agent);
  }
}, 30_000);

test('raw critical incident reaches subscriber, stays off Telegram, and does not throttle a later complete owner report', async () => {
  const session = 'raw-subscriber';
  const agent = await host(session);
  expect((await ctl('subscribe', '--pid', String(agent.pid), '--sources', 'raw-memory')).code).toBe(0);
  const before = sent.length;
  // Prove this very text is refused by the real automated owner-report gate.
  expect((await command('tg', '--automated', '--tag', 'problem', raw)).code).not.toBe(0);
  expect(sent).toHaveLength(before);

  const routed = await send('raw-memory');
  expect(routed.code).toBe(0);
  expect(routed.out).toContain('INTERNAL owner=withheld sessions=1');
  expect(sent).toHaveLength(before);
  expect(received(session)).toHaveLength(1);
  expect(received(session)[0]).toContain(raw);
  expect(received(session)[0]).toContain('Owner problem report withheld');
  expect(received(session)[0]).toContain('actual');
  expect(received(session)[0]).not.toMatch(/tg#0|--reply-to 0|remediation started/u);
  expect((await send('raw-memory')).out).toContain('throttled internal');
  expect(received(session)).toHaveLength(1);

  const complete = await send('raw-memory', COMPLETE_PROBLEM);
  expect(complete.code).toBe(0);
  expect(complete.out).toContain('OK tg#');
  expect(sent).toHaveLength(before + 1);
  expect(received(session)).toHaveLength(2);
  await stop(agent);
}, 30_000);

test('a complete plain-text alert is judged as the body tg will post, so angle-bracket URLs do not withhold it', async () => {
  const before = sent.length;
  const text = 'Already tried: Checked <https://api.example.com/health>; result: HTTP 503.\nDoing now: Checking backup API health.';
  const result = await send('angle-url', text);
  expect(result.code).toBe(0);
  expect(result.out).toContain('OK tg#');
  expect(sent).toHaveLength(before + 1);
}, 30_000);

test('a complete alert typed with literal \\n escapes is judged after the decoding tg applies', async () => {
  const before = sent.length;
  const text = 'Already tried:\\nChecked the API; result: HTTP 503.\\nDoing now:\\nRestarting the worker.';
  const result = await send('escaped-lines', text);
  expect(result.code).toBe(0);
  expect(result.out).toContain('OK tg#');
  expect(sent).toHaveLength(before + 1);
}, 30_000);

test('a post the classifier refuses is withheld as a content problem, not reported as an unconfirmed owner post', async () => {
  const layaDir = tempDir('tgctl-laya-', { short: true });
  const socketPath = join(layaDir, 'laya.sock');
  const laya = Bun.listen<{ input: string }>({
    unix: socketPath,
    socket: {
      open(socket) { socket.data = { input: '' }; },
      data(socket, chunk) {
        socket.data.input += Buffer.from(chunk).toString('utf8');
        if (!socket.data.input.includes('\n')) return;
        const req = JSON.parse(socket.data.input.split('\n')[0]) as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(Object.keys(req.questions).map((key) => [key, { type: 'noul', noul: 0.05 }]));
        socket.write(`${JSON.stringify({ ok: true, result: { answers } })}\n`);
      },
    },
  });
  try {
    const before = sent.length;
    const proc = trackChild(Bun.spawn(['bun', join(ROOT, 'tg-ctl'), 'alert', 'send', '--source', 'laya-refused', '--severity', 'critical', '--key', 'memory', '--text', COMPLETE_PROBLEM], {
      env: { ...env, TG_LAYA: '1', TG_LAYA_SOCKET: socketPath, TG_LAYA_TIMEOUT_MS: '1500' }, stdout: 'pipe', stderr: 'pipe',
    }));
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(err).toContain('Blocked: nothing was sent');
    expect(out).toContain('owner=withheld');
    expect(out).not.toContain('owner=unconfirmed');
    expect(sent).toHaveLength(before);
  } finally { laya.stop(true); }
}, 30_000);

test('partial internal delivery retries only pending session with original text and claim identity', async () => {
  const good = await host('partial-good');
  expect((await ctl('subscribe', '--pid', String(good.pid), '--sources', 'partial-memory')).code).toBe(0);
  // No frame has reached this suspended session. A throwing host callback would be an
  // uncertain side effect, so a new generation must not blindly replay that attempt.
  expect((await ctl('subscribe', '--session', 'partial-failing', '--sources', 'partial-memory')).code).toBe(0);
  const before = sent.length;
  const first = await send('partial-memory');
  expect(first.code).toBe(1);
  expect(first.out).toContain('owner=withheld sessions=1 pending=1');
  expect(received('partial-good')).toHaveLength(1);
  const initial = throttles().find((entry) => entry.key.startsWith('internal:') && entry.key.includes('partial-memory'))!;
  expect(initial.pending).toEqual(['partial-failing']);
  expect(initial.messageId).toBe(0);

  const resumed = await host('partial-failing');
  const retry = await send('partial-memory', 'Updated memory sample 98%; still full.');
  expect(retry.code).toBe(0);
  expect(retry.out).toContain('throttled internal');
  expect(received('partial-good')).toHaveLength(1);
  expect(received('partial-failing')).toEqual(received('partial-good'));
  const settled = throttles().find((entry) => entry.key === initial.key)!;
  expect(settled.at).toBe(initial.at);
  expect(settled.pending).toEqual([]);
  expect(settled.internalText).toBe(initial.internalText);
  expect(sent).toHaveLength(before);
  await Promise.all([stop(good), stop(resumed)]);
}, 30_000);

test('suspended exclusive holder retains pending incident and is never bypassed to subscribers', async () => {
  const coordinator = await host('exclusive-coordinator');
  const subscriber = await host('exclusive-subscriber');
  expect((await ctl('subscribe', '--exclusive', '--source', 'exclusive-memory', '--pid', String(coordinator.pid))).code).toBe(0);
  expect((await ctl('subscribe', '--sources', 'exclusive-memory', '--pid', String(subscriber.pid))).code).toBe(0);
  await stop(coordinator);
  const before = sent.length;
  const pending = await send('exclusive-memory');
  expect(pending.code).toBe(5);
  expect(pending.out).toContain('SUSPENDED');
  expect(pending.out).toContain('owner=withheld');
  expect(received('exclusive-subscriber')).toHaveLength(0);
  const saved = throttles().find((entry) => entry.key.startsWith('internal:') && entry.key.includes('exclusive-memory'))!;
  expect(saved.pending).toEqual(['exclusive-coordinator']);
  const resumed = await host('exclusive-coordinator');
  expect((await send('exclusive-memory')).code).toBe(0);
  expect(received('exclusive-coordinator')).toHaveLength(1);
  expect(received('exclusive-subscriber')).toHaveLength(0);
  expect(throttles().find((entry) => entry.key === saved.key)?.at).toBe(saved.at);
  expect(sent).toHaveLength(before);
  await Promise.all([stop(resumed), stop(subscriber)]);
}, 30_000);

test('a replacement subscriber receives the pending incident without replaying accepted recipients', async () => {
  const good = await host('reassignment-good');
  const old = await host('reassignment-old', true);
  for (const agent of [good, old]) expect((await ctl('subscribe', '--pid', String(agent.pid), '--sources', 'reassigned-memory')).code).toBe(0);
  expect((await send('reassigned-memory')).code).toBe(1);
  const saved = throttles().find((entry) => entry.key.startsWith('internal:') && entry.key.includes('reassigned-memory'))!;
  expect(saved.pending).toEqual(['reassignment-old']);
  expect((await ctl('unsubscribe', '--session', 'reassignment-old')).code).toBe(0);
  await stop(old);
  const replacement = await host('reassignment-new');
  expect((await ctl('subscribe', '--pid', String(replacement.pid), '--sources', 'reassigned-memory')).code).toBe(0);
  const retry = await send('reassigned-memory', 'Memory usage is now 98%.');
  expect(retry.code).toBe(0);
  expect(received('reassignment-good')).toHaveLength(1);
  expect(received('reassignment-new')).toEqual(received('reassignment-good'));
  expect(throttles().find((entry) => entry.key === saved.key)?.pending).toEqual([]);
  expect(throttles().find((entry) => entry.key === saved.key)?.at).toBe(saved.at);
  // Accepted history survives withdrawal and even a new process with the same session.
  expect((await ctl('unsubscribe', '--session', 'reassignment-good')).code).toBe(0);
  expect((await send('reassigned-memory')).code).toBe(0);
  await stop(good);
  const resumed = await host('reassignment-good');
  expect((await ctl('subscribe', '--pid', String(resumed.pid), '--sources', 'reassigned-memory')).code).toBe(0);
  expect((await send('reassigned-memory')).code).toBe(0);
  expect(received('reassignment-good')).toHaveLength(1);
  expect(received('reassignment-new')).toHaveLength(1);
  await Promise.all([stop(resumed), stop(replacement)]);
}, 30_000);

test('vacant incident has explicit local failure, leaves no false receipt, and can be delivered after subscribe', async () => {
  const before = sent.length;
  const absent = await send('vacant-memory');
  expect(absent.code).toBe(3);
  expect(absent.out).toContain('VACANT owner=withheld sessions=0');
  expect(throttles().some((entry) => entry.key.includes('vacant-memory'))).toBe(false);
  const agent = await host('new-subscriber');
  expect((await ctl('subscribe', '--sources', 'vacant-memory', '--pid', String(agent.pid))).code).toBe(0);
  expect((await send('vacant-memory')).code).toBe(0);
  expect(received('new-subscriber')).toHaveLength(1);
  expect(sent).toHaveLength(before);
  await stop(agent);
}, 30_000);

test('unreachable live exclusive holder is retained without leaking the incident to subscribers', async () => {
  const coordinator = await host('unreachable-coordinator', true);
  const subscriber = await host('unreachable-subscriber');
  expect((await ctl('subscribe', '--exclusive', '--source', 'unreachable-memory', '--pid', String(coordinator.pid))).code).toBe(0);
  expect((await ctl('subscribe', '--sources', 'unreachable-memory', '--pid', String(subscriber.pid))).code).toBe(0);
  const before = sent.length;
  const result = await send('unreachable-memory');
  expect(result.code).toBe(5);
  expect(result.out).toContain('owner=withheld sessions=0 pending=1 holder=unreachable-coordinator');
  expect(result.err).toContain('internal delivery unconfirmed');
  expect(received('unreachable-subscriber')).toHaveLength(0);
  expect(sent).toHaveLength(before);
  const receipt = throttles().find((entry) => entry.key.startsWith('internal:') && entry.key.includes('unreachable-memory'))!;
  expect(receipt.pending).toEqual(['unreachable-coordinator']);
  await Promise.all([stop(coordinator), stop(subscriber)]);
}, 30_000);

test('owner-post failure still delivers internal incident and keeps owner retry eligible', async () => {
  const agent = await host('owner-failure-subscriber');
  expect((await ctl('subscribe', '--sources', 'owner-failure', '--pid', String(agent.pid))).code).toBe(0);
  rejectPost = true;
  let failed: Awaited<ReturnType<typeof send>>;
  try { failed = await send('owner-failure', COMPLETE_PROBLEM); }
  finally { rejectPost = false; }
  expect(failed!.code).toBe(1);
  expect(failed!.out).toContain('owner=unconfirmed sessions=1');
  expect(received('owner-failure-subscriber')).toHaveLength(1);
  expect(received('owner-failure-subscriber')[0]).toContain('Owner delivery is unconfirmed');
  expect((await send('owner-failure', COMPLETE_PROBLEM)).out).toContain('OK tg#');
  expect(received('owner-failure-subscriber')).toHaveLength(2);
  await stop(agent);
}, 30_000);
