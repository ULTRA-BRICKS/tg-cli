// daemon-runtime/topic-routing-attach: the delivery half of an attach-picker tap (tg-ctl topic routing).
// Split out of handleTopicAttach (guardian-817): the statements keep their original order and text;
// the closure variables they used arrive through `AttachRuntime` / `AttachJob`.
import type { AgentCandidate } from "../agent-match"
import { type SessionEntry } from "../session-registry"
import { resolveLocatorToSession } from "../session-registry-store"
import { sessionTopicTitle, topicTitleFor } from "../session-topics"
import type { AgentKind } from "../types"
import { appendTopic, attachTopic, topicForPane, topicLink, type TopicHold } from "../topics"
import type { TopicBinding, TopicPayload } from "../types"
import type { Ctx } from "./ctx-io"
import { registryForPane } from "./delivery"
import { editSessionTopic, liveEntry, patchSessionEntry } from "./session-registry"

type SessionState = { state: "live"; cwd: string } | { state: "gone" } | { state: "unconfirmed"; reply: string }
type LiveSessionEntry = SessionEntry

/** The picked pane as topics.ts attachTopic wants it. */
export interface AttachSession {
  paneId: string
  name: string
  path?: string
  harness?: AgentKind
}

/** The closure functions of topic-routing that the attach delivery steps call. */
export interface AttachRuntime {
  ctx: Ctx
  loadTopics: () => TopicBinding[]
  updateTopics: (mutate: (topics: TopicBinding[]) => TopicBinding[] | null) => TopicBinding[]
  deliverToSession: (key: string, threadId: number, payload: TopicPayload) => Promise<{ kind: "sent"; ok: boolean } | { kind: "gone"; name: string | null }>
  deliverTopicPayload: (threadId: number, paneId: string, cwd: string, payload: TopicPayload, sessionKey?: string) => Promise<boolean>
  topicSessionState: (binding: TopicBinding & { paneId: string }) => SessionState
  settleAckReaction: (messageId: number, ok: boolean) => Promise<void>
}

/** What one picked session receives: the queue taken from the hold, and who it goes to. */
export interface AttachJob {
  threadId: number
  hold: TopicHold
  target: AgentCandidate
  session: AttachSession
  label: string
}

/** Running tally; kept on one object so a throw mid-delivery still reports what got through. */
export interface AttachProgress {
  outcome: string
  delivered: number
  stopped: string | null
}

/** A tap on a picker message that is no longer the hold's current picker. */
export function isStalePicker(hold: TopicHold, messageId: number | null): boolean {
  return hold.pickerMessageId != null && messageId !== null && messageId !== hold.pickerMessageId
}

/** The one-line result of an attach, edited into the picker (or sent to the topic). */
export function attachSummary(label: string, delivered: number, total: number, stopped: string | null): string {
  const failed = total - delivered
  return `→ ${label}: ${delivered} delivered${failed ? `, ${failed} failed` : ""}${stopped ? ` — ${stopped}` : ""}`
}

/** The registry session behind the picked pane, when the registry knows it. Re-read as the pane is now. */
export function registrySessionForPane(ctx: Ctx, paneId: string): LiveSessionEntry | null {
  const reg = registryForPane(paneId)
  const pickedKey = reg ? resolveLocatorToSession(reg, paneId, undefined) : null
  return pickedKey ? liveEntry(ctx, pickedKey) : null
}

/**
 * "Does this session already have a topic?" and the bind run with no await in between, so
 * two topics picking the same session concurrently can never both bind it. Returns the outcome line.
 */
export async function bindOrLinkTopic(rt: AttachRuntime, job: AttachJob, entry: LiveSessionEntry | null): Promise<string> {
  const { threadId, session, label, target } = job
  const own = entry?.threadId ?? topicForPane(rt.loadTopics(), target.paneId)?.threadId ?? null
  if (own !== null && own !== threadId) {
    const link = topicLink(rt.ctx.chatId, own)
    return `${label} already has its own topic${link ? ` — ${link}` : ""}; this topic stays unlinked`
  }
  if (entry) patchSessionEntry(rt.ctx, entry.key, { threadId })
  rt.updateTopics((current) => appendTopic(current, attachTopic(threadId, session, Math.floor(Date.now() / 1000))))
  await editSessionTopic(rt.ctx, threadId, entry ? topicTitleFor(entry) : sessionTopicTitle(label))
  return `this topic is now ${label}`
}

/** Deliver the queue by session key, like any bound topic's. */
export async function deliverQueueToEntry(rt: AttachRuntime, job: AttachJob, entry: LiveSessionEntry, progress: AttachProgress): Promise<void> {
  for (const payload of job.hold.payloads) {
    const res = await rt.deliverToSession(entry.key, job.threadId, payload)
    if (res.kind === "gone") {
      progress.stopped = `${job.label} stopped before delivery`
      break
    }
    if (!res.ok) continue
    progress.delivered++
    await rt.settleAckReaction(payload.messageId, true)
  }
}

/**
 * Re-verify after the Bot API round-trips: a pane that died and whose `%N` was
 * reused meanwhile must never receive this topic's queue (the same guard the route path applies).
 */
export async function deliverQueueToPane(rt: AttachRuntime, job: AttachJob, progress: AttachProgress): Promise<void> {
  const { threadId, target, session, label, hold } = job
  const state = rt.topicSessionState({ ...attachTopic(threadId, session, 0), paneId: target.paneId })
  if (state.state === "gone") progress.stopped = `${label} stopped before delivery`
  else if (state.state === "unconfirmed") progress.stopped = state.reply
  else {
    for (const payload of hold.payloads) {
      if (!(await rt.deliverTopicPayload(threadId, target.paneId, state.cwd, payload))) continue
      progress.delivered++
      await rt.settleAckReaction(payload.messageId, true)
    }
  }
}

/** Everything after the hold was dropped, up to the summary: bind or link the topic, then deliver. */
export async function bindAndDeliver(rt: AttachRuntime, job: AttachJob, progress: AttachProgress): Promise<void> {
  const entry = registrySessionForPane(rt.ctx, job.target.paneId)
  progress.outcome = await bindOrLinkTopic(rt, job, entry)
  if (entry) await deliverQueueToEntry(rt, job, entry, progress)
  else await deliverQueueToPane(rt, job, progress)
}
