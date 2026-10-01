import { expect, test } from 'bun:test';
import { parseArgs } from '../features/cli/args';

const HOME = '/home/tester';
const dir = '/tmp/tg-agent-flag-args-nonexistent-dir';

test('--subagent <name> is parsed and composes with a body', () => {
  expect(parseArgs(['--subagent', 'hyperide-fixer', 'the body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'the body',
    format: 'plain',
    subagent: 'hyperide-fixer',
  });
});

// Deprecated alias: `--agent` still parses to the same `subagent` field so
// in-flight callers/skills don't break mid-rename.
test('deprecated --agent alias still parses to the subagent field', () => {
  expect(parseArgs(['--agent', 'hyperide-fixer', 'the body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'the body',
    format: 'plain',
    subagent: 'hyperide-fixer',
  });
});

// Bare --subagent with no body still sends (a header-only message), same as
// --title/--tag — the "empty invocation" gate treats it as real content.
test('bare --subagent with no body still sends (header-only)', () => {
  expect(parseArgs(['--subagent', 'sub-3'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '',
    format: 'plain',
    subagent: 'sub-3',
  });
});

test('--subagent composes with --title and --tag', () => {
  expect(parseArgs(['--subagent', 'sub-1', '--tag', 'report', '--title', 'Done', 'body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    subagent: 'sub-1',
    tag: 'report',
    title: 'Done',
  });
});

test('--subagent requires a value (a dashed next token is a missing value)', () => {
  expect(parseArgs(['--subagent'], dir, HOME)).toEqual({
    action: 'error',
    message: '--subagent requires a value',
  });
  expect(parseArgs(['--subagent', '--tag', 'report'], dir, HOME)).toEqual({
    action: 'error',
    message: '--subagent requires a value',
  });
});

// The deprecated alias reports its OWN flag name in the error, not --subagent —
// covered for BOTH the bare and the dashed-next-token path so a future "simplify
// the error to a literal" refactor can't silently regress the alias self-naming.
test('deprecated --agent alias requires a value and names itself in the error', () => {
  expect(parseArgs(['--agent'], dir, HOME)).toEqual({
    action: 'error',
    message: '--agent requires a value',
  });
  expect(parseArgs(['--agent', '--tag', 'report'], dir, HOME)).toEqual({
    action: 'error',
    message: '--agent requires a value',
  });
});

// A whitespace-only value must be REJECTED like a missing one — trimming it to
// '' would otherwise fall through to TG_AGENT in the entrypoint, breaking
// "explicit flag wins".
test('--subagent rejects a whitespace-only value (not silently emptied)', () => {
  expect(parseArgs(['--subagent', '   ', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: '--subagent requires a value',
  });
  expect(parseArgs(['--subagent', '\t'], dir, HOME)).toEqual({
    action: 'error',
    message: '--subagent requires a value',
  });
});

test('--detect-agent wins anywhere as a dedicated info action', () => {
  expect(parseArgs(['--detect-agent'], dir, HOME)).toEqual({ action: 'detectAgent' });
  expect(parseArgs(['hi', '--detect-agent'], dir, HOME)).toEqual({ action: 'detectAgent' });
});

test('--session-topic wins anywhere as a dedicated info action', () => {
  expect(parseArgs(['--session-topic'], dir, HOME)).toEqual({ action: 'sessionTopic' });
  expect(parseArgs(['hi', '--session-topic'], dir, HOME)).toEqual({ action: 'sessionTopic' });
});

test('--subagent value is trimmed', () => {
  expect(parseArgs(['--subagent', '  padded-name  ', 'body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    subagent: 'padded-name',
  });
});
