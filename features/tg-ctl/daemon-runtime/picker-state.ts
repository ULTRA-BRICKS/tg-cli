// daemon-runtime/picker-state: /agent picker, selected-agent route and /new session pending state.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { DeferQueues } from "../defer"
import { type ButtonMessagePayload } from "../questions"
import { threadOfMessageInBlob } from "../../replies/history"
import { type NewSession } from "../new-command"
import { log, readFileOrNull } from "./ctx-io"
import { recordFailed, recordHeld } from "./delivery"
import { clearMessageKeyboard, editMessageText, sendMessage } from "./telegram-api"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { DeferredInbound, PendingAgentEntry, SelectedAgentRoute } from "./daemon-types"

export type PickerDeps = {
  ctx: Ctx
  state: DaemonState
}

export function createPicker(d: PickerDeps) {
  const { ctx, state } = d

  const pendingAgent = new Map<string, PendingAgentEntry>()

  const PICKER_TTL_MS = 10 * 60_000

  // The one notice for an inbound message the daemon gave up on (tg-cli#299): a reply
  // under the CTO's own message, so he sees exactly which one to resend. In the topic the message
  // was written in (its history row records it): a reply anchor alone does not name the thread,
  // so without it the notice lands in General (tg-cli#551).
  const tellUndelivered = async (messageId: number, notice: string): Promise<void> => {
    log(`undelivered: tg#${messageId} ${notice}`)
    const threadId = threadOfMessageInBlob(readFileOrNull(ctx.paths.history), ctx.chatId, messageId)
    await sendMessage(ctx, `⚠️ tg#${messageId} ${notice}`, {
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      ...(typeof threadId === "number" ? { message_thread_id: threadId } : {}),
    })
  }

  // A picker holds its message only in memory until a tap: the ledger records the hold
  // (a restart loses it and startup reports it), and a picker nobody taps reports its
  // message as not delivered instead of dropping it silently.
  const armPendingAgent = (token: string, entry: Omit<PendingAgentEntry, "timer">): void => {
    const timer = setTimeout(() => void expirePendingAgent(token), PICKER_TTL_MS)
    pendingAgent.set(token, { ...entry, timer })
    if (!entry.selectOnly) recordHeld(entry.sourceMessageId, "picker", "picker")
  }

  const expirePendingAgent = async (token: string): Promise<void> => {
    const entry = pendingAgent.get(token)
    if (!entry) return
    pendingAgent.delete(token)
    if (entry.selectOnly || entry.sourceMessageId === null) return
    if (entry.messageId !== null) void clearMessageKeyboard(ctx, entry.messageId)
    const error = "nobody picked an agent within 10 minutes"
    recordFailed(entry.sourceMessageId, "picker", error)
    await tellUndelivered(entry.sourceMessageId, `was not delivered: ${error}. Resend it if it still matters.`)
  }

  state.agentTokenSeq = 0

  const SELECTED_AGENT_TTL_MS = 10 * 60_000

  state.selectedAgentRoute = null

  state.selectedAgentTokenSeq = 0

  // Must match features/tg-ctl/agent-match.ts's parser prefix.
  const AGENT_CANCEL_CALLBACK_PREFIX = "tgac"

  const cancelSelectedAgentRoute = (): SelectedAgentRoute | null => {
    const selected = state.selectedAgentRoute
    if (!selected) return null
    state.selectedAgentRoute = null
    clearTimeout(selected.timer)
    return selected
  }

  const cancelSelectedAgentRouteForAgentCommand = (): void => {
    const previous = cancelSelectedAgentRoute()
    if (previous && previous.messageId !== null) {
      void editMessageText(ctx, previous.messageId, `cancelled ${previous.label} — another /agent command was used`)
    }
  }

  const selectedAgentCancelMarkup = (token: string): ButtonMessagePayload["reply_markup"] => ({
    inline_keyboard: [[{ text: "Cancel", callback_data: `${AGENT_CANCEL_CALLBACK_PREFIX}:${token}` }]],
  })

  // Flat-chat `/new` sessions in flight (issue #27), keyed by an opaque token. IN-MEMORY only:
  // a `/new` interrupted by a daemon restart is simply abandoned (the user re-runs it) — far
  // simpler than the crash-recovery the PERSISTENT forum-topic bindings need, because a flat /new
  // creates a plain pane (addressed by /agent afterwards), not a tracked binding. Sessions older
  // than NEW_SESSION_TTL_MS are reaped lazily so an abandoned awaiting-dir can't capture a much
  // later plain message as its "path answer".
  const pendingNew = new Map<string, NewSession>()

  state.newTokenSeq = 0

  const NEW_SESSION_TTL_MS = 10 * 60_000

  // Reap expired /new sessions (lazy GC, called before each read of the store). Keeps an
  // abandoned awaiting-dir from later swallowing an unrelated plain message as a path answer.
  const reapNewSessions = (): void => {
    const cutoff = Math.floor(Date.now() / 1000) - NEW_SESSION_TTL_MS / 1000
    for (const [tok, s] of pendingNew) {
      if (s.ts < cutoff) pendingNew.delete(tok)
    }
  }

  // True while at least one /new session is awaiting its working directory — so stepUpdates
  // treats the next plain prose message as the typed path answer (injected via newSessionAwaitingDir).
  const newSessionAwaitingDir = (): boolean => {
    reapNewSessions()
    for (const s of pendingNew.values()) {
      // A ➕ New session flow takes its directory in its own topic (newSessionDirAnswer), never
      // from General: a flat `/compact` then still reaches the flat agent.
      if (s.status === "awaiting-dir" && s.bindThreadId === undefined) return true
    }
    return false
  }

  // Inbound queued behind an agent's outstanding question (defer-while-waiting):
  // pane → already-wrapped texts plus their Telegram source message id, flushed
  // when the question is answered. The flag tells the trailing `ack` to mark the
  // source message with DEFER_REACTION (✍️ "noted, queued") instead of 👀.
  const deferred = new DeferQueues<DeferredInbound>()

  // Panes with an in-flight flushDeferred. While a flush drains a pane, its queue
  // is momentarily empty (taken out per round), so deferred.has() alone would let
  // a live message inject AHEAD of items still being flushed. This flag keeps new
  // inbound deferring for the whole flush, preserving strict FIFO; the drain
  // loop's next round picks up whatever was enqueued meanwhile.
  const flushingPanes = new Set<string>()

  return { pendingAgent, tellUndelivered, armPendingAgent, SELECTED_AGENT_TTL_MS, cancelSelectedAgentRoute, cancelSelectedAgentRouteForAgentCommand, selectedAgentCancelMarkup, pendingNew, reapNewSessions, newSessionAwaitingDir, deferred, flushingPanes }
}

export type PickerApi = ReturnType<typeof createPicker>
