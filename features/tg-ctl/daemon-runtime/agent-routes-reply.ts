// daemon-runtime/agent-routes-reply: routing a Telegram reply to the agent that sent the replied-to message.
// Extracted from createAgentRoutes.handleReplyRoute (guardian-817): each way a reply can be delivered
// (live omp, rig-wrapper host, session registry, recognized tmux pane, the picker) is a named step
// taking the shared `AgentRouteEnv` plus the per-reply `ReplyCall`.
import { buildAgentSelectMessage, type AgentCandidate } from "../agent-match"
import { findAgentInPane } from "../discover"
import { buildTextInjectPlan } from "../inject"
import { liveOmpPaneId, matchLiveOmpOrigin, lineageParentCandidate, ompReplyOriginMatches } from "../omp"
import { hostNameFromOriginId } from "../host-registry"
import { goneRouteSession, resolveRouteSession, sessionDeliveryTarget } from "../session-target"
import { aggregateUsage, orderByLruMru, parseRoutes, recognizeRoute, routeMatchesPane, type Route } from "../routes"
import type { Registry } from "../session-registry"
import type { Action } from "../types"
import { log, readFileOrNull } from "./ctx-io"
import { deliverHostPane, deliverOriginalOmp, injectInbound, listLiveHosts } from "./delivery"
import { sendMessage } from "./telegram-api"
import { listLiveOmpAgents, refreshOriginalHosts, refreshSessionRegistry } from "./session-registry"
import { listAgentCandidates, noAgentReplyNow } from "./pane-discovery"
import { snapshot } from "./tmux-probe"
import type { AgentRouteEnv } from "./agent-routes-env"

type ReplyRouteAction = Extract<Action, { kind: "reply-route" }>
type LiveOmp = NonNullable<ReturnType<typeof matchLiveOmpOrigin>>

/** One reply being routed: the action plus everything resolved once up front. */
interface ReplyCall {
  action: ReplyRouteAction
  relatedReactionMessageId: number | null
  routes: Route[]
  // The origin the replied-to message was recorded against; null when the reply's origin is unknown.
  recognized: Route | null
  // A reply handed over from a gone session's topic (tg-cli#709) is answered in that topic.
  out: Record<string, unknown>
  msgPreview: string
}

/**
 * A human label for the GONE origin agent of a recognized reply — the project dir (cwd
 * basename) it was recorded against, else its pane id. Used in the picker notice so the CTO
 * sees WHICH agent vanished, not just "an agent".
 */
export function goneOriginLabel(recognized: Pick<Route, "cwd" | "paneId"> | null): string {
  const cwd = recognized?.cwd
  if (cwd) {
    const base = cwd.replace(/\/+$/, "").split("/").pop()
    if (base) return base
  }
  return recognized?.paneId ?? "the agent you replied to"
}

/** The picker's gone-target line for the agent called `name`. */
export function goneNotice(name: string): string {
  return `That agent (${name}) is no longer running — pick a live one:`
}

// A reply: route to the recognized origin pane (routes map) or, when unknown,
// a session-grouped picker ordered LRU/MRU. injectText is injected verbatim
// everywhere here — for a prose reply it already carries the wrap + quote
// anchor; for a `!shell` reply it is the RAW `!…` text (codex #192), so `!`
// stays at column 0 for the harness passthrough.
export async function handleReplyRouteWith(
  env: AgentRouteEnv,
  action: ReplyRouteAction,
  relatedReactionMessageId: number | null = null,
): Promise<boolean> {
  const routes = parseRoutes(readFileOrNull(env.ctx.paths.routes))
  const recognized = recognizeRoute(routes, action.replyToMessageId)
  const out = env.replyContext(action.threadId)
  const msgPreview = action.injectText.slice(0, 60).replace(/\n/g, " ")
  const call: ReplyCall = { action, relatedReactionMessageId, routes, recognized, out, msgPreview }
  if (recognized) {
    const routed = await routeRecognizedReply(env, call, recognized)
    if (routed !== null) return routed
  }
  return routeToLiveCandidates(env, call)
}

// A reply whose origin is known: deliver to wherever that origin lives now. null: it could not be
// confirmed as a same-project agent (reused/gone pane) — the caller falls through to the picker.
async function routeRecognizedReply(env: AgentRouteEnv, call: ReplyCall, recognized: Route): Promise<boolean | null> {
  const bySession = await routeReplyBySession(env, call, recognized)
  if (bySession !== null) return bySession
  const viaOmp = await routeReplyToLiveOmpOrigin(env, call, recognized)
  if (viaOmp !== null) return viaOmp
  return routeReplyToOriginPane(env, call, recognized)
}

// Session-keyed reply (spec §2.4–§2.5, tg-cli#459): the reply follows the
// SESSION that sent the replied-to message to wherever it lives now — a
// resumed omp keeps its key under a new pid, a moved one under a new pane —
// re-read by a fresh scan. It never falls back to a same-project guess: a gone
// session (or a legacy row the migration could not resolve) goes to
// replyToGoneOrigin. null: the route carries no session identity at all
// (an untracked harness, a pre-registry `tg`) — the pane path below decides.
async function routeReplyBySession(env: AgentRouteEnv, call: ReplyCall, route: Route): Promise<boolean | null> {
  if (route.legacySince !== undefined) return replyToGoneOrigin(env, call, route, goneOriginLabel(call.recognized), `legacy route ${route.paneId}`)
  // A session a rig wrapper hosts outside tmux: its route origin IS `host:<name>`. The host
  // is re-verified by deliverToHost; a gone one gets the picker, never a same-project guess.
  const originHost = hostNameFromOriginId(route.paneId)
  if (originHost !== null) return routeReplyToHostOrigin(env, call, route, originHost)
  const exactOrigin = route.agentPid !== undefined || route.serverPid !== undefined || route.paneId.startsWith("omp:")
  if (route.sessionKey === undefined && !exactOrigin) return null
  // A resumed omp's new process publishes a new endpoint; pick it up before
  // the scan so an out-of-tmux delivery can reach it.
  await refreshOriginalHosts()
  const reg = refreshSessionRegistry()
  if (!reg) return null
  return routeReplyViaRegistry(env, call, route, reg)
}

async function routeReplyToHostOrigin(env: AgentRouteEnv, call: ReplyCall, route: Route, originHost: string): Promise<boolean> {
  const host = listLiveHosts(snapshot().procs).find((h) => h.name === originHost)
  if (!host) return replyToGoneOrigin(env, call, route, goneOriginLabel(call.recognized), `host ${originHost} gone`)
  log(`reply-route: replyTo=${call.action.replyToMessageId} → ${route.paneId} (abduco PTY) msg="${call.msgPreview}"`)
  const delivered = await injectReplyVerbatim(env, call, route.paneId)
  if (delivered) env.recordLastUserTarget(route.paneId, host.cwd ?? route.cwd)
  return delivered
}

// The session registry resolves the route to a session; deliver to wherever it lives now.
// null: the registry has no session for the route and none that left — the pane path decides.
async function routeReplyViaRegistry(env: AgentRouteEnv, call: ReplyCall, route: Route, reg: Registry): Promise<boolean | null> {
  const key = route.sessionKey ?? resolveRouteSession(reg, route)
  if (key === null) {
    // The origin's exact locators name a session that has since left: the
    // picker, never the same-project pane guess below.
    const gone = goneRouteSession(reg, route)
    if (gone) return replyToGoneOrigin(env, call, route, gone.name.primary, `origin session ${gone.key} gone`)
    return null
  }
  const target = sessionDeliveryTarget(reg, key)
  if (target.kind !== "live") {
    return replyToGoneOrigin(env, call, route, target.kind === "gone" ? target.name : goneOriginLabel(call.recognized), `session ${key} ${target.kind}`)
  }
  const paneId = target.paneId ?? (target.pid !== null ? liveOmpPaneId(target.pid) : null)
  if (paneId === null) return replyToGoneOrigin(env, call, route, target.name, `session ${key} has no locator`)
  log(`reply-route: replyTo=${call.action.replyToMessageId} → session ${key} at ${paneId} (sent from ${route.paneId}) msg="${call.msgPreview}"`)
  const delivered = await injectReplyVerbatim(env, call, paneId, key)
  if (delivered) env.recordLastUserTarget(paneId, target.cwd || undefined)
  return delivered
}

// `omp:<pid>` is the live process (pid identity). Do not require cwd match:
// tg often runs from /tmp while liveHit.cwd is the session dir (Codex P1 #340).
// null: the origin is not a live omp that owns this reply.
async function routeReplyToLiveOmpOrigin(env: AgentRouteEnv, call: ReplyCall, recognized: Route): Promise<boolean | null> {
  const liveHit = matchLiveOmpOrigin(recognized.paneId, listLiveOmpAgents())
  if (!liveHit || !ompReplyOriginMatches(recognized, liveHit)) return null
  log(`reply-route: replyTo=${call.action.replyToMessageId} → ${recognized.paneId} omp ACP pid=${liveHit.pid} msg="${call.msgPreview}"`)
  const delivered = await injectReplyVerbatim(env, call, recognized.paneId)
  if (delivered) env.recordLastUserTarget(recognized.paneId, liveHit.cwd ?? "/")
  return delivered
}

// The recognized origin as a tmux pane. null: the pane is visible but not a same-project agent.
async function routeReplyToOriginPane(env: AgentRouteEnv, call: ReplyCall, recognized: Route): Promise<boolean | null> {
  const { action, msgPreview } = call
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === recognized.paneId)
  // Route to the origin pane ONLY if it still hosts an agent AND is still the
  // SAME project: a tmux pane id is reused after kill-pane, so a stale
  // message_id→%N map could otherwise inject a reply into a DIFFERENT
  // project's agent — leaking project A's reply into project B (review
  // --brainstorm finding). routeMatchesPane validates the recorded send-path
  // (now the origin pane's path — see tg recordRoute) against the live pane's
  // path; on mismatch (or no recorded cwd for an old route) fall through to
  // the picker rather than risk mis-routing.
  const sameProject = routeMatchesPane({ recognizedCwd: recognized.cwd, panePath: pane?.panePath })
  if (pane && sameProject && findAgentInPane(pane, procs)) {
    log(`reply-route: replyTo=${action.replyToMessageId} → ${recognized.paneId} recognized=true sameProject=true msg="${msgPreview}"`)
    // A confirmed reply is the CTO explicitly addressing this pane — the
    // clearest possible signal for the tg-cli#78 anchor. Recorded only once
    // injectVerbatim confirms delivery (queued-deferred or actually injected),
    // never on a failed inject (codex/Opus review finding).
    const delivered = await injectReplyVerbatim(env, call, recognized.paneId)
    if (delivered) env.recordLastUserTarget(recognized.paneId, pane.panePath)
    return delivered
  }

  // We KNOW the origin pane but the snapshot can't CONFIRM it. snapshot()
  // already retried the transient empty/partial `tmux list-panes` read
  // (panesWithRetry); if it STILL can't see the recognized pane there are two
  // shapes — and the launchd no-locale flake (`no-agent reply: panes=0`) makes
  // a zero/partial snapshot a real, recurring runtime state, not a one-off:
  //   (a) the snapshot returned ZERO/partial panes — origin almost certainly
  //       still alive, just invisible. The OLD code fell through and, when the
  //       partial snapshot left exactly ONE agent visible (deterministically
  //       the last writer of the single global registration slot — [rig]/%2),
  //       silently injected the recognized reply into THAT wrong agent. A
  //       recognized reply must NEVER lose to whatever single agent is visible.
  //   (b) the origin pane is genuinely gone/reused/different-project — the
  //       legitimate fall-through to the picker (04cb6e5).
  // Tell them apart by whether the origin pane appears in the snapshot AT ALL
  // (`pane` IS that lookup — undefined ⇔ not visible). When it is NOT visible,
  // post the PICKER (human disambiguates) instead of the single-candidate
  // auto-inject — never the registration's last-writer pane.
  if (!pane) {
    // DEAD SENDER: the origin was a disposable/one-shot sender — a subagent
    // process (or a synthetic omp:<pid> from a headless script, tg-cli#363)
    // that sent once and exited, so its pane/pid will NEVER become visible
    // again. Only its recorded lineage parent may take the reply. A live
    // agent that merely shares the recorded cwd is NOT its parent: the old
    // exact-cwd guess (#423) typed replies into unrelated sessions sharing
    // /tmp or a repository root (#503).
    return replyToGoneOrigin(env, call, recognized, goneOriginLabel(recognized), `origin ${recognized.paneId} NOT visible in snapshot`)
  }
  // origin pane visible but not a same-project agent → genuinely reused/gone;
  // fall through to the normal picker path (with the gone notice).
  log(`reply-route: replyTo=${action.replyToMessageId} → origin ${recognized.paneId} visible but sameProject=${sameProject} hasAgent=${!!findAgentInPane(pane, procs)} → picker (gone/reused)`)
  return null
}

// No origin could take the reply (unknown, or recognized but reused/gone): the only live agent when
// the reply is unrecognized, else the LRU/MRU picker.
async function routeToLiveCandidates(env: AgentRouteEnv, call: ReplyCall): Promise<boolean> {
  const { action, recognized, out, msgPreview } = call
  const candidates = listAgentCandidates()
  if (candidates.length === 0) {
    log(`reply-route: replyTo=${action.replyToMessageId} → no candidates recognized=${!!recognized}`)
    await sendMessage(env.ctx, noAgentReplyNow(), out)
    return false
  }
  // An UNRECOGNIZED reply (no origin known) with a single agent is unambiguous —
  // inject there. The recognized-but-unconfirmed case above never reaches here. A reply
  // from a gone session's topic is not: its session is gone, so the human picks (tg-cli#709).
  if (!recognized && candidates.length === 1 && action.threadId === undefined) {
    log(`reply-route: replyTo=${action.replyToMessageId} → unrecognized, single candidate ${candidates[0].paneId}/${candidates[0].windowName} → inject msg="${msgPreview}"`)
    const delivered = await injectReplyVerbatim(env, call, candidates[0].paneId)
    // Still a confirmed CTO-explicit delivery — record it as the tg-cli#78
    // anchor (review finding: this was the other remaining gap where a
    // successful delivery never updated the anchor).
    if (delivered) env.recordLastUserTarget(candidates[0].paneId, candidates[0].panePath)
    return delivered
  }

  // Anything else — several agents, OR a recognized reply that fell through
  // (origin visible but reused/gone) — goes to the LRU/MRU-ordered picker. A
  // recognized reply that reached here KNEW an origin that's now gone (its pane
  // was reused by a different project), so it carries the gone notice; an
  // unrecognized reply never knew an origin, so no notice.
  log(`reply-route: replyTo=${action.replyToMessageId} → ${candidates.length} candidates recognized=${!!recognized} → picker`)
  return postReplyPicker(env, call, candidates, recognized ? goneNotice(goneOriginLabel(recognized)) : undefined)
}

// A reply whose origin is gone. It goes to the origin's recorded process-lineage
// parent (route.parentPaneId, #503) when that is live: a disposable nested omp
// that sent the replied-to message and exited hands the reply to the omp that
// started it. `tg` proved that lineage from the process tree at send time; a
// session that only shares the origin's cwd is never chosen (unrelated sessions
// share /tmp or a repo root). Otherwise the picker naming the agent they meant,
// so a terminated one reads as "that agent is gone" rather than a silent re-ask
// (CTO ask, #72) — or the no-agent reply when nothing is live.
async function replyToGoneOrigin(env: AgentRouteEnv, call: ReplyCall, route: Route, name: string, why: string): Promise<boolean> {
  const { action, out, msgPreview } = call
  const replyTo = action.replyToMessageId
  const candidates = listAgentCandidates()
  const parentId = route.parentPaneId
  const parent = parentId === undefined ? null : lineageParentCandidate(parentId, candidates, listLiveOmpAgents())
  if (parent) {
    log(`reply-route: replyTo=${replyTo} → ${why}, routing to lineage parent ${parent.paneId} msg="${msgPreview}"`)
    const delivered = await injectReplyVerbatim(env, call, parent.paneId)
    if (delivered) {
      if (parent.panePath) env.recordLastUserTarget(parent.paneId, parent.panePath)
      // Fire-and-forget, never delaying delivery: the reply did not land where
      // the CTO replied, so say where it went (#446).
      void sendMessage(env.ctx, `↩️ ${name} is gone — routed to ${env.labelFor(parent, candidates)}, the session that started it`, out)
    }
    return delivered
  }
  const lineage = parentId === undefined ? "" : `, lineage parent ${parentId} not live`
  log(`reply-route: replyTo=${replyTo} → ${why} → picker (${candidates.length} candidates${lineage})`)
  if (candidates.length > 0) return postReplyPicker(env, call, candidates, goneNotice(name))
  await sendMessage(env.ctx, noAgentReplyNow(), out)
  return false
}

// Post the LRU/MRU-ordered agent picker for this reply and arm its pending
// selection. Shared by the unrecognized-multi-agent case AND the
// recognized-but-unconfirmed origin case (a known origin we currently can't
// SEE must never auto-collapse onto the wrong agent — let the human pick).
// `notice` prepends a gone-target line ("That agent … is no longer running")
// when the reply's recorded origin pane is no longer a live, same-project agent.
async function postReplyPicker(env: AgentRouteEnv, call: ReplyCall, candidates: AgentCandidate[], notice?: string): Promise<boolean> {
  const { action, relatedReactionMessageId, routes, out } = call
  const usage = aggregateUsage(routes)
  const order = orderByLruMru(candidates.map((c) => c.paneId), usage)
  const byPane = new Map(candidates.map((c) => [c.paneId, c]))
  const sorted = order.map((pid) => byPane.get(pid)!).filter(Boolean)
  const token = `a${++env.state.agentTokenSeq}`
  // preserveOrder: keep the LRU/MRU ranking — groupBySession must not re-sort.
  const payload = buildAgentSelectMessage(env.ctx.chatId, sorted, token, action.injectText, true, notice)
  const messageId = await sendMessage(env.ctx, payload.text, { reply_markup: payload.reply_markup, ...out })
  if (messageId === null) {
    await sendMessage(env.ctx, "couldn't post the reply picker", out)
    return false
  }
  env.armPendingAgent(token, {
    message: action.injectText,
    candidates: sorted,
    messageId,
    sourceMessageId: action.messageId,
    relatedReactionMessageId,
    prewrapped: true,
  })
  env.queueAckReaction(action.messageId, env.DEFER_REACTION)
  return true
}

// Inject the reply text verbatim into `paneId` (a live omp, a rig-wrapper host or a tmux pane).
// `sessionKey`: the session this reply is for, when known — a deferred copy
// carries it, and the pane is re-verified to host it right before typing (§2.6).
async function injectReplyVerbatim(env: AgentRouteEnv, call: ReplyCall, paneId: string, sessionKey?: string): Promise<boolean> {
  const { action } = call
  const live = matchLiveOmpOrigin(paneId, listLiveOmpAgents())
  if (live) return injectReplyToLiveOmp(env, call, live, sessionKey)
  const hostDelivery = env.shouldDeferInbound(paneId) ? null : deliverHostPane(paneId, action.injectText, action.messageId)
  if (hostDelivery) return settleReplyDelivery(env, call, await hostDelivery)
  if (env.shouldDeferInbound(paneId)) {
    env.markDeferredForAck(env.enqueueDeferred(paneId, action.injectText, action.messageId, call.relatedReactionMessageId, sessionKey))
    return true
  }
  // The source message's own receipt is still handled by the trailing ack
  // action. This branch only adds the related replied-to message receipt.
  const res = await injectInbound(action.messageId, paneId, buildTextInjectPlan(paneId, action.injectText, { sessionKey }))
  return settleReplyDelivery(env, call, res)
}

async function injectReplyToLiveOmp(env: AgentRouteEnv, call: ReplyCall, live: LiveOmp, sessionKey: string | undefined): Promise<boolean> {
  const { action } = call
  // Same defer-while-waiting rule as every tmux pane: never type into an open question.
  if (live.paneId && env.shouldDeferInbound(live.paneId)) {
    env.markDeferredForAck(env.enqueueDeferred(live.paneId, action.injectText, action.messageId, call.relatedReactionMessageId, sessionKey))
    return true
  }
  const res = await deliverOriginalOmp(live, action.injectText, action.messageId, live.paneId)
  return settleReplyDelivery(env, call, res)
}

// A delivery sink's result: a failure is reported to the chat; a success adds the related replied-to receipt.
async function settleReplyDelivery(env: AgentRouteEnv, call: ReplyCall, res: { ok: true } | { ok: false; error: string }): Promise<boolean> {
  if (!res.ok) {
    await sendMessage(env.ctx, res.error)
    return false
  }
  await env.setSeenReactions(null, call.relatedReactionMessageId)
  return true
}
