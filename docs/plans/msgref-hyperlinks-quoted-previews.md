# Plan — msgref quoted previews: `tg#<id>` becomes a hyperlinked quote of the referenced message

Status: IMPLEMENTED by tg-cli#116 — `docs/specs/autolink-msgrefs.md` §Quoted previews is the
authoritative description now; this plan stays as the design record (carries the originating
ask, tg#5663). Differences from the plan: the renderer lives in `render.ts` next to the plain
marker (`preview.ts` holds the text shaping), and the length budget is option 1 by
construction — the whole body is one text message until the transmitter splits it.

## Problem

Outbound agent reports reference inbound Telegram messages by id: "answered tg#5663",
"per tg#5698". Today `autolink-msgrefs` renders that token as:

- **supergroup chat** — a deep link `<a href="https://t.me/c/<internal>/<id>">tg#5663</a>`;
  the reader must TAP to learn which message it was;
- **private DM** (the dominant case — the operator's chat with the bot is a DM) — a
  marked-but-unlinked bold-italic token; the reader can do NOTHING with it.

The ask (tg#5663): message references should be marked up as hyperlinks, and the literal
`tg#xxxx` replaced with a quoted preview of the referenced message's beginning
("начало сообщения с …"), so a report reads without cross-referencing ids.

## Data source: the replies history JSONL

`tg-ctl.<botid>.history.jsonl` (see `features/replies/history.ts`) already records one
`{ts, message_id, direction, from, text, pane}` per line for BOTH directions: the daemon
appends every inbound message it processes; `tg` appends one record per outbound send. So a
message-id → text lookup is a pure parse of a file both entrypoints already know how to
locate (`ctlPaths(configDir, botIdFromToken(token)).history` — the exact resolution `tg
replies` uses at `tg` line ~345).

Known properties the design must respect:

- **Trimmed tail** — the log keeps the last ~5000 lines (`MAX_HISTORY`). Old ids age out.
- **Scope every lookup by `chat_id`, reusing the existing pattern — do NOT add a new
  ID-only Map.** `message_id` is only unique PER CHAT. `HistoryRecord` already carries an
  optional `chat_id` (`features/replies/history.ts`), and the sibling bottom-reference
  builder `buildMsgRefEntries` (`features/autolink-msgrefs/render.ts`) already resolves this
  correctly via `chatMatchRank(rec, chatId)`: an exact `chat_id` match ranks highest, a
  legacy record with no `chat_id` ranks as a fallback, and a record from a DIFFERENT chat is
  excluded outright. (Review finding, P1: an earlier draft of this plan assumed a naive
  ID-only lookup was "safe" because the tool is one-chat-per-machine — but a bound topic, a
  second configured chat, or simply old cross-chat history rows sharing the file can already
  produce a same-id collision; the fix is to reuse the existing scoping, not to special-case
  a new one.) The new inline-preview lookup must call `buildMsgRefEntries` (or a shared
  helper factored out of it) with the SAME `chatId` argument the bottom-reference path
  already passes, rather than re-implementing its own `Map<number, HistoryRecord>`.
- **Records with `message_id: null` are dropped** when building the lookup Map (some
  outbound paths log without an id; a null key must never match anything).
- **Duplicate ids resolve first-write-wins.** Today no writer logs the same id twice
  (edits are not logged; each send/inbound appends once), but the best-effort
  read-modify-write makes duplicates possible in principle. The Map must skip an already
  -present key — pinned by a test — so the "text as first seen" claim below actually holds
  (a naive `map.set` per line would be last-write-wins).
- **Both directions** — `tg#<id>` may reference an inbound (user) OR outbound (agent)
  message; both are legitimate lookup hits (ids share one per-chat sequence).
- **Media placeholders** — an outbound photo/document is logged as `[photo]`/`[document]`;
  an inbound media message may have an empty/caption-only text. Previews of those are
  low-value but harmless; render whatever text is stored, placeholder included.
- **Best-effort log** — a racing read-modify-write can occasionally lose a record (the
  documented `routes`-style posture). A missing id therefore MUST degrade gracefully.

## Proposed rendering

Given `tg#5663` and a history hit whose text begins «Запланируй чтобы ссылки на сообщения
размечались гиперссылками…»:

- **supergroup**:
  `<a href="https://t.me/c/<internal>/5663">«Запланируй чтобы ссылки на сообщения размеча…»</a> (tg#5663)`
- **private DM / basic group** (no public per-message URL):
  `«Запланируй чтобы ссылки на сообщения размеча…» (tg#5663)` — quote plain, id marker in
  the existing bold-italic styled form so it still reads as a deliberate reference.
- **id not found in history**: today's rendering, byte-identical. A preview is NEVER
  fabricated (no "message #5663" pseudo-text) — absence of data renders as absence of
  preview.

**Must not duplicate the existing bottom `<blockquote expandable>` entry (review finding,
P2).** `buildMsgRefEntries` already renders a one-line excerpt for every mentioned id into a
bottom reference block (`tg`'s autolink transform, `<blockquote expandable>`) — that is
where today's byte-identical fallback rendering gets its excerpt from. Once an id gets an
INLINE preview under this plan, its bottom-block entry must be SUPPRESSED for that id (pass
the already-linkified id set into `buildMsgRefEntriesFor` as an exclusion, or filter the
built entries before rendering the bottom block) — otherwise every previewed reference shows
the same excerpt TWICE: once inline, once at the bottom. The id-not-found fallback above is
exactly the case that still needs the bottom-block entry (no inline preview exists to show
it), so the suppression must be per-id (found → suppress bottom entry; not-found → keep it),
not a blanket "turn off the bottom block once this feature ships."

Decision — **keep the trailing `(tg#id)` marker** in both cases. Rationale: the id is the
stable handle. Replies quote these tokens back ("про tg#5663 — сделай наоборот"), agents
grep `tg replies` by id, and the detector convention (`docs/specs/autolink-msgrefs.md`)
survives round-trips. Dropping the id would make previews terminal — pretty but
dead-end. The marker also keeps the not-found and found renderings consistent (both always
contain `tg#<id>`).

Preview shape:

- The stored text is **trimmed first**, then whitespace-collapsed; a text that is empty
  after trimming yields NO preview (fall back to today's rendering) — never an empty
  `«»` or a quoted lone space.
- First **48 grapheme clusters** (`Intl.Segmenter`, not code points — a cut mid
  ZWJ-emoji/flag renders a broken glyph before the `…`), trim-end applied to the cut
  before appending `…` (a cut landing on a collapsed space must not render `«…слово …»`),
  then `…` when truncated. 48 keeps the common two-ref report line under one phone line
  and bounds the length inflation (below).
- Wrapped in French quotes `«…»` — matches the reply-quote anchor convention
  (`↩ «[date time] quoted…»`) the daemon already uses, so quoted-message previews look the
  same everywhere.
- HTML-escaped, always. The stored text is raw user text and may contain `<`, `&`, or
  markup-looking fragments; the substitution emits escaped text into an
  already-rendered HTML body (same contract as `linkifyMsgRefs` today, which escapes the
  token and the URL attribute).

## Pipeline placement: previews run LAST, not first

`linkifyMsgRefs` currently runs FIRST in the outbound transform (before the ticket/#N
passes). That order CANNOT survive preview substitution: the inserted preview is arbitrary
user text. In the supergroup case it sits inside `<a>…</a>` (which the later walkers
skip), but in the DM case the quote is bare escaped text — a quoted message containing
`#42`, `HYP-100`, or another `tg#999` would be re-scanned by the ticket/#N passes and
linkified INSIDE the quote (false links into someone's quoted words).

So the preview-substitution pass runs **LAST** — after the ticket/#N passes. This is safe
in both directions:

- the earlier passes never touch a raw `tg#123` token (their boundary rules reject a `#`
  preceded by the alphanumeric `g` — the disjointness `docs/specs/autolink-msgrefs.md`
  documents as the belt-and-braces reason for the current order);
- the msgref walker already skips inside the `<a>` tags those passes produced;
- text inserted by the FINAL pass is, by construction, never re-scanned.

The spec's "runs FIRST" section is updated in the same PR (the ordering rationale inverts:
first was belt-and-braces; last is correctness). A coexistence test pins the no-rescan
property: a preview containing `#42 HYP-100 tg#999` renders with zero links inside the
quote.

## Length budget

A quoted preview changes VISIBLE length: `tg#5663` (7 chars) → `«48 chars…» (tg#5663)`
(~62 chars) — unlike today's linkify, whose `<a href>` wrappers are invisible to
Telegram's 4096/1024 post-parse limits. Naively substituting after the transmitter split
can push a near-limit message over the cap and fail the send. Two options, decided at
implementation:

1. **Preferred**: perform the substitution BEFORE the transmitter split, so the splitter
   sees the real final text. Note this EXPANDS scope: today the linkify touches only
   `plan.textMessages[0]`; a pre-split substitution applies to the whole body, so refs in
   the second+ split messages start rendering previews too. That is accepted as a
   deliberate extension (a ref is a ref wherever the splitter put it) and pinned by a
   test — not smuggled in as a refactor. ORDERING CONSTRAINT: "preview pass runs LAST"
   is defined relative to the ticket/#N passes, and those currently run post-split. If
   option 1 moves the preview pass pre-split, the ticket/#N passes MUST move pre-split
   with it (preserving their relative order, previews still last) — a pre-split preview
   followed by post-split ticket/#N passes would re-scan the inserted quote and void the
   no-rescan guarantee. The no-rescan coexistence test must run against whichever phase
   layout is chosen.
2. **Fallback** (if (1) tangles the caption-promotion logic): keep post-plan substitution
   on the first message but compute the inflation delta; if the substituted body would
   exceed the visible limit, degrade THAT message's refs to today's non-preview rendering
   (never a mid-send failure). The delta is measured in **UTF-16 code units** (JS
   `.length` of the substituted string) — Telegram counts its 4096/1024 limits in code
   units, and a 48-grapheme emoji-heavy preview is several times longer in units than in
   clusters; a cluster-based delta would pass the check and still fail the send. Test
   with an emoji-heavy preview at the limit. (Option 1 has no such failure mode — the
   splitter sees the real text.)

Preview cap, defined per option so the tests and the implementation cannot diverge: at
most **8 previews per outbound BODY** under option 1 (at substitution time no message
boundaries exist yet), at most **8 per first message** under option 2. Refs beyond the
cap keep today's rendering. A report that cites 30 ids should not triple in height.

## Compound refs

`autolink-refs` compound ranges (`#5-7,9`, `HYP-100..103`) do NOT apply to msgrefs: the
msgref detector matches `tg#<id>` single tokens only (`tg#5-7` matches as `tg#5`; the
`-7` tail is untouched text). No range/list preview semantics are planned — a range of
message previews would be noise, and no writing convention produces such tokens today. If
compound msgrefs are ever added to the detector, previews apply per-expanded-id with the
same per-message cap.

## Feature flag

Default-ON `autolink-msgref-preview` in the existing `features/auto-attach/feature-flags.ts`
map, opt-out via `--no-feature autolink-msgref-preview` or the `features:` config block —
exactly like the sibling autolink flags. With the flag off (or with `autolink-msgrefs`
itself off) the rendering is today's, byte-identical. Separate flag (not reusing
`autolink-msgrefs`) so a user who dislikes previews keeps plain links.

## Module shape (follows repo decomposition rules)

- `features/autolink-msgrefs/preview.ts` — PURE: `buildPreview(text, maxChars)` (collapse,
  cap, ellipsis), `renderMsgRefPreview(token, id, preview, url)` (the three renderings
  above). No I/O.
- History lookup stays in the entrypoint (`tg`), injected as `lookupText: (id: number) =>
  string | null` into the linkify call — mirrors how `urlFor` is injected today, keeps the
  feature module I/O-free and unit-testable. The entrypoint reads the history file ONCE
  per send (only when refs were detected), builds a Map, and hands the closure over.
- `linkifyMsgRefs(html, urlFor)` grows an optional `previewFor` parameter (or a sibling
  `linkifyMsgRefsWithPreview`) — decided at implementation by whichever keeps the
  tag-safe walker single-sourced.

## Testing plan (TDD, red-first)

- `buildPreview`: cap at 48 grapheme clusters (ZWJ-emoji/flag safe), trim-then-collapse,
  ellipsis only when truncated — "truncated" judged on the ORIGINAL collapsed length, not
  the post-trim-end cut (pinning tests: exactly-48 → no ellipsis, 49 → ellipsis, and a
  cut landing on an inter-word space → trim-end drops that single trailing space (48→47)
  and the ellipsis still appends), whitespace-only text → null (no preview), placeholder
  passthrough.
- `renderMsgRefPreview`: supergroup anchor + escaped quote + marker; DM styled fallback;
  not-found → byte-identical current rendering; HTML-escaping of hostile stored text
  (`<b>`, `&`, quotes in the URL attr path).
- Tag-safety: previews never substituted inside `<a>`/`<pre>`/`<code>` or URL tokens
  (reuses the existing walker tests' shape).
- Budget: a near-4096 visible body with refs → either pre-split substitution yields two
  valid messages (option 1, plus the pinned scope-expansion test for second+ messages) or
  refs degrade to non-preview (option 2); the per-message preview cap.
- Coexistence / ordering: the pass runs last — a preview containing `#42 HYP-100 tg#999`
  gets zero links inside the quote; earlier passes leave raw `tg#<id>` tokens intact
  (boundary-rule disjointness test); the walker still skips previews inside pre-existing
  `<a>` tags.
- Lookup hygiene: records with `message_id: null` never match; the single-chat assumption
  is asserted in a comment-pinning test next to the Map construction.
- Flag-off byte-identity, as its OWN test distinct from not-found: `previewFor` absent
  (flag off, or `autolink-msgrefs` itself off) is a different code path than a lookup
  miss; both must render today's output byte-identically.
- History is read and the Map built LAZILY — only after refs were detected in the body —
  pinned by a test so a ref-less send never pays the ~5000-line parse.
- One real smoke send (repo-accepted practice): a report citing two real ids from the live
  history, visually verified on the phone.

## Increments

1. **Lookup + single-ref preview** — history Map in `tg`, pure preview module, supergroup +
   DM renderings behind the new flag, unit tests. BLOCKING PRECONDITION for the ordering
   flip: the boundary-disjointness test (ticket/#N passes leave a raw `tg#123` untouched)
   must land RED-first and pass BEFORE the msgref pass moves to last — the whole pipeline
   inversion rests on that property, so it is a gate, not a checklist item.
2. **Fallbacks hardened** — not-found byte-identity, media placeholders, hostile-text
   escaping, duplicate-id first-write-wins, the preview cap.
3. **Length-budget integration** — pre-split substitution (or the degrade fallback),
   transmitter-limit tests, real smoke send.

## Open questions

- **Cross-machine gaps**: history is per-machine; a report composed on machine A citing an
  id only machine B saw renders without preview (correct degrade, but worth a line in the
  README when shipped).
- **Forwarded/edited messages**: history stores the text as first seen; an edited Telegram
  message keeps its stale preview. Accepted — previews are orientation aids, not quotes of
  record.
- **Outbound-record ids are best-effort** (`message_id: null` on some outbound paths —
  those records are unreferenceable and simply never match a lookup).
- **Preview length 48** is a guess at phone-line width; tune after the first real sends.
