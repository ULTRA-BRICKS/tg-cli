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
#   features/ + tools/) into memory at start; the running daemon keeps the OLD
#   code until it is restarted — merged fixes sat inert for weeks (tg-cli#279).
#   So every deploy ends with `tg-ctl restart --if-stale`: the daemon records
#   which commit it loaded, and is gracefully restarted (SIGTERM drain; queued
#   messages, questions and pane registrations are on disk and survive) exactly
#   when that commit differs from the checkout's HEAD in daemon code. It runs
#   on the already-up-to-date path too, so re-running this script converges a
#   checkout that was pulled by hand without a restart.
#
# PAST BUG THIS GUARDS
#   ROADMAP "tg-cli #36 merged but NOT deployed": a merged `--tag`/help change
#   sat un-deployed because the live `~/.files/bin/tg` checkout was never
#   pulled. This script is the documented, scripted deploy step that closes
#   that gap; `gh ship`'s post-merge step is expected to run it.
#
# USAGE
#   scripts/deploy.sh [--checkout DIR] [--no-restart-ctl] [--dry-run]
#
#   --checkout DIR     The git checkout to update. Default: resolve the `tg` on
#                      PATH through its symlink to its containing repo. Override
#                      when deploying a checkout other than the one on PATH.
#   --no-restart-ctl   Leave a stale tg-ctl daemon running (report only).
#   --dry-run          Show what would land (fetch + report divergence) without
#                      pulling or touching the daemon. Always FF-safe to run.
#
# EXIT CODES
#   0  deployed (or already up to date) and the daemon, if running, runs it
#   1  usage / environment error (no checkout, not a git repo, dirty tree)
#   2  cannot fast-forward (checkout diverged from origin/main) — needs a human
#   3  checkout up to date (pulled or already current), but the tg-ctl restart failed
#      (old daemon still alive, or no successor came up) — see the tg-ctl message above it
set -euo pipefail

usage() {
  cat <<'EOF'
deploy.sh — update an installed `tg` checkout to the latest committed code.

`tg` is a committed Bun script (no build step): the symlink `tg` -> <checkout>/tg
means the checked-out FILE is the running binary, so "deploying" a merged change
is a guarded fast-forward `git pull` in that checkout.

Usage:
  scripts/deploy.sh [--checkout DIR] [--no-restart-ctl] [--dry-run]

  --checkout DIR     The git checkout to update. Default: resolve the `tg` on PATH
                     through its symlink to its containing repo.
  --no-restart-ctl   Do not restart a tg-ctl daemon running stale code (report
                     only). Default: `tg-ctl restart --if-stale` — a graceful
                     reload only when the daemon's loaded code is not current.
  --dry-run          Show what would land (fetch + report) without pulling or
                     touching the daemon. Always safe to run.

Exit codes: 0 deployed · 1 usage/env error · 2 non-fast-forward · 3 tg-ctl restart failed.
EOF
}

CHECKOUT=""
RESTART_CTL=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --checkout)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "deploy: --checkout requires a directory argument." >&2; exit 1
      fi
      CHECKOUT="$2"; shift 2 ;;
    --no-restart-ctl) RESTART_CTL=0; shift ;;
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

# Run the deployed checkout's OWN tg/tg-ctl (NOT whatever is first on PATH — when
# --checkout names a tree other than the PATH one, the PATH binary is unrelated).
tg_checkout="$CHECKOUT/tg"
ctl_checkout="$CHECKOUT/tg-ctl"

# Bound every invocation of the checkout's binaries with `timeout` when available,
# so a wedged binary (startup lock, blocking on stdin, network on launch) can't
# hang the deploy. `bounded SECS CMD ARGS…` runs CMD under that bound (or bare
# where no timeout(1)/gtimeout is on the box).
timeout_bin="$(command -v timeout || command -v gtimeout || true)"
bounded() {
  secs="$1"; shift
  if [ -n "$timeout_bin" ]; then "$timeout_bin" "$secs" "$@"; else "$@"; fi
}
# Both the pull and the already-up-to-date path run the checkout's binaries (the latter at least
# `tg-ctl restart --if-stale`); a --dry-run runs none.
if [ -z "$timeout_bin" ] && [ "$DRY_RUN" = "0" ]; then
  echo "deploy: NOTE — no timeout(1)/gtimeout; post-deploy tg/tg-ctl calls run unbounded." >&2
fi

if [ "$local_sha" = "$remote_sha" ]; then
  echo "deploy: already up to date ($(git_c rev-parse --short HEAD)) — nothing to pull."
  [ "$DRY_RUN" = "1" ] && exit 0
else
  # Fast-forward only: refuse if the checkout has commits the remote lacks.
  if ! git_c merge-base --is-ancestor HEAD "$upstream"; then
    echo "deploy: cannot fast-forward — '$branch' has diverged from '$upstream'." >&2
    echo "        A human must reconcile (rebase/merge). Aborting." >&2
    exit 2
  fi

  echo "deploy: $(git_c rev-parse --short HEAD) -> $(git_c rev-parse --short "$upstream"), commits to land:"
  git_c log --oneline "HEAD..$upstream" | sed 's/^/  /'

  if [ "$DRY_RUN" = "1" ]; then
    echo "deploy: --dry-run — not pulling (a real run then restarts tg-ctl if its loaded code is stale)."
    exit 0
  fi

  # ── fast-forward to the already-validated upstream ───────────────────────────
  # Use `merge --ff-only "$upstream"` (not `pull`, which would re-fetch): we already
  # fetched and validated `$upstream` is a strict descendant of HEAD, so this lands
  # exactly the commits listed above — no race window where a new push slips in.
  git_c merge --ff-only --quiet "$upstream"
  echo "deploy: pulled — now at $(git_c rev-parse --short HEAD)"

  # `tg` is a committed script: the symlink already points at the new file. Verify
  # the deployed `tg` reports the new commit (sanity check the script is runnable).
  # The `|| true` keeps a failing/empty version probe (e.g. bun missing → exit 127,
  # which `set -o pipefail` would otherwise surface) from aborting the whole deploy.
  if [ -x "$tg_checkout" ]; then
    tg_version="$(bounded 30 "$tg_checkout" --version 2>/dev/null | head -1)" || true
    if [ -n "$tg_version" ]; then
      echo "deploy: tg --version -> $tg_version"
    else
      echo "deploy: WARNING — deployed tg produced no --version output (is bun on PATH?)." >&2
    fi
  fi

  # Re-register the agent skill (idempotent; keeps the skill file current).
  if [ -x "$tg_checkout" ]; then
    bounded 30 "$tg_checkout" install-skill >/dev/null 2>&1 \
      && echo "deploy: refreshed tg skill (install-skill)" \
      || echo "deploy: WARNING — 'tg install-skill' failed/timed out; re-run it manually." >&2
  fi
fi

# ── tg-ctl daemon ──────────────────────────────────────────────────────────────
# `tg-ctl restart --if-stale` owns the whole decision (tg-cli#279): no daemon → no-op
# (a deploy never starts one); loaded code current → no-op; otherwise a graceful,
# verified reload — under launchd when launchd owns the daemon — that exits non-zero
# unless the old process is gone AND a successor holds the lock (tg-cli#438). Bound:
# the SIGTERM drain (≤10s) plus the successor wait (≤15s), with margin.
if [ -x "$ctl_checkout" ]; then
  if [ "$RESTART_CTL" = "1" ]; then
    if ! bounded 60 "$ctl_checkout" restart --if-stale; then
      echo "deploy: ====================================================================" >&2
      echo "deploy: tg-ctl restart FAILED — the checkout is up to date, but the daemon may" >&2
      echo "deploy: still run the OLD code (or not run at all). See the tg-ctl message" >&2
      echo "deploy: above; \`tg-ctl status\` shows the running pid and its code line." >&2
      echo "deploy: ====================================================================" >&2
      exit 3
    fi
  else
    echo "deploy: --no-restart-ctl — tg-ctl left as is:"
    bounded 30 "$ctl_checkout" status 2>/dev/null | grep -E '^(tg-ctl:|code:)' | sed 's/^/  /' || true
  fi
fi

echo "deploy: done — $CHECKOUT at $(git_c rev-parse --short HEAD)."
