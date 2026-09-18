import { expect, test } from 'bun:test';
import { join } from 'path';

// Run the real `tg` script as a subprocess for the no-send actions/errors that
// resolve BEFORE the Telegram credential gate — so no API is ever touched and no
// creds are needed (mirrors the --version subprocess test in ergonomics.test.ts).

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const NO_CREDS_ENV = { PATH: process.env.PATH ?? '', HOME: '/tmp/tg-cli-test-home' };

function run(args: string[], stdin?: string) {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env: NO_CREDS_ENV,
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
  });
}

test('tg help format prints the formatting reference and exits 0 (no creds needed)', () => {
  const proc = run(['help', 'format']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Telegram message formatting');
  expect(out).toContain('--table');
  expect(out).toContain('&lt;');
  expect(out).toContain('<tg-emoji');
});

test('--format-help still works as a back-compat alias for `tg help format`', () => {
  // The flag is replaced by the topic-help convention but kept as an undocumented
  // alias so older scripts/skills that learned `--format-help` do not break.
  const flag = run(['--format-help']).stdout.toString();
  const topic = run(['help', 'format']).stdout.toString();
  expect(flag).toBe(topic);
  expect(flag).toContain('Telegram message formatting');
});

test('bare `tg help` prints the main help (lists the format topic) and exits 0', () => {
  const proc = run(['help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Usage:');
  expect(out).toContain('tg help <topic>');
  expect(out).toContain('format');
});

test('`tg help <unknown>` errors with a 3-part message and exits non-zero', () => {
  const proc = run(['help', 'bogus']);
  expect(proc.exitCode).not.toBe(0);
  const err = proc.stderr.toString();
  expect(err).toContain("unknown help topic 'bogus'");
  expect(err).toContain('Available topics: format');
});

test('--help advertises `tg help format`, --table, --reply-to and --topic', () => {
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  // The canonical topic-help form is advertised (not a bespoke --format-help flag).
  expect(out).toContain('tg help format');
  expect(out).toContain('--table');
  expect(out).toContain('--reply-to');
  expect(out).toContain('--topic');
});

test('--help nudges long messages toward readable structure', () => {
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Readable long messages');
  expect(out).toContain('headings');
  expect(out).toContain('paragraphs');
  expect(out).toContain('lists');
  expect(out).toContain('--format html');
  expect(out).toContain('tg --table');
});

test('--help documents the successful send stdout refs', () => {
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Send output');
  expect(out).toContain('OK tg#123');
  expect(out).toContain('tg#124');
});

test('--help does NOT advertise the hidden terminal-only bypass flag', () => {
  // `--terminal-question` is the escape for the answer-requires-reply-to gate.
  // It must be discoverable ONLY from that gate's error message — never from
  // --help/usage. A normal user reading the help must not learn the escape.
  const out = run(['--help']).stdout.toString();
  expect(out).not.toContain('--terminal-question');
  expect(out).not.toContain('terminal-question');
  // Same for the `tg help` main-help surface.
  const helpMain = run(['help']).stdout.toString();
  expect(helpMain).not.toContain('terminal-question');
});

test('--help piped (non-TTY) is PLAIN — no ANSI color codes leak into the output', () => {
  // Color is gated on an interactive stdout; a captured subprocess pipe is not a
  // TTY, so the help must be plain text (no `\x1b[` escapes) even though an
  // interactive `tg --help` colorizes it.
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).not.toContain('\x1b[');
  // The advertised tags are lowercase-english only (anchor on stable tokens,
  // not the exact help wording).
  expect(out).toMatch(/lowercase[\s-]?english/i);
  expect(out).toContain('--tag');
  expect(out).toContain('answer');
});

test('--tag answer without --reply-to errors before the credential gate', () => {
  const proc = run(['--tag', 'answer', 'an answer']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  // The clear, non-misleading message — not an HTML-escaping artifact.
  expect(err).toContain('--tag answer must reply to a specific message');
  expect(err).toContain('--reply-to <message_id>');
  // The error — and ONLY the error — reveals the hidden terminal-only escape.
  expect(err).toContain('--terminal-question');
  expect(err).toContain('originated in the terminal');
  // It must NOT be the missing-credentials error — the parse error fires first.
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--terminal-question lets --tag answer pass the parse gate (reaches the credential gate)', () => {
  // With the bypass, the answer-without-reply-to parse error is GONE; the send
  // proceeds far enough to hit the missing-credentials gate (no creds in this
  // test env). The proof is the ABSENCE of the answer-gate error.
  const proc = run(['--tag', 'answer', '--terminal-question', 'a terminal answer']);
  const err = proc.stderr.toString();
  expect(err).not.toContain('--tag answer must reply to a specific message');
  // It got past parsing → it now fails on credentials, not on the answer gate.
  expect(err).toContain('TG_BOT_TOKEN');
});

test('--tag with an uppercase tag is rejected (lowercase-english only) before the credential gate', () => {
  const proc = run(['--tag', 'ANSWER', '--reply-to', '1', 'an answer']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain("invalid --tag 'ANSWER'");
  expect(err).toContain('lowercase english');
  expect(err).toContain('Use one of: answer, decision, problem, report');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--tag with a Cyrillic tag is rejected (lowercase-english only)', () => {
  const proc = run(['--tag', 'ОТВЕТ', 'a message']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain("invalid --tag 'ОТВЕТ'");
  expect(err).toContain('lowercase english');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--reply-to with a bad id errors before the credential gate', () => {
  const proc = run(['--reply-to', 'nope', 'x']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('positive message id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--topic with a bad id errors before the credential gate', () => {
  const proc = run(['--topic', 'nope', 'x']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('positive topic id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--topic without a value errors before the credential gate', () => {
  const proc = run(['--topic']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('--topic requires a topic id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

// --- Escalation-format gate: deny-by-default vs the ESCALATION_GATE_ENFORCE=0 escape ---

function runWithEnv(args: string[], extraEnv: Record<string, string>) {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env: { ...NO_CREDS_ENV, ...extraEnv },
  });
}

// A body satisfying every required section (see escalation-gate-args.test.ts).
const COMPLIANT_BODY = [
  '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
  '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
  '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
  '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
].join('\n');

test('deny-by-default: --tag decision with plain prose hard-blocks (exit 1) before the credential gate', () => {
  const proc = run(['--tag', 'decision', 'ship it or not?']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).toBe(1);
  // The core checklist is printed...
  expect(err).toContain('--tag decision is an escalation');
  expect(err).toContain('Missing:');
  // ...with the deny-by-default block framing...
  expect(err).toContain('Blocked:');
  // ...and it never reached the credential gate (send did not proceed).
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--tag question is REFUSED with the one-line decision hint, before the credential gate (tg-cli#301)', () => {
  const proc = run(['--tag', 'question', 'which option?']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain(
    '--tag question was removed: an open question is a decision request — ' +
      'use --tag decision in the decision-request format',
  );
  // It is a redirect, not the escalation-format checklist and not the generic off-list error.
  expect(err).not.toContain('is an escalation');
  expect(err).not.toContain('Use one of:');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('ESCALATION_GATE_ENFORCE=0 (documented escape): a malformed --tag decision downgrades to advisory and PROCEEDS', () => {
  const proc = runWithEnv(['--tag', 'decision', 'ship it or not?'], { ESCALATION_GATE_ENFORCE: '0' });
  const err = proc.stderr.toString();
  // Still prints the checklist, but as advisory...
  expect(err).toContain('--tag decision is an escalation');
  expect(err).toContain('Advisory only (ESCALATION_GATE_ENFORCE=0)');
  // ...and falls through to the credential gate (no creds here), proving it sent.
  expect(err).toContain('TG_BOT_TOKEN');
  expect(err).not.toContain('Blocked:');
});

test('--tag decision with a FULLY-COMPLIANT body: no block, proceeds to the credential gate', () => {
  const proc = run(['--tag', 'decision', '--format', 'html', COMPLIANT_BODY]);
  const err = proc.stderr.toString();
  expect(err).not.toContain('Blocked:');
  expect(err).toContain('TG_BOT_TOKEN');
});

test('--table does NOT bypass the gate: a bare-table decision is validated on the final body and BLOCKS', () => {
  // The parse-time gate skips --table (rows come from stdin), so the FINAL
  // rendered body is validated in the entrypoint. A boxed table alone lacks a
  // recommendation / context / file ref / structure → blocked. Creds are set so
  // execution reaches the (post-credential) final-body validation; the block
  // fires before any network send, so the unreachable API is never hit.
  const proc = Bun.spawnSync(['bun', TG_SCRIPT, '--tag', 'decision', '--table'], {
    env: { ...NO_CREDS_ENV, TG_BOT_TOKEN: '123:abc', TG_CHAT_ID: '1', TG_API_BASE: 'http://127.0.0.1:9' },
    stdin: Buffer.from('Option\tCons\nA\tslow\nB\trisky'),
  });
  const err = proc.stderr.toString();
  expect(proc.exitCode).toBe(1);
  expect(err).toContain('Blocked:');
});

// --- `tg report` subcommand dispatch (features/cli/report.ts wiring) ---

test('tg help report prints the report usage and exits 0 (no creds needed)', () => {
  const proc = run(['help', 'report']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('tg report --title <text>');
  expect(out).toContain('--verify-cmd <cmd>');
});

test('`tg help <unknown>` now lists report alongside format in the topic list', () => {
  const proc = run(['help', 'bogus']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('Available topics: format, report');
});

test('bare `tg report` and `tg report --help` both print usage and exit 0', () => {
  for (const args of [['report'], ['report', '--help'], ['report', '-h']]) {
    const proc = run(args);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain('tg report --title <text>');
  }
});

test('`tg report --title x` (missing required fields) errors before the credential gate', () => {
  const proc = run(['report', '--title', 'x']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).toBe(1);
  expect(err).toContain('Result report is missing required fields');
  expect(err).toContain('ticket or PR link');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('a well-formed `tg report ...` reaches the normal send pipeline (fails only on missing creds)', () => {
  const proc = run([
    'report', '--title', 'Fix the thing', '--ticket', 'HYP-1',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  // It got past the report parser and INTO the normal send pipeline — the
  // only failure left in this creds-less test env is the credential gate.
  expect(err).toContain('TG_BOT_TOKEN');
  expect(err).not.toContain('Result report is missing required fields');
}, 90000);

test('`tg report <prose>` (second token is not "-h"/"--flag") is NOT captured by the subcommand — sends as a literal message', () => {
  // The dispatch guard requires the second token to be "-h" or a real
  // "--flag" (or absent) to engage the report parser; "failure" is neither,
  // so this must fall through to an ordinary send exactly like any other
  // prose starting with the word "report" — proven by reaching the
  // credential gate, not the report-parser's missing-fields error.
  const proc = run(['report', 'failure', 'investigation', 'notes']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('TG_BOT_TOKEN');
  expect(err).not.toContain('Result report is missing required fields');
}, 90000);

test('`tg report -50% ...` (a single-dash, non-flag second token) is NOT captured by the report subcommand', () => {
  // Regression: the dispatch guard used to engage on ANY leading "-", which
  // included non-flag prose like "-50%" — buildReportSend would then reject
  // it as "unexpected argument — tg report takes only flags". The guard now
  // requires "-h" or a real "--" flag, so this falls through to the ORDINARY
  // global argv parser instead — which itself treats any unrecognized
  // "-"-prefixed token as an attempted flag (the same as a bare `tg -50% …`
  // with no "report" involved at all — an existing, unrelated tg behavior).
  // The proof this is no longer the report subcommand's own rejection is the
  // wording: "unknown flag", never "tg report takes only flags".
  const proc = run(['report', '-50%', 'latency', 'regression']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('unknown flag: -50%');
  expect(err).not.toContain('tg report takes only flags');
});

test('a title containing a ticket code does not hard-fail the send (tg report never re-emits --title globally)', () => {
  // Regression: routing the report title through the global --title flag used
  // to hit args.ts's "refusing --title with an embedded ticket reference"
  // guard for the most natural headline shape ("HYP-123: fix the crash").
  const proc = run([
    'report', '--title', 'HYP-123: fix the crash', '--ticket', 'HYP-123',
    '--impact', 'x', '--verify-cmd', 'x', '--verify-result', 'x',
  ]);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).not.toContain('Refusing: --title contains a ticket reference');
  // Still reaches the ordinary send pipeline (creds gate is the only failure).
  expect(err).toContain('TG_BOT_TOKEN');
}, 90000);

test('`tg report --dry-run ...` renders the full body through the actual send pipeline (rich routing, prefix, guards) with no network call', () => {
  const proc = run([
    'report', '--dry-run', '--title', 'Smoke test', '--ticket', 'HYP-1',
    '--pr', 'alex-mextner/tg-cli#123',
    '--impact', 'proves the pipeline end to end',
    '--verify-cmd', 'bun test tests/cli-subprocess.test.ts',
    '--verify-result', 'all green',
    '--summary', 'added the dry-run e2e test',
  ]);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('No network call was made and nothing was sent');
  expect(out).toContain('<h2>Smoke test</h2>');
  expect(out).toContain('<b>Ticket:</b> HYP-1');
  expect(out).toContain('<a href="https://github.com/alex-mextner/tg-cli/pull/123">alex-mextner/tg-cli#123</a>');
  expect(out).toContain('<pre>bun test tests/cli-subprocess.test.ts</pre>');
}, 90000);
