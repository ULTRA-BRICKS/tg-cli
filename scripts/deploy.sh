#!/usr/bin/env bash
# deploy.sh — update an installed `tg` checkout to the latest committed code.
#
# WHY THIS EXISTS
#   `tg` is a committed Bun script (no build step): the symlink `tg` ->
#   <checkout>/tg means the checked-out FILE *is* the running binary
#   (single-file-live-symlink-cli). "Deploying" a merged change is therefore
#   just a fast-forward `git pull` in the checkout the symlink points at —
#   there is nothing to compile. This script makes that one-step deploy safe,
#   idempotent, and aware of the one moving part a bare `git pull` forgets:
#   the long-lived `tg-ctl` daemon.
#
#   `tg` itself needs NO restart — the next `tg` invocation reads the new file.
#   `tg-ctl run` is a resident Bun process that loaded its code (tg-ctl +
#   features/tg-ctl/*) into memory at start; if the pull changes any file the
#   daemon imports, the running daemon keeps the OLD code until it is
#   restarted. Restarting it DROPS the daemon's pane/cwd/session registration,
#   so this script never blind-restarts a running daemon: it detects whether
#   the deploy touched daemon code and, if so, STOPS at a clear warning telling
#   you to restart it yourself (re-registering the same pane). Pass
#   --restart-ctl to opt in to an automatic stop/start (registration is NOT
#   preserved — only do this when no agent pane is registered, or you will
#   re-register it after).
#
# PAST BUG THIS GUARDS
#   ROADMAP "tg-cli #36 merged but NOT deployed": a merged `--tag`/help change
#   sat un-deployed because the live `~/.files/bin/tg` checkout was never
#   pulled. This script is the documented, scripted deploy step that closes
#   that gap.
#
# USAGE
#   scripts/deploy.sh [--checkout DIR] [--restart-ctl] [--dry-run]
#
#   --checkout DIR   The git checkout to update. Default: resolve the `tg` on
#                    PATH through its symlink to its containing repo. Override
#                    when deploying a checkout other than the one on PATH.
#   --restart-ctl    If a `tg-ctl` daemon is running AND the deploy touched its
#                    code, stop+start it automatically. WITHOUT this flag the
#                    script warns and leaves the daemon alone (default: safe).
#   --dry-run        Show what would happen (fetch + report divergence) without
#                    pulling or touching the daemon. Always FF-safe to run.
#
# EXIT CODES
#   0  up to date, or deployed successfully
#   1  usage / environment error (no checkout, not a git repo, dirty tree)
#   2  cannot fast-forward (checkout diverged from origin/main) — needs a human
set -euo pipefail

usage() {
  cat <<'EOF'
deploy.sh — update an installed `tg` checkout to the latest committed code.

`tg` is a committed Bun script (no build step): the symlink `tg` -> <checkout>/tg
means the checked-out FILE is the running binary, so "deploying" a merged change
is a guarded fast-forward `git pull` in that checkout.

Usage:
  scripts/deploy.sh [--checkout DIR] [--restart-ctl] [--dry-run]

  --checkout DIR   The git checkout to update. Default: resolve the `tg` on PATH
                   through its symlink to its containing repo.
  --restart-ctl    If a tg-ctl daemon is running AND the deploy touched its code,
                   stop+start it automatically (drops the pane/cwd/session
                   registration — re-register afterwards). Default: warn only.
  --dry-run        Show what would land (fetch + report) without pulling or
                   touching the daemon. Always safe to run.

Exit codes: 0 up-to-date/deployed · 1 usage/env error · 2 non-fast-forward.
EOF
}

CHECKOUT=""
RESTART_CTL=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --checkout)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "deploy: --checkout requires a directory argument." >&2; exit 1
      fi
      CHECKOUT="$2"; shift 2 ;;
    --restart-ctl) RESTART_CTL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy: unknown argument '$1' (try --help)" >&2; exit 1 ;;
  esac
done

# Resolve the real file behind a symlink, following the chain hop-by-hop (no
# `readlink -f` — it is absent on stock macOS). Echoes the final target. A depth
# cap breaks a symlink cycle (a -> b -> a) instead of looping forever.
resolve_link() {
  target="$1"
  hops=0
  while [ -L "$target" ]; do
    hops=$((hops + 1))
    if [ "$hops" -gt 40 ]; then
      echo "deploy: symlink chain for '$1' is too deep (cycle?) — aborting." >&2
      exit 1
    fi
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;                      # absolute
      *)  target="$(dirname "$target")/$link" ;; # relative to its own dir
    esac
  done
  echo "$target"
}

# ── resolve the checkout the live `tg` points at ───────────────────────────────
if [ -z "$CHECKOUT" ]; then
  tg_bin="$(command -v tg || true)"
  if [ -z "$tg_bin" ]; then
    echo "deploy: no 'tg' on PATH and no --checkout given." >&2
    echo "        Pass --checkout DIR to name the checkout to update." >&2
    exit 1
  fi
  CHECKOUT="$(cd "$(dirname "$(resolve_link "$tg_bin")")" && pwd)"
fi

# Accept any git work tree, including one whose `.git` is a FILE (worktrees,
# submodules) — a `-d .git` check would wrongly reject those.
if ! git -C "$CHECKOUT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "deploy: '$CHECKOUT' is not a git checkout." >&2
  echo "        tg may be installed from a curl tarball rather than a clone;" >&2
  echo "        re-run install.sh to refresh that kind of install." >&2
  exit 1
fi

git_c() { git -C "$CHECKOUT" "$@"; }

echo "deploy: checkout = $CHECKOUT"

# ── refuse to clobber a dirty tree ─────────────────────────────────────────────
# Only TRACKED changes block a fast-forward; untracked files (a stray bun.lock /
# node_modules from a `bun install`, editor temp files) do not, so exclude them.
# Capture into a var first so a `git status` FAILURE (locked index, corrupt repo)
# aborts under `set -e` instead of being read as "clean" inside `$(...)`.
dirty="$(git_c status --porcelain --untracked-files=no)"
if [ -n "$dirty" ]; then
  echo "deploy: checkout has local (tracked) changes — refusing to pull over them." >&2
  echo "        Commit, stash, or discard them, then re-run." >&2
  echo "$dirty" >&2
  exit 1
fi

branch="$(git_c rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "HEAD" ]; then
  echo "deploy: checkout is in detached-HEAD state — no branch to pull." >&2
  echo "        Check out a branch (e.g. 'git -C $CHECKOUT switch main') first." >&2
  exit 1
fi
echo "deploy: branch  = $branch"

# ── fetch and measure divergence ───────────────────────────────────────────────
git_c fetch origin --quiet
upstream="origin/${branch}"
if ! git_c rev-parse --verify --quiet "$upstream" >/dev/null; then
  echo "deploy: no upstream '$upstream' — is this branch pushed?" >&2
  exit 1
fi

local_sha="$(git_c rev-parse HEAD)"
remote_sha="$(git_c rev-parse "$upstream")"

if [ "$local_sha" = "$remote_sha" ]; then
  echo "deploy: already up to date ($(git_c rev-parse --short HEAD)) — nothing to do."
  exit 0
fi

# Fast-forward only: refuse if the checkout has commits the remote lacks.
if ! git_c merge-base --is-ancestor HEAD "$upstream"; then
  echo "deploy: cannot fast-forward — '$branch' has diverged from '$upstream'." >&2
  echo "        A human must reconcile (rebase/merge). Aborting." >&2
  exit 2
fi

echo "deploy: $(git_c rev-parse --short HEAD) -> $(git_c rev-parse --short "$upstream"), commits to land:"
git_c log --oneline "HEAD..$upstream" | sed 's/^/  /'

# Does the deploy touch the tg-ctl daemon's runtime code? The `tg-ctl run`
# process imports the `tg-ctl` entry AND shared modules under `features/` (the
# inbound-inject wrap, cli/version, render helpers, …) — not just
# features/tg-ctl/. So treat a change to `tg-ctl` OR anything under `features/`
# as "the running daemon may be stale". This only drives a WARNING (never a blind
# restart), so erring toward over-warning is the safe bias — a missed warning
# silently ships stale daemon behavior (e.g. this PR's VERSION bump in
# features/cli/version.ts, which a features/tg-ctl-only matcher would not catch).
ctl_changed=0
if git_c diff --name-only "HEAD..$upstream" | grep -qE '^(tg-ctl(/|$)|features/)'; then
  ctl_changed=1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "deploy: --dry-run — not pulling."
  [ "$ctl_changed" = "1" ] && echo "deploy: (dry-run) would require a tg-ctl restart (daemon code changed)."
  exit 0
fi

# ── fast-forward to the already-validated upstream ─────────────────────────────
# Use `merge --ff-only "$upstream"` (not `pull`, which would re-fetch): we already
# fetched and validated `$upstream` is a strict descendant of HEAD, so this updates
# against the SAME object state the ctl_changed decision was computed from — no
# second fetch, no race window where a new push slips in unwarned.
git_c merge --ff-only --quiet "$upstream"
new_sha="$(git_c rev-parse --short HEAD)"
echo "deploy: pulled — now at $new_sha"

# Run the deployed checkout's OWN tg/tg-ctl (NOT whatever is first on PATH — when
# --checkout names a tree other than the PATH one, the PATH binary is unrelated).
tg_checkout="$CHECKOUT/tg"
ctl_checkout="$CHECKOUT/tg-ctl"

# Bound every post-deploy invocation of the freshly-pulled binaries with `timeout`
# when available, so a wedged binary (startup lock, blocking on stdin, network on
# launch) can't hang the deploy. `bounded CMD ARGS…` runs CMD under that bound (or
# bare where no timeout(1)/gtimeout is on the box).
timeout_bin="$(command -v timeout || command -v gtimeout || true)"
[ -z "$timeout_bin" ] && echo "deploy: NOTE — no timeout(1)/gtimeout; post-deploy tg/tg-ctl calls run unbounded." >&2
bounded() {
  if [ -n "$timeout_bin" ]; then "$timeout_bin" 30 "$@"; else "$@"; fi
}

# `tg` is a committed script: the symlink already points at the new file. Verify
# the deployed `tg` reports the new commit (sanity check the script is runnable).
# The `|| true` keeps a failing/empty version probe (e.g. bun missing → exit 127,
# which `set -o pipefail` would otherwise surface) from aborting the whole deploy.
if [ -x "$tg_checkout" ]; then
  tg_version="$(bounded "$tg_checkout" --version 2>/dev/null | head -1)" || true
  if [ -n "$tg_version" ]; then
    echo "deploy: tg --version -> $tg_version"
  else
    echo "deploy: WARNING — deployed tg produced no --version output (is bun on PATH?)." >&2
  fi
fi

# Re-register the agent skill (idempotent; keeps the skill file current).
if [ -x "$tg_checkout" ]; then
  bounded "$tg_checkout" install-skill >/dev/null 2>&1 \
    && echo "deploy: refreshed tg skill (install-skill)" \
    || echo "deploy: WARNING — 'tg install-skill' failed/timed out; re-run it manually." >&2
fi

# ── tg-ctl daemon ──────────────────────────────────────────────────────────────
# Manage the deployed checkout's own tg-ctl. The daemon is a host singleton, so a
# running one may belong to a DIFFERENT checkout; only restart when this deploy's
# binary reports the daemon as running (its status reads the shared pid/lock).
ctl_bin="$ctl_checkout"
ctl_running=0
if [ -x "$ctl_bin" ] && bounded "$ctl_bin" status >/dev/null 2>&1; then
  ctl_running=1
fi

if [ "$ctl_running" = "1" ] && [ "$ctl_changed" = "1" ]; then
  if [ "$RESTART_CTL" = "1" ]; then
    echo "deploy: restarting tg-ctl (daemon code changed; --restart-ctl given)..."
    echo "deploy: NOTE — restart drops the daemon's pane/cwd/session registration." >&2
    # Surface a stop failure on its own — otherwise a still-alive daemon makes the
    # subsequent start fail and wrongly blames `start`.
    bounded "$ctl_bin" stop  || { echo "deploy: tg-ctl stop FAILED — daemon may still be running; fix it and retry." >&2; exit 1; }
    bounded "$ctl_bin" start || { echo "deploy: tg-ctl start FAILED — start it manually." >&2; exit 1; }
    echo "deploy: tg-ctl restarted. Re-register the agent pane if one was bound."
  else
    echo "deploy: ====================================================================" >&2
    echo "deploy: ACTION NEEDED — tg-ctl is running and this deploy changed its code." >&2
    echo "deploy: The running daemon still holds the OLD code. Restart it to apply:" >&2
    echo "deploy:     tg-ctl status   # note the registered pane/cwd/session" >&2
    echo "deploy:     tg-ctl stop && tg-ctl start [--pane %N] [--cwd ...] [--session ...]" >&2
    echo "deploy: (or re-run this deploy with --restart-ctl to stop/start automatically)" >&2
    echo "deploy: ====================================================================" >&2
  fi
elif [ "$ctl_running" = "1" ]; then
  echo "deploy: tg-ctl running; deploy did not touch its code — no restart needed."
fi

echo "deploy: done — deployed $new_sha."
