// Unit tests for the pure decision-request-format validator
// (features/cli/escalation-format.ts) — the machine-checkable half of the
// decision-request-discipline skill enforced for --tag decision.
import { expect, test } from 'bun:test';
import { validateEscalationFormat } from '../features/cli/escalation-format';

// A body that satisfies EVERY required section, laid out as a structured Rich
// Message: table with pros/cons, a recommendation, a file:line "where to look",
// context prose, >=2 headings, a <ul>, and <hr> dividers.
const COMPLIANT = [
  '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
  '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
  '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
  '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
].join('\n');

test('a fully-compliant structured body passes with no missing sections', () => {
  const r = validateEscalationFormat(COMPLIANT);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('plain prose fails every content + structure section', () => {
  const r = validateEscalationFormat('should we ship A or B?');
  expect(r.ok).toBe(false);
  // options/list, pros/cons, recommendation, where-to-look, context, headings,
  // list, hr — the whole checklist.
  expect(r.missing.length).toBeGreaterThanOrEqual(6);
});

test('a bare table (no recommendation/context/structure) is not enough', () => {
  const body = ['| Option | Cons |', '| --- | --- |', '| A | slow |'].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  const joined = r.missing.join('\n');
  expect(joined).toContain('recommendation');
  expect(joined).toContain('heading');
});

test('Russian recommendation / pros-cons / where-to-look keywords are recognized', () => {
  const body = [
    '<h3>Контекст</h3><p>Резолвер в features/foo.ts:42 выбирает не тот элемент при холодных мапах.</p><hr>',
    '<h3>Опции</h3><table><tr><th>Вариант</th><th>Плюсы</th><th>Минусы</th></tr>',
    '<tr><td>A</td><td>быстро</td><td>риск</td></tr><tr><td>Б</td><td>надёжно</td><td>медленно</td></tr></table><hr>',
    '<h3>Рекомендация</h3><ul><li>Рекомендую A, потому что быстрее</li></ul><hr>',
    '<h4>Где смотреть</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
});

test('an inline comma-run enumeration ("плюсы: a, b, c, d") is flagged as a wall of text', () => {
  // Otherwise-structured, but the pros are jammed into one prose line.
  const body = [
    '<h3>Context</h3><p>features/foo.ts:42 misbehaves on cold maps quite often.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th></tr><tr><td>A</td><td>x</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>recommend A</li></ul>',
    'плюсы: быстро, безопасно, дешево, просто',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Readability');
});

test('a recommendation-only single-item list is NOT an options section', () => {
  // A <ul> with one <li> (a recommendation) plus pros/cons words in prose must
  // not satisfy the Options requirement — no table, <2 list items.
  const body = [
    '<h3>Context</h3><p>features/foo.ts:42 misbehaves on cold maps sometimes.</p><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because its pros outweigh its cons</li></ul><hr>',
    '<h4>Where to look</h4><p>features/foo.ts:42</p>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Options');
});

test('a body with no concrete file reference fails the where-to-look requirement', () => {
  const body = [
    '<h3>Context</h3><p>The click resolver misbehaves on cold maps quite often now.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Where to look');
});

test('a single run-on paragraph longer than the wall threshold is flagged', () => {
  const wall = 'A'.repeat(400);
  const body = [
    `<h3>Context</h3><p>${wall}</p><hr>`,
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>recommend A, see features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).toContain('Readability');
});

// --- Regression coverage for tg-cli#261 ---------------------------------
//
// Root cause: hasWallOfText split the body on LITERAL '\n' only. A fully
// structured Rich Message (headings/table/list/<hr>) typed or assembled as
// one continuous string — with no literal newline between sections — still
// renders as separate visual lines in Telegram (block-level tags force
// their own line), but the raw source string is one giant "line" whose
// character count trivially blows past WALL_LINE_CHARS the moment the
// content is realistic (a real file path, an extra table row, a second
// recommendation bullet). The reported "template passes / any real content
// fails" pattern is exactly this: the toy template joined into one line is
// 345 chars (just under the 350 threshold); the same shape with one real
// filename swapped in is 538. Fixed by giving hasWallOfText a virtual line
// break after each block-level tag boundary before scanning, so the same
// content produces the same result regardless of the caller's literal-\n
// formatting choice. See tg-cli#261 for the `tg --dry-run` transcript that
// reproduced this before the fix.
test('a realistic body assembled as ONE continuous line (no literal \\n) passes', () => {
  // Same content as COMPLIANT, but joined with '' instead of '\n' — the
  // exact shape that reproduced tg-cli#261 (fails before this fix, passes
  // after).
  const oneLine = COMPLIANT.replace(/\n/g, '');
  const r = validateEscalationFormat(oneLine);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('a genuine run-on paragraph on one continuous line still fails Readability', () => {
  // The fix must not turn hasWallOfText into a no-op: an actual wall of
  // text glued to the rest of a one-line body is still a wall of text.
  const wall = 'A'.repeat(400);
  const oneLine = COMPLIANT.replace('The resolver in features/foo.ts:42 picks the wrong click target on cold maps.', wall).replace(
    /\n/g,
    '',
  );
  const r = validateEscalationFormat(oneLine);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Readability');
});

test('a single long <li> item sharing a source line with its <h3> heading is still excluded', () => {
  // The Recommendation line below is "<h3>Recommendation</h3><ul><li>…</li></ul><hr>"
  // as ONE array element (no literal \n inside it), so pre-fix it starts
  // with "<h3", escapes the skip-list, and WOULD have been flagged as a
  // wall of text (this is new correct behavior, not a preserved one).
  // withVisualLineBreaks breaks BEFORE opening tags and AFTER closing ones,
  // so post-fix "<li>…</li>" lands on its own line and the skip-list's
  // "line starts with <li" exclusion applies there. Breaking after the
  // opening tag instead (splitting the element from its own content) would
  // defeat that exclusion and wrongly flag a long-but-valid list item.
  const longItem = 'x'.repeat(360);
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    `<h3>Recommendation</h3><ul><li>${longItem}</li></ul><hr>`,
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).not.toContain('Readability');
});

test('a long <blockquote> is excluded from the wall check, same as <pre>', () => {
  // blockquote joins the break set (it is block-level in Telegram, same as
  // <pre>) — it must also join the skip-list, or a long-but-legitimate
  // quoted block gets flagged post-normalization even though the
  // equally-long <pre> case does not.
  const longQuote = 'y'.repeat(360);
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    `<h3>Recommendation</h3><ul><li>see quote</li></ul><blockquote>${longQuote}</blockquote><hr>`,
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).not.toContain('Readability');
});

test('someone else\'s quoted words in a <blockquote> do NOT satisfy the Context prose requirement', () => {
  // Caught in review: hasWallOfText's skip-list gained blockquote (same as
  // pre) but hasContextProse's did not, so a body whose only ≥20-letter
  // non-table line was a QUOTED block (not the agent's own prose) could
  // satisfy "Context — a sentence of prose" via someone else's words. Both
  // skip-lists must agree on blockquote.
  const longQuote = 'z'.repeat(30);
  const body = [
    '<h3>Context</h3><blockquote>' + longQuote + '</blockquote><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

test('a <pre> code dump does NOT satisfy the Context prose requirement', () => {
  // Same class as the <blockquote> case above (caught in the same review
  // round): a <pre> code sample is even less the agent's own explanatory
  // prose than a quote. hasContextProse's skip-list must exclude pre/code
  // the same way hasWallOfText's already does.
  const body = [
    '<h3>Context</h3><pre>const r = await fetchSomethingFromApi(url);</pre><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

test('a one-line body with "Pros:" and its 3rd comma in DIFFERENT visual sections is not falsely flagged', () => {
  // INLINE_ENUM_RE must be scoped to the normalized (post-line-break) body,
  // not the raw one-line string — otherwise "Pros:" in the Context sentence
  // and the 3 commas in the (unrelated) Recommendation sentence match
  // across a section boundary that only exists once literal newlines are
  // removed, giving the same content two different verdicts depending on
  // the caller's newline formatting. Neither section alone has 3 commas
  // after a pros/cons label.
  const body =
    '<h3>Context</h3><p>Pros: see the table below for details.</p><hr>' +
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>fast</td><td>risky</td></tr></table><hr>' +
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster, safer, cheaper, and simpler</li></ul><hr>' +
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>';
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).not.toContain('Readability');
});

test('a genuine inline enumeration crammed into one <li> is still caught, in both newline and one-line form', () => {
  // INLINE_ENUM_RE moved to run per visual line (see above), not the whole
  // raw body — but it still runs BEFORE the table/list skip-list, so a real
  // "Плюсы: a, b, c," jammed into a single bullet (instead of one <li> per
  // item) is caught exactly as before, whether or not the caller used
  // literal newlines.
  const withNewlines = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>Плюсы: быстро, безопасно, дешево, просто</li></ul>',
  ].join('\n');
  expect(validateEscalationFormat(withNewlines).missing.join('\n')).toContain('Readability');

  const oneLine = withNewlines.replace(/\n/g, '');
  expect(validateEscalationFormat(oneLine).missing.join('\n')).toContain('Readability');
});

test('a real, non-template file path satisfies the where-to-look requirement', () => {
  // A real repo-relative workflow path. FILE_REF_RE does not special-case
  // the template's own "features/foo.ts:42" example (the other tests below
  // reuse it freely) — this test exists to confirm an unrelated, longer,
  // dot-prefixed real path matches the same way, not that the validator
  // treats "real" paths differently from the placeholder.
  const body = [
    '<h3>Context</h3><p>.github/workflows/self-hosted-runner-smoke.yml:1 flakes on cold docker starts.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>.github/workflows/self-hosted-runner-smoke.yml:1</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('a 3-row Options table with short 2-word cells still counts as a real table', () => {
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast build</td><td>risky call</td></tr>',
    '<tr><td>B</td><td>safe path</td><td>slow build</td></tr>',
    '<tr><td>C</td><td>middle ground</td><td>extra work</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('a 2-item Recommendation list is not penalized for having more than one bullet', () => {
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A wins on speed</li><li>B loses on latency</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

// hasContextProse requires >=20 \p{L}/\p{N} characters SOMEWHERE on a
// single non-markup line — it is not scoped to the line under the "Context"
// heading, and tag names inside an unexcluded line (e.g. the "p" in
// `<p>`/`</p>`) count toward the total same as prose does. Both are
// consistent with this file's documented bias toward false positives over
// false negatives (see the file header): a real decision-request always has
// SOME real sentence somewhere, so scanning the whole body for one is
// deliberately generous, not scoped per-section. These tests pin the exact
// character count on a bare, tag-free line so the boundary is unambiguous;
// isolating it that way is required because a full compliant body has OTHER
// qualifying lines (e.g. the Context <p> sentence itself in COMPLIANT) that
// would satisfy this check regardless of a bare-string input's own length —
// these tests call validateEscalationFormat directly on a minimal string, not
// a full compliant body, precisely to isolate the 20-char boundary.
const CONTEXT_MISSING_LABEL = 'Context — a sentence of prose';

test('exactly 20 letter/digit chars of prose satisfies the Context requirement', () => {
  const r = validateEscalationFormat('A'.repeat(20));
  expect(r.missing.join('\n')).not.toContain(CONTEXT_MISSING_LABEL);
});

test('19 letter/digit chars of prose is one short and fails the Context requirement', () => {
  const r = validateEscalationFormat('A'.repeat(19));
  expect(r.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

test('20 Cyrillic letters (\\p{L}, non-ASCII) also satisfy the Context requirement', () => {
  // Rules out a counting bug specific to non-ASCII scripts — the reporter's
  // original claim was bilingual and did not specify which language broke.
  const r = validateEscalationFormat('ф'.repeat(20));
  expect(r.missing.join('\n')).not.toContain(CONTEXT_MISSING_LABEL);
});

test('a one-line structured body with NO real prose sentence still fails Context, same as its newline form', () => {
  // Caught in review of this same PR: hasContextProse originally split on
  // literal '\n' only (unlike hasWallOfText, which got the tg-cli#261
  // withVisualLineBreaks fix). A one-line body is one "line" starting with
  // "<h3" — not in hasContextProse's skip-list — so the >=20-char word count
  // ran over the WHOLE glued body including tag names ("h","3","C","o","n",
  // "t","e","x","t",…), trivially clearing 20 chars from markup alone and
  // auto-passing Context with zero real prose. The newline form of the exact
  // same content correctly fails. Both forms must agree.
  const body = [
    '<h3>Context</h3><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const oneLine = body.replace(/\n/g, '');

  const withNewlines = validateEscalationFormat(body);
  const glued = validateEscalationFormat(oneLine);
  expect(withNewlines.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
  expect(glued.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

// --- tg-cli#217 / #221: "where to look" must be a real file:line ---------

const WHERE_MISSING_LABEL = 'Where to look';

// COMPLIANT with every `features/foo.ts:42` swapped for `ref`.
function compliantWithRef(ref: string): string {
  return COMPLIANT.replaceAll('features/foo.ts:42', ref);
}

test('#217: a path or file name WITHOUT a :line suffix does not satisfy where-to-look', () => {
  for (const ref of ['features/foo.ts', 'foo.ts', 'features/cli']) {
    const r = validateEscalationFormat(compliantWithRef(ref));
    expect({ ref, missing: r.missing.join('\n') }).toEqual({ ref, missing: expect.stringContaining(WHERE_MISSING_LABEL) });
  }
});

test('#217: a genuine file:line still satisfies where-to-look (extension, slashed path, Makefile)', () => {
  for (const ref of ['features/foo.ts:42', 'foo.ts:42', 'features/cli/args:12', 'Makefile:12', './tg:1219']) {
    const r = validateEscalationFormat(compliantWithRef(ref));
    expect({ ref, missing: r.missing }).toEqual({ ref, missing: [] });
  }
});

test('#221: and/or, A/B, a 12:30 time and step:2 are not file references', () => {
  for (const ref of ['and/or', 'A/B', '12:30', 'step:2']) {
    const r = validateEscalationFormat(compliantWithRef(ref));
    expect({ ref, missing: r.missing.join('\n') }).toEqual({ ref, missing: expect.stringContaining(WHERE_MISSING_LABEL) });
  }
});

test('#217: a forge #L<n> line anchor is a file:line reference', () => {
  const ref = 'https://git.hyperide.ai/ultrabricks/tg-cli/src/branch/main/features/foo.ts#L42';
  expect(validateEscalationFormat(compliantWithRef(ref)).missing).toEqual([]);
});

// --- tg-cli#216: sections are validated by their own boundaries ----------

const OPTIONS_MISSING_LABEL = 'Options as a real table';
const PROS_CONS_MISSING_LABEL = 'Pros/cons';
const RECOMMENDATION_MISSING_LABEL = 'A recommendation';

test('#216: bullets from unrelated sections do not add up to an Options section', () => {
  // One bullet under Recommendation + one under Where to look = 2 <li> in the
  // body, but no section offers two options.
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target; pros and cons below.</p><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(OPTIONS_MISSING_LABEL);
});

test('#216: a two-bullet list under an Options heading is a real options section', () => {
  const body = COMPLIANT.replace(
    /<h3>Options<\/h3><table>[\s\S]*?<\/table>/u,
    '<h3>Options</h3><ul><li>A — pros: fast, cons: risky</li><li>B — pros: safe, cons: slow</li></ul>',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#216: a single-option table is not an options section', () => {
  const body = COMPLIANT.replace('<tr><td>B</td><td>safe</td><td>slow</td></tr>', '');
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(OPTIONS_MISSING_LABEL);
});

test('#216: a single-option markdown pipe grid is not an options section either', () => {
  const body = COMPLIANT.replace(
    /<table>[\s\S]*?<\/table>/u,
    '\n| Option | Pros | Cons |\n| --- | --- | --- |\n| A | fast | risky |\n',
  );
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(OPTIONS_MISSING_LABEL);
});

test('#216: an options table whose pros/cons cells are empty fails Pros/cons', () => {
  const body = COMPLIANT.replace('<td>fast</td><td>risky</td>', '<td></td><td></td>').replace(
    '<td>safe</td><td>slow</td>',
    '<td> </td><td></td>',
  );
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(PROS_CONS_MISSING_LABEL);
});

test('#216: an empty Recommendation section (heading + divider only) fails the recommendation check', () => {
  const body = COMPLIANT.replace('<ul><li>I recommend A because it is faster</li></ul>', '');
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(RECOMMENDATION_MISSING_LABEL);
});

// --- tg-cli#259: wall-of-text measures VISIBLE text, not raw markup -------

test('#259: a single-line body with h3/table/ul(3 li)/hr sections well over 350 chars passes', () => {
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li><li>B — also fine</li><li>C — last resort</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('');
  expect(body.length).toBeGreaterThan(350);
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#259: link markup does not count toward a paragraph length — only the visible text does', () => {
  const href = `https://git.hyperide.ai/ultrabricks/tg-cli/src/branch/main/features/cli/${'x'.repeat(300)}.ts`;
  const body = COMPLIANT.replace(
    '<p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p>',
    `<p>The resolver in <a href="${href}">features/foo.ts:42</a> picks the wrong click target on cold maps.</p>`,
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#259: a genuine plain-prose paragraph over 350 visible chars still fails Readability', () => {
  const prose = 'The resolver picks the wrong click target on cold maps and nobody knows why yet. '.repeat(5);
  const body = COMPLIANT.replace(
    '<p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p>',
    `<p>${prose}</p>`,
  );
  expect(validateEscalationFormat(body).missing.join('\n')).toContain('Readability');
});

// --- tg-cli#270: virtual line breaks respect <pre>/<code>; full block-tag set ---

test('#270: a long <pre> line holding tag-shaped TEXT is not split into a wall of text', () => {
  const code = `renders as "<h3>" + ${'x'.repeat(400)}`;
  const body = COMPLIANT.replace('<hr>\n<h3>Options', `<pre>${code}</pre><hr>\n<h3>Options`);
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#270: <details>/<summary>/<aside> get virtual line breaks like other block tags', () => {
  const long = 'B'.repeat(200);
  // Each block holds 200 visible chars and renders on its own line; glued
  // without newlines they must not read as one >350-char line.
  const body = COMPLIANT.replace(
    '<hr>\n<h3>Options',
    `<details><summary>${long}</summary>${long}</details><aside>${long}</aside><aside>${long}</aside><hr>\n<h3>Options`,
  ).replace(/\n/g, '');
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#270: <caption>/<thead>/<tbody> inside a one-line options table keep it a table', () => {
  const body = COMPLIANT.replace(
    '<table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    `<table><caption>${'Choices '.repeat(30)}</caption><thead><tr><th>Option</th><th>Pros</th><th>Cons</th></tr></thead><tbody>`,
  )
    .replace('</table>', '</tbody></table>')
    .replace(/\n/g, '');
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

// --- review findings on the section-aware rewrite ---

test('#216 review: a filled decoy table under Context does not launder an empty Options table', () => {
  const body = COMPLIANT.replace(
    '<hr>\n<h3>Options',
    '<table><tr><td>Mon</td><td>9am</td></tr><tr><td>Tue</td><td>10am</td></tr></table><hr>\n<h3>Options',
  )
    .replace('<td>fast</td><td>risky</td>', '<td></td><td></td>')
    .replace('<td>safe</td><td>slow</td>', '<td></td><td></td>');
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(PROS_CONS_MISSING_LABEL);
});

test('#216 review: one option with a nested pros/cons sub-list is still ONE option', () => {
  const body = COMPLIANT.replace(
    /<h3>Options<\/h3><table>[\s\S]*?<\/table>/u,
    '<h3>Options</h3><ul><li>Option A<ul><li>pros: fast</li><li>cons: risky</li></ul></li></ul>',
  );
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(OPTIONS_MISSING_LABEL);
});

test('#216 review: two options each with a nested sub-list count as two options', () => {
  const body = COMPLIANT.replace(
    /<h3>Options<\/h3><table>[\s\S]*?<\/table>/u,
    '<h3>Options</h3><ul><li>A<ul><li>pros: fast</li></ul></li><li>B<ul><li>cons: slow</li></ul></li></ul>',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#216 review: a recommendation stated in the heading itself counts', () => {
  const body = COMPLIANT.replace(
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul>',
    '<h3>I recommend A because it is faster</h3>',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#216 review: a list under "Предлагаемые варианты" is an options list (options heading wins)', () => {
  const body = COMPLIANT.replace(
    /<h3>Options<\/h3><table>[\s\S]*?<\/table>/u,
    '<h3>Предлагаемые варианты</h3><ul><li>A — плюс: быстро</li><li>B — минус: медленно</li></ul>',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#216 review: a "# comment" line inside <pre> does not open a section', () => {
  const body = COMPLIANT.replace(
    '<ul><li>I recommend A because it is faster</li></ul>',
    '<pre>\n# install deps\nbun add x\n</pre><p>A — it is faster</p>',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#216 review: a two-option table with no <th> row keeps both options', () => {
  const body = COMPLIANT.replace('<tr><th>Option</th><th>Pros</th><th>Cons</th></tr>', '');
  expect(validateEscalationFormat(body).missing.join('\n')).not.toContain(OPTIONS_MISSING_LABEL);
});

test('#217 review: a URL host:port is not a file:line', () => {
  const r = validateEscalationFormat(compliantWithRef('http://example.com:8080/x'));
  expect(r.missing.join('\n')).toContain(WHERE_MISSING_LABEL);
});

test('#216 review: a decoy table BEFORE the first heading does not stand in for an empty Options section', () => {
  const decoy = '<table><tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table>\n';
  const body = decoy + COMPLIANT.replace(/<h3>Options<\/h3><table>[\s\S]*?<\/table>/u, '<h3>Options</h3><p>N/A</p>');
  expect(validateEscalationFormat(body).missing.join('\n')).toContain(OPTIONS_MISSING_LABEL);
});

test('#216 review: with an Options section, an incidental half-filled table elsewhere does not fail Pros/cons', () => {
  const body = COMPLIANT.replace(
    '<hr>\n<h3>Options',
    '<h3>Current behavior</h3><table><tr><th>Step</th><th>Note</th></tr><tr><td>parse</td><td></td></tr><tr><td>send</td><td>ok</td></tr></table><hr>\n<h3>Options',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});

test('#217 review: a long slash run with no line suffix is checked in linear time', () => {
  const started = performance.now();
  validateEscalationFormat(`${'a/'.repeat(16000)}.:1`);
  expect(performance.now() - started).toBeLessThan(250);
});

test('#216 review: a recommendation inside a <pre> "# comment" line still counts', () => {
  const body = COMPLIANT.replace(
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul>',
    '<h3>Decision</h3><pre>\n# I recommend A because it is simpler\n</pre>',
  );
  expect(validateEscalationFormat(body).missing).toEqual([]);
});
