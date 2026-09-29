// Agent / process detection used for outbound branding (tg decomposition Stage
// 0b, docs/specs/tg-decomposition.md). Extracted verbatim from `tg` — behaviour
// unchanged. Real spawns live here (the entrypoint imports these); the pure
// process-tree parsing is reused from features/tg-ctl/discover.
import { findAgentsInAncestry, parseProcList } from "../tg-ctl/discover"

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
// (a sibling, never an ancestor) can no longer hijack the label.
function ancestryHits(): Array<{ agent: string; pid: number }> {
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
  return ancestryHits()[0]?.agent ?? null
}

/**
 * OMP ancestors nearest-first. A second OMP is an explicit process-lineage
 * parent for a disposable/headless child; cwd equality alone is never lineage.
 */
export function detectOmpAncestorPids(): number[] {
  return ancestryHits()
    .filter((hit) => hit.agent === "omp")
    .map((hit) => hit.pid)
}

export interface OmpAncestry {
  pids: number[]
  nearestIsAcpHelper: boolean
}

function ompCommandIsAcpHelper(command: string): boolean {
  // Both the compiled binary (`omp acp ...`) and the source launcher
  // (`bun .../cli.ts acp ...`) expose the ACP subcommand as a standalone argv
  // token. Do not substring-match paths/names containing "acp".
  return /(?:^|\s)acp(?:\s|$)/.test(command)
}

export function detectOmpAncestry(): OmpAncestry {
  try {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return { pids: [], nearestIsAcpHelper: false }
    const procs = parseProcList(new TextDecoder().decode(result.stdout))
    const hits = findAgentsInAncestry(procs, process.ppid).filter((hit) => hit.agent === "omp")
    const pids = hits.map((hit) => hit.pid)
    const nearest = pids.length > 0 ? procs.find((proc) => proc.pid === pids[0]) : undefined
    return {
      pids,
      nearestIsAcpHelper: nearest ? ompCommandIsAcpHelper(nearest.command) : false,
    }
  } catch {
    return { pids: [], nearestIsAcpHelper: false }
  }
}

/** Pid of the nearest omp ancestor — used to stamp routes.json omp:<pid> outside tmux. */
export function detectOmpAncestorPid(): number | null {
  return detectOmpAncestorPids()[0] ?? null
}
