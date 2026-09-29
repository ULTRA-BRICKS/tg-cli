#!/usr/bin/env bash
# Finding (a)/(c)/(d) for the Bash tool: exact rendering of the Bash permission
# prompt, the transcript tail while it is pending vs after, and that a bare
# digit "1" submits the menu without Enter.
source "$(dirname "$0")/lib.sh"
cc_setup 01-bash-permission
cc_launch
cc_prompt 'Use the Bash tool to run exactly this command: echo study-01 > out.txt . Do not explain, do not ask.'
cc_wait_prompt
sleep 1
cc_evidence_pending pending
cc_options > "$CC_OUT/pending-options.txt"
cc_send 1            # bare digit, no Enter
sleep 2
cc_snapshot after-digit-screen
cc_wait_idle
sleep 2
cc_evidence_pending answered
ls "$CC_REPO" > "$CC_OUT/repo-after.txt"
cc_quit_claude
