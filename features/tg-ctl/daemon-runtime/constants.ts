// daemon-runtime/constants: extracted verbatim from tg-ctl (guardian-817 modular refactor).

export const USAGE = `Usage:
  tg-ctl start [--pane %N] [--cwd PATH] [--session NAME]
                         # background (detached) daemon, returns immediately
  tg-ctl run             # foreground (blocking) daemon — the process itself
  tg-ctl status          # is it running? pid / bot / target pane / autostart;
                         # \`code:\` names the commit the daemon loaded — STALE when its
                         # checkout has newer daemon code (merged but not restarted);
                         # also lists sessions hosted by the rig wrapper outside tmux (typed into
                         # their abduco PTY) and agents outside tmux AND the wrapper as unreachable
  tg-ctl audit-delivery [--since DATE] [--until DATE] [--json] [--transcripts DIR]...
                         # report inbound messages never delivered, delivered twice, or
                         # never received (update-id gaps), with dates; read-only
  tg-ctl inbox           # pending Stop-hook inbox entries (omp's grant-notice fallback) and the
                         # archived cc/codex backlog (tg-cli#456)
  tg-ctl stop            # stop the daemon (found via pidfile, flock holder or launchd job);
                         # exits 1 if it is still alive after the SIGTERM drain
  tg-ctl restart [--if-stale]
                         # graceful reload — drains in-flight, keeps queued messages + questions;
                         # exits 0 only once the old process is gone AND a successor holds the
                         # lock (a launchd-owned daemon comes back under launchd).
                         # --if-stale: only when a daemon runs whose loaded code differs from its
                         # checkout's HEAD (what scripts/deploy.sh runs after a pull)
  tg-ctl enable [--dry-run]
                         # install OS autostart (launchd / systemd --user) AND start now
                         # (--dry-run prints the plan and touches nothing)
  tg-ctl disable         # remove OS autostart AND stop
  tg-ctl usage-schedule enable [--dry-run]
                         # install a launchd job (macOS only) that checks daily at 23:50 and
                         # sends a token/cost report to the chat once per completed week and
                         # month; a check missed at 23:50 (machine asleep) is reported as
                         # missed, never silently skipped (--dry-run prints the plan only)
  tg-ctl usage-schedule disable
                         # remove the scheduled usage-report launchd job
  tg-ctl ask             # internal: hook client, reads a ButtonRequest JSON from stdin
                         # optional per-request timeoutMs field extends the wait,
                         # capped at 15 min (agent-tools sends 600000 for hatch asks)
  tg-ctl ask --owner-only <question> [--timeout SEC]
                         # same, but only the owner (TG_CHAT_ID, a positive private chat id)
                         # tapping in that private chat can answer; others get "not allowed"
  tg-ctl capabilities --json
                         # print feature markers (e.g. ask-owner-only-v1); no network/config
  tg-ctl ask <question> [--timeout SEC]
                         # blocking human approval for any script or hook: posts an
                         # Approve/Reject card, exit 0 ONLY on an Approve tap; reject,
                         # timeout (default 300s, max 900s), daemon down or no creds
                         # exit 1. Works without tmux and without a registration.
                         # A SIGTERM/SIGINT/SIGHUP while either ask waits withdraws its card.
  tg-ctl withdraw <requestId> | --hook-id <id> [--cwd <dir>] [--reason <text>]
                         # close question cards that are no longer relevant: one request, or
                         # every open hatch card of a hook id (in one directory with --cwd);
                         # the card shows "⏹ withdrawn: <reason>" and leaves the 📥 Inbox.
                         # exit 0 closed ≥1, 1 nothing matched, 2 usage, 69 daemon unreachable
  tg-ctl ask --verify-grant <approval_id> --hook <hook_id>
                         # internal: consume a late-approval grant by its id
                         # (single-use, bound to hook + operation + cwd); stdin
                         # carries the normalized payload; replies allow/deny
                         # hookSpecificOutput JSON on stdout, exit 0 always
  tg-ctl ask --verify-grant --pull --hook <hook_id>
                         # internal: consume an outstanding grant WITHOUT an id —
                         # matched by hook + operation + the daemon-observed route
                         # (for hooks with no env channel); same reply shape
  tg-ctl omp-live install        # install the original-process extension (the daemon also does at startup); saved stop/resume required once
  tg-ctl omp-live status --json  # verified live PIDs and exact sessions (no bot credentials)
  tg-ctl omp-live send <pid> --request-id <id> <text...>  # queued receipt, never a clone
  tg-ctl alert subscribe [--pid N | --session ID] [--sources a,b] [--ttl 12h]
                         # bind THIS omp session (the nearest live omp-live ancestor, or the
                         # one named) to monitoring alerts, keyed by its omp session id: a
                         # closed session is unbound by itself, a resumed one rebinds by
                         # itself; --ttl 0 = no expiry (tg-cli#636)
  tg-ctl alert subscribe --exclusive --source S [--pid N | --session ID] [--ttl 12h]
                         # become the ONLY holder of source S (exit 3 + who holds it when
                         # taken); "send --to-holder" alerts go to that session alone (tg-cli#747)
  tg-ctl alert handoff-request --source S [--reason R] [--pid N | --session ID]
                         # ask the holder for S (a note reaches it; exit 5 + withdrawn when it
                         # cannot); unanswered for 10 min → take
  tg-ctl alert handoff --source S (--to SESSION | --deny [--reason R]) [--pid N | --session ID]
                         # the holder hands S to a LIVE session, or denies the pending request
  tg-ctl alert take --source S [--ttl 12h] [--pid N | --session ID]
                         # claim S when vacant, or after your request went unanswered 10 min
  tg-ctl alert release --source S [--pid N | --session ID]
  tg-ctl alert holder --source S [--json]
                         # bound | suspended (endpoint gone < 10 min) | vacant (exit 3)
  tg-ctl alert unsubscribe [--pid N | --session ID | --all]
                         # --all removes non-exclusive subscriptions only, never a holder
  tg-ctl alert list [--json]
  tg-ctl alert send --source S --severity info|warning|critical --key K --text T
                    [--title T] [--html] [--window 10m] [--force]
                         # complete problem reports and info posts go through tg, then to
                         # bound subscribers with tg#<id>. Raw warning/critical incidents
                         # go internally to the exclusive holder (subscribers if vacant);
                         # owner report withheld until actual attempts/results + current
                         # remediation are present. A failed problem post still routes the
                         # incident internally; owner delivery remains unconfirmed (exit 1).
                         # Internal receipts/retries never throttle a complete owner report.
                         # Unconfirmed delivery after an endpoint restart is UNCERTAIN:
                         # reconcile session history before an explicit --force; no replay.
                         # Exit 3: no recipient; 5: suspended/failed exclusive holder.
  tg-ctl alert send --to-holder --source S --severity … --key K --text T [--window 10m] [--force]
                         # deliver "[alert S · severity · K] T" into S's holder ONLY — never
                         # Telegram, never subscribers: exit 0 OK/throttled, 3 VACANT,
                         # 5 SUSPENDED or FAILED (the claim is released, so a retry delivers).
                         # Known limits: a send racing a handoff may still reach the previous
                         # holder (the next send goes to the new one); a pre-1.66 tg-ctl that
                         # rewrites the store drops its holders
  tg-ctl install-hooks   # wire q→buttons + StopFailure + Claude/Codex usage telemetry
                         #   (codex: delegates to rig when present — rig owns ~/.codex hooks)
  tg-ctl voice-setup [--dry-run]
                         # configure inbound voice→text: keep a working voice: config, else
                         # use a local Whisper (~/xp, PATH), else install a prebuilt one
                         # (macOS: Homebrew whisper.cpp + Metal; Linux: faster-whisper wheels
                         # in a uv venv, CUDA wheels with an NVIDIA GPU) + large-v3-turbo;
                         # --dry-run prints the plan / the voice: block, changes nothing
  tg-ctl harness-event [--dry-run] [--pane %N] [--window-name NAME] [--agent NAME] [--language LANG]
                        [--reason MATCHER]
                        [--reset-at ISO] [--source-message-id ID] [--transcript PATH]
                         # StopFailure/usage hook: notify the chat when a harness
                         # stopped on a limit/error, or supported usage telemetry reaches >=90%.
                         # --agent labels reports and selects harness-specific usage contracts.
                         # Claude context_window and Pi stats require --agent claude/pi.
                         # --transcript or transcript_path alone is treated as failure input.
                         # Limit warnings localize from payload/locale hints; else English.
                         # --dry-run renders WITHOUT sending (safe smoke, #113).
  tg-ctl codex-usage-hook
                         # internal: Codex Stop hook; forwards transcript token_count telemetry.
The run/start/status/stop/enable/disable lifecycle follows the shared agent-tools
service-management contract (agenttools_service). Autostart matrix: macOS → launchd
LaunchAgent; Linux → systemd --user unit; no supported autostart → start now but it
will NOT survive reboot. enable/disable exit 4 when the OS autostart install/remove
failed (the daemon is still started; autostart is just not live).

Credentials: <config dir>/.env (TG_BOT_TOKEN, TG_CHAT_ID).
Config:      <config dir>/config.yaml, top-level control: + voice: blocks.
Env:         TG_CTL_CONFIG_DIR (default ~/.config/tg-cli),
             TG_API_BASE (default https://api.telegram.org).
`

export const CLAUDE_QUESTION_HOOK_CMD = "tg-ctl ask"

export const CLAUDE_HARNESS_HOOK_CMD = "tg-ctl harness-event"

export const CLAUDE_STATUSLINE_TELEMETRY_CMD = "tg-ctl harness-event --agent claude"

export const CODEX_USAGE_HOOK_CMD = "tg-ctl codex-usage-hook"

export const CODEX_TRANSCRIPT_TAIL_BYTES = 500_000

// Spec §5.2 no-agent guard: harness-neutral, one line. Never claims "Claude Code"
// for whatever was addressed (tg#17036: it was sent for an omp that WAS in tmux).
export const NO_AGENT_REPLY =
  "No live agent found → not delivered. Start Claude Code / Codex in a tmux window or under the rig wrapper (`rig harness run <harness> --name <label>`); omp is reachable in or outside tmux."

export const OVERLOAD_RETRY_LOCK_ATTEMPTS = 200

export const OVERLOAD_RETRY_LOCK_DELAY_MS = 10

// --- run: the daemon itself ---

// Upper bound on a cooperative (SIGTERM) drain: finish the in-flight batch, then
// exit. If some await hangs past this, hard-exit anyway so a reload never stalls.
// Comfortably under launchd's own SIGTERM→SIGKILL grace, and well above a normal
// batch's action time (a few tmux send-keys).
export const GRACEFUL_SHUTDOWN_MS = 8000

// How long a starting daemon keeps retrying a taken flock before the idempotent no-op exit. A
// lock probe that takes the flock for an instant (daemonLockFree, where no kernel lock table can
// be read) made a successor whose single attempt landed there exit 0, and `restart` left no
// daemon (tg-cli#490). A live daemon holds the lock for its lifetime, so a duplicate start still
// ends as the no-op — this much later.
export const DAEMON_LOCK_GRACE_MS = 1000
