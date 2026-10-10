// Bounds for every synchronous subprocess tg and tg-ctl start (tg-cli#481).
//
// Bun.spawnSync blocks its thread until the child exits: in `tg` that is the whole send, in
// `tg-ctl run` the daemon's single event loop (Telegram poll, hook socket, button taps). A
// wedged child — lsof walking a long-lived omp's fds, a stuck tmux server, git on a hung mount —
// must cost a bounded delay, never a hang. Spread one of these into the spawn options: on expiry
// Bun SIGKILLs the child and returns `exitCode: null` with `exitedDueToTimeout: true`, which every
// caller reads as "the probe failed". tests/spawn-timeout-audit.test.ts fails on any
// Bun.spawnSync in the shipped code that names no timeout.

/** A read-only local query: tmux display-message/list-panes/capture-pane, ps, pgrep, lsof, git rev-parse/status, which. */
export const PROBE_SPAWN = { timeout: 2000, killSignal: 'SIGKILL' } as const;

/** A tmux command that changes state: send-keys, load-buffer/paste-buffer, new-window, set-option. */
export const TMUX_WRITE_SPAWN = { timeout: 5000, killSignal: 'SIGKILL' } as const;

/** A service-manager or installer command run by a human-facing subcommand: launchctl/systemctl (un)install, rig delegate. */
export const ADMIN_SPAWN = { timeout: 60_000, killSignal: 'SIGKILL' } as const;
