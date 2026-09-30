import { expect, test } from 'bun:test';
import { stepUpdates } from '../features/tg-ctl/updates';
import {
  DEFAULT_CONTROL,
  type Action,
  type ControlConfig,
  type TgMessage,
  type TgUpdate,
  type TopicBinding,
  type TopicPayload,
  type TopicStatus,
} from '../features/tg-ctl/types';
import {
  appendTopic,
  attachTopic,
  buildAttachKeyboard,
  capHolds,
  dropHold,
  findHold,
  findTopic,
  goneTopicReply,
  holdExpiredReply,
  holdPayload,
  markBound,
  markClosed,
  markNoSessionNotice,
  markSpawnPending,
  MAX_TOPIC_HOLDS,
  MAX_TOPICS,
  type TopicHold,
  parseHolds,
  parseTopicAttachCallback,
  parseTopics,
  serializeHolds,
  serializeTopics,
  setHoldPicker,
  slugifyTopicName,
  splitExpiredHolds,
  topicForPane,
  topicLink,
  topicTitle,
  TOPIC_HOLD_TTL_SEC,
} from '../features/tg-ctl/topics';
import { DEFAULT_MODEL_ID, findModel, harnessLabel, MODEL_CATALOG, modelsForHarness, spawnArgv, spawnArgvWithTask } from '../features/tg-ctl/models';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const wrap = (name: string, msg: string, id?: number) => `[TG from ${name}${id ? ` #${id}` : ''}] ${msg}`;

function makeOpts(
  over: Partial<{
    topicsEnabled: boolean;
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
    topicStatusOf: over.topicStatusOf,
  };
}

function upd(id: number, msg: Partial<TgMessage>): TgUpdate {
  return {
    update_id: id,
    message: { message_id: id, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW, ...msg },
  };
}

const bound = makeOpts({ topicsEnabled: true, topicStatusOf: (t) => (t === 50 ? 'bound' : null) });
const unknown = makeOpts({ topicsEnabled: true, topicStatusOf: () => null });
const inTopic = (id: number, msg: Partial<TgMessage>, thread = 50): TgUpdate =>
  upd(id, { message_thread_id: thread, is_topic_message: true, ...msg });
const text = (t: string, messageId: number): TopicPayload => ({ type: 'text', text: t, from: 'Alex', messageId });

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
  expect(spawnArgv('claude-default', '/a b/c')).toEqual(['claude']);
});

test('model catalog helpers: harness labels, harness filters, and task argv', () => {
  expect(harnessLabel('claude')).toBe('Claude');
  expect(harnessLabel('codex')).toBe('Codex');
  expect(harnessLabel('opencode')).toBe('opencode');
  expect(modelsForHarness('codex').every((m) => m.kind === 'codex')).toBe(true);
  expect(modelsForHarness('codex').length).toBeGreaterThan(0);
  expect(spawnArgvWithTask('claude-opus', '/x', '')).toEqual(['claude', '--model', 'opus']);
  expect(spawnArgvWithTask('claude-opus', '/x', 'do it')).toEqual(['claude', '--model', 'opus', '--', 'do it']);
  expect(spawnArgvWithTask('claude-opus', '/x', '--force --all')).toEqual(['claude', '--model', 'opus', '--', '--force --all']);
  // models.ts is PURE: the codex hook-trust bypass is added at spawn time (gated on rig-managed
  // hooks), not baked into the catalog argv — see tests/ctl-models-codex-hook-trust.test.ts.
  expect(spawnArgvWithTask('codex-gpt-5.5', '/x', 'do it')).toEqual(['codex', '--model', 'gpt-5.5', '--', 'do it']);
  expect(spawnArgvWithTask('codex-gpt-5.5', '/x', '; rm -rf /')).toEqual(['codex', '--model', 'gpt-5.5', '--', '; rm -rf /']);
  expect(spawnArgvWithTask('opencode-zai-glm-5.2', '/x', 'do it')).toEqual(['opencode', '--model', 'zai/glm-5.2', '--prompt=do it']);
  expect(spawnArgvWithTask('opencode-zai-glm-5.2', '/x', '--continue please')).toEqual([
    'opencode',
    '--model',
    'zai/glm-5.2',
    '--prompt=--continue please',
  ]);
  expect(spawnArgvWithTask('nope', '/x', 'do it')).toBeNull();
});

// --- binding store ---

test('topics store: round-trips and upserts by threadId', () => {
  const a: TopicBinding = { threadId: 10, name: 'api', status: 'bound', paneId: '%1', harness: 'omp', ts: 1 };
  const b: TopicBinding = { threadId: 20, name: 'web', status: 'bound', paneId: '%3', path: '/w', model: 'claude-opus', ts: 2 };
  let topics = appendTopic(appendTopic([], a), b);
  expect(findTopic(topics, 10)?.harness).toBe('omp');
  expect(findTopic(topics, 20)?.paneId).toBe('%3');
  topics = appendTopic(topics, { ...a, paneId: '%9', ts: 3 });
  expect(topics.filter((t) => t.threadId === 10)).toHaveLength(1);
  expect(findTopic(topics, 10)?.paneId).toBe('%9');
  expect(parseTopics(serializeTopics(topics))).toEqual(topics);
});

test('topics store: parse rejects junk + non-array, keeps valid', () => {
  expect(parseTopics(null)).toEqual([]);
  expect(parseTopics('not json')).toEqual([]);
  expect(parseTopics('{"threadId":1}')).toEqual([]);
  expect(parseTopics('[{"threadId":"x","status":"bound"},{"threadId":5,"status":"nope"},{"threadId":7,"name":"ok","status":"bound","paneId":"%2","ts":9}]'))
    .toEqual([{ threadId: 7, name: 'ok', status: 'bound', path: undefined, model: undefined, paneId: '%2', ts: 9 }]);
});

test('topics store: rows left by the deleted spawn wizard are dropped, so the topic is unknown again', () => {
  const raw = JSON.stringify([
    { threadId: 1, name: 'mid-path', status: 'awaiting-path', ts: 1, pathChoices: ['/a'] },
    { threadId: 2, name: 'mid-model', status: 'awaiting-model', path: '/p', ts: 1 },
    { threadId: 3, name: 'spawning', status: 'awaiting-model', path: '/p', model: 'claude-opus', spawnPending: true, spawnToken: 't', ts: 1 },
    { threadId: 4, name: 'dead', status: 'closed', paneId: '%4', respawnOffered: true, ts: 1 },
  ]);
  const topics = parseTopics(raw);
  expect(findTopic(topics, 1)).toBeNull();
  expect(findTopic(topics, 2)).toBeNull();
  // a flat /new private-topic spawn in flight is kept for startup orphan reconcile
  expect(findTopic(topics, 3)?.spawnToken).toBe('t');
  // a gone session keeps its binding (it answers "not running"); wizard-only fields are gone
  expect(findTopic(topics, 4)).toEqual({ threadId: 4, name: 'dead', status: 'closed', path: undefined, model: undefined, paneId: '%4', ts: 1 });
});

test('topics store: parse drops a bound binding with no paneId, and a NaN ts → 0', () => {
  expect(parseTopics('[{"threadId":7,"name":"x","status":"bound","ts":1}]')).toEqual([]);
  expect(parseTopics('[{"threadId":7,"name":"x","status":"closed","paneId":"%1","ts":null}]')[0]?.ts).toBe(0);
});

test('topics store: caps at MAX_TOPICS keeping the newest', () => {
  let topics: TopicBinding[] = [];
  for (let i = 0; i < MAX_TOPICS + 5; i++) topics = appendTopic(topics, { threadId: i, name: `t${i}`, status: 'bound', paneId: '%1', ts: i });
  expect(topics).toHaveLength(MAX_TOPICS);
  expect(findTopic(topics, 0)).toBeNull();
  expect(findTopic(topics, MAX_TOPICS + 4)?.name).toBe(`t${MAX_TOPICS + 4}`);
});

test('topicForPane: only a BOUND binding makes a session "already have a topic"', () => {
  const topics = [
    { threadId: 1, name: 'a', status: 'closed' as const, paneId: '%1', ts: 1 },
    { threadId: 2, name: 'b', status: 'bound' as const, paneId: '%2', ts: 1 },
  ];
  expect(topicForPane(topics, '%1')).toBeNull();
  expect(topicForPane(topics, '%2')?.threadId).toBe(2);
  expect(topicForPane(topics, 'omp:9')).toBeNull();
});

test('attachTopic binds the topic to the picked session; markClosed keeps the pane for display', () => {
  const b = attachTopic(77, { paneId: 'omp:42', name: 'api · omp', path: '/repo', harness: 'omp' }, 5);
  expect(b).toEqual({ threadId: 77, name: 'api · omp', status: 'bound', paneId: 'omp:42', path: '/repo', harness: 'omp', ts: 5 });
  expect(markClosed(b, 6)).toMatchObject({ status: 'closed', paneId: 'omp:42', ts: 6 });
});

test('spawn markers: markSpawnPending drops a stale pane; markBound / markClosed clear both', () => {
  const b: TopicBinding = { threadId: 1, name: 'x', status: 'awaiting-model', paneId: '%old', ts: 1 };
  const pending = markSpawnPending(b, 'tok', 2);
  expect(pending).toMatchObject({ spawnPending: true, spawnToken: 'tok' });
  expect(pending.paneId).toBeUndefined();
  for (const next of [markBound(pending, '%5', 3), markClosed(pending, 3)]) {
    expect(next.spawnPending).toBeUndefined();
    expect(next.spawnToken).toBeUndefined();
  }
});

test('goneTopicReply names the session and the harness resume command', () => {
  expect(goneTopicReply({ name: 'api', harness: 'omp' })).toBe('`api` is not running — resume with `rig omp run --resume …`');
  expect(goneTopicReply({ name: 'web', harness: 'claude' })).toContain('`claude --resume`');
  expect(goneTopicReply({ name: 'cx', harness: 'codex' })).toContain('`codex resume`');
  // A harness with no known resume command gets a generic hint — never another harness's command.
  for (const harness of [undefined, 'unknown', 'aider'] as const) {
    expect(goneTopicReply({ name: 'old', harness })).toBe('`old` is not running — resume it, then send again');
  }
});

test('slugifyTopicName: safe tmux window name, fallback to threadId', () => {
  expect(slugifyTopicName('My API Bot!', 5)).toBe('my-api-bot');
  expect(slugifyTopicName('Апи Бот', 5)).toBe('api-bot');
  expect(slugifyTopicName('Ревью', 7)).toBe('revyu');
  expect(slugifyTopicName('🔥🔥', 9)).toBe('topic-9');
  expect(slugifyTopicName('  ---  ', 5)).toBe('topic-5');
  expect(slugifyTopicName('a'.repeat(40), 5)).toHaveLength(24);
  expect(slugifyTopicName(`${'a'.repeat(23)} b`, 5)).toBe('a'.repeat(23));
});

test('topicTitle caps at Telegram\'s 128 characters; topicLink only for supergroups', () => {
  expect(topicTitle('short')).toBe('short');
  const long = topicTitle('я'.repeat(200));
  expect([...long]).toHaveLength(128);
  expect(long.endsWith('…')).toBe(true);
  expect(topicLink(-1001234567890, 42)).toBe('https://t.me/c/1234567890/42');
  expect(topicLink(1000, 42)).toBeNull();
});

// --- unknown-topic hold ---

test('hold: FIFO per topic, the expiry clock runs from the FIRST item', () => {
  let holds = holdPayload([], 50, text('one', 1), NOW);
  holds = holdPayload(holds, 60, text('other', 2), NOW + 5);
  holds = holdPayload(holds, 50, text('two', 3), NOW + 590);
  expect(findHold(holds, 50)?.payloads.map((p) => p.messageId)).toEqual([1, 3]);
  expect(findHold(holds, 50)?.firstAt).toBe(NOW);
  const { expired, open } = splitExpiredHolds(holds, NOW + TOPIC_HOLD_TTL_SEC);
  expect(expired.map((h) => h.threadId)).toEqual([50]);
  expect(open.map((h) => h.threadId)).toEqual([60]);
  expect(dropHold(holds, 50).map((h) => h.threadId)).toEqual([60]);
});

test('hold store: survives a restart — round-trips payloads, picker id and first-item time', () => {
  let holds = holdPayload([], 50, text('hi', 1), NOW);
  holds = holdPayload(holds, 50, { type: 'media', mediaKind: 'photo', fileId: 'F', suggestedName: '9.jpg', caption: 'c', from: 'Alex', messageId: 2 }, NOW);
  holds = holdPayload(holds, 50, { type: 'voice', fileId: 'V', suggestedName: '10.ogg', anchor: '↩ tg#1 «…»', from: 'Alex', messageId: 3 }, NOW);
  holds = setHoldPicker(holds, 50, 900);
  expect(parseHolds(serializeHolds(holds))).toEqual(holds);
});

test('hold store: corrupt input degrades to no holds; an invalid payload is skipped, not the hold', () => {
  expect(parseHolds(null)).toEqual([]);
  expect(parseHolds('garbage')).toEqual([]);
  expect(parseHolds('{"version":99,"holds":[]}')).toEqual([]);
  const raw = JSON.stringify({
    version: 1,
    holds: [
      { threadId: 5, firstAt: NOW, pickerMessageId: 'x', payloads: [{ type: 'text', text: 'ok', from: 'A', messageId: 1 }, { type: 'sticker' }] },
      { threadId: 6, firstAt: NOW, payloads: [{ type: 'text' }] },
    ],
  });
  expect(parseHolds(raw)).toEqual([{ threadId: 5, firstAt: NOW, pickerMessageId: null, payloads: [{ type: 'text', text: 'ok', from: 'A', messageId: 1 }] }]);
});

test('hold cap: a new topic past MAX_TOPIC_HOLDS evicts the OLDEST hold, never the newest', () => {
  let holds: TopicHold[] = [];
  for (let t = 1; t <= MAX_TOPIC_HOLDS; t++) holds = holdPayload(holds, t, text(`m${t}`, t), NOW + t);
  // A message joining an existing hold never evicts anything.
  expect(capHolds(holdPayload(holds, 5, text('more', 999), NOW + 999)).evicted).toEqual([]);
  const { kept, evicted } = capHolds(holdPayload(holds, 10_000, text('newest', 10_000), NOW + 10_000));
  expect(kept).toHaveLength(MAX_TOPIC_HOLDS);
  expect(findHold(kept, 10_000)?.payloads.map((p) => p.messageId)).toEqual([10_000]);
  expect(evicted.map((h) => h.threadId)).toEqual([1]);
  expect(findHold(kept, 1)).toBeNull();
});

test('hold cap: evicts by firstAt, not array position (a restored store may be out of order)', () => {
  const holds: TopicHold[] = [];
  for (let t = 1; t <= MAX_TOPIC_HOLDS; t++) holds.push({ threadId: t, firstAt: NOW + t, payloads: [text(`m${t}`, t)], pickerMessageId: null });
  // The oldest hold sits in the middle of the array.
  holds.splice(100, 0, { threadId: 9_999, firstAt: NOW - 500, payloads: [text('old', 9_999)], pickerMessageId: null });
  const { kept, evicted } = capHolds(holds);
  expect(evicted.map((h) => h.threadId)).toEqual([9_999]);
  expect(kept.map((h) => h.threadId)).toEqual(holds.filter((h) => h.threadId !== 9_999).map((h) => h.threadId));
});

test('a dead picker resets the no-session notice, so the next message is answered again', () => {
  let holds = markNoSessionNotice(holdPayload([], 7, text('a', 1), NOW), 7);
  holds = setHoldPicker(holds, 7, 900); // a session started; a real picker was posted
  holds = setHoldPicker(holds, 7, null); // its session exited
  expect(findHold(holds, 7)?.noSessionNoticeSent).toBeUndefined();
});

test('holdExpiredReply counts the undelivered messages', () => {
  expect(holdExpiredReply(1)).toBe('1 message not delivered — send again to reach a session');
  expect(holdExpiredReply(3)).toBe('3 messages not delivered — send again to reach a session');
});

// --- attach picker ---

test('attach picker: one button per session carrying tgt:<thread>:<pane>, parsed back exactly', () => {
  const kb = buildAttachKeyboard(50, [
    { paneId: '%3', label: 'api · omp' },
    { paneId: 'omp:4242', label: 'web · omp' },
  ]);
  expect(kb).toEqual([[{ text: 'api · omp', callback_data: 'tgt:50:%3' }], [{ text: 'web · omp', callback_data: 'tgt:50:omp:4242' }]]);
  for (const row of kb) expect(Buffer.byteLength(row[0].callback_data)).toBeLessThanOrEqual(64);
  expect(parseTopicAttachCallback('tgt:50:%3')).toEqual({ threadId: 50, paneId: '%3' });
  expect(parseTopicAttachCallback('tgt:50:omp:4242')).toEqual({ threadId: 50, paneId: 'omp:4242' });
  for (const bad of [undefined, 'tgt:0:%3', 'tgt:50:', 'tgt:50:%x', 'tgt:-1:%3', 'tga:50:%3', 'tgt:50:%3:extra']) {
    expect(parseTopicAttachCallback(bad)).toBeNull();
  }
});

// --- stepUpdates: §4.4 decision table ---

test('topics OFF: a topic message falls through to normal flat injection (unchanged behaviour)', () => {
  const r = stepUpdates([upd(1, { text: 'hi', message_thread_id: 99, is_topic_message: true })], makeOpts({ topicsEnabled: false }));
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #1] hi', messageId: 1 },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('topics ON: General (no message_thread_id) and a non-forum reply-thread stay flat', () => {
  expect(stepUpdates([upd(1, { text: 'hi' })], bound).actions[0]).toEqual({ kind: 'inject-text', text: '[TG from Alex #1] hi', messageId: 1 });
  // a supergroup reply thread carries a thread id but no is_topic_message — even one colliding with a bound topic
  expect(stepUpdates([upd(2, { text: 'x', message_thread_id: 50 })], bound).actions[0]).toMatchObject({ kind: 'inject-text' });
});

test('row 1: every daemon verb is answered IN the topic, bound or unknown', () => {
  const verbs: Array<[string, Partial<Action>]> = [
    ['/status', { kind: 'status' }],
    ['/agent @mybot pane1', { kind: 'agent-route' }],
    ['/new claude-opus /tmp MyAgent', { kind: 'new-command' }],
    ['/tasks', { kind: 'tasks' }],
    ['/limit codex', { kind: 'limit-status', agent: 'codex' }],
    ['/daily', { kind: 'daily-report' }],
    ['/spend week', { kind: 'usage-report', period: 'week' }],
  ];
  for (const opts of [bound, unknown]) {
    for (const [cmd, expected] of verbs) {
      const r = stepUpdates([inTopic(22, { text: cmd })], opts);
      expect(r.actions[0]).toMatchObject({ ...expected, threadId: 50 });
      expect(r.actions[1]).toEqual({ kind: 'ack', messageId: 22 });
    }
  }
});

test('row 1: /stop, /kill and harness-reserved verbs are NOT daemon verbs — they reach the bound session verbatim', () => {
  for (const cmd of ['/stop', '/kill', '/usage', '/cost', '/stats', '/compact']) {
    expect(stepUpdates([inTopic(20, { text: cmd })], bound).actions[0]).toEqual({ kind: 'topic-route', threadId: 50, payload: text(cmd, 20) });
  }
});

test('row 2: prose in a BOUND topic → topic-route with the wrapped text', () => {
  const r = stepUpdates([inTopic(7, { text: 'deploy now' })], bound);
  expect(r.actions).toEqual([
    { kind: 'topic-route', threadId: 50, payload: text('[TG from Alex #7] deploy now', 7) },
    { kind: 'ack', messageId: 7 },
  ]);
});

test('row 2: a path-like prose message is wrapped, not injected as a command', () => {
  const r = stepUpdates([inTopic(14, { text: '/etc/hosts is broken' })], bound);
  expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, payload: text('[TG from Alex #14] /etc/hosts is broken', 14) });
});

test('row 2: a prose reply carries the quote anchor; a /command or `!` reply stays verbatim', () => {
  const replyTo = { message_id: 42, date: 1_749_000_000, text: 'quoted text', chat: { id: CHAT_ID } };
  const prose = stepUpdates([inTopic(25, { text: 'yes, do it', reply_to_message: replyTo })], bound).actions[0];
  expect(prose.kind === 'topic-route' && prose.payload.type === 'text' && prose.payload.text).toMatch(/^↩ tg#42 «/);
  expect(stepUpdates([inTopic(26, { text: '/stop', reply_to_message: replyTo })], bound).actions[0]).toEqual({
    kind: 'topic-route',
    threadId: 50,
    payload: text('/stop', 26),
  });
  expect(stepUpdates([inTopic(16, { text: '!ls', reply_to_message: replyTo })], bound).actions[0]).toEqual({
    kind: 'topic-route',
    threadId: 50,
    payload: text('!ls', 16),
  });
});

test('`!shell`: a safe or confirmed command passes verbatim; a catastrophic one is answered in the topic, bound or unknown', () => {
  expect(stepUpdates([inTopic(15, { text: '!git status' })], bound).actions[0]).toEqual({ kind: 'topic-route', threadId: 50, payload: text('!git status', 15) });
  expect(stepUpdates([inTopic(21, { text: '!!rm -rf /' })], bound).actions[0]).toEqual({ kind: 'topic-route', threadId: 50, payload: text('!rm -rf /', 21) });
  for (const opts of [bound, unknown]) {
    const r = stepUpdates([inTopic(17, { text: '!rm -rf /' })], opts);
    expect(r.actions).toHaveLength(1);
    const reply = r.actions[0];
    expect(reply).toMatchObject({ kind: 'reply', threadId: 50 });
    expect(reply.kind === 'reply' && reply.text).toContain('rm-rf');
  }
});

test('row 2: photo, document and voice in a bound topic are delivered, not silently acked', () => {
  const photo = stepUpdates([inTopic(12, { photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 99 }], caption: 'look' })], bound);
  expect(photo.actions).toEqual([
    {
      kind: 'topic-route',
      threadId: 50,
      payload: { type: 'media', mediaKind: 'photo', fileId: 'big', suggestedName: '12.jpg', caption: 'look', from: 'Alex', messageId: 12 },
    },
    { kind: 'ack', messageId: 12 },
  ]);
  const doc = stepUpdates([inTopic(13, { document: { file_id: 'D', file_name: 'report.PDF' } })], bound).actions[0];
  expect(doc).toEqual({
    kind: 'topic-route',
    threadId: 50,
    payload: { type: 'media', mediaKind: 'document', fileId: 'D', suggestedName: '13.pdf', from: 'Alex', messageId: 13 },
  });
  const voice = stepUpdates([inTopic(14, { voice: { file_id: 'V' } })], bound).actions[0];
  expect(voice).toEqual({ kind: 'topic-route', threadId: 50, payload: { type: 'voice', fileId: 'V', suggestedName: '14.ogg', from: 'Alex', messageId: 14 } });
});

test('row 2/3: a topic whose session is gone or whose spawn never finished is routed — the entrypoint decides', () => {
  for (const st of ['closed', 'awaiting-model'] as const) {
    const r = stepUpdates([inTopic(9, { text: 'hello' })], makeOpts({ topicsEnabled: true, topicStatusOf: () => st }));
    expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, payload: text('[TG from Alex #9] hello', 9) });
  }
});

test('row 4: an UNKNOWN topic holds the payload — text, album parts and voice join in order', () => {
  const r = stepUpdates(
    [
      inTopic(1, { text: 'first' }, 77),
      inTopic(2, { photo: [{ file_id: 'p1' }] }, 77),
      inTopic(3, { photo: [{ file_id: 'p2' }] }, 77),
      inTopic(4, { voice: { file_id: 'v' } }, 77),
      inTopic(5, { text: '/stop' }, 77),
    ],
    unknown,
  );
  const holds = r.actions.filter((a) => a.kind === 'topic-hold');
  expect(holds.map((a) => a.kind === 'topic-hold' && a.threadId)).toEqual([77, 77, 77, 77, 77]);
  expect(holds.map((a) => a.kind === 'topic-hold' && a.payload.messageId)).toEqual([1, 2, 3, 4, 5]);
  expect(holds[4]).toEqual({ kind: 'topic-hold', threadId: 77, payload: text('/stop', 5) });
  // every held message still gets its receipt
  expect(r.actions.filter((a) => a.kind === 'ack')).toHaveLength(5);
});

test('row 4: with no topicStatusOf lookup a topic message is held, never leaked to a flat agent', () => {
  const r = stepUpdates([inTopic(31, { text: 'hi' }, 30)], { ...makeOpts({ topicsEnabled: true }), topicStatusOf: undefined });
  expect(r.actions[0]).toEqual({ kind: 'topic-hold', threadId: 30, payload: text('[TG from Alex #31] hi', 31) });
});

test('nothing is silently dropped: an oversized file and an unsupported message are answered in the topic', () => {
  const big = stepUpdates([inTopic(40, { document: { file_id: 'D', file_size: 30 * 1024 * 1024 } })], unknown);
  expect(big.actions).toEqual([{ kind: 'reply', text: 'file too large for Bot API (>20 MB)', threadId: 50 }]);
  const sticker = stepUpdates([inTopic(41, {})], bound);
  expect(sticker.actions).toHaveLength(1);
  expect(sticker.actions[0]).toMatchObject({ kind: 'reply', threadId: 50 });
});

test('every user message in a topic, in every binding state, yields a visible action — never a bare ack', () => {
  const messages: Array<Partial<TgMessage>> = [
    { text: 'hi' },
    { text: '/status' },
    { text: '!rm -rf /' },
    { photo: [{ file_id: 'p' }] },
    { voice: { file_id: 'v' } },
    { document: { file_id: 'd', file_size: 99 * 1024 * 1024 } },
    {},
  ];
  for (const st of [null, 'bound', 'closed', 'awaiting-model'] as const) {
    for (const [i, msg] of messages.entries()) {
      const r = stepUpdates([inTopic(100 + i, msg)], makeOpts({ topicsEnabled: true, topicStatusOf: () => st }));
      expect(r.actions.some((a) => a.kind !== 'ack')).toBe(true);
    }
  }
});

test('row 5: forum topic service messages are recorded only — no spawn, no ack', () => {
  const r = stepUpdates(
    [
      upd(50, { message_thread_id: 50, forum_topic_created: { name: 'feature-x' } }),
      upd(51, { message_thread_id: 50, forum_topic_edited: { name: 'renamed' } }),
      upd(52, { message_thread_id: 50, forum_topic_edited: {} }),
      upd(53, { message_thread_id: 50, forum_topic_closed: {}, date: NOW - 9999 }),
      upd(54, { message_thread_id: 50, forum_topic_reopened: {} }),
    ],
    bound,
  );
  expect(r.actions).toEqual([
    { kind: 'topic-event', threadId: 50, event: 'created', name: 'feature-x' },
    { kind: 'topic-event', threadId: 50, event: 'edited', name: 'renamed' },
    { kind: 'topic-event', threadId: 50, event: 'edited' },
    { kind: 'topic-event', threadId: 50, event: 'closed' },
    { kind: 'topic-event', threadId: 50, event: 'reopened' },
  ]);
});

test('an attach tap → topic-attach in message order (after same-batch held messages); OFF → expired', () => {
  const tap: TgUpdate = {
    update_id: 9,
    callback_query: { id: 'cb1', from: { id: CHAT_ID }, data: 'tgt:77:%3', message: { message_id: 500, chat: { id: CHAT_ID }, date: NOW } },
  };
  const r = stepUpdates([inTopic(8, { text: 'queued' }, 77), tap], unknown);
  expect(r.actions.map((a) => a.kind)).toEqual(['topic-hold', 'ack', 'topic-attach']);
  expect(r.actions[2]).toEqual({ kind: 'topic-attach', callbackQueryId: 'cb1', threadId: 77, paneId: '%3', messageId: 500 });
  const off = stepUpdates([tap], makeOpts({ topicsEnabled: false }));
  expect(off.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb1', text: 'expired' }]);
});

test('a topic message or tap from a NON-allowed sender yields no topic action', () => {
  const intruder: TgUpdate = {
    update_id: 21,
    message: { message_id: 21, from: { id: 999 }, chat: { id: CHAT_ID }, date: NOW, text: 'pwn', message_thread_id: 50, is_topic_message: true },
  };
  expect(stepUpdates([intruder], bound).actions).toEqual([]);
  const tap: TgUpdate = { update_id: 22, callback_query: { id: 'cb', from: { id: 999 }, data: 'tgt:50:%3' } };
  expect(stepUpdates([tap], bound).actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb', text: 'not allowed' }]);
});

test('an OLD topic message is still triaged, never age-dropped (#183)', () => {
  const r = stepUpdates([inTopic(20, { text: 'old', date: NOW - 9999 })], bound);
  expect(r.actions[0]).toMatchObject({ kind: 'topic-route' });
  expect(r.skippedStale).toBe(0);
});
