// daemon-runtime/daemon-types: types that were declared inside runDaemon's closure and are shared by several of its parts.
import { type AgentCandidate } from "../agent-match"

// /agent (and unrecognized-reply) selection awaiting a button tap: token →
// message + candidate list. `prewrapped` = inject the message verbatim (a reply
// already carries its wrap/anchor) instead of wrapping it again.
export type PendingAgentEntry = {
  message: string
  candidates: AgentCandidate[]
  messageId: number | null
  sourceMessageId: number | null
  relatedReactionMessageId: number | null
  timer: ReturnType<typeof setTimeout>
  prewrapped?: boolean
  // Select-only picker: there is no message on the button itself. Bare
  // `/agent` uses this to arm a one-shot route for the next ordinary inbound
  // message; control pickers (/stop, /kill) only hand back the selector.
  selectOnly?: boolean
  armNextMessage?: boolean
  threadId?: number | null
}

export type SelectedAgentRoute = {
  token: string
  paneId: string
  label: string
  messageId: number | null
  threadId: number | null
  timer: ReturnType<typeof setTimeout>
}

export type DeferredInbound = {
  text: string
  sourceMessageId: number | null
  relatedReactionMessageId: number | null
  // The session the pane hosted when this was queued (spec §2.6): the flush
  // delivers it only while the pane still hosts that session.
  sessionKey?: string
  // queued → ✍️ is true; delivered → 👀; dead-lettered (the flush failed and the CTO was
  // told to resend) → no reaction, since ✍️ would claim it is still waiting (#127).
  state: "queued" | "delivered" | "dead-lettered"
}

export type QueuedAckReaction = {
  messageId: number
  emoji: string
  shouldSend?: () => boolean
}

export type PrivateTopicResult =
  | { kind: "topic"; threadId: number }
  | { kind: "fallback"; message?: string }
  | { kind: "ask"; message: string }
  | { kind: "waiting" }
