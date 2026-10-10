// Seeded property-test runner (tg-cli#606). No dependency: a mulberry32 PRNG drives small
// generators, `forAll` runs a property N times and, on failure, throws with the seed, the run
// index and the generated input, so a red run is reproducible: `PROP_SEED=<seed> bun test …`.
// Deterministic by default (fixed seed per property name), so CI never flakes on a new draw.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Gen<T> = (rng: Rng) => T;

export const int =
  (min: number, max: number): Gen<number> =>
  (rng) =>
    min + Math.floor(rng() * (max - min + 1));

export const pick =
  <T>(items: readonly T[]): Gen<T> =>
  (rng) =>
    items[Math.floor(rng() * items.length)];

export const oneOf =
  <T>(...gens: Gen<T>[]): Gen<T> =>
  (rng) =>
    gens[Math.floor(rng() * gens.length)](rng);

export const arrayOf =
  <T>(gen: Gen<T>, min: number, max: number): Gen<T[]> =>
  (rng) =>
    Array.from({ length: int(min, max)(rng) }, () => gen(rng));

// Text atoms chosen for the bug classes this repo's text paths have hit: HTML specials and
// entities, astral emoji (UTF-16 surrogate pairs), ZWJ / variation-selector sequences, CJK,
// combining marks, Cyrillic, whitespace runs and newlines.
export const ATOMS = {
  ascii: ['a', 'b', 'Z', '0', '7', 'word', 'hello', '-', '.', ',', '/', ':', '#', '|', '_', '*'],
  html: ['<', '>', '&', '"', "'", '&amp;', '&lt;', '&gt;', '&quot;', '&#39;', '&#x1F600;', '&nbsp;'],
  emoji: ['😀', '🚀', '👍🏽', '👨‍👩‍👧', '❤️', '1️⃣', '🇷🇸'],
  cjk: ['漢', '字', '日本語', '한국어', 'かな'],
  combining: ['é', 'ñ', 'á'],
  cyrillic: ['привет', 'Ж', 'ё'],
  space: [' ', '  ', '\t', '\n', '\n\n'],
} as const;

const ALL_ATOMS: readonly string[] = Object.values(ATOMS).flat();

export const textAtom: Gen<string> = pick(ALL_ATOMS);

export function textOf(atoms: readonly string[], min: number, max: number): Gen<string> {
  return (rng) => arrayOf(pick(atoms), min, max)(rng).join('');
}

export const anyText = (min = 0, max = 40): Gen<string> => textOf(ALL_ATOMS, min, max);

function seedFor(name: string): number {
  const env = process.env.PROP_SEED;
  if (env !== undefined && env !== '') return Number(env) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

function show(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x));
  } catch {
    return String(v);
  }
}

// Run `prop` on `runs` generated inputs. `prop` asserts with expect() (or throws); the first
// failure is rethrown with the seed and the offending input attached.
export function forAll<T>(name: string, gen: Gen<T>, prop: (value: T) => void, runs = 300): void {
  const seed = seedFor(name);
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    const value = gen(rng);
    try {
      prop(value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property "${name}" failed (PROP_SEED=${seed}, run ${i}) for input ${show(value)}\n${msg}`);
    }
  }
}
