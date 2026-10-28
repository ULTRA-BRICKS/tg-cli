// The origin of one outbound send (tg-cli#817): which tmux pane / omp process / wrapper host it
// came from, and the registry session that maps to. Each reader is a closure that caches its answer —
// every chunk of one send shares one tmux read and one registry read.
import { readFileSync } from "fs"
import { parseRegistry } from "../../tg-ctl/session-registry-store"
import { resolveRouteSession, type RouteOrigin } from "../../tg-ctl/session-target"
import { parseLsofCwd } from "../../tg-ctl/unreachable"
import type { SenderContext } from "./types"

export interface OriginPane {
  path: string | null
  serverPid?: number
  panePid?: number
}

export interface OriginSession {
  locators: RouteOrigin
  sessionKey: string | null
}

type PaneSender = Pick<SenderContext, "pinned" | "sessionless">
type PathSender = Pick<SenderContext, "ompAncestorPid" | "ownHost">
type SessionSender = Pick<SenderContext, "ancestor" | "pinnedKey" | "sessionsPath">

// `tmux display-message` output: `path \t server pid \t pane pid`. The pids are the LAST two
// fields because a pane path may itself contain a tab.
function parseOriginPane(stdout: string): OriginPane {
  const fields = stdout.replace(/\r?\n$/, "").split("\t")
  const panePid = fields.pop()
  const serverPid = fields.pop()
  const path = fields.join("\t")
  return {
    path: path || null,
    ...(Number(serverPid) > 0 ? { serverPid: Number(serverPid) } : {}),
    ...(Number(panePid) > 0 ? { panePid: Number(panePid) } : {}),
  }
}

function queryTmuxPane(tmuxPane: string): OriginPane | null {
  try {
    const result = Bun.spawnSync(
      ["tmux", "display-message", "-p", "-t", tmuxPane, "#{pane_current_path}\t#{pid}\t#{pane_pid}"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode === 0) return parseOriginPane(new TextDecoder().decode(result.stdout))
  } catch {
    // tmux missing / pane gone — fall back to process.cwd() in resolveRouteCwd
  }
  return null
}

// ONE tmux read of the origin pane: its path (the route cwd) and its
// exact locator — server pid + pane pid — that names the pane across tmux
// restarts (spec §2.6). Cached: every chunk of one send shares it.
export function makeOriginPaneReader(tmuxPane: string | undefined, sender: PaneSender): () => OriginPane {
  let originPane: OriginPane | undefined
  return () => {
    if (originPane) return originPane
    originPane = { path: null }
    if (!tmuxPane || sender.pinned || sender.sessionless) return originPane
    originPane = queryTmuxPane(tmuxPane) ?? originPane
    return originPane
  }
}

// The cwd of an out-of-tmux omp, via lsof; null when lsof is missing / fails.
function queryOmpCwd(ompAncestorPid: number): string | null {
  try {
    const result = Bun.spawnSync(
      ["lsof", "-a", "-p", String(ompAncestorPid), "-d", "cwd", "-Fn"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode === 0) {
      const cwd = parseLsofCwd(new TextDecoder().decode(result.stdout))
      if (cwd) return cwd
    }
  } catch {
    // lsof missing — fall back to process.cwd() in resolveRouteCwd
  }
  return null
}

// The origin pane's tmux pane_current_path — the SAME quantity the daemon
// reads (pane.panePath) when validating a reply. Recording this instead of
// process.cwd() is the routing fix: agents run `tg` from /tmp, so process.cwd()
// never matched the pane's project dir and every reply hit the picker. Returns
// null when not in tmux / the query fails, so resolveRouteCwd degrades to cwd.
export function makePanePathQuery(
  tmuxPane: string | undefined,
  sender: PathSender,
  readOriginPane: () => OriginPane,
): () => string | null {
  return () => {
    if (!tmuxPane && sender.ompAncestorPid) return queryOmpCwd(sender.ompAncestorPid)
    if (!tmuxPane) return sender.ownHost?.cwd ?? null
    return readOriginPane().path
  }
}

// The session this send came from (session registry key, spec §2.4), resolved
// once per send from the daemon's sessions.json (read-only here) and the exact
// origin locators. A reply then follows the SESSION, so it still lands after an
// omp restart/resume changed the pid (tg-cli#459). Unresolved (the daemon has
// not scanned this session yet) → the route keeps its locators and the
// daemon's next scan stamps the key.
export function makeOriginSessionResolver(
  originPaneId: string,
  sender: SessionSender,
  readOriginPane: () => OriginPane,
): () => OriginSession {
  let originSession: OriginSession | undefined
  return () => {
    if (originSession) return originSession
    const pane = readOriginPane()
    const locators: RouteOrigin = {
      paneId: originPaneId,
      ...(sender.ancestor ? { agentPid: sender.ancestor.pid } : {}),
      ...(pane.serverPid && pane.panePid ? { serverPid: pane.serverPid, panePid: pane.panePid } : {}),
    }
    // A pin decides outright (tg-cli#709); otherwise the exact origin locators do.
    let sessionKey: string | null = sender.pinnedKey ?? null
    if (sender.pinnedKey === undefined) {
      try {
        sessionKey = resolveRouteSession(parseRegistry(readFileSync(sender.sessionsPath, "utf8")), locators)
      } catch {
        // no registry yet — the daemon's next scan stamps the route
      }
    }
    originSession = { locators, sessionKey }
    return originSession
  }
}
