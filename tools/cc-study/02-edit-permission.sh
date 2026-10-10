#!/usr/bin/env bash
# Finding (a) for Edit/Write: exact rendering of the edit permission prompt
# including the deny label, and what a deny (option "No") does next.
source "$(dirname "$0")/lib.sh"
cc_setup 02-edit-permission
cc_launch
cc_prompt 'Use the Edit tool to replace the word hello with goodbye in README.md. Do not explain, do not ask.'
cc_wait_prompt
sleep 1
cc_evidence_pending pending
cc_options > "$CC_OUT/pending-options.txt"
# Deny with the LAST option (the "No" variant) to see what follows a deny.
last="$(cc_last_option_digit)"
echo "deny_digit=$last" > "$CC_OUT/deny-digit.txt"
cc_send "$last"
sleep 2
cc_snapshot after-deny-screen
cc_transcript_tail after-deny-transcript
sleep 5
cc_snapshot after-deny-5s-screen
cc_quit_claude
