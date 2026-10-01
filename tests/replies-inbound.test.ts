import { expect, test } from 'bun:test';
import { inboundHistoryRecords } from '../features/replies/inbound';
import { isAgentCommand } from '../features/tg-ctl/agent-match';
import type { TgMessage, TgUpdate } from '../features/tg-ctl/types';

const ALLOWED = 555;

const msg = (over: Record<string, unknown>): TgUpdate => ({
  update_id: 1,
  message: {
    message_id: 100,
    chat: { id: ALLOWED },
    date: 1700000000,
    from: { id: ALLOWED, first_name: 'Alex' },
    ...over,
  },
});

const opts = { chatId: ALLOWED, allowedSenders: [] as number[], pane: '%3' as string | null };

test('inboundHistoryRecords: one user record per text message, UNWRAPPED text + pane', () => {
  const recs = inboundHistoryRecords([msg({ text: 'do the thing' })], opts);
  expect(recs).toEqual([
    {
      ts: 1700000000,
      message_id: 100,
      chat_id: ALLOWED,
      direction: 'user',
      from: 'Alex',
      text: 'do the thing',
      pane: '%3',
      threadId: null,
    },
  ]);
});

test('inboundHistoryRecords: captures the caption of a photo/document', () => {
  const recs = inboundHistoryRecords([msg({ photo: [{ file_id: 'x' }], caption: 'a screenshot' })], opts);
  expect(recs.length).toBe(1);
  expect(recs[0].text).toBe('a screenshot');
  expect(recs[0].direction).toBe('user');
});

test('inboundHistoryRecords: a media item with no caption records a placeholder', () => {
  const recs = inboundHistoryRecords([msg({ document: { file_id: 'd' } })], opts);
  expect(recs.length).toBe(1);
  expect(recs[0].text).toBe('[document]');
});

test('inboundHistoryRecords: a voice note records a [voice] placeholder (transcript is async)', () => {
  const recs = inboundHistoryRecords([msg({ voice: { file_id: 'v' } })], opts);
  expect(recs.length).toBe(1);
  expect(recs[0].text).toBe('[voice]');
});

test('inboundHistoryRecords: skips disallowed senders (a group member must not be logged)', () => {
  const intruder = msg({ text: 'hi' });
  intruder.message!.from = { id: 999, first_name: 'Eve' };
  expect(inboundHistoryRecords([intruder], opts)).toEqual([]);
});

test('inboundHistoryRecords: allowedSenders extends who is logged', () => {
  const extra = msg({ text: 'allowed extra' });
  extra.message!.from = { id: 42, first_name: 'Bot' };
  const recs = inboundHistoryRecords([extra], { ...opts, allowedSenders: [42] });
  expect(recs.length).toBe(1);
  expect(recs[0].from).toBe('Bot');
});

test('inboundHistoryRecords: ignores callback queries + non-message updates', () => {
  const cb: TgUpdate = { update_id: 2, callback_query: { id: 'c', from: { id: ALLOWED }, data: 'x' } };
  expect(inboundHistoryRecords([cb], opts)).toEqual([]);
});

test('inboundHistoryRecords: a reply carries the replied-to text? No — only its own body is logged', () => {
  const reply = msg({
    text: 'yes do it',
    reply_to_message: { message_id: 50, chat: { id: ALLOWED }, date: 1, text: 'should I deploy?' },
  });
  const recs = inboundHistoryRecords([reply], opts);
  expect(recs.length).toBe(1);
  expect(recs[0].text).toBe('yes do it');
});

test('inboundHistoryRecords: falls back to username then "tg" for the display name', () => {
  const u = msg({ text: 'a' });
  u.message!.from = { id: ALLOWED, username: 'ult' };
  expect(inboundHistoryRecords([u], opts)[0].from).toBe('ult');
});

test('inboundHistoryRecords: pane=null is preserved (logged outside a known pane)', () => {
  const recs = inboundHistoryRecords([msg({ text: 'hi' })], { ...opts, pane: null });
  expect(recs[0].pane).toBeNull();
});

test('inboundHistoryRecords: keeps old owner messages so tg replies can recover them after downtime (#183)', () => {
  // Owner inbound is no longer dropped by age — recall keeps every allowed
  // message Telegram delivered, mirroring stepUpdates.
  const old = msg({ text: 'ancient' }); // date 1700000000
  const recs = inboundHistoryRecords([old], {
    ...opts,
    nowSec: 1700000000 + 1000, // 1000s later — legacy staleness would have dropped it
    stalenessSec: 300,
  });
  expect(recs.length).toBe(1);
  expect(recs[0].text).toContain('ancient');
});

test('inboundHistoryRecords: keeps fresh messages', () => {
  const fresh = msg({ text: 'just now' });
  const recs = inboundHistoryRecords([fresh], {
    ...opts,
    nowSec: 1700000000 + 100,
    stalenessSec: 300,
  });
  expect(recs.length).toBe(1);
});

test('inboundHistoryRecords: resolvePane overrides the default pane PER message (reply → origin pane)', () => {
  const reply = msg({
    message_id: 200,
    text: 'yes',
    reply_to_message: { message_id: 50, chat: { id: ALLOWED }, date: 1, text: 'deploy?' },
  });
  const plain = msg({ message_id: 201, text: 'and status' });
  const recs = inboundHistoryRecords([reply, plain], {
    ...opts,
    pane: '%default',
    // The daemon resolves a reply to its recognized origin pane; a plain message
    // falls back to the default target (null → use opts.pane).
    resolvePane: (m) => (m.reply_to_message ? '%origin' : null),
  });
  expect(recs.map((r) => [r.message_id, r.pane])).toEqual([
    [200, '%origin'],
    [201, '%default'],
  ]);
});

test('inboundHistoryRecords: resolvePane returning null falls back to opts.pane', () => {
  const recs = inboundHistoryRecords([msg({ text: 'hi' })], {
    ...opts,
    pane: '%fallback',
    resolvePane: () => null,
  });
  expect(recs[0].pane).toBe('%fallback');
});

test('inboundHistoryRecords: a media reply is stamped under the routed origin pane', () => {
  const photoReply = msg({
    photo: [{ file_id: 'p' }],
    caption: 'see this',
    reply_to_message: { message_id: 50, chat: { id: ALLOWED }, date: 1, text: 'which one?' },
  });
  const textReply = msg({
    message_id: 201,
    text: 'this one',
    reply_to_message: { message_id: 50, chat: { id: ALLOWED }, date: 1, text: 'which one?' },
  });
  const resolvePane = (m: TgMessage): string | null =>
    m.reply_to_message &&
    ((m.text !== undefined && !m.text.startsWith('/')) ||
      (m.photo !== undefined && !isAgentCommand(m.caption ?? '')) ||
      (m.document !== undefined && !isAgentCommand(m.caption ?? '')) ||
      m.voice !== undefined ||
      m.audio !== undefined)
      ? '%origin'
      : null;
  const recs = inboundHistoryRecords([photoReply, textReply], { ...opts, pane: '%default', resolvePane });
  expect(recs.map((r) => r.pane)).toEqual(['%origin', '%origin']);
});

test('inboundHistoryRecords: a `!shell` text reply IS stamped under the routed origin (codex #192)', () => {
  // A `!` reply now reply-routes to its replied-to origin pane (updates.ts) — it
  // keeps its raw `!…` text but is DELIVERED to that pane, so its `tg replies`
  // history must be stamped there too, like prose/photo/voice replies. Otherwise
  // scoped recall shows the command in the wrong (default) pane. The predicate
  // mirrors the daemon: a text reply routes iff it is not a `/command`.
  const bangReply = msg({
    message_id: 202,
    text: '!git status',
    reply_to_message: { message_id: 50, chat: { id: ALLOWED }, date: 1, text: 'which one?' },
  });
  const resolvePane = (m: TgMessage): string | null =>
    m.reply_to_message &&
    ((m.text !== undefined && !m.text.startsWith('/')) ||
      (m.photo !== undefined && !isAgentCommand(m.caption ?? '')) ||
      (m.document !== undefined && !isAgentCommand(m.caption ?? '')) ||
      m.voice !== undefined ||
      m.audio !== undefined)
      ? '%origin'
      : null;
  const recs = inboundHistoryRecords([bangReply], { ...opts, pane: '%default', resolvePane });
  expect(recs.map((r) => r.pane)).toEqual(['%origin']);
});

test('inboundHistoryRecords: a media reply with /agent caption is not stamped under the replied-to origin', () => {
  const explicitAgentPhotoReply = msg({
    photo: [{ file_id: 'p' }],
    caption: '/agent ext\nlook at this route error',
    reply_to_message: { message_id: 50, chat: { id: ALLOWED }, date: 1, text: 'origin pane report' },
  });
  const resolvePane = (m: TgMessage): string | null =>
    m.reply_to_message &&
    ((m.text !== undefined && !m.text.startsWith('/')) ||
      (m.photo !== undefined && !isAgentCommand(m.caption ?? '')) ||
      (m.document !== undefined && !isAgentCommand(m.caption ?? '')) ||
      m.voice !== undefined ||
      m.audio !== undefined)
      ? '%origin'
      : null;
  const recs = inboundHistoryRecords([explicitAgentPhotoReply], { ...opts, pane: '%default', resolvePane });
  expect(recs.map((r) => r.pane)).toEqual(['%default']);
});
