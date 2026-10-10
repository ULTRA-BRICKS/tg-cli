// Agent / process detection used for outbound branding (tg decomposition Stage
// 0b, docs/specs/tg-decomposition.md). Extracted verbatim from `tg` — behaviour
// unchanged. Real spawns live here (the entrypoint imports these); the pure
// process-tree parsing is reused from features/tg-ctl/discover.
import { findAgentsInAncestry, parseProcList, type AgentAncestor } from "../tg-ctl/discover"

export function isProcessRunning(name: string): boolean {
  try {
    const result = Bun.spawnSync(["pgrep", "-x", name], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

// Which agents launched this `tg` process, nearest first? Climb the ppid chain
// and match each ancestor command (claude/codex/opencode/pi/aider/omp). This is
// the reliable signal for agents that — unlike Claude Code's CLAUDECODE — export
// no env marker: a `codex exec` is the direct parent of the shell command it
// runs. Crucially it runs BEFORE the pgrep fallbacks so a background `ollama`
// daemon (a sibling, never an ancestor) can no longer hijack the label. The
// nearest hit is the sender: `tg` uses an omp's pid to stamp routes.json
// `omp:<pid>` outside tmux and to read that omp session's own title. The hits
// past it are the sender's lineage (the omp that started a nested omp, #503).
export function detectAgentAncestry(): AgentAncestor[] {
  try {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return []
    const procs = parseProcList(new TextDecoder().decode(result.stdout))
    return findAgentsInAncestry(procs, process.ppid)
  } catch {
    return []
  }
}

export function detectAgentViaAncestry(): string | null {
  return detectAgentAncestry()[0]?.agent ?? null
}
