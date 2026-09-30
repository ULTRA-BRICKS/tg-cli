import { expect, test } from 'bun:test';
import { buildReplyAnchor, buildReplyInject, stepUpdates, type StepOpts } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type TgMessage, type TgUpdate } from '../features/tg-ctl/types';
import { hasUnpairedSurrogate } from '../features/tg-ctl/text-util';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const REPLIED_AT = 1_700_000_000;

const opts: StepOpts = {
  cfg: { ...DEFAULT_CONTROL },
  chatId: CHAT_ID,
  nowSec: NOW,
  currentOffset: 0,
  wrap: (name, msg) => `[TG from ${name}] ${msg} — reply via tg`,
  fmtTime: () => '2026-06-12 14:30',
};

// A realistic (non-zero) id — tg-cli#28 renders it as `tg#<id>` in the anchor
// (distinct from a zero/falsy id, which must NOT collapse the token away).
const REPLIED_TO_ID = 42;

const replied = (text: string, id: number = REPLIED_TO_ID): TgMessage => ({
  message_id: id,
  chat: { id: CHAT_ID },
  date: REPLIED_AT,
  text,
});

const reply = (text: string, rtmText: string, quote?: string, rtmId?: number): TgMessage => ({
  message_id: 9,
  from: { id: CHAT_ID, first_name: 'Alex' },
  chat: { id: CHAT_ID },
  date: NOW,
  text,
  reply_to_message: replied(rtmText, rtmId),
  ...(quote ? { quote: { text: quote } } : {}),
});

// --- buildReplyInject ---

test('partial quote is forwarded as the quote anchor (item 2)', () => {
  const out = buildReplyInject(reply('fix the bug', 'Deployed auth and migrated the DB', 'migrated the DB'), 'Alex', opts);
  expect(out).toBe('↩ tg#42 «[2026-06-12 14:30] migrated the DB…»\n[TG from Alex] fix the bug — reply via tg');
});

test('no partial quote → beginning of the replied-to message (item 3)', () => {
  const out = buildReplyInject(reply('do it', 'Short original message', undefined), 'Alex', opts);
  expect(out).toBe('↩ tg#42 «[2026-06-12 14:30] Short original message…»\n[TG from Alex] do it — reply via tg');
});

test('long original is truncated to the head + ellipsis', () => {
  const long = 'x'.repeat(120);
  const out = buildReplyInject(reply('y', long, undefined), 'Alex', opts);
  const anchor = out.split('\n')[0];
  expect(anchor).toBe(`↩ tg#42 «[2026-06-12 14:30] ${'x'.repeat(60)}…»`);
});

// tg#17245 (live incident): the quoted head is cut at a fixed UTF-16 code-unit
// count. A naive slice can land between the two halves of a surrogate pair (an
// emoji), producing an orphaned lone surrogate. JSON.stringify escapes that as
// `\uD83D` (still valid JSON on the wire), but Telegram's Bot API rejects the
// decoded string server-side with a flat 400 "strings must be encoded in
// UTF-8" — the whole sendMessage call fails. The cut must back up to keep the
// pair whole (dropped together), never split.
test('a quote head that would split an emoji surrogate pair drops the pair whole, not orphaned', () => {
  // 😀 (\uD83D\uDE00) sits exactly on the QUOTE_HEAD_MAX=60 cut boundary: chars
  // 0-58 fill positions 0..58, so the high surrogate lands at index 59 — a
  // naive `.slice(0, 60)` would keep it and drop its low-surrogate partner.
  const long = `${'x'.repeat(59)}\ud83d\ude00${'y'.repeat(10)}`;
  const out = buildReplyInject(reply('y', long, undefined), 'Alex', opts);
  const anchor = out.split('\n')[0];
  expect(anchor).toBe(`↩ tg#42 «[2026-06-12 14:30] ${'x'.repeat(59)}…»`);
  // No lone surrogate anywhere in the anchor — the property Telegram enforces.
  expect(hasUnpairedSurrogate(anchor)).toBe(false);
});

test('multiline original/quote is collapsed to one anchor line', () => {
  const out = buildReplyInject(reply('ok', 'line one\nline two', 'line\none'), 'Alex', opts);
  expect(out.split('\n')[0]).toBe('↩ tg#42 «[2026-06-12 14:30] line one…»');
});

test('default UTC formatter is deterministic when fmtTime is omitted', () => {
  const o: StepOpts = { ...opts, fmtTime: undefined };
  const out = buildReplyInject(reply('a', 'b', undefined), 'Alex', o);
  expect(out.split('\n')[0]).toMatch(/^↩ tg#42 «\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] b…»$/);
});

test('the original id in the anchor is the replied-to message id, not the reply\'s own id', () => {
  const out = buildReplyInject(reply('follow up', 'earlier report', undefined, 5975), 'Alex', opts);
  // 9 is the reply's own message_id (opts.wrap ignores it here — the fake
  // wrap fn takes no id param); 5975 is the ORIGINAL id, and only it must
  // appear in the anchor.
  expect(out.split('\n')[0]).toBe('↩ tg#5975 «[2026-06-12 14:30] earlier report…»');
  expect(out).not.toContain('tg#9 ');
});

test('a falsy (zero) original id still renders — no silent collapse', () => {
  const out = buildReplyInject(reply('ok', 'zero-id original', undefined, 0), 'Alex', opts);
  expect(out.split('\n')[0]).toBe('↩ tg#0 «[2026-06-12 14:30] zero-id original…»');
});

// --- tg-cli#461: a replied-to message with no `text`/`caption` ---
//
// Every empty `↩ tg#N «[date] …»` seen live (30 ids, 2026-09-18..09-25) was a reply to an
// agent report sent via sendRichMessage: such a Message carries its content in
// `rich_message.blocks`, never in `text`, so the old `text ?? caption` read produced an
// empty quote. A media message without a caption (a long report shipped as a file, a
// photo) is the other no-text shape. The anchor must carry real quoted content or drop
// the «…» quote entirely — never an empty «[date] …».

const EMPTY_QUOTE = /«\[[^\]]*\] …»/;

const replyTo = (rtm: Omit<TgMessage, 'message_id' | 'chat' | 'date'>, quote?: string): TgMessage => ({
  message_id: 9,
  from: { id: CHAT_ID, first_name: 'Alex' },
  chat: { id: CHAT_ID },
  date: NOW,
  text: 'ответ',
  reply_to_message: { message_id: REPLIED_TO_ID, chat: { id: CHAT_ID }, date: REPLIED_AT, ...rtm },
  ...(quote ? { quote: { text: quote } } : {}),
});

// The shape Telegram returns for the tg#17821 report (`<b>Запрос:</b> «…»` + `<ul>`),
// long enough that only its head fits the anchor.
const longRichReport = {
  blocks: [
    { type: 'paragraph', text: [{ type: 'bold', text: 'Запрос:' }, ' «сравни review-cli с revmux от umputun тщательно и детально»'] },
    {
      type: 'list',
      items: [
        { label: '•', blocks: [{ type: 'paragraph', text: [{ type: 'code', text: 'docs/compare-revmux.md' }, ' — детальное сравнение'] }] },
        { label: '•', blocks: [{ type: 'paragraph', text: 'README.md — добавлена ссылка' }] },
      ],
    },
  ],
};

test('#461: reply to a long rich message quotes its flattened text head', () => {
  const anchor = buildReplyAnchor(replyTo({ rich_message: longRichReport }), opts);
  expect(anchor).toBe('↩ tg#42 «[2026-06-12 14:30] Запрос: «сравни review-cli с revmux от umputun тщательно и д…»');
  expect(anchor).not.toMatch(EMPTY_QUOTE);
});

test('#461: rich blocks are space-separated and nested containers are walked in reading order', () => {
  const rich = {
    blocks: [
      { type: 'heading', size: 3, text: 'Итог' },
      { type: 'divider' },
      { type: 'details', summary: 'PR', blocks: [{ type: 'paragraph', text: '#785' }] },
      { type: 'table', cells: [[{ text: 'a' }, {}], [{ text: [{ type: 'custom_emoji', custom_emoji_id: '1', alternative_text: '✅' }] }]] },
      { type: 'mathematical_expression', expression: 'x^2' },
      { type: 'photo', photo: [], caption: { text: 'скрин' } },
    ],
  };
  expect(buildReplyAnchor(replyTo({ rich_message: rich }), opts)).toBe('↩ tg#42 «[2026-06-12 14:30] Итог PR #785 a ✅ x^2 скрин…»');
});

test('#461: a partial-quote selection still wins over the rich body', () => {
  const anchor = buildReplyAnchor(replyTo({ rich_message: longRichReport }, 'детальное сравнение'), opts);
  expect(anchor).toBe('↩ tg#42 «[2026-06-12 14:30] детальное сравнение…»');
});

test('#461: reply to a captionless photo quotes a media label, not an empty preview', () => {
  const anchor = buildReplyAnchor(replyTo({ photo: [{ file_id: 'p1' }] }), opts);
  expect(anchor).toBe('↩ tg#42 «[2026-06-12 14:30] [photo]»');
});

test('#461: reply to a captionless document (a long report shipped as a file) names the file', () => {
  const anchor = buildReplyAnchor(replyTo({ document: { file_id: 'd1', file_name: 'report.pdf' } }), opts);
  expect(anchor).toBe('↩ tg#42 «[2026-06-12 14:30] [document report.pdf]»');
});

test('#461: a captioned media message still quotes its caption', () => {
  const anchor = buildReplyAnchor(replyTo({ photo: [{ file_id: 'p1' }], caption: 'the chart' }), opts);
  expect(anchor).toBe('↩ tg#42 «[2026-06-12 14:30] the chart…»');
});

test('#461: a GIF (Telegram sets both animation and document) is labelled an animation', () => {
  const gif = { animation: { file_id: 'g1', file_name: 'x.gif.mp4' }, document: { file_id: 'g1', file_name: 'x.gif.mp4' } };
  expect(buildReplyAnchor(replyTo(gif), opts)).toBe('↩ tg#42 «[2026-06-12 14:30] [animation]»');
});

test('#461: null nodes in raw rich JSON are skipped, never thrown on', () => {
  const raw = JSON.parse(
    '{"blocks":[null,{"type":"paragraph","text":[null,"ok",{"type":"bold","text":null}]},{"type":"list","items":[null,{"blocks":null}]},{"type":"table","cells":[null,[null,{"text":"cell"}]]}]}',
  );
  expect(buildReplyAnchor(replyTo({ rich_message: raw }), opts)).toBe('↩ tg#42 «[2026-06-12 14:30] ok cell…»');
});

test('#461: every media kind gets its label', () => {
  const cases: Array<[Omit<TgMessage, 'message_id' | 'chat' | 'date'>, string]> = [
    [{ video: { file_id: 'v' } }, '[video]'],
    [{ video_note: { file_id: 'n' } }, '[video note]'],
    [{ voice: { file_id: 'o' } }, '[voice note]'],
    [{ audio: { file_id: 'a' } }, '[audio]'],
    [{ sticker: { file_id: 's', emoji: '👍' } }, '[sticker 👍]'],
    [{ document: { file_id: 'd' } }, '[document]'],
  ];
  for (const [rtm, label] of cases) expect(buildReplyAnchor(replyTo(rtm), opts)).toBe(`↩ tg#42 «[2026-06-12 14:30] ${label}»`);
});

test('#461: nothing quotable → the «…» preview is omitted, the tg#id stays for recall', () => {
  const anchor = buildReplyAnchor(replyTo({}), opts);
  expect(anchor).toBe('↩ tg#42');
  // A whitespace-only / empty rich body is "nothing quotable" too.
  expect(buildReplyAnchor(replyTo({ text: '  \n ' }), opts)).toBe('↩ tg#42');
  expect(buildReplyAnchor(replyTo({ rich_message: { blocks: [{ type: 'divider' }] } }), opts)).toBe('↩ tg#42');
});

test('#461: the reply-route inject for a rich-message reply carries the quote end-to-end', () => {
  const r = stepUpdates([{ update_id: 5, message: replyTo({ rich_message: longRichReport }) }], opts);
  const route = r.actions[0] as Extract<(typeof r.actions)[number], { kind: 'reply-route' }>;
  expect(route.kind).toBe('reply-route');
  expect(route.injectText.split('\n')[0]).toStartWith('↩ tg#42 «[2026-06-12 14:30] Запрос: «сравни');
  expect(route.injectText).not.toMatch(EMPTY_QUOTE);
});

// --- stepUpdates integration ---

function upd(id: number, m: TgMessage): TgUpdate {
  return { update_id: id, message: m };
}

test('reply with prose → reply-route with the quote anchor (carrying the original tg#id) + ack', () => {
  const r = stepUpdates([upd(1, reply('please fix', 'Original report text', 'report text', 5975))], opts);
  expect(r.actions[0]).toEqual({
    kind: 'reply-route',
    replyToMessageId: 5975,
    injectText: '↩ tg#5975 «[2026-06-12 14:30] report text…»\n[TG from Alex] please fix — reply via tg',
    from: 'Alex',
    messageId: 9,
  });
  expect(r.actions[1]).toEqual({ kind: 'ack', messageId: 9 });
});

test('reply whose text is a /command runs the command, not a quote forward', () => {
  const m = reply('/stop', 'Original', undefined);
  const r = stepUpdates([upd(2, m)], opts);
  expect(r.actions[0]).toEqual({ kind: 'inject-key', key: 'Escape' });
});

test('a plain (non-reply) message has no anchor at all — format is unaffected', () => {
  const m: TgMessage = {
    message_id: 11,
    from: { id: CHAT_ID, first_name: 'Alex' },
    chat: { id: CHAT_ID },
    date: NOW,
    text: 'no reply here',
  };
  const r = stepUpdates([upd(3, m)], opts);
  const injected = r.actions.find((a) => a.kind === 'inject-text') as Extract<(typeof r.actions)[number], { kind: 'inject-text' }>;
  expect(injected.text).not.toContain('↩');
  expect(injected.text).toBe('[TG from Alex] no reply here — reply via tg');
});
