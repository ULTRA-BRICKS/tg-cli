import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTelegramTransport, isThreadRejection, TelegramSendError } from '../features/transport/telegram';

// createTelegramTransport hits the Bot API via global fetch. Stub fetch to
// capture the request bodies (JSON sends) and FormData (multipart sends) so we
// can assert message_thread_id wiring without touching the network. Mirrors
// transport-reply.test.ts.
//
// THE LOAD-BEARING CONTRACT (forum-topics increment 2, docs/specs/
// tg-forum-topics.md §8): unlike reply_to_message_id (consumed after the FIRST
// message so split-continuation chunks don't re-reply to one anchor), a topic's
// message_thread_id rides EVERY message — every send in a topic carries the same
// thread id, including >4096 split continuations and album items, or the
// continuation lands in General. The tests below pin both: thread id present on
// every primitive, AND back-compat absence when no topic is given (the
// daily-critical 1:1 path must stay byte-identical).

const realFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>>;
let forms: FormData[];

beforeEach(() => {
  bodies = [];
  forms = [];
  let nextId = 100;
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    if (init?.body instanceof FormData) {
      forms.push(init.body);
    } else if (typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    } else {
      bodies.push({});
    }
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: nextId++ } }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CTX = { api: 'https://api.telegram.org/botTEST', chatId: '42', recordRoute: () => {} };

// A memory-sourced SendItem the photo/document/album primitives can upload
// without touching the filesystem.
function memItem(filename: string): Parameters<ReturnType<typeof createTelegramTransport>['sendPhoto']>[0] {
  return {
    type: filename.endsWith('.png') ? 'photo' : 'document',
    source: { kind: 'memory', content: 'x', filename },
  } as Parameters<ReturnType<typeof createTelegramTransport>['sendPhoto']>[0];
}

test('message_thread_id is set on sendMessage when messageThreadId is given', async () => {
  const t = createTelegramTransport({ ...CTX, messageThreadId: 7 });
  await t.sendMessage('topic reply', 'plain');
  expect(bodies).toHaveLength(1);
  expect(bodies[0].message_thread_id).toBe(7);
  expect(bodies[0].text).toBe('topic reply');
});

test('message_thread_id is set on sendRich too', async () => {
  const t = createTelegramTransport({ ...CTX, messageThreadId: 7 });
  await t.sendRich('<b>hi</b>');
  expect(bodies).toHaveLength(1);
  expect(bodies[0].message_thread_id).toBe(7);
});

test('message_thread_id rides EVERY message — it is NOT consumed after the first', async () => {
  // The load-bearing distinction from reply_to_message_id: a >4096 split sends
  // several sendMessage calls; each MUST carry the thread id or the continuation
  // lands in General.
  const t = createTelegramTransport({ ...CTX, messageThreadId: 7 });
  await t.sendMessage('chunk 1', 'plain');
  await t.sendMessage('chunk 2', 'plain');
  expect(bodies).toHaveLength(2);
  expect(bodies[0].message_thread_id).toBe(7);
  expect(bodies[1].message_thread_id).toBe(7);
});

test('message_thread_id is carried on multipart sends (photo, document, mediaGroup)', async () => {
  const t = createTelegramTransport({ ...CTX, messageThreadId: 7 });
  await t.sendPhoto(memItem('a.png'), 'cap', 'plain');
  await t.sendDocument(memItem('a.txt'), 'cap', 'plain');
  await t.sendMediaGroup('photo', [memItem('a.png'), memItem('b.png')], 'cap', 'plain');
  expect(forms).toHaveLength(3);
  for (const form of forms) {
    expect(form.get('message_thread_id')).toBe('7');
  }
});

test('NO message_thread_id is set when none is given — back-compat (1:1 path byte-identical)', async () => {
  const t = createTelegramTransport(CTX);
  await t.sendMessage('plain message', 'plain');
  await t.sendRich('<b>x</b>');
  await t.sendPhoto(memItem('a.png'), 'cap', 'plain');
  await t.sendDocument(memItem('a.txt'), 'cap', 'plain');
  await t.sendMediaGroup('photo', [memItem('a.png'), memItem('b.png')], 'cap', 'plain');
  for (const body of bodies) {
    expect('message_thread_id' in body).toBe(false);
  }
  for (const form of forms) {
    expect(form.has('message_thread_id')).toBe(false);
  }
});

test('topic and reply compose: a threaded reply INSIDE a topic carries both ids', async () => {
  const t = createTelegramTransport({ ...CTX, messageThreadId: 7, replyToMessageId: 1234 });
  await t.sendMessage('answer in topic', 'plain');
  expect(bodies[0].message_thread_id).toBe(7);
  expect(bodies[0].reply_to_message_id).toBe(1234);
});

// --- isThreadRejection: only thread-specific failures fall back ---
test('isThreadRejection matches the thread-rejection descriptions, not other errors', () => {
  expect(isThreadRejection('Bad Request: message thread not found')).toBe(true);
  expect(isThreadRejection('Bad Request: TOPIC_CLOSED')).toBe(true);
  expect(isThreadRejection('Bad Request: the chat is not a forum')).toBe(true);
  expect(isThreadRejection('Bad Request: message text is empty')).toBe(false);
  expect(isThreadRejection('Forbidden: bot was blocked by the user')).toBe(false);
  expect(isThreadRejection(undefined)).toBe(false);
});

// --- advisory (env-sourced) thread fallback: a rejection retries to General ---
// A fetch stub that rejects the FIRST send carrying message_thread_id (mimicking
// a stale/closed TG_TOPIC) and succeeds on any send WITHOUT it.
// `rejectAsHttp400` toggles WHICH error shape the rejection uses: the common
// Telegram HTTP-400 (resp.ok false) or a 200 with { ok:false } (some proxies) —
// readErrorDescription must handle both. A fresh mock Response is built per call
// so the body is never double-consumed (clone() returns an independent copy).
function mockResponse(httpOk: boolean, payload: { ok: boolean; description?: string; result?: unknown }): Response {
  const text = JSON.stringify(payload);
  const make = (): Response =>
    ({
      ok: httpOk,
      status: httpOk ? 200 : 400,
      json: async () => payload,
      text: async () => text,
      clone: () => make(),
    }) as unknown as Response;
  return make();
}

function installThreadRejectingFetch(rejectAsHttp400 = false): void {
  let nextId = 200;
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    bodies.push(body);
    if ('message_thread_id' in body) {
      return mockResponse(!rejectAsHttp400, { ok: false, description: 'Bad Request: message thread not found' });
    }
    return mockResponse(true, { ok: true, result: { message_id: nextId++ } });
  }) as unknown as typeof fetch;
}

test('an ADVISORY (env) thread id that Telegram rejects retries WITHOUT the thread — lands in General', async () => {
  installThreadRejectingFetch();
  const t = createTelegramTransport({ ...CTX, messageThreadId: 99, threadIdAdvisory: true });
  // Must NOT throw / exit — the send falls back to General.
  await t.sendMessage('survives a stale TG_TOPIC', 'plain');
  // Two POSTs: the first WITH the thread (rejected), the retry WITHOUT it.
  expect(bodies).toHaveLength(2);
  expect(bodies[0].message_thread_id).toBe(99);
  expect('message_thread_id' in bodies[1]).toBe(false);
  expect(bodies[1].text).toBe('survives a stale TG_TOPIC');
});

test('the advisory fallback also fires on the HTTP-400 rejection shape (real Telegram)', async () => {
  installThreadRejectingFetch(/* rejectAsHttp400 */ true);
  const t = createTelegramTransport({ ...CTX, messageThreadId: 99, threadIdAdvisory: true });
  await t.sendMessage('survives an HTTP-400 thread reject', 'plain');
  expect(bodies).toHaveLength(2);
  expect(bodies[0].message_thread_id).toBe(99);
  expect('message_thread_id' in bodies[1]).toBe(false);
});

test('an ADVISORY rich send also falls back to General on a thread rejection', async () => {
  installThreadRejectingFetch();
  const t = createTelegramTransport({ ...CTX, messageThreadId: 99, threadIdAdvisory: true });
  await t.sendRich('<b>rich survives</b>');
  expect(bodies).toHaveLength(2);
  expect(bodies[0].message_thread_id).toBe(99);
  expect('message_thread_id' in bodies[1]).toBe(false);
});

test('advisory mode still FAILS LOUD on a non-thread error (rate-limit / blocked) — no silent General retry', async () => {
  // The whole safety of threadIdAdvisory rests on isThreadRejection being NARROW:
  // a NON-thread error in advisory mode must reach checkResponse and fail the send, NOT be
  // swallowed into a General retry. This pins that — a regression that widens
  // isThreadRejection would make this go red.
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    bodies.push(body);
    // A non-thread failure regardless of the thread id (e.g. flood wait).
    return mockResponse(false, { ok: false, description: 'Too Many Requests: retry after 5' });
  }) as unknown as typeof fetch;
  const t = createTelegramTransport({ ...CTX, messageThreadId: 99, threadIdAdvisory: true });
  await expect(t.sendMessage('rate limited in a topic', 'plain')).rejects.toThrow(TelegramSendError);
  // Exactly ONE POST — the non-thread error is NOT retried to General.
  expect(bodies).toHaveLength(1);
  expect(bodies[0].message_thread_id).toBe(99);
});

test('the advisory General retry drops the reply anchor too (no re-bind to the rejected topic)', async () => {
  installThreadRejectingFetch();
  const t = createTelegramTransport({
    ...CTX,
    messageThreadId: 99,
    threadIdAdvisory: true,
    replyToMessageId: 555, // a message INSIDE the (rejected) topic
  });
  await t.sendMessage('reply inside a stale topic', 'plain');
  expect(bodies).toHaveLength(2);
  // First attempt carries both the thread and the reply anchor.
  expect(bodies[0].message_thread_id).toBe(99);
  expect(bodies[0].reply_to_message_id).toBe(555);
  // The General retry drops BOTH — a plain message, so Telegram can't re-bind it
  // to the rejected topic via the reply anchor.
  expect('message_thread_id' in bodies[1]).toBe(false);
  expect('reply_to_message_id' in bodies[1]).toBe(false);
});

test('a NON-advisory (explicit --topic) thread rejection does NOT fall back — it fails loud', async () => {
  // checkResponse throws a TelegramSendError on an { ok:false } body: the strict path fails
  // the send (no silent General retry).
  installThreadRejectingFetch();
  const t = createTelegramTransport({ ...CTX, messageThreadId: 99 }); // advisory false
  await expect(t.sendMessage('explicit topic must not silently retry', 'plain')).rejects.toThrow(TelegramSendError);
  // Exactly ONE POST — the strict path does not retry to General.
  expect(bodies).toHaveLength(1);
  expect(bodies[0].message_thread_id).toBe(99);
});

test('the advisory rich (sendRich) General retry also drops reply_parameters', async () => {
  installThreadRejectingFetch();
  const t = createTelegramTransport({
    ...CTX,
    messageThreadId: 99,
    threadIdAdvisory: true,
    replyToMessageId: 777, // sendRich threads via reply_parameters
  });
  await t.sendRich('<b>rich reply in a stale topic</b>');
  expect(bodies).toHaveLength(2);
  expect(bodies[0].message_thread_id).toBe(99);
  expect(bodies[0].reply_parameters).toEqual({ message_id: 777 });
  // The General retry drops BOTH the thread and the rich reply anchor.
  expect('message_thread_id' in bodies[1]).toBe(false);
  expect('reply_parameters' in bodies[1]).toBe(false);
});

// --- readErrorDescription: direct unit coverage of its branchy logic ---
function resp(httpOk: boolean, body: string): Response {
  return {
    ok: httpOk,
    status: httpOk ? 200 : 400,
    text: async () => body,
  } as unknown as Response;
}

test('readErrorDescription returns the description on { ok:false } (200 or HTTP-400)', async () => {
  const { readErrorDescription } = await import('../features/transport/telegram');
  expect(await readErrorDescription(resp(true, JSON.stringify({ ok: false, description: 'topic closed' })))).toBe(
    'topic closed',
  );
  expect(await readErrorDescription(resp(false, JSON.stringify({ ok: false, description: 'thread not found' })))).toBe(
    'thread not found',
  );
});

test('readErrorDescription returns null on success and empty string on { ok:false } without a description', async () => {
  const { readErrorDescription } = await import('../features/transport/telegram');
  expect(await readErrorDescription(resp(true, JSON.stringify({ ok: true, result: { message_id: 1 } })))).toBeNull();
  // { ok:false } with no description → '' (an error, but not a thread rejection — must NOT fall back).
  expect(await readErrorDescription(resp(true, JSON.stringify({ ok: false })))).toBe('');
  expect(isThreadRejection('')).toBe(false);
});

test('readErrorDescription returns the raw text on a non-JSON HTTP error, null on a non-JSON 2xx', async () => {
  const { readErrorDescription } = await import('../features/transport/telegram');
  expect(await readErrorDescription(resp(false, '<html>502 Bad Gateway</html>'))).toBe('<html>502 Bad Gateway</html>');
  expect(await readErrorDescription(resp(true, 'not json but 2xx'))).toBeNull();
});

// --- session-resolved topic (tg-cli#467, spec §4.5): retry once, then General, then stay there ---
// A fetch stub whose thread-carrying sends are rejected `rejections` times (JSON or multipart),
// recording whether each send carried the thread.
function installCountingRejectFetch(rejections: number, description = 'Bad Request: message thread not found'): Array<{ threaded: boolean; form: boolean }> {
  const sent: Array<{ threaded: boolean; form: boolean }> = [];
  let left = rejections;
  let nextId = 300;
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    const body = init?.body;
    const form = body instanceof FormData;
    const threaded = body instanceof FormData ? body.has('message_thread_id') : 'message_thread_id' in JSON.parse(String(body));
    sent.push({ threaded, form });
    if (threaded && left > 0) {
      left--;
      return mockResponse(false, { ok: false, description });
    }
    return mockResponse(true, { ok: true, result: { message_id: nextId++ } });
  }) as unknown as typeof fetch;
  return sent;
}

test('a resolved topic that rejects once is retried after the delay and stays threaded', async () => {
  const sent = installCountingRejectFetch(1);
  const fallbacks: string[] = [];
  const t = createTelegramTransport({
    ...CTX,
    messageThreadId: 5,
    threadIdAdvisory: true,
    threadRetryDelayMs: 1,
    onThreadFallback: (d) => void fallbacks.push(d),
  });
  await t.sendMessage('first send into a fresh private topic', 'plain');
  expect(sent).toEqual([
    { threaded: true, form: false },
    { threaded: true, form: false },
  ]);
  expect(fallbacks).toEqual([]);
});

test('a resolved topic rejected twice lands in General, reports the fallback once, and later parts skip the topic', async () => {
  const sent = installCountingRejectFetch(2);
  const fallbacks: string[] = [];
  const t = createTelegramTransport({
    ...CTX,
    messageThreadId: 5,
    threadIdAdvisory: true,
    threadRetryDelayMs: 1,
    onThreadFallback: (d) => void fallbacks.push(d),
  });
  await t.sendMessage('part 1', 'plain');
  await t.sendMessage('part 2', 'plain');
  expect(sent).toEqual([
    { threaded: true, form: false },
    { threaded: true, form: false },
    { threaded: false, form: false },
    { threaded: false, form: false },
  ]);
  expect(fallbacks).toEqual(['Bad Request: message thread not found']);
});

test('a deleted resolved topic (TOPIC_ID_INVALID) lands in General at once, without the retry', async () => {
  const sent = installCountingRejectFetch(2, 'Bad Request: TOPIC_ID_INVALID');
  const fallbacks: string[] = [];
  const t = createTelegramTransport({
    ...CTX,
    messageThreadId: 5,
    threadIdAdvisory: true,
    threadRetryDelayMs: 1,
    onThreadFallback: (d) => void fallbacks.push(d),
  });
  await t.sendMessage('into a deleted topic', 'plain');
  expect(sent).toEqual([
    { threaded: true, form: false },
    { threaded: false, form: false },
  ]);
  expect(fallbacks).toEqual(['Bad Request: TOPIC_ID_INVALID']);
});

test('an advisory thread rejection on a photo upload falls back to General instead of failing the send', async () => {
  const sent = installCountingRejectFetch(1);
  const fallbacks: string[] = [];
  const t = createTelegramTransport({ ...CTX, messageThreadId: 5, threadIdAdvisory: true, onThreadFallback: (d) => void fallbacks.push(d) });
  await t.sendPhoto(memItem('a.png'), 'cap', 'plain');
  await t.sendMediaGroup('photo', [memItem('a.png'), memItem('b.png')], 'cap', 'plain');
  expect(sent).toEqual([
    { threaded: true, form: true },
    { threaded: false, form: true },
    { threaded: false, form: true },
  ]);
  expect(fallbacks).toHaveLength(1);
});
