// daemon-runtime/agent-routes-command: the `/agent` command route and the picker-tap callback.
// Extracted from createAgentRoutes (guardian-817): each step is a named function taking the shared
// `AgentRouteEnv`; the decision logic that needs no I/O (which tap is valid, which reaction a delivered
// tap earns) is exported as pure functions.
import { matchWindows, goneAgentFallbackReplyText, suggestSelector, type AgentCandidate, type MatchResult } from "../agent-match"
import { wrapInbound } from "../inject"
import type { Action } from "../types"
import { log } from "./ctx-io"
import { answerCallbackQuery, editMessageText, sendMessage } from "./telegram-api"
import { listAgentCandidates, noAgentReplyNow } from "./pane-discovery"
import type { AgentRouteEnv } from "./agent-routes-env"
import type { PaneInjectOutcome } from "./inbound-inject-delivery"
import type { PendingAgentEntry } from "./daemon-types"

type AgentRouteAction = Extract<Action, { kind: "agent-route" }>
type AgentCallbackAction = Extract<Action, { kind: "agent-callback" }>

/** One `/agent` command being routed: the parsed action plus what every step needs. */
interface AgentRouteCall {
  action: AgentRouteAction
  candidates: AgentCandidate[]
  out: Record<string, unknown>
  msgPreview: string
}

// /agent routing (item 1): bare `/agent` → an inline-keyboard PICKER (tappable
// buttons, one distinct-labelled button per agent); confident phonetic match →
// direct inject; ambiguous → the same session-grouped picker carrying the pending
// message; named selector with NO match → error reply, never silent fallback.
export async function handleAgentRouteWith(env: AgentRouteEnv, action: AgentRouteAction): Promise<boolean> {
  const out = env.replyContext(action.threadId)
  env.cancelSelectedAgentRouteForAgentCommand()
  const candidates = listAgentCandidates()
  const msgPreview = action.all.slice(0, 60).replace(/\n/g, " ")
  const call: AgentRouteCall = { action, candidates, out, msgPreview }
  if (candidates.length === 0) return routeWithNoCandidates(env, call)
  if (!action.all.trim()) {
    // Bare `/agent`: tappable picker over EVERY live agent, including
    // out-of-tmux omp (paneId omp:<pid> → ACP). No outside-tmux notice.
    log(`agent-route: bare /agent → picker over ${candidates.length} candidates`)
    return env.postAgentPicker(candidates, "", null, { armNextMessage: true, messageExtra: out, threadId: action.threadId ?? null })
  }

  if (action.selector) return routeBySelector(env, call, action.selector)

  // No selector (bare `/agent <message>` with no agent name): route to single
  // candidate directly, or show picker when multiple are running.
  if (candidates.length === 1) return routeToSoleCandidate(env, call)

  log(`agent-route: no selector, ${candidates.length} candidates → picker msg="${msgPreview}"`)
  return env.postAgentPicker(candidates, action.all, action.messageId, { messageExtra: out, threadId: action.threadId ?? null })
}

// No live candidate: a selector may still name an agent running outside tmux; else the no-agent reply.
async function routeWithNoCandidates(env: AgentRouteEnv, { action, out, msgPreview }: AgentRouteCall): Promise<boolean> {
  if (action.selector && action.rest.trim()) {
    const wrapped = wrapInbound(env.ctx.cfg.injectWrap, action.from, action.rest, action.messageId)
    const routed = await env.tryRouteOutsideTmux(action.selector, wrapped, action.messageId, out)
    if (routed !== null) return routed
  } else if (action.selector && (await env.refuseOutsideTmux(action.selector, out))) {
    return false
  }
  log(`agent-route: no candidates — selector=${action.selector || "(none)"} msg="${msgPreview}"`)
  await sendMessage(env.ctx, noAgentReplyNow(), out)
  return false
}

// `/agent <selector> …`: a matching candidate takes it (select-only, direct or via picker); a selector
// that matches nothing is reported, never silently routed to a random agent.
async function routeBySelector(env: AgentRouteEnv, call: AgentRouteCall, selector: string): Promise<boolean> {
  const { action, candidates, out } = call
  const m = matchWindows(selector, candidates)
  if (m.matches.length === 0) return routeToUnmatchedSelector(env, call, selector)
  if (!action.rest.trim()) return selectNamedAgent(env, call, selector, m)
  if (m.confident) return injectToConfidentMatch(env, call, selector, m.matches[0])
  // Ambiguous: multiple matches — show picker over matched subset
  const names = m.matches.map((c) => c.windowName).join(", ")
  log(`agent-route: selector="${selector}" → ambiguous (${m.matches.length} matches: ${names}) → picker`)
  return env.postAgentPicker(m.matches, action.rest, action.messageId, { messageExtra: out, threadId: action.threadId ?? null })
}

// `/agent <name>` with NO message: SELECT that agent as the routing
// target for the next ordinary message (repair of #158 — a named
// selection used to only print a hint and never arm a route). A
// confident single match arms directly; an ambiguous match shows the
// same select-only picker bare `/agent` uses (a tap arms the route).
//
// The one-shot route is a FLAT-CHAT concept: injectIntoSelectedAgent is
// only consulted on flat inject-text / media, never on a topic-route.
// A topic-originated `/agent <name>` (threadId set) therefore keeps the
// plain hint — arming a global route there would only leak into a later
// flat message and mislead ("send the next message here", codex review).
async function selectNamedAgent(env: AgentRouteEnv, call: AgentRouteCall, selector: string, m: MatchResult): Promise<boolean> {
  const { action, candidates, out } = call
  if (action.threadId != null) {
    const names = m.matches.map((c) => c.windowName).join(", ")
    await sendMessage(env.ctx, `matched ${names} — add a message: /agent ${selector} <message>`, out)
    return true
  }
  if (m.confident) {
    const target = m.matches[0]
    const label = env.labelFor(target, candidates)
    log(`agent-route: selector="${selector}" → select-only arm ${target.paneId}/${target.windowName}`)
    const cardId = await sendMessage(env.ctx, `selected ${label}`, out)
    const routeToken = env.armSelectedAgentRoute(target, label, cardId, null)
    if (cardId !== null) {
      void editMessageText(env.ctx, cardId, `selected ${label} — send the next message here`, env.selectedAgentCancelMarkup(routeToken))
    }
    return true
  }
  log(`agent-route: selector="${selector}" → ambiguous select-only picker over ${m.matches.length} matches`)
  return env.postAgentPicker(m.matches, "", action.messageId, { armNextMessage: true, messageExtra: out })
}

// `/agent <name> <msg>` with one confident match: inject straight into that pane.
async function injectToConfidentMatch(env: AgentRouteEnv, call: AgentRouteCall, selector: string, target: AgentCandidate): Promise<boolean> {
  const { action, candidates, out, msgPreview } = call
  log(`agent-route: selector="${selector}" → ${target.paneId}/${target.windowName} confident=true msg="${msgPreview}"`)
  const res = await env.injectToPane(target.paneId, action.from, action.rest, action.messageId, true)
  if (!res.ok) {
    log(`agent-route: inject failed → ${target.paneId}: ${res.error}`)
    await sendMessage(env.ctx, res.error ?? "inject failed", out)
    return false
  }
  // A named `/agent <name> <msg>` is the CTO explicitly addressing this
  // pane — record it as the tg-cli#78 anchor (review finding: `/agent`
  // routing previously never updated it, unlike the ambiguous picker).
  env.recordLastUserTarget(target.paneId, target.panePath)
  if (target.paneId.startsWith("omp:")) {
    await sendMessage(env.ctx, env.routedReply(env.labelFor(target, candidates), res.deferred), out)
  }
  return true
}

// Named selector matched NOTHING — never silently fall back to a random agent.
// Report the miss clearly so the user knows their intent was not routed.
async function routeToUnmatchedSelector(env: AgentRouteEnv, call: AgentRouteCall, selector: string): Promise<boolean> {
  const { action, candidates, out } = call
  if (action.rest.trim()) {
    const wrapped = wrapInbound(env.ctx.cfg.injectWrap, action.from, action.rest, action.messageId)
    const routed = await env.tryRouteOutsideTmux(selector, wrapped, action.messageId, out)
    if (routed !== null) return routed
    const viaAnchor = await routeToGoneAgentAnchor(env, call, selector)
    if (viaAnchor !== null) return viaAnchor
  } else if (await env.refuseOutsideTmux(selector, out)) {
    return false
  }
  const names = candidates.map((c) => c.windowName).join(", ")
  log(`agent-route: selector="${selector}" → NO match among [${names}] — reporting error`)
  await sendMessage(env.ctx, `no agent matching '${selector}' (running: ${names}) — try /agent to pick`, out)
  return false
}

// The named target is not live ANYWHERE tg-ctl can see — see agent-match.ts's
// "gone-agent (dead subagent) fallback" comment for the full rationale. FLAT
// chat only: a bound topic already carries its own stronger routing signal (the
// topic's bound pane), so this flat last-user-target anchor — which may point at
// a DIFFERENT project's pane entirely — must not override it, matching
// selectNamedAgent's "topic-originated /agent keeps the plain hint" precedent.
// null: no anchor to fall back to (the caller keeps its "no agent matching" error).
async function routeToGoneAgentAnchor(env: AgentRouteEnv, { action, candidates, out }: AgentRouteCall, selector: string): Promise<boolean | null> {
  const found = env.resolveGoneAgentAnchor("agent-route", selector, candidates, action.threadId == null)
  if (!found) return null
  const { anchor, label } = found
  const res = await env.injectToPane(anchor.paneId, action.from, action.rest, action.messageId, true)
  if (!res.ok) {
    await sendMessage(env.ctx, res.error ?? "inject failed", out)
    return false
  }
  env.recordLastUserTarget(anchor.paneId, anchor.panePath)
  await sendMessage(env.ctx, goneAgentFallbackReplyText(selector, label, res.deferred), out)
  return true
}

// Bare `/agent <message>` with exactly one live candidate.
async function routeToSoleCandidate(env: AgentRouteEnv, { action, candidates, out, msgPreview }: AgentRouteCall): Promise<boolean> {
  const target = candidates[0]
  log(`agent-route: no selector, single candidate → ${target.paneId}/${target.windowName} msg="${msgPreview}"`)
  const res = await env.injectToPane(target.paneId, action.from, action.all, action.messageId, true)
  if (!res.ok) {
    await sendMessage(env.ctx, res.error ?? "inject failed", out)
    return false
  }
  // A bare `/agent <message>` with a single live candidate is still a
  // confirmed CTO-explicit delivery — record it as the tg-cli#78 anchor
  // (review finding: this was one of two remaining gaps where a successful
  // delivery never updated the anchor, leaving it stale once a second pane
  // later appears).
  env.recordLastUserTarget(target.paneId, target.panePath)
  await sendMessage(env.ctx, env.routedReply(env.labelFor(target, candidates), res.deferred), out)
  return true
}

/**
 * The pending picker entry and the chosen candidate for a tap, or null when the tap is stale.
 * A tap must come from THIS prompt's Telegram message. After a restart
 * agentTokenSeq reuses tokens (a1, a2…), so a tap on an OLD prompt that
 * reused the token must not consume the new pending route (codex P2).
 */
export function resolveAgentTap(
  pending: PendingAgentEntry | undefined,
  tap: { messageId: number | null; index: number },
): { pending: PendingAgentEntry; target: AgentCandidate } | null {
  if (!pending) return null
  if (pending.messageId !== null && tap.messageId !== null && tap.messageId !== pending.messageId) return null
  const target = pending.candidates[tap.index]
  return target ? { pending, target } : null
}

/** The reaction a delivered picker tap earns on its source message: a queued-behind-a-question ✍️, a 👀, or none. */
export type PickerTapReaction = { kind: "defer"; messageId: number } | { kind: "seen" } | { kind: "none" }

export function pickerTapReaction(res: PaneInjectOutcome, sourceMessageId: number | null): PickerTapReaction {
  const deferredState = res.deferredItem?.state ?? "queued"
  if (res.deferred && sourceMessageId !== null && deferredState !== "delivered") {
    return deferredState === "queued" ? { kind: "defer", messageId: sourceMessageId } : { kind: "none" }
  }
  return res.ok ? { kind: "seen" } : { kind: "none" }
}

export async function handleAgentCallbackWith(env: AgentRouteEnv, action: AgentCallbackAction): Promise<boolean> {
  const tap = resolveAgentTap(env.pendingAgent.get(action.token), action)
  if (!tap) {
    await answerCallbackQuery(env.ctx, action.callbackQueryId, "expired")
    return true
  }
  const { pending, target } = tap
  env.pendingAgent.delete(action.token)
  clearTimeout(pending.timer)
  // Select-only picker: bare `/agent` arms a one-shot target for the next
  // ordinary inbound message; control pickers only return the selector hint.
  if (pending.selectOnly) return answerSelectOnlyTap(env, action, pending, target)
  const res = await deliverPickedMessage(env, action, pending, target)
  // An explicit picker tap is the CTO deliberately choosing this pane — record
  // it as the tg-cli#78 anchor on any confirmed outcome (delivered or queued),
  // never on a failed inject (codex/Opus review finding: explicit routing
  // previously never updated the anchor, leaving an ambiguous fleet asking
  // forever after the very first pick). Every `res` construction above already
  // sets `ok: true` for a deferred outcome too, so `res.ok` alone covers both
  // today — `res.deferred` is included explicitly anyway (Opus review finding)
  // so this stays correct even if a future refactor ever decouples the two.
  if (res.ok || res.deferred) env.recordLastUserTarget(target.paneId, target.panePath)
  await reactToPickerTap(env, pending, res)
  await answerCallbackQuery(env.ctx, action.callbackQueryId, res.ok ? (res.deferred ? "queued" : "sent") : "failed")
  if (pending.messageId !== null) {
    void editMessageText(
      env.ctx,
      pending.messageId,
      res.ok ? env.routedReply(env.labelFor(target, pending.candidates), res.deferred) : `inject failed: ${res.error ?? ""}`,
    )
  }
  return res.ok
}

// A tap on a select-only picker: confirm it, then arm the next-message route or hand back the selector.
async function answerSelectOnlyTap(env: AgentRouteEnv, action: AgentCallbackAction, pending: PendingAgentEntry, target: AgentCandidate): Promise<boolean> {
  await answerCallbackQuery(env.ctx, action.callbackQueryId, "selected")
  if (pending.messageId === null) return true
  // Build selector/label against the full live fleet, not only the button
  // subset, so a suggested selector can never confidently route elsewhere.
  const live = listAgentCandidates()
  const fleet = live.some((c) => c.paneId === target.paneId) ? live : pending.candidates
  const liveTarget = fleet.find((c) => c.paneId === target.paneId) ?? target
  const label = env.labelFor(liveTarget, fleet)
  if (pending.armNextMessage) {
    const token = env.armSelectedAgentRoute(liveTarget, label, pending.messageId, pending.threadId ?? null)
    void editMessageText(env.ctx, pending.messageId, `selected ${label} — send the next message here`, env.selectedAgentCancelMarkup(token))
  } else {
    const selector = suggestSelector(liveTarget, fleet)
    void editMessageText(env.ctx, pending.messageId, `selected ${label} — send: /agent ${selector} <message>`)
  }
  return true
}

// A reply's pending text already carries its wrap/anchor → inject verbatim;
// a /agent message is raw → wrap it. Both defer behind an open question.
async function deliverPickedMessage(
  env: AgentRouteEnv,
  action: AgentCallbackAction,
  pending: PendingAgentEntry,
  target: AgentCandidate,
): Promise<PaneInjectOutcome> {
  if (!pending.prewrapped) return env.injectToPane(target.paneId, action.from, pending.message, pending.sourceMessageId)
  if (!target.paneId.startsWith("omp:") && env.shouldDeferInbound(target.paneId)) {
    const item = env.enqueueDeferred(target.paneId, pending.message, pending.sourceMessageId, pending.relatedReactionMessageId)
    return { ok: true, deferred: true, deferredItem: item }
  }
  const ok = await env.injectPrewrappedToPane(target.paneId, pending.message, pending.sourceMessageId, target.panePath ?? "/")
  return ok ? { ok: true } : { ok: false, error: "inject failed" }
}

// The callback has no trailing ack, so it updates the source reaction directly.
async function reactToPickerTap(env: AgentRouteEnv, pending: PendingAgentEntry, res: PaneInjectOutcome): Promise<void> {
  const reaction = pickerTapReaction(res, pending.sourceMessageId)
  if (reaction.kind === "defer") await env.setReaction(reaction.messageId, env.DEFER_REACTION)
  else if (reaction.kind === "seen") await env.setSeenReactions(pending.sourceMessageId, pending.relatedReactionMessageId)
}
