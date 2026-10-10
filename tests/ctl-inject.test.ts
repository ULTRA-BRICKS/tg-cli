import { expect, test } from 'bun:test';
import { wrapInbound, buildTextInjectPlan, buildKeyInjectPlan, buildDigitInjectPlan, paneTypingKey, unsubmittedNotice } from '../features/tg-ctl/inject';
import type { InjectStep } from '../features/tg-ctl/types';
import type { PermissionMenuTarget } from '../features/tg-ctl/permission-menu';

const menuTarget = (digit: string): PermissionMenuTarget => ({ identity: 'pkill -f x', decision: 'allow', digit, box: 'pkill -f x\n❯ 1. Yes\n2. No' });

// --- wrapInbound: {name}/{msg} template substitution ---

test('wrapInbound substitutes {name} and {msg}', () => {
  expect(wrapInbound('[TG from {name}] {msg} — reply via tg', 'alex', 'hi')).toBe('[TG from alex] hi — reply via tg');
});

test('wrapInbound substitutes ALL occurrences of each placeholder', () => {
  expect(wrapInbound('{name}/{name}: {msg} ({msg})', 'a', 'b')).toBe('a/a: b (b)');
});

test('wrapInbound leaves templates without placeholders untouched', () => {
  expect(wrapInbound('static text', 'a', 'b')).toBe('static text');
});

test('wrapInbound does not re-substitute placeholders inside values', () => {
  // Single pass over the TEMPLATE only — a "{name}" living inside the user's
  // message must come out literal, not expanded again.
  expect(wrapInbound('{name}: {msg}', 'x', 'msg has {name} inside')).toBe('x: msg has {name} inside');
  expect(wrapInbound('{name}: {msg}', '{msg}', 'm')).toBe('{msg}: m');
});

// --- {id} placeholder: the inbound message_id surfaced for `tg --reply-to` ---

test('wrapInbound substitutes {id} with tg#<messageId> when an id is given', () => {
  // The id renders as `tg#<id>` (NOT bare `#<id>`): `tg#` is the message-ref
  // convention so the autolink layer can tell it apart from a GitHub issue/PR
  // `#<id>` and never mis-resolve it (tg#28).
  expect(wrapInbound('[TG from {name} {id}] {msg} — reply via tg', 'Alex', 'hi', 1234)).toBe(
    '[TG from Alex tg#1234] hi — reply via tg',
  );
});

test('wrapInbound collapses the ` {id}` segment cleanly when no id is given', () => {
  // A synthetic/non-inbound injection (no underlying Telegram message, e.g. a
  // button-tap answer label) has no id → the marker drops and the space
  // stranded before the closing bracket is cleaned up. A `/agent <selector>
  // <text>` route DOES carry an id (forwarded from sourceMessageId) and is
  // covered separately in tests/ctl-agent-route-message-id-integration.test.ts.
  expect(wrapInbound('[TG from {name} {id}] {msg} — reply via tg', 'Alex', 'hi')).toBe(
    '[TG from Alex] hi — reply via tg',
  );
});

test('wrapInbound with id leaves a template that has no {id} untouched (back-compat)', () => {
  expect(wrapInbound('[TG from {name}] {msg} — reply via tg', 'Alex', 'hi', 5)).toBe(
    '[TG from Alex] hi — reply via tg',
  );
});

test('the no-id {id} cleanup NEVER mangles the user message (codex regression)', () => {
  // The cleanup must act on the TEMPLATE around {id}, not on the substituted
  // output — a {msg} with double spaces or a ` : ` ratio comes through verbatim.
  const T = '[TG from {name} {id}] {msg} — reply via tg';
  expect(wrapInbound(T, 'Alex', 'keep  two spaces and ratio 1 : 2')).toBe(
    '[TG from Alex] keep  two spaces and ratio 1 : 2 — reply via tg',
  );
  // And the user name with trailing-relevant spacing in the message is intact.
  expect(wrapInbound('{name} {id} {msg}', 'Alex', 'a  b')).toBe('Alex a  b');
});

// --- buildTextInjectPlan: single-line ---

test('single-line text → verify-pane, literal send-keys, sleep, Enter, submit check with one retry Enter', () => {
  expect(buildTextInjectPlan('%3', 'hello world')).toEqual([
    { kind: 'verify-pane', paneId: '%3' },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%3', '-l', 'hello world'] },
    { kind: 'sleep', ms: 500 },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%3', 'Enter'] },
    { kind: 'sleep', ms: 700 },
    { kind: 'submit-check', paneId: '%3', text: 'hello world' },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%3', 'Enter'] },
    { kind: 'sleep', ms: 700 },
    { kind: 'submit-check', paneId: '%3', text: 'hello world', final: true },
  ]);
});

test('single-line send-keys uses -l (literal mode, special-char safe)', () => {
  const plan = buildTextInjectPlan('%1', 'rm -rf; echo "q"');
  const send = plan.find((s): s is Extract<InjectStep, { kind: 'tmux' }> => s.kind === 'tmux' && s.argv.includes('-l'));
  expect(send).toBeDefined();
  expect(send!.argv).toEqual(['tmux', 'send-keys', '-t', '%1', '-l', 'rm -rf; echo "q"']);
  expect(send!.stdin).toBeUndefined();
});

// --- buildTextInjectPlan: multi-line ---

test('multi-line text → load-buffer with stdin, then bracketed paste-buffer', () => {
  const text = 'line one\nline two\nline three';
  expect(buildTextInjectPlan('%7', text)).toEqual([
    { kind: 'verify-pane', paneId: '%7' },
    { kind: 'tmux', argv: ['tmux', 'load-buffer', '-'], stdin: text },
    { kind: 'tmux', argv: ['tmux', 'paste-buffer', '-p', '-d', '-t', '%7'] },
    { kind: 'sleep', ms: 500 },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%7', 'Enter'] },
    { kind: 'sleep', ms: 700 },
    { kind: 'submit-check', paneId: '%7', text },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%7', 'Enter'] },
    { kind: 'sleep', ms: 700 },
    { kind: 'submit-check', paneId: '%7', text, final: true },
  ]);
});

test('stdin appears ONLY on the load-buffer step', () => {
  const plan = buildTextInjectPlan('%7', 'a\nb');
  for (const step of plan) {
    if (step.kind !== 'tmux') continue;
    if (step.argv[1] === 'load-buffer') expect(step.stdin).toBe('a\nb');
    else expect(step.stdin).toBeUndefined();
  }
});

// --- escapePrelude option ---

test('escapePrelude inserts Escape + 200ms sleep right after verify-pane', () => {
  const plan = buildTextInjectPlan('%2', 'hi', { escapePrelude: true });
  expect(plan.slice(0, 3)).toEqual([
    { kind: 'verify-pane', paneId: '%2' },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%2', 'Escape'] },
    { kind: 'sleep', ms: 200 },
  ]);
  // Text injection still follows, ending with the separate Enter.
  expect(plan[3]).toEqual({
    kind: 'tmux',
    argv: ['tmux', 'send-keys', '-t', '%2', '-l', 'hi'],
  });
});

test('no escapePrelude by default', () => {
  const plan = buildTextInjectPlan('%2', 'hi');
  const escapes = plan.filter((s) => s.kind === 'tmux' && s.argv.includes('Escape'));
  expect(escapes).toEqual([]);
});

// --- gapMs option ---

test('custom gapMs replaces the default 500ms pre-Enter sleep', () => {
  const plan = buildTextInjectPlan('%4', 'hi', { gapMs: 1200 });
  const firstEnter = plan.findIndex((s) => s.kind === 'tmux' && s.argv.includes('Enter'));
  expect(plan[firstEnter - 1]).toEqual({ kind: 'sleep', ms: 1200 });
});

test('prelude sleep stays 200ms even with custom gapMs', () => {
  const plan = buildTextInjectPlan('%4', 'hi', { escapePrelude: true, gapMs: 1200 });
  const sleeps = plan.filter((s) => s.kind === 'sleep');
  expect(sleeps).toEqual([
    { kind: 'sleep', ms: 200 },
    { kind: 'sleep', ms: 1200 },
    { kind: 'sleep', ms: 700 },
    { kind: 'sleep', ms: 700 },
  ]);
});

// --- invariants: verify-pane first, Enter separate and last ---

test('verify-pane is ALWAYS the first step', () => {
  const variants = [
    buildTextInjectPlan('%9', 'one'),
    buildTextInjectPlan('%9', 'one\ntwo'),
    buildTextInjectPlan('%9', 'one', { escapePrelude: true }),
    buildKeyInjectPlan('%9', 'Escape'),
    buildDigitInjectPlan('%9', menuTarget('1')),
  ];
  for (const plan of variants) {
    expect(plan[0]).toEqual({ kind: 'verify-pane', paneId: '%9' });
  }
});

test('Enter is ALWAYS its own step after a sleep; the only second Enter is the retry behind a submit check', () => {
  const variants = [
    buildTextInjectPlan('%5', 'one'),
    buildTextInjectPlan('%5', 'one\ntwo'),
    buildTextInjectPlan('%5', 'one', { escapePrelude: true, gapMs: 50 }),
  ];
  const ENTER = { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%5', 'Enter'] };
  for (const plan of variants) {
    const enters = plan.flatMap((s, i) => (s.kind === 'tmux' && s.argv.includes('Enter') ? [i] : []));
    expect(enters).toHaveLength(2);
    for (const i of enters) expect(plan[i]).toEqual(ENTER); // never rides along with the payload
    expect(plan[enters[0] - 1].kind).toBe('sleep');
    // The retry Enter runs only after a check found the text still typed…
    expect(plan[enters[1] - 1]).toMatchObject({ kind: 'submit-check', paneId: '%5' });
    expect(plan[enters[1] - 2].kind).toBe('sleep');
    // …and the plan ends on the final check, which reports a still-typed text.
    expect(plan.at(-1)).toMatchObject({ kind: 'submit-check', paneId: '%5', final: true });
    expect(plan.at(-2)!.kind).toBe('sleep');
  }
});

test('the unsubmitted notice names the pane and agent and quotes the first line, truncated', () => {
  const notice = unsubmittedNotice('%5', 'claude', `[TG from Alex tg#9] ${'x'.repeat(300)}\nsecond line`);
  expect(notice).toContain('pane %5 (claude)');
  expect(notice).toContain('[TG from Alex tg#9] xxx');
  expect(notice).not.toContain('second line');
  expect(notice).toContain('…»');
});

// --- buildKeyInjectPlan ---

test('key plan: verify-pane + raw send-keys, no -l, no Enter, no sleep', () => {
  expect(buildKeyInjectPlan('%6', 'Escape')).toEqual([
    { kind: 'verify-pane', paneId: '%6' },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%6', 'Escape'] },
  ]);
});

// --- buildDigitInjectPlan ---

test('digit plan: verify-pane, then the menu re-check, then the literal send-keys — no Enter, no sleep', () => {
  const target = menuTarget('1');
  expect(buildDigitInjectPlan('%8', target)).toEqual([
    { kind: 'verify-pane', paneId: '%8' },
    { kind: 'verify-permission-menu', paneId: '%8', target },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%8', '-l', '1'] },
  ]);
});

test('digit plan: the menu re-check is the step IMMEDIATELY before the send-keys (tg-cli#309)', () => {
  const plan = buildDigitInjectPlan('%8', menuTarget('2'), 'sess-1');
  const send = plan.findIndex((s) => s.kind === 'tmux');
  expect(plan[send - 1].kind).toBe('verify-permission-menu');
  expect(plan[0]).toEqual({ kind: 'verify-pane', paneId: '%8', sessionKey: 'sess-1' });
});

test('digit plan uses -l (literal mode), unlike buildKeyInjectPlan', () => {
  const plan = buildDigitInjectPlan('%8', menuTarget('2'));
  const send = plan.find((s): s is Extract<InjectStep, { kind: 'tmux' }> => s.kind === 'tmux')!;
  expect(send.argv).toContain('-l');
});

test('digit plan does NOT truncate or otherwise reinterpret its input — trusts the single-digit contract, never silently substitutes a plausible-but-wrong value', () => {
  const target = menuTarget('10');
  expect(buildDigitInjectPlan('%8', target)).toEqual([
    { kind: 'verify-pane', paneId: '%8' },
    { kind: 'verify-permission-menu', paneId: '%8', target },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', '%8', '-l', '10'] },
  ]);
});

test('digit plan never includes an Enter step', () => {
  const plan = buildDigitInjectPlan('%8', menuTarget('3'));
  expect(plan.some((s) => s.kind === 'tmux' && s.argv.includes('Enter'))).toBe(false);
  expect(plan.some((s) => s.kind === 'sleep')).toBe(false);
});

// A late button tap (digit/key plan) types into the same pane as a text plan mid submit-check:
// they must take the same turn, and plans for different panes must not wait on each other.
test('paneTypingKey: text, digit and key plans of one pane share a turn; other panes do not', () => {
  const key = paneTypingKey(buildTextInjectPlan('%5', 'hi'));
  expect(key).not.toBeNull();
  expect(paneTypingKey(buildDigitInjectPlan('%5', menuTarget('1')))).toBe(key);
  expect(paneTypingKey(buildKeyInjectPlan('%5', 'Escape'))).toBe(key);
  expect(paneTypingKey(buildTextInjectPlan('%6', 'hi'))).not.toBe(key);
});
