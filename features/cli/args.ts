// --- Arg parsing (pure) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 0c, docs/specs/
// tg-decomposition.md). Pure: captures no main() state. The only disk access is
// `resolveExistingFile`, which checks an explicit --photo/--file value — the
// message text is NEVER resolved into file paths (tg-cli#648). The entrypoint
// imports `parseArgs` + the `Format` type from here.
import { statSync } from 'fs';
import { join, resolve } from 'path';
import { isNeverAttach } from '../auto-attach/denylist';
import { parseLineSpec, stripSpecWrappers } from '../auto-attach/snippet';
import { ESCALATION_TAGS, validateTag } from '../render/tag';
import { detectMsgRefs } from '../autolink-msgrefs/detect';
import { detectTicketCodesExpanded } from '../autolink-tasks/detect';
import { validateEscalationFormat, escalationFormatMessage } from './escalation-format';
import { decodeTextEscapes } from './text-escapes';

export interface ItemLineSpec {
  // The full original token as written (e.g. "src/a.ts:42-50"), kept so the
  // quote can be anchored on it in the caption.
  token: string;
  startLine: number;
  endLine: number;
  col: number | undefined;
}

export interface Item {
  type: 'photo' | 'document';
  path: string;
  // Present only when the explicit --file path is named with a trailing
  // line-spec in the text (`--file x.ts "see x.ts:42"`). Absent otherwise so
  // no-spec parse results stay byte-identical (keeps toEqual assertions green).
  lineSpec?: ItemLineSpec;
}

export type Format = 'plain' | 'html';

export type ParseResult =
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'lsEmojiHelpers' }
  | { action: 'detectModel' }
  | { action: 'detectAgent' }
  | { action: 'sessionTopic' }
  | { action: 'formatHelp' }
  | { action: 'error'; message: string }
  | {
      action: 'send';
      items: Item[];
      caption: string;
      format: Format;
      // Explicit header title (`--title`). Appears on the `✳️ [window]` line as
      // `✳️ [window] <title>`. The message body is NEVER pulled up here.
      title?: string;
      // Explicit message tag (`--tag`). Rendered as a wordmark pill (custom-emoji
      // cells + readable word): `✳️ [window] 🔵 ANSWER`. Composes with `--title`.
      tag?: string;
      // Explicit SUBAGENT self-label (`--subagent <name>`; the deprecated
      // `--agent` alias still parses). Appears as its own `[name]` bracket right
      // after `[window]`: `✳️ [window] [name] <title>`. The MAIN/orchestrator
      // agent needs NO flag — its `[window]` bracket already carries the project
      // (resolveSessionName derives it from the tmux window / cwd). This
      // flag is for a Task-tool SUBAGENT to identify WHICH subagent sent the
      // message (e.g. `--subagent hyperide-fixer`). Claude Code / Codex / opencode
      // in-process subagents share the parent's env, so no env signal can
      // label them (docs/specs/agent-role-model.md); omp / detached children
      // are labelled from RIG_AGENT_ID without a flag.
      subagent?: string;
      // code-as-pdf: also attach the raw original file alongside the rendered
      // PDF (`--with-original`). Default is PDF-only for code/config files.
      withOriginal?: boolean;
      // code-as-pdf: skip the PDF render entirely and attach the original file
      // (`--no-pdf`) — today's behavior. Wins over --with-original.
      noPdf?: boolean;
      // code-as-pdf: device preset for the mobile PDF page geometry
      // (`--pdf-device <name>`, e.g. iphone15pro / a4). Overrides TG_PDF_DEVICE.
      pdfDevice?: string;
      // Threaded reply (`--reply-to <message_id>`): sets reply_to_message_id on
      // the outbound sendMessage so it threads UNDER that inbound Telegram
      // message. The id is Telegram's own per-chat sequential message_id (the
      // daemon surfaces it in the injected wrap as `tg#<id>`). Absent when the flag
      // is not given (keeps no-flag send results byte-identical).
      replyTo?: number;
      // Forum topic (`--topic <id>`): sets message_thread_id on EVERY outbound
      // send so an agent's `tg` reply threads INTO its bound topic instead of
      // General (docs/specs/tg-forum-topics.md §8). The id is the topic's
      // message_thread_id. The entrypoint falls back to the TG_TOPIC env when the
      // flag is absent; an explicit flag wins. Absent (and no TG_TOPIC) keeps
      // no-flag send results byte-identical for the 1:1 path.
      topic?: number;
      // `tg --table`: read delimited rows from stdin, render an aligned <pre>
      // monospace table, and send it (composes with --tag/--title). The flag is
      // a boolean; the rows come from stdin, not argv. Absent when not given.
      table?: true;
      // `--dry-run`: validate and render the message through every LOCAL guard
      // (escalation-format gate, cjk/mixed-script guard, table/pipe-table
      // conversion) and print the outcome, but perform NO network call and
      // require NO credentials. Lets an agent iterate against the strict
      // `--tag decision` structural gate without leaking
      // scaffold/placeholder drafts to the real chat — see the entrypoint's
      // dry-run short-circuit (features/cli comment "dry-run short-circuit")
      // for the exact cutoff (text guards run; photo/document/PDF plan
      // building and any send do not). Absent when not given.
      dryRun?: true;
      // `--terminal-question`: the HIDDEN escape for the `answer`-requires-
      // `--reply-to` gate. The answered question originated in the TERMINAL (the
      // Claude/agent harness) where there is no inbound Telegram message_id to
      // reply to, so an `--tag answer` legitimately has no `--reply-to` target.
      // This flag — and ONLY this flag — permits that. It is DELIBERATELY absent
      // from USAGE/`--help`: the only place it is surfaced is the error raised
      // when `--tag answer` lacks `--reply-to`. Absent when not given, so a
      // normal send result stays byte-identical.
      terminalQuestion?: true;
      // Tier-1 escalation-format ADVISORY (WARN-mode default): set when a
      // `--tag decision` send carries no literal table. parseArgs
      // does NOT block on it — it attaches the copy-pasteable guidance here and
      // still returns a `send`. The entrypoint prints it to stderr and, ONLY
      // when the off-by-default `ESCALATION_GATE_ENFORCE` flag is set
      // (escalationGateEnforced), upgrades it to a hard stop (exit 1). This is
      // the skill-first → warn → later-flip-to-block rollout: nothing hard-
      // blocks a decision send today. Absent (undefined) on every
      // other send, so those results stay byte-identical.
      escalationWarning?: string;
    };

// Extensions that Telegram's sendPhoto accepts. SVG is intentionally excluded:
// Telegram rejects SVG as a photo (explicit --photo still honors the user's choice).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/')) return join(home, token.slice(2));
  return token;
}

// ~-expand, then make absolute against cwd and normalize (`resolve` collapses
// `.`/`..` in absolute paths too, so `/etc/../etc/hosts` equals `/etc/hosts`).
// Pure path math, no disk access.
function absolutePath(token: string, cwd: string, home: string): string {
  return resolve(cwd, expandHome(token, home));
}

/**
 * Resolve an explicit --photo/--file value to an existing file path, if it is one.
 * Tries ~-expansion, absolute, and cwd-relative resolution.
 * Returns the absolute path only when it resolves to a real file (not a dir).
 */
export function resolveExistingFile(token: string, cwd: string, home: string): string | null {
  if (!token) return null;
  const candidate = absolutePath(token, cwd, home);
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // not a path / no access
  }
  return null;
}

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
interface TagGateContext {
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

const TAG_GATES: Record<string, TagGate> = {
  answer: answerGate,
  // Every ESCALATION_TAGS entry gets the same gate — built from the shared
  // list (features/render/tag.ts) instead of two hardcoded keys, so it can't
  // drift from the hook's own GATED_TAGS set.
  ...Object.fromEntries(ESCALATION_TAGS.map((t) => [t, escalationFormatGate])),
};

export interface ParseOptions {
  // Pin routing before feature flags are removed; prose after leading flags stays prose.
  explicitSend?: boolean;
  // Never-attach denylist (feature `attach-denylist`, ON by default): an explicit
  // --photo/--file naming a secret-looking file (.env family, private keys,
  // credential rc-files, …) is a HARD ERROR.
  attachDenylist?: boolean;
  // Message-reference autolinking (feature `autolink-msgrefs`, ON by default): gates the
  // `--title` tg#<id> guard below, mirroring the SAME flag the body-detection call in the `tg`
  // entrypoint already gates on. With the feature off, a `tg#<id>` is inert plain text (no
  // linkify, no gate) in BOTH the title and the body — consistent, rather than banning it from
  // the title while the identical literal is freely allowed in the body (task-cli#45 / tg-cli
  // review finding on PR #139).
  msgrefAutolink?: boolean;
  // Ticket-code autolinking (feature `autolink-tasks`, ON by default): gates the `--title`
  // HYP-<id> guard below, mirroring the `msgrefAutolink` gating of the tg#<id> guard. A bare
  // ticket code in the one-line header is inert (nothing there ever linkifies it) and only
  // duplicates a body reference the reader can follow — the same rule task-cli/gh-ship enforce
  // on a ticket title (tg-cli#116). With the feature off, a `TEAM-123` is inert plain text in
  // BOTH title and body, so it must not be banned in one and allowed in the other.
  ticketAutolink?: boolean;
}

/**
 * Parse argv (already sliced past node/script) into an action. Never throws and
 * never calls process.exit: the caller decides what to do with the result.
 *
 * Precedence (the reconciliation point for "unknown dashed → error"):
 *   1. -h/--help and -v/--version win before the literal terminator.
 *   2. Info-only flags --ls-emoji-helpers / --detect-model / --detect-agent / --session-topic win next.
 *   3. Real flags are matched: --format (with value validation), --photo,
 *      --file (each consuming a path value).
 *   4. ONLY a dashed token that matched none of the above is "unknown" → error.
 * This guarantees every flag main supports is recognized before the
 * unknown-dashed guard can fire, so none of them regress to an error.
 */
export function parseArgs(
  args: string[],
  cwd: string,
  home: string,
  { attachDenylist = true, msgrefAutolink = true, ticketAutolink = true, explicitSend = args[0] === 'send' && args.length > 1 }: ParseOptions = {},
): ParseResult {
  if (explicitSend && args[0] === 'send') args = args.slice(1);
  const terminator = args.findIndex((arg) => arg === '--' || arg === '--literal');
  const optionArgs = terminator < 0 ? args : args.slice(0, terminator);
  // 1. Help / version win before the literal terminator.
  for (const a of optionArgs) {
    if (a === '-h' || a === '--help') return { action: 'help' };
  }
  for (const a of optionArgs) {
    if (a === '-v' || a === '--version') return { action: 'version' };
  }

  // 2. Info-only flags win next, before the literal terminator.
  for (const a of optionArgs) {
    if (a === '--ls-emoji-helpers') return { action: 'lsEmojiHelpers' };
  }
  for (const a of optionArgs) {
    if (a === '--detect-model') return { action: 'detectModel' };
  }
  for (const a of optionArgs) {
    if (a === '--detect-agent') return { action: 'detectAgent' };
  }
  for (const a of optionArgs) {
    if (a === '--session-topic') return { action: 'sessionTopic' };
  }
  for (const a of optionArgs) {
    if (a === '--format-help') return { action: 'formatHelp' };
  }

  const explicit: Item[] = [];
  const textParts: string[] = [];
  let format: Format = 'plain';
  let title: string | undefined;
  let tag: string | undefined;
  let subagent: string | undefined;
  // Left undefined when the flag is absent so a no-flag parse result stays
  // byte-identical to before (the test suite asserts the send object with
  // toEqual and omits unset optional fields — same convention as title/tag).
  let withOriginal: true | undefined;
  let noPdf: true | undefined;
  let pdfDevice: string | undefined;
  let replyTo: number | undefined;
  let topic: number | undefined;
  let table: true | undefined;
  // `--dry-run` — validate/render locally, never send. See the flag comment
  // below and the `dryRun` field on the `send` action type.
  let dryRun: true | undefined;
  // Hidden escape for the answer-gate (see the gate below + the type comment on
  // `terminalQuestion`). Never advertised in USAGE/--help.
  let terminalQuestion: true | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--' || arg === '--literal') {
      textParts.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--format') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--format requires plain or html' };
      }
      if (nextArg !== 'plain' && nextArg !== 'html') {
        return {
          action: 'error',
          message: `unsupported format '${nextArg}'. Accepted values: plain, html`,
        };
      }
      format = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--title') {
      const nextArg = args[i + 1];
      // Require a value; a dashed next token is treated as a missing value
      // (consistent with --format), so `--title --tag X` errors rather than
      // silently swallowing the next flag as the title.
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--title requires a value' };
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
      if (msgrefAutolink && detectMsgRefs(nextArg).length > 0) {
        return {
          action: 'error',
          message: 'Refusing: --title contains a tg#<id> reference — move it into the message body.',
        };
      }
      // Same rule for a bare ticket code (`HYP-1234`, any `TEAM-<n>`): inert in the header,
      // and it only duplicates a body reference the reader can actually follow. Uses the SAME
      // `detectTicketCodesExpanded` the body linkifies with (so a compound list like `HYP-1/2/3`
      // — which the plain detector treats as a path — is still caught), gated on the SAME
      // `autolink-tasks` flag. The FIRST detected code names the offender. (GitHub-style `#N` is
      // deliberately NOT banned — it is not a code and a title `closes #42` is legitimate.)
      const ticketCodes = ticketAutolink ? detectTicketCodesExpanded(nextArg) : [];
      if (ticketCodes.length > 0) {
        return {
          action: 'error',
          message: `Refusing: --title contains a ticket reference (${ticketCodes[0]}) — move it into the message body.`,
        };
      }
      title = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--tag') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--tag requires a value' };
      }
      // Reject anything that is not a lowercase-english tag (uppercase,
      // Cyrillic, unknown) right here, with a 3-part WHAT/WHY/HOW message and a
      // non-zero exit (the caller maps `action: 'error'` → exit 1). See the
      // INPUT POLICY in features/render/tag.ts.
      const tagError = validateTag(nextArg);
      if (tagError) {
        return { action: 'error', message: tagError };
      }
      // Store the trimmed canonical form. validateTag accepts surrounding
      // whitespace (`' answer '`), so normalize here — otherwise the literal
      // `tag === 'answer'` answer-gate below (and the value handed to send)
      // would carry the padding and the gate would miss a padded `answer`.
      tag = nextArg.trim();
      i += 2;
      continue;
    }
    // Explicit SUBAGENT self-label: `--subagent <name>` (the deprecated
    // `--agent` alias is still accepted so in-flight callers don't break). Same
    // "require a value, a `--`-prefixed next token is a missing value" contract
    // as --title/--tag (a single-dash token like `-x` IS accepted as a literal
    // value, same parity as those flags) — so `--subagent --tag X` errors rather
    // than swallowing `--tag` as the label. No content restriction (unlike
    // --tag's lowercase-english set): the label is a free-form identifier a
    // subagent picks — it reaches Telegram HTML-escaped via styleWindowName
    // (features/prefix-style/style.ts), same as `[window]`. A whitespace-only
    // value (`--subagent "   "`) is REJECTED the same as a missing one — trimming
    // it silently to '' would break the "explicit flag always wins" invariant.
    if (arg === '--subagent' || arg === '--agent') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--') || !nextArg.trim()) {
        return { action: 'error', message: `${arg} requires a value` };
      }
      subagent = nextArg.trim();
      i += 2;
      continue;
    }
    // code-as-pdf flags. `--with-original` and `--no-pdf` are booleans; consume
    // only themselves. `--pdf-device` consumes a value.
    if (arg === '--with-original') {
      withOriginal = true;
      i += 1;
      continue;
    }
    if (arg === '--no-pdf') {
      noPdf = true;
      i += 1;
      continue;
    }
    if (arg === '--pdf-device') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--pdf-device requires a value' };
      }
      pdfDevice = nextArg;
      i += 2;
      continue;
    }
    // Threaded reply: `--reply-to <message_id>`. The value must be a positive
    // integer (Telegram's own per-chat message_id); anything else is a clear
    // error rather than a silently-dropped reply.
    if (arg === '--reply-to') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--reply-to requires a message id' };
      }
      if (!/^[1-9][0-9]*$/.test(nextArg)) {
        return {
          action: 'error',
          message: `--reply-to expects a positive message id, got '${nextArg}'`,
        };
      }
      replyTo = Number(nextArg);
      i += 2;
      continue;
    }
    // Forum topic: `--topic <id>`. Same validation as --reply-to (a positive
    // integer message_thread_id); anything else is a clear error rather than a
    // silently-dropped topic (which would scatter the reply to General).
    if (arg === '--topic') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--topic requires a topic id' };
      }
      if (!/^[1-9][0-9]*$/.test(nextArg)) {
        return {
          action: 'error',
          message: `--topic expects a positive topic id, got '${nextArg}'`,
        };
      }
      topic = Number(nextArg);
      i += 2;
      continue;
    }
    // `--table` is a boolean — the rows are read from stdin by the entrypoint.
    if (arg === '--table') {
      table = true;
      i += 1;
      continue;
    }
    // `--dry-run` is a boolean — validate/render the message LOCALLY (every
    // guard: escalation-format gate, cjk-guard, table conversion) and print the
    // result, but never touch credentials or the network (tg-cli#incident:
    // agents iterating against the strict --tag decision gate had no
    // way to test structural compliance except a REAL send, which leaked
    // scaffold/placeholder text to the live chat 6 times in one incident). See
    // the entrypoint's dry-run short-circuit for what it does and does not cover.
    if (arg === '--dry-run') {
      dryRun = true;
      i += 1;
      continue;
    }
    // `--terminal-question` is a boolean — the HIDDEN escape for the
    // `answer`-requires-`--reply-to` gate (see the gate below). Recognized here
    // so it is consumed as a real flag (not an "unknown flag" error and not
    // swallowed into the message text), but it is intentionally NOT documented
    // in USAGE/--help: it must only be learned from the gate's error message.
    if (arg === '--terminal-question') {
      terminalQuestion = true;
      i += 1;
      continue;
    }
    if (arg === '--photo' || arg === '--file') {
      const nextArg = args[i + 1];
      if (nextArg === '--' || nextArg === '--literal') {
        return { action: 'error', message: `${arg} requires a path before the literal terminator; use ./${nextArg} for that filename` };
      }
      // A dashed next token is only consumed as a path when it actually
      // resolves to an existing file (e.g. `--file -receipt.png`). Otherwise
      // it is a missing/invalid path → error, matching main's behavior.
      const dashedButNotAFile =
        !!nextArg && nextArg.startsWith('-') && resolveExistingFile(nextArg, cwd, home) === null;
      if (!nextArg || dashedButNotAFile) {
        return { action: 'error', message: `${arg} requires a file path argument` };
      }
      if (attachDenylist && isNeverAttach(nextArg)) {
        return {
          action: 'error',
          message:
            `refusing to attach '${nextArg}': matches the never-attach denylist (secrets). ` +
            'Override with --no-feature attach-denylist',
        };
      }
      explicit.push({ type: arg === '--photo' ? 'photo' : 'document', path: nextArg });
      i += 2;
      continue;
    }
    // A standalone dashed token that matched no known flag (and is not a flag
    // value, since those are consumed above) is an unknown flag → error.
    if (arg.startsWith('-')) {
      return { action: 'error', message: `unknown flag: ${arg}` };
    }
    // Anything else is plain text.
    textParts.push(arg);
    i += 1;
  }

  // The message text is NEVER resolved into file paths (tg-cli#648): a token
  // that happens to name an existing file is plain text, nothing is attached for
  // it. Only explicit --photo/--file attach. The one thing the text may add is a
  // line-spec for a file that IS explicitly attached (`--file x.ts "see
  // x.ts:42"` renders the quote + marker copy). That match is pure path math on
  // the explicit items — the text never touches the filesystem. First spec per
  // file wins (the marker copy can only mark one range).
  const text = textParts.join(' ');
  if (explicit.length > 0) {
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

  const items = explicit;
  // Trim only the outer edges; interior formatting (newlines, alignment) stays.
  const caption = text.replace(/^\s+|\s+$/g, '');

  // Per-tag parse-time gates (TAG_GATES above) — a cheap, in-process check run
  // before anything else (no subprocess, no hook). `tag` was already validated
  // to one of the lowercase-english words, so a plain registry lookup suffices.
  // A 'block' result (answer-gate) hard-errors here; an 'advisory' result
  // (escalation-format) is attached as escalationWarning and the send still
  // proceeds — the entrypoint decides warn-vs-block via ESCALATION_GATE_ENFORCE.
  let escalationWarning: string | undefined;
  if (tag !== undefined) {
    const gate = TAG_GATES[tag];
    if (gate) {
      const result = gate({ tag, caption, table, replyTo, terminalQuestion, format });
      if (result) {
        if (result.severity === 'block') return { action: 'error', message: result.message };
        escalationWarning = result.message;
      }
    }
  }

  // Empty invocation → help, exit 0.
  // A bare `--title`/`--tag`/`--table`/`--reply-to` still sends (a header-only
  // or table or reply message), so none of those is an empty invocation. The
  // `--table` body arrives on stdin, read by the entrypoint after parsing.
  if (items.length === 0 && !caption && !title && !tag && !subagent && !table && replyTo === undefined) {
    return { action: 'help' };
  }
  return {
    action: 'send',
    items,
    caption,
    format,
    title,
    tag,
    subagent,
    withOriginal,
    noPdf,
    pdfDevice,
    replyTo,
    topic,
    table,
    dryRun,
    terminalQuestion,
    escalationWarning,
  };
}
