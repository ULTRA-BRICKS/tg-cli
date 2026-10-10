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

  test('a value-taking flag never swallows the next flag; on/off flags take no value', () => {
    expect(parseAuthArgs(['auth', 'login', '--token', '--test'])).toEqual({ error: expect.stringContaining("'--test'") });
    expect(parseAuthArgs(['auth', 'login', '--timeout', '-5'])).toEqual({ error: expect.stringContaining('--timeout') });
    expect(parseAuthArgs(['auth', 'login', '--token=-abc'])).toMatchObject({ token: '-abc' });
    expect(parseAuthArgs(['auth', 'login', '--token', '-'])).toMatchObject({ tokenFromStdin: true });
    expect(parseAuthArgs(['auth', 'logout', '--yes=no'])).toEqual({ error: expect.stringContaining('--yes') });
    expect(parseAuthArgs(['auth', 'login', '--test=0'])).toEqual({ error: expect.stringContaining('--test') });
  });
});

test('AUTH_USAGE documents every subcommand, flag and exit code', () => {
  for (const s of ['tg auth', 'login', 'status', 'logout', '--token', '--timeout', '--test', '--yes', '78', 'tg-auth.md']) {
    expect(AUTH_USAGE).toContain(s);
  }
  for (const code of ['0', '1', '2', '3', '4', '5']) expect(AUTH_USAGE).toMatch(new RegExp(`\\n\\s+${code}\\s`));
});
