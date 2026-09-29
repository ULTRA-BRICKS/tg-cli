#!/usr/bin/env bash
# Finding (c): the per-process registry <config>/sessions/<pid>.json — what it
# holds while idle / working / waiting, whether it is removed on a clean exit,
# and whether it goes STALE (left behind) when the process is killed -9. This
# decides how "asker gone" must be detected (pid liveness + procStart, not the
# file's mere existence).
source "$(dirname "$0")/lib.sh"
cc_setup 09-process-lifecycle
cc_launch; sleep 2
cc_process_state idle
# (`sleep N` alone is auto-allowed as a safe command and never prompts — first run.)
cc_prompt 'Use the Bash tool to run exactly this command: sleep 4 && echo lc > lc.txt . Do not explain, do not ask.'
cc_wait_prompt 60; sleep 1
cc_process_state waiting-permission
cc_send 1; sleep 1.5
cc_process_state working-tool-running
cc_wait_idle 60; sleep 2
cc_process_state idle-again
pid="$(cc_claude_pid)"; echo "pid=$pid" > "$CC_OUT/pids.txt"
cc_send "/exit" Enter; sleep 4
ls "$CC_HOME/.claude/sessions/" > "$CC_OUT/sessions-after-clean-exit.txt" 2>&1 || true
ls -la /tmp/cc-socks/"$pid".sock >> "$CC_OUT/sessions-after-clean-exit.txt" 2>&1 || true
# Second process: SIGKILL it.
cc_launch; sleep 2
pid2="$(cc_claude_pid)"; echo "pid2=$pid2" >> "$CC_OUT/pids.txt"
cc_process_state second-idle
kill -9 "$pid2"; sleep 2
ls -la "$CC_HOME/.claude/sessions/" > "$CC_OUT/sessions-after-sigkill.txt" 2>&1 || true
ls -la /tmp/cc-socks/"$pid2".sock >> "$CC_OUT/sessions-after-sigkill.txt" 2>&1 || true
{ echo "kill -0 $pid2:"; kill -0 "$pid2" 2>&1 && echo alive || echo dead; } >> "$CC_OUT/sessions-after-sigkill.txt"
cc_snapshot after-sigkill-screen
