// Post-render message transform for the autolink-tasks feature (spec
// §Rendering). Runs on the ALREADY-RENDERED HTML body (the tg entrypoint
// forces HTML whenever verified tickets exist, same as line-spec quotes), and
// BEFORE line-spec quote insertion so injected <pre> bodies are never touched.

import { linkifyCompound } from '../autolink-refs/compound';
import { findCodeMatches, ticketLeads } from './detect';
import type { TicketInfo } from './linear';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function anchor(ticket: TicketInfo): string {
  return `<a href="${escapeAttr(ticket.url)}">${ticket.code}</a>`;
}

/**
 * Replace verified-code occurrences in `html` with <a href> links. Walks the
 * markup tag-by-tag and only rewrites text segments that are:
 *   - not inside an <a>…</a> (Telegram rejects nested links),
 *   - not inside <pre>/<code> (no nested entities allowed there),
 *   - not part of a token containing "://" (don't corrupt pasted URLs).
 * Tag bodies themselves (attributes) are copied verbatim.
 */
export function linkifyCodes(html: string, tickets: Map<string, TicketInfo>): string {
  if (tickets.size === 0) return html;
  const parts = html.split(/(<[^>]*>)/);
  let aDepth = 0;
  let preDepth = 0;
  let out = '';
  for (const part of parts) {
    if (part.startsWith('<')) {
      const name = part.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase();
      const closing = part.startsWith('</');
      if (name === 'a') aDepth = Math.max(0, aDepth + (closing ? -1 : 1));
      if (name === 'pre' || name === 'code') preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
      out += part;
      continue;
    }
    if (aDepth > 0 || preDepth > 0) {
      out += part;
      continue;
    }
    out += linkifyTextSegment(part, tickets);
  }
  return out;
}

function linkifyTextSegment(text: string, tickets: Map<string, TicketInfo>): string {
  // Odd indices are the whitespace separators (capture group), even are tokens.
  const pieces = text.split(/(\s+)/);
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i % 2 === 1 || !piece || piece.includes('://')) {
      out += piece;
      continue;
    }
    let rebuilt = '';
    let cursor = 0;
    for (const { start, end, code } of findCodeMatches(piece)) {
      const ticket = tickets.get(code);
      if (!ticket) continue;
      rebuilt += piece.slice(cursor, start) + anchor(ticket);
      cursor = end;
    }
    out += rebuilt + piece.slice(cursor);
  }
  return out;
}

// Compound-aware ticket linkify (item 7): links the lead code AND every bare
// trailing number of a range/list group (HYP-100..103 → links 100 and 103),
// mapping each to its verified ticket URL. For a separator-free code this is
// byte-identical to linkifyCodes, so it is a safe drop-in.
export function linkifyTicketsCompound(html: string, tickets: Map<string, TicketInfo>): string {
  if (tickets.size === 0) return html;
  return linkifyCompound(html, ticketLeads, (key, value) => tickets.get(`${key}-${value}`)?.url ?? null);
}

// A pre-rendered reference line contributed by a sibling feature (autolink-prs).
// `label` is the already-linkified anchor (or plain text) for the left side; the
// title is escaped and appended as `label — title`. This lets autolink-tasks own
// the blockquote shape while autolink-prs supplies GitHub issue/PR entries, with
// no dependency from autolink-tasks back onto autolink-prs.
export interface LinkEntry {
  label: string; // already-built HTML for the left side (e.g. an <a href> anchor)
  title: string; // RAW title, escaped here
  suffix?: string; // optional already-built/escaped trailing annotation, e.g. " (merged)"
}

function entryLine(e: LinkEntry): string {
  return `${e.label} — ${escapeHtml(e.title)}${e.suffix ?? ''}`;
}

export interface AutolinkExtras {
  // Linkify table for sibling refs (e.g. GitHub #N → anchor HTML), applied to
  // the body in the same tag-safe pass as ticket codes via linkifyTokens below.
  linkify?: (html: string) => string;
  // Entries merged INTO the tickets reference block (GitHub issues).
  issues?: LinkEntry[];
  // Entries rendered in their OWN block AFTER the tickets/issues block (PRs).
  prs?: LinkEntry[];
  // Style + escape the single-ticket first-line title (item 5: Unicode Bold
  // Script). Takes the RAW title, returns final HTML. Defaults to plain
  // escapeHtml so callers without styling keep the historical behavior.
  styleTitle?: (raw: string) => string;
  // Override the ticket-code body linkify (item 7: compound ranges/lists).
  // Defaults to the legacy single-code linkifyCodes so existing callers are
  // unchanged. Receives the rendered body, returns it with tickets linked.
  linkifyTickets?: (html: string) => string;
  // Final body pass, after every linkify above and BEFORE the reference blocks are
  // appended: what it inserts (autolink-msgrefs' quoted previews — arbitrary user
  // text) is never re-scanned by the ticket/#N passes, and the blocks are never
  // rewritten by it. Runs even when there are no tickets/issues/PRs.
  linkifyLast?: (html: string) => string;
}

/**
 * Full autolink transform of a rendered message body:
 *   1. linkify every verified code in place (and any sibling refs via
 *      `extras.linkify`), then the `extras.linkifyLast` pass;
 *   2. one ticket and no sibling issues → its (escaped) title on the first line:
 *      appended after the emoji/[window] prefix when one exists, otherwise as
 *      its own first line;
 *   3. several tickets, OR any sibling issues → a collapsed
 *      <blockquote expandable> reference block appended at the end (tickets
 *      first, then issues), one entry line each;
 *   4. sibling PRs → a SEPARATE collapsed block after that one, even for a
 *      single PR (`PRs:` header line).
 * `tickets` is in first-appearance order. Everything empty → body unchanged.
 */
export function applyAutolink(
  body: string,
  tickets: TicketInfo[],
  hasPrefixLine: boolean,
  extras: AutolinkExtras = {},
): string {
  const issues = extras.issues ?? [];
  const prs = extras.prs ?? [];
  if (tickets.length === 0 && issues.length === 0 && prs.length === 0) {
    return extras.linkifyLast ? extras.linkifyLast(body) : body;
  }

  const ticketMap = new Map(tickets.map((t) => [t.code, t]));
  let out = (extras.linkifyTickets ?? ((h: string) => linkifyCodes(h, ticketMap)))(body);
  if (extras.linkify) out = extras.linkify(out);
  if (extras.linkifyLast) out = extras.linkifyLast(out);

  // A single ticket with no sibling issues keeps the first-line title behavior.
  // Any issue forces the block form (issues never ride the first line).
  if (tickets.length === 1 && issues.length === 0) {
    const title = (extras.styleTitle ?? escapeHtml)(tickets[0].title);
    if (hasPrefixLine) {
      const lines = out.split('\n');
      lines[0] = `${lines[0]} ${title}`;
      out = lines.join('\n');
    } else {
      out = `${title}\n${out}`;
    }
  } else if (tickets.length > 0 || issues.length > 0) {
    // Ticket lines keep the historical `CODE: title` shape; GitHub issue lines
    // use `#N — title` (spec §Rendering). Both coexist in the one block.
    const ticketLines = tickets.map((t) => `${anchor(t)}: ${escapeHtml(t.title)}`);
    const issueLines = issues.map(entryLine);
    out = `${out}\n<blockquote expandable>${[...ticketLines, ...issueLines].join('\n')}</blockquote>`;
  }

  if (prs.length > 0) {
    out = `${out}\n<blockquote expandable>PRs:\n${prs.map(entryLine).join('\n')}</blockquote>`;
  }
  return out;
}
