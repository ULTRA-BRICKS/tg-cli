// Post-loop assembly for parseArgs: caption + line-spec attachment, per-tag gates, the
// empty-invocation check and the `send` result (field order is part of the contract).
import { parseLineSpec, stripSpecWrappers } from '../auto-attach/snippet';
import { absolutePath } from './args-paths';
import { TAG_GATES } from './args-gates';
import type { ParseState } from './args-flags';
import type { Item, ParseResult } from './args-types';

// The message text is NEVER resolved into file paths (tg-cli#648): a token
// that happens to name an existing file is plain text, nothing is attached for
// it. Only explicit --photo/--file attach. The one thing the text may add is a
// line-spec for a file that IS explicitly attached (`--file x.ts "see
// x.ts:42"` renders the quote + marker copy). That match is pure path math on
// the explicit items — the text never touches the filesystem. First spec per
// file wins (the marker copy can only mark one range).
export function attachLineSpecs(explicit: Item[], text: string, cwd: string, home: string): void {
  if (explicit.length === 0) return;
  const explicitAbs = explicit.map((it) => absolutePath(it.path, cwd, home));
  for (const seg of text.split(/\s+/)) {
    if (!seg) continue;
    // Try the raw token, then the same token with wrapping punctuation stripped
    // (`(file.ts:42)`, `file.ts:42.`, `` `file.ts:42` ``) so a spec glued to prose
    // punctuation still matches (tg#29). The full original `seg` stays the quote anchor.
    const ls = parseLineSpec(seg) ?? parseLineSpec(stripSpecWrappers(seg));
    if (!ls) continue;
    const target = absolutePath(ls.path, cwd, home);
    const item = explicit.find((it, k) => explicitAbs[k] === target && !it.lineSpec);
    if (item) item.lineSpec = { token: seg, startLine: ls.startLine, endLine: ls.endLine, col: ls.col };
  }
}

// Per-tag parse-time gates (TAG_GATES) — a cheap, in-process check run
// before anything else (no subprocess, no hook). `tag` was already validated
// to one of the lowercase-english words, so a plain registry lookup suffices.
// A 'block' result (answer-gate) hard-errors; an 'advisory' result
// (escalation-format) comes back as `warning` and the send still
// proceeds — the entrypoint decides warn-vs-block via ESCALATION_GATE_ENFORCE.
export function runTagGate(
  state: ParseState,
  caption: string,
): { error: string } | { warning: string | undefined } {
  const { tag } = state;
  if (tag === undefined) return { warning: undefined };
  const gate = TAG_GATES[tag];
  if (!gate) return { warning: undefined };
  const result = gate({
    tag,
    caption,
    table: state.table,
    replyTo: state.replyTo,
    terminalQuestion: state.terminalQuestion,
    format: state.format,
  });
  if (!result) return { warning: undefined };
  if (result.severity === 'block') return { error: result.message };
  return { warning: result.message };
}

// Empty invocation → help, exit 0.
// A bare `--title`/`--tag`/`--table`/`--reply-to` still sends (a header-only
// or table or reply message), so none of those is an empty invocation. The
// `--table` body arrives on stdin, read by the entrypoint after parsing.
function isEmptyInvocation(state: ParseState, caption: string): boolean {
  return (
    state.explicit.length === 0 &&
    !caption &&
    !state.title &&
    !state.tag &&
    !state.subagent &&
    !state.table &&
    state.replyTo === undefined
  );
}

export function finishParse(
  state: ParseState,
  bodyText: string | undefined,
  cwd: string,
  home: string,
): ParseResult {
  // Stdin body joins the text after the argv loop, so it is never tokenized.
  if (bodyText?.trim()) state.textParts.push(bodyText);
  const text = state.textParts.join(' ');
  attachLineSpecs(state.explicit, text, cwd, home);

  // Trim only the outer edges; interior formatting (newlines, alignment) stays.
  const caption = text.replace(/^\s+|\s+$/g, '');

  const gate = runTagGate(state, caption);
  if ('error' in gate) return { action: 'error', message: gate.error };

  if (isEmptyInvocation(state, caption)) return { action: 'help' };
  return {
    action: 'send',
    items: state.explicit,
    caption,
    format: state.format,
    title: state.title,
    tag: state.tag,
    subagent: state.subagent,
    withOriginal: state.withOriginal,
    noPdf: state.noPdf,
    pdfDevice: state.pdfDevice,
    replyTo: state.replyTo,
    topic: state.topic,
    session: state.session,
    table: state.table,
    dryRun: state.dryRun,
    automated: state.automated,
    terminalQuestion: state.terminalQuestion,
    escalationWarning: gate.warning,
  };
}
