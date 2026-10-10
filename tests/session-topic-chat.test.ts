// tg-cli#556 (5): `tg` uses the daemon's session topic only in the chat the daemon answered for.
import { expect, test } from 'bun:test';
import { sessionTopicInChat, type ResolvedSession } from '../features/cli/session-topic';

const session = (chatId: number | null): ResolvedSession => ({ key: 'cc:x', name: 'alpha', threadId: 42, chatId });

test('the topic is used in the daemon chat and ignored in another one', () => {
  expect(sessionTopicInChat(session(-100), -100)).toBe(42);
  expect(sessionTopicInChat(session(-100), -200)).toBeNull();
});

test('an answer from a daemon too old to name its chat is trusted', () => {
  expect(sessionTopicInChat(session(null), -200)).toBe(42);
});

test('a non-numeric TG_CHAT_ID (an @username) cannot be compared, so the topic is trusted', () => {
  expect(sessionTopicInChat(session(-100), undefined)).toBe(42);
});

test('no session or no topic gives no topic', () => {
  expect(sessionTopicInChat(null, -100)).toBeNull();
  expect(sessionTopicInChat({ ...session(-100), threadId: null }, -100)).toBeNull();
});
