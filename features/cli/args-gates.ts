// Per-tag parse-time gates (answer needs a reply target; escalation tags need the
// decision-request format). Registry lives here so parseArgs stays a thin loop.
import { ESCALATION_TAGS } from '../render/tag';
import { validateEscalationFormat, escalationFormatMessage } from './escalation-format';
import { decodeTextEscapes } from './text-escapes';
import type { Format } from './args-types';

// --- TAG_GATES: per-tag parse-time checks (the escalation-format gate; the
// pure validator lives in features/cli/escalation-format.ts). Each gate inspects the
// already-parsed fields and returns a result with a SEVERITY, or null to let
// it through. Kept as a registry (not a hardcoded `if` per tag) so a future
// gated tag is one entry, not another branch to thread through.
//
// SEVERITY decides what parseArgs does with a non-null result:
//   'block'    → hard `action: 'error'` (exit 1). Used for the `answer`-gate:
//                a `--tag answer` with no reply target is genuinely malformed.
//   'advisory' → attached as `escalationWarning` on a still-successful `send`.
//                parseArgs NEVER blocks on it. Used for the decision
//                escalation-format check: it is WARN-mode by default (the
//                skill-first → warn → later-flip-to-block rollout). The
//                entrypoint prints the guidance and only upgrades it to a hard
//                stop when the off-by-default ESCALATION_GATE_ENFORCE flag is
//                set (see escalationGateEnforced below).
export interface TagGateContext {
  // The canonical lowercase tag that selected this gate (e.g. "decision") —
  // so a shared gate (escalationFormatGate serves every ESCALATION_TAGS entry)
  // can still report the ACTUAL tag the caller used, not a hardcoded list that
  // silently goes stale the moment another escalation tag is added.
  tag: string;
  caption: string;
  table?: true;
  replyTo?: number;
  terminalQuestion?: true;
  // The parsed --format. A structured escalation must go out as a Rich Message,
  // which requires --format html (raw <table>/<h3> tags are literal text under
  // plain format), so the format gate requires it.
  format: Format;
}
interface TagGateResult {
  message: string;
  severity: 'block' | 'advisory';
}
type TagGate = (ctx: TagGateContext) => TagGateResult | null;

// Is the escalation-format gate in ENFORCE (hard-block) mode? ON by default now
// (deny-by-default): a `--tag decision` send that does not follow the
// decision-request format is a HARD ERROR (exit 1). This is the CTO's explicit
// direction — the escalation format is REQUIRED, not opt-in. The documented
// escape for a genuine non-escalation / urgent edge case is
// ESCALATION_GATE_ENFORCE=0 (or false/no/off), which downgrades the gate to
// advisory (warn + proceed). Any other value (unset, 1, true, …) means ENFORCE.
// Same trim+lowercase parse family as the AGENTS_HOOKS_TRUST guard.
export function escalationGateEnforced(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ESCALATION_GATE_ENFORCE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// The `answer` tag means "I am answering THIS specific message", so it
// requires a reply target. Without `--reply-to` a `--tag answer` has no thread
// to attach to and reads as a reply that isn't one — make it an actionable
// error.
//
// The ONE legitimate exception: the question originated in the TERMINAL (the
// Claude/agent harness) where no inbound Telegram message_id exists to reply
// to. `--terminal-question` is the explicit, HIDDEN escape for exactly that
// case — it permits `--tag answer` without `--reply-to`. The flag is NOT in
// USAGE/--help by design; the only place it is surfaced is this very error
// message, and only framed as the terminal-origin escape. So a normal user
// reading --help never sees it; only someone who hit THIS error and genuinely
// has a terminal-origin question (no Telegram id) learns it.
const answerGate: TagGate = ({ replyTo, terminalQuestion }) => {
  if (replyTo !== undefined || terminalQuestion) return null;
  return {
    severity: 'block',
    message:
      '--tag answer must reply to a specific message — pass --reply-to <message_id>. ' +
      'Use the id from the inbound `[TG from … #<id>]` wrap. ' +
      'If this answers a question that originated in the terminal and there is no ' +
      'Telegram message id to reply to, pass --terminal-question.',
  };
};

// `decision` is the ESCALATION tag — it asks the recipient (the CTO) to
// choose or decide (an open question IS a decision request, tg-cli#301). The decision-request-discipline skill mandates a
// self-contained request the human can answer in ~30s without opening the repo:
// Context + Options with real pros/cons + a Recommendation + a "where to look"
// file:line, presented as a REAL table or list. This gate runs the full
// validateEscalationFormat check on the caption and, when a required section is
// missing, returns the checklist of what's missing.
//
// SEVERITY IS 'advisory' at the PARSE layer — this gate never hard-exits inside
// parseArgs; it attaches its message as `escalationWarning` and the ENTRYPOINT
// decides block-vs-warn via escalationGateEnforced (now ON by default — a
// malformed decision send is a hard error unless
// ESCALATION_GATE_ENFORCE=0). Keeping the parse layer non-throwing lets tests
// inspect the attached warning and lets the one documented escape downgrade to
// warn cleanly.
//
// `--table` reads its rows from STDIN, which parseArgs never sees (the
// entrypoint reads stdin after parsing) — a `--table` send WILL carry a
// rendered table by construction, so the table requirement is satisfied for it;
// the OTHER sections (recommendation / where-to-look / context) still can't be
// verified pre-stdin, so a `--table` decision is not blocked here.
const escalationFormatGate: TagGate = ({ tag, caption, table, format }) => {
  if (table) return null;
  // Validate the DECODED caption, not the raw argv text: a compliant multiline body
  // supplied via tg's documented literal `\n`/`\r`/`\t` escapes (the convention for
  // passing a real newline as one shell argument) is otherwise seen as a single
  // long line, so the section/heading heuristics below false-positive-block it
  // before the entrypoint's own decode ever runs (review finding).
  const result = validateEscalationFormat(decodeTextEscapes(caption));
  // A structured escalation only renders as a Rich Message under --format html;
  // without it the headings/table/list tags arrive as literal text. Require it.
  if (format !== 'html') {
    result.missing.unshift(
      'Send as a Rich Message: pass --format html so the headings/table/list render (raw tags are literal text under plain format)',
    );
  }
  if (result.missing.length === 0) return null;
  // The message is the CORE checklist only. The mode-specific framing
  // ("advisory, sending anyway" vs "blocked") is appended by the ENTRYPOINT,
  // the only place that knows whether ESCALATION_GATE_ENFORCE downgrades it.
  return {
    severity: 'advisory',
    message: escalationFormatMessage(tag, result.missing),
  };
};

export const TAG_GATES: Record<string, TagGate> = {
  answer: answerGate,
  // Every ESCALATION_TAGS entry gets the same gate — built from the shared
  // list (features/render/tag.ts) instead of two hardcoded keys, so it can't
  // drift from the hook's own GATED_TAGS set.
  ...Object.fromEntries(ESCALATION_TAGS.map((t) => [t, escalationFormatGate])),
};
