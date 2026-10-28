// daemon-runtime/tmux-probe: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { readlinkSync } from "fs"
import { panesWithRetry, parsePaneTitles, parseProcList } from "../discover"
import { parseLsofCwd, parsePidTtyList } from "../unreachable"
import type { PaneInfo, ProcInfo } from "../types"
import { log } from "./ctx-io"

// Tab separator — pane_current_path may contain spaces (see discover.ts).
// #{window_name} is carried in the CORE snapshot (a fixed field BEFORE the greedy
// path) so the /agent picker can label by the user-set window name reliably
// (tg-cli#75 fix C); the previous separate window-name tmux call did NOT pass the
// UTF-8 locale env, so under launchd the tab-mangle blanked every name and the
// picker fell back to the cwd basename.
export const PANE_FORMAT =
  "#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{window_name}\t#{@tg_spawn_token}\t#{pane_current_path}"

// Subprocess env with a GUARANTEED UTF-8 locale. THE root cause of the "Claude Code not in tmux"
// saga: under launchd the daemon inherits NO locale (LANG/LC_* unset), and tmux then classifies the
// TAB separator in PANE_FORMAT as non-printable and ESCAPES it to `_` in its `-F` output. Every line
// then collapses to a single field, parsePaneList drops it (<8 fields), snapshot() returns ZERO
// panes, and the daemon reports "not in tmux" for every message despite live agent panes. A UTF-8
// locale makes tmux emit real tabs. It MUST be passed explicitly on the spawn — Bun.spawnSync does
// NOT pick up a runtime `process.env` mutation — so this env is handed to every discovery subprocess.
// (#44/#46 retried a symptom; the output was non-empty but mis-separated, which is why a retry could
// never fix it.)
//
// Set LC_ALL UNCONDITIONALLY. LC_ALL is the top-priority locale var, so this overrides ANY inherited
// state — including the trap where LC_ALL=C coexists with LANG=*.UTF-8 (common in cron/CI profiles):
// a "does any var look UTF-8?" check would see LANG and wrongly leave the effective C locale in place.
// Discovery output is parsed as raw bytes, so the SPECIFIC UTF-8 locale is irrelevant — only that it
// IS UTF-8. Pick one guaranteed to exist on the platform: macOS ships en_US.UTF-8 but not C.UTF-8;
// minimal Linux images often ship C.UTF-8 but not en_US.UTF-8.
export const SUBPROC_ENV: Record<string, string> = (() => {
  const env = { ...process.env } as Record<string, string>
  env.LC_ALL = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
  return env
})()

// tmux absent / no server / ps failure → empty snapshot, never a crash:
// discovery then degrades to the no-agent reply path.
export function snapshot(): { panes: PaneInfo[]; procs: ProcInfo[] } {
  let procs: ProcInfo[] = []
  // Retry a transient empty/failed `tmux list-panes` before accepting "no panes". panesWithRetry is
  // a no-op on the happy path (breaks on the first non-empty read) and pure/unit-tested. The env is
  // forced UTF-8 (see SUBPROC_ENV) so tmux emits real tab separators.
  const panes = panesWithRetry(
    () => {
      try {
        const tmux = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", PANE_FORMAT], {
          stdout: "pipe",
          stderr: "pipe",
          env: SUBPROC_ENV,
        })
        return { exitCode: tmux.exitCode ?? 1, stdout: tmux.stdout.toString() }
      } catch {
        return null // tmux binary missing — retrying cannot help
      }
    },
    { sleep: (ms) => Bun.sleepSync(ms) },
  )
  // The ps query gets the SAME transient-empty resilience as tmux above: `ps -axo` returning an
  // empty list is impossible on a live system (system procs always exist), so an empty/failed read
  // is a launchd-runtime flake — and an empty procs list makes findAgentInPane match nothing, so
  // live agent panes report as "no agent" exactly like an empty tmux read (the gap the tmux-only
  // retry missed). Retry an exit-0-but-empty read; break on the first non-empty or a hard failure.
  for (let i = 0; i < 3; i++) {
    if (i > 0) Bun.sleepSync(120)
    try {
      const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
      if (ps.exitCode !== 0) break // ps failed hard — retrying unlikely to help
      procs = parseProcList(ps.stdout.toString())
      if (procs.length > 0) break
    } catch {
      break // ps missing — never on a supported platform
    }
  }
  return { panes, procs }
}

// Raw `#{pane_title}` per pane id — the harness title omp (`π > title`) and Claude Code
// (`✳ title`) paint into the terminal (secondary name, tg-cli#455). A separate query, not a
// PANE_FORMAT field: a title is free text and would break that parser's fixed layout. Only
// the naming surfaces read it; any failure degrades to "no titles", never to "no panes".
export function readPaneTitles(): Map<string, string> {
  try {
    const tmux = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{pane_title}"], {
      stdout: "pipe",
      stderr: "pipe",
      env: SUBPROC_ENV,
    })
    return tmux.exitCode === 0 ? parsePaneTitles(tmux.stdout.toString()) : new Map()
  } catch {
    return new Map()
  }
}

// --- agents OUTSIDE tmux (tg-cli#306) ---
//
// A second, cheap ps read (`pid tty` only) is DISPLAY-ONLY for claude/codex/opencode
// (tg-cli#413 follow-up removed the gate there — see the "Past bug (tg-cli#413
// follow-up)" note above `findUnreachableAgents`); for pi/aider/omp/unknown (no
// per-shape headless detection) it is still load-bearing: `findUnreachableAgents`
// requires a real tty map entry for those kinds before listing one as unreachable.
// Their cwd comes from lsof (one call per such agent — a handful at most). A `ps`
// failure here degrades to an empty map, never a crash — that only suppresses
// pi/aider/omp/unknown (still tty-gated); claude/codex/opencode are listed either way.
export function readPidTtyMap(): Map<number, string> {
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,tty="], { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
    if (ps.exitCode !== 0) return new Map()
    return parsePidTtyList(ps.stdout.toString())
  } catch {
    return new Map()
  }
}

export const LSOF_TIMEOUT_MS = 2000

export let lsofMissingWarned = false

// The agent's cwd: `/proc/<pid>/cwd` where it exists (Linux — no external tool),
// else `lsof` (macOS ships it). On a Linux box with neither the cwd is unknown — said
// ONCE in the log, never silently — and the agent is still listed, by its --name or
// pid, just without a cwd-derived inbox key.
export function cwdOfPid(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    // no procfs (macOS) or the process is gone — fall through to lsof
  }
  try {
    const lsof = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn", "-n"], {
      stdout: "pipe",
      stderr: "pipe",
      env: SUBPROC_ENV,
      timeout: LSOF_TIMEOUT_MS,
      killSignal: "SIGKILL",
    })
    if (lsof.exitCode !== 0) return null
    return parseLsofCwd(lsof.stdout.toString())
  } catch (err) {
    if (!lsofMissingWarned) {
      lsofMissingWarned = true
      log(`unreachable scan: cannot resolve the cwd of pid ${pid} — no /proc and lsof failed (${err}); install lsof for cwd-keyed inboxes`)
    }
    return null
  }
}

// Memoized for a short window: the scan is sync (ps + one lsof per agent, up to
// LSOF_TIMEOUT_MS each) and one inbound message can ask for it several times in a row
// (route attempt, then the no-agent reply); a poll tick asks once more. One scan per
// ~2s keeps the single-threaded poll loop responsive (review finding).
export const UNREACHABLE_SCAN_TTL_MS = 2000

// tmux `#{pid}` of the server `list-panes` read — part of every pane locator, so a
// server restart that reuses `%N` ids never looks like the same pane (§2.6).
export function readTmuxServerPid(): number | null {
  try {
    const tmux = Bun.spawnSync(["tmux", "display-message", "-p", "#{pid}"], { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
    const pid = Number(tmux.stdout.toString().trim())
    return tmux.exitCode === 0 && Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
