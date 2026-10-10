// GitHub-reference detection for the autolink-prs feature (spec §Detection).
//
// A reference is `#` immediately followed by digits, written as one token
// (#260). Whether the number is a real Issue or PR is the resolve.ts probe's
// job; this is pure text analysis. Mirrors features/autolink-tasks/detect.ts.

import { expandGroup, groupsFromLeads, type LeadMatch } from '../autolink-refs/compound';

// One reference occurrence inside a token. The leading digit must be 1-9 (#0 is
// not a thing on GitHub). The boundary chars (before/after) must not be
// alphanumeric, so x#1 / #1a are not references while (#260), #260, and #260.
// are.
const REF_RE = /#[1-9][0-9]*/g;

// Boundary test: a reference is rejected when the char on either side is a
// letter or digit. Uses the Unicode property classes (not ASCII `[A-Za-z0-9]`)
// so a STYLED token like `𝒕𝒈#3715` — where the msgref pass rendered `tg` as
// Mathematical Bold Italic before this pass walks the body — is still treated as
// "letter then #" and rejected, instead of letting the GitHub linkifier hijack
// the message ref's `#3715`.
const ALNUM_RE = /[\p{L}\p{N}]/u;

// The full code point ending just before `idx`, or undefined at the start. The
// `#` boundary may sit right after an astral char (e.g. Mathematical Bold Italic
// `𝒈`, a UTF-16 surrogate pair); a bare `segment[idx-1]` would return only the
// trailing low surrogate and mis-classify it as non-letter, so combine the pair.
function codePointBefore(segment: string, idx: number): string | undefined {
  if (idx <= 0) return undefined;
  const lo = segment.charCodeAt(idx - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && idx >= 2) {
    const hi = segment.charCodeAt(idx - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return segment.slice(idx - 2, idx);
  }
  return segment[idx - 1];
}

// The full code point starting at `idx` (handles a leading surrogate pair), or
// undefined at the end.
function codePointAt(segment: string, idx: number): string | undefined {
  if (idx >= segment.length) return undefined;
  const cp = segment.codePointAt(idx);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && ALNUM_RE.test(ch);
}

/**
 * Find reference occurrences in a single text segment (no tag/URL awareness —
 * the caller decides which segments are eligible). Returns [start, end, number]
 * triples for boundary-valid matches. Shared by detection and linkify so the two
 * can never disagree on what counts as a reference.
 */
export function findRefMatches(segment: string): Array<{ start: number; end: number; number: number }> {
  const out: Array<{ start: number; end: number; number: number }> = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(segment)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isAlnum(codePointBefore(segment, start)) || isAlnum(codePointAt(segment, end))) continue;
    out.push({ start, end, number: parseInt(m[0].slice(1), 10) });
  }
  return out;
}

/**
 * Detect GitHub references (#N) in message text: unique by number,
 * first-appearance order. Whitespace-delimited tokens containing "://" (URLs)
 * are skipped entirely — a pasted GitHub URL contains the number in its path and
 * must not count as a plain-text mention.
 */
export function detectRefs(text: string): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.includes('://')) continue;
    for (const { number } of findRefMatches(token)) {
      if (seen.has(number)) continue;
      seen.add(number);
      ordered.push(number);
    }
  }
  return ordered;
}

// Compound lead matches for a token: every #N ref as a keyless LeadMatch the
// compound parser consumes (item 7). Reuses findRefMatches so the #1-9 leading
// digit + boundary rules stay identical to single refs.
export function refLeads(token: string): LeadMatch[] {
  return findRefMatches(token).map((m) => ({ start: m.start, end: m.end, key: '', value: m.number }));
}

/**
 * Like detectRefs, but expands compound groups (#100..103, #5/6/7) into every
 * number they denote — unique, first-appearance order. Feeds the Forgejo probe and
 * the bottom reference block (decision 2026-06-12: enumerate the whole range
 * below, link only the endpoints in the body). A separator-free token yields
 * exactly its single number, so this is a strict superset of detectRefs.
 */
export function detectRefsExpanded(text: string): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.includes('://')) continue;
    for (const g of groupsFromLeads(token, refLeads(token))) {
      for (const n of expandGroup(g)) {
        if (seen.has(n)) continue;
        seen.add(n);
        ordered.push(n);
      }
    }
  }
  return ordered;
}
