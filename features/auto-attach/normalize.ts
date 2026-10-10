// Pre-send normalization layer (spec §Architecture #2).
//
// Turns parsed items + a raw caption into an ordered SendPlan with the text
// rules applied:
//   - R2: a detected file's full content pasted verbatim → stripped from text.
//   - R3: small inline excerpt (≤1024) → left inline, not attached.
//   - R4: large free code block (>1024) → extracted as an in-memory fragment
//     document and removed from text.
//
// Pipeline (order matters — see comments): decode → extract(R4 then R2) →
// renderText(survivors) → assemble. Emoji rendering is injected via the
// `renderText` hook so this module stays free of tg-specific concerns and the
// emoji-entity offsets are computed on the POST-extraction text (otherwise a
// strip would invalidate every later offset).

import {
  detectLanguage,
  extractLargeCodeBlocks,
  inferFragmentName,
  stripDuplicatedFileContent,
  type FileContent,
} from './extract';
import type { Format, SendItem, SendPlan, TextMessage } from './types';

export interface ParsedItem {
  type: 'photo' | 'document';
  path: string;
}

export interface RenderedText {
  text: string;
  format: Format;
}

export interface BuildOptions {
  // Contents of attached DOCUMENT files (not photos) — for R2 dup detection.
  fileContents?: FileContent[];
  // Optional hook to render the surviving prose (e.g. tg's emoji → <tg-emoji>
  // HTML). Receives the post-extraction text; must return final text + format.
  // Defaults to identity (keeps the passed-in format).
  renderText?: (text: string, format: Format) => RenderedText;
}

export interface Extraction {
  text: string;
  fragments: SendItem[];
}

/**
 * Apply R4 (extract large code blocks) then R2 (strip duplicated file content)
 * to `text`. R4 runs FIRST and on the original text because its index spans are
 * fragile; R2 is line-based and resilient, so it runs on the R4 result.
 */
export function extractFromText(text: string, fileContents: FileContent[] = []): Extraction {
  const fragments: SendItem[] = [];

  // R4 — pull out >1024 fenced code blocks as in-memory fragment documents.
  const blocks = extractLargeCodeBlocks(text);
  let working = text;
  // Splice last-to-first so earlier removals don't invalidate later spans.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const ext = detectLanguage(b.lang, b.content);
    const preceding = working.slice(0, b.start);
    const base = inferFragmentName(preceding, ext);
    // Mark it clearly as a fragment per spec §R4 (in the filename).
    const filename = base.startsWith('fragment') ? base : `fragment-${base}`;
    fragments.unshift({
      type: 'document',
      source: { kind: 'memory', filename, content: b.content },
    });
    working = working.slice(0, b.start) + working.slice(b.end);
  }
  // Tidy the gap left where a block was removed.
  working = working.replace(/\n{3,}/g, '\n\n');

  // R2 — strip verbatim full-content pastes of the attached documents.
  if (fileContents.length) {
    working = stripDuplicatedFileContent(working, fileContents);
  }

  return { text: working.replace(/^\s+|\s+$/g, ''), fragments };
}

export function buildSendPlan(items: ParsedItem[], rawText: string, format: Format, opts: BuildOptions = {}): SendPlan {
  const { text: strippedText, fragments } = extractFromText(rawText, opts.fileContents ?? []);

  const rendered = opts.renderText ? opts.renderText(strippedText, format) : { text: strippedText, format };

  const photos: SendItem[] = [];
  const documents: SendItem[] = [];
  for (const it of items) {
    const sendItem: SendItem = { type: it.type, source: { kind: 'disk', path: it.path } };
    if (it.type === 'photo') photos.push(sendItem);
    else documents.push(sendItem);
  }
  // R4 fragments go at the end of the documents section.
  documents.push(...fragments);

  // No body, only the rendered header: it is there to caption the attachments (a send with no
  // attachment keeps it as its message — `tg --title …` alone).
  const headerOnly = strippedText === '' && photos.length + documents.length > 0;
  const textMessages: TextMessage[] = rendered.text
    ? [{ text: rendered.text, format: rendered.format, ...(headerOnly ? { headerOnly: true as const } : {}) }]
    : [];
  return { photos, textMessages, documents };
}
