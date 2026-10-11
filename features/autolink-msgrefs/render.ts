// Post-render linkify for the autolink-msgrefs feature (tg#28).
//
// Turns each `tg#<id>` message reference in an already-rendered HTML body into
// either a clickable link (when a deep link is possible) or a visually-marked
// styled reference (when it is not). Same tag-safe walk as the sibling autolink
// features: never rewrites inside <a>/<pre>/<code> or a token containing "://".
//
// Telegram message deep links only exist for SUPERGROUPS: a chat id of the form
// `-100<rest>` maps to https://t.me/c/<rest>/<id>. A private bot DM (a positive
// chat id) has NO public per-message URL, so there the reference cannot be a
// link — we still mark it (bold-italic, like the autolink task title) so it
// reads as a deliberate reference rather than stray text.
//
// When the referenced message is in the local history, the ref is instead quoted
// inline — `«beginning of the message…» (tg#<id>)`, the quote linked where a deep
// link exists (tg-cli#116, docs/specs/autolink-msgrefs.md §Quoted previews).

import { escapeHtml, toBoldItalic } from '../prefix-style/style';
import type { LinkEntry } from '../autolink-tasks/render';
import type { HistoryRecord } from '../replies/history';
import { findMsgRefMatches } from './detect';
import { MSGREF_EXCERPT_MAX, MSGREF_PREVIEW_CAP, MSGREF_PREVIEW_MAX, oneLineHead } from './preview';

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * Build the t.me deep link for inbound message `id` in `chatId`, or null when
 * no public link exists. Only SUPERGROUP chats (id `-100<rest>`) have one:
 * https://t.me/c/<rest>/<id>. Channels share that shape. A private DM (positive
 * id) or a basic group (a `-<digits>` id without the `-100` prefix) returns null.
 */
export function msgRefUrl(chatId: number | undefined, id: number): string | null {
  if (chatId === undefined) return null;
  const m = String(chatId).match(/^-100(\d+)$/);
  if (!m) return null;
  return `https://t.me/c/${m[1]}/${id}`;
}

/** The marked-but-unlinked rendering of a `tg#<id>` token (no deep link). The
 *  bold-italic Unicode keeps it visible as a reference; a foreign-letter
 *  fallback never triggers here (the token is ASCII), so this always escapes
 *  cleanly. */
function styledRef(token: string): string {
  if (/^[𝑻𝒕][𝑮𝒈]#/u.test(token)) return escapeHtml(token);
  const uni = toBoldItalic(token);
  return uni !== null ? escapeHtml(uni) : `<i>${escapeHtml(token)}</i>`;
}

/** The plain `tg#<id>` marker: a link when a deep link exists, the styled unlinked form otherwise. */
function refMarker(token: string, url: string | null): string {
  return url ? `<a href="${escapeAttr(url)}">${escapeHtml(token)}</a>` : styledRef(token);
}

function chatMatchRank(rec: HistoryRecord, chatId: number | undefined): 0 | 1 | 2 {
  if (rec.chat_id === undefined) return 1;
  if (chatId === undefined) return 0;
  return rec.chat_id === chatId ? 2 : 0;
}

/**
 * message_id → the history row it refers to in the current chat. `message_id` is
 * only unique per chat: a row stamped with another chat never matches, a legacy
 * row without `chat_id` is the fallback, and among rows of the same rank the
 * first-written one wins (the text as first seen).
 */
function indexHistory(
  history: HistoryRecord[],
  chatId: number | undefined,
): Map<number, { rec: HistoryRecord; rank: 1 | 2 }> {
  const byId = new Map<number, { rec: HistoryRecord; rank: 1 | 2 }>();
  for (const rec of history) {
    if (rec.message_id === null) continue;
    const rank = chatMatchRank(rec, chatId);
    if (rank === 0) continue;
    const prev = byId.get(rec.message_id);
    if (!prev || rank > prev.rank) byId.set(rec.message_id, { rec, rank });
  }
  return byId;
}

function excerptEntries(
  byId: Map<number, { rec: HistoryRecord }>,
  ids: number[],
  urlFor: (id: number) => string | null,
): LinkEntry[] {
  const seen = new Set<number>();
  const entries: LinkEntry[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = byId.get(id)?.rec;
    if (!hit) continue;
    const head = oneLineHead(hit.text, MSGREF_EXCERPT_MAX);
    if (head === null) continue;
    entries.push({
      label: refMarker(`tg#${id}`, urlFor(id)),
      title: `${hit.from}: ${head}`,
    });
  }
  return entries;
}

/**
 * Build bottom-reference entries for mentioned Telegram message ids using the
 * local `tg replies` history. Missing ids are skipped. Text is deliberately a
 * compact one-line head, not a full quote, so a long prior Telegram message
 * does not get copied wholesale into the outgoing report.
 */
export function buildMsgRefEntries(
  history: HistoryRecord[],
  ids: number[],
  urlFor: (id: number) => string | null,
  chatId?: number,
): LinkEntry[] {
  return excerptEntries(indexHistory(history, chatId), ids, urlFor);
}

export interface MsgRefRender {
  previews: Map<number, string>; // id → raw preview text, for linkifyMsgRefs
  entries: LinkEntry[]; // bottom excerpt entries for the refs that got no preview
}

/**
 * Split the linkable refs (`ids`, mention order) between inline previews and the
 * bottom excerpt block, indexing the history once. With `withPreviews`, the first
 * `MSGREF_PREVIEW_CAP` ids that have a non-empty history row in the current chat
 * get a preview and leave the block; every other id with a row keeps its excerpt
 * entry. Ids without a row take no slot and get neither — a preview is never
 * fabricated.
 */
export function resolveMsgRefs(
  history: HistoryRecord[],
  ids: number[],
  urlFor: (id: number) => string | null,
  chatId: number | undefined,
  withPreviews: boolean,
): MsgRefRender {
  const previews = new Map<number, string>();
  if (ids.length === 0) return { previews, entries: [] };
  const byId = indexHistory(history, chatId);
  for (const id of withPreviews ? ids : []) {
    if (previews.size >= MSGREF_PREVIEW_CAP) break;
    if (previews.has(id)) continue;
    const rec = byId.get(id)?.rec;
    const preview = rec ? oneLineHead(rec.text, MSGREF_PREVIEW_MAX) : null;
    if (preview !== null) previews.set(id, preview);
  }
  const rest = ids.filter((id) => !previews.has(id));
  return { previews, entries: excerptEntries(byId, rest, urlFor) };
}

/**
 * `«preview» (marker)` in place of `token` as written. With a deep link the quote
 * itself is the link and the marker stays plain beside it; without one the marker
 * keeps the styled unlinked form of a plain ref. `preview` is raw text.
 */
export function renderMsgRefPreview(token: string, preview: string, url: string | null): string {
  const quote = `«${escapeHtml(preview)}»`;
  if (url) return `<a href="${escapeAttr(url)}">${quote}</a> (${escapeHtml(token)})`;
  return `${quote} (${styledRef(token)})`;
}

function visitLinkableTextSegments(html: string, visit: (segment: string) => string): string {
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
    out += aDepth > 0 || preDepth > 0 ? part : visit(part);
  }
  return out;
}

function textSegmentMsgRefIds(text: string): number[] {
  const ids: number[] = [];
  // Odd indices are the whitespace separators (capture group), even are tokens.
  const pieces = text.split(/(\s+)/);
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i % 2 === 1 || !piece || piece.includes('://')) continue;
    for (const { id } of findMsgRefMatches(piece)) ids.push(id);
  }
  return ids;
}

export function detectLinkableMsgRefs(html: string): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  visitLinkableTextSegments(html, (segment) => {
    for (const id of textSegmentMsgRefIds(segment)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    return segment;
  });
  return ordered;
}

const NO_PREVIEWS: ReadonlyMap<number, string> = new Map();

/**
 * Linkify verified `tg#<id>` references in `html`. `urlFor(id)` returns the deep
 * link or null; a non-null url wraps the token in <a href>, a null url renders
 * the marked-but-unlinked styled form. An id in `previews` is quoted inline at its
 * FIRST occurrence instead (renderMsgRefPreview); repeats get the plain form.
 * Walks the markup tag-by-tag and only rewrites text segments that are NOT inside
 * <a>…</a> (Telegram rejects nested links), NOT inside <pre>/<code>, and NOT part
 * of a token containing "://". Inserted text is never re-scanned.
 */
export function linkifyMsgRefs(
  html: string,
  urlFor: (id: number) => string | null,
  previews: ReadonlyMap<number, string> = NO_PREVIEWS,
): string {
  const unquoted = new Map(previews);
  return visitLinkableTextSegments(html, (segment) => linkifyTextSegment(segment, urlFor, unquoted));
}

function linkifyTextSegment(
  text: string,
  urlFor: (id: number) => string | null,
  unquoted: Map<number, string>,
): string {
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
    for (const { start, end, id } of findMsgRefMatches(piece)) {
      const token = piece.slice(start, end);
      const url = urlFor(id);
      const preview = unquoted.get(id);
      unquoted.delete(id);
      const replacement = preview !== undefined ? renderMsgRefPreview(token, preview, url) : refMarker(token, url);
      rebuilt += piece.slice(cursor, start) + replacement;
      cursor = end;
    }
    out += rebuilt + piece.slice(cursor);
  }
  return out;
}
