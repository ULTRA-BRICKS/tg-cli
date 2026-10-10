#!/usr/bin/env bash
# Run tg-cli's `bun test` on a remote Linux box (a Runpod CPU pod) instead of this machine.
#
# The full suite spawns hundreds of daemons, tmux servers and abduco sessions for ~10 min;
# on a workstation already running a swarm of agents it competes with everything else and
# its timing-sensitive tests flake. This ships a worktree's files to the pod, runs the suite
# there under ci/test/bun-test-watchdog.sh (streams output, kills a hung run naming the
# file), mirrors the output here and exits with bun's exit code.
#
#   scripts/remote-test.sh                          # full suite: bun test ./tests
#   scripts/remote-test.sh tests/foo.test.ts -t x   # any `bun test` arguments instead
#   scripts/remote-test.sh -C ../other-worktree     # test another checkout
#   scripts/remote-test.sh --setup                  # provision the pod only (idempotent)
#
# Options (before the bun arguments; `--` ends them):
#   -C DIR          checkout to test (default: the git toplevel of the current directory)
#   --timeout SECS  hard limit for the test run on the pod (default 1800); exit 124 when hit
#   --log FILE      where to save the output (default ~/.cache/tg-cli/remote-test/<run>.log)
#   --keep          leave the remote run directory in place (debugging; swept after 3 h)
#   --setup         only provision the pod
#
# Configuration — environment, else ~/.config/tg-cli/remote-test.env (KEY=VALUE lines,
# sourced; TG_REMOTE_TEST_CONFIG names another file). Never commit that file.
#   TG_REMOTE_TEST_POD_ID  Runpod pod id; host and port are resolved with `runpodctl ssh info`
#                          on every run, so a pod restart (new port) needs no edit
#   TG_REMOTE_TEST_HOST    or a fixed ssh host/IP (wins over the pod id)
#   TG_REMOTE_TEST_PORT    ssh port for TG_REMOTE_TEST_HOST (default 22)
#                          A pod id or host set in the environment replaces the file's address.
#   TG_REMOTE_TEST_KEY     ssh identity file (default ~/.runpod/ssh/runpodctl-ssh-key when it
#                          exists — the key `runpodctl doctor` registers on the account)
#   TG_REMOTE_TEST_SLOTS   runs allowed at once on the pod; more wait for a slot (default 3:
#                          three concurrent full runs on 8 vCPU each took as long as one alone)
#   TG_REMOTE_TEST_BUN_VERSION  bun to run with (default: the local `bun --version`)
#
# Each run gets its own directory (~runner/runs/<run-id>) and every process it starts carries
# TG_REMOTE_TEST_RUN=<run-id> in its environment; on exit, Ctrl-C or TERM the run's processes
# (by that marker, or by the run directory in their command line or cwd) are killed and the
# directory removed, so concurrent runs never touch each other. What a client that lost its
# connection leaves behind is swept by a later run once its pod-side shell is gone. Tests run as
# the unprivileged `runner` user: as root, permission tests (chmod 000 → EACCES) cannot fail
# the way they must.
#
# Exit codes: bun's own (0 pass, 1 failures), 124 timeout or watchdog stall, 2 usage or
# configuration error, 3 the pod could not be prepared (provisioning, git snapshot, bun install),
# 255 ssh failure.
set -uo pipefail

usage() { sed -n '2,/^set -uo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }
die() { echo "remote-test: $*" >&2; exit 2; }

checkout=""
timeout_s=1800
log=""
keep=0
setup_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) [ "$#" -ge 2 ] || die "-C needs a directory"; checkout=$2; shift 2 ;;
    --timeout) [ "$#" -ge 2 ] || die "--timeout needs seconds"; timeout_s=$2; shift 2 ;;
    --log) [ "$#" -ge 2 ] || die "--log needs a file"; log=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    --setup) setup_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || die "--timeout must be a positive whole number of seconds, got '$timeout_s'"
[ "$#" -gt 0 ] || set -- ./tests

config=${TG_REMOTE_TEST_CONFIG:-$HOME/.config/tg-cli/remote-test.env}
if [ -f "$config" ]; then
  # The environment wins over the file, and an address given in the environment (pod id or
  # host) replaces the file's address as a whole instead of mixing with it.
  saved=""
  for name in ${!TG_REMOTE_TEST_@}; do saved+=$(declare -p "$name")$'\n'; done
  env_address=${TG_REMOTE_TEST_POD_ID:-}${TG_REMOTE_TEST_HOST:-}
  set -a
  # shellcheck disable=SC1090
  . "$config"
  set +a
  [ -n "$env_address" ] && unset TG_REMOTE_TEST_POD_ID TG_REMOTE_TEST_HOST TG_REMOTE_TEST_PORT
  eval "$saved"
fi

host=${TG_REMOTE_TEST_HOST:-}
port=${TG_REMOTE_TEST_PORT:-22}
key=${TG_REMOTE_TEST_KEY:-}
[ -z "$key" ] && [ -f "$HOME/.runpod/ssh/runpodctl-ssh-key" ] && key=$HOME/.runpod/ssh/runpodctl-ssh-key
slots=${TG_REMOTE_TEST_SLOTS:-3}
[[ "$slots" =~ ^[1-9][0-9]*$ ]] || die "TG_REMOTE_TEST_SLOTS must be a positive integer, got '$slots'"
bun_version=${TG_REMOTE_TEST_BUN_VERSION:-$(bun --version 2>/dev/null)}
[[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "cannot tell the bun version (no local bun?); set TG_REMOTE_TEST_BUN_VERSION"

if [ -z "$host" ]; then
  [ -n "${TG_REMOTE_TEST_POD_ID:-}" ] || die "no pod configured: set TG_REMOTE_TEST_POD_ID or TG_REMOTE_TEST_HOST (in the environment or $config)"
  command -v runpodctl >/dev/null || die "TG_REMOTE_TEST_POD_ID needs runpodctl to resolve the pod's ssh address"
  info=$(runpodctl ssh info "$TG_REMOTE_TEST_POD_ID" 2>&1) || die "runpodctl ssh info $TG_REMOTE_TEST_POD_ID failed: $info"
  host=$(printf '%s' "$info" | sed -n 's/^ *"ip": *"\([^"]*\)".*/\1/p')
  port=$(printf '%s' "$info" | sed -n 's/^ *"port": *\([0-9]*\).*/\1/p')
  [ -n "$host" ] && [ -n "$port" ] || die "pod $TG_REMOTE_TEST_POD_ID has no ssh address yet (stopped or still starting?): $info"
fi
host=${host#*@}

known_hosts=$HOME/.cache/tg-cli/remote-test-known_hosts
mkdir -p "$(dirname "$known_hosts")"
ssh_opts=(-p "$port" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=4
  -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$known_hosts" -o LogLevel=ERROR)
[ -n "$key" ] && ssh_opts+=(-i "$key")
# remote USER SCRIPT [ARGS...]: run SCRIPT with bash on the pod. ssh hands the remote login shell
# one joined string, so every argument is shell-quoted here (a `-t "two words"` stays one).
remote() {
  local user=$1 script=$2 args=""
  shift 2
  [ "$#" -gt 0 ] && args=$(printf '%q ' "$@")
  ssh "${ssh_opts[@]}" "$user@$host" "bash -s -- $args" <<<"$script"
}
ssh_failed() {
  echo "remote-test: $1 on $host:$port failed (ssh). If ssh reported a changed host key (a pod" \
    "restarted on the same address): ssh-keygen -R '[$host]:$port' -f $known_hosts" >&2
  exit 255
}

# --- provisioning (root, idempotent, serialized by a lock on the pod) -------------------------
# Packages: tmux/abduco/lsof/procps for the daemon and session tests, pandoc + Chrome for the
# md/html→pdf integration tests (as CI installs them), python3 + Pillow for the hook tests, git for the
# checkout fixtures, ffmpeg for media conversion. bun lives under /opt/bun/<version> so runs
# from checkouts on different bun versions coexist.
SETUP_SCRIPT='
main() {
  set -euo pipefail
  bun_version=$1
  exec 8>/var/lock/tg-remote-test-setup
  flock 8
  export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
  if [ ! -f /opt/tg-remote-test/packages-v2 ]; then
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends tmux git lsof procps psmisc ffmpeg pandoc \
      python3 python3-pil rsync curl unzip ca-certificates util-linux locales gcc make libc6-dev >/dev/null
    if ! command -v abduco >/dev/null; then
      # Not packaged for Ubuntu 24.04: build the release the developer machines run (0.6).
      rm -rf /tmp/abduco && mkdir -p /tmp/abduco
      curl -fsSL https://github.com/martanne/abduco/archive/refs/tags/v0.6.tar.gz | tar -xz -C /tmp/abduco --strip-components=1
      make -s -C /tmp/abduco PREFIX=/usr/local install >/dev/null
      rm -rf /tmp/abduco
    fi
    if ! command -v google-chrome >/dev/null; then
      curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
      apt-get install -y -qq /tmp/chrome.deb >/dev/null
      rm -f /tmp/chrome.deb
    fi
    mkdir -p /opt/tg-remote-test
    touch /opt/tg-remote-test/packages-v2
  fi
  id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
  install -d -o runner -g runner -m 700 /home/runner/.ssh /home/runner/runs /home/runner/slots
  install -o runner -g runner -m 600 /root/.ssh/authorized_keys /home/runner/.ssh/authorized_keys
  if [ ! -x "/opt/bun/$bun_version/bin/bun" ]; then
    mkdir -p "/opt/bun/$bun_version"
    curl -fsSL https://bun.sh/install | BUN_INSTALL="/opt/bun/$bun_version" bash -s "bun-v$bun_version" >/dev/null
    chmod -R a+rX "/opt/bun/$bun_version"
  fi
  echo "remote-test: pod ready — bun $("/opt/bun/$bun_version/bin/bun" --version), $(nproc) vCPU"
}
main "$@"
'

ensure_setup() {
  remote runner 'test -x "/opt/bun/$1/bin/bun" && test -f /opt/tg-remote-test/packages-v2' "$bun_version" \
    2>/dev/null && return 0
  echo "remote-test: provisioning $host (one-time, a few minutes)…" >&2
  remote root "$SETUP_SCRIPT" "$bun_version"
  local code=$?
  [ "$code" -eq 255 ] && ssh_failed provisioning
  [ "$code" -eq 0 ] || { echo "remote-test: provisioning $host failed (exit $code)" >&2; exit 3; }
}

ensure_setup
[ "$setup_only" -eq 1 ] && exit 0

# --- the run --------------------------------------------------------------------------------
if [ -z "$checkout" ]; then
  checkout=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout; pass -C DIR"
fi
checkout=$(cd "$checkout" && pwd) || die "no such directory: $checkout"
git -C "$checkout" rev-parse --git-dir >/dev/null 2>&1 || die "$checkout is not a git checkout"

run_id="$(date +%m%d-%H%M%S)-$$-$RANDOM"
remote_dir="runs/$run_id"
[ -n "$log" ] || log=$HOME/.cache/tg-cli/remote-test/$run_id.log
mkdir -p "$(dirname "$log")"

# Kill everything the run started and drop its directory. A process belongs to the run when it
# carries the run marker in its environment, or names the run directory on its command line
# (`bun …/tg-ctl run`), or runs inside it — tests spawn daemons with explicit `env:` objects that
# drop the marker. The scan repeats until a pass kills nothing, so a child forked mid-scan is
# caught too.
#
# It also sweeps what clients that lost their connection left behind. A run is live while the
# pod-side shell that runs it (runs/<id>/pid) is; a dead one's processes and directory go
# (a --keep directory after 3 h). Every other process of the user that started before the
# oldest live run (and over 30 min ago) cannot belong to a live run, nor can /tmp entries the
# suite leaked (tg-cli#486) that are older than both that run and 3 h.
REAP_SCRIPT='
main() {
  run_id=$1 keep=$2
  reap() {
    local p pass hit dir="$HOME/runs/$1"
    for pass in 1 2 3 4 5; do
      hit=0
      for p in /proc/[0-9]*; do
        [ "${p#/proc/}" = "$$" ] && continue
        if grep -qzxF "TG_REMOTE_TEST_RUN=$1" "$p/environ" 2>/dev/null ||
          grep -qzF "$dir/" "$p/cmdline" 2>/dev/null; then
          kill -9 "${p#/proc/}" 2>/dev/null && hit=1
          continue
        fi
        case "$(readlink "$p/cwd" 2>/dev/null)/" in "$dir"/*) kill -9 "${p#/proc/}" 2>/dev/null && hit=1 ;; esac
      done
      [ "$hit" = 0 ] && break
    done
  }
  reap "$run_id"
  if [ "$keep" = 1 ]; then touch "$HOME/runs/$run_id/keep"; else rm -rf "$HOME/runs/$run_id"; fi

  oldest=0
  for dir in "$HOME"/runs/*/; do
    [ -d "$dir" ] || continue
    id=$(basename "$dir")
    [ "$id" = "$run_id" ] && continue
    pid=$(cat "$dir/pid" 2>/dev/null)
    age=""
    # Live = that pid still runs inside this run directory (a recycled pid runs elsewhere).
    case "$(readlink "/proc/${pid:-0}/cwd" 2>/dev/null)/" in
      "$dir"*) age=$(ps -o etimes= -p "$pid" | tr -d " ") ;;
    esac
    if [ -n "$age" ]; then
      [ "$age" -gt "$oldest" ] && oldest=$age
    elif [ -f "$dir/keep" ]; then
      [ -n "$(find "$dir/keep" -mmin +180)" ] && rm -rf "$dir"
    elif [ -n "$pid" ] || [ -n "$(find "$dir" -maxdepth 0 -mmin +30)" ]; then
      reap "$id"
      rm -rf "$dir"
    fi
  done
  # +60 s: the login shell that ssh started a run shell from is a moment older than it. At least
  # 30 min, the grace a run gets before its shell starts (the rsync of its files).
  floor=$(( oldest + 60 > 1800 ? oldest + 60 : 1800 ))
  ps -u "$(id -u)" -o pid=,etimes=,comm= | while read -r pid age comm; do
    [ "$age" -gt "$floor" ] && [ "${comm#sshd}" = "$comm" ] && kill -9 "$pid" 2>/dev/null
  done
  minutes=$(( oldest / 60 + 1 > 180 ? oldest / 60 + 1 : 180 ))
  find /tmp -mindepth 1 -maxdepth 1 -user "$(id -u)" -mmin "+$minutes" -exec rm -rf {} + 2>/dev/null
  return 0
}
main "$@"
'
cleaned=0
cleanup() {
  [ "$cleaned" -eq 1 ] && return
  cleaned=1
  # A signal ends the local ssh first; the remote side is then reaped by its run marker.
  [ -n "${run_pid:-}" ] && kill "$run_pid" 2>/dev/null
  remote runner "$REAP_SCRIPT" "$run_id" "$keep" >/dev/null 2>&1
  rm -rf "${fifo_dir:-}" "${files:-}"
}
trap cleanup EXIT
trap 'echo; echo "remote-test: interrupted — stopping remote run $run_id" >&2; exit 130' INT TERM HUP

start=$(date +%s)
echo "remote-test: run $run_id — syncing $checkout to $host" >&2
# Tracked + untracked-but-not-ignored files: what is on disk in this checkout, uncommitted
# work included, without node_modules, .git or build output.
files=$(mktemp)
(cd "$checkout" && git ls-files -co --exclude-standard -z) >"$files" || die "git ls-files failed in $checkout"
# rsync splits -e on spaces and honours quotes but not backslashes: single-quote each option.
rsync_rsh=ssh
for opt in "${ssh_opts[@]}"; do
  [[ "$opt" == *"'"* ]] && die "an ssh option holds a single quote, which rsync -e cannot carry: $opt"
  rsync_rsh+=" '$opt'"
done
(cd "$checkout" && while IFS= read -r -d '' f; do [ -e "$f" ] || [ -L "$f" ] && printf '%s\0' "$f"; done <"$files") |
  rsync -a --from0 --files-from=- -e "$rsync_rsh" \
    --rsync-path="mkdir -p $remote_dir/src && rsync" "$checkout/" "runner@$host:$remote_dir/src/" ||
  ssh_failed "rsync"
rm -f "$files"

# Waits for one of $slots locks under ~/slots, then runs bun from the synced tree under the
# CI watchdog (or plain bun under a pty for checkouts that predate it), as its own session,
# with the run marker in its environment. The lock fd is closed for the test process so a
# daemon a test leaks cannot keep the slot taken. Preparing the tree fails with exit 3.
RUN_SCRIPT='
main() {
  run_id=$1 timeout_s=$2 slots=$3 bun_version=$4
  shift 4
  # The run is live while this shell is: the sweep in every cleanup reads this.
  echo "$$" >"$HOME/runs/$run_id/pid"
  cd "$HOME/runs/$run_id/src" || exit 3
  export PATH="/opt/bun/$bun_version/bin:$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8
  waited=0
  while :; do
    for i in $(seq 1 "$slots"); do
      exec {lock}>"$HOME/slots/$i"
      if flock -n "$lock"; then break 2; fi
      exec {lock}>&-
    done
    [ "$waited" = 0 ] && echo "remote-test: all $slots slots busy — waiting" >&2
    waited=1
    sleep 5
  done
  echo "remote-test: slot $i/$slots on $(hostname) ($(nproc) vCPU), bun $(bun --version)" >&2
  # Tests that read the repo itself (git ls-files, git grep) need a git checkout: snapshot the
  # synced tree as one commit.
  { git init -q && git add -A && git -c user.name=remote-test -c user.email=remote-test@localhost \
    commit -qm "remote-test snapshot" --no-verify; } >&2 {lock}>&- || { echo "remote-test: git snapshot failed" >&2; exit 3; }
  # Tests use literal pids (up to 99991) for fake agents, and on Linux the daemon reads
  # /proc/<pid>/cwd before its lsof shim, so a real process holding one of those pids changes
  # what a test sees (tg-cli#618). A freshly booted pod hands out pids from 1: move its counter
  # past that range once, as on a long-running host. With pid_max at or below the range no
  # fixture pid can be live anyway (and the counter would wrap before reaching it).
  if [ "$(cat /proc/sys/kernel/pid_max)" -gt 100000 ]; then
    exec {warm}>"$HOME/slots/pid-warmup"
    flock "$warm"
    while [ "$(cat /proc/sys/kernel/ns_last_pid)" -lt 100000 ]; do
      for _ in 1 2 3 4 5 6 7 8; do (for _ in $(seq 2000); do (:); done) & done
      wait
    done
    exec {warm}>&-
  fi
  if grep -q "\"\(dev\)\{0,1\}[dD]ependencies\"" package.json 2>/dev/null; then
    bun install --silent </dev/null >&2 {lock}>&- || { echo "remote-test: bun install failed" >&2; exit 3; }
  fi
  # setsid -w: should setsid have to fork (it does when already a group leader), it still
  # returns the exit code of the run.
  if [ -x ci/test/bun-test-watchdog.sh ]; then
    TG_REMOTE_TEST_RUN=$run_id setsid -w timeout -k 30 "$timeout_s" ci/test/bun-test-watchdog.sh "$@" </dev/null {lock}>&-
  else
    cmd="bun test$(printf " %q" "$@")"
    TG_REMOTE_TEST_RUN=$run_id setsid -w timeout -k 30 "$timeout_s" script -qfec "$cmd" /dev/null </dev/null {lock}>&-
  fi
}
main "$@"
'
# ssh in the background + `wait`: a signal to this script (a supervisor's TERM, not only a
# terminal's Ctrl-C to the whole group) must run the trap now, not after the remote run ends.
fifo_dir=$(mktemp -d)
fifo=$fifo_dir/out
mkfifo "$fifo" || die "cannot create a fifo in $fifo_dir"
tee "$log" <"$fifo" &
tee_pid=$!
# ssh itself, not the `remote` function: run_pid must be the ssh process for cleanup to end it.
ssh "${ssh_opts[@]}" "runner@$host" "bash -s -- $(printf '%q ' "$run_id" "$timeout_s" "$slots" "$bun_version" "$@")" \
  <<<"$RUN_SCRIPT" >"$fifo" 2>&1 &
run_pid=$!
wait "$run_pid"
code=$?
run_pid=""
wait "$tee_pid"
# 255 is ssh's own failure code; a test run that itself exits 255 is reported as one too.
[ "$code" -eq 255 ] && ssh_failed "the run"

elapsed=$(( $(date +%s) - start ))
summary=$(sed -E $'s/\x1b\\[[0-9;?]*[A-Za-z]//g; s/\r//g' "$log" |
  grep -E '^ *[0-9]+ (pass|fail|skip|todo)$|^Ran [0-9]+ tests? across' | tr -s ' \n' ' ' | sed 's/^ //')
echo "remote-test: exit $code after ${elapsed}s — ${summary}log: $log" >&2
exit "$code"
