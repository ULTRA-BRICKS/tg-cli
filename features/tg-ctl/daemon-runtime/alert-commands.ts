// daemon-runtime/alert-commands: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { defaultRegistryRoot, listLiveEndpoints, sendLiveMessage } from "../omp-live-runtime.mjs"
import { type OriginalOmpEndpoint } from "../omp-live-routing"
import { validateProblemRemediation } from "../../cli/problem-remediation"
import { decodeTextEscapes } from "../../cli/text-escapes"
import { alertRequestId, alertTag, alertTitle, claimAlert, claimInternalAlert, formatAlertList, markAlertDelivered, markInternalAlertDelivered, reconcileInternalAlertRecipients, pinInternalAlertAttempt, releaseInternalAlertAttempt, InternalReceiptCapacityError, internalAlertRequestId, internalAlertText, internalThrottleKey, nearestLiveAncestor, parseAlertArgv, parseAlertSubscriptions, parseAlertThrottle, parseTgSendOk, removeAlertSubscription, resolveAlertBindings, serializeAlertSubscriptions, serializeAlertThrottle, sessionAlertText, settleAlert, telegramAlertBody, throttleKey, throttleVerdict, upsertAlertSubscription, claimHolder, denyHandoff, grantHandoff, handoffDeniedNote, handoffGrantedNote, handoffRequestNote, holderRefusal, holderRequestId, holderState, holderAlertText, HOLDER_TEXT_MAX_BYTES, holderTakenNote, markHolderDelivery, settleHolderAlert, holderThrottleKey, releaseHolderClaim, deliverWithStaleRetry, refreshHolder, releaseHolder, requestHandoff, withdrawRequest, takeHolder, type AlertHolder, type Claimant, type HolderOutcome, type HolderState, type AlertBinding, type AlertCommand, type AlertMessage, type AlertSubscription, type AlertSubscriptionStore, type AlertThrottleEntry, type AlertThrottleStore, type InternalAlertOwnerStatus, type ThrottleVerdict } from "../alert-subscriptions"
import { formatAge } from "../text-util"
import { fsRoutesLockIo, withRoutesLock } from "../routes"
import { atomicWrite, readFileOrNull, spawnGuarded, type Ctx } from "./ctx-io"
import { ancestorPids, tgBinary } from "./delivery"

// `tg-ctl alert …` (tg-cli#636): temporary alert subscriptions of live omp sessions and the
// alert ingestion used by rig sysmon and the omp-supervisor watcher. Bound state is resolved
// against the omp-live registry here — the extension publishes no events (see
// features/tg-ctl/alert-subscriptions.ts). One-shot: no daemon involved. Both state files
// are read-modify-written under their O_EXCL lockfile (the routes/history protocol): the
// two documented sources fire together on an overloaded machine.
export interface AlertHost {
  ctx: Ctx
  now: number
  endpoints: OriginalOmpEndpoint[]
  registryError: string | null // the omp-live registry could not be read: no binding is trustworthy
}

export async function runAlertCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const command = parseAlertArgv(argv)
  if (command.cmd === "error") {
    console.error(`tg-ctl alert: ${command.error}`)
    return 1
  }
  const host: AlertHost = { ctx, now: Date.now(), endpoints: [], registryError: null }
  try {
    host.endpoints = await listLiveEndpoints(defaultRegistryRoot())
  } catch (err) {
    host.registryError = `omp-live registry unreadable: ${(err as { code?: string }).code ?? err}`
    console.error(`tg-ctl alert: ${host.registryError}`)
  }
  switch (command.cmd) {
    case "list":
      return runAlertList(host, command.json)
    case "subscribe":
      return runAlertSubscribe(host, command)
    case "unsubscribe":
      return runAlertUnsubscribe(host, command)
    case "send":
      return runAlertSend(host, command)
    case "handoff-request":
      return runAlertHandoffRequest(host, command)
    case "handoff":
      return runAlertHandoff(host, command)
    case "take":
      return runAlertTake(host, command)
    case "release":
      return runAlertRelease(host, command)
    case "holder":
      return runAlertHolder(host, command)
  }
}

// Run `body` over the subscription store under its lock and persist what it returns;
// a store nobody can lock within ~2 s is reported, never written unlocked.
export function withAlertSubscriptions<T>(host: AlertHost, body: (store: AlertSubscriptionStore) => { store: AlertSubscriptionStore; result: T }): T | undefined {
  const path = host.ctx.paths.alertSubscriptions
  return withRoutesLock(fsRoutesLockIo(`${path}.lock`), () => {
    const out = body(parseAlertSubscriptions(readFileOrNull(path), host.now))
    atomicWrite(path, serializeAlertSubscriptions(out.store, host.now))
    return out.result
  }, { attempts: 200, onContended: "skip" })
}

export function withAlertThrottle<T>(host: AlertHost, body: (store: AlertThrottleStore) => { store: AlertThrottleStore; result: T }): T | undefined {
  const path = host.ctx.paths.alertThrottle
  return withRoutesLock(fsRoutesLockIo(`${path}.lock`), () => {
    const out = body(parseAlertThrottle(readFileOrNull(path), host.now))
    atomicWrite(path, serializeAlertThrottle(out.store, host.now))
    return out.result
  }, { attempts: 200, onContended: "skip" })
}

export const ALERT_LOCK_BUSY = "state file locked by another tg-ctl alert for over 2 s; nothing changed"

export function runAlertList(host: AlertHost, json: boolean): number {
  const store = parseAlertSubscriptions(readFileOrNull(host.ctx.paths.alertSubscriptions), host.now)
  const bindings = resolveAlertBindings(store, host.endpoints, host.now)
  writeStdoutLine(json ? JSON.stringify(bindings.map((b) => ({ ...b.subscription, state: b.state })), null, 1) : formatAlertList(bindings, host.now))
  return host.registryError && bindings.length > 0 ? 1 : 0
}

export type AlertSessionTarget = { ok: true; sessionId: string; endpoint: OriginalOmpEndpoint | null } | { ok: false; error: string }

// The session a subscribe/unsubscribe names: --session, --pid (a LIVE omp), or the caller's
// own omp (the nearest live omp-live ancestor).
export function resolveAlertSession(host: AlertHost, pid: number | null, sessionId: string | null): AlertSessionTarget {
  if (sessionId !== null) return { ok: true, sessionId, endpoint: host.endpoints.find((e) => e.sessionId === sessionId) ?? null }
  if (pid !== null) {
    const endpoint = host.endpoints.find((e) => e.pid === pid)
    return endpoint ? { ok: true, sessionId: endpoint.sessionId, endpoint } : { ok: false, error: `omp pid ${pid} has no live omp-live endpoint (tg-ctl omp-live status --json)` }
  }
  const endpoint = nearestLiveAncestor(ancestorPids(process.pid), host.endpoints)
  if (endpoint) return { ok: true, sessionId: endpoint.sessionId, endpoint }
  return { ok: false, error: "no live omp session among this process's ancestors (a tmux pane descends from the tmux server, not from omp): pass --pid <omp pid> or --session <omp session id>" }
}

export function runAlertSubscribe(host: AlertHost, command: Extract<AlertCommand, { cmd: "subscribe" }>): Promise<number> | number {
  if (host.registryError) return 1
  if (command.exclusive && command.source !== null) return runAlertExclusiveSubscribe(host, command.source, command)
  const target = resolveAlertSession(host, command.pid, command.sessionId)
  if (!target.ok) {
    console.error(`tg-ctl alert: ${target.error}`)
    return 1
  }
  const subscription = withAlertSubscriptions(host, (store) => {
    const prior = store.subscriptions.find((s) => s.sessionId === target.sessionId)
    const next: AlertSubscription = {
      sessionId: target.sessionId,
      title: target.endpoint?.title ?? prior?.title ?? null,
      pid: target.endpoint?.pid ?? prior?.pid ?? null,
      cwd: target.endpoint?.cwd ?? prior?.cwd ?? null,
      sources: command.sources,
      createdAt: host.now,
      expiresAt: command.ttlMs === null ? null : host.now + command.ttlMs,
    }
    return { store: upsertAlertSubscription(store, next), result: next }
  })
  if (!subscription) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  const state = target.endpoint ? "bound" : "suspended"
  const ttl = command.ttlMs === null ? "no expiry" : `ttl ${formatAge(command.ttlMs)}`
  writeStdoutLine(`subscribed (${state}): ${subscription.title ?? "(untitled)"} · pid ${subscription.pid ?? "?"} · session ${target.sessionId} · sources: ${command.sources?.join(",") ?? "all"} · ${ttl}`)
  return 0
}

// --- exclusive holder (tg-cli#747): one session per source receives `send --to-holder` ---
// Every slot change happens under the subscription-store lock (two sessions claiming at
// once: exactly one wins); notes into sessions are delivered after the lock is released.

export type HolderStep = { outcome: HolderOutcome; state: HolderState; prior: AlertHolder | null; denied?: { sessionId: string } | null }

// The caller of a holder command as a claimant: --session, --pid or the nearest live omp.
// `requireLive`: the acting session must have a live omp-live endpoint (claim, request, take).
export function resolveAlertClaimant(host: AlertHost, pid: number | null, sessionId: string | null, requireLive = false): { ok: true; claimant: Claimant } | { ok: false; error: string } {
  const target = resolveAlertSession(host, pid, sessionId)
  if (!target.ok) return target
  const ep = target.endpoint
  if (requireLive && !ep) return { ok: false, error: `session ${target.sessionId} is not live (no omp-live endpoint)` }
  return { ok: true, claimant: { sessionId: target.sessionId, title: ep?.title ?? null, pid: ep?.pid ?? null, cwd: ep?.cwd ?? null } }
}

// Run one holder rule on the refreshed store under the lock; a refusal persists only the
// refresh. undefined = the lock stayed busy (reported here).
export function holderStep(host: AlertHost, source: string, rule: (store: AlertSubscriptionStore) => HolderOutcome & { denied?: { sessionId: string } | null }): HolderStep | undefined {
  const step = withAlertSubscriptions<HolderStep>(host, (raw) => {
    const store = refreshHolder(raw, source, host.endpoints, host.now)
    const before = holderState(store, source, host.endpoints, host.now)
    const outcome = rule(store)
    return { store: outcome.ok ? outcome.store : store, result: { outcome, state: before.state, prior: before.holder, denied: outcome.denied } }
  })
  if (step === undefined) console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
  return step
}

// Deliver a note into a session when it has a live endpoint; a failure is reported, never fatal.
export async function deliverHolderNote(host: AlertHost, source: string, sessionId: string, text: string): Promise<boolean> {
  const ep = host.endpoints.find((e) => e.sessionId === sessionId)
  if (!ep) return false
  // A resume between listing and sending (new pid, same session) re-resolves once.
  const failure = await deliverWithStaleRetry(
    ep,
    (e) => sendLiveMessage({ root: defaultRegistryRoot(), pid: e.pid, instanceId: e.instanceId, sessionId: e.sessionId, requestId: holderRequestId(source, sessionId, host.now, crypto.randomUUID()), text }),
    async () => (await listLiveEndpoints(defaultRegistryRoot())).find((e) => e.sessionId === sessionId) ?? null,
  )
  if (failure !== null) console.error(`tg-ctl alert: note to session ${sessionId} failed: ${failure}`)
  return failure === null
}

// A refused step: code 3 prints who holds the slot (stdout), code 1 the error (stderr).
export function reportHolderRefusal(host: AlertHost, source: string, step: HolderStep): number {
  const { outcome } = step
  if (outcome.ok) return 0
  if (outcome.code === 1) console.error(`tg-ctl alert: ${outcome.error}`)
  else writeStdoutLine(outcome.holder && step.state !== "vacant" ? `${holderRefusal(source, outcome.holder, step.state, host.now)}\n(${outcome.error})` : outcome.error)
  return outcome.code
}

export const holderLine = (h: AlertHolder): string => `${h.title ?? "(untitled)"} · pid ${h.pid ?? "?"} · session ${h.sessionId}`

export const holderTtl = (h: AlertHolder, now: number): string => (h.expiresAt === null ? "no expiry" : `expires in ${formatAge(h.expiresAt - now)}`)

export function runAlertExclusiveSubscribe(host: AlertHost, source: string, command: Extract<AlertCommand, { cmd: "subscribe" }>): number {
  const caller = resolveAlertClaimant(host, command.pid, command.sessionId, true)
  if (!caller.ok) {
    console.error(`tg-ctl alert: ${caller.error}`)
    return 1
  }
  const step = holderStep(host, source, (store) => claimHolder(store, source, caller.claimant, host.endpoints, host.now, command.ttlMs))
  if (!step) return 1
  if (!step.outcome.ok) return reportHolderRefusal(host, source, step)
  writeStdoutLine(`holder of ${source}: ${holderLine(step.outcome.holder)} · ${holderTtl(step.outcome.holder, host.now)}`)
  return 0
}

export async function runAlertHandoffRequest(host: AlertHost, command: Extract<AlertCommand, { cmd: "handoff-request" }>): Promise<number> {
  if (host.registryError) return 1
  const caller = resolveAlertClaimant(host, command.pid, command.sessionId, true)
  if (!caller.ok) {
    console.error(`tg-ctl alert: ${caller.error}`)
    return 1
  }
  const step = holderStep(host, command.source, (store) => requestHandoff(store, command.source, caller.claimant, host.endpoints, host.now, command.reason))
  if (!step) return 1
  if (!step.outcome.ok) return reportHolderRefusal(host, command.source, step)
  const holder = step.outcome.holder
  const request = holder.request!
  const noted = await deliverHolderNote(host, command.source, holder.sessionId, handoffRequestNote(command.source, holder, request))
  if (!noted) {
    // The holder never saw it: withdraw it so it cannot ripen into a take.
    withAlertSubscriptions(host, (store) => ({ store: withdrawRequest(store, command.source, request.sessionId, request.at), result: null }))
    writeStdoutLine(`FAILED request for ${command.source}: the note did not reach ${holderLine(holder)}; the request was withdrawn — retry later (a holder gone for 10 minutes frees the slot)`)
    return 5
  }
  writeStdoutLine(`requested ${command.source} from ${holderLine(holder)}; the holder was notified; unanswered for 10 minutes, take it with: tg-ctl alert take --source ${command.source}`)
  return 0
}

export async function runAlertHandoff(host: AlertHost, command: Extract<AlertCommand, { cmd: "handoff" }>): Promise<number> {
  if (host.registryError) return 1
  const caller = resolveAlertClaimant(host, command.pid, command.sessionId)
  if (!caller.ok) {
    console.error(`tg-ctl alert: ${caller.error}`)
    return 1
  }
  const { source } = command
  if (command.deny) {
    const step = holderStep(host, source, (store) => denyHandoff(store, source, caller.claimant.sessionId, host.endpoints, host.now))
    if (!step) return 1
    if (!step.outcome.ok) return reportHolderRefusal(host, source, step)
    const denied = step.denied!
    await deliverHolderNote(host, source, denied.sessionId, handoffDeniedNote(source, step.outcome.holder, command.reason))
    writeStdoutLine(`denied the ${source} request of session ${denied.sessionId}`)
    return 0
  }
  const to = command.to!
  const ep = host.endpoints.find((e) => e.sessionId === to)
  const target: Claimant = { sessionId: to, title: ep?.title ?? null, pid: ep?.pid ?? null, cwd: ep?.cwd ?? null }
  const step = holderStep(host, source, (store) => grantHandoff(store, source, caller.claimant.sessionId, target, host.endpoints, host.now))
  if (!step) return 1
  if (!step.outcome.ok) return reportHolderRefusal(host, source, step)
  if (step.prior) await deliverHolderNote(host, source, to, handoffGrantedNote(source, step.prior))
  writeStdoutLine(`handed ${source} to ${holderLine(step.outcome.holder)}`)
  return 0
}

export async function runAlertTake(host: AlertHost, command: Extract<AlertCommand, { cmd: "take" }>): Promise<number> {
  if (host.registryError) return 1
  const caller = resolveAlertClaimant(host, command.pid, command.sessionId, true)
  if (!caller.ok) {
    console.error(`tg-ctl alert: ${caller.error}`)
    return 1
  }
  const step = holderStep(host, command.source, (store) => takeHolder(store, command.source, caller.claimant, host.endpoints, host.now, command.ttlMs))
  if (!step) return 1
  if (!step.outcome.ok) return reportHolderRefusal(host, command.source, step)
  const prior = step.prior
  if (prior && prior.sessionId !== caller.claimant.sessionId) await deliverHolderNote(host, command.source, prior.sessionId, holderTakenNote(command.source, step.outcome.holder))
  writeStdoutLine(`holder of ${command.source}: ${holderLine(step.outcome.holder)} · ${holderTtl(step.outcome.holder, host.now)}`)
  return 0
}

export function runAlertRelease(host: AlertHost, command: Extract<AlertCommand, { cmd: "release" }>): number {
  const caller = resolveAlertClaimant(host, command.pid, command.sessionId)
  if (!caller.ok) {
    console.error(`tg-ctl alert: ${caller.error}`)
    return 1
  }
  const step = holderStep(host, command.source, (store) => releaseHolder(store, command.source, caller.claimant.sessionId))
  if (!step) return 1
  if (!step.outcome.ok) return reportHolderRefusal(host, command.source, step)
  writeStdoutLine(`released ${command.source}`)
  return 0
}

// The slot's state (refreshed under the lock, so a live holder's lastSeenLiveAt advances).
// Exit 3 when vacant; 1 when the registry is unreadable (no state is trustworthy).
export function runAlertHolder(host: AlertHost, command: Extract<AlertCommand, { cmd: "holder" }>): number {
  const { source } = command
  const st = withAlertSubscriptions(host, (raw) => {
    const store = refreshHolder(raw, source, host.endpoints, host.now)
    return { store, result: holderState(store, source, host.endpoints, host.now) }
  })
  if (!st) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  const holder = st.state === "vacant" ? null : st.holder
  if (command.json) {
    const h = holder && { sessionId: holder.sessionId, title: holder.title, pid: holder.pid, cwd: holder.cwd, since: holder.since, lastSeenLiveAt: holder.lastSeenLiveAt, failingSince: holder.failingSince, expiresAt: holder.expiresAt }
    writeStdoutLine(JSON.stringify({ source, state: st.state, holder: h, request: holder?.request ?? null }, null, 1))
  } else if (!holder) {
    writeStdoutLine(`${source}: vacant`)
  } else {
    const request = holder.request ? ` · request from ${holder.request.title ?? "(untitled)"} (session ${holder.request.sessionId}, ${formatAge(host.now - holder.request.at)} ago)` : ""
    writeStdoutLine(`${source}: ${st.state} · ${holderLine(holder)} · since ${formatAge(host.now - holder.since)} · ${holderTtl(holder, host.now)}${request}`)
  }
  if (host.registryError) return 1
  return st.state === "vacant" ? 3 : 0
}

export type AlertUnsubscribeOutcome = { removed: string } | { none: string } | { error: string }

export function runAlertUnsubscribe(host: AlertHost, command: Extract<AlertCommand, { cmd: "unsubscribe" }>): number {
  const outcome = withAlertSubscriptions<AlertUnsubscribeOutcome | number>(host, (store) => {
    if (command.all) return { store: { ...store, subscriptions: [] }, result: store.subscriptions.length }
    // --pid names a LIVE omp first (a pid the OS reused belongs to that session now); only a
    // pid no live endpoint owns falls back to the recorded pid of a closed session.
    const target = resolveAlertSession(host, command.pid, command.sessionId)
    const byRecordedPid = !target.ok && command.pid !== null ? store.subscriptions.find((s) => s.pid === command.pid) : undefined
    const sessionId = target.ok ? target.sessionId : byRecordedPid?.sessionId
    if (sessionId === undefined) return { store, result: { error: target.ok ? "no session named" : target.error } }
    if (!store.subscriptions.some((s) => s.sessionId === sessionId)) return { store, result: { none: sessionId } }
    return { store: removeAlertSubscription(store, sessionId), result: { removed: sessionId } }
  })
  if (outcome === undefined) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  if (typeof outcome === "number") {
    writeStdoutLine(`unsubscribed ${outcome} session(s)`)
    return 0
  }
  if ("error" in outcome) {
    console.error(`tg-ctl alert: ${outcome.error}`)
    return 1
  }
  writeStdoutLine("none" in outcome ? `no subscription for session ${outcome.none}` : `unsubscribed session ${outcome.removed}`)
  return 0
}

export interface AlertDeliveryFailure {
  binding: AlertBinding
  reason: string
}

// Deliver the posted alert into every bound session among `targets`.
export async function deliverAlertToSessions(host: AlertHost, message: AlertMessage, messageId: number, targets: readonly AlertBinding[]): Promise<{ delivered: AlertBinding[]; failed: AlertDeliveryFailure[] }> {
  const text = sessionAlertText(message, messageId)
  const delivered: AlertBinding[] = []
  const failed: AlertDeliveryFailure[] = []
  for (const b of targets) {
    if (!b.endpoint) continue
    try {
      await sendLiveMessage({ root: defaultRegistryRoot(), pid: b.endpoint.pid, instanceId: b.endpoint.instanceId, sessionId: b.endpoint.sessionId, requestId: alertRequestId(messageId, b.endpoint.sessionId), text })
      delivered.push(b)
    } catch (err) {
      failed.push({ binding: b, reason: String((err as { code?: string }).code ?? err) })
    }
  }
  for (const f of failed) console.error(`tg-ctl alert: session delivery failed — ${describeAlertBinding(f.binding)}: ${f.reason}`)
  return { delivered, failed }
}

export function describeAlertBinding(b: AlertBinding): string {
  return `${b.subscription.title ?? "(untitled)"} (pid ${b.subscription.pid ?? "?"})`
}

type AlertSendCommand = Extract<AlertCommand, { cmd: "send" }>

export async function runAlertSend(host: AlertHost, command: AlertSendCommand): Promise<number> {
  if (command.toHolder) return runAlertSendToHolder(host, command)
  const { message, windowMs, force } = command
  // Judge the exact body `tg` will post: escape sequences decoded as `tg` does, plain text HTML-escaped
  // there, so `<url>` is text, not a tag.
  if (alertTag(message.severity) === "problem" && !validateProblemRemediation(decodeTextEscapes(telegramAlertBody(message, []))).ok) {
    return runInternalAlertSend(host, command, "withheld")
  }
  const key = throttleKey(message.source, message.key, message.severity)

  // 1. Under the lock: the verdict, and a claim when this send is the one to post.
  const verdict = claimThrottleSlot(host, key, force, windowMs)
  if (verdict === undefined) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  if (verdict.kind === "in-flight") {
    writeStdoutLine(`in flight: another tg-ctl alert is posting ${message.source}/${message.key}/${message.severity} (claimed ${formatAge(host.now - verdict.entry.at)} ago)`)
    return 0
  }
  if (verdict.kind === "throttled") return redeliverThrottledAlert(host, message, windowMs, key, verdict.entry)

  // 2. Post to Telegram (outside the lock; `tg` may take a while).
  const posted = await postAlertToTelegram(message, boundSessions(host, message.source))
  if (!posted.ok) return failAlertPost(host, command, key, posted)

  // 3. Deliver into the sessions bound NOW (a session resumed while `tg` ran has a new
  //    endpoint), then settle the claim with the ones not reached.
  return deliverPostedAlert(host, message, key, posted.messageId)
}

// Judge the throttle for `key` under the lock and claim it when this send is the one to
// act; undefined = the lock stayed busy (the caller reports it).
function claimThrottleSlot(host: AlertHost, key: string, force: boolean, windowMs: number): ThrottleVerdict | undefined {
  return withAlertThrottle(host, (store) => {
    const v: ThrottleVerdict = force ? { kind: "send" } : throttleVerdict(store, key, host.now, windowMs)
    return { store: v.kind === "send" ? claimAlert(store, key, host.now) : store, result: v }
  })
}

// The subscriptions of `source` whose session has a live endpoint right now.
function boundSessions(host: AlertHost, source: string): AlertBinding[] {
  const store = parseAlertSubscriptions(readFileOrNull(host.ctx.paths.alertSubscriptions), host.now)
  return resolveAlertBindings(store, host.endpoints, host.now, source).filter((b) => b.state === "bound")
}

// Posted inside the window: no second post; the sessions it did not reach get it now.
async function redeliverThrottledAlert(host: AlertHost, message: AlertMessage, windowMs: number, key: string, entry: AlertThrottleEntry): Promise<number> {
  const messageId = entry.messageId!
  const pending = boundSessions(host, message.source).filter((b) => entry.pending.includes(b.subscription.sessionId))
  const { delivered, failed } = await deliverAlertToSessions(host, message, messageId, pending)
  if (delivered.length > 0) withAlertThrottle(host, (store) => ({ store: markAlertDelivered(store, key, delivered.map((b) => b.subscription.sessionId)), result: null }))
  const extra = delivered.length > 0 ? `; delivered to ${delivered.length} pending session(s)` : ""
  writeStdoutLine(`throttled tg#${messageId} (${message.source}/${message.key}/${message.severity} sent ${formatAge(host.now - entry.at)} ago, window ${formatAge(windowMs)}${extra})`)
  return failed.length > 0 ? 1 : 0
}

type TelegramPost = { ok: true; messageId: number } | { ok: false; why: string; output: string; refusedContent: boolean }

// `tg` has no `--` end-of-options, so a body starting with `-` would be read as an unknown
// flag; a leading space (trimmed by `tg`) keeps it text.
async function postAlertToTelegram(message: AlertMessage, bound: AlertBinding[]): Promise<TelegramPost> {
  const body = telegramAlertBody(message, bound)
  const tgArgv = [tgBinary(), "--format", "html", "--automated", "--tag", alertTag(message.severity), "--subagent", message.source, "--title", alertTitle(message), body.startsWith("-") ? ` ${body}` : body]
  const posted = await spawnGuarded(tgArgv, 60_000)
  const messageId = posted.exitCode === 0 ? parseTgSendOk(posted.stdout) : null
  if (messageId !== null) return { ok: true, messageId }
  const why = posted.exitCode === 0 ? "tg exited 0 but printed no `OK tg#<id>` line" : `tg exit ${posted.exitCode}`
  // `tg` refused the content itself (its classifier found no actual attempts/results): a withheld
  // report, not a transport failure the holder should wait on.
  const refusedContent = posted.exitCode === 1 && posted.stderr.includes("Blocked: nothing was sent")
  return { ok: false, why, output: (posted.stderr || posted.stdout).trim().slice(-300) || "no output", refusedContent }
}

// A failed owner post: the claim is released so the monitor's retry posts again.
async function failAlertPost(host: AlertHost, command: AlertSendCommand, key: string, failure: { why: string; output: string; refusedContent: boolean }): Promise<number> {
  withAlertThrottle(host, (store) => ({ store: settleAlert(store, key, null, []), result: null }))
  console.error(`tg-ctl alert: Telegram post failed (${failure.why}): ${failure.output}`)
  if (alertTag(command.message.severity) === "problem") {
    if (failure.refusedContent) return runInternalAlertSend(host, command, "withheld")
    await runInternalAlertSend(host, command, "unconfirmed")
    return 1 // Internal acceptance does not confirm the owner post; its retry stays eligible.
  }
  writeStdoutLine("FAILED tg#? sessions=0")
  return 1
}

async function deliverPostedAlert(host: AlertHost, message: AlertMessage, key: string, messageId: number): Promise<number> {
  try {
    host.endpoints = await listLiveEndpoints(defaultRegistryRoot())
  } catch {
    /* keep the snapshot: the registry was readable a moment ago */
  }
  const { delivered, failed } = await deliverAlertToSessions(host, message, messageId, boundSessions(host, message.source))
  const settled = withAlertThrottle(host, (store) => ({ store: settleAlert(store, key, messageId, failed.map((f) => f.binding.subscription.sessionId)), result: true }))
  if (settled === undefined) console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY} (the claim expires by itself)`)
  const names = delivered.length ? ` (${delivered.map(describeAlertBinding).join("; ")})` : ""
  writeStdoutLine(`OK tg#${messageId} sessions=${delivered.length}${names}${failed.length ? ` failed=${failed.length}` : ""}`)
  return failed.length > 0 || host.registryError !== null ? 1 : 0
}

// Raw incidents need an investigator before they can become truthful owner problem
// reports. Preserve the exclusive holder, even when suspended/unreachable; ordinary
// subscribers are eligible only when that source's holder slot is actually vacant.
export async function runInternalAlertSend(host: AlertHost, command: AlertSendCommand, owner: InternalAlertOwnerStatus): Promise<number> {
  const { message } = command
  if (host.registryError) return 1
  try {
    host.endpoints = await listLiveEndpoints(defaultRegistryRoot())
  } catch (err) {
    console.error(`tg-ctl alert: internal recipient registry unavailable: ${String(err)}`)
    writeStdoutLine(`FAILED owner=${owner} sessions=0`)
    return 1
  }
  const selected = selectInternalRecipients(host, message.source)
  if (!selected) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  if (selected.targets.length === 0) {
    writeStdoutLine(`VACANT owner=${owner} sessions=0 (${message.source}/${message.key}/${message.severity}; no holder or subscribed session)`)
    return 3
  }
  const text = internalAlertText(message, owner)
  if (Buffer.byteLength(text) > HOLDER_TEXT_MAX_BYTES) {
    console.error(`tg-ctl alert: the internal copy exceeds ${HOLDER_TEXT_MAX_BYTES} bytes (shorten --text)`)
    return 1
  }
  const key = internalThrottleKey(message, selected.holder?.sessionId ?? null)
  const prepared = prepareInternalReceipt(host, command, owner, key, text, selected.targets)
  if ("exit" in prepared) return prepared.exit
  const tally = await deliverInternalPending(host, message.source, selected, key, prepared.entry)
  return settleInternalSend(host, command, owner, selected.holder, key, prepared, tally)
}

type InternalTarget = { sessionId: string; endpoint: OriginalOmpEndpoint | null }
type InternalRecipients = { holder: AlertHolder | null; targets: InternalTarget[] }
type InternalReceipt = { first: boolean; entry: AlertThrottleEntry }
type InternalTally = { delivered: string[]; failures: string[]; uncertain: string[] }

// The exclusive holder when the slot is held (even suspended), else every subscriber of
// the source. undefined = the subscription store stayed locked (reported by the caller).
function selectInternalRecipients(host: AlertHost, source: string): InternalRecipients | undefined {
  return withAlertSubscriptions(host, (raw) => {
    const store = refreshHolder(raw, source, host.endpoints, host.now)
    const st = holderState(store, source, host.endpoints, host.now)
    const holder = st.state === "vacant" ? null : st.holder
    const targets = holder
      ? [{ sessionId: holder.sessionId, endpoint: st.endpoint }]
      : resolveAlertBindings(store, host.endpoints, host.now, source)
        .map((binding) => ({ sessionId: binding.subscription.sessionId, endpoint: binding.endpoint }))
    return { store, result: { holder, targets } }
  })
}

// Persist (or reconcile) the immutable internal receipt BEFORE any delivery. A refusal
// is reported here and comes back as the exit code.
function prepareInternalReceipt(host: AlertHost, command: AlertSendCommand, owner: InternalAlertOwnerStatus, key: string, text: string, targets: readonly InternalTarget[]): InternalReceipt | { exit: number } {
  const { windowMs, force } = command
  let prepared: InternalReceipt | undefined
  try {
    prepared = withAlertThrottle(host, (store) => {
      const verdict = force ? { kind: "send" as const } : throttleVerdict(store, key, host.now, windowMs)
      const sessions = targets.map((target) => target.sessionId)
      const next = verdict.kind === "send"
        ? claimInternalAlert(store, key, host.now, text, sessions) : reconcileInternalAlertRecipients(store, key, verdict.entry.at, sessions)
      return { store: next, result: { first: verdict.kind === "send", entry: next.sent.find((entry) => entry.key === key)! } }
    })
  } catch (error) {
    if (!(error instanceof InternalReceiptCapacityError)) throw error
    console.error(`tg-ctl alert: ${error.message}`)
    writeStdoutLine(`FAILED owner=${owner} sessions=0 (${error.code}; no delivery attempted)`)
    return { exit: 1 }
  }
  if (!prepared) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return { exit: 1 }
  }
  if (prepared.entry.internalText === undefined || prepared.entry.messageId !== 0) {
    console.error("tg-ctl alert: internal receipt unavailable; no delivery attempted")
    return { exit: 1 }
  }
  return prepared
}

// Send the receipt's text to every target it still lists as pending, one by one.
async function deliverInternalPending(host: AlertHost, source: string, selected: InternalRecipients, key: string, entry: AlertThrottleEntry): Promise<InternalTally> {
  const tally: InternalTally = { delivered: [], failures: [], uncertain: [] }
  for (const target of selected.targets.filter((target) => entry.pending.includes(target.sessionId))) {
    if (!target.endpoint) continue
    const failure = await sendInternalCopy(host, key, entry, target.endpoint, target.sessionId)
    recordInternalOutcome(tally, target.sessionId, failure)
    // Refusing a replay because history is uncertain does not make a live holder stale.
    if (selected.holder && !(failure?.startsWith("internal_") ?? false)) {
      const holder = selected.holder
      withAlertSubscriptions(host, (store) => ({ store: markHolderDelivery(store, source, holder.sessionId, holder.since, failure === null, Date.now()), result: null }))
    }
  }
  return tally
}

// null = the session accepted it (or had already acknowledged this very receipt).
async function sendInternalCopy(host: AlertHost, key: string, entry: AlertThrottleEntry, endpoint: OriginalOmpEndpoint, sessionId: string): Promise<string | null> {
  const outcome = await deliverWithStaleRetry(
    endpoint,
    (ep) => sendPinnedInternalFrame(host, key, entry, ep),
    async () => (await listLiveEndpoints(defaultRegistryRoot())).find((ep) => ep.sessionId === sessionId) ?? null,
  )
  return outcome === "internal_receipt_acknowledged" ? null : outcome
}

// One frame to one endpoint generation, its pin recorded durably first. `stale_identity` is answered
// before the host reads the frame, so nothing was accepted and THIS attempt's pin goes — letting the
// re-resolved endpoint be tried. A pin an earlier attempt left (`ready`) may have written a frame
// and is never released here: that uncertainty rule is what stops a replay across generations.
export async function sendPinnedInternalFrame(host: AlertHost, key: string, entry: AlertThrottleEntry, ep: OriginalOmpEndpoint, send: typeof sendLiveMessage = sendLiveMessage): ReturnType<typeof sendLiveMessage> {
  let createdPin = false
  try {
    return await send({ root: defaultRegistryRoot(), pid: ep.pid, instanceId: ep.instanceId, sessionId: ep.sessionId,
      requestId: internalAlertRequestId(key, entry.at, ep.sessionId), text: entry.internalText!,
      beforeSend: (current: OriginalOmpEndpoint) => {
        const pinned = tryPinInternalAttempt(host, key, entry.at, current)
        if (pinned !== "pinned" && pinned !== "ready") throw Object.assign(new Error(pinned ?? "internal_receipt_unavailable"), { code: pinned ?? "internal_receipt_unavailable" })
        createdPin = pinned === "pinned"
      } })
  } catch (err) {
    if (createdPin && (err as { code?: string }).code === "stale_identity") releaseCreatedPin(host, key, entry.at, ep)
    throw err
  }
}

function releaseCreatedPin(host: AlertHost, key: string, claimAt: number, ep: OriginalOmpEndpoint): void {
  try { withAlertThrottle(host, (store) => ({ store: releaseInternalAlertAttempt(store, key, claimAt, { sessionId: ep.sessionId, pid: ep.pid, instanceId: ep.instanceId }), result: null })) }
  catch { /* the pin stays: the retry is refused as uncertain, never replayed */ }
}

// Record the generation about to receive the frame, durably, before any byte is written.
function tryPinInternalAttempt(host: AlertHost, key: string, claimAt: number, current: OriginalOmpEndpoint) {
  try {
    return withAlertThrottle(host, (store) => pinInternalAlertAttempt(store, key, claimAt, current))
  } catch {
    return undefined // no durable pin: the caller aborts before writing any frame
  }
}

function recordInternalOutcome(tally: InternalTally, sessionId: string, failure: string | null): void {
  if (failure === null) {
    tally.delivered.push(sessionId)
    return
  }
  tally.failures.push(sessionId)
  console.error(`tg-ctl alert: internal delivery unconfirmed — session ${sessionId}: ${failure}`)
  if (failure === "internal_delivery_uncertain") {
    tally.uncertain.push(sessionId)
    console.error("tg-ctl alert: prior delivery may have been accepted by another endpoint generation; reconcile session history before an explicit --force")
  }
}

// Mark who got it, print the one-line verdict and map it to the exit code.
function settleInternalSend(host: AlertHost, command: AlertSendCommand, owner: InternalAlertOwnerStatus, holder: AlertHolder | null, key: string, receipt: InternalReceipt, tally: InternalTally): number {
  const { message } = command
  const { entry, first } = receipt
  const { delivered, failures, uncertain } = tally
  const remaining = entry.pending.filter((session) => !delivered.includes(session))
  const saved = withAlertThrottle(host, (store) => ({ store: markInternalAlertDelivered(store, key, entry.at, delivered), result: true }))
  if (saved === undefined) console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY} (original pending receipt retained for a safe retry)`)
  const suspended = remaining.length > 0 && delivered.length === 0 && failures.length === 0
  const label = suspended ? "SUSPENDED" : first ? "INTERNAL" : "throttled internal"
  const prefix = uncertain.length > 0 ? "UNCERTAIN" : label
  writeStdoutLine(`${prefix} owner=${owner} sessions=${delivered.length} pending=${remaining.length}${holder ? ` holder=${holder.sessionId}` : ""} (${message.source}/${message.key}/${message.severity})`)
  if (saved === undefined) return 1
  if (remaining.length === 0) return 0
  return holder ? 5 : 1
}

// `send --to-holder` (tg-cli#747): deliver into the source's exclusive holder ONLY — never
// Telegram (no `tg` spawn), never the non-exclusive subscribers. The holder state is read
// (and a bound holder's liveness refreshed) BEFORE any throttle claim, so a vacant or
// suspended slot leaves no claim behind. A delivery then claims the holder's own throttle key
// (holderThrottleKey: a handoff starts the new holder's window afresh); a failed one releases
// its own claim so the monitor's retry delivers. Known limit: delivery
// runs outside the store lock, so a send that picked the holder just before a handoff may
// still reach the previous holder; the next send goes to the new one.
// Exit 0 ok/throttled, 1 error, 3 vacant, 5 suspended or failed.
export async function runAlertSendToHolder(host: AlertHost, command: Extract<AlertCommand, { cmd: "send" }>): Promise<number> {
  const { message, windowMs, force } = command
  const { source } = message
  if (host.registryError) return 1
  const text = holderAlertText(message)
  if (Buffer.byteLength(text) > HOLDER_TEXT_MAX_BYTES) {
    console.error(`tg-ctl alert: the holder copy is ${Buffer.byteLength(text)} bytes; the omp-live limit is ${HOLDER_TEXT_MAX_BYTES} (shorten --text)`)
    return 1
  }
  const st = withAlertSubscriptions(host, (raw) => {
    const store = refreshHolder(raw, source, host.endpoints, host.now)
    return { store, result: holderState(store, source, host.endpoints, host.now) }
  })
  if (st === undefined) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  if (st.state === "vacant" || !st.holder) {
    writeStdoutLine(`VACANT ${source}`)
    return 3
  }
  const holder = st.holder
  if (st.state === "suspended" || !st.endpoint) {
    writeStdoutLine(`SUSPENDED ${source} ${holder.sessionId}`)
    return 5
  }

  const key = holderThrottleKey(holder.sessionId, source, message.key, message.severity)
  const verdict = claimThrottleSlot(host, key, force, windowMs)
  if (verdict === undefined) {
    console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY}`)
    return 1
  }
  const what = `${source}/${message.key}/${message.severity}`
  if (verdict.kind === "in-flight") {
    writeStdoutLine(`in flight: another tg-ctl alert is delivering ${what} to the holder (claimed ${formatAge(host.now - verdict.entry.at)} ago)`)
    return 0
  }
  if (verdict.kind === "throttled") {
    writeStdoutLine(`throttled holder (${what} delivered ${formatAge(host.now - verdict.entry.at)} ago, window ${formatAge(windowMs)})`)
    return 0
  }

  const failure = await deliverWithStaleRetry(
    st.endpoint,
    (ep) => sendLiveMessage({ root: defaultRegistryRoot(), pid: ep.pid, instanceId: ep.instanceId, sessionId: ep.sessionId, requestId: holderRequestId(source, ep.sessionId, host.now, crypto.randomUUID()), text }),
    async () => (await listLiveEndpoints(defaultRegistryRoot())).find((e) => e.sessionId === holder.sessionId) ?? null,
  )
  const now = Date.now()
  withAlertSubscriptions(host, (store) => ({ store: markHolderDelivery(store, source, holder.sessionId, holder.since, failure === null, now), result: null }))
  const settled = withAlertThrottle(host, (store) => ({ store: failure === null ? settleHolderAlert(store, key, host.now) : releaseHolderClaim(store, key, host.now), result: true }))
  if (settled === undefined) console.error(`tg-ctl alert: ${ALERT_LOCK_BUSY} (the claim expires by itself)`)
  if (failure !== null) {
    writeStdoutLine(`FAILED holder ${holder.sessionId}: ${failure}`)
    return 5
  }
  writeStdoutLine(`OK holder ${holder.sessionId} pid ${st.endpoint.pid}`)
  return 0
}
