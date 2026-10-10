// Property tests for the harness input-box reader (features/tg-ctl/input-box.ts, tg-cli#463,
// #606) against the real captures in tests/fixtures/input-box. Any message, re-wrapped by
// the TUI at any width, still reads as typed while it sits in the box; the same message only
// echoed in the transcript above an empty box never does.
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { messageStillTyped } from '../features/tg-ctl/input-box';
import type { AgentKind } from '../features/tg-ctl/types';
import { ATOMS, arrayOf, forAll, type Gen, int, pick, textOf } from './helpers/prop';

const screen = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'input-box', `${name}.txt`), 'utf8');
const RULE = /^[╭╰]?─{8,}[╮╯]?\s*$/;

// What each TUI draws in front of the first and every further line of the input.
const PREFIX: Record<'claude' | 'omp' | 'codex', { first: string; rest: string }> = {
  claude: { first: '❯\u00a0', rest: '  ' },
  omp: { first: ' ', rest: ' ' },
  codex: { first: '› ', rest: '  ' },
};
const AGENTS = ['claude', 'omp', 'codex'] as const;

// Lay the message out the way the TUI does: each line of it wrapped at `width` code points.
function render(agent: (typeof AGENTS)[number], text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const cps = [...line];
    if (cps.length === 0) out.push('');
    for (let i = 0; i < cps.length; i += width) out.push(cps.slice(i, i + width).join(''));
  }
  return out.map((l, i) => (l === '' ? '' : `${i === 0 ? PREFIX[agent].first : PREFIX[agent].rest}${l}`));
}

// Replace the input box of a captured screen with `lines`.
function withBox(agent: (typeof AGENTS)[number], s: string, lines: string[]): string {
  const rows = s.split('\n');
  if (agent === 'codex') {
    const top = rows.findLastIndex((l) => l.startsWith('› '));
    let footer = rows.length - 1;
    while (rows[footer].trim() === '') footer--;
    return [...rows.slice(0, top), ...lines, '', ...rows.slice(footer)].join('\n');
  }
  const bottom = rows.findLastIndex((l) => RULE.test(l));
  const top = rows.slice(0, bottom).findLastIndex((l) => RULE.test(l));
  return [...rows.slice(0, top + 1), ...lines, ...rows.slice(bottom)].join('\n');
}

// A wrapped inbound message: the tg-ctl envelope, then words of any script, maybe several lines.
const WORDS = [...ATOMS.ascii, ...ATOMS.cyrillic, ...ATOMS.cjk, ...ATOMS.emoji, ...ATOMS.html, 'continue', '│', '──'];
const message: Gen<string> = (rng) => {
  const lines = arrayOf(textOf([...WORDS, ' ', ' '], 1, 14), 1, 4)(rng);
  return `[TG from tg tg#${int(1, 99_999)(rng)}] ${lines.join(pick(['\n', '\n', '\n\n'])(rng))}`;
};

for (const agent of AGENTS) {
  test(`${agent}: a message left in the box reads as typed at any wrap width`, () => {
    const base = screen(`${agent}-typed`);
    forAll(`input-box-typed-${agent}`, (rng) => ({ text: message(rng), width: int(8, 90)(rng) }), ({ text, width }) => {
      const s = withBox(agent, base, render(agent, text, width));
      expect(messageStillTyped(agent as AgentKind, s, text)).toBe(true);
    });
  });

  test(`${agent}: a message only echoed in the transcript above an empty box is not typed`, () => {
    const base = screen(`${agent}-submitted`);
    forAll(`input-box-echo-${agent}`, (rng) => ({ text: message(rng), width: int(8, 90)(rng) }), ({ text, width }) => {
      const echo = render(agent, text, width);
      const rows = base.split('\n');
      const s = [...echo, '', ...rows].join('\n');
      expect(messageStillTyped(agent as AgentKind, s, text)).toBe(false);
    });
  });

  test(`${agent}: another message in the box is never taken for this one`, () => {
    const base = screen(`${agent}-typed`);
    forAll(`input-box-other-${agent}`, (rng) => ({ inBox: message(rng), mine: message(rng), width: int(8, 90)(rng) }), ({ inBox, mine, width }) => {
      if (inBox.replace(/[\s│]+/g, '').includes(mine.replace(/[\s│]+/g, '').slice(0, 30))) return;
      const s = withBox(agent, base, render(agent, inBox, width));
      expect(messageStillTyped(agent as AgentKind, s, mine)).toBe(false);
    });
  });
}
