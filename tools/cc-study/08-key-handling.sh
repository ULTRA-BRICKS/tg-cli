#!/usr/bin/env bash
# Finding (d): how keys injected with `tmux send-keys` reach a pending Bash
# permission menu. No tmux client is attached at any point (the private server
# is headless), so "focus" is not a factor. Cases: a digit that is not an
# option, a digit while the pane is in tmux copy-mode, `send-keys -l`
# (literal) digit, digit + Enter (where does the Enter land?), Esc.
source "$(dirname "$0")/lib.sh"
cc_setup 08-key-handling
cc_launch
prompt_bash() { cc_prompt "Use the Bash tool to run exactly this command: echo $1 > $1.txt . Do not explain, do not ask."; cc_wait_prompt 60; sleep 1; }

prompt_bash k1
cc_snapshot k1-pending
cc_send 9; sleep 1.5; cc_snapshot k1-after-nonoption-digit-9
"${CC_TMUX[@]}" copy-mode -t "$CC_SESSION"; sleep 0.5; cc_snapshot k1-copy-mode-entered
cc_send 1; sleep 1.5; cc_snapshot k1-after-digit-in-copy-mode
cc_send q; sleep 0.5; cc_snapshot k1-copy-mode-left
cc_send -l 1; sleep 2; cc_snapshot k1-after-literal-digit-1
cc_wait_idle 60; sleep 1

prompt_bash k2
cc_send 1 Enter; sleep 2; cc_snapshot k2-after-digit-plus-enter
cc_wait_idle 60; sleep 1; cc_snapshot k2-idle-after
cc_transcript_tail k2-transcript

prompt_bash k3
cc_send Escape; sleep 2; cc_snapshot k3-after-escape
cc_transcript_tail k3-transcript-after-escape
cc_wait_idle 60; sleep 1

prompt_bash k4
cc_send Down Down; sleep 1; cc_snapshot k4-after-down-down
cc_send Enter; sleep 2; cc_snapshot k4-after-enter-on-no
cc_transcript_tail k4-transcript-after-no
ls "$CC_REPO" > "$CC_OUT/repo-after.txt"
cc_quit_claude
