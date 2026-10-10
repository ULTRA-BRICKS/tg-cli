// isLikelySlashCommand: which texts a bound topic passes to the harness verbatim
// (a slash command) instead of wrapping them as chat (#298).
import { expect, test } from 'bun:test';
import { isLikelySlashCommand } from '../features/tg-ctl/updates';

test('isLikelySlashCommand: plain commands, with or without args', () => {
  expect(isLikelySlashCommand('/compact')).toBe(true);
  expect(isLikelySlashCommand('/stop now')).toBe(true);
});

test('isLikelySlashCommand: Telegram group-chat @botname suffix is still a command (#298)', () => {
  expect(isLikelySlashCommand('/compact@my_tg_bot')).toBe(true);
  expect(isLikelySlashCommand('/stop@MyBot now')).toBe(true);
});

test('isLikelySlashCommand: paths and prose are not commands', () => {
  expect(isLikelySlashCommand('/etc/hosts is broken')).toBe(false);
  expect(isLikelySlashCommand('/1 thing')).toBe(false);
  expect(isLikelySlashCommand('/cmd@')).toBe(false);
  expect(isLikelySlashCommand('/cmd@bot/path')).toBe(false);
});
