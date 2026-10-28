// The subcommands `tg` handles before any flag/feature/credential parsing (tg-cli#817: moved out
// of the entrypoint). Each subcommand is a matcher + runner that exits the process when it
// handles argv and returns otherwise; the dispatcher walks them in the original order, so prose
// that merely starts with a subcommand word still falls through and sends.
import { writeStdoutLine } from "../stdout-line"
import { lstatSync, readFileSync } from "fs"
import { join } from "path"
import { AUTH_USAGE, parseAuthArgs } from "../../auth/args"
import { runAuth } from "../../auth/cli"
import { CHATGPT_USAGE } from "../../chatgpt/args"
import { runChatgptCli } from "../../chatgpt/cli"
import { spawnPmRunner } from "../../chatgpt/pm-runner"
import { loadEnv } from "../../config/env"
import { renderConfigHelp } from "../../config/schema"
import { CONFIG_VALIDATE_USAGE, renderValidation, validateConfigText } from "../../config/validate"
import { runHooksCli } from "../../hooks/cli"
import { installSkill } from "../../install-skill/install"
import { formatHelp } from "../../render/format-help"
import { colorizeHelp, shouldColorize } from "../../render/help-color"
import { parseUserAccountArgs } from "../../user-account/args"
import { runUserAccount } from "../../user-account/cli"
import { userAccountDeps } from "../../user-account/sidecar-fs"
import { OBLIGATIONS_USAGE } from "../obligations"
import { buildReportSend, isReportError, isReportHelp, REPORT_USAGE } from "../report"
import { authDeps } from "./auth-deps"
import { runObligationsSubcommand } from "./subcommands-obligations"
import { applyUserShorthand, runRepliesSubcommand } from "./subcommands-replies"
import type { RuntimePaths } from "./types"
import { USAGE } from "./usage"

const HELP_FLAGS = ["help", "--help", "-h"]

// Register `tg` as a skill in agent harnesses. Runs before any flag/feature
// parsing so it works in a bare environment (e.g. from the installer).
// Exact-match only, so `tg "install-skill"` still sends that as a message.
function runInstallSkill(rawArgs: string[]): void {
  if (rawArgs.length === 1 && rawArgs[0] === "install-skill") {
    process.exit(installSkill())
  }
}

// Configuration help is static: no config/credential reads or initialization.
// Match the complete command so prose beginning with "config" still sends.
function runConfigHelp(rawArgs: string[], paths: RuntimePaths): void {
  if (
    rawArgs.length === 2 &&
    ((rawArgs[0] === "help" && rawArgs[1] === "config") ||
      (rawArgs[0] === "config" && HELP_FLAGS.includes(rawArgs[1])))
  ) {
    writeStdoutLine(colorizeHelp(renderConfigHelp(paths.configDir), shouldColorize()))
    process.exit(0)
  }
}

// A dangling symlink is a broken configuration, not an absent file.
function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function readConfigYamlOrExit(configPath: string): string {
  try {
    return readFileSync(configPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lstatExists(configPath)) {
      writeStdoutLine(`${configPath}: not found; defaults apply`)
      process.exit(0)
    }
    const dangling = (error as NodeJS.ErrnoException).code === "ENOENT" ? " (dangling symlink)" : ""
    console.error(`${configPath}: error: cannot read${dangling}: ${(error as Error).message}`)
    process.exit(1)
  }
}

// `tg config validate`: read-only check of config.yaml. Exact commands only, so prose
// such as "config validate my file" still sends. No credential, network or write path.
function runConfigValidate(rawArgs: string[], paths: RuntimePaths): void {
  if (rawArgs.length === 3 && rawArgs[0] === "config" && rawArgs[1] === "validate") {
    if (HELP_FLAGS.includes(rawArgs[2])) {
      process.stdout.write(CONFIG_VALIDATE_USAGE)
      process.exit(0)
    }
  }
  if (rawArgs.length === 2 && rawArgs[0] === "config" && rawArgs[1] === "validate") {
    const configPath = join(paths.configDir, "config.yaml")
    const raw = readConfigYamlOrExit(configPath)
    const verdict = renderValidation(configPath, validateConfigText(raw))
    process.stderr.write(verdict.stderr)
    process.stdout.write(verdict.stdout)
    process.exit(verdict.code)
  }
}

// `tg auth …` — the bot connection AND the user's own accounts (docs/specs/tg-auth.md):
// one parser, one help. Runs before every credential gate: it is how the credentials get
// there. Exact-match leading token (parseAuthArgs → null for prose like
// `tg auth is broken`, which still sends). `tg auth user|caller …` comes back as
// `{ account }` and runs through the MTProto sidecar, never the Bot API.
async function runAuthSubcommand(rawArgs: string[], paths: RuntimePaths): Promise<void> {
  const authCmd = parseAuthArgs(rawArgs)
  if (authCmd === null) return
  if ("error" in authCmd) {
    console.error(`Error: ${authCmd.error}`)
    process.exit(2)
  }
  if ("account" in authCmd) {
    process.exit(await runUserAccount(authCmd.account, userAccountDeps(paths.configDir, paths.rootDir, paths.home)))
  }
  process.exit(await runAuth(authCmd, authDeps(paths.configDir)))
}

// `tg call <peer>`, `tg user send <peer>` — the user's OWN Telegram account over MTProto,
// via the Python sidecar (docs/specs/independent-telegram-clients.md). Exact-match leading
// tokens; runs before the `tg user` → `tg replies user` shorthand, which keeps every other argv.
async function runUserAccountSubcommand(rawArgs: string[], paths: RuntimePaths): Promise<void> {
  const userAccount = parseUserAccountArgs(rawArgs)
  if (userAccount === null) return
  process.exit(await runUserAccount(userAccount, userAccountDeps(paths.configDir, paths.rootDir, paths.home)))
}

// `tg hooks ...` — list / trust / untrust for pre-send-photo hooks. Hooks are
// trust-by-default (they run with no trust step), so `trust` is a no-op unless
// AGENTS_HOOKS_TRUST=1 re-engages the TOFU pin. Exact-match leading token, so
// `tg "hooks ..."` as a plain message still sends. Returns null when argv is
// not a hooks subcommand. Pass the SAME merged config+process env the later
// gate uses (config `.env` → process.env precedence) so AGENTS_HOOKS_TRUST set
// in the resolved config dir's .env governs `hooks list/trust` exactly as it
// governs a real send — otherwise `trust` would no-op while sends still quarantine.
function runHooksSubcommand(rawArgs: string[], paths: RuntimePaths): void {
  if (rawArgs[0] !== "hooks") return
  const hooksEnv = {
    ...loadEnv(join(paths.configDir, ".env")),
    ...process.env,
  }
  const code = runHooksCli(rawArgs, paths.home, hooksEnv)
  if (code !== null) process.exit(code)
}

// `tg chatgpt …` — ChatGPT session control through `pm chatgpt api` (features/chatgpt,
// docs/chatgpt.md). Handled BEFORE every other path and ALWAYS ends in process.exit with the
// CLI's own code, so no chatgpt invocation — valid, malformed or unknown — can fall through to
// the generic Telegram send below. Unknown subcommands/options exit 2 on stderr.
async function runChatgptSubcommand(rawArgs: string[]): Promise<void> {
  if (rawArgs[0] !== "chatgpt") return
  const result = await runChatgptCli(rawArgs.slice(1), { run: spawnPmRunner })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}

// `tg voice setup` — (re)configure inbound voice transcription (STT). Keeps a
// working voice: config, else uses a local Whisper (~/xp first), else installs
// a prebuilt one (Homebrew whisper.cpp on macOS, faster-whisper wheels on
// Linux), persists runner/model/language into config.yaml, and prints the
// guidance. Delegated to `tg-ctl voice-setup` so the logic lives in ONE place.
// EXACT match only: bare `tg voice` (1 token), `tg voice setup` (2 tokens) or
// `tg voice setup --dry-run` (3). A longer first arg like `tg voice setup is
// done` is an ordinary message and must still send — hence the length guard,
// not just `rawArgs[1] === "setup"`.
function runVoiceSetup(rawArgs: string[], paths: RuntimePaths): void {
  if (
    rawArgs[0] === "voice" &&
    (rawArgs.length === 1 ||
      (rawArgs[1] === "setup" && (rawArgs.length === 2 || (rawArgs.length === 3 && rawArgs[2] === "--dry-run"))))
  ) {
    const result = Bun.spawnSync([join(paths.rootDir, "tg-ctl"), "voice-setup", ...rawArgs.slice(2)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      // An install downloads ~1-3 GB (wheels + model); bounded, but not by a probe's budget.
      timeout: 60 * 60_000,
    })
    process.exit(result.exitCode ?? 1)
  }
}

// Topic-help texts, computed on demand (colorization is decided at print time).
const HELP_TOPIC_TEXT: Record<string, () => string> = {
  format: formatHelp,
  report: () => REPORT_USAGE,
  auth: () => AUTH_USAGE,
  obligations: () => OBLIGATIONS_USAGE,
  chatgpt: () => CHATGPT_USAGE,
}

// `tg help [<topic>]` — standard topic-help (the ecosystem convention; NOT a
// bespoke `--format-help` flag). `tg help format` prints the message-formatting
// reference; `tg help` (no/unknown topic) prints the main help, which lists the
// available topics. Exact leading-token match only, so `tg "help me"` (a longer
// first token followed by prose) still sends as an ordinary message. The
// `--format-help` flag is kept as a back-compat alias (handled via parseArgs).
function runHelpTopics(rawArgs: string[]): void {
  if (
    rawArgs[0] !== "help" ||
    !(rawArgs.length === 1 || (rawArgs.length === 2 && !rawArgs[1].startsWith("-")))
  ) {
    return
  }
  const topic = rawArgs[1]
  if (topic !== undefined && Object.hasOwn(HELP_TOPIC_TEXT, topic)) {
    writeStdoutLine(colorizeHelp(HELP_TOPIC_TEXT[topic](), shouldColorize()))
    process.exit(0)
  }
  if (topic === undefined) {
    writeStdoutLine(colorizeHelp(USAGE, shouldColorize()))
    process.exit(0)
  }
  // A `tg help <unknown>` names a topic that does not exist — say so (3-part:
  // WHAT/WHY/HOW) on stderr and exit non-zero, rather than silently sending it.
  console.error(`Error: unknown help topic '${topic}'. Available topics: format, config, report, auth, obligations, chatgpt. See \`tg help\`.`)
  process.exit(1)
}

// `tg report --title … (--ticket … | --pr …) --impact … --verify-cmd … --verify-result …`
// — formats a structured result report and re-enters the normal send pipeline
// with --tag report --format html (features/cli/report.ts owns the pure
// parsing/formatting; this block owns I/O + argv splicing, same shape as the
// `user`/`replies` subcommands). Exact leading-token match; second token
// must be "-h" or a real "--flag" (or absent) — so `tg report failure` as
// prose still sends, and so does prose starting with a single dash like
// `tg report -50% latency regression` (buildReportSend itself only ever
// accepts "-h"/"--help" or a "--"-prefixed flag, so the guard mirrors that
// exactly instead of engaging on any leading "-").
function spliceReport(rawArgs: string[]): void {
  if (
    rawArgs[0] === "report" &&
    (rawArgs.length === 1 || rawArgs[1] === "-h" || rawArgs[1].startsWith("--"))
  ) {
    const result = buildReportSend(rawArgs.slice(1))
    if (isReportHelp(result)) {
      writeStdoutLine(colorizeHelp(result.help, shouldColorize()))
      process.exit(0)
    }
    if (isReportError(result)) {
      console.error(result.error)
      process.exit(1)
    }
    process.argv.splice(2, process.argv.length - 2, ...result.argv)
    rawArgs.splice(0, rawArgs.length, ...result.argv)
  }
}

export async function runSubcommands(rawArgs: string[], paths: RuntimePaths): Promise<void> {
  runInstallSkill(rawArgs)
  runConfigHelp(rawArgs, paths)
  runConfigValidate(rawArgs, paths)
  await runAuthSubcommand(rawArgs, paths)
  await runUserAccountSubcommand(rawArgs, paths)
  runHooksSubcommand(rawArgs, paths)
  await runChatgptSubcommand(rawArgs)
  runVoiceSetup(rawArgs, paths)
  runHelpTopics(rawArgs)
  runObligationsSubcommand(rawArgs, paths.configDir)
  applyUserShorthand(rawArgs)
  runRepliesSubcommand(rawArgs, paths.configDir)
  spliceReport(rawArgs)
}
