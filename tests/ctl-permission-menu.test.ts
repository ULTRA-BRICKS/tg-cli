import { expect, test } from 'bun:test';
import {
  classifyPostInjectPane,
  extractPermissionIdentity,
  findPermissionMenuTarget,
  parsePermissionMenu,
  permissionMenuMatchesRequest,
  permissionMenuUnchanged,
  pickPermissionMenuDigit,
} from '../features/tg-ctl/permission-menu';
import { truncateWithEllipsis } from '../features/tg-ctl/text-util';
import { DANGEROUS_LONG, permissionBoxFor as boxFor, SAFE_LONG, SHARED_99 } from './fixtures/permission-menu';

const TWO_OPTION_PANE = `
 Bash command

   pkill -f nonexistent-process-xyz-test
   Kill any process matching test pattern

 Permission rule Bash(pkill:*) requires
 confirmation for this command.
 /permissions to update rules

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

const THREE_OPTION_PANE = `
 Bash command · from the fork agent
   some command --flag

 Ask rule Bash(some:*) overrides auto mode for this command.
 /permissions to let auto mode decide

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for: some command --flag
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

const NO_MENU_PANE = `
⏺ Bash(pkill -f nonexistent-process-xyz-test)
  ⎿  Error: Exit code 1

✻ Cooked for 10s
`;

// --- parsePermissionMenu: options ---

test('parses a 2-option Yes/No menu', () => {
  expect(parsePermissionMenu(TWO_OPTION_PANE)?.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: 'No' },
  ]);
});

test('parses a 3-option menu with a "don\'t ask again" variant', () => {
  expect(parsePermissionMenu(THREE_OPTION_PANE)?.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: "Yes, and don't ask again for: some command --flag" },
    { digit: '3', label: 'No' },
  ]);
});

test('returns null when the pane shows no live menu', () => {
  expect(parsePermissionMenu(NO_MENU_PANE)).toBeNull();
});

test('returns null on an empty or unrelated pane', () => {
  expect(parsePermissionMenu('')).toBeNull();
  expect(parsePermissionMenu('just some random terminal output\nno menu here')).toBeNull();
});

test('stops collecting options at the first non-numbered line after the marker', () => {
  const pane = `Do you want to proceed?\n 1. Yes\n 2. No\n\n Esc to cancel`;
  expect(parsePermissionMenu(pane)?.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: 'No' },
  ]);
});

// --- pickPermissionMenuDigit ---

test('allow picks the plain "Yes" digit, not "don\'t ask again"', () => {
  const menu = parsePermissionMenu(THREE_OPTION_PANE)!;
  expect(pickPermissionMenuDigit(menu.options, 'allow')).toBe('1');
});

test('deny picks the "No" digit', () => {
  const menu = parsePermissionMenu(THREE_OPTION_PANE)!;
  expect(pickPermissionMenuDigit(menu.options, 'deny')).toBe('3');
});

test('2-option menu: allow → 1, deny → 2', () => {
  const menu = parsePermissionMenu(TWO_OPTION_PANE)!;
  expect(pickPermissionMenuDigit(menu.options, 'allow')).toBe('1');
  expect(pickPermissionMenuDigit(menu.options, 'deny')).toBe('2');
});

test('returns null when no matching option exists', () => {
  expect(pickPermissionMenuDigit([{ digit: '1', label: 'Maybe' }], 'allow')).toBeNull();
  expect(pickPermissionMenuDigit([{ digit: '1', label: 'Maybe' }], 'deny')).toBeNull();
});

test('returns null on an empty options list', () => {
  expect(pickPermissionMenuDigit([], 'allow')).toBeNull();
});

test('allow does NOT match a wide "yes" variant that is not literally "Yes" (allowlist, not blocklist)', () => {
  // Beyond "don't ask again", Claude Code has other broad yes-variants (e.g.
  // "Yes, allow all edits during this session") — an exact match means a tap
  // never silently grants one of those instead of a plain one-time yes.
  const options = [{ digit: '1', label: 'Yes, allow all edits during this session' }, { digit: '2', label: 'No' }];
  expect(pickPermissionMenuDigit(options, 'allow')).toBeNull();
});

test('a verbose deny label ("No, and tell Claude what to do differently") is NOT matched — known gap, safely falls through to queuing', () => {
  // Unlike a wide "yes" variant (unsafe to auto-grant), a verbose "No, ..."
  // is still unambiguously a refusal — but this module's exact-match keeps
  // deny symmetric with allow rather than risk-assessing per-decision, so
  // this case currently returns null (pane-inject path skipped, existing
  // queue-and-wait fallback used instead — never a wrong action, just a
  // missed optimization). Tracked as a follow-up (tg-cli#268) to confirm the
  // REAL rendered label live and prefix-match deny specifically if warranted.
  const options = [{ digit: '1', label: 'Yes' }, { digit: '2', label: 'No, and tell Claude what to do differently (esc)' }];
  expect(pickPermissionMenuDigit(options, 'deny')).toBeNull();
});

// --- parsePermissionMenu: last-occurrence scan ---

test('scans from the LAST "Do you want to proceed?" occurrence, not the first', () => {
  // The marker can appear earlier in scrollback (e.g. the agent's own output
  // relaying a past prompt) — only the LAST one is the live, answerable menu.
  const pane = [
    'Do you want to proceed?',
    ' 1. Yes',
    ' 2. No',
    '',
    'some transcript noise mentioning the phrase again',
    '',
    'Do you want to proceed?',
    ' 1. Yes',
    ' 2. Yes, and don\'t ask again for: rm -rf /tmp/x',
    ' 3. No',
  ].join('\n');
  expect(parsePermissionMenu(pane)?.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: "Yes, and don't ask again for: rm -rf /tmp/x" },
    { digit: '3', label: 'No' },
  ]);
});

test('a two-digit option number is never captured (single-digit regex only)', () => {
  const pane = 'Do you want to proceed?\n 9. Yes\n 10. No';
  // "10." does not match the single-digit OPTION_LINE — parsing stops there,
  // leaving only the one real option found before it.
  expect(parsePermissionMenu(pane)?.options).toEqual([{ digit: '9', label: 'Yes' }]);
});

test('a marker with no option on the immediately-following line (beyond 1 blank) returns null, not a distant unrelated numbered list', () => {
  // The marker here is stale/relayed scrollback (no live menu) — real
  // prose separates it from an unrelated numbered list further down, which
  // must NOT be mistaken for this "menu"'s own options (review finding: an
  // earlier version scanned past arbitrary lines looking for the first
  // option, silently un-bounding the context window along with it).
  const pane = [
    'Do you want to proceed? the user asked, quoting an earlier turn.',
    'I explained the tradeoffs in detail across several paragraphs of',
    'reasoning before getting to the actual recommendation for the team.',
    '',
    'Here are the options to consider going forward:',
    '1. Ship it now',
    '2. Wait for review',
  ].join('\n');
  expect(parsePermissionMenu(pane)).toBeNull();
});

test('tolerates exactly ONE blank line between the marker and the first option', () => {
  const pane = 'Do you want to proceed?\n\n 1. Yes\n 2. No';
  expect(parsePermissionMenu(pane)?.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: 'No' },
  ]);
});

// --- parsePermissionMenu: context window (bounded, not the whole pane) ---

test('context is bounded to MENU_CONTEXT_LINES before the marker, not the whole pane', () => {
  // A unique marker on line 0, then enough distinct filler that it falls
  // outside the bounded window by the time the menu appears. A naive
  // "whole pane" context would include line 0; the bounded context must not.
  const filler = Array.from({ length: 19 }, (_, i) => `filler line ${i}`);
  const pane = ['OLD-COMMAND-MARKER', ...filler, '', 'Do you want to proceed?', ' 1. Yes', ' 2. No'].join('\n');
  const menu = parsePermissionMenu(pane)!;
  expect(menu.context).not.toContain('OLD-COMMAND-MARKER');
});

test('context DOES include the command block that sits close to the marker', () => {
  const pane = ['Bash command', '', '  pkill -f nonexistent-process-xyz-test', '', 'Do you want to proceed?', ' 1. Yes', ' 2. No'].join(
    '\n',
  );
  const menu = parsePermissionMenu(pane)!;
  expect(menu.context).toContain('pkill -f nonexistent-process-xyz-test');
});

// --- extractPermissionIdentity ---

test('toolInput present but with none of the 4 recognized keys falls back to the question text', () => {
  expect(extractPermissionIdentity({ question: 'Allow Task? do the thing', toolInput: { description: 'do the thing' } })).toBe(
    'do the thing',
  );
});

test('prefers toolInput.command over the question text', () => {
  expect(
    extractPermissionIdentity({ question: 'Allow Bash? pkill -f x', toolInput: { command: 'pkill -f nonexistent-process-xyz-test' } }),
  ).toBe('pkill -f nonexistent-process-xyz-test');
});

test('falls back through file_path, path, url in priority order', () => {
  expect(extractPermissionIdentity({ question: 'Allow Write?', toolInput: { file_path: '/tmp/a.txt', path: '/tmp/b.txt' } })).toBe(
    '/tmp/a.txt',
  );
  expect(extractPermissionIdentity({ question: 'Allow Fetch?', toolInput: { url: 'https://example.com' } })).toBe('https://example.com');
});

test('falls back to the question text with the "Allow <Tool>? " prefix stripped when there is no toolInput', () => {
  expect(extractPermissionIdentity({ question: 'Allow Bash? pkill -f nonexistent-process-xyz-test' })).toBe(
    'pkill -f nonexistent-process-xyz-test',
  );
});

test('a manual/back-compat question with no "Allow <SingleWord>?" prefix is used verbatim', () => {
  // Multi-word text before the "?" (e.g. "bash command: pkill -f x") must NOT
  // match the prefix regex — only a single whitespace-free tool-name token
  // does, matching hook-normalize.ts's literal `Allow ${toolName}? ` shape.
  expect(extractPermissionIdentity({ question: 'Allow bash command: pkill -f x?' })).toBe('Allow bash command: pkill -f x?');
});

test('"Allow <Tool>?" with no trailing detail has no identity at all (null — nothing to bind against)', () => {
  expect(extractPermissionIdentity({ question: 'Allow Bash?' })).toBeNull();
});

test('SECURITY #309: a question summary hook-normalize truncated ("…") is not an identity — null, never a prefix to match', () => {
  // No toolInput survived, so the only text is the 100-char question summary;
  // its 99-char prefix is shared by SAFE_LONG and DANGEROUS_LONG alike.
  const question = `Allow Bash? ${truncateWithEllipsis(SAFE_LONG, 100)}`;
  expect(extractPermissionIdentity({ question })).toBeNull();
});

test('a full command from toolInput is the identity even when the question summary was truncated', () => {
  const question = `Allow Bash? ${truncateWithEllipsis(SAFE_LONG, 100)}`;
  expect(extractPermissionIdentity({ question, toolInput: { command: SAFE_LONG } })).toBe(SAFE_LONG);
});

// --- permissionMenuMatchesRequest ---

test('matches when the identity text appears verbatim in the menu context', () => {
  const menu = parsePermissionMenu(TWO_OPTION_PANE)!;
  expect(permissionMenuMatchesRequest(menu.context, 'pkill -f nonexistent-process-xyz-test')).toBe(true);
});

test('does not match a DIFFERENT command — the stale-tap-approves-wrong-thing guard', () => {
  const menu = parsePermissionMenu(TWO_OPTION_PANE)!;
  expect(permissionMenuMatchesRequest(menu.context, 'rm -rf /some/other/path')).toBe(false);
});

test('matches across irregular internal whitespace on the SAME line (both sides normalized)', () => {
  // A genuinely wrapped command is already re-joined into one logical line by
  // `-J` before this module ever sees it (capturePane) — what real terminal
  // rendering DOES vary is internal spacing on that one line.
  const pane = 'Bash command\n\n   pkill  -f   nonexistent-process-xyz-test\n\nDo you want to proceed?\n 1. Yes\n 2. No';
  const menu = parsePermissionMenu(pane)!;
  expect(permissionMenuMatchesRequest(menu.context, 'pkill -f nonexistent-process-xyz-test')).toBe(true);
});

test('SECURITY: a stale identity that is a whitespace-bounded PREFIX of a materially different live command does NOT match', () => {
  // The exact escalation case two independent reviewers flagged: a boundary-
  // aware substring check still finds "git push" inside "git push --force"
  // (both genuinely end/continue at a space) — only line-exact matching
  // correctly tells these apart, since a command is always its own line.
  const pane = 'Bash command\n\n   git push --force\n\nDo you want to proceed?\n 1. Yes\n 2. No';
  const menu = parsePermissionMenu(pane)!;
  expect(permissionMenuMatchesRequest(menu.context, 'git push')).toBe(false);
  expect(permissionMenuMatchesRequest(menu.context, 'git push --force')).toBe(true);
});

test('SECURITY: a short identity does not match inside an unrelated longer word', () => {
  const pane = 'Permission rule requires confirmation for this command.\n\nDo you want to proceed?\n 1. Yes\n 2. No';
  const menu = parsePermissionMenu(pane)!;
  expect(permissionMenuMatchesRequest(menu.context, 'rm')).toBe(false); // NOT inside "confi_rm_ation"
});

test('SECURITY: a path does not match a longer path sharing its prefix', () => {
  const pane = 'Write file\n\n   /tmp/a.txt.bak\n\nDo you want to proceed?\n 1. Yes\n 2. No';
  const menu = parsePermissionMenu(pane)!;
  expect(permissionMenuMatchesRequest(menu.context, '/tmp/a.txt')).toBe(false); // NOT a prefix of "/tmp/a.txt.bak"
  expect(permissionMenuMatchesRequest(menu.context, '/tmp/a.txt.bak')).toBe(true);
});

test('SECURITY #309: two commands sharing a 99-char prefix never match each other, truncated identity or not', () => {
  expect(SHARED_99.length).toBe(99);
  const live = parsePermissionMenu(boxFor(DANGEROUS_LONG))!;
  // The truncated form a 100-char question summary carries for the SAFE command.
  expect(permissionMenuMatchesRequest(live.context, truncateWithEllipsis(SAFE_LONG, 100))).toBe(false);
  expect(permissionMenuMatchesRequest(live.context, SAFE_LONG)).toBe(false);
  expect(permissionMenuMatchesRequest(live.context, DANGEROUS_LONG)).toBe(true);
});

test('SECURITY #309: a menu that renders the command TRUNCATED never matches the full identity', () => {
  // If the box ever shortens a long command ("…"), the visible line cannot prove
  // which of SAFE_LONG / DANGEROUS_LONG it is — refuse, the decision stays queued.
  const live = parsePermissionMenu(boxFor(`${SHARED_99}…`))!;
  expect(permissionMenuMatchesRequest(live.context, SAFE_LONG)).toBe(false);
  expect(permissionMenuMatchesRequest(live.context, `${SHARED_99}…`)).toBe(false);
});

test('an empty identity never matches (avoids a vacuous true on empty context)', () => {
  const menu = parsePermissionMenu(TWO_OPTION_PANE)!;
  expect(permissionMenuMatchesRequest(menu.context, '')).toBe(false);
  expect(permissionMenuMatchesRequest(menu.context, '   ')).toBe(false);
});

// --- the exact bypass two independent reviewers found: an OLD, already-resolved
// permission's leftover scrollback must not satisfy the identity check for a
// DIFFERENT, currently-live menu ---

test('SECURITY: an old resolved command far above a new live menu does not satisfy identity matching for the OLD request', () => {
  // Request A ("pkill -f x") was already answered at the keyboard; its
  // resolved echo is still visible. Request B ("rm -rf /some/path") now has
  // its OWN live menu further down, separated by enough turn output that A's
  // echo falls outside the bounded context window. A stale tap for A must
  // never match against B's menu just because A's text is still somewhere
  // (far) up the pane.
  const pane = [
    '⏺ Bash(pkill -f nonexistent-process-xyz-test)', // A's resolved echo (old, far above)
    '  ⎿  (no processes matched)',
    '',
    '✻ Thinking about the next step…',
    '',
    'I ran the cleanup command and it found nothing to kill, so now let me',
    'check whether the target path needs to be removed as the next step in',
    'this cleanup sequence before moving on to the final verification pass.',
    '',
    '✻ Composing a plan for the next command…',
    '',
    'Bash command',
    '',
    '  rm -rf /some/totally/different/path', // B's own command, close to B's marker
    '',
    'Do you want to proceed?',
    ' 1. Yes',
    ' 2. No',
  ].join('\n');
  const menu = parsePermissionMenu(pane)!;
  expect(menu.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: 'No' },
  ]);
  // The bounded context must NOT reach back far enough to include A's line.
  expect(menu.context).not.toContain('pkill -f nonexistent-process-xyz-test');
  expect(permissionMenuMatchesRequest(menu.context, 'pkill -f nonexistent-process-xyz-test')).toBe(false);
  // It DOES correctly identify B's own command.
  expect(permissionMenuMatchesRequest(menu.context, 'rm -rf /some/totally/different/path')).toBe(true);
});

test('hasLiveCursor is true when an option line carries the cursor glyph', () => {
  const menu = parsePermissionMenu(TWO_OPTION_PANE)!;
  expect(menu.hasLiveCursor).toBe(true);
});

test('hasLiveCursor is false for the identical menu once the cursor glyph is gone — review finding: text alone must not be read as still-live', () => {
  // Same marker, same options, same everything — EXCEPT no reviewer/session has
  // confirmed whether Claude Code erases a resolved menu from the pane or
  // leaves it as static scrollback history. This fixture models the second
  // case: the box is still visible, but nothing is actively selecting an
  // option anymore.
  const resolvedButRetained = TWO_OPTION_PANE.replace('❯ 1. Yes', '  1. Yes');
  const menu = parsePermissionMenu(resolvedButRetained)!;
  expect(menu.options).toEqual([
    { digit: '1', label: 'Yes' },
    { digit: '2', label: 'No' },
  ]);
  expect(menu.hasLiveCursor).toBe(false);
});

test('hasLiveCursor is true if the cursor sits on a later option, not just the first', () => {
  const cursorOnSecond = THREE_OPTION_PANE.replace('❯ 1. Yes', '  1. Yes').replace(
    "  2. Yes, and don't ask again for: some command --flag",
    "❯ 2. Yes, and don't ask again for: some command --flag",
  );
  const menu = parsePermissionMenu(cursorOnSecond)!;
  expect(menu.hasLiveCursor).toBe(true);
});

// --- findPermissionMenuTarget / permissionMenuUnchanged / classifyPostInjectPane (tg-cli#309) ---

const PKILL = 'pkill -f nonexistent-process-xyz-test';

test('findPermissionMenuTarget: a live menu for the request yields its digit and box', () => {
  const found = findPermissionMenuTarget(TWO_OPTION_PANE, PKILL, 'deny');
  expect(found.ok).toBe(true);
  if (!found.ok) return;
  expect(found.target.digit).toBe('2');
  expect(found.target.box.split('\n')[0]).toBe(PKILL);
  expect(found.target.box.split('\n').at(-1)).toBe('2. No');
});

test('findPermissionMenuTarget: names why nothing is injectable', () => {
  expect(findPermissionMenuTarget(TWO_OPTION_PANE, null, 'allow')).toEqual({ ok: false, reason: 'identity-unverifiable' });
  expect(findPermissionMenuTarget(null, PKILL, 'allow')).toEqual({ ok: false, reason: 'no-menu' });
  expect(findPermissionMenuTarget(NO_MENU_PANE, PKILL, 'allow')).toEqual({ ok: false, reason: 'no-menu' });
  expect(findPermissionMenuTarget(TWO_OPTION_PANE.replace('❯ 1. Yes', '  1. Yes'), PKILL, 'allow')).toEqual({ ok: false, reason: 'no-live-cursor' });
  expect(findPermissionMenuTarget(boxFor(DANGEROUS_LONG), SAFE_LONG, 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  const verboseNo = TWO_OPTION_PANE.replace('2. No', '2. No, and tell Claude what to do differently');
  expect(findPermissionMenuTarget(verboseNo, PKILL, 'deny')).toEqual({ ok: false, reason: 'no-pickable-option' });
});

test('permissionMenuUnchanged: the same live box passes the pre-send gate', () => {
  const found = findPermissionMenuTarget(boxFor(SAFE_LONG), SAFE_LONG, 'allow');
  if (!found.ok) throw new Error('expected a target');
  expect(permissionMenuUnchanged(boxFor(SAFE_LONG), found.target)).toBe(true);
  // Scrollback ABOVE the box moving does not matter — only the box itself.
  expect(permissionMenuUnchanged(`⏺ earlier output\n${boxFor(SAFE_LONG)}`, found.target)).toBe(true);
});

test('SECURITY #309: permissionMenuUnchanged fails when a different command took the spot, the pane is unreadable, the menu resolved, or the human moved the cursor', () => {
  const found = findPermissionMenuTarget(boxFor(SAFE_LONG), SAFE_LONG, 'allow');
  if (!found.ok) throw new Error('expected a target');
  expect(permissionMenuUnchanged(boxFor(DANGEROUS_LONG), found.target)).toBe(false);
  expect(permissionMenuUnchanged(null, found.target)).toBe(false);
  expect(permissionMenuUnchanged(boxFor(SAFE_LONG).replace('❯ 1. Yes', '  1. Yes'), found.target)).toBe(false);
  expect(permissionMenuUnchanged(boxFor(SAFE_LONG).replace('❯ 1. Yes', '  1. Yes').replace('   2. No', ' ❯ 2. No'), found.target)).toBe(false);
});

test('SECURITY #309: permissionMenuUnchanged fails when the SAME command is asked again with a different box', () => {
  // Same command line, different surrounding text (a new request for the same
  // command, e.g. a different description): not the menu the human saw.
  const found = findPermissionMenuTarget(TWO_OPTION_PANE, PKILL, 'allow');
  if (!found.ok) throw new Error('expected a target');
  const reasked = TWO_OPTION_PANE.replace('Kill any process matching test pattern', 'Retry the kill after the first attempt');
  expect(permissionMenuUnchanged(reasked, found.target)).toBe(false);
});

test('classifyPostInjectPane: unreadable / still-pending / next-menu / resolved', () => {
  const found = findPermissionMenuTarget(boxFor(SAFE_LONG), SAFE_LONG, 'allow');
  if (!found.ok) throw new Error('expected a target');
  const { target } = found;
  expect(classifyPostInjectPane(null, target)).toBe('unreadable');
  expect(classifyPostInjectPane(boxFor(SAFE_LONG), target)).toBe('still-pending');
  // The prefix-sharing DANGEROUS menu is a different permission, never "still ours".
  expect(classifyPostInjectPane(boxFor(DANGEROUS_LONG), target)).toBe('next-menu');
  expect(classifyPostInjectPane(boxFor(SAFE_LONG).replace('❯ 1. Yes', '  1. Yes'), target)).toBe('resolved');
  expect(classifyPostInjectPane(NO_MENU_PANE, target)).toBe('resolved');
});

test('SECURITY #309: a RESOLVED box for the request left in scrollback right above a DIFFERENT live menu never matches', () => {
  // Review finding: both boxes fit inside the live marker's 12-line context, so an
  // identity search over the whole context finds the stale command line and
  // would answer the live menu below it.
  const resolvedAbove = boxFor(SAFE_LONG).replace('❯ 1. Yes', '  1. Yes');
  const pane = `${resolvedAbove}\n${boxFor(DANGEROUS_LONG)}`;
  expect(findPermissionMenuTarget(pane, SAFE_LONG, 'allow')).toEqual({ ok: false, reason: 'identity-mismatch' });
  expect(permissionMenuMatchesRequest(parsePermissionMenu(pane)!.context, SAFE_LONG)).toBe(false);
  expect(findPermissionMenuTarget(pane, DANGEROUS_LONG, 'allow').ok).toBe(true);
});
