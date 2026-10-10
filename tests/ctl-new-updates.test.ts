// Update→action tests for the flat `/new` command (issue #27): the slash parses to a
// new-command action, the tnh:/tnm:/tnp: taps route to new-harness/new-model/new-dir, and a plain message while
// a /new awaits its dir becomes a new-answer (else it injects as normal — 1:1 byte-identical).

import { expect, test } from 'bun:test';
import { stepUpdates } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type ControlConfig, type TgMessage, type TgUpdate } from '../features/tg-ctl/types';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const wrap = (name: string, msg: string) => `[TG from ${name}] ${msg}`;

function makeOpts(over: Partial<{ newSessionAwaitingDir: (threadId: number | null) => boolean }> = {}) {
  return {
    cfg: { ...DEFAULT_CONTROL } as ControlConfig,
    chatId: CHAT_ID,
    nowSec: NOW,
    currentOffset: 5,
    wrap,
    newSessionAwaitingDir: over.newSessionAwaitingDir,
  };
}

function upd(id: number, msg: Partial<TgMessage> = {}): TgUpdate {
  return {
    update_id: id,
    message: { message_id: id, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW, ...msg },
  };
}

function cbUpd(id: number, data: string): TgUpdate {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: CHAT_ID, first_name: 'Alex' },
      message: { message_id: id * 10, chat: { id: CHAT_ID }, date: NOW },
      data,
    },
  };
}

test('/new <name> parses to a new-command action', () => {
  const r = stepUpdates([upd(10, { text: '/new myproj fix it' })], makeOpts());
  const a = r.actions.find((x) => x.kind === 'new-command');
  expect(a).toEqual({ kind: 'new-command', harness: null, model: null, dir: null, name: 'myproj', task: 'fix it', dirAfterName: false, from: 'Alex', messageId: 10, chatId: CHAT_ID });
});

test('/new with model + dir parses both', () => {
  const r = stepUpdates([upd(11, { text: '/new opus /Users/me/app api do thing' })], makeOpts());
  const a = r.actions.find((x) => x.kind === 'new-command');
  expect(a).toMatchObject({ kind: 'new-command', harness: 'claude', model: 'claude-opus', dir: '/Users/me/app', name: 'api', task: 'do thing' });
});

test('/new with harness + name + task parses the harness separately from the name', () => {
  const r = stepUpdates([upd(17, { text: '/new codex task-cli msg' })], makeOpts());
  const a = r.actions.find((x) => x.kind === 'new-command');
  expect(a).toMatchObject({ kind: 'new-command', harness: 'codex', model: null, dir: null, name: 'task-cli', task: 'msg' });
});

test('/new with name + harness + task parses the swapped order too', () => {
  const r = stepUpdates([upd(18, { text: '/new task-cli oc msg' })], makeOpts());
  const a = r.actions.find((x) => x.kind === 'new-command');
  expect(a).toMatchObject({ kind: 'new-command', harness: 'opencode', model: null, dir: null, name: 'task-cli', task: 'msg' });
});

test('tnm: tap → new-model action carrying token + modelId + messageId', () => {
  const r = stepUpdates([cbUpd(12, 'tnm:n1:claude-sonnet')], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'new-model', callbackQueryId: 'cb12', token: 'n1', modelId: 'claude-sonnet', messageId: 120 },
  ]);
});

test('tnh: tap → new-harness action carrying token + harness + messageId', () => {
  const r = stepUpdates([cbUpd(25, 'tnh:n1:codex')], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'new-harness', callbackQueryId: 'cb25', token: 'n1', harness: 'codex', messageId: 250 },
  ]);
});

test('tnp: tap → new-dir action carrying token + index + messageId', () => {
  const r = stepUpdates([cbUpd(13, 'tnp:n1:2')], makeOpts());
  expect(r.actions).toEqual([{ kind: 'new-dir', callbackQueryId: 'cb13', token: 'n1', index: 2, messageId: 130 }]);
});

test('tnf: tap → private-topic fallback action carrying token + choice + messageId', () => {
  const r = stepUpdates([cbUpd(26, 'tnf:n1:continue')], makeOpts());
  expect(r.actions).toEqual([
    {
      kind: 'new-private-topic-fallback',
      callbackQueryId: 'cb26',
      token: 'n1',
      choice: 'continue',
      messageId: 260,
    },
  ]);
  const cancel = stepUpdates([cbUpd(27, 'tnf:n1:cancel')], makeOpts());
  expect(cancel.actions).toEqual([
    {
      kind: 'new-private-topic-fallback',
      callbackQueryId: 'cb27',
      token: 'n1',
      choice: 'cancel',
      messageId: 270,
    },
  ]);
});

test('tnf: tap stays ordered with same-batch /new messages', () => {
  const r = stepUpdates([upd(28, { text: '/new first' }), cbUpd(29, 'tnf:n1:continue')], makeOpts());
  expect(r.actions.map((a) => a.kind)).toEqual(['new-command', 'ack', 'new-private-topic-fallback']);
});

test('plain message while a /new awaits its dir → new-answer', () => {
  const r = stepUpdates([upd(14, { text: '/Users/me/app' })], makeOpts({ newSessionAwaitingDir: () => true }));
  const a = r.actions.find((x) => x.kind === 'new-answer');
  expect(a).toEqual({ kind: 'new-answer', text: '/Users/me/app', from: 'Alex', messageId: 14 });
});

test('plain message with NO /new in flight → injects as normal (1:1 unchanged)', () => {
  const r = stepUpdates([upd(15, { text: 'hello agent' })], makeOpts({ newSessionAwaitingDir: () => false }));
  const a = r.actions.find((x) => x.kind === 'inject-text');
  expect(a).toEqual({ kind: 'inject-text', text: '[TG from Alex] hello agent', messageId: 15 });
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
});

test('a /command while /new awaits dir is NOT swallowed as a path answer', () => {
  // `/status` is still a command even mid-/new — only an absolute PATH is the answer.
  const r = stepUpdates([upd(16, { text: '/status' })], makeOpts({ newSessionAwaitingDir: () => true }));
  expect(r.actions.some((x) => x.kind === 'status')).toBe(true);
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
});

test('REGRESSION (review #1): ordinary prose mid-/new is NOT swallowed — it injects normally', () => {
  // A forgotten /new must not mute 1:1 routing: `fix the bug` (no leading slash) is NOT a path,
  // so it injects to the agent as usual instead of being eaten as a (bad) dir answer.
  const r = stepUpdates([upd(19, { text: 'fix the bug' })], makeOpts({ newSessionAwaitingDir: () => true }));
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
  expect(r.actions.find((x) => x.kind === 'inject-text')).toEqual({
    kind: 'inject-text',
    text: '[TG from Alex] fix the bug',
    messageId: 19,
  });
});

test('REGRESSION (review #1): a single-component path /tmp IS accepted as the dir answer', () => {
  // The old isLikelySlashCommand gate wrongly treated `/tmp` as a command; it must be a path answer.
  const r = stepUpdates([upd(21, { text: '/tmp' })], makeOpts({ newSessionAwaitingDir: () => true }));
  expect(r.actions.find((x) => x.kind === 'new-answer')).toEqual({
    kind: 'new-answer',
    text: '/tmp',
    from: 'Alex',
    messageId: 21,
  });
});

test('a second /new while one awaits dir is the COMMAND, not a path answer', () => {
  const r = stepUpdates([upd(22, { text: '/new other' })], makeOpts({ newSessionAwaitingDir: () => true }));
  expect(r.actions.some((x) => x.kind === 'new-command')).toBe(true);
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
});

test('a harness passthrough command (/compact) mid-/new becomes a new-answer (handler injects it)', () => {
  // The stepUpdates gate emits new-answer for any non-daemon slash text; handleNewAnswer then
  // recognizes a bare /word as a harness passthrough and injects it (review #1 second pass). The
  // pure step just needs to NOT misroute it to the daemon's own dispatch.
  const r = stepUpdates([upd(23, { text: '/compact' })], makeOpts({ newSessionAwaitingDir: () => true }));
  expect(r.actions.find((x) => x.kind === 'new-answer')).toMatchObject({ kind: 'new-answer', text: '/compact' });
  expect(r.actions.some((x) => x.kind === 'inject-text')).toBe(false); // not the flat dispatch
});

test('/new@botname dispatches to new-command (group @mention tolerated)', () => {
  const r = stepUpdates([upd(24, { text: '/new@mybot api' })], makeOpts());
  expect(r.actions.find((x) => x.kind === 'new-command')).toMatchObject({ kind: 'new-command', name: 'api' });
});

test('EVERY daemon command (derived from the menu) is recognized as a command mid-/new, not swallowed', () => {
  // The dir-answer gate excludes daemon commands via a set DERIVED from botCommandNames() — so a
  // newly-added command can never silently leak into the agent as a passthrough while a /new is
  // pending (review #1). Exercise each handled verb: it must dispatch as its own action, NOT a
  // new-answer.
  for (const [verb, expectedKind] of [
    ['/kill', 'kill-agent'],
    ['/stop', 'inject-key'],
    ['/status', 'status'],
    ['/agent foo', 'agent-route'],
    ['/new other', 'new-command'],
  ] as const) {
    const r = stepUpdates([upd(26, { text: verb })], makeOpts({ newSessionAwaitingDir: () => true }));
    expect(r.actions.some((x) => x.kind === expectedKind)).toBe(true);
    expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
  }
});

test('a REPLY while /new awaits dir is NOT swallowed as a path answer', () => {
  const r = stepUpdates(
    [upd(17, { text: 'looks good', reply_to_message: { message_id: 5, chat: { id: CHAT_ID }, date: NOW } })],
    makeOpts({ newSessionAwaitingDir: () => true }),
  );
  expect(r.actions.some((x) => x.kind === 'reply-route')).toBe(true);
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
});

test('tnm:/tnp: taps work with topics mode OFF (flat /new is not topic-gated)', () => {
  const r = stepUpdates([cbUpd(18, 'tnm:n9:claude-opus')], makeOpts());
  expect(r.actions[0]).toMatchObject({ kind: 'new-model', token: 'n9', modelId: 'claude-opus' });
});

test('topics-on: a path message INSIDE a topic is routed to the topic, NOT eaten by a pending flat /new (review #2)', () => {
  // With control.topics on and a flat /new awaiting its dir, an absolute-path message sent inside a
  // TRACKED bound topic must route to that topic (the topics block runs first and continues) — it
  // must NOT be intercepted as the flat /new's dir answer.
  const r = stepUpdates(
    [
      upd(27, {
        text: '/Users/me/app',
        message_thread_id: 555,
        is_topic_message: true,
      }),
    ],
    {
      ...makeOpts({ newSessionAwaitingDir: (tid) => tid === null }),
      topicsEnabled: true,
      topicStatusOf: (tid: number) => (tid === 555 ? 'bound' : null),
    },
  );
  expect(r.actions.some((x) => x.kind === 'topic-route')).toBe(true);
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
});

// tg-cli#555 (1): a `/new` typed in a topic asks for its dir in that topic, so the path typed
// there answers it — the flat /new's answer gate never sees topic messages.
test('topics-on: a path typed in the topic whose /new awaits its dir answers that /new', () => {
  const asked: Array<number | null> = [];
  const r = stepUpdates([upd(28, { text: '/tmp', message_thread_id: 555, is_topic_message: true })], {
    ...makeOpts({ newSessionAwaitingDir: (tid) => (asked.push(tid), tid === 555) }),
    topicsEnabled: true,
    topicStatusOf: (tid: number) => (tid === 555 ? 'bound' : null),
  });
  expect(asked).toContain(555);
  expect(r.actions.find((x) => x.kind === 'new-answer')).toEqual({ kind: 'new-answer', text: '/tmp', from: 'Alex', messageId: 28, threadId: 555 });
  expect(r.actions.some((x) => x.kind === 'topic-route' || x.kind === 'topic-hold')).toBe(false);
});

test('topics-on: prose in a topic with a pending /new still goes to the session', () => {
  const r = stepUpdates([upd(29, { text: 'fix the bug', message_thread_id: 555, is_topic_message: true })], {
    ...makeOpts({ newSessionAwaitingDir: () => true }),
    topicsEnabled: true,
    topicStatusOf: () => 'bound',
  });
  expect(r.actions.some((x) => x.kind === 'topic-route')).toBe(true);
  expect(r.actions.some((x) => x.kind === 'new-answer')).toBe(false);
});

// tg-cli#555 (2): /stop and /kill in a bound topic act on that topic's session, like the flat verbs.
test('topics-on: /stop and /kill in a bound topic are session controls, not text', () => {
  const opts = { ...makeOpts(), topicsEnabled: true, topicStatusOf: (tid: number) => (tid === 555 ? ('bound' as const) : null) };
  const stop = stepUpdates([upd(30, { text: '/stop', message_thread_id: 555, is_topic_message: true })], opts);
  expect(stop.actions.find((x) => x.kind === 'topic-control')).toEqual({ kind: 'topic-control', threadId: 555, control: 'stop', messageId: 30 });
  const kill = stepUpdates([upd(31, { text: '/kill@tgbot', message_thread_id: 555, is_topic_message: true })], opts);
  expect(kill.actions.find((x) => x.kind === 'topic-control')).toEqual({ kind: 'topic-control', threadId: 555, control: 'kill', messageId: 31 });
  // An unknown topic holds it behind the attach picker, like any other message (§4.4 row 4).
  const unknown = stepUpdates([upd(32, { text: '/stop', message_thread_id: 777, is_topic_message: true })], opts);
  expect(unknown.actions.some((x) => x.kind === 'topic-hold')).toBe(true);
  expect(unknown.actions.some((x) => x.kind === 'topic-control')).toBe(false);
});

test('a tnm: tap from an UNAUTHORIZED sender is rejected, never routed to spawn', () => {
  const r = stepUpdates(
    [
      {
        update_id: 25,
        callback_query: {
          id: 'cb25',
          from: { id: 999999, first_name: 'Mallory' }, // not CHAT_ID, not in allowedSenders
          message: { message_id: 250, chat: { id: CHAT_ID }, date: NOW },
          data: 'tnm:n1:claude-opus',
        },
      },
    ],
    makeOpts(),
  );
  expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb25', text: 'not allowed' }]);
  expect(r.actions.some((x) => x.kind === 'new-model')).toBe(false);
});
