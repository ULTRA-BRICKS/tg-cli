import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// tg-cli#710 end to end: the REAL `tg` against a fake Bot API (TG_API_BASE). A 5xx is
// retried; one that outlasts the retry budget is queued in the bot's outbox and `tg`
// exits 75 (EX_TEMPFAIL); a 400 still fails at once with exit 1.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

// Scripted status per sendMessage request; the default once the script runs out.
let script: number[] = [];
let fallback = 200;
let sent: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as Record<string, unknown>);
      const status = script.shift() ?? fallback;
      if (status === 200) return Response.json({ ok: true, result: { message_id: 40 + sent.length } });
      return Response.json({ ok: false, error_code: status, description: status === 400 ? 'Bad Request: chat not found' : 'Bad Gateway' }, { status });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

afterAll(() => server.stop(true));

function makeHome(): { home: string; cfg: string } {
  const home = tempDir('tg-outbox-home-');
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return { home, cfg };
}

// Async spawn: the fake API runs on this process's event loop.
async function runSend(args: string[], budgetMs: number): Promise<{ exitCode: number; stderr: string; cfg: string }> {
  const { home, cfg } = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TG_SEND_RETRY_BUDGET_MS: String(budgetMs),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr, cfg };
}

function outboxEntries(cfg: string): Array<Record<string, any>> {
  const dir = join(cfg, 'tg-ctl.123.outbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
}

test('a 502 followed by a 200 is delivered after a retry (exit 0)', async () => {
  sent = [];
  script = [502];
  fallback = 200;
  const r = await runSend(['retry me'], 10_000);
  expect(r.exitCode).toBe(0);
  expect(sent).toHaveLength(2);
  expect(r.stderr).toContain('502');
  expect(outboxEntries(r.cfg)).toEqual([]);
});

test('a 5xx that outlasts the budget is queued in the outbox and exits 75', async () => {
  sent = [];
  script = [];
  fallback = 502;
  const before = Date.now();
  const r = await runSend(['--topic', '7', '--reply-to', '55', 'queued report'], 2500);
  expect(r.exitCode).toBe(75);
  // retried inside the budget before giving up
  expect(sent.length).toBeGreaterThan(1);
  expect(r.stderr.toLowerCase()).toContain('queued');
  const entries = outboxEntries(r.cfg);
  expect(entries).toHaveLength(1);
  const op = entries[0].ops[0];
  expect(op.method).toBe('sendMessage');
  expect(op.body.text).toContain('queued report');
  expect(op.body.message_thread_id).toBe(7);
  expect(op.body.reply_to_message_id).toBe(55);
  expect(entries[0].createdAt).toBeGreaterThanOrEqual(before);
  // the daemon log notes the queueing
  expect(readFileSync(join(r.cfg, 'tg-ctl.123.log'), 'utf8')).toContain('outbox: queued');
});

test('a 400 is not retried and not queued (exit 1)', async () => {
  sent = [];
  script = [];
  fallback = 400;
  const r = await runSend(['rejected'], 10_000);
  expect(r.exitCode).toBe(1);
  expect(sent).toHaveLength(1);
  expect(r.stderr).toContain('chat not found');
  expect(outboxEntries(r.cfg)).toEqual([]);
});
