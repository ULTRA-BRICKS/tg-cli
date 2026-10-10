#!/usr/bin/env bash
# The study's hook command. Records, per invocation, into $CC_CTL/:
#   <n>-<event>.json    full stdin payload (as received)
#   <n>-<event>.env     the hook's CLAUDE*/TMUX* environment, SECRETS SCRUBBED
#   log.tsv             one line per lifecycle step: ts_ms, id, event, step
#                       (start | reply | end | signal=<SIG>), with the mode used
# Behaviour is read from $CC_CTL/mode at fire time (so a study script can change
# it without restarting Claude):
#   sleep=N        seconds to block before replying
#   reply=<json>   printed to stdout before exiting 0 (empty = no output)
#   for=<Ev,Ev>    apply sleep/reply ONLY to these events (default: all)
#   detach=1       additionally fork a child that outlives THIS process, sleeps
#                  `sleep` seconds and then writes `reply` to the SAME stdout —
#                  the "late reply after the harness killed the hook" probe
set -u
EV="${1:-unknown}"
: "${CC_CTL:?CC_CTL must point at the control dir}"
mkdir -p "$CC_CTL"
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
N="$(ls "$CC_CTL" | grep -c '\.json$' || true)"; N=$((N+1)); ID="$(printf '%03d' "$N")"
logline() { printf '%s\t%s\t%s\t%s\n' "$(now_ms)" "$ID" "$EV" "$*" >> "$CC_CTL/log.tsv"; }
PAYLOAD="$(cat)"
printf '%s' "$PAYLOAD" > "$CC_CTL/$ID-$EV.json"
env | sort | grep -E '^(CLAUDE|TMUX|HOME=|PWD=)' | grep -viE 'TOKEN|KEY|SECRET|PASS|CREDENTIAL' > "$CC_CTL/$ID-$EV.env"
SLEEP=0; REPLY=""; FOR=""; DETACH=""
if [ -f "$CC_CTL/mode" ]; then
  SLEEP="$(sed -n 's/^sleep=//p' "$CC_CTL/mode" | head -1)"; SLEEP="${SLEEP:-0}"
  REPLY="$(sed -n 's/^reply=//p' "$CC_CTL/mode" | head -1)"
  FOR="$(sed -n 's/^for=//p' "$CC_CTL/mode" | head -1)"
  DETACH="$(sed -n 's/^detach=//p' "$CC_CTL/mode" | head -1)"
fi
if [ -n "$FOR" ] && ! printf ',%s,' "$FOR" | grep -q ",$EV,"; then SLEEP=0; REPLY=""; DETACH=""; fi
logline "start pid=$$ sleep=$SLEEP reply=${REPLY:+yes} detach=${DETACH:-0}"
for sig in TERM INT HUP PIPE; do
  # shellcheck disable=SC2064
  trap "logline 'signal=$sig'; exit 143" "$sig"
done
if [ -n "$DETACH" ] && [ -n "$REPLY" ]; then
  # Ignore the signals the harness sends to the hook's process group at timeout,
  # so the child really outlives the hook (first run: the child died with it).
  # Heartbeat every second so the log shows exactly WHEN the child stops
  # existing (a SIGKILL leaves no other trace).
  ( trap '' TERM HUP INT PIPE; for ((i=1;i<=SLEEP;i++)); do sleep 1; printf '%s\t%s\t%s\tdetached-child alive %ss\n' "$(now_ms)" "$ID" "$EV" "$i" >> "$CC_CTL/log.tsv"; done; printf '%s\n' "$REPLY"; rc=$?; printf '%s\t%s\t%s\tdetached-child wrote reply rc=%s\n' "$(now_ms)" "$ID" "$EV" "$rc" >> "$CC_CTL/log.tsv" ) &
  disown
fi
[ "$SLEEP" != "0" ] && sleep "$SLEEP"
if [ -n "$REPLY" ]; then printf '%s\n' "$REPLY"; logline "reply"; fi
logline "end"
exit 0
