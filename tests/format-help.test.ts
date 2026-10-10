import { expect, test } from 'bun:test';
import { FORMAT_HELP, formatHelp } from '../features/render/format-help';

test('formatHelp returns the reference constant', () => {
  expect(formatHelp()).toBe(FORMAT_HELP);
});

test('lists the supported HTML tags with examples', () => {
  for (const tag of [
    '<b>',
    '<i>',
    '<u>',
    '<s>',
    '<code>',
    '<pre>',
    '<a href',
    '<blockquote',
    '<tg-emoji',
    'tg-spoiler',
  ]) {
    expect(FORMAT_HELP).toContain(tag);
  }
});

test('documents the recognized HTML entities tier-specifically', () => {
  // Basic send: only the four. Rich send: the expanded set. The help must make
  // the distinction (basic does NOT accept &nbsp; etc.).
  expect(FORMAT_HELP).toContain('&lt;');
  expect(FORMAT_HELP).toContain('&gt;');
  expect(FORMAT_HELP).toContain('&amp;');
  expect(FORMAT_HELP).toContain('&quot;');
  expect(FORMAT_HELP).toMatch(/BASIC/);
  expect(FORMAT_HELP).toContain('&nbsp;');
});

test('documents native tables via rich --format html (NOT "no tables")', () => {
  // Bot API 10.1 added Rich Messages: <table> in --format html IS supported and
  // auto-routes to a native bordered table. The old "Telegram has NO tables"
  // claim must be gone.
  expect(FORMAT_HELP).toContain('<table');
  expect(FORMAT_HELP).not.toMatch(/NO tables|no native HTML tables|has NO tables/i);
  expect(FORMAT_HELP).toMatch(/Rich Message|rich message/);
});

test('explains that --format html auto-routes rich tags to a Rich Message', () => {
  expect(FORMAT_HELP).toMatch(/sendRichMessage/);
  // A rich tag set is listed: headings + lists + formulas.
  expect(FORMAT_HELP).toContain('<h1>');
  expect(FORMAT_HELP).toContain('<ul>');
  expect(FORMAT_HELP).toMatch(/tg-math/);
});

test('documents the rich-message limits', () => {
  expect(FORMAT_HELP).toContain('32768');
  expect(FORMAT_HELP).toMatch(/500 blocks/);
  expect(FORMAT_HELP).toMatch(/20 table columns/);
});

test('keeps the <pre> monospace --table fallback', () => {
  expect(FORMAT_HELP).toContain('<pre>');
  expect(FORMAT_HELP).toContain('--table');
});

test('documents the --tag/--title badge and --reply-to', () => {
  expect(FORMAT_HELP).toContain('--tag');
  expect(FORMAT_HELP).toContain('--title');
  expect(FORMAT_HELP).toContain('--reply-to');
});

test('notes the one-emoji rule for tg-emoji', () => {
  expect(FORMAT_HELP).toMatch(/EXACTLY ONE emoji|exactly one emoji|one emoji/i);
});

// tg-cli#221: the escalation gate checks the TEXT only — the help must say a
// --file/--photo attachment does not satisfy "where to look".
test('the decision-format help states that an attachment does not count as where-to-look', () => {
  expect(FORMAT_HELP).toContain('attachment does not count');
  expect(FORMAT_HELP).toContain('A bare path');
});
