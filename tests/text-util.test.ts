import { expect, test } from 'bun:test';
import { hasUnpairedSurrogate, safeSliceEnd, truncateWithEllipsis } from '../features/tg-ctl/text-util';

// 😀 = U+1F600, encoded as the UTF-16 surrogate pair \uD83D\uDE00.
const EMOJI = '\ud83d\ude00';

test('safeSliceEnd: no truncation needed → end unchanged', () => {
  expect(safeSliceEnd('hello', 10)).toBe(5);
  expect(safeSliceEnd('hello', 5)).toBe(5);
});

test('safeSliceEnd: cut on an ordinary char boundary is unaffected', () => {
  expect(safeSliceEnd('hello world', 5)).toBe(5);
});

test('safeSliceEnd: cut that would split a surrogate pair backs up one unit', () => {
  const s = `ab${EMOJI}cd`; // a b [hi] [lo] c d — length 6
  // end=3 would keep 'a','b', and the lone HIGH surrogate at index 2, orphaning
  // the LOW surrogate at index 3. The pair must be dropped together instead.
  expect(safeSliceEnd(s, 3)).toBe(2);
  expect(s.slice(0, safeSliceEnd(s, 3))).toBe('ab');
});

test('safeSliceEnd: cut right after a complete pair keeps it intact', () => {
  const s = `ab${EMOJI}cd`;
  expect(safeSliceEnd(s, 4)).toBe(4);
  expect(s.slice(0, safeSliceEnd(s, 4))).toBe(`ab${EMOJI}`);
});

// Review finding (Sonnet, round 3): a single-step backup is not enough for a run of
// TWO OR MORE consecutive high surrogates — `JSON.parse` doesn't validate that `\uXXXX`
// escapes pair up, so a hook payload's `tool_input.plan`/`.command` can carry this
// shape verbatim. A single check backs up onto the SECOND high surrogate, which is
// itself still unpaired; the cut must back up over the WHOLE run.
test('safeSliceEnd: a run of consecutive high surrogates at the cut boundary backs up past all of them', () => {
  // a b [HI][HI][LO] c d — indices 2,3 are back-to-back high surrogates (malformed:
  // index 2 can never pair with anything), index 4 is the low surrogate that pairs
  // with index 3. Cutting at end=4 keeps indices 0-3 (both highs, no low) — a naive
  // single-step backup lands on index 2 (still an unpaired high); the fix must back
  // up past index 2 too.
  const s = 'ab\ud83d\ud83d\ude00cd';
  expect(safeSliceEnd(s, 4)).toBe(2);
  expect(s.slice(0, safeSliceEnd(s, 4))).toBe('ab');
});

test('safeSliceEnd: clamps out-of-range end values', () => {
  expect(safeSliceEnd('hi', -3)).toBe(0);
  expect(safeSliceEnd('hi', 99)).toBe(2);
});

// --- truncateWithEllipsis ---

test('truncateWithEllipsis: no truncation needed → returned verbatim, no ellipsis', () => {
  expect(truncateWithEllipsis('hello', 10)).toBe('hello');
  expect(truncateWithEllipsis('hello', 5)).toBe('hello'); // exactly at the limit
});

test('truncateWithEllipsis: ordinary cut reserves one unit for the ellipsis', () => {
  expect(truncateWithEllipsis('hello world', 5)).toBe('hell…'); // 4 kept + '…'
});

test('truncateWithEllipsis: an emoji landing on the reserved-unit boundary backs up whole', () => {
  // max=3 → cuts at max-1=2; EMOJI's high surrogate sits at index 2 of "ab😀cd".
  const s = `ab${EMOJI}cd`;
  expect(truncateWithEllipsis(s, 3)).toBe('ab…');
});

test('truncateWithEllipsis: an emoji that fits within the reserved budget is kept whole', () => {
  // max=5 → cuts at max-1=4, which lands right after the LOW surrogate (index 3)
  // — the pair is complete, so it survives.
  const s = `ab${EMOJI}cd`;
  expect(truncateWithEllipsis(s, 5)).toBe(`ab${EMOJI}…`);
});

test('truncateWithEllipsis: max<=1 degrades to a bare ellipsis, never a lone surrogate', () => {
  const s = `${EMOJI}xyz`;
  expect(truncateWithEllipsis(s, 1)).toBe('…');
  expect(truncateWithEllipsis(s, 0)).toBe('…');
  expect(hasUnpairedSurrogate(truncateWithEllipsis(s, 1))).toBe(false);
});

// --- hasUnpairedSurrogate ---

test('hasUnpairedSurrogate: truth table', () => {
  expect(hasUnpairedSurrogate('plain ascii')).toBe(false);
  expect(hasUnpairedSurrogate(`a${EMOJI}b`)).toBe(false); // one valid pair
  expect(hasUnpairedSurrogate(`${EMOJI}${EMOJI}`)).toBe(false); // two adjacent valid pairs
  expect(hasUnpairedSurrogate('a\ud83db')).toBe(true); // lone high surrogate
  expect(hasUnpairedSurrogate('a\ude00b')).toBe(true); // lone low surrogate
  expect(hasUnpairedSurrogate('\ud83d\ud83d\ude00')).toBe(true); // high-high-low: first high is orphaned
});

// GLM review finding F3: a single pinned offset per call site could pass even if
// `safeSliceEnd`'s off-by-one were wrong in a way that happens to clean up that one
// case (e.g. backing up 2 instead of 1, or checking the wrong index). Sweep a range
// of cut positions around and through the pair to pin the exact boundary, not just
// one lucky offset.
test('truncateWithEllipsis: offset sweep — never emits an unpaired surrogate at any cut through the pair', () => {
  const prefix = 'x'.repeat(50);
  const s = `${prefix}${EMOJI}${'y'.repeat(50)}`; // high surrogate at index 50, low at 51
  for (let max = 40; max <= 60; max++) {
    const out = truncateWithEllipsis(s, max);
    expect(hasUnpairedSurrogate(out)).toBe(false);
  }
});
