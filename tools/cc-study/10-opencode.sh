#!/usr/bin/env bash
# Finding (e) for opencode: how a bash PERMISSION prompt renders in the opencode
# TUI inside tmux, and what the server's SSE event stream (`GET /event` on the
# TUI's own --port) emits for it — the surface tg-ctl's opencode adapter
# (features/tg-ctl/opencode.ts) is written against. Isolated via XDG_* dirs; only
# the provider auth file is copied in (never printed). Runs without plugins.
source "$(dirname "$0")/lib.sh"
cc_setup 10-opencode
command -v opencode >/dev/null || { echo "opencode not installed" > "$CC_OUT/NOT-INSTALLED.txt"; exit 0; }
XDG="$CC_LAB/xdg"; mkdir -p "$XDG/config/opencode" "$XDG/data/opencode" "$XDG/state" "$XDG/cache"
( umask 077; cp "$HOME/.local/share/opencode/auth.json" "$XDG/data/opencode/auth.json" )
python3 - "$HOME/.config/opencode/opencode.json" "$XDG/config/opencode/opencode.json" <<'PY'
import json, sys
src = json.load(open(sys.argv[1]))
json.dump({"$schema": src.get("$schema"), "provider": src.get("provider", {}),
           "permission": {"bash": "ask", "edit": "ask"}}, open(sys.argv[2], "w"), indent=1)
PY
PORT=4097
echo "opencode_version=$(opencode --version 2>&1)" >> "$CC_OUT/meta.txt"
cc_require_memory_ok
cc_send "clear; XDG_CONFIG_HOME=$XDG/config XDG_DATA_HOME=$XDG/data XDG_STATE_HOME=$XDG/state XDG_CACHE_HOME=$XDG/cache opencode --pure --port $PORT --model '${OC_MODEL:-zai/glm-5.2}'" Enter
cc_wait_for 'opencode|Ask|Build|Plan' 60 || true
sleep 3
# SSE tap: every event the server emits, with a receive timestamp.
( curl -sN "http://127.0.0.1:$PORT/event" | while IFS= read -r line; do printf '%s\t%s\n' "$(cc_now_ms)" "$line"; done ) > "$CC_OUT/sse-events.tsv" 2>&1 &
SSE_PID=$!
cc_snapshot startup
cc_prompt 'Run exactly this shell command: echo study-10 > out.txt . Do not explain.'
cc_wait_for 'ermission|allow|Allow|once|always' 90 || true
sleep 2
cc_snapshot pending-screen
cc_options > "$CC_OUT/pending-options.txt" || true
cc_capture | grep -nE 'ermission|llow|once|always|reject|Reject|deny|Deny|Enter|tab' > "$CC_OUT/pending-hints.txt" || true
cc_send Enter; sleep 4
cc_snapshot after-enter-screen
ls "$CC_REPO" > "$CC_OUT/repo-after.txt"
kill "$SSE_PID" 2>/dev/null || true
cc_send C-c; sleep 0.5; cc_send C-c; sleep 1
