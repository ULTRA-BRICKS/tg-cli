// Per-flag handlers for the argv loop. Each handler consumes its flag (and value)
// at args[i], mutates the shared ParseState and returns the next index, or a
// ParseError that aborts parsing. Pure: the only disk access is
// resolveExistingFile for the --photo/--file dashed-path rule.
import { isNeverAttach } from '../auto-attach/denylist';
import { detectMsgRefs } from '../autolink-msgrefs/detect';
import { detectTicketCodesExpanded } from '../autolink-tasks/detect';
import { validateTag } from '../render/tag';
import { resolveExistingFile } from './args-paths';
import type { Format, Item, ParseError } from './args-types';

export interface ParseState {
  explicit: Item[];
  textParts: string[];
  format: Format;
  title: string | undefined;
  tag: string | undefined;
  subagent: string | undefined;
  // Left undefined when the flag is absent so a no-flag parse result stays
  // byte-identical to before (the test suite asserts the send object with
  // toEqual and omits unset optional fields — same convention as title/tag).
  withOriginal: true | undefined;
  noPdf: true | undefined;
  pdfDevice: string | undefined;
  replyTo: number | undefined;
  topic: number | undefined;
  session: string | undefined;
  table: true | undefined;
  // `--dry-run` — validate/render locally, never send. See the flag comment
  // below and the `dryRun` field on the `send` action type.
  dryRun: true | undefined;
  automated: true | undefined;
  // Hidden escape for the answer-gate (see the gate in args-gates.ts + the type comment on
  // `terminalQuestion`). Never advertised in USAGE/--help.
  terminalQuestion: true | undefined;
}

export interface FlagContext {
  cwd: string;
  home: string;
  attachDenylist: boolean;
  msgrefAutolink: boolean;
  ticketAutolink: boolean;
}

type FlagStep = number | ParseError;
type FlagHandler = (state: ParseState, args: string[], i: number, ctx: FlagContext) => FlagStep;

export function newParseState(): ParseState {
  return {
    explicit: [],
    textParts: [],
    format: 'plain',
    title: undefined,
    tag: undefined,
    subagent: undefined,
    withOriginal: undefined,
    noPdf: undefined,
    pdfDevice: undefined,
    replyTo: undefined,
    topic: undefined,
    session: undefined,
    table: undefined,
    dryRun: undefined,
    automated: undefined,
    terminalQuestion: undefined,
  };
}

function fail(message: string): ParseError {
  return { action: 'error', message };
}

// A value-taking flag requires a value; a `--`-prefixed next token is a missing value
// (a single-dash token like `-x` IS accepted as a literal value).
function missingValue(nextArg: string | undefined): nextArg is undefined | '' {
  return !nextArg || nextArg.startsWith('--');
}

const POSITIVE_INT = /^[1-9][0-9]*$/;

function formatFlag(state: ParseState, args: string[], i: number): FlagStep {
  const nextArg = args[i + 1];
  if (missingValue(nextArg)) return fail('--format requires plain or html');
  if (nextArg !== 'plain' && nextArg !== 'html') {
    return fail(`unsupported format '${nextArg}'. Accepted values: plain, html`);
  }
  state.format = nextArg;
  return i + 2;
}

// A `tg#<id>` message reference in the header line defeats its own
// purpose: --title is a one-line header (`✳️ [window] <title>`), not a
// place a reader can follow a reference from — and unlike the message
// body, nothing here ever gets linkified. Refuse instrumentally (the
// same rule task-cli/gh-ship enforce on a ticket/PR title) rather than
// silently sending an inert `tg#1234` in the header. Gated on the SAME
// `autolink-msgrefs` feature flag the body detection uses (`tg`'s main
// entrypoint) — with the feature off, `tg#<id>` is inert plain text
// everywhere, in the title exactly like the body, not banned in one and
// freely allowed in the other.
//
// Same rule for a bare ticket code (`HYP-1234`, any `TEAM-<n>`): inert in the header,
// and it only duplicates a body reference the reader can actually follow. Uses the SAME
// `detectTicketCodesExpanded` the body linkifies with (so a compound list like `HYP-1/2/3`
// — which the plain detector treats as a path — is still caught), gated on the SAME
// `autolink-tasks` flag. The FIRST detected code names the offender. (GitHub-style `#N` is
// deliberately NOT banned — it is not a code and a title `closes #42` is legitimate.)
function titleRefError(title: string, ctx: FlagContext): ParseError | null {
  if (ctx.msgrefAutolink && detectMsgRefs(title).length > 0) {
    return fail('Refusing: --title contains a tg#<id> reference — move it into the message body.');
  }
  const ticketCodes = ctx.ticketAutolink ? detectTicketCodesExpanded(title) : [];
  if (ticketCodes.length > 0) {
    return fail(`Refusing: --title contains a ticket reference (${ticketCodes[0]}) — move it into the message body.`);
  }
  return null;
}

function titleFlag(state: ParseState, args: string[], i: number, ctx: FlagContext): FlagStep {
  const nextArg = args[i + 1];
  // Require a value; a dashed next token is treated as a missing value
  // (consistent with --format), so `--title --tag X` errors rather than
  // silently swallowing the next flag as the title.
  if (missingValue(nextArg)) return fail('--title requires a value');
  const refError = titleRefError(nextArg, ctx);
  if (refError) return refError;
  state.title = nextArg;
  return i + 2;
}

function tagFlag(state: ParseState, args: string[], i: number): FlagStep {
  const nextArg = args[i + 1];
  if (missingValue(nextArg)) return fail('--tag requires a value');
  // Reject anything that is not a lowercase-english tag (uppercase,
  // Cyrillic, unknown) right here, with a 3-part WHAT/WHY/HOW message and a
  // non-zero exit (the caller maps `action: 'error'` → exit 1). See the
  // INPUT POLICY in features/render/tag.ts.
  const tagError = validateTag(nextArg);
  if (tagError) return fail(tagError);
  // Store the trimmed canonical form. validateTag accepts surrounding
  // whitespace (`' answer '`), so normalize here — otherwise the literal
  // `tag === 'answer'` answer-gate (and the value handed to send)
  // would carry the padding and the gate would miss a padded `answer`.
  state.tag = nextArg.trim();
  return i + 2;
}

// Explicit SUBAGENT self-label: `--subagent <name>` (the deprecated
// `--agent` alias is still accepted so in-flight callers don't break). Same
// "require a value, a `--`-prefixed next token is a missing value" contract
// as --title/--tag (a single-dash token like `-x` IS accepted as a literal
// value, same parity as those flags) — so `--subagent --tag X` errors rather than
// swallowing `--tag` as the label. No content restriction (unlike
// --tag's lowercase-english set): the label is a free-form identifier a
// subagent picks — it reaches Telegram HTML-escaped via styleWindowName
// (features/prefix-style/style.ts), same as `[window]`. A whitespace-only
// value (`--subagent "   "`) is REJECTED the same as a missing one — trimming
// it silently to '' would break the "explicit flag always wins" invariant.
function subagentFlag(state: ParseState, args: string[], i: number): FlagStep {
  const nextArg = args[i + 1];
  if (missingValue(nextArg) || !nextArg.trim()) return fail(`${args[i]} requires a value`);
  state.subagent = nextArg.trim();
  return i + 2;
}

function pdfDeviceFlag(state: ParseState, args: string[], i: number): FlagStep {
  const nextArg = args[i + 1];
  if (missingValue(nextArg)) return fail('--pdf-device requires a value');
  state.pdfDevice = nextArg;
  return i + 2;
}

// Positive-integer flags (`--reply-to <message_id>`, `--topic <id>`): anything else is a
// clear error rather than a silently-dropped value (a dropped reply/topic would scatter
// the message to General).
function positiveIntFlag(
  key: 'replyTo' | 'topic',
  missingMessage: string,
  expected: string,
  flag: string,
): FlagHandler {
  return (state, args, i) => {
    const nextArg = args[i + 1];
    if (missingValue(nextArg)) return fail(missingMessage);
    if (!POSITIVE_INT.test(nextArg)) return fail(`${flag} expects a positive ${expected}, got '${nextArg}'`);
    state[key] = Number(nextArg);
    return i + 2;
  };
}

// Session pin: `--session <id>` — one non-empty token (a session id or `omp:<id>` key).
function sessionFlag(state: ParseState, args: string[], i: number): FlagStep {
  const nextArg = args[i + 1];
  if (missingValue(nextArg) || /\s/.test(nextArg)) {
    return fail('--session requires a session id (tg --session-id prints it)');
  }
  state.session = nextArg;
  return i + 2;
}

// Boolean flags consume only themselves.
function booleanFlag(
  key: 'withOriginal' | 'noPdf' | 'table' | 'dryRun' | 'automated' | 'terminalQuestion',
): FlagHandler {
  return (state, _args, i) => {
    state[key] = true;
    return i + 1;
  };
}

function attachFlag(state: ParseState, args: string[], i: number, ctx: FlagContext): FlagStep {
  const arg = args[i];
  const nextArg = args[i + 1];
  // A dashed next token is only consumed as a path when it actually
  // resolves to an existing file (e.g. `--file -receipt.png`). Otherwise
  // it is a missing/invalid path → error, matching main's behavior.
  const dashedButNotAFile =
    !!nextArg && nextArg.startsWith('-') && resolveExistingFile(nextArg, ctx.cwd, ctx.home) === null;
  if (!nextArg || dashedButNotAFile) return fail(`${arg} requires a file path argument`);
  if (ctx.attachDenylist && isNeverAttach(nextArg)) {
    return fail(
      `refusing to attach '${nextArg}': matches the never-attach denylist (secrets). ` +
        'Override with --no-feature attach-denylist',
    );
  }
  state.explicit.push({ type: arg === '--photo' ? 'photo' : 'document', path: nextArg });
  return i + 2;
}

// Exact-match dispatch. A Map (not an object) so a token like `constructor` is never
// mistaken for a handler.
//
// `--table` rows come from stdin (read by the entrypoint). `--dry-run` validates/renders
// the message LOCALLY (every guard: escalation-format gate, cjk-guard, table conversion)
// and prints the result, but never touches credentials or the network (tg-cli#incident:
// agents iterating against the strict --tag decision gate had no way to test structural
// compliance except a REAL send, which leaked scaffold/placeholder text to the live chat
// 6 times in one incident). See the entrypoint's dry-run short-circuit for what it does
// and does not cover. `--terminal-question` is the HIDDEN escape for the
// `answer`-requires-`--reply-to` gate: recognized here so it is consumed as a real flag
// (not an "unknown flag" error and not swallowed into the message text), but
// intentionally NOT documented in USAGE/--help — it must only be learned from the gate's
// error message. `--with-original`/`--no-pdf` are code-as-pdf booleans; `--pdf-device`
// consumes a value.
const FLAG_HANDLERS = new Map<string, FlagHandler>([
  ['--format', formatFlag],
  ['--title', titleFlag],
  ['--tag', tagFlag],
  ['--subagent', subagentFlag],
  ['--agent', subagentFlag],
  ['--with-original', booleanFlag('withOriginal')],
  ['--no-pdf', booleanFlag('noPdf')],
  ['--pdf-device', pdfDeviceFlag],
  // Threaded reply: `--reply-to <message_id>` (Telegram's own per-chat message_id).
  ['--reply-to', positiveIntFlag('replyTo', '--reply-to requires a message id', 'message id', '--reply-to')],
  // Forum topic: `--topic <id>` (a positive integer message_thread_id).
  ['--topic', positiveIntFlag('topic', '--topic requires a topic id', 'topic id', '--topic')],
  ['--session', sessionFlag],
  ['--table', booleanFlag('table')],
  ['--dry-run', booleanFlag('dryRun')],
  ['--automated', booleanFlag('automated')],
  ['--terminal-question', booleanFlag('terminalQuestion')],
  ['--photo', attachFlag],
  ['--file', attachFlag],
]);

/**
 * Run the flag loop over args. Returns a ParseError for the first bad flag; otherwise
 * the filled state (`explicit` attachments + `textParts`).
 */
export function parseFlagLoop(args: string[], ctx: FlagContext): ParseState | ParseError {
  const state = newParseState();
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const handler = FLAG_HANDLERS.get(arg);
    if (handler) {
      const step = handler(state, args, i, ctx);
      if (typeof step !== 'number') return step;
      i = step;
      continue;
    }
    // A standalone dashed token that matched no known flag (and is not a flag
    // value, since those are consumed above) is an unknown flag → error.
    if (arg.startsWith('-')) return fail(`unknown flag: ${arg}`);
    // Anything else is plain text.
    state.textParts.push(arg);
    i += 1;
  }
  return state;
}
