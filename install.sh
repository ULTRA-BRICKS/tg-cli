#!/usr/bin/env bash
# install.sh — install the `tg` CLI (Bun/TypeScript)
# Works both from a local clone (./install.sh) and piped from curl:
#   curl -fsSL https://git.hyperide.ai/ultrabricks/tg-cli/raw/branch/main/install.sh | bash
set -euo pipefail

# ── identity ──────────────────────────────────────────────────────────────────
TOOL="tg"
REPO="tg-cli"
FORGE="https://git.hyperide.ai/ultrabricks"   # canonical home; github.com/alex-mextner is an archived mirror
ENTRY="tg"          # path inside repo root (not bin/)
CLONE_BASE="${XDG_DATA_HOME:-$HOME/.local/share}"
EXPECT_URL="$FORGE/$REPO.git"

# Origins that are the same repo: the canonical Forgejo one and the pre-migration GitHub ones (a
# GitHub origin is re-pointed at Forgejo — the GitHub copy is frozen). Compared as HOST + PATH, never
# as a substring: an origin that merely contains "hyperide.ai" (git.hyperide.ai.evil.example,
# evil.example/git.hyperide.ai/…) must not pass for the canonical repo and get pulled + installed.
_url_host_path() {  # https / ssh / scp-style git URL -> "host path" (user@, :port, .git, trailing / dropped)
  local _u _hp _path _host
  _u=${1%/}; _u=${_u%.git}
  case "$_u" in
    https://*|ssh://*) _u=${_u#*://}; _hp=${_u%%/*}; _path=${_u#*/} ;;
    *@*:*) _hp=${_u%%:*}; _path=${_u#*:} ;;
    *) return 1 ;;
  esac
  [ "$_path" != "$_u" ] || return 1
  case "$_hp" in *[!A-Za-z0-9._:@%~-]*) return 1 ;; esac  # e.g. `\` (a host separator to some parsers)
  _host=${_hp##*@}; _host=${_host%%:*}
  printf '%s %s\n' "$_host" "$_path"
}
_origin_is_canonical() {
  [ "$(_url_host_path "$1")" = "git.hyperide.ai ultrabricks/$REPO" ]
}
_origin_is_legacy() {
  case "$(_url_host_path "$1")" in
    "github.com alex-mextner/$REPO"|"github.com ultrabricks/$REPO") return 0 ;;
  esac
  return 1
}

# ── locate source dir ─────────────────────────────────────────────────────────
# When run from a local clone, BASH_SOURCE[0] resolves to the script file.
# When piped through bash, BASH_SOURCE[0] is empty or "bash".
_script_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && "${BASH_SOURCE[0]}" != "bash" ]]; then
  _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -n "$_script_dir" && -f "$_script_dir/$ENTRY" ]]; then
  SRC="$_script_dir"
  echo "tg: using local clone at $SRC"
else
  if ! command -v git &>/dev/null; then
    echo "  ERROR: 'git' is required to fetch $REPO via the curl installer." >&2
    echo "  Install git, or clone the repo manually and run ./install.sh from it." >&2
    exit 1
  fi
  mkdir -p "$CLONE_BASE"
  CLONE_DIR="$CLONE_BASE/$REPO"
  if [[ -d "$CLONE_DIR/.git" ]]; then
    actual_url="$(git -C "$CLONE_DIR" remote get-url origin 2>/dev/null || echo "")"
    if _origin_is_legacy "$actual_url"; then
      echo "tg: $REPO moved to $FORGE — re-pointing origin ($actual_url -> $EXPECT_URL)"
      git -C "$CLONE_DIR" remote set-url origin "$EXPECT_URL"
    elif ! _origin_is_canonical "$actual_url"; then
      echo "ERROR: $CLONE_DIR exists but its origin is '$actual_url', not $EXPECT_URL." >&2
      echo "       Remove that directory or fix its remote, then re-run." >&2
      exit 1
    fi
    echo "tg: updating existing clone at $CLONE_DIR"
    # The validated origin (not whatever branch.*.remote names) and the branch that is checked out
    # (a clone kept on a feature branch updates that branch; a detached HEAD takes origin HEAD).
    _branch="$(git -C "$CLONE_DIR" symbolic-ref --quiet --short HEAD || echo HEAD)"
    git -C "$CLONE_DIR" pull --ff-only origin "$_branch"
  else
    echo "tg: cloning $EXPECT_URL into $CLONE_DIR"
    git clone "$EXPECT_URL" "$CLONE_DIR"
  fi
  SRC="$CLONE_DIR"
fi

# ── bin dir ───────────────────────────────────────────────────────────────────
BIN="$HOME/.local/bin"
mkdir -p "$BIN"

if [[ ":$PATH:" != *":$BIN:"* ]]; then
  echo ""
  echo "  NOTE: $BIN is not on your PATH."
  echo "  Add the following line to your ~/.bashrc or ~/.zshrc and restart your shell:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

# ── dependency: bun ───────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo ""
  echo "  ERROR: 'bun' is not installed. tg requires Bun."
  echo "  Install it with:"
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo ""
  exit 1
fi

# ── symlink entry ─────────────────────────────────────────────────────────────
ENTRY_PATH="$SRC/$ENTRY"
chmod +x "$ENTRY_PATH"
ln -sfn "$ENTRY_PATH" "$BIN/$TOOL"
echo "tg: symlinked $BIN/$TOOL -> $ENTRY_PATH"

# Independent optional clients: no auth or dependency installation during setup.
for client in tg-mtproto tg-call call-cli; do
  if [[ -f "$SRC/$client" ]]; then
    chmod +x "$SRC/$client"
    ln -sfn "$SRC/$client" "$BIN/$client"
  fi
done

# tg-ctl ships alongside tg (inbound control daemon: `tg-ctl start/stop/status`).
if [[ -f "$SRC/tg-ctl" ]]; then
  chmod +x "$SRC/tg-ctl"
  ln -sfn "$SRC/tg-ctl" "$BIN/tg-ctl"
  echo "tg: symlinked $BIN/tg-ctl -> $SRC/tg-ctl"
fi

# ── register skill ────────────────────────────────────────────────────────────
if ! "$BIN/$TOOL" install-skill; then
  echo "  WARNING: '$TOOL install-skill' failed — $TOOL is installed but agents may not"
  echo "           auto-discover it. Re-run '$TOOL install-skill' manually to fix."
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  tg is installed."
echo "  Usage: tg \"<message>\"          — send a Telegram message"
echo "         tg --format html \"<html>\" — send formatted HTML"
echo "         tg --file <path> \"caption\" — send a file"
echo "         tg --help               — full usage"
echo "         tg --detect-model       — detect the current AI model"
echo ""
