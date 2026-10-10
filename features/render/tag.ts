// --- Message tag badge (`--tag <TAG>`) ---
//
// A small, well-known set of message tags agents use to label what a Telegram
// message IS (an answer, a decision, a problem report, a status report). Each
// canonical tag is the ENGLISH word and renders as a wordmark PILL (a custom
// emoji chip) plus, for non-premium / not-yet-uploaded viewers, a unicode
// fallback badge on the header line, right after `✳️ [window]`:
//
//   ✳️ [window] 🔵 ANSWER — <title>        (unicode fallback)
//   ✳️ [window] <ANSWER pill> — <title>    (premium, real pill ids uploaded)
//
// INPUT POLICY (CTO 2026-06-16, ROADMAP "tg --tag: lowercase-english only"):
// `--tag` accepts ONLY the lowercase-english tag words — `answer` / `decision`
// / `problem` / `report`. Uppercase (`ANSWER`), Cyrillic aliases (`ОТВЕТ`), and
// unknown words are REJECTED at parse time (`validateTag`) with a 3-part error
// and a non-zero exit, instead of the old soft-render-and-warn behavior. The
// former `question` tag (tg-cli#301, CTO 2026-09-05) is REJECTED with a
// dedicated hint: an open question for the human IS a decision request and
// goes out as `--tag decision` in the decision-request format. The
// internal pipeline still keys on the UPPERCASE canonical (the pill set, the
// fallback map, and the upload script), so `resolveTag` uppercases the already-
// validated lowercase input to look it up.

import { TAG_PILL_DOT, TAG_PILL_FALLBACK, tagPillCellDots } from '../branding/emoji';

// The four canonical (English) tag words. This is the canonical order the pill
// set, the fallback map, and the upload script all key on.
export const CANONICAL_TAGS = ['ANSWER', 'DECISION', 'PROBLEM', 'REPORT'] as const;
export type CanonicalTag = (typeof CANONICAL_TAGS)[number];

// The lowercase-english tags that mean "this is an escalation ask needing a
// structured reply" — used by features/cli/args.ts's TAG_GATES (parse-time,
// blocking), the one escalation-format enforcement. A single shared list so
// adding another escalation tag is one edit. `decision` is the
// ONLY escalation tag: an open question is a decision request (tg-cli#301).
export const ESCALATION_TAGS = ['decision'] as const;

/** Whether a (validated, lowercase) tag is an escalation tag — the ONE membership
 * predicate every consumer of ESCALATION_TAGS uses (the entrypoint's --table
 * final-body check, the pre-send-text hook), so none keeps a private copy. */
export function isEscalationTag(tag: string): boolean {
  return (ESCALATION_TAGS as readonly string[]).includes(tag);
}

// The tag word REMOVED in tg-cli#301. It is not merely unknown — an agent
// reaching for it has the right intent (asking the human something) and the
// wrong vocabulary, so validateTag answers with a redirect instead of the
// generic off-list error.
const REMOVED_QUESTION_TAG = 'question';
export const REMOVED_QUESTION_TAG_HINT =
  '--tag question was removed: an open question is a decision request — ' +
  'use --tag decision in the decision-request format';

// The accepted `--tag` values: the lowercase-english spelling of each canonical
// tag. This is the ONLY accepted input form (see INPUT POLICY above). Derived
// from CANONICAL_TAGS so the two never drift.
export const ACCEPTED_TAGS: readonly string[] = CANONICAL_TAGS.map((t) => t.toLowerCase());

// The canonical tags as an uppercase lookup set. There are no aliases anymore
// (Cyrillic was removed; validateTag rejects off-list input before resolveTag
// runs), so resolveTag just uppercases its input and checks membership.
const CANONICAL_TAG_SET = new Set<string>(CANONICAL_TAGS);

// A human-readable, comma-separated list of the accepted tags, for error/help
// text ("use one of: answer, decision, problem, report").
export const ACCEPTED_TAGS_LIST = ACCEPTED_TAGS.join(', ');

/**
 * Validate a raw `--tag` value against the lowercase-english-only policy.
 *
 * Returns `null` when the tag is accepted (a lowercase-english canonical word,
 * after trimming surrounding whitespace). Otherwise returns a 3-part error
 * MESSAGE — WHAT (`invalid --tag 'X'`), WHY (`tags must be lowercase english`),
 * HOW (`use one of: answer, decision, problem, report`) — that the caller
 * surfaces verbatim before exiting non-zero. Never throws.
 *
 * Rejects everything that is not exactly one of ACCEPTED_TAGS: uppercase
 * (`ANSWER`), mixed case (`Answer`), Cyrillic aliases (`ОТВЕТ`), and any
 * unknown word. The removed `question` tag gets its own one-line redirect
 * (REMOVED_QUESTION_TAG_HINT) instead of the generic off-list error.
 */
export function validateTag(raw: string): string | null {
  const value = raw.trim();
  if (ACCEPTED_TAGS.includes(value)) return null;
  if (value === REMOVED_QUESTION_TAG) return REMOVED_QUESTION_TAG_HINT;
  return `invalid --tag '${value}': tags must be lowercase english. Use one of: ${ACCEPTED_TAGS_LIST}`;
}

export interface ResolvedTag {
  // The unicode fallback badge to show before/instead of the pill (e.g.
  // "🔵 ANSWER"). Empty for an unknown tag (which renders as a bare `[WORD]`).
  // This is what non-premium viewers (and any viewer while the pill ids are
  // still placeholders) see.
  fallback: string;
  // The colored DOT alone (e.g. "🔵"), the tag's identifying glyph: the leading
  // glyph of `fallback` and the FIRST pill cell's inner fallback. Empty for an
  // unknown tag.
  dot: string;
  // The per-CELL inner fallbacks for the real <tg-emoji> pill, in cell order:
  // cell 0 = the colored `dot`, cells 1..n-1 = the neutral square (`▫️`). So a
  // push notification shows one colored dot + neutrals (e.g. `🔵▫️▫️`) instead of
  // N identical color dots. Empty for an unknown tag. Each entry MUST equal that
  // cell's Telegram-side alt (emoji_list) or Telegram drops the entity.
  cellDots: string[];
  // The canonical (English) tag WORD. For a known tag this is one of
  // ANSWER/DECISION/PROBLEM/REPORT; for an unknown tag it is the
  // uppercased raw input (and `known` is false).
  word: string;
  // True when the input resolved to a canonical tag; false for an off-list tag.
  known: boolean;
}

/**
 * Resolve a `--tag` value (already validated to a lowercase-english word at the
 * CLI gate) to its canonical English tag + unicode fallback badge: uppercase the
 * input and look it up. Total and case-insensitive — off-list input resolves to
 * `{ known: false, word: <UPPER>, ... }` (empty badge) so the renderer never
 * throws; the CLI never reaches that branch (validateTag rejects first).
 */
export function resolveTag(raw: string): ResolvedTag {
  const key = raw.trim().toUpperCase();
  if (CANONICAL_TAG_SET.has(key)) {
    const canonical = key as CanonicalTag;
    return {
      fallback: TAG_PILL_FALLBACK[canonical],
      dot: TAG_PILL_DOT[canonical],
      cellDots: tagPillCellDots(canonical),
      word: canonical,
      known: true,
    };
  }
  return { fallback: '', dot: '', cellDots: [], word: key, known: false };
}
