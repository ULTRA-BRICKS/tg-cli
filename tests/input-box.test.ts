import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { messageStillTyped } from '../features/tg-ctl/input-box';
import type { AgentKind } from '../features/tg-ctl/types';

// tg-cli#463: fixtures are real `tmux capture-pane -p -J` screens (bottom 20 lines)
// of claude 2.1.285, codex 0.153.4 and omp 18.3.0, taken 2026-09-30 on a throwaway
// tmux server. In every "submitted"/"busy" screen the message is still on screen,
// echoed in the transcript above the box — only the box may count.
const screen = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'input-box', `${name}.txt`), 'utf8');

const HARNESSES: Array<{ agent: AgentKind; word: string; queued: string }> = [
  { agent: 'claude', word: 'cc', queued: '[TG from tg tg#44] queued cc msg' },
  { agent: 'codex', word: 'codex', queued: '[TG from tg tg#44] queued codex msg' },
  { agent: 'omp', word: 'omp', queued: '[TG from tg tg#43] queued omp msg' },
];
const MULTILINE = '[TG from tg tg#45] line one\nline two\nline three';
const PASTE = `[TG from tg tg#46] big paste\n${Array.from({ length: 30 }, (_, i) => `row ${i + 1} of a long paste with words`).join('\n')}\n`;

for (const { agent, word, queued } of HARNESSES) {
  const typed = `[TG from tg tg#42] hello ${word} pending`;

  test(`${agent}: text left in the input box after Enter is still typed`, () => {
    expect(messageStillTyped(agent, screen(`${agent}-typed`), typed)).toBe(true);
  });

  test(`${agent}: a submitted message echoed in the transcript is not still typed`, () => {
    expect(messageStillTyped(agent, screen(`${agent}-submitted`), typed)).toBe(false);
  });

  test(`${agent}: a message queued/steered into a busy agent is not still typed`, () => {
    expect(messageStillTyped(agent, screen(`${agent}-busy`), queued)).toBe(false);
  });

  test(`${agent}: a multi-line paste re-wrapped inside the box is still typed`, () => {
    expect(messageStillTyped(agent, screen(`${agent}-multiline`), MULTILINE)).toBe(true);
  });

  test(`${agent}: a long paste collapsed into the harness placeholder is still typed`, () => {
    expect(messageStillTyped(agent, screen(`${agent}-paste`), PASTE)).toBe(true);
  });

  test(`${agent}: a different message in the box is not this one`, () => {
    expect(messageStillTyped(agent, screen(`${agent}-typed`), '[TG from tg tg#99] something else entirely')).toBe(false);
  });
}

test('a single-line message never matches a collapsed-paste placeholder', () => {
  expect(messageStillTyped('claude', screen('claude-paste'), '[TG from tg tg#47] one line')).toBe(false);
});

test('a short text counts only at the end of the box input, never inside a placeholder or footer', () => {
  // codex: the footer below the composer reads "/private/tmp/t463/w" — a raw "4" answer is not typed.
  expect(messageStillTyped('codex', screen('codex-submitted'), '4')).toBe(false);
  // codex placeholder "Ask Codex to do anything" contains "do", which is not typed.
  expect(messageStillTyped('codex', screen('codex-submitted'), 'do')).toBe(false);
  // A short text that IS the end of the box input is still typed.
  expect(messageStillTyped('claude', screen('claude-typed'), 'pending')).toBe(true);
  expect(messageStillTyped('codex', screen('codex-typed'), 'pending')).toBe(true);
});

test('a short text that is the end of a harness placeholder is not typed (the box is empty)', () => {
  // codex draws "› Ask Codex to do anything" in its empty composer.
  expect(messageStillTyped('codex', screen('codex-submitted'), 'anything')).toBe(false);
  expect(messageStillTyped('codex', screen('codex-busy'), 'do anything')).toBe(false);
  // claude, busy with a queued message, draws "❯ Press up to edit queued messages".
  expect(messageStillTyped('claude', screen('claude-busy'), 'messages')).toBe(false);
});

// A `───` line inside a pasted multi-line message is drawn indented inside the box,
// so it must not be taken for the box's own top rule.
const RULE_LINE = '─'.repeat(40);
const WITH_RULE = `[TG from tg tg#45] line one\n${RULE_LINE}\nline three`;

test('claude: a message with a ─── line of its own, left in the box, is still typed', () => {
  const s = screen('claude-multiline').replace('  line two', `  ${RULE_LINE}`);
  expect(messageStillTyped('claude', s, WITH_RULE)).toBe(true);
});

test('omp: a message with a ─── line of its own, left in the box, is still typed', () => {
  const s = screen('omp-multiline').replace(' line two', ` ${RULE_LINE}`);
  expect(messageStillTyped('omp', s, WITH_RULE)).toBe(true);
});

test('codex: a message with a paragraph break is read whole, the footer below the blank line is not', () => {
  // Live layout: composer lines, a blank line, then the model/cwd footer.
  const screen = '› [TG from tg tg#5] short intro\n\n  long body\n\n  gpt-6-astra medium · /private/tmp/t463/w';
  expect(messageStillTyped('codex', screen, '[TG from tg tg#5] short intro\n\nlong body')).toBe(true);
  expect(messageStillTyped('codex', screen, '463')).toBe(false);
});

test('harness without an adapter, or no box on screen → cannot tell (null)', () => {
  expect(messageStillTyped('opencode', screen('claude-typed'), '[TG from tg tg#42] hello cc pending')).toBeNull();
  expect(messageStillTyped('claude', 'plain shell\n$ ', 'x')).toBeNull();
  expect(messageStillTyped('codex', '', 'x')).toBeNull();
});
