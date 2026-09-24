#!/usr/bin/env bash
# install.sh — install the `tg` CLI (Bun/TypeScript)
# Works both from a local clone (./install.sh) and piped from curl:
#   curl -fsSL https://git.hyperide.ai/ultrabricks/tg-cli/raw/branch/main/install.sh | bash
set -euo pipefail

# ── identity ──────────────────────────────────────────────────────────────────
TOOL="tg"
REPO="tg-cli"
GIT_OWNER="ultrabricks"
ENTRY="tg"          # path inside repo root (not bin/)
CLONE_BASE="${XDG_DATA_HOME:-$HOME/.local/share}"

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
  EXPECT_URL="https://git.hyperide.ai/$GIT_OWNER/$REPO.git"
  if [[ -d "$CLONE_DIR/.git" ]]; then
    actual_url="$(git -C "$CLONE_DIR" remote get-url origin 2>/dev/null || echo "")"
    if [[ "$actual_url" != "$EXPECT_URL" ]]; then
      echo "ERROR: $CLONE_DIR exists but its origin is '$actual_url', not $EXPECT_URL." >&2
      echo "       Remove that directory or fix its remote, then re-run." >&2
      exit 1
    fi
    echo "tg: updating existing clone at $CLONE_DIR"
    git -C "$CLONE_DIR" pull --ff-only
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
