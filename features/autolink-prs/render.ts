// Post-render message transform pieces for the autolink-prs feature (spec
// §Rendering). The actual blockquote assembly is owned by autolink-tasks'
// applyAutolink (so tickets + issues coexist in one block); this module supplies
// the GitHub-specific bits: a tag-safe #N linkifier and the LinkEntry adapters
// for issues (merged into the tickets block) and PRs (their own block).

import { linkifyCompound } from '../autolink-refs/compound';
import { escapeHtml, type LinkEntry } from '../autolink-tasks/render';
import { findRefMatches, refLeads } from './detect';
import type { ForgeRef } from './resolve';

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** `<a href="URL">#N</a>` for a resolved reference. */
export function refAnchor(ref: ForgeRef): string {
  return `<a href="${escapeAttr(ref.url)}">#${ref.number}</a>`;
}

/**
 * Replace verified #N occurrences in `html` with <a href> links. Same tag-safe
 * walk as autolink-tasks linkifyCodes: skips inside <a>…</a>, <pre>/<code>, tag
 * attributes, and tokens containing "://". Issues and PRs are linkified alike.
 */
export function linkifyRefs(html: string, refs: Map<number, ForgeRef>): string {
  if (refs.size === 0) return html;
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
    out += linkifyTextSegment(part, refs);
  }
  return out;
}

function linkifyTextSegment(text: string, refs: Map<number, ForgeRef>): string {
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
    for (const { start, end, number } of findRefMatches(piece)) {
      const ref = refs.get(number);
      if (!ref) continue;
      rebuilt += piece.slice(cursor, start) + refAnchor(ref);
      cursor = end;
    }
    out += rebuilt + piece.slice(cursor);
  }
  return out;
}

// Compound-aware #N linkify (item 7): links the lead #N AND every bare trailing
// number of a range/list group (#100..103 → links #100 and 103). A
// separator-free ref renders byte-identical to linkifyRefs, so it is a safe
// drop-in for the autolink-prs body pass.
export function linkifyRefsCompound(html: string, refs: Map<number, ForgeRef>): string {
  if (refs.size === 0) return html;
  return linkifyCompound(html, refLeads, (_key, value) => refs.get(value)?.url ?? null);
}

/**
 * The state annotation appended to a PR line: `(merged)` / `(closed)` /
 * `(draft)` for an open draft / `(open)`. Always already-escaped (literal),
 * usable directly as a LinkEntry suffix.
 */
export function prStateSuffix(ref: ForgeRef): string {
  const state = ref.state.toUpperCase();
  if (state === 'MERGED') return ' (merged)';
  if (state === 'CLOSED') return ' (closed)';
  if (ref.isDraft) return ' (draft)';
  return ' (open)';
}

/** Split resolved refs into issues and PRs, each as applyAutolink LinkEntries,
 *  preserving the given first-appearance `order` of numbers. */
export function buildEntries(
  refs: Map<number, ForgeRef>,
  order: number[],
): { issues: LinkEntry[]; prs: LinkEntry[] } {
  const issues: LinkEntry[] = [];
  const prs: LinkEntry[] = [];
  for (const number of order) {
    const ref = refs.get(number);
    if (!ref) continue;
    if (ref.kind === 'pr') {
      prs.push({ label: refAnchor(ref), title: ref.title, suffix: prStateSuffix(ref) });
    } else {
      issues.push({ label: refAnchor(ref), title: ref.title });
    }
  }
  return { issues, prs };
}
