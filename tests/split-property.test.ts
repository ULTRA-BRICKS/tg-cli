// Property tests for the generic message splitter (docs/specs/auto-attach.md §Message
// splitting, tg-cli#606): every chunk ≤ limit, no chunk cut inside a tag, an entity or a
// surrogate pair, every HTML chunk balanced on its own, and nothing lost or invented.
import { expect, test } from 'bun:test';
import { splitMessage } from '../features/auto-attach/split';
import { decodeHtmlEntities, escapeHtml, stripHtmlTags } from '../features/render/html';
import { hasUnpairedSurrogate } from '../features/tg-ctl/text-util';
import { ATOMS, anyText, arrayOf, forAll, type Gen, int, oneOf, pick, textOf } from './helpers/prop';

// Telegram's basic paired tags; a body is plain text escaped then wrapped in nested runs.
const TAGS = ['b', 'i', 'u', 's', 'code', 'tg-spoiler', 'blockquote'];
const OPENERS: Record<string, string> = { b: '<b>', i: '<i>', u: '<u>', s: '<s>', code: '<code class="language-ts">', 'tg-spoiler': '<tg-spoiler>', blockquote: '<blockquote expandable>' };

const htmlBody: Gen<string> = (rng) => {
  const piece = (depth: number): string => {
    const text = escapeHtml(anyText(0, 12)(rng));
    if (depth > 2 || rng() < 0.5) return text;
    const tag = pick(TAGS)(rng);
    const inner = arrayOf(() => piece(depth + 1), 1, 3)(rng).join('');
    return `${text}${OPENERS[tag]}${inner}</${tag}>`;
  };
  return arrayOf(() => piece(0), 1, 6)(rng).join('');
};

// Each `&` in a chunk must start a complete entity — a cut inside `&amp;` leaves `&am` at the
// end of one chunk, which Telegram's HTML parser rejects ("can't parse entities").
const BROKEN_ENTITY = /&(?!(?:[a-zA-Z]+|#[0-9]+|#[xX][0-9a-fA-F]+);)/;

// Every chunk must be standalone-valid: no close without its open, nothing left open.
function unbalanced(chunk: string): string | null {
  const stack: string[] = [];
  for (const m of chunk.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g)) {
    const name = m[2].toLowerCase();
    if (m[1] !== '/') stack.push(name);
    else if (stack.pop() !== name) return `stray </${name}>`;
  }
  return stack.length ? `left open: ${stack.join(',')}` : null;
}

test('plain: chunks concatenate back to the exact text, each ≤ limit, no surrogate pair cut', () => {
  forAll('split-plain', (rng) => ({ text: anyText(0, 120)(rng), limit: int(2, 60)(rng) }), ({ text, limit }) => {
    const chunks = splitMessage(text, limit, 'plain');
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit);
      expect(c.length).toBeGreaterThan(0);
      expect(hasUnpairedSurrogate(c)).toBe(false);
    }
  });
});

test('plain: a tag-looking run is literal text, never balanced or rewritten', () => {
  forAll('split-plain-tags', (rng) => ({ text: textOf(['<b>', '</i>', 'x', ' ', '<', '>', '\n'], 10, 80)(rng), limit: int(4, 30)(rng) }), ({ text, limit }) => {
    expect(splitMessage(text, limit, 'plain').join('')).toBe(text);
  });
});

test('html: every chunk ≤ limit, balanced, with no cut tag, entity or surrogate pair', () => {
  forAll('split-html', (rng) => ({ text: htmlBody(rng), limit: int(120, 300)(rng) }), ({ text, limit }) => {
    for (const c of splitMessage(text, limit, 'html')) {
      expect(c.length).toBeLessThanOrEqual(limit);
      expect(unbalanced(c)).toBeNull();
      expect(c).not.toMatch(BROKEN_ENTITY);
      expect(c).not.toMatch(/<[^>]*$/); // a tag cut before its `>`
      expect(hasUnpairedSurrogate(c)).toBe(false);
    }
  });
});

test('html: the visible text of the chunks, in order, is exactly the visible text of the body', () => {
  forAll('split-html-text', (rng) => ({ text: htmlBody(rng), limit: int(120, 300)(rng) }), ({ text, limit }) => {
    const visible = (s: string): string => decodeHtmlEntities(stripHtmlTags(s));
    expect(splitMessage(text, limit, 'html').map(visible).join('')).toBe(visible(text));
  });
});

test('html: an entity-dense body is never cut inside an entity when the limit can hold one', () => {
  const dense = oneOf(
    textOf(['&amp;', '&lt;', '&gt;', '&quot;', '&#39;', 'a', ' '], 20, 200),
    textOf([...ATOMS.html.filter((a) => a.startsWith('&') && a.length > 1), 'x'], 20, 200),
    // zero-padded numeric entities are valid HTML of any length; `&#X…;` is as valid as `&#x…;`
    textOf(['&#x0000000000000000000000000001F600;', '&#00000000000000000000000000000038;', '&#X1F680;', '&#X000000000000000000000000002603;', 'y'], 5, 40),
  );
  forAll('split-html-entities', (rng) => ({ text: dense(rng), limit: int(40, 80)(rng) }), ({ text, limit }) => {
    const chunks = splitMessage(text, limit, 'html');
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(c).not.toMatch(BROKEN_ENTITY);
  });
});

test('html: the length limit holds at every limit, even one smaller than an entity', () => {
  const text = textOf(['&#x1F600;', '&amp;', '<b>x</b>', 'a'], 5, 60);
  forAll('split-html-tiny-limit', (rng) => ({ text: text(rng), limit: int(1, 12)(rng) }), ({ text, limit }) => {
    for (const c of splitMessage(text, limit, 'html')) expect(c.length).toBeLessThanOrEqual(limit);
  });
});
