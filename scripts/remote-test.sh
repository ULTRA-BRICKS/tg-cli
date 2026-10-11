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
#   scripts/remote-test.sh --ephemeral              # own pod even when a shared one is configured
#   scripts/remote-test.sh --setup                  # shared pod only: provision it (idempotent)
#
# Options (before the bun arguments; `--` ends them):
#   -C DIR          checkout to test (default: the git toplevel of the current directory)
#   --timeout SECS  hard limit for the test run on the pod (default 1800); exit 124 when hit
#   --log FILE      where to save the output (default ~/.cache/tg-cli/remote-test/<run>.log)
#   --keep          leave the remote run directory in place (shared pod only; swept after 3 h)
#   --setup         only provision the shared pod
#   --ephemeral     rent a pod for this run alone even when a shared pod is configured
#
# Configuration — environment, else ~/.config/tg-cli/remote-test.env (KEY=VALUE lines,
# sourced; TG_REMOTE_TEST_CONFIG names another file). Never commit that file.
#   TG_REMOTE_TEST_POD_ID  opt-in shared Runpod pod id; host and port are resolved with
#                          `runpodctl ssh info` on every run, so a pod restart needs no edit
#   TG_REMOTE_TEST_HOST    or a fixed ssh host/IP (wins over the pod id)
#   TG_REMOTE_TEST_PORT    ssh port for TG_REMOTE_TEST_HOST (default 22)
#                          A pod id or host set in the environment replaces the file's address.
#                          With neither set, every run rents its own pod (see below).
#   TG_REMOTE_TEST_KEY     ssh identity file (default ~/.runpod/ssh/runpodctl-ssh-key when it
#                          exists — the key `runpodctl doctor` registers on the account)
#   TG_REMOTE_TEST_SLOTS   runs allowed at once on the pod; more wait for a slot (default 3:
#                          three concurrent full runs on 8 vCPU each took as long as one alone)
#   TG_REMOTE_TEST_BUN_VERSION  bun to run with (default: the local `bun --version`)
#   TG_REMOTE_TEST_AVOID_DATA_CENTERS  ephemeral runs: Runpod data center ids (comma-separated)
#                          not to rent in, e.g. one whose pods' ssh never answers from here
#   TG_REMOTE_TEST_SSH_WAIT  ephemeral runs: seconds a new pod gets for its ssh to answer before
#                          it is replaced, once, in another data center (default 300)
#
# Two ways to get a pod. The default is an ephemeral pod: the run rents its own cpu3c 8 vCPU /
# 16 GB pod through Runpod's REST API (key: RUNPOD_API_KEY, else `apikey` in
# ~/.runpod/config.toml; needs runpodctl, curl and jq), provisions it (about 2 min), runs, and
# deletes the pod on every exit path: pass, failure, Ctrl-C or TERM. It bills only for those
# minutes (~$0.04 a full run, ~10 min end to end). A pod whose ssh does not answer in
# TG_REMOTE_TEST_SSH_WAIT (pods in some data centers never do from here) is deleted and
# replaced, once, in another data center; a pod that cannot be deleted stops the run (exit 3)
# rather than renting another. A client killed with SIGKILL cannot delete it, so once ssh
# answers the pod is set to delete itself: an hour later while it provisions, then --timeout +
# 1 h after provisioning ends. Before that (its first minute or two) a leak shows in
# `runpodctl pod list` as tg-remote-test-<run-id>.
#
# Opt-in: a long-lived shared pod (TG_REMOTE_TEST_POD_ID or TG_REMOTE_TEST_HOST) is provisioned
# once and serves every run of every checkout, up to TG_REMOTE_TEST_SLOTS at a time, without
# the ~2 min of provisioning — but it bills while it exists, idle or not ($0.24/h, ~$5.80/day),
# so whoever configures one must stop it (`runpodctl pod stop <id>`) when done.
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
# configuration error, 3 the pod could not be prepared (provisioning, git snapshot, bun install)
# or an ephemeral pod could not be deleted, 255 ssh failure.
set -uo pipefail

# bash reads a script as it runs it, so editing this file under a running copy (a worktree
# checkout, an in-place install) made the run execute fragments of the new text once it
# reached them. Everything below is one block, read in full before any of it runs.
{

usage() { sed -n '2,/^set -uo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }
die() { echo "remote-test: $*" >&2; exit 2; }

checkout=""
timeout_s=1800
log=""
keep=0
setup_only=0
ephemeral=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) [ "$#" -ge 2 ] || die "-C needs a directory"; checkout=$2; shift 2 ;;
    --timeout) [ "$#" -ge 2 ] || die "--timeout needs seconds"; timeout_s=$2; shift 2 ;;
    --log) [ "$#" -ge 2 ] || die "--log needs a file"; log=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    --setup) setup_only=1; shift ;;
    --ephemeral) ephemeral=1; shift ;;
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
# No shared pod configured: this run rents its own.
[ -z "${TG_REMOTE_TEST_POD_ID:-}${TG_REMOTE_TEST_HOST:-}" ] && ephemeral=1
if [ "$ephemeral" -eq 1 ]; then
  [ "$keep" -eq 0 ] || die "--keep needs a shared pod (TG_REMOTE_TEST_POD_ID): an ephemeral pod is deleted when the run ends"
  [ "$setup_only" -eq 0 ] || die "--setup needs a shared pod (TG_REMOTE_TEST_POD_ID): an ephemeral run provisions its own pod"
fi

host=${TG_REMOTE_TEST_HOST:-}
port=${TG_REMOTE_TEST_PORT:-22}
key=${TG_REMOTE_TEST_KEY:-}
[ -z "$key" ] && [ -f "$HOME/.runpod/ssh/runpodctl-ssh-key" ] && key=$HOME/.runpod/ssh/runpodctl-ssh-key
slots=${TG_REMOTE_TEST_SLOTS:-3}
[[ "$slots" =~ ^[1-9][0-9]*$ ]] || die "TG_REMOTE_TEST_SLOTS must be a positive integer, got '$slots'"
bun_version=${TG_REMOTE_TEST_BUN_VERSION:-$(bun --version 2>/dev/null)}
[[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "cannot tell the bun version (no local bun?); set TG_REMOTE_TEST_BUN_VERSION to x.y.z, got '$bun_version'"

if [ "$setup_only" -eq 0 ]; then
  if [ -z "$checkout" ]; then
    checkout=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout; pass -C DIR"
  fi
  checkout=$(cd "$checkout" && pwd) || die "no such directory: $checkout"
  git -C "$checkout" rev-parse --git-dir >/dev/null 2>&1 || die "$checkout is not a git checkout"
fi
run_id="$(date +%m%d-%H%M%S)-$$-$RANDOM"
remote_dir="runs/$run_id"
[ -n "$log" ] || log=$HOME/.cache/tg-cli/remote-test/$run_id.log

# ssh_address POD: set host and port from `runpodctl ssh info POD`, a JSON object whose first
# "ip" and "port" are the pod's public ssh address. Returns 1 while the pod has none (stopped or
# still starting, the reason in address_error); a malformed port is a configuration error.
ssh_address() {
  local info
  info=$(bounded 60 runpodctl ssh info "$1" 2>&1) || { address_error="runpodctl ssh info $1 failed: $info"; return 1; }
  host=$(printf '%s\n' "$info" | sed -n '/^ *"ip": *"/{s/^ *"ip": *"\([^"]*\)".*/\1/p;q;}')
  port=$(printf '%s\n' "$info" | sed -n '/^ *"port":/{s/^ *"port": *\([^,]*\).*/\1/p;q;}')
  address_error="pod $1 has no ssh address yet (stopped or still starting?): $info"
  [ -n "$host" ] && [ -n "$port" ] || return 1
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] ||
    die "runpodctl ssh info $1 gave ssh port '$port', not a port number: $info"
  [[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || die "runpodctl ssh info $1 gave ssh host '$host', not an address: $info"
  address_error="ssh to $host:$port does not answer yet"
}
set_ssh_opts() {
  ssh_opts=(-p "$port" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=4
    -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$known_hosts" -o LogLevel=ERROR)
  if [ -n "$key" ]; then ssh_opts+=(-i "$key"); fi
}
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

# --- ephemeral pod: rented for this run, deleted on every exit path ---------------------------
ephemeral_pod=""
renting=0
# runpod_api METHOD PATH [BODY]: Runpod's REST v2 API. The key reaches curl as config on stdin,
# never on its command line (visible in ps).
runpod_api() {
  local data=()
  [ "$#" -ge 3 ] && data=(-d "$3")
  printf 'header = "Authorization: Bearer %s"\n' "$api_key" |
    curl -sS --max-time 60 -K - -X "$1" "https://api.runpod.io/v2$2" -H 'Content-Type: application/json' ${data[@]+"${data[@]}"} 2>&1
}
# find_rented_pod: set ephemeral_pod to the pod named for this run, when a create's answer was
# lost (a dropped connection, or a signal mid-request). A just-created pod can take a moment to
# show in the list.
find_rented_pod() {
  local try
  for try in 1 2 3; do
    ephemeral_pod=$(runpod_api GET /pods |
      jq -r --arg name "tg-remote-test-$run_id" 'first(.pods[]? | select(.name == $name) | .id) // empty' 2>/dev/null)
    [ -n "$ephemeral_pod" ] || [ "$try" -eq 3 ] && break
    sleep 2 </dev/null >/dev/null 2>&1 & wait "$!"
  done
  renting=0
  [ -n "$ephemeral_pod" ] ||
    echo "remote-test: if a pod named tg-remote-test-$run_id shows up in \`runpodctl pod list\`, delete it" >&2
}
# create_pod: rent the pod, anywhere but the data centers in $avoid_dcs (space-separated). With
# an avoid list it rents only in a data center the catalog lists with cpu3c stock outside it,
# and fails (exit 3) when there is none or the catalog cannot be read.
create_pod() {
  local dcs='[]' catalog body response
  if [ -n "${avoid_dcs// /}" ]; then
    catalog=$(runpod_api GET '/catalog/cpus/cpu3c?include=AVAILABILITY&product=POD')
    dcs=$(jq -c --arg avoid "$avoid_dcs" \
      '[.dataCenters[] | select(.availability != "NONE") | .id] - ($avoid | split(" "))' <<<"$catalog" 2>/dev/null)
    if [ -z "$dcs" ] || [ "$dcs" = '[]' ]; then
      echo "remote-test: no data center offers cpu3c outside the avoided ones (${avoid_dcs# }): $catalog" >&2
      exit 3
    fi
  fi
  body=$(jq -nc --arg name "tg-remote-test-$run_id" --argjson dcs "$dcs" '{name: $name,
    image: "runpod/base:1.0.2-ubuntu2404", cpu: {id: "cpu3c", vcpuCount: 8}, disk: 40, ports: ["22/tcp"],
    startSsh: true} + if $dcs == [] then {} else {dataCenterIds: $dcs} end')
  echo "remote-test: renting pod tg-remote-test-$run_id (cpu3c 8 vCPU / 16 GB, \$0.24/h) — deleted when this run ends" >&2
  renting=1
  response=$(runpod_api POST /pods "$body")
  ephemeral_pod=$(jq -r '.id // empty' <<<"$response" 2>/dev/null)
  if [ -z "$ephemeral_pod" ]; then
    # The EXIT trap deletes what this finds.
    find_rented_pod
    echo "remote-test: renting the pod failed: $response${ephemeral_pod:+ — but pod $ephemeral_pod exists under its name}" >&2
    exit 3
  fi
  renting=0
  echo "remote-test: pod $ephemeral_pod created — waiting for ssh" >&2
}
# bounded SECS CMD...: CMD, killed after SECS where timeout(1) exists (gtimeout on macOS with
# coreutils); unbounded otherwise.
timeout_bin=$(command -v timeout || command -v gtimeout)
bounded() {
  local secs=$1
  shift
  if [ -n "$timeout_bin" ]; then "$timeout_bin" "$secs" "$@"; else "$@"; fi
}
# delete_pod: delete the ephemeral pod; 1, with a warning, when three tries all failed.
delete_pod() {
  local try
  for try in 1 2 3; do
    bounded 60 runpodctl pod delete "$ephemeral_pod" >/dev/null 2>&1 && { echo "remote-test: pod $ephemeral_pod deleted" >&2; return 0; }
    [ "$try" -lt 3 ] && sleep 2
  done
  echo "remote-test: WARNING — could not delete pod $ephemeral_pod; it bills until deleted: runpodctl pod delete $ephemeral_pod" >&2
  return 1
}
# SELF_DELETE_SCRIPT SECS (root): the pod deletes itself SECS from now, so a client that dies
# without running its trap (SIGKILL) leaves nothing billing. The runpod/base image ships
# runpodctl, and Runpod puts a key scoped to the pod itself (RUNPOD_API_KEY, with RUNPOD_POD_ID)
# into its environment, which /etc/rp_environment re-exports for ssh sessions. The first call
# starts the watcher; a later one moves its deadline.
SELF_DELETE_SCRIPT='
. /etc/rp_environment 2>/dev/null
command -v runpodctl >/dev/null && [ -n "${RUNPOD_API_KEY:-}" ] && [ -n "${RUNPOD_POD_ID:-}" ] || exit 1
at=/root/tg-remote-test-delete-at
started=0; [ -f "$at" ] && started=1
echo "$(( $(date +%s) + $1 ))" >"$at"
[ "$started" = 1 ] && exit 0
nohup setsid sh -c "while [ \"\$(date +%s)\" -lt \"\$(cat $at)\" ]; do sleep 30; done
  runpodctl remove pod \"\$RUNPOD_POD_ID\" || runpodctl pod delete \"\$RUNPOD_POD_ID\"" </dev/null >/dev/null 2>&1 &
'
self_delete_after() {
  remote root "$SELF_DELETE_SCRIPT" "$1" ||
    echo "remote-test: WARNING — pod $ephemeral_pod cannot delete itself; if this client is killed, run: runpodctl pod delete $ephemeral_pod" >&2
}
# Polls until the pod has an ssh address that answers; 1 after $ssh_wait seconds without one.
# Some data centers' ssh never answers from here at all, while a reachable pod answers within
# a minute or two.
wait_for_ssh() {
  local give_up=$((SECONDS + ssh_wait))
  until ssh_address "$ephemeral_pod" && set_ssh_opts && bounded 60 ssh "${ssh_opts[@]}" "root@$host" true 2>/dev/null; do
    [ "$SECONDS" -lt "$give_up" ] || return 1
    # In the background, so a TERM runs the trap (and deletes the pod) at once.
    sleep 10 </dev/null >/dev/null 2>&1 & wait "$!"
  done
}

cleaned=0
run_started=0
cleanup() {
  local code=$?
  [ "$cleaned" -eq 1 ] && return
  cleaned=1
  # A second Ctrl-C must not cut the pod delete short.
  trap '' INT TERM HUP
  # A signal ends the local ssh first; the remote side is then reaped by its run marker.
  [ -n "${run_pid:-}" ] && kill "$run_pid" 2>/dev/null
  # A signal during the create request: the pod may exist without its id.
  [ -z "$ephemeral_pod" ] && [ "$renting" -eq 1 ] && find_rented_pod
  if [ -n "$ephemeral_pod" ]; then
    # A pod left billing turns a pass into exit 3, so it is not mistaken for a clean run.
    delete_pod || { [ "$code" -eq 0 ] && code=3; }
  elif [ "$run_started" -eq 1 ]; then
    remote runner "$REAP_SCRIPT" "$run_id" "$keep" >/dev/null 2>&1
  fi
  rm -rf "${fifo_dir:-}" "${files:-}" "${ephemeral_known_hosts:-}"
  exit "$code"
}
trap cleanup EXIT
trap 'echo; echo "remote-test: interrupted — stopping run $run_id" >&2; exit 130' INT TERM HUP

known_hosts=$HOME/.cache/tg-cli/remote-test-known_hosts
mkdir -p "$(dirname "$known_hosts")"
if [ "$ephemeral" -eq 1 ]; then
  for tool in runpodctl curl jq; do command -v "$tool" >/dev/null || die "an ephemeral run needs $tool"; done
  api_key=${RUNPOD_API_KEY:-$(sed -n '/^ *apikey *= *"/{s/^ *apikey *= *"\([^"]*\)".*/\1/p;q;}' "$HOME/.runpod/config.toml" 2>/dev/null)}
  [ -n "$api_key" ] || die "an ephemeral run needs a Runpod API key: RUNPOD_API_KEY, or apikey in ~/.runpod/config.toml"
  ssh_wait=${TG_REMOTE_TEST_SSH_WAIT:-300}
  [[ "$ssh_wait" =~ ^[0-9]+$ ]] || die "TG_REMOTE_TEST_SSH_WAIT must be a whole number of seconds, got '$ssh_wait'"
  avoid_dcs=${TG_REMOTE_TEST_AVOID_DATA_CENTERS:-}
  avoid_dcs=${avoid_dcs//,/ }
  # A fresh pod has a fresh host key, possibly on an ip:port another pod used before.
  ephemeral_known_hosts=$(mktemp)
  known_hosts=$ephemeral_known_hosts
  # A pod whose ssh never answers is replaced once, outside its data center; when the API does
  # not name that data center, or the dead pod cannot be deleted, the run stops instead (exit 3).
  # Provisioning then gets an hour before the pod deletes itself; once provisioned, the run
  # gets --timeout + 1 h.
  for attempt in 1 2; do
    create_pod
    # A replacement pod may get the dead one's ip:port with another host key.
    : >"$known_hosts"
    wait_for_ssh && break
    dc=$(runpod_api GET "/pods/$ephemeral_pod" | jq -r '.dataCenterId // empty' 2>/dev/null)
    echo "remote-test: pod $ephemeral_pod${dc:+ in $dc} has no working ssh after ${ssh_wait}s ($address_error) — deleting it" >&2
    delete_pod
    deleted=$?
    ephemeral_pod=""
    [ "$deleted" -eq 0 ] || exit 3
    [ "$attempt" -eq 2 ] && exit 3
    [ -n "$dc" ] || { echo "remote-test: cannot tell that pod's data center, so not renting another" >&2; exit 3; }
    avoid_dcs+=" $dc"
  done
  self_delete_after 3600
elif [ -z "$host" ]; then
  command -v runpodctl >/dev/null || die "TG_REMOTE_TEST_POD_ID needs runpodctl to resolve the pod's ssh address"
  ssh_address "$TG_REMOTE_TEST_POD_ID" || die "$address_error"
fi
host=${host#*@}
set_ssh_opts

# --- provisioning (root, idempotent, serialized by a lock on the pod) -------------------------
# Packages: tmux/abduco/lsof/procps for the daemon and session tests, pandoc + Chrome for the
# md/html→pdf integration tests (as CI installs them), python3 + Pillow for the hook tests, git for the
# checkout fixtures, ffmpeg for media conversion, jq for this script's own tests. bun lives under
# /opt/bun/<version> so runs from checkouts on different bun versions coexist.
SETUP_SCRIPT='
main() {
  set -euo pipefail
  bun_version=$1
  exec 8>/var/lock/tg-remote-test-setup
  flock 8
  export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
  if [ ! -f /opt/tg-remote-test/packages-v3 ]; then
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends tmux git lsof procps psmisc ffmpeg pandoc \
      python3 python3-pil rsync curl jq unzip ca-certificates util-linux locales gcc make libc6-dev >/dev/null
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
    touch /opt/tg-remote-test/packages-v3
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
  remote runner 'test -x "/opt/bun/$1/bin/bun" && test -f /opt/tg-remote-test/packages-v3' "$bun_version" \
    2>/dev/null && return 0
  echo "remote-test: provisioning $host (a few minutes, once per pod)…" >&2
  remote root "$SETUP_SCRIPT" "$bun_version"
  local code=$?
  [ "$code" -eq 255 ] && ssh_failed provisioning
  [ "$code" -eq 0 ] || { echo "remote-test: provisioning $host failed (exit $code)" >&2; exit 3; }
}

ensure_setup
[ "$setup_only" -eq 1 ] && exit 0
[ "$ephemeral" -eq 1 ] && self_delete_after "$((timeout_s + 3600))"

# --- the run --------------------------------------------------------------------------------
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
run_started=1

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
  cd "$HOME/runs/$run_id/src" || exit 3
  # The run is live while this shell is: the sweep in every cleanup reads this, and counts the
  # shell as live only while its cwd is inside the run directory, so the cd comes first.
  echo "$$" >"$HOME/runs/$run_id/pid"
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
}
