// Escalation-format gate (parse-time TAG_GATES in features/cli/args.ts). For
// --tag decision the gate now runs the FULL decision-request-format
// validator (features/cli/escalation-format.ts): a self-contained STRUCTURED
// Rich Message — Context + Options-with-pros/cons + Recommendation + a
// "where to look" file:line, laid out with headings / bullet lists / <hr>
// dividers. A malformed send has `escalationWarning` attached; the ENTRYPOINT
// hard-blocks it deny-by-default (escalationGateEnforced is ON by default),
// downgraded to advisory only under ESCALATION_GATE_ENFORCE=0.
import { expect, test } from 'bun:test';
import { escalationGateEnforced, parseArgs } from '../features/cli/args';

const HOME = '/home/tester';
const CWD = '/tmp/no-such-cwd-for-tg-tests';

// A body that satisfies EVERY required section: table with pros/cons, a
// recommendation, a file:line "where to look", context prose, >=2 headings, a
// <ul> list, and <hr> dividers — and no wall-of-text run-on.
const COMPLIANT = [
  '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
  '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
  '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
  '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  '<hr><h4>Glossary</h4><ul><li>resolver — picks the element a click lands on</li></ul>',
].join('\n');

test('the removed "question" tag is REFUSED at parse time — even with a compliant body (tg-cli#301)', () => {
  // The refusal is about vocabulary, not format: a perfectly formatted
  // question is still refused and redirected to --tag decision.
  const r = parseArgs(['--tag', 'question', '--format', 'html', COMPLIANT], CWD, HOME);
  expect(r.action).toBe('error');
  if (r.action === 'error') {
    expect(r.message).toContain('--tag question was removed');
    expect(r.message).toContain('use --tag decision in the decision-request format');
  }
});

test('--tag decision with plain prose (no format) is WARN (still a send); names the actual tag', () => {
  const r = parseArgs(['--tag', 'decision', 'ship the thing or not?'], CWD, HOME);
  // Parse layer never throws: it SENDS with a warning; the entrypoint decides
  // block-vs-warn via escalationGateEnforced (default block).
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.escalationWarning).toBeDefined();
    // Names the ACTUAL tag used.
    expect(r.escalationWarning).toContain('--tag decision is an escalation');
    // Lists the missing sections as a checklist.
    expect(r.escalationWarning).toContain('Missing:');
    // The mode-specific framing (advisory vs blocked, ESCALATION_GATE_ENFORCE)
    // lives in the ENTRYPOINT, not the parse-time message.
    expect(r.escalationWarning).not.toContain('ESCALATION_GATE_ENFORCE');
  }
});

test('--tag decision with a FULLY-COMPLIANT structured body (+ --format html): no warning attached', () => {
  const r = parseArgs(['--tag', 'decision', '--format', 'html', COMPLIANT], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
});

test('--tag decision with a compliant body passed via literal \\n escapes (one shell argument): no warning attached', () => {
  // tg's documented convention for a multiline caption as a single shell argument is
  // literal `\n` escapes, decoded by the entrypoint right before send. The parse-time
  // gate must validate the DECODED content, not the raw argv text with literal
  // backslash-n sequences (review finding, tg-cli#202) — otherwise a fully compliant
  // escalation body is seen as one long line and false-positive-blocked.
  const escaped = COMPLIANT.replace(/\n/g, '\\n');
  const r = parseArgs(['--tag', 'decision', '--format', 'html', escaped], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
});

test('--tag decision with a compliant body but NO --format html: still warns (raw tags would be literal)', () => {
  const r = parseArgs(['--tag', 'decision', COMPLIANT], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.escalationWarning).toBeDefined();
    expect(r.escalationWarning).toContain('--format html');
  }
});

test('--tag decision with a BARE table only (no recommendation/context/structure): still WARNS', () => {
  const body = ['| Option | Tradeoff |', '| --- | --- |', '| A | slower |'].join('\n');
  const r = parseArgs(['--tag', 'decision', body], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeDefined();
});

test('--tag decision WITH --table (rows arrive on stdin, not argv): no warning attached', () => {
  // --table short-circuits the gate: the rendered table arrives from stdin,
  // which parseArgs never sees, so it cannot be validated here.
  const r = parseArgs(['--tag', 'decision', '--table'], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
});

test('non-escalation tags (problem/report) get no escalation warning', () => {
  for (const tag of ['problem', 'report']) {
    const r = parseArgs(['--tag', tag, 'plain prose, no table'], CWD, HOME);
    expect(r.action).toBe('send');
    if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
  }
});

test('the answer gate is a HARD block (severity block), unaffected by the format gate', () => {
  const noReply = parseArgs(['--tag', 'answer', 'here is the answer'], CWD, HOME);
  expect(noReply.action).toBe('error');
  if (noReply.action === 'error') expect(noReply.message).toContain('--reply-to');

  const withReply = parseArgs(['--tag', 'answer', '--reply-to', '7', 'here is the answer'], CWD, HOME);
  expect(withReply.action).toBe('send');

  const terminal = parseArgs(['--tag', 'answer', '--terminal-question', 'here is the answer'], CWD, HOME);
  expect(terminal.action).toBe('send');
});

// --- ESCALATION_GATE_ENFORCE flag parse. The gate is ON (deny-by-default); the
// ONE documented escape is an explicit falsy value, which downgrades to advisory. ---
test('escalationGateEnforced: absent value is ON by default (deny-by-default)', () => {
  expect(escalationGateEnforced({} as NodeJS.ProcessEnv)).toBe(true);
});

test('escalationGateEnforced: only an explicit falsy value disables it (the documented escape)', () => {
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', ' Off ']) {
    expect(escalationGateEnforced({ ESCALATION_GATE_ENFORCE: v } as NodeJS.ProcessEnv)).toBe(false);
  }
});

test('escalationGateEnforced: any other value (incl. truthy / unknown / empty) stays ON', () => {
  for (const v of ['', '1', 'true', 'yes', 'on', 'nope']) {
    expect(escalationGateEnforced({ ESCALATION_GATE_ENFORCE: v } as NodeJS.ProcessEnv)).toBe(true);
  }
});
