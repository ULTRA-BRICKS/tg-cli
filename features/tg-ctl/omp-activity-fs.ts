// The one impure reader behind the awareness nudge's activity facts: when was an
// omp session's transcript — or one of its subagents' — last written (tg-cli#789).
// A subagent transcript lives in the folder named like the session file without
// `.jsonl` (`…/<ts>_<sessionId>/<Agent>.jsonl`, nested for sub-subagents).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_DEPTH = 3;

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function newestUnder(dir: string, depth: number): number | null {
  let newest: number | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const path = join(dir, name);
    const candidate = name.endsWith('.jsonl')
      ? mtimeMs(path)
      : depth < MAX_DEPTH
        ? newestUnder(path, depth + 1)
        : null;
    if (candidate !== null && (newest === null || candidate > newest)) newest = candidate;
  }
  return newest;
}

/** Newest write (ms epoch) to the session transcript or any subagent transcript; null when unreadable. */
export function newestTranscriptWriteMs(sessionFile: string | null): number | null {
  if (!sessionFile?.endsWith('.jsonl')) return null;
  const own = mtimeMs(sessionFile);
  const sub = newestUnder(sessionFile.slice(0, -'.jsonl'.length), 1);
  if (own === null) return sub;
  return sub === null || own >= sub ? own : sub;
}
