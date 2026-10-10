// --- Monospace table renderer (`tg --table`) ---
//
// Telegram has NO native HTML table tag. The only way to show aligned columns
// is a padded monospace block wrapped in <pre> (Telegram renders <pre> in a
// fixed-width font). This module turns delimited rows into a box-drawn,
// column-aligned <pre> string. Adapted from the reference renderer
// (/tmp/mktable.ts): box-drawing borders, padEnd alignment, HTML-escaped cells.
//
// PURE — no I/O. The entrypoint reads stdin, calls parseTableRows + renderTable,
// and feeds the <pre> result into the normal send pipeline (so it composes with
// --tag / --title exactly like any other HTML message body).

// HTML-escape a cell so literal <, >, & in the data can never break the <pre>
// wrapper's parsing. Deliberately narrower than render/html.ts's escapeHtml
// (which ALSO escapes quotes, for its `<a href="...">` attribute callers,
// e.g. tasks-command.ts — PR #120 review): a table cell only ever lands as
// TEXT CONTENT inside <pre>, never an attribute value, so a raw `"`/`'` can't
// break anything here and escaping it would just show literal &quot;/&#39; in
// the rendered table. Kept local so the pure table module has no cross-
// feature import beyond what it needs.
export function escapeCell(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A double-width glyph (emoji, CJK) is ONE JS string unit wide to padEnd but
// renders two cells wide in a monospace font, and a zero-width combining mark is
// one unit that renders no cell at all, so a row carrying either would push its
// column out of alignment. We do NOT try to width-correct (Telegram's exact
// glyph metrics are unknowable); instead we detect such glyphs so the caller can
// warn. This keeps columns aligned for the overwhelmingly-common ASCII/Cyrillic
// case the CTO sends. Beyond the emoji/CJK blocks, an emoji-presentation selector
// (U+FE0F) or keycap (U+20E3) makes the sequence before it wide (`#️⃣`), and the
// fullwidth forms (`Ａ`, `！`), CJK compatibility ideographs and Hangul jamo are
// wide too. A combining mark left after NFC (parseTableRows composes `e` + U+0301
// into `é` first) has no precomposed form — `z̃`, Hebrew and Arabic points
// (tg-cli#606).
const WIDE_GLYPH_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{AC00}-\u{D7AF}\u{1100}-\u{115F}\u{3130}-\u{318F}\u{F900}-\u{FAFF}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\p{Mn}\p{Me}]/u;

// True when a cell holds a glyph whose rendered width is not one cell per string unit.
export function hasWideGlyph(s: string): boolean {
  return WIDE_GLYPH_RE.test(s);
}

export interface ParsedTable {
  rows: string[][];
  // True when any cell carried a double-width or zero-width glyph that may misalign
  // columns. The caller surfaces a one-line stderr note; the table still renders.
  hasWide: boolean;
}

// Parse delimited text into a grid of cells. Each non-empty line is a row; a
// row is split on the first delimiter that appears in it, preferring a literal
// tab (TSV) then a pipe (`a | b`). Surrounding whitespace per cell is trimmed.
// Blank lines are dropped. A line with no delimiter is a single-cell row.
// Cells are NFC-normalized: a decomposed accent (`e` + U+0301, as macOS file names
// and some keyboards produce) is two code units but one column, so padding it by
// length would shift its column left (tg-cli#606).
//
// The first row is treated by the caller as the header (renderTable draws a
// separator under row 0); this function does not special-case it.
export function parseTableRows(input: string): ParsedTable {
  const rows: string[][] = [];
  let hasWide = false;
  for (const rawLine of input.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    // TSV wins over pipe: a tab is unambiguous, a pipe might be real content.
    const delim = line.includes('\t') ? '\t' : line.includes('|') ? '|' : null;
    const cells = (delim === null ? [line] : line.split(delim)).map((c) => c.trim().normalize('NFC'));
    for (const c of cells) {
      if (hasWideGlyph(c)) hasWide = true;
    }
    rows.push(cells);
  }
  return { rows, hasWide };
}

// Render a grid of cells into a box-drawn, column-aligned monospace block. The
// first row is the header (a separator is drawn beneath it). Column widths
// auto-size to the widest cell in each column. Ragged rows are padded with
// empty trailing cells so every row spans every column. Returns the raw block
// (NOT yet wrapped in <pre> — the caller wraps + escapes via toTablePre).
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  // Normalize ragged rows to a full-width grid.
  const grid = rows.map((r) => {
    const padded = r.slice();
    while (padded.length < cols) padded.push('');
    return padded;
  });
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(...grid.map((r) => r[c].length), 1));
  }
  const bar = (l: string, m: string, r: string): string => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const top = bar('┌', '┬', '┐');
  const sep = bar('├', '┼', '┤');
  const bot = bar('└', '┴', '┘');
  const line = (cells: string[]): string => '│ ' + cells.map((cell, c) => cell.padEnd(widths[c])).join(' │ ') + ' │';

  const out: string[] = [top, line(grid[0])];
  if (grid.length > 1) out.push(sep);
  for (let i = 1; i < grid.length; i++) out.push(line(grid[i]));
  out.push(bot);
  return out.join('\n');
}

// Full pipeline: a raw delimited input string → an HTML <pre> table body ready
// to send. Alignment runs on the RAW cells (so `&`→`&amp;` escaping can't skew
// the column math — `&amp;` is 5 visible chars but renders as one), then the
// fully-rendered block is HTML-escaped as a whole. Box-drawing glyphs
// (│ ┌ ─ …) are not HTML-special, so only real cell content is escaped. The
// result is wrapped in <pre>.
export function toTablePre(input: string): { html: string; hasWide: boolean } {
  const { rows, hasWide } = parseTableRows(input);
  return { html: `<pre>${escapeCell(renderTable(rows))}</pre>`, hasWide };
}

// --- Literal-table detection (escalation-format gate) ---
//
// A cheap, pure heuristic for "does this message body already contain a
// literal table?" — used by the parse-time TAG_GATES check
// (features/cli/args.ts), the one escalation-format enforcement. Recognizes the three shapes a
// literal table can take in a tg message:
//   'html'  — a real <table> tag (--format html / a rich send).
//   'boxed' — our own box-drawn <pre> table (tg --table / toTablePre above).
//   'pipe'  — a markdown-style `a | b | c` grid typed directly in the body:
//             >=2 lines each carrying >=1 pipe, AND at least one of those
//             lines is a markdown separator row (` --- | --- `-shaped: only
//             dashes/colons/pipes/whitespace, AND itself contains a pipe).
//             The pipe-per-row minimum is 1, not 2 (review finding: a
//             borderless 2-column GFM table like `Option | Tradeoff` /
//             `--- | ---` / `A | slower` has exactly ONE pipe per row — a
//             >=2 threshold hard-REJECTED a legitimate table, worse than a
//             false allow). The separator row is what stops code prose like
//             "if a || b" / "while c || d" from false-positiving — a bare
//             `---` divider between them does NOT count as that separator
//             (review finding: it must itself contain a pipe, or two
//             `||`-bearing lines plus an unrelated thematic break elsewhere
//             in the body would false-positive as a table).
// 'none' means no literal table was found by any of the three shapes.
//
// CODE IS CONTENT (tg-cli#210): a pipe grid or a <table> inside a ```/~~~
// fence, a <pre>/<code> element, or an inline `code` span is an EXAMPLE the
// sender wants shown verbatim, not a table — those regions are ignored for the
// 'html' and 'pipe' shapes. 'boxed' is the exception: our own boxed table IS a
// <pre> block, so it is matched on the whole body.
export type TableKind = 'html' | 'boxed' | 'pipe' | 'none';

const HTML_TABLE_RE = /<table[\s>]/iu;
// The box-drawing CORNER + T-junction glyphs renderTable() emits on its
// top/bottom bars (┌┬┐ / └┴┘). Deliberately excludes the plain vertical
// divider │ AND the row-separator T/cross glyphs ├┼┤ (review finding): │
// alone is the most commonly-pasted box glyph in ordinary prose (quoted UI
// text, ASCII-art fences, a stray cell divider) and would false-positive on
// a body that never called renderTable at all. The top/bottom bar glyphs, by
// contrast, are only ever emitted by our own box-drawn table.
const BOXED_TABLE_RE = /[┌┬┐└┴┘]/u;
// A markdown table separator row, e.g. `| --- | --- |` or `--- | :--:`: only
// dashes/colons/pipes/whitespace, AND itself containing a '-' and a '|' — a
// bare `---` thematic break elsewhere in the body must never count.
const PIPE_SEP_LINE_RE = /^[\s|:-]+$/u;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/u;
// A closing fence is the fence run and nothing else (CommonMark); a CRLF
// body's trailing `\r` is line ending, not content.
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/u;
// A CLOSED <pre>/<code> element. An unclosed one is prose that merely mentions
// the tag ("wrap it in the <code> tag"), not code swallowing the rest. Opens
// and closers are found separately (no lazy `[\s\S]*?` to EOF per open), so
// a body full of unclosed tags stays linear.
const CODE_OPEN_RE = /<(pre|code)\b/giu;
const CODE_CLOSE_RE = { pre: /<\/pre\s*>/giu, code: /<\/code\s*>/giu } as const;
const INLINE_CODE_RE = /`[^`\n]*`/gu;

// Per line of `body.split('\n')`: is it code? A line is code when it is a
// fence line or inside a ```/~~~ fence (an unclosed fence runs to the end, as
// in CommonMark), or when it is touched by a <pre>/<code> element that spans
// LINES. A one-line element (`| init | <code>a=1</code> |`) is cell or prose
// content, not a code block — and a grid needs several lines, so a grid
// wrapped in code always spans lines. One forward scan: whichever code region
// opens first owns its lines, so a ``` inside a <pre> opens no fence and a
// <pre> mentioned inside a fence opens no element. Splits `body` itself so the
// line offsets match the element offsets exactly (a caller that strips `\r`
// first would skew them on CRLF input).
function codeLineMask(body: string): boolean[] {
  const lines = body.split('\n');
  const mask = lines.map(() => false);
  // The next closer at/after a position, per tag. Positions only grow, so a
  // cached hit (or a cached "none to EOF") is reused instead of rescanning.
  const closers: Partial<Record<'pre' | 'code', { from: number; at: number; end: number }>> = {};
  const nextClose = (tag: 'pre' | 'code', from: number): { at: number; end: number } => {
    const hit = closers[tag];
    if (hit && hit.from <= from && (hit.at === -1 || hit.at >= from)) return hit;
    const re = new RegExp(CODE_CLOSE_RE[tag]);
    re.lastIndex = from;
    const m = re.exec(body);
    const found = { from, at: m ? m.index : -1, end: m ? m.index + m[0].length : -1 };
    closers[tag] = found;
    return found;
  };
  const opens = new RegExp(CODE_OPEN_RE);
  let fence: string | null = null;
  let lineStart = 0;
  for (let i = 0; i < lines.length; lineStart += lines[i].length + 1, i += 1) {
    const line = lines[i];
    if (fence !== null) {
      mask[i] = true;
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_RE.exec(line)?.[1];
    if (open) {
      mask[i] = true;
      fence = open;
      continue;
    }
    // A multi-line element opening on this line masks every line it touches;
    // scanning resumes on the line after it ends. A one-line element is cell or
    // prose content; scanning continues after it on the same line.
    opens.lastIndex = 0;
    for (let m = opens.exec(line); m; m = opens.exec(line)) {
      const tag = m[1].toLowerCase() as 'pre' | 'code';
      const close = nextClose(tag, lineStart + m.index + m[0].length);
      if (close.at === -1) continue;
      const lineEnd = lineStart + line.length;
      if (close.end <= lineEnd) {
        opens.lastIndex = close.end - lineStart;
        continue;
      }
      mask[i] = true;
      while (i + 1 < lines.length && lineStart + lines[i].length < close.end) {
        lineStart += lines[i].length + 1;
        i += 1;
        mask[i] = true;
      }
      break;
    }
  }
  return mask;
}

// A line that could be a pipe-table row: it carries a pipe OUTSIDE inline code
// (`a | b` inside backticks is an example, not a cell divider).
function isPipeLine(line: string): boolean {
  return line.replace(INLINE_CODE_RE, '').includes('|');
}
function isSeparatorLine(line: string): boolean {
  return line.includes('-') && line.includes('|') && PIPE_SEP_LINE_RE.test(line);
}

export function detectTableKind(body: string): TableKind {
  if (!body) return 'none';
  const lines = body.split('\n');
  const code = codeLineMask(body);
  const prose = lines.filter((_, i) => !code[i]);
  if (HTML_TABLE_RE.test(prose.join('\n'))) return 'html';
  if (BOXED_TABLE_RE.test(body)) return 'boxed';
  if (prose.filter(isPipeLine).length >= 2 && prose.some(isSeparatorLine)) return 'pipe';
  return 'none';
}

// --- Markdown pipe table → real Telegram <table> HTML ---
//
// Telegram has NO markdown table support: a body that types its options as a
// GFM grid (`| Option | Tradeoff |` / `| --- | --- |` / `| A | slower |`)
// arrives as PLAIN TEXT — literal pipes and dashes, no table. This is the
// "таблица сломана" bug: escalation messages (and the escalation gate's own
// suggested example) use markdown pipes, so they never render as a table. The
// only body shape Telegram renders as a real bordered table is the rich-HTML
// `<table>`/<tr>/<th>/<td> tag (routed to sendRichMessage by isRichHtml).
//
// This converter upgrades EVERY contiguous markdown pipe-table block in a body
// to a `<table>` HTML block — independently, so an existing <table> or boxed
// <pre> grid elsewhere in the body does not stop it (tg-cli#218) — leaving all
// non-table lines untouched (each passed through `escapeText` — HTML-escape
// when the send was plain text, identity when the caller already owns HTML
// markup). Lines inside code (fences, <pre>/<code>) are never table rows
// (tg-cli#210). The FIRST data row of each block becomes the header (<th>); the
// markdown separator row (`--- | ---`) is dropped. A run of pipe lines with NO
// separator row is left as-is (it is ordinary prose with pipes, e.g. `a || b`,
// not a table). Pure — no I/O.
//
// A leading/trailing border pipe (`| a | b |`) yields empty edge cells on split;
// those are dropped, interior empty cells are kept. Data rows are normalized to
// the header's column count — padded with empty cells or truncated — and a row
// with no content at all (`| |`) is skipped (tg-cli#221), so Telegram never gets
// an empty or mismatched <tr>.
//
// splitPipeRow: the cells of one grid row. A `|` inside an inline-code span or
// escaped as `\|` is cell text, not a divider (GFM); `\|` renders as `|`.
function splitPipeRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      if (ch === '`') inCode = !inCode;
      cell += ch;
    }
  }
  cells.push(cell.trim());
  // Drop the empty leading/trailing cells produced by border pipes.
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}
function renderHtmlTable(header: string[], bodyRows: string[][]): string {
  const rowHtml = (cells: string[], tag: 'th' | 'td'): string =>
    `<tr>${cells.map((v) => `<${tag}>${escapeCell(v)}</${tag}>`).join('')}</tr>`;
  const rows = bodyRows
    .filter((cells) => cells.some((c) => c !== ''))
    .map((cells) => Array.from({ length: header.length }, (_, i) => cells[i] ?? ''));
  return `<table>${[rowHtml(header, 'th'), ...rows.map((r) => rowHtml(r, 'td'))].join('')}</table>`;
}

export function pipeTableToHtml(
  body: string,
  escapeText: (s: string) => string = (s) => s,
): { html: string; converted: boolean } {
  // No pipe, no grid: skip the line scans on the common plain send.
  if (!body.includes('|')) return { html: escapeText(body), converted: false };
  const code = codeLineMask(body);
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  const out: string[] = [];
  let block: string[] = [];
  let prose: string[] = [];
  let converted = false;

  const flushProse = (): void => {
    if (prose.length) out.push(escapeText(prose.join('\n')));
    prose = [];
  };
  const flushBlock = (): void => {
    let rest = block;
    block = [];
    while (rest.length > 0) {
      // A GFM table has the separator as the row DIRECTLY under the header, so
      // the header is the line immediately before the first separator. Any pipe
      // lines BEFORE that header are prose (e.g. a "Choose A | B" sentence just
      // above the grid) — not table rows — and must not be absorbed as the header.
      const sepIdx = rest.findIndex(isSeparatorLine);
      if (sepIdx < 0) {
        // No separator → prose with pipes, not a table.
        prose = prose.concat(rest);
        return;
      }
      const header = sepIdx >= 1 ? splitPipeRow(rest[sepIdx - 1]) : [];
      if (header.length === 0) {
        // A separator with no columned header above it: that pair is prose,
        // but a valid grid later in the same block still converts.
        prose = prose.concat(rest.slice(0, sepIdx + 1));
        rest = rest.slice(sepIdx + 1);
        continue;
      }
      prose = prose.concat(rest.slice(0, sepIdx - 1)); // pipe-prose above the header
      flushProse();
      // The grid runs until another header + separator pair starts the next one
      // (two grids typed back to back are two tables). A row that itself sits
      // under a separator is a data row followed by a decorative rule
      // (`| 1 | 2 |` / `| --- | --- |` between every row), not a new header.
      const startsNextGrid = (i: number): boolean =>
        !isSeparatorLine(rest[i]) && isSeparatorLine(rest[i + 1] ?? '') && !isSeparatorLine(rest[i - 1]);
      let end = sepIdx + 1;
      while (end < rest.length && !startsNextGrid(end)) end += 1;
      const dataRows = rest.slice(sepIdx + 1, end).filter((l) => !isSeparatorLine(l));
      out.push(renderHtmlTable(header, dataRows.map(splitPipeRow)));
      converted = true;
      rest = rest.slice(end);
    }
  };

  lines.forEach((line, i) => {
    if (!code[i] && isPipeLine(line)) {
      block.push(line);
    } else {
      flushBlock();
      prose.push(line);
    }
  });
  flushBlock();
  flushProse();

  // Nothing converted: hand back the body exactly as the caller would have sent it.
  if (!converted) return { html: escapeText(body), converted: false };
  return { html: out.join('\n'), converted };
}
