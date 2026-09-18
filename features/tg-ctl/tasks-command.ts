// `/tasks [<agent>] [<status>]` bot command (tg-cli#115).
//
// Alex (tg#5698) wants the task board on his phone: a table of tickets with
// lifecycle status, filterable by agent window and status, composed from
// `task list --json` plus the PR/CI state `gh pr list --json` carries. This
// module owns arg parsing, status normalization, PR↔ticket matching, CI
// rollup, and the rich-HTML table composition. The daemon owns the spawns
// (task-cli, gh), the fuzzy agent→project scope (agent-match.ts), and the
// sendRichMessage call.
//
// Missing data (no PR, no CI, no due date) renders as an explicit em dash — it
// is NEVER fabricated (a fabricated "passing" CI would be worse than a blank).

import { escapeHtml } from '../render/html';
import { truncateWithEllipsis } from './text-util';

// task-cli's canonical states. `/tasks <status>` filters on one of these; a range
// of natural aliases normalizes onto them so `/tasks wip` or `/tasks review` work.
export const TASK_STATES = ['todo', 'in-progress', 'in-review', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

const STATUS_ALIASES: Readonly<Record<string, TaskState>> = {
  todo: 'todo', open: 'todo', backlog: 'todo', new: 'todo',
  'in-progress': 'in-progress', inprogress: 'in-progress', in_progress: 'in-progress',
  progress: 'in-progress', wip: 'in-progress', doing: 'in-progress', active: 'in-progress',
  'in-review': 'in-review', inreview: 'in-review', in_review: 'in-review',
  review: 'in-review', reviewing: 'in-review',
  done: 'done', closed: 'done', complete: 'done', completed: 'done', finished: 'done',
  cancelled: 'cancelled', canceled: 'cancelled', cancel: 'cancelled', wontfix: 'cancelled', dropped: 'cancelled',
};

// A status token → its canonical task-cli state, or null when it is not a status
// (so the daemon can treat it as an agent selector instead).
export function normalizeTaskStatus(token: string): TaskState | null {
  return STATUS_ALIASES[token.trim().toLowerCase()] ?? null;
}

export interface ParsedTasksCommand {
  agent: string | null; // fuzzy agent-window selector (daemon resolves → project dir)
  status: TaskState | null; // normalized state filter
}

// What the table header/label renders — the resolved scope. Widened to a plain
// string status so the daemon's Action (a string) composes without a cast; the
// value is display-only (escaped), never re-parsed.
export interface TasksScope {
  agent: string | null;
  status: string | null;
}

// Parse `/tasks [<agent>] [<status>]`. Order-tolerant: whichever token
// normalizes to a status IS the status, the other is the agent. So `/tasks done`,
// `/tasks hyperide`, `/tasks hyperide done`, and `/tasks done hyperide` all work.
export function parseTasksCommand(text: string): ParsedTasksCommand {
  const args = text
    .trim()
    .replace(/^\/tasks(@\w+)?/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let agent: string | null = null;
  let status: TaskState | null = null;
  for (const arg of args) {
    const asStatus = normalizeTaskStatus(arg);
    if (asStatus && !status) status = asStatus;
    else if (!agent) agent = arg;
  }
  return { agent, status };
}

// A ticket as `task list --json` emits it (extra fields are ignored).
export interface TaskItem {
  id: string; // "#117"
  title: string;
  state: string;
  url?: string;
  due?: string;
  labels?: string[];
  what?: string;
  project?: string;
  agent?: string;
}

// A PR as `gh pr list --json number,title,url,body,state,statusCheckRollup,reviewDecision,isDraft`
// emits it, after the daemon normalizes the CI rollup to a verdict and the review
// decision to a lifecycle verdict.
export interface PrRef {
  number: number;
  url: string;
  title: string;
  body?: string;
  ci: CiState;
  // Optional (like `body?`): an absent review is treated exactly like `null` — a dash — per the
  // module's no-fabrication rule, so a caller that has no review data need not synthesize one.
  review?: ReviewState;
  project?: string;
}

export type CiState = 'pass' | 'fail' | 'pending' | null;

// The PR review lifecycle for the message→acceptance→CI→review board (tg-cli#117, Alex tg#5698).
export type ReviewState = 'approved' | 'changes' | 'review-required' | 'draft' | null;

// Reduce gh's `reviewDecision` string + `isDraft` boolean to one review verdict. A draft PR
// dominates (it is explicitly not ready for review). Never fabricates an "approved" — an
// unrecognized/empty decision is null (a dash), same posture as rollupCiState.
export function rollupReviewState(reviewDecision: unknown, isDraft: unknown): ReviewState {
  if (isDraft === true) return 'draft';
  switch (String(reviewDecision ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes';
    case 'REVIEW_REQUIRED':
      return 'review-required';
    default:
      return null;
  }
}

export const TASK_VIEW_FILTERS = ['attention', 'active', 'ready', 'done', 'all'] as const;
export type TaskViewFilter = (typeof TASK_VIEW_FILTERS)[number];
export const DEFAULT_TASK_VIEW: TaskViewFilter = 'attention';
export const TASKS_PAGE_SIZE = 10;
export const TASK_VIEW_LABELS: Readonly<Record<TaskViewFilter, string>> = {
  attention: 'Needs',
  active: 'Active',
  ready: 'Ready',
  done: 'Done',
  all: 'All',
};

export interface TasksViewOptions {
  view: TaskViewFilter;
  page: number;
  pageSize?: number;
  label?: string;
}

export interface TasksViewResult {
  html: string;
  reply_markup: TasksReplyMarkup;
  page: number;
  totalPages: number;
  totalTasks: number;
}

export interface TasksReplyMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export type TasksCallbackKind = 'filter' | 'page';

// Reduce a gh statusCheckRollup array to one verdict. Any failure → fail; any
// still-running/queued → pending; all successful/neutral/skipped → pass; empty
// or unknown → null (rendered as a dash, never a fabricated "pass").
export function rollupCiState(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let sawPending = false;
  let sawPass = false;
  for (const check of rollup) {
    const c = check as { status?: string; conclusion?: string; state?: string };
    const status = (c.status ?? '').toUpperCase();
    const verdict = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      sawPending = true;
      continue;
    }
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(verdict)) return 'fail';
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)) sawPass = true;
    else if (verdict === '' || ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(verdict)) sawPending = true;
  }
  if (sawPending) return 'pending';
  return sawPass ? 'pass' : null;
}

export function taskKey(task: Pick<TaskItem, 'id' | 'project'>): string {
  return task.project ? `${task.project}:${task.id}` : task.id;
}

/**
 * Match each ticket to the most relevant PR that references it.
 *
 * The returned map is keyed by `taskKey(task)`, not bare `task.id`, so duplicate
 * task ids from different projects cannot overwrite each other.
 */
export function matchPrsToTasks(tasks: TaskItem[], prs: PrRef[]): Map<string, PrRef> {
  const out = new Map<string, PrRef>();
  const idCounts = duplicateIdCounts(tasks);
  for (const task of tasks) {
    const num = task.id.replace(/^#/, '');
    if (!num) continue;
    // The id comes from `task list --json` output — escape regex metacharacters
    // so a non-numeric / odd id (e.g. a `+`/`(`/`[`) can't corrupt the match or
    // throw an uncaught RegExp error in the daemon.
    const re = new RegExp(`#${escapeRegExp(num)}\\b`);
    const matches = prs.filter((pr) => {
      const text = `${pr.title}\n${pr.body ?? ''}`;
      if (!re.test(text)) return false;
      return taskMatchesPr(task, pr, text, (idCounts.get(num) ?? 0) > 1);
    });
    if (matches.length === 0) continue;
    out.set(taskKey(task), matches.reduce((best, pr) => (pr.number > best.number ? pr : best)));
  }
  return out;
}

const CI_GLYPH: Readonly<Record<Exclude<CiState, null>, string>> = { pass: '✓', fail: '✗', pending: '…' };
// Full-color emoji here vs CI_GLYPH's spare text symbols is a DELIBERATE register difference:
// the Review verdict is the lifecycle leg a human scans for on a phone, so it gets the louder
// glyphs. Also distinct from the STATUS_GROUP_EMOJI axis (🟢🟡🔴⚪ prepended to the Title cell)
// — `changes` uses 🔁, NOT the 🔴 problem circle, so a changes-requested review and a
// problem-status task never show two identical reds in one row.
const REVIEW_GLYPH: Readonly<Record<Exclude<ReviewState, null>, string>> = {
  approved: '✅',
  changes: '🔁',
  'review-required': '👀',
  draft: '✏️',
};

// The lifecycle table's columns, in render order — the ONE source of truth. The header HTML and
// the group-separator colspan both derive from this list, so they cannot drift; each taskRow
// emits exactly TASKS_TABLE_COLUMNS <td> cells (guarded by a structural test) or Telegram's rich
// <table> render breaks. Add/remove a column here.
const TASKS_TABLE_HEADERS = ['ID', 'Title', 'State', 'Due', 'PR', 'CI', 'Review'] as const;
const TASKS_TABLE_COLUMNS = TASKS_TABLE_HEADERS.length;
const TASKS_TABLE_HEADER_HTML = `<tr>${TASKS_TABLE_HEADERS.map((h) => `<th>${h}</th>`).join('')}</tr>`;

// The scope line above the table (what the filters resolved to), for context.
export function tasksScopeLabel(scope: TasksScope): string {
  const parts: string[] = [];
  if (scope.agent) parts.push(`agent <b>${escapeHtml(scope.agent)}</b>`);
  if (scope.status) parts.push(`status <b>${escapeHtml(scope.status)}</b>`);
  return parts.length ? `Tasks — ${parts.join(', ')}` : 'Tasks';
}

// Compatibility shim for old table-only callers. New /tasks UI should call
// composeTasksView so it can send the filter/pagination keyboard with the HTML.
export function composeTasksTable(tasks: TaskItem[], prsByTask: Map<string, PrRef>, scope: TasksScope): string {
  return composeTasksView(tasks, prsByTask, scope, { view: 'all', page: 0, pageSize: Math.max(tasks.length, 1) }).html;
}

export function composeTasksView(
  tasks: TaskItem[],
  prsByTask: Map<string, PrRef>,
  scope: TasksScope,
  options: TasksViewOptions,
): TasksViewResult {
  const label = tasksScopeLabel(scope);
  const filtered = filterTasksForView(tasks, prsByTask, options.view);
  const pageSize = Math.max(1, options.pageSize ?? TASKS_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = clampPage(options.page, totalPages);
  const agentProjects = agentProjectCounts(filtered);
  const groupedTasks = groupOrderedTasks(filtered, agentProjects);
  const pageTasks = groupedTasks.slice(page * pageSize, page * pageSize + pageSize);
  const viewLabel = `${label} — <b>${escapeHtml(options.label ?? TASK_VIEW_LABELS[options.view])}</b>`;
  if (pageTasks.length === 0) {
    return {
      html: `<p>${viewLabel}</p><p>No matching tasks.</p>`,
      reply_markup: buildTasksReplyMarkup(options.view, page, totalPages),
      page,
      totalPages,
      totalTasks: filtered.length,
    };
  }
  const header = TASKS_TABLE_HEADER_HTML;
  const rows = taskRowsByGroup(pageTasks, agentProjects, prsByTask);
  const pageLabel = totalPages > 1 ? ` page ${page + 1}/${totalPages}` : '';
  return {
    html: `<p>${viewLabel}${pageLabel}</p><table>${header}${rows}</table>`,
    reply_markup: buildTasksReplyMarkup(options.view, page, totalPages),
    page,
    totalPages,
    totalTasks: filtered.length,
  };
}

export function filterTasksForView(tasks: TaskItem[], prsByTask: Map<string, PrRef>, view: TaskViewFilter): TaskItem[] {
  return tasks.filter((task) => {
    const pr = prsByTask.get(taskKey(task)) ?? null;
    const state = normalizeState(task.state);
    switch (view) {
      case 'all':
        return true;
      case 'done':
        return state === 'done';
      case 'active':
        return state === 'in-progress' || state === 'in-review';
      case 'ready':
        return state !== 'done' && state !== 'cancelled' && statusGroupForTask(task, pr) === 'ready';
      case 'attention': {
        if (state === 'done' || state === 'cancelled') return false;
        const group = statusGroupForTask(task, pr);
        return group === 'problem' || group === 'ready';
      }
    }
  });
}

export function statusEmojiForTask(task: TaskItem, pr: PrRef | null): string {
  return STATUS_GROUP_EMOJI[statusGroupForTask(task, pr)];
}

export function tasksCallbackData(view: TaskViewFilter, page: number, kind: TasksCallbackKind = 'page'): string {
  return `tgt:${kind}:${view}:${Math.max(0, Math.floor(page))}`;
}

export function parseTasksCallback(data: string | undefined): { view: TaskViewFilter; page: number; kind: TasksCallbackKind } | null {
  if (!data) return null;
  const m = /^tgt:(?:(filter|page):)?([a-z]+):(\d+)$/.exec(data);
  if (!m) return null;
  const kind = (m[1] ?? 'page') as TasksCallbackKind;
  const view = m[2] as TaskViewFilter;
  if (!isTaskViewFilter(view)) return null;
  return { view, page: Number(m[3]), kind };
}

export function buildTasksReplyMarkup(view: TaskViewFilter, page: number, totalPages: number): TasksReplyMarkup {
  const inline_keyboard: TasksReplyMarkup['inline_keyboard'] = [
    TASK_VIEW_FILTERS.map((filter) => ({ text: TASK_VIEW_LABELS[filter], callback_data: tasksCallbackData(filter, 0, 'filter') })),
  ];
  if (totalPages > 1) {
    const last = Math.max(0, totalPages - 1);
    const prev = Math.max(0, page - 1);
    const next = Math.min(last, page + 1);
    inline_keyboard.push([
      { text: '‹ Prev', callback_data: tasksCallbackData(view, prev, 'page') },
      { text: `${Math.min(page + 1, totalPages)}/${totalPages}`, callback_data: tasksCallbackData(view, page, 'page') },
      { text: 'Next ›', callback_data: tasksCallbackData(view, next, 'page') },
    ]);
  }
  return { inline_keyboard };
}

function taskRow(t: TaskItem, pr: PrRef | null): string {
  const id = t.url ? `<a href="${escapeHtml(t.url)}">${escapeHtml(t.id)}</a>` : escapeHtml(t.id);
  const title = escapeHtml(`${statusEmojiForTask(t, pr)} ${truncateWithEllipsis(t.title, 58)}`);
  const state = escapeHtml(t.state || '—');
  const due = t.due ? escapeHtml(t.due) : '—';
  const prCell = pr ? `<a href="${escapeHtml(pr.url)}">#${pr.number}</a>` : '—';
  const ci = pr && pr.ci ? CI_GLYPH[pr.ci] : '—';
  const review = pr && pr.review ? REVIEW_GLYPH[pr.review] : '—';
  return `<tr><td>${id}</td><td>${title}</td><td>${state}</td><td>${due}</td><td>${prCell}</td><td>${ci}</td><td>${review}</td></tr>`;
}

function taskRowsByGroup(pageTasks: TaskItem[], agentProjects: Map<string, Set<string>>, prsByTask: Map<string, PrRef>): string {
  const grouped = pageTasks.some((t) => t.agent || t.project);
  if (!grouped) return pageTasks.map((t) => taskRow(t, prsByTask.get(taskKey(t)) ?? null)).join('');
  const rows: string[] = [];
  let current = '';
  for (const task of pageTasks) {
    const label = taskGroupLabel(task, agentProjects);
    if (label !== current) {
      current = label;
      rows.push(`<tr><th colspan="${TASKS_TABLE_COLUMNS}">${escapeHtml(label)}</th></tr>`);
    }
    rows.push(taskRow(task, prsByTask.get(taskKey(task)) ?? null));
  }
  return rows.join('');
}

function groupOrderedTasks(tasks: TaskItem[], agentProjects: Map<string, Set<string>>): TaskItem[] {
  if (!tasks.some((task) => task.agent || task.project)) return tasks;
  return tasks
    .map((task, index) => ({ task, index, label: taskGroupLabel(task, agentProjects) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.index - b.index)
    .map((entry) => entry.task);
}

function taskGroupLabel(task: TaskItem, agentProjects: Map<string, Set<string>>): string {
  const project = shortProjectName(task.project ?? '');
  if (!task.agent) return project || 'Tasks';
  const projects = agentProjects.get(task.agent);
  if (project && projects && projects.size > 1) return `${task.agent} • ${project}`;
  return task.agent;
}

function agentProjectCounts(tasks: TaskItem[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!task.agent) continue;
    const projects = out.get(task.agent) ?? new Set<string>();
    if (task.project) projects.add(shortProjectName(task.project));
    out.set(task.agent, projects);
  }
  return out;
}

export function shortProjectName(project: string): string {
  const parts = project.split('/').filter(Boolean);
  return parts.at(-1) ?? project;
}

type StatusGroup = 'ready' | 'active' | 'problem' | 'inactive';

const STATUS_GROUP_EMOJI: Readonly<Record<StatusGroup, string>> = {
  ready: '🟢',
  active: '🟡',
  problem: '🔴',
  inactive: '⚪',
};
const PROBLEM_WORDS_RE = /\b(blocked|blocker|stuck|problem|broken|failing|failed|failure|flaky|regression)\b/;

function statusGroupForTask(task: TaskItem, pr: PrRef | null): StatusGroup {
  const state = normalizeState(task.state);
  if (state === 'done') return 'ready';
  if (state === 'cancelled') return 'inactive';
  if (hasProblemSignal(task, pr, state)) return 'problem';
  if (state === 'in-progress') return 'active';
  if (state === 'in-review' && pr?.ci !== 'pass') return 'active';
  return 'ready';
}

function hasProblemSignal(task: TaskItem, pr: PrRef | null, state: string): boolean {
  if (pr?.ci === 'fail') return true;
  // NOTE: a `review === 'changes'` verdict is display-only (the Review column) and deliberately
  // does NOT flag the task into the attention/problem view for v1 (tg-cli#117 is scope-limited to
  // rendering the review leg). Wiring changes-requested into the attention filter is a follow-up.
  const labels = Array.isArray(task.labels) ? task.labels.filter((label): label is string => typeof label === 'string') : [];
  const haystack = [...labels, task.what ?? ''].join(' ').toLowerCase();
  if (PROBLEM_WORDS_RE.test(haystack)) return true;
  if (task.due && state !== 'done' && state !== 'cancelled') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(task.due) && task.due < localIsoDate()) return true;
  }
  return false;
}

function localIsoDate(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeState(state: string | undefined): string {
  return normalizeTaskStatus(state ?? '') ?? (state ?? '').trim().toLowerCase();
}

export function isTaskViewFilter(view: unknown): view is TaskViewFilter {
  return typeof view === 'string' && (TASK_VIEW_FILTERS as readonly string[]).includes(view);
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.floor(page)), Math.max(0, totalPages - 1));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function duplicateIdCounts(tasks: TaskItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const num = task.id.replace(/^#/, '');
    if (!num) continue;
    counts.set(num, (counts.get(num) ?? 0) + 1);
  }
  return counts;
}

function taskMatchesPr(task: TaskItem, pr: PrRef, text: string, duplicateId: boolean): boolean {
  if (!task.project) return !duplicateId;
  if (pr.project) return projectNamesMatch(task.project, pr.project);
  if (!duplicateId) return true;
  return prTextNamesTaskProject(task, text);
}

function prTextNamesTaskProject(task: TaskItem, text: string): boolean {
  if (!task.project) return false;
  const normalizedProject = normalizeProjectName(task.project);
  const short = shortProjectName(normalizedProject);
  const escapedShort = escapeRegExp(short);
  return projectTokenRe(normalizedProject).test(text) || new RegExp(`(^|[^\\w-])${escapedShort}([^\\w-]|$)`, 'i').test(text);
}

function projectTokenRe(project: string): RegExp {
  return new RegExp(`(^|[^\\w/-])${escapeRegExp(project)}([^\\w/-]|$)`, 'i');
}

function projectNamesMatch(taskProject: string, prProject: string): boolean {
  const taskNormalized = normalizeProjectName(taskProject);
  const prNormalized = normalizeProjectName(prProject);
  if (taskNormalized === prNormalized) return true;
  const taskOwnerRepo = ownerRepoProject(taskNormalized);
  const prOwnerRepo = ownerRepoProject(prNormalized);
  if (taskOwnerRepo && prOwnerRepo) return false;
  return shortProjectName(taskNormalized) === shortProjectName(prNormalized);
}

function normalizeProjectName(project: string): string {
  return project.trim().replace(/\/+$/, '').toLowerCase();
}

function ownerRepoProject(project: string): string | null {
  if (project.startsWith('/')) return null;
  const parts = project.split('/').filter(Boolean);
  return parts.length === 2 ? project : null;
}
