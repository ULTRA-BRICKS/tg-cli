// daemon-runtime/usage-records: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { unlinkSync } from "fs"
import { describeDependencyProblem } from "../dependency-problem"
import { renderUsageReport } from "../usage-format"
import { mergePendingDailyReport, undeliveredReportTail } from "../report-delivery"
import { splitMessage } from "../../auto-attach/split"
import { MESSAGE_LIMIT } from "../../auto-attach/types"
import { formatClock, formatDelta, type HarnessFailureEvent, type UsageLimitEvent } from "../limits"
import { fsRoutesLockIo, withRoutesLock } from "../routes"
import { atomicWrite, kill0, log, readFileOrNull, spawnGuarded, type Ctx } from "./ctx-io"
import { OVERLOAD_RETRY_LOCK_ATTEMPTS, OVERLOAD_RETRY_LOCK_DELAY_MS } from "./constants"
import { sendMessage } from "./telegram-api"

// --- harness-event subcommand (#113): notify on a StopFailure hook ---

export interface HarnessEventFlags {
  dryRun: boolean
  paneId: string | null
  agent: string | null
  windowName: string | null
  reason: string | null
  resetAtIso: string | null
  sourceMessageId: number | null
  transcriptPath: string | null
  language: string | null
}

export function parseHarnessEventFlags(argv: string[]): HarnessEventFlags {
  const flags: HarnessEventFlags = {
    dryRun: false,
    paneId: process.env.TMUX_PANE ?? null,
    agent: null,
    windowName: null,
    reason: null,
    resetAtIso: null,
    sourceMessageId: null,
    transcriptPath: null,
    language: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => argv[++i] ?? ""
    if (a === "--dry-run") flags.dryRun = true
    else if (a === "--pane") flags.paneId = next()
    else if (a === "--agent") flags.agent = next()
    else if (a === "--window-name") flags.windowName = next()
    else if (a === "--reason") flags.reason = next()
    else if (a === "--reset-at") flags.resetAtIso = next()
    else if (a === "--source-message-id") flags.sourceMessageId = Number(next()) || null
    else if (a === "--transcript") flags.transcriptPath = next()
    else if (a === "--language" || a === "--lang" || a === "--locale") flags.language = next()
  }
  return flags
}

export function strField(obj: unknown, key: string): string {
  const v = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined
  return typeof v === "string" ? v : ""
}

export const USAGE_WARNING_COOLDOWN_MS = 60 * 60_000

export const USAGE_WARNING_STORE_MAX = 100

export const USAGE_LATEST_NO_RESET_MAX_AGE_MS = 24 * 60 * 60_000

export interface UsageWarningRecord {
  key: string
  lastSentAt: number
  resetAt: number | null
}

export interface UsageLatestRecord {
  agent: string
  limitName: string | null
  percent: number
  resetAt: number | null
  language: string
  detail: string
  sampledAt: number
}

export interface OverloadRetryRecord {
  key: string
  attempt: number
  pid: number | null
  lastFailureAt: number
  nextAt: number
}

export const OVERLOAD_RETRY_RESET_MS = 30 * 60_000

export const OVERLOAD_RETRY_STORE_MAX = 100

export const OVERLOAD_AUTO_CONTINUE_MAX_ATTEMPTS = 8

export function usageWarningKey(ev: UsageLimitEvent): string {
  return JSON.stringify([ev.agent, ev.limitName ?? ""])
}

export function usageWarningLockPath(path: string): string {
  return `${path}.lock`
}

export function usageLatestKey(rec: Pick<UsageLatestRecord, "agent" | "limitName">): string {
  return JSON.stringify([rec.agent, rec.limitName ?? ""])
}

export function usageLatestLockPath(path: string): string {
  return `${path}.lock`
}

export function overloadRetryLockPath(path: string): string {
  return `${path}.lock`
}

export function overloadRetryKey(ev: HarnessFailureEvent, windowName: string): string {
  return JSON.stringify([ev.paneId ?? "", ev.sessionId ?? "", windowName])
}

export function overloadRetryScope(key: string): { paneId: string; windowName: string } | null {
  try {
    const parsed = JSON.parse(key) as unknown
    if (!Array.isArray(parsed)) return null
    if (parsed.length >= 3 && typeof parsed[0] === "string" && typeof parsed[2] === "string") {
      return { paneId: parsed[0], windowName: parsed[2] }
    }
    if (parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { paneId: parsed[0], windowName: parsed[1] }
    }
  } catch {
    return null
  }
  return null
}

export function overloadRetrySameScope(rec: OverloadRetryRecord, paneId: string, windowName: string): boolean {
  const scope = overloadRetryScope(rec.key)
  return scope !== null && scope.paneId === paneId && scope.windowName === windowName
}

export function parseUsageLatestRecordsRaw(blob: string | null): UsageLatestRecord[] {
  if (!blob) return []
  try {
    const parsed = JSON.parse(blob) as { samples?: unknown }
    if (!Array.isArray(parsed.samples)) return []
    return parsed.samples
      .filter((item): item is UsageLatestRecord => {
        if (!item || typeof item !== "object") return false
        const rec = item as Record<string, unknown>
        const resetAt = rec.resetAt
        return (
          typeof rec.agent === "string" &&
          (rec.limitName === null || typeof rec.limitName === "string") &&
          typeof rec.percent === "number" &&
          Number.isFinite(rec.percent) &&
          rec.percent >= 0 &&
          rec.percent <= 100 &&
          (resetAt === null || (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0)) &&
          typeof rec.language === "string" &&
          typeof rec.detail === "string" &&
          typeof rec.sampledAt === "number" &&
          Number.isFinite(rec.sampledAt) &&
          rec.sampledAt > 0
        )
      })
  } catch {
    return []
  }
}

export function parseUsageLatestRecords(blob: string | null, now: number): UsageLatestRecord[] {
  return parseUsageLatestRecordsRaw(blob)
    .filter((rec) => (rec.resetAt !== null ? rec.resetAt > now : rec.sampledAt > now - USAGE_LATEST_NO_RESET_MAX_AGE_MS))
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

// One persisted retry row, or null when any field is malformed.
function parseOverloadRetryRecord(rec: Record<string, unknown>): OverloadRetryRecord | null {
  const pid = rec.pid
  const pidValid = pid === undefined || pid === null || (typeof pid === "number" && Number.isInteger(pid) && pid > 0)
  if (typeof rec.key !== "string" || !pidValid) return null
  if (typeof rec.attempt !== "number" || !Number.isInteger(rec.attempt) || rec.attempt <= 0) return null
  if (!isPositiveFinite(rec.lastFailureAt) || !isPositiveFinite(rec.nextAt)) return null
  return {
    key: rec.key,
    attempt: rec.attempt,
    pid: typeof pid === "number" ? pid : null,
    lastFailureAt: rec.lastFailureAt,
    nextAt: rec.nextAt,
  }
}

export function parseOverloadRetryRecords(blob: string | null, now: number): OverloadRetryRecord[] {
  if (!blob) return []
  try {
    const parsed = JSON.parse(blob) as { retries?: unknown }
    if (!Array.isArray(parsed.retries)) return []
    const records: OverloadRetryRecord[] = []
    for (const item of parsed.retries) {
      if (!item || typeof item !== "object") continue
      const record = parseOverloadRetryRecord(item as Record<string, unknown>)
      if (record) records.push(record)
    }
    return records
      .filter((rec) => rec.lastFailureAt > now - 24 * OVERLOAD_RETRY_RESET_MS)
      .slice(-OVERLOAD_RETRY_STORE_MAX)
  } catch {
    return []
  }
}

export function writeOverloadRetryRecords(path: string, records: OverloadRetryRecord[]): void {
  atomicWrite(path, `${JSON.stringify({ version: 1, retries: records.slice(-OVERLOAD_RETRY_STORE_MAX) })}\n`)
}

export function runtimeOverloadAutoContinueDelayMs(delayMs: number): number {
  const raw = Number(process.env.TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS)
  if (Number.isFinite(raw) && raw >= 1000) return raw
  return delayMs
}

export function overloadRetryChildAlive(rec: OverloadRetryRecord): boolean {
  if (rec.pid === null) return false
  const match = overloadRetryChildMatchState(rec.pid, rec.key)
  return match === true || match === null
}

export function terminateSpawnedRetry(pid: number): void {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    /* best effort: the child may already have exited */
  }
}

export function overloadRetryChildMatches(pid: number, retryKey: string): boolean {
  return overloadRetryChildMatchState(pid, retryKey) === true
}

export function overloadRetryChildMatchState(pid: number, retryKey: string): boolean | null {
  if (!kill0(pid)) return false
  const proc = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" })
  if (proc.exitCode !== 0) return null
  const command = new TextDecoder().decode(proc.stdout).trim()
  return command.includes("auto-continue-once") && command.includes("--retry-key") && command.includes(retryKey)
}

export function finishOverloadRetryRecord(records: OverloadRetryRecord[], retryKey: string, pid: number, now: number): OverloadRetryRecord[] {
  return records.map((rec) => (rec.key === retryKey && rec.pid === pid ? { ...rec, pid: null, nextAt: now } : rec))
}

export function writeUsageLatestRecords(path: string, records: UsageLatestRecord[]): void {
  atomicWrite(path, `${JSON.stringify({ version: 1, samples: records })}\n`)
}

export function recordUsageLatest(path: string, events: UsageLimitEvent[], now: number): void {
  if (events.length === 0) return
  try {
    withRoutesLock(
      fsRoutesLockIo(usageLatestLockPath(path)),
      () => {
        const byKey = new Map<string, UsageLatestRecord>()
        for (const rec of parseUsageLatestRecords(readFileOrNull(path), now)) byKey.set(usageLatestKey(rec), rec)
        for (const ev of events) {
          const rec: UsageLatestRecord = {
            agent: ev.agent,
            limitName: ev.limitName,
            percent: ev.percent,
            resetAt: ev.resetAt,
            language: ev.language,
            detail: ev.detail,
            sampledAt: now,
          }
          byKey.set(usageLatestKey(rec), rec)
        }
        writeUsageLatestRecords(path, [...byKey.values()].sort(compareUsageLatestRecords))
      },
      { attempts: OVERLOAD_RETRY_LOCK_ATTEMPTS, delayMs: OVERLOAD_RETRY_LOCK_DELAY_MS, onContended: "skip" },
    )
  } catch (err) {
    log(`harness-event: usage latest store failed: ${err}`)
  }
}

export function latestRecentUsageLatest(path: string, agent: string, now: number): UsageLatestRecord | null {
  const normalized = agent.trim().toLowerCase()
  return parseUsageLatestRecords(readFileOrNull(path), now)
    .filter((rec) => rec.agent.toLowerCase() === normalized)
    .sort((a, b) => b.sampledAt - a.sampledAt || b.percent - a.percent)[0] ?? null
}

export function latestAnyUsageLatest(path: string, agent: string): UsageLatestRecord | null {
  const normalized = agent.trim().toLowerCase()
  return parseUsageLatestRecordsRaw(readFileOrNull(path))
    .filter((rec) => rec.agent.toLowerCase() === normalized)
    .sort((a, b) => b.sampledAt - a.sampledAt || b.percent - a.percent)[0] ?? null
}

export function compareUsageLatestRecords(a: UsageLatestRecord, b: UsageLatestRecord): number {
  const agent = a.agent.localeCompare(b.agent)
  if (agent !== 0) return agent
  return usageLimitRank(a.limitName) - usageLimitRank(b.limitName) || (a.limitName ?? "").localeCompare(b.limitName ?? "")
}

export function usageLimitRank(limitName: string | null): number {
  if (limitName === "5-hour") return 0
  if (limitName === "weekly") return 1
  if (limitName === "context window") return 2
  if (limitName === "primary") return 3
  if (limitName === "secondary") return 4
  return 10
}

export function formatUsagePercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, "")
}

export function composeLimitStatus(ctx: Ctx, agentFilter: string | null, now = Date.now()): string {
  const filter = agentFilter?.trim().toLowerCase() || null
  const records = parseUsageLatestRecords(readFileOrNull(ctx.paths.usageLatest), now)
    .filter((rec) => !filter || rec.agent.toLowerCase() === filter)
    .sort(compareUsageLatestRecords)
  const scope = filter ? ` for ${filter}` : ""
  if (records.length === 0) {
    return `No recent limit telemetry${scope}. Run tg-ctl install-hooks and wait for the agent statusLine/harness telemetry to report.`
  }
  const lines = [`Latest limits${scope}:`]
  let currentAgent = ""
  for (const rec of records) {
    if (rec.agent !== currentAgent) {
      currentAgent = rec.agent
      lines.push(`${rec.agent}:`)
    }
    const limit = rec.limitName ?? "limit"
    const reset = rec.resetAt !== null ? ` · resets ${formatClock(rec.resetAt)} (in ${formatDelta(rec.resetAt - now)})` : ""
    const sampled = ` · updated ${formatDelta(now - rec.sampledAt)} ago`
    lines.push(`- ${limit}: ${formatUsagePercent(rec.percent)}%${reset}${sampled}`)
  }
  return lines.join("\n")
}

// /daily — shells out to `rig daily` (rig-cli's own categorized what-shipped report
// over merged PRs, source of truth `gh pr list --state merged`, never a ticket
// status). Bare `rig daily` with no flags reports since each configured repo's own
// saved watermark and advances it — exactly the semantics wanted for a repeatable
// Telegram command (a second /daily right after the first reports "nothing new",
// same as the CLI itself). 30s timeout: `gh pr list` across a couple of repos is
// normally sub-second, but a slow/rate-limited GitHub API call must not wedge the
// daemon's single event loop past a bounded ceiling (see spawnGuarded's own doc).
// `ok: false` is a failure to RUN rig (nothing was generated, no watermark moved) —
// only an `ok: true` report is worth persisting if its send later fails.
export async function composeDailyReport(): Promise<{ ok: boolean; text: string }> {
  const r = await spawnGuarded(["rig", "daily"], 30_000)
  if (r.exitCode === 127) {
    return { ok: false, text: `daily: ${r.problem ? describeDependencyProblem("rig", r.problem) : `couldn't run \`rig\` (${r.stderr.trim() || "not found on PATH"}).`}` }
  }
  if (r.exitCode === 124) {
    return { ok: false, text: "daily: `rig daily` timed out after 30s (GitHub API slow/rate-limited?) — try again shortly." }
  }
  if (r.exitCode !== 0) {
    return { ok: false, text: `daily: \`rig daily\` failed (exit ${r.exitCode}): ${r.stderr.trim() || "no error output"}` }
  }
  const report = r.stdout.trim()
  return { ok: true, text: report || "daily: nothing new since the last report." }
}

// Send a plain-text daemon reply as ≤4096-char chunks, in order (Telegram rejects a
// longer sendMessage outright, and botPost only logs that — the user would get an ack
// and no report). Stops at the first failed chunk; returns how many were accepted so the
// caller can persist the rest.
export async function sendReportChunks(ctx: Ctx, text: string, extra: Record<string, unknown>): Promise<{ chunks: string[]; delivered: number }> {
  const chunks = splitMessage(text, MESSAGE_LIMIT, "plain")
  let delivered = 0
  for (const chunk of chunks) {
    if ((await sendMessage(ctx, chunk, extra)) === null) break
    delivered++
  }
  return { chunks, delivered }
}

// /daily delivery: `rig daily` advances its watermark while GENERATING the report (rig
// has no commit-after-send verb; --dry-run/--since are read-only), so a report whose
// send fails would otherwise be lost for good — the next /daily says "nothing new". The
// undelivered tail is persisted (per bot, 0600) and prepended to the next /daily reply.
// The pending file is touched only AFTER the send is decided: overwritten (atomically)
// with the new undelivered tail on a partial send, removed only once everything went
// out. Deleting it up front would open a window (a slow `rig daily`, a daemon restart
// mid-action) where the carried report — already consumed from rig's watermark — is
// gone for good; the worst case of this ordering is a benign duplicate carry instead.
export async function deliverDailyReport(ctx: Ctx, extra: Record<string, unknown>): Promise<void> {
  const pending = readFileOrNull(ctx.paths.dailyPending)
  const fresh = await composeDailyReport()
  const body = mergePendingDailyReport(pending, fresh.text)
  const { chunks, delivered } = await sendReportChunks(ctx, body, extra)
  const tail = undeliveredReportTail(chunks, delivered)
  if (tail === null) {
    if (pending !== null) unlinkGuarded(ctx.paths.dailyPending, "daily: removing the delivered pending-report file failed")
    return
  }
  // Nothing generated this time (rig failed — its watermark did not move, a plain retry
  // regenerates it): keep the carried report exactly as it was rather than persisting a
  // tail that mixes it with an error text; with nothing carried there is nothing to keep.
  const keep = fresh.ok ? tail : pending
  if (keep === null) return
  try {
    atomicWrite(ctx.paths.dailyPending, keep)
    log(`daily: send failed after ${delivered}/${chunks.length} chunks — kept the undelivered report for the next /daily`)
  } catch (err) {
    log(`daily: send failed AND persisting the undelivered report failed: ${err}`)
  }
}

export function unlinkGuarded(path: string, failureNote: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    log(`${failureNote}: ${err}`)
  }
}

// /spend [day|week|month] — shells out to `rig usage --json`, rig-cli's own
// streaming aggregation over ~/.claude/projects + every ~/.claude-accounts/account-*
// (see rig-cli's riglib/usage.py). Cost is a HYPOTHETICAL estimate at published API
// list prices — these are Claude.ai subscription accounts, never a real bill; that
// disclaimer is threaded through from `rig usage` itself and repeated here so a lone
// forwarded chat message still carries it. No period arg mirrors the CLI's own
// default (both current week AND current month in one report). 30s timeout matches
// composeDailyReport's own ceiling — this is a local, hermetic file scan, not a
// network call, but a very large/first-run ~/.claude/projects tree could still take
// a few seconds and must not wedge the daemon's single event loop past a bound.
// `ok: false` is a failure to RUN rig or to read its output (no report exists) — the
// scheduled push must not treat that text as a delivered report (usage-format.ts owns
// the JSON contract + rendering, unit-tested there).
export async function composeUsageReport(period: "day" | "week" | "month" | null): Promise<{ ok: boolean; text: string }> {
  const argv = period ? ["rig", "usage", "--json", "--period", period] : ["rig", "usage", "--json"]
  const r = await spawnGuarded(argv, 30_000)
  if (r.exitCode === 127) {
    return { ok: false, text: `spend: ${r.problem ? describeDependencyProblem("rig", r.problem) : `couldn't run \`rig\` (${r.stderr.trim() || "not found on PATH"}).`}` }
  }
  if (r.exitCode === 124) {
    return { ok: false, text: "spend: `rig usage` timed out after 30s — try again shortly." }
  }
  if (r.exitCode !== 0) {
    return { ok: false, text: `spend: \`rig usage\` failed (exit ${r.exitCode}): ${r.stderr.trim() || "no error output"}` }
  }
  return renderUsageReport(r.stdout)
}

export function parseUsageWarningRecords(blob: string | null, now: number): UsageWarningRecord[] {
  if (!blob) return []
  try {
    const parsed = JSON.parse(blob) as { warnings?: unknown }
    if (!Array.isArray(parsed.warnings)) return []
    return parsed.warnings
      .filter((item): item is UsageWarningRecord => {
        if (!item || typeof item !== "object") return false
        const rec = item as Record<string, unknown>
        const resetAt = rec.resetAt
        return (
          typeof rec.key === "string" &&
          typeof rec.lastSentAt === "number" &&
          Number.isFinite(rec.lastSentAt) &&
          rec.lastSentAt > 0 &&
          (resetAt === null || (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0))
        )
      })
      .filter((rec) => (rec.resetAt !== null ? rec.resetAt > now : rec.lastSentAt > now - 24 * USAGE_WARNING_COOLDOWN_MS))
      .slice(-USAGE_WARNING_STORE_MAX)
  } catch {
    return []
  }
}

export function usageWarningAlreadyRecorded(records: UsageWarningRecord[], ev: UsageLimitEvent, now: number): boolean {
  const key = usageWarningKey(ev)
  const rec = records.find((item) => item.key === key)
  if (!rec) return false
  return rec.resetAt !== null || now - rec.lastSentAt < USAGE_WARNING_COOLDOWN_MS
}

export function writeUsageWarningRecords(path: string, records: UsageWarningRecord[]): void {
  atomicWrite(path, `${JSON.stringify({ version: 1, warnings: records.slice(-USAGE_WARNING_STORE_MAX) })}\n`)
}

export function claimUsageWarning(path: string, ev: UsageLimitEvent, now: number): boolean {
  try {
    const claimed = withRoutesLock(
      fsRoutesLockIo(usageWarningLockPath(path)),
      () => {
        const key = usageWarningKey(ev)
        const records = parseUsageWarningRecords(readFileOrNull(path), now)
        if (usageWarningAlreadyRecorded(records, ev, now)) return false
        const next = records.filter((item) => item.key !== key)
        next.push({ key, lastSentAt: now, resetAt: ev.resetAt })
        writeUsageWarningRecords(path, next)
        return true
      },
      { attempts: OVERLOAD_RETRY_LOCK_ATTEMPTS, delayMs: OVERLOAD_RETRY_LOCK_DELAY_MS, onContended: "skip" },
    )
    return claimed === true
  } catch (err) {
    log(`harness-event: usage warning dedupe claim failed: ${err}`)
    return false
  }
}

export function clearUsageWarningClaim(path: string, ev: UsageLimitEvent, now: number): void {
  try {
    withRoutesLock(
      fsRoutesLockIo(usageWarningLockPath(path)),
      () => {
        const key = usageWarningKey(ev)
        writeUsageWarningRecords(
          path,
          parseUsageWarningRecords(readFileOrNull(path), now).filter((item) => item.key !== key),
        )
      },
      { onContended: "skip" },
    )
  } catch (err) {
    log(`harness-event: usage warning dedupe cleanup failed: ${err}`)
  }
}
