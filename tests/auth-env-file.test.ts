import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { loadEnv } from '../features/config/env';
import { mergeEnvContent } from '../features/auth/env-file';

// docs/specs/tg-auth.md §6 — tg auth writes the SAME flat KEY=VALUE file the
// shared loader reads, and must never disturb anything it does not own.

describe('mergeEnvContent', () => {
  test('creates a file from nothing, one key per line, trailing newline', () => {
    expect(mergeEnvContent(null, { TG_BOT_TOKEN: '1:a', TG_CHAT_ID: '42' })).toBe('TG_BOT_TOKEN=1:a\nTG_CHAT_ID=42\n');
  });

  test('replaces an existing key in place and keeps comments, blanks, order and other keys', () => {
    const before = '# my tg config\nTG_EMOJI_IDS={"a":1}\n\nTG_CHAT_ID=1\nLINEAR_KEY=x\n';
    const after = mergeEnvContent(before, { TG_CHAT_ID: '42', TG_BOT_TOKEN: '9:z' });
    expect(after).toBe('# my tg config\nTG_EMOJI_IDS={"a":1}\n\nTG_CHAT_ID=42\nLINEAR_KEY=x\nTG_BOT_TOKEN=9:z\n');
  });

  test('a key written with spaces around = is still recognised and replaced', () => {
    expect(mergeEnvContent('TG_CHAT_ID = 1\n', { TG_CHAT_ID: '2' })).toBe('TG_CHAT_ID=2\n');
  });

  test('later duplicates of a replaced key are dropped (the loader would let the LAST win)', () => {
    expect(mergeEnvContent('TG_CHAT_ID=1\nA=b\nTG_CHAT_ID=3\n', { TG_CHAT_ID: '2' })).toBe('TG_CHAT_ID=2\nA=b\n');
  });

  test('a commented-out key is a comment, not a definition', () => {
    expect(mergeEnvContent('# TG_CHAT_ID=1\n', { TG_CHAT_ID: '2' })).toBe('# TG_CHAT_ID=1\nTG_CHAT_ID=2\n');
  });

  test('removes keys, every occurrence, and leaves the rest alone', () => {
    const before = 'TG_BOT_TOKEN=1:a\nKEEP=1\nTG_CHAT_ID=42\nTG_CHAT_ID=43\n';
    expect(mergeEnvContent(before, {}, ['TG_BOT_TOKEN', 'TG_CHAT_ID'])).toBe('KEEP=1\n');
  });

  test('a file without a trailing newline gets exactly one', () => {
    expect(mergeEnvContent('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  test('removing everything yields an empty file', () => {
    expect(mergeEnvContent('TG_CHAT_ID=1\n', {}, ['TG_CHAT_ID'])).toBe('');
  });

  test('refuses a value that would forge a second line', () => {
    expect(() => mergeEnvContent(null, { TG_CHAT_ID: '1\nTG_BOT_TOKEN=evil' })).toThrow(/newline/);
    expect(() => mergeEnvContent(null, { TG_CHAT_ID: '1\rX=2' })).toThrow(/newline/);
  });

  test('round-trips through the shared loader', () => {
    const content = mergeEnvContent('# c\nOTHER=v\n', { TG_BOT_TOKEN: '7:sec-ret_x', TG_CHAT_ID: '-1001' });
    const p = join(tempDir('tg-auth-env-'), '.env');
    writeFileSync(p, content);
    expect(loadEnv(p)).toEqual({ OTHER: 'v', TG_BOT_TOKEN: '7:sec-ret_x', TG_CHAT_ID: '-1001' });
  });
});
