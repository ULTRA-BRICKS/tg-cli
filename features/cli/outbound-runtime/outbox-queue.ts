// tg-cli#710: Telegram stayed unavailable through the retry budget. Persist the unsent
// rest of this send for the daemon to replay (marked as delayed) — with the ids that did
// go out, so the replay writes the history of the whole send as one group — and exit 75
// (EX_TEMPFAIL), not 1: nothing is lost.
import { randomUUID } from "node:crypto"
import { appendFileSync } from "fs"
import { join } from "path"
import { doneReactionForSend } from "../../tg-ctl/reactions"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import { writeOutboxEntry, type OutboxHistory } from "../../transport/outbox"
import type { QueuedSend } from "../../transport/telegram"
import type { OutboundRun } from "./types"

/** Capture the history template the replay writes for the whole send (needs a pane). */
function captureOutboxHistory(run: OutboundRun): OutboxHistory | undefined {
  let history: OutboxHistory | undefined
  run.recorder.recordOutboundHistory(run.prepared.caption, ([r]) => {
    if (!r?.pane) return
    history = {
      ts: r.ts,
      text: r.text,
      pane: r.pane,
      ...(r.chat_id !== undefined ? { chatId: r.chat_id } : {}),
      ...(r.targetAgent ? { targetAgent: r.targetAgent } : {}),
      ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}),
      groupToken: r.groupId ?? randomUUID(),
    }
  })
  return history
}

/** Write the outbox entry; the outcome carries the entry id, or the error that stopped it. */
async function writeEntry(
  run: OutboundRun,
  ctlOutbox: string,
  queuedSends: QueuedSend[],
  sendStartedAt: number,
): Promise<{ id: string | undefined; writeError: unknown }> {
  const history = captureOutboxHistory(run)
  // The route recordRoute would have written, for the replayed message ids.
  const route = run.recorder.outboxRoute()
  try {
    // `home` falls back to a literal "~": never create a ./~ tree in the cwd.
    if (!process.env.TG_CTL_CONFIG_DIR && !process.env.HOME) throw new Error("no config dir: HOME and TG_CTL_CONFIG_DIR are unset")
    const { outboundIds, outboundThreads } = run.recorder
    const delivered = outboundIds.map((messageId) => ({ id: messageId, threadId: outboundThreads.get(messageId) ?? null }))
    // A queued `--tag answer --reply-to` answer marks its question done when it is replayed.
    const done = doneReactionForSend({ tag: run.send.tag, replyToMessageId: run.send.replyTo })
    const reaction = done ? { chatId: run.sender.chatId, messageId: done.messageId, emoji: done.emoji } : undefined
    const { id } = await writeOutboxEntry(ctlOutbox, { sends: queuedSends, createdAt: sendStartedAt, route, history, delivered, reaction })
    return { id, writeError: undefined }
  } catch (err) {
    return { id: undefined, writeError: err }
  }
}

export async function persistQueuedSends(
  run: OutboundRun,
  queuedSends: QueuedSend[],
  sendStartedAt: number,
  removePdfTempDirs: () => void,
): Promise<never> {
  const ctl = ctlPaths(process.env.TG_CTL_CONFIG_DIR || join(run.paths.home, ".config", "tg-cli"), botIdFromToken(run.sender.botToken))
  const reason = queuedSends.find((s) => s.reason !== undefined)?.reason ?? "Telegram unavailable"
  const { id, writeError } = await writeEntry(run, ctl.outbox, queuedSends, sendStartedAt)
  // Only now: a queued upload of a generated PDF is read from its temp dir by the write.
  removePdfTempDirs()
  if (id === undefined) {
    if (run.recorder.outboundIds.length > 0) run.recorder.recordOutboundHistory(run.prepared.caption)
    console.error(`Telegram API error: ${reason}; the outbox write failed too (${writeError}) — the message was NOT sent`)
    process.exit(1)
  }
  try {
    appendFileSync(ctl.log, `[${new Date().toISOString()}] outbox: queued ${id} (${queuedSends.length} request(s), ${reason})\n`)
  } catch {
    // best-effort: the daemon logs the entry again when it replays it
  }
  console.error(
    `tg: Telegram did not answer (${reason}) — queued ${queuedSends.length} part(s); the tg-ctl daemon delivers them, marked as delayed, when Telegram answers again`,
  )
  process.exit(75)
}
