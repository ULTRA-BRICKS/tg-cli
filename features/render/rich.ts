// --- Rich message detection + validation (pure) ---
//
// Telegram Bot API 10.1 (June 2026) added `sendRichMessage`, which renders a
// MUCH larger HTML tag set than the basic `sendMessage` parse_mode=HTML path:
// native tables, headings, lists, dividers, footers, details/summary, pull
// quotes, LaTeX formulas (`<tg-math>` / `<tg-math-block>`) and media blocks.
// See https://core.telegram.org/bots/api#rich-html-style and #sendrichmessage.
//
// CTO design: NO new flag and NO new `--format` value. Rich goes THROUGH the
// existing `--format html`. tg auto-decides by content: HTML that uses only the
// basic tags (b/i/u/s/code/pre/a/blockquote/tg-emoji/tg-time/spoiler) →
// sendMessage as today; HTML that contains a RICH-only tag (table/h1-h6/ul/ol/
// li/hr/p/details/formula/media/…) → sendRichMessage with `rich_message.html`.
//
// This module is PURE: detection + limit validation only. The actual API call
// (sendRichMessage) lives in features/transport/telegram.ts; the routing (which
// text messages go rich vs. plain, and that a rich message is NOT 4096-split
// and never rides as a media caption) lives in the transmitter.

import { stripHtmlTags } from './html';
import { escapeRegExp } from '../util/regex';

// Rich-ONLY tags: present in the rich-html-style allowlist but NOT in the basic
// sendMessage allowlist (features/render/html.ts detectHtmlTags). Seeing any of
// these in an HTML body means the message must go via sendRichMessage. The
// basic tags (b, strong, i, em, u, ins, s, strike, del, code, pre, a, span,
// tg-spoiler, tg-emoji, tg-time, blockquote) are deliberately EXCLUDED here so a
// normal report with a <b> bold + a <blockquote> still takes the plain path.
//
// `mark`, `sub`, `sup` ARE in the basic visual set conceptually, but Telegram's
// BASIC sendMessage HTML does not accept them — they only render inside a rich
// message — so they count as rich-only triggers too.
export const RICH_ONLY_TAGS = [
  // structure / block
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'hr',
  'footer',
  'aside',
  'cite',
  'figure',
  'figcaption',
  'details',
  'summary',
  // lists
  'ul',
  'ol',
  'li',
  // tables
  'table',
  'caption',
  'tr',
  'th',
  'td',
  // inline rich
  'mark',
  'sub',
  'sup',
  'br',
  // task-list checkbox (rich-only void element); a bare `<input type=checkbox>`
  // checklist item must route to sendRichMessage, not basic sendMessage.
  'input',
  // formulas
  'tg-math',
  'tg-math-block',
  'tg-reference',
  // media / containers
  'img',
  'video',
  'audio',
  'tg-map',
  'tg-collage',
  'tg-slideshow',
] as const;

// Compiled once: `<tag` or `</tag` at a word boundary, case-insensitive. The
// hyphenated custom tags (tg-math, tg-math-block, …) must be matched with the
// hyphen escaped and ordered longest-first so `tg-math-block` wins over
// `tg-math` (a trailing \b after `tg-math` would otherwise also fire on the
// longer one, but matching the longer token first keeps intent clear).
const RICH_TAG_RE = new RegExp(
  '</?(?:' +
    [...RICH_ONLY_TAGS]
      .sort((a, b) => b.length - a.length)
      .map((t) => escapeRegExp(t))
      .join('|') +
    ')(?=[\\s/>]|$)',
  'i',
);

// Rich-only <a> forms. A bare external HTTP(S) link (`<a href="https://…">`) and
// a `tg://user?id=…` mention are BASIC inline tags (in both allowlists) and must
// stay on the sendMessage path; but the rich-html-style docs give <a> several
// RICH-only roles the basic parser does not render:
//   - an in-document anchor target:  `<a name="chapter-1"></a>`
//   - an in-document link / footnote: `<a href="#chapter-1">…</a>`
//   - a mailto: e-mail link:          `<a href="mailto:user@example.com">…</a>`
//   - a tel: phone link:              `<a href="tel:+123456789">…</a>`
// Any of those means the body must go via sendRichMessage (basic HTML only
// documents http(s) and tg://user links). Matched per ATTRIBUTE — the tag name
// alone can't distinguish these from a normal link, and a scan of the raw tag
// text misfires on `name=` inside a value: `<a href="https://x/?name=y">` or
// `title="name=x"` is a basic link (tg-cli#606). Each attribute's value is
// consumed whole, quoted or not, so only real attribute names are tested.
const A_OPEN_RE = /<a\b([^>]*)>/gi;
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function hasRichAnchor(text: string): boolean {
  for (const tag of text.matchAll(A_OPEN_RE)) {
    for (const [, rawName, rawValue] of tag[1].matchAll(ATTR_RE)) {
      if (rawValue === undefined) continue;
      const name = rawName.toLowerCase();
      if (name === 'name') return true;
      if (name === 'href' && /^["']?\s*(?:#|mailto:|tel:)/i.test(rawValue)) return true;
    }
  }
  return false;
}

/**
 * True when the HTML body contains at least one RICH-only tag and therefore
 * must be sent via sendRichMessage. HTML that uses only the basic Telegram tags
 * returns false (it stays on the today sendMessage path). Pure.
 */
export function isRichHtml(text: string): boolean {
  return RICH_TAG_RE.test(text) || hasRichAnchor(text);
}

/**
 * Normalize basic-only constructs that the RICH HTML allowlist does NOT accept,
 * so a mixed basic+rich body (routed to sendRichMessage because of a rich tag)
 * doesn't carry a tag the rich parser rejects. The rich allowlist is NOT a
 * strict superset of the basic one: the basic html-style supports
 * `<span class="tg-spoiler">…</span>`, but rich-html-style only supports the
 * `<tg-spoiler>…</tg-spoiler>` form (https://core.telegram.org/bots/api#rich-html-style).
 * Rewrite the span form to the tg-spoiler form (semantically identical, both
 * documented spoilers). Pure; applied just before a rich send.
 */
export function normalizeRichHtml(html: string): string {
  // Walk every <span …>/<\/span> tag with a depth stack so the close tag is
  // rewritten to match its OWN open tag, even when spoiler spans nest. A regex
  // pairing open-to-close mis-nests; independent open/close replacement can flip
  // the wrong close. The `class` attribute is matched on a word boundary so
  // `data-class="tg-spoiler"` is NOT treated as a real class. A <span> that is
  // NOT a tg-spoiler is left untouched (it is invalid in rich HTML regardless;
  // validateRichHtml / the API surface that — we only safely rewrite the one
  // documented spoiler form). Pure.
  const SPAN_RE = /<span\b([^>]*)>|<\/span>/gi;
  const isSpoiler = (attrs: string): boolean => /(?:^|\s)class\s*=\s*["']tg-spoiler["']/i.test(attrs);
  const stack: boolean[] = [];
  return html.replace(SPAN_RE, (match, attrs?: string) => {
    if (attrs !== undefined) {
      const spoiler = isSpoiler(attrs);
      stack.push(spoiler);
      return spoiler ? '<tg-spoiler>' : match;
    }
    // Close tag: rewrite iff its matching open was a spoiler span.
    const spoiler = stack.pop();
    return spoiler ? '</tg-spoiler>' : match;
  });
}

// Telegram rich-message limits (https://core.telegram.org/bots/api#rich-message-limits).
export const RICH_LIMITS = {
  // Up to 32768 UTF-8 characters in the rich message text, including custom
  // emoji alternative text and formula source.
  maxChars: 32768,
  // Up to 500 blocks, including nested blocks, list items, ordered list items,
  // table rows, quotation blocks, and details blocks.
  maxBlocks: 500,
  // Up to 16 levels of nested formatting and blocks.
  maxNesting: 16,
  // Up to 50 media attachments in total (photos, videos, audio).
  maxMedia: 50,
  // Up to 20 columns in a table.
  maxTableColumns: 20,
} as const;

// Tags that count as a "block" toward the 500-block limit (best-effort: the API
// counts structural blocks + every list item / table row / quote / details).
const BLOCK_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'pre',
  'hr',
  'footer',
  'aside',
  'li',
  'tr',
  'table',
  'ul',
  'ol',
  'blockquote',
  'details',
  'figure',
  'tg-math-block',
  'img',
  'video',
  'audio',
  'tg-map',
  'tg-collage',
  'tg-slideshow',
]);

const MEDIA_TAGS = new Set(['img', 'video', 'audio']);

// Void (self-closing) rich elements that never open a nesting level even without
// a trailing slash. Beyond media + <hr>/<br>, the rich task-list `<input
// type="checkbox">` is void too — counting it as a container would inflate the
// nesting depth and falsely reject a long checklist.
const VOID_TAGS = new Set(['img', 'hr', 'br', 'input', 'tg-map', 'tg-emoji']);

// Collapse the entities the API recognizes to a single placeholder before
// counting characters: every NUMERIC entity (&#NN; / &#xNN;) and the documented
// named set each render as ONE (or few) visible chars, so counting their raw
// spelling (`&lt;` = 4) would over-count and falsely reject. Conservative: it is
// only used for the length budget, so collapsing to one char per entity can only
// LOWER the count (never falsely reject); literal `&` that is not an entity is
// left as-is.
const NAMED_ENTITY_RE = /&(?:lt|gt|amp|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo);/g;
const NUMERIC_ENTITY_RE = /&#(?:[0-9]+|x[0-9a-fA-F]+);/g;
// NOT a js/double-escaping chain (unlike the decode this PR replaced elsewhere):
// both replaces map an entity to the SAME placeholder `￼`, which contains no `&`,
// so the second pass can never re-process the first's output. The two patterns
// also match disjoint sets (named vs `&#…;` numeric). It collapses entities for a
// CHARACTER-COUNT budget only — it must not be turned into decodeHtmlEntities,
// which decodes to real chars and would change the count.
function decodeEntitiesForCount(s: string): string {
  return s.replace(NAMED_ENTITY_RE, '￼').replace(NUMERIC_ENTITY_RE, '￼');
}

export interface RichValidation {
  ok: boolean;
  // Human-readable reason when ok=false; undefined when ok=true.
  error?: string;
}

/**
 * Pre-flight the rich HTML against Telegram's documented limits so an oversize /
 * over-nested message fails with a clear local error instead of an opaque 400
 * from the API. Best-effort and conservative: it counts UTF-8 length exactly,
 * approximates block/media counts by counting opening block/media tags, and
 * tracks the maximum tag-nesting depth and per-table column count. Pure.
 */
export function validateRichHtml(html: string): RichValidation {
  // 1. Character budget (UTF-8 code points). The API's 32768 limit counts the
  //    rich message TEXT (visible text + custom-emoji alt text + formula source),
  //    NOT the tag/attribute markup. Counting the raw HTML would FALSELY reject a
  //    valid dense table (e.g. 400 rows x 20 one-char cells ≈ 8k text chars but
  //    ~83k of HTML). So strip the tags before counting — a false reject of a
  //    valid message is worse than letting an over-budget body get a clean API
  //    400. Formula source survives as element CONTENT (<tg-math>…</tg-math>).
  //    The one piece of counted text that lives in an ATTRIBUTE is a custom
  //    emoji's `alt` (`<img src="tg://emoji?…" alt="…">` / `<tg-emoji>` alt), so
  //    pull those out and add them back before the strip drops the attributes.
  const altText = (html.match(/\balt\s*=\s*"([^"]*)"|alt\s*=\s*'([^']*)'/gi) ?? [])
    .map((a) => a.replace(/^[^=]*=\s*["']?/, '').replace(/["']$/, ''))
    .join('');
  const text = decodeEntitiesForCount(stripHtmlTags(html) + altText);
  const chars = [...text].length;
  if (chars > RICH_LIMITS.maxChars) {
    return {
      ok: false,
      error: `rich message too long: ${chars} chars (limit ${RICH_LIMITS.maxChars}).`,
    };
  }

  // 2/3/4. Single pass over tags: count blocks + media, track nesting depth,
  //        and per-table column counts.
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let blocks = 0;
  let media = 0;
  let depth = 0;
  let maxDepth = 0;
  // Per-row column count, checked at EVERY </tr> (a later row can be the wide
  // one). Reset at each <tr> to the columns still OCCUPIED by rowspans started in
  // earlier rows (`carry`), then accumulate this row's <td>/<th> (counting
  // colspan). `inTable` only gates that cells/rows belong to a table so stray
  // <tr>/<td> outside one are ignored. `rowspans` tracks { cols, rowsLeft } for
  // each active rowspan; each <tr> ages them by one row and drops the expired.
  let inTable = 0;
  let cols = 0;
  let rowspans: { cols: number; rowsLeft: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(attrs) || VOID_TAGS.has(name);
    // A media tag counts toward the 50-attachment limit ONLY when it is a real
    // media block — i.e. an HTTP/HTTPS source. `<img src="tg://emoji?id=…">` is a
    // custom emoji, not a photo, and must not consume the media budget.
    const httpSrc = /\bsrc\s*=\s*["']?https?:/i.test(attrs);

    if (!isClose) {
      // A media tag is a block only when it's a real HTTP/HTTPS media block; a
      // tg://emoji <img> is a custom emoji, neither a block nor an attachment.
      if (BLOCK_TAGS.has(name) && (!MEDIA_TAGS.has(name) || httpSrc)) blocks++;
      if (MEDIA_TAGS.has(name) && httpSrc) media++;
      if (!selfClosing) {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
      }
      if (name === 'table') {
        inTable++;
        rowspans = [];
      }
      if (name === 'tr' && inTable > 0) {
        // A new row starts already occupying the columns held by active rowspans
        // from EARLIER rows, then those carries age by one row (drop expired).
        // Aging here — not at </tr> — means a rowspan added by THIS row's own
        // cells (pushed below) is not aged until the next <tr>, so a rowspan=2
        // correctly reaches into exactly one following row.
        cols = rowspans.reduce((sum, r) => sum + r.cols, 0);
        rowspans = rowspans.map((r) => ({ cols: r.cols, rowsLeft: r.rowsLeft - 1 })).filter((r) => r.rowsLeft > 0);
      }
      if (inTable > 0 && (name === 'td' || name === 'th')) {
        const colspan = /colspan\s*=\s*["']?(\d+)/i.exec(attrs);
        const span = colspan ? Math.max(1, Number(colspan[1])) : 1;
        cols += span;
        // A rowspan>1 cell keeps occupying `span` columns in the next rows.
        const rowspan = /rowspan\s*=\s*["']?(\d+)/i.exec(attrs);
        const rs = rowspan ? Math.max(1, Number(rowspan[1])) : 1;
        if (rs > 1) rowspans.push({ cols: span, rowsLeft: rs - 1 });
      }
    } else {
      if (!selfClosing && depth > 0) depth--;
      if (name === 'tr' && inTable > 0) {
        if (cols > RICH_LIMITS.maxTableColumns) {
          return {
            ok: false,
            error: `table has ${cols} columns (limit ${RICH_LIMITS.maxTableColumns}).`,
          };
        }
      }
      if (name === 'table' && inTable > 0) inTable--;
    }
  }

  if (blocks > RICH_LIMITS.maxBlocks) {
    return {
      ok: false,
      error: `rich message has ${blocks} blocks (limit ${RICH_LIMITS.maxBlocks}).`,
    };
  }
  if (media > RICH_LIMITS.maxMedia) {
    return {
      ok: false,
      error: `rich message has ${media} media attachments (limit ${RICH_LIMITS.maxMedia}).`,
    };
  }
  if (maxDepth > RICH_LIMITS.maxNesting) {
    return {
      ok: false,
      error: `rich message nested ${maxDepth} levels deep (limit ${RICH_LIMITS.maxNesting}).`,
    };
  }
  return { ok: true };
}
