// Generic transmitter (spec §Architecture #3).
//
// The ONLY layer that knows about Telegram's length limits. It consumes a fully
// normalized SendPlan and a Transport (the injectable set of send primitives —
// real ones hit the API, fakes record calls for tests). It applies, in order:
//   - the photos → text → documents "sandwich" (spec §Ordering)
//   - caption overflow: a caption that exceeds 1024, or that would need
//     splitting, is NOT used as media caption; instead the media is sent
//     caption-less and the text becomes separate message(s) (spec §Caption)
//   - the generic >4096 HTML-safe split, applied LAST (spec §Message splitting)
//
// These are transmitter-level SAFETY NETS: they run even when the auto-attach
// feature is OFF, because they are not part of the feature — they are correct
// behavior for any send.

import { decodeHtmlEntities, stripHtmlTags } from '../render/html';
import { isRichHtml, normalizeRichHtml, validateRichHtml } from '../render/rich';
import type { FileCheckResult } from './file-check';
import { splitMessage } from './split';
import {
  CAPTION_LIMIT,
  FLOOD_CAP_MAX_MESSAGES,
  MESSAGE_LIMIT,
  type Format,
  type SendItem,
  type SendPlan,
} from './types';

export interface TransmitOptions {
  checkFile?: (path: string) => FileCheckResult;
  warn?: (message: string) => void;
  allowFlood?: boolean;
}

export interface Transport {
  sendMessage(text: string, format: Format): Promise<void>;
  // Rich message send (Bot API sendRichMessage with rich_message.html). Used for
  // HTML bodies that contain rich-only tags (tables/headings/lists/formulas).
  // Unlike sendMessage, a rich body is sent WHOLE — it is never 4096-split (rich
  // has a 32768 budget and a split would corrupt a <table>/<details>) and never
  // rides as a media caption.
  sendRich(html: string): Promise<void>;
  sendPhoto(item: SendItem, caption: string | undefined, format: Format): Promise<void>;
  sendDocument(item: SendItem, caption: string | undefined, format: Format): Promise<void>;
  // Album send (spec §Ordering / FIX 2): 2..10 same-type items as a single
  // Telegram media group. `kind` is 'photo' or 'document' — Telegram does NOT
  // allow photos and documents in the SAME group, so photo-albums and
  // document-albums are always separate calls (the photos→docs ordering already
  // separates them). The caption, if any, rides the FIRST item of the group.
  sendMediaGroup(
    kind: 'photo' | 'document',
    items: SendItem[],
    caption: string | undefined,
    format: Format,
  ): Promise<void>;
}

// Telegram counts caption/message length by VISIBLE characters, not raw HTML.
// Under HTML mode the text carries <tg-emoji>/<pre>/… tags + escaped &lt; etc.
// that don't count. Approximate the visible length so a caption with an emoji
// prefix isn't wrongly classified as overflow (and sent as a separate message)
// purely because of tag bytes. Approximate (good enough for the 1024 boundary),
// not a full HTML length per Telegram's exact rules.
export function visibleLength(text: string, format: Format): number {
  if (format !== 'html') return text.length;
  // Strip tags first, then decode entities in a single pass (stripHtmlTags /
  // decodeHtmlEntities in render/html). This replaces a `/<[^>]+>/g` strip (which
  // left a dangling `<script` behind — js/incomplete-multi-character-sanitization)
  // followed by a chain of `.replace()` entity decodes. The chained decode trips
  // js/double-escaping: an `&amp;`→`&` step alongside `&lt;`→`<` etc. can feed one
  // decode's output into another (e.g. `&amp;lt;`→`&lt;`→`<`). The single-pass
  // decoder consumes each entity exactly once, so no replacement chains.
  return decodeHtmlEntities(stripHtmlTags(text)).length;
}

// Can the single text message ride as a media caption? Only when there is
// exactly one text message and its VISIBLE length fits within the caption limit.
function captionCandidate(plan: SendPlan): { text: string; format: Format } | null {
  if (plan.textMessages.length !== 1) return null;
  const m = plan.textMessages[0];
  // A rich HTML body (table/heading/list/formula) is sent via sendRichMessage,
  // which is NOT a media caption — never let it ride as one.
  if (m.format === 'html' && isRichHtml(m.text)) return null;
  if (visibleLength(m.text, m.format) > CAPTION_LIMIT) return null;
  return m;
}

async function sendText(text: string, format: Format, t: Transport): Promise<void> {
  // Rich HTML (table/heading/list/formula tags) goes out WHOLE via
  // sendRichMessage — never 4096-split (a split would corrupt a <table>) and
  // never balanced like basic HTML.
  if (format === 'html' && isRichHtml(text)) {
    await t.sendRich(text);
    return;
  }
  // Pass the format so plain messages skip HTML tag-balancing (otherwise a long
  // plain message containing pseudo-tags like `a<b>c` would be corrupted).
  for (const chunk of splitMessage(text, MESSAGE_LIMIT, format)) {
    await t.sendMessage(chunk, format);
  }
}

// tg-cli#208. Counts chunks with the SAME splitMessage(text, MESSAGE_LIMIT, format)
// call `sendText` uses to actually send — keep the two call sites parameter-identical,
// or the preflight count can silently drift from the real send count.
function floodCapViolation(
  text: string,
  format: Format,
): { charCount: number; messageCount: number } | null {
  if (format === 'html' && isRichHtml(text)) return null;
  const messageCount = splitMessage(text, MESSAGE_LIMIT, format).length;
  if (messageCount <= FLOOD_CAP_MAX_MESSAGES) return null;
  return { charCount: text.length, messageCount };
}

const FILE_CHECK_REASON: Record<Exclude<FileCheckResult, 'ok'>, string> = {
  missing: 'file not found',
  empty: 'file is empty',
  unreadable: 'file is unreadable',
};

function filterSendableItems(
  items: SendItem[],
  checkFile: (path: string) => FileCheckResult,
  warn: (message: string) => void,
): SendItem[] {
  return items.filter((item) => {
    if (item.source.kind === 'memory') return true;
    const result = checkFile(item.source.path);
    if (result === 'ok') return true;
    warn(`tg: skipping attachment ${item.source.path}: ${FILE_CHECK_REASON[result]}`);
    return false;
  });
}

// Send one media section (all photos OR all documents) in the order-preserving
// shape Telegram supports: a single sendMediaGroup album for 2..10 items, a lone
// sendPhoto/sendDocument for exactly 1 (a 1-item group is rejected by Telegram),
// and nothing for 0. The caption (when this section is the host) rides the first
// item: as the single item's caption, or as the album's first-item caption.
// Telegram caps a media group at 10 items; >10 same-type attachments are chunked
// into consecutive albums. The caption rides only the FIRST item of the FIRST
// chunk. A trailing chunk of exactly 1 falls back to sendPhoto/sendDocument
// because a 1-item media group is rejected by the API.
const MEDIA_GROUP_MAX = 10;

async function sendMediaSection(
  kind: 'photo' | 'document',
  items: SendItem[],
  caption: string | undefined,
  captionFormat: Format,
  t: Transport,
): Promise<void> {
  if (items.length === 0) return;
  const send1 = kind === 'photo' ? t.sendPhoto.bind(t) : t.sendDocument.bind(t);
  const fmtFor = (cap: string | undefined): Format => (cap !== undefined ? captionFormat : 'plain');

  for (let offset = 0; offset < items.length; offset += MEDIA_GROUP_MAX) {
    const chunk = items.slice(offset, offset + MEDIA_GROUP_MAX);
    // Caption only on the very first item of the whole section.
    const cap = offset === 0 ? caption : undefined;
    if (chunk.length === 1) {
      await send1(chunk[0], cap, fmtFor(cap));
    } else {
      await t.sendMediaGroup(kind, chunk, cap, fmtFor(cap));
    }
  }
}

// PREFLIGHT rich text BEFORE any send. The sandwich sends photos first, so a
// rich body that fails limit-validation inside sendRich (which exits the
// process) would otherwise leave an orphaned photo already on the wire. Catch
// it here, before the first media send, so an invalid rich report sends
// NOTHING. Uses the same validateRichHtml (post-normalize) as the transport.
function preflightRichHtml(plan: SendPlan): void {
  for (const m of plan.textMessages) {
    if (m.format === 'html' && isRichHtml(m.text)) {
      const check = validateRichHtml(normalizeRichHtml(m.text));
      if (!check.ok) {
        console.error(`tg: ${check.error}`);
        process.exit(1);
      }
    }
  }
}

// tg-cli#208 preflight, same posture as preflightRichHtml above (before ANY
// send, so a refused body sends NOTHING — no orphaned photo already on the
// wire). Must run AFTER `riding` is decided: a message that rides as a media
// caption is sent as ONE call regardless of its RAW length (a caption's own
// bound is CAPTION_LIMIT on VISIBLE length, e.g. `visibleLength` collapses many
// `<tg-emoji>` entities to a handful of visible chars) — checking splitMessage's
// raw-length chunk count on that same text would false-positive-refuse a send
// that was never actually going to fragment. `plan.textMessages` is, in
// practice, at most one entry (buildSendPlan's invariant: a plan carries one
// assembled caption/body) — each entry is checked independently, so if that
// invariant ever changes, several just-under-cap messages could together still
// flood without tripping this.
function preflightFloodCap(
  plan: SendPlan,
  riding: { text: string; format: Format } | null,
  allowFlood: boolean,
  warn: (message: string) => void,
): void {
  if (allowFlood) return;
  for (const m of plan.textMessages) {
    if (riding && m === riding) continue;
    const violation = floodCapViolation(m.text, m.format);
    if (violation) {
      warn(
        `tg: refusing ${violation.charCount}-character message: it would send as ${violation.messageCount} messages; ` +
          `use allowFlood: true or --no-feature flood-cap to allow it`,
      );
      process.exit(1);
    }
  }
}

export async function transmit(plan: SendPlan, t: Transport, opts: TransmitOptions = {}): Promise<void> {
  const checkFile = opts.checkFile ?? ((): FileCheckResult => 'ok');
  const warn = opts.warn ?? ((message: string) => console.error(message));

  preflightRichHtml(plan);

  const filteredPlan: SendPlan = {
    ...plan,
    photos: filterSendableItems(plan.photos, checkFile, warn),
    documents: filterSendableItems(plan.documents, checkFile, warn),
  };

  if (
    filteredPlan.photos.length === 0 &&
    filteredPlan.documents.length === 0 &&
    filteredPlan.textMessages.length === 0
  ) {
    // tg-cli#207: every attachment (if any) failed validation and no text
    // remains. A silent success with zero transport calls would read to the
    // caller as a delivered message when nothing actually went out — refuse
    // loudly instead of a fake OK.
    warn('tg: refusing to send — nothing survived validation (no photos, documents, or text)');
    process.exit(1);
  }

  const hasMedia = filteredPlan.photos.length > 0 || filteredPlan.documents.length > 0;
  const riding = hasMedia ? captionCandidate(filteredPlan) : null;
  preflightFloodCap(filteredPlan, riding, opts.allowFlood === true, warn);
  // The text becomes a media caption only when it's a ride candidate. Otherwise
  // it is sent as separate (possibly split) message(s) in the sandwich middle.
  const captionText = riding ? riding.text : undefined;
  const captionFormat = riding ? riding.format : 'plain';

  // Caption host SECTION: photos take priority over documents (matches the
  // pre-album behavior). The caption rides the first item of that section —
  // sendMediaSection puts it on the album's first item (or the lone item).
  const captionOnPhotos = riding && filteredPlan.photos.length > 0;
  const captionOnDocs = riding && filteredPlan.photos.length === 0 && filteredPlan.documents.length > 0;

  // 1. Photos (album when >=2, single send when 1).
  await sendMediaSection('photo', filteredPlan.photos, captionOnPhotos ? captionText : undefined, captionFormat, t);

  // 2. Text — only as separate message(s) when it did NOT ride as a caption.
  if (!riding) {
    for (const m of filteredPlan.textMessages) {
      await sendText(m.text, m.format, t);
    }
  }

  // 3. Documents (album when >=2, single send when 1).
  await sendMediaSection(
    'document',
    filteredPlan.documents,
    captionOnDocs ? captionText : undefined,
    captionFormat,
    t,
  );
}
