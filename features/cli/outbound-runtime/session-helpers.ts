// Session/pane identity helpers shared by the `tg replies` read path and the outbound history
// writer (tg-cli#817: moved out of the `tg` entrypoint unchanged).
import { readFileSync } from "fs"
import { agentNameFromDisplayLine } from "../../tg-ctl/agent-name"
import { callerSessionKey, parseRegistry } from "../../tg-ctl/session-registry-store"
import type { Registry } from "../../tg-ctl/session-registry"

// The human AGENT NAME for THIS shell's tmux pane — the SAME derivation the
// daemon stamps on inbound records (resolveSessionName().primary over #{window_name} +
// #{pane_current_path}). Used by BOTH the `tg replies` read path (its default
// `current` scope resolves the reader's own agent) AND the outbound history
// writer (it stamps `targetAgent` on each record it appends), so a session's
// outbound and the inbound routed to it share one label and the default
// agent-scoped view groups them together. Returns null when not in tmux / the
// query fails / neither signal is usable — the caller then degrades to untagged.
export function currentPaneAgentName(): string | null {
  const pane = process.env.TMUX_PANE
  if (!process.env.TMUX || !pane) return null
  try {
    const result = Bun.spawnSync(
      ["tmux", "display-message", "-p", "-t", pane, "#{window_name}\t#{pane_current_path}"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode !== 0) return null
    // Parse via the shared helper: it splits on the FIRST tab and strips only the trailing
    // newline, so an empty window name (a bare/auto-named pane — the cwd-fallback case) keeps
    // the path in the right slot instead of a blanket .trim() eating the tab delimiter.
    return agentNameFromDisplayLine(new TextDecoder().decode(result.stdout))
  } catch {
    return null // tmux missing / pane gone
  }
}

// sessions.json (the daemon is its only writer; `tg` only reads it). Absent or
// unreadable → an empty registry: history rows then go untagged by session and
// `tg replies` falls back to the pane + window name.
export function readSessionRegistry(sessionsPath: string): Registry {
  try {
    return parseRegistry(readFileSync(sessionsPath, "utf8"))
  } catch {
    return parseRegistry(null)
  }
}

// The registry session THIS `tg` runs under (spec §3.3): by its agent ancestor's
// pid, else by $TMUX_PANE or the out-of-tmux omp's `omp:<pid>` origin.
export function ownSessionKey(reg: Registry, ancestor: { agent: string; pid: number } | null): string | null {
  const pane = process.env.TMUX_PANE || null
  const locator = pane ?? (ancestor?.agent === "omp" ? `omp:${ancestor.pid}` : null)
  return callerSessionKey(reg, { agentPid: ancestor?.pid ?? null, locator })
}
