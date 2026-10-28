// daemon-runtime/voice-setup: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { updateConfigFile, withConfigModeline } from "../../config/config-file"
import { buildFasterWhisperArgv, buildFfmpegArgv, buildWhisperCppArgv, cleanTranscript, colorizeVoiceStatus, FASTER_WHISPER_FALLBACK_SCRIPT, decideOnboarding, formatCommand, isVoiceConfigured, managedVoicePaths, onboardingMessage, renderVoiceConfigBlock, upsertVoiceBlock, voiceArtifactsPresent, type VoiceConfig } from "../voice"
import { physicalCores, probeWhisper, voiceInstallRoot } from "../voice-probe"
import { shouldColorize } from "../../render/help-color"
import { log, readFileOrNull, spawnGuarded, type Ctx } from "./ctx-io"

// --- voice transcription (inbound STT) ---

// Configured AND the on-disk artefacts still exist. The config gate
// (isVoiceConfigured) is cheap; this adds the filesystem check the step function
// can't do (it is pure). A deleted model/binary falls back to onboarding instead
// of downloading the note and failing deep inside the runner.
export function voiceReady(ctx: Ctx): boolean {
  return isVoiceConfigured(ctx.voice) && voiceArtifactsPresent(ctx.voice, existsSync, managedModelDir(ctx.home))
}

// The CT2 dir `tg voice setup` downloads into — it must also hold its tokenizer.
export function managedModelDir(home: string): string {
  return managedVoicePaths(voiceInstallRoot(home)).fasterWhisperModelDir
}

// Spawn ffmpeg (OGG→WAV 16k mono) then the configured Whisper, returning the
// cleaned transcript or null on failure. Both spawns are ASYNC (event loop stays
// free for hooks/poll during a long transcription), timeout-guarded so a stuck
// binary can't wedge the loop, and exception-guarded so a MISSING binary returns
// null (not an uncaught throw). The WAV is written next to the OGG.
export async function runTranscription(ctx: Ctx, oggPath: string): Promise<string | null> {
  const wavPath = oggPath.replace(/\.[^.]+$/, "") + ".wav"
  const ff = await spawnGuarded(buildFfmpegArgv(oggPath, wavPath), 60_000)
  if (ff.exitCode !== 0 || !existsSync(wavPath)) {
    log(`ffmpeg failed: ${ff.stderr.trim()}`)
    return null
  }

  const argv =
    ctx.voice.runner === "whisper.cpp"
      ? buildWhisperCppArgv(ctx.voice, wavPath, physicalCores())
      : buildFasterWhisperArgv(ctx.voice.binPath, fasterWhisperScriptPath(ctx), ctx.voice, wavPath)

  const proc = await spawnGuarded(argv, 300_000)
  try {
    unlinkSync(wavPath)
  } catch {
    // best-effort cleanup
  }
  if (proc.exitCode !== 0) {
    log(`whisper failed (${ctx.voice.runner}): ${proc.stderr.trim()}`)
    return null
  }
  return cleanTranscript(proc.stdout)
}

export function formatVoiceConfirmation(text: string): string {
  const prefix = "🎤 Расшифровка: "
  const suffix = "\n… (здесь укорочено; полный текст не обрезается перед маршрутизацией)"
  const maxTelegramText = 4096
  const full = `${prefix}${text}`
  if (full.length <= maxTelegramText) return full

  const maxTextLength = Math.max(0, maxTelegramText - prefix.length - suffix.length)
  const kept: string[] = []
  let keptLength = 0
  for (const char of text) {
    if (keptLength + char.length > maxTextLength) break
    kept.push(char)
    keptLength += char.length
  }
  const out = `${prefix}${kept.join("")}${suffix}`
  if (out.length <= maxTelegramText) return out
  return `${prefix}${suffix}`.slice(0, maxTelegramText)
}

// The faster-whisper runner script: the configured project's own transcriber
// when it ships one (my_faster_whisper.py / transcribe.py), else a generated
// fallback written into the config dir. `main.py` is intentionally NOT trusted
// as a transcriber — uv-init projects ship a "Hello world" main.py that would
// silently produce no text. Resolved at transcription time (not stored) so a
// moved project is tolerated. The fallback is (re)written whenever it differs
// from the built-in copy, so an upgrade reaches hosts that already have one.
export function fasterWhisperScriptPath(ctx: Ctx): string {
  // binPath is <project>/.venv/bin/python → project root is three dirs up.
  const projectRoot = resolve(ctx.voice.binPath, "..", "..", "..")
  for (const name of ["my_faster_whisper.py", "transcribe.py"]) {
    const candidate = join(projectRoot, name)
    if (existsSync(candidate)) return candidate
  }
  // No project transcriber → the self-contained built-in one.
  const fallback = join(ctx.configDir, "tg-faster-whisper.py")
  if (readFileOrNull(fallback) !== FASTER_WHISPER_FALLBACK_SCRIPT) {
    try {
      mkdirSync(ctx.configDir, { recursive: true })
      writeFileSync(fallback, FASTER_WHISPER_FALLBACK_SCRIPT)
    } catch (err) {
      log(`faster-whisper fallback script write failed: ${err}`)
    }
  }
  return fallback
}

// Persist the resolved voice config into <configDir>/config.yaml, replacing any
// existing `voice:` block (or appending one). No secrets here — only
// binary/model paths + language. The config dir is created first (a fresh
// machine running `tg voice setup` before anything else has no ~/.config/tg-cli
// yet). Returns whether the write landed so the caller can avoid claiming
// "configured" on a swallowed ENOENT.
export function persistVoiceConfigToDir(configDir: string, cfg: VoiceConfig): boolean {
  const written = updateConfigFile(configDir, (raw) => upsertVoiceBlock(withConfigModeline(raw), cfg))
  if (!written) log("voice config persist failed: config unavailable, read-only, or busy")
  return written
}

type OnboardingVerdict = ReturnType<typeof decideOnboarding>
type InstallStep = Extract<OnboardingVerdict, { kind: "install" }>["steps"][number]

// Run one install step with the terminal attached. null = success, else a short failure reason.
function runInstallStep(step: InstallStep): string | null {
  try {
    // Each step is bounded on its own: `tg-ctl voice-setup` may be run directly,
    // without the `tg` wrapper's overall cap. The network tools time out stalls
    // themselves (curl --speed-time, uv/HF read timeouts); this catches the rest.
    const r = Bun.spawnSync(step.argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      timeout: 30 * 60_000,
    })
    if (r.exitedDueToTimeout) return "timed out after 30 min"
    return r.exitCode === 0 ? null : `exit ${r.exitCode ?? 1}`
  } catch (err) {
    console.error(String(err))
    return "exit 127"
  }
}

// Run the install plan in order; stops at the first failing step.
function runInstallSteps(steps: InstallStep[]): boolean {
  for (const step of steps) {
    writeStdoutLine(`\n→ ${step.label}: ${formatCommand(step.argv)}`)
    const outcome = runInstallStep(step)
    if (outcome !== null) {
      console.error(`✗ ${step.label} failed (${outcome}). Fix the cause above and re-run \`tg voice setup\`.`)
      return false
    }
  }
  return true
}

// Persist a ready voice config (or, on --dry-run, show the block that would be written).
function persistReadyVoiceConfig(args: { configDir: string; dryRun: boolean }, cfg: VoiceConfig): "written" | "dry-run" | "failed" {
  const path = join(args.configDir, "config.yaml")
  if (args.dryRun) {
    writeStdoutLine(`--dry-run: ${path} unchanged; tg voice setup would write:\n${renderVoiceConfigBlock(cfg)}`)
    return "dry-run"
  }
  if (persistVoiceConfigToDir(args.configDir, cfg)) return "written"
  console.error(
    `Found a local Whisper (${cfg.runner}, ${cfg.modelPath}) but could not write ` +
      `${path}. Fix the permissions and re-run \`tg voice setup\`.`,
  )
  return "failed"
}

// `tg-ctl voice-setup` (invoked by `tg voice setup`): probe the host, decide,
// install when nothing usable is there, persist when ready, and print the human
// guidance to stdout so the CLI relays it. Never sends to Telegram — this is the
// interactive local path. Takes only what it needs (no bot token / chatId — the
// gate is bypassed for this command). A configured runner whose files are still
// on disk is kept (decideOnboarding). The install plan is prebuilt only
// (Homebrew bottles, PyPI wheels, model downloads); each step runs with the
// terminal attached so download progress shows, and the host is re-probed after
// it, so "configured" is only claimed for an install that is really usable.
// `dryRun` prints the plan / the voice block it would write and changes nothing.
// Returns true on success (config written, or guidance shown for a not-ready
// host), false when an install step fails or a ready install could not be
// persisted — the caller exits non-zero so scripts/agents don't mistake it for
// a successful setup.
export function runVoiceSetup(args: { configDir: string; home: string; current: VoiceConfig; dryRun: boolean }): boolean {
  const color = shouldColorize()
  const current = {
    cfg: args.current,
    present: voiceArtifactsPresent(args.current, existsSync, managedModelDir(args.home)),
  }
  let verdict = decideOnboarding(probeWhisper(args.home), args.current.language, current)
  if (verdict.kind === "install") {
    writeStdoutLine(colorizeVoiceStatus(onboardingMessage(verdict), color))
    if (args.dryRun) {
      writeStdoutLine("--dry-run: nothing installed, config.yaml unchanged.")
      return true
    }
    if (!runInstallSteps(verdict.steps)) return false
    verdict = decideOnboarding(probeWhisper(args.home), args.current.language, current)
    if (verdict.kind !== "ready") {
      console.error(`The install finished but no usable Whisper was found:\n${onboardingMessage(verdict)}`)
      return false
    }
  }
  if (verdict.kind === "ready") {
    const persisted = persistReadyVoiceConfig(args, verdict.cfg)
    if (persisted !== "written") return persisted === "dry-run"
  }
  // This is the CLI path (`tg voice setup`): colorize the ✓/○ status glyph for a
  // terminal (green=configured, yellow=pending), and never when piped/NO_COLOR.
  // The DAEMON path (an unconfigured voice note) sends onboardingMessage to
  // Telegram uncolored — it builds the message directly and never calls this.
  writeStdoutLine(colorizeVoiceStatus(onboardingMessage(verdict), color))
  return true
}
