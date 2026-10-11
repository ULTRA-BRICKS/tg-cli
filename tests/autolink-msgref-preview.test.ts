// Inline quoted previews for `tg#<id>` message refs (tg-cli#116,
// docs/specs/autolink-msgrefs.md §Quoted previews).
import { expect, test } from 'bun:test';
import {
  MSGREF_EXCERPT_MAX,
  MSGREF_PREVIEW_CAP,
  MSGREF_PREVIEW_MAX,
  oneLineHead,
} from '../features/autolink-msgrefs/preview';
import {
  buildMsgRefEntries,
  linkifyMsgRefs,
  renderMsgRefPreview,
  resolveMsgRefs,
} from '../features/autolink-msgrefs/render';
import { applyAutolink, linkifyTicketsCompound } from '../features/autolink-tasks/render';
import type { TicketInfo } from '../features/autolink-tasks/linear';
import { detectRefs } from '../features/autolink-prs/detect';
import { linkifyRefsCompound } from '../features/autolink-prs/render';
import type { GhRef } from '../features/autolink-prs/resolve';
import { DEFAULT_FEATURES, parseFeatureConfig, resolveFeatures } from '../features/auto-attach/feature-flags';
import type { HistoryRecord } from '../features/replies/history';

const H = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1700000000,
  message_id: 5663,
  direction: 'user',
  from: 'Alex',
  text: 'short message',
  pane: '%1',
  ...over,
});

const noUrl = (): string | null => null;
const sgUrl = (id: number): string => `https://t.me/c/99/${id}`;

// The preview cut (MSGREF_PREVIEW_MAX); the excerpt shares the function at MSGREF_EXCERPT_MAX.
const preview = (text: string): string | null => oneLineHead(text, MSGREF_PREVIEW_MAX);

// --- oneLineHead ---

test('oneLineHead: short text is kept whole, no ellipsis', () => {
  expect(preview('please fix the login')).toBe('please fix the login');
});

test('oneLineHead: trims, then collapses every whitespace run (newlines too) to one space', () => {
  expect(preview('  first line\n\n  second\tline  ')).toBe('first line second line');
});

test('oneLineHead: whitespace-only or empty text yields no preview', () => {
  expect(preview('')).toBeNull();
  expect(preview(' \n\t ')).toBeNull();
});

test('oneLineHead: exactly MSGREF_PREVIEW_MAX clusters → no ellipsis; one more → ellipsis', () => {
  expect(MSGREF_PREVIEW_MAX).toBe(48);
  const exact = 'a'.repeat(48);
  expect(preview(exact)).toBe(exact);
  expect(preview(`${exact}b`)).toBe(`${exact}…`);
});

test('oneLineHead: a cut landing on a collapsed space drops that space before the ellipsis', () => {
  // 47 letters + space + more: the 48-cluster cut ends in the space.
  const text = `${'a'.repeat(47)} tail words`;
  expect(preview(text)).toBe(`${'a'.repeat(47)}…`);
});

test('oneLineHead: counts grapheme clusters — a ZWJ family or a flag is never cut in half', () => {
  const family = '👨‍👩‍👧‍👦';
  const flag = '🇺🇦';
  expect(preview(family.repeat(49))).toBe(`${family.repeat(48)}…`);
  expect(preview(flag.repeat(60))).toBe(`${flag.repeat(48)}…`);
});

test('oneLineHead: never leaves a lone surrogate half', () => {
  const out = preview(`${'x'.repeat(47)}😀😀😀`) ?? '';
  expect(out).toBe(`${'x'.repeat(47)}😀…`);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
});

test('oneLineHead: media placeholders are quoted like any text', () => {
  expect(preview('[photo]')).toBe('[photo]');
});

// --- renderMsgRefPreview ---

test('renderMsgRefPreview: DM → plain quote + styled retained marker, no link', () => {
  expect(renderMsgRefPreview('tg#5663', 'Запланируй ссылки', null)).toBe('«Запланируй ссылки» (𝒕𝒈#5663)');
});

test('renderMsgRefPreview: supergroup → the quote is the link, the marker stays plain beside it', () => {
  expect(renderMsgRefPreview('tg#5663', 'plan it', 'https://t.me/c/99/5663')).toBe(
    '<a href="https://t.me/c/99/5663">«plan it»</a> (tg#5663)',
  );
});

test('renderMsgRefPreview: the marker keeps the token as written', () => {
  expect(renderMsgRefPreview('𝒕𝒈#5663', 'x', null)).toBe('«x» (𝒕𝒈#5663)');
  expect(renderMsgRefPreview('TG#5663', 'x', 'https://t.me/c/99/5663')).toBe(
    '<a href="https://t.me/c/99/5663">«x»</a> (TG#5663)',
  );
});

test('renderMsgRefPreview: hostile stored text and url are escaped', () => {
  expect(renderMsgRefPreview('tg#1', '<b>x</b> & "y"', null)).toBe('«&lt;b&gt;x&lt;/b&gt; &amp; "y"» (𝒕𝒈#1)');
  expect(renderMsgRefPreview('tg#1', 'x', 'https://t.me/c/1/1?a="b"&c')).toBe(
    '<a href="https://t.me/c/1/1?a=&quot;b&quot;&amp;c">«x»</a> (tg#1)',
  );
});

// --- resolveMsgRefs: lookup, cap, scoping, preview vs bottom excerpt ---

const previewsOf = (history: HistoryRecord[], ids: number[], chatId?: number): Map<number, string> =>
  resolveMsgRefs(history, ids, noUrl, chatId, true).previews;

test('resolveMsgRefs: ids with a history hit get a preview, missing ids none', () => {
  expect([...previewsOf([H({ message_id: 10, text: 'ten' })], [10, 11])]).toEqual([[10, 'ten']]);
});

test('resolveMsgRefs: message_id null rows and empty texts never match', () => {
  expect(previewsOf([H({ message_id: null, text: 'x' }), H({ message_id: 12, text: '  ' })], [12]).size).toBe(0);
});

test('resolveMsgRefs: another chat never matches; exact chat beats legacy; first-written wins', () => {
  const previews = previewsOf(
    [
      H({ message_id: 1, chat_id: 2, text: 'other chat' }),
      H({ message_id: 2, text: 'legacy' }),
      H({ message_id: 2, chat_id: 1, text: 'exact' }),
      H({ message_id: 3, chat_id: 1, text: 'first seen' }),
      H({ message_id: 3, chat_id: 1, text: 'later duplicate' }),
    ],
    [1, 2, 3],
    1,
  );
  expect([...previews]).toEqual([
    [2, 'exact'],
    [3, 'first seen'],
  ]);
});

test('resolveMsgRefs: at most MSGREF_PREVIEW_CAP previews; ids past the cap keep their bottom excerpt', () => {
  expect(MSGREF_PREVIEW_CAP).toBe(8);
  const history = Array.from({ length: 12 }, (_, i) => H({ message_id: i + 1, text: `m${i + 1}` }));
  // 100 is missing: it takes no slot and gets no entry. 12 is mentioned twice.
  const ids = [12, 100, 11, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const { previews, entries } = resolveMsgRefs(history, ids, noUrl, undefined, true);
  expect([...previews.keys()]).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
  expect(entries.map((e) => e.title)).toEqual(['Alex: m4', 'Alex: m3', 'Alex: m2', 'Alex: m1']);
});

test('resolveMsgRefs: previews off → no previews, every found id keeps its bottom excerpt', () => {
  const history = [H({ message_id: 1, text: 'one' }), H({ message_id: 2, text: 'two' })];
  const { previews, entries } = resolveMsgRefs(history, [2, 3, 1], noUrl, undefined, false);
  expect(previews.size).toBe(0);
  expect(entries).toEqual(buildMsgRefEntries(history, [2, 3, 1], noUrl));
  expect(entries.map((e) => e.title)).toEqual(['Alex: two', 'Alex: one']);
});

test('oneLineHead: max below 1 is a caller bug, not a bare «…»', () => {
  expect(() => oneLineHead('hello', 0)).toThrow(RangeError);
});

test('buildMsgRefEntries: the bottom excerpt never cuts a ZWJ family in half either', () => {
  const family = '👨‍👩‍👧‍👦';
  const entries = buildMsgRefEntries([H({ message_id: 8, text: family.repeat(200) })], [8], noUrl);
  expect(entries[0].title).toBe(`Alex: ${family.repeat(MSGREF_EXCERPT_MAX)}…`);
});

test('buildMsgRefEntries: two rows with one id and one rank → the first-written one', () => {
  const entries = buildMsgRefEntries(
    [H({ message_id: 7, chat_id: 1, text: 'first seen' }), H({ message_id: 7, chat_id: 1, text: 'later' })],
    [7],
    noUrl,
    1,
  );
  expect(entries[0].title).toBe('Alex: first seen');
});

// --- linkifyMsgRefs with previews ---

test('linkify+preview: DM ref becomes «quote» (𝒕𝒈#id)', () => {
  const out = linkifyMsgRefs('answered tg#5663.', noUrl, new Map([[5663, 'Запланируй']]));
  expect(out).toBe('answered «Запланируй» (𝒕𝒈#5663).');
});

test('linkify+preview: supergroup ref becomes a linked quote + plain marker', () => {
  const out = linkifyMsgRefs('see tg#5663', sgUrl, new Map([[5663, 'plan it']]));
  expect(out).toBe('see <a href="https://t.me/c/99/5663">«plan it»</a> (tg#5663)');
});

test('linkify+preview: only the first occurrence of an id is quoted, repeats keep the marker', () => {
  const out = linkifyMsgRefs('tg#5 and again tg#5', noUrl, new Map([[5, 'five']]));
  expect(out).toBe('«five» (𝒕𝒈#5) and again 𝒕𝒈#5');
});

test('linkify+preview: ids without a preview render byte-identical to the no-preview path', () => {
  const html = 'tg#1 tg#2 <code>tg#3</code>';
  expect(linkifyMsgRefs(html, noUrl)).toBe('𝒕𝒈#1 𝒕𝒈#2 <code>tg#3</code>');
  expect(linkifyMsgRefs(html, noUrl, new Map())).toBe('𝒕𝒈#1 𝒕𝒈#2 <code>tg#3</code>');
  expect(linkifyMsgRefs(html, noUrl, new Map([[1, 'one']]))).toBe('«one» (𝒕𝒈#1) 𝒕𝒈#2 <code>tg#3</code>');
});

test('linkify+preview: never inside <a>/<pre>/<code> or a URL token', () => {
  const html = '<a href="https://e">tg#5</a> <pre>tg#5</pre> <code>tg#5</code> https://h/tg#5';
  expect(linkifyMsgRefs(html, noUrl, new Map([[5, 'five']]))).toBe(html);
});

// --- applyAutolink linkifyLast: ordering + no rescan ---

test('applyAutolink linkifyLast: runs after ticket/#N passes, its inserted quote is never rescanned', () => {
  const refs = new Map<number, GhRef>([
    [42, { number: 42, title: 'PR', url: 'https://gh/pull/42', kind: 'pr', state: 'OPEN', isDraft: false }],
  ]);
  const tickets: TicketInfo[] = [{ code: 'HYP-100', title: 'Ticket', url: 'https://linear/HYP-100' }];
  const previews = new Map([[5663, '#42 HYP-100 tg#999']]);
  const out = applyAutolink('re tg#5663 and #42 HYP-100', tickets, false, {
    linkifyTickets: (h) => linkifyTicketsCompound(h, new Map(tickets.map((t) => [t.code, t]))),
    linkify: (h) => linkifyRefsCompound(h, refs),
    linkifyLast: (h) => linkifyMsgRefs(h, noUrl, previews),
  });
  const firstLine = out.split('\n').find((l) => l.includes('«')) ?? '';
  expect(firstLine).toContain('«#42 HYP-100 tg#999» (𝒕𝒈#5663)');
  // The body's own #42 and HYP-100 are linked exactly once each — nothing inside the quote.
  expect(out.match(/href="https:\/\/gh\/pull\/42"/g)?.length).toBe(1);
  expect(out.match(/href="https:\/\/linear\/HYP-100"/g)?.length).toBe(1);
});

test('applyAutolink linkifyLast: runs even with no tickets/issues/prs, and not over the blocks', () => {
  expect(applyAutolink('see tg#5', [], false, { linkifyLast: (h) => linkifyMsgRefs(h, noUrl) })).toBe('see 𝒕𝒈#5');
  const entries = buildMsgRefEntries([H({ message_id: 6, text: 'six' })], [6], noUrl);
  const out = applyAutolink('tg#5 tg#6', [], false, {
    issues: entries,
    linkifyLast: (h) => linkifyMsgRefs(h, noUrl, new Map([[5, 'five']])),
  });
  expect(out).toBe('«five» (𝒕𝒈#5) 𝒕𝒈#6\n<blockquote expandable>𝒕𝒈#6 — Alex: six</blockquote>');
});

// --- boundary disjointness: the gate for running the msgref pass LAST ---

test('ticket and #N linkifiers leave a raw or styled tg#<id> untouched even when the number resolves', () => {
  const refs = new Map<number, GhRef>([
    [3715, { number: 3715, title: 'PR', url: 'https://gh/pull/3715', kind: 'pr', state: 'OPEN', isDraft: false }],
  ]);
  // The styled form is what users copy back from a DM; its 𝒈 is outside ASCII.
  const body = 'reply tg#3715, tg#3715-3716, 𝒕𝒈#3715 TG#3715';
  expect(detectRefs(body)).toEqual([]);
  expect(linkifyRefsCompound(body, refs)).toBe(body);
  // Positive control: the same number without the prefix does link.
  expect(linkifyRefsCompound(`${body} #3715`, refs)).toBe(`${body} <a href="https://gh/pull/3715">#3715</a>`);
  // Ticket codes have another shape (`ABC-123`); the control code links, the refs do not.
  const tickets = new Map<string, TicketInfo>([['TGX-1', { code: 'TGX-1', title: 't', url: 'https://l/TGX-1' }]]);
  expect(linkifyTicketsCompound('tg#1 TGX-1 tg#3715 𝒕𝒈#1', tickets)).toBe(
    'tg#1 <a href="https://l/TGX-1">TGX-1</a> tg#3715 𝒕𝒈#1',
  );
});

// --- feature flag ---

test('autolink-msgref-preview is ON by default and opts out like its siblings', () => {
  expect(DEFAULT_FEATURES['autolink-msgref-preview']).toBe(true);
  expect(resolveFeatures({}, { enable: [], disable: ['autolink-msgref-preview'] })['autolink-msgref-preview']).toBe(false);
  const fromConfig = parseFeatureConfig('features:\n  autolink-msgref-preview: false\n');
  expect(resolveFeatures(fromConfig, { enable: [], disable: [] })['autolink-msgref-preview']).toBe(false);
});
