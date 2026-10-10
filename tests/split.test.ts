import { expect, test } from 'bun:test';
import { splitMessage } from '../features/auto-attach/split';

const LIMIT = 4096;

test('short text is returned as a single chunk', () => {
  expect(splitMessage('hello', LIMIT)).toEqual(['hello']);
});

test('empty text returns empty array', () => {
  expect(splitMessage('', LIMIT)).toEqual([]);
});

test('splits on paragraph/newline boundaries, each chunk <= limit', () => {
  const para = 'x'.repeat(500);
  const text = Array.from({ length: 20 }, () => para).join('\n\n'); // ~10k chars
  const chunks = splitMessage(text, LIMIT);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  // Rejoining the visible text content is preserved (no chars dropped).
  expect(chunks.join('\n\n').replace(/\n+/g, '')).toBe(text.replace(/\n+/g, ''));
});

test('a single oversize line with no newline is hard-split at the limit', () => {
  const text = 'a'.repeat(LIMIT * 2 + 50);
  const chunks = splitMessage(text, LIMIT);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  expect(chunks.join('')).toBe(text);
});

test('never splits mid-multibyte (emoji stay intact)', () => {
  // Each 🎉 is 2 UTF-16 code units; build a string longer than a small limit.
  const text = '🎉'.repeat(50);
  const chunks = splitMessage(text, 10);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(10);
    // No lone surrogate at either edge.
    expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(c)).toBe(false);
  }
  expect(chunks.join('')).toBe(text);
});

test('HTML: open tag spanning a boundary is closed and reopened per chunk', () => {
  const inner = 'y'.repeat(LIMIT);
  const text = `<b>${inner}</b>`;
  const chunks = splitMessage(text, LIMIT);
  expect(chunks.length).toBeGreaterThan(1);
  // Every chunk is balanced AND within the limit (closing/reopening tags must
  // not push a chunk over — regression for the budget-margin bug).
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(LIMIT);
    const opens = (c.match(/<b>/g) || []).length;
    const closes = (c.match(/<\/b>/g) || []).length;
    expect(opens).toBe(closes);
  }
});

test('HTML: a tag spanning 3+ chunks stays balanced in every chunk', () => {
  // Inner long enough to need at least 3 chunks at this limit.
  const inner = 'y'.repeat(LIMIT * 3);
  const text = `<b>${inner}</b>`;
  const chunks = splitMessage(text, LIMIT, 'html');
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(LIMIT);
    const opens = (c.match(/<b>/g) || []).length;
    const closes = (c.match(/<\/b>/g) || []).length;
    expect(opens).toBe(closes); // each middle chunk reopens AND closes <b>
    expect(opens).toBeGreaterThanOrEqual(1);
  }
});

test('plain mode does not treat <...> as tags (no balancing)', () => {
  const text = 'a<b>c'.repeat(2000); // > 4096, contains pseudo-tags
  const chunks = splitMessage(text, LIMIT, 'plain');
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  // No injected closing tags: rejoining yields the exact original.
  expect(chunks.join('')).toBe(text);
});

test('HTML: never splits inside a tag', () => {
  // A long run of text then a tag positioned so a naive cut lands mid-tag.
  const text = 'z'.repeat(LIMIT - 3) + '<code>abc</code>';
  const chunks = splitMessage(text, LIMIT);
  for (const c of chunks) {
    // No chunk ends in the middle of a tag (`<` without a closing `>`).
    const lastOpen = c.lastIndexOf('<');
    const lastClose = c.lastIndexOf('>');
    if (lastOpen !== -1) expect(lastClose).toBeGreaterThan(lastOpen);
  }
});

// Telegram's HTML parser refuses an `&` that does not start a complete entity, so a cut inside
// `&amp;` fails the whole send. Every cut offset 1..len-1 of the entity must be pulled back.
test('HTML: never cuts inside an entity, wherever the hard cut lands (named, decimal, hex)', () => {
  for (const entity of ['&amp;', '&quot;', '&#128512;', '&#x1F600;']) {
    for (let shift = 0; shift <= entity.length; shift++) {
      const text = 'z'.repeat(LIMIT - shift) + entity + 'z'.repeat(50);
      const chunks = splitMessage(text, LIMIT, 'html');
      expect(chunks.join('')).toBe(text);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(LIMIT);
        expect(c.replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, '')).not.toContain('&');
      }
    }
  }
});

test('plain mode leaves `&` literal: a cut right after it is not pulled back', () => {
  const text = 'z'.repeat(LIMIT - 2) + '&amp;' + 'z'.repeat(50);
  const chunks = splitMessage(text, LIMIT, 'plain');
  expect(chunks[0]).toHaveLength(LIMIT);
  expect(chunks.join('')).toBe(text);
});
