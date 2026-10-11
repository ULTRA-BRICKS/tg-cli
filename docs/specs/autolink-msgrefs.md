# tg-cli — autolink-msgrefs feature spec

Repo: `~/.files/repos/tg-cli`. Feature lives in `features/autolink-msgrefs/`, tests in
`tests/autolink-msgrefs.test.ts`. Sibling of `autolink-prs` (docs/specs/autolink-prs.md)
in shape, but for inbound **Telegram message** references — `tg#<id>` — not GitHub `#N`.

## North star

The inbound inject wrap renders an inbound message's id as `tg#<id>`
(`[TG from Alex tg#1234] …`, see `features/tg-ctl/inject.ts`). When an agent quotes that
id back in an outbound message ("answered tg#1234", "see tg#1234"), it means *the Telegram
message with id 1234* — NOT a GitHub issue/PR `#1234`.

The `tg#` prefix is the whole disambiguation. A bare `#1234` belongs to `autolink-prs`
(resolved against the cwd GitHub repo). Without the prefix the two namespaces collide:
`#3715` quoted from a phone would be probed against `gh` and mis-linked as PR/issue #3715.
The convention fixes that at the source — ids are *written* as `tg#<id>`, and this feature
links them.

ON by default, toggled like any feature: `--no-feature autolink-msgrefs` or
`features: { autolink-msgrefs: false }` in `~/.config/tg-cli/config.yaml`.

## Detection (`detect.ts`)

- A reference is `tg#` (case-insensitive on `tg`) immediately followed by a positive id:
  `tg#[1-9][0-9]*`. `tg#0` is not a thing — the leading digit must be `1-9`.
- The already-rendered bold-italic form `𝒕𝒈#<id>` / `𝑻𝑮#<id>` is also accepted. This
  matters in private DMs, where message refs render as styled-but-unlinked text and users
  often copy that visible token back verbatim.
- Boundaries: the char before `tg` and the char after the number must not be alphanumeric.
  `xtg#1`, `tg#1a` are NOT references; `(tg#10)`, `tg#10,`, `tg#10.` are.
- Whitespace tokens containing `://` are skipped (a pasted URL with `tg#` in its path is not
  a plain-text mention — same guard as autolink-prs).
- `detectMsgRefs(text)` → unique ids in first-appearance order.

## Linking (`render.ts`)

- `msgRefUrl(chatId, id)` builds a `t.me` deep link **only for a supergroup/channel** chat
  (`-100<rest>` → `https://t.me/c/<rest>/<id>`). A private bot DM (a positive chat id) or a
  basic group has NO public per-message URL → `null`.
- `linkifyMsgRefs(html, urlFor)` rewrites each `tg#<id>` in an already-rendered HTML body:
  - url present → `<a href="t.me/c/…">tg#<id></a>`;
  - url null → a marked-but-unlinked **bold-italic** styled reference (so it still reads as
    a deliberate reference, not stray text). The dominant case — the user's private DM — is
    the null case.
- Same tag-safe walk as the sibling features: never rewrites inside `<a>…</a>` (Telegram
  rejects nested links), `<pre>`/`<code>`, or a token containing `://`.
- When a mentioned message id exists in the local `tg replies` history and did NOT get an
  inline quoted preview (below: preview flag off, past the preview cap), it gets a bottom
  `<blockquote expandable>` entry (`resolveMsgRefs` decides preview vs entry in one pass over
  the history; `buildMsgRefEntries` builds entries alone). The label is the same link/styled
  `tg#<id>` marker; the title is `from: head`, where `head` is a one-line collapsed excerpt
  cut to 120 grapheme clusters with `…` (`oneLineHead` in `preview.ts`, the same cut as the
  inline preview). The outbound message never quotes the whole referenced Telegram message.
- Excerpt entries are keyed from the same tag-safe walk as linkification, not from raw text:
  `tg#<id>` inside `<a>`, `<pre>`, `<code>`, or a URL token does not link and does not add an
  excerpt block.
- New history rows carry `chat_id`, and excerpt lookup filters by the current chat so the same
  bot used in two chats cannot show another chat's message text for a colliding `message_id`.
  Legacy rows without `chat_id` remain eligible for backward compatibility.
- Missing/corrupt history is best-effort: link/styled body refs still render, but the excerpt
  block entry and the inline preview are skipped.

## Quoted previews (`autolink-msgref-preview`, tg-cli#116)

The CTO's ask (tg#5663): «ссылки на сообщения размечались гиперссылками и tg#xxxx
заменялись на «начало сообщения с …»». A report that says "answered tg#5663" is opaque on a
phone; in a private DM the styled marker is not even tappable. So a referenced message that
is in the local history is quoted INLINE, where the reference stands:

- **private DM / basic group** (no per-message URL): `«<preview>» (𝒕𝒈#5663)` — the quote is
  plain text, the retained id marker keeps today's styled form.
- **supergroup / channel**: `<a href="https://t.me/c/<rest>/5663">«<preview>»</a> (tg#5663)` —
  the quote itself is the link; the marker stays plain beside it.
- There is deliberately NO link in a DM: `tg://openmessage` is handled only by Telegram
  Android and points at the chat, not the message (Desktop/macOS/iOS have no handler — see the
  evidence on tg-cli#116). "Hyperlinked where possible" means `t.me/c` only.
- The marker keeps the token as written (`TG#5663` stays `TG#5663`, an already-styled
  `𝒕𝒈#5663` stays styled). It is the stable handle replies, `tg replies` and the detector
  round-trip on; dropping it would make the preview a dead end.
- No sender name inline: the quote sits mid-sentence ("answered «…» (𝒕𝒈#5663)"), and the
  sender is one `tg replies` lookup away. The bottom excerpt entry (with sender) still exists
  for refs that get no inline preview.

Preview text (`oneLineHead` in `features/autolink-msgrefs/preview.ts`, pure):

- The stored history text is trimmed, then every whitespace run (newlines included) collapses
  to one space. Empty after that → no preview (today's rendering, never an empty `«»`).
- At most `MSGREF_PREVIEW_MAX` = 48 **grapheme clusters** (`Intl.Segmenter`): a ZWJ emoji or
  flag is never cut in half and a UTF-16 surrogate pair is never split. The cut is
  `trimEnd`-ed and `…` appended — only when the collapsed text was longer than 48.
- HTML-escaped (`&`, `<`, `>`); the stored text is raw user text and is never interpreted as
  markup. The `href` is attribute-escaped.
- Media placeholders (`[photo]`, a caption) are quoted like any other text.

Which refs get a preview:

- Lookup reuses the excerpt block's chat scoping (`chat_id` match beats a legacy row; another
  chat's row never matches; `message_id: null` rows never match). Two rows with the same id
  and the same rank → the FIRST written wins (the text as first seen).
- Only refs the tag-safe walk would rewrite: never inside `<a>`, `<pre>`, `<code>` or a `://`
  token.
- Ids are taken in mention order; the first `MSGREF_PREVIEW_CAP` = 8 ids WITH a history hit
  get a preview. Later ids keep today's rendering and their bottom excerpt entry, so a report
  that cites 30 ids does not triple in height.
- Each previewed id is quoted ONCE, at its first occurrence; later mentions of the same id
  render the plain marker (link/styled), as today.
- A previewed id is dropped from the bottom excerpt block (it would repeat the same words).
  An id that has a history hit but no inline preview keeps its bottom entry.
- An id with no history hit (trimmed away, other machine, foreign chat) renders byte-identical
  to the flag-off output. A preview is never fabricated.

Tiers and length:

- The preview is plain text plus, in a supergroup, one `<a>` — valid in BOTH the basic tier
  (`sendMessage`, captions) and the rich tier (`sendRichMessage`). It adds no rich-only tag,
  so a preview never moves a message between tiers.
- The substitution happens on the whole body BEFORE the transmitter, so the caption-ride check
  (1024) and the 4096 splitter see the final text: a near-4096 body that a preview pushes over
  the limit is split into two valid messages, never rejected. Each preview adds at most
  48 clusters + `«…» ()` + the marker; the 8-preview cap bounds the total.

Flag: `autolink-msgref-preview`, ON by default, opt out with
`--no-feature autolink-msgref-preview` or `features: { autolink-msgref-preview: false }`.
It only acts when `autolink-msgrefs` is on. Flag off → the pre-preview output (plain markers
plus the bottom excerpt block), byte-identical except where the history holds two same-rank
rows for one id (both paths now take the first-written row; before: the last) and where the
old code-point excerpt cut split a ZWJ emoji (now cut by grapheme cluster).

## Ordering — the msgref pass runs LAST among the body linkifiers

In the `tg` outbound transform the msgref pass (`linkifyMsgRefs`, previews included) runs
AFTER `applyAutolink`'s ticket/`#N` linkifiers and BEFORE the reference blocks are appended
(`AutolinkExtras.linkifyLast`). A quoted preview is arbitrary user text; a quote containing
`#42`, `HYP-100` or `tg#999` must not be linkified by a later pass, and text the final pass
inserts is never re-scanned. Running last is safe because the earlier passes never touch a
raw `tg#<id>`: the PR and ticket detectors reject a `#`/code preceded by the alphanumeric `g`
(pinned by the boundary-disjointness tests), so a `tg#3715` is never offered to the gh
probe. The reference blocks are appended after the pass, so their labels/titles are never
rewritten into previews.

## Tests (TDD, red-first)

- detect: bare `tg#<id>`; case-insensitive prefix; dedup + first-appearance order;
  already-styled `𝒕𝒈#<id>`; punctuation boundaries; leading/trailing alnum rejection;
  `tg#0` rejection; bare `#N` is NOT a msgref; URL tokens skipped; multiline; empty.
- `msgRefUrl`: supergroup → `t.me/c` link; DM/basic-group/empty → null.
- linkify: url → anchor; null url → styled bold-italic ref; tag-safety inside
  `<a>`/`<pre>`/`<code>`/URL tokens; no-ref body unchanged.
- excerpt entries: compact one-line history excerpt, ellipsis on truncation, missing ids
  skipped, duplicate ids deduped in mention order, grapheme-safe (ZWJ/emoji) truncation, escaped
  excerpt text, current-chat filtering when `chat_id` is available, first-written row wins.
- previews: grapheme cap (ZWJ/flag safe), trim-then-collapse, ellipsis only past 48,
  whitespace-only → none, escaping of hostile text; DM / supergroup renderings; marker kept as
  written; first-occurrence-only; the 8-preview cap; not-found and flag-off byte-identity;
  previewed ids leave the bottom block; a quote containing `#42 HYP-100 tg#999` gains no links.
- entrypoint subprocess: real `tg` send against a fake Bot API reads
  `tg-ctl.<bot>.history.jsonl` and sends the inline preview (DM and supergroup) for both
  `tg#<id>` and `𝒕𝒈#<id>`; skipped tags get neither preview nor excerpt block;
  `--no-feature autolink-msgref-preview` sends the bottom excerpt block instead; a near-4096
  body whose preview crosses the limit is split and every part is ≤ 4096.
- coexistence: `detectRefs` ignores `tg#<id>`; the PR and ticket linkifiers never rewrite a
  `tg#<id>` even when that number is a verified PR, while a standalone `#N` still links.
