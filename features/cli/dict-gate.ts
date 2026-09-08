// Dictionary gate (tg-cli#302) — refuse to send a message that contains a
// banned word from the shared dictionary, printing the replacement.
//
// WHAT: Alex keeps a machine-readable twin of the "Dictionary" section of his
// global CLAUDE.md at ~/.claude/DICT.json (path override: $TG_DICT_PATH). Prose
// bans failed three times — an agent keeps inventing a new form of a banned
// stem — so the SENDING tool enforces them: every outgoing message (the body /
// file caption for every --tag and both formats, plus the --title) is matched
// against every rule; a hit prints each match (rule id, the matched text with
// ~20 chars of context, the replacement) and the send is REFUSED (exit 1).
// `--dry-run` runs the same check. Reached from the `tg` entrypoint next to the
// stray-CJK / mixed-script guards, before the dry-run short-circuit and before
// any transport.
//
// NO OFF-SWITCH BY DESIGN. Unlike its sibling guards there is deliberately no
// `--no-feature dict-gate` and no env bypass: the whole point is that the agent
// rewrites the wording instead of routing around the ban. The only ways to make
// a refused message go out are to fix the wording, or for the HUMAN to edit /
// remove the dictionary file.
//
// FILE LIFECYCLE (fail closed on damage, silent on absence of the DEFAULT):
//   * missing DEFAULT file   → gate disabled, nothing printed (a machine without
//                              the dictionary is not an error);
//   * missing EXPLICIT file  → an explicitly set TG_DICT_PATH that does not
//                              exist is a misconfiguration — or the agent's own
//                              off-switch — so it REFUSES every send (review-
//                              found: `TG_DICT_PATH=/nonexistent tg …` must not
//                              be a bypass);
//   * malformed JSON / shape → REFUSE every send with a warning naming the file
//                              (and the rule) until it is fixed;
//   * a rule whose regex does not compile → same, naming the rule.
// A broken dictionary silently disabling the gate would be the worst outcome
// (the words leak with nobody noticing), hence fail closed.
//
// MATCHING. Rules are JS regexes (`pattern` + `flags`, normally "iu"; `u` is
// always forced because the boundary rewrite below uses `\p{}`). The text is
// matched AS THE RECIPIENT WILL READ IT, so the normalisation depends on the
// field's format (`stripForDictionary`):
//   * html  — the CONTENTS of <pre> and <code> blocks are removed (quoting a
//             banned word to discuss it is legitimate), inline tags are removed
//             so a tag boundary cannot split a word (`почт<b>ил</b>` → `почтил`),
//             block-level tags become a newline so two words are not glued
//             together, and HTML entities (named + numeric) are decoded so
//             `почт&#1080;л` cannot hide;
//   * plain — NOTHING is stripped: Telegram renders a plain send verbatim, so
//             `<скамейка>` and `<code>почтил</code>` both reach the reader with
//             the banned word visible and must be refused (stripping here was
//             review-found to be an unlimited bypass channel).
// The --title is always a plain field (the header renderer escapes it), the
// raw --table rows likewise (they are rendered escaped inside <pre>).
// A rule with `only_if_cyrillic: true` applies only when the WHOLE message
// (title + body combined, judged on the RAW text — Cyrillic inside <code> is
// still Cyrillic the reader sees) contains Cyrillic — the dictionary's own
// description defines the scope as the whole message, and an English
// `--title "Landing done"` over a Russian body is exactly the case the rule
// exists for.
//
// `\b` IS READ AS A UNICODE WORD BOUNDARY. The dictionary is authored with the
// Python `re` mental model, where `\b` works on Cyrillic. In JavaScript `\b` is
// ASCII-only even under the `u` flag (`/\bпочтил\b/u.test("он почтил")` is
// FALSE), which would leave ten of the thirteen shipped rules dead. So at load
// time every `\b` outside a character class is rewritten to a lookaround pair
// over `[\p{L}\p{N}_]` (`toUnicodeBoundaryPattern`), and the `u` flag is
// forced. `\B`, `[\b]` (backspace) and an escaped backslash are left alone.
//
// SCOPE. Gated: the --title, the --subagent label (both header text the agent
// authors), the body / caption, and the raw --table heading + rows. NOT gated,
// deliberately (same scope as the stray-CJK guard): externally sourced text
// spliced in AFTER the gate — autolink-inlined ticket / PR titles, quoted
// tg# messages, line-spec file excerpts — and the on-disk filename of a --file
// upload (not authored in the message).
//
// Pure: the entrypoint reads the file and passes the raw text in; this module
// never touches the filesystem (it only RESOLVES the path, see
// `resolveDictionaryPath`).

import { join } from 'path';

import { stripHtmlTags } from '../render/html';

export interface DictionaryRule {
  id: string;
  regex: RegExp; // compiled with the `g` flag for matchAll (a fresh object per rule)
  onlyIfCyrillic: boolean;
  replacement: string;
}

export type LoadedDictionary =
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; rules: DictionaryRule[] };

export type DictionaryFieldFormat = 'plain' | 'html';

export interface DictionaryField {
  label: string; // e.g. "--title", "body"
  text: string;
  format: DictionaryFieldFormat; // how Telegram will render `text` (see stripForDictionary)
}

/** Shared tail of every fail-closed refusal, so the wording cannot drift. */
export const FAIL_CLOSED_NOTE =
  'Refusing to send until the file is fixed (only a MISSING file at the default path disables the gate; a broken or misconfigured one does not).';

/** The only dictionary format version this gate understands. */
export const SUPPORTED_DICTIONARY_VERSION = 1;

export interface DictionaryHit {
  ruleId: string;
  field: string;
  matched: string;
  context: string; // the match with ~CONTEXT_CHARS chars either side, whitespace collapsed
  replacement: string;
}

const CONTEXT_CHARS = 20;
const CYRILLIC_RE = /\p{sc=Cyrillic}/u;

// The Unicode-aware replacement for `\b`: a boundary between a "word" codepoint
// (letter / digit / underscore of ANY script) and a non-word one (or the edge).
const UNICODE_BOUNDARY = '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';

/**
 * Rewrite every `\b` outside a character class into a Unicode-aware boundary.
 * `[\b]` (backspace inside a class), `\B`, and an escaped backslash (`\\b` = a
 * literal backslash followed by `b`) are preserved verbatim.
 */
export function toUnicodeBoundaryPattern(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (next === 'b' && !inClass) {
        out += UNICODE_BOUNDARY;
      } else {
        out += ch + next;
      }
      i += 1;
      continue;
    }
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    out += ch;
  }
  return out;
}

// Flags for the compiled rule: the file's flags, minus `g`/`y` (state-bearing;
// `g` is re-added once for matchAll), plus `u` (the boundary rewrite uses \p{}).
function compileFlags(flags: string): string {
  const set = new Set(flags.replace(/[gy]/g, '').split(''));
  set.add('u');
  set.add('g');
  return Array.from(set).join('');
}

type CompiledRule = { rule: DictionaryRule } | { error: string };

function ruleError(path: string, ruleLabel: string, detail: string): CompiledRule {
  return { error: `dictionary ${path} is invalid — rule ${ruleLabel}: ${detail}. ${FAIL_CLOSED_NOTE}` };
}

function compileRule(raw: unknown, index: number, path: string): CompiledRule {
  const label = (r: Record<string, unknown>): string =>
    typeof r.id === 'string' && r.id ? `"${r.id}"` : `#${index + 1}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ruleError(path, `#${index + 1}`, 'not an object');
  }
  const r = raw as Record<string, unknown>;
  for (const key of ['id', 'pattern', 'replacement'] as const) {
    if (typeof r[key] !== 'string' || (key !== 'replacement' && !r[key])) {
      return ruleError(path, label(r), `missing or non-string "${key}"`);
    }
  }
  if (r.flags !== undefined && typeof r.flags !== 'string') {
    return ruleError(path, label(r), '"flags" must be a string');
  }
  if (r.only_if_cyrillic !== undefined && typeof r.only_if_cyrillic !== 'boolean') {
    return ruleError(path, label(r), '"only_if_cyrillic" must be a boolean');
  }
  const pattern = r.pattern as string;
  // JSON "\b" decodes to a BACKSPACE (U+0008), not the regex token — the
  // natural mistake for a Python-minded author. The regex would compile and
  // silently match nothing: a dead rule, the exact outcome the gate must never
  // hide. Any control character in a pattern is refused, with the hint.
  const control = /[\u0000-\u001f\u007f]/u.exec(pattern);
  if (control) {
    const cp = control[0].codePointAt(0) ?? 0;
    const hint = cp === 8 ? ' — in JSON write "\\\\b" for a regex word boundary, "\\b" is a backspace' : '';
    return ruleError(path, label(r), `pattern contains a control character U+${cp.toString(16).padStart(4, '0').toUpperCase()}${hint}`);
  }
  const flags = compileFlags((r.flags as string | undefined) ?? '');
  let regex: RegExp;
  try {
    regex = new RegExp(toUnicodeBoundaryPattern(pattern), flags);
  } catch (e) {
    return ruleError(path, label(r), `invalid regex (${e instanceof Error ? e.message : String(e)})`);
  }
  return {
    rule: {
      id: r.id as string,
      regex,
      onlyIfCyrillic: r.only_if_cyrillic === true,
      replacement: r.replacement as string,
    },
  };
}

function fileError(path: string, detail: string): LoadedDictionary {
  return { kind: 'error', message: `dictionary ${path} ${detail}. ${FAIL_CLOSED_NOTE}` };
}

/**
 * Parse + compile a dictionary from its raw file text. `raw === null` means the
 * file does not exist → the gate is disabled. Any parse / shape / regex problem
 * is an error (the caller refuses to send) whose message names the file and,
 * where applicable, the rule.
 */
export function loadDictionary(raw: string | null, path: string): LoadedDictionary {
  if (raw === null) return { kind: 'disabled' };
  let parsed: unknown;
  try {
    // A hand-edited file may carry a UTF-8 BOM (Notepad, some macOS tools);
    // JSON.parse rejects U+FEFF, and one invisible byte must not become a
    // full-send outage.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return fileError(path, `is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fileError(path, 'is invalid — the top level must be an object with a "rules" array');
  }
  const { version, rules: rulesRaw } = parsed as Record<string, unknown>;
  if (version !== undefined && version !== SUPPORTED_DICTIONARY_VERSION) {
    return fileError(
      path,
      `has "version": ${JSON.stringify(version)}, but this tg only understands version ${SUPPORTED_DICTIONARY_VERSION}`,
    );
  }
  if (!Array.isArray(rulesRaw)) {
    return fileError(path, 'is invalid — "rules" must be an array');
  }
  const rules: DictionaryRule[] = [];
  for (let i = 0; i < rulesRaw.length; i += 1) {
    const compiled = compileRule(rulesRaw[i], i, path);
    if ('error' in compiled) return { kind: 'error', message: compiled.error };
    rules.push(compiled.rule);
  }
  return { kind: 'ok', rules };
}

// Tags whose removal must not glue the words on either side together.
const BLOCK_TAG_RE =
  /<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|thead|tbody|caption|h[1-6]|hr|blockquote|details|summary|section|article)\b[^>]*>/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// Deliberately NOT `render/html.ts::decodeHtmlEntities`: that one decodes only
// the six forms tg itself emits (its job is to undo tg's own escaping for
// length accounting). Here the threat is a word HIDDEN behind markup, so every
// numeric form (`&#1080;`, `&#x438;`) and `&nbsp;` must decode too. Both are
// single-pass for the same double-decode reason.
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
      return m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * Normalise a field for dictionary matching, i.e. reduce it to what the
 * recipient will actually read. An `html` field: drop <pre>/<code> contents,
 * separate block tags with a newline, remove inline tags, decode entities. A
 * `plain` field is returned VERBATIM — Telegram renders it literally, so every
 * character (tags and entities included) is visible text.
 */
export function stripForDictionary(text: string, format: DictionaryFieldFormat): string {
  if (format === 'plain') return text;
  const noPre = text.replace(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, ' ');
  const noCode = noPre.replace(/<code\b[^>]*>[\s\S]*?<\/code\s*>/gi, ' ');
  const blocksSeparated = noCode.replace(BLOCK_TAG_RE, '\n');
  return decodeEntities(stripHtmlTags(blocksSeparated));
}

function contextAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - CONTEXT_CHARS);
  const to = Math.min(text.length, end + CONTEXT_CHARS);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return prefix + text.slice(from, to).replace(/\s+/g, ' ') + suffix;
}

function matchesIn(rule: DictionaryRule, field: DictionaryField, text: string): DictionaryHit[] {
  const hits: DictionaryHit[] = [];
  for (const m of text.matchAll(rule.regex)) {
    if (m[0] === '') continue; // an empty match is never a banned word
    const start = m.index ?? 0;
    hits.push({
      ruleId: rule.id,
      field: field.label,
      matched: m[0],
      context: contextAround(text, start, start + m[0].length),
      replacement: rule.replacement,
    });
  }
  return hits;
}

/**
 * Check every field against every rule. Returns EVERY hit (all rules, all
 * fields, all occurrences), in field order then rule order — the caller prints
 * them all so the agent can fix the message in one pass.
 */
export function checkDictionary(rules: DictionaryRule[], fields: DictionaryField[]): DictionaryHit[] {
  const stripped = fields.map((f) => ({ field: f, text: stripForDictionary(f.text, f.format) }));
  // Judged on the RAW text: Cyrillic quoted inside <code> is still Cyrillic the
  // reader sees, so it must not switch the only_if_cyrillic rules off.
  const wholeMessageHasCyrillic = fields.some((f) => CYRILLIC_RE.test(f.text));
  const hits: DictionaryHit[] = [];
  for (const { field, text } of stripped) {
    if (!text) continue;
    for (const rule of rules) {
      if (rule.onlyIfCyrillic && !wholeMessageHasCyrillic) continue;
      hits.push(...matchesIn(rule, field, text));
    }
  }
  return hits;
}

/**
 * The refusal text: one line per hit, then where the dictionary lives. Only
 * meaningful for a non-empty hit list (a refusal with nothing to show is a
 * caller bug, not a message).
 */
export function formatDictionaryHits(hits: DictionaryHit[], path: string): string {
  if (hits.length === 0) throw new Error('formatDictionaryHits: called with no hits');
  const lines = hits.map(
    (h) => `  [${h.ruleId}] in ${h.field}: "${h.context}" — matched "${h.matched}" → use: ${h.replacement}`,
  );
  return (
    `Error: dictionary gate — the message contains banned wording (${hits.length} hit${hits.length === 1 ? '' : 's'}). ` +
    'Nothing was sent. Rewrite the wording and resend:\n' +
    lines.join('\n') +
    `\nDictionary: ${path} (override the path with TG_DICT_PATH). ` +
    'Under --format html, text inside <code>/<pre> is exempt; there is no bypass flag.'
  );
}

export interface DictionaryLocation {
  path: string;
  // true when TG_DICT_PATH named it: a missing EXPLICIT file refuses to send,
  // a missing DEFAULT one only disables the gate.
  explicit: boolean;
}

/**
 * Where the dictionary lives: `$TG_DICT_PATH` when set (and non-empty), else
 * `~/.claude/DICT.json`. With neither an override nor a `HOME` there is no
 * default location, so the gate is disabled (`null`) — the entrypoint never
 * builds a literal `~/...` path that cannot resolve. Pass the MERGED config env
 * (`~/.config/tg-cli/.env` under the real environment), like every other
 * TG_* setting. Pure.
 */
export function resolveDictionaryPath(env: { TG_DICT_PATH?: string; HOME?: string }): DictionaryLocation | null {
  if (env.TG_DICT_PATH) return { path: env.TG_DICT_PATH, explicit: true };
  if (env.HOME) return { path: join(env.HOME, '.claude', 'DICT.json'), explicit: false };
  return null;
}
