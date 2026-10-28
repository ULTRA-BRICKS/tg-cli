// daemon-runtime/topic-spawn-private: pure readers for the Bot API answers createPrivateTopic acts on.
// Split out of createPrivateTopic (guardian-817) so the response-shape decisions are testable on plain data.

/** getMe result says the bot has private-chat topics switched off (`has_topics_enabled === false`). */
export function reportsTopicsDisabled(getMeResult: unknown): boolean {
  if (!getMeResult || typeof getMeResult !== "object" || !("has_topics_enabled" in getMeResult)) return false
  return getMeResult.has_topics_enabled === false
}

/** The outcome of reading a createForumTopic `result`: the thread id, or why it is unusable. */
export type CreatedTopic =
  | { ok: true; threadId: number }
  | { ok: false; logLine: string; reason: string }

export function readCreatedTopic(result: unknown): CreatedTopic {
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      logLine: "private chat topic create unavailable — createForumTopic returned no result object",
      reason: "Telegram Bot API returned no topic object from `createForumTopic`",
    }
  }
  const threadId = "message_thread_id" in result ? result.message_thread_id : undefined
  if (typeof threadId !== "number") {
    return {
      ok: false,
      logLine: "private chat topic create unavailable — createForumTopic returned no message_thread_id",
      reason: "Telegram Bot API returned no `message_thread_id` from `createForumTopic`",
    }
  }
  return { ok: true, threadId }
}
