import { expect, test } from 'bun:test';
import { createTelegramTransport, TelegramSendError } from '../features/transport/telegram';

// Transport-level tests for the new sendRichMessage call (the riskiest
// integration boundary). They stub globalThis.fetch and assert the exact
// outbound request shape, route recording, reply_parameters consumption, and
// the local limit-validation failure path. No real network.

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

// Stub fetch to capture the request and return a canned Message. Returns the
// capture array + a restore thunk.
function stubFetch(result: unknown = { message_id: 99 }): {
  calls: Captured[];
  restore: () => void;
} {
  const calls: Captured[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(url), body });
    return { ok: true, json: async () => ({ ok: true, result }) } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = orig) };
}

test('sendRich POSTs /sendRichMessage with rich_message.html (no parse_mode/text)', async () => {
  const { calls, restore } = stubFetch();
  const recorded: number[] = [];
  try {
    const t = createTelegramTransport({
      api: 'https://example.invalid/botTEST',
      chatId: '42',
      recordRoute: (id) => recorded.push(id),
    });
    const html = '<h1>R</h1><table><tr><td>a</td></tr></table>';
    await t.sendRich(html);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith('/sendRichMessage');
    expect(calls[0].body.chat_id).toBe('42');
    expect(calls[0].body.rich_message).toEqual({ html });
    // It is NOT the basic sendMessage shape.
    expect(calls[0].body.parse_mode).toBeUndefined();
    expect(calls[0].body.text).toBeUndefined();
    // The returned message id was recorded as a route.
    expect(recorded).toEqual([99]);
  } finally {
    restore();
  }
});

test('sendRich threads via reply_parameters and consumes the anchor once', async () => {
  const { calls, restore } = stubFetch();
  try {
    const t = createTelegramTransport({
      api: 'https://example.invalid/botTEST',
      chatId: '42',
      recordRoute: () => {},
      replyToMessageId: 1234,
    });
    await t.sendRich('<h1>first</h1>');
    await t.sendRich('<h1>second</h1>');

    // The FIRST rich send threads under the anchor; the second does not (the
    // anchor is consumed — no re-reply).
    expect(calls[0].body.reply_parameters).toEqual({ message_id: 1234 });
    expect(calls[1].body.reply_parameters).toBeUndefined();
    // sendRichMessage uses reply_parameters, NOT reply_to_message_id.
    expect(calls[0].body.reply_to_message_id).toBeUndefined();
  } finally {
    restore();
  }
});

test('sendRich rejects an over-limit body locally (no fetch; fails the send with a TelegramSendError)', async () => {
  const { calls, restore } = stubFetch();
  try {
    const t = createTelegramTransport({
      api: 'https://example.invalid/botTEST',
      chatId: '42',
      recordRoute: () => {},
    });
    // 21 columns in one row → over the 20-column limit → local rejection.
    const over = '<table><tr>' + '<td>c</td>'.repeat(21) + '</tr></table>';
    await expect(t.sendRich(over)).rejects.toThrow(TelegramSendError);
    // It failed BEFORE hitting the network.
    expect(calls).toHaveLength(0);
  } finally {
    restore();
  }
});
