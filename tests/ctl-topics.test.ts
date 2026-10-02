import { expect, test } from 'bun:test';
import { stepUpdates } from '../features/tg-ctl/updates';
import {
  DEFAULT_CONTROL,
  type ControlConfig,
  type TgMessage,
  type TgUpdate,
  type TopicBinding,
  type TopicStatus,
} from '../features/tg-ctl/types';
import {
  appendTopic,
  applyModelAnswer,
  applyPathAnswer,
  buildModelKeyboard,
  buildPathKeyboard,
  buildRespawnKeyboard,
  createTopic,
  findTopic,
  isAwaitingAnswer,
  clearSpawnPending,
  markBound,
  markClosed,
  markRenamed,
  markReopened,
  markRespawnOffered,
  markSpawnPending,
  MAX_PATH_CHOICES,
  MAX_TOPICS,
  parseTopics,
  parseTopicModelCallback,
  parseTopicPathCallback,
  parseTopicRespawnCallback,
  recentPathChoices,
  serializeTopics,
  slugifyTopicName,
} from '../features/tg-ctl/topics';
import { DEFAULT_MODEL_ID, findModel, MODEL_CATALOG, spawnArgv } from '../features/tg-ctl/models';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const wrap = (name: string, msg: string, id?: number) => `[TG from ${name}${id ? ` #${id}` : ''}] ${msg}`;

function makeOpts(
  over: Partial<{
    topicsEnabled: boolean;
    topicCreateFlowEnabled: boolean;
    topicStatusOf: (t: number) => TopicStatus | null;
    cfg: ControlConfig;
  }> = {},
) {
  return {
    cfg: { ...DEFAULT_CONTROL, ...(over.cfg ?? {}) },
    chatId: CHAT_ID,
    nowSec: NOW,
    currentOffset: 5,
    wrap,
    topicsEnabled: over.topicsEnabled ?? false,
    topicCreateFlowEnabled: over.topicCreateFlowEnabled,
    topicStatusOf: over.topicStatusOf,
  };
}

function upd(id: number, msg: Partial<TgMessage>): TgUpdate {
  return {
    update_id: id,
    message: { message_id: id, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW, ...msg },
  };
}

// --- model catalog ---

test('model catalog: default is first, findModel + spawnArgv resolve', () => {
  expect(MODEL_CATALOG[0].id).toBe(DEFAULT_MODEL_ID);
  expect(findModel('claude-opus')?.kind).toBe('claude');
  expect(findModel('nope')).toBeNull();
  expect(spawnArgv('claude-opus', '/x')).toEqual(['claude', '--model', 'opus']);
  expect(spawnArgv('claude-default', '/x')).toEqual(['claude']);
  expect(spawnArgv('nope', '/x')).toBeNull();
});

test('spawnArgv keeps a spaced path as a single argv element (no shell split)', () => {
  // path is not part of the claude argv today, but the builder must never split it
  // — assert the builder is called with the path intact and returns a clean argv.
  expect(spawnArgv('claude-default', '/a b/c')).toEqual(['claude']);
});

// --- store ---

test('topics store: round-trips and upserts by threadId', () => {
  const a: TopicBinding = { threadId: 10, name: 'api', status: 'awaiting-path', ts: 1 };
  const b: TopicBinding = { threadId: 20, name: 'web', status: 'bound', paneId: '%3', path: '/w', model: 'claude-opus', ts: 2 };
  let topics = appendTopic(appendTopic([], a), b);
  expect(findTopic(topics, 10)).toEqual(a);
  expect(findTopic(topics, 20)?.paneId).toBe('%3');
  // upsert: same threadId replaces, not duplicates
  topics = appendTopic(topics, { ...a, status: 'bound', paneId: '%9', ts: 3 });
  expect(topics.filter((t) => t.threadId === 10)).toHaveLength(1);
  expect(findTopic(topics, 10)?.paneId).toBe('%9');
  // serialize → parse round-trip
  expect(parseTopics(serializeTopics(topics))).toEqual(topics);
});

test('topics store: parse rejects junk + non-array, keeps valid', () => {
  expect(parseTopics(null)).toEqual([]);
  expect(parseTopics('not json')).toEqual([]);
  expect(parseTopics('{"threadId":1}')).toEqual([]); // not an array
  expect(parseTopics('[{"threadId":"x","status":"bound"},{"threadId":5,"status":"nope"},{"threadId":7,"name":"ok","status":"bound","paneId":"%2","ts":9}]'))
    .toEqual([{ threadId: 7, name: 'ok', status: 'bound', path: undefined, model: undefined, paneId: '%2', ts: 9 }]);
});

test('topics store: parse drops a bound binding with no paneId, and a NaN ts → 0', () => {
  // bound-without-pane would route into nothing → dropped (re-binds on next message)
  expect(parseTopics('[{"threadId":7,"name":"x","status":"bound","ts":1}]')).toEqual([]);
  // a NaN ts (typeof NaN === 'number') must not slip through — normalized to 0
  expect(parseTopics('[{"threadId":7,"name":"x","status":"awaiting-path","ts":null}]')[0]?.ts).toBe(0);
});

test('topics store: caps at MAX_TOPICS keeping the newest', () => {
  let topics: TopicBinding[] = [];
  for (let i = 0; i < MAX_TOPICS + 5; i++) topics = appendTopic(topics, { threadId: i, name: `t${i}`, status: 'bound', ts: i });
  expect(topics).toHaveLength(MAX_TOPICS);
  expect(findTopic(topics, 0)).toBeNull(); // oldest dropped
  expect(findTopic(topics, MAX_TOPICS + 4)?.name).toBe(`t${MAX_TOPICS + 4}`);
});

// --- lifecycle transitions ---

test('lifecycle: create → path → model → bound', () => {
  const created = createTopic(42, 'My Repo', 100);
  expect(created).toEqual({ threadId: 42, name: 'My Repo', status: 'awaiting-path', ts: 100 });
  expect(isAwaitingAnswer(created)).toBe(true);

  const withPath = applyPathAnswer(created, '/Users/me/repo', 101);
  expect(withPath.status).toBe('awaiting-model');
  expect(withPath.path).toBe('/Users/me/repo');

  const withModel = applyModelAnswer(withPath, 'claude-opus', 102);
  expect(withModel?.model).toBe('claude-opus');
  expect(withModel?.status).toBe('awaiting-model'); // stays until spawn succeeds

  const bound = markBound(withModel!, '%7', 103);
  expect(bound.status).toBe('bound');
  expect(bound.paneId).toBe('%7');
  expect(isAwaitingAnswer(bound)).toBe(false);
});

test('lifecycle: an invalid model id is rejected (re-ask), valid keeps the path', () => {
  const withPath = applyPathAnswer(createTopic(1, 'x', 1), '/p', 2);
  expect(applyModelAnswer(withPath, 'bogus', 3)).toBeNull();
  expect(applyModelAnswer(withPath, 'claude-sonnet', 3)?.path).toBe('/p'); // path preserved
});

test('lifecycle: close, then reopen resumes at awaiting-model when a path is known', () => {
  const bound = markBound(applyModelAnswer(applyPathAnswer(createTopic(1, 'x', 1), '/p', 2), 'claude-opus', 3)!, '%2', 4);
  const closed = markClosed(bound, 5);
  expect(closed.status).toBe('closed');
  const reopened = markReopened(closed, 6);
  expect(reopened.status).toBe('awaiting-model'); // path known → re-pick model
  expect(reopened.paneId).toBeUndefined(); // old pane dropped
  // a topic reopened with no path restarts at awaiting-path
  expect(markReopened(createTopic(2, 'y', 1), 7).status).toBe('awaiting-path');
});

test('slugifyTopicName: safe tmux window name, fallback to threadId', () => {
  expect(slugifyTopicName('My API Bot!', 5)).toBe('my-api-bot');
  expect(slugifyTopicName('Апи Бот', 5)).toBe('api-bot'); // Cyrillic transliterated, not collapsed to topic-5
  expect(slugifyTopicName('Ревью', 7)).toBe('revyu');
  expect(slugifyTopicName('🔥🔥', 9)).toBe('topic-9'); // emoji-only → fallback (unmapped)
  expect(slugifyTopicName('  ---  ', 5)).toBe('topic-5');
  expect(slugifyTopicName('a'.repeat(40), 5)).toHaveLength(24);
  // the length cap must not re-expose a trailing dash (trim runs AFTER slice)
  expect(slugifyTopicName(`${'a'.repeat(23)} b`, 5)).toBe('a'.repeat(23));
});

// --- stepUpdates topic routing ---

test('topics OFF: a topic message falls through to normal flat injection (unchanged behaviour)', () => {
  const r = stepUpdates([upd(1, { text: 'hi', message_thread_id: 99 })], makeOpts({ topicsEnabled: false }));
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #1] hi', messageId: 1 },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('topics ON: forum_topic_created → topic-new + ack', () => {
  const r = stepUpdates(
    [upd(50, { message_thread_id: 50, forum_topic_created: { name: 'feature-x' } })],
    makeOpts({ topicsEnabled: true }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-new', threadId: 50, name: 'feature-x', from: 'Alex' },
    { kind: 'ack', messageId: 50 },
  ]);
});

test('private-topic routing mode: untracked forum_topic_created is acked, not started as a forum flow', () => {
  const r = stepUpdates(
    [upd(52, { message_thread_id: 52, forum_topic_created: { name: 'private-echo' } })],
    makeOpts({ topicsEnabled: true, topicCreateFlowEnabled: false, topicStatusOf: () => null }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 52 }]);
});

test('private-topic routing mode: tracked forum_topic_created echo is swallowed', () => {
  const r = stepUpdates(
    [upd(53, { message_thread_id: 53, forum_topic_created: { name: 'private-echo' } })],
    makeOpts({ topicsEnabled: true, topicCreateFlowEnabled: false, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 53 }]);
});

test('private-topic routing mode: untracked topic prose falls through to flat injection', () => {
  const r = stepUpdates(
    [upd(54, { text: 'legacy forum text', message_thread_id: 54, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicCreateFlowEnabled: false, topicStatusOf: () => null }),
  );
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #54] legacy forum text', messageId: 54 },
    { kind: 'ack', messageId: 54 },
  ]);
});

test('topics ON: prose in a BOUND topic → topic-route with wrapped text', () => {
  const r = stepUpdates(
    [upd(7, { text: 'deploy now', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: (t) => (t === 50 ? 'bound' : null) }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-route', threadId: 50, injectText: '[TG from Alex #7] deploy now', from: 'Alex', messageId: 7 },
    { kind: 'ack', messageId: 7 },
  ]);
});

test('topics ON: a slash-command in a BOUND topic injects VERBATIM (reaches the agent)', () => {
  const r = stepUpdates(
    [upd(11, { text: '/compact', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, injectText: '/compact', from: 'Alex', messageId: 11 });
});

test('topics ON: media (no text) in a BOUND topic is ACKED only — never leaks to a flat agent', () => {
  const r = stepUpdates(
    [upd(12, { photo: [{ file_id: 'f' }], message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  // no inject-text / no download-media to a flat agent — just the ack (increment 2 routes topic media)
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 12 }]);
});

test('topics ON: a message in a CLOSED topic → topic-dead (offer re-spawn) — never leaks to a flat agent', () => {
  // increment 4: a message to a topic whose agent died emits topic-dead so the entrypoint offers
  // a one-tap re-spawn (the old behaviour was a silent ack-only dead-end). Still never leaks flat.
  const r = stepUpdates(
    [upd(13, { text: 'still here?', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-dead', threadId: 50, injectText: wrap('Alex', 'still here?', 13), messageId: 13 },
    { kind: 'ack', messageId: 13 },
  ]);
});

test('topics ON: a media-only message in a CLOSED topic → topic-dead with empty injectText', () => {
  const r = stepUpdates(
    [upd(14, { photo: [{ file_id: 'f' }], message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-dead', threadId: 50, injectText: '', messageId: 14 },
    { kind: 'ack', messageId: 14 },
  ]);
});

test('topics ON: a message in an AWAITING topic → topic-answer (raw text)', () => {
  const r = stepUpdates(
    [upd(8, { text: '/Users/me/api', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'awaiting-path' }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-answer', threadId: 50, text: '/Users/me/api', from: 'Alex', messageId: 8 },
    { kind: 'ack', messageId: 8 },
  ]);
});

test('topics ON: an UNTRACKED forum-topic message is ACKED only — never leaks to a flat agent / General', () => {
  const r = stepUpdates(
    [upd(9, { text: 'hello', message_thread_id: 77, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => null }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 9 }]);
});

test('topics ON: prose starting with / (a path) in a BOUND topic is WRAPPED, not a verbatim command', () => {
  const r = stepUpdates(
    [upd(14, { text: '/etc/hosts is broken', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  // wrapped (carries sender + #id for tg --reply-to), NOT injected verbatim as a command
  expect(r.actions[0]).toEqual({
    kind: 'topic-route',
    threadId: 50,
    injectText: '[TG from Alex #14] /etc/hosts is broken',
    from: 'Alex',
    messageId: 14,
  });
});

test('topics ON: a DUPLICATE forum_topic_created for an in-flight/bound topic does NOT reset it', () => {
  for (const st of ['bound', 'awaiting-path', 'awaiting-model'] as const) {
    const r = stepUpdates(
      [upd(50, { message_thread_id: 50, forum_topic_created: { name: 'dup' } })],
      makeOpts({ topicsEnabled: true, topicStatusOf: () => st }),
    );
    // no topic-new (would clobber the live binding) — just the ack
    expect(r.actions).toEqual([{ kind: 'ack', messageId: 50 }]);
  }
  // but a create for an untracked/closed topic DOES start the flow
  const fresh = stepUpdates(
    [upd(51, { message_thread_id: 51, forum_topic_created: { name: 'new' } })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => null }),
  );
  expect(fresh.actions[0]).toEqual({ kind: 'topic-new', threadId: 51, name: 'new', from: 'Alex' });
});

test('topics ON: a STALE topic message yields NO topic action (never leaks to a live agent)', () => {
  const stale: TgUpdate = {
    update_id: 20,
    message: { message_id: 20, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW - 9999, text: 'old', message_thread_id: 50, is_topic_message: true },
  };
  const r = stepUpdates([stale], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(1);
});

test('topics ON: a topic message from a NON-allowed sender yields NO topic action', () => {
  const intruder: TgUpdate = {
    update_id: 21,
    message: { message_id: 21, from: { id: 999, first_name: 'Mallory' }, chat: { id: CHAT_ID }, date: NOW, text: 'pwn', message_thread_id: 50, is_topic_message: true },
  };
  const r = stepUpdates([intruder], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions).toEqual([]);
});

test('topics ON but topicStatusOf undefined: service messages still route; a topic message falls to flat', () => {
  const opts = { ...makeOpts({ topicsEnabled: true }), topicStatusOf: undefined };
  const created = stepUpdates([upd(30, { message_thread_id: 30, forum_topic_created: { name: 'x' } })], opts);
  expect(created.actions[0]).toEqual({ kind: 'topic-new', threadId: 30, name: 'x', from: 'Alex' });
  // a regular forum-topic message with no lookup → status null → acked only (not leaked to flat)
  const msg = stepUpdates([upd(31, { text: 'hi', message_thread_id: 30, is_topic_message: true })], opts);
  expect(msg.actions).toEqual([{ kind: 'ack', messageId: 31 }]);
});

test('topics ON: forum_topic_created with no from → name defaults to "tg"', () => {
  const r = stepUpdates(
    [{ update_id: 40, message: { message_id: 40, chat: { id: CHAT_ID }, date: NOW, from: { id: CHAT_ID }, message_thread_id: 40, forum_topic_created: { name: 'z' } } }],
    makeOpts({ topicsEnabled: true }),
  );
  expect(r.actions[0]).toEqual({ kind: 'topic-new', threadId: 40, name: 'z', from: 'tg' });
});

test('topics ON: a non-forum reply-thread (thread id but NOT is_topic_message) falls through to flat', () => {
  // A supergroup reply thread carries message_thread_id but no is_topic_message; even if its id
  // collides with a tracked topic it must NOT be captured as a topic message.
  const r = stepUpdates(
    [upd(10, { text: 'reply thread msg', message_thread_id: 50 })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #10] reply thread msg', messageId: 10 },
    { kind: 'ack', messageId: 10 },
  ]);
});

test('topics ON: forum_topic_closed / reopened on a TRACKED topic → topic-close / topic-reopen + ack', () => {
  const tracked = makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' });
  const closed = stepUpdates([upd(1, { message_thread_id: 50, forum_topic_closed: {} })], tracked);
  expect(closed.actions).toEqual([{ kind: 'topic-close', threadId: 50 }, { kind: 'ack', messageId: 1 }]);
  const reopened = stepUpdates([upd(2, { message_thread_id: 50, forum_topic_reopened: {} })], tracked);
  expect(reopened.actions).toEqual([{ kind: 'topic-reopen', threadId: 50 }, { kind: 'ack', messageId: 2 }]);
});

test('topics ON: close/reopen on an UNTRACKED topic emits no topic action (just ack) — not ours', () => {
  const untracked = makeOpts({ topicsEnabled: true, topicStatusOf: () => null });
  const closed = stepUpdates([upd(3, { message_thread_id: 99, forum_topic_closed: {} })], untracked);
  expect(closed.actions).toEqual([{ kind: 'ack', messageId: 3 }]);
});

test('topics ON: forum_topic_edited (rename) with name → topic-rename + ack for a tracked topic — never leaks to flat', () => {
  // §11 deferral 3: a rename of a tracked topic emits topic-rename so the entrypoint can
  // persist the new name and update the tmux window slug.
  const r = stepUpdates(
    [upd(4, { message_thread_id: 50, forum_topic_edited: { name: 'renamed' } })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions).toEqual([{ kind: 'topic-rename', threadId: 50, name: 'renamed' }, { kind: 'ack', messageId: 4 }]);
});

test('topics ON: forum_topic_edited with no name (icon-only) is silently acked — never leaks to flat', () => {
  // An icon-only edit carries no name; nothing to persist, just ack.
  const r = stepUpdates(
    [upd(4, { message_thread_id: 50, forum_topic_edited: {} })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 4 }]);
});

test('topics ON: General (no message_thread_id) is unaffected', () => {
  const r = stepUpdates([upd(3, { text: 'plain' })], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #3] plain', messageId: 3 },
    { kind: 'ack', messageId: 3 },
  ]);
});

// --- model-pick button (the awaiting-model spawn step) ---

function cbUpd(id: number, data: string): TgUpdate {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: CHAT_ID, first_name: 'Alex' },
      message: { message_id: id, chat: { id: CHAT_ID }, date: NOW },
      data,
    },
  };
}

test('parseTopicModelCallback: parses tgm:<threadId>:<modelId>, rejects malformed', () => {
  expect(parseTopicModelCallback('tgm:50:claude-opus')).toEqual({ threadId: 50, modelId: 'claude-opus' });
  expect(parseTopicModelCallback('tgm:1:claude-default')).toEqual({ threadId: 1, modelId: 'claude-default' });
  expect(parseTopicModelCallback('tgm:0:claude-default')).toBeNull(); // a thread id is always >= 1
  expect(parseTopicModelCallback('tga:50:0')).toBeNull(); // wrong prefix (/agent picker)
  expect(parseTopicModelCallback('tgq:abc:o0')).toBeNull(); // wrong prefix (question)
  expect(parseTopicModelCallback('tgm:notanum:m')).toBeNull();
  expect(parseTopicModelCallback('tgm:50:')).toBeNull();
  expect(parseTopicModelCallback('tgm:50')).toBeNull();
  expect(parseTopicModelCallback('tgm::claude-opus')).toBeNull(); // empty threadId must NOT coerce to 0
  expect(parseTopicModelCallback('tgm:1e2:m')).toBeNull(); // Number() exotica rejected
  expect(parseTopicModelCallback('tgm:0x10:m')).toBeNull();
  expect(parseTopicModelCallback('tgm:-5:m')).toBeNull(); // a thread id is always positive
  expect(parseTopicModelCallback(undefined)).toBeNull();
});

test('buildModelKeyboard: one button per catalog model, callback carries threadId + id', () => {
  const kb = buildModelKeyboard(50, MODEL_CATALOG);
  expect(kb).toHaveLength(MODEL_CATALOG.length);
  expect(kb[0][0]).toEqual({ text: MODEL_CATALOG[0].label, callback_data: `tgm:50:${MODEL_CATALOG[0].id}` });
  // every row is a single button whose callback round-trips through the parser
  for (const row of kb) {
    expect(row).toHaveLength(1);
    expect(parseTopicModelCallback(row[0].callback_data)?.threadId).toBe(50);
  }
});

test('topics ON: a tgm: model tap emits a topic-model action (routed to the spawn flow)', () => {
  const r = stepUpdates([cbUpd(7, 'tgm:50:claude-opus')], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'awaiting-model' }));
  expect(r.actions).toEqual([
    {
      kind: 'topic-model',
      callbackQueryId: 'cb7',
      threadId: 50,
      modelId: 'claude-opus',
      messageId: 7,
    },
  ]);
});

test('topics OFF: a tgm: tap does NOT emit topic-model — falls through to the question parser (expired)', () => {
  const r = stepUpdates([cbUpd(8, 'tgm:50:claude-opus')], makeOpts({ topicsEnabled: false }));
  // With topics off the model tap is not recognized as a spawn action; it falls to the
  // button-callback parser which rejects the non-tgq data as an expired callback.
  expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb8', text: 'expired' }]);
});

// --- increment 4: recent-path buttons, path/respawn callbacks, pathChoices persistence ---

test('recentPathChoices: dedupes, keeps absolute existing dirs, preserves newest-first order', () => {
  const existing = new Set(['/a', '/b', '/c']);
  const isAbsDir = (p: string) => p.startsWith('/') && existing.has(p);
  // '/a' repeated, 'rel' relative, '/gone' not a dir → only /a,/b,/c survive, in first-seen order.
  const out = recentPathChoices(['/a', '/a', 'rel', '/gone', '/b', undefined, '', '/c'], isAbsDir);
  expect(out).toEqual(['/a', '/b', '/c']);
});

test('recentPathChoices: caps at MAX_PATH_CHOICES', () => {
  const candidates = Array.from({ length: MAX_PATH_CHOICES + 5 }, (_, i) => `/p${i}`);
  const out = recentPathChoices(candidates, () => true);
  expect(out).toHaveLength(MAX_PATH_CHOICES);
  expect(out[0]).toBe('/p0');
});

test('buildPathKeyboard: one button per choice, callback tgp:<threadId>:<index>:<nonce>', () => {
  expect(buildPathKeyboard(42, ['/x', '/y'], 7)).toEqual([
    [{ text: '/x', callback_data: 'tgp:42:0:7' }],
    [{ text: '/y', callback_data: 'tgp:42:1:7' }],
  ]);
});

test('buildPathKeyboard: empty choices → empty keyboard (free-text only)', () => {
  expect(buildPathKeyboard(42, [], 7)).toEqual([]);
});

test('parseTopicPathCallback: valid tgp:<thread>:<index>:<nonce> (index may be 0)', () => {
  expect(parseTopicPathCallback('tgp:42:0:99')).toEqual({ threadId: 42, index: 0, nonce: 99 });
  expect(parseTopicPathCallback('tgp:7:3:5')).toEqual({ threadId: 7, index: 3, nonce: 5 });
});

test('parseTopicPathCallback: rejects malformed / wrong-prefix / leading-zero index / negative / missing nonce', () => {
  expect(parseTopicPathCallback(undefined)).toBeNull();
  expect(parseTopicPathCallback('tgp:42')).toBeNull();
  expect(parseTopicPathCallback('tgp:42:0')).toBeNull(); // missing nonce (old 3-part shape)
  expect(parseTopicPathCallback('tgm:42:0:1')).toBeNull(); // model prefix
  expect(parseTopicPathCallback('tgp:0:1:1')).toBeNull(); // threadId must be >=1
  expect(parseTopicPathCallback('tgp:42:00:1')).toBeNull(); // leading-zero index
  expect(parseTopicPathCallback('tgp:42:-1:1')).toBeNull();
  expect(parseTopicPathCallback('tgp:42:x:1')).toBeNull();
  expect(parseTopicPathCallback('tgp:42:0:0')).toBeNull(); // nonce must be >=1
});

test('parseTopicRespawnCallback: valid tgr:<thread>, rejects malformed', () => {
  expect(parseTopicRespawnCallback('tgr:42')).toBe(42);
  expect(parseTopicRespawnCallback(undefined)).toBeNull();
  expect(parseTopicRespawnCallback('tgr:0')).toBeNull();
  expect(parseTopicRespawnCallback('tgr:42:extra')).toBeNull();
  expect(parseTopicRespawnCallback('tgm:42')).toBeNull();
});

test('buildRespawnKeyboard: one Re-spawn button carrying tgr:<threadId>', () => {
  expect(buildRespawnKeyboard(42)).toEqual([[{ text: 'Re-spawn the agent', callback_data: 'tgr:42' }]]);
});

test('parseTopics: preserves a clean pathChoices array; drops a malformed one', () => {
  const good = serializeTopics([
    { threadId: 1, name: 'a', status: 'awaiting-path', ts: 1, pathChoices: ['/p', '/q'] },
  ]);
  expect(parseTopics(good)[0].pathChoices).toEqual(['/p', '/q']);
  const bad = JSON.stringify([
    { threadId: 2, name: 'b', status: 'awaiting-path', ts: 1, pathChoices: ['/p', 5] },
  ]);
  expect(parseTopics(bad)[0].pathChoices).toBeUndefined();
});

test('applyPathAnswer: drops the now-stale pathChoices when advancing to awaiting-model', () => {
  const b: TopicBinding = { threadId: 1, name: 'a', status: 'awaiting-path', ts: 1, pathChoices: ['/p'] };
  const next = applyPathAnswer(b, '/chosen', 2);
  expect(next.status).toBe('awaiting-model');
  expect(next.path).toBe('/chosen');
  expect(next.pathChoices).toBeUndefined();
});

test('topics ON: a tgp: tap → topic-path action (recent-path button, carries the nonce)', () => {
  expect(stepUpdates([cbUpd(9, 'tgp:50:1:77')], makeOpts({ topicsEnabled: true })).actions).toEqual([
    { kind: 'topic-path', callbackQueryId: 'cb9', threadId: 50, index: 1, nonce: 77, messageId: 9 },
  ]);
});

test('topics ON: a tgr: tap → topic-respawn action', () => {
  expect(stepUpdates([cbUpd(10, 'tgr:50')], makeOpts({ topicsEnabled: true })).actions).toEqual([
    { kind: 'topic-respawn', callbackQueryId: 'cb10', threadId: 50, messageId: 10 },
  ]);
});

test('topics OFF: a tgp:/tgr: tap does NOT emit a topic action — falls through (expired)', () => {
  expect(stepUpdates([cbUpd(9, 'tgp:50:0:1')], makeOpts({ topicsEnabled: false })).actions).toEqual([
    { kind: 'answer-callback', callbackQueryId: 'cb9', text: 'expired' },
  ]);
  expect(stepUpdates([cbUpd(10, 'tgr:50')], makeOpts({ topicsEnabled: false })).actions).toEqual([
    { kind: 'answer-callback', callbackQueryId: 'cb10', text: 'expired' },
  ]);
});

test('topics ON: a SAME-BATCH forum_topic_closed wins over a tgr/tgm/tgp tap — no spawn into a closed topic (codex r21)', () => {
  // The close + a stale spawn tap arrive in one batch. Callbacks run before service messages, so
  // without the pre-scan the tap would spawn into the just-closed topic. The pre-scan suppresses the
  // tap (answered "topic closed") so the close wins. topicStatusOf must see the topic as TRACKED.
  const closedMsg = upd(20, { forum_topic_closed: {}, message_thread_id: 50, is_topic_message: false });
  const opts = makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' });

  const r1 = stepUpdates([closedMsg, cbUpd(21, 'tgr:50')], opts);
  expect(r1.actions).toContainEqual({ kind: 'answer-callback', callbackQueryId: 'cb21', text: 'topic changed — try again' });
  expect(r1.actions.some((a) => a.kind === 'topic-respawn')).toBe(false);
  expect(r1.actions.some((a) => a.kind === 'topic-close')).toBe(true);

  const r2 = stepUpdates([closedMsg, cbUpd(22, 'tgm:50:claude-opus')], opts);
  expect(r2.actions).toContainEqual({ kind: 'answer-callback', callbackQueryId: 'cb22', text: 'topic changed — try again' });
  expect(r2.actions.some((a) => a.kind === 'topic-model')).toBe(false);

  const r3 = stepUpdates([closedMsg, cbUpd(23, 'tgp:50:0:7')], opts);
  expect(r3.actions).toContainEqual({ kind: 'answer-callback', callbackQueryId: 'cb23', text: 'topic changed — try again' });
  expect(r3.actions.some((a) => a.kind === 'topic-path')).toBe(false);
});

test('topics ON: a SAME-BATCH forum_topic_reopened also suppresses a stale spawn tap (codex r27)', () => {
  // The reopen + a stale tgr tap in one batch: the tap would re-bind a pane that the reopen
  // (markReopened) then drops → orphan. The pre-scan suppresses the tap so the reopen wins.
  const reopenMsg = upd(26, { forum_topic_reopened: {}, message_thread_id: 50, is_topic_message: false });
  const opts = makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' });

  const r = stepUpdates([reopenMsg, cbUpd(27, 'tgr:50')], opts);
  expect(r.actions).toContainEqual({ kind: 'answer-callback', callbackQueryId: 'cb27', text: 'topic changed — try again' });
  expect(r.actions.some((a) => a.kind === 'topic-respawn')).toBe(false);
  expect(r.actions.some((a) => a.kind === 'topic-reopen')).toBe(true);

  // A same-batch reopen (id 26) + a LATER TEXT (id 28 > 26) → suppressed (ack only).
  const textAfter = upd(28, { text: 'hi', message_thread_id: 50, is_topic_message: true });
  const r2 = stepUpdates([reopenMsg, textAfter], opts);
  expect(r2.actions.some((a) => a.kind === 'topic-route' || a.kind === 'topic-dead')).toBe(false);
  expect(r2.actions).toContainEqual({ kind: 'ack', messageId: 28 });
});

test('topics ON: a text BEFORE a same-batch close (lower update_id) is PROCESSED, not dropped (codex r30 order-aware)', () => {
  // The text (id 20) arrived BEFORE the close (id 21), so it happened before the topic was closed →
  // it must route to the (still-bound) agent, NOT be silently acked/dropped.
  const textBefore = upd(20, { text: 'last thing', message_thread_id: 50, is_topic_message: true });
  const closeAfter = upd(21, { forum_topic_closed: {}, message_thread_id: 50, is_topic_message: false });
  const r = stepUpdates([textBefore, closeAfter], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions.some((a) => a.kind === 'topic-route' && (a as { threadId: number }).threadId === 50)).toBe(true);
  expect(r.actions.some((a) => a.kind === 'topic-close')).toBe(true);

  // The SYMMETRIC reopen order: a text (id 30) BEFORE a reopen (id 31) on a closed topic still routes
  // its dead-topic recovery (topic-dead) — it happened before the reopen.
  const textBefore2 = upd(30, { text: 'hi', message_thread_id: 50, is_topic_message: true });
  const reopenAfter = upd(31, { forum_topic_reopened: {}, message_thread_id: 50, is_topic_message: false });
  const r2 = stepUpdates([textBefore2, reopenAfter], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' }));
  expect(r2.actions.some((a) => a.kind === 'topic-dead')).toBe(true);
});

test('topics ON: a tgr tap is NOT suppressed when the same-batch close is for a DIFFERENT thread', () => {
  // The pre-scan is per-thread: a close of thread 99 must not block a tap on thread 50.
  const closedOther = upd(24, { forum_topic_closed: {}, message_thread_id: 99, is_topic_message: false });
  const r = stepUpdates([closedOther, cbUpd(25, 'tgr:50')], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' }));
  expect(r.actions.some((a) => a.kind === 'topic-respawn' && (a as { threadId: number }).threadId === 50)).toBe(true);
});

test('topics ON: a same-batch close + a TEXT message to that thread → ack only, NO topic-route/recovery (codex r24 P1b)', () => {
  // A [forum_topic_closed, <text>] batch on a bound topic: the text must NOT emit a topic-route (which
  // would route into / offer a re-spawn for the just-closed topic). Ack only; the close action wins.
  const closeMsg = upd(40, { forum_topic_closed: {}, message_thread_id: 50, is_topic_message: false });
  const textMsg = upd(41, { text: 'still there?', message_thread_id: 50, is_topic_message: true });
  const r = stepUpdates([closeMsg, textMsg], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions.some((a) => a.kind === 'topic-route')).toBe(false);
  expect(r.actions.some((a) => a.kind === 'topic-dead')).toBe(false);
  expect(r.actions.some((a) => a.kind === 'topic-close')).toBe(true);
  expect(r.actions).toContainEqual({ kind: 'ack', messageId: 41 }); // the text is acked, not routed
});

test('topics ON: a STALE or UNAUTHORIZED same-batch close does NOT suppress a valid tap (codex r22)', () => {
  const opts = makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' });
  // STALE close (date far in the past, beyond stalenessSec): it's ignored by the loop, so it must
  // NOT suppress the fresh tgr tap on the same thread.
  const staleClose = upd(30, { forum_topic_closed: {}, message_thread_id: 50, is_topic_message: false, date: NOW - 10 * 3600 });
  const rStale = stepUpdates([staleClose, cbUpd(31, 'tgr:50')], opts);
  expect(rStale.actions.some((a) => a.kind === 'topic-respawn')).toBe(true);

  // UNAUTHORIZED close (from a non-allowlisted user id): same — must not suppress the valid tap.
  const unauthClose = upd(32, { forum_topic_closed: {}, message_thread_id: 50, is_topic_message: false, from: { id: 999_999, first_name: 'Mallory' } });
  const rUnauth = stepUpdates([unauthClose, cbUpd(33, 'tgr:50')], opts);
  expect(rUnauth.actions.some((a) => a.kind === 'topic-respawn')).toBe(true);
});

test('markRespawnOffered sets the flag; markClosed/markBound/markReopened clear it', () => {
  const closed: TopicBinding = { threadId: 1, name: 'a', status: 'closed', path: '/p', model: 'claude-opus', ts: 1 };
  const offered = markRespawnOffered(closed, 2);
  expect(offered.respawnOffered).toBe(true);
  // A fresh close drops a stale flag (so the first message after re-close re-offers).
  expect(markClosed(offered, 3).respawnOffered).toBeUndefined();
  // Re-binding (re-spawn succeeded) clears it — the topic is no longer dead.
  expect(markBound(offered, '%5', 4).respawnOffered).toBeUndefined();
  // Reopen restarts the flow → clears it too.
  expect(markReopened(offered, 5).respawnOffered).toBeUndefined();
});

test('parseTopics preserves respawnOffered:true, ignores a non-true value', () => {
  const on = serializeTopics([{ threadId: 1, name: 'a', status: 'closed', ts: 1, respawnOffered: true }]);
  expect(parseTopics(on)[0].respawnOffered).toBe(true);
  const off = JSON.stringify([{ threadId: 2, name: 'b', status: 'closed', ts: 1, respawnOffered: 'yes' }]);
  expect(parseTopics(off)[0].respawnOffered).toBeUndefined();
});

test('markSpawnPending sets the flag + token; clearSpawnPending / markBound / markClosed / markReopened clear both', () => {
  const am: TopicBinding = { threadId: 1, name: 'a', status: 'awaiting-model', path: '/p', model: 'claude-opus', ts: 1 };
  const pending = markSpawnPending(am, 'TOK1', 2);
  expect(pending.spawnPending).toBe(true);
  expect(pending.spawnToken).toBe('TOK1');
  for (const next of [clearSpawnPending(pending, 3), markBound(pending, '%5', 4), markClosed(pending, 5), markReopened(pending, 6)]) {
    expect(next.spawnPending).toBeUndefined();
    expect(next.spawnToken).toBeUndefined();
  }
});

test('parseTopics preserves spawnPending:true + spawnToken, ignores non-true / non-string values', () => {
  const on = serializeTopics([
    { threadId: 1, name: 'a', status: 'awaiting-model', path: '/p', model: 'm', ts: 1, spawnPending: true, spawnToken: 'TOK' },
  ]);
  expect(parseTopics(on)[0].spawnPending).toBe(true);
  expect(parseTopics(on)[0].spawnToken).toBe('TOK');
  const off = JSON.stringify([{ threadId: 2, name: 'b', status: 'awaiting-model', ts: 1, spawnPending: 1, spawnToken: 42 }]);
  expect(parseTopics(off)[0].spawnPending).toBeUndefined();
  expect(parseTopics(off)[0].spawnToken).toBeUndefined();
});

// --- §11 deferrals: reply anchor, daemon-global slash intercept, topic-rename ---

// Deferral 2 adversarial boundary: /stop and /kill must NOT be intercepted (they
// belong to the topic's own harness session, not the daemon).
test('§11 d2: /stop in a bound topic → topic-route with verbatim /stop (not daemon-intercepted)', () => {
  const r = stepUpdates(
    [upd(20, { text: '/stop', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, injectText: '/stop', from: 'Alex', messageId: 20 });
});

test('§11 d2: /kill in a bound topic → topic-route with verbatim /kill (not daemon-intercepted)', () => {
  const r = stepUpdates(
    [upd(21, { text: '/kill', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, injectText: '/kill', from: 'Alex', messageId: 21 });
});

test('§11 d2: /status in a bound topic → daemon-intercepted (kind: status)', () => {
  const r = stepUpdates(
    [upd(22, { text: '/status', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]).toMatchObject({ kind: 'status' });
});

test('§11 d2: /agent @bot in a bound topic → daemon-intercepted (kind: agent-route, NOT topic-route)', () => {
  const r = stepUpdates(
    [upd(23, { text: '/agent @mybot pane1', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]?.kind).not.toBe('topic-route');
  expect(r.actions[0]?.kind).toBe('agent-route');
});

test('§11 d2: /new model dir Name in a bound topic → daemon-intercepted (NOT topic-route)', () => {
  const r = stepUpdates(
    [upd(24, { text: '/new claude-opus /tmp MyAgent', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]?.kind).not.toBe('topic-route');
  expect(r.actions[0]?.kind).toBe('new-command');
});

// Deferral 1: prose reply in a bound topic gets the ↩ tg#<id> «…» quote-anchor.
test('§11 d1: prose reply in a bound topic → topic-route with ↩ tg#<id> «…» quote-anchor', () => {
  const replyTo = { message_id: 42, date: 1_749_000_000, text: 'quoted text', chat: { id: CHAT_ID, type: 'supergroup' as const } };
  const r = stepUpdates(
    [upd(25, { text: 'yes, do it', message_thread_id: 50, is_topic_message: true, reply_to_message: replyTo })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  const a = r.actions[0];
  expect(a?.kind).toBe('topic-route');
  if (a?.kind === 'topic-route') {
    expect(a.injectText).toMatch(/^↩ tg#42 «/);
  }
});

test('§11 d1: /stop reply in a bound topic → verbatim /stop (no anchor, /stop is a command)', () => {
  const replyTo = { message_id: 42, date: 1_749_000_000, text: 'whatever', chat: { id: CHAT_ID, type: 'supergroup' as const } };
  const r = stepUpdates(
    [upd(26, { text: '/stop', message_thread_id: 50, is_topic_message: true, reply_to_message: replyTo })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  // /stop must go verbatim to the topic agent, no anchor
  expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, injectText: '/stop', from: 'Alex', messageId: 26 });
});

// Deferral 3: topic-rename action from forum_topic_edited.
test('§11 d3: forum_topic_edited with name → topic-rename for a tracked topic', () => {
  const r = stepUpdates(
    [upd(30, { message_thread_id: 50, forum_topic_edited: { name: 'New Name' } })],
    makeOpts({ topicsEnabled: true, topicStatusOf: (t) => (t === 50 ? 'bound' : null) }),
  );
  expect(r.actions).toContainEqual({ kind: 'topic-rename', threadId: 50, name: 'New Name' });
});

test('§11 d3: forum_topic_edited with no name (icon-only edit) → [] for a tracked topic', () => {
  const r = stepUpdates(
    [upd(31, { message_thread_id: 50, forum_topic_edited: {} })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions.some((a) => a.kind === 'topic-rename')).toBe(false);
  expect(r.actions).toContainEqual({ kind: 'ack', messageId: 31 });
});

test('§11 d3: forum_topic_edited with name for an UNTRACKED topic → [] (not topic-rename)', () => {
  const r = stepUpdates(
    [upd(32, { message_thread_id: 77, forum_topic_edited: { name: 'Whatever' } })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => null }),
  );
  expect(r.actions.some((a) => a.kind === 'topic-rename')).toBe(false);
});

// markRenamed lifecycle: keeps all fields except name + ts.
test('markRenamed updates name + ts, preserves all other fields', () => {
  const binding: TopicBinding = {
    threadId: 50, name: 'old-name', status: 'bound', paneId: '%3', path: '/p', model: 'claude-opus', ts: 100,
  };
  const renamed = markRenamed(binding, 'new-name', 200);
  expect(renamed.name).toBe('new-name');
  expect(renamed.ts).toBe(200);
  expect(renamed.status).toBe('bound');
  expect(renamed.paneId).toBe('%3');
  expect(renamed.path).toBe('/p');
  expect(renamed.model).toBe('claude-opus');
});
