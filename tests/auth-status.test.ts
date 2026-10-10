import { describe, expect, test } from 'bun:test';
import { botLabel, chatLabel, formatStatus } from '../features/auth/status';

// docs/specs/tg-auth.md §5 — what `tg auth status` prints.

describe('labels', () => {
  test('bot: @username (name) · id', () => {
    expect(botLabel({ id: 123, username: 'my_bot', first_name: 'My Bot' })).toBe('@my_bot (My Bot) · id 123');
  });

  test('private chat: first + last name, @username, type, id', () => {
    expect(chatLabel({ id: 42, type: 'private', first_name: 'Alex', last_name: 'M', username: 'alex' })).toBe(
      'Alex M (@alex) · private · id 42',
    );
  });

  test('group: title wins; no username → no @ part', () => {
    expect(chatLabel({ id: -100, type: 'supergroup', title: 'Ops', first_name: 'ignored' })).toBe('Ops · supergroup · id -100');
  });

  test('no name at all falls back to the id only', () => {
    expect(chatLabel({ id: 7, type: 'private' })).toBe('id 7 · private');
  });
});

describe('formatStatus', () => {
  const bot = { id: 123, username: 'my_bot', first_name: 'My Bot' };

  test('the full connected block', () => {
    const out = formatStatus({
      bot,
      chat: { kind: 'ok', chat: { id: 42, type: 'private', first_name: 'Alex', username: 'alex' } },
      envPath: '/h/.config/tg-cli/.env',
      daemonPid: 4242,
      fromEnvironment: [],
    });
    expect(out).toBe(
      [
        'bot:    @my_bot (My Bot) · id 123',
        'chat:   Alex (@alex) · private · id 42',
        'config: /h/.config/tg-cli/.env',
        'daemon: running (pid 4242)',
      ].join('\n'),
    );
  });

  test('unbound chat, stopped daemon, environment overrides flagged', () => {
    const out = formatStatus({
      bot,
      chat: { kind: 'unbound' },
      envPath: '/c/.env',
      daemonPid: null,
      fromEnvironment: ['TG_BOT_TOKEN'],
    });
    expect(out).toContain('chat:   not bound — run `tg auth`');
    expect(out).toContain('daemon: not running');
    expect(out).toContain('bot:    @my_bot (My Bot) · id 123 (TG_BOT_TOKEN from environment)');
  });

  test('unreachable chat names the Telegram description', () => {
    const out = formatStatus({
      bot,
      chat: { kind: 'error', id: '42', description: 'Bad Request: chat not found' },
      envPath: '/c/.env',
      daemonPid: null,
      fromEnvironment: ['TG_CHAT_ID'],
    });
    expect(out).toContain('chat:   id 42 — unreachable: Bad Request: chat not found (TG_CHAT_ID from environment)');
  });
});
