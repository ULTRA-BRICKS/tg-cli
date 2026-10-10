#!/usr/bin/env bash
# In-pane launcher: pulls the OAuth token from the macOS Keychain into the
# process env (never onto disk / the screen) and execs Claude Code with the
# study's default flags. Invoked by lib.sh's cc_launch via tmux send-keys with
# HOME already pointed at the isolated lab home.
set -euo pipefail
# CC_KEYCHAIN_SERVICE selects which stored login to use (a multi-account setup
# keeps one item per config dir: "Claude Code-credentials-<sha256(dir)[:8]>").
CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s "${CC_KEYCHAIN_SERVICE:-Claude Code-credentials}" -w \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')"
export CLAUDE_CODE_OAUTH_TOKEN
# The Keychain lookup above needs the REAL $HOME (the login keychain lives under
# ~/Library/Keychains); only now switch to the isolated lab home.
export HOME="${CC_HOME:?CC_HOME must be set}"
# The user's shell may export CLAUDE_CONFIG_DIR (a multi-account setup); the
# private tmux server inherits it, and Claude Code prefers it over $HOME — the
# first study runs silently landed in the REAL account dir this way. Pin it.
export CLAUDE_CONFIG_DIR="$HOME/.claude"
cd "${CC_REPO_DIR:-$PWD}"
exec /Users/ultra/.local/bin/claude --permission-mode default --model "${CC_MODEL:-haiku}" "$@"
