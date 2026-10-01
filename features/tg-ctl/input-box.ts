// Harness input-box reader (tg-cli#463): is a message tg-ctl typed into a pane still
// sitting in the agent's input box, i.e. its submitting Enter was lost?
//
// This is the ONLY place that knows how each harness draws its input box
// (harness adapter boundary, tg#16810): the delivery path asks
// `messageStillTyped(agent, screen, text)` and never branches on a harness name.
// When harness-cli (#377) reports prompt state, this file becomes a thin client.
// PURE — the daemon runs `tmux capture-pane -p -J` and passes the text in.
//
// Layouts, from live captures (tests/fixtures/input-box, 2026-09-30):
//   claude  v2.1  ─── rule / `❯ text` / ─── rule / footer
//   omp     v18   ─── rule / ` text` / ─── rule / status line
//   codex   v0.153 `› text` composer (continuation lines indented) above the footer
// The submitted message is echoed in the transcript ABOVE the box in all three, so
// "the text is still on screen" is never the test — only the box counts.

import { safeSliceEnd } from './text-util';
import type { AgentKind } from './types';

// A horizontal rule: the full-width `───` line claude and omp draw around the box
// (with corners for the older claude `╭───╮ │ > … │ ╰───╯` box). Anchored at column 0:
// every line INSIDE the box is indented (claude `❯ `/`  `, omp ` `), so a `───` line
// of a pasted message is never taken for the box's own rule.
const RULE = /^[╭╰]?─{8,}[╮╯]?\s*$/;

// The box is the bottom-most rule pair; `prompt` (when the harness draws one) must
// open the line right under the top rule, so the pair is the input box and not two
// rules of something else drawn below it.
function betweenRules(prompt: RegExp | null): (screen: string) => string | null {
  return (screen) => {
    const lines = screen.split('\n');
    let bottom = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!RULE.test(lines[i])) continue;
      if (bottom < 0) bottom = i;
      else if (prompt === null || prompt.test(lines[i + 1] ?? '')) return lines.slice(i + 1, bottom).join('\n');
      else bottom = i;
    }
    return null;
  };
}

// Codex's composer starts at the LAST `› ` line (the transcript echoes each
// submitted message with the same glyph above it) and runs to the model/cwd footer:
// the last non-blank line, below a blank one. A message's own blank lines (paragraph
// breaks) stay inside the composer.
function fromLastChevron(screen: string): string | null {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('› ')) continue;
    let footer = lines.length - 1;
    while (footer > i && lines[footer].trim() === '') footer--;
    const hasFooter = footer > i + 1 && lines[footer - 1].trim() === '';
    return lines.slice(i, hasFooter ? footer : undefined).join('\n');
  }
  return null;
}

interface InputBoxAdapter {
  read: (screen: string) => string | null;
  // A long paste the harness collapsed into a placeholder: still unsubmitted.
  collapsedPaste: RegExp;
  // The hint the harness draws in an EMPTY box (tested against the whole trimmed box):
  // its words are not input, so a short text never matches their end.
  emptyHint: RegExp | null;
}

const ADAPTERS: Partial<Record<AgentKind, InputBoxAdapter>> = {
  claude: {
    read: betweenRules(/^(?:│\s*)?[❯>]/),
    collapsedPaste: /\[Pasted text #\d+/,
    emptyHint: /^(?:│\s*)?[❯>]\s*(?:Press up to edit queued messages|Try ".*")\s*│?$/,
  },
  omp: { read: betweenRules(null), collapsedPaste: /📄 #\d+/, emptyHint: null },
  codex: {
    read: fromLastChevron,
    collapsedPaste: /\[Pasted Content \d+ chars\]/,
    // codex 0.153: the default hint, or one of its rotating example prompts.
    emptyHint:
      /^›\s*(?:Ask Codex to do anything|Explain this codebase|Summarize recent commits|Implement \{feature\}|Find and fix a bug in @filename|Write tests for @filename|Improve documentation in @filename|Run \/review on my current changes|Use \/skills to list available skills)$/,
  },
};

// Compared with ALL whitespace and box borders removed: the TUIs re-wrap the text
// inside the box (indenting continuation lines), so only the characters are stable.
const WRAP_NOISE = /[\s│]+/g;
// Long enough to carry the message's own id and content past a `[TG from <long name>
// tg#<id>]` wrap, so another message from the same sender never matches.
const PROBE_CHARS = 64;
// A shorter text (a bare "continue", a raw "4" answer) could be a substring of a
// hint or footer; it counts only as the END of the box's input.
const SHORT_PROBE_CHARS = 16;

// true = still in the input box (Enter lost), false = the box no longer holds it,
// null = this harness has no adapter or its box is not on screen (cannot tell).
export function messageStillTyped(agent: AgentKind, screen: string, text: string): boolean | null {
  const adapter = ADAPTERS[agent];
  if (!adapter) return null;
  const box = adapter.read(screen);
  if (box === null) return null;
  if (adapter.emptyHint?.test(box.trim())) return false;
  const squashed = text.replace(WRAP_NOISE, '');
  const probe = squashed.slice(0, safeSliceEnd(squashed, PROBE_CHARS));
  const input = box.replace(WRAP_NOISE, '');
  if (probe !== '' && (probe.length < SHORT_PROBE_CHARS ? input.endsWith(probe) : input.includes(probe))) return true;
  return text.includes('\n') && adapter.collapsedPaste.test(box);
}
