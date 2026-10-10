// Shim bodies that make a test's view of the HOST realistic and empty, shared by the
// preload (tests/hermetic-env.ts) and by tests that write their own shim dir.
//
// Why these exact shapes (tg-cli#545): the daemon treats `tmux list-panes` that exits 0 with
// NOTHING on stdout, and a `ps` table with no rows, as the transient launchd flake and retries
// each with a synchronous 120 ms sleep (features/tg-ctl/discover.ts panesWithRetry, snapshot()).
// One poll tick takes four snapshots, so an "exit 0, print nothing" shim parks the daemon's
// single thread in sleepSync for seconds per tick — while the mock Bot API (which answers
// getUpdates at once, unlike Telegram's 50 s long-poll) turns ticks over back to back. Hook
// socket asks and callback taps are served between ticks only, so every hop of a test's flow
// waited out a whole tick and blew its 5–20 s budget. A host with tmux unused answers
// `list-panes` with a non-zero exit (no server), which is never retried; a live host always
// has a process table with at least launchd in it.

/**
 * `tmux` with no server running: non-zero exit, nothing on stdout — never retried by the daemon.
 * `before`: shell lines to run first (a shim that logs its argv).
 */
export function tmuxNoServerShim(before = ''): string {
  const lines = before === '' || before.endsWith('\n') ? before : `${before}\n`;
  return `#!/bin/sh\n${lines}echo "no server running on /tmp/tmux-501/default" >&2\nexit 1\n`;
}

export const TMUX_NO_SERVER_SHIM = tmuxNoServerShim();

/** The process table of a host with no agent on it: launchd and nothing else. */
export const PS_ROW_LAUNCHD = '    1     0 /sbin/launchd';

/**
 * `ps` whose two table listings (the exact argv of `snapshot()` / the tty probe in
 * features/tg-ctl/discover.ts — a changed flag order there falls through to the real `ps` and
 * leaks the host again, so keep the two in step) (`-axo pid=,ppid=,command=` and `-axo pid=,tty=`) show only
 * launchd, and which hands every other invocation (`ps -ww -p <pid> -o command=`, …) to the
 * real `ps`.
 */
export const PS_NO_AGENTS_SHIM = [
  '#!/bin/sh',
  'case "$*" in',
  `  "-axo pid=,ppid=,command=") printf '%s\\n' '${PS_ROW_LAUNCHD}' ;;`,
  `  "-axo pid=,tty=") printf '%s\\n' '    1 ??' ;;`,
  '  *) for real in /bin/ps /usr/bin/ps; do [ -x "$real" ] && exec "$real" "$@"; done; exit 127 ;;',
  'esac',
  '',
].join('\n');

/** `launchctl list` with no jobs; `status` otherwise spawns one `launchctl print` per loaded host job. */
export const LAUNCHCTL_NO_JOBS_SHIM = `#!/bin/sh\n[ "$1" = list ] && printf 'PID\\tStatus\\tLabel\\n'\nexit 0\n`;

/**
 * `pgrep` that matches no process. features/branding/detect.ts asks `pgrep -x <name>` whether a
 * local model server is running; a developer's own ollama or agent must never answer for the test.
 */
export const PGREP_NO_MATCH_SHIM = '#!/bin/sh\nexit 1\n';
