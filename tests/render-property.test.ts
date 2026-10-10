// Property tests for the pure HTML render helpers (features/render/html.ts, rich.ts,
// table.ts; tg-cli#606): escaping round-trips, tag stripping never leaves a tag behind,
// rich detection and normalization keep a body's meaning, the rich pre-flight counts what
// Telegram counts, and a rendered table stays a rectangle for any cell content.
import { expect, test } from 'bun:test';
import { decodeHtmlEntities, escapeHtml, stripHtmlTags } from '../features/render/html';
import { isRichHtml, normalizeRichHtml, RICH_LIMITS, RICH_ONLY_TAGS, validateRichHtml } from '../features/render/rich';
import { hasWideGlyph, parseTableRows, renderTable, toTablePre } from '../features/render/table';
import { ATOMS, anyText, arrayOf, forAll, type Gen, int, oneOf, pick, textOf } from './helpers/prop';

// --- html.ts ---

test('escapeHtml → decodeHtmlEntities is the identity on any text', () => {
  forAll('html-roundtrip', anyText(0, 60), (s) => {
    expect(decodeHtmlEntities(escapeHtml(s))).toBe(s);
  });
});

test('escaped text has no raw markup character and every & starts an entity', () => {
  forAll('html-escaped-shape', anyText(0, 60), (s) => {
    const e = escapeHtml(s);
    expect(e).not.toMatch(/[<>"']/);
    expect(e).not.toMatch(/&(?!(?:amp|lt|gt|quot|#39);)/);
  });
});

test('decoding is single-pass: an escaped entity decodes to the entity, never further', () => {
  forAll('html-single-pass', anyText(0, 60), (s) => {
    expect(decodeHtmlEntities(escapeHtml(escapeHtml(s)))).toBe(escapeHtml(s));
  });
});

const BASIC_TAGS = ['b', 'i', 'u', 's', 'code', 'pre', 'tg-spoiler', 'blockquote'];
// Escaped text wrapped in random nested basic tags; returns [html, the escaped text alone].
const markedUp: Gen<[string, string]> = (rng) => {
  let text = '';
  const node = (depth: number): string => {
    const t = escapeHtml(anyText(0, 8)(rng));
    text += t;
    if (depth > 3 || rng() < 0.4) return t;
    const tag = pick(BASIC_TAGS)(rng);
    const attrs = pick(['', ' class="x"', ' expandable', ` title="${escapeHtml('a>b')}"`])(rng);
    return `${t}<${tag}${attrs}>${arrayOf(() => node(depth + 1), 1, 3)(rng).join('')}</${tag}>`;
  };
  const html = arrayOf(() => node(0), 1, 4)(rng).join('');
  return [html, text];
};

test('stripHtmlTags removes exactly the tags of a marked-up body, keeping its text', () => {
  forAll('html-strip', markedUp, ([html, text]) => {
    expect(stripHtmlTags(html)).toBe(text);
  });
});

test('stripHtmlTags never leaves a tag-like fragment, even from a body cut mid-tag', () => {
  forAll('html-strip-cut', (rng) => {
    const [html] = markedUp(rng);
    return html.slice(0, int(0, html.length)(rng));
  }, (cut) => {
    expect(stripHtmlTags(cut)).not.toMatch(/<[/!A-Za-z]/);
  });
});

// --- rich.ts: detection ---

const basicLink: Gen<string> = (rng) => {
  const query = pick(['', '?name=x', '?a=1&amp;name=bob', '#name=top', '?tel=1', '/mailto:x', '?q=%3Ctable%3E'])(rng);
  const title = pick(['', ' title="name=x"', ' title="mailto:me"'])(rng);
  return `<a href="https://example.test/p${query}"${title}>${escapeHtml(anyText(1, 6)(rng))}</a>`;
};
const basicBody: Gen<string> = (rng) => arrayOf(oneOf((r) => markedUp(r)[0], basicLink, (r) => escapeHtml(pick(['<table>', '<h1>', '<br>', '<a name="x">'])(r))), 1, 5)(rng).join(' ');

test('a body of basic tags and http(s) links is never routed to the rich API', () => {
  forAll('rich-basic-stays-basic', basicBody, (html) => {
    expect(isRichHtml(html)).toBe(false);
  });
});

test('any rich-only tag or rich anchor anywhere in a basic body makes it rich', () => {
  const richBit: Gen<string> = oneOf(
    (rng) => {
      const tag = pick(RICH_ONLY_TAGS)(rng);
      return pick([`<${tag}>`, `<${tag.toUpperCase()} class="x">`, `<${tag}/>`, `</${tag}>`])(rng);
    },
    pick(['<a name="ch1"></a>', '<a href="#ch1">x</a>', '<a href="mailto:a@b.c">m</a>', "<a href='tel:+1'>t</a>", '<a class="x" name="y">z</a>']),
  );
  forAll('rich-detect', (rng) => {
    const body = basicBody(rng);
    const at = int(0, body.length)(rng);
    // insert only at a tag boundary or text position, never inside a tag
    const cut = body.lastIndexOf('>', at) + 1;
    return `${body.slice(0, cut)}${richBit(rng)}${body.slice(cut)}`;
  }, (html) => {
    expect(isRichHtml(html)).toBe(true);
  });
});

// --- rich.ts: normalizeRichHtml ---

// A nested span tree rendered twice: as written, and as the rich API wants it.
const spanTree: Gen<[string, string]> = (rng) => {
  const node = (depth: number): [string, string] => {
    const t = escapeHtml(anyText(0, 5)(rng));
    if (depth > 3 || rng() < 0.3) return [t, t];
    const kids = arrayOf(() => node(depth + 1), 0, 3)(rng);
    const inner: [string, string] = [kids.map((k) => k[0]).join(''), kids.map((k) => k[1]).join('')];
    const kind = pick(['spoiler', 'spoiler-single', 'spoiler-spaced', 'data-class', 'plain-span', 'bold'])(rng);
    switch (kind) {
      case 'spoiler':
        return [`${t}<span class="tg-spoiler">${inner[0]}</span>`, `${t}<tg-spoiler>${inner[1]}</tg-spoiler>`];
      case 'spoiler-single':
        return [`${t}<SPAN id="q" class='tg-spoiler'>${inner[0]}</SPAN>`, `${t}<tg-spoiler>${inner[1]}</tg-spoiler>`];
      case 'spoiler-spaced':
        return [`${t}<span  class = "tg-spoiler" >${inner[0]}</span>`, `${t}<tg-spoiler>${inner[1]}</tg-spoiler>`];
      case 'data-class':
        return [`${t}<span data-class="tg-spoiler">${inner[0]}</span>`, `${t}<span data-class="tg-spoiler">${inner[1]}</span>`];
      case 'plain-span':
        return [`${t}<span class="note">${inner[0]}</span>`, `${t}<span class="note">${inner[1]}</span>`];
      default:
        return [`${t}<b>${inner[0]}</b>`, `${t}<b>${inner[1]}</b>`];
    }
  };
  const roots = arrayOf(() => node(0), 1, 4)(rng);
  return [roots.map((r) => r[0]).join(''), roots.map((r) => r[1]).join('')];
};

test('normalizeRichHtml rewrites every spoiler span — and only those — to a matched tg-spoiler pair', () => {
  forAll('rich-normalize', spanTree, ([source, expected]) => {
    expect(normalizeRichHtml(source)).toBe(expected);
  });
});

// --- rich.ts: validateRichHtml ---

test('the rich character budget counts visible characters: escaping and markup never change it', () => {
  // Code points of decoded text, the unit the pre-flight documents: exactly maxChars passes,
  // one more fails, however much of it is entities or tags.
  const unit: Gen<string> = pick([...ATOMS.ascii, ...ATOMS.html.slice(0, 5), ...ATOMS.cyrillic, '😀', '漢']);
  forAll('rich-char-budget', (rng) => {
    const parts: string[] = [];
    let n = 0;
    while (n < RICH_LIMITS.maxChars) {
      const u = unit(rng);
      const len = [...u].length;
      if (n + len > RICH_LIMITS.maxChars) break;
      parts.push(u);
      n += len;
    }
    while (n < RICH_LIMITS.maxChars) {
      parts.push('x');
      n += 1;
    }
    return parts;
  }, (parts) => {
    const wrap = (s: string): string => `<p>${s}</p>`;
    const body = parts.map((p, i) => (i % 97 === 0 ? `<b>${escapeHtml(p)}</b>` : escapeHtml(p))).join('');
    expect(validateRichHtml(wrap(body))).toEqual({ ok: true });
    expect(validateRichHtml(wrap(`${body}&amp;`)).ok).toBe(false);
  }, 5);
});

test('nesting depth is the deepest container chain; void elements never add a level', () => {
  const VOIDS = ['<br>', '<hr>', '<br/>', '<input type="checkbox">', '<img src="tg://emoji?id=1" alt="x">', '<tg-emoji emoji-id="1">😀</tg-emoji>'];
  const nested: Gen<string[]> = (rng) => arrayOf(pick(VOIDS), 1, RICH_LIMITS.maxNesting + 1)(rng);
  forAll('rich-depth', nested, (voids) => {
    // one <blockquote> level per entry, a void element on each side of the inner content
    const html = voids.reduce((inner, v) => `<blockquote>${v}${inner}${v}</blockquote>`, 'x');
    expect(validateRichHtml(`<p>${html}</p>`).ok).toBe(voids.length + 1 <= RICH_LIMITS.maxNesting);
  }, 60);
});

// --- table.ts ---

const cell: Gen<string> = textOf([...ATOMS.ascii.filter((a) => a !== '|'), ...ATOMS.html, ...ATOMS.emoji, ...ATOMS.cjk, ...ATOMS.cyrillic, ...ATOMS.combining, ' '], 0, 6);
const grid: Gen<string[][]> = (rng) => arrayOf(arrayOf(cell, 1, 5), 1, 6)(rng).map((r) => r.map((c) => c.trim()));

test('a rendered table is a rectangle: every line has the same length, whatever the cells hold', () => {
  forAll('table-rectangle', grid, (rows) => {
    const lines = renderTable(rows).split('\n');
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines.length).toBe(rows.length + (rows.length > 1 ? 3 : 2));
    // every cell is in its own row's line, in order
    rows.forEach((r, i) => {
      const line = lines[i === 0 ? 1 : i + 2];
      let from = 0;
      for (const c of r) {
        const at = line.indexOf(c, from);
        expect(at).toBeGreaterThanOrEqual(from);
        from = at + c.length;
      }
    });
  });
});

test('toTablePre escapes after aligning: decoding the <pre> body gives back the raw rendered table', () => {
  forAll('table-escape', grid, (rows) => {
    const input = rows.map((r) => r.join('\t')).join('\n');
    const { html } = toTablePre(input);
    expect(html.startsWith('<pre>') && html.endsWith('</pre>')).toBe(true);
    const inner = html.slice(5, -6);
    expect(inner).not.toMatch(/[<>]/);
    expect(decodeHtmlEntities(inner)).toBe(renderTable(parseTableRows(input).rows));
  });
});

// Display columns a monospace font gives these atoms: a non-spacing mark takes none.
const displayWidth = (s: string): number => [...s].reduce((w, ch) => w + (/[\p{Mn}\p{Me}]/u.test(ch) ? 0 : 1), 0);

// The --table promise: a table either lines up in display columns, or the caller is warned.
test('a table of Latin/Cyrillic cells with any combining marks lines up, or the user is warned', () => {
  // Decomposed accents (NFD: e + U+0301) arrive from macOS file names and some keyboards;
  // a mark with no precomposed form (z + U+0303, Hebrew/Arabic points) stays decomposed in
  // any normalization. A cell measured in code units pads either one column short.
  const latin = textOf([...ATOMS.ascii.filter((a) => a !== '|'), ...ATOMS.cyrillic, ...ATOMS.combining, 'й', 'ü', 'z\u0303', 'שָׁ'], 1, 6);
  forAll('table-marks', (rng) => arrayOf(arrayOf((r) => (r() < 0.5 ? latin(r).normalize('NFD') : latin(r)), 2, 4), 2, 5)(rng), (rows) => {
    const input = rows.map((r) => r.join('\t')).join('\n');
    const { rows: parsed, hasWide } = parseTableRows(input);
    const lines = renderTable(parsed).split('\n');
    if (!hasWide) expect(new Set(lines.map(displayWidth)).size).toBe(1);
  });
});

test('a decomposed accent that has a precomposed form never needs the warning', () => {
  const composable = textOf(['e\u0301', 'n\u0303', 'u\u0308', '\u0438\u0306', 'a', 'Ж'], 1, 6);
  forAll('table-nfd', (rng) => arrayOf(arrayOf(composable, 2, 4), 2, 5)(rng), (rows) => {
    const { rows: parsed, hasWide } = parseTableRows(rows.map((r) => r.join('\t')).join('\n'));
    expect(hasWide).toBe(false);
    expect(new Set(renderTable(parsed).split('\n').map(displayWidth)).size).toBe(1);
  });
});

test('every double-width glyph a cell can carry raises the width warning', () => {
  const wide = pick([...ATOMS.emoji, ...ATOMS.cjk, '#️⃣', 'Ａ', '！']);
  forAll('table-wide', (rng) => `${textOf(['a', ' ', 'b'], 0, 3)(rng)}${wide(rng)}${textOf(['a', 'b'], 0, 3)(rng)}`, (c) => {
    expect(hasWideGlyph(c)).toBe(true);
  });
});
