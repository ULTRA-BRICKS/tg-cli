// daemon-runtime/inbound-inject-delivery: the "type this text into ONE specific pane" delivery paths
// (an omp original-process bridge, a rig-wrapper host, a deferred queue entry, or tmux send-keys) used by
// inbound-inject.ts's closure-bound routing. Extracted from the factory (guardian-817) so each delivery
// target is a named step; none of these keep state — everything they need arrives through `PaneDeliveryEnv`.
import { buildTextInjectPlan, wrapInbound } from "../inject"
import { findAgentInPane } from "../discover"
import { liveOmpForPane } from "../omp"
import { deliverHostPane, deliverOriginalOmp, injectInbound, paneSessionRefusal } from "./delivery"
import { log } from "./ctx-io"
import { sendMessage } from "./telegram-api"
import { listLiveOmpAgents } from "./session-registry"
import { snapshot } from "./tmux-probe"
import type { Ctx } from "./ctx-io"
import type { DeferQueueApi } from "./defer-queue"
import type { TargetRoutingApi } from "./target-routing"
import type { DeferredInbound } from "./daemon-types"

/** The closure-bound collaborators every pane delivery shares. */
export interface PaneDeliveryEnv {
  ctx: Ctx
  recordLastUserTarget: TargetRoutingApi["recordLastUserTarget"]
  shouldDeferInbound: DeferQueueApi["shouldDeferInbound"]
  enqueueDeferred: DeferQueueApi["enqueueDeferred"]
  markDeferredForAck: DeferQueueApi["markDeferredForAck"]
}

export type PaneInjectOutcome = { ok: boolean; error?: string; deferred?: boolean; deferredItem?: DeferredInbound }

type SinkOutcome = { ok: true } | { ok: false; error: string }

const OMP_PANE_PREFIX = "omp:"

/** The `{ ok, error }` shape injectToPane reports for a delivery sink's result. */
export function outcomeOf(res: SinkOutcome): PaneInjectOutcome {
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/** A routable message body: `deferText` itself when it carries text, null for undefined/whitespace-only. */
export function routableText(deferText: string | undefined): string | null {
  return deferText !== undefined && deferText.trim() !== "" ? deferText : null
}

// Inject a wrapped message into ONE specific pane (the /agent target). The
// plan's verify-pane step still re-checks the pane hosts an agent first.
export async function injectWrappedToPane(
  env: PaneDeliveryEnv,
  paneId: string,
  from: string,
  msg: string,
  sourceMessageId: number | null,
  deferReactionViaAck = false,
): Promise<PaneInjectOutcome> {
  const { ctx, shouldDeferInbound, enqueueDeferred, markDeferredForAck } = env
  // `sourceMessageId` was accepted here for deferred-queue bookkeeping (see
  // enqueueDeferred below) but never forwarded into wrapInbound — every
  // /agent-routed inbound (direct hit, defer flush, and the ambiguous-picker
  // confirm) silently lost its `tg#<id>` wrap tag while the generic
  // auto-bind inject path (which does pass its messageId) kept it. Forward
  // it here so `/agent <selector> <text>` gets the same `tg#<id>` tag as
  // every other inbound path.
  const wrapped = wrapInbound(ctx.cfg.injectWrap, from, msg, sourceMessageId ?? undefined)
  if (paneId.startsWith(OMP_PANE_PREFIX)) return injectWrappedToOmpPid(paneId, wrapped, sourceMessageId)
  // A hosted session asks its questions unscoped (no TMUX_PANE), which defers every target
  // (paneHasPendingQuestion): such a message waits in the queue below, never typed into the prompt.
  const hostDelivery = shouldDeferInbound(paneId) ? null : deliverHostPane(paneId, wrapped, sourceMessageId)
  if (hostDelivery) return outcomeOf(await hostDelivery)
  if (shouldDeferInbound(paneId)) {
    const item = enqueueDeferred(paneId, wrapped, sourceMessageId)
    if (deferReactionViaAck) markDeferredForAck(item)
    return { ok: true, deferred: true, deferredItem: item }
  }
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === paneId)
  const hosted = pane ? findAgentInPane(pane, procs) : null
  if (hosted?.agent === "omp") {
    const live = liveOmpForPane(listLiveOmpAgents(), paneId, hosted.pid)
    const cwd = pane?.panePath || live?.cwd || "/"
    log(`injectToPane: omp original-process pane=${paneId} cwd=${cwd} (endpoint first; own-pane tmux only without one)`)
    return outcomeOf(await deliverOriginalOmp(live ?? { cwd, pid: hosted.pid }, wrapped, sourceMessageId ?? undefined, paneId))
  }
  return outcomeOf(await injectInbound(sourceMessageId, paneId, buildTextInjectPlan(paneId, wrapped)))
}

// An out-of-tmux omp (`omp:<pid>`) is reached through its original-process bridge, never send-keys.
async function injectWrappedToOmpPid(paneId: string, wrapped: string, sourceMessageId: number | null): Promise<PaneInjectOutcome> {
  const pid = Number(paneId.slice(OMP_PANE_PREFIX.length))
  const live = listLiveOmpAgents().find((a) => a.pid === pid)
  if (!live) return { ok: false, error: `omp ${paneId} is no longer running` }
  const cwd = live.cwd ?? "/"
  log(`injectToPane: omp original-process pane=${paneId} cwd=${cwd} (not tmux send-keys)`)
  return outcomeOf(await deliverOriginalOmp(live, wrapped, sourceMessageId ?? undefined, live.paneId))
}

export interface PrewrappedOptions {
  // A topic delivery answers errors in its topic and never moves the flat-chat anchor.
  out?: Record<string, unknown>
  recordAnchor?: boolean
  // `sessionKey`: the registry session this is for — a pane must still host THAT session
  // (spec §2.6), checked before typing or queueing behind an open question.
  sessionKey?: string
}

// The pane/cwd the tg-cli#78 anchor moves to after a confirmed delivery; null leaves the anchor alone.
type AnchorTarget = { paneId: string; cwd: string } | null

// A delivery's outcome: a failure is answered in `out`; a success optionally moves the anchor.
async function settlePrewrapped(env: PaneDeliveryEnv, res: SinkOutcome, out: Record<string, unknown>, anchor: AnchorTarget): Promise<boolean> {
  if (!res.ok) {
    await sendMessage(env.ctx, res.error, out)
    return false
  }
  if (anchor) env.recordLastUserTarget(anchor.paneId, anchor.cwd)
  return true
}

// Inject already-wrapped text into one pane. `cwd` is REQUIRED, not optional (review finding):
// both call sites already have the target's live `panePath` on hand, and an optional `cwd`
// would let a future caller silently omit it — recordLastUserTarget then treats a missing cwd
// as "invalidate the anchor" (tg-cli#78), so a forgotten argument here would silently wipe
// the CTO's anchor on every delivery through this path.
export async function injectPrewrappedToPaneWith(
  env: PaneDeliveryEnv,
  paneId: string,
  prewrappedText: string,
  sourceMessageId: number | null,
  cwd: string,
  { out = {}, recordAnchor = true, sessionKey }: PrewrappedOptions = {},
): Promise<boolean> {
  const { ctx, shouldDeferInbound, enqueueDeferred, markDeferredForAck } = env
  if (paneId.startsWith(OMP_PANE_PREFIX)) return injectPrewrappedToOmpPid(env, paneId, prewrappedText, sourceMessageId, out, recordAnchor)
  const anchor = recordAnchor ? { paneId, cwd } : null
  const hostDelivery = shouldDeferInbound(paneId) ? null : deliverHostPane(paneId, prewrappedText, sourceMessageId)
  if (hostDelivery) return settlePrewrapped(env, await hostDelivery, out, anchor)
  const refusal = paneSessionRefusal(sessionKey, paneId)
  if (refusal !== null) {
    await sendMessage(ctx, refusal, out)
    return false
  }
  if (shouldDeferInbound(paneId)) {
    markDeferredForAck(enqueueDeferred(paneId, prewrappedText, sourceMessageId, null, sessionKey))
    // A media `/agent` caption is an explicit CTO routing choice, same as its
    // text equivalent — record the tg-cli#78 anchor (review finding: this path
    // was the one remaining explicit-routing gap).
    if (anchor) env.recordLastUserTarget(anchor.paneId, anchor.cwd)
    return true
  }
  const { panes, procs } = snapshot()
  const pane = panes.find((p) => p.paneId === paneId)
  const hosted = pane ? findAgentInPane(pane, procs) : null
  if (hosted?.agent === "omp") {
    const live = liveOmpForPane(listLiveOmpAgents(), paneId, hosted.pid)
    log(`injectPrewrapped: omp original-process pane=${paneId} cwd=${cwd} (endpoint first; own-pane tmux only without one)`)
    const res = await deliverOriginalOmp(live ?? { cwd: cwd || "/", pid: hosted.pid }, prewrappedText, sourceMessageId ?? undefined, paneId)
    return settlePrewrapped(env, res, out, anchor)
  }
  const res = await injectInbound(sourceMessageId, paneId, buildTextInjectPlan(paneId, prewrappedText, { sessionKey }))
  return settlePrewrapped(env, res, out, anchor)
}

// An out-of-tmux omp (`omp:<pid>`): original-process bridge, anchored on the omp's own cwd.
async function injectPrewrappedToOmpPid(
  env: PaneDeliveryEnv,
  paneId: string,
  prewrappedText: string,
  sourceMessageId: number | null,
  out: Record<string, unknown>,
  recordAnchor: boolean,
): Promise<boolean> {
  const pid = Number(paneId.slice(OMP_PANE_PREFIX.length))
  const live = listLiveOmpAgents().find((a) => a.pid === pid)
  if (!live) {
    await sendMessage(env.ctx, `omp ${paneId} is no longer running`, out)
    return false
  }
  const ompCwd = live.cwd ?? "/"
  log(`injectPrewrapped: omp original-process pane=${paneId} cwd=${ompCwd} (not tmux send-keys)`)
  const res = await deliverOriginalOmp(live, prewrappedText, sourceMessageId ?? undefined, live.paneId)
  return settlePrewrapped(env, res, out, recordAnchor ? { paneId, cwd: ompCwd } : null)
}
