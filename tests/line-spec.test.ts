import { expect, test } from 'bun:test';
import { planLineSpecs, type GateItem } from '../features/auto-attach/line-spec';
import { buildSendPlan, type ParsedItem } from '../features/auto-attach/normalize';

// In-memory reader factory: maps path → content. Unknown paths read as null
// (missing/binary/unreadable).
function reader(files: Record<string, string>) {
  return (p: string): string | null => (p in files ? files[p] : null);
}

const lineSpec = (token: string, n: number) => ({ token, startLine: n, endLine: n, col: undefined });

// Decision C (2026-06-11): a mentioned file is ALWAYS attached, regardless of
// size. There is no size gate. A line-spec adds an inline ±2 snippet AND a
// marker-injected attachment, both for small and large files.

// A small (<=1024) line-spec file: snippet inline + 1 marker attachment.
test('line-spec file <=1024 → snippet inline + 1 marker attachment (always attached)', () => {
  const content = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5'].join('\n');
  expect(content.length).toBeLessThanOrEqual(1024);
  const items: GateItem[] = [{ type: 'document', path: '/x.ts', lineSpec: lineSpec('/x.ts:3', 3) }];
  const plan = planLineSpecs(items, reader({ '/x.ts': content }));
  // Snippet is always shown for a line-spec.
  expect(plan.quotes.length).toBe(1);
  expect(plan.quotes[0].token).toBe('/x.ts:3');
  expect(plan.quotes[0].quote).toContain('const c = 3');
  // And the small file IS attached (marker-injected), not dropped — decision C.
  expect(plan.marked.length).toBe(1);
  expect(plan.marked[0].path).toBe('/x.ts');
  expect(plan.marked[0].filename).toBe('x.ts');
  expect(plan.marked[0].content).toContain('// line: ');
  expect(plan.marked[0].content).toContain('const c = 3');
});

// A large (>1024) line-spec file: snippet inline + 1 marker-injected attachment.
test('line-spec file >1024 → snippet inline + 1 marker attachment', () => {
  const big = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}`).join('\n');
  expect(big.length).toBeGreaterThan(1024);
  const items: GateItem[] = [{ type: 'document', path: '/big.ts', lineSpec: lineSpec('/big.ts:50', 50) }];
  const plan = planLineSpecs(items, reader({ '/big.ts': big }));
  expect(plan.quotes.length).toBe(1);
  expect(plan.marked.length).toBe(1);
  expect(plan.marked[0].path).toBe('/big.ts');
  expect(plan.marked[0].filename).toBe('big.ts');
  // The marker band is present around the referenced range.
  expect(plan.marked[0].content).toContain('// line: ');
  expect(plan.marked[0].content).toContain('const v49 = 49');
});

// An EXPLICIT --file with an adopted line-spec (no `auto`) <=1024 also attaches
// with markers — same as auto, since there is no size gate at all now.
test('explicit (non-auto) line-spec file <=1024 → snippet + attached with markers', () => {
  const content = ['a = 1', 'b = 2', 'c = 3', 'd = 4'].join('\n');
  const items: GateItem[] = [
    { type: 'document', path: '/e.ts', lineSpec: lineSpec('/e.ts:2', 2) }, // no auto
  ];
  const plan = planLineSpecs(items, reader({ '/e.ts': content }));
  expect(plan.quotes.length).toBe(1);
  expect(plan.marked.length).toBe(1);
  expect(plan.marked[0].content).toContain('// line: ');
});

// Bare path (no line-spec): this layer plans nothing — bare paths attach as-is
// via the normal send path. No size discrimination here either.
test('bare document (any size) → no snippet, no marker (attaches via normal path)', () => {
  const small: GateItem[] = [{ type: 'document', path: '/s.txt' }];
  const planSmall = planLineSpecs(small, reader({ '/s.txt': 'small file\njust two lines' }));
  expect(planSmall.quotes.length).toBe(0);
  expect(planSmall.marked.length).toBe(0);

  const big: GateItem[] = [{ type: 'document', path: '/b.txt' }];
  const planBig = planLineSpecs(big, reader({ '/b.txt': 'x'.repeat(2000) }));
  expect(planBig.quotes.length).toBe(0);
  expect(planBig.marked.length).toBe(0);
});

test('PHOTOS are never snippeted/marked', () => {
  const items: GateItem[] = [{ type: 'photo', path: '/a.png' }];
  const plan = planLineSpecs(items, reader({ '/a.png': 'PNGDATA' }));
  expect(plan.quotes.length).toBe(0);
  expect(plan.marked.length).toBe(0);
});

test('binary-ext line-spec (report.pdf:12) → no snippet, no marker, attached as-is', () => {
  const items: GateItem[] = [
    { type: 'document', path: '/report.pdf', lineSpec: lineSpec('/report.pdf:12', 12) },
  ];
  // reader returns null for a pdf (binary).
  const plan = planLineSpecs(items, reader({}));
  expect(plan.quotes.length).toBe(0);
  expect(plan.marked.length).toBe(0);
});

test('unreadable text-ext line-spec → no snippet, no marker (attached as-is)', () => {
  const items: GateItem[] = [{ type: 'document', path: '/gone.ts', lineSpec: lineSpec('/gone.ts:3', 3) }];
  const plan = planLineSpecs(items, reader({})); // reads null
  expect(plan.quotes.length).toBe(0);
  expect(plan.marked.length).toBe(0);
});

// --- Wiring integration (replicates the load-bearing lines in `tg`) ---
// The send path: planLineSpecs → R2 over ALL docs → buildSendPlan. Decision C
// removed the gate, so a small auto doc whose full content is pasted verbatim is
// ATTACHED and R2 strips the duplicated paste (same as a large doc).
test('wiring: small auto doc with pasted content → attached AND R2 strips the paste', () => {
  const content = 'export const a = 1\nexport const b = 2';
  const path = '/small.ts';
  const text = `Updated:\n${content}\nthanks`;
  const items: GateItem[] = [{ type: 'document', path }];

  // 1. plan the line-specs (none here — bare path).
  const lsPlan = planLineSpecs(items, reader({ [path]: content }));
  expect(lsPlan.marked.length).toBe(0);

  // 2. R2 fileContents now includes EVERY doc (no gate exclusion).
  const fileContents = items.filter((it) => it.type === 'document').map((it) => ({ path: it.path, content }));
  expect(fileContents.length).toBe(1);

  // 3. build the plan.
  const parsed: ParsedItem[] = items.map((it) => ({ type: it.type, path: it.path }));
  const plan = buildSendPlan(parsed, text, 'plain', { fileContents });

  // The attachment is present (decision C: small files attach too)...
  expect(plan.documents.length).toBe(1);
  // ...and R2 stripped the verbatim paste from the text (the file carries it).
  expect(plan.textMessages[0].text).not.toContain('export const b = 2');
});

test('wiring: large auto doc → attached AND R2 strips the paste', () => {
  const content = 'L\n'.repeat(700); // > 1024
  const path = '/big.ts';
  const text = `Here:\n${content}\nend`;
  const items: GateItem[] = [{ type: 'document', path }];

  const fileContents = items.filter((it) => it.type === 'document').map((it) => ({ path: it.path, content }));
  expect(fileContents.length).toBe(1);

  const parsed: ParsedItem[] = items.map((it) => ({ type: it.type, path: it.path }));
  const plan = buildSendPlan(parsed, text, 'plain', { fileContents });

  // Doc stays attached, and the verbatim paste is stripped (R2).
  expect(plan.documents.length).toBe(1);
  expect(plan.textMessages[0].text).not.toContain('L\nL\nL');
});
