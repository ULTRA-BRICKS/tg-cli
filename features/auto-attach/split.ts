// Generic HTML-safe message splitter (spec §Message splitting).
//
// Runs LAST in the transmitter and knows NOTHING about excerpts/attachments —
// it only takes a string + a limit and produces chunks each ≤ limit. Telegram
// measures length in UTF-16 code units, which is exactly JS String#length, so
// we work in that unit throughout.
//
// Guarantees:
//   - prefers splitting on paragraph/newline boundaries
//   - never splits inside an HTML tag (`<...>`)
//   - never splits mid-surrogate-pair (multibyte intact)
//   - balances HTML formatting: any tags left open at a cut are closed at the
//     end of the chunk and reopened at the start of the next, so every chunk is
//     standalone-valid HTML.

// Telegram's HTML subset that carries formatting across a boundary. Void-ish /
// non-nesting tags (<br>) aren't in TG's set; everything here is a paired tag.
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

interface OpenTag {
  name: string;
  full: string; // the exact opening tag text, e.g. `<code class="language-ts">`
}

// Track the open-tag stack as of a position in the text, scanning [0, end).
function openTagsAt(text: string, end: number): OpenTag[] {
  const stack: OpenTag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index >= end) break;
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    if (isClose) {
      // Pop the nearest matching open tag.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          stack.splice(i, 1);
          break;
        }
      }
    } else {
      stack.push({ name, full: m[0] });
    }
  }
  return stack;
}

// Is position `pos` inside an HTML tag (between a `<` and its `>`)? Used to
// avoid cutting mid-tag.
function insideTag(text: string, pos: number): boolean {
  const lastOpen = text.lastIndexOf('<', pos - 1);
  if (lastOpen === -1) return false;
  const close = text.indexOf('>', lastOpen);
  return close !== -1 && pos <= close;
}

// Pull a surrogate-pair / tag-boundary back so we never cut mid-multibyte or
// mid-tag. Returns an adjusted cut index in [start+1, hardCut]. Same invariant as
// `features/tg-ctl/text-util.ts`'s `safeSliceEnd` (also guards a Telegram-bound cut
// against orphaning a UTF-16 surrogate half), independently evolved here for this
// splitter's own tag-boundary concern — see that module's header for the shared
// "why" (tg#17245: an orphaned surrogate 400s the whole Bot API send).
function safeCut(text: string, start: number, hardCut: number): number {
  let cut = hardCut;
  // Don't sit on the low half of a surrogate pair.
  while (cut > start + 1 && /[\uDC00-\uDFFF]/.test(text[cut])) cut--;
  // Don't cut inside a tag — back up to before the tag's `<`.
  if (insideTag(text, cut)) {
    const lastOpen = text.lastIndexOf('<', cut - 1);
    if (lastOpen > start) cut = lastOpen;
  }
  return cut;
}

// When `format` is "plain", `<...>` are literal text, not tags: skip ALL tag
// logic so a plain message containing `a<b>c` isn't mangled into balanced HTML.
export function splitMessage(text: string, limit: number, format: 'plain' | 'html' = 'html'): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const htmlAware = format === 'html';

  const chunks: string[] = [];
  let rest = text;
  // carryOpen: tags open at the end of the previous chunk, reopened here.
  // Always empty in plain mode.
  let carryOpen: OpenTag[] = [];

  while (rest.length > 0) {
    const reopen = carryOpen.map((t) => t.full).join('');

    if (reopen.length + rest.length <= limit) {
      chunks.push(reopen + rest);
      break;
    }

    // Budget must leave room for BOTH reopened tags (prefix) AND closing tags
    // appended at the end. We don't know the closing length until we pick a
    // cut, so retry with a growing closing-margin until the chunk fits ≤ limit.
    let closingMargin = 0;
    let assembled = '';
    let stillOpen: OpenTag[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const budget = limit - reopen.length - closingMargin;
      if (budget <= 0) {
        // Pathological: reopened tags alone fill the limit. Hard-cut at 1 char.
        stillOpen = [];
        assembled = reopen + rest.slice(0, Math.max(1, safeCut(rest, 0, 1)));
        rest = rest.slice(Math.max(1, safeCut(rest, 0, 1)));
        break;
      }
      let cut = budget;
      const window = rest.slice(0, budget);
      const para = window.lastIndexOf('\n\n');
      const nl = window.lastIndexOf('\n');
      const sp = window.lastIndexOf(' ');
      if (para > budget * 0.3) cut = para + 2;
      else if (nl > budget * 0.3) cut = nl + 1;
      else if (sp > budget * 0.5) cut = sp + 1;
      else cut = budget; // hard split

      cut = safeCut(rest, 0, cut);
      if (cut <= 0) cut = Math.max(1, safeCut(rest, 0, budget));

      const piece = rest.slice(0, cut);
      // The open-tag stack must be computed over reopen+piece, NOT piece alone:
      // a tag carried in from the previous chunk (present in `reopen`) is still
      // open across this chunk and must be re-carried forward + closed here.
      // (Bug fix: computing from `piece` only dropped carried tags on 3+-chunk
      // spans, leaving an unclosed opener.)
      const assembledPiece = reopen + piece;
      stillOpen = htmlAware ? openTagsAt(assembledPiece, assembledPiece.length) : [];
      const closing = stillOpen
        .slice()
        .reverse()
        .map((t) => `</${t.name}>`)
        .join('');
      assembled = reopen + piece + closing;
      if (assembled.length <= limit || attempt === 7) {
        // Fits, or we've retried enough — accept and advance.
        if (assembled.length > limit) {
          // Last resort: drop the closing tags (piece itself is within budget).
          assembled = reopen + piece;
          stillOpen = [];
        }
        rest = rest.slice(cut);
        break;
      }
      // Over limit due to closing tags — reserve their length and retry.
      closingMargin = closing.length;
    }

    chunks.push(assembled);
    carryOpen = stillOpen;
  }

  return chunks;
}
