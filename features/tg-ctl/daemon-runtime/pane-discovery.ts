// daemon-runtime/pane-discovery: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { dedupeCandidates, type AgentCandidate } from "../agent-match"
import { findAgentInPane, pickTargetPaneFromSet } from "../discover"
import { buildPaneGitState, type PaneGitState } from "../git-state"
import { findUnreachableAgents, noAgentReplyText, type UnreachableAgent } from "../unreachable"
import { describeLiveOmp, mergeLiveOmpCandidates, bridgeCodeChangedAtMs, parsePidStartList, type BridgeCodeAge, type LiveOmpAgent } from "../omp"
import { hostDisplayName, hostOfPid, hostToCandidate } from "../host-registry"
import { resolveLocatorToSession } from "../session-registry-store"
import { resolveAnchorTarget, resolveRegistrationsBySession } from "../session-target"
import { parseRegistrations, pruneRegistrations, serializeRegistrations } from "../registration-store"
import { fsRoutesLockIo, routeMatchesPane, withRoutesLock } from "../routes"
import { parseLastUserTarget } from "../last-user-target"
import type { CtlPaths, DiscoverResult, PaneInfo, ProcInfo, Registration, TargetPane } from "../types"
import { currentSessionRegistry, listLiveOmpAgents, sessionRegistry, sessionRegistryScanned } from "./session-registry"
import { fileMtimeMs, log, readFileOrNull, type Ctx } from "./ctx-io"
import { SUBPROC_ENV, UNREACHABLE_SCAN_TTL_MS, cwdOfPid, readPaneTitles, readPidTtyMap, snapshot } from "./tmux-probe"
import { listLiveHosts, ptyOnlyHosts } from "./delivery"
import { NO_AGENT_REPLY } from "./constants"

// Read the per-pane registration SET (tg-cli#67). Tolerates the legacy
// single-object file shape (a daemon upgraded in place keeps the live
// registration written by the previous version — see parseRegistrations).
// `livePaneIds` prunes entries whose pane is gone; pass null to skip pruning
// (no snapshot available, or a momentarily-empty/flaky one — pruning on empty
// would wipe every live session at once). Inside the daemon a keyed row then
// follows its session through the registry: to the pane it lives in now, or out
// of the set once it is gone, so a reused pane never inherits it (#354).
export function readRegistrations(paths: CtlPaths, livePaneIds: Set<string> | null = null): Registration[] {
  let raw: string | null
  try {
    raw = readFileSync(paths.registration, "utf8")
  } catch {
    return []
  }
  return pruneRegistrations(resolveRegistrationsBySession(parseRegistrations(raw), currentSessionRegistry()), livePaneIds)
}

// Durably PRUNE dead-pane entries from the on-disk store (review finding): the
// daemon reads-and-prunes in memory every poll, but without writing the pruned
// set back, dead entries accumulate forever — and upsertRegistration's cap
// evicts by insertion order, so 100 piled-up dead entries would eventually evict
// a still-LIVE session and silently drop its questions (the exact failure this
// feature fights). So when discovery sees the store shrink under a TRUSTWORTHY
// live-pane set, persist the smaller set. Race-safe: re-read + re-prune INSIDE
// the registration lock, so a `tg start` that upserted between the poll read and
// here is not clobbered. Best-effort and off the hot path — never throws, and is
// skipped entirely on a flaky/empty snapshot (livePaneIds === null).
export function pruneRegistrationsOnDisk(paths: CtlPaths, livePaneIds: Set<string> | null): void {
  if (livePaneIds === null) return
  try {
    withRoutesLock(
      fsRoutesLockIo(`${paths.registration}.lock`),
      () => {
        let raw: string | null
        try {
          raw = readFileSync(paths.registration, "utf8")
        } catch {
          return
        }
        const current = parseRegistrations(raw)
        const pruned = pruneRegistrations(current, livePaneIds)
        if (pruned.length !== current.length) {
          writeFileSync(paths.registration, serializeRegistrations(pruned))
        }
      },
      { onContended: "skip" }, // a live writer holds the lock — let it; we prune next poll
    )
  } catch {
    // best-effort prune — never break the poll loop
  }
}

// Fresh discovery on every call — the registration file may have been
// rewritten by a newer `tg`/`tg-ctl start` since the last poll.
// An explicit `tg-ctl start --session X` (stored in the registration) outranks
// config.yaml's control.session: it is the fresher, more specific intent, and
// the auto-start path never sets it (tg passes only --pane/--cwd).
// Rate-limit the no-agent diagnostic so the per-poll idle check can't spam the log.
export let lastNoAgentLogMs = 0

export function discoverTarget(ctx: Ctx): DiscoverResult {
  const { panes, procs } = snapshot()
  // Prune dead-pane entries against the live snapshot, but ONLY when the snapshot
  // actually has panes — an empty/flaky read must not wipe every registration
  // (panesWithRetry already retried the transient empty case).
  const livePaneIds = panes.length > 0 ? new Set(panes.map((p) => p.paneId)) : null
  const regs = readRegistrations(ctx.paths, livePaneIds)
  // Persist the prune so dead-pane entries can't accumulate to the cap and evict
  // a live session (review finding). Off the hot path, lock-guarded, no-op when
  // nothing was pruned or the snapshot is untrustworthy.
  pruneRegistrationsOnDisk(ctx.paths, livePaneIds)
  // An explicit `tg-ctl start --session X` (the fresher, more specific intent)
  // outranks config.yaml's control.session; the auto-start path never sets it.
  const sessionPin = regs.find((r) => r.sessionName)?.sessionName ?? ctx.cfg.session
  const result = pickTargetPaneFromSet(panes, procs, regs, sessionPin)
  // OBSERVABILITY: a "no-agent" result is what produces the misleading "Claude Code not in tmux"
  // reply. It has been an UNREPRODUCIBLE intermittent in the launchd runtime, so log the snapshot
  // shape on it — the next occurrence then shows the REAL cause (tmux-empty vs ps-empty vs
  // agent-match-fail vs a stale registration) instead of failing silently. Rate-limited to ≤1/10s.
  if (!result.ok && result.reason === "no-agent") {
    const now = Date.now()
    if (now - lastNoAgentLogMs > 10_000) {
      lastNoAgentLogMs = now
      const agentPanes = panes.filter((p) => findAgentInPane(p, procs)).length
      const regSummary = regs.length > 0 ? regs.map((r) => `${r.paneId ?? "?"}@${r.cwd ?? "?"}`).join(",") : "none"
      log(
        `no-agent reply: panes=${panes.length} procs=${procs.length} agent-panes=${agentPanes} ` +
          `regs=${regs.length} reg=${regSummary}`,
      )
    }
  }
  return result
}

// Git-state-check banner support (git-state.ts): a best-effort, timeout-guarded read of the
// destination pane's cwd, run right before a silent auto-bind delivery. A stuck `git` (lock
// contention, a huge repo, a hung network filesystem) must never block the daemon's single-
// threaded poll loop, so both spawns are killed after GIT_STATE_TIMEOUT_MS; ANY failure — not a
// git repo, the git binary missing, a timeout, a non-zero exit — degrades to null (no banner),
// the same "never breaks delivery" contract every other best-effort read in this file follows.
export const GIT_STATE_TIMEOUT_MS = 2000

export function gitStateForPath(cwd: string): PaneGitState | null {
  try {
    const branchProc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: GIT_STATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    })
    if (branchProc.exitCode !== 0) return null // not a git repo, or git errored — undeterminable
    const statusProc = Bun.spawnSync(["git", "-C", cwd, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: GIT_STATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    })
    if (statusProc.exitCode !== 0) return null
    return buildPaneGitState(branchProc.stdout.toString(), statusProc.stdout.toString())
  } catch {
    return null // git binary missing — never break the poll loop
  }
}

// All tmux panes that host an agent, as /agent selection candidates (item 1).
// The window name comes from the CORE snapshot's #{window_name} field (tg-cli#75
// fix C) — NOT a separate tmux call: that call skipped the UTF-8 locale env, so
// under launchd the tab-mangle blanked every name and the picker fell back to the
// cwd basename ("hyperide · claude" instead of "ext · claude"). A pane with no
// usable name (empty / a bare default) is detected downstream (isBareWindowName)
// and the label leans on the cwd basename there; here we fall back to the session
// name only when the snapshot carried no window name at all.
function tmuxAgentCandidates(panes: PaneInfo[], procs: ProcInfo[]): AgentCandidate[] {
  const out: AgentCandidate[] = []
  for (const pane of panes) {
    const found = findAgentInPane(pane, procs)
    if (!found) continue
    out.push({
      paneId: pane.paneId,
      sessionName: pane.sessionName,
      windowIndex: pane.windowIndex,
      windowName: pane.windowName || pane.sessionName,
      agent: found.agent,
      // cwd — the picker derives a distinct project-dir label from its basename
      // when window names collide or are bare defaults (the "4 · claude" ×3 bug).
      panePath: pane.panePath,
    })
  }
  // The harness title each agent pane shows — the picker's SECONDARY name, read only
  // for panes that host an agent (a pane whose omp exited keeps its stale title).
  const titles = out.length > 0 ? readPaneTitles() : new Map<string, string>()
  for (const c of out) c.paneTitle = titles.get(c.paneId) ?? null
  return out
}

// An omp a rig wrapper hosts is already the `omp:<pid>` row (that row is how it is reached);
// it takes the wrapper's label and id so `/agent <label>` selects it like any other host.
function labelRigHostedOmps(candidates: AgentCandidate[], procs: ProcInfo[]): void {
  const ompHosts = listLiveHosts(procs).filter((h) => h.agent === "omp")
  for (const c of candidates) {
    const host = c.paneId.startsWith("omp:") ? ompHosts.find((h) => `omp:${h.harnessPid}` === c.paneId) : undefined
    if (host) {
      c.windowName = hostDisplayName(host)
      c.aliases = [...(c.aliases ?? []), host.name]
    }
  }
}

// Names a session had before a rename (registry aliases, spec §3.2), so
// `/agent <oldname>` still reaches it.
function attachFormerNames(candidates: AgentCandidate[]): void {
  const registry = sessionRegistry
  if (!registry) return
  for (const c of candidates) {
    const key = resolveLocatorToSession(registry, c.paneId, undefined)
    const aliases = key ? registry.sessions.find((e) => e.key === key)?.aliases : undefined
    if (aliases && aliases.length > 0) c.formerNames = aliases
  }
}

export function listAgentCandidates(): AgentCandidate[] {
  const { panes, procs } = snapshot()
  // A pane id is unique per tmux server; dedupe guards a merged/flaky snapshot.
  // Out-of-tmux omp join as paneId omp:<pid> so /agent can pick them; an omp shown
  // in a pane keeps that pane's row and adds its title (never renames the row).
  const merged = mergeLiveOmpCandidates(dedupeCandidates(tmuxAgentCandidates(panes, procs)), listLiveOmpAgents())
  // A session a rig wrapper hosts in abduco outside tmux joins as `host:<name>`.
  merged.push(...ptyOnlyHosts(panes, procs).map(hostToCandidate))
  labelRigHostedOmps(merged, procs)
  attachFormerNames(merged)
  return merged
}

// #458: when the installed bridge last changed — the managed loader (same agent root
// ensureOmpLiveExtensionOnStartup installs into) and the files it names (the extension and
// runtime; the runtime imports only node builtins) — vs when each unbridged omp started:
// tells "resume once to load it" from a real bridge failure. No loader, a loader with no
// file URL, any missing file or a `ps` failure degrades to no verdict, never a crash.
export function readBridgeCodeAge(home: string, pids: number[]): BridgeCodeAge | undefined {
  const loaderPath = join(home, ".omp", "agent", "extensions", "tg-omp-live.ts")
  const codeChangedAtMs = bridgeCodeChangedAtMs(loaderPath, readFileOrNull(loaderPath), fileMtimeMs)
  try {
    const ps = Bun.spawnSync(["ps", "-o", "pid=,etime=", "-p", pids.join(",")], { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
    return { codeChangedAtMs, startedAtMs: parsePidStartList(ps.stdout.toString(), Date.now()) }
  } catch {
    return undefined
  }
}

export let unreachableCache: { at: number; agents: UnreachableAgent[] } | null = null

export function listUnreachableAgents(): UnreachableAgent[] {
  const now = Date.now()
  if (unreachableCache && now - unreachableCache.at < UNREACHABLE_SCAN_TTL_MS) return unreachableCache.agents
  const ttyByPid = readPidTtyMap()
  const { panes, procs } = snapshot()
  const hosts = listLiveHosts(procs)
  const agents = findUnreachableAgents(panes, procs, ttyByPid)
    .filter((a) => a.agent !== "omp")
    // A harness a rig wrapper hosts in abduco is reachable through its PTY, not unreachable.
    .filter((a) => hostOfPid(a.pid, procs, hosts) === null)
    .map((a) => ({ ...a, cwd: cwdOfPid(a.pid) }))
  unreachableCache = { at: now, agents }
  return agents
}

// One `  - …` line per omp, each naming the tmux pane it is shown in (window name +
// harness title, falling back to the pane title) — the same resolver name the picker
// and the outbound header use. One pane snapshot + one title read per listing.
export function describeOmpLines(agents: LiveOmpAgent[]): string[] {
  const panes = snapshot().panes
  const titles = agents.some((a) => a.paneId) ? readPaneTitles() : new Map<string, string>()
  return agents.map((a) => {
    const pane = a.paneId ? panes.find((p) => p.paneId === a.paneId) : undefined
    return `  - ${describeLiveOmp(a, pane ? { ...pane, paneTitle: titles.get(pane.paneId) ?? null } : null)}`
  })
}

export function noAgentReplyNow(): string {
  const live = listLiveOmpAgents()
  const unreachable = listUnreachableAgents()
  if (live.length > 0) {
    const lines = describeOmpLines(live)
    const ompBlock = `omp (original-process bridge, never session/load):\n${lines.join("\n")}`
    if (unreachable.length === 0) return ompBlock
    return `${ompBlock}\n${noAgentReplyText("", unreachable)}`
  }
  return noAgentReplyText(NO_AGENT_REPLY, unreachable)
}

export function newestRegisteredCwd(regs: Registration[]): string | null {
  let best: Registration | null = null
  for (const reg of regs) {
    if (!reg.cwd) continue
    if (!best || (reg.registeredAt ?? 0) > (best.registeredAt ?? 0)) best = reg
  }
  return best?.cwd ?? null
}

export function registeredCwdForPane(regs: Registration[], pane: Pick<PaneInfo, "paneId" | "sessionName">): string | null {
  const exact = regs.find((reg) => reg.cwd && reg.paneId && reg.paneId === pane.paneId)
  if (exact?.cwd) return exact.cwd
  const sessionMatches = regs.filter((reg) => reg.cwd && !reg.paneId && reg.sessionName && reg.sessionName === pane.sessionName)
  return sessionMatches.length === 1 ? sessionMatches[0].cwd! : null
}

export function singleRegisteredCwd(regs: Registration[]): string | null {
  const unique = [...new Set(regs.map((reg) => reg.cwd).filter((cwd): cwd is string => Boolean(cwd)))]
  return unique.length === 1 ? unique[0] : null
}

// --- /tasks command (#115): compose task-cli + gh into a rich board table ---

// The pane of the CTO's OWN last resolved inbound delivery (tg-cli#78 anchor
// fix) — shared by the daemon's discoverForInject (message routing) AND
// resolveTasksScopeDir below (`/tasks` default scoping), so both use the SAME
// anchor rather than `/tasks` falling back to the old `lastMessagePane` (any
// pane's last outbound send) after the routing path already moved on to this
// one (review finding: the two surfaces silently disagreeing on "the default
// target" is the exact class of bug tg-cli#78 fixed for inbound routing).
//
// Guards against tmux pane-ID reuse (mirrors routeMatchesPane's reply-route
// protection): a recognized paneId is trusted only if its recorded cwd still
// matches the LIVE candidate's path. A stale/mismatched anchor returns null
// rather than risk mis-routing into a different project that now happens to
// own that pane id.
export function resolveLastUserTarget(ctx: Ctx, candidates: TargetPane[]): TargetPane | null {
  const anchor = parseLastUserTarget(readFileOrNull(ctx.paths.lastUserTarget))
  if (!anchor) return null
  // A keyed anchor follows its session (spec §2.4); a gone one never falls back
  // to its old pane, which may host a different session now.
  const target = resolveAnchorTarget(anchor, currentSessionRegistry())
  if (!target) return null
  const hit = candidates.find((c) => c.pane.paneId === target.paneId)
  if (!hit) return null
  return anchorProven(target) || routeMatchesPane({ recognizedCwd: anchor.cwd, panePath: hit.pane.panePath }) ? hit : null
}

// Only a registry this daemon scanned itself may vouch for a pane and skip the
// cwd guard: the persisted one read before the first scan can predate a tmux
// restart that reused the pane id.
export function anchorProven(target: { proven: boolean }): boolean {
  return target.proven && sessionRegistryScanned
}

// Same anchor lookup as resolveLastUserTarget, but against the merged
// tmux+omp AgentCandidate view (listAgentCandidates()) instead of the
// tmux-only TargetPane view — used by injectViaTarget's no-tmux-pane
// fallback so the tg-cli#78 anchor also covers out-of-tmux omp agents
// (tg-cli#369).
export function resolveLastUserTargetCandidate(ctx: Ctx, candidates: AgentCandidate[]): AgentCandidate | null {
  const anchor = parseLastUserTarget(readFileOrNull(ctx.paths.lastUserTarget))
  if (!anchor) return null
  const target = resolveAnchorTarget(anchor, currentSessionRegistry())
  if (!target) return null
  const hit = candidates.find((c) => c.paneId === target.paneId)
  if (!hit) return null
  return anchorProven(target) || routeMatchesPane({ recognizedCwd: anchor.cwd, panePath: hit.panePath }) ? hit : null
}
