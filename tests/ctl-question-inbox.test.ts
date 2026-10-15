// tg-cli#705: the pure half of the 📥 Inbox and its close signals — the sync plan, the copy's
// rendering, hatch sibling selection, which cards a chat message can answer, how typed text
// maps to an answer, the withdraw line/argv, the state file, and the reminder migration.
import { expect, test } from 'bun:test';
import {
  addRetireTargets,
  arrivalClock,
  emptyInboxState,
  freeTextAnswer,
  ANY_CWD,
  hatchSiblingKeys,
  hatchSiblingsOf,
  inboxMirrorMessage,
  hasLegacyCriticalState,
  inboxEntryOf,
  legacyReminderMessages,
  parseInboxState,
  parseRetireQueue,
  parseWithdrawArgv,
  parseWithdrawLine,
  planInboxSync,
  serializeInboxState,
  serializeRetireQueue,
  sessionCardKeys,
  type OpenCard,
} from '../features/tg-ctl/question-inbox';
import { formatAgentHookOutput, type ButtonRequest } from '../features/tg-ctl/questions';

const CHAT = 1;

function card(key: string, req: Partial<ButtonRequest> = {}, at = 0): OpenCard {
  return { key, at, req: { requestId: key, agent: 'claude', kind: 'question', question: `Q ${key}?`, options: [{ label: 'Yes' }], ...req } as ButtonRequest };
}

function hatch(key: string, hookId: string, cwd: string): OpenCard {
  return card(key, { requestId: `hatch-${hookId}-aaaaaaaaaaaa`, kind: 'permission', question: '<b>ship</b>', cwd, hookId });
}

const open = (...pairs: Array<[string, number]>) => pairs.map(([key, messageId]) => ({ key, messageId }));

test('planInboxSync posts a copy for every open card without one and removes copies of closed cards', () => {
  const state = { chatId: CHAT, threadId: 7, mirrors: { a: { messageId: 10, cardId: 1 }, gone: { messageId: 11, cardId: 2 } }, removing: [] };
  expect(planInboxSync(open(['a', 1], ['b', 3], ['c', 4]), state)).toEqual({ post: ['b', 'c'], remove: ['gone'] });
  expect(planInboxSync([], state)).toEqual({ post: [], remove: ['a', 'gone'] });
  expect(planInboxSync(open(['a', 1], ['gone', 2]), state)).toEqual({ post: [], remove: [] });
});

test('a copy left from an earlier card with the same request id is replaced, and maps to no card', () => {
  // Card 1 closed; before its copy was removed a new card (message 5) reused request id `p`.
  const state = { chatId: CHAT, threadId: 7, mirrors: { p: { messageId: 10, cardId: 1 } }, removing: [] };
  expect(planInboxSync(open(['p', 5]), state)).toEqual({ post: ['p'], remove: ['p'] });
  // The stale copy still names the OLD card, so the daemon maps a tap on it to no current card.
  expect(inboxEntryOf(state, 10)).toEqual({ key: 'p', cardId: 1 });
  // A card posted INTO the Inbox stands for itself.
  const inInbox = { chatId: CHAT, threadId: 7, mirrors: { q: { messageId: 20, card: true as const } }, removing: [] };
  expect(planInboxSync(open(['q', 20]), inInbox)).toEqual({ post: [], remove: [] });
  expect(inboxEntryOf(inInbox, 20)).toEqual({ key: 'q', cardId: 20 });
  expect(inboxEntryOf(inInbox, 99)).toBeNull();
});

test('a request id named like an Object.prototype member is an ordinary card key', () => {
  const fresh = parseInboxState(null, CHAT);
  expect(planInboxSync(open(['toString', 1], ['constructor', 2], ['__proto__', 3]), fresh).post).toEqual(['toString', 'constructor', '__proto__']);
  // A JSON `__proto__` key is an own key after JSON.parse; it must survive as an entry.
  const raw = `{"version":1,"chatId":${CHAT},"threadId":7,"mirrors":{"__proto__":{"messageId":5,"cardId":1},"toString":{"messageId":6,"cardId":2}}}`;
  const restored = parseInboxState(raw, CHAT);
  expect(planInboxSync(open(['__proto__', 1], ['toString', 2]), restored)).toEqual({ post: [], remove: [] });
  expect(inboxEntryOf(restored, 5)).toEqual({ key: '__proto__', cardId: 1 });
});

test('the state file round-trips; a foreign chat, an unknown version or garbage starts fresh', () => {
  const state = { chatId: CHAT, threadId: 7, mirrors: { a: { messageId: 10, cardId: 1 }, b: { messageId: 11, card: true as const } }, removing: [] };
  expect(parseInboxState(serializeInboxState(state), CHAT)).toEqual(state);
  expect(parseInboxState(serializeInboxState(state), 2)).toEqual(emptyInboxState(2));
  expect(parseInboxState(JSON.stringify({ ...state, version: 2 }), CHAT)).toEqual(emptyInboxState(CHAT));
  expect(parseInboxState('{nope', CHAT)).toEqual(emptyInboxState(CHAT));
  expect(parseInboxState(null, CHAT)).toEqual(emptyInboxState(CHAT));
  // A copy from before copies recorded their card is kept unbound, so the next sync replaces it.
  const old = parseInboxState(JSON.stringify({ version: 1, chatId: CHAT, threadId: 7, mirrors: { a: { messageId: 10 } } }), CHAT);
  expect(planInboxSync(open(['a', 1]), old)).toEqual({ post: ['a'], remove: ['a'] });
  // Copies without a topic cannot exist: they are dropped with it.
  expect(parseInboxState(JSON.stringify({ version: 1, chatId: CHAT, threadId: null, mirrors: { a: { messageId: 10 } } }), CHAT)).toEqual(emptyInboxState(CHAT));
});

test('a copy carries the session, kind and age, the card text, the SAME buttons and a Dismiss', () => {
  const c = card('k1', { options: [{ label: 'Staging' }, { label: 'Production' }] }, 0);
  const m = inboxMirrorMessage(c, 'tg-cli', 5 * 60_000);
  expect(m.text.startsWith('📥 tg-cli · question · 5 min\n\n')).toBe(true);
  expect(m.text).toContain('Q k1?');
  expect(m.parse_mode).toBeUndefined();
  const rows = m.reply_markup.inline_keyboard;
  expect(rows.at(-1)).toEqual([{ text: '✕ Dismiss', callback_data: 'tgqc:k1' }]);
  const data = rows.flat().map((b) => b.callback_data);
  expect(data).toContain('tgq:k1:o0');
  expect(data).toContain('tgq:k1:o1');
});

test('a hatch copy keeps HTML parse mode, names the hook, and escapes the header', () => {
  const c = hatch('h1', 'ship-skip-ci', '/repo');
  const m = inboxMirrorMessage(c, 'a<b>', 0);
  expect(m.parse_mode).toBe('HTML');
  expect(m.text.startsWith('📥 a&lt;b&gt; · hatch ship-skip-ci · 0 min')).toBe(true);
  expect(m.text).toContain('<b>ship</b>');
});

test('hatch siblings: same hook id and cwd, excluding the deciding card; --cwd optional', () => {
  const cards = [hatch('h1', 'ship', '/a'), hatch('h2', 'ship', '/a'), hatch('h3', 'ship', '/b'), hatch('h4', 'other', '/a'), card('q1')];
  expect(hatchSiblingKeys(cards, 'ship', '/a', 'h1')).toEqual(['h2']);
  // Only an explicit any-directory withdraw spans directories.
  expect(hatchSiblingKeys(cards, 'ship', ANY_CWD, null)).toEqual(['h1', 'h2', 'h3']);
  expect(hatchSiblingsOf(cards, cards[1].req, 'h2')).toEqual(['h1']);
  expect(hatchSiblingsOf(cards, cards[4].req, 'q1')).toEqual([]);
  // A retry with no cwd is not the same (hookId, cwd): it closes no card asked from a directory.
  const cwdless = { ...cards[0].req, cwd: undefined, requestId: 'hatch-ship-bbbbbbbbbbbb' };
  expect(hatchSiblingKeys(cards, 'ship', undefined, null)).toEqual([]);
  expect(hatchSiblingsOf(cards, cwdless, 'new')).toEqual([]);
  // A plain permission that merely carries a hookId is no hatch: it neither supersedes nor is superseded.
  const plainA = card('perm-a', { kind: 'permission', cwd: '/a', hookId: 'ship' });
  const plainB = card('perm-b', { kind: 'permission', cwd: '/a', hookId: 'ship' });
  expect(hatchSiblingsOf([plainA, ...cards], plainB.req, 'perm-b')).toEqual([]);
  expect(hatchSiblingKeys([plainA], 'ship', '/a', null)).toEqual([]);
});

// The tmux server a card was asked from: pane ids repeat across servers (tg-cli#722).
const onServer = (paneId: string, tmuxServerPid: number | null): Partial<ButtonRequest> => ({
  paneId,
  asker: { tmuxPane: paneId, tmuxServerPid, ancestorPids: [], sessionFile: null, sessionKey: null },
});

test('sessionCardKeys: cards asked by the session or from the pane the message goes to — never a hatch card', () => {
  const cards = [card('a', { sessionKey: 'cc:1' }), card('b', onServer('%3', 40)), card('c', { sessionKey: 'cc:2', ...onServer('%9', 40) })];
  expect(sessionCardKeys(cards, { sessionKey: 'cc:1', paneId: '%3', serverPid: 40 })).toEqual(['a', 'b']);
  expect(sessionCardKeys(cards, { paneId: '%9', serverPid: 40 })).toEqual(['c']);
  expect(sessionCardKeys(cards, { paneId: '%5', serverPid: 40 })).toEqual([]);
  // A hatch card on the session's own pane is a shell gate: the message is for the agent.
  const gate = { ...hatch('h', 'ship', '/w'), req: { ...hatch('h', 'ship', '/w').req, sessionKey: 'cc:1', ...onServer('%3', 40) } };
  expect(sessionCardKeys([gate], { sessionKey: 'cc:1', paneId: '%3', serverPid: 40 })).toEqual([]);
  // One text cannot answer each question of a multi-question card.
  expect(sessionCardKeys([card('m', { sessionKey: 'cc:1', multiQuestion: true } as Partial<ButtonRequest>)], { sessionKey: 'cc:1', paneId: '%3', serverPid: 40 })).toEqual([]);
});

test('sessionCardKeys: a pane matches only on the same tmux server — a session key matches anywhere (#722)', () => {
  const other = card('other', onServer('%1', 41));
  const mine = card('mine', onServer('%1', 40));
  expect(sessionCardKeys([other, mine], { paneId: '%1', serverPid: 40 })).toEqual(['mine']);
  expect(sessionCardKeys([other], { paneId: '%1', serverPid: 40 })).toEqual([]);
  // A card or a target whose server is unknown cannot prove it is the same pane.
  expect(sessionCardKeys([card('unknown', onServer('%1', null))], { paneId: '%1', serverPid: 40 })).toEqual([]);
  expect(sessionCardKeys([card('bare', { paneId: '%1' })], { paneId: '%1', serverPid: 40 })).toEqual([]);
  expect(sessionCardKeys([mine], { paneId: '%1', serverPid: null })).toEqual([]);
  // The asking session's key is unambiguous on any server.
  const keyed = card('keyed', { sessionKey: 'cc:7', ...onServer('%1', 41) });
  expect(sessionCardKeys([keyed], { sessionKey: 'cc:7', paneId: '%1', serverPid: 40 })).toEqual(['keyed']);
});

test('copies whose removal is still owed survive in the state file until Telegram confirms (#722)', () => {
  const state = { chatId: CHAT, threadId: 7, mirrors: emptyInboxState(CHAT).mirrors, removing: [10, 11] };
  expect(parseInboxState(serializeInboxState(state), CHAT).removing).toEqual([10, 11]);
  // An older state file has no list; garbage entries are dropped.
  expect(parseInboxState(JSON.stringify({ version: 1, chatId: CHAT, threadId: 7, mirrors: {} }), CHAT).removing).toEqual([]);
  expect(parseInboxState(JSON.stringify({ version: 1, chatId: CHAT, threadId: 7, mirrors: {}, removing: [12, 'x', 1.5, null] }), CHAT).removing).toEqual([12]);
  // No topic, no copies to remove.
  expect(parseInboxState(JSON.stringify({ version: 1, chatId: CHAT, threadId: null, mirrors: {}, removing: [12] }), CHAT).removing).toEqual([]);
});

test('the reminder retire queue round-trips, merges without duplicates and tolerates garbage (#723)', () => {
  const queue = [{ chatId: CHAT, messageId: 501 }, { chatId: 7, messageId: 555 }];
  expect(parseRetireQueue(serializeRetireQueue(queue))).toEqual(queue);
  expect(parseRetireQueue(null)).toEqual([]);
  expect(parseRetireQueue('{bad')).toEqual([]);
  // A queue written by some other version is not read as this one: no message deleted on a guess.
  expect(parseRetireQueue(JSON.stringify({ version: 2, messages: queue }))).toEqual([]);
  expect(parseRetireQueue(JSON.stringify({ messages: queue }))).toEqual([]);
  expect(parseRetireQueue(JSON.stringify({ version: 1, messages: [{ chatId: 1, messageId: 'x' }, { chatId: 2, messageId: 9 }, null] }))).toEqual([{ chatId: 2, messageId: 9 }]);
  expect(addRetireTargets(queue, [{ chatId: 7, messageId: 555 }, { chatId: 7, messageId: 556 }])).toEqual([...queue, { chatId: 7, messageId: 556 }]);
});

test('arrivalClock: asks in the same millisecond still get distinct, ordered arrival times (#723)', () => {
  let now = 5;
  const at = arrivalClock(() => now);
  expect([at(), at(), at()]).toEqual([5, 6, 7]);
  now = 100;
  expect(at()).toBe(100);
  // A clock stepping back never reorders arrivals.
  now = 50;
  expect(at()).toBe(101);
});

test('freeTextAnswer: a question takes the text; a permission reads yes/no; other text denies with it as the reason', () => {
  const q = card('q').req;
  expect(freeTextAnswer(q, '  use staging ')).toEqual({ status: 'answered', requestId: 'q', label: 'use staging', value: 'use staging' });
  const p = card('p', { kind: 'permission', options: undefined }).req;
  for (const yes of ['yes', 'ok', 'да', 'ок']) expect(freeTextAnswer(p, yes)).toMatchObject({ decision: 'allow', value: 'allow' });
  for (const no of ['no', 'нет']) expect(freeTextAnswer(p, no)).toMatchObject({ decision: 'deny', value: 'deny' });
  const other = freeTextAnswer(p, 'no — use the staging db');
  expect(other).toMatchObject({ decision: 'deny', reason: 'no — use the staging db' });
  // The reason reaches the model through the hook reply.
  expect(formatAgentHookOutput({ ...p, permissionEvent: 'PreToolUse' }, other)).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no — use the staging db' },
  });
  expect(formatAgentHookOutput(p, other)).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no — use the staging db' } },
  });
});

test('parseWithdrawLine: by request id or by hook id (+cwd), with an optional reason', () => {
  expect(parseWithdrawLine({ withdraw: 'r1', reason: ' done ' })).toEqual({ kind: 'request', requestId: 'r1', reason: 'done' });
  expect(parseWithdrawLine({ withdrawHookId: 'ship', cwd: '/a' })).toEqual({ kind: 'hook', hookId: 'ship', cwd: '/a', reason: undefined });
  expect(parseWithdrawLine({ withdraw: '' })).toBeNull();
  expect(parseWithdrawLine({ requestId: 'r1' })).toBeNull();
  expect(parseWithdrawLine(null)).toBeNull();
});

test('parseWithdrawArgv builds the socket line or names the usage error', () => {
  expect(parseWithdrawArgv(['r1'])).toEqual({ line: { withdraw: 'r1' } });
  expect(parseWithdrawArgv(['r1', '--reason', 'gone'])).toEqual({ line: { withdraw: 'r1', reason: 'gone' } });
  expect(parseWithdrawArgv(['--hook-id', 'ship', '--cwd', '/a'])).toEqual({ line: { withdrawHookId: 'ship', cwd: '/a' } });
  expect(parseWithdrawArgv([])).toHaveProperty('error');
  expect(parseWithdrawArgv(['r1', '--hook-id', 'ship'])).toHaveProperty('error');
  expect(parseWithdrawArgv(['r1', '--cwd', '/a'])).toHaveProperty('error');
  expect(parseWithdrawArgv(['--hook-id'])).toHaveProperty('error');
  expect(parseWithdrawArgv(['--bogus'])).toHaveProperty('error');
  // An unset shell variable (`tg-ctl withdraw "$ID"`) is a usage error, not a silent no-op.
  expect(parseWithdrawArgv([''])).toHaveProperty('error');
  expect(parseWithdrawArgv(['  '])).toHaveProperty('error');
});

test('hasLegacyCriticalState reads the records, not the text: a question mentioning the word is not legacy state', () => {
  expect(hasLegacyCriticalState(JSON.stringify({ questions: [{ req: { question: 'q' }, criticalState: { lastReminderMessageId: 4 } }] }))).toBe(true);
  expect(hasLegacyCriticalState(JSON.stringify({ questions: [{ req: { question: 'what does "criticalState" mean?' } }] }))).toBe(false);
  expect(hasLegacyCriticalState('{nope')).toBe(false);
  expect(hasLegacyCriticalState(null)).toBe(false);
});

test('legacyReminderMessages finds every reminder the old reminders left, in the chat each was posted in', () => {
  const questions = JSON.stringify({
    v: 1,
    questions: [
      { req: {}, messageId: 1, at: 0, criticalState: { lastReminderAt: 5, lastReminderMessageId: 501, lastReminderChatId: -100 } },
      { req: {}, messageId: 2, at: 0, criticalState: { lastReminderMessageId: 502 } },
      { req: {}, messageId: 3, at: 0 },
    ],
  });
  const unanswered = JSON.stringify({ version: 1, messageId: 555, chatId: 7 });
  expect(legacyReminderMessages(questions, unanswered, CHAT)).toEqual([
    { chatId: -100, messageId: 501 },
    { chatId: CHAT, messageId: 502 },
    { chatId: 7, messageId: 555 },
  ]);
  expect(legacyReminderMessages(null, null, CHAT)).toEqual([]);
  expect(legacyReminderMessages('{bad', JSON.stringify({ messageId: null }), CHAT)).toEqual([]);
});
