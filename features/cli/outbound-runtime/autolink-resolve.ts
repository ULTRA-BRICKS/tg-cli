// Autolink stage of the outbound `tg` pipeline (tg-cli#817): verify ticket codes (linear CLI), GitHub
// `#N` refs (gh CLI) and detect `tg#<id>` message refs in the final caption.
//
// Every failure mode keeps the send going unchanged: a missing CLI / missing auth produce a ONE-TIME
// stderr hint (state in ~/.config/tg-cli/autolink-tasks.json, shared by the tasks and prs flows), anything
// else a one-line warning. Synchronous, like the spawns it wraps.
import { readFileSync } from "fs"
import { join } from "path"
import type { FeatureMap } from "../../auto-attach/feature-flags"
import { mergeIntoCache as mergeGhCache, splitByCache as splitGhCache } from "../../autolink-prs/cache"
import { mergeIntoCache, splitByCache } from "../../autolink-tasks/cache"
import { detectTicketCodesExpanded } from "../../autolink-tasks/detect"
import { probeTickets, type LinearProbe, type TicketInfo } from "../../autolink-tasks/linear"
import { detectRefsExpanded } from "../../autolink-prs/detect"
import { probeRefsInRepo, probeRepo, type GhRef, type GhRefsResult } from "../../autolink-prs/resolve"
import { detectMsgRefs } from "../../autolink-msgrefs/detect"
import { parseHistory, type HistoryRecord } from "../../replies/history"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import { makeHintOnce, makeSpawnRunner, readCacheFile, writeCacheFileBestEffort, type HintOnce } from "./autolink-probes"
import type { AutolinkFindings, RuntimePaths } from "./types"

type TicketProbeFailure = Exclude<LinearProbe, { status: "ok" }>

// Map a failed linear probe to its one-time hint or one-line warning.
function reportTicketProbeFailure(probe: TicketProbeFailure, codes: string[], hintOnce: HintOnce): void {
  if (probe.status === "no-cli") {
    hintOnce(
      "install",
      `autolink-tasks: ticket-like codes found (${codes.join(", ")}) but the linear CLI is not installed. ` +
        "Install: brew install schpet/tap/linear — or disable with --no-feature autolink-tasks. (shown once)",
    )
  } else if (probe.status === "no-auth") {
    hintOnce("login", "autolink-tasks: the linear CLI is not authenticated. Run: linear auth login (shown once)")
  } else {
    console.error(`Warning: autolink-tasks: ${probe.message} — sending without links`)
  }
}

// --- autolink-tasks: detect ticket codes, verify them via the linear CLI ---
// (docs/specs/autolink-tasks.md). One `linear api` spawn per send, and only
// when the text actually contains ticket-like codes. Codes Linear doesn't
// know simply don't come back and stay plain text.
function resolveTickets(caption: string, features: FeatureMap, home: string, hintOnce: HintOnce): TicketInfo[] {
  if (features["autolink-tasks"] === false || !caption) return []
  const codes = detectTicketCodesExpanded(caption)
  if (codes.length === 0) return []
  // 1h response cache (positive AND negative verdicts) so repeated reports
  // mentioning the same tickets don't re-spawn the linear CLI every send.
  // Cache failures degrade to a plain probe; probe failures degrade to
  // cached hits only — the send itself is never blocked.
  const cachePath = join(home, ".cache", "tg-cli", "linear-cache.json")
  const cacheRaw = readCacheFile(cachePath)
  const now = Date.now()
  const { hits, missing } = splitByCache(codes, cacheRaw, now)
  let probed: Map<string, TicketInfo> | null = null
  if (missing.length > 0) {
    const probe = probeTickets(missing, makeSpawnRunner("linear"))
    if (probe.status === "ok") {
      probed = probe.tickets
      const fresh = probe.tickets
      writeCacheFileBestEffort(home, cachePath, () => mergeIntoCache(cacheRaw, missing, fresh, now))
    } else {
      reportTicketProbeFailure(probe, codes, hintOnce)
    }
  }
  // Cached hits + live results, in first-appearance order. A null hit is a
  // cached verified-absent verdict; a failed probe leaves its codes plain.
  return codes
    .map((c) => (hits.has(c) ? hits.get(c) : (probed?.get(c) ?? null)))
    .filter((t): t is TicketInfo => t != null)
}

// Hint/warning for a failed gh step. `no-repo` (not a GitHub repo / no remote — normal for many cwds)
// stays silent.
function reportGhFailure(
  probe: { status: "no-cli" } | { status: "no-auth" } | { status: "no-repo" } | { status: "error"; message: string },
  refs: number[],
  hintOnce: HintOnce,
): void {
  if (probe.status === "no-cli") {
    hintOnce(
      "gh-install",
      `autolink-prs: GitHub refs found (${refs.map((n) => `#${n}`).join(", ")}) but the gh CLI is not installed. ` +
        "Install: brew install gh — or disable with --no-feature autolink-prs. (shown once)",
    )
  } else if (probe.status === "no-auth") {
    hintOnce("gh-login", "autolink-prs: the gh CLI is not authenticated. Run: gh auth login (shown once)")
  } else if (probe.status === "error") {
    console.error(`Warning: autolink-prs: ${probe.message} — sending without links`)
  }
}

// Cached hits + live probe of the cache misses for one known repo.
function resolveRefsInRepo(repo: string, refs: number[], home: string, hintOnce: HintOnce): Map<number, GhRef> {
  const cachePath = join(home, ".cache", "tg-cli", "gh-cache.json")
  const cacheRaw = readCacheFile(cachePath)
  const now = Date.now()
  const { hits, missing } = splitGhCache(repo, refs, cacheRaw, now)
  let probed: Map<number, GhRef> | null = null
  if (missing.length > 0) {
    const probe: GhRefsResult = probeRefsInRepo(repo, missing, makeSpawnRunner("gh"))
    if (probe.status === "ok") {
      probed = probe.refs
      const fresh = probe.refs
      writeCacheFileBestEffort(home, cachePath, () => mergeGhCache(cacheRaw, repo, missing, fresh, now))
    } else {
      reportGhFailure(probe, refs, hintOnce)
    }
  }
  // Cached hits + live results, in first-appearance order. A null hit is a
  // cached verified-absent verdict; a failed probe leaves its refs plain.
  const resolved = new Map<number, GhRef>()
  for (const num of refs) {
    const ref = hits.has(num) ? hits.get(num) : (probed?.get(num) ?? null)
    if (ref) resolved.set(num, ref)
  }
  return resolved
}

// --- autolink-prs: detect #N refs, resolve them via the gh CLI ---
// (docs/specs/autolink-prs.md). Sibling of autolink-tasks: detect → cache
// split → probe → merge. Two gh spawns when refs are found — repo identity
// (`gh repo view`) then one batched `gh api graphql`. Issues merge into the
// tickets reference block; PRs get their own block (handled in render later).
function resolveGhRefs(
  caption: string,
  features: FeatureMap,
  home: string,
  hintOnce: HintOnce,
): { refs: Map<number, GhRef>; refOrder: number[] } {
  if (features["autolink-prs"] === false || !caption) return { refs: new Map(), refOrder: [] }
  const detected = detectRefsExpanded(caption)
  if (detected.length === 0) return { refs: new Map(), refOrder: [] }
  // Resolve repo identity first — the cache is keyed by repo (#260 means
  // different things in different repos), so we cannot cache-split before we
  // know the repo. `gh repo view` is cheap; the batched graphql is the spawn
  // we want to skip when every ref is already cached.
  const repoProbe = probeRepo(makeSpawnRunner("gh"))
  if (repoProbe.status !== "ok") {
    reportGhFailure(repoProbe, detected, hintOnce)
    return { refs: new Map(), refOrder: detected }
  }
  return { refs: resolveRefsInRepo(repoProbe.repo, detected, home, hintOnce), refOrder: detected }
}

// Read only when the body has a linkable ref, so a ref-less send never parses the
// ~5000-line log. Missing/corrupt history → no previews, no excerpts.
function makeMsgRefHistoryReader(home: string, botToken: string | undefined): (ids: number[]) => HistoryRecord[] {
  return (ids) => {
    if (ids.length === 0) return []
    const historyPath = ctlPaths(process.env.TG_CTL_CONFIG_DIR || join(home, ".config", "tg-cli"), botIdFromToken(botToken!)).history
    try {
      return parseHistory(readFileSync(historyPath, "utf8"))
    } catch {
      return []
    }
  }
}

export function resolveAutolinks(
  caption: string,
  features: FeatureMap,
  paths: RuntimePaths,
  botToken: string | undefined,
): AutolinkFindings {
  const { home } = paths
  const hintOnce = makeHintOnce(home)
  const tickets = resolveTickets(caption, features, home, hintOnce)
  const hasTickets = tickets.length > 0
  const { refs, refOrder } = resolveGhRefs(caption, features, home, hintOnce)
  const hasRefs = refs.size > 0
  // --- autolink-msgrefs: detect `tg#<id>` inbound-message references (tg#28).
  // These are the convention the inbound inject wrap renders, distinct from a
  // GitHub `#<id>`. PURE text detection — no CLI spawn. The deep link only
  // materializes for a supergroup chat; in a private DM the ref is marked but
  // unlinked (no public per-message URL exists there). A ref whose message is in
  // the local history is quoted inline instead (`autolink-msgref-preview`,
  // tg-cli#116); the rest get a bottom excerpt entry when the history has them.
  const rawMsgRefIds = features["autolink-msgrefs"] !== false && caption ? detectMsgRefs(caption) : []
  const msgRefPreviewOn = features["autolink-msgref-preview"] !== false
  const hasMsgRefs = rawMsgRefIds.length > 0
  return {
    tickets,
    hasTickets,
    refs,
    refOrder,
    hasRefs,
    rawMsgRefIds,
    msgRefPreviewOn,
    hasMsgRefs,
    hasAutolink: hasTickets || hasRefs || hasMsgRefs,
    readMsgRefHistory: makeMsgRefHistoryReader(home, botToken),
  }
}
