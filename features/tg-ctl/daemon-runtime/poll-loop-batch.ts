// daemon-runtime/poll-loop-batch: processing of one batch of updates inside the poll loop —
// journal, dedupe, ledger, auth claim, stepUpdates, persist-offset-BEFORE-acting, history, action dispatch.
// Split out of poll-loop.ts (guardian-817); the order of the steps below is the exactly-once contract.
import { unlinkSync, writeFileSync } from "fs"
import { groupActionsByAckBoundary } from "../concurrent-dispatch"
import { wrapInbound } from "../inject"
import { daemonAuthStep } from "../../auth/binding"
import { inboxEntryOf } from "../question-inbox"
import { type GraceRecord } from "../grants"
import { type LedgerEvent } from "../delivery-ledger"
import { parsePendingBatch, serializePendingBatch, stepUpdates, type StepOpts } from "../updates"
import type { Action, TgUpdate } from "../types"
import { atomicWrite, log, readFileOrNull } from "./ctx-io"
import { claimAuthBinding, deliveryLedger, recordDelivery } from "./delivery"
import { findDecidablePermissionRequestId } from "./button-requests"
import { refreshOriginalHosts } from "./session-registry"
import { recordInboundHistory } from "./poll-loop-history"
import type { Ctx } from "./ctx-io"
import type { PollLoopDeps } from "./poll-loop"

// Loop state that outlives one iteration.
export interface PollLoopState {
  // Updates a prior crash/kill left in the pending-batch journal; consumed once.
  recoveryQueue: TgUpdate[] | null
  // A chat `tg auth` bound in the previous batch (claimAuthBinding); applied between batches.
  authChatSwitch: number | null
}

// The journal a killed run left behind, if any.
export function readRecoveryQueue(ctx: Ctx): TgUpdate[] | null {
  const leftover = parsePendingBatch(readFileOrNull(ctx.paths.pendingBatch))
  if (leftover.length === 0) return null
  log(`recovering ${leftover.length} update(s) from a pending batch left by a prior crash/kill`)
  return leftover
}

// An update this daemon already finished — Telegram redelivering it after a lost offset
// write, or the journal replaying it after a kill — is skipped whole (tg-cli#299). One it
// only half-processed runs again; the sinks' ledger gate keeps whatever already went out
// from going out twice.
export function withoutProcessed(batch: readonly TgUpdate[], processed: ReadonlySet<number> | undefined): TgUpdate[] {
  return processed ? batch.filter((u) => !processed.has(u.update_id)) : [...batch]
}

// The offset still advances past the whole raw batch.
export function offsetPastBatch(batch: readonly TgUpdate[], currentOffset: number): number {
  return batch.reduce((next, u) => Math.max(next, u.update_id + 1), currentOffset)
}

// A message from the bound chat by an allowed sender carries its chat and message id; anything
// else is recorded by update id alone.
export function receivedLedgerEvent(u: TgUpdate, ctx: Pick<Ctx, "chatId" | "cfg">, receivedAt: number, now: number): LedgerEvent {
  const m = u.message
  const sender = m?.from?.id
  if (m && m.chat.id === ctx.chatId && sender !== undefined && (sender === ctx.chatId || ctx.cfg.allowedSenders.includes(sender))) {
    return { ts: now, event: "received", update: u.update_id, date: m.date, chat: ctx.chatId, msg: m.message_id }
  }
  return { ts: now, event: "received", update: u.update_id, date: m?.date ?? receivedAt }
}

// Local-time quote anchor for replies (item 3); pure module defaults to UTC.
export function formatLocalMinute(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface QuestionCardRef {
  messageId: number | null
  req: { kind: string; multiQuestion?: boolean; paneId?: string }
}

// The request id of the question card `cardId` stands for: a LIVE card first, then a retained
// one (which must be scoped to a pane, or a late reply has nowhere to go).
export function findPostTimeoutQuestionId(pending: ReadonlyMap<string, QuestionCardRef>, retained: ReadonlyMap<string, QuestionCardRef>, cardId: number): string | null {
  for (const [requestId, entry] of pending) {
    if (entry.messageId === cardId && entry.req.kind === "question" && !entry.req.multiQuestion) return requestId
  }
  for (const [requestId, entry] of retained) {
    if (entry.messageId === cardId && entry.req.kind === "question" && !entry.req.multiQuestion && entry.req.paneId) return requestId
  }
  return null
}

function stepOptions(d: PollLoopDeps): StepOpts {
  const { ctx, state } = d
  const { pendingButtons, abandonedButtons } = d.startup
  const { cardMessageIdFor, grantsData } = d.questionInbox
  const topicsMode = ctx.cfg.topics || ctx.cfg.privateTopics
  return {
    cfg: ctx.cfg,
    chatId: ctx.chatId,
    nowSec: Math.floor(Date.now() / 1000),
    currentOffset: state.offset,
    wrap: (name, msg, messageId) => wrapInbound(ctx.cfg.injectWrap, name, msg, messageId),
    fmtTime: formatLocalMinute,
    // Forum-topics mode (spec §8). OFF by default: when ctx.cfg.topics is false stepUpdates
    // ignores message_thread_id and the flat 1:1 path is byte-identical to before. When on,
    // topicStatusOf reads the binding store so topic messages route per-topic.
    // privateTopics also uses the same TopicBinding store and the same routing — enabling
    // either flag arms the topic router so private-chat topic messages reach their agent pane.
    topicsEnabled: topicsMode,
    topicStatusOf: topicsMode ? d.topicRouting.topicStatusOf : undefined,
    // Flat /new (issue #27): always wired (not gated by topics) — a plain message while a
    // /new awaits its dir is the typed path. When no /new is in flight this is false and the
    // plain-text path is byte-identical to before.
    newSessionAwaitingDir: d.picker.newSessionAwaitingDir,
    // A reply to a card's 📥 Inbox copy is a reply to the card (tg-cli#705): both lookups
    // see the card's own message id. A LIVE question card answers the same way as a
    // retained one — executeAction sends the text down its hook socket.
    postTimeoutQuestionRequestIdForMessage: (messageId) => findPostTimeoutQuestionId(pendingButtons, abandonedButtons, cardMessageIdFor(messageId)),
    permissionRequestIdForMessage: (messageId) =>
      findDecidablePermissionRequestId(pendingButtons, cardMessageIdFor(messageId)) ??
      findDecidablePermissionRequestId(abandonedButtons, cardMessageIdFor(messageId)) ??
      // A grace-only hatch card (its retained entry gone after a decision or restart) is
      // decided by a text reply exactly like by a tap (handleGraceStoreTap) — also through an
      // Inbox copy, which names the card it was made from.
      findDecidablePermissionRequestId(
        grantsData.grace.map((g): [string, GraceRecord] => [g.key, g]),
        inboxEntryOf(state.inboxState, messageId)?.cardId ?? messageId,
      ),
  }
}

// tg auth (docs/specs/tg-auth.md §4): claim a live `/start <nonce>` and keep every deep-link
// Start tap out of routing so it is never typed into a pane. The ledger above still records
// it (no update-id gap) and the offset still advances past it (offsetPastBatch).
function applyAuthStep(ctx: Ctx, loop: PollLoopState, received: TgUpdate[]): TgUpdate[] {
  const auth = daemonAuthStep(received, () => readFileOrNull(ctx.paths.authPending), Date.now())
  if (auth.claim && claimAuthBinding(ctx, auth.claim)) loop.authChatSwitch = auth.claim.chat.id
  return auth.drop.size > 0 ? received.filter((u) => !auth.drop.has(u.update_id)) : received
}

// The batch is durably journaled BEFORE this point (see journalBatch), so
// persisting the offset here no longer risks losing the update if a kill lands during
// action dispatch: recovery-on-restart (readRecoveryQueue) replays the
// pending-batch file. Telegram will redeliver anything whose offset was never advanced —
// i.e. a crash before this line, including mid-write of the journal itself, which a POSIX
// atomic rename makes never partially-visible. Anything past this line is recoverable from
// OUR OWN journal instead of relying on Telegram redelivery.
function persistOffset(d: PollLoopDeps, newOffset: number): void {
  const { ctx, state } = d
  if (newOffset === state.offset) return
  state.offset = newOffset
  writeFileSync(ctx.paths.offset, `${state.offset}\n`)
}

// The first resource key of a group's actions, if any action has one.
export function resourceKeyOfGroup(group: readonly Action[], resourceKeyOf: (a: Action) => string | null): string | null {
  return group.reduce<string | null>((acc, a) => acc ?? resourceKeyOf(a), null)
}

// One atomic, internally sequential unit: each action runs with the previous one's outcome.
async function runActionGroup(d: PollLoopDeps, group: readonly Action[]): Promise<void> {
  let ok = true
  for (const action of group) {
    try {
      ok = await d.execute.executeAction(action, ok)
    } catch (err) {
      log(`action ${action.kind} failed: ${err instanceof Error ? err.message : String(err)}`)
      ok = false
    }
  }
}

// Concurrent per-target dispatch (tg-cli#357, fixes the reported head-of-line-blocking
// incident: one wedged omp ACP session/prompt call froze delivery to every other agent
// sharing this daemon). Actions for one inbound message are grouped by their trailing
// `ack` boundary and run as one atomic, internally sequential unit — the forum-topics
// no-double-spawn guarantee (two `topic-model` taps for the SAME thread reach `bound`
// one-after-another) is preserved because same-key groups (actionResourceKey) still run
// through dispatchQueues in strict enqueue order. Groups with different keys (the common
// case: different messages routed to different agents) run fully concurrently via
// Promise.allSettled, so one group's stuck action can never delay or fail any other.
async function dispatchActions(d: PollLoopDeps, actions: Action[]): Promise<void> {
  const { dispatchQueues } = d.startup
  const { actionResourceKey } = d.execute
  const actionGroups = groupActionsByAckBoundary(actions)
  await Promise.allSettled(
    actionGroups.map((group) => dispatchQueues.run(resourceKeyOfGroup(group, actionResourceKey), () => runActionGroup(d, group))),
  )
}

// The batch fully completed — the journal is no longer needed. Best-effort:
// if this unlink fails the next startup replays the same batch (idempotent/dedupe-tolerant
// downstream, matching the rest of the codebase's at-least-once handling, e.g. the Stop-hook
// inbox fallback).
function discardJournal(ctx: Ctx): void {
  try {
    unlinkSync(ctx.paths.pendingBatch)
  } catch {}
}

export async function processBatch(d: PollLoopDeps, loop: PollLoopState, batch: TgUpdate[]): Promise<void> {
  const { ctx, state } = d
  // Durably journal the raw batch BEFORE stepUpdates/offset-advance (tg-cli#322): if this
  // write completes, ANY subsequent crash — including one back inside stepUpdates or during
  // action dispatch — has a durable copy to replay via recoveryQueue on the next startup.
  // Unconditional on the recovery path too: harmless idempotent rewrite of the same content.
  if (batch.length > 0) {
    atomicWrite(ctx.paths.pendingBatch, serializePendingBatch(batch))
  }
  const received = withoutProcessed(batch, deliveryLedger?.state.processedUpdates)
  if (received.length < batch.length) log(`skipping ${batch.length - received.length} already-processed update(s)`)
  const batchOffset = offsetPastBatch(batch, state.offset)
  const receivedAt = Math.floor(Date.now() / 1000)
  recordDelivery(received.map((u) => receivedLedgerEvent(u, ctx, receivedAt, Date.now())))
  const updates = applyAuthStep(ctx, loop, received)

  await refreshOriginalHosts()
  const step = stepUpdates(updates, stepOptions(d))

  persistOffset(d, Math.max(step.newOffset, batchOffset))

  if (updates.length > 0) recordInboundHistory(d, updates)

  await dispatchActions(d, step.actions)

  // Every action for these updates ran: a later replay of any of them is skipped whole
  // (a dropped tg auth Start tap included — it is finished, not pending).
  recordDelivery(received.map((u): LedgerEvent => ({ ts: Date.now(), event: "processed", update: u.update_id })))

  if (batch.length > 0) discardJournal(ctx)
}
