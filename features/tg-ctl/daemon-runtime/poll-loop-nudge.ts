// daemon-runtime/poll-loop-nudge: the per-iteration awareness nudge sweep of the poll loop.
// Split out of poll-loop.ts (guardian-817): a nudge goes only to a verified original omp process.
import { liveOmpPaneId, type LiveOmpAgent } from "../omp"
import { sessionKey } from "../session-registry"
import { AWARENESS_NUDGE_TEXT, lastTgSentAtByKey, markAwarenessNudgeSent, planAwarenessNudges, type AwarenessNudgeStore } from "../tg-awareness-nudge"
import { parseHistory } from "../../replies/history"
import { log, readFileOrNull } from "./ctx-io"
import { deliverOriginalOmp } from "./delivery"
import { listLiveOmpAgents, originalHosts } from "./session-registry"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { AutoContinueApi } from "./auto-continue"

export type NudgeDeps = {
  ctx: Ctx
  state: DaemonState
  autoContinue: Pick<AutoContinueApi, "persistAwarenessNudge">
}

export interface NudgeInputs {
  agentByKey: Map<string, LiveOmpAgent>
  keys: string[]
  sessionIdByKey: Map<string, LiveOmpAgent["sessionId"]>
  sentAtByKey: Map<string, number>
  store: AwarenessNudgeStore
}

export const locatorOf = (a: LiveOmpAgent): string => a.paneId ?? liveOmpPaneId(a.pid)

export const nudgeKeyOf = (a: LiveOmpAgent): string => (a.sessionId ? sessionKey("omp", a.sessionId) : locatorOf(a))

// A pre-#459 row keyed by the locator for this same session carries
// over, so the cutover does not restart its silence clock.
export function carryOverLegacyRow(store: AwarenessNudgeStore, key: string, locator: string, sessionId: LiveOmpAgent["sessionId"]): AwarenessNudgeStore {
  const legacy = store[locator]
  if (key !== locator && !store[key] && legacy?.sessionId === sessionId) return { ...store, [key]: legacy }
  return store
}

// Nudge state is keyed by the session (`omp:<sessionId>`) when omp has
// published one, so a `--resume` into another pane keeps its silence
// clock and nudge marker (#459). History rows only carry the pane/pid
// locator, so the last-send time is read through the agent's locator.
export function collectNudgeInputs(agents: readonly LiveOmpAgent[], sentAtByLocator: ReadonlyMap<string, number>, store: AwarenessNudgeStore): NudgeInputs {
  const agentByKey = new Map(agents.map((a) => [nudgeKeyOf(a), a]))
  const sentAtByKey = new Map<string, number>()
  let carried = store
  for (const [key, a] of agentByKey) {
    const locator = locatorOf(a)
    const sentAt = sentAtByLocator.get(locator)
    if (sentAt !== undefined) sentAtByKey.set(key, sentAt)
    carried = carryOverLegacyRow(carried, key, locator, a.sessionId)
  }
  return {
    agentByKey,
    keys: [...agentByKey.keys()],
    sessionIdByKey: new Map([...agentByKey].map(([key, a]) => [key, a.sessionId])),
    sentAtByKey,
    store: carried,
  }
}

// The keys whose nudge was actually delivered.
async function deliverDueNudges(due: readonly string[], agentByKey: ReadonlyMap<string, LiveOmpAgent>): Promise<string[]> {
  const sentKeys: string[] = []
  for (const key of due) {
    const target = agentByKey.get(key)
    if (!target) continue
    const res = await deliverOriginalOmp(target, AWARENESS_NUDGE_TEXT, `awareness:${target.pid}:${target.sessionId}:${Math.floor(Date.now() / 3_600_000)}`)
    log(res.ok ? `awareness-nudge sent to ${key}` : `awareness-nudge failed for ${key}: ${res.error}`)
    if (res.ok) sentKeys.push(key)
  }
  return sentKeys
}

// Remind only verified original processes. Never spawn an anonymous agent
// because a TUI has not published its bridge or its session identity is unknown.
export async function runAwarenessNudges(d: NudgeDeps): Promise<void> {
  const { ctx, state } = d
  const liveOmpAgentsForNudge = listLiveOmpAgents().filter((a) => originalHosts.some((h) => h.pid === a.pid))
  if (liveOmpAgentsForNudge.length === 0 && Object.keys(state.awarenessNudgeStore).length === 0) return
  const sentAtByLocator = lastTgSentAtByKey(parseHistory(readFileOrNull(ctx.paths.history)))
  const inputs = collectNudgeInputs(liveOmpAgentsForNudge, sentAtByLocator, state.awarenessNudgeStore)
  state.awarenessNudgeStore = inputs.store
  const nudgePlan = planAwarenessNudges(inputs.keys, inputs.sentAtByKey, state.awarenessNudgeStore, Date.now(), inputs.sessionIdByKey)
  state.awarenessNudgeStore = nudgePlan.store
  if (nudgePlan.keysChanged) d.autoContinue.persistAwarenessNudge()
  // Only a send that actually SUCCEEDS commits the "nudged" marker
  // (via markAwarenessNudgeSent, below) — a due key stays due next
  // sweep on failure/drop instead of silently losing its one shot at
  // reaching the exact busy/loaded agent this feature targets.
  const sentKeys = await deliverDueNudges(nudgePlan.due, inputs.agentByKey)
  if (sentKeys.length > 0) {
    state.awarenessNudgeStore = markAwarenessNudgeSent(state.awarenessNudgeStore, sentKeys, Date.now())
    d.autoContinue.persistAwarenessNudge()
  }
}
