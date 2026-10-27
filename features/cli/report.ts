// --- `tg report` — structured result-report formatter (pure) ---
//
// WHAT THIS IS
//   The "показывай отчёт через /result-report" convention has repeatedly been
//   asked for, but the piece that lived under that name (a Claude Code slash
//   command, ~/.claude/commands/result-report.md, backed by rig-cli's
//   `rig report`) only ever produced a chat-visible Markdown report + an
//   openable HTML file + a ticket/PR comment — it never pushed to Telegram.
//   `tg --tag report` is the send-to-Telegram primitive, but it is free-form:
//   nothing enforces that a "report" actually carries a ticket/PR link, the
//   user impact, and verification proof. This module is the missing bridge:
//   `tg report --title … --ticket … --impact … --verify-cmd … --verify-result …`
//   builds the same rich-HTML body other rich sends use and re-enters the
//   normal send pipeline with --tag report --format html, so a result report
//   gets the SAME dictionary gate / autolink / attachment machinery as any
//   other send instead of a bespoke parallel path.
//
// PURE — no I/O, no process.exit. The `tg` entrypoint owns argv splicing and
// process exit, mirroring how `report`'s sibling subcommands (`user`,
// `replies`) are wired.
import { escapeHtml } from '../render/html';

export interface ReportSendResult {
  argv: string[];
}

export interface ReportErrorResult {
  error: string;
}

export interface ReportHelpResult {
  help: string;
}

export type ReportResult = ReportSendResult | ReportErrorResult | ReportHelpResult;

export function isReportError(r: ReportResult): r is ReportErrorResult {
  return 'error' in r;
}
export function isReportHelp(r: ReportResult): r is ReportHelpResult {
  return 'help' in r;
}

type FlagKind = 'single' | 'repeatable' | 'passthroughValue' | 'passthroughBool';

// The single source of truth for every flag this subcommand understands: what
// kind it is (single-value / repeatable / passed straight through to the
// normal send pipeline unchanged) drives BOTH the unknown-flag check and the
// parse-loop dispatch below, so adding a flag never desyncs a separate
// "is this known" table from the switch that consumes it — a flag missing
// from the switch below now surfaces as an unhandled kind, not as a silent
// fall-through into the passthrough default.
const FLAG_KINDS: Record<string, FlagKind> = {
  title: 'single',
  impact: 'single',
  'verify-cmd': 'single',
  'verify-result': 'single',
  ticket: 'repeatable',
  pr: 'repeatable',
  evidence: 'repeatable',
  summary: 'repeatable',
  'reply-to': 'passthroughValue',
  subagent: 'passthroughValue',
  agent: 'passthroughValue',
  topic: 'passthroughValue',
  // Attachments (tg-cli#775): repeatable, carried verbatim into the send argv so the
  // plain send's guards (screenshot gate, never-attach denylist, missing/empty skip,
  // code/md→pdf) apply unchanged.
  photo: 'passthroughValue',
  file: 'passthroughValue',
  'dry-run': 'passthroughBool',
};

export const REPORT_USAGE = `Usage:
  tg report --title <text> (--ticket <id-or-url> | --pr <num-or-url>) \\
            --impact <text> --verify-cmd <cmd> --verify-result <result> \\
            [--evidence <text>]... [--summary <text>]... \\
            [--photo <path>]... [--file <path>]... \\
            [--reply-to <id>] [--subagent <name>] [--topic <id>] [--dry-run]

Formats a structured result report — ticket/PR link(s), user impact,
"what changed" bullets, evidence, and required verification proof — as a
Telegram Rich Message and sends it with --tag report (🟢 REPORT badge).
Reuses the normal send pipeline (dictionary gate, autolink, --dry-run, …).

Required:
  --title <text>           report headline; becomes the <h2> body headline
  --ticket <id-or-url>      ticket reference (repeatable) — at least one of
  --pr <num-or-url>         --ticket/--pr is required (also repeatable)
  --impact <text>           the user-facing impact / motivation — why this report exists
  --verify-cmd <cmd>        the exact command/action run to verify the change
  --verify-result <text>    its observed result — verification is not optional

Optional:
  --evidence <text>        supporting evidence line (repeatable)
  --summary <text>         a "what changed" bullet (repeatable)
  --photo <path>           attach an image (repeatable) — same as the global --photo
  --file <path>            attach a document (repeatable) — same as the global --file
  --reply-to / --subagent / --topic / --dry-run   same as the global flags

Attachments: --photo/--file take exactly the semantics of the plain send form:
the screenshot gate is satisfied by a real, non-empty --photo; secret-looking
files (.env, keys, …) are refused by the never-attach denylist; a missing/empty/
unreadable attachment is skipped with a warning and the report still goes out;
code files and markdown given to --file are converted to PDF as usual. A rich
report cannot ride as a media caption, so the photos arrive FIRST as their own
message(s) (an album for 2+), then the report, then any documents — the same
order as a plain send. --dry-run validates the attachments and uploads nothing.
--feature/--no-feature/--pdf-device and the other global flags are not
supported here. A file path mentioned inside --evidence/--summary text stays
plain text; it is never attached.

A --ticket value that already looks like a ticket code (HYP-123) is left as
plain text so the existing autolink-tasks feature links it. A --pr value is
rendered as a real link whenever one can be built: an http(s) URL is used
as-is, an "owner/repo#123" reference becomes a github.com PR link (built
directly here — autolink-prs only ever resolves a bare #N against the
INVOKING repo, so leaving a cross-repo reference to it could link the wrong
PR), and a bare number ("123") is rewritten to "#123" for autolink-prs to
resolve against the invoking repo.`;

// Wraps a value for display: an http(s) URL becomes a real link over the
// escaped URL text; anything else is returned as plain escaped text so the
// existing autolink-tasks/autolink-prs features (already ON by default) can
// resolve a bare ticket code or #N reference downstream. `displayText`
// (defaults to `value`) lets a caller show a readable label over a computed
// href — see renderPrRef below.
function escapeOrLink(value: string, displayText: string = value): string {
  const escapedText = escapeHtml(displayText);
  if (/^https?:\/\//i.test(value)) {
    return `<a href="${escapeHtml(value)}">${escapedText}</a>`;
  }
  return escapedText;
}

// Normalizes a --pr value into what should actually be rendered:
//   - an http(s) URL is used as-is;
//   - "owner/repo#N" is rewritten to a real GitHub PR URL, keeping the
//     original "owner/repo#N" as the visible label — autolink-prs only ever
//     resolves a bare #N against the INVOKING repo (features/autolink-prs/
//     detect.ts), so leaving a cross-repo reference to that pass could link
//     the wrong PR;
//   - a bare number ("456") becomes "#456" so autolink-prs' cwd-repo
//     resolution can link it — the one form genuinely left to that feature;
//   - anything else (already "#N", or an unrecognized shape) is left as-is.
function renderPrRef(value: string): string {
  if (/^https?:\/\//i.test(value)) return escapeOrLink(value);
  const ownerRepoMatch = value.match(/^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/);
  if (ownerRepoMatch) {
    const [, ownerRepo, number] = ownerRepoMatch;
    return escapeOrLink(`https://github.com/${ownerRepo}/pull/${number}`, value);
  }
  if (/^[1-9][0-9]*$/.test(value)) return escapeOrLink(`#${value}`);
  return escapeOrLink(value);
}

function buildBody(opts: {
  title: string;
  tickets: string[];
  prs: string[];
  impact: string;
  verifyCmd: string;
  verifyResult: string;
  evidence: string[];
  summary: string[];
}): string {
  const parts: string[] = [`<h2>${escapeHtml(opts.title)}</h2>`];

  const links: string[] = [
    ...opts.tickets.map((t) => `<b>Ticket:</b> ${escapeOrLink(t)}`),
    ...opts.prs.map((p) => `<b>PR:</b> ${renderPrRef(p)}`),
  ];
  if (links.length) parts.push(links.join('\n'));

  parts.push(`<h3>Why</h3>\n<p>${escapeHtml(opts.impact)}</p>`);

  if (opts.summary.length) {
    parts.push(`<h3>What changed</h3>\n<ul>${opts.summary.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`);
  }

  if (opts.evidence.length) {
    parts.push(`<h3>Evidence</h3>\n<ul>${opts.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`);
  }

  parts.push(
    `<h3>Verification</h3>\n<pre>${escapeHtml(opts.verifyCmd)}</pre>\n<p>${escapeHtml(opts.verifyResult)}</p>`,
  );

  return parts.join('\n\n');
}

/**
 * Parse `tg report <...>` arguments (everything AFTER the leading "report"
 * token) into either a fresh argv for the normal send pipeline
 * (`--tag report --format html … <body>`), a help text, or an error.
 */
export function buildReportSend(args: string[]): ReportResult {
  if (args.length === 0) {
    return { help: REPORT_USAGE };
  }

  let title: string | undefined;
  let impact: string | undefined;
  let verifyCmd: string | undefined;
  let verifyResult: string | undefined;
  const tickets: string[] = [];
  const prs: string[] = [];
  const evidence: string[] = [];
  const summary: string[] = [];
  const passthrough: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Help wins anywhere in the argument list (matches the global parseArgs
    // convention), not only as the very first token.
    if (arg === '-h' || arg === '--help') {
      return { help: REPORT_USAGE };
    }
    if (!arg.startsWith('--')) {
      return { error: `Error: unexpected argument '${arg}' — tg report takes only flags. See \`tg help report\`.` };
    }
    const name = arg.slice(2);
    const kind = FLAG_KINDS[name];
    if (kind === undefined) {
      return { error: `Error: unknown flag '${arg}'. See \`tg help report\`.` };
    }

    if (kind === 'passthroughBool') {
      passthrough.push(arg);
      continue;
    }

    const value = args[i + 1];
    // A value that itself looks like ANOTHER known flag (e.g. `--title
    // --ticket HYP-1`, where --title's value was simply forgotten) is
    // rejected as a missing value with a clear message. An arbitrary value
    // that merely starts with "--" but isn't a recognized flag name (e.g.
    // test-runner output like "--- 12 passed, 0 fail ---") is accepted
    // verbatim — there is no other way to supply such a value.
    const looksLikeForgottenFlag = value !== undefined && value.startsWith('--') && FLAG_KINDS[value.slice(2)] !== undefined;
    if (value === undefined || value === '' || looksLikeForgottenFlag) {
      return { error: `Error: ${arg} requires a value. See \`tg help report\`.` };
    }
    i++;

    switch (name) {
      case 'title':
        title = value;
        break;
      case 'impact':
        impact = value;
        break;
      case 'verify-cmd':
        verifyCmd = value;
        break;
      case 'verify-result':
        verifyResult = value;
        break;
      case 'ticket':
        tickets.push(value);
        break;
      case 'pr':
        prs.push(value);
        break;
      case 'evidence':
        evidence.push(value);
        break;
      case 'summary':
        summary.push(value);
        break;
      default:
        // The only remaining kind reaching here is 'passthroughValue'
        // (reply-to/subagent/agent/topic) — carried through verbatim.
        passthrough.push(arg, value);
    }
  }

  const missing: string[] = [];
  if (!title) missing.push('title (--title "<text>")');
  if (tickets.length === 0 && prs.length === 0) {
    missing.push('a ticket or PR link (--ticket <id> and/or --pr <num-or-url>)');
  }
  if (!impact) missing.push('user impact (--impact "<text>")');
  if (!verifyCmd) missing.push('verification command (--verify-cmd "<cmd>")');
  if (!verifyResult) missing.push('verification result (--verify-result "<result>")');
  if (missing.length > 0) {
    return {
      error:
        `Result report is missing required fields:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\nFix and resend. See \`tg help report\` for the full field list.`,
    };
  }

  if (title === undefined || impact === undefined || verifyCmd === undefined || verifyResult === undefined) {
    // Unreachable: the missing-field checks above already guarantee these are
    // all defined by this point. This narrows the types below without an
    // unchecked cast — if a future edit ever desyncs the two checks, this
    // fails loudly instead of silently forwarding `undefined` as a string.
    return { error: 'Error: internal — a required field was unset after validation passed. This is a tg-cli bug; please report it.' };
  }

  const body = buildBody({
    title,
    tickets,
    prs,
    impact,
    verifyCmd,
    verifyResult,
    evidence,
    summary,
  });

  return {
    argv: ['--tag', 'report', '--format', 'html', ...passthrough, body],
  };
}
