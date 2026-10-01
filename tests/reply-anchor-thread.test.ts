import { expect, test } from 'bun:test';
import { parseHistory, serializeHistoryRecord, threadOfMessageInBlob, type HistoryRecord } from '../features/replies/history';
import { inboundHistoryRecords } from '../features/replies/inbound';
import { buildOutboundHistoryRecords } from '../features/replies/outbound';
import type { TgUpdate } from '../features/tg-ctl/types';

// Where a message sits in a forum chat is recorded on its history row (tg-cli#551): `tg --reply-to
// <id>` reads it to post the answer into the topic of the message it answers — Telegram does not
// infer the topic from the reply anchor in a private chat with topics.

const CHAT = 5153477378;

const row = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1,
  message_id: 100,
  chat_id: CHAT,
  direction: 'user',
  from: 'Alex',
  text: 'hi',
  pane: null,
  ...over,
});

const blob = (...rows: HistoryRecord[]): string => rows.map(serializeHistoryRecord).join('\n') + '\n';

test('threadId survives a serialize/parse round trip: a topic id, null (General), or absent (legacy row)', () => {
  const parsed = parseHistory(blob(row({ message_id: 1, threadId: 192230 }), row({ message_id: 2, threadId: null }), row({ message_id: 3 })));
  expect(parsed.map((r) => r.threadId)).toEqual([192230, null, undefined]);
});

test('a malformed threadId is dropped as unknown, never trusted', () => {
  const lines = [{ message_id: 1, threadId: 'x' }, { message_id: 2, threadId: -4 }, { message_id: 3, threadId: 1.5 }].map((over) => JSON.stringify(row(over as Partial<HistoryRecord>)));
  expect(parseHistory(lines.join('\n')).map((r) => r.threadId)).toEqual([undefined, undefined, undefined]);
});

test('threadOfMessageInBlob: a topic row answers its topic id, a General row null, an unrecorded or legacy row undefined', () => {
  const raw = blob(row({ message_id: 19000, threadId: 192230 }), row({ message_id: 19010, threadId: null }), row({ message_id: 18000 }));
  expect(threadOfMessageInBlob(raw, CHAT, 19000)).toBe(192230);
  expect(threadOfMessageInBlob(raw, CHAT, 19010)).toBeNull();
  expect(threadOfMessageInBlob(raw, CHAT, 18000)).toBeUndefined();
  expect(threadOfMessageInBlob(raw, CHAT, 777)).toBeUndefined();
  expect(threadOfMessageInBlob(null, CHAT, 19000)).toBeUndefined();
});

test('threadOfMessageInBlob: another chat\'s row with the same message id is not this message', () => {
  const raw = blob(row({ message_id: 5, chat_id: -100999, threadId: 42 }));
  expect(threadOfMessageInBlob(raw, CHAT, 5)).toBeUndefined();
  expect(threadOfMessageInBlob(raw, -100999, 5)).toBe(42);
});

test('threadOfMessageInBlob: a newer legacy row without chat_id never shadows the exact chat row', () => {
  const legacy = { ts: 1, message_id: 5, direction: 'user', from: 'Alex', text: 'old', pane: null };
  const raw = `${serializeHistoryRecord(row({ message_id: 5, threadId: 42 }))}\n${JSON.stringify(legacy)}\n`;
  expect(threadOfMessageInBlob(raw, CHAT, 5)).toBe(42);
  expect(threadOfMessageInBlob(JSON.stringify(legacy), CHAT, 5)).toBeUndefined();
});

test('threadOfMessageInBlob: a message text that merely contains the id digits does not match another message', () => {
  const raw = blob(row({ message_id: 7, text: 'see "message_id":19000 here', threadId: 9 }));
  expect(threadOfMessageInBlob(raw, CHAT, 19000)).toBeUndefined();
});

test('threadOfMessageInBlob: the latest row for an id wins', () => {
  const raw = blob(row({ message_id: 5, threadId: null }), row({ message_id: 5, threadId: 8 }));
  expect(threadOfMessageInBlob(raw, CHAT, 5)).toBe(8);
});

const inbound = (over: Record<string, unknown>): TgUpdate => ({
  update_id: 1,
  message: { message_id: 19000, chat: { id: CHAT }, date: 1700000000, from: { id: CHAT, first_name: 'Alex' }, text: 'Какой статус?', ...over },
});
const opts = { chatId: CHAT, allowedSenders: [] as number[], pane: null };

test('inbound history: a message inside a topic records that topic id; a General message records null', () => {
  const [inTopic] = inboundHistoryRecords([inbound({ message_thread_id: 192230, is_topic_message: true })], opts);
  expect(inTopic.threadId).toBe(192230);
  const [inGeneral] = inboundHistoryRecords([inbound({})], opts);
  expect(inGeneral.threadId).toBeNull();
});

test('inbound history: a non-forum reply thread (message_thread_id without is_topic_message) is General, not a topic', () => {
  const [rec] = inboundHistoryRecords([inbound({ message_thread_id: 55 })], opts);
  expect(rec.threadId).toBeNull();
});

test('outbound history: every record carries the thread ITS message was posted into, so a late fallback does not relabel earlier chunks', () => {
  const threads = new Map<number, number | null>([[1, 192230], [2, null]]);
  const recs = buildOutboundHistoryRecords([1, 2, 3], 'x', 1, '%1', 'g', CHAT, undefined, undefined, threads);
  expect(recs.map((r) => r.threadId)).toEqual([192230, null, undefined]);
  const unspecified = buildOutboundHistoryRecords([4], 'x', 1, '%1', 'g', CHAT);
  expect('threadId' in unspecified[0]).toBe(false);
});

// A message inside a topic belongs to the topic's session, never to the flat chat's default target
// and never to a reply-route guess (tg-cli#551): its history row feeds that session's `tg replies`.

const topicMsg = (over: Record<string, unknown> = {}): TgUpdate => inbound({ message_thread_id: 192230, is_topic_message: true, ...over });
const SESSION = { pane: '%14', agent: 'omp-rotate-fix', sessionKey: 'cc:pane:11819/%14/10594' };

test('inbound history: a topic message is stamped with the topic\'s session, not the flat default pane', () => {
  const [rec] = inboundHistoryRecords([topicMsg()], {
    ...opts,
    pane: '%2',
    resolveAgent: () => 'flat-agent',
    resolveSession: () => 'omp:flat',
    resolveTopic: (threadId) => (threadId === 192230 ? SESSION : null),
  });
  expect(rec.pane).toBe('%14');
  expect(rec.targetAgent).toBe('omp-rotate-fix');
  expect(rec.sessionKey).toBe('cc:pane:11819/%14/10594');
  expect(rec.threadId).toBe(192230);
});

test('inbound history: a message in a topic nobody owns is stamped with no pane at all, not the default target', () => {
  const [rec] = inboundHistoryRecords([topicMsg()], { ...opts, pane: '%2', resolveAgent: () => 'flat-agent', resolveSession: () => 'omp:flat', resolveTopic: () => null });
  expect(rec.pane).toBeNull();
  expect(rec.targetAgent).toBeUndefined();
  expect(rec.sessionKey).toBeUndefined();
});

test('inbound history: a reply inside a topic is not stamped by the flat reply-route recognition', () => {
  const [rec] = inboundHistoryRecords([topicMsg({ reply_to_message: { message_id: 18913 } })], {
    ...opts,
    resolvePane: () => '%99',
    resolveTopic: () => SESSION,
  });
  expect(rec.pane).toBe('%14');
});

test('inbound history: a session in no pane (an omp outside tmux) is stamped by key and name alone', () => {
  const [rec] = inboundHistoryRecords([topicMsg()], { ...opts, resolveTopic: () => ({ pane: null, agent: 'cross-stitch', sessionKey: 'omp:abc' }) });
  expect(rec.pane).toBeNull();
  expect(rec.targetAgent).toBe('cross-stitch');
  expect(rec.sessionKey).toBe('omp:abc');
});

test('inbound history: a General message keeps the flat stamping', () => {
  const [rec] = inboundHistoryRecords([inbound({})], { ...opts, pane: '%2', resolveAgent: () => 'flat-agent', resolveTopic: () => SESSION });
  expect(rec.pane).toBe('%2');
  expect(rec.targetAgent).toBe('flat-agent');
});

test('inbound history: a topic service message (created / renamed / closed) is not a user row', () => {
  const service = [{ forum_topic_created: { name: 'x' } }, { forum_topic_edited: { name: 'y' } }, { forum_topic_closed: {} }, { forum_topic_reopened: {} }];
  for (const s of service) {
    expect(inboundHistoryRecords([inbound({ text: undefined, message_thread_id: 5, is_topic_message: true, ...s })], opts)).toEqual([]);
  }
});

test('inbound history: with topics mode off (no resolveTopic) a topic message is stamped like any flat message', () => {
  const [rec] = inboundHistoryRecords([topicMsg()], { ...opts, pane: '%2', resolveAgent: () => 'flat-agent' });
  expect(rec.pane).toBe('%2');
  expect(rec.targetAgent).toBe('flat-agent');
});
