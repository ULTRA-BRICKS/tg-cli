#!/usr/bin/env bash
# Finding (a)/(d) for AskUserQuestion (single question): exact rendering, the
# PreToolUse hook payload, and Down+Enter selection of the second option.
source "$(dirname "$0")/lib.sh"
cc_setup 04-ask-single
cc_launch
cc_prompt 'Call the AskUserQuestion tool with exactly one question "Which color?" and the options Red and Green (with short descriptions). Do not answer it yourself.'
cc_wait_prompt 120
sleep 1
cc_evidence_pending pending
cc_options > "$CC_OUT/pending-options.txt"
sleep 3; cc_transcript_tail pending-transcript-3s-later
cc_send Down; sleep 1
cc_snapshot after-down-screen
cc_send Enter; sleep 2
cc_snapshot after-enter-screen
cc_wait_idle
sleep 2
cc_evidence_pending answered
cc_quit_claude
