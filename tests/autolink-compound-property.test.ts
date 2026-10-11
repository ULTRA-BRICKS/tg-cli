// Property tests for the compound ref parser (docs/specs/autolink-compound.md, tg-cli#606):
// the expansion of any token is bounded, terminates, never invents a number outside the
// written endpoints, and linkify only ever ADDS links to the body.
import { expect, test } from 'bun:test';
import { type CompoundGroup, expandGroup, groupsFromLeads, RANGE_GROUP_CAP, RANGE_STEP_CAP } from '../features/autolink-refs/compound';
import { detectRefsExpanded, refLeads } from '../features/autolink-prs/detect';
import { linkifyRefsCompound } from '../features/autolink-prs/render';
import type { GhRef } from '../features/autolink-prs/resolve';
import { detectTicketCodesExpanded, ticketLeads } from '../features/autolink-tasks/detect';
import { arrayOf, forAll, type Gen, int, oneOf, pick } from './helpers/prop';
import { spawnSyncBounded } from './helpers/spawn-sync';

const SEPS = ['/', ',', '..', '…', '-'] as const;

// A written number: mostly close together, sometimes far apart. Numbers past 2^53 are
// exercised only in a child process below — a regression there spins forever, and a
// synchronous loop cannot be interrupted by bun's per-test timeout.
const num: Gen<string> = oneOf(
  (rng) => String(int(1, 300)(rng)),
  (rng) => String(int(1, 100_000)(rng)),
);
const compoundToken: Gen<string> = (rng) => {
  const lead = pick(['#', 'HYP-'])(rng);
  const tail = arrayOf((r) => `${pick(SEPS)(r)}${num(r)}`, 0, 40)(rng).join('');
  return `${lead}${int(1, 300)(rng)}${tail}`;
};
const groupOf = (token: string): CompoundGroup[] => groupsFromLeads(token, token.startsWith('#') ? refLeads(token) : ticketLeads(token));

test('expansion is bounded per group, duplicate-free, and only fills written range steps', () => {
  forAll('compound-bounds', compoundToken, (token) => {
    for (const g of groupOf(token)) {
      const out = expandGroup(g);
      const written = g.written.map((w) => w.value);
      expect(new Set(out).size).toBe(out.length);
      expect(out.length).toBeLessThanOrEqual(new Set(written).size + RANGE_GROUP_CAP);
      for (const w of written) expect(out).toContain(w);
      // A non-written number must lie strictly inside one RANGE step (a, b) with a < b.
      const insideStep = (n: number): boolean =>
        g.seps.some((sep, i) => sep !== '/' && sep !== ',' && written[i] < n && n < written[i + 1]);
      for (const n of out) expect(written.includes(n) || insideStep(n)).toBe(true);
    }
  });
});

test('a small range expands to exactly its inclusive interior, in order', () => {
  forAll('compound-small-range', (rng) => ({ a: int(1, 500)(rng), d: int(0, RANGE_STEP_CAP)(rng), sep: pick(['..', '…', '-'])(rng) }), ({ a, d, sep }) => {
    const [g] = groupOf(`#${a}${sep}${a + d}`);
    expect(expandGroup(g)).toEqual(Array.from({ length: d + 1 }, (_, i) => a + i));
  });
});

test('a chain of capped ranges in one token enumerates at most RANGE_GROUP_CAP interior numbers', () => {
  // 1000 steps of 100: each step alone is within RANGE_STEP_CAP, together they were 100k refs
  // (a 100k-line reference block and 100k probes) — the per-step cap alone does not bound it.
  const token = `#${Array.from({ length: 1001 }, (_, i) => 1 + i * RANGE_STEP_CAP).join('-')}`;
  const started = performance.now();
  const refs = detectRefsExpanded(token);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(refs.length).toBeLessThanOrEqual(1001 + RANGE_GROUP_CAP);
  expect(detectTicketCodesExpanded(token.replace('#', 'HYP-')).length).toBeLessThanOrEqual(1001 + RANGE_GROUP_CAP);
});

test('a range whose endpoints lie past 2^53 terminates (no interior synthesized)', () => {
  // 2^53 + 1 === 2^53 in floating point: `n++` stops advancing and the old loop spun forever,
  // freezing the tg send. Run in a child so a regression fails on the deadline instead of
  // wedging the whole test process.
  const code = `const { detectRefsExpanded } = await import(${JSON.stringify(`${import.meta.dir}/../features/autolink-prs/detect.ts`)});
process.stdout.write(JSON.stringify(detectRefsExpanded('#1,9007199254740992-9007199254741000 HYP-9007199254740992..9007199254740999')));`;
  const proc = spawnSyncBounded(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' }, 10_000);
  expect(proc.stderr.toString()).toBe('');
  expect(JSON.parse(proc.stdout.toString())).toEqual([1, 9007199254740992, 9007199254741000]);
}, 20_000);

test('linkify only adds <a> wrappers: stripping them gives back the body byte for byte', () => {
  const refs = new Map<number, GhRef>();
  for (let n = 1; n <= 300; n += 2) refs.set(n, { number: n, url: `https://example.test/${n}?a=1&b="x"`, title: 't', state: 'OPEN', kind: 'issue' });
  const body: Gen<string> = (rng) =>
    arrayOf(oneOf(compoundToken, pick(['text', '&amp;', '<b>', '</b>', '<code>#5</code>', '<a href="x">#7</a>', 'https://h/#9', '\n', ' '])), 1, 12)(rng).join(' ');
  forAll('compound-linkify-additive', body, (html) => {
    const out = linkifyRefsCompound(html, refs);
    const added = out.replace(/<a href="https:\/\/example\.test\/\d+\?a=1&amp;b=&quot;x&quot;">([^<]*)<\/a>/g, '$1');
    expect(added).toBe(html);
    // never a link inside a link, <code> or <pre>
    expect(out).not.toMatch(/<(a|code|pre)\b[^>]*>(?:(?!<\/\1>).)*<a href="https:\/\/example\.test/s);
  });
});
