// daemon-runtime/daemon-state: the mutable scalars several parts of the daemon share.
//
// runDaemon used to be one closure, so a `let` assigned in one place and read in another was
// just a variable. After the split each part is its own module, and an ES import binding can
// never be assigned by its importer, so every `let` that crosses a module boundary lives here
// as a field of one object. A field starts at a neutral value; the part that owns it assigns
// its real initial value at the same point in the startup order the closure did.
import type { InboxState } from "../question-inbox"
import type { AwarenessNudgeStore } from "../tg-awareness-nudge"
import { emptyInboxState } from "../question-inbox"
import type { Ctx } from "./ctx-io"
import type { SelectedAgentRoute } from "./daemon-types"

export interface DaemonState {
  /** The 📥 Inbox topic bookkeeping (question-inbox-runtime owns it; topic routing reads it). */
  inboxState: InboxState
  /** Monotonic token counters for the /agent picker, the selected-agent route and /new. */
  agentTokenSeq: number
  selectedAgentTokenSeq: number
  newTokenSeq: number
  /** The route a tap on an /agent candidate armed; consumed by the next plain message. */
  selectedAgentRoute: SelectedAgentRoute | null
  /** Whether the user accepted spawning without a topic after private topics failed. */
  privateTopicFallbackState: "unknown" | "pending" | "accepted"
  /** getUpdates cursor and the poll loop's health counters. */
  offset: number
  lastAgentSeenMs: number
  consecutive409: number
  warned409: boolean
  /** Graceful shutdown: set by SIGTERM, read between batches; `pollAbort` ends the idle long-poll. */
  shuttingDown: boolean
  pollAbort: AbortController | null
  /** Durable per-agent silence-nudge state (tg-cli#363). */
  awarenessNudgeStore: AwarenessNudgeStore
}

export function createDaemonState(ctx: Ctx): DaemonState {
  return {
    inboxState: emptyInboxState(ctx.chatId),
    agentTokenSeq: 0,
    selectedAgentTokenSeq: 0,
    newTokenSeq: 0,
    selectedAgentRoute: null,
    privateTopicFallbackState: "unknown",
    offset: 0,
    lastAgentSeenMs: 0,
    consecutive409: 0,
    warned409: false,
    shuttingDown: false,
    pollAbort: null,
    awarenessNudgeStore: {},
  }
}
