// daemon-runtime/ack-reactions: queued acknowledgement reactions and message reactions.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { api, log } from "./ctx-io"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { QueuedAckReaction } from "./daemon-types"

export type ReactionsDeps = {
  ctx: Ctx
  state: DaemonState
}

export function createReactions(d: ReactionsDeps) {
  const { ctx } = d

  const queuedAckReactions: QueuedAckReaction[] = []

  const queueAckReaction = (messageId: number | null, emoji: string, shouldSend?: () => boolean): void => {
    if (messageId === null) return
    queuedAckReactions.push({ messageId, emoji, shouldSend })
  }

  const takeAckReaction = (messageId: number): QueuedAckReaction | null => {
    const index = queuedAckReactions.findIndex((reaction) => reaction.messageId === messageId)
    if (index < 0) return null
    const [reaction] = queuedAckReactions.splice(index, 1)
    return reaction ?? null
  }

  // Best-effort delivery receipt (spec §10): 👀 on the source message. A
  // failed reaction is logged and otherwise ignored — receipts must never
  // break the poll loop (e.g. a Bot API fake without the endpoint).
  const postReaction = async (messageId: number, reaction: Array<{ type: "emoji"; emoji: string }>): Promise<void> => {
    try {
      // codeql[js/file-access-to-http] Intentional: the request goes to the operator-configured Bot API base
      // (TG_API_BASE) with the operator's own bot token, both read from ~/.config/tg-cli/.env / process env
      // by cli-main (the daemon's trust root, 0600 owner file). Body is chat id + message id + fixed emoji.
      // No attacker-controlled file data reaches the URL host. Covered by the ctl-*-integration tests that
      // run the daemon against a fake Bot API.
      const resp = await fetch(`${api(ctx)}/setMessageReaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: ctx.chatId, message_id: messageId, reaction }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!resp.ok) log(`setMessageReaction failed: ${resp.status}`)
    } catch (err) {
      log(`setMessageReaction failed: ${err}`)
    }
  }

  const setReaction = (messageId: number, emoji: string): Promise<void> => postReaction(messageId, [{ type: "emoji", emoji }])

  // An empty list removes the bot's reaction.
  const clearReaction = (messageId: number): Promise<void> => postReaction(messageId, [])

  const setSeenReaction = (messageId: number): Promise<void> => setReaction(messageId, "👀")

  const setSeenReactions = async (
    primaryMessageId: number | null,
    relatedMessageId: number | null | undefined,
  ): Promise<void> => {
    // setReaction is best-effort and already catches/logs Bot API failures.
    const ids = Array.from(new Set([primaryMessageId, relatedMessageId].filter((id): id is number => typeof id === "number")))
    for (const id of ids) await setSeenReaction(id)
  }

  // ⏳ is NOT in Telegram's allowed reaction set; ✍️ ("noted, queued") is the
  // closest allowed emoji for "deferred behind the agent's open question".
  const DEFER_REACTION = "✍️"

  // The delivery receipt for one source message: a reaction a handler queued for it (✍️ while it
  // waits) wins; otherwise 👀 when its delivery succeeded.
  const settleAckReaction = async (messageId: number, delivered: boolean): Promise<void> => {
    const queuedReaction = takeAckReaction(messageId)
    if (queuedReaction) {
      if (!queuedReaction.shouldSend || queuedReaction.shouldSend()) await setReaction(messageId, queuedReaction.emoji)
    } else if (delivered) {
      await setSeenReaction(messageId)
    }
  }

  return { queueAckReaction, setReaction, clearReaction, setSeenReactions, DEFER_REACTION, settleAckReaction }
}

export type ReactionsApi = ReturnType<typeof createReactions>
