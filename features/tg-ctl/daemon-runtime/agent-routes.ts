// daemon-runtime/agent-routes: /agent selection, agent callbacks and reply routing.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import type { Action } from "../types"
import { log } from "./ctx-io"
import { answerCallbackQuery, editMessageText, sendMessage } from "./telegram-api"
import { listAgentCandidates } from "./pane-discovery"
import { handleAgentCallbackWith, handleAgentRouteWith } from "./agent-routes-command"
import { handleReplyRouteWith } from "./agent-routes-reply"
import type { AgentRouteEnv } from "./agent-routes-env"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { PickerApi } from "./picker-state"
import type { TargetRoutingApi } from "./target-routing"
import type { InboundInjectApi } from "./inbound-inject"
import type { DeferQueueApi } from "./defer-queue"
import type { ReactionsApi } from "./ack-reactions"

export type AgentRoutesDeps = {
  ctx: Ctx
  state: DaemonState
  picker: PickerApi
  targetRouting: TargetRoutingApi
  inboundInject: InboundInjectApi
  deferQueue: DeferQueueApi
  reactions: ReactionsApi
}

export function createAgentRoutes(d: AgentRoutesDeps) {
  const { ctx, state } = d
  const { pendingAgent, armPendingAgent, cancelSelectedAgentRoute, cancelSelectedAgentRouteForAgentCommand, selectedAgentCancelMarkup } = d.picker
  const { recordLastUserTarget, withGitStateBanner, replyContext } = d.targetRouting
  const { injectToPane, routedReply, labelFor, resolveGoneAgentAnchor, armSelectedAgentRoute, postAgentPicker, injectPrewrappedToPane, refuseOutsideTmux, tryRouteOutsideTmux } = d.inboundInject
  const { shouldDeferInbound, enqueueDeferred, markDeferredForAck } = d.deferQueue
  const { queueAckReaction, setReaction, setSeenReactions, DEFER_REACTION } = d.reactions

  const injectIntoSelectedAgent = async (prewrappedText: string, sourceMessageId: number): Promise<boolean | null> => {
    const selected = cancelSelectedAgentRoute()
    if (!selected) return null
    const liveFleet = listAgentCandidates()
    const liveTarget = liveFleet.find((c) => c.paneId === selected.paneId)
    if (!liveTarget) {
      await sendMessage(ctx, `selected ${selected.label} is no longer running — routing this message normally`, replyContext(selected.threadId))
      if (selected.messageId !== null) void editMessageText(ctx, selected.messageId, `selected ${selected.label} — agent is no longer running`)
      return null
    }
    const label = labelFor(liveTarget, liveFleet)
    log(`agent-select: next message → ${liveTarget.paneId}/${liveTarget.windowName}`)
    if (!liveTarget.paneId.startsWith("omp:") && shouldDeferInbound(liveTarget.paneId)) {
      markDeferredForAck(enqueueDeferred(liveTarget.paneId, prewrappedText, sourceMessageId))
      if (selected.messageId !== null) void editMessageText(ctx, selected.messageId, routedReply(label, true))
      // An armed one-shot route is the CTO's own prior explicit choice — record
      // it as the tg-cli#78 anchor (review finding: `/agent`-driven routing
      // previously never updated it).
      recordLastUserTarget(liveTarget.paneId, liveTarget.panePath)
      return true
    }
    const text = withGitStateBanner(liveTarget.panePath, prewrappedText)
    const ok = await injectPrewrappedToPane(liveTarget.paneId, text, sourceMessageId, liveTarget.panePath ?? "/")
    if (!ok) {
      if (selected.messageId !== null) void editMessageText(ctx, selected.messageId, "inject failed")
      return false
    }
    if (selected.messageId !== null) void editMessageText(ctx, selected.messageId, routedReply(label, false))
    return true
  }

  const handleAgentCancelCallback = async (action: Extract<Action, { kind: "agent-cancel" }>): Promise<boolean> => {
    const selected = state.selectedAgentRoute
    if (
      !selected ||
      selected.token !== action.token ||
      (selected.messageId !== null && action.messageId !== null && selected.messageId !== action.messageId)
    ) {
      await answerCallbackQuery(ctx, action.callbackQueryId, "expired")
      return true
    }
    cancelSelectedAgentRoute()
    await answerCallbackQuery(ctx, action.callbackQueryId, "cancelled")
    if (selected.messageId !== null) void editMessageText(ctx, selected.messageId, `cancelled ${selected.label}`)
    return true
  }

  // The /agent command, picker taps and reply routing live in agent-routes-command.ts / agent-routes-reply.ts;
  // they receive the collaborators below through `env`.
  const env: AgentRouteEnv = {
    ctx,
    state,
    pendingAgent,
    armPendingAgent,
    cancelSelectedAgentRouteForAgentCommand,
    selectedAgentCancelMarkup,
    recordLastUserTarget,
    replyContext,
    injectToPane,
    routedReply,
    labelFor,
    resolveGoneAgentAnchor,
    armSelectedAgentRoute,
    postAgentPicker,
    injectPrewrappedToPane,
    refuseOutsideTmux,
    tryRouteOutsideTmux,
    shouldDeferInbound,
    enqueueDeferred,
    markDeferredForAck,
    queueAckReaction,
    setReaction,
    setSeenReactions,
    DEFER_REACTION,
  }
  const handleAgentRoute = handleAgentRouteWith.bind(null, env)
  const handleAgentCallback = handleAgentCallbackWith.bind(null, env)
  const handleReplyRoute = handleReplyRouteWith.bind(null, env)

  return { injectIntoSelectedAgent, handleAgentRoute, handleAgentCallback, handleAgentCancelCallback, handleReplyRoute }
}

export type AgentRoutesApi = ReturnType<typeof createAgentRoutes>
