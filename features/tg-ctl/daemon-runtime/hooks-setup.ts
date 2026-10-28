// daemon-runtime/hooks-setup: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { installOmpLiveExtension } from "../../../tools/omp-live-cli.mjs"
import { claudeStatusLineTelemetryInstalled, reconcileClaudeHooks, runClaudeHookSelfHeal, writeSettingsPreservingLink, withClaudeStatusLineTelemetry, withCodexUsageHook } from "../hook-install"
import { detectRig, NO_RIG_EXIT, runRigDelegate } from "../rig-delegate"
import { codexConfigDir, hasClaudeStatusLineCommand, log, readFileOrNull, readJsonObjectOrNull, resolveConfigDir, type Ctx } from "./ctx-io"
import { CLAUDE_HARNESS_HOOK_CMD, CLAUDE_QUESTION_HOOK_CMD, CLAUDE_STATUSLINE_TELEMETRY_CMD, CODEX_USAGE_HOOK_CMD } from "./constants"

// Shared by `tg-ctl status` (CLI) and the /status command (TG reply). Works
// with no daemon running — everything is read from files + live discovery.
export function findShadowingClaudeStatusLine(home: string, cwd: string, command: string): string | null {
  const userSettingsPath = resolve(home, ".claude", "settings.json")
  let dir = resolve(cwd)
  while (true) {
    for (const name of ["settings.local.json", "settings.json"]) {
      const candidate = resolve(dir, ".claude", name)
      if (candidate === userSettingsPath) continue
      const settings = readJsonObjectOrNull(candidate)
      if (!settings || !hasClaudeStatusLineCommand(settings)) continue
      return claudeStatusLineTelemetryInstalled(settings, command) ? null : candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// The three Claude Code hook commands the daemon owns, as one unit. Shared by
// `install-hooks` and the startup self-heal so both target the identical wiring.
export const CLAUDE_HOOK_COMMANDS = {
  question: CLAUDE_QUESTION_HOOK_CMD,
  harness: CLAUDE_HARNESS_HOOK_CMD,
  statusLine: CLAUDE_STATUSLINE_TELEMETRY_CMD,
}

// Opt-in sentinel: `install-hooks` writes this so the daemon self-heal knows the
// user has ADOPTED the Claude hooks and it may restore them if a rewrite drops
// them. Its absence means "never opted in" → the daemon never first-time-installs
// hooks or rewrites a statusLine behind the user's back.
export function claudeHooksSentinelPath(configDir: string): string {
  return join(configDir, "claude-hooks-installed")
}

// Startup self-heal: re-merge the Claude Code hooks into ~/.claude/settings.json
// when a rewrite dropped any of them — but ONLY for a user who previously ran
// `install-hooks` (the opt-in sentinel). The merge is purely ADDITIVE (reconcile
// appends missing hook groups and WRAPS any existing statusLine so the user's own
// display output is preserved) and CONVERGES after one write. Idempotent (writes
// only on an actual change) and fully best-effort — every failure is swallowed
// with a log line so the daemon always proceeds to its poll loop. Heals only the
// user-scope file; a shadowing project-scoped statusLine is left to the explicit
// `install-hooks`. The backup uses a self-heal-specific suffix + atomicWrite so an
// unattended heal can never clobber the manual `install-hooks` `.bak` nor truncate
// settings.json into garbage that would wedge the next start.
export function ensureClaudeHooksOnStartup(ctx: Ctx): void {
  try {
    const claudeDir = join(ctx.home, ".claude")
    const paths = {
      settingsPath: join(claudeDir, "settings.json"),
      settingsDir: claudeDir,
      sentinelPath: claudeHooksSentinelPath(ctx.configDir),
    }
    const fs = {
      exists: existsSync,
      read: readFileOrNull,
      backup: (p: string, content: string) => {
        try {
          writeFileSync(p, content)
        } catch {}
      },
      writeAtomic: writeSettingsPreservingLink,
      ensureDir: (dir: string) => mkdirSync(dir, { recursive: true }),
      markOptedIn: (p: string) => writeFileSync(p, `${new Date().toISOString()}\n`),
    }
    const res = runClaudeHookSelfHeal(fs, paths, CLAUDE_HOOK_COMMANDS)
    if (res.outcome === "healed") {
      log("ensureClaudeHooksOnStartup: re-merged dropped Claude Code hooks into settings.json")
    }
    if (res.outcome === "migrated") {
      log("ensureClaudeHooksOnStartup: pre-sentinel hook install detected; wrote the opt-in sentinel (#211)")
    }
  } catch (err) {
    log(`ensureClaudeHooksOnStartup failed: ${err}`)
  }
}

// #458: every NEW interactive omp must load the original-process bridge without a
// manual step. Only where omp is actually used (its agent dir exists); the installer
// is idempotent and refuses user-owned or differently-managed loaders. Best-effort.
export async function ensureOmpLiveExtensionOnStartup(ctx: Ctx): Promise<void> {
  const agentRoot = join(ctx.home, ".omp", "agent")
  if (!existsSync(agentRoot)) return
  try {
    const res = await installOmpLiveExtension(agentRoot)
    if (res.changed) log(`omp-live: installed the original-process extension at ${res.path} (new omp sessions load it)`)
  } catch (err) {
    log(`omp-live: extension not installed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Direct fallback writer: merges the Codex Stop usage-telemetry hook straight into
// ~/.codex/hooks.json (backing the file up first). Used when rig is absent, and as the
// telemetry-preservation safety net when rig is present but hasn't provisioned the hook itself
// yet — see installCodexUsageTelemetry below.
export function installCodexUsageTelemetryDirect(codexHooksPath: string, codexRaw: string | null, codexExisting: Record<string, unknown>): void {
  const codexUsage = withCodexUsageHook(codexExisting, CODEX_USAGE_HOOK_CMD)
  if (codexUsage.changed) {
    if (codexRaw) {
      try {
        writeFileSync(`${codexHooksPath}.bak`, codexRaw)
      } catch {}
    }
    mkdirSync(dirname(codexHooksPath), { recursive: true })
    writeFileSync(codexHooksPath, `${JSON.stringify(codexUsage.settings, null, 2)}\n`)
    writeStdoutLine(`tg-ctl: installed Codex Stop usage telemetry collector → ${codexHooksPath}` + (codexRaw ? ` (backup: ${codexHooksPath}.bak)` : ""))
  } else {
    writeStdoutLine("tg-ctl: Codex Stop usage telemetry collector already installed — nothing to do.")
  }
}

// Rig-aware Codex hook provisioning (tg#8672). When rig is present it owns the codex hook
// bridge (writes ~/.codex/config.toml), so writing tg-ctl's own hook straight into
// ~/.codex/hooks.json makes codex warn about loading hooks from both files. Delegate to
// `rig apply` first; rig does NOT yet fold the usage-telemetry Stop hook into its bridge, so we
// always re-check afterwards and only skip the direct hooks.json write when the hook is actually
// found installed — telemetry must never be silently lost while rig catches up (see
// features/tg-ctl/rig-delegate.ts for the detection/delegation mechanics and the full caveat).
// Returns the exit code the caller should propagate: 0 on success (rig owns it, or telemetry
// written directly), or rig's non-zero exit when a PRESENT rig FAILS (never swallowed into a
// fallback — the shared contract is that fallback is for ABSENT rig only).
export function installCodexUsageTelemetry(codexHooksPath: string, codexRaw: string | null, codexExisting: Record<string, unknown>): number {
  const rig = detectRig(process.env)
  if (!rig.present) {
    // rig absent (or its shared helper not installed) — the direct write is the fallback.
    installCodexUsageTelemetryDirect(codexHooksPath, codexRaw, codexExisting)
    return 0
  }
  // Scope the reconcile to `--only harness` — the codex hook bridge is provisioned under the
  // harness layer, so a bare `rig apply` (which would reconcile skills/CI/GitHub/tmux/… too) is
  // both too broad and surprising for an `install-hooks` command.
  const delegated = runRigDelegate(["apply", "--only", "harness"], process.env, process.cwd())
  if (!delegated.ran) {
    // rig binary present but the shared helper couldn't run (e.g. agent-tools not fully
    // deployed) — the delegation never happened, so honor the request via the direct write.
    writeStdoutLine(`tg-ctl: rig detected (${rig.rigPath}) but the delegation helper could not run — writing the telemetry hook directly.`)
    installCodexUsageTelemetryDirect(codexHooksPath, codexRaw, codexExisting)
    return 0
  }
  if (delegated.exitCode === NO_RIG_EXIT) {
    // The shared helper reports rig ABSENT via its sentinel (agent-tools#282: 97, moved off 3 so
    // it can't be confused with rig's own EXIT_DRIFT=3). detectRig said present, but rig went
    // away between detect and delegate (uninstalled mid-flight) — this is the "rig absent" case,
    // NOT a rig failure, so honor the request with the direct write. Branch on the sentinel
    // EXACTLY: a real rig failure (1/2/3/…) must fall through to the propagate path below.
    // Checked BEFORE the "delegated … (exit N)" log so the absent path never claims provisioning
    // happened.
    writeStdoutLine(`tg-ctl: rig reported absent (sentinel ${NO_RIG_EXIT}) at delegation time — writing the telemetry hook directly.`)
    installCodexUsageTelemetryDirect(codexHooksPath, codexRaw, codexExisting)
    return 0
  }
  writeStdoutLine(`tg-ctl: rig detected (${rig.rigPath}) — delegated codex hook provisioning via \`rig apply --only harness\` (exit ${delegated.exitCode})`)
  if (delegated.exitCode !== 0) {
    // A PRESENT rig that FAILS is a real failure — surface it, do NOT fall back to a direct
    // write (that would recreate the dual-source we set out to remove). Propagate the exit code.
    if (delegated.stderr.trim()) {
      console.error(`tg-ctl: rig apply failed: ${delegated.stderr.trim().split("\n").slice(0, 3).join(" | ")}`)
    }
    console.error("tg-ctl: rig apply failed — not writing codex hooks directly. Fix rig and re-run `tg-ctl install-hooks`.")
    return delegated.exitCode ?? 1
  }
  // rig succeeded. Check the AUTHORITATIVE artifact rig actually writes (~/.codex/config.toml),
  // re-read from disk — NOT the pre-delegation snapshot — to see whether rig now provisions the
  // usage-telemetry Stop hook itself.
  const codexConfigToml = readFileOrNull(join(dirname(codexHooksPath), "config.toml"))
  if (codexConfigToml && codexConfigToml.includes(CODEX_USAGE_HOOK_CMD)) {
    writeStdoutLine("tg-ctl: rig now provisions the codex usage-telemetry Stop hook (~/.codex/config.toml) — skipping the direct hooks.json write.")
    return 0
  }
  // rig does not fold in the telemetry hook yet — write it directly so telemetry is not lost.
  // Re-read hooks.json FRESH (rig apply may have touched ~/.codex) rather than reusing the stale
  // pre-delegation snapshot.
  const freshRaw = readFileOrNull(codexHooksPath)
  let freshExisting: Record<string, unknown> = {}
  if (freshRaw) {
    try {
      const parsed = JSON.parse(freshRaw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) freshExisting = parsed as Record<string, unknown>
    } catch {
      console.error(`tg-ctl: ${codexHooksPath} is not valid JSON after rig apply — fix or move it aside, then re-run`)
      return 1
    }
  }
  writeStdoutLine(
    "tg-ctl: rig does not yet provision the codex usage-telemetry Stop hook — writing it directly so telemetry is not lost " +
      "(may coexist with rig's ~/.codex/config.toml bridge until rig folds this hook in; tg#8672).",
  )
  installCodexUsageTelemetryDirect(codexHooksPath, freshRaw, freshExisting)
  return 0
}

// Parse an existing JSON-object config file, or exit 1 telling the user to fix it. An absent or
// empty file is the empty object.
function parseJsonObjectOrExit(path: string, raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`tg-ctl: ${path} is not valid JSON — fix or move it aside, then re-run`)
    process.exit(1)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`tg-ctl: ${path} is not a JSON object — fix or move it aside, then re-run`)
    process.exit(1)
  }
  return parsed as Record<string, unknown>
}

// Write the reconciled Claude settings (backing up the previous text) and announce it.
function writeClaudeSettings(home: string, settingsPath: string, raw: string | null, settings: Record<string, unknown>): void {
  if (raw) {
    try {
      writeFileSync(`${settingsPath}.bak`, raw)
    } catch {}
  }
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  writeStdoutLine(`tg-ctl: installed Claude Code q→buttons + StopFailure + statusLine usage telemetry → ${settingsPath}` + (raw ? ` (backup: ${settingsPath}.bak)` : ""))
}

// A project/local settings file whose own statusLine shadows the user-level one would silence the
// usage telemetry; patch it too. Returns whether it was rewritten.
function patchShadowingStatusLine(home: string): boolean {
  const shadowingStatusLine = findShadowingClaudeStatusLine(home, process.cwd(), CLAUDE_STATUSLINE_TELEMETRY_CMD)
  if (!shadowingStatusLine) return false
  const shadowRaw = readFileOrNull(shadowingStatusLine)
  const shadowSettings = readJsonObjectOrNull(shadowingStatusLine)
  if (!shadowRaw || !shadowSettings) return false
  const shadowTelemetry = withClaudeStatusLineTelemetry(shadowSettings, CLAUDE_STATUSLINE_TELEMETRY_CMD)
  if (!shadowTelemetry.changed) return false
  try {
    writeFileSync(`${shadowingStatusLine}.bak`, shadowRaw)
  } catch {}
  mkdirSync(dirname(shadowingStatusLine), { recursive: true })
  writeFileSync(shadowingStatusLine, `${JSON.stringify(shadowTelemetry.settings, null, 2)}\n`)
  writeStdoutLine(`tg-ctl: installed Claude statusLine usage telemetry → ${shadowingStatusLine} (backup: ${shadowingStatusLine}.bak)`)
  return true
}

// Record opt-in so the daemon may RESTORE these hooks if a later settings.json
// rewrite drops them (ensureClaudeHooksOnStartup). Best-effort — never fail the
// install over the sentinel.
function recordClaudeHooksOptIn(home: string): void {
  try {
    const configDir = resolveConfigDir(home)
    mkdirSync(configDir, { recursive: true })
    writeFileSync(claudeHooksSentinelPath(configDir), `${new Date().toISOString()}\n`)
    writeStdoutLine(
      `The daemon will restore these hooks if a settings.json rewrite drops them. ` +
        `To stop that, delete ${claudeHooksSentinelPath(configDir)}.`,
    )
  } catch {}
}

// Idempotently install the q→buttons agent-question hooks into Claude Code's
// user settings (backing the file up first), then print guidance for the other
// harnesses. Pure JSON merge lives in features/tg-ctl/hook-install.ts.
export function installHooks(home: string): number {
  const settingsPath = join(home, ".claude", "settings.json")
  const raw = readFileOrNull(settingsPath)
  const existing = parseJsonObjectOrExit(settingsPath, raw)
  const codexHooksPath = join(codexConfigDir(home), "hooks.json")
  const codexRaw = readFileOrNull(codexHooksPath)
  const codexExisting = parseJsonObjectOrExit(codexHooksPath, codexRaw)
  // Provision all three Claude channels in ONE pass (q→buttons, StopFailure
  // notifications, and proactive statusLine usage telemetry) — the same shared
  // engine the daemon startup self-heal uses, so both stay in lockstep.
  const { settings, changed } = reconcileClaudeHooks(existing, CLAUDE_HOOK_COMMANDS)
  if (changed) writeClaudeSettings(home, settingsPath, raw, settings)
  const shadowChanged = patchShadowingStatusLine(home)
  if (!changed && !shadowChanged) {
    writeStdoutLine("tg-ctl: Claude Code q→buttons + StopFailure + statusLine usage telemetry already installed — nothing to do.")
  }
  const codexExit = installCodexUsageTelemetry(codexHooksPath, codexRaw, codexExisting)
  writeStdoutLine("")
  writeStdoutLine("Codex: trust the `tg-ctl codex-usage-hook` Stop hook via /hooks so quota telemetry can flow; add a PermissionRequest hook running `tg-ctl ask --agent codex` if you also want q→buttons.")
  writeStdoutLine("opencode: native — the bot subscribes to question/permission SSE events; no hook file needed.")
  writeStdoutLine("Restart any running agent session so it loads the new hooks.")
  recordClaudeHooksOptIn(home)
  return codexExit
}
