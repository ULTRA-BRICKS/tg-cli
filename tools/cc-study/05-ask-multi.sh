#!/usr/bin/env bash
# Finding (a) for a MULTI-question AskUserQuestion (2 questions): rendering of
# the tabbed dialog, one hook invocation for the whole set, how the second
# question is reached and how the set is submitted.
source "$(dirname "$0")/lib.sh"
cc_setup 05-ask-multi
cc_launch
cc_prompt 'Call the AskUserQuestion tool ONCE with two questions: "Which color?" (options Red, Green) and "Which size?" (options Small, Large). Do not answer them yourself.'
cc_wait_prompt 120
sleep 1
cc_evidence_pending pending-q1
cc_options > "$CC_OUT/pending-q1-options.txt"
cc_send 1; sleep 1.5
cc_snapshot after-q1-digit-screen
cc_options > "$CC_OUT/q2-options.txt"
cc_send 2; sleep 1.5
cc_snapshot after-q2-digit-screen
cc_send Enter; sleep 2
cc_snapshot after-enter-screen
cc_wait_idle
sleep 2
cc_evidence_pending answered
cc_quit_claude
