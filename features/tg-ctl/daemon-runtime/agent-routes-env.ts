// daemon-runtime/agent-routes-env: the collaborators agent-routes' /agent, picker-tap and reply
// routing steps need from the other daemon parts. Built once by createAgentRoutes (guardian-817) and
// passed to the module-level step functions in agent-routes-command.ts / agent-routes-reply.ts.
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { PickerApi } from "./picker-state"
import type { TargetRoutingApi } from "./target-routing"
import type { InboundInjectApi } from "./inbound-inject"
import type { DeferQueueApi } from "./defer-queue"
import type { ReactionsApi } from "./ack-reactions"

export type AgentRouteEnv = {
  ctx: Ctx
  state: DaemonState
} & Pick<PickerApi, "pendingAgent" | "armPendingAgent" | "cancelSelectedAgentRouteForAgentCommand" | "selectedAgentCancelMarkup"> &
  Pick<TargetRoutingApi, "recordLastUserTarget" | "replyContext"> &
  Pick<
    InboundInjectApi,
    | "injectToPane"
    | "routedReply"
    | "labelFor"
    | "resolveGoneAgentAnchor"
    | "armSelectedAgentRoute"
    | "postAgentPicker"
    | "injectPrewrappedToPane"
    | "refuseOutsideTmux"
    | "tryRouteOutsideTmux"
  > &
  Pick<DeferQueueApi, "shouldDeferInbound" | "enqueueDeferred" | "markDeferredForAck"> &
  Pick<ReactionsApi, "queueAckReaction" | "setReaction" | "setSeenReactions" | "DEFER_REACTION">
