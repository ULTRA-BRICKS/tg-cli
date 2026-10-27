# Configuration schema and help implementation plan

## Scope

Implement the approved configuration discovery work in an isolated worktree.
The real Bun entrypoints, scalar parsers, default maps, installer, CI, and
release-test route determine integration points.

## Tasks

1. Audit supported settings and effective defaults. Describe current
   `control.enabled` behavior accurately; it only gates lazy autostart.
2. Add pure metadata and shared schema/help renderers, deriving literal
   defaults from runtime modules. Verify key completeness, types, defaults,
   and canonical examples against the parsers.
3. Add config filesystem maintenance and route actual config reads/writes
   through it. Preserve comments, symlinks, permissions, and read-only help/
   dry-run behavior; test repeated calls and competing application writers.
4. Route exact config help aliases before configuration/credential reads and
   list the topic in main help. Verify aliases, path resolution, unchanged
   filesystem state, and ordinary-message fallback with subprocess tests.
5. Add deterministic schema/reference generation and a non-writing check.
   Wire CI and ordinary-suite artifact assertions so the existing remote
   shipping gate catches stale output. Keep direct-script install/deploy.
6. Generate the tracked artifacts, update README semantics and discovery,
   run targeted regressions and the required release suite, and review the
   final diff before preparing the requested PR.

## Validation and delivery

Use the repository's hermetic test preload and temporary directories. Run all
real CLI subprocess checks without inherited credentials; use dry-run for
message fallback. Keep artifact tests in the normal Bun suite. Record targeted
and release-run results in the PR, including any remaining failures. Do not
merge or deploy as part of this work.
