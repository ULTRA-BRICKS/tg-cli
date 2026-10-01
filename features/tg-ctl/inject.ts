// tmux injection plans (spec §5.2, §16 module 5).
//
// PURE — these functions return InjectStep[] data; the tg-ctl entrypoint
// executes the steps (spawnSync tmux, Bun.sleep, pane re-verification, the
// input-box read of a submit-check).
// The recipe is the live-proven one: literal send-keys for single lines,
// bracketed paste via load-buffer/paste-buffer for multi-line, a paced
// SEPARATE Enter, then a submit check with one retry Enter (tg-cli#463).

import { truncateWithEllipsis } from './text-util';
import type { AgentKind, InjectStep } from './types';

// {name}/{msg}/{id} substitution in a single pass over the TEMPLATE only, so
// placeholder-looking text inside the substituted values is never expanded
// (replacement output is not rescanned).
//
// `{id}` carries the inbound Telegram message_id so the agent reading its pane
// knows the id to pass to `tg --reply-to <id>` (threaded replies). It renders as
// `tg#<id>` (the `tg#` prefix is part of the substitution, NOT the template):
// this is the message-ref convention (tg#28). The `tg#` — not a bare `#` — is
// what lets the outbound autolink layer recognize a reply-to-a-message reference
// and keep it distinct from a GitHub issue/PR `#<id>` (which would otherwise be
// resolved against the cwd repo and mis-linked). A `/agent <selector> <text>`
// route DOES carry an id (forwarded from `sourceMessageId`, same as every other
// inbound path) — the only genuinely id-less callers are synthetic/non-inbound
// injections with no underlying Telegram message. When no id is available the
// `{id}` placeholder is removed from the
// TEMPLATE along with one adjacent space BEFORE substitution, so the wrap reads
// naturally (`[TG from {name} {id}]` → `[TG from {name}]`). Doing the cleanup on
// the template — never on the substituted output — is what keeps the user's
// message intact: a `{msg}` containing double spaces or a ` : ` ratio must come
// through verbatim and must NOT be collapsed (codex review finding).
export function wrapInbound(template: string, name: string, msg: string, messageId?: number): string {
  // No id → strip the `{id}` token (and one neighbouring space) from the
  // template first; with an id, substitute it as `#<id>` in place.
  const prepared =
    messageId === undefined ? template.replace(/ ?\{id\} ?/g, (m) => (/^ .* $/.test(m) ? ' ' : '')) : template;
  return prepared.replace(/\{name\}|\{msg\}|\{id\}/g, (m) => {
    if (m === '{name}') return name;
    if (m === '{msg}') return msg;
    return messageId !== undefined ? `tg#${messageId}` : '';
  });
}

export interface TextInjectOpts {
  escapePrelude?: boolean; // send Escape first (close pickers/menus before typing)
  gapMs?: number; // pre-Enter gap (default 500ms — competitor-source-proven pacing)
  sessionKey?: string; // refuse unless the pane still hosts this session (§2.6)
}

// Time for a TUI to redraw after Enter before its input box is read. All three
// harnesses had cleared the box 600ms after Enter in the 2026-09-30 captures.
const SUBMIT_SETTLE_MS = 700;

export function buildTextInjectPlan(paneId: string, text: string, opts: TextInjectOpts = {}): InjectStep[] {
  const steps: InjectStep[] = [opts.sessionKey ? { kind: 'verify-pane', paneId, sessionKey: opts.sessionKey } : { kind: 'verify-pane', paneId }];

  if (opts.escapePrelude) {
    steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, 'Escape'] });
    steps.push({ kind: 'sleep', ms: 200 });
  }

  if (text.includes('\n')) {
    // Bracketed paste — the universally safe multi-line path. A literal
    // send-keys LF submits early in canonical-mode REPLs; -p keeps the whole
    // payload as one paste event, -d drops the buffer after use.
    steps.push({ kind: 'tmux', argv: ['tmux', 'load-buffer', '-'], stdin: text });
    steps.push({ kind: 'tmux', argv: ['tmux', 'paste-buffer', '-p', '-d', '-t', paneId] });
  } else {
    // -l = literal mode: no key-name interpretation, special-char safe.
    steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, '-l', text] });
  }

  // Enter MUST be a separate send-keys after a real gap — a combined or
  // too-fast Enter is dropped by the Ink TUI (spec §5.2: the single most
  // common failure mode in other tmux-injecting bots).
  steps.push({ kind: 'sleep', ms: opts.gapMs ?? 500 });
  steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, 'Enter'] });
  // Even a paced Enter is sometimes lost (tg-cli#463: the CTO's message sat typed in
  // the box, never sent). Check the input box once the TUI has redrawn, retry Enter
  // ONCE, and fail loudly if the text is still there — never a silent "delivered".
  steps.push({ kind: 'sleep', ms: SUBMIT_SETTLE_MS });
  steps.push({ kind: 'submit-check', paneId, text });
  steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, 'Enter'] });
  steps.push({ kind: 'sleep', ms: SUBMIT_SETTLE_MS });
  steps.push({ kind: 'submit-check', paneId, text, final: true });
  return steps;
}

// The Telegram reply for a message still typed after the retry Enter (the final
// submit-check). It names the pane and quotes the text so the CTO can finish it.
export function unsubmittedNotice(paneId: string, agent: AgentKind, text: string): string {
  const firstLine = text.split('\n', 1)[0];
  return `⚠️ Typed into pane ${paneId} (${agent}) but NOT sent: Enter was pressed twice and the message is still in its input box — «${truncateWithEllipsis(firstLine, 120)}». Press Enter in that pane, or clear the box and resend.`;
}

// The typing turn a plan must take: the pane it types into. Text, digit and key plans of one pane
// share a key, so a late button tap cannot land in the box of a message mid submit-check.
// null = the plan types into no pane.
export function paneTypingKey(steps: InjectStep[]): string | null {
  const target = steps.find((step) => step.kind === 'verify-pane');
  return target ? `pane:${target.paneId}` : null;
}

// Control verbs are raw key names — NO -l, tmux must interpret them.
export function buildKeyInjectPlan(paneId: string, key: 'Escape'): InjectStep[] {
  return [
    { kind: 'verify-pane', paneId },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, key] },
  ];
}

// A single digit keypress for a numbered "Do you want to proceed?" menu — NO
// trailing Enter. Verified live (2026-08-18, throwaway tmux session): Claude
// Code's numbered permission menu submits the instant a bare digit is sent —
// the prompt was already resolved and the command running 400ms after a
// literal "1" with no Enter follow-up. Sending Enter afterward would risk it
// landing on whatever prompt/input follows the now-resolved menu instead
// (tg-cli#267's late-delivery-for-permissions path is the only caller).
// `digit` is trusted single-character input: permission-menu.ts's OPTION_LINE
// regex captures exactly one digit at the source, so this is the only shape
// that ever reaches here. Deliberately NOT silently truncating a longer
// string here (an earlier version did `digit.slice(0, 1)`, framed as
// "insurance" — review finding: on a permission-ANSWERING path, silently
// reinterpreting a caller's contract violation into "select whatever the
// first character happens to be" is less safe than just trusting the
// contract, since it can never be distinguished from a correct single-digit
// call — a real bug upstream would inject a plausible-looking WRONG answer
// instead of surfacing loudly).
export function buildDigitInjectPlan(paneId: string, digit: string, sessionKey?: string): InjectStep[] {
  return [
    sessionKey ? { kind: 'verify-pane', paneId, sessionKey } : { kind: 'verify-pane', paneId },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, '-l', digit] },
  ];
}
