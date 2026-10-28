// daemon-runtime/daemon-service: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { LAUNCHD_LABEL, autostartKind, autostartKindLabel, autostartStatusLine, autostartUnitPath, buildDisablePlan, buildEnablePlan, defaultConfigDir, launchdJobConfigDir, launchdJobIsPersistent, parseLaunchctlListJobs, parseLaunchctlListLabels, parseLaunchctlPrintArgv, parseLaunchctlPrintEnvironment, parseLaunchctlPrintPid, selectExternalLaunchdSupervisor, selectLaunchdDaemonJob, type AutostartCommand, type AutostartEnv, type AutostartKind, type DisablePlan, type EnablePlan, type ProbedLaunchdJob } from "../autostart"
import { daemonRunState, ownsPidFile, readPidFile, type DaemonRunState } from "../lock"
import { assessCodeFreshness, codeFreshnessLine, parseRunInfo, serializeRunInfo, shouldRestartForFreshness, type CodeFreshness } from "../code-freshness"
import { parseRegistrations, serializeRegistrations, upsertRegistration } from "../registration-store"
import { fsRoutesLockIo, withRoutesLock } from "../routes"
import type { Registration } from "../types"
import { atomicWrite, kill0, readFileOrNull, type Ctx, type StartFlags } from "./ctx-io"
import { GRACEFUL_SHUTDOWN_MS, OVERLOAD_RETRY_LOCK_ATTEMPTS, OVERLOAD_RETRY_LOCK_DELAY_MS } from "./constants"
import { daemonLockHeldBy, lockHolderPid } from "./daemon-lock"
import { rootScriptPath } from "./root-script"

// --- start: registration snapshot + detached daemon spawn, then exit ---

export function startLauncher(ctx: Ctx, flags: StartFlags): void {
  recordStartRegistration(ctx, flags)

  // No lock, no pipes (see header). The daemon flocks first and exits 0 if
  // another instance holds the bot, so double-starts are a cheap no-op.
  const logFd = openSync(ctx.paths.log, "a")
  const runBin = resolveDeployedBin(ctx.home)
  const runCwd = dirname(runBin)
  // Pin cwd + PWD to the deployed bin dir so a caller's worktree can be removed
  // after `start` without leaving the long-lived daemon on a deleted cwd.
  const proc = Bun.spawn([process.execPath, runBin, "run"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: runCwd,
    env: { ...process.env, PWD: runCwd, TG_CTL_CONFIG_DIR: ctx.configDir },
  })
  proc.unref()
  closeSync(logFd) // the child holds its own dup
  writeStdoutLine(`tg-ctl: daemon launch requested (bot ${ctx.botId}) — log: ${ctx.paths.log}`)
  // Hint at autostart unless it's already installed, so a one-shot `start` doesn't silently die
  // at the next reboot (the shared service-management contract: start HINTS at enable). Skipped
  // on the no-op fallback OS, where there's nothing to enable.
  const env = autostartEnv(ctx)
  if (autostartKind(env) !== "none" && !autostartUnitInstalled(env)) {
    writeStdoutLine("tg-ctl: not set to start at login — run `tg-ctl enable` to survive reboots.")
  }
}

export function recordStartRegistration(ctx: Ctx, flags: StartFlags): void {
  mkdirSync(ctx.configDir, { recursive: true })
  // UPSERT this session's entry into the per-pane registration SET (tg-cli#67),
  // keyed by paneId — instead of OVERWRITING one global slot. A `tg` send from
  // any OTHER live session no longer clobbers this session's registration, so
  // every concurrently-registered session's questions keep forwarding. Written
  // synchronously EVEN IF the daemon already runs — a fresh `tg` call re-targets
  // a long-lived daemon at the current pane (its own entry only).
  const reg: Registration = { registeredAt: Math.floor(Date.now() / 1000) }
  if (flags.paneId) reg.paneId = flags.paneId
  if (flags.cwd) reg.cwd = flags.cwd
  if (flags.session) reg.sessionName = flags.session
  // Serialize the read-modify-write across concurrent `tg start`s (two sessions
  // racing the upsert would last-writer-wins-clobber each other's entry — the
  // very lost-update the routes lock was built for). Same O_EXCL lockfile +
  // PID-liveness break; onContended:'skip' loses only THIS start's bookkeeping,
  // never another session's entry. Best-effort: a write failure must never block
  // the daemon launch below, so the whole RMW is swallowed.
  try {
    withRoutesLock(
      fsRoutesLockIo(`${ctx.paths.registration}.lock`),
      () => {
        let raw: string | null
        try {
          raw = readFileSync(ctx.paths.registration, "utf8")
        } catch {
          raw = null
        }
        writeFileSync(
          ctx.paths.registration,
          serializeRegistrations(upsertRegistration(parseRegistrations(raw), reg)),
        )
      },
      { attempts: OVERLOAD_RETRY_LOCK_ATTEMPTS, delayMs: OVERLOAD_RETRY_LOCK_DELAY_MS, onContended: "skip" },
    )
  } catch {
    // best-effort registration bookkeeping — never block the daemon launch
  }
}

// --- stop / restart / status ---

// Locate the daemon through the pidfile → flock holder → launchd chain `status` reports
// (tg-cli#316). `authoritativeLock`: stop/restart always ask the flock — its holder IS the daemon
// (spec §6), so a vanished pidfile can't make them no-op against a live daemon, and a live pidfile
// pid that does not hold the flock (a reused pid) is never signalled (tg-cli#438): with no lock
// holder and no launchd job, a pidfile pid that does not hold the flock is a stale pidfile. `status`
// probes the flock only when the pidfile pid is dead, keeping its cheap path.
export function probeDaemonRunState(ctx: Ctx, authoritativeLock: boolean): DaemonRunState {
  const pid = readPidFile(readFileOrNull(ctx.paths.pid))
  const pidAlive = pid !== null && kill0(pid)
  const lockPid = authoritativeLock || !pidAlive ? lockHolderPid(ctx.paths.lock) : null
  const hintPid = lockPid ?? (pidAlive ? pid : null)
  const launchd = detectLaunchdDaemon(autostartEnv(ctx), hintPid)
  const reusedPid = authoritativeLock && pid !== null && pidAlive && lockPid === null && !launchd && !daemonLockHeldBy(ctx.paths.lock, pid)
  return daemonRunState(pid, pidAlive && !reusedPid, launchd, lockPid)
}

// How long `restart` waits for a successor (a launchd relaunch or the detached spawn) to take the
// flock and write its pidfile.
export const SUCCESSOR_WAIT_MS = 15_000

// Re-run `probe` every 100ms until it yields a value or `ms` elapses (then null). Sync on purpose:
// the lifecycle subcommands are one-shot CLI calls with nothing else to run meanwhile.
export function pollSync<T>(probe: () => T | null, ms: number): T | null {
  for (let waited = 0; ; waited += 100) {
    const value = probe()
    if (value !== null || waited >= ms) return value
    Bun.sleepSync(100)
  }
}

export type StopOutcome =
  | { kind: "not-running" }
  | { kind: "stopped"; pid: number; launchdLabel?: string }
  | { kind: "still-alive"; pid: number }

// SIGTERM the located daemon and wait out its drain. "still-alive" means the process outlived the
// ceiling (or could not be signalled): it is NOT stopped, and `restart` must not launch over it.
// `state` is the caller's probe when it already has one (`restart --if-stale`), so one invocation
// acts on one view of the daemon instead of re-probing between the decision and the signal.
export function stopDaemon(ctx: Ctx, state: DaemonRunState = probeDaemonRunState(ctx, true)): StopOutcome {
  if (state.kind === "not-running") {
    writeStdoutLine("tg-ctl: not running")
    return { kind: "not-running" }
  }
  if (state.kind === "stale-pidfile") {
    try {
      unlinkSync(ctx.paths.pid)
    } catch {}
    writeStdoutLine(`tg-ctl: not running (cleaned stale pidfile, pid ${state.pid})`)
    return { kind: "not-running" }
  }
  const pid = state.pid
  try {
    process.kill(pid, "SIGTERM")
  } catch (err) {
    // ESRCH: it exited between the probe and the signal — that IS stopped. Anything else (EPERM:
    // another user's process) leaves it running.
    if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) {
      console.error(`tg-ctl: SIGTERM failed for pid ${pid}: ${err}`)
      return { kind: "still-alive", pid }
    }
  }
  // Poll until the pid is gone, NOT a flat sleep: returning while the old daemon still owns the
  // flock would make `restart`'s successor no-op-exit on it and, once the old one drains, leave
  // NOTHING running (review: restart can leave no daemon). Ceiling: the cooperative drain may hold
  // the flock for GRACEFUL_SHUTDOWN_MS while it finishes the in-flight batch, plus a margin.
  const waitMs = GRACEFUL_SHUTDOWN_MS + 2000
  if (pollSync(() => (kill0(pid) ? null : pid), waitMs) === null) {
    console.error(`tg-ctl: pid ${pid} is still alive ${waitMs / 1000}s after SIGTERM — NOT stopped (\`kill -9 ${pid}\` if it is wedged)`)
    return { kind: "still-alive", pid }
  }
  // The daemon's cleanExit removes its own pidfile; this covers one that died without cleaning up.
  // Ownership-guarded: a launchd KeepAlive relaunch may already have written the successor's pid.
  try {
    if (ownsPidFile(readFileOrNull(ctx.paths.pid), pid)) unlinkSync(ctx.paths.pid)
  } catch {}
  writeStdoutLine(`tg-ctl: stopped (pid ${pid})`)
  return { kind: "stopped", pid, launchdLabel: state.owner === "launchd" ? state.label : undefined }
}

// `restart --if-stale` gate (tg-cli#279): proceed only when a daemon runs whose loaded code is not
// proven current. Otherwise `exit` is the code to return right away.
function staleRestartGate(ctx: Ctx): { exit: number } | { running: DaemonRunState } {
  const running = probeDaemonRunState(ctx, true)
  if (running.kind !== "running") {
    writeStdoutLine("tg-ctl: not running — nothing to restart")
    return { exit: 0 }
  }
  const freshness = assessRunningCode(ctx, running.pid)
  if (!shouldRestartForFreshness(freshness)) {
    writeStdoutLine(`tg-ctl: ${codeFreshnessLine(freshness)} — no restart needed`)
    return { exit: 0 }
  }
  writeStdoutLine(`tg-ctl: ${codeFreshnessLine(freshness)} — restarting`)
  return { running }
}

// Bring the daemon back after a stop: under launchd when it owned the old one, else a detached
// start. False when the launchd kickstart failed.
function launchReplacement(ctx: Ctx, flags: StartFlags, launchdLabel: string | undefined): boolean {
  if (!launchdLabel) {
    startLauncher(ctx, flags)
    return true
  }
  recordStartRegistration(ctx, flags)
  return runAutostartCommand({ argv: ["launchctl", "kickstart", `${launchdDomain()}/${launchdLabel}`], describe: `kickstart of launchd job ${launchdLabel}` })
}

// `tg-ctl restart [--if-stale]`: a graceful, VERIFIED reload. Exit 0 only when the old process is
// confirmed dead AND a successor holds the flock (its pidfile names a new live pid) — never
// "restarted" over a still-running old daemon or over nothing (tg-cli#438). A launchd-owned daemon
// comes back under launchd (`launchctl kickstart`; a no-op when a KeepAlive job already relaunched
// it), never as a detached stray fighting launchd for the flock. `--if-stale` is the deploy path
// (tg-cli#279): act only when a daemon runs whose loaded code is not proven current.
export function restartDaemon(ctx: Ctx, flags: StartFlags, ifStale: boolean): number {
  let running: DaemonRunState | undefined
  if (ifStale) {
    const gate = staleRestartGate(ctx)
    if ("exit" in gate) return gate.exit
    running = gate.running
  }
  const stopped = stopDaemon(ctx, running)
  if (stopped.kind === "still-alive") {
    console.error(`tg-ctl: restart aborted — pid ${stopped.pid} is still running; did NOT start a replacement.`)
    return 1
  }
  const oldPid = stopped.kind === "stopped" ? stopped.pid : null
  const launchdLabel = stopped.kind === "stopped" ? stopped.launchdLabel : undefined
  if (!launchReplacement(ctx, flags, launchdLabel)) return 1
  // The daemon writes its pidfile only after taking the flock; still requiring the pidfile pid to
  // hold the flock rejects a detached successor that died right after writing it — our own
  // unreaped child keeps answering kill(0) as a zombie, but the kernel has already released its
  // lock — and a stale pidfile naming some other live pid.
  const successor = pollSync(() => {
    const pid = readPidFile(readFileOrNull(ctx.paths.pid))
    return pid !== null && pid !== oldPid && kill0(pid) && daemonLockHeldBy(ctx.paths.lock, pid) ? pid : null
  }, SUCCESSOR_WAIT_MS)
  if (successor === null) {
    const where = launchdLabel ? `launchd job ${launchdLabel}` : `the daemon log ${ctx.paths.log}`
    console.error(`tg-ctl: restart FAILED — no new daemon took the lock within ${SUCCESSOR_WAIT_MS / 1000}s; check ${where}.`)
    return 1
  }
  writeStdoutLine(oldPid === null ? `tg-ctl: started (pid ${successor})` : `tg-ctl: restarted (pid ${oldPid} → ${successor})`)
  return 0
}

// Run `git -C dir …`; trimmed stdout, or null when git fails / is missing.
export function gitOutput(dir: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" })
    return r.exitCode === 0 ? r.stdout.toString().trim() : null
  } catch {
    return null
  }
}

// Record which commit this daemon process loaded (tg-cli#279) so `status` and `restart --if-stale`
// can compare it with the checkout's HEAD. Best-effort: outside a git checkout nothing is recorded
// and the code identity reads as unknown.
export function recordRunInfo(ctx: Ctx): void {
  try {
    const codeDir = dirname(realpathSync(rootScriptPath()))
    const commit = gitOutput(codeDir, ["rev-parse", "HEAD"])
    if (commit) atomicWrite(ctx.paths.runInfo, serializeRunInfo({ pid: process.pid, commit, codeDir, startedAt: Date.now() }))
  } catch {}
}

// Is the running daemon executing the code its checkout holds now? (tg-cli#279)
export function assessRunningCode(ctx: Ctx, daemonPid: number): CodeFreshness {
  const info = parseRunInfo(readFileOrNull(ctx.paths.runInfo))
  if (info === null || info.pid !== daemonPid) return assessCodeFreshness(info, daemonPid, null, null)
  const head = gitOutput(info.codeDir, ["rev-parse", "HEAD"])
  let changed: string[] | null = []
  if (head !== null && head !== info.commit) {
    const out = gitOutput(info.codeDir, ["diff", "--name-only", info.commit, head])
    changed = out === null ? null : out.split("\n").filter(Boolean)
  }
  return assessCodeFreshness(info, daemonPid, head, changed)
}

// --- enable / disable: OS autostart self-registration (the agenttools_service contract) ---

// Exit code for an autostart enable/disable that failed to install/remove the OS unit (the OS
// control command returned nonzero, or the unit file could not be written/removed). Mirrors the
// agenttools_service contract's exit-code 4 for "autostart enable/disable failed", so a script
// can branch on "the service is up but autostart is NOT live".
export const EXIT_AUTOSTART_FAILED = 4

// Resolve the path the autostart unit should launch. launchd/systemd run the agent with a
// minimal PATH, so argv MUST be absolute. The deployed binary is the ~/.files/bin/tg-ctl symlink
// on PATH; fall back to this script's own path when it isn't installed (e.g. a worktree run) so
// `enable` from a dev checkout still launches the right file.
export function resolveDeployedBin(home: string): string {
  const deployed = join(home, ".files", "bin", "tg-ctl")
  return existsSync(deployed) ? deployed : rootScriptPath()
}

// True when `systemctl --user` is usable on this Linux host. Cheap probe, never throws. macOS
// never calls this (autostartKind short-circuits to launchd before hasSystemd is read).
export function hasUserSystemd(): boolean {
  try {
    const r = Bun.spawnSync(["systemctl", "--user", "--version"], { stdout: "ignore", stderr: "ignore" })
    return r.exitCode === 0
  } catch {
    return false
  }
}

export function autostartEnv(ctx: Ctx): AutostartEnv {
  return {
    platform: process.platform,
    home: ctx.home,
    binPath: resolveDeployedBin(ctx.home),
    bunPath: process.execPath,
    logPath: ctx.paths.log,
    // The resolved config dir, so a non-default `TG_CTL_CONFIG_DIR=/x tg-ctl enable` pins it into
    // the unit (the OS launches the daemon with a minimal env that wouldn't carry it otherwise).
    configDir: ctx.configDir,
    xdgConfigHome: process.env.XDG_CONFIG_HOME ?? "",
    hasSystemd: process.platform === "linux" ? hasUserSystemd() : false,
  }
}

// The OS unit label/name for an enable-path message. Narrows the type to the kinds that HAVE a unit
// (the "none" fallback installs none) so a fallback can't be mislabeled, and delegates the actual
// mapping to autostartKindLabel — single source of truth shared with the status line, so the two
// can't drift.
export function autostartUnitLabel(kind: "launchd" | "systemd"): string {
  return autostartKindLabel(kind)
}

// Is the launchd/systemd unit file already on disk for tg-ctl? Cheap existence check (no plist/
// unit body rendered); on the no-op fallback (no unit file) this returns false.
export function autostartUnitInstalled(env: AutostartEnv): boolean {
  const path = autostartUnitPath(env)
  return path !== undefined && existsSync(path)
}

// The impure launchd probe behind detectExternalLaunchdSupervisor, factored out so the detection
// flow can be unit-tested with a fake probe (no real launchctl). `listLabels` runs `launchctl list`;
// `printDump(label)` runs `launchctl print <domain>/<label>`. Each returns undefined on failure so
// the caller skips that job instead of crashing.
export interface LaunchctlProbe {
  listLabels(): string[] | undefined
  listJobs(): Array<{ pid: number | null; label: string }> | undefined
  printDump(label: string): string | undefined
}

// A LaunchAgent lives in the per-user `gui/<uid>` domain; under root (uid 0) daemons live in
// `system` instead (`gui/0/<label>` just errors), so pick the domain by uid.
export function launchdDomain(): string {
  const uid = process.getuid?.() ?? 0
  return uid === 0 ? "system" : `gui/${uid}`
}

// The real probe: `launchctl list` for labels, `launchctl print <domain>/<label>` per label.
export function realLaunchctlProbe(): LaunchctlProbe {
  const domain = launchdDomain()
  const listStdout = (): string | undefined => {
    const r = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe", stderr: "ignore" })
    if (r.exitCode !== 0 || !r.stdout) return undefined
    return new TextDecoder().decode(r.stdout)
  }
  return {
    listLabels() {
      const stdout = listStdout()
      return stdout === undefined ? undefined : parseLaunchctlListLabels(stdout)
    },
    listJobs() {
      const stdout = listStdout()
      return stdout === undefined ? undefined : parseLaunchctlListJobs(stdout)
    },
    printDump(label) {
      const r = Bun.spawnSync(["launchctl", "print", `${domain}/${label}`], { stdout: "pipe", stderr: "ignore" })
      if (r.exitCode !== 0 || !r.stdout) return undefined
      return new TextDecoder().decode(r.stdout)
    },
  }
}

// Probe launchd (macOS only) for an EXTERNAL job that supervises this tg-ctl binary — autostart wired
// outside `tg-ctl enable` (e.g. rig's `ai.hyperide.tg-ctl` LaunchAgent). Returns the supervising
// label, or undefined when none / not macOS / launchctl unavailable. Used by `status` to stop lying
// "NOT enabled" while launchd keeps the daemon alive across reboots (tg-cli#88). Read-only.
//
// Builds a ProbedLaunchdJob per loaded label (its argv + whether it's persistent per the `properties`
// line) from the probe, then hands selection to the PURE selectExternalLaunchdSupervisor (which
// excludes tg-ctl's OWN label, requires the `run` subcommand against THIS binary, and rejects a
// loaded-but-temporary job). `probe` is injectable for tests; defaults to the real launchctl probe.
// Fully wrapped so a launchctl hiccup, a non-macOS host, or a missing binary never crashes `status`.
export function detectExternalLaunchdSupervisor(env: AutostartEnv, probe: LaunchctlProbe = realLaunchctlProbe()): string | undefined {
  if (env.platform !== "darwin") return undefined
  if (!env.binPath) return undefined
  try {
    const labels = probe.listLabels()
    if (!labels) return undefined
    const jobs: ProbedLaunchdJob[] = []
    for (const label of labels) {
      if (label === LAUNCHD_LABEL) continue
      const dump = probe.printDump(label)
      if (dump === undefined) continue
      jobs.push({ label, argv: parseLaunchctlPrintArgv(dump), persistent: launchdJobIsPersistent(dump) })
    }
    return selectExternalLaunchdSupervisor(jobs, env.binPath)
  } catch {
    return undefined
  }
}

// Probe launchd for the job that is running THIS bot's daemon right now (tg-cli#316). Unlike
// detectExternalLaunchdSupervisor this includes tg-ctl's own unit, requires a live pid, and matches
// the job's config dir so a test HOME is not reported as ours. Read-only.
//
// Launchd is a LABEL on an already-proven per-bot process (`hintPid` from the pidfile or flock
// holder). It must not invent "running" for a different bot token that shares the config dir
// (review finding). No hint → no launchd claim.
export function detectLaunchdDaemon(
  env: AutostartEnv,
  hintPid: number | null,
  probe: LaunchctlProbe = realLaunchctlProbe(),
): { label: string; pid: number } | undefined {
  if (env.platform !== "darwin") return undefined
  if (!env.binPath) return undefined
  if (hintPid === null) return undefined
  try {
    const listed = probe.listJobs()
    if (!listed) return undefined
    const labels = listed.filter((j) => j.pid === hintPid).map((j) => j.label)
    if (labels.length === 0) return undefined
    const jobs: ProbedLaunchdJob[] = []
    for (const label of labels) {
      const dump = probe.printDump(label)
      if (dump === undefined) continue
      jobs.push({
        label,
        argv: parseLaunchctlPrintArgv(dump),
        persistent: launchdJobIsPersistent(dump),
        pid: parseLaunchctlPrintPid(dump),
        configDir: launchdJobConfigDir(parseLaunchctlPrintEnvironment(dump)),
      })
    }
    return selectLaunchdDaemonJob(jobs, env.binPath, env.configDir, defaultConfigDir(env.home))
  } catch {
    return undefined
  }
}

// The `autostart:` status line. Gathers the impure facts — own-unit file existence and (only when
// that's absent, to skip the launchctl probe otherwise) the external-launchd-supervisor probe — then
// hands them to the PURE autostartStatusLine for precedence + formatting (own-unit before external).
// Keeps composeStatus slim and isolates the one impure probe behind status logic.
export function composeAutostartLine(env: AutostartEnv, kind: AutostartKind): string {
  const ownInstalled = kind !== "none" && autostartUnitInstalled(env)
  // Only probe launchd when the own unit is absent — autostartStatusLine prefers the own unit, so the
  // probe would be wasted work otherwise. The probe itself no-ops off launchd / on non-macOS.
  const external = !ownInstalled && kind === "launchd" ? detectExternalLaunchdSupervisor(env) : undefined
  return autostartStatusLine(kind, ownInstalled, external)
}

// Run one plan command. Returns true on success. An `optional` command that fails is treated as
// success (e.g. `launchctl unload` when nothing was loaded yet). stderr is surfaced on a hard
// failure so the user sees the launchctl/systemctl error.
export function runAutostartCommand(cmd: AutostartCommand): boolean {
  try {
    const r = Bun.spawnSync(cmd.argv, { stdout: "ignore", stderr: "pipe" })
    if (r.exitCode === 0) return true
    if (cmd.optional) return true
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr).trim() : ""
    console.error(`tg-ctl: ${cmd.describe} failed (${cmd.argv.join(" ")}): exit ${r.exitCode}${stderr ? ` — ${stderr}` : ""}`)
    return false
  } catch (err) {
    if (cmd.optional) return true
    console.error(`tg-ctl: ${cmd.describe} failed to spawn (${cmd.argv.join(" ")}): ${err}`)
    return false
  }
}

function printEnableDryRun(plan: EnablePlan): void {
  writeStdoutLine(`tg-ctl: [dry-run] autostart kind: ${plan.kind}` + (plan.kind !== "none" ? `, ${autostartUnitLabel(plan.kind)}` : ""))
  if (plan.kind === "none") {
    writeStdoutLine("tg-ctl: [dry-run] no supported OS autostart — would `tg-ctl start` now (no reboot survival)")
  }
  if (plan.file) writeStdoutLine(`tg-ctl: [dry-run] would write ${plan.file.path}`)
  for (const cmd of plan.commands) writeStdoutLine(`tg-ctl: [dry-run] would run: ${cmd.argv.join(" ")}`)
}

// Write the unit file when the plan has one. Returns false (after reporting) on failure.
function writeAutostartUnitFile(file: EnablePlan["file"]): boolean {
  if (!file) return true
  try {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.content, { mode: file.mode })
    return true
  } catch (err) {
    console.error(`tg-ctl: writing ${file.path} failed: ${err}`)
    return false
  }
}

// Run all commands; the LAST one is the activating one (`launchctl load` / `enable --now`)
// whose success means autostart is live (mirrors the lib gating `enabled` on its exit code).
// Every command runs even after a failure.
function runAllAutostartCommands(commands: AutostartCommand[]): boolean {
  let activated = true
  for (const cmd of commands) {
    if (!runAutostartCommand(cmd)) activated = false
  }
  return activated
}

// `tg-ctl enable [--dry-run]` — install OS autostart AND start now. Mirrors the lib's
// ServiceManager.enable single-owner contract:
//   - launchd/systemd OWN the process (RunAtLoad / enable --now), so we stop any background
//     (pidfile) instance first to avoid two daemons fighting over the bot, then install the unit;
//     the activating command's exit code decides whether autostart is actually live.
//   - if the OS control command FAILS (sandbox / missing binary), OR there's no supported OS
//     autostart at all (the 'none' fallback), we fall back to a plain background `start` so the
//     service is still up now, and report that it will NOT survive reboot (enabled=false).
// Idempotent: re-running re-writes the same unit and reloads it. `--dry-run` prints the plan
// (unit path + launchctl/systemctl commands) and touches nothing — the e2e test uses it so it
// never loads a real LaunchAgent. Returns the process exit code.
export function enableAutostart(ctx: Ctx, dryRun: boolean): number {
  const env = autostartEnv(ctx)
  const plan = buildEnablePlan(env)
  if (dryRun) {
    printEnableDryRun(plan)
    return 0
  }

  // No supported OS autostart: just background-start now (the lib's NoopAutostartBackend path).
  if (plan.kind === "none") {
    startLauncher(ctx, {})
    console.error("tg-ctl: autostart is not supported on this OS — started now, but it will NOT survive reboot.")
    return 0
  }

  // The OS is about to launch its own copy. Stop any background (pidfile) instance first so we
  // don't end up with two processes on the same bot — the no-double-start invariant.
  if (stopDaemon(ctx).kind === "still-alive") {
    console.error("tg-ctl: enable aborted — the running daemon did not stop; autostart NOT installed over it.")
    return EXIT_AUTOSTART_FAILED
  }

  if (!writeAutostartUnitFile(plan.file)) return EXIT_AUTOSTART_FAILED
  if (!runAllAutostartCommands(plan.commands)) {
    // The unit file is on disk but the OS control command failed — autostart is NOT live. Fall
    // back to a background start so the service is at least up now, and report enabled=false.
    console.error(`tg-ctl: ${plan.kind} autostart command failed — falling back to a one-shot start (will NOT survive reboot).`)
    startLauncher(ctx, {})
    return EXIT_AUTOSTART_FAILED
  }
  // Past the kind === "none" early return, a launchd/systemd plan ALWAYS carries a file; narrow
  // explicitly so the success message doesn't lean on a non-null assertion.
  const where = plan.file ? ` at ${plan.file.path}` : ""
  writeStdoutLine(
    `tg-ctl: autostart enabled — ${plan.kind} (${autostartUnitLabel(plan.kind)})${where}. ` +
      "The daemon starts at login and is running now.",
  )
  return 0
}

// Deactivate the OS unit and remove its file — but only when the deactivating command succeeded.
// The first command is the deactivator (unload / disable --now); it gates file removal. Returns
// true when something was left behind (deactivate failed, or the unit file could not be removed).
function removeAutostartUnit(plan: DisablePlan & { filePath: string }): boolean {
  const [deactivateCmd, ...postCmds] = plan.commands
  const ok = deactivateCmd ? runAutostartCommand(deactivateCmd) : true
  if (!ok) {
    // Deactivate failed — leave the file so `status` doesn't lie about the unit being gone.
    console.error(`tg-ctl: ${plan.kind} deactivate failed — leaving the unit file in place (the OS may still be running it).`)
    return true
  }
  let removeFailed = false
  try {
    unlinkSync(plan.filePath)
  } catch (err) {
    console.error(`tg-ctl: removing ${plan.filePath} failed: ${err}`)
    removeFailed = true
  }
  for (const cmd of postCmds) runAutostartCommand(cmd)
  return removeFailed
}

// `tg-ctl disable` — remove OS autostart AND stop the running daemon. Mirrors the lib's
// ServiceManager.disable: run the deactivating command (unload / disable --now) and only remove
// the unit file if it succeeded — a still-loaded unit's file is left in place rather than
// orphaning the live OS process. Then stop any background instance too. Idempotent: a missing
// unit is a no-op, not an error. Returns the process exit code (4 if the OS deactivate failed).
export function disableAutostart(ctx: Ctx): number {
  const env = autostartEnv(ctx)
  const plan = buildDisablePlan(env)
  const removeFailed = plan.filePath !== undefined && existsSync(plan.filePath) ? removeAutostartUnit({ ...plan, filePath: plan.filePath }) : false
  // disable also stops the manager-spawned (background) instance. On launchd/systemd the unload/
  // disable above already stopped the OS-owned copy; this is the catch-all for a pidfile instance.
  const stopped = stopDaemon(ctx)
  if (stopped.kind === "still-alive") {
    console.error(`tg-ctl: disable incomplete — pid ${stopped.pid} is still running.`)
    return EXIT_AUTOSTART_FAILED
  }
  if (removeFailed) return EXIT_AUTOSTART_FAILED
  // On the 'none' fallback there was never an OS unit — say what actually happened (stopped the
  // background instance) rather than the misleading "autostart disabled (none)".
  writeStdoutLine(
    plan.kind === "none"
      ? "tg-ctl: no OS autostart to remove — stopped the background instance."
      : `tg-ctl: autostart disabled (${plan.kind}).`,
  )
  return 0
}
