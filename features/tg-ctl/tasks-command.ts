// `/tasks [<agent>] [<status>]` bot command (tg-cli#115).
//
// Alex (tg#5698) wants the task board on his phone: a table of tickets with
// lifecycle status, filterable by agent window and status, composed from
// `task list --json` plus the PRs, commit statuses and reviews the Forgejo REST
// API reports. This module owns arg parsing, status normalization, PR↔ticket
// matching, the CI/review rollups, and the rich-HTML table composition. The
// daemon owns the I/O (task-cli, Forgejo via features/forgejo/client.ts), the
// fuzzy agent→project scope (agent-match.ts), and the sendRichMessage call.
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

// A PR as the board renders it, normalized from one `GET /repos/{o}/{r}/pulls` item. `ci` and
// `review` start null and are filled for ticket-matched PRs only, from the head commit's
// combined status and the PR's reviews (rollupForgejoStatus / rollupForgejoReviews). There is
// no `state` field: the board never shows open/merged — it shows CI and review.
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
  /** Head commit, the key for the CI lookup. */
  headSha?: string;
  draft?: boolean;
  /** Reviewers asked and not yet answered — "review required" when nobody has decided. */
  requestedReviewers?: number;
}

export type CiState = 'pass' | 'fail' | 'pending' | null;

// The PR review lifecycle for the message→acceptance→CI→review board (tg-cli#117, Alex tg#5698).
export type ReviewState = 'approved' | 'changes' | 'review-required' | 'draft' | null;

/**
 * Parse one page of `GET /repos/{o}/{r}/pulls` into board PRs; malformed items are skipped.
 * `items` is the page's raw length — the pagination signal, since skipped items still count.
 */
export function parseForgejoPulls(raw: string, project: string): { prs: PrRef[]; items: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { prs: [], items: 0 };
  }
  if (!Array.isArray(parsed)) return { prs: [], items: 0 };
  const out: PrRef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const pr = item as {
      number?: unknown;
      title?: unknown;
      html_url?: unknown;
      body?: unknown;
      draft?: unknown;
      head?: { sha?: unknown } | null;
      requested_reviewers?: unknown;
    };
    if (typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number <= 0) continue;
    if (typeof pr.title !== 'string' || typeof pr.html_url !== 'string' || !/^https?:\/\//.test(pr.html_url)) continue;
    const ref: PrRef = {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      body: typeof pr.body === 'string' ? pr.body : '',
      ci: null,
      review: null,
      project,
      draft: pr.draft === true,
      requestedReviewers: Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers.length : 0,
    };
    if (typeof pr.head?.sha === 'string' && pr.head.sha) ref.headSha = pr.head.sha;
    out.push(ref);
  }
  return { prs: out, items: parsed.length };
}

// Bounds the Forgejo request fan-out of one /tasks board: PR_PAGES list pages of PR_PAGE_SIZE
// (Forgejo's default max page size), STATUS_CONCURRENCY status/review GETs in flight.
export const PR_PAGE_SIZE = 50;
export const PR_PAGES = 2;
export const STATUS_CONCURRENCY = 4;
// Ceilings on the PR-list stage and on the CI/review lookup stage of one board render.
export const PR_LIST_BUDGET_MS = 10_000;
export const STATUS_BUDGET_MS = 10_000;

/**
 * Reduce `GET /repos/{o}/{r}/commits/{sha}/status` (Forgejo's combined status) to a verdict.
 * No statuses, or a state outside success/failure/error/pending (e.g. `warning`), is null — a
 * dash, never a fabricated pass.
 */
export function rollupForgejoStatus(raw: string): CiState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const combined = parsed as { state?: unknown; total_count?: unknown; statuses?: unknown };
  const count = typeof combined.total_count === 'number' ? combined.total_count : Array.isArray(combined.statuses) ? combined.statuses.length : 0;
  if (count === 0) return null;
  switch (combined.state) {
    case 'success':
      return 'pass';
    case 'failure':
    case 'error':
      return 'fail';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

/**
 * Reduce `GET /repos/{o}/{r}/pulls/{n}/reviews` to one verdict. Each reviewer's latest decisive
 * review counts (comments and pending drafts decide nothing; dismissed reviews are dropped). A
 * draft PR dominates — it is explicitly not ready. Any outstanding change request → changes;
 * else any approval → approved; else requested reviewers (or a REQUEST_REVIEW) → review-required;
 * else null. Never fabricates an approval; `raw` null (the reviews could not be read) is null.
 */
export function rollupForgejoReviews(raw: string | null, draft: boolean, requestedReviewers: number): ReviewState {
  if (draft) return 'draft';
  if (raw === null) return null;
  let reviews: unknown;
  try {
    reviews = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(reviews)) return null;
  type Review = { id?: unknown; state?: unknown; dismissed?: unknown; user?: { login?: unknown } | null };
  // Review ids grow with submission, so ascending id order lets a reviewer's later verdict
  // replace their earlier one regardless of the order the API lists them in.
  const ordered = (reviews.filter((r) => r && typeof r === 'object') as Review[]).sort(
    (a, b) => (typeof a.id === 'number' ? a.id : 0) - (typeof b.id === 'number' ? b.id : 0),
  );
  const latest = new Map<string, string>();
  let reviewRequested = requestedReviewers > 0;
  for (const r of ordered) {
    if (r.dismissed === true || typeof r.state !== 'string') continue;
    if (r.state === 'REQUEST_REVIEW') {
      reviewRequested = true;
      continue;
    }
    if (r.state !== 'APPROVED' && r.state !== 'REQUEST_CHANGES') continue;
    // A review without a user (e.g. a team review) is its own reviewer: collapsing all of them
    // onto one key would let one's approval overwrite another's change request.
    latest.set(typeof r.user?.login === 'string' && r.user.login ? `user:${r.user.login}` : `review:${String(r.id)}`, r.state);
  }
  const verdicts = [...latest.values()];
  if (verdicts.includes('REQUEST_CHANGES')) return 'changes';
  if (verdicts.includes('APPROVED')) return 'approved';
  return reviewRequested ? 'review-required' : null;
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
