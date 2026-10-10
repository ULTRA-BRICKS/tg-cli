// Forgejo gateway for the autolink-prs feature.
//
// The caller injects a ForgejoGet (features/forgejo/client.ts) so tests never touch the real
// forge. Cache misses cost one `GET /repos/{owner}/{repo}/issues/{n}` each — Forgejo's issue
// endpoint answers for PRs too (with a `pull_request` block); cached refs cause no lookup.
// Lookups run LOOKUP_CONCURRENCY at a time under one LOOKUP_BUDGET_MS ceiling, so a long
// range like `#1..100` on a cold cache cannot hold the send for long.

import type { ForgejoGet, ForgejoRepo } from '../forgejo/client';
import { mapWithConcurrency, OVER_BUDGET, withinBudget } from '../util/concurrency';

export const LOOKUP_CONCURRENCY = 6;
export const LOOKUP_BUDGET_MS = 8_000;

export interface ForgeRef {
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
}

/** Parse one `GET /issues/{n}` JSON body; null unless it is the expected number. */
export function parseIssueResponse(raw: string, expectedNumber: number): ForgeRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    state?: unknown;
    pull_request?: { merged?: unknown; draft?: unknown } | null;
  };
  if (rec.number !== expectedNumber) return null;
  if (typeof rec.title !== 'string' || typeof rec.html_url !== 'string' || !/^https?:\/\//.test(rec.html_url)) return null;
  const pr = rec.pull_request && typeof rec.pull_request === 'object' ? rec.pull_request : null;
  let state = String(rec.state ?? '').toUpperCase();
  if (pr?.merged === true) state = 'MERGED';
  const ref: ForgeRef = { number: expectedNumber, kind: pr ? 'pr' : 'issue', title: rec.title, url: rec.html_url, state };
  if (pr) ref.isDraft = pr.draft === true;
  return ref;
}

export type ForgeRefsResult =
  | { status: 'ok'; refs: Map<number, ForgeRef> }
  | { status: 'no-auth' }
  | { status: 'error'; message: string };

type ProbeFailure = Exclude<ForgeRefsResult, { status: 'ok' }>;

/**
 * Resolve cache-miss refs in `repo`. HTTP 404 is a verified absence (the number is neither an
 * issue nor a PR there); any other failure — or running past `budgetMs` — fails the whole
 * batch, so an incomplete lookup is never cached as "absent". The first failure stops the
 * batch: no further lookup starts and the ones in flight are aborted.
 */
export async function probeRefsInRepo(
  repo: ForgejoRepo,
  numbers: number[],
  get: ForgejoGet,
  budgetMs: number = LOOKUP_BUDGET_MS,
): Promise<ForgeRefsResult> {
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues`;
  const stop = new AbortController();
  let failure: ProbeFailure | undefined;
  const fail = (f: ProbeFailure): void => {
    failure ??= f;
    stop.abort();
  };
  const found = await withinBudget((budget) => {
    const signal = AbortSignal.any([budget, stop.signal]);
    return mapWithConcurrency(
      numbers,
      LOOKUP_CONCURRENCY,
      async (number): Promise<ForgeRef | null> => {
        const result = await get(`${base}/${number}`, signal);
        if (signal.aborted) return null; // stopped by another lookup's failure or the budget
        if (result === null) fail({ status: 'error', message: `Forgejo ${repo.hostKey} unreachable` });
        else if (result.status === 401 || result.status === 403) fail({ status: 'no-auth' });
        else if (result.status === 404) return null;
        else if (result.status !== 200) fail({ status: 'error', message: `Forgejo answered HTTP ${result.status} for #${number}` });
        else {
          const ref = parseIssueResponse(result.body, number);
          if (ref === null) fail({ status: 'error', message: `unexpected Forgejo response for #${number}` });
          return ref;
        }
        return null;
      },
      signal,
    );
  }, budgetMs);
  if (found === OVER_BUDGET) return { status: 'error', message: `Forgejo lookups exceeded ${budgetMs}ms` };
  if (failure) return failure;
  const refs = new Map<number, ForgeRef>();
  found.forEach((ref, i) => {
    if (ref) refs.set(numbers[i], ref);
  });
  return { status: 'ok', refs };
}
