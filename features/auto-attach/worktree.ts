// Worktree-aware path resolution for the auto-attach scanner.
//
// Why this exists: `tg` resolves relative path tokens against `cwd` only
// (~-expand / absolute / cwd-relative — see `resolveExistingFile` in the `tg`
// script). When a message is composed from a different checkout than the one
// that contains the mentioned file (e.g. the path lives in a feature worktree
// but the send runs from the main checkout, or vice versa), the relative path
// does not exist under cwd → it never resolves → the file is never attached.
//
// This module adds a FALLBACK that, after the plain cwd/~/absolute resolution
// fails, tries the same relative path against the roots of every git worktree
// in deterministic priority order:
//   1. current worktree root (the worktree containing cwd)
//   2. the MAIN worktree root (primary checkout), if different from current
//   3. worktree(s) whose checked-out branch == the current branch
//   4. any remaining worktree roots (creation order)
//
// Design constraints (spec + CTO request):
// - Gated under the `auto-attach` feature flag (the caller only invokes this
//   when auto-attach is ON; flag OFF → plain cwd resolution, this is unused).
// - PURE + testable: the porcelain→pairs parse and the priority-ordering are
//   pure functions. The single impure seam (`Bun.spawnSync(["git", ...])`) is
//   injected as a `RunGit` callback so tests stub it without spawning git.
// - PERFORMANCE: the caller only reaches here when a token FAILED plain
//   resolution AND looks path-like (`looksPathLike`), and memoizes the root
//   list so git is spawned at most once per process.
// - SECURITY: only resolves to files that exist AND sit inside a worktree root
//   (no `..` traversal escaping the root) — see `resolveAcrossWorktrees`.

import { isAbsolute, resolve, sep } from 'path';
import { PROBE_SPAWN } from '../util/spawn-timeout';

// One git worktree: its checkout root and the branch it currently has checked
// out (null for a detached HEAD or a bare entry).
export interface WorktreeEntry {
  root: string;
  branch: string | null;
}

// Injectable git runner: given args, return stdout (or null on failure). The
// real implementation shells out via Bun.spawnSync; tests pass a stub.
export type RunGit = (args: string[]) => string | null;

// File-existence predicate, injectable for tests. Returns true iff the absolute
// path is an existing regular file.
export type FileExists = (absPath: string) => boolean;

/**
 * Parse `git worktree list --porcelain` output into (root, branch) pairs.
 *
 * Porcelain format is a blank-line-separated list of records; each record has a
 * `worktree <abs-path>` line, optionally `HEAD <sha>`, and either
 * `branch refs/heads/<name>`, `detached`, or `bare`. The FIRST record is always
 * the main (primary) worktree. We preserve order — callers rely on entry[0]
 * being the main root.
 *
 * Pure: this is the mockable seam the tests stub a worktree list through.
 */
export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { root: string; branch: string | null } | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { root: line.slice('worktree '.length).trim(), branch: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
    // `detached` / `bare` / `HEAD <sha>` carry no branch — leave it null.
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Build the deterministic priority-ordered list of worktree ROOTS to probe.
 *
 * NOTE: this is NOT git's output order. Git lists main first, then others in
 * creation order. The CTO's priority is explicit and constructed here:
 *   1. current worktree root (the worktree containing cwd)
 *   2. main worktree root (entries[0]), if different from current
 *   3. worktree(s) whose branch == currentBranch (covers both directions:
 *      from main → the branch's dedicated worktree, and from a worktree →
 *      its sibling sharing the branch)
 *   4. every remaining root, in git's creation order
 * De-duplicated, first occurrence wins. Pure.
 */
export function orderWorktreeRoots(
  entries: WorktreeEntry[],
  currentRoot: string | null,
  currentBranch: string | null,
): string[] {
  const ordered: string[] = [];
  const push = (root: string | null | undefined): void => {
    if (!root) return;
    if (!ordered.includes(root)) ordered.push(root);
  };

  // 1. current worktree first.
  push(currentRoot);
  // 2. main worktree (first porcelain entry).
  if (entries.length > 0) push(entries[0].root);
  // 3. worktree(s) matching the current branch.
  if (currentBranch) {
    for (const e of entries) {
      if (e.branch && e.branch === currentBranch) push(e.root);
    }
  }
  // 4. the rest, in creation order.
  for (const e of entries) push(e.root);

  return ordered;
}

/**
 * Heuristic gate: is this token worth spawning git for?
 *
 * Only tokens that look like a relative file path get the worktree fallback —
 * a path separator OR a known file extension. This keeps git OUT of the hot
 * path for ordinary prose words. Absolute / ~-rooted tokens are excluded: the
 * plain resolver already handles those, and a worktree-relative join of an
 * absolute path is meaningless. Pure.
 */
const PATHLIKE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|sh|bash|zsh|css|scss|sass|less|html|htm|xml|yaml|yml|toml|ini|cfg|conf|go|rs|py|rb|java|kt|c|h|cc|cpp|hpp|cs|php|swift|sql|csv|tsv|log|lock|env|sample|svg|png|jpg|jpeg|gif|webp|bmp|pdf)$/i;

export function looksPathLike(token: string): boolean {
  if (!token) return false;
  // Absolute and ~-rooted tokens are the plain resolver's job, not ours.
  if (isAbsolute(token) || token === '~' || token.startsWith('~/')) return false;
  // A path separator strongly implies a relative path (`docs/specs/x.md`).
  if (token.includes('/')) return true;
  // A bare filename with a known extension (`README.md`) is also path-like.
  return PATHLIKE_EXT.test(token);
}

/**
 * Reject relative tokens that would escape a worktree root via `..`. We refuse
 * any token containing a `..` path segment up front (cheap, and the spec only
 * asks to resolve files INSIDE a worktree root). A post-join containment check
 * in `resolveAcrossWorktrees` is the belt-and-braces second line. Pure.
 */
function hasParentTraversal(token: string): boolean {
  return token.split(/[/\\]/).some((seg) => seg === '..');
}

/**
 * Try to resolve a relative token against a priority-ordered list of worktree
 * roots. Returns the first absolute path that EXISTS and stays INSIDE its root,
 * or null. Pure given an injected `fileExists`.
 *
 * Security: rejects `..`-bearing tokens, and verifies the resolved path is
 * still within `<root>/` (defends against absolute-ish or symlink-y joins).
 */
export function resolveAcrossWorktrees(token: string, roots: string[], fileExists: FileExists): string | null {
  if (!token || isAbsolute(token)) return null;
  if (hasParentTraversal(token)) return null;
  for (const root of roots) {
    if (!root) continue;
    const candidate = resolve(root, token);
    // Containment: the resolved path must live under `<root>/` (or be the root
    // itself, which can't be a file anyway). Guards against traversal escaping.
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!candidate.startsWith(rootWithSep)) continue;
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Enumerate worktree roots in priority order for a given cwd, using injected
 * git + parse. Combines:
 *   - `git -C <cwd> rev-parse --show-toplevel`        → current worktree root
 *   - `git -C <cwd> rev-parse --abbrev-ref HEAD`      → current branch
 *   - `git -C <cwd> worktree list --porcelain`        → all (root, branch) pairs
 * then `orderWorktreeRoots`. Returns [] when cwd is not in a git repo (every
 * git call returns null). Pure given an injected `runGit`.
 */
export function enumerateWorktreeRoots(cwd: string, runGit: RunGit): string[] {
  const topRaw = runGit(['-C', cwd, 'rev-parse', '--show-toplevel']);
  const currentRoot = topRaw ? topRaw.trim() : null;
  if (!currentRoot) return []; // not a git repo / git unavailable

  const branchRaw = runGit(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = branchRaw && branchRaw.trim() && branchRaw.trim() !== 'HEAD' ? branchRaw.trim() : null;

  const listRaw = runGit(['-C', cwd, 'worktree', 'list', '--porcelain']);
  const entries = listRaw ? parseWorktreePorcelain(listRaw) : [];

  return orderWorktreeRoots(entries, currentRoot, currentBranch);
}

/**
 * The real git runner: shell out via Bun.spawnSync. Returns stdout on success,
 * null on any failure (non-zero exit, git missing). This is the ONE impure
 * function in the module; everything above is pure and injectable.
 */
export const runGitReal: RunGit = (args) => {
  try {
    const proc = Bun.spawnSync(['git', ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      ...PROBE_SPAWN,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString();
  } catch {
    return null;
  }
};
