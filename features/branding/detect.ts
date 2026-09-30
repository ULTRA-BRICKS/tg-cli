// Agent / process detection used for outbound branding (tg decomposition Stage
// 0b, docs/specs/tg-decomposition.md). Extracted verbatim from `tg` — behaviour
// unchanged. Real spawns live here (the entrypoint imports these); the pure
// process-tree parsing is reused from features/tg-ctl/discover.
import { findAgentInAncestry, parseProcList } from "../tg-ctl/discover"

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

// Which agent launched this `tg` process? Climb the ppid chain and match the
// nearest ancestor command (claude/codex/opencode/pi/aider/omp). This is the
// reliable signal for agents that — unlike Claude Code's CLAUDECODE — export no
// env marker: a `codex exec` is the direct parent of the shell command it runs.
// Crucially it runs BEFORE the pgrep fallbacks so a background `ollama` daemon
// (a sibling, never an ancestor) can no longer hijack the label. Returns the kind
// AND pid: `tg` also uses an omp ancestor's pid to stamp routes.json `omp:<pid>`
// outside tmux and to read that omp session's own title.
export function detectAncestorAgent(): { agent: string; pid: number } | null {
  try {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return null
    const procs = parseProcList(new TextDecoder().decode(result.stdout))
    return findAgentInAncestry(procs, process.ppid)
  } catch {
    return null
  }
}

export function detectAgentViaAncestry(): string | null {
  return detectAncestorAgent()?.agent ?? null
}
