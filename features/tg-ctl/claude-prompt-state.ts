// Is a Claude Code prompt still waiting for the human? (tg-cli#304)
//
// PURE. Two independent signals, both measured in the study
// docs/research/2026-09-04-claude-code-tmux-prompts.md (Claude Code 2.1.261, tmux 3.5a):
//
// 1. The pane (`readPendingClaudePrompt`): every interactive prompt — Bash/Edit permission, plan
//    approval, AskUserQuestion (each tab and the multi-question review screen) — replaces Claude
//    Code's idle input box (a `❯` line between two horizontal rules) with a numbered option list
//    whose selected row carries the `❯` cursor. A prompt is pending exactly when the capture has
//    such a cursor row and no idle input box below it. Answering, denying or Esc-ing the prompt
//    brings the input box back; a digit that is not an option, a late hook reply, or a keypress
//    sent while the pane is in tmux copy-mode leaves it up (findings 06–08).
// 2. The per-process registry `<config>/sessions/<pid>.json` (`parseClaudeSessionRecord`):
//    `status: "waiting"` with `waitingFor: "permission prompt"` (permissions and plan approval) or
//    `"input needed"` (AskUserQuestion), else `idle` / `busy`. It reports "waiting" for the whole
//    time the harness is blocked — while a PermissionRequest hook is still deciding too, not only
//    once the terminal prompt shows (06 frames/index.tsv). The file survives SIGKILL, so whether
//    the asker is gone is a pid + procStart question for the caller, never the file's existence.
//
// Shapes the study did not capture (Write/WebFetch/MCP permissions, other "Do you want to …?"
// menus) still read as pending — the cursor-row rule is shape-independent — with kind 'unknown'.

export type ClaudePromptKind = 'permission' | 'edit' | 'plan' | 'question' | 'question-review' | 'unknown';

export interface ClaudePromptOption {
  digit: string;
  label: string;
}

export interface PendingClaudePrompt {
  kind: ClaudePromptKind;
  // The line directly above the option list: "Do you want to proceed?", the question text, …
  marker: string;
  options: ClaudePromptOption[];
  // Digit of the row under the `❯` cursor (moves with ↑/↓ without answering).
  selected: string;
}

const OPTION = /^\s*(?:❯\s*)?(\d)\.\s+(.*\S)\s*$/;
const CURSOR_OPTION = /^\s*❯\s*(\d)\.\s+\S/;
const RULE = /^\s*─{3,}\s*$/;
const INPUT_LINE = /^❯(?:\s.*)?$/;
// Option descriptions (AskUserQuestion) and wrapped hints sit deeper than any marker line.
const CONTINUATION_INDENT = 4;
const QUESTION_TABS = /[☐☒]/;

// Claude Code's idle input box: a `❯` line whose nearest non-blank neighbours are both rules. An
// AskUserQuestion option can also start at column 0 ("❯ 1. Red"), but never between two rules.
function isInputBox(lines: string[], i: number): boolean {
  if (!INPUT_LINE.test(lines[i])) return false;
  const neighbour = (step: number): string | undefined => {
    for (let j = i + step; j >= 0 && j < lines.length; j += step) if (lines[j].trim()) return lines[j];
    return undefined;
  };
  const above = neighbour(-1);
  const below = neighbour(1);
  return above !== undefined && below !== undefined && RULE.test(above) && RULE.test(below);
}

function classify(marker: string, tabsAbove: boolean): ClaudePromptKind {
  if (marker === 'Do you want to proceed?') return 'permission';
  if (/^Do you want to make this edit to .+\?$/.test(marker)) return 'edit';
  if (/Would you like to proceed\?$/.test(marker)) return 'plan';
  if (marker === 'Ready to submit your answers?') return 'question-review';
  if (tabsAbove) return 'question';
  return 'unknown';
}

// `paneText`: a plain `tmux capture-pane -p` of the harness pane. Pass -J on a narrow pane: a
// wrapped marker line (a long edit path) reads as kind 'unknown'; pending is unaffected.
export function readPendingClaudePrompt(paneText: string): PendingClaudePrompt | null {
  const lines = paneText.split('\n').map((l) => l.trimEnd());

  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isInputBox(lines, i)) return null; // the input box is back below any menu: nothing pending
    if (CURSOR_OPTION.test(lines[i])) {
      cursor = i;
      break;
    }
  }
  if (cursor === -1) return null;

  // Walk up over the option rows (and their deeper-indented descriptions) to the marker line.
  let first = cursor;
  let markerIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (OPTION.test(line)) {
      first = i;
      continue;
    }
    if (line.length - line.trimStart().length >= CONTINUATION_INDENT) continue;
    markerIdx = i;
    break;
  }
  const marker = markerIdx === -1 ? '' : lines[markerIdx].trim();

  // Options run 1, 2, 3, … from the first row; a separator rule or a description may sit between
  // two of them ("3. Type something." ─── "4. Chat about this"). A number out of sequence (a
  // numbered line inside a description) ends the list.
  const options: ClaudePromptOption[] = [];
  for (let i = first; i < lines.length; i++) {
    const m = OPTION.exec(lines[i]);
    if (!m) continue;
    if (m[1] !== String(options.length + 1)) break;
    options.push({ digit: m[1], label: m[2] });
  }

  let tabsAbove = false;
  for (let i = markerIdx - 1; i >= 0 && !RULE.test(lines[i]); i--) {
    if (QUESTION_TABS.test(lines[i])) {
      tabsAbove = true;
      break;
    }
  }

  const selected = CURSOR_OPTION.exec(lines[cursor])![1];
  return { kind: classify(marker, tabsAbove), marker, options, selected };
}

export type ClaudeSessionActivity = 'idle' | 'busy' | 'waiting-permission' | 'waiting-input' | 'unknown';

export interface ClaudeSessionRecord {
  pid: number;
  sessionId: string;
  // `ps -o lstart`-style start time: tells a live owner from a reused pid.
  procStart?: string;
  activity: ClaudeSessionActivity;
}

function activityOf(status: unknown, waitingFor: unknown): ClaudeSessionActivity {
  if (status === 'idle') return 'idle';
  if (status === 'busy') return 'busy';
  if (status !== 'waiting') return 'unknown';
  if (waitingFor === 'permission prompt') return 'waiting-permission';
  if (waitingFor === 'input needed') return 'waiting-input';
  return 'unknown';
}

// `raw`: the contents of `<config>/sessions/<pid>.json`. null when it is not such a record.
export function parseClaudeSessionRecord(raw: string): ClaudeSessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.pid !== 'number' || typeof rec.sessionId !== 'string') return null;
  return {
    pid: rec.pid,
    sessionId: rec.sessionId,
    ...(typeof rec.procStart === 'string' ? { procStart: rec.procStart } : {}),
    activity: activityOf(rec.status, rec.waitingFor),
  };
}
