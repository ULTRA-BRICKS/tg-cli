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
// renders two cells wide in a monospace font, so a row carrying one would push
// its column out of alignment. We do NOT try to width-correct (Telegram's exact
// glyph metrics are unknowable); instead we DROP the variation selectors and
// detect remaining wide glyphs so the caller can warn. This keeps columns
// aligned for the overwhelmingly-common ASCII/Cyrillic case the CTO sends.
const WIDE_GLYPH_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{AC00}-\u{D7AF}]/u;

export function hasWideGlyph(s: string): boolean {
  return WIDE_GLYPH_RE.test(s);
}

export interface ParsedTable {
  rows: string[][];
  // True when any cell carried a double-width glyph that may misalign columns.
  // The caller surfaces a one-line stderr note; the table still renders.
  hasWide: boolean;
}

// Parse delimited text into a grid of cells. Each non-empty line is a row; a
// row is split on the first delimiter that appears in it, preferring a literal
// tab (TSV) then a pipe (`a | b`). Surrounding whitespace per cell is trimmed.
// Blank lines are dropped. A line with no delimiter is a single-cell row.
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
    const cells = (delim === null ? [line] : line.split(delim)).map((c) => c.trim());
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
// A markdown table separator row, e.g. `| --- | --- |` or `--- | :--:`.
// Matched against a line that has ALREADY been confirmed to contain both '-'
// and '|' (see hasSeparatorRow below) — this pattern alone is too loose
// (matches a bare run of colons/spaces too) to gate on by itself.
const PIPE_SEPARATOR_ROW_RE = /^[\s|:-]+$/u;

export function detectTableKind(body: string): TableKind {
  if (!body) return 'none';
  if (HTML_TABLE_RE.test(body)) return 'html';
  if (BOXED_TABLE_RE.test(body)) return 'boxed';
  const lines = body.split('\n');
  const pipeRows = lines.filter((line) => (line.match(/\|/g) ?? []).length >= 1);
  // The separator row itself MUST contain a pipe (not just dashes) — a bare
  // `---` thematic break elsewhere in the body must never count.
  const hasSeparatorRow = lines.some(
    (line) => line.includes('-') && line.includes('|') && PIPE_SEPARATOR_ROW_RE.test(line),
  );
  if (pipeRows.length >= 2 && hasSeparatorRow) return 'pipe';
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
// This converter upgrades every contiguous markdown pipe-table block in a body
// to a `<table>` HTML block, leaving all non-table lines untouched (each passed
// through `escapeText` — HTML-escape when the send was plain text, identity when
// the caller already owns HTML markup). The FIRST data row of each block becomes
// the header (<th>); the markdown separator row (`--- | ---`) is dropped. A run
// of pipe lines with NO separator row is left as-is (it is ordinary prose with
// pipes, e.g. `a || b`, not a table). Pure — no I/O.
//
// A leading/trailing border pipe (`| a | b |`) yields empty edge cells on split;
// those are dropped, interior empty cells are kept.
const PIPE_SEP_LINE_RE = /^[\s|:-]+$/u;
function isPipeLine(line: string): boolean {
  return line.includes('|');
}
function isSeparatorLine(line: string): boolean {
  return line.includes('-') && line.includes('|') && PIPE_SEP_LINE_RE.test(line);
}
function splitPipeRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  // Drop the empty leading/trailing cells produced by border pipes.
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}
function renderHtmlTable(rows: string[][]): string {
  const cell = (tag: 'th' | 'td', v: string): string => `<${tag}>${escapeCell(v)}</${tag}>`;
  const rowHtml = (cells: string[], tag: 'th' | 'td'): string =>
    `<tr>${cells.map((c) => cell(tag, c)).join('')}</tr>`;
  const [header, ...bodyRows] = rows;
  const parts = [rowHtml(header, 'th'), ...bodyRows.map((r) => rowHtml(r, 'td'))];
  return `<table>${parts.join('')}</table>`;
}

export function pipeTableToHtml(
  body: string,
  escapeText: (s: string) => string = (s) => s,
): { html: string; converted: boolean } {
  // Only touch bodies whose ONLY table-ish shape is a markdown pipe grid. A
  // real <table>, our own boxed <pre>, or no table at all is left alone.
  if (detectTableKind(body) !== 'pipe') return { html: escapeText(body), converted: false };

  const lines = body.split('\n');
  const out: string[] = [];
  let block: string[] = [];
  let converted = false;

  const flushProse = (proseLines: string[]): void => {
    if (proseLines.length) out.push(escapeText(proseLines.join('\n')));
  };
  const flushBlock = (): void => {
    if (block.length === 0) return;
    // A GFM table has the separator as the row DIRECTLY under the header, so the
    // header is the line immediately before the first separator. Any pipe lines
    // BEFORE that header are prose (e.g. a "Choose A | B" sentence just above the
    // grid) — not table rows — and must not be absorbed as the header.
    const sepIdx = block.findIndex(isSeparatorLine);
    if (sepIdx >= 1) {
      flushProse(block.slice(0, sepIdx - 1)); // pipe-prose above the header
      const header = block[sepIdx - 1];
      const dataRows = block.slice(sepIdx + 1).filter((l) => !isSeparatorLine(l));
      out.push(renderHtmlTable([header, ...dataRows].map(splitPipeRow)));
      converted = true;
    } else {
      // No separator in a valid header+separator position → prose, not a table.
      flushProse(block);
    }
    block = [];
  };

  let prose: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (isPipeLine(line)) {
      if (prose.length) {
        flushProse(prose);
        prose = [];
      }
      block.push(line);
    } else {
      flushBlock();
      prose.push(line);
    }
  }
  flushBlock();
  if (prose.length) flushProse(prose);

  return { html: out.join('\n'), converted };
}
