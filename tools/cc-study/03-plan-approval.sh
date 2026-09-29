#!/usr/bin/env bash
# Finding (a) for plan approval (ExitPlanMode in --permission-mode plan): the
# exact "Would you like to proceed?" rendering + option labels, and which hook
# events fire for it (PreToolUse ExitPlanMode AND PermissionRequest?).
source "$(dirname "$0")/lib.sh"
cc_setup 03-plan-approval
cc_launch --permission-mode plan
cc_prompt 'Write a two-line plan to add a LICENSE file (MIT) to this repo, then call ExitPlanMode to present it. Do not ask questions.'
cc_wait_prompt 120
sleep 1
cc_evidence_pending pending
cc_options > "$CC_OUT/pending-options.txt"
last="$(cc_last_option_digit)"
echo "keep_planning_digit=$last" > "$CC_OUT/deny-digit.txt"
cc_send "$last"
sleep 3
cc_snapshot after-deny-screen
cc_transcript_tail after-deny-transcript
cc_quit_claude
