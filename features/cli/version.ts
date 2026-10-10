// --- Version output (runtime git hash + changelog) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 0d, docs/specs/
// tg-decomposition.md). VERSION + the version helpers live here; the entrypoint
// imports `versionOutput` and re-exports `VERSION` for back-compat
// (tests/ergonomics.test.ts imports VERSION from `../tg`). VERSION is sourced
// from package.json at module load (tg-cli#80) — no hardcoded literal.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PROBE_SPAWN } from '../util/spawn-timeout';

/**
 * Read the `version` field from a repo's package.json. `package.json` is the
 * SINGLE SOURCE OF TRUTH for the tool version (tg-cli#80): no hardcoded literal
 * lives in the source anymore. The tool runs directly via bun from the repo
 * root, so package.json sits next to the `tg` entrypoint (the `scriptDir` /
 * `import.meta.dir` passed to `versionOutput`). Returns "unknown" when
 * package.json is absent or has no string `version`. Never throws.
 */
export function resolveVersion(scriptDir: string): string {
  try {
    const raw = readFileSync(join(scriptDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
  } catch {
    // missing/unreadable/malformed package.json — degrade gracefully
  }
  return 'unknown';
}

// The directory of THIS module's package (features/cli/version.ts → ../../ is
// the repo root holding package.json). Resolved from import.meta.url so the
// static `VERSION` export below matches whatever `versionOutput(scriptDir)`
// reports when called with the repo root, keeping the two in lockstep.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The tool version, sourced from package.json at module load. Re-exported by the
 * `tg` entrypoint for back-compat (`import { VERSION } from "../tg"`). Not a
 * literal: package.json is the only place the version is declared.
 */
export const VERSION = resolveVersion(PACKAGE_ROOT);

/**
 * Resolve the short git commit hash of the repo containing the tg script.
 * Read at RUNTIME (the tool is run directly via bun, not built), so the hash
 * always reflects the checked-out commit. Never throws: returns "unknown" when
 * git is unavailable or the script lives outside a git repo.
 */
export function gitShortHash(scriptDir: string): string {
  try {
    const proc = Bun.spawnSync(['git', '-C', scriptDir, 'rev-parse', '--short', 'HEAD'], PROBE_SPAWN);
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
  const head = `tg ${resolveVersion(scriptDir)} (${gitShortHash(scriptDir)})`;
  const changelog = latestChangelogSection(scriptDir);
  return changelog ? `${head}\n\n${changelog}` : head;
}
