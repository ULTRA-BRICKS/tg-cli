// daemon-runtime/harness-event: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { closeSync, openSync } from "fs"
import { dirname } from "path"
import { codexUsageTranscriptPath, latestCodexUsageTelemetryPayload } from "../codex-usage"
import { buildTextInjectPlan } from "../inject"
import { buildCodexHardLimitDiagnostic, buildLimitNotification, buildTransientAutoContinue, buildUsageLimitNotification, extractAssistantText, extractFailure, extractUsageLimitEvents, formatDelta, type TransientAutoContinuePlan, type HarnessFailureEvent } from "../limits"
import { reactionForStage } from "../reactions"
import { fsRoutesLockIo, withRoutesLock } from "../routes"
import { log, readFileOrNull, readFileTailOrNull, readStdinText, type Ctx } from "./ctx-io"
import { OVERLOAD_AUTO_CONTINUE_MAX_ATTEMPTS, OVERLOAD_RETRY_RESET_MS, claimUsageWarning, clearUsageWarningClaim, finishOverloadRetryRecord, latestAnyUsageLatest, latestRecentUsageLatest, overloadRetryChildAlive, overloadRetryChildMatches, overloadRetryKey, overloadRetryLockPath, overloadRetrySameScope, parseHarnessEventFlags, parseOverloadRetryRecords, recordUsageLatest, runtimeOverloadAutoContinueDelayMs, strField, terminateSpawnedRetry, type HarnessEventFlags, writeOverloadRetryRecords } from "./usage-records"
import { CODEX_TRANSCRIPT_TAIL_BYTES, OVERLOAD_RETRY_LOCK_ATTEMPTS, OVERLOAD_RETRY_LOCK_DELAY_MS } from "./constants"
import { listAgentCandidates } from "./pane-discovery"
import { executeInjectStepsSync } from "./delivery"
import { sendMessage, setMessageReaction } from "./telegram-api"
import { rootScriptPath } from "./root-script"

type OverloadRetryRecord = ReturnType<typeof parseOverloadRetryRecords>[number]

// null = do not (re)arm: a live child already owns the pending retry, or the
// attempt budget inside the reset window is exhausted.
function nextOverloadAttempt(prev: OverloadRetryRecord | undefined, now: number): number | null {
  if (!prev) return 1
  if (prev.nextAt > now) return overloadRetryChildAlive(prev) ? null : prev.attempt
  const recent = prev.lastFailureAt > now - OVERLOAD_RETRY_RESET_MS
  if (recent && prev.attempt >= OVERLOAD_AUTO_CONTINUE_MAX_ATTEMPTS) return null
  return recent ? prev.attempt + 1 : 1
}

function persistOverloadRetry(ctx: Ctx, records: OverloadRetryRecord[], entry: OverloadRetryRecord, spawnedPid: number, paneId: string, windowName: string): void {
  const replaced = records.filter((rec) => overloadRetrySameScope(rec, paneId, windowName))
  const next = records.filter((rec) => !overloadRetrySameScope(rec, paneId, windowName))
  next.push(entry)
  try {
    writeOverloadRetryRecords(ctx.paths.overloadRetries, next)
  } catch (err) {
    terminateSpawnedRetry(spawnedPid)
    throw err
  }
  for (const rec of replaced) {
    if (rec.pid !== null && rec.pid !== spawnedPid && overloadRetryChildMatches(rec.pid, rec.key)) terminateSpawnedRetry(rec.pid)
  }
}

export function claimOverloadAutoContinue(
  ctx: Ctx,
  ev: HarnessFailureEvent,
  now: number,
  language: string | null,
  windowName: string | null,
): TransientAutoContinuePlan | null {
  if (!ev.paneId || !windowName) return null
  const paneId = ev.paneId
  try {
    const claimed = withRoutesLock(
      fsRoutesLockIo(overloadRetryLockPath(ctx.paths.overloadRetries)),
      () => {
        const key = overloadRetryKey(ev, windowName)
        const records = parseOverloadRetryRecords(readFileOrNull(ctx.paths.overloadRetries), now)
        const attempt = nextOverloadAttempt(records.find((rec) => rec.key === key), now)
        if (attempt === null) return null
        const built = buildTransientAutoContinue(ev, { attempt, language })
        if (!built) return null
        const plan = { ...built, delayMs: runtimeOverloadAutoContinueDelayMs(built.delayMs) }
        const spawned = spawnDelayedAutoContinue(ctx, ev, plan, windowName, key)
        if (!spawned) return null
        persistOverloadRetry(ctx, records, { key, attempt, pid: spawned.pid, lastFailureAt: now, nextAt: now + plan.delayMs }, spawned.pid, paneId, windowName)
        return plan
      },
      { attempts: OVERLOAD_RETRY_LOCK_ATTEMPTS, delayMs: OVERLOAD_RETRY_LOCK_DELAY_MS, onContended: "skip" },
    )
    return claimed ?? null
  } catch (err) {
    log(`harness-event: overload auto-continue claim failed: ${err}`)
    return null
  }
}

export function hasHarnessFailureSignal(payloadText: string, flags: HarnessEventFlags, hasUsageTelemetry = false): boolean {
  if (flags.reason || flags.resetAtIso || flags.transcriptPath) return true
  let payload: unknown = null
  try {
    payload = JSON.parse(payloadText)
  } catch {
    return payloadText.trim().length > 0
  }
  if (!payload || typeof payload !== "object") return false
  const hookEventName = strField(payload, "hook_event_name")
  return Boolean(
    hookEventName === "StopFailure" ||
      strField(payload, "reason") ||
      strField(payload, "matcher") ||
      strField(payload, "error") ||
      strField(payload, "error_type") ||
      (!hookEventName && !hasUsageTelemetry && strField(payload, "transcript_path")),
  )
}

// The failure prose from a Claude transcript (JSONL): the LAST assistant message
// text — where the synthetic session-limit / error message lives. Scanning the
// raw file would pick up per-line ISO timestamps and dump JSON into the alert;
// extractAssistantText pulls clean prose. Bounded read (tail) for a big file.
export function transcriptFailureText(path: string | null): string {
  if (!path) return ""
  const raw = readFileOrNull(path)
  if (!raw) return ""
  return extractAssistantText(raw.length > 200_000 ? raw.slice(-200_000) : raw)
}

// Normalize the StopFailure payload + flags into a HarnessFailureEvent. The
// installed hook runs a BARE `tg-ctl harness-event`, so everything but the
// payload/transcript is resolved from the runtime: paneId from TMUX_PANE (flag
// default), agent from the live pane. The failure text comes from the transcript
// (prod) or an inline `message` field / plain-text stdin (tests / manual).
//
// Field names: the REAL bare-hook payload (per the StopFailure hook docs) is
// `{ error_type, error, transcript_path, ... }` — NOT `reason`/`matcher`/
// `message`/`last_message` (those only exist on our own test/manual-invocation
// shape and predate reading the real payload — PR #120 review). `error_type`
// and `error` are read as an ADDITIONAL fallback (not a replacement) so both
// shapes keep working: a bare production hook now classifies on `error_type`
// and shows the real `error` text instead of falling back to "unknown".
//
// `error_type` now feeds classifyFailure's `/limit/i` substring test (review
// round 3): today's documented StopFailure error_type enum (rate_limit,
// overloaded, authentication_failed, oauth_org_not_allowed, billing_error,
// invalid_request, model_not_found, server_error, max_output_tokens, unknown)
// has exactly ONE value containing "limit" — rate_limit — and that IS the
// auto-continue-eligible case. If a future error_type value adds "limit" to
// its name without being a resumable rate/session limit, this substring test
// would need to narrow to an exact match; revisit if the enum changes.
export function buildHarnessEvent(payloadText: string, flags: HarnessEventFlags, agent: string, now: number): HarnessFailureEvent {
  let payload: unknown = null
  try {
    payload = JSON.parse(payloadText)
  } catch {
    /* non-JSON stdin (or empty) — treat it as the inline failure text */
  }
  const reason = flags.reason ?? (strField(payload, "reason") || strField(payload, "matcher") || strField(payload, "error_type"))
  const tPath = flags.transcriptPath ?? (strField(payload, "transcript_path") || null)
  // inline: an explicit message field, else plain-text (non-JSON) stdin. NEVER
  // the raw JSON payload — parseResetTime would scan JSON noise (a real bug).
  const inline = strField(payload, "message") || strField(payload, "last_message") || strField(payload, "error") || (payload === null ? payloadText : "")
  const failureText = [inline, transcriptFailureText(tPath)].filter(Boolean).join("\n")
  const extracted = extractFailure(reason, failureText, now, { agent })
  const sessionId = strField(payload, "session_id") || strField(payload, "sessionId") || null
  const explicitReset = flags.resetAtIso ? Date.parse(flags.resetAtIso) : NaN
  const resetAt = Number.isFinite(explicitReset) ? explicitReset : extracted.resetAt
  return {
    kind: resetAt !== null ? "session-limit" : extracted.kind,
    agent,
    paneId: flags.paneId,
    sessionId,
    reason: extracted.reason,
    detail: extracted.detail,
    resetAt,
    sourceMessageId: flags.sourceMessageId,
  }
}

export function payloadLanguage(payloadText: string, flags: HarnessEventFlags): string | null {
  if (flags.language) return flags.language
  let payloadLanguage: string | null = null
  try {
    const payload = JSON.parse(payloadText)
    payloadLanguage =
      strField(payload, "language") ||
      strField(payload, "locale") ||
      strField(payload, "user_language") ||
      strField(payload, "userLanguage") ||
      null
  } catch {
    /* fall through to locale environment */
  }
  return payloadLanguage ?? languageFromProcessEnv(process.env)
}

export function languageFromProcessEnv(env: NodeJS.ProcessEnv): string | null {
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = env[key]
    if (!raw) continue
    const normalized = raw.trim().toLowerCase()
    if (normalized.startsWith("ru")) return "ru"
    if (normalized.startsWith("en")) return "en"
  }
  return null
}

export function formatAutoContinueDelay(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`
  return formatDelta(ms)
}

export function spawnDelayedAutoContinue(
  ctx: Ctx,
  ev: HarnessFailureEvent,
  plan: TransientAutoContinuePlan,
  windowName: string,
  retryKey: string,
): { pid: number } | null {
  if (!ev.paneId) return null
  let logFd: number | null = null
  try {
    logFd = openSync(ctx.paths.log, "a")
    const runBin = rootScriptPath()
    const argv = [
      process.execPath,
      runBin,
      "auto-continue-once",
      "--pane",
      ev.paneId,
      "--delay-ms",
      String(plan.delayMs),
      "--text",
      plan.text,
      "--retry-key",
      retryKey,
    ]
    argv.push("--window-name", windowName)
    const proc = Bun.spawn(argv, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: dirname(runBin),
      env: { ...process.env, PWD: dirname(runBin), TG_CTL_CONFIG_DIR: ctx.configDir },
    })
    proc.unref()
    closeSync(logFd)
    logFd = null
    log(`harness-event: auto-continue spawned for ${ev.paneId} in ${plan.delayMs}ms (attempt ${plan.attempt})`)
    return { pid: proc.pid }
  } catch (err) {
    log(`harness-event: auto-continue spawn failed for ${ev.paneId}: ${err}`)
    return null
  } finally {
    if (logFd !== null) closeSync(logFd)
  }
}

export interface AutoContinueOnceFlags {
  paneId: string | null
  delayMs: number
  text: string
  windowName: string | null
  retryKey: string | null
}

export function parseAutoContinueOnceFlags(argv: string[]): AutoContinueOnceFlags {
  const flags: AutoContinueOnceFlags = { paneId: null, delayMs: 0, text: "", windowName: null, retryKey: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => argv[++i] ?? ""
    if (a === "--pane") flags.paneId = next()
    else if (a === "--delay-ms") flags.delayMs = Number(next())
    else if (a === "--text") flags.text = next()
    else if (a === "--window-name") flags.windowName = next()
    else if (a === "--retry-key") flags.retryKey = next()
  }
  return flags
}

export async function runAutoContinueOnce(ctx: Ctx, argv: string[]): Promise<number> {
  const flags = parseAutoContinueOnceFlags(argv)
  if (!flags.paneId || !flags.text || !Number.isFinite(flags.delayMs) || flags.delayMs < 0) return 2
  if (!flags.windowName) return 2
  if (!flags.retryKey) return 2
  if (flags.text !== "continue" && flags.text !== "продолжи") return 2
  if (flags.delayMs > 0) await Bun.sleep(flags.delayMs)
  // Set when the "continue" stayed typed in the box (#463); reported after the lock.
  let unsubmitted: string | null = null
  try {
    const result = withRoutesLock(
      fsRoutesLockIo(overloadRetryLockPath(ctx.paths.overloadRetries)),
      () => {
        const now = Date.now()
        const records = parseOverloadRetryRecords(readFileOrNull(ctx.paths.overloadRetries), now)
        const rec = records.find((item) => item.key === flags.retryKey)
        if (!rec || rec.pid !== process.pid) {
          log(`auto-continue-once skipped: retry state no longer matches ${flags.paneId}`)
          return 0
        }
        const finish = (code: number): number => {
          writeOverloadRetryRecords(ctx.paths.overloadRetries, finishOverloadRetryRecord(records, flags.retryKey!, process.pid, Date.now()))
          return code
        }
        const live = listAgentCandidates().find((c) => c.paneId === flags.paneId)
        if (!live || live.windowName !== flags.windowName) {
          log(`auto-continue-once skipped: ${flags.paneId} no longer hosts ${flags.windowName}`)
          return finish(0)
        }
        const res = executeInjectStepsSync(buildTextInjectPlan(flags.paneId, flags.text))
        if (!res.ok) {
          log(`auto-continue-once inject failed for ${flags.paneId}: ${res.error}`)
          if (res.unsubmitted) unsubmitted = res.error
          return finish(1)
        }
        log(`auto-continue-once fired for ${flags.paneId} (${flags.text})`)
        return finish(0)
      },
      { attempts: OVERLOAD_RETRY_LOCK_ATTEMPTS, delayMs: OVERLOAD_RETRY_LOCK_DELAY_MS, onContended: "skip" },
    )
    if (unsubmitted !== null) await sendMessage(ctx, unsubmitted)
    return result ?? 0
  } catch (err) {
    log(`auto-continue-once failed for ${flags.paneId}: ${err}`)
    return 1
  }
}

// The LIVE harness kind for a pane — so the bare installed hook still labels the
// notification instead of a default "agent". MUST read `.agent` (the process-tree-
// detected harness), not `.windowName`: a window's name is set once at spawn time
// (or by hand) and drifts from whatever's actually running in the pane (tg-cli#263).
export function resolveAgentForPane(paneId: string | null): string {
  if (!paneId) return "agent"
  return listAgentCandidates().find((c) => c.paneId === paneId)?.agent ?? "agent"
}

export function resolveWindowNameForPane(paneId: string | null): string | null {
  if (!paneId) return null
  return listAgentCandidates().find((c) => c.paneId === paneId)?.windowName ?? null
}

export async function runHarnessEvent(ctx: Ctx, argv: string[], now: number): Promise<number> {
  const payloadText = await readStdinText().catch(() => "")
  return runHarnessEventPayload(ctx, argv, now, payloadText)
}

type UsageEvents = ReturnType<typeof extractUsageLimitEvents>

async function sendUsageWarningIfPresent(ctx: Ctx, usageEvents: UsageEvents, flags: HarnessEventFlags, now: number): Promise<boolean> {
  const usage = usageEvents.slice().sort((a, b) => b.percent - a.percent)[0] ?? null
  if (!usage) return false
  const notif = buildUsageLimitNotification(usage, now)
  if (!notif) {
    if (!flags.dryRun) log(`harness-event: suppressed (usage below threshold) agent=${usage.agent} percent=${usage.percent}`)
    else writeStdoutLine("harness-event: SUPPRESSED (usage below 90%)")
    return true
  }
  if (flags.dryRun) {
    writeStdoutLine("=== harness-event DRY-RUN (no send) ===")
    writeStdoutLine(notif.text)
    return true
  }
  if (!claimUsageWarning(ctx.paths.usageWarnings, usage, now)) {
    log(`harness-event: suppressed (duplicate usage warning) agent=${usage.agent} limit=${usage.limitName ?? "-"} reset=${usage.resetAt ?? "-"}`)
    return true
  }
  const messageId = await sendMessage(ctx, notif.text, { parse_mode: "HTML" })
  if (messageId === null) clearUsageWarningClaim(ctx.paths.usageWarnings, usage, now)
  return true
}

type LimitNotification = NonNullable<ReturnType<typeof buildLimitNotification>>

function printLimitDryRun(notif: LimitNotification, ev: HarnessFailureEvent, retryableOverload: TransientAutoContinuePlan | null): void {
  writeStdoutLine("=== harness-event DRY-RUN (no send) ===")
  writeStdoutLine(notif.text)
  if (notif.button) writeStdoutLine(`[button] ${notif.button.label} → ${notif.button.data}`)
  if (retryableOverload) writeStdoutLine(`[auto-continue] ${retryableOverload.text} in ${formatAutoContinueDelay(retryableOverload.delayMs)} (attempt ${retryableOverload.attempt})`)
  if (ev.sourceMessageId !== null) writeStdoutLine(`[reaction] ${reactionForStage("stalled")} on message ${ev.sourceMessageId}`)
}

function buildCodexDiagnostic(ctx: Ctx, ev: HarnessFailureEvent, hasSupportedUsageTelemetry: boolean, now: number) {
  const latestCodexUsage = latestRecentUsageLatest(ctx.paths.usageLatest, "codex", now)
  const anyCodexUsage = latestCodexUsage === null ? latestAnyUsageLatest(ctx.paths.usageLatest, "codex") : latestCodexUsage
  return buildCodexHardLimitDiagnostic(ev, {
    hasSupportedUsageTelemetry: hasSupportedUsageTelemetry || latestCodexUsage !== null,
    latestSupportedUsagePercent: latestCodexUsage?.percent ?? null,
    latestSupportedUsageLimitName: latestCodexUsage?.limitName ?? null,
    hadExpiredSupportedUsageTelemetry: latestCodexUsage === null && anyCodexUsage !== null,
  })
}

async function sendLimitNotification(ctx: Ctx, notif: LimitNotification, ev: HarnessFailureEvent): Promise<number | null> {
  const keyboard = notif.button ? { inline_keyboard: [[{ text: notif.button.label, callback_data: notif.button.data }]] } : undefined
  const extra: Record<string, unknown> = { parse_mode: "HTML" }
  if (keyboard) extra.reply_markup = keyboard
  const messageId = await sendMessage(ctx, notif.text, extra)
  if (ev.sourceMessageId !== null) await setMessageReaction(ctx, ev.sourceMessageId, reactionForStage("stalled"))
  return messageId
}

interface HarnessFailureInput {
  ctx: Ctx
  payloadText: string
  flags: HarnessEventFlags
  agent: string
  windowName: string | null
  now: number
  usageEvents: UsageEvents
  hasSupportedUsageTelemetry: boolean
}

async function reportHarnessFailure(input: HarnessFailureInput): Promise<void> {
  const { ctx, payloadText, flags, agent, windowName, now, usageEvents, hasSupportedUsageTelemetry } = input
  const ev = buildHarnessEvent(payloadText, flags, agent, now)
  const diagnostic = buildCodexDiagnostic(ctx, ev, hasSupportedUsageTelemetry, now)
  const notif = buildLimitNotification(ev, now, { diagnostic })
  const overloadLanguage = payloadLanguage(payloadText, flags)
  const retryableOverload = ev.paneId && windowName ? buildTransientAutoContinue(ev, { attempt: 1, language: overloadLanguage }) : null
  if (!notif) {
    if (await sendUsageWarningIfPresent(ctx, usageEvents, flags, now)) return
    // Staleness guard (#113): a reset already in the past, or nothing to report.
    if (!flags.dryRun) log(`harness-event: suppressed (stale/none) agent=${ev.agent} reset=${ev.resetAt}`)
    else writeStdoutLine("harness-event: SUPPRESSED (reset already past or nothing to report)")
    return
  }
  if (flags.dryRun) {
    printLimitDryRun(notif, ev, retryableOverload)
    return
  }
  const messageId = await sendLimitNotification(ctx, notif, ev)
  if (retryableOverload && messageId !== null) {
    claimOverloadAutoContinue(ctx, ev, now, overloadLanguage, windowName)
  }
}

export async function runHarnessEventPayload(ctx: Ctx, argv: string[], now: number, payloadText: string): Promise<number> {
  const flags = parseHarnessEventFlags(argv)
  const agent = flags.agent ?? resolveAgentForPane(flags.paneId)
  const windowName = flags.windowName ?? resolveWindowNameForPane(flags.paneId)
  const usageEvents = extractUsageLimitEvents(payloadText, { agent, language: flags.language, env: process.env, now })
  const hasSupportedUsageTelemetry = extractUsageLimitEvents(payloadText, { agent, language: flags.language, env: process.env, now: 0 }).length > 0
  if (!flags.dryRun) recordUsageLatest(ctx.paths.usageLatest, usageEvents, now)
  if (hasHarnessFailureSignal(payloadText, flags, hasSupportedUsageTelemetry)) {
    await reportHarnessFailure({ ctx, payloadText, flags, agent, windowName, now, usageEvents, hasSupportedUsageTelemetry })
    return 0
  }
  if (await sendUsageWarningIfPresent(ctx, usageEvents, flags, now)) return 0
  if (!flags.dryRun) log(`harness-event: suppressed (no supported event) agent=${agent}`)
  else writeStdoutLine("harness-event: SUPPRESSED (no supported event)")
  return 0
}

export async function runCodexUsageHook(ctx: Ctx, now: number): Promise<number> {
  const hookPayload = await readStdinText().catch(() => "")
  const transcriptPath = codexUsageTranscriptPath(hookPayload)
  if (!transcriptPath) return 0
  const transcript = readFileTailOrNull(transcriptPath, CODEX_TRANSCRIPT_TAIL_BYTES)
  if (!transcript) return 0
  const payload = latestCodexUsageTelemetryPayload(transcript, { now })
  if (!payload) return 0
  return runHarnessEventPayload(ctx, ["--agent", "codex"], now, payload)
}
