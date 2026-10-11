// tg-cli#636: the `tg-ctl alert` lifecycle against a real omp-live endpoint and a mock
// Bot API — subscribe, a send that posts to Telegram with the footer and delivers the
// `[alert tg#<id> …]` copy into the session, the throttle, unbind when the session's
// endpoint is gone, rebind when a NEW process publishes the SAME session id (a resume).
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

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

const home = mkdtempSync(join(tmpdir(), 'tgctl-alert-'));
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
  rmSync(home, { recursive: true, force: true });
});

const env = { ...process.env, HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: `http://127.0.0.1:${server.port}` };

// A stand-in original omp: publishes an endpoint for SESSION from its OWN process (so a
// "resume" is a new pid) and appends every delivered text to receivedLog.
async function startHost(title: string): Promise<Subprocess> {
  const script = `
    import { startLiveEndpoint } from ${JSON.stringify(join(import.meta.dir, '..', 'features', 'tg-ctl', 'omp-live-runtime.mjs'))};
    import { appendFileSync } from 'node:fs';
    const ep = await startLiveEndpoint({ root: ${JSON.stringify(join(cfg, 'omp-live'))},
      snapshot: () => ({ sessionId: ${JSON.stringify(SESSION)}, sessionFile: null, cwd: ${JSON.stringify(home)}, title: ${JSON.stringify(title)}, busy: false }),
      send: (text) => appendFileSync(${JSON.stringify(receivedLog)}, JSON.stringify({ pid: process.pid, text }) + '\\n') });
    process.on('SIGTERM', async () => { await ep.close(); process.exit(0); });
    console.log('ready');
  `;
  const proc = Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'pipe' });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain('ready');
  return proc;
}

async function ctl(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', TG_CTL, 'alert', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
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

  const sendArgs = ['send', '--source', 'sysmon', '--severity', 'critical', '--key', 'load', '--text', 'load 38 > 24; swap 10 GB'];
  const posted = await ctl(...sendArgs);
  expect(posted.err).toBe('');
  expect(posted.code).toBe(0);
  expect(posted.out).toBe(`OK tg#500 sessions=1 (Supervisor (pid ${first.pid}))\n`);
  expect(sent).toHaveLength(1);
  expect(String(sent[0].text)).toEndWith(`load 38 &gt; 24; swap 10 GB\n\n<i>↳ также адресовано агенту: Supervisor (pid ${first.pid})</i>`);
  expect(received()).toEqual([{ pid: first.pid, text: '[alert tg#500 · sysmon · critical] load 38 > 24; swap 10 GB\n— when fixed, follow up on this alert: tg --reply-to 500 "<status>"' }]);

  // The same (source,key,severity) inside the window: nothing posted, nothing delivered.
  const repeat = await ctl(...sendArgs);
  expect(repeat.code).toBe(0);
  expect(repeat.out).toStartWith('throttled tg#500 ');
  expect(sent).toHaveLength(1);
  // An escalation (different severity) and a source nobody subscribed to.
  const warning = await ctl('send', '--source', 'sysmon', '--severity', 'warning', '--key', 'load', '--text', 'w');
  expect(warning.out).toBe(`OK tg#501 sessions=1 (Supervisor (pid ${first.pid}))\n`);
  const other = await ctl('send', '--source', 'other', '--severity', 'warning', '--key', 'x', '--text', 'x');
  expect(other.out).toBe('OK tg#502 sessions=0\n');
  expect(String(sent[2].text)).not.toContain('адресовано');
  expect(received()).toHaveLength(2);

  // The session closes: its endpoint is withdrawn, the subscription stays but is suspended.
  first.kill('SIGTERM');
  await first.exited;
  expect((await ctl('list')).out).toContain(`  - suspended (no live omp-live endpoint) · Supervisor · pid ${first.pid} · session ${SESSION}`);
  const unbound = await ctl('send', '--source', 'sysmon', '--severity', 'critical', '--key', 'mem', '--text', 'm');
  expect(unbound.out).toBe('OK tg#503 sessions=0\n');
  expect(received()).toHaveLength(2);

  // Resume: a new process publishes the same session id → bound again, new pid, new title.
  const second = await startHost('Supervisor (resumed)');
  expect(second.pid).not.toBe(first.pid);
  expect((await ctl('list')).out).toContain(`  - bound · Supervisor (resumed) · pid ${second.pid} · session ${SESSION}`);
  const rebound = await ctl('send', '--source', 'supervisor', '--severity', 'critical', '--key', 'OVERLOAD', '--text', 'load1=40');
  expect(rebound.out).toBe(`OK tg#504 sessions=1 (Supervisor (resumed) (pid ${second.pid}))\n`);
  expect(received().at(-1)).toEqual({ pid: second.pid, text: '[alert tg#504 · supervisor · critical] load1=40\n— when fixed, follow up on this alert: tg --reply-to 504 "<status>"' });

  // Unsubscribe by the recorded pid; list is empty again.
  expect((await ctl('unsubscribe', '--pid', String(second.pid))).out).toBe(`unsubscribed session ${SESSION}\n`);
  expect((await ctl('list')).out).toBe('alert subscriptions: none\n');
}, 30_000);
