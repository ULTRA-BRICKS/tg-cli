// --- Full escalation-format validator (--tag decision) ---
//
// WHAT THIS IS
//   The machine-checkable half of the `decision-request-discipline` skill. A
//   `--tag decision` send is an ESCALATION: it asks the human
//   (CTO) to choose. The skill mandates a self-contained request the human can
//   answer in ~30s WITHOUT opening the repo — Context, Options with real
//   pros/cons, a Recommendation, and "where to look" (a file:line reference),
//   presented as a real table or list (not a prose paragraph the human must
//   re-derive). Before this, `tg` only WARNED (and only checked for a bare
//   table, only under an opt-in env). This validator enforces the FORMAT
//   deny-by-default (see `escalationGateEnforced`, now ON by default).
//
// WHY HEURISTIC (and bilingual)
//   The body is free-form and usually RUSSIAN (the CTO's language). There is no
//   structured schema to validate, so each required section is detected by a
//   generous bilingual signal. The checks bias toward FALSE POSITIVES (letting a
//   borderline-but-real request through) over FALSE NEGATIVES (blocking a
//   genuine escalation and wedging the agent): the documented escape
//   `ESCALATION_GATE_ENFORCE=0` exists for the rare genuine edge case. The error
//   lists EXACTLY which sections are missing so the caller can fix and resend.
//
// SECTION-AWARE (tg-cli#216)
//   Generous does not mean shape-only. The body is split at its headings and
//   each requirement is checked against real content, not mere presence of a
//   tag somewhere: Options needs ONE table with >= 2 option rows, or ONE list of
//   >= 2 items outside the Context / Recommendation / Where-to-look sections
//   (bullets from unrelated sections never add up); an options table must have
//   its tradeoff cells filled; a Recommendation heading counts only when its
//   section has content; "where to look" needs a real file:line in the TEXT
//   (tg-cli#217, #221). A `--file`/`--photo` attachment does not count; a
//   `path:line` typed in the body stays in the body, so it is seen here.
//
// PURE — no I/O. Consumed by features/cli/args.ts (parse-time gate) and the tg
// entrypoint (post-assembly re-check for --table sends).

export interface EscalationFormatResult {
  ok: boolean;
  // Human-readable labels of the missing required sections, in skill order.
  missing: string[];
}

// A recommendation: "which option I'd pick and why". Bilingual.
const RECOMMENDATION_RE =
  /\b(recommend|recommendation|i (?:suggest|propose)|my pick|i'?d pick|i would (?:pick|go with)|lean(?:ing)? toward)\b|рекоменд|предлаг|советую|склоня|выбрал бы|мой выбор|остановил бы|пошёл бы|пошел бы/iu;

// Pros/cons / tradeoffs attached to the options. Bilingual.
const PROS_CONS_RE =
  /\b(pros?|cons?|trade[- ]?offs?|advantages?|disadvantages?|upsides?|downsides?|benefits?|drawbacks?)\b|плюс|минус|компромисс|преимуществ|недостат|за и против|риск/iu;

// A concrete `file:line` pointer — the "where to look" contract (tg-cli#217).
// The file part must LOOK like a file: a slashed path (`features/cli/args:12`,
// `./tg:1219`), a name with a known code extension (`foo.ts:42`), or a
// well-known extensionless build file (`Makefile:12`). The line part is a
// `:<n>` suffix or a forge `#L<n>` anchor. A bare path with no line, and
// ordinary prose tokens such as `and/or`, `A/B`, `12:30`, `step:2` or a URL's
// `host:port`, are not references (tg-cli#221).
//
// Matched per whitespace/markup-delimited TOKEN and anchored at its start: an
// unanchored scan of a long `a/a/a/…` run would retry from every offset
// (quadratic). A URL's `scheme://host/` prefix is dropped first, so a forge
// link's path is what gets matched.
const FILE_REF_TOKEN_RE = new RegExp(
  String.raw`^(?:\.{0,2}\/)?(?:(?:[\w.-]+\/)+[\w.-]*\w` +
    String.raw`|[\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|ya?ml|md|sh|sql|toml|css|scss|html?|vue|svelte|c|cc|cpp|h|hpp|java|rb|php|swift|kt|lua|zig|ex|exs)` +
    String.raw`|Makefile|Dockerfile|Containerfile|Justfile|Rakefile|Gemfile|Procfile)(?::\d+|#L\d+)(?!\d)`,
  'iu',
);
const TOKEN_SPLIT_RE = /[\s<>"'`()[\]{},;]+/u;
const URL_PREFIX_RE = /^[a-z][\w+.-]*:\/\/[^/]*\/?/iu;

export function hasFileRef(text: string): boolean {
  return text.split(TOKEN_SPLIT_RE).some((token) => FILE_REF_TOKEN_RE.test(token.replace(URL_PREFIX_RE, '')));
}

// A <ul>/<ol>/<li> list — the readability requirement for enumerations.
const LIST_RE = /<(?:ul|ol|li)\b/iu;
// Section headings (Rich Message) — the readability requirement.
const HEADING_RE = /<h[1-6]\b/giu;
const HR_RE = /<hr\b/iu;

// --- Sections (tg-cli#216) ---
// A heading — `<h1>`..`<h6>` or a markdown `#` line — opens a section that runs
// to the next heading; text before the first heading is a section with an empty
// heading. A `#` line inside code (`<pre># install deps</pre>`, a ``` fence) is
// a comment, not a heading.
const SECTION_HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>|^[ \t]*#{1,6}[ \t]+(.+)$/gimu;
const FENCED_CODE_RE = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1|$(?![\s\S]))/gmu;
// An Options section by name — it wins over the non-options names below, so
// "Предлагаемые варианты" (proposed options) or "Options and context" is still
// an options section.
export const OPTIONS_HEADING_RE = /\b(?:options?|alternatives?|choices?)\b|вариант|опци|альтернатив/iu;
// Sections whose bullets and tables are NOT the options: Context,
// Recommendation, Where to look, Glossary. Bullets from them never satisfy Options.
const NON_OPTIONS_HEADING_RE = new RegExp(
  `${RECOMMENDATION_RE.source}|where to look|references?|links?|context|background|glossary|terms|где смотреть|ссылк|контекст|глоссари|термин`,
  'iu',
);
// The Glossary section (skill point 2): a heading that names it, or an inline
// "Глоссарий: …" / "Glossary — …" label followed by words.
const GLOSSARY_HEADING_RE = /glossary|\bterms\b|глоссари|термин|словарик/iu;
const GLOSSARY_LABEL_RE = /(?:glossary|глоссарий|термины)\s*[:：—–-]\s*[\p{L}\p{N}]/iu;
// Words a Recommendation heading uses as a mere LABEL; anything else in the
// heading ("I recommend A", "Рекомендую A") is the recommendation itself.
const RECOMMENDATION_LABEL_WORD_RE = /^(?:recommendations?|рекомендаци[яи]|my|our|моя|мои|наша|наши)[:.]?$/iu;
const TAG_RE = /<[^>]*>/gu;
const HAS_CONTENT_RE = /[\p{L}\p{N}]/u;

export interface Section {
  heading: string; // tag-stripped heading text; '' for the preamble
  body: string;
}

// <pre>/<code> elements: their contents are literal text, never markup — a
// tag-shaped string inside (`<pre>renders as "<h3>"</pre>`) or a `# comment`
// line is not a heading or a block tag (tg-cli#270).
const CODE_ELEMENT_RE = /<(pre|code)\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu;
// Rewrites the CONTENTS of every <pre>/<code> element with `mask`, keeping the
// element's own tags.
function maskCodeContents(text: string, mask: (inner: string) => string): string {
  return text.replace(CODE_ELEMENT_RE, (m, tag: string, attrs: string, inner: string) => {
    const open = `<${tag}${attrs}>`;
    return open + mask(inner) + m.slice(open.length + inner.length);
  });
}
// Same-length stand-ins for angle brackets, so tag-shaped code text is inert.
function maskAngles(code: string): string {
  return code.replace(/</gu, '‹').replace(/>/gu, '›');
}

export function splitSections(text: string): Section[] {
  // Neutralize heading syntax inside code with SAME-LENGTH stand-ins, so the
  // heading scan cannot start (or end) inside code and the offsets still slice
  // the original text.
  const neutralize = (code: string): string => maskAngles(code).replace(/^([ \t]*)#/gmu, '$1＃');
  const scanned = maskCodeContents(text, neutralize).replace(FENCED_CODE_RE, neutralize);
  const sections: Section[] = [];
  let heading = '';
  let from = 0;
  for (const m of scanned.matchAll(SECTION_HEADING_RE)) {
    sections.push({ heading, body: text.slice(from, m.index) });
    // Tag-stripped text here is only measured and pattern-matched by the gate, never rendered as HTML.
    // codeql[js/incomplete-multi-character-sanitization]
    heading = (m[2] ?? m[3] ?? '').replace(TAG_RE, '').trim();
    from = m.index + m[0].length;
  }
  sections.push({ heading, body: text.slice(from) });
  return sections;
}

// The option rows of every HTML `<table>` and markdown pipe grid in `body`,
// each row its trimmed visible cell texts. Header rows are dropped: a row of
// `<th>` only, and the grid line above the `| --- |` separator. A table with no
// `<th>` row keeps every row (no header to guess at).
function tableOptionRows(body: string): string[][][] {
  const tables: string[][][] = [];
  for (const [table] of body.matchAll(/<table\b[\s\S]*?<\/table\s*>/giu)) {
    tables.push(
      [...table.matchAll(/<tr\b[\s\S]*?<\/tr\s*>/giu)]
        .filter(([tr]) => /<td\b/iu.test(tr))
        // Cell text is only matched against option shapes, never rendered as HTML.
        // codeql[js/incomplete-multi-character-sanitization]
        .map(([tr]) => [...tr.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/giu)].map((c) => c[2].replace(TAG_RE, '').trim())),
    );
  }
  const lines = body.split('\n').map((l) => l.trim());
  for (let i = 1; i < lines.length; i += 1) {
    if (!(lines[i].includes('|') && lines[i].includes('-') && /^[\s|:-]+$/u.test(lines[i]))) continue;
    const rows: string[][] = [];
    for (let j = i + 1; j < lines.length && lines[j].includes('|'); j += 1) {
      rows.push(lines[j].replace(/^\||\|$/gu, '').split('|').map((c) => c.trim()));
    }
    tables.push(rows);
  }
  return tables;
}

// The option rows of our boxed `tg --table` grid (a `<pre>` of `│` rows; the
// first is the header).
function boxedOptionRows(body: string): string[][][] {
  return [...body.matchAll(/<pre\b[^>]*>[^<]*[┌└][\s\S]*?<\/pre\s*>/giu)].map(([pre]) =>
    pre
      .split('\n')
      .filter((l) => l.includes('│'))
      .map((l) => l.split('│').slice(1, -1).map((c) => c.trim()))
      .slice(1),
  );
}

// The item count of every top-level <ul>/<ol> in `body`. Only an outer list's
// own <li> count: a nested pros/cons sub-list under one option does not make it
// two options.
function topLevelListItemCounts(body: string): number[] {
  const counts: number[] = [];
  let depth = 0;
  for (const [, close, tag] of body.matchAll(/<(\/?)(ul|ol|li)\b[^>]*>/giu)) {
    const isList = tag.toLowerCase() !== 'li';
    if (isList && !close) {
      if (depth === 0) counts.push(0);
      depth += 1;
    } else if (isList) {
      depth = Math.max(0, depth - 1);
    } else if (!close && depth === 1) {
      counts[counts.length - 1] += 1;
    }
  }
  return counts;
}

// A "wall of text": run-on prose with no structure. Two shapes, both what the
// CTO flagged (tg#8970 — an 8-point message that was still "very hard to read"):
//   1. A single non-markup line whose VISIBLE text (tags stripped, entities
//      counted as one char — tg-cli#259) is longer than WALL_LINE_CHARS.
//   2. An inline comma-run enumeration after a pros/cons label on ONE line
//      ("плюсы: a, b, c, d") instead of a <ul> of one-line items.
const WALL_LINE_CHARS = 350;
const INLINE_ENUM_RE =
  /(?:pros?|cons?|плюсы|минусы|преимуществ\w*|недостат\w*)\s*[:：].*?,.*?,.*?,/iu;

// Block-level HTML tags that Telegram renders as a visual line break
// regardless of whether the source string contains a literal `\n` there
// (tg-cli#261: a fully-structured Rich Message typed as one continuous
// string, with no literal newline between sections, was misdiagnosed as a
// wall of text purely because its RAW string had no newlines — every
// section still renders on its own line in Telegram). The break goes
// BEFORE an opening tag and AFTER a closing/void tag — never splitting an
// element from its own tags — so `<li>…</li>` stays one line and the
// skip-list below (which matches a line's STARTING tag, e.g. `<li`) keeps
// excluding it exactly as it did for a literal-newline body. The set is every
// block element of Telegram's Rich Message tier (tg-cli#270); a tag added here
// must also be decided for BOTH skip-lists (MARKUP_LINE_RE).
const BLOCK_TAGS =
  'h[1-6]|p|tr|li|table|caption|thead|tbody|tfoot|ul|ol|blockquote|pre|details|summary|aside|footer|figure|figcaption|tg-math-block';
const OPEN_BLOCK_RE = new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'giu');
const CLOSE_BLOCK_RE = new RegExp(`</(?:${BLOCK_TAGS})\\s*>|<(?:hr|br)\\b[^>]*/?>`, 'giu');
// A visual line that is table/list/code/quote markup, not the sender's prose:
// skipped by both the wall-of-text and the Context-prose checks. <aside> is a
// pull quote (someone else's words, like <blockquote>); <tg-math-block> is a
// formula (like <pre>).
const MARKUP_LINE_RE =
  /^<\/?(?:table|tr|td|th|thead|tbody|tfoot|caption|ul|ol|li|pre|code|blockquote|aside|tg-math-block)\b/iu;
const BOXED_GLYPH_RE = /[│┌┬┐└┴┘├┼┤─]/u;
// Code contents get their angle brackets masked and their newlines folded, so
// a whole <pre>/<code> element stays on the visual line its opening tag starts.
function withVisualLineBreaks(body: string): string {
  return maskCodeContents(body, (inner) => maskAngles(inner).replace(/\r?\n/gu, ' '))
    .replace(OPEN_BLOCK_RE, (tag) => `\n${tag}`)
    .replace(CLOSE_BLOCK_RE, (tag) => `${tag}\n`);
}
export function hasWallOfText(body: string): boolean {
  for (const raw of withVisualLineBreaks(body).split('\n')) {
    const line = raw.trim();
    // INLINE_ENUM_RE runs on every visual line BEFORE the skips below (same
    // as the original whole-body check): an inline "Плюсы: a, b, c," is
    // still the pattern this exists to catch even inside a <li> or a
    // markdown table row. Scoping it to one visual line (rather than the
    // raw, possibly newline-free body) is what stops it from matching
    // across unrelated sections of a one-line body — see tg-cli#261.
    if (INLINE_ENUM_RE.test(line)) return true;
    if (line.includes('|')) continue; // table row
    if (MARKUP_LINE_RE.test(line)) continue;
    if (BOXED_GLYPH_RE.test(line)) continue; // boxed table
    // Only the visible length is used; the stripped line is never rendered as HTML.
    // codeql[js/incomplete-multi-character-sanitization]
    const visible = line.replace(TAG_RE, '').replace(/&(?:#\d+|#x[\da-f]+|\w+);/giu, '&');
    if (visible.length > WALL_LINE_CHARS) return true;
  }
  return false;
}

// A body has explanatory PROSE (the Context requirement) when at least one line
// is not part of a table/list markup and carries real words (>= 20 chars).
export function hasContextProse(body: string): boolean {
  // Same tg-cli#261 normalization as hasWallOfText: without it, a one-line
  // structured body is a single "line" that starts with `<h3` (not in the
  // skip-list below) and the word count runs over the WHOLE glued body
  // including tag names ("h", "3", "C", "o", "n", "t", "e", "x", "t", …),
  // trivially clearing 20 chars from markup alone — auto-passing Context
  // with zero real prose, while the same content with literal newlines
  // correctly fails. Caught in review of this same PR.
  for (const raw of withVisualLineBreaks(body).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.includes('|')) continue; // markdown pipe / boxed table row
    if (MARKUP_LINE_RE.test(line)) continue;
    if (BOXED_GLYPH_RE.test(line)) continue; // boxed-table glyphs
    // Count word characters so a divider line ("-----") is not "prose".
    const words = (line.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (words >= 20) return true;
  }
  return false;
}

/**
 * Validate a decision body against the decision-request-discipline
 * format. Returns `ok:true` with an empty `missing` when every required section
 * is present, else `ok:false` and the labels of what's missing (skill order).
 */
export function validateEscalationFormat(body: string): EscalationFormatResult {
  const missing: string[] = [];
  const text = body ?? '';
  const sections = splitSections(text);

  // Options must be ONE genuine multi-option structure (tg-cli#216): a table
  // with >= 2 option rows, or a single top-level list of >= 2 items. When the
  // body names an Options section, only that section counts — a table before
  // the first heading or under "Current behavior" is not the options. Without
  // one, any section but Context / Recommendation / Where to look qualifies. A
  // single bullet, a single-row table, a nested sub-list under one option, or
  // bullets scattered over unrelated sections are not options.
  const namedOptionSections = sections.filter((s) => OPTIONS_HEADING_RE.test(s.heading));
  const optionSections =
    namedOptionSections.length > 0 ? namedOptionSections : sections.filter((s) => !NON_OPTIONS_HEADING_RE.test(s.heading));
  const tables = optionSections
    .flatMap((s) => [...tableOptionRows(s.body), ...boxedOptionRows(s.body)])
    .filter((rows) => rows.length >= 2);
  const hasOptionsList = optionSections.some((s) => topLevelListItemCounts(s.body).some((n) => n >= 2));
  if (tables.length === 0 && !hasOptionsList) {
    missing.push('Options as a real table (<table> / markdown pipe grid / tg --table) or a <ul>/<ol> list of >=2 options');
  }
  // An options TABLE carries its tradeoffs in its cells: every option row of
  // every options table needs a filled cell beyond the option's own name, or
  // the pros/cons header is an empty promise.
  const tradeoffsFilled =
    hasOptionsList || tables.every((rows) => rows.every((cells) => cells.filter(Boolean).length >= 2));
  if (!PROS_CONS_RE.test(text) || !tradeoffsFilled) {
    missing.push('Pros/cons (tradeoffs) for each option — "плюсы/минусы", pros/cons');
  }
  // A recommendation phrase in the prose; a Recommendation heading that states
  // it ("I recommend A"); or a Recommendation-label heading whose section
  // actually says something — the label alone recommends nothing.
  const hasRecommendation =
    sections.some((s) => RECOMMENDATION_RE.test(s.body)) ||
    sections.some(
      (s) =>
        RECOMMENDATION_RE.test(s.heading) &&
        // Only tested for content; the stripped body is never rendered as HTML.
        // codeql[js/incomplete-multi-character-sanitization]
        (HAS_CONTENT_RE.test(s.body.replace(TAG_RE, '')) ||
          s.heading.split(/\s+/u).some((w) => HAS_CONTENT_RE.test(w) && !RECOMMENDATION_LABEL_WORD_RE.test(w))),
    );
  if (!hasRecommendation) {
    missing.push('A recommendation (which option you’d pick and why) — "рекомендация"');
  }
  // A concrete file:line is REQUIRED — a bare "where to look" phrase or a bare
  // path is useless to the reviewer.
  if (!hasFileRef(text)) {
    missing.push('Where to look — a concrete file:line reference (e.g. features/foo.ts:42) — "где смотреть"');
  }
  if (!hasContextProse(text)) {
    missing.push('Context — a sentence of prose on where the code is and what it does');
  }
  // Glossary (skill point 2, tg-cli#706): every internal name the request
  // uses — a ticket, module, flag, acronym — explained in one phrase, so the
  // CTO never has to recall the agent's jargon. A Glossary section with
  // content, or an inline "Глоссарий: …" label, counts.
  // Tag-stripped text here is only pattern-matched, never rendered as HTML.
  const hasGlossary =
    // codeql[js/incomplete-multi-character-sanitization]
    sections.some((s) => GLOSSARY_HEADING_RE.test(s.heading) && HAS_CONTENT_RE.test(s.body.replace(TAG_RE, ''))) ||
    // codeql[js/incomplete-multi-character-sanitization]
    GLOSSARY_LABEL_RE.test(text.replace(TAG_RE, ' '));
  if (!hasGlossary) {
    missing.push('Glossary — every internal name (ticket, module, flag, acronym) explained in one phrase — "глоссарий"');
  }

  // --- Readability / structure (CTO tg#8970): an 8-point message that follows
  // the content format is STILL unacceptable if it is a "wall of text". A
  // compliant escalation is a STRUCTURED Rich Message: each section under its
  // own heading, enumerations as short bullet items, dividers between sections.
  if ((text.match(HEADING_RE) ?? []).length < 2) {
    missing.push('Structure — put each section under its own <h3>/<h4> heading (needs --format html; ≥2 headings)');
  }
  if (!LIST_RE.test(text)) {
    missing.push('Structure — use <ul>/<ol> bullet lists for pros/cons and enumerations (one short item per <li>, never inline "плюсы: a, b, c")');
  }
  if (!HR_RE.test(text)) {
    missing.push('Structure — separate sections with <hr> dividers');
  }
  if (hasWallOfText(text)) {
    missing.push('Readability — break run-on paragraphs: short lines, one idea per bullet (no long dense paragraph, no inline comma-run enumeration)');
  }

  return { ok: missing.length === 0, missing };
}

/**
 * The separate decisions a body that passes validateEscalationFormat carries, one
 * label each: one per named Options section holding a real option structure, or —
 * when no section is named Options — one per option table. Always at least one. The
 * intent gate (features/cli/intent-gate.ts) asks for one reply per decision when a
 * body carries more than one. A label is the options heading; for a bare "Options"
 * heading, the heading just before it when that names a topic (not Context, Glossary…).
 */
export function decisionLabels(body: string): string[] {
  const sections = splitSections(body ?? '');
  const optionTables = (s: Section): string[][][] =>
    [...tableOptionRows(s.body), ...boxedOptionRows(s.body)].filter((rows) => rows.length >= 2);
  const topic = (i: number): string => {
    const own = sections[i].heading;
    if (!/^(?:options?|alternatives?|choices?|варианты?|опции|альтернативы)[:.]?$/iu.test(own)) return own;
    const before = i > 0 ? sections[i - 1].heading : '';
    return before && !NON_OPTIONS_HEADING_RE.test(before) ? before : '';
  };
  const named = sections.flatMap((s, i) =>
    OPTIONS_HEADING_RE.test(s.heading) && (optionTables(s).length > 0 || topLevelListItemCounts(s.body).some((n) => n >= 2))
      ? [topic(i)]
      : [],
  );
  const labels =
    named.length > 0
      ? named
      : sections.flatMap((s, i) => (NON_OPTIONS_HEADING_RE.test(s.heading) ? [] : optionTables(s).map(() => topic(i))));
  return labels.length === 0 ? ['decision 1'] : labels.map((l, i) => `decision ${i + 1}${l ? `: ${l}` : ''}`);
}

// The copy-pasteable guidance appended when a decision send is
// malformed. Shared by the parse-time gate and the pre-send-text hook so the two
// never drift.
export function escalationFormatMessage(tag: string, missing: string[]): string {
  const bullets = missing.map((m) => `  • ${m}`).join('\n');
  return (
    `--tag ${tag} is an escalation and must follow the decision-request format ` +
    `(skill: decision-request-discipline) as a STRUCTURED Rich Message, so the CTO can ` +
    `answer in ~30s without opening the repo AND without reading a wall of text. ` +
    `Missing:\n${bullets}\n` +
    `Use --format html with this shape (markdown pipe grids are auto-converted to a <table>):\n` +
    `<h3>Context</h3><p>features/foo.ts:42 does X.</p><hr>\n` +
    `<h3>Glossary</h3><ul><li>X — what the internal name means</li></ul><hr>\n` +
    `<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>` +
    `<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>\n` +
    `<h3>Recommendation</h3><ul><li>A — because …</li></ul><hr>\n` +
    `<h3>Where to look</h3><ul><li>features/foo.ts:42</li></ul>`
  );
}
