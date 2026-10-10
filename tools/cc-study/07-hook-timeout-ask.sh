#!/usr/bin/env bash
# Finding (b) for AskUserQuestion: the PreToolUse hook payload, timeout
# behaviour (5 s timeout, hook sleeps 20 s, then prints an `updatedInput`
# answers reply — the envelope tg-ctl uses), whether the dialog appears at the
# timeout, whether the late reply is honoured, and whether PermissionRequest
# also fires for the same call.
source "$(dirname "$0")/lib.sh"
CC_HOOK_TIMEOUT=5
cc_setup 07-hook-timeout-ask
cc_launch
Q='{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"r"},{"label":"Green","description":"g"}],"multiSelect":false}]}'
REPLY="{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"updatedInput\":{\"questions\":$(python3 -c "import json;print(json.dumps(json.loads('$Q')['questions']))"),\"answers\":{\"Which color?\":\"Green\"}}}}"
cc_hook_mode "sleep=20" "reply=$REPLY" "for=PreToolUse"
cc_prompt 'Call the AskUserQuestion tool with exactly one question "Which color?" (header "Color") and the options Red (description "r") and Green (description "g"). Do not answer it yourself.'
cc_wait_prompt 60
echo "prompt_visible_at_ms=$(cc_now_ms)" >> "$CC_OUT/timeline.txt"
cc_evidence_pending pending-at-timeout
sleep 22
echo "late_reply_checked_at_ms=$(cc_now_ms)" >> "$CC_OUT/timeline.txt"
cc_evidence_pending after-late-reply
if cc_capture | grep -q 'Which color'; then
  echo "late_reply=ignored (dialog still up) -> answering with 1" >> "$CC_OUT/timeline.txt"
  cc_send 1; sleep 0.5; cc_send Enter
else
  echo "late_reply=honoured (dialog gone without a keypress)" >> "$CC_OUT/timeline.txt"
fi
cc_wait_idle 60; sleep 2
cc_evidence_pending answered
# Control: the hook answers within the timeout with the same envelope.
cc_hook_mode "sleep=2" "reply=$REPLY" "for=PreToolUse"
cc_prompt 'Call the AskUserQuestion tool again with the same single question "Which color?" (header "Color", options Red/Green). Do not answer it yourself.'
sleep 14
cc_evidence_pending control-hook-answered
cc_quit_claude
