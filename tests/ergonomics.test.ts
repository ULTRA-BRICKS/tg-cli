import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from '../features/cli/args';
import { VERSION } from '../tg';
import { tempDir } from './helpers/test-temp';

// Real temp files for existence checks — no Telegram API is ever touched.
let dir: string;
let imgAbs: string;
let pdfAbs: string;
const HOME = '/home/tester';

beforeAll(() => {
  dir = tempDir('tg-ergo-');
  imgAbs = join(dir, 'shot.PNG'); // uppercase ext → case-insensitive check
  pdfAbs = join(dir, 'report.pdf');
  writeFileSync(imgAbs, 'fake');
  writeFileSync(pdfAbs, 'fake');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- Ergonomic #2: help on empty / -h / --help anywhere ---
test('help wins anywhere; empty invocation resolves to help', () => {
  expect(parseArgs([], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['-h'], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['hi', '--help'], dir, HOME)).toEqual({ action: 'help' });
});

// --- Ergonomic #1: -v / --version ---
test('version flag wins anywhere', () => {
  expect(parseArgs(['-v'], dir, HOME)).toEqual({ action: 'version' });
  expect(parseArgs(['hi', '--version'], dir, HOME)).toEqual({ action: 'version' });
});

// The real script run as a subprocess: --version prints VERSION, a runtime git
// short hash (hex) or the graceful "unknown" fallback, and the latest CHANGELOG
// section. The version branch exits before any network call — no API hit. The
// hash is dynamic, so we assert robust tokens, not an exact byte match.
const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

for (const flag of ['--version', '-v']) {
  test(`${flag} prints version + git hash + changelog, exit 0, no creds needed`, () => {
    const proc = Bun.spawnSync(['bun', TG_SCRIPT, flag], {
      // No TG_BOT_TOKEN / TG_CHAT_ID — version must work without credentials.
      env: { PATH: process.env.PATH ?? '', HOME: tempDir('tg-cli-test-home-') },
    });
    const out = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(out).toContain(VERSION);
    expect(out).toMatch(/\b([0-9a-f]{7,40}|unknown)\b/);
    // Stable changelog marker — the version heading, not prose we might reword.
    expect(out).toContain(`## ${VERSION}`);
  });
}

// --- Ergonomic #5: unknown dashed token → error (reconciliation point) ---
test('unknown dashed token is an error, not plain text', () => {
  expect(parseArgs(['--foo'], dir, HOME)).toEqual({
    action: 'error',
    message: 'unknown flag: --foo',
  });
  // The first unknown flag in the args is reported; text after it is irrelevant.
  expect(parseArgs(['-x', 'hello'], dir, HOME)).toEqual({
    action: 'error',
    message: 'unknown flag: -x',
  });
});

test('--bogus unknown flag → error (not sent as text)', () => {
  expect(parseArgs(['--bogus'], dir, HOME)).toEqual({
    action: 'error',
    message: 'unknown flag: --bogus',
  });
});

// --- Regression: every real flag main supports is still recognized, NOT
// treated as an unknown-dashed error (the core reconciliation requirement). ---
test("main's real flags are all recognized (no unknown-flag regression)", () => {
  // --ls-emoji-helpers / --detect-model / --detect-agent win anywhere as dedicated actions.
  expect(parseArgs(['--ls-emoji-helpers'], dir, HOME)).toEqual({
    action: 'lsEmojiHelpers',
  });
  expect(parseArgs(['--detect-model'], dir, HOME)).toEqual({
    action: 'detectModel',
  });
  expect(parseArgs(['--detect-agent'], dir, HOME)).toEqual({
    action: 'detectAgent',
  });
  // --format is matched and validated, not errored as unknown.
  expect(parseArgs(['--format', 'html', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'html',
  });
  expect(parseArgs(['--format', 'plain', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'plain',
  });
  // --photo / --file are matched and consume a path value.
  expect(parseArgs(['--photo', imgAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: '',
    format: 'plain',
  });
  expect(parseArgs(['--file', pdfAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs }],
    caption: '',
    format: 'plain',
  });
  // --subagent (and its deprecated --agent alias) is matched and consumes a
  // value, same as --title/--tag.
  expect(parseArgs(['--subagent', 'sub-1', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'plain',
    subagent: 'sub-1',
  });
  expect(parseArgs(['--agent', 'sub-1', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'plain',
    subagent: 'sub-1',
  });
});

// --- --title / --tag flags (explicit header title + tag badge) ---
test('--title is parsed as an explicit title; the body is NEVER pulled up', () => {
  expect(parseArgs(['--title', 'Ship it', 'the body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'the body',
    format: 'plain',
    title: 'Ship it',
  });
  // Bare --title with no body still sends (a header-only message).
  expect(parseArgs(['--title', 'Just a header'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '',
    format: 'plain',
    title: 'Just a header',
  });
});

test('--tag is parsed; it composes with --title and with a body', () => {
  // A non-answer, non-escalation tag composes freely. (`answer` now REQUIRES
  // --reply-to, and `decision` now wants a literal table — both
  // covered in reply-table-args.test.ts — so this case uses `problem`.) Tags
  // are lowercase-english only (validated at parse time).
  expect(parseArgs(['--tag', 'problem', '--title', 'Done', 'body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    title: 'Done',
    tag: 'problem',
  });
  // Bare --tag with no body/title still sends.
  expect(parseArgs(['--tag', 'report'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '',
    format: 'plain',
    tag: 'report',
  });
});

test('--title / --tag require a value (a dashed next token is a missing value)', () => {
  expect(parseArgs(['--title'], dir, HOME)).toEqual({
    action: 'error',
    message: '--title requires a value',
  });
  expect(parseArgs(['--title', '--tag', 'X'], dir, HOME)).toEqual({
    action: 'error',
    message: '--title requires a value',
  });
  expect(parseArgs(['--tag'], dir, HOME)).toEqual({
    action: 'error',
    message: '--tag requires a value',
  });
});

test('--title refuses a tg#<id> reference (must move into the body)', () => {
  expect(parseArgs(['--title', 'see tg#5900', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a tg#<id> reference — move it into the message body.',
  });
  // Case-insensitive prefix, still refused — asserted on the MESSAGE (not just the error
  // action), and WITH a body token present, so this genuinely exercises the tg#-detection guard
  // rather than passing vacuously on the "missing body" error a bare --title would hit anyway.
  expect(parseArgs(['--title', 'TG#42 done', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a tg#<id> reference — move it into the message body.',
  });
  // A bare GitHub-style #42 (no `tg` prefix) is unaffected — only tg#<id> is banned.
  expect(parseArgs(['--title', 'closes #42', 'body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    title: 'closes #42',
  });
  // The reference must still land in the BODY without complaint.
  expect(parseArgs(['--title', 'Ship it', 'per tg#5900 do X'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'per tg#5900 do X',
    format: 'plain',
    title: 'Ship it',
  });
});

test('--title guard is gated on the SAME autolink-msgrefs feature flag as the body (tg-cli#138)', () => {
  // With the feature OFF, a tg#<id> in --title is inert plain text, exactly like the body
  // (`tg` gates the body's detectMsgRefs call on the identical flag) — not banned in one place
  // while freely allowed in the other.
  expect(parseArgs(['--title', 'see tg#5900', 'body'], dir, HOME, { msgrefAutolink: false })).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    title: 'see tg#5900',
  });
  // Default (flag omitted / on) still refuses — the guard is ON unless explicitly disabled.
  expect(parseArgs(['--title', 'see tg#5900', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a tg#<id> reference — move it into the message body.',
  });
});

test('--title refuses a HYP-<id> ticket reference (must move into the body)', () => {
  // A bare ticket code in the one-line header is inert (nothing linkifies it there) and
  // duplicates a body reference the reader can actually follow — same rule task-cli/gh-ship
  // enforce on a ticket/PR title (tg-cli#116, refs #6344-6350 "таски не размечены ссылками").
  expect(parseArgs(['--title', 'HYP-1234 done', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a ticket reference (HYP-1234) — move it into the message body.',
  });
  // Detected mid-title too, and the FIRST detected code names the offender.
  expect(parseArgs(['--title', 'fix ABC-7 then', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a ticket reference (ABC-7) — move it into the message body.',
  });
  // Compound list/range forms are caught too — the guard uses the SAME expanded detector the
  // body linkifies with, so a `/`-list (which the plain detector reads as a path) can't leak.
  expect(parseArgs(['--title', 'HYP-1/2/3 ship', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a ticket reference (HYP-1) — move it into the message body.',
  });
  expect(parseArgs(['--title', 'HYP-100..103 do', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a ticket reference (HYP-100) — move it into the message body.',
  });
  // GitHub-style `#N` is deliberately NOT a ticket code — a title `closes #42` is legitimate.
  expect(parseArgs(['--title', 'closes #42', 'body'], dir, HOME).action).toBe('send');
  // A path/line-spec token that merely contains a code shape is not a ticket mention.
  expect(parseArgs(['--title', 'edit HYP-1.ts:10 here', 'body'], dir, HOME).action).toBe('send');
  // The reference must still land in the BODY without complaint.
  expect(parseArgs(['--title', 'Ship it', 'per HYP-1234 do X'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'per HYP-1234 do X',
    format: 'plain',
    title: 'Ship it',
  });
});

test('--title HYP-<id> guard is gated on the autolink-tasks feature flag', () => {
  // With autolink-tasks OFF, a ticket code in --title is inert plain text, exactly like the
  // body (`tg` gates the body's detectTicketCodes call on the identical flag) — not banned in
  // one place while freely allowed in the other.
  expect(parseArgs(['--title', 'HYP-1234 done', 'body'], dir, HOME, { ticketAutolink: false })).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    title: 'HYP-1234 done',
  });
  // Default (flag omitted / on) still refuses.
  expect(parseArgs(['--title', 'HYP-1234 done', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: 'Refusing: --title contains a ticket reference (HYP-1234) — move it into the message body.',
  });
});

test('--tag rejects uppercase / Cyrillic / unknown with a 3-part error (lowercase-english only)', () => {
  for (const bad of ['ANSWER', 'Decision', 'ОТВЕТ', 'ПРОБЛЕМА', 'fixme']) {
    const r = parseArgs(['--tag', bad, 'body'], dir, HOME);
    expect(r.action).toBe('error');
    if (r.action === 'error') {
      expect(r.message).toContain(`invalid --tag '${bad}'`);
      expect(r.message).toContain('lowercase english');
      expect(r.message).toContain('Use one of: answer, decision, problem, report');
    }
  }
});

// --- code-as-pdf flags (--with-original / --no-pdf / --pdf-device) ---
test('--with-original / --no-pdf / --pdf-device are parsed (not unknown flags)', () => {
  expect(parseArgs(['--with-original', 'see code'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'see code',
    format: 'plain',
    withOriginal: true,
  });
  expect(parseArgs(['--no-pdf', 'raw only'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'raw only',
    format: 'plain',
    noPdf: true,
  });
  expect(parseArgs(['--pdf-device', 'a4', 'mobile'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'mobile',
    format: 'plain',
    pdfDevice: 'a4',
  });
});

test('--pdf-device requires a value', () => {
  expect(parseArgs(['--pdf-device'], dir, HOME)).toEqual({
    action: 'error',
    message: '--pdf-device requires a value',
  });
  expect(parseArgs(['--pdf-device', '--no-pdf'], dir, HOME)).toEqual({
    action: 'error',
    message: '--pdf-device requires a value',
  });
});

test('a no-code-flag parse result has none of the code-pdf fields (byte-identical)', () => {
  // Spreading undefined fields must NOT change a plain send object.
  expect(parseArgs(['hello'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hello',
    format: 'plain',
  });
});

// --- Regression: main's --format validation errors preserved (NOT changed) ---
test('--format validation errors are preserved from main', () => {
  expect(parseArgs(['--format'], dir, HOME)).toEqual({
    action: 'error',
    message: '--format requires plain or html',
  });
  expect(parseArgs(['--format', 'xml', 'hi'], dir, HOME)).toEqual({
    action: 'error',
    message: "unsupported format 'xml'. Accepted values: plain, html",
  });
});

// --- Regression: main's --photo/--file missing-path error preserved
// (this is where main's semantics differ from the reference branch, which
// returned help — we keep main's error). ---
test("--photo/--file with missing path → error (main's behavior, not help)", () => {
  expect(parseArgs(['--photo'], dir, HOME)).toEqual({
    action: 'error',
    message: '--photo requires a file path argument',
  });
  expect(parseArgs(['--file'], dir, HOME)).toEqual({
    action: 'error',
    message: '--file requires a file path argument',
  });
  // --photo followed by an unknown dashed token that is not a real file → the
  // flag has no valid path → error (the dashed token is in value position).
  expect(parseArgs(['--photo', '--foo'], dir, HOME)).toEqual({
    action: 'error',
    message: '--photo requires a file path argument',
  });
});

test('--file with a real dashed filename is still attached explicitly', () => {
  const dashed = join(dir, '-receipt.png');
  writeFileSync(dashed, 'fake');
  // Even though it starts with "-", it resolves to a real file → kept as the
  // explicit --file document (NOT reclassified as a photo by extension).
  expect(parseArgs(['--file', dashed], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: dashed }],
    caption: '',
    format: 'plain',
  });
  rmSync(dashed, { force: true });
});

test('--photo with a real RELATIVE dashed filename still attaches (flag value, not unknown flag)', () => {
  writeFileSync(join(dir, '-realfile.png'), 'fake');
  expect(parseArgs(['--photo', '-realfile.png'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: '-realfile.png' }],
    caption: '',
    format: 'plain',
  });
  rmSync(join(dir, '-realfile.png'), { force: true });
});

// --- Paths in the message text are NEVER attached (tg-cli#648) ---
// A token naming an existing file stays plain text; only explicit --photo/--file
// attach. Each shape the old text scanner resolved is pinned here.
test('absolute image path in text → NOT attached, stays in caption', () => {
  expect(parseArgs(['look', imgAbs, 'here'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: `look ${imgAbs} here`,
    format: 'plain',
  });
});

test('absolute non-image path in text → NOT attached', () => {
  expect(parseArgs([pdfAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: pdfAbs,
    format: 'plain',
  });
});

test('relative existing file in text → NOT attached', () => {
  expect(parseArgs(['shot.PNG'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'shot.PNG',
    format: 'plain',
  });
});

test('path inside a quoted single argv token → NOT attached', () => {
  expect(parseArgs([`look at ${imgAbs} please`], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: `look at ${imgAbs} please`,
    format: 'plain',
  });
});

test('non-existent path token stays as text', () => {
  expect(parseArgs(['/nope/does-not-exist.png', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '/nope/does-not-exist.png hi',
    format: 'plain',
  });
});

test('ordinary words that are not files stay as text', () => {
  expect(parseArgs(['hello', 'world'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hello world',
    format: 'plain',
  });
});

test('directory token is NOT treated as a file', () => {
  expect(parseArgs([dir, 'msg'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: `${dir} msg`,
    format: 'plain',
  });
});

test('~ home path to a real file in text → NOT attached', () => {
  // home = dir for this case so ~/shot.PNG names imgAbs.
  expect(parseArgs(['~/shot.PNG'], '/some/other/cwd', dir)).toEqual({
    action: 'send',
    items: [],
    caption: '~/shot.PNG',
    format: 'plain',
  });
});

test('explicit --photo attaches once; the same path in the text adds nothing', () => {
  expect(parseArgs(['--photo', imgAbs, imgAbs, 'cap'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: `${imgAbs} cap`,
    format: 'plain',
  });
});

test('explicit --file plus another existing path in the text → only the --file attaches', () => {
  expect(parseArgs(['--file', pdfAbs, imgAbs, 'both'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs }],
    caption: `${imgAbs} both`,
    format: 'plain',
  });
});

// --- Whitespace preservation (caption formatting) ---
test('plain multi-line / multi-space text preserves whitespace exactly', () => {
  const msg = 'line1\nline2\n\n  indented';
  expect(parseArgs([msg], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: msg,
    format: 'plain',
  });
  expect(parseArgs(['a    b'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'a    b',
    format: 'plain',
  });
});

test('caption around a path keeps the path AND surrounding formatting, nothing attached', () => {
  expect(parseArgs([`top\n${imgAbs}\nbottom`], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: `top\n${imgAbs}\nbottom`,
    format: 'plain',
  });
});

// --- Line-spec: only for an explicitly attached file ---
test('line-spec :N on an existing file in the text → NOT attached', () => {
  const tsAbs = join(dir, 'mod.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne');
  expect(parseArgs([`see ${tsAbs}:3`], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: `see ${tsAbs}:3`,
    format: 'plain',
  });
  rmSync(tsAbs, { force: true });
});

test('line-spec :N-M range and :N:C column parse onto an explicit --file item', () => {
  const tsAbs = join(dir, 'mod2.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne\nf');
  const range = parseArgs(['--file', tsAbs, `${tsAbs}:2-4`], dir, HOME);
  expect(range.action).toBe('send');
  if (range.action === 'send') {
    expect(range.items[0].lineSpec).toEqual({
      token: `${tsAbs}:2-4`,
      startLine: 2,
      endLine: 4,
      col: undefined,
    });
  }
  const col = parseArgs(['--file', tsAbs, `${tsAbs}:2:5`], dir, HOME);
  expect(col.action).toBe('send');
  if (col.action === 'send') {
    expect(col.items[0].lineSpec).toEqual({
      token: `${tsAbs}:2:5`,
      startLine: 2,
      endLine: 2,
      col: 5,
    });
  }
  rmSync(tsAbs, { force: true });
});

// GitHub permalink-anchor forms a human pastes (file#L10 / file#L10-L20) land on
// an explicit --file item just like the colon forms (tg#29).
test('line-spec #L GitHub anchor adopts onto an explicit --file item', () => {
  const tsAbs = join(dir, 'mod3.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne\nf');
  const single = parseArgs(['--file', tsAbs, `see ${tsAbs}#L3`], dir, HOME);
  expect(single.action).toBe('send');
  if (single.action === 'send') {
    expect(single.items[0].lineSpec).toEqual({
      token: `${tsAbs}#L3`,
      startLine: 3,
      endLine: 3,
      col: undefined,
    });
    expect(single.caption).toBe(`see ${tsAbs}#L3`);
  }
  const range = parseArgs(['--file', tsAbs, `${tsAbs}#L2-L4`], dir, HOME);
  expect(range.action).toBe('send');
  if (range.action === 'send') {
    expect(range.items[0].lineSpec).toEqual({
      token: `${tsAbs}#L2-L4`,
      startLine: 2,
      endLine: 4,
      col: undefined,
    });
  }
  rmSync(tsAbs, { force: true });
});

test('a relative line-spec mention adopts onto an explicit --file given relative', () => {
  const tsAbs = join(dir, 'rel.ts');
  writeFileSync(tsAbs, 'a\nb\nc');
  const r = parseArgs(['--file', './rel.ts', 'see (rel.ts:2)'], dir, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items).toEqual([
      { type: 'document', path: './rel.ts', lineSpec: { token: '(rel.ts:2)', startLine: 2, endLine: 2, col: undefined } },
    ]);
  }
  rmSync(tsAbs, { force: true });
});

test('a line-spec adopts onto an explicit --file whose absolute path has ../ segments', () => {
  const tsAbs = join(dir, 'norm.ts');
  writeFileSync(tsAbs, 'a\nb\nc');
  const dotted = `${dir}/../${dir.split('/').pop()}/norm.ts`;
  const r = parseArgs(['--file', dotted, `see ${tsAbs}:1`], dir, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items[0].lineSpec).toEqual({ token: `${tsAbs}:1`, startLine: 1, endLine: 1, col: undefined });
  }
  rmSync(tsAbs, { force: true });
});

test('a line-spec naming a different file than the --file is plain text', () => {
  const r = parseArgs(['--file', pdfAbs, 'bug at /nope/x.ts:42'], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs }],
    caption: 'bug at /nope/x.ts:42',
    format: 'plain',
  });
});

test('line-spec mention of an already --file-attached file adopts the spec', () => {
  const tsAbs = join(dir, 'adopt.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne');
  // --file attaches with no spec; the text mention carries :3 → adopted.
  const r = parseArgs(['--file', tsAbs, `see ${tsAbs}:3`], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [
      {
        type: 'document',
        path: tsAbs,
        lineSpec: { token: `${tsAbs}:3`, startLine: 3, endLine: 3, col: undefined },
      },
    ],
    caption: `see ${tsAbs}:3`,
    format: 'plain',
  });
  rmSync(tsAbs, { force: true });
});

test('explicit --file with no spec in the text has NO lineSpec field', () => {
  const r = parseArgs(['--file', pdfAbs, 'see it'], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs }],
    caption: 'see it',
    format: 'plain',
  });
  // No spec: the lineSpec field is absent, not undefined.
  if (r.action === 'send') expect('lineSpec' in r.items[0]).toBe(false);
});

// --- --topic <id> (forum-topics increment 2): parse + validation + back-compat ---
test('--topic <id> parses a positive topic id onto the send result', () => {
  const r = parseArgs(['--topic', '7', 'hi'], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'plain',
    topic: 7,
  });
});

test('--topic composes with --reply-to (a threaded reply INSIDE a topic)', () => {
  const r = parseArgs(['--topic', '7', '--reply-to', '1234', '--tag', 'answer', 'a'], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [],
    caption: 'a',
    format: 'plain',
    tag: 'answer',
    replyTo: 1234,
    topic: 7,
  });
});

test('--topic with a non-positive / non-numeric id is a parse error', () => {
  expect(parseArgs(['--topic', '0', 'x'], dir, HOME).action).toBe('error');
  expect(parseArgs(['--topic', '-3', 'x'], dir, HOME).action).toBe('error');
  expect(parseArgs(['--topic', 'abc', 'x'], dir, HOME).action).toBe('error');
});

test('--topic without a value is a parse error', () => {
  expect(parseArgs(['--topic'], dir, HOME)).toEqual({
    action: 'error',
    message: '--topic requires a topic id',
  });
});

test('a bare --topic (no body) resolves to help, not an empty send', () => {
  // --topic is a pure routing modifier — with nothing to post it is an empty
  // invocation (like no flag at all), not a header-only send.
  expect(parseArgs(['--topic', '7'], dir, HOME)).toEqual({ action: 'help' });
});

test('REGRESSION: a no-topic send leaves topic undefined (1:1 path unchanged)', () => {
  // toEqual ignores undefined-valued keys, so the result is shape-equal to the
  // pre-feature send shape; the entrypoint reads `topic` as undefined and stamps
  // no message_thread_id (the wire-level byte-identical guarantee is proven in
  // cli-topic-send.test.ts). The `topic` key being present-but-undefined matches
  // how the result already carries replyTo/pdfDevice when unset.
  const r = parseArgs(['just a message'], dir, HOME);
  expect(r).toEqual({ action: 'send', items: [], caption: 'just a message', format: 'plain' });
  if (r.action === 'send') expect(r.topic).toBeUndefined();
});
