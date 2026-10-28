// daemon-runtime/telegram-api: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeFileSync } from "fs"
import { isAllowedReaction } from "../reactions"
import { isEditNotModified, telegramFailureIsTransient } from "../../transport/telegram"
import { type TasksReplyMarkup } from "../tasks-command"
import { normalizeRichHtml, validateRichHtml } from "../../render/rich"
import { BOT_COMMANDS, validateBotCommands } from "../bot-commands"
import { type ButtonMessagePayload } from "../questions"
import { appendRoute, fsRoutesLockIo, parseRoutes, serializeRoutes, withRoutesLock } from "../routes"
import { flushOutbox } from "../../transport/outbox"
import { DEFAULT_SEND_RETRY } from "../../transport/send-retry"
import type { Action } from "../types"
import { api, appendHistory, log, readFileOrNull, type Ctx } from "./ctx-io"

// Daemon-side Bot API call. Never throws and never exits — a failed notice
// must not take the poll loop down with it.
export async function botPost(ctx: Ctx, method: string, body: unknown): Promise<Record<string, unknown> | null> {
  const result = await botPostResult(ctx, method, body)
  // Preserve the legacy wrapper contract: transport-level HTTP errors return null,
  // but Telegram's historical HTTP-200 {ok:false} envelopes remain visible to callers.
  if (!result.ok && typeof result.status === "number") return null
  return result.json ?? null
}

export type BotPostResult =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; status?: number; description: string; json?: Record<string, unknown> }

export function telegramErrorDescription(text: string): { description: string; json?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const json = parsed as Record<string, unknown>
      if (typeof json.description === "string") return { description: json.description, json }
      return { description: JSON.stringify(json).slice(0, 200), json }
    }
  } catch {
    // Fall through to the raw body; non-JSON upstream failures are still useful diagnostics.
  }
  return { description: text.slice(0, 200) }
}

// Telegram's success answer to an edit, standing in for a "message is not modified" refusal.
export const EDIT_UNCHANGED: Record<string, unknown> = { ok: true, result: true }

// The one path every daemon Bot API call takes, so an edit that changed nothing
// (isEditNotModified, tg-cli#728) is success here for every edit call site: no failure line,
// and the caller sees ok. `timeoutMs`: a diagnostic read (status' getMe) passes a short one, so
// a stalled API cannot hold the reply for the full send timeout.
export async function botPostResult(ctx: Ctx, method: string, body: unknown, timeoutMs = 15_000): Promise<BotPostResult> {
  try {
    // codeql[js/file-access-to-http] Intentional: the request goes to the operator-configured Bot API base
    // (TG_API_BASE) with the operator's own bot token, both read from ~/.config/tg-cli/.env / process env by
    // cli-main (the daemon's trust root, 0600 owner file). method is a hard-coded Bot API name at every call
    // site. No attacker-controlled file data reaches the URL host. Covered by the ctl-*-integration tests
    // that run the daemon against a fake Bot API.
    const resp = await fetch(`${api(ctx)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // codeql[js/file-access-to-http] Intentional: the body is the message this daemon sends to Telegram;
      // the file data in the flow is the state files (routes, questions, outbox) the daemon itself wrote 0600
      // and the token. The destination is the configured Bot API base only. Covered by
      // ctl-outbox-flush-integration.
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      const text = await resp.text()
      const error = telegramErrorDescription(text)
      if (isEditNotModified(method, error.description)) return { ok: true, json: EDIT_UNCHANGED }
      log(`${method} failed: ${resp.status} ${text.slice(0, 200)}`)
      return { ok: false, status: resp.status, ...error }
    }
    const json = (await resp.json()) as Record<string, unknown>
    if (!json || typeof json !== "object") return { ok: false, description: "non-object JSON response" }
    if (json.ok === false) {
      const description =
        typeof json.description === "string" ? json.description : JSON.stringify(json).slice(0, 200)
      if (isEditNotModified(method, description)) return { ok: true, json: EDIT_UNCHANGED }
      return { ok: false, description, json }
    }
    return { ok: true, json }
  } catch (err) {
    log(`${method} failed: ${err}`)
    return { ok: false, description: String(err) }
  }
}

// The 📥 Inbox topic (tg-cli#705) carries ONLY question-card copies, which the daemon's inbox
// sync posts straight through botPostResult. Every other daemon send — notices, replies, /status,
// pickers, session posts — that would land there goes to General instead. Set by the daemon
// whenever its Inbox state changes; null outside a daemon or before the topic exists.
export let inboxThreadId: number | null = null

// An ES import binding cannot be assigned by the importer: the daemon arms the guard through this.
export function setInboxThreadId(threadId: number | null): void {
  inboxThreadId = threadId
}

export function outsideInbox<T extends { message_thread_id?: unknown }>(extra: T): T {
  if (inboxThreadId === null || extra.message_thread_id !== inboxThreadId) return extra
  log(`inbox guard: a non-card send aimed at the Inbox topic ${inboxThreadId} goes to General`)
  const rest = { ...extra }
  delete rest.message_thread_id
  return rest
}

export async function sendMessage(ctx: Ctx, text: string, extra: Record<string, unknown> = {}): Promise<number | null> {
  const json = await botPost(ctx, "sendMessage", { chat_id: ctx.chatId, text, ...outsideInbox(extra) })
  const result = json?.result
  if (!result || typeof result !== "object") return null
  const messageId = (result as { message_id?: unknown }).message_id
  return typeof messageId === "number" ? messageId : null
}

// tg-cli#710: replay the sends `tg` queued while Telegram kept failing (outbox.ts), each
// marked as delayed, with the route + history rows `tg` would have written. Kicked on
// startup and after every successful getUpdates; single-flight and never awaited, so a
// backlog never holds up inbound handling. A transient failure ends the pass and pauses
// the next one (Telegram's retry_after on a 429, else OUTBOX_RETRY_PAUSE_MS), so a busy
// chat's getUpdates batches don't each re-read the backlog and fire a doomed request.
export const OUTBOX_RETRY_PAUSE_MS = 5_000

export let outboxFlushing = false

export let outboxFlushNotBefore = 0

export function kickOutboxFlush(ctx: Ctx): void {
  if (outboxFlushing || Date.now() < outboxFlushNotBefore) return
  outboxFlushing = true
  flushOutbox(ctx.paths.outbox, {
    post: (method, init) =>
      // codeql[js/file-access-to-http] Intentional: the request goes to the operator-configured Bot API base
      // (TG_API_BASE) with the operator's own bot token, both read from ~/.config/tg-cli/.env / process env
      // by cli-main (the daemon's trust root, 0600 owner file). The outbox method is validated as a bare
      // [A-Za-z]+ Bot API name by parseEntry (tests/codeql-hardening.test.ts), so a tampered entry cannot add
      // path or query segments. No attacker-controlled file data reaches the URL host. Covered by the
      // ctl-*-integration tests that run the daemon against a fake Bot API.
      fetch(`${api(ctx)}/${method}`, {
        ...init,
        signal: AbortSignal.timeout(init.body instanceof FormData ? DEFAULT_SEND_RETRY.uploadAttemptTimeoutMs : DEFAULT_SEND_RETRY.attemptTimeoutMs),
      }),
    now: Date.now,
    log,
    recordRoutes: (routes) => {
      const done = withRoutesLock(
        fsRoutesLockIo(`${ctx.paths.routes}.lock`),
        () => {
          writeFileSync(ctx.paths.routes, serializeRoutes(routes.reduce(appendRoute, parseRoutes(readFileOrNull(ctx.paths.routes)))))
          return true
        },
        { onContended: "skip" },
      )
      if (!done) log(`outbox: routes lock contended, ${routes.length} route(s) not recorded`)
    },
    appendHistory: (records) => appendHistory(ctx.paths.history, records),
  })
    .then((res) => {
      if (res.stopped) outboxFlushNotBefore = Date.now() + (res.retryAfterMs ?? OUTBOX_RETRY_PAUSE_MS)
    })
    .catch((err) => log(`outbox: flush error: ${err}`))
    .finally(() => {
      outboxFlushing = false
    })
}

export async function answerCallbackQuery(ctx: Ctx, callbackQueryId: string, text: string): Promise<void> {
  // A text-reply-synthesized decision (see the 'answer-question' construction in
  // features/tg-ctl/updates.ts) carries an empty callbackQueryId sentinel: there is no real
  // Telegram callback query to acknowledge, so this is a correct no-op on a SUCCESS path — the
  // card's own editMessageText already gives the human visible feedback. It is NOT correct on a
  // pure-toast failure branch (expired / already-answered / mismatched) that posts no edit —
  // those call sites MUST use answerCallbackQueryOrNotify below instead, or the sentinel would
  // silently swallow the only feedback the human would otherwise get (review finding).
  if (!callbackQueryId) return
  await botPost(ctx, "answerCallbackQuery", { callback_query_id: callbackQueryId, text })
}

// For a failure branch that reports its outcome ONLY via the toast (no accompanying card edit):
// a real button tap's `action.callbackQueryId` is always real, so `answerCallbackQuery` reaches
// the human either way. A text-reply-synthesized decision (empty-sentinel `action`, see
// features/tg-ctl/updates.ts) has no callback query to toast — without this, the human's "yes"
// would silently do nothing with zero feedback (review finding: a same-batch race where a button
// tap resolves the card a moment before a text reply to it lands would otherwise vanish
// unexplained). Falls back to a plain chat reply carrying the identical text. Success branches
// that follow up with an editMessageText keep using plain `answerCallbackQuery` — the card edit
// is already sufficient feedback there and a second message would be redundant noise.
export async function answerCallbackQueryOrNotify(
  ctx: Ctx,
  action: Extract<Action, { kind: "answer-question" }>,
  text: string,
): Promise<void> {
  if (!action.callbackQueryId) {
    await sendMessage(ctx, text, typeof action.threadId === "number" ? { message_thread_id: action.threadId } : {})
    return
  }
  await answerCallbackQuery(ctx, action.callbackQueryId, text)
}

// NOTE: Telegram's editMessageText REPLACES the whole inline keyboard — omitting
// reply_markup detaches it. Pass the markup whenever the edited card must stay
// tappable (e.g. restoring a re-attached question card to its live prompt).
export async function editMessageText(
  ctx: Ctx,
  messageId: number,
  text: string,
  replyMarkup?: ButtonMessagePayload["reply_markup"],
  parseMode?: ButtonMessagePayload["parse_mode"],
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: ctx.chatId, message_id: messageId, text }
  if (replyMarkup) body.reply_markup = replyMarkup
  if (parseMode) body.parse_mode = parseMode
  await botPost(ctx, "editMessageText", body)
}

// Remove the inline keyboard from a previously-sent message (forum-topics increment 4): after a
// topic binds we clear the now-stale model buttons so they can't be re-tapped. Omitting
// reply_markup detaches the keyboard. Best-effort — botPost swallows failures (a deleted prompt
// message, a transient API error), never throwing into the poll loop.
export async function clearMessageKeyboard(ctx: Ctx, messageId: number): Promise<void> {
  await botPost(ctx, "editMessageReplyMarkup", { chat_id: ctx.chatId, message_id: messageId })
}

// Take a message the daemon posted out of the chat — an Inbox copy whose card closed, a reminder
// ping the removed #403 / #464 reminders left: delete it; when Telegram refuses the delete for
// good (too old for a bot delete, already gone, …) edit it to `placeholder` instead. True once
// Telegram gave its verdict: done, or refused for good — a message already gone counts as
// removed. False when a step failed for a reason that may pass (no answer, 429, 5xx): the caller
// keeps the message on disk and retries (tg-cli#722, #723). Never throws. `chatId` is the chat
// the message was POSTED in (tg-cli#518): after a TG_CHAT_ID change it is not ctx.chatId.
export async function retireMessage(ctx: Ctx, chatId: number, messageId: number, placeholder: string): Promise<boolean> {
  const deleted = await botPostResult(ctx, "deleteMessage", { chat_id: chatId, message_id: messageId })
  if (deleted.ok) return true
  if (telegramFailureIsTransient(deleted)) return false
  const edited = await botPostResult(ctx, "editMessageText", { chat_id: chatId, message_id: messageId, text: placeholder })
  return !telegramFailureIsTransient(edited)
}

// Set a reaction on a message (tg-cli#114 lifecycle: 👀 working → 😴 stalled →
// 👌 done). Skips an emoji Telegram would reject (⏳/✅ are REACTION_INVALID) so
// we never waste a call on a guaranteed 400. Best-effort — botPost swallows
// failures; a receipt must never break the caller.
export async function setMessageReaction(ctx: Ctx, messageId: number, emoji: string): Promise<void> {
  if (!isAllowedReaction(emoji)) {
    log(`setMessageReaction skipped: ${emoji} is not an allowed reaction`)
    return
  }
  await botPost(ctx, "setMessageReaction", {
    chat_id: ctx.chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  })
}

// Send a rich-HTML message (Bot API sendRichMessage, `rich_message.html`), the
// path /tasks uses for its table (#115). Normalizes + pre-flights the HTML with
// the same helpers `tg` uses, so an invalid table fails locally with a clear log
// instead of an opaque API 400. Returns the sent message id or null.
export async function sendRich(
  ctx: Ctx,
  rawHtml: string,
  extra: { reply_markup?: TasksReplyMarkup; message_thread_id?: number; reply_parameters?: { message_id: number } } = {},
): Promise<number | null> {
  const html = normalizeRichHtml(rawHtml)
  const check = validateRichHtml(html)
  if (!check.ok) {
    log(`sendRich invalid html: ${check.error}`)
    return null
  }
  const json = await botPost(ctx, "sendRichMessage", { chat_id: ctx.chatId, rich_message: { html }, ...outsideInbox(extra) })
  const result = json?.result
  if (!result || typeof result !== "object") return null
  const messageId = (result as { message_id?: unknown }).message_id
  return typeof messageId === "number" ? messageId : null
}

// Publish the bot's own slash-commands to Telegram's "/" autocomplete + menu
// button (setMyCommands), so `/agent` and the rest are discoverable instead of
// blind-typed. Best-effort and idempotent: a network/API failure is logged and
// ignored — the daemon's job is routing, not the menu. The ENTIRE body is
// wrapped: botPost already swallows transport errors, but the whole publish path
// is belt-and-suspenders try/catch'd so no future regression on this side path
// can ever throw into runDaemon and abort startup. validateBotCommands guards
// the list against Telegram's constraints (the test suite enforces it too).
//
// Scope: the default (global) scope — the menu shows in every chat with the bot.
// tg-ctl is a single-user personal control bot (one TG_CHAT_ID), so global is the
// intended choice; a multi-tenant bot would scope per chat to avoid leaking the
// menu to other chats.
export async function publishBotCommands(ctx: Ctx): Promise<void> {
  try {
    validateBotCommands()
    const json = await botPost(ctx, "setMyCommands", { commands: BOT_COMMANDS })
    if (json?.ok === true) log(`setMyCommands ok — published ${BOT_COMMANDS.length} commands`)
    else log("setMyCommands did not confirm ok — menu may be stale (continuing)")
  } catch (err) {
    // Unreachable on today's code (botPost is try/catch'd, validate only throws
    // on a bad list we control) — but startup must survive it regardless.
    log(`setMyCommands failed — menu not published (continuing): ${err}`)
  }
}
