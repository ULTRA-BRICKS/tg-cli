import { expect, test } from 'bun:test';
import { decodeHtmlEntities } from '../features/render/html';
import {
  detectTableKind,
  escapeCell,
  hasWideGlyph,
  parseTableRows,
  pipeTableToHtml,
  renderTable,
  toTablePre,
} from '../features/render/table';

// --- parseTableRows ---

test('parses TSV rows, trims cells, drops blank lines', () => {
  const { rows } = parseTableRows('task\tstatus\nship\tdone\n\n  review  \t  wip  ');
  expect(rows).toEqual([
    ['task', 'status'],
    ['ship', 'done'],
    ['review', 'wip'],
  ]);
});

test('parses pipe-delimited rows (`a | b`)', () => {
  const { rows } = parseTableRows('task | status\nship | done');
  expect(rows).toEqual([
    ['task', 'status'],
    ['ship', 'done'],
  ]);
});

test('TSV wins over pipe when both appear in a line', () => {
  // A tab is unambiguous; a pipe inside a cell must stay content.
  const { rows } = parseTableRows('a|b\tc');
  expect(rows).toEqual([['a|b', 'c']]);
});

test('a line with no delimiter is a single-cell row', () => {
  const { rows } = parseTableRows('just one column');
  expect(rows).toEqual([['just one column']]);
});

test('strips trailing CR (CRLF input)', () => {
  const { rows } = parseTableRows('a\tb\r\nc\td\r');
  expect(rows).toEqual([
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

// --- hasWideGlyph / wide detection ---

test('hasWideGlyph detects emoji and CJK, not ASCII/Cyrillic', () => {
  expect(hasWideGlyph('done')).toBe(false);
  expect(hasWideGlyph('готово')).toBe(false); // Cyrillic is single-width
  expect(hasWideGlyph('done ✅')).toBe(true);
  expect(hasWideGlyph('完了')).toBe(true);
});

test('parseTableRows flags hasWide when a cell carries a double-width glyph', () => {
  expect(parseTableRows('a\tb').hasWide).toBe(false);
  expect(parseTableRows('a\t✅').hasWide).toBe(true);
});

// --- renderTable: alignment + borders ---

test('renders an aligned box-drawn table; columns padEnd to the widest cell', () => {
  const out = renderTable([
    ['task', 'status'],
    ['ship', 'done'],
    ['review-cli', 'wip'],
  ]);
  const lines = out.split('\n');
  // Header separator present (a sep row under row 0).
  expect(lines[0]).toBe('┌────────────┬────────┐');
  expect(lines[1]).toBe('│ task       │ status │');
  expect(lines[2]).toBe('├────────────┼────────┤');
  expect(lines[3]).toBe('│ ship       │ done   │');
  expect(lines[4]).toBe('│ review-cli │ wip    │');
  expect(lines[5]).toBe('└────────────┴────────┘');
  // Every content/border line is the same visual width → columns are aligned.
  const widths = new Set(lines.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('ragged rows are padded to full width', () => {
  const out = renderTable([
    ['a', 'b', 'c'],
    ['x'], // short row → padded with two empty cells
  ]);
  const lines = out.split('\n');
  const widths = new Set(lines.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('a single-row table has no separator line', () => {
  const out = renderTable([['only', 'header']]);
  const lines = out.split('\n');
  // top, the one row, bottom — no ├ separator.
  expect(lines.length).toBe(3);
  expect(lines.some((l) => l.startsWith('├'))).toBe(false);
});

test('empty grid renders nothing', () => {
  expect(renderTable([])).toBe('');
});

// --- escapeCell + toTablePre (HTML safety) ---

test('escapeCell escapes &, <, >', () => {
  expect(escapeCell('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
});

test('toTablePre wraps in <pre> and HTML-escapes cell content', () => {
  const { html } = toTablePre('name\tnote\nA <x>\tit & that');
  expect(html.startsWith('<pre>')).toBe(true);
  expect(html.endsWith('</pre>')).toBe(true);
  // Literal <, >, & in the data are escaped so they cannot break the wrapper.
  expect(html).toContain('A &lt;x&gt;');
  expect(html).toContain('it &amp; that');
  // Box-drawing glyphs are NOT HTML-special and stay verbatim.
  expect(html).toContain('┌');
  expect(html).toContain('│');
});

test('toTablePre alignment is computed on RAW cells (escaping does not skew columns)', () => {
  // `&` (1 char) becomes `&amp;` (5 chars); padding must be on the raw width so
  // the column still aligns visually in a monospace font.
  const { html } = toTablePre('h1\th2\na & b\tx');
  const body = html.replace(/^<pre>/, '').replace(/<\/pre>$/, '');
  const lines = body.split('\n');
  // The data row, with `&` un-escaped back, must be the same width as the border.
  // Single-pass decode (decodeHtmlEntities) instead of chained replaces, which
  // double-unescape `&amp;lt;` (js/double-escaping).
  const unescaped = lines.map((l) => decodeHtmlEntities(l));
  const widths = new Set(unescaped.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('toTablePre surfaces hasWide for emoji cells', () => {
  expect(toTablePre('a\tb').hasWide).toBe(false);
  expect(toTablePre('a\t✅ done').hasWide).toBe(true);
});

// --- detectTableKind (escalation-format gate) ---

test('detectTableKind: empty/plain-prose body has no table', () => {
  expect(detectTableKind('')).toBe('none');
  expect(detectTableKind('just a normal sentence, no pipes here')).toBe('none');
});

test('detectTableKind: a single stray pipe in prose does not false-positive', () => {
  expect(detectTableKind('either A|B works for me')).toBe('none');
});

test('detectTableKind: a real HTML <table> is detected', () => {
  expect(detectTableKind('<table><tr><td>a</td></tr></table>')).toBe('html');
  expect(detectTableKind('intro text\n<table>\n<tr><td>x</td></tr>\n</table>')).toBe('html');
});

test('detectTableKind: our own box-drawn <pre> table (toTablePre output) is detected', () => {
  const { html } = toTablePre('a\tb\n1\t2');
  expect(detectTableKind(html)).toBe('boxed');
});

test('detectTableKind: >=2 markdown pipe-delimited rows are detected', () => {
  const body = ['| Option | Tradeoff |', '| --- | --- |', '| A | slower |'].join('\n');
  expect(detectTableKind(body)).toBe('pipe');
});

test('detectTableKind: a single pipe row alone is NOT enough (needs >=2 rows)', () => {
  expect(detectTableKind('| Option | Tradeoff |')).toBe('none');
});

// Review finding: boolean-OR code prose (`a || b`) has >=2 pipes per line and
// >=2 such lines, but is NOT a table — a markdown separator row is required
// too (real pipe tables always have one; code never does).
test('detectTableKind: boolean-OR code prose does NOT false-positive as a pipe table', () => {
  const body = 'if a || b\nwhile c || d';
  expect(detectTableKind(body)).toBe('none');
});

test('detectTableKind: pipe rows WITHOUT a separator row are not a table', () => {
  const body = '| Option | Tradeoff |\n| A | slower |';
  expect(detectTableKind(body)).toBe('none');
});

// Review finding: a BORDERLESS 2-column GFM table has only ONE pipe per row
// (no leading/trailing pipe). The earlier >=2-pipes-per-row threshold
// hard-REJECTED this at the parse-time gate — a false BLOCK of a legitimate
// table, worse than a false allow.
test('detectTableKind: a borderless 2-column markdown table (one pipe per row) is detected', () => {
  const body = 'Option | Tradeoff\n--- | ---\nA | slower';
  expect(detectTableKind(body)).toBe('pipe');
});

// Review finding: a bare thematic-break `---` (no pipe) must NOT count as
// the required separator row — otherwise two unrelated `||`-bearing lines
// plus an unrelated `---` divider anywhere in the body would false-positive.
test('detectTableKind: a pipe-less thematic break does NOT satisfy the separator requirement', () => {
  const body = 'if a || b\n---\nwhile c || d';
  expect(detectTableKind(body)).toBe('none');
});

// --- pipeTableToHtml: markdown pipe grid → real Telegram <table> ---
test('pipeTableToHtml: a markdown pipe table becomes a <table> with <th> header + <td> rows', () => {
  const body = ['| Option | Cons |', '| --- | --- |', '| A | slow |', '| B | risky |'].join('\n');
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(true);
  expect(html).toContain('<table>');
  expect(html).toContain('<tr><th>Option</th><th>Cons</th></tr>');
  expect(html).toContain('<tr><td>A</td><td>slow</td></tr>');
  expect(html).toContain('<tr><td>B</td><td>risky</td></tr>');
  // The markdown separator row is dropped, not rendered as a data row.
  expect(html).not.toContain('---');
});

test('pipeTableToHtml: prose around the table is preserved (and escaped when asked)', () => {
  const body = ['Ship A or B?', '| Opt | Note |', '| --- | --- |', '| A | 5 < 10 |', 'Done.'].join('\n');
  const { html, converted } = pipeTableToHtml(body, (s) => s.replace(/</g, '&lt;'));
  expect(converted).toBe(true);
  expect(html.startsWith('Ship A or B?')).toBe(true);
  expect(html.endsWith('Done.')).toBe(true);
  // Non-table prose is escaped by the provided escaper; table cells are escaped
  // by escapeCell (5 &lt; 10 lives inside a <td>).
  expect(html).toContain('<td>A</td><td>5 &lt; 10</td>');
});

test('pipeTableToHtml: a body with no pipe table is returned unchanged (converted=false)', () => {
  const { html, converted } = pipeTableToHtml('just prose, no table');
  expect(converted).toBe(false);
  expect(html).toBe('just prose, no table');
});

test('pipeTableToHtml: pipe lines with NO separator row are treated as prose, not a table', () => {
  // `a || b` code prose must not become a table.
  const { converted } = pipeTableToHtml('if a || b\nwhile c || d');
  expect(converted).toBe(false);
});

test('pipeTableToHtml: an existing real <table> is left alone (not double-wrapped)', () => {
  const body = '<table><tr><td>a</td></tr></table>';
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(false);
  expect(html).toBe(body);
});

test('pipeTableToHtml: a pipe-bearing prose line ABOVE the grid is not absorbed as the header', () => {
  // "Choose A | B" precedes a real GFM table; it must stay prose, and the real
  // header (Option/Cons) must not be displaced into a data row.
  const body = ['Choose A | B', '| Option | Cons |', '| --- | --- |', '| A | slow |'].join('\n');
  const { html, converted } = pipeTableToHtml(body, (s) => s);
  expect(converted).toBe(true);
  expect(html).toContain('<tr><th>Option</th><th>Cons</th></tr>');
  expect(html).toContain('<tr><td>A</td><td>slow</td></tr>');
  // The prose line is preserved as text, NOT turned into a <th>/<td> row.
  expect(html).toContain('Choose A | B');
  expect(html).not.toContain('<th>Choose A</th>');
});

// --- tg-cli#210: code fences / <pre> / <code> are content, not tables ---

const GRID = ['| Option | Cons |', '| --- | --- |', '| A | slow |'].join('\n');

test('#210: detectTableKind ignores a pipe grid inside a ``` or ~~~ fence', () => {
  expect(detectTableKind(['```md', GRID, '```'].join('\n'))).toBe('none');
  expect(detectTableKind(['~~~', GRID, '~~~'].join('\n'))).toBe('none');
});

test('#210: detectTableKind ignores a pipe grid inside <pre> or <code>', () => {
  expect(detectTableKind(`<pre>${GRID}</pre>`)).toBe('none');
  expect(detectTableKind(`<pre><code class="language-md">\n${GRID}\n</code></pre>`)).toBe('none');
});

test('#210: pipeTableToHtml leaves a fenced grid verbatim but converts a real grid after it', () => {
  const body = ['Example:', '```', GRID, '```', 'Actual:', GRID].join('\n');
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(true);
  expect(html).toContain(['```', GRID, '```'].join('\n'));
  expect(html.match(/<table>/g)).toHaveLength(1);
});

// --- tg-cli#218: every pipe grid converts, even next to an existing table ---

test('#218: a pipe grid after an existing HTML <table> is converted; the HTML table is untouched', () => {
  const existing = '<table><tr><td>a</td></tr></table>';
  const { html, converted } = pipeTableToHtml(`${existing}\n${GRID}`);
  expect(converted).toBe(true);
  expect(html.startsWith(existing)).toBe(true);
  expect(html).toContain('<tr><th>Option</th><th>Cons</th></tr>');
});

test('#218: a pipe grid after our own boxed --table <pre> is converted too', () => {
  const { html: boxed } = toTablePre('a\tb\n1\t2');
  const { html, converted } = pipeTableToHtml(`${boxed}\n${GRID}`);
  expect(converted).toBe(true);
  expect(html).toContain(boxed);
  expect(html).toContain('<tr><td>A</td><td>slow</td></tr>');
});

test('#218: two separate pipe grids both convert', () => {
  const { html } = pipeTableToHtml(`${GRID}\n\nand\n\n${GRID}`);
  expect(html.match(/<table>/g)).toHaveLength(2);
});

// --- tg-cli#221: ragged rows are normalized to the header's column count ---

test('#221: a short data row is padded and a long one truncated to the header width', () => {
  const body = ['| A | B | C |', '| --- | --- | --- |', '| 1 |', '| 1 | 2 | 3 | 4 | 5 |'].join('\n');
  const { html } = pipeTableToHtml(body);
  expect(html).toContain('<tr><td>1</td><td></td><td></td></tr>');
  expect(html).toContain('<tr><td>1</td><td>2</td><td>3</td></tr>');
  expect(html).not.toContain('<td>4</td>');
});

test('#221: a degenerate empty row is skipped, not emitted as an empty <tr>', () => {
  const body = ['| A | B |', '| --- | --- |', '| |', '|  |  |', '| 1 | 2 |'].join('\n');
  const { html } = pipeTableToHtml(body);
  expect(html).toBe('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
});

// Review finding: the code mask must use the same offsets as the body — a
// CRLF body with a multi-line <pre> above a real grid must still convert it.
test('#210: a CRLF body with a multi-line <pre> above a real grid still converts the grid', () => {
  const body = '<pre>\r\nLLLLLLLLLL\r\n</pre>\r\n| H | I |\r\n| --- | --- |\r\n| 1 | 2 |';
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(true);
  expect(html).toContain('<tr><th>H</th><th>I</th></tr>');
});

// Review finding: a header line that is only a border pipe has no columns —
// it is not a table, and its rows must not be swallowed into empty <tr>s.
test('#221: a grid whose header has no cells stays prose', () => {
  const body = '|\n|-|\n|a|';
  expect(pipeTableToHtml(body)).toEqual({ html: body, converted: false });
});

// Review finding: prose that MENTIONS a tag ("the <code> tag") is not an
// unclosed code element swallowing the rest of the body.
test('#210: a bare "<code>" / "<pre>" mention in prose does not hide a later grid', () => {
  for (const mention of ['Wrap it in the <code> tag.', 'Use <pre> for alignment.']) {
    const { converted } = pipeTableToHtml(`${mention}\n${GRID}`);
    expect({ mention, converted }).toEqual({ mention, converted: true });
  }
});

// Review finding: two grids with no line between them are two tables.
test('#218: back-to-back grids with no separating line convert to two tables', () => {
  const second = ['| C | D |', '| - | - |', '| 3 | 4 |'].join('\n');
  const { html } = pipeTableToHtml(`${GRID}\n${second}`);
  expect(html.match(/<table>/g)).toHaveLength(2);
  expect(html).toContain('<tr><th>C</th><th>D</th></tr>');
});

// Review finding: an inline <code> element INSIDE a cell is cell content; it
// must not turn its row into "code" and break the grid apart.
test('#210: a grid row with an inline <code> cell still converts with the grid', () => {
  const body = ['| Name | Snippet |', '| --- | --- |', '| init | <code>a=1</code> |', '| run | plain |'].join('\n');
  const { html } = pipeTableToHtml(body);
  expect(html).toContain('<tr><td>init</td><td>&lt;code&gt;a=1&lt;/code&gt;</td></tr>');
  expect(html).toContain('<tr><td>run</td><td>plain</td></tr>');
});

// Review finding: a fence closes only on a line that is JUST the fence.
test('#210: a ``` line with trailing text inside a fence does not close it', () => {
  const body = ['```', '``` js -- a fence starter shown literally', GRID, '```'].join('\n');
  expect(pipeTableToHtml(body).converted).toBe(false);
});

// Review finding: a pipe inside an inline-code cell or an escaped \| is cell
// text, not a column divider.
test('#221: a pipe inside `inline code` or escaped as \\| stays inside its cell', () => {
  const body = ['| Command | Description |', '| --- | --- |', '| `a|b` | pipe cmd |', '| x \\| y | escaped |'].join('\n');
  const { html } = pipeTableToHtml(body);
  expect(html).toContain('<tr><td>`a|b`</td><td>pipe cmd</td></tr>');
  expect(html).toContain('<tr><td>x | y</td><td>escaped</td></tr>');
});

// Review finding: on CRLF input a fence still closes on its `\r`-ended line.
test('#210: a closed fence in a CRLF body does not hide a later grid', () => {
  const body = ['```', 'code', '```', '| H | I |', '| --- | --- |', '| 1 | 2 |'].join('\r\n');
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(true);
  expect(html).toContain('<tr><th>H</th><th>I</th></tr>');
});

// Review finding: the code region that opens first owns its lines.
test('#210: a ``` inside <pre> opens no fence; a <pre> inside a fence opens no element', () => {
  const fenceInPre = `<pre>\n\`\`\`\n</pre>\n${GRID}`;
  expect(pipeTableToHtml(fenceInPre).converted).toBe(true);
  const preInFence = `\`\`\`\n<pre> shown literally\n\`\`\`\n${GRID}\nthe </pre> tag`;
  expect(pipeTableToHtml(preInFence).converted).toBe(true);
});

// Review finding: a rule between every row is decoration, not a new header.
test('#218: a decorative separator between data rows keeps one table', () => {
  const body = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| --- | --- |', '| 3 | 4 |'].join('\n');
  expect(pipeTableToHtml(body).html).toBe(
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>',
  );
});

// Review finding: a degenerate header/separator pair does not swallow a
// valid grid later in the same pipe block.
test('#221: a degenerate header pair does not stop a later grid in the block', () => {
  const body = ['|', '|-|', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(true);
  expect(html).toContain('<tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr>');
});

// Review finding: the code scan is linear — a long log body and a body full
// of unclosed <code> tags convert without a per-line rescan of the rest.
test('#210: large bodies with many lines or unclosed code tags stay fast', () => {
  const started = performance.now();
  pipeTableToHtml(`${'<code>'.repeat(11000)}|\n${GRID}`);
  pipeTableToHtml('log line | x\n'.repeat(50000));
  expect(performance.now() - started).toBeLessThan(2000);
});
