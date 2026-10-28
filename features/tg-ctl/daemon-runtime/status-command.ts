// daemon-runtime/status-command: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { join } from "path"
import { autostartKind } from "../autostart"
import { describeUnreachable, UNREACHABLE_HINT } from "../unreachable"
import { describeUnbridgedOmp } from "../omp"
import { describeHost } from "../host-registry"
import { daemonStatusLine } from "../lock"
import { codeFreshnessLine, shouldRestartForFreshness } from "../code-freshness"
import { claudeHooksInstalled, claudeStatusLineTelemetryInstalled, codexUsageHookInstalled, harnessHooksInstalled } from "../hook-install"
import { codexConfigDir, fileMtimeMs, formatCandidates, readFileOrNull, readOffset, type Ctx } from "./ctx-io"
import { botPostResult } from "./telegram-api"
import { assessRunningCode, autostartEnv, composeAutostartLine, probeDaemonRunState } from "./daemon-service"
import { snapshot } from "./tmux-probe"
import { describeOmpLines, discoverTarget, listUnreachableAgents, newestRegisteredCwd, readBridgeCodeAge, readRegistrations } from "./pane-discovery"
import { ptyOnlyHosts } from "./delivery"
import { listLiveOmpAgents } from "./session-registry"
import { CLAUDE_HARNESS_HOOK_CMD, CLAUDE_QUESTION_HOOK_CMD, CLAUDE_STATUSLINE_TELEMETRY_CMD, CODEX_USAGE_HOOK_CMD } from "./constants"
import { findShadowingClaudeStatusLine } from "./hooks-setup"

// The bot's topic settings from getMe (docs/specs/session-registry-and-topics.md §4.6, tg-cli#736),
// or null when topics are off. With allows_users_to_create_topics, Telegram opens a new topic for
// every message sent from its "New Chat" entry (an implicit topic, §4.4 row 4) — the usual cause
// behind "a new topic appeared and my message went to a picker". Null synchronously, not a
// promise of null: with topics off, /status takes no extra await and keeps its place among the
// replies of the same batch.
export function topicSettingsLine(ctx: Ctx): Promise<string> | null {
  if (!ctx.cfg.topics && !ctx.cfg.privateTopics) return null
  return botPostResult(ctx, "getMe", {}, 3_000).then((me) => {
    if (!me.ok) return `topics: getMe unavailable (${me.description})`
    const result = me.json.result
    const settings = new Map<string, unknown>(result && typeof result === "object" ? Object.entries(result) : [])
    const userTopics = settings.get("allows_users_to_create_topics")
    const line =
      `topics: has_topics_enabled=${String(settings.get("has_topics_enabled") ?? "unknown")}, ` +
      `allows_users_to_create_topics=${String(userTopics ?? "unknown")}`
    return userTopics === true
      ? `${line} — ⚠ every message sent from Telegram's "New Chat" opens a new topic and waits behind the session picker; @BotFather can stop users creating topics`
      : line
  })
}

// Daemon liveness plus, when it runs, the commit it loaded. Merged ≠ deployed until the resident
// process restarts (tg-cli#279).
function daemonStateLines(ctx: Ctx, runState: ReturnType<typeof probeDaemonRunState>): string[] {
  const lines = [daemonStatusLine(runState, ctx.botId)]
  if (runState.kind === "running") {
    const freshness = assessRunningCode(ctx, runState.pid)
    lines.push(codeFreshnessLine(freshness) + (shouldRestartForFreshness(freshness) ? " — run `tg-ctl restart`" : ""))
  }
  return lines
}

function registrationLines(regs: ReturnType<typeof readRegistrations>): string[] {
  if (regs.length === 0) return ["registrations: none"]
  const lines = [`registrations: ${regs.length}`]
  for (const reg of regs) {
    lines.push(
      `  - pane ${reg.paneId ?? "?"}, cwd ${reg.cwd ?? "?"}` +
        (reg.sessionName ? `, session ${reg.sessionName}` : ""),
    )
  }
  return lines
}

function targetLine(found: ReturnType<typeof discoverTarget>): string {
  if (found.ok) {
    return (
      `target: ${found.target.agent} in ${found.target.pane.sessionName}:${found.target.pane.windowIndex} ` +
      `${found.target.pane.paneId}` +
      (found.target.agentPid !== undefined ? ` (pid ${found.target.agentPid})` : "")
    )
  }
  return found.reason === "ambiguous" ? `target: ambiguous —\n${formatCandidates(found.candidates)}` : "target: no agent pane found"
}

// Sessions a rig wrapper hosts in abduco outside tmux: reachable through their PTY.
function hostedLines(): string[] {
  const statusSnapshot = snapshot()
  const hosted = ptyOnlyHosts(statusSnapshot.panes, statusSnapshot.procs)
  if (hosted.length === 0) return []
  return [`hosted (abduco, outside tmux): ${hosted.length}`, ...hosted.map((h) => `  - ${describeHost(h)}`)]
}

// Agents outside tmux AND outside the rig wrapper (tg-cli#306) — listed, not omitted, with the
// reason and how to restart them so Telegram can reach them; the silent-invisibility this
// replaces was the incident.
function unreachableLines(): string[] {
  const unreachable = listUnreachableAgents()
  if (unreachable.length === 0) return []
  return [
    `unreachable (outside tmux and the rig wrapper): ${unreachable.length}`,
    ...unreachable.map((a) => `  - ${describeUnreachable(a)}`),
    `  ${UNREACHABLE_HINT}`,
  ]
}

function ompLines(ctx: Ctx): string[] {
  const liveOmp = listLiveOmpAgents()
  if (liveOmp.length === 0) return []
  return [
    `omp (original-process): ${liveOmp.length}`,
    ...describeOmpLines(liveOmp),
    ...describeUnbridgedOmp(liveOmp, (pids) => readBridgeCodeAge(ctx.home, pids)),
  ]
}

function offsetLine(ctx: Ctx): string {
  const offsetMtime = fileMtimeMs(ctx.paths.offset)
  if (offsetMtime === null) return "offset: none"
  return `offset: ${readOffset(readFileOrNull(ctx.paths.offset))} ` + `(file age ${Math.round((Date.now() - offsetMtime) / 1000)}s)`
}

interface ClaudeHookFacts {
  questionHooksOk: boolean
  harnessHooksOk: boolean
  statusLineTelemetryOk: boolean
  shadowingStatusLine: string | null
}

// What Claude Code's user settings.json wires. An unreadable/invalid file reads as nothing wired.
function readClaudeHookFacts(ctx: Ctx, statusScopeCwd: string): ClaudeHookFacts {
  const facts: ClaudeHookFacts = { questionHooksOk: false, harnessHooksOk: false, statusLineTelemetryOk: false, shadowingStatusLine: null }
  const hooksRaw = readFileOrNull(join(ctx.home, ".claude", "settings.json"))
  if (!hooksRaw) return facts
  try {
    const hooksSettings = JSON.parse(hooksRaw)
    facts.questionHooksOk = claudeHooksInstalled(hooksSettings, CLAUDE_QUESTION_HOOK_CMD)
    facts.harnessHooksOk = harnessHooksInstalled(hooksSettings, CLAUDE_HARNESS_HOOK_CMD)
    facts.statusLineTelemetryOk = claudeStatusLineTelemetryInstalled(hooksSettings, CLAUDE_STATUSLINE_TELEMETRY_CMD)
    if (facts.statusLineTelemetryOk) {
      facts.shadowingStatusLine = findShadowingClaudeStatusLine(ctx.home, statusScopeCwd, CLAUDE_STATUSLINE_TELEMETRY_CMD)
    }
  } catch {}
  return facts
}

function codexUsageTelemetryInstalled(ctx: Ctx): boolean {
  const codexHooksRaw = readFileOrNull(join(codexConfigDir(ctx.home), "hooks.json"))
  if (!codexHooksRaw) return false
  try {
    return codexUsageHookInstalled(JSON.parse(codexHooksRaw), CODEX_USAGE_HOOK_CMD)
  } catch {
    return false
  }
}

function usageTelemetryLine(facts: ClaudeHookFacts): string {
  if (facts.shadowingStatusLine) {
    return `usage telemetry: shadowed by ${facts.shadowingStatusLine} — run \`tg-ctl install-hooks\` from that scope or remove the override`
  }
  return facts.statusLineTelemetryOk
    ? "usage telemetry: installed (Claude Code statusLine)"
    : "usage telemetry: NOT installed — run `tg-ctl install-hooks`"
}

// Guide the user when q→buttons isn't wired (the hook is what forwards an
// agent's question to Telegram — without it the feature is silently dead).
function hookStatusLines(ctx: Ctx, statusScopeCwd: string): string[] {
  const facts = readClaudeHookFacts(ctx, statusScopeCwd)
  const codexUsageTelemetryOk = codexUsageTelemetryInstalled(ctx)
  return [
    facts.questionHooksOk
      ? "q→buttons hooks: installed (Claude Code)"
      : "q→buttons hooks: NOT installed — run `tg-ctl install-hooks`",
    facts.harnessHooksOk
      ? "limit/error hooks: installed (Claude Code StopFailure)"
      : "limit/error hooks: NOT installed — run `tg-ctl install-hooks`",
    usageTelemetryLine(facts),
    codexUsageTelemetryOk
      ? "Codex usage telemetry: installed (Stop hook transcript collector)"
      : "Codex usage telemetry: NOT installed — run `tg-ctl install-hooks`, then trust it via Codex `/hooks`",
  ]
}

// `topicSettings`: the resolved topicSettingsLine, awaited by the async caller.
// `extraLines`: a block the async caller resolved up front (the hub's remote machines; [] elsewhere).
export function composeStatus(ctx: Ctx, statusCwd: string | null, topicSettings: string | null, extraLines: string[] = []): string {
  const env = autostartEnv(ctx)
  const runState = probeDaemonRunState(ctx, false)
  const lines: string[] = daemonStateLines(ctx, runState)
  if (topicSettings) lines.push(topicSettings)

  // Show every LIVE registered session (the per-pane set), not just one — a
  // multi-session operator must SEE that all their panes are registered to
  // forward. Prune against the live snapshot so closed panes don't show as ghosts
  // (review finding); a flaky/empty snapshot skips pruning (shows all, fail-safe).
  const statusPanes = snapshot().panes
  const statusLive = statusPanes.length > 0 ? new Set(statusPanes.map((p) => p.paneId)) : null
  const regs = readRegistrations(ctx.paths, statusLive)
  lines.push(...registrationLines(regs))
  const found = discoverTarget(ctx)
  const statusScopeCwd = statusCwd ?? (found.ok ? found.target.pane.panePath : newestRegisteredCwd(regs) ?? ctx.cwd)
  lines.push(targetLine(found))
  lines.push(...hostedLines(), ...unreachableLines(), ...ompLines(ctx))
  lines.push(offsetLine(ctx))
  lines.push(...hookStatusLines(ctx, statusScopeCwd))
  // Autostart (the shared service-management lifecycle): an installed unit means the daemon
  // comes back at login. Mirrors the q→buttons line — installed reports the kind/label, absent
  // gets a hint. On the no-op fallback (no launchd/systemd) there's no unit to find.
  //
  // Two mechanisms can autostart the daemon: tg-ctl's OWN `enable` unit (the file existence check),
  // OR an EXTERNAL launchd job that supervises this tg-ctl binary, wired outside tg-ctl (e.g. rig's
  // `ai.hyperide.tg-ctl` LaunchAgent). We check the own unit first (it carries the precise kind/label
  // and is cheap), then probe launchd for an external supervisor before declaring "NOT enabled" —
  // otherwise status lies while launchd keeps the daemon alive across reboots (tg-cli#88).
  const kind = autostartKind(env)
  lines.push(composeAutostartLine(env, kind))
  lines.push(...extraLines)
  return lines.join("\n")
}
