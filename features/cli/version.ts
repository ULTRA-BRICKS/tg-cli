// --- Version output (runtime git hash + changelog) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 0d, docs/specs/
// tg-decomposition.md). VERSION + the three helpers live here; the entrypoint
// imports `versionOutput` and re-exports `VERSION` for back-compat
// (tests/ergonomics.test.ts imports VERSION from `../tg`).
import { readFileSync } from 'fs';
import { join } from 'path';

export const VERSION = '1.14.0';

/**
 * Resolve the short git commit hash of the repo containing the tg script.
 * Read at RUNTIME (the tool is run directly via bun, not built), so the hash
 * always reflects the checked-out commit. Never throws: returns "unknown" when
 * git is unavailable or the script lives outside a git repo.
 */
export function gitShortHash(scriptDir: string): string {
  try {
    const proc = Bun.spawnSync(['git', '-C', scriptDir, 'rev-parse', '--short', 'HEAD']);
    if (proc.exitCode === 0) {
      const hash = proc.stdout.toString().trim();
      if (hash) return hash;
    }
  } catch {
    // git missing / not a repo — fall through to "unknown"
  }
  return 'unknown';
}

/**
 * Read the latest (top-most) version section of CHANGELOG.md, i.e. everything
 * from the first `## ` heading up to the next `## ` heading. Keeps --version
 * output readable as releases accumulate. Returns "" when the changelog is
 * absent or has no version section. Never throws.
 */
export function latestChangelogSection(scriptDir: string): string {
  try {
    const raw = readFileSync(join(scriptDir, 'CHANGELOG.md'), 'utf8');
    const lines = raw.split('\n');
    const start = lines.findIndex((l) => l.startsWith('## '));
    if (start === -1) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n').replace(/\s+$/, '');
  } catch {
    // no changelog — degrade gracefully
    return '';
  }
}

/**
 * Compose the full `--version` / `-v` output: a version+hash line, then the
 * latest changelog section (when present). Pure aside from the I/O it delegates
 * to the helpers above, and never throws.
 */
export function versionOutput(scriptDir: string): string {
  const head = `tg ${VERSION} (${gitShortHash(scriptDir)})`;
  const changelog = latestChangelogSection(scriptDir);
  return changelog ? `${head}\n\n${changelog}` : head;
}
