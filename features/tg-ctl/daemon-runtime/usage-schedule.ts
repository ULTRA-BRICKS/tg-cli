// daemon-runtime/usage-schedule: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { dirname } from "path"
import { USAGE_SCHEDULE_LAUNCHD_LABEL, buildUsageScheduleDisablePlan, buildUsageScheduleEnablePlan, missedUsageReportNotice, parseUsageScheduleWatermark, seedUsageScheduleWatermarkFor, shouldSeedUsageScheduleWatermark, usageScheduleGapNote, usageSchedulePeriodsDue, type UsageScheduleDuePeriod, type UsageScheduleEnv, type UsageScheduleWatermark } from "../usage-schedule"
import { escapeHtml } from "../../render/html"
import { botIdFromToken, ctlPaths } from "../lock"
import { atomicWrite, readFileOrNull, spawnGuarded, type Ctx } from "./ctx-io"
import { EXIT_AUTOSTART_FAILED, resolveDeployedBin, runAutostartCommand } from "./daemon-service"
import { composeUsageReport, unlinkGuarded } from "./usage-records"

// --- /spend scheduled push (end-of-week / end-of-month) ---

export function usageScheduleWatermarkPath(ctx: Ctx): string {
  return ctlPaths(ctx.configDir, botIdFromToken(ctx.token) || "unknown").usageSchedule
}

export function usageScheduleEnv(ctx: Ctx): UsageScheduleEnv {
  return {
    home: ctx.home,
    binPath: resolveDeployedBin(ctx.home),
    bunPath: process.execPath,
    logPath: ctx.paths.log,
    configDir: ctx.configDir,
    // Captured from the enabling shell — launchd's own PATH won't include wherever
    // `tg`/`rig` live (see usageScheduleUnitEnv's comment in usage-schedule.ts).
    pathEnv: process.env.PATH ?? '',
  }
}

// `tg-ctl usage-schedule enable [--dry-run]` — install the launchd job that fires
// `usage-schedule-check` daily at 23:50; `--dry-run` prints the plan and touches nothing
// (mirrors enableAutostart's own --dry-run contract). launchd (macOS) only — see
// usage-schedule.ts's SCOPE note.
// Seeded ONLY on a truly first enable (no watermark file yet) so the FIRST scheduled check
// never claims a period was "missed while the machine was asleep" — nothing was scheduled
// yet, so nothing could have been missed. `enable` is also a supported RE-run (retry a
// half-failed load, re-pin PATH after moving `tg`/`rig`) — an unconditional reseed there
// would silently overwrite a real pending/failed period with "already reported" and swallow
// it with neither a report nor a missed notice (review finding, converged on by two
// independent reviewers). An existing watermark — even an all-null one written by a prior
// enable — is therefore left untouched; only a genuinely absent file gets seeded.
export function seedUsageScheduleWatermark(watermarkPath: string, now: Date): void {
  if (!shouldSeedUsageScheduleWatermark(readFileOrNull(watermarkPath))) return
  const seed = seedUsageScheduleWatermarkFor(now)
  try {
    atomicWrite(watermarkPath, `${JSON.stringify(seed)}\n`)
  } catch (err) {
    console.error(`tg-ctl: usage-schedule: seeding the watermark failed (a false "missed" notice may fire once): ${err}`)
  }
}

export function enableUsageSchedule(ctx: Ctx, dryRun: boolean): number {
  if (process.platform !== "darwin") {
    console.error("tg-ctl: usage-schedule is only implemented for launchd (macOS) — not supported on this OS.")
    return EXIT_AUTOSTART_FAILED
  }
  const env = usageScheduleEnv(ctx)
  const plan = buildUsageScheduleEnablePlan(env)
  if (dryRun) {
    writeStdoutLine(`tg-ctl: [dry-run] usage-schedule label: ${USAGE_SCHEDULE_LAUNCHD_LABEL}`)
    writeStdoutLine(`tg-ctl: [dry-run] would write ${plan.file.path}`)
    for (const cmd of plan.commands) writeStdoutLine(`tg-ctl: [dry-run] would run: ${cmd.argv.join(" ")}`)
    return 0
  }
  try {
    mkdirSync(dirname(plan.file.path), { recursive: true })
    writeFileSync(plan.file.path, plan.file.content, { mode: plan.file.mode })
  } catch (err) {
    console.error(`tg-ctl: writing ${plan.file.path} failed: ${err}`)
    return EXIT_AUTOSTART_FAILED
  }
  seedUsageScheduleWatermark(usageScheduleWatermarkPath(ctx), new Date())
  let activated = true
  for (const cmd of plan.commands) {
    if (!runAutostartCommand(cmd)) activated = false
  }
  if (!activated) {
    console.error("tg-ctl: usage-schedule launchctl command failed — the unit file is on disk but not loaded.")
    return EXIT_AUTOSTART_FAILED
  }
  writeStdoutLine(`tg-ctl: usage-schedule enabled — ${USAGE_SCHEDULE_LAUNCHD_LABEL} at ${plan.file.path}. Checks daily at 23:50, sends one report per completed week and month (a day missed while asleep is reported as missed, not skipped).`)
  return 0
}

export function disableUsageSchedule(ctx: Ctx): number {
  if (process.platform !== "darwin") {
    writeStdoutLine("tg-ctl: usage-schedule was never installed on this OS — nothing to remove.")
    return 0
  }
  const plan = buildUsageScheduleDisablePlan(ctx.home)
  // The watermark is cleared on EVERY disable call that reaches this function — including
  // the "already gone" early-return paths below — not just the branch that actually
  // unloads/removes a plist. A re-disable after a partial failure, or a disable after the
  // plist was already removed by hand, is still an intentional "stop watching" the user
  // asked for; leaving the watermark behind in either case would make a LATER re-enable
  // (which only reseeds an ABSENT file, see shouldSeedUsageScheduleWatermark) see it as
  // present and skip reseeding, then fire a false "machine was asleep" notice for the whole
  // disabled window — the exact bug an earlier fix (review MEDIUM finding) closed for the
  // plist-present path but left open here (review HIGH finding: the early returns below
  // used to skip this cleanup entirely).
  const clearWatermark = () =>
    unlinkGuarded(usageScheduleWatermarkPath(ctx), "tg-ctl: usage-schedule: removing the watermark failed (harmless — a stale one only delays the next reseed)")
  if (!existsSync(plan.filePath)) {
    clearWatermark()
    writeStdoutLine("tg-ctl: usage-schedule is not installed — nothing to remove.")
    return 0
  }
  const ok = runAutostartCommand(plan.commands[0])
  if (!ok) {
    console.error("tg-ctl: usage-schedule deactivate failed — leaving the unit file in place.")
    return EXIT_AUTOSTART_FAILED
  }
  try {
    unlinkSync(plan.filePath)
  } catch (err) {
    console.error(`tg-ctl: removing ${plan.filePath} failed: ${err}`)
    return EXIT_AUTOSTART_FAILED
  }
  clearWatermark()
  writeStdoutLine("tg-ctl: usage-schedule disabled.")
  return 0
}

export function writeUsageScheduleWatermark(path: string, watermark: UsageScheduleWatermark): void {
  atomicWrite(path, `${JSON.stringify(watermark)}\n`)
}

// Send one scheduled report through the `tg` CLI. The report body is plain text built
// from `rig usage --json` data (model names, the disclaimer) but `--format html` parses
// it as HTML — `rig usage` really does emit a "<synthetic>" model name, and Telegram
// rejects an unescaped stray "<" — so the body is escaped right here, at the HTML
// boundary (the interactive /spend reply goes out as plain text and must NOT be escaped).
// No splitting here: the `tg` CLI's own transmitter 4096-splits a non-rich HTML body
// (features/auto-attach/transmitter.ts), unlike the daemon's direct Bot API sends.
export async function sendScheduledUsageReport(title: string, body: string): Promise<boolean> {
  const r = await spawnGuarded(["tg", "--format", "html", "--automated", "--tag", "report", "--title", title, escapeHtml(body)], 30_000)
  if (r.exitCode === 0) return true
  console.error(`tg-ctl: usage-schedule: sending "${title}" failed (exit ${r.exitCode}): ${r.stderr.trim() || "no error output"}`)
  return false
}

// What the scheduled check sends for one due period: the real report when the check runs
// ON the boundary day (`rig usage --period X` covers exactly the completing period), an
// explicit missed-report notice when it runs late (rig can only report the CURRENT
// period — see usage-schedule.ts's LIMIT note), or nothing (`null`, period stays due)
// when rig itself failed: an error blurb delivered "successfully" must never advance the
// watermark, or a transient rig failure on the boundary day consumes the period for good.
export async function scheduledUsageBody(due: UsageScheduleDuePeriod): Promise<string | null> {
  if (!due.onTime) return missedUsageReportNotice(due)
  const report = await composeUsageReport(due.period)
  if (report.ok) return due.hasGap ? `${report.text}\n\n${usageScheduleGapNote(due.period)}` : report.text
  console.error(`tg-ctl: usage-schedule: "${due.title}" (period ${due.id}) not generated, left due for the next check: ${report.text}`)
  return null
}

// The job the installed launchd unit actually invokes once a day. A no-op unless a
// week/month report is DUE per the persisted watermark (usage-schedule.ts's
// usageSchedulePeriodsDue; both can be due the same day — both are handled). A period
// whose compose or send fails stays due, so the next daily check retries it instead of
// silently losing it. Dry-run (TG_USAGE_SCHEDULE_DRY_RUN=1 in the PROCESS env — not the
// merged .env, so a line left in the config file can't turn the schedule into a permanent
// no-op — or --dry-run) logs what WOULD be sent and never advances the watermark, so a
// manual smoke check neither pushes a message nor masks a pending real report.
// Dry-run logs what WOULD be sent; otherwise sends. True = the period was delivered.
async function deliverScheduledReport(item: UsageScheduleDuePeriod, body: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    writeStdoutLine(`tg-ctl: [dry-run] would send "${item.title}" (period ${item.id}${item.onTime ? "" : ", LATE"}): ${body.slice(0, 200)}${body.length > 200 ? "…" : ""}`)
    return false
  }
  return sendScheduledUsageReport(item.title, body)
}

// Persisted right after EACH successful send (not once after the whole loop) — a crash
// between send and write would otherwise leave a delivered report looking "NOT
// generated" to the next check (review LOW finding).
function persistWatermarkAfterSend(path: string, watermark: UsageScheduleWatermark, title: string): void {
  try {
    writeUsageScheduleWatermark(path, watermark)
  } catch (err) {
    console.error(`tg-ctl: usage-schedule: sent "${title}" but FAILED to persist the watermark — it may be reported as missed again tomorrow: ${err}`)
  }
}

export async function runUsageScheduleCheck(now: Date, dryRun: boolean, watermarkPath: string): Promise<number> {
  const watermark = parseUsageScheduleWatermark(readFileOrNull(watermarkPath))
  const due = usageSchedulePeriodsDue(now, watermark)
  if (due.length === 0) return 0
  let next = watermark
  for (const item of due) {
    const body = await scheduledUsageBody(item)
    if (body === null) continue
    if (!(await deliverScheduledReport(item, body, dryRun))) continue
    next = item.period === "week" ? { ...next, lastWeekReported: item.id } : { ...next, lastMonthReported: item.id }
    persistWatermarkAfterSend(watermarkPath, next, item.title)
  }
  return 0
}
