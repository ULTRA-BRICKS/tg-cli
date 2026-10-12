// Explicit sending must not leak its verb or reinterpret literal message tokens.
import { expect, test } from 'bun:test';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { parseArgs } from '../features/cli/args';
import { applyFeatureFlags } from '../features/auto-attach/feature-flags';

function parse(args: string[]) { return parseArgs(args, '/tmp', '/tmp'); }

test('explicit send consumes only its leading verb', () => {
  const result = parse(['send', 'hello']);
  expect(result.action).toBe('send');
  if (result.action !== 'send') throw new Error('expected send');
  expect(result.caption).toBe('hello');
  const twice = parse(['send', 'send', 'hello']);
  if (twice.action !== 'send') throw new Error('expected send');
  expect(twice.caption).toBe('send hello');
});

test('sole send and quoted text beginning with send stay literal', () => {
  for (const [args, caption] of [[['send'], 'send'], [['send hello'], 'send hello'], [['get', '2199'], 'get 2199']] satisfies Array<[string[], string]>) {
    const result = parse(args);
    if (result.action !== 'send') throw new Error('expected send');
    expect(result.caption).toBe(caption);
  }
});

test('literal terminator protects info flags, attachment flags and command names', () => {
  const result = parse(['--', '--help', '--version', '--photo', 'private.txt', 'auth', 'user', 'logout']);
  expect(result.action).toBe('send');
  if (result.action !== 'send') throw new Error('expected send');
  expect(result.caption).toBe('--help --version --photo private.txt auth user logout');
  expect(result.items).toEqual([]);
});

test('feature extraction stops at the literal terminator', () => {
  expect(applyFeatureFlags(['--', '--feature', 'unknown', '--no-feature'])).toEqual({enable: [], disable: [], rest: ['--', '--feature', 'unknown', '--no-feature']});
});

test('sending flags preserve existing semantics', () => {
  for (const options of [['--format', 'html'], ['--tag', 'report'], ['--reply-to', '42'], ['--topic', '7'], ['--table'], ['--dry-run']]) {
    expect(parse(['send', ...options, 'hello'])).toEqual(parse([...options, 'hello']));
  }
});

test('empty explicit send, help and malformed options remain no-send actions', () => {
  expect(parse(['send', '']).action).toBe('help');
  expect(parse(['send', '--help']).action).toBe('help');
  expect(parse(['send', '--version']).action).toBe('version');
  for (const options of [['--unknown'], ['--format'], ['--reply-to'], ['--topic'], ['--photo'], ['--file']]) {
    expect(parse(['send', ...options]).action).toBe('error');
  }
});

test('body command names are text, and literal -- protects every info-only flag', () => {
  for (const words of [['auth', 'user', 'logout'], ['hooks', 'trust'], ['voice', 'setup'], ['report'], ['replies', 'user'], ['install-skill']]) {
    const result = parse(['send', ...words]);
    if (result.action !== 'send') throw new Error('expected send');
    expect(result.caption).toBe(words.join(' '));
  }
  for (const flag of ['--ls-emoji-helpers', '--detect-model', '--detect-agent', '--session-topic', '--format-help']) {
    const result = parse(['send', '--', flag]);
    if (result.action !== 'send') throw new Error('expected send');
    expect(result.caption).toBe(flag);
  }
});

test('caller can pin implicit mode before feature extraction changes the leading token', () => {
  const result = parseArgs(['send', 'hello'], '/tmp', '/tmp', { explicitSend: false });
  if (result.action !== 'send') throw new Error('expected send');
  expect(result.caption).toBe('send hello');
});

test('literal alias protects leading command words when Bun consumes a leading separator', () => {
  const flags = applyFeatureFlags(['--literal', 'send', '--feature', 'unknown', '--help']);
  expect(flags.enable).toEqual([]);
  const result = parse(flags.rest);
  if (result.action !== 'send') throw new Error('expected literal send');
  expect(result.caption).toBe('send --feature unknown --help');
});


test('attachment values cannot consume literal terminators even when matching files exist', () => {
  const cwd = tempDir('tg-literal-attachment-');
  try {
    for (const marker of ['--literal', '--']) {
      writeFileSync(join(cwd, marker), 'fixture');
      for (const flag of ['--file', '--photo']) {
        const result = parseArgs(['send', flag, marker, '--photo', 'private.png'], cwd, cwd);
        expect(result.action).toBe('error');
      }
      const explicitPath = parseArgs(['send', '--file', `./${marker}`, 'hello'], cwd, cwd);
      if (explicitPath.action !== 'send') throw new Error('expected explicit path send');
      expect(explicitPath.items).toHaveLength(1);
    }
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});
