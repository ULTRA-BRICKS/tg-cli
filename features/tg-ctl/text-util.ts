// Shared text-truncation safety helper.
//
// Slicing a JS string by raw UTF-16 code-unit count can land the cut between the two
// halves of a surrogate pair — any astral character, most commonly an emoji (e.g. 😀 is
// the pair U+D83D U+DE00). `JSON.stringify` happily escapes the resulting lone surrogate
// as a literal `\uXXXX` sequence (still valid ASCII/JSON on the wire), but Telegram's Bot
// API re-decodes that JSON string server-side and rejects the now-invalid Unicode with a
// FLAT `400 Bad Request: strings must be encoded in UTF-8` — the whole sendMessage call
// fails, not just the truncated field. Reproduced live (tg#17245): a reply-route picker
// built from a quoted message whose 60/80-char cut landed mid-emoji.
//
// Every char-count truncation that appends an ellipsis (buildReplyAnchor's quote head,
// buildAgentSelectMessage's prompt preview, the limit-notification detail line, the
// /tasks table cell truncation, the ExitPlanMode plan card, the permission-prompt
// summary) must cut through `safeSliceEnd`, not a raw `.slice(0, n)`.
//
// Scope: this guards surrogate-PAIR splits only — the specific shape that produces
// invalid UTF-16 and trips Telegram's decoder. A cut through a multi-code-unit grapheme
// cluster that stays well-formed at the code-unit level (a ZWJ sequence, a regional-
// indicator flag pair, a base+combining-mark pair) is unaffected: each half is valid
// Unicode on its own, so it renders as a mangled-looking but VALID character, never the
// 400 this module exists to prevent. Not a gap in this fix, just a different bug class.
//
// A second, independently-evolved surrogate-safety cut lives in
// `features/auto-attach/split.ts`'s private `safeCut` (guards the 4096-char message
// splitter, checks the FIRST-EXCLUDED unit for a low surrogate rather than the
// last-included unit for a high one — same invariant, inverted direction). That code
// predates this module and has its own splitter-specific concerns (tag boundaries); it
// is intentionally not merged into this one, but a change to either's surrogate logic
// should double-check the other still holds the same guarantee.
export function safeSliceEnd(s: string, end: number): number {
  let clamped = Math.max(0, Math.min(end, s.length));
  // A high surrogate (0xD800–0xDBFF) as the LAST included unit means its low-surrogate
  // partner just past `clamped` is about to be cut off — back up so the pair stays whole
  // (dropped together) instead of being split into an orphaned half. LOOPS rather than
  // checking once: well-formed text never has two consecutive high surrogates, so this
  // is a single step for every real case, but malformed input CAN — e.g. a hook payload
  // whose JSON carries `"\ud83d\ud83d\ude00"` verbatim (`JSON.parse` doesn't validate
  // that `\uXXXX` escapes pair up). A single-step check backs up onto the SECOND high
  // surrogate of such a run, which is itself still unpaired — review finding: back up
  // over the WHOLE run so the cut always lands on a unit that is safe to end on.
  while (clamped > 0 && clamped < s.length) {
    const code = s.charCodeAt(clamped - 1);
    if (code < 0xd800 || code > 0xdbff) break;
    clamped -= 1;
  }
  return clamped;
}

// The common shape shared by every picker/notification/table-cell truncation: cut to at
// most `max` UTF-16 units (reserving one for the ellipsis) and append `…` ONLY when
// truncation actually happened. Single source of truth so a new call site can't reopen
// this bug class by hand-rolling its own `s.slice(0, max - 1)}…` copy (review finding:
// the first fix duplicated this one-liner across three files, and two more call sites —
// the ExitPlanMode plan card and the permission-prompt summary — were missed entirely
// because there was no shared helper steering new truncation code toward the safe cut).
export function truncateWithEllipsis(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, safeSliceEnd(s, max - 1))}…`;
}

// True when `s` contains a surrogate code unit with no valid pair partner — the exact
// invalid-Unicode shape Telegram's Bot API rejects server-side. Shared by tests asserting
// a truncation never emits one.
export function hasUnpairedSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}
