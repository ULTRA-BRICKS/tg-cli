// daemon-runtime/poll-loop-history: inbound history recording of a poll batch (for `tg replies` recall).
// Split out of poll-loop.ts (guardian-817): each message is stamped with the pane/agent/session/topic it routes to.
import { isAgentCommand } from "../agent-match"
import { findAgentInPane } from "../discover"
import { resolveSessionName } from "../session-name"
import { type Registry } from "../session-registry"
import { resolveLocatorToSession } from "../session-registry-store"
import { paneLocatorOf } from "../session-topics"
import { parseRoutes, recognizeRoute, routeMatchesPane, type Route } from "../routes"
import { parseRemoteRoutes, recognizeRemoteRoute, remotePaneLabel, type RemoteRouteEntry } from "../remote-routes"
import { inboundHistoryRecords, type TopicSession } from "../../replies/inbound"
import { findTopic } from "../topics"
import type { PaneInfo, TgMessage, TgUpdate } from "../types"
import { appendHistory, readFileOrNull } from "./ctx-io"
import { sessionRegistry } from "./session-registry"
import { snapshot } from "./tmux-probe"
import type { Ctx } from "./ctx-io"
import type { TopicRoutingApi } from "./topic-routing"
import { hubMachines } from "./remote-hub"
import type { TargetRoutingApi } from "./target-routing"

export type InboundHistoryDeps = {
  ctx: Ctx
  topicRouting: Pick<TopicRoutingApi, "topicOwner" | "loadTopics">
  targetRouting: Pick<TargetRoutingApi, "discover">
}

// What the stamping lookups share: one snapshot of the live panes and registry for the whole batch.
interface HistoryScope {
  topicRouting: InboundHistoryDeps["topicRouting"]
  registry: Registry | null
  agentPanes: PaneInfo[]
}

// ONLY the kinds that actually reply-route (updates.ts): a text reply
// whose body is NOT a /command (a /command reply runs verbatim in the
// default auto-bind pane, never reply-route). A `!shell` reply DOES
// reply-route to its origin pane (codex #192) — it keeps its raw text but
// is delivered to the recognized pane, so it must be stamped there too,
// matching the prose/photo/voice cases. Also a photo/document reply after
// download, or a voice/audio reply after transcription.
export function isRoutedReply(m: TgMessage): boolean {
  return (
    (m.text !== undefined && !m.text.startsWith("/")) ||
    (m.photo !== undefined && !isAgentCommand(m.caption ?? "")) ||
    (m.document !== undefined && !isAgentCommand(m.caption ?? "")) ||
    m.voice !== undefined ||
    m.audio !== undefined
  )
}

// Mirror handleReplyRoute's recognized-but-unconfirmed guard (HISTORY
// STAMP ONLY — this is the scoped-recall pane, NEVER an inject
// target). When the origin pane is NOT visible (`!pane` — the launchd
// empty/partial flake), the reply still BELONGS to its recognized origin
// (the picker routes it there), so stamp it under the origin pane, NOT
// the default discovered target (the registration's last-writer = the
// WRONG pane). A genuinely reused/different-project VISIBLE pane (present
// but failed the same-project/agent check) falls back to
// the default. The two recognized-but-unconfirmed paths intentionally
// diverge: handleReplyRoute posts the picker (delivery), this stamps the
// origin pane (attribution) — neither ever injects into an unconfirmed pane.
export function stampPaneForRecognizedReply(originPaneId: string, paneVisible: boolean, confirmed: boolean): string | null {
  if (confirmed) return originPaneId
  return paneVisible ? null : originPaneId
}

// Pane stamping must match where the message ACTUALLY routes, else a reply
// (which routes to its recognized ORIGIN pane, not the default target) would
// be logged under the wrong pane and vanish from that pane's scoped recall.
// Mirrors handleReplyRoute's recognition: a reply whose replied-to id is in the
// routes map AND still maps to a live same-project agent pane is stamped with that pane.
function resolveReplyPane(histRoutes: Route[], m: TgMessage): string | null {
  const replyId = m.reply_to_message?.message_id
  if (replyId === undefined) return null
  if (!isRoutedReply(m)) return null
  const recognized = recognizeRoute(histRoutes, replyId)
  if (!recognized) return null
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === recognized.paneId)
  const sameProject = routeMatchesPane({ recognizedCwd: recognized.cwd, panePath: pane?.panePath })
  const confirmed = pane !== undefined && sameProject && Boolean(findAgentInPane(pane, procs))
  return stampPaneForRecognizedReply(recognized.paneId, pane !== undefined, confirmed)
}

function resolveSessionOf(scope: HistoryScope, pane: string | null): string | null {
  return pane !== null && scope.registry ? resolveLocatorToSession(scope.registry, pane, undefined) : null
}

function resolveAgentOf(scope: HistoryScope, pane: string | null): string | null {
  if (pane === null) return null
  const p = scope.agentPanes.find((x) => x.paneId === pane)
  if (p) return resolveSessionName({ tmuxWindow: p.windowName, cwd: p.panePath }).primary || null
  const key = resolveSessionOf(scope, pane)
  return scope.registry?.sessions.find((e) => e.key === key)?.name.primary || null
}

// A message inside a forum topic belongs to the topic's session — the one `topic-route`
// delivers it to (tg-cli#551): the registry owner, else the session on the pane a
// pre-registry binding names. A gone owner keeps its key but has no pane to stamp (the
// `%N` may host a stranger now); a topic nobody owns stamps nothing.
function resolveTopicOf(scope: HistoryScope, threadId: number): TopicSession | null {
  const owner = scope.topicRouting.topicOwner(threadId)
  if (owner) {
    return {
      pane: owner.state === "live" ? paneLocatorOf(owner) : null,
      agent: owner.name.primary || null,
      sessionKey: owner.key,
    }
  }
  const binding = findTopic(scope.topicRouting.loadTopics(), threadId)
  if (binding?.status !== "bound" || !binding.paneId) return null
  // The binding's own cwd must match, exactly as resolveTopicSession requires: a pane id is reused freely.
  const key = scope.registry ? resolveLocatorToSession(scope.registry, binding.paneId, binding.path) : null
  return { pane: binding.paneId, agent: resolveAgentOf(scope, binding.paneId), sessionKey: key }
}

// How the replies of THIS batch that answer a message another machine sent are attributed (hub mode
// only; null otherwise, so a plain machine reads nothing extra). The row names the remote session —
// `<machine>/<pane>`, `<machine>/<name>`, `<machine>/<key>` — and never a local pane, which a
// same-numbered local `%3` would otherwise collide with (spec §5).
interface RemoteReplyScope {
  paneOf: (m: TgMessage) => string | null
  agentOf: (pane: string | null) => string | null
  sessionOf: (pane: string | null) => string | null
}

function remoteReplyScope(ctx: Ctx): RemoteReplyScope | null {
  if (hubMachines(ctx).length === 0) return null
  const store = parseRemoteRoutes(readFileOrNull(ctx.paths.remoteRoutes))
  const byPane = new Map<string, RemoteRouteEntry>()
  return {
    paneOf: (m) => {
      const replyId = m.reply_to_message?.message_id
      if (replyId === undefined || !isRoutedReply(m)) return null
      const hit = recognizeRemoteRoute(store, ctx.chatId, replyId)
      if (!hit) return null
      const pane = remotePaneLabel(hit.machine, hit.route)
      byPane.set(pane, hit)
      return pane
    },
    agentOf: (pane) => {
      const hit = pane === null ? undefined : byPane.get(pane)
      return hit ? `${hit.machine}/${hit.name.primary}` : null
    },
    sessionOf: (pane) => {
      const hit = pane === null ? undefined : byPane.get(pane)
      return hit?.route.sessionKey ? `${hit.machine}/${hit.route.sessionKey}` : null
    },
  }
}

// Persist inbound history for `tg replies` recall — every message the CTO
// sent in this batch. Best-effort, off the inject path: a read/write error
// here never blocks delivery. Stale + rejected senders are filtered the
// same way stepUpdates does (inboundHistoryRecords). Only called when the batch
// carried messages — an empty 50s long-poll skips the walk.
export function recordInboundHistory(d: InboundHistoryDeps, updates: TgUpdate[]): void {
  const { ctx } = d
  const found = d.targetRouting.discover()
  const targetPane = found.ok ? found.target.pane.paneId : null
  const histRoutes = parseRoutes(readFileOrNull(ctx.paths.routes))
  const remote = remoteReplyScope(ctx)
  // One snapshot for the whole batch (the resolveSessionName primary over the live panes — the
  // SAME derivation the reader uses for its own pane); a pane that's gone (or none) → null →
  // untagged. The registry session the pane (or `omp:<pid>` origin) hosts is stamped
  // too (§3.3): the identity `tg replies` scopes on across renames, and the
  // name of an out-of-tmux omp, which has no pane to derive one from.
  const scope: HistoryScope = { topicRouting: d.topicRouting, agentPanes: snapshot().panes, registry: sessionRegistry }
  appendHistory(
    ctx.paths.history,
    inboundHistoryRecords(updates, {
      chatId: ctx.chatId,
      allowedSenders: ctx.cfg.allowedSenders,
      pane: targetPane,
      nowSec: Math.floor(Date.now() / 1000),
      stalenessSec: ctx.cfg.stalenessSec,
      resolvePane: (m) => resolveReplyPane(histRoutes, m) ?? remote?.paneOf(m) ?? null,
      resolveAgent: (pane) => remote?.agentOf(pane) ?? resolveAgentOf(scope, pane),
      resolveSession: (pane) => remote?.sessionOf(pane) ?? resolveSessionOf(scope, pane),
      ...(ctx.cfg.topics || ctx.cfg.privateTopics ? { resolveTopic: (threadId: number) => resolveTopicOf(scope, threadId) } : {}),
    }),
  )
}
