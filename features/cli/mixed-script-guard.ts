// Mixed-script "garbage token" guard (part of feature `cjk-guard`, ON by default).
//
// WHAT: catch a homoglyph / mojibake "garbage word" — a single CONTIGUOUS run of
// letters whose script switches back and forth between Cyrillic and a foreign
// alphabet (Latin, Greek, …). The detector is BIDIRECTIONAL (tg-cli#224): it
// flags a foreign fragment sandwiched inside Cyrillic, e.g. "почčesна" (Cyrillic
// по + Latin čes + Cyrillic на, meant "починена"), AND a Cyrillic letter
// sandwiched inside a foreign word, e.g. "mіr" (Latin m + Cyrillic і + Latin r).
// Reached from the `tg` entrypoint alongside the stray-CJK guard, on the FINAL
// decoded caption and the --title header, right before send; a hit is a HARD
// error (exit 1) so the sender re-sends clean. Off-switch: `--no-feature
// cjk-guard` (same toggle as the CJK guard — both catch the same "a garbled token
// slipped into the message" class).
//
// INVARIANT: precision over recall, and fire ONLY on INTERLEAVING within ONE run.
// We count script transitions and flag only runs with >= 2 (`…Cyr → Lat → Cyr…`
// or `…Lat → Cyr → Lat…`). That is what separates garble from the many
// LEGITIMATE two-segment tokens Russian dev writing produces:
//   * a message using both scripts across DIFFERENT words ("влил PR", "gh ship
//     готово", "dev-cli") — each word is one run, one script, zero transitions;
//   * a Latin acronym HYPHEN-joined to a Cyrillic word ("PR-ревью", "MCP-сервер")
//     — the hyphen is a non-letter, so the two scripts are in SEPARATE runs;
//   * a Latin acronym with a GLUED Cyrillic case/diminutive suffix and no
//     separator ("IDшник", "PRы", "APIшка", "ORMка") — ONE run but only ONE
//     boundary (Latin → Cyrillic), so it is NOT a sandwich and passes.
//
// LEGIT SANDWICH (tg-cli#215, #226): Russian dev slang glues a Cyrillic prefix
// AND suffix onto an untouched English stem or acronym — "заpushил",
// "заmergeил", "отdebugил", "антиDDoSный". That is exactly two transitions, so
// the count alone cannot tell it from "почčesна". The distinguishing signal is
// the ISLAND itself: slang keeps a real English word — plain ASCII letters,
// at least two of them, and at least one that has no Cyrillic lookalike. A
// mojibake island either carries a non-ASCII letter (č, Greek τ), is a single
// letter ("починeна"), or is made ONLY of Cyrillic lookalikes ("пеpeход": p, e)
// — the homoglyph-substitution signature. So a run passes when it is
// Cyrillic → one ASCII island → Cyrillic and that island is not homoglyph-only.
// A Cyrillic island inside a foreign word ("mіr") is never exempt.
//
// SCOPE: the "foreign" partner is any cased/other letter that is neither Cyrillic
// nor CJK (Latin, Greek, Armenian, …). CJK letters are IGNORED entirely — they do
// not vote on script AND do not create a transition — so this guard measures pure
// Cyrillic<->foreign interleaving and stays STRUCTURALLY orthogonal to the
// stray-CJK guard (features/cli/cjk-guard.ts, whose `isCjk` we reuse so the two
// can't drift), rather than relying on CLI firing order. A run is flagged only
// when its Cyrillic/foreign letters contain BOTH a Cyrillic AND a foreign letter
// with >= 2 transitions between them; Cyrillic + digits / punctuation / emoji is
// not mixing and passes. Combining marks (\p{M}), invisible format characters
// (\p{Cf}: zero-width space, ZWNJ, soft hyphen, word joiner, BOM — tg-cli#227)
// and modifier letters (\p{Lm}, e.g. a lone U+02BC used in some Cyrillic-script
// orthographies) are part of the run but do NOT vote: a decomposed accent or a
// modifier letter cannot fabricate a transition, and an invisible character
// cannot split a garbage run into two single-transition halves. The flip side
// is deliberate: words glued only by invisible characters render as ONE word
// ("PRготовоdone") and are judged as one run. Residual recall
// gaps (accepted, same escape hatch as the CJK guard): a garble with the foreign
// fragment at a run EDGE (one transition) reads identically to a legit glued
// compound, and a pure-ASCII island with a non-lookalike letter reads like
// slang — both are left alone; use `--no-feature cjk-guard` for the rare
// legitimately-mixed token.

import { isCjk } from './cjk-guard';

// A codepoint that participates in a letter "run": a letter (\p{L}), a
// combining mark (\p{M}), or an invisible format character (\p{Cf}). Marks
// attach to the preceding letter and format characters are invisible, so
// neither may split a run.
const LETTERISH_RE = /[\p{L}\p{M}\p{Cf}]/u;
const LETTER_RE = /\p{L}/u;
// A modifier letter (Lm) is a letter but is not part of the base alphabet — treat
// it like a combining mark: it rides in the run but does not vote on script.
const MODIFIER_LETTER_RE = /\p{Lm}/u;
const CYRILLIC_RE = /\p{sc=Cyrillic}/u;
const ASCII_LETTER_RE = /^[A-Za-z]$/u;
// ASCII letters that render like a Russian Cyrillic letter (a→а, B→В, p→р, …).
// An island made only of these is homoglyph substitution, not an English stem.
const CYRILLIC_LOOKALIKE_RE = /^[aceopxyABCEHKMOPTXY]$/u;

// The voting script "class" of a base letter, for transition counting. Non-voting
// codepoints (non-letters, combining marks, format chars, modifier letters, and
// CJK letters — the stray-CJK guard's domain) return null and are skipped.
type ScriptClass = 'cyrillic' | 'foreign';

export interface MixedScriptToken {
  token: string; // the offending contiguous letter run
  index: number; // 0-based codepoint index of the run's first char in the message
}

export interface MixedScriptFinding {
  tokens: MixedScriptToken[];
}

function isLetterish(ch: string): boolean {
  return LETTERISH_RE.test(ch);
}

// Classify a codepoint's voting script, or null when it does not vote (a
// non-letter, a combining mark, a format char, a modifier letter, or a CJK
// letter — CJK is the stray-CJK guard's domain and is skipped so it neither
// votes nor transitions).
function scriptClassOf(ch: string): ScriptClass | null {
  if (!LETTER_RE.test(ch) || MODIFIER_LETTER_RE.test(ch)) return null;
  if (isCjk(ch)) return null;
  return CYRILLIC_RE.test(ch) ? 'cyrillic' : 'foreign';
}

// A letter run [start, end) is "garbage" when its voting letters contain BOTH
// Cyrillic and foreign AND the script switches at least twice — the mojibake
// sandwich signature. A single boundary (Latin acronym + glued Cyrillic suffix,
// e.g. `IDшник`) is a legit compound, and so is ONE English island wrapped in a
// Cyrillic prefix and suffix (`заpushил`, `антиDDoSный`) — see the header.
function runIsGarbage(codepoints: string[], start: number, end: number): boolean {
  let transitions = 0;
  let firstClass: ScriptClass | null = null;
  let prev: ScriptClass | null = null;
  // The foreign letters of the run; only inspected for the one-island shape.
  const foreign: string[] = [];
  for (let i = start; i < end; i += 1) {
    const cls = scriptClassOf(codepoints[i]);
    if (cls === null) continue;
    if (cls === 'foreign') foreign.push(codepoints[i]);
    if (prev !== null && cls !== prev) transitions += 1;
    firstClass ??= cls;
    prev = cls;
  }
  // >= 2 transitions implies both scripts are present.
  if (transitions < 2) return false;
  const isOneEnglishIsland =
    transitions === 2 &&
    firstClass === 'cyrillic' &&
    foreign.length >= 2 &&
    foreign.every((ch) => ASCII_LETTER_RE.test(ch)) &&
    foreign.some((ch) => !CYRILLIC_LOOKALIKE_RE.test(ch));
  return !isOneEnglishIsland;
}

/**
 * Find contiguous letter runs whose script interleaves Cyrillic and a foreign
 * alphabet — a foreign fragment inside Cyrillic ("почčesна") or a Cyrillic
 * letter inside a foreign word ("mіr"): the homoglyph/mojibake "garbage word"
 * bug. Russian dev slang (`заpushил`) passes. Returns null when clean.
 */
export function findMixedScriptTokens(text: string): MixedScriptFinding | null {
  const codepoints = Array.from(text);
  const tokens: MixedScriptToken[] = [];
  let i = 0;
  while (i < codepoints.length) {
    if (!isLetterish(codepoints[i])) {
      i += 1;
      continue;
    }
    // Consume the maximal run of letters (+ attached combining marks).
    const start = i;
    while (i < codepoints.length && isLetterish(codepoints[i])) i += 1;
    if (runIsGarbage(codepoints, start, i)) {
      tokens.push({ token: codepoints.slice(start, i).join(''), index: start });
    }
  }
  return tokens.length > 0 ? { tokens } : null;
}

/** A human-actionable error naming each offending token and its position. */
export function formatMixedScriptError(finding: MixedScriptFinding): string {
  const list = finding.tokens
    .map((t) => `'${t.token}' at position ${t.index + 1}`)
    .join(', ');
  return (
    `mixed-script "garbage" token — a single word mixes Cyrillic with Latin/other ` +
    `letters (the homoglyph/mojibake signature): ${list}. This usually means a ` +
    `garbled token slipped into the message — re-send a clean copy. To send it ` +
    `anyway, pass --no-feature cjk-guard.`
  );
}
