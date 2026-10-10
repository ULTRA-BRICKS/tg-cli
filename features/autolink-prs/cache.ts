// Forgejo response cache for the autolink-prs feature (1h TTL).
//
// Each verified reference is cached as either a positive entry (ForgeRef) or a
// NEGATIVE one (info: null — Forgejo answered 404 for the number in this repo),
// so a report repeatedly mentioning the same #N doesn't re-query the forge
// every send. Pure string→state helpers; the tg entrypoint owns the file I/O
// (~/.cache/tg-cli/forgejo-cache.json) and treats every failure as cache-miss /
// don't-persist. Mirrors features/autolink-tasks/cache.ts.
//
// CRITICAL: the cache key is `<host>/<owner>/<repo>#<number>`, NOT a bare number —
// the same #260 resolves to different things in different repos, so a
// repo-agnostic key would be a correctness bug.

import type { ForgeRef } from './resolve';

export const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  t: number; // epoch ms when the entry was written
  info: ForgeRef | null; // null = verified-absent in this repo
}

export interface CacheSplit {
  // number → cached verdict (ForgeRef or null for verified-absent)
  hits: Map<number, ForgeRef | null>;
  // numbers that need a live probe, in input order
  missing: number[];
}

/** Repo-scoped cache key. Keep this the single source of truth for the shape. */
export function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function parseEntries(raw: string | null): Record<string, CacheEntry> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    const entries = parsed?.entries;
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      const e = value as { t?: unknown; info?: unknown };
      if (typeof e?.t !== 'number') continue;
      const info = e.info as ForgeRef | null;
      if (info !== null) {
        // `state` must be a string: prStateSuffix() does ref.state.toUpperCase()
        // on the render path, so a corrupt/hand-edited entry missing it would
        // crash a real send. Treat any shape mismatch as a cache miss.
        if (
          typeof info?.number !== 'number' ||
          typeof info?.title !== 'string' ||
          typeof info?.url !== 'string' ||
          typeof info?.state !== 'string' ||
          (info.kind !== 'issue' && info.kind !== 'pr')
        ) {
          continue;
        }
      }
      out[key] = { t: e.t, info };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Split numbers into fresh cache hits and numbers needing a live probe, scoped
 * to `repo`. An empty repo (identity unknown) means nothing can be keyed, so
 * everything is reported missing.
 */
export function splitByCache(repo: string, numbers: number[], raw: string | null, now: number): CacheSplit {
  const entries = parseEntries(raw);
  const hits = new Map<number, ForgeRef | null>();
  const missing: number[] = [];
  for (const number of numbers) {
    const entry = repo ? entries[cacheKey(repo, number)] : undefined;
    if (entry && now - entry.t < CACHE_TTL_MS) {
      hits.set(number, entry.info);
    } else {
      missing.push(number);
    }
  }
  return { hits, missing };
}

/**
 * Fold a probe result back into the cache: every probed number gets a fresh
 * repo-keyed entry (positive when GitHub resolved it, negative otherwise).
 * Unrelated fresh entries are kept; expired ones are pruned so the file stays
 * small.
 */
export function mergeIntoCache(
  raw: string | null,
  repo: string,
  probedNumbers: number[],
  refs: Map<number, ForgeRef>,
  now: number,
): string {
  const entries = parseEntries(raw);
  for (const [key, entry] of Object.entries(entries)) {
    if (now - entry.t >= CACHE_TTL_MS) delete entries[key];
  }
  for (const number of probedNumbers) {
    entries[cacheKey(repo, number)] = { t: now, info: refs.get(number) ?? null };
  }
  return JSON.stringify({ entries });
}
