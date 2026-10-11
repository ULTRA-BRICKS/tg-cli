// One-line heads of stored Telegram messages for `tg#<id>` refs (tg-cli#116,
// docs/specs/autolink-msgrefs.md §Quoted previews): the inline quoted preview and
// the bottom excerpt entry are both cut here, at different lengths.
//
// The CTO asked that a `tg#5663` in an agent report read as the beginning of the
// message it points at, not as an opaque id: on a phone, and above all in the
// private DM where the ref cannot be a link, the reader otherwise has to look the
// id up. PURE text shaping; the HTML rendering lives in render.ts next to the
// plain-marker rendering it extends.

// Grapheme clusters, not code points: a cut through a ZWJ family or a flag would
// render a broken glyph before the ellipsis. 48 keeps a typical two-ref report line
// on one phone line and bounds how much a preview inflates the visible length.
export const MSGREF_PREVIEW_MAX = 48;
// The bottom excerpt entry has its own line, so it can say more.
export const MSGREF_EXCERPT_MAX = 120;
// Distinct ids quoted inline per message body; later ids keep the plain marker, so a
// report citing 30 messages does not triple in height.
export const MSGREF_PREVIEW_CAP = 8;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The first `max` (≥ 1) grapheme clusters of `text` on one line (raw, not escaped), `…`
 *  when cut; null when nothing visible is left. */
export function oneLineHead(text: string, max: number): string | null {
  if (!(max >= 1)) throw new RangeError(`oneLineHead: max must be >= 1, got ${max}`);
  const oneLine = text.trim().replace(/\s+/g, ' ');
  if (!oneLine) return null;
  // Stop at the first cluster past `max`: a stored message can be 4096 long and only
  // the head is needed; reaching that cluster is the truncation signal.
  const head: string[] = [];
  for (const { segment } of segmenter.segment(oneLine)) {
    if (head.length === max) return `${head.join('').trimEnd()}…`;
    head.push(segment);
  }
  return oneLine;
}
