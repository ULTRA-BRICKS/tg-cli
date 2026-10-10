import { expect, test } from 'bun:test';
import { parseRepliesArgs, parseDateArg } from '../features/replies/args';

test('parseRepliesArgs: bare `replies` → direction=user, action=list, scope=session, limit 20', () => {
  const a = parseRepliesArgs([]);
  expect(a.kind).toBe('query');
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('list');
  expect(a.allSessions).toBe(false);
  expect(a.session).toBeUndefined();
  expect(a.limit).toBe(20);
  expect(a.full).toBe(false);
  expect(a.json).toBe(false);
  expect(a.query).toBeUndefined();
  expect(a.regex).toBe(false);
});

test('parseRepliesArgs: explicit direction `agent`', () => {
  const a = parseRepliesArgs(['agent']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('agent');
  expect(a.action).toBe('list');
});

test('parseRepliesArgs: explicit direction `all`', () => {
  const a = parseRepliesArgs(['all']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('all');
});

test('parseRepliesArgs: `list` alone keeps default direction user', () => {
  const a = parseRepliesArgs(['list']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('list');
});

test('parseRepliesArgs: `user list`', () => {
  const a = parseRepliesArgs(['user', 'list']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('list');
});

test('parseRepliesArgs: `find <query>` defaults direction user and joins the rest of argv', () => {
  const a = parseRepliesArgs(['find', 'deploy', 'the', 'thing']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('find');
  expect(a.query).toBe('deploy the thing');
});

test('parseRepliesArgs: `all find foo`', () => {
  const a = parseRepliesArgs(['all', 'find', 'foo']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('all');
  expect(a.action).toBe('find');
  expect(a.query).toBe('foo');
});

test('parseRepliesArgs: find with no query is an error', () => {
  const a = parseRepliesArgs(['find']);
  expect(a.kind).toBe('error');
});

test('parseRepliesArgs: -n / --limit override', () => {
  expect((parseRepliesArgs(['-n', '5']) as { limit: number }).limit).toBe(5);
  expect((parseRepliesArgs(['--limit', '99']) as { limit: number }).limit).toBe(99);
  expect((parseRepliesArgs(['user', 'list', '--limit', '3']) as { limit: number }).limit).toBe(3);
});

test('parseRepliesArgs: invalid limit is an error', () => {
  expect(parseRepliesArgs(['-n', 'abc']).kind).toBe('error');
  expect(parseRepliesArgs(['-n', '0']).kind).toBe('error');
  expect(parseRepliesArgs(['-n', '-4']).kind).toBe('error');
});

test('parseRepliesArgs: --full, --json, --regex, --all-sessions flags', () => {
  const a = parseRepliesArgs(['all', 'find', 'x', '--full', '--json', '--regex', '--all-sessions']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.full).toBe(true);
  expect(a.json).toBe(true);
  expect(a.regex).toBe(true);
  expect(a.allSessions).toBe(true);
});

test('parseRepliesArgs: --session <pane> sets explicit pane scope', () => {
  const a = parseRepliesArgs(['--session', '%7']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.session).toBe('%7');
  expect(a.allSessions).toBe(false);
});

test('parseRepliesArgs: --session <windowName> stores the raw value verbatim (interpreted at resolution)', () => {
  const a = parseRepliesArgs(['--session', 'ext']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.session).toBe('ext');
  expect(a.allSessions).toBe(false);
});

test('parseRepliesArgs: --session preserves a window name with spaces', () => {
  const a = parseRepliesArgs(['--session', 'ext: diagram']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.session).toBe('ext: diagram');
});

test('parseRepliesArgs: --session requires a value; error names window OR pane', () => {
  const a = parseRepliesArgs(['--session']);
  expect(a.kind).toBe('error');
  if (a.kind === 'error') {
    expect(a.message.toLowerCase()).toContain('window');
    expect(a.message.toLowerCase()).toContain('pane');
  }
});

test('parseRepliesArgs: --help → help action', () => {
  expect(parseRepliesArgs(['--help']).kind).toBe('help');
  expect(parseRepliesArgs(['-h']).kind).toBe('help');
});

test('parseRepliesArgs: flags may appear before positionals', () => {
  const a = parseRepliesArgs(['--json', 'agent', 'find', 'ship']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('agent');
  expect(a.action).toBe('find');
  expect(a.query).toBe('ship');
  expect(a.json).toBe(true);
});

test('parseRepliesArgs: regex query keeps spaces and special chars verbatim', () => {
  const a = parseRepliesArgs(['user', 'find', 'foo.*bar', '--regex']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.query).toBe('foo.*bar');
  expect(a.regex).toBe(true);
});

test('parseRepliesArgs: unknown flag is an error', () => {
  expect(parseRepliesArgs(['--nope']).kind).toBe('error');
});

// parseDateArg

test('parseDateArg: ISO date resolves to midnight UTC of that day', () => {
  const ts = parseDateArg('2026-06-28');
  expect(ts).toBe(Date.parse('2026-06-28T00:00:00Z') / 1000);
});

test('parseDateArg: ISO datetime (YYYY-MM-DDTHH:MM) resolves to that UTC moment', () => {
  const ts = parseDateArg('2026-06-28T10:30');
  expect(ts).toBe(Date.parse('2026-06-28T10:30:00Z') / 1000);
});

test('parseDateArg: relative Nd resolves to now minus N days', () => {
  const now = 1_000_000;
  expect(parseDateArg('3d', now)).toBe(now - 3 * 86400);
  expect(parseDateArg('7d', now)).toBe(now - 7 * 86400);
});

test('parseDateArg: relative Nh resolves to now minus N hours', () => {
  const now = 1_000_000;
  expect(parseDateArg('24h', now)).toBe(now - 24 * 3600);
  expect(parseDateArg('1h', now)).toBe(now - 3600);
});

test('parseDateArg: invalid string returns null', () => {
  expect(parseDateArg('bogus')).toBeNull();
  expect(parseDateArg('2026-99-99')).toBeNull(); // invalid calendar date
  expect(parseDateArg('yesterday')).toBeNull();
});

test('parseDateArg: ISO datetime with trailing Z or +00:00 equals the bare UTC form (#524)', () => {
  const bare = parseDateArg('2026-09-29T16:45:00');
  expect(bare).not.toBeNull();
  expect(parseDateArg('2026-09-29T16:45:00Z')).toBe(bare);
  expect(parseDateArg('2026-09-29T16:45:00+00:00')).toBe(bare);
  expect(parseDateArg('2026-09-29T16:45Z')).toBe(parseDateArg('2026-09-29T16:45'));
  expect(parseDateArg('2026-09-29T16:45:00.000Z')).toBe(bare);
  expect(parseDateArg('2026-09-29T16:45:00+03:00')).toBe(bare! - 3 * 3600); // other offsets honoured, not misread as UTC
});

// parseRepliesArgs --since / --until

test('parseRepliesArgs: --since ISO date sets since field', () => {
  const a = parseRepliesArgs(['--since', '2026-06-28']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.since).toBe(Date.parse('2026-06-28T00:00:00Z') / 1000);
  expect(a.until).toBeUndefined();
});

test('parseRepliesArgs: --until ISO date sets until field', () => {
  const a = parseRepliesArgs(['--until', '2026-06-30']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.until).toBe(Date.parse('2026-06-30T00:00:00Z') / 1000);
  expect(a.since).toBeUndefined();
});

test('parseRepliesArgs: --since and --until together', () => {
  const a = parseRepliesArgs(['--since', '2026-06-28', '--until', '2026-06-30']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.since).toBe(Date.parse('2026-06-28T00:00:00Z') / 1000);
  expect(a.until).toBe(Date.parse('2026-06-30T00:00:00Z') / 1000);
});

test('parseRepliesArgs: --since with relative value (3d)', () => {
  const a = parseRepliesArgs(['--since', '3d']);
  if (a.kind !== 'query') throw new Error('unreachable');
  // just verify it's a number and within a sane range (now - 3d ± 5s)
  const expected = Math.floor(Date.now() / 1000) - 3 * 86400;
  expect(a.since).toBeDefined();
  expect(Math.abs((a.since as number) - expected)).toBeLessThan(5);
});

test('parseRepliesArgs: --since missing value is an error', () => {
  expect(parseRepliesArgs(['--since']).kind).toBe('error');
});

test('parseRepliesArgs: --until missing value is an error', () => {
  expect(parseRepliesArgs(['--until']).kind).toBe('error');
});

test('parseRepliesArgs: --since with invalid date is an error', () => {
  const a = parseRepliesArgs(['--since', 'yesterday']);
  expect(a.kind).toBe('error');
  if (a.kind === 'error') expect(a.message).toContain('--since');
});

test('parseRepliesArgs: --until with invalid date is an error', () => {
  const a = parseRepliesArgs(['--until', 'bogus']);
  expect(a.kind).toBe('error');
  if (a.kind === 'error') expect(a.message).toContain('--until');
});
