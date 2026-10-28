// daemon-runtime/cli-main: the tg-ctl CLI dispatch, extracted verbatim from the import.meta.main block.
import { writeStdoutLine } from "../../cli/stdout-line"
import { join } from "path"
import { parseControlConfig, resolveControlConfig } from "../config"
import { readConfigFile } from "../../config/config-file"
import { runOmpLiveCommand } from "../../../tools/omp-live-cli.mjs"
import { botIdFromToken, ctlPaths } from "../lock"
import { CAPABILITIES, CAPABILITIES_SCHEMA_VERSION, OWNER_ONLY_FLAG, parseGenericAskArgv } from "../generic-ask"
import { parseVoiceConfig, resolveVoiceConfig } from "../voice"
import { USAGE } from "./constants"
import { installHooks } from "./hooks-setup"
import { loadEnv, parseStartFlags, readStdinText, resolveConfigDir, type Ctx } from "./ctx-io"
import { disableUsageSchedule, enableUsageSchedule, runUsageScheduleCheck } from "./usage-schedule"
import { runVoiceSetup } from "./voice-setup"
import { disableAutostart, enableAutostart, launchdDomain, restartDaemon, startLauncher, stopDaemon } from "./daemon-service"
import { refreshOriginalHosts } from "./session-registry"
import { composeStatus, topicSettingsLine } from "./status-command"
import { runInboxCommand } from "./stranded-inbox"
import { askDaemon, runGenericAsk, runWithdrawCommand, signalExit, verifyGrantArgvFrom, verifyGrantDaemon } from "./ask-client"
import { runAlertCommand } from "./alert-commands"
import { runAuditDelivery } from "./delivery"
import { runAutoContinueOnce, runCodexUsageHook, runHarnessEvent } from "./harness-event"
import { runDaemon } from "./run-daemon"

type GenericAsk = NonNullable<ReturnType<typeof parseGenericAskArgv>>
type CliEnv = Record<string, string | undefined>

const KNOWN_COMMANDS = ["start", "run", "stop", "restart", "status", "enable", "disable", "ask", "withdraw", "install-hooks", "voice-setup", "harness-event", "codex-usage-hook", "auto-continue-once", "usage-schedule", "usage-schedule-check", "inbox", "audit-delivery", "alert", "capabilities"]

const OWNER_ONLY_USAGE = "usage: tg-ctl ask --owner-only <question> [--timeout SEC]"

// Exits that need no config, env, network or daemon access; order matters (first match wins).
async function exitEarlyWithoutConfig(cmd: string | undefined): Promise<void> {
  if (cmd === "omp-live") process.exit(await runOmpLiveCommand(process.argv.slice(3)))
  // Bare invocation (no subcommand) prints HELP on stdout and exits 0 — it NEVER launches the
  // daemon (the shared service-management contract: a bare `<tool> <service>` is help, not run).
  if (!cmd || cmd === "-h" || cmd === "--help") {
    writeStdoutLine(USAGE)
    process.exit(0)
  }
  // Internal one-shot child spawned by `harness-event`; intentionally absent
  // from USAGE and guarded by persisted retry state before it can inject text.
  if (!KNOWN_COMMANDS.includes(cmd)) {
    console.error(USAGE)
    process.exit(1)
  }
  // `ask --help` / `ask -h` (exactly one arg) is help: print usage before any config, auth,
  // daemon or network access so it can never be posted as a question.
  if (cmd === "ask" && process.argv.length === 4 && (process.argv[3] === "--help" || process.argv[3] === "-h")) {
    writeStdoutLine(USAGE)
    process.exit(0)
  }
  if (cmd === "capabilities") exitCapabilities()
  if (cmd === "ask" && process.argv.slice(3).includes(OWNER_ONLY_FLAG) && process.argv.slice(3).some((a) => a === "--help" || a === "-h")) {
    console.error(OWNER_ONLY_USAGE)
    process.exit(2)
  }
}

// `capabilities --json`: static feature markers, no config, env, network or daemon access.
function exitCapabilities(): never {
  if (process.argv.length === 4 && process.argv[3] === "--json") {
    writeStdoutLine(JSON.stringify({ schema_version: CAPABILITIES_SCHEMA_VERSION, capabilities: [...CAPABILITIES] }))
    process.exit(0)
  }
  console.error("usage: tg-ctl capabilities --json")
  process.exit(2)
}

// `tg-ctl ask "<question>"` (tg-cli#149) fails CLOSED on every path below; the
// internal hook-client shapes (parseGenericAskArgv → null) keep their exit-0
// fast passthrough.
function parseGenericAskOrExit(cmd: string): GenericAsk | null {
  const genericAsk = cmd === "ask" ? parseGenericAskArgv(process.argv.slice(3)) : null
  if (genericAsk?.ownerOnly && !genericAsk.question.trim()) {
    console.error(OWNER_ONLY_USAGE)
    process.exit(2)
  }
  if (genericAsk && !genericAsk.question.trim()) {
    console.error("denied: empty question")
    process.exit(1)
  }
  return genericAsk
}

// usage-schedule-check is a LOCAL date check that shells out to `rig`/`tg` directly (no
// Bot API call via ctx) — runs before the bot-token gate, same reasoning as voice-setup.
// `tg` itself owns bot-token resolution for the actual send. The watermark path is still
// keyed by bot id (same scheme as every other per-bot state file, see ctlPaths) so two
// bots on one machine never share a schedule — that needs only the token's id part, not
// the full token gate below.
async function runUsageScheduleCheckCommand(configDir: string, env: CliEnv): Promise<never> {
  const dryRun = process.env.TG_USAGE_SCHEDULE_DRY_RUN === "1" || process.argv.includes("--dry-run")
  const watermarkPath = ctlPaths(configDir, botIdFromToken(env.TG_BOT_TOKEN ?? "") || "unknown").usageSchedule
  process.exit(await runUsageScheduleCheck(new Date(), dryRun, watermarkPath))
}

// voice-setup is a LOCAL probe + install + config write — no Telegram I/O, so it
// runs before the bot-token gate (a user may set up voice before configuring creds).
function runVoiceSetupCommand(configDir: string, home: string): never {
  const setupArgs = process.argv.slice(3)
  const unknown = setupArgs.filter((a) => a !== "--dry-run")
  if (unknown.length > 0) {
    console.error(`tg-ctl voice-setup: unknown argument ${unknown[0]} (usage: tg-ctl voice-setup [--dry-run])`)
    process.exit(2)
  }
  // Probe/install first: a failed install must not initialize config metadata.
  const configYaml = readConfigFile(configDir, { readOnly: true })
  const current = resolveVoiceConfig(parseVoiceConfig(configYaml))
  const ok = runVoiceSetup({ configDir, home, current, dryRun: setupArgs.includes("--dry-run") })
  // Ready configurations are persisted above; successful guidance/no-op paths
  // also refresh editor metadata, while failures and dry-runs skip this refresh.
  if (ok && !setupArgs.includes("--dry-run")) readConfigFile(configDir)
  process.exit(ok ? 0 : 1)
}

function exitUnlessBotCredentials(cmd: string, configDir: string, env: CliEnv, genericAsk: GenericAsk | null): { token: string; botId: string } {
  const token = env.TG_BOT_TOKEN ?? ""
  const botId = botIdFromToken(token)
  const missing = !botId || !env.TG_CHAT_ID
  if (genericAsk && missing) {
    console.error("denied: no bot credentials configured")
    process.exit(1)
  }
  if ((cmd === "ask" || cmd === "codex-usage-hook") && missing) process.exit(0)
  if (missing) {
    console.error(`Error: TG_BOT_TOKEN and TG_CHAT_ID must be set in ${join(configDir, ".env")} — run \`tg auth\` to connect.`)
    process.exit(1)
  }
  return { token, botId }
}

function buildCtx(configDir: string, home: string, env: CliEnv, creds: { token: string; botId: string }): Ctx {
  const configYaml = readConfigFile(configDir, { readOnly: process.argv.slice(3).some((arg) => ["--dry-run", "--help", "-h", "--version", "-v"].includes(arg)) })
  const cfg = resolveControlConfig(parseControlConfig(configYaml))
  const voice = resolveVoiceConfig(parseVoiceConfig(configYaml))
  return {
    configDir,
    paths: ctlPaths(configDir, creds.botId),
    cfg,
    voice,
    token: creds.token,
    chatId: Number(env.TG_CHAT_ID),
    apiBase: env.TG_API_BASE || "https://api.telegram.org",
    botId: creds.botId,
    home,
    cwd: process.cwd(),
  }
}

function runStartCommand(ctx: Ctx): never {
  startLauncher(ctx, parseStartFlags(process.argv.slice(3)))
  process.exit(0)
}

function runStopCommand(ctx: Ctx): never {
  const stopped = stopDaemon(ctx)
  if (stopped.kind === "stopped" && stopped.launchdLabel) {
    writeStdoutLine(
      `tg-ctl: note — launchd job ${stopped.launchdLabel} supervises the daemon and may relaunch it; ` +
        `\`tg-ctl disable\` (or \`launchctl bootout ${launchdDomain()}/${stopped.launchdLabel}\`) keeps it down.`,
    )
  }
  process.exit(stopped.kind === "still-alive" ? 1 : 0)
}

function runRestartCommand(ctx: Ctx): never {
  const args = process.argv.slice(3)
  process.exit(restartDaemon(ctx, parseStartFlags(args), args.includes("--if-stale")))
}

function runEnableCommand(ctx: Ctx): never {
  process.exit(enableAutostart(ctx, process.argv.includes("--dry-run")))
}

function runDisableCommand(ctx: Ctx): never {
  process.exit(disableAutostart(ctx))
}

function runUsageScheduleCommand(ctx: Ctx): never {
  const sub = process.argv[3]
  if (sub === "enable") process.exit(enableUsageSchedule(ctx, process.argv.includes("--dry-run")))
  if (sub === "disable") process.exit(disableUsageSchedule(ctx))
  console.error("usage: tg-ctl usage-schedule enable|disable [--dry-run]")
  process.exit(1)
}

async function runStatusCommand(ctx: Ctx): Promise<never> {
  await refreshOriginalHosts()
  writeStdoutLine(composeStatus(ctx, null, await topicSettingsLine(ctx)))
  process.exit(0)
}

function runInboxCliCommand(ctx: Ctx): never {
  process.exit(runInboxCommand(ctx, process.argv.slice(3)))
}

async function runWithdrawCliCommand(ctx: Ctx): Promise<never> {
  process.exit(await runWithdrawCommand(ctx, process.argv.slice(3)))
}

async function runAlertCliCommand(ctx: Ctx): Promise<never> {
  process.exit(await runAlertCommand(ctx, process.argv.slice(3)))
}

function runAuditDeliveryCliCommand(ctx: Ctx): never {
  process.exit(runAuditDelivery(ctx, process.argv.slice(3)))
}

async function readVerifyGrantPayload(): Promise<unknown> {
  try {
    return JSON.parse(await readStdinText())
  } catch {
    return null // the daemon denies malformed payloads fail-closed
  }
}

async function runAskCommand(ctx: Ctx, genericAsk: GenericAsk | null): Promise<never> {
  // A generic question first: parseGenericAskArgv returns null for every
  // internal shape, so a `--verify-grant` word inside an unquoted question can
  // never reach the grant client below (which exits 0).
  if (genericAsk) {
    const code = await runGenericAsk(ctx, genericAsk.question, genericAsk.timeout, genericAsk.ownerOnly)
    if (signalExit) await signalExit
    process.exit(code)
  }
  // Grant-protocol client (tg-cli#398): `--verify-grant <approval_id> --hook
  // <hook_id>` (TOKEN path) or `--verify-grant --pull --hook <hook_id>` (PULL
  // path) — stdin carries the normalized payload with the recomputed
  // `operation`. Intercepted BEFORE askDaemon so the stdin payload flows to
  // the verify exchange, not the question normalizer.
  const verifyArgv = verifyGrantArgvFrom(process.argv.slice(3))
  if (verifyArgv) {
    await verifyGrantDaemon(ctx, verifyArgv, await readVerifyGrantPayload())
    process.exit(0)
  }
  await askDaemon(ctx)
  if (signalExit) await signalExit
  process.exit(0)
}

async function runHarnessEventCommand(ctx: Ctx): Promise<never> {
  process.exit(await runHarnessEvent(ctx, process.argv.slice(3), Date.now()))
}

async function runCodexUsageHookCommand(ctx: Ctx): Promise<never> {
  process.exit(await runCodexUsageHook(ctx, Date.now()))
}

async function runAutoContinueOnceCommand(ctx: Ctx): Promise<never> {
  process.exit(await runAutoContinueOnce(ctx, process.argv.slice(3)))
}

const CTX_COMMANDS: Record<string, (ctx: Ctx) => unknown> = {
  start: runStartCommand,
  stop: runStopCommand,
  restart: runRestartCommand,
  enable: runEnableCommand,
  disable: runDisableCommand,
  "usage-schedule": runUsageScheduleCommand,
  status: runStatusCommand,
  inbox: runInboxCliCommand,
  withdraw: runWithdrawCliCommand,
  alert: runAlertCliCommand,
  "audit-delivery": runAuditDeliveryCliCommand,
  "harness-event": runHarnessEventCommand,
  "codex-usage-hook": runCodexUsageHookCommand,
  "auto-continue-once": runAutoContinueOnceCommand,
}

export async function runCli(): Promise<void> {
  const cmd = process.argv[2]
  await exitEarlyWithoutConfig(cmd)

  const home = process.env.HOME ?? "~"
  // install-hooks edits ~/.claude/settings.json only — no bot token needed.
  if (cmd === "install-hooks") process.exit(installHooks(home))
  // TG_CTL_CONFIG_DIR exists so tests can point a spawned daemon at a tmpdir. Resolve it to an
  // ABSOLUTE path: `enable` pins this dir into the launchd/systemd unit, and the OS launches the
  // login daemon from its own cwd (not the shell's) — a relative override would resolve against
  // the wrong directory and silently miss the .env it was enabled with. (The default branch is
  // already absolute, so this is a no-op there.)
  const configDir = resolveConfigDir(home)
  const fileEnv = loadEnv(join(configDir, ".env"))
  const env = { ...fileEnv, ...process.env }
  const genericAsk = parseGenericAskOrExit(cmd)

  if (cmd === "usage-schedule-check") await runUsageScheduleCheckCommand(configDir, env)
  if (cmd === "voice-setup") runVoiceSetupCommand(configDir, home)

  const ctx = buildCtx(configDir, home, env, exitUnlessBotCredentials(cmd, configDir, env, genericAsk))
  if (cmd === "ask") await runAskCommand(ctx, genericAsk)
  const run = CTX_COMMANDS[cmd]
  if (run) {
    await run(ctx)
    return
  }
  await runDaemon(ctx)
}
