// Quotable content of a replied-to Telegram message, for the reply-quote anchor
// (`buildReplyAnchor` in updates.ts). PURE.
//
// tg-cli#461: the anchor used to read only `text ?? caption`. A report sent through
// sendRichMessage (every `tg --format html` body with a list/table/heading) has NO
// `text` — Bot API 10.1 delivers its content as `rich_message.blocks` — so replies to
// exactly the agents' longest reports reached the agent as an empty `«[date] …»`.

import type { TgMessage, TgRichBlock, TgRichText } from './types';

// Inline RichText → its visible characters, concatenated as written: a bold `Запрос:`
// followed by the plain ` «…»` reads `Запрос: «…»` — inline runs carry their own spacing.
// This walks raw Telegram JSON, so a null/non-object node reads as '' instead of throwing.
function inlineText(t: TgRichText | null | undefined): string {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(inlineText).join('');
  if (!t || typeof t !== 'object') return '';
  if (t.text != null) return inlineText(t.text);
  return t.alternative_text ?? t.expression ?? '';
}

// Block tree → text fragments in reading order. Blocks are separate fragments (the
// caller joins them with a space) so a heading never runs into the next paragraph.
function blockTexts(blocks: readonly (TgRichBlock | null)[] | null | undefined, out: string[]): void {
  for (const b of blocks ?? []) {
    if (!b || typeof b !== 'object') continue;
    out.push(inlineText(b.text), inlineText(b.summary), b.expression ?? '');
    blockTexts(b.blocks, out);
    for (const item of b.items ?? []) blockTexts(item?.blocks, out);
    for (const row of b.cells ?? []) for (const cell of row ?? []) out.push(inlineText(cell?.text));
    out.push(inlineText(b.caption));
  }
}

// The replied-to message's own text: `text`, else a media `caption`, else the flattened
// rich body. Whitespace-collapsed; '' when the message carries none.
export function messagePlainText(m: TgMessage): string {
  const parts: string[] = [];
  blockTexts(m.rich_message?.blocks, parts);
  return (m.text ?? m.caption ?? parts.filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
}

// A short `[kind …]` label for a message with no quotable text (a captionless photo, a
// long report shipped as a file), or '' for a kind we don't recognize. `animation` is
// tested before `document`: Telegram sets both on a GIF for backward compatibility.
export function mediaLabel(m: TgMessage): string {
  if (m.photo) return '[photo]';
  if (m.animation) return '[animation]';
  if (m.document) return m.document.file_name ? `[document ${m.document.file_name}]` : '[document]';
  if (m.video) return '[video]';
  if (m.video_note) return '[video note]';
  if (m.voice) return '[voice note]';
  if (m.audio) return '[audio]';
  if (m.sticker) return m.sticker.emoji ? `[sticker ${m.sticker.emoji}]` : '[sticker]';
  return '';
}
