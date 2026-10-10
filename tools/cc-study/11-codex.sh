#!/usr/bin/env bash
# Finding (e) for codex: how a command APPROVAL prompt renders in the codex TUI
# inside tmux, and what its PreToolUse hook receives. Isolated via CODEX_HOME;
# only auth.json is copied in (never printed). Sandbox read-only + approval
# on-request, so a file write must ask.
source "$(dirname "$0")/lib.sh"
cc_setup 11-codex
command -v codex >/dev/null || { echo "codex not installed" > "$CC_OUT/NOT-INSTALLED.txt"; exit 0; }
CH="$CC_LAB/codex"; mkdir -p "$CH"
( umask 077; cp "$HOME/.codex/auth.json" "$CH/auth.json" )
cat > "$CH/config.toml" <<EOF
model = "${CODEX_MODEL:-gpt-5.6-terra}"
approval_policy = "on-request"
sandbox_mode = "read-only"
[projects."$CC_REPO"]
trust_level = "trusted"
[hooks]
PreToolUse = [{matcher = "Bash", hooks = [{type = "command", command = "CC_CTL=$CC_CTL bash $CC_STUDY_DIR/hook-logger.sh PreToolUse"}]}]
PostToolUse = [{matcher = "Bash", hooks = [{type = "command", command = "CC_CTL=$CC_CTL bash $CC_STUDY_DIR/hook-logger.sh PostToolUse"}]}]
Stop = [{hooks = [{type = "command", command = "CC_CTL=$CC_CTL bash $CC_STUDY_DIR/hook-logger.sh Stop"}]}]
EOF
echo "codex_version=$(codex --version 2>&1)" >> "$CC_OUT/meta.txt"
cc_require_memory_ok
cc_send "clear; CODEX_HOME=$CH codex --dangerously-bypass-hook-trust -C $CC_REPO" Enter
cc_wait_for 'codex|Codex|OpenAI' 60 || true
sleep 4
cc_snapshot startup
cc_prompt 'Run exactly this shell command: echo study-11 > out.txt . Do not explain.'
cc_wait_for 'pprov|llow|Yes|es \(|y\)|Run' 120 || true
sleep 2
cc_snapshot pending-screen
cc_options > "$CC_OUT/pending-options.txt" || true
cc_capture | grep -nE 'pprov|llow|Yes|No|always|Enter|esc|Esc' > "$CC_OUT/pending-hints.txt" || true
cc_send Enter; sleep 5
cc_snapshot after-enter-screen
ls "$CC_REPO" > "$CC_OUT/repo-after.txt"
cc_send C-c; sleep 0.5; cc_send C-c; sleep 1
