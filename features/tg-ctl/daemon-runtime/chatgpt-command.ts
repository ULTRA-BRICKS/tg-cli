// daemon-runtime/chatgpt-command: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { randomBytes } from "node:crypto"
import { buildMenu, handleCallback, type BotDeps, type BotReply } from "../../chatgpt/bot"
import { spawnPmRunner } from "../../chatgpt/pm-runner"
import type { Action } from "../types"
import { atomicWrite, log, readFileOrNull, type Ctx } from "./ctx-io"
import { answerCallbackQuery, sendMessage } from "./telegram-api"

// /chatgpt — the owner-only ChatGPT session menu (features/chatgpt, docs/chatgpt.md). The pure
// module decides everything; this wiring supplies the real pm runner and the durable ref store.
// Handlers are NOT awaited by the action loop (a pm call may take up to its bounded timeout), at
// most CHATGPT_MAX_IN_FLIGHT at a time. The reference is consumed synchronously inside
// handleCallback BEFORE its first await, so action order and replay safety do not depend on that.
export const CHATGPT_MAX_IN_FLIGHT = 4

export let chatgptInFlight = 0

export function chatgptBotDeps(ctx: Ctx): BotDeps {
  return {
    run: spawnPmRunner,
    now: Date.now,
    randomId: () => randomBytes(16).toString("base64url"),
    readStore: () => readFileOrNull(ctx.paths.chatgptRefs),
    writeStore: (content) => atomicWrite(ctx.paths.chatgptRefs, content),
    ownerChatId: ctx.chatId,
  }
}

export async function sendChatgptReply(ctx: Ctx, reply: BotReply, extra: Record<string, unknown> = {}): Promise<void> {
  const id = await sendMessage(ctx, reply.html, { ...extra, parse_mode: "HTML", ...(reply.keyboard ? { reply_markup: reply.keyboard } : {}) })
  if (id === null) log("chatgpt: reply could not be delivered")
}

export async function runChatgptMenu(ctx: Ctx, action: Extract<Action, { kind: "chatgpt-menu" }>): Promise<void> {
  const thread = typeof action.threadId === "number" ? { message_thread_id: action.threadId } : {}
  if (action.workspace === null) {
    await sendMessage(ctx, "usage: /chatgpt [home|glide.vc|all]", thread)
    return
  }
  if (chatgptInFlight >= CHATGPT_MAX_IN_FLIGHT) {
    await sendMessage(ctx, "chatgpt: busy with earlier requests — try again in a moment", thread)
    return
  }
  chatgptInFlight++
  try {
    await sendChatgptReply(ctx, await buildMenu(chatgptBotDeps(ctx), action.workspace), thread)
  } finally {
    chatgptInFlight--
  }
}

export async function runChatgptCallback(ctx: Ctx, action: Extract<Action, { kind: "chatgpt-callback" }>): Promise<void> {
  if (chatgptInFlight >= CHATGPT_MAX_IN_FLIGHT) {
    await answerCallbackQuery(ctx, action.callbackQueryId, "busy — tap again in a moment")
    return
  }
  chatgptInFlight++
  try {
    const result = await handleCallback(chatgptBotDeps(ctx), { data: action.data, chatId: action.chatId })
    await answerCallbackQuery(ctx, action.callbackQueryId, result.toast)
    if (result.reply) await sendChatgptReply(ctx, result.reply, typeof action.threadId === "number" ? { message_thread_id: action.threadId } : {})
  } finally {
    chatgptInFlight--
  }
}
