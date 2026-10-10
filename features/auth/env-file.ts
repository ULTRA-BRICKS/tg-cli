// --- Config `.env` writer (tg auth, docs/specs/tg-auth.md §6) ---
//
// The write side of features/config/env.ts's loader: rewrites the flat
// KEY=VALUE file so `tg auth` (and the daemon's `/start` claim) can set or drop
// TG_BOT_TOKEN / TG_CHAT_ID without touching anything else the user keeps there.
// Pure string → string; the caller owns the atomic 0600 write.

// The key a line defines, by the loader's own rules (trimmed, `#` = comment,
// first `=` splits), or null for a comment / blank / non-assignment line.
function definedKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return null;
  return trimmed.slice(0, eq).trim() || null;
}

/**
 * Set `set` keys and drop `remove` keys in `.env` content. The first line
 * defining a set key is replaced in place, later duplicates are dropped, missing
 * keys are appended; every other line is kept byte-for-byte. Throws on a value
 * with a line break, which would forge another key.
 */
export function mergeEnvContent(existing: string | null, set: Record<string, string>, remove: readonly string[] = []): string {
  for (const [key, value] of Object.entries(set)) {
    if (/[\r\n]/.test(value)) throw new Error(`refusing to write ${key}: value contains a newline`);
  }
  const lines = existing === null || existing === '' ? [] : existing.replace(/\r?\n$/, '').split(/\r?\n/);
  const written = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = definedKey(line);
    if (key === null) {
      kept.push(line);
      continue;
    }
    if (remove.includes(key)) continue;
    if (Object.hasOwn(set, key)) {
      if (written.has(key)) continue;
      written.add(key);
      kept.push(`${key}=${set[key]}`);
      continue;
    }
    kept.push(line);
  }
  for (const [key, value] of Object.entries(set)) {
    if (!written.has(key)) kept.push(`${key}=${value}`);
  }
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}
