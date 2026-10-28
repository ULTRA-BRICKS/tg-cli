// daemon-runtime/tasks-board: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { basename } from "path"
import { matchWindows, type AgentCandidate } from "../agent-match"
import { isBareWindowName } from "../session-name"
import { DEFAULT_TASK_VIEW, TASK_STATES, TASKS_PAGE_SIZE, composeTasksView, isTaskViewFilter, matchPrsToTasks, rollupCiState, rollupReviewState, shortProjectName, taskKey, type TaskViewFilter, type PrRef, type TaskItem } from "../tasks-command"
import { parseRoutes, recognizeRoute } from "../routes"
import { findTopic, parseTopics } from "../topics"
import type { Action, DiscoverResult } from "../types"
import { log, readFileOrNull, spawnGuarded, type Ctx } from "./ctx-io"
import { discoverTarget, listAgentCandidates, readRegistrations, registeredCwdForPane, resolveLastUserTarget, singleRegisteredCwd } from "./pane-discovery"
import { answerCallbackQuery, sendMessage, sendRich } from "./telegram-api"

// Pane selected by `/tasks <agent>`; null when the match is ambiguous.
function scopeDirForAgentSelector(agent: string, regs: ReturnType<typeof readRegistrations>): string | null {
  const m = matchWindows(agent, listAgentCandidates())
  if (!m.confident) return null
  const pane = m.matches[0]
  return pane?.panePath || (pane ? registeredCwdForPane(regs, pane) : null)
}

// Ambiguous fleet, no reply/thread anchor: use the SAME default-target anchor
// the daemon's inbound routing uses (tg-cli#78) rather than the old
// `lastMessagePane` (whoever spoke last, routes.json) — the two surfaces
// silently disagreeing on "the default target" was the review finding this
// replaces. No further fallback: an unresolved anchor stays ambiguous here
// too, exactly mirroring discoverForInject's own picker fallback.
function scopeDirForDefaultTarget(ctx: Ctx, regs: ReturnType<typeof readRegistrations>): string | null {
  const target = discoverTarget(ctx)
  let routed: DiscoverResult = target
  if (!target.ok && target.reason === "ambiguous") {
    const anchor = resolveLastUserTarget(ctx, target.candidates)
    if (anchor) routed = { ok: true, target: anchor }
  }
  if (routed.ok) return routed.target.pane.panePath || registeredCwdForPane(regs, routed.target.pane)
  if (routed.reason === "no-agent") return singleRegisteredCwd(regs)
  return null
}

export function resolveTasksScopeDir(ctx: Ctx, action: Pick<Extract<Action, { kind: "tasks" }>, "agent" | "replyToMessageId" | "threadId">): string | null {
  const regs = readRegistrations(ctx.paths)
  if (action.agent) return scopeDirForAgentSelector(action.agent, regs)
  if (action.threadId !== null && action.threadId !== undefined) {
    const topic = findTopic(parseTopics(readFileOrNull(ctx.paths.topics)), action.threadId)
    return topic?.path ?? null
  }
  const routes = parseRoutes(readFileOrNull(ctx.paths.routes))
  if (action.replyToMessageId !== null) {
    const recognized = recognizeRoute(routes, action.replyToMessageId)
    if (recognized?.cwd) return recognized.cwd
  }
  return scopeDirForDefaultTarget(ctx, regs)
}

export async function loadTasks(scopeDir: string | null, status: string | null, includeUnfiltered: boolean): Promise<TaskItem[]> {
  if (status) return loadTaskList(scopeDir, status)
  // task-cli scoped JSON does not provide a reliable "all lifecycle states" view, so the board fans out by canonical state.
  // The explicit All view also merges an unfiltered call so custom states stay visible when task-cli reports them.
  const states: Array<string | null> = includeUnfiltered ? [null, ...TASK_STATES] : [...TASK_STATES]
  const lists = await Promise.all(states.map((state) => loadTaskList(scopeDir, state)))
  const out: TaskItem[] = []
  const seen = new Set<string>()
  for (const task of lists.flat()) {
    const key = taskKey(task)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(task)
  }
  return out
}

export async function loadTaskList(scopeDir: string | null, status: string | null): Promise<TaskItem[]> {
  const argv = ["task", "list", "--json", "--no-pager", "-n", "100"]
  if (status) argv.push("--state", status)
  if (scopeDir) argv.push("-C", scopeDir)
  const r = await spawnGuarded(argv, 15_000)
  if (r.exitCode !== 0) {
    log(`/tasks: 'task list' failed (${r.exitCode}): ${r.stderr.slice(0, 200)}`)
    return []
  }
  try {
    const parsed = JSON.parse(r.stdout)
    return flattenTaskListJson(parsed)
  } catch {
    return []
  }
}

function flattenTaskListEntry(item: unknown): TaskItem[] {
  if (!item || typeof item !== "object") return []
  const rec = item as { id?: unknown; project?: unknown; tickets?: unknown }
  if (typeof rec.id === "string") {
    return [{ ...(item as TaskItem), project: typeof rec.project === "string" ? rec.project : undefined }]
  }
  if (typeof rec.project !== "string" || !Array.isArray(rec.tickets)) return []
  const project = rec.project
  return rec.tickets
    .filter((ticket) => ticket && typeof ticket === "object" && typeof (ticket as { id?: unknown }).id === "string")
    .map((ticket) => ({ ...(ticket as TaskItem), project }))
}

export function flattenTaskListJson(parsed: unknown): TaskItem[] {
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(flattenTaskListEntry)
}

export async function loadPrRefs(scopeDir: string | null): Promise<PrRef[]> {
  const argv = ["gh", "pr", "list", "--state", "all", "--limit", "100", "--json", "number,title,url,body,statusCheckRollup,reviewDecision,isDraft"]
  const r = await spawnGuarded(argv, 20_000, scopeDir ? { cwd: scopeDir } : {})
  if (r.exitCode !== 0) {
    log(`/tasks: 'gh pr list' failed (${r.exitCode}): ${r.stderr.slice(0, 200)}`)
    return []
  }
  try {
    const parsed = JSON.parse(r.stdout)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p) => p && typeof p.number === "number")
      .map((p) => {
        const url = typeof p.url === "string" ? p.url : ""
        return {
          number: p.number,
          url,
          title: p.title ?? "",
          body: p.body ?? "",
          ci: rollupCiState(p.statusCheckRollup),
          review: rollupReviewState(p.reviewDecision, p.isDraft),
          project: projectFromPrUrl(url),
        }
      })
  } catch {
    return []
  }
}

export function projectFromPrUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    const parts = url.pathname.split("/").filter(Boolean)
    const pullIndex = parts.indexOf("pull")
    if (pullIndex < 2) return undefined
    return `${parts[pullIndex - 2]}/${parts[pullIndex - 1]}`
  } catch {
    return undefined
  }
}

export interface TaskBoardState {
  scopeDir: string | null
  agent: string | null
  status: string | null
  threadId: number | null
}

// Best-effort in-memory callback scope; a daemon restart intentionally expires old /tasks boards.
export const taskBoardStates = new Map<string, TaskBoardState>()

export const MAX_TASK_BOARD_STATES = 50

export function taskBoardStateKey(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`
}

export function rememberTaskBoardState(chatId: number | string, messageId: number | null, state: TaskBoardState): void {
  if (messageId === null) return
  const key = taskBoardStateKey(chatId, messageId)
  taskBoardStates.delete(key)
  taskBoardStates.set(key, state)
  while (taskBoardStates.size > MAX_TASK_BOARD_STATES) {
    const first = taskBoardStates.keys().next().value
    if (typeof first !== "string") break
    taskBoardStates.delete(first)
  }
}

function taskBoardMessageContext(action: Extract<Action, { kind: "tasks" }>, threadId: number | null): { message_thread_id?: number; reply_parameters?: { message_id: number } } {
  const messageContext: { message_thread_id?: number; reply_parameters?: { message_id: number } } = {}
  if (threadId !== null) messageContext.message_thread_id = threadId
  if (!action.callbackQueryId && action.replyToMessageId !== null) messageContext.reply_parameters = { message_id: action.replyToMessageId }
  return messageContext
}

export async function runTasksCommand(ctx: Ctx, action: Extract<Action, { kind: "tasks" }>): Promise<void> {
  const prior = priorTaskBoardState(ctx, action)
  if (action.callbackQueryId && !prior) {
    await answerCallbackQuery(ctx, action.callbackQueryId, "expired")
    return
  }
  if (action.callbackQueryId) await answerCallbackQuery(ctx, action.callbackQueryId, "updating")
  const scopeDir = prior ? prior.scopeDir : resolveTasksScopeDir(ctx, action)
  const agent = prior ? prior.agent : action.agent
  const status = taskBoardStatusForAction(action, prior)
  const threadId = prior ? prior.threadId : action.threadId ?? null
  const messageContext = taskBoardMessageContext(action, threadId)
  if (!scopeDir && !action.callbackQueryId) {
    const suffix = agent ? ` for /tasks ${agent}` : " for /tasks"
    await sendMessage(ctx, `couldn't resolve a project${suffix} — reply to an agent message or use /tasks <agent>`, messageContext)
    return
  }
  const viewOptions = tasksViewOptions(action, status)
  const [tasks, prs] = await Promise.all([loadTasks(scopeDir, status, viewOptions.view === "all" && status === null), scopeDir ? loadPrRefs(scopeDir) : Promise.resolve([])])
  const prsByTask = matchPrsToTasks(tasks, prs)
  const view = composeTasksView(annotateTasksWithAgents(tasks, agent), prsByTask, { agent, status }, viewOptions)
  const sent = await sendRich(ctx, view.html, { ...messageContext, reply_markup: view.reply_markup })
  rememberTaskBoardState(ctx.chatId, sent, { scopeDir, agent, status, threadId })
  if (sent === null) await sendMessage(ctx, "couldn't render the task board — see the daemon log", messageContext)
}

export function priorTaskBoardState(ctx: Ctx, action: Extract<Action, { kind: "tasks" }>): TaskBoardState | undefined {
  if (!action.callbackQueryId || action.messageId == null) return undefined
  if (action.chatId == null || String(action.chatId) !== String(ctx.chatId)) return undefined
  return taskBoardStates.get(taskBoardStateKey(action.chatId, action.messageId))
}

export function taskBoardStatusForAction(action: Extract<Action, { kind: "tasks" }>, prior: TaskBoardState | undefined): string | null {
  if (!prior) return action.status
  // Filter taps switch back to the full lifecycle view, dropping any prior /tasks <status> scope.
  return action.callbackKind === "filter" ? null : prior.status
}

export function tasksViewOptions(action: Extract<Action, { kind: "tasks" }>, status: string | null): { view: TaskViewFilter; page: number; pageSize: number; label?: string } {
  const view = isTaskViewFilter(action.view) ? action.view : status ? "all" : DEFAULT_TASK_VIEW
  return { view, page: action.page ?? 0, pageSize: TASKS_PAGE_SIZE, label: status ? taskStatusViewLabel(status) : undefined }
}

export function taskStatusViewLabel(status: string): string {
  switch (status) {
    case "done":
      return "Done"
    case "in-progress":
    case "in-review":
      return "Active"
    case "todo":
      return "Ready"
    case "cancelled":
      return "Cancelled"
    default:
      return status
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ")
  }
}

export function annotateTasksWithAgents(tasks: TaskItem[], fallbackAgent: string | null): TaskItem[] {
  const candidates = listAgentCandidates()
  return tasks.map((task) => {
    const agent = task.agent || fallbackAgent || agentForTaskProject(task, candidates)
    return agent ? { ...task, agent } : task
  })
}

export function agentForTaskProject(task: TaskItem, candidates: AgentCandidate[]): string | null {
  const short = task.project ? shortProjectName(task.project) : null
  if (!short) return null
  const matches = candidates.filter((candidate): candidate is AgentCandidate & { panePath: string } => Boolean(candidate.panePath) && basename(candidate.panePath) === short)
  if (matches.length !== 1) return null
  const match = matches[0]
  return isBareWindowName(match.windowName) ? basename(match.panePath) : match.windowName
}
