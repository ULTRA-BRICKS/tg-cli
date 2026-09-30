#!/usr/bin/env bash
# CI entry for the test suite: `bun test` under a stall watchdog (tg-cli#506).
#
# bun's per-test and hook timeouts only fire while its event loop runs. A test
# process wedged below that (blocked syscall, stopped process, runtime deadlock)
# printed nothing more and the job sat silent until the runner killed it ~11 min
# later, naming no file. This wrapper streams bun's output unchanged and, when it
# stops growing for BUN_TEST_STALL_SECS, prints the test file that was running,
# its last output lines, and the process table, then kills the run and exits 124.
#
# bun runs under a pseudo-terminal (util-linux `script`, so Linux/CI only): on a
# plain pipe it buffers its whole report until exit, which would leave the watchdog
# nothing to measure and lose the report on a kill. On a terminal it prints each
# file header and result as it lands.
#
# Knobs (env):
#   BUN_TEST_STALL_SECS  seconds without output before the run counts as hung.
#                        Default 180: twice the longest per-test timeout (90 s).
#
# Usage: ci/test/bun-test-watchdog.sh [bun test args...]
set -uo pipefail

stall="${BUN_TEST_STALL_SECS:-180}"
[[ "$stall" =~ ^[1-9][0-9]*$ ]] || { echo "BUN_TEST_STALL_SECS must be a positive integer, got '$stall'" >&2; exit 2; }
poll=5
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# -e returns the child's exit status, -f flushes every write; the typescript file
# doubles as the watchdog's log while the output still streams to stdout. `%q` quotes
# each arg for `script`'s `sh -c`; zero args must stay zero (not a `''` filter).
cmd="bun test"
[ "$#" -gt 0 ] && cmd+=" $(printf '%q ' "$@")"
script -qfec "$cmd" "$log" < /dev/null &
run_pid=$!

# Every process below $1, deepest last (the run's bun and the daemons its tests spawned).
descendants() {
  local child
  for child in $(ps -Ao pid=,ppid= | awk -v p="$1" '$2 == p { print $1 }'); do
    echo "$child"
    descendants "$child"
  done
}

last_size=-1
idle=0
while kill -0 "$run_pid" 2>/dev/null; do
  sleep "$poll"
  size=$(wc -c < "$log")
  if [ "$size" -ne "$last_size" ]; then
    last_size=$size
    idle=0
    continue
  fi
  idle=$((idle + poll))
  [ "$idle" -lt "$stall" ] && continue
  # The run may have finished during the last sleep: its own exit status wins.
  kill -0 "$run_pid" 2>/dev/null || break

  # bun runs test files one at a time and announces each as `tests/x.test.ts:`
  # (`::group::tests/x.test.ts:` under GitHub-style CI); the last announcement is the
  # file still running. Colour codes and CRs from the pseudo-terminal are stripped first.
  file=$(sed -E $'s/\x1b\\[[0-9;?]*[A-Za-z]//g; s/\r//g' "$log" | grep -aoE '^(::group::)?[^ ]+\.test\.[cm]?[jt]sx?:' | tail -1 | sed -E 's/^::group:://; s/:$//')
  echo
  echo "::error title=bun test hung::no test output for ${idle}s — stuck in ${file:-<no file started>}"
  echo "--- last output lines ---"
  tail -20 "$log"
  echo "--- process table ---"
  ps -Ao pid,ppid,stat,etime,command
  # shellcheck disable=SC2046 # word-splitting the pid list is intended
  kill -9 $(descendants "$run_pid") "$run_pid" 2>/dev/null
  wait "$run_pid" 2>/dev/null
  exit 124
done

wait "$run_pid"
