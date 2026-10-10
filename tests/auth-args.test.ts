import { describe, expect, test } from 'bun:test';
import { AUTH_USAGE, parseAuthArgs } from '../features/auth/args';

// docs/specs/tg-auth.md §2: `auth` is an exact-match leading token, so prose that
// merely starts with the word still sends as a message.

describe('parseAuthArgs — dispatch', () => {
  test('not an auth invocation → null (falls through to the send path)', () => {
    expect(parseAuthArgs(['hello'])).toBeNull();
    expect(parseAuthArgs(['auth is broken'])).toBeNull();
    expect(parseAuthArgs(['auth', 'is', 'broken'])).toBeNull();
    expect(parseAuthArgs(['auth', 'users'])).toBeNull();
    expect(parseAuthArgs([])).toBeNull();
  });

  test('bare `tg auth` → auto', () => {
    expect(parseAuthArgs(['auth'])).toEqual({ sub: 'auto', tokenFromStdin: false, timeoutSec: 300, test: false, yes: false });
  });

  test('subcommands; bot is an alias of login', () => {
    expect(parseAuthArgs(['auth', 'login'])).toMatchObject({ sub: 'login' });
    expect(parseAuthArgs(['auth', 'bot'])).toMatchObject({ sub: 'login' });
    expect(parseAuthArgs(['auth', 'status'])).toMatchObject({ sub: 'status' });
    expect(parseAuthArgs(['auth', 'logout'])).toMatchObject({ sub: 'logout' });
  });

  test('help forms', () => {
    expect(parseAuthArgs(['auth', '--help'])).toMatchObject({ sub: 'help' });
    expect(parseAuthArgs(['auth', '-h'])).toMatchObject({ sub: 'help' });
    expect(parseAuthArgs(['auth', 'login', '--help'])).toMatchObject({ sub: 'help' });
  });
});

describe('parseAuthArgs — flags', () => {
  test('--token, --token=, --token - (stdin)', () => {
    expect(parseAuthArgs(['auth', 'login', '--token', '1:abc'])).toMatchObject({ sub: 'login', token: '1:abc' });
    expect(parseAuthArgs(['auth', '--token=1:abc'])).toMatchObject({ sub: 'auto', token: '1:abc' });
    const fromStdin = parseAuthArgs(['auth', 'login', '--token', '-']);
    expect(fromStdin).toMatchObject({ tokenFromStdin: true });
    expect(fromStdin).not.toHaveProperty('token');
  });

  test('--timeout, --test, --yes', () => {
    expect(parseAuthArgs(['auth', 'login', '--timeout', '30', '--test'])).toMatchObject({ timeoutSec: 30, test: true });
    expect(parseAuthArgs(['auth', 'logout', '--yes'])).toMatchObject({ sub: 'logout', yes: true });
    expect(parseAuthArgs(['auth', 'logout', '-y'])).toMatchObject({ sub: 'logout', yes: true });
  });

  test('usage errors carry a message', () => {
    expect(parseAuthArgs(['auth', 'login', '--token'])).toEqual({ error: expect.stringContaining('--token') });
    expect(parseAuthArgs(['auth', 'login', '--timeout', '0'])).toEqual({ error: expect.stringContaining('--timeout') });
    expect(parseAuthArgs(['auth', 'login', '--timeout', 'x'])).toEqual({ error: expect.stringContaining('--timeout') });
    expect(parseAuthArgs(['auth', 'login', '--bogus'])).toEqual({ error: expect.stringContaining('--bogus') });
    expect(parseAuthArgs(['auth', 'status', 'extra'])).toEqual({ error: expect.stringContaining('extra') });
    expect(parseAuthArgs(['auth', 'status', '--token', '1:a'])).toEqual({ error: expect.stringContaining('--token') });
    expect(parseAuthArgs(['auth', 'logout', '--test'])).toEqual({ error: expect.stringContaining('--test') });
  });

  test('a value-taking flag never swallows the next flag (only `--token -` is a dash value)', () => {
    expect(parseAuthArgs(['auth', 'login', '--token', '--test'])).toEqual({ error: expect.stringContaining('--token') });
    expect(parseAuthArgs(['auth', 'login', '--timeout', '--test'])).toEqual({ error: expect.stringContaining('--timeout') });
    expect(parseAuthArgs(['auth', '--token', '-y'])).toEqual({ error: expect.stringContaining('--token') });
    expect(parseAuthArgs(['auth', 'login', '--timeout=30', '--test'])).toMatchObject({ timeoutSec: 30, test: true });
    expect(parseAuthArgs(['auth', 'login', '--token', '-'])).toMatchObject({ tokenFromStdin: true });
    // booleans take no value: `--yes=no` must not silently mean yes
    expect(parseAuthArgs(['auth', 'logout', '--yes=no'])).toEqual({ error: expect.stringContaining('--yes takes no value') });
    expect(parseAuthArgs(['auth', 'login', '--test=1'])).toEqual({ error: expect.stringContaining('--test takes no value') });
    expect(parseAuthArgs(['auth', 'logout', '--yes='])).toEqual({ error: expect.stringContaining('--yes takes no value') });
  });
});

// docs/specs/tg-auth.md §2 "One parser", §9: `tg auth user|caller …` is the same command.
describe('parseAuthArgs — user / caller accounts', () => {
  test('user and caller delegate to the account parser', () => {
    expect(parseAuthArgs(['auth', 'user'])).toEqual({ account: { kind: 'login', role: 'personal', qr: false, json: false } });
    expect(parseAuthArgs(['auth', 'caller', '--qr', '--expected-id', '42'])).toEqual({
      account: { kind: 'login', role: 'caller', qr: true, expectedId: '42', json: false },
    });
    expect(parseAuthArgs(['auth', 'caller', '--import-session', '/s/voice.session', '--import-config', '/s/.env'])).toEqual({
      account: { kind: 'import', role: 'caller', session: '/s/voice.session', config: '/s/.env', json: false },
    });
    expect(parseAuthArgs(['auth', 'user', '--import-session=/s/a b.session', '--import-config=/s/.env'])).toMatchObject({
      account: { kind: 'import', session: '/s/a b.session', config: '/s/.env' },
    });
    expect(parseAuthArgs(['auth', 'user', 'status', '--online'])).toEqual({
      account: { kind: 'status', role: 'personal', online: true, sourceIdle: false, json: false },
    });
    expect(parseAuthArgs(['auth', 'caller', 'logout'])).toEqual({ account: { kind: 'logout', role: 'caller', json: false } });
  });

  test('`tg auth user --help` is the one auth help', () => {
    expect(parseAuthArgs(['auth', 'user', '--help'])).toMatchObject({ sub: 'help' });
    expect(parseAuthArgs(['auth', 'caller', 'status', '-h'])).toMatchObject({ sub: 'help' });
  });

  test('account usage errors are auth usage errors pointing at `tg auth --help`', () => {
    for (const argv of [
      ['auth', 'user', '--import-session', 'x'],
      ['auth', 'user', '--qr', '--import-session', 'a', '--import-config', 'b'],
      ['auth', 'user', '--expected-id', 'abc'],
      ['auth', 'user', 'status', '--expected-id', '5'],
      ['auth', 'user', '--online'],
      ['auth', 'caller', 'logout', '--qr'],
      ['auth', 'user', 'constructor'],
      // a value flag followed by a flag: never a session path named `--qr`
      ['auth', 'user', '--import-session', '--qr'],
      ['auth', 'user', '--expected-id', '--qr'],
      ['auth', 'caller', '--import-session', 'a', '--import-config', '--json'],
      ['auth', 'user', '--qr=yes'],
    ]) {
      expect(parseAuthArgs(argv)).toEqual({ error: expect.stringContaining('tg auth --help') });
    }
  });
});

test('AUTH_USAGE is the one help for the bot and both accounts', () => {
  for (const s of ['tg auth user', 'tg auth caller', '--qr', '--import-session', 'status [--online]', 'mtproto', 'my.telegram.org']) {
    expect(AUTH_USAGE).toContain(s);
  }
});

describe('parseAuthArgs — unchanged surface', () => {
  test('bot subcommands never reach the account parser', () => {
    expect(parseAuthArgs(['auth', 'status'])).not.toHaveProperty('account');
    expect(parseAuthArgs(['auth', 'logout', '--yes'])).not.toHaveProperty('account');
  });
});

test('AUTH_USAGE documents every subcommand, flag and exit code', () => {
  for (const s of ['tg auth', 'login', 'status', 'logout', '--token', '--timeout', '--test', '--yes', '78', 'tg-auth.md']) {
    expect(AUTH_USAGE).toContain(s);
  }
  for (const code of ['0', '1', '2', '3', '4', '5']) expect(AUTH_USAGE).toMatch(new RegExp(`\\n\\s+${code}\\s`));
});
