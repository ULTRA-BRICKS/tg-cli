// tg-cli#304: is a Claude Code prompt still pending? Every fixture is a real capture from the
// study in docs/research/2026-09-04-claude-code-tmux-prompts.md (Claude Code 2.1.261, tmux 3.5a),
// copied verbatim from docs/cc-tmux-evidence/ — never a hand-drawn screen. One test types text into
// a real capture's idle input box.
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseClaudeSessionRecord, readPendingClaudePrompt } from '../features/tg-ctl/claude-prompt-state';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', 'claude-prompt', `${name}.txt`), 'utf8');

// The sessions/<pid>.json body is the one JSON line inside a captured "-process.txt" bundle.
const sessionJson = (name: string): string => {
  const line = fixture(name).split('\n').find((l) => l.startsWith('{"pid"'));
  if (!line) throw new Error(`no sessions/<pid>.json line in ${name}`);
  return line;
};

test('Bash permission menu: pending, kind permission, plain Yes/No with the cursor on 1', () => {
  const p = readPendingClaudePrompt(fixture('bash-pending'));
  expect(p?.kind).toBe('permission');
  expect(p?.selected).toBe('1');
  expect(p?.options.map((o) => o.label)).toEqual([
    'Yes',
    'Yes, and always allow access to /private/var/folders/1c/d4v7_mrs4b9085f6w7w9p35c0000gn/T/cc-study-46864/repo from this project',
    'No',
  ]);
});

test('Edit permission: its own marker, the deny option is a plain "No"', () => {
  const p = readPendingClaudePrompt(fixture('edit-pending'));
  expect(p?.kind).toBe('edit');
  expect(p?.marker).toBe('Do you want to make this edit to README.md?');
  expect(p?.options.at(-1)).toEqual({ digit: '3', label: 'No' });
});

test('plan approval: pending; digit 3 only moves the cursor to the free-text option, still pending', () => {
  const p = readPendingClaudePrompt(fixture('plan-pending'));
  expect(p?.kind).toBe('plan');
  expect(p?.options.map((o) => o.label)).toEqual([
    'Yes, auto-accept edits',
    'Yes, manually approve edits',
    'Tell Claude what to change',
  ]);
  const after = readPendingClaudePrompt(fixture('plan-after-digit-3'));
  expect(after?.kind).toBe('plan');
  expect(after?.selected).toBe('3');
});

test('AskUserQuestion: pending with its question text; Down moves the cursor without answering', () => {
  const p = readPendingClaudePrompt(fixture('ask-single-pending'));
  expect(p?.kind).toBe('question');
  expect(p?.marker).toBe('Which color?');
  expect(p?.selected).toBe('1');
  expect(p?.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Type something.', 'Chat about this']);
  expect(readPendingClaudePrompt(fixture('ask-single-after-down'))?.selected).toBe('2');
});

test('multi-question AskUserQuestion: each tab is pending, then the review screen (no footer) is too', () => {
  expect(readPendingClaudePrompt(fixture('ask-multi-q1'))?.marker).toBe('Which color?');
  expect(readPendingClaudePrompt(fixture('ask-multi-q2'))?.marker).toBe('Which size?');
  const review = readPendingClaudePrompt(fixture('ask-multi-review'));
  expect(review?.kind).toBe('question-review');
  expect(review?.options).toEqual([
    { digit: '1', label: 'Submit answers' },
    { digit: '2', label: 'Cancel' },
  ]);
});

test('a late PermissionRequest hook reply leaves the terminal prompt pending', () => {
  expect(readPendingClaudePrompt(fixture('bash-pending-after-late-hook-reply'))?.kind).toBe('permission');
});

test('answered, denied, escaped and busy screens are not pending', () => {
  for (const name of [
    'bash-answered',
    'bash-approved-busy',
    'bash-escaped',
    'edit-denied',
    'ask-single-answered-busy',
    'ask-multi-answered',
  ]) {
    expect({ name, pending: readPendingClaudePrompt(fixture(name)) }).toEqual({ name, pending: null });
  }
});

test('cursor moved onto "No" with arrows is still the same pending permission', () => {
  const p = readPendingClaudePrompt(fixture('bash-cursor-on-no'));
  expect(p?.kind).toBe('permission');
  expect(p?.selected).toBe('3');
});

test('other harnesses are not read as a Claude Code prompt', () => {
  expect(readPendingClaudePrompt(fixture('opencode-permission'))).toBeNull();
  expect(readPendingClaudePrompt(fixture('codex-working'))).toBeNull();
});

// The idle input box is "❯" + U+00A0 (NBSP), not a plain space, in every idle capture.
test('a typed numbered line in the idle input box is not a prompt', () => {
  const idle = fixture('bash-answered').replace(/^❯\u00a0$/m, '❯\u00a01. Yes');
  expect(idle).toContain('❯\u00a01. Yes');
  expect(readPendingClaudePrompt(idle)).toBeNull();
});

test('sessions/<pid>.json: waitingFor tells a permission from a question; idle and busy are not waiting', () => {
  expect(parseClaudeSessionRecord(sessionJson('session-waiting-permission'))).toEqual({
    pid: 71856,
    sessionId: '5d993f87-b74f-4df0-ab18-6759f5d298af',
    procStart: 'Fri Sep  4 22:09:41 2026',
    activity: 'waiting-permission',
  });
  expect(parseClaudeSessionRecord(sessionJson('session-waiting-plan'))?.activity).toBe('waiting-permission');
  expect(parseClaudeSessionRecord(sessionJson('session-waiting-input'))?.activity).toBe('waiting-input');
  expect(parseClaudeSessionRecord(sessionJson('session-idle'))?.activity).toBe('idle');
  expect(parseClaudeSessionRecord(sessionJson('session-busy'))?.activity).toBe('busy');
});

test('sessions/<pid>.json: unknown status or waitingFor is "unknown", malformed is null', () => {
  expect(parseClaudeSessionRecord('{"pid":1,"sessionId":"s","status":"waiting","waitingFor":"something new"}')?.activity).toBe('unknown');
  expect(parseClaudeSessionRecord('{"pid":1,"sessionId":"s","status":"compacting"}')?.activity).toBe('unknown');
  expect(parseClaudeSessionRecord('not json')).toBeNull();
  expect(parseClaudeSessionRecord('{"sessionId":"s","status":"idle"}')).toBeNull();
});
