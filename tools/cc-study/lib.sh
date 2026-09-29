#!/usr/bin/env bash
# Shared harness for the Claude-Code-in-tmux study (tg-cli#304).
#
# Every study script sources this file. It provides an ISOLATED lab:
#   * a private tmux server (`tmux -L cc-study`) — never the user's live server
#   * an isolated $HOME (CC_HOME) with a minimal ~/.claude/settings.json whose
#     hooks point at hook-logger.sh (records stdin JSON, scrubbed env, timing)
#   * a throwaway git repo as cwd
#   * a 1 Hz frame poller (capture-pane -p -e + tmux pane flags) so every
#     finding is backed by a timeline of screen states, not a single capture
#   * a teardown trap that kills the private server and removes CC_HOME
#
# Config dir: CLAUDE_CONFIG_DIR is pinned to $CC_HOME/.claude everywhere a
# claude process starts (run-claude.sh, cc_probe_auth) — an inherited value from
# the user's shell would otherwise win over $HOME (Claude Code checks the env
# var first) and the study would write into the user's real config dir.
#
# Auth: on macOS Claude Code reads its OAuth credentials from the login Keychain
# (service "Claude Code-credentials", suffixed with a config-dir hash for
# non-default config dirs) and IGNORES ~/.claude/.credentials.json — an isolated
# HOME is therefore "Not logged in" (see docs/cc-tmux-evidence/00-auth/). The
# launcher (run-claude.sh) exports CLAUDE_CODE_OAUTH_TOKEN from the Keychain
# inside the pane; the token value is never written to disk or shown on screen.
set -euo pipefail

CC_STUDY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_BIN="${CC_BIN:-/Users/ultra/.local/bin/claude}"
CC_SOCK="${CC_SOCK:-cc-study}"
CC_SESSION="${CC_SESSION:-study}"
CC_TMUX=(tmux -L "$CC_SOCK")
CC_LAB="${CC_LAB:-${TMPDIR:-/tmp}/cc-study-$$}"
CC_HOME="$CC_LAB/home"
CC_REPO="$CC_LAB/repo"
CC_CTL="$CC_LAB/ctl"          # hook-logger control + logs
CC_EVIDENCE="${CC_EVIDENCE:-$CC_STUDY_DIR/../../docs/cc-tmux-evidence}"
CC_POLL_PID=""

cc_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
cc_now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# Never launch a claude while the machine is under memory pressure: wait
# (bounded) for kern.memorystatus_vm_pressure_level to return to 1.
cc_require_memory_ok() {
  local lvl i=0
  while :; do
    lvl="$(sysctl -n kern.memorystatus_vm_pressure_level)"
    [ "$lvl" = "1" ] && return 0
    i=$((i+1))
    if [ $i -gt 24 ]; then cc_log "memory pressure level is $lvl (need 1) for 2 min — refusing to launch"; exit 3; fi
    cc_log "memory pressure level $lvl — waiting"; sleep 5
  done
}

# $1 = evidence subdir name (e.g. 01-bash-permission). Creates the lab.
cc_setup() {
  local name="$1"
  CC_OUT="$CC_EVIDENCE/$name"
  rm -rf "$CC_OUT"; mkdir -p "$CC_OUT/frames" "$CC_OUT/hooks"
  mkdir -p "$CC_HOME/.claude" "$CC_REPO" "$CC_CTL"
  # Claude Code keys project trust by the REAL path (/private/var/... on macOS,
  # not the /var/... symlink) — a mismatch shows the "Quick safety check" trust
  # dialog on startup (docs/cc-tmux-evidence/00-smoke/trust-dialog.txt).
  CC_LAB="$(cd "$CC_LAB" && pwd -P)"; CC_HOME="$CC_LAB/home"; CC_REPO="$CC_LAB/repo"; CC_CTL="$CC_LAB/ctl"
  trap cc_teardown EXIT INT TERM
  git -C "$CC_REPO" init -q
  printf 'hello\nworld\n' > "$CC_REPO/README.md"
  git -C "$CC_REPO" -c user.email=study@example.com -c user.name=study add -A
  git -C "$CC_REPO" -c user.email=study@example.com -c user.name=study commit -qm init
  # Minimal onboarding-complete state + pre-trusted repo, so the TUI opens on
  # the prompt instead of theme/trust dialogs. With CLAUDE_CONFIG_DIR set the
  # file lives INSIDE the config dir (<config>/.claude.json), not at ~/.claude.json
  # (a ~/.claude.json there is ignored: full theme onboarding showed).
  python3 - "$CC_HOME/.claude/.claude.json" "$CC_REPO" <<'PY'
import json, sys
path, repo = sys.argv[1], sys.argv[2]
json.dump({
  "hasCompletedOnboarding": True, "theme": "dark", "autoUpdates": False,
  "numStartups": 5, "projects": {repo: {"hasTrustDialogAccepted": True, "allowedTools": []}},
}, open(path, "w"))
PY
  cc_write_settings "${CC_HOOK_TIMEOUT:-120}"
  cc_hook_mode "sleep=0"
  "${CC_TMUX[@]}" kill-server 2>/dev/null || true
  # A tmux server inherits the environment of the process that starts it, and
  # this study is usually launched FROM a Claude Code session (CLAUDECODE=1,
  # CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_CHILD_SESSION, ...). Start the
  # private server with a minimal environment so the studied Claude never sees
  # a parent session's variables (evidence: 01-bash-permission/hooks/*.env).
  env -i HOME="$HOME" PATH="$PATH" USER="${USER:-$(id -un)}" SHELL="${SHELL:-/bin/zsh}" \
    TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    "${CC_TMUX[@]}" new-session -d -s "$CC_SESSION" -x 200 -y 50 -c "$CC_REPO"
  "${CC_TMUX[@]}" set -g escape-time 0 >/dev/null 2>&1 || true
  {
    echo "date_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "claude_version=$("$CC_BIN" --version 2>&1)"
    echo "tmux_version=$("${CC_TMUX[@]}" -V)"
    echo "macos=$(sw_vers -productVersion 2>/dev/null || uname -r)"
    echo "hook_timeout_sec=${CC_HOOK_TIMEOUT:-120}"
  } > "$CC_OUT/meta.txt"
  cc_poll_start
}

# Write the isolated settings.json. $1 = hook timeout in seconds.
cc_write_settings() {
  local t="$1" logger="$CC_STUDY_DIR/hook-logger.sh"
  python3 - "$CC_HOME/.claude/settings.json" "$logger" "$t" "$CC_CTL" <<'PY'
import json, sys
path, logger, t, ctl = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
def cmd(ev): return {"type": "command", "command": f"CC_CTL={ctl} bash {logger} {ev}", "timeout": t}
json.dump({
  "hooks": {
    "PermissionRequest": [{"matcher": "*", "hooks": [cmd("PermissionRequest")]}],
    "PreToolUse": [{"matcher": "AskUserQuestion|ExitPlanMode", "hooks": [cmd("PreToolUse")]}],
    "PostToolUse": [{"matcher": "*", "hooks": [cmd("PostToolUse")]}],
    "Notification": [{"matcher": "*", "hooks": [cmd("Notification")]}],
  }
}, open(path, "w"), indent=1)
PY
}

# Hook behaviour for the NEXT invocations: "sleep=N" and optional "reply=<json>".
cc_hook_mode() { printf '%s\n' "$@" > "$CC_CTL/mode"; }

cc_poll_start() {
  (
    local last="" n=0
    while :; do
      local ts frame flags
      ts="$(cc_now_ms)"
      frame="$("${CC_TMUX[@]}" capture-pane -p -e -t "$CC_SESSION" 2>/dev/null || echo '<capture failed>')"
      flags="$("${CC_TMUX[@]}" display -p -t "$CC_SESSION" '#{alternate_on} #{pane_in_mode} #{pane_current_command} #{cursor_x},#{cursor_y}' 2>/dev/null || echo '? ? ? ?')"
      status="$(cc_session_status)"
      if [ "$frame" != "$last" ]; then
        n=$((n+1))
        printf '%s' "$frame" > "$CC_OUT/frames/$(printf '%04d' "$n")-$ts.txt"
        last="$frame"
      fi
      # One line per tick: ts, frame number, tmux flags, sessions/<pid>.json status.
      printf '%s\t%04d\t%s\t%s\n' "$ts" "$n" "$flags" "$status" >> "$CC_OUT/frames/index.tsv"
      sleep 1
    done
  ) &
  CC_POLL_PID=$!
}

# "status=<status> waitingFor=<...> statusUpdatedAt=<ms>" from the per-process
# registry Claude Code maintains at <config>/sessions/<pid>.json, or "no-session-file".
cc_session_status() {
  local f
  for f in "$CC_HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    python3 - "$f" <<'PY' 2>/dev/null && return 0
import json, sys
d = json.load(open(sys.argv[1]))
print(f"pid={d.get('pid')} status={d.get('status')} waitingFor={d.get('waitingFor')!r} statusUpdatedAt={d.get('statusUpdatedAt')}")
PY
  done
  echo "no-session-file"
}

cc_poll_stop() { [ -n "$CC_POLL_PID" ] && kill "$CC_POLL_PID" 2>/dev/null || true; CC_POLL_PID=""; }

# Launch claude in the pane. Extra args are appended (e.g. --permission-mode plan).
cc_launch() {
  cc_require_memory_ok
  "${CC_TMUX[@]}" send-keys -t "$CC_SESSION" "clear; CC_HOME=$CC_HOME CC_KEYCHAIN_SERVICE='${CC_KEYCHAIN_SERVICE:-Claude Code-credentials}' bash $CC_STUDY_DIR/run-claude.sh $*" Enter
  cc_wait_for '\? for shortcuts|Try "|Yes, I trust this folder' 60
  # A fresh HOME shows the workspace-trust dialog even with
  # projects.<realpath>.hasTrustDialogAccepted=true in ~/.claude.json (observed
  # 2.1.261, docs/cc-tmux-evidence/00-smoke/trust-dialog.txt). Its cursor
  # defaults to "No, exit": Down + Enter accepts.
  if cc_capture | grep -q 'Yes, I trust this folder'; then
    cc_snapshot trust-dialog
    cc_send Down; sleep 0.3; cc_send Enter
    cc_wait_for '\? for shortcuts|Try "' 60
  fi
}

cc_send() { "${CC_TMUX[@]}" send-keys -t "$CC_SESSION" "$@"; }
cc_capture() { "${CC_TMUX[@]}" capture-pane -p -t "$CC_SESSION"; }
cc_capture_raw() { "${CC_TMUX[@]}" capture-pane -p -e -J -t "$CC_SESSION"; }
cc_flags() { "${CC_TMUX[@]}" display -p -t "$CC_SESSION" 'alternate_on=#{alternate_on} pane_in_mode=#{pane_in_mode} cmd=#{pane_current_command}'; }

# Wait until the plain capture matches the regex ($1) or $2 seconds elapse.
cc_wait_for() {
  local re="$1" secs="${2:-60}" i=0
  while [ $i -lt "$secs" ]; do
    if cc_capture | grep -Eq "$re"; then return 0; fi
    sleep 1; i=$((i+1))
  done
  cc_log "timeout waiting for /$re/"; return 1
}

# Snapshot current screen + flags into $CC_OUT/<label>.txt (plain + ansi).
cc_snapshot() {
  local label="$1"
  { echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) $(cc_flags)"; cc_capture; } > "$CC_OUT/$label.txt"
  cc_capture_raw > "$CC_OUT/$label.ansi.txt"
}

# Type a prompt into the Claude input and submit it.
cc_prompt() { cc_send -l -- "$1"; sleep 1; cc_send Enter; }

# Non-interactive auth probe; $1 = label, rest = extra env assignments.
cc_probe_auth() {
  local label="$1"; shift
  ( cd "$CC_REPO" && env HOME="$CC_HOME" CLAUDE_CONFIG_DIR="$CC_HOME/.claude" "$@" \
      timeout 60 "$CC_BIN" -p "Reply with exactly the word OK" --model haiku < /dev/null ) \
    > "$CC_OUT/$label.txt" 2>&1 || true
}

cc_transcript() { find "$CC_HOME/.claude/projects" -name '*.jsonl' 2>/dev/null | head -1; }

# Record the transcript tail (record types + a few fields) as evidence.
cc_transcript_tail() {
  local label="$1" f; f="$(cc_transcript || true)"
  [ -n "$f" ] || { echo "no transcript yet" > "$CC_OUT/$label.txt"; return; }
  python3 "$CC_STUDY_DIR/transcript-tail.py" "$f" > "$CC_OUT/$label.txt"
}

cc_copy_hook_logs() { cp -Rp "$CC_CTL"/. "$CC_OUT/hooks/" 2>/dev/null || true; rm -f "$CC_OUT/hooks/mode"; }

cc_quit_claude() {
  cc_send Escape; sleep 0.3; cc_send C-c; sleep 0.3; cc_send C-c; sleep 1
  cc_send "exit" Enter 2>/dev/null || true
}

cc_teardown() {
  cc_poll_stop
  cc_copy_hook_logs
  "${CC_TMUX[@]}" kill-server 2>/dev/null || true
  rm -rf "$CC_LAB"
  cc_log "teardown done (private tmux server killed, $CC_LAB removed)"
}

# Wait for an interactive Claude Code prompt (a numbered option list with the
# selection cursor on option 1) — permission menus, plan approval and
# AskUserQuestion all render this way (findings 01-05).
cc_wait_prompt() { cc_wait_for '❯ 1\.' "${1:-90}"; }

# Wait until the prompt is gone and Claude is back at its idle input box.
cc_wait_idle() { cc_wait_for '\? for shortcuts' "${1:-90}"; }

# Extract the option lines of the on-screen prompt (for the findings table).
cc_options() { cc_capture | grep -E '^\s*(❯\s*)?[0-9]\. ' || true; }

# Standard "prompt is up" evidence bundle: screen, flags, transcript tail,
# a listing of everything under the isolated ~/.claude, open sockets.
cc_evidence_pending() {
  local label="$1"
  cc_snapshot "$label-screen"
  cc_transcript_tail "$label-transcript"
  ( cd "$CC_HOME/.claude" && find . -type f -not -path './debug/*' -not -path './plugins/*' -not -path './cache/*' | sort | sed "s#^\./##" ) > "$CC_OUT/$label-home-files.txt"
  cc_process_state "$label"
}

# The studied claude process, from the per-process registry Claude Code keeps
# at <config>/sessions/<pid>.json (finding (c)). "" when none is registered.
cc_claude_pid() {
  local f
  for f in "$CC_HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] && python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$f" && return 0
  done
  return 0
}

# Digit of the LAST numbered option on screen (the deny / "No" variant).
cc_last_option_digit() { cc_options | python3 -c 'import re,sys;m=[re.search(r"([0-9])\.",l) for l in sys.stdin];m=[x.group(1) for x in m if x];print(m[-1] if m else "")'; }

# Process-level evidence for finding (c): the per-process files Claude Code
# keeps (sessions/<pid>.json, daemon state) and its open unix sockets.
cc_process_state() {
  local label="$1" pid; pid="$(cc_claude_pid || true)"
  {
    echo "# claude pid=${pid:-<none>} $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for f in "$CC_HOME"/.claude/sessions/*.json; do
      [ -f "$f" ] && { echo "## $(basename "$f")"; cat "$f"; echo; }
    done
    if [ -n "$pid" ]; then
      echo "## lsof unix sockets"; lsof -a -U -p "$pid" 2>/dev/null | awk '{print $1, $5, $8, $9}' | sort -u || true
      echo "## /tmp/cc-socks/$pid.sock"; ls -la "/tmp/cc-socks/$pid.sock" 2>&1 || true
    fi
  } > "$CC_OUT/$label-process.txt" || true
}
