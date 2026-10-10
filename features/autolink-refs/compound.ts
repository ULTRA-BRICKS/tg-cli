// Compound reference detection + linkify for ranges and lists (item 7,
// docs/specs/autolink-compound.md). Shared by autolink-tasks (XXX-ddd ticket
// codes) and autolink-prs (#ddd GitHub refs).
//
// A compound token is a LEAD reference followed by more numbers joined by
// separators:   HYP-100..103/110     or     #5-7,9
//   list seps  '/' ','        → each written number is its own reference;
//   range seps '..' '…' '-'   → an inclusive range. The bottom reference block
//     enumerates EVERY number in the range, but in the message body only the two
//     WRITTEN endpoints are linked (decision 2026-06-12: "в теле ссылки на
//     границы, внизу — все").
//
// "Written" numbers are the digit-runs that literally appear in the text: the
// lead, plus every number after a separator. Range INTERIOR numbers are
// synthesized for the block only and never appear (so never link) in the body.
//
// This module is PURE and owns its own tag-safe HTML walker so the heavily
// tested single-code linkers (linkifyCodes / linkifyRefs) stay untouched. For a
// single, separator-free token a compound group degenerates to one written
// number and the output is identical to the legacy linkers.

export type Sep = '/' | ',' | '..' | '…' | '-';

export interface NumberSpan {
  value: number;
  start: number; // token-relative; for the lead it spans the whole lead token
  end: number;
}

export interface CompoundGroup {
  key: string; // ticket team key ('HYP'); '' for #refs
  written: NumberSpan[]; // written[0] is the lead
  seps: Sep[]; // seps[i] sits between written[i] and written[i+1]
}

const RANGE_SEPS = new Set<Sep>(['..', '…', '-']);

// Cap on interior numbers synthesized for ONE range step — a fat-fingered
// HYP-1..99999 must not enumerate 100k entries. Beyond the cap the interior is
// dropped; the two written endpoints still link + list.
export const RANGE_STEP_CAP = 100;

// Cap on interior numbers synthesized for a whole GROUP: a chain of in-cap steps
// (#1-101-201-…) would otherwise enumerate 100 × steps entries (tg-cli#606). Once a
// step's interior would exceed what is left, that step keeps only its endpoints.
export const RANGE_GROUP_CAP = 500;

// A lead match supplied by the feature (reuses its boundary/path rules):
// findCodeMatches → {start,end,code}; findRefMatches → {start,end,number}.
export interface LeadMatch {
  start: number;
  end: number;
  key: string; // 'HYP' for tickets, '' for refs
  value: number;
}

// sep alternation, longest first so '..' wins and a single '.' is never eaten
// (a sentence period after a code must not start a phantom range).
const TAIL_RE = /^(\.\.|…|\/|,|-)([0-9]+)/;

// Index just past the last numeric tail segment of a compound starting after a
// lead at `from`. Lets a caller inspect what follows the whole numeric run (a
// path suffix like `.ts:10` must disqualify the lead — codex review finding).
export function compoundTailEnd(token: string, from: number): number {
  let i = from;
  for (;;) {
    const m = TAIL_RE.exec(token.slice(i));
    if (!m) break;
    i += m[0].length;
  }
  return i;
}

// Build compound groups for one whitespace-delimited token, given its lead
// matches (already boundary/path-filtered by the caller). Each lead grows a tail
// of (sep)(digits) repeats. Tails are bare digit-runs only: `HYP-1/HYP-2` does
// NOT merge (the second lead has letters), it stays two single-number groups.
export function groupsFromLeads(token: string, leads: LeadMatch[]): CompoundGroup[] {
  const groups: CompoundGroup[] = [];
  for (const lead of leads) {
    const written: NumberSpan[] = [{ value: lead.value, start: lead.start, end: lead.end }];
    const seps: Sep[] = [];
    let i = lead.end;
    for (;;) {
      const m = TAIL_RE.exec(token.slice(i));
      if (!m) break;
      const sep = m[1] as Sep;
      const numStart = i + m[1].length;
      const numStr = m[2];
      written.push({ value: parseInt(numStr, 10), start: numStart, end: numStart + numStr.length });
      seps.push(sep);
      i = numStart + numStr.length;
    }
    groups.push({ key: lead.key, written, seps });
  }
  return groups;
}

// Expand a group to every number it denotes, in order, deduped within the group:
// list seps add the next written number; range seps fill the inclusive interior
// (capped per step and per group). The written endpoints are always present. A
// range with an endpoint past 2^53 gets no interior: `n++` stops advancing there
// (2^53 + 1 === 2^53), which used to spin forever (tg-cli#606).
export function expandGroup(g: CompoundGroup): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const push = (n: number): void => {
    if (seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  let interiorLeft = RANGE_GROUP_CAP;
  push(g.written[0].value);
  for (let i = 1; i < g.written.length; i++) {
    const sep = g.seps[i - 1];
    const prev = g.written[i - 1].value;
    const cur = g.written[i].value;
    const interior = cur - prev - 1;
    if (RANGE_SEPS.has(sep) && Number.isSafeInteger(cur) && interior > 0 && interior < RANGE_STEP_CAP && interior <= interiorLeft) {
      interiorLeft -= interior;
      for (let n = prev + 1; n < cur; n++) push(n);
    }
    // beyond a cap: drop the interior, keep the endpoint below
    push(cur);
  }
  return out;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Linkify a rendered (already HTML-escaped) body. `findLeads` returns the lead
// matches for a token; `urlFor(key, value)` returns the verified URL or null.
// Each WRITTEN number that resolves is wrapped in <a>; separators, interior text
// and unverified numbers are copied verbatim. Tag-safe: never rewrites inside
// <a>/<pre>/<code>, never touches a token containing '://'.
export function linkifyCompound(
  html: string,
  findLeads: (token: string) => LeadMatch[],
  urlFor: (key: string, value: number) => string | null,
): string {
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
    out += linkifySegment(part, findLeads, urlFor);
  }
  return out;
}

function linkifySegment(
  text: string,
  findLeads: (token: string) => LeadMatch[],
  urlFor: (key: string, value: number) => string | null,
): string {
  const pieces = text.split(/(\s+)/);
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i % 2 === 1 || !piece || piece.includes('://')) {
      out += piece;
      continue;
    }
    const groups = groupsFromLeads(piece, findLeads(piece));
    // Collect every written span that resolves, in token order, then splice.
    const links: Array<{ start: number; end: number; url: string }> = [];
    for (const g of groups) {
      for (const w of g.written) {
        const url = urlFor(g.key, w.value);
        if (url) links.push({ start: w.start, end: w.end, url });
      }
    }
    if (links.length === 0) {
      out += piece;
      continue;
    }
    links.sort((a, b) => a.start - b.start);
    let cursor = 0;
    let rebuilt = '';
    for (const l of links) {
      if (l.start < cursor) continue; // overlap guard (shouldn't happen)
      rebuilt += piece.slice(cursor, l.start);
      rebuilt += `<a href="${escapeAttr(l.url)}">${piece.slice(l.start, l.end)}</a>`;
      cursor = l.end;
    }
    out += rebuilt + piece.slice(cursor);
  }
  return out;
}
