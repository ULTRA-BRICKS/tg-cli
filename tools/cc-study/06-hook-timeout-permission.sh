#!/usr/bin/env bash
# Finding (b) for PermissionRequest: the hook's stdin payload, what happens when
# the hook OUTLIVES its configured timeout (5 s here, hook sleeps 20 s), whether
# the terminal prompt appears at the timeout, whether the hook's LATE reply
# (an allow decision printed at t+20 s) is honoured or ignored, and whether the
# hook is re-invoked. A control prompt (hook replies allow within 2 s) follows.
source "$(dirname "$0")/lib.sh"
CC_HOOK_TIMEOUT=5
cc_setup 06-hook-timeout-permission
cc_launch
ALLOW='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
cc_hook_mode "sleep=20" "reply=$ALLOW" "for=PermissionRequest"
cc_prompt 'Use the Bash tool to run exactly this command: echo study-06 > out.txt . Do not explain, do not ask.'
cc_wait_prompt 60
echo "prompt_visible_at_ms=$(cc_now_ms)" >> "$CC_OUT/timeline.txt"
cc_evidence_pending pending-at-timeout
sleep 22        # past the hook's 20 s sleep + its late reply
echo "late_reply_checked_at_ms=$(cc_now_ms)" >> "$CC_OUT/timeline.txt"
cc_evidence_pending after-late-reply
ls "$CC_REPO" > "$CC_OUT/repo-after-late-reply.txt"
if cc_capture | grep -q 'Do you want to proceed'; then
  echo "late_reply=ignored (prompt still up) -> answering with 1" >> "$CC_OUT/timeline.txt"
  cc_send 1
else
  echo "late_reply=honoured (prompt gone without a keypress)" >> "$CC_OUT/timeline.txt"
fi
cc_wait_idle 60; sleep 2
cc_evidence_pending answered
# Control: the hook answers allow within the timeout -> no terminal prompt.
cc_hook_mode "sleep=2" "reply=$ALLOW" "for=PermissionRequest"
cc_prompt 'Use the Bash tool to run exactly this command: echo study-06b > out2.txt . Do not explain, do not ask.'
sleep 12
cc_evidence_pending control-hook-allowed
ls "$CC_REPO" > "$CC_OUT/repo-after-control.txt"
# Detached late writer: the hook process itself is killed at the 5 s timeout,
# but a forked child keeps the SAME stdout pipe, sleeps 20 s and then writes the
# allow reply. Does Claude Code still read it?
cc_hook_mode "sleep=20" "reply=$ALLOW" "for=PermissionRequest" "detach=1"
cc_prompt 'Use the Bash tool to run exactly this command: echo study-06c > out3.txt . Do not explain, do not ask.'
cc_wait_prompt 60
echo "detached_prompt_visible_at_ms=$(cc_now_ms)" >> "$CC_OUT/timeline.txt"
sleep 24
cc_evidence_pending after-detached-late-reply
ls "$CC_REPO" > "$CC_OUT/repo-after-detached.txt"
if cc_capture | grep -q 'Do you want to proceed'; then
  echo "detached_late_reply=ignored (prompt still up) -> answering with 3 (No)" >> "$CC_OUT/timeline.txt"
  cc_send 3
else
  echo "detached_late_reply=honoured (prompt gone without a keypress)" >> "$CC_OUT/timeline.txt"
fi
sleep 3
cc_evidence_pending after-detached-answer
cc_quit_claude
