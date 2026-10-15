import { expect, test } from 'bun:test';
import {
  DEFAULT_SEND_RETRY,
  postWithRetry,
  sendRetryPolicyFromEnv,
  type SendRetryIo,
} from '../features/transport/send-retry';
import { createTelegramTransport, type QueuedSend } from '../features/transport/telegram';

// tg-cli#710: a Bot API 5xx / 429 / dropped connection is retried with a bounded,
// budgeted backoff; anything else is Telegram's verdict and is returned at once.
// The clock and sleep are fakes, so every case runs instantly.

type Reply = Response | Error;

function fakeIo(replies: Reply[]): SendRetryIo & { calls: string[]; sleeps: number[]; warnings: string[] } {
  let clock = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const warnings: string[] = [];
  return {
    calls,
    sleeps,
    warnings,
    fetch: async (url) => {
      calls.push(url);
      const next = replies.shift();
      if (next === undefined) throw new Error('fake fetch: no reply scripted');
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
    warn: (line) => warnings.push(line),
  };
}

const ok = (result: unknown = { message_id: 5 }): Response => Response.json({ ok: true, result });
const fail = (status: number, extra: Record<string, unknown> = {}): Response =>
  Response.json({ ok: false, error_code: status, description: `HTTP ${status}`, ...extra }, { status });
const reset = (): Error => Object.assign(new Error('The socket connection was closed unexpectedly'), { code: 'ECONNRESET' });
const init = () => ({ method: 'POST', body: '{}' });

test('a 502 followed by a 200 succeeds after one retry, with one short stderr line', async () => {
  const io = fakeIo([fail(502), ok()]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(io.calls).toHaveLength(2);
  expect(io.sleeps).toEqual([1000]);
  expect(io.warnings).toHaveLength(1);
  expect(io.warnings[0]).toContain('sendMessage');
  expect(io.warnings[0]).toContain('502');
  expect(io.warnings[0]).not.toContain('\n');
});

test('a dropped connection followed by a 200 succeeds', async () => {
  const io = fakeIo([reset(), ok()]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(io.calls).toHaveLength(2);
  expect(io.warnings[0]).toContain('ECONNRESET');
});

test('a per-attempt timeout is transient too', async () => {
  const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
  const io = fakeIo([timeout, ok()]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(io.warnings[0]).toContain('TimeoutError');
});

test('500, 503 and 504 retry; the backoff doubles (1 s, 2 s, 4 s)', async () => {
  const io = fakeIo([fail(500), fail(503), fail(504), ok()]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(io.sleeps).toEqual([1000, 2000, 4000]);
});

test('jitter stretches a delay by at most a quarter', async () => {
  const io = { ...fakeIo([fail(502), ok()]), random: () => 0.999 };
  await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(io.sleeps[0]).toBeGreaterThan(1000);
  expect(io.sleeps[0]).toBeLessThanOrEqual(1250);
});

test('a 429 waits parameters.retry_after seconds', async () => {
  const io = fakeIo([fail(429, { parameters: { retry_after: 3 } }), ok()]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(io.sleeps).toEqual([3000]);
});

test('a 429 whose retry_after does not fit the budget gives up', async () => {
  const io = fakeIo([fail(429, { parameters: { retry_after: 120 } })]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(false);
  expect(io.calls).toHaveLength(1);
});

test('a 429 with a non-positive retry_after falls back to the normal backoff', async () => {
  const io = fakeIo([fail(429, { parameters: { retry_after: -1 } }), ok()]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(io.sleeps).toEqual([1000]);
});

test('a 400 is returned at once, never retried', async () => {
  const io = fakeIo([fail(400)]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(true);
  expect(out.ok && out.resp.status).toBe(400);
  expect(io.calls).toHaveLength(1);
  expect(io.sleeps).toEqual([]);
  expect(io.warnings).toEqual([]);
});

test('a persistent 5xx gives up once the budget is spent, naming the last failure', async () => {
  const io = fakeIo(Array.from({ length: 50 }, () => fail(502)));
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(out.ok).toBe(false);
  expect(!out.ok && out.reason).toContain('502');
  const waited = io.sleeps.reduce((a, b) => a + b, 0);
  expect(waited).toBeLessThan(DEFAULT_SEND_RETRY.budgetMs);
  // capped exponential: 1, 2, 4, 8, 8, … — never more than maxDelayMs
  expect(Math.max(...io.sleeps)).toBe(DEFAULT_SEND_RETRY.maxDelayMs);
  expect(io.calls.length).toBeGreaterThan(4);
});

test('a zero budget makes exactly one attempt', async () => {
  const io = fakeIo([fail(502)]);
  const out = await postWithRetry('u/sendMessage', init, 'sendMessage', { ...DEFAULT_SEND_RETRY, budgetMs: 0 }, io);
  expect(out.ok).toBe(false);
  expect(io.calls).toHaveLength(1);
});

test('every attempt carries its own timeout signal and a freshly built body', async () => {
  let built = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const io = fakeIo([fail(502), ok()]);
  const fetchScripted = io.fetch;
  io.fetch = async (url, req) => {
    signals.push(req.signal);
    return fetchScripted(url, req);
  };
  await postWithRetry('u/sendMessage', () => ({ method: 'POST', body: String(++built) }), 'sendMessage', DEFAULT_SEND_RETRY, io);
  expect(built).toBe(2);
  expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  expect(signals[0]).not.toBe(signals[1]);
});

test('TG_SEND_RETRY_BUDGET_MS overrides the budget; garbage keeps the default', () => {
  expect(sendRetryPolicyFromEnv({ TG_SEND_RETRY_BUDGET_MS: '2500' }).budgetMs).toBe(2500);
  expect(sendRetryPolicyFromEnv({ TG_SEND_RETRY_BUDGET_MS: '0' }).budgetMs).toBe(0);
  expect(sendRetryPolicyFromEnv({ TG_SEND_RETRY_BUDGET_MS: 'soon' }).budgetMs).toBe(DEFAULT_SEND_RETRY.budgetMs);
  expect(sendRetryPolicyFromEnv({ TG_SEND_RETRY_BUDGET_MS: '9'.repeat(400) }).budgetMs).toBe(DEFAULT_SEND_RETRY.budgetMs);
  expect(sendRetryPolicyFromEnv({}).budgetMs).toBe(60_000);
  expect(DEFAULT_SEND_RETRY.attemptTimeoutMs).toBe(30_000);
});

// --- the transport: a spent budget switches it to queueing the rest of the send ---

function transportWith(replies: Reply[], extra: Partial<Parameters<typeof createTelegramTransport>[0]> = {}) {
  const io = fakeIo(replies);
  const routes: number[] = [];
  const queued: QueuedSend[] = [];
  const t = createTelegramTransport({
    api: 'https://api.test/botX',
    chatId: '1',
    recordRoute: (id) => routes.push(id),
    io,
    queue: (op) => void queued.push(op),
    ...extra,
  });
  return { t, io, routes, queued };
}

test('transport: a 502 then 200 delivers and records the route', async () => {
  const { t, routes, queued } = transportWith([fail(502), ok({ message_id: 9 })]);
  await t.sendMessage('hi', 'plain');
  expect(routes).toEqual([9]);
  expect(queued).toEqual([]);
});

test('transport: once the budget is spent, the failed part and every later part are queued, delivered parts are not', async () => {
  const replies: Reply[] = [ok({ message_id: 1 }), ...Array.from({ length: 50 }, () => fail(504))];
  const { t, io, routes, queued } = transportWith(replies, { replyToMessageId: 77, messageThreadId: 5, threadIdAdvisory: true });
  await t.sendMessage('part one', 'html');
  const callsAfterFirst = io.calls.length;
  await t.sendMessage('part two', 'html');
  const callsAfterSecond = io.calls.length;
  await t.sendDocument({ type: 'document', source: { kind: 'memory', filename: 'a.txt', content: 'x' } }, undefined, 'plain');
  expect(routes).toEqual([1]);
  // queued mode never touches the network again
  expect(io.calls.length).toBe(callsAfterSecond);
  expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst + 1);
  expect(queued.map((q) => q.method)).toEqual(['sendMessage', 'sendDocument']);
  const body = queued[0].body as Record<string, unknown>;
  expect(body.text).toBe('part two');
  expect(body.parse_mode).toBe('HTML');
  expect(body.message_thread_id).toBe(5);
  // the reply anchor was consumed by the delivered first part
  expect(body.reply_to_message_id).toBeUndefined();
  expect(queued[0].threadAdvisory).toBe(true);
  expect(queued[0].reason).toContain('504');
  expect(queued[1].body).toBeInstanceOf(FormData);
});

test('transport: a queued first part keeps the reply anchor', async () => {
  const { t, queued } = transportWith(Array.from({ length: 50 }, () => fail(502)), { replyToMessageId: 77 });
  await t.sendRich('<h1>x</h1>');
  expect(queued).toHaveLength(1);
  expect((queued[0].body as Record<string, unknown>).reply_parameters).toEqual({ message_id: 77 });
});
