// tests/report.test.ts — tg report: structured result-report formatting
// (the "/result-report" convention was repeatedly asked for but never wired
// to Telegram; this bridges tg --tag report to a required-field format).
import { expect, test } from 'bun:test';
import { buildReportSend, isReportError, isReportHelp, REPORT_USAGE } from '../features/cli/report';

test('no args returns help', () => {
  const result = buildReportSend([]);
  expect(isReportHelp(result)).toBe(true);
  if (isReportHelp(result)) expect(result.help).toBe(REPORT_USAGE);
});

test('-h and --help both return help', () => {
  expect(isReportHelp(buildReportSend(['-h']))).toBe(true);
  expect(isReportHelp(buildReportSend(['--help']))).toBe(true);
});

test('missing every field lists title, ticket-or-pr, impact, verify-cmd, verify-result', () => {
  const result = buildReportSend(['--dry-run']);
  expect(isReportError(result)).toBe(true);
  if (!isReportError(result)) throw new Error('expected error');
  expect(result.error).toContain('title (--title');
  expect(result.error).toContain('ticket or PR link');
  expect(result.error).toContain('user impact');
  expect(result.error).toContain('verification command');
  expect(result.error).toContain('verification result');
});

test('a --ticket alone satisfies the ticket-or-pr requirement (no --pr needed)', () => {
  const result = buildReportSend([
    '--title', 'Fix the thing',
    '--ticket', 'HYP-123',
    '--impact', 'users stop seeing the crash',
    '--verify-cmd', 'bun test tests/report.test.ts',
    '--verify-result', 'all green',
  ]);
  expect(isReportError(result)).toBe(false);
  expect(isReportHelp(result)).toBe(false);
});

test('a --pr alone (no --ticket) also satisfies the requirement', () => {
  const result = buildReportSend([
    '--title', 'Fix the thing',
    '--pr', 'alex-mextner/tg-cli#123',
    '--impact', 'users stop seeing the crash',
    '--verify-cmd', 'bun test',
    '--verify-result', 'all green',
  ]);
  expect(isReportError(result)).toBe(false);
});

test('valid input builds --tag report/--format html argv with the body last (no global --title)', () => {
  const result = buildReportSend([
    '--title', 'Fix the thing',
    '--ticket', 'HYP-123',
    '--impact', 'users stop seeing the crash',
    '--verify-cmd', 'bun test tests/report.test.ts',
    '--verify-result', 'all green',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  expect(result.argv.slice(0, 4)).toEqual(['--tag', 'report', '--format', 'html']);
  expect(result.argv).not.toContain('--title');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<h2>Fix the thing</h2>');
  expect(body).toContain('<b>Ticket:</b> HYP-123');
  expect(body).toContain('<h3>Why</h3>');
  expect(body).toContain('users stop seeing the crash');
  expect(body).toContain('<pre>bun test tests/report.test.ts</pre>');
  expect(body).toContain('all green');
});

test('an http(s) --ticket/--pr value is wrapped in a real <a href> link', () => {
  const result = buildReportSend([
    '--title', 'x', '--pr', 'https://git.hyperide.ai/ultrabricks/tg-cli/pulls/123',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<a href="https://git.hyperide.ai/ultrabricks/tg-cli/pulls/123">https://git.hyperide.ai/ultrabricks/tg-cli/pulls/123</a>');
});

test('a bare-number --pr value (e.g. "123") is normalized to #123 so autolink-prs can resolve it', () => {
  const result = buildReportSend([
    '--title', 'x', '--pr', '123',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<b>PR:</b> #123');
  expect(body).not.toContain('<b>PR:</b> 123<');
});

test('repeatable --evidence/--summary/--ticket/--pr all render as separate <li> items / link rows', () => {
  const result = buildReportSend([
    '--title', 'x',
    '--ticket', 'HYP-1', '--ticket', 'HYP-2',
    '--pr', 'org/repo#1',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
    '--summary', 'did a', '--summary', 'did b',
    '--evidence', 'log line 1', '--evidence', 'log line 2',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<b>Ticket:</b> HYP-1');
  expect(body).toContain('<b>Ticket:</b> HYP-2');
  expect(body).toContain('<b>PR:</b> <a href="https://git.hyperide.ai/org/repo/pulls/1">org/repo#1</a>');
  expect(body).toContain('<li>did a</li>');
  expect(body).toContain('<li>did b</li>');
  expect(body).toContain('<li>log line 1</li>');
  expect(body).toContain('<li>log line 2</li>');
});

test('user-supplied text is HTML-escaped in the body (no tag injection via --impact/--evidence)', () => {
  const result = buildReportSend([
    '--title', 'x', '--ticket', 'HYP-1',
    '--impact', '<script>alert(1)</script>',
    '--verify-cmd', 'x', '--verify-result', 'x',
    '--evidence', 'a & b < c',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  const body = result.argv[result.argv.length - 1];
  expect(body).not.toContain('<script>alert(1)</script>');
  expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(body).toContain('a &amp; b &lt; c');
});

test('passthrough flags (--reply-to, --subagent, --topic, --dry-run) are carried into argv before the body', () => {
  const result = buildReportSend([
    '--title', 'x', '--ticket', 'HYP-1', '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
    '--reply-to', '4821', '--subagent', 'worker-1', '--topic', '7', '--dry-run',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  expect(result.argv).toContain('--reply-to');
  expect(result.argv).toContain('4821');
  expect(result.argv).toContain('--subagent');
  expect(result.argv).toContain('worker-1');
  expect(result.argv).toContain('--topic');
  expect(result.argv).toContain('7');
  expect(result.argv).toContain('--dry-run');
  // body is still the LAST element even with passthrough flags present
  expect(result.argv[result.argv.length - 1]).toContain('<h2>x</h2>');
});

test('an unknown flag errors', () => {
  const result = buildReportSend(['--bogus', 'x']);
  expect(isReportError(result)).toBe(true);
});

test('a flag missing its value errors', () => {
  const result = buildReportSend(['--title']);
  expect(isReportError(result)).toBe(true);
});

test('a bare positional (not a flag) errors', () => {
  const result = buildReportSend(['just some text']);
  expect(isReportError(result)).toBe(true);
});

test('a title containing a ticket code (a natural report headline) never surfaces as a global --title argv token — avoids args.ts refusing --title with an embedded ticket reference', () => {
  const result = buildReportSend([
    '--title', 'HYP-123: fix crash on empty input',
    '--ticket', 'HYP-123',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  expect(result.argv).not.toContain('--title');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<h2>HYP-123: fix crash on empty input</h2>');
});

test('an empty-string value (e.g. an unset $VAR interpolated into a flag) is rejected like a missing value', () => {
  const result = buildReportSend(['--title', '', '--ticket', 'HYP-1', '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x']);
  expect(isReportError(result)).toBe(true);
  if (!isReportError(result)) throw new Error('expected error');
  expect(result.error).toContain('--title requires a value');
});

test('an empty-string --ticket is rejected rather than silently producing an empty link row', () => {
  const result = buildReportSend(['--title', 'x', '--ticket', '', '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x']);
  expect(isReportError(result)).toBe(true);
  if (!isReportError(result)) throw new Error('expected error');
  expect(result.error).toContain('--ticket requires a value');
});

test('a value that looks like a forgotten flag (a KNOWN flag name) is rejected as a missing value', () => {
  const result = buildReportSend([
    '--title', '--ticket', 'HYP-1', '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  expect(isReportError(result)).toBe(true);
  if (!isReportError(result)) throw new Error('expected error');
  expect(result.error).toContain('--title requires a value');
});

test('a legitimate value that merely starts with "--" (not a known flag name) is accepted verbatim', () => {
  const result = buildReportSend([
    '--title', 'x', '--ticket', 'HYP-1', '--impact', 'x', '--verify-cmd', 'x',
    '--verify-result', '--- 12 passed, 0 fail ---',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<pre>x</pre>');
  expect(body).toContain('--- 12 passed, 0 fail ---');
});

test('an "owner/repo#N" --pr value is rendered as a real Forgejo PR link with the readable text kept as the label', () => {
  const result = buildReportSend([
    '--title', 'x', '--pr', 'alex-mextner/tg-cli#456',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  if (isReportError(result) || isReportHelp(result)) throw new Error('expected a send result');
  const body = result.argv[result.argv.length - 1];
  expect(body).toContain('<a href="https://git.hyperide.ai/alex-mextner/tg-cli/pulls/456">alex-mextner/tg-cli#456</a>');
});

test('-h / --help anywhere in the argument list wins over the rest of the parse (not only as the first token)', () => {
  const midArgs = buildReportSend(['--title', 'x', '-h', '--ticket', 'HYP-1']);
  expect(isReportHelp(midArgs)).toBe(true);
  const trailingArgs = buildReportSend(['--title', 'x', '--impact', 'y', '--help']);
  expect(isReportHelp(trailingArgs)).toBe(true);
});
