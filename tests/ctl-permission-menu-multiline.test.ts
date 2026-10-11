// tg-cli#283: binding a late Telegram tap to Claude Code's live Bash permission box when the
// command spans several lines. Every pane here is a real `tmux capture-pane -p -J` of Claude
// Code 2.1.296 (docs/research/2026-10-11-claude-code-bash-permission-box.md), copied verbatim
// into tests/fixtures/claude-prompt/; the identities are the exact `tool_input.command` strings
// the binary was given (tools/cc-study/283-multiline-bash/scenarios.json). Two tests edit one
// row of a real capture or stack two real captures; they say so.
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyPostInjectPane,
  findPermissionMenuTarget,
  parsePermissionMenu,
  permissionMenuMatchesRequest,
  permissionMenuUnchanged,
  type PermissionMenuTarget,
} from '../features/tg-ctl/permission-menu';
import scenarios from '../tools/cc-study/283-multiline-bash/scenarios.json';
import { permissionBoxFor } from './fixtures/permission-menu';

// The first line of each fixture names its source capture; the pane follows it.
const pane = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', 'claude-prompt', `${name}.txt`), 'utf8').replace(/^# .*\n/, '');

type Scenario = keyof typeof scenarios;
const command = (scenario: Scenario, step = 0): string => scenarios[scenario][step].command;

// The rows Claude Code drew between the two dashed rules, without their " │ " prefix — what a
// tap would have to carry to be mistaken for a wrapped command.
const drawnRows = (text: string): string[] =>
  text
    .split('\n')
    .filter((l) => /^\s*│/.test(l))
    .map((l) => l.replace(/^\s*│ ?/, '').trimEnd());

const targetFor = (text: string, identity: string, decision: 'allow' | 'deny' = 'allow'): PermissionMenuTarget => {
  const found = findPermissionMenuTarget(text, identity, decision);
  if (!found.ok) throw new Error(`no target: ${found.reason}`);
  return found.target;
};

test('a real 3-line command box matches its exact command; Approve is 1, Reject is the plain "No" (4)', () => {
  const live = pane('bash-multiline-pending');
  expect(findPermissionMenuTarget(live, command('ml3'), 'allow')).toMatchObject({ ok: true, target: { digit: '1' } });
  expect(findPermissionMenuTarget(live, command('ml3'), 'deny')).toMatchObject({ ok: true, target: { digit: '4' } });
  expect(permissionMenuMatchesRequest(parsePermissionMenu(live)!.context, command('ml3'))).toBe(true);
});

test('a heredoc with a blank line and an indented line matches exactly', () => {
  expect(findPermissionMenuTarget(pane('bash-heredoc-pending'), command('heredoc'), 'allow').ok).toBe(true);
});

test('tabs match as Claude Code draws them (8-column stops); trailing spaces are not on screen and are ignored', () => {
  expect(findPermissionMenuTarget(pane('bash-multiline-tabs'), command('midtab'), 'allow').ok).toBe(true);
  // command('tabs') = "touch a.txt\n\tcat a.txt  >  b.txt\ntouch c.txt   "
  expect(findPermissionMenuTarget(pane('bash-multiline-leading-tab'), command('tabs'), 'allow').ok).toBe(true);
});

test('a short one-line command (one unprefixed row) still matches on 2.1.296', () => {
  expect(findPermissionMenuTarget(pane('bash-single-2.1.296'), command('single'), 'allow').ok).toBe(true);
});

test('SECURITY: every line must match — one line fewer or more, a changed line, changed spacing or the lines joined never match', () => {
  const live = pane('bash-multiline-pending');
  const lines = command('ml3').split('\n');
  const mismatches = [
    lines.slice(0, 2).join('\n'),
    lines.slice(1).join('\n'),
    [...lines, 'rm -rf ~'].join('\n'),
    ['rm -rf ~', ...lines].join('\n'),
    [lines[0], 'sleep 2', lines[2]].join('\n'),
    [lines[0], 'sleep  1', lines[2]].join('\n'),
    lines.join(' '),
    lines.join('; '),
    lines[2],
  ];
  for (const identity of mismatches) {
    expect(findPermissionMenuTarget(live, identity, 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  }
});

test('SECURITY: the description row is not the command — a tap for a command equal to it does not approve the live menu', () => {
  // Live command "touch live-one.txt\ntouch live-two.txt", model-written description "touch harmless.txt".
  const live = pane('bash-multiline-description-spoof');
  expect(findPermissionMenuTarget(live, 'touch harmless.txt', 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(findPermissionMenuTarget(live, command('descspoof'), 'allow').ok).toBe(true);
});

test('SECURITY: the transcript echo of the live command above the box is not the command', () => {
  // After approving step 0, the next prompt (step 1, "touch live-one.txt\ntouch live-two.txt")
  // is live; the transcript area above it echoes "⎿  $ touch live-one.txt" / "touch live-two.txt".
  const live = pane('bash-multiline-next-after-approve');
  expect(findPermissionMenuTarget(live, 'touch live-two.txt', 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(findPermissionMenuTarget(live, command('stale', 0), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(findPermissionMenuTarget(live, command('stale', 1), 'allow').ok).toBe(true);
});

test('SECURITY: an older box with the stale command still above the live one does not satisfy a tap for it', () => {
  // Two real captures stacked, as scrollback would leave them: the step-0 box (the stale tap's
  // own command) directly above the live step-1 box.
  const stacked = `${pane('bash-multiline-before-approve')}\n${pane('bash-multiline-next-after-approve')}`;
  expect(findPermissionMenuTarget(pane('bash-multiline-before-approve'), command('stale', 0), 'allow').ok).toBe(true);
  expect(findPermissionMenuTarget(stacked, command('stale', 0), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(findPermissionMenuTarget(stacked, command('stale', 1), 'allow').ok).toBe(true);
});

test('a command taller than the pane: its top is off the screen, so nothing is injected (command-partly-visible)', () => {
  const live = pane('bash-heredoc-taller-than-pane');
  expect(findPermissionMenuTarget(live, command('longhd'), 'allow')).toEqual({ ok: false, reason: 'command-partly-visible' });
  // Not even a tap whose command is exactly the visible rows.
  expect(findPermissionMenuTarget(live, drawnRows(live).join('\n'), 'allow')).toEqual({ ok: false, reason: 'command-partly-visible' });
});

test("SECURITY: Claude Code's own word wrap is not a newline — a tap carrying the wrapped rows as lines is refused", () => {
  for (const [name, scenario] of [
    ['bash-multiline-word-wrapped', 'wide'],
    ['bash-long-single-wrapped', 'longsingle'],
    ['bash-multiline-width80', 'width'],
  ] as const) {
    const live = pane(name);
    // The real command does not match either: its rows are not its lines.
    expect(findPermissionMenuTarget(live, command(scenario), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
    expect(findPermissionMenuTarget(live, drawnRows(live).join('\n'), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  }
});

test('SECURITY: a row shown shortened ("…") never matches, even a tap carrying the same "…"', () => {
  // One row of a real capture edited to end in "…".
  const live = pane('bash-multiline-pending').replace('│ rm -rf /tmp/cc283-scratch', '│ rm -rf /tmp/cc283-scr…');
  const lines = command('ml3').split('\n');
  expect(findPermissionMenuTarget(live, [lines[0], lines[1], 'rm -rf /tmp/cc283-scr…'].join('\n'), 'allow')).toEqual({
    ok: false,
    reason: 'identity-mismatch',
  });
  expect(findPermissionMenuTarget(live, command('ml3'), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
});

test('a command with a carriage return or another control character never matches', () => {
  const live = pane('bash-multiline-pending');
  expect(findPermissionMenuTarget(live, command('ml3').replace('\n', '\r\n'), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(findPermissionMenuTarget(live, command('ml3').replace('sleep', '\u001b[0msleep'), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
});

test('SECURITY: a line ending in a backslash never matches — "\\" and an undrawn "\\ " parse differently', () => {
  // command('continuation') = "touch one.txt \\\n  two.txt": one command continued onto the next
  // line. A live "touch one.txt \\ \n  two.txt" (escaped space, then a SECOND command) draws the
  // same rows, since trailing spaces are not on screen.
  expect(findPermissionMenuTarget(pane('bash-multiline-continuation'), command('continuation'), 'allow')).toEqual({
    ok: false,
    reason: 'identity-mismatch',
  });
});

test('#309 re-verify: the same live box passes the pre-send gate; the next command in its spot does not', () => {
  const target = targetFor(pane('bash-multiline-before-approve'), command('stale', 0));
  expect(permissionMenuUnchanged(pane('bash-multiline-before-approve'), target)).toBe(true);
  expect(permissionMenuUnchanged(pane('bash-multiline-next-after-approve'), target)).toBe(false);
  expect(permissionMenuUnchanged(null, target)).toBe(false);
});

test('#309 re-verify: the same command asked again with a different description is a different box', () => {
  // The real capture with its description row edited — another call of the same command.
  const target = targetFor(pane('bash-multiline-pending'), command('ml3'));
  const reasked = pane('bash-multiline-pending').replace(' Stop worker and clean scratch', ' Approve production deploy');
  expect(reasked).not.toBe(pane('bash-multiline-pending'));
  expect(permissionMenuUnchanged(reasked, target)).toBe(false);
});

test('SECURITY: without the dashed rules (the older box shape) a multi-line command never matches a one-line command', () => {
  // Hand-drawn in the pre-2.1.296 shape (tests/fixtures/permission-menu.ts): no rule, no " │ ".
  // Normalizing "pkill -f x\nsleep 1" to one line would approve the different "pkill -f x sleep 1".
  expect(findPermissionMenuTarget(permissionBoxFor('pkill -f x sleep 1'), 'pkill -f x\nsleep 1', 'allow')).toEqual({
    ok: false,
    reason: 'identity-mismatch',
  });
  expect(findPermissionMenuTarget(permissionBoxFor('pkill -f x sleep 1'), 'pkill -f x sleep 1', 'allow').ok).toBe(true);
});

test('post-inject: the same box still live is still-pending; the next command live is next-menu', () => {
  const target = targetFor(pane('bash-multiline-before-approve'), command('stale', 0));
  expect(classifyPostInjectPane(pane('bash-multiline-before-approve'), target)).toBe('still-pending');
  expect(classifyPostInjectPane(pane('bash-multiline-next-after-approve'), target)).toBe('next-menu');
});

test('SECURITY: dashed rules too far above the menu (text wrapped in a narrow pane) refuse instead of falling back to any-line', () => {
  // The real description-spoof capture with four extra rows between the lower rule and the
  // marker, as a long notice wrapped in a narrow pane would put there.
  const live = pane('bash-multiline-description-spoof').replace(
    ' Do you want to proceed?',
    ' This command\n requires\n approval for\n this reason\n Do you want to proceed?',
  );
  expect(findPermissionMenuTarget(live, 'touch harmless.txt', 'allow')).toEqual({ ok: false, reason: 'command-unrecognized' });
  expect(findPermissionMenuTarget(live, command('descspoof'), 'allow')).toEqual({ ok: false, reason: 'command-unrecognized' });
});

test('post-inject: the same menu scrolled so its top is off the screen is not confirmed (still-pending)', () => {
  // The real capture cut above its first command row, as output scrolling the pane would leave it.
  const full = pane('bash-multiline-before-approve');
  const target = targetFor(full, command('stale', 0));
  const scrolled = full.slice(full.indexOf(' │ pkill'));
  expect(classifyPostInjectPane(scrolled, target)).toBe('still-pending');
});

test('KNOWN LIMITATION (tg-cli#683): a run of spaces that fills a row is drawn exactly like a line break', () => {
  // "touch xyz" + 400 spaces + "uvw" is one line of the real command; on screen it is the rows
  // "touch xyz", "", "                 uvw". A tap whose command has those three LINES matches
  // the same box: the screen carries no difference to check. Pinned so the fix (binding to
  // Claude Code's own record of the pending tool call) flips this test.
  const live = pane('bash-multiline-space-runs');
  expect(findPermissionMenuTarget(live, command('spacerun'), 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(findPermissionMenuTarget(live, drawnRows(live).join('\n'), 'allow').ok).toBe(true);
});
