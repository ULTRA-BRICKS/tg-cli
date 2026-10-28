// daemon-runtime/topic-routing-hold: the held-queue → first-task planning of a ➕ New session spawn.
// Split out of spawnIntoHeldTopic (guardian-817).
import type { LedgerEvent } from "../delivery-ledger"
import type { TopicPayload } from "../types"
import { deliveryLedger } from "./delivery"

export type TextPayload = Extract<TopicPayload, { type: "text" }>

// The task rides one argv element, which Linux caps at 128 KiB (MAX_ARG_STRLEN): held texts
// join it in order up to half that; the rest is answered like an attachment, never a spawn
// that fails the same way on every Retry.
const TASK_MAX_BYTES = 64 * 1024

/** The held texts that fit the argv prompt (in order, stopping at the first that does not), and the joined task. */
export function planHeldTask(sessionTask: string, payloads: TopicPayload[]): { texts: TextPayload[]; task: string } {
  const texts: TextPayload[] = []
  let taskBytes = Buffer.byteLength(sessionTask)
  for (const p of payloads) {
    if (p.type !== "text") continue
    const bytes = Buffer.byteLength(p.text) + 2
    if (taskBytes + bytes > TASK_MAX_BYTES) break
    texts.push(p)
    taskBytes += bytes
  }
  const task = [sessionTask, ...texts.map((p) => p.text)].filter((t) => t.trim().length > 0).join("\n\n")
  return { texts, task }
}

/** The held payloads that did not ride the first task (attachments, or past the size cap). */
export function payloadsNotPassed(payloads: TopicPayload[], passed: TextPayload[]): TopicPayload[] {
  const ids = new Set(passed.map((p) => p.messageId))
  return payloads.filter((p) => !ids.has(p.messageId))
}

/** One ledger row for a held message, or none when no ledger is configured. */
export function heldLedgerEvent(event: "claimed" | "delivered", messageId: number, target: string): LedgerEvent[] {
  return deliveryLedger ? [{ ts: Date.now(), event, chat: deliveryLedger.chat, msg: messageId, target }] : []
}
