#!/usr/bin/env bash
# Capture the REAL Claude Code permission box for one scripted Bash tool call
# (tg-cli#283). Usage: run.sh <scenario> [approve]
#   fake-api.ts must be running (bun fake-api.ts); CLAUDE_BIN = the claude to study
#   (default: claude on PATH); WIDTH/HEIGHT = pane size (default 200x50);
#   approve = press 1 on the first prompt, then capture the next one (second-J.txt).
# Isolated: private tmux server (-L cc283-<scenario>), throwaway HOME/CLAUDE_CONFIG_DIR and
# repo, a fake API key (no login, no Anthropic traffic: ANTHROPIC_BASE_URL is the fake).
# PORT must match fake-api.ts's (both default to 18283).
set -euo pipefail
S="${1:?usage: run.sh <scenario> [approve]}"; HERE="$(cd "$(dirname "$0")" && pwd)"
# The name becomes a path that is rm -rf'd and text typed into a shell: a scenarios.json key only.
[[ "$S" =~ ^[A-Za-z0-9_]+$ ]] || { echo "bad scenario name: $S" >&2; exit 2; }
python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)' "$HERE/scenarios.json" "$S" \
  || { echo "no scenario $S in scenarios.json" >&2; exit 2; }
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
: "${CLAUDE_BIN:?set CLAUDE_BIN or put claude on PATH}"
LAB="${TMPDIR:-/tmp}/cc283-lab-$S"; OUT="${OUT_DIR:-$HERE/../../../docs/cc-tmux-evidence/283-multiline-bash}/$S"
rm -rf "$LAB" "$OUT"; mkdir -p "$LAB/home/.claude" "$LAB/repo" "$OUT"
git -C "$LAB/repo" init -q
KEY=sk-ant-api03-fakekeyforcc283evidence0000000000
# Onboarding done, repo trusted, the fake key pre-approved: the TUI opens on the prompt.
python3 - "$LAB/home/.claude/.claude.json" "$LAB/repo" "${KEY: -20}" <<'PY'
import json, sys
path, repo, tail = sys.argv[1:4]
json.dump({"hasCompletedOnboarding": True, "theme": "dark", "autoUpdates": False, "numStartups": 5,
           "customApiKeyResponses": {"approved": [tail], "rejected": []},
           "projects": {repo: {"hasTrustDialogAccepted": True, "allowedTools": []}}}, open(path, "w"))
PY
echo '{"permissions":{"defaultMode":"default"}}' > "$LAB/home/.claude/settings.json"
T=(tmux -L "cc283-$S")
"${T[@]}" kill-server 2>/dev/null || true
trap '"${T[@]}" kill-server 2>/dev/null || true; rm -rf "$LAB"' EXIT
env -i HOME="$LAB/home" PATH="$PATH" USER="${USER:-study}" SHELL=/bin/bash TERM=xterm-256color LANG=en_US.UTF-8 TMPDIR="${TMPDIR:-/tmp}" \
  "${T[@]}" new-session -d -s s -x "${WIDTH:-200}" -y "${HEIGHT:-50}" -c "$LAB/repo"
"${T[@]}" set -g escape-time 0 >/dev/null
"${T[@]}" send-keys -t s "export CLAUDE_CONFIG_DIR=$LAB/home/.claude ANTHROPIC_API_KEY=$KEY ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT:-18283} DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1; clear; $CLAUDE_BIN --permission-mode default 'SCENARIO:$S'" Enter
# Until a permission menu is up whose screen differs from $1 (the previous capture, if any).
wait_menu() {
  local now
  for _ in $(seq 1 40); do
    sleep 1
    now="$("${T[@]}" capture-pane -p -J -t s)"
    if grep -q 'Do you want to proceed' <<<"$now" && [ "$now" != "${1:-}" ]; then return 0; fi
  done
  echo "timed out waiting for a permission menu" >&2; return 1
}
wait_menu; sleep 1
"${T[@]}" capture-pane -p -J -t s > "$OUT/pending-J.txt"
"${T[@]}" capture-pane -p -e -t s > "$OUT/pending-e.txt"
if [ "${2:-}" = approve ]; then
  "${T[@]}" send-keys -t s 1
  wait_menu "$(cat "$OUT/pending-J.txt")"; sleep 1
  "${T[@]}" capture-pane -p -J -t s > "$OUT/second-J.txt"
fi
{ "$CLAUDE_BIN" --version; "${T[@]}" -V; echo "size=${WIDTH:-200}x${HEIGHT:-50}"; date -u +%FT%TZ; } > "$OUT/meta.txt"
echo "captured $OUT"
