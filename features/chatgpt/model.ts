// PURE tolerant readers for the JSON that `pm chatgpt api` returns.
//
// pm is a separate project: unknown extra keys are ignored and a missing optional field is null
// (rendered as an em dash by ./format.ts) — a value is never fabricated. The shapes assumed here
// are the combined monitor shape (accounts/sessions/events, pmlib/chatgpt_monitor.combine()) and
// the frozen request receipt; see docs/chatgpt.md "Assumed pm result shapes".

import { isRecord } from '../tg-ctl/guards';

export const WORKSPACES = ['home', 'glide.vc'] as const;
export type Workspace = (typeof WORKSPACES)[number];
export type WorkspaceScope = Workspace | 'all';

export function isWorkspace(value: unknown): value is Workspace {
  return typeof value === 'string' && (WORKSPACES as readonly string[]).includes(value);
}

export function isWorkspaceScope(value: unknown): value is WorkspaceScope {
  return value === 'all' || isWorkspace(value);
}

// Bounded charsets: no leading '-' (never option-like), no whitespace, no shell metacharacters.
const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TURN_ID_RE = CHAT_ID_RE;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function isChatId(value: string): boolean {
  return CHAT_ID_RE.test(value);
}
export function isRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
}

// pm reports a chat as an id or as a URL/path; the API identity is the last path segment.
export function chatIdOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tail = raw.trim().split(/[?#]/, 1)[0].replace(/\/+$/, '').split('/').pop() ?? '';
  return CHAT_ID_RE.test(tail) ? tail : null;
}

export type JsonRecord = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// Epoch seconds (milliseconds are folded down), or null.
function epoch(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? Math.floor(value / 1000) : value;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function list(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const TURN_KEYS = ['latest_turn', 'latest_turn_id', 'turn', 'turn_id', 'last_turn', 'expected_turn'] as const;

function turnIn(record: JsonRecord): string | null {
  for (const key of TURN_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && TURN_ID_RE.test(value)) return value;
  }
  return null;
}

export interface SessionRow {
  account: string | null;
  chat: string;
  title: string | null;
  status: string | null;
  reason: string | null;
  continuation: string | null;
  model: string | null;
  effort: string | null;
  lastCheckedAt: number | null;
  lastGoAt: number | null;
  lastGoState: string | null;
  nextCheckAt: number | null;
  latestTurn: string | null;
}

function sessionRow(row: JsonRecord, defaultAccount: string | null): SessionRow | null {
  const chat = chatIdOf(row.chat);
  if (chat === null) return null;
  const accountRaw = text(row.account) ?? defaultAccount;
  return {
    account: accountRaw !== null && ACCOUNT_RE.test(accountRaw) ? accountRaw : null,
    chat,
    title: text(row.title),
    status: text(row.status),
    reason: text(row.reason),
    continuation: text(row.continuation),
    model: text(row.model),
    effort: text(row.effort),
    lastCheckedAt: epoch(row.last_checked_at),
    lastGoAt: epoch(row.last_go_at),
    lastGoState: text(row.last_go_state),
    nextCheckAt: epoch(row.next_check_at),
    latestTurn: turnIn(row),
  };
}

export function sessionRowsOf(result: unknown, defaultAccount: string | null): SessionRow[] {
  if (!isRecord(result)) return [];
  const fallback = defaultAccount === 'all' ? null : defaultAccount;
  return list(result.sessions)
    .map((row) => sessionRow(row, fallback))
    .filter((row): row is SessionRow => row !== null);
}

// sessions.get: the session sits at result.session (or is the result itself).
export function sessionOf(result: unknown, defaultAccount: string | null): SessionRow | null {
  if (!isRecord(result)) return null;
  const inner = isRecord(result.session) ? result.session : result;
  const row = sessionRow(inner, defaultAccount);
  if (row === null) return null;
  return { ...row, latestTurn: row.latestTurn ?? turnIn(result) };
}

// The current latest turn id of a sessions.get result, or null when pm exposes none.
export function latestTurnOf(result: unknown): string | null {
  if (!isRecord(result)) return null;
  return (isRecord(result.session) ? turnIn(result.session) : null) ?? turnIn(result);
}

export interface AccountHealth {
  workspace: string;
  ok: boolean | null;
  stale: boolean | null;
  error: string | null;
  generatedAt: number | null;
  enrolled: number | null;
  present: number | null;
  running: number | null;
  blocked: number | null;
}

// sessions.list accounts (combined monitor shape).
export function accountHealthOf(result: unknown): AccountHealth[] {
  if (!isRecord(result)) return [];
  const rows: AccountHealth[] = [];
  for (const row of list(result.accounts)) {
    const workspace = text(row.workspace);
    if (workspace === null || !ACCOUNT_RE.test(workspace)) continue;
    const summary = isRecord(row.summary) ? row.summary : {};
    rows.push({
      workspace,
      ok: bool(row.ok),
      stale: bool(row.stale),
      error: text(row.error),
      generatedAt: epoch(row.generated_at),
      enrolled: count(summary.enrolled),
      present: count(summary.present),
      running: count(summary.running),
      blocked: count(summary.blocked),
    });
  }
  return rows;
}

export interface AccountReport {
  workspace: string;
  configured: boolean | null;
  serviceActive: string | null;
  serviceError: string | null;
  monitorOk: boolean | null;
  monitorError: string | null;
  stale: boolean | null;
  sessions: number | null;
  enrolled: number | null;
  running: number | null;
  blocked: number | null;
}

// accounts.list result.
export function accountsOf(result: unknown): AccountReport[] {
  if (!isRecord(result)) return [];
  const rows: AccountReport[] = [];
  for (const row of list(result.accounts)) {
    const workspace = text(row.workspace);
    if (workspace === null || !ACCOUNT_RE.test(workspace)) continue;
    const service = isRecord(row.service) ? row.service : {};
    const monitor = isRecord(row.monitor) ? row.monitor : {};
    rows.push({
      workspace,
      configured: bool(row.configured),
      serviceActive: text(service.active),
      serviceError: text(service.error),
      monitorOk: bool(monitor.ok),
      monitorError: text(monitor.error),
      stale: bool(monitor.stale),
      sessions: count(monitor.sessions),
      enrolled: count(monitor.enrolled),
      running: count(monitor.running),
      blocked: count(monitor.blocked),
    });
  }
  return rows;
}

export interface EventRow {
  account: string | null;
  at: number | null;
  chat: string | null;
  kind: string | null;
  message: string | null;
}

export function eventsOf(result: unknown): EventRow[] {
  if (!isRecord(result)) return [];
  return list(result.events).map((row) => {
    const account = text(row.account);
    return {
      account: account !== null && ACCOUNT_RE.test(account) ? account : null,
      at: epoch(row.at),
      chat: chatIdOf(row.chat),
      kind: text(row.kind) ?? text(row.type) ?? text(row.event),
      message: text(row.message) ?? text(row.text) ?? text(row.summary) ?? text(row.reason),
    };
  });
}

export interface RequestRow {
  requestId: string | null;
  status: string | null;
  action: string | null;
  workspace: string | null;
  chat: string | null;
  expectedTurn: string | null;
  expiresAt: number | null;
}

function requestRow(row: JsonRecord): RequestRow {
  const id = text(row.request_id);
  const workspace = text(row.workspace);
  const expected = text(row.expected_turn);
  return {
    requestId: id !== null && REQUEST_ID_RE.test(id) ? id : null,
    status: text(row.status),
    action: text(row.action),
    workspace: workspace !== null && ACCOUNT_RE.test(workspace) ? workspace : null,
    chat: chatIdOf(row.chat),
    expectedTurn: expected !== null && TURN_ID_RE.test(expected) ? expected : null,
    expiresAt: epoch(row.expires_at),
  };
}

// A single receipt (actions.request / requests.get / connectors.request) or null.
export function requestOf(result: unknown): RequestRow | null {
  return isRecord(result) ? requestRow(result) : null;
}

// requests.list: {requests:[…]} or a bare array.
export function requestsOf(result: unknown): RequestRow[] {
  if (Array.isArray(result)) return list(result).map(requestRow);
  return isRecord(result) ? list(result.requests).map(requestRow) : [];
}

export interface ConnectorRow {
  connector: string | null;
  target: string | null;
  state: string | null;
  detail: string | null;
}

export function connectorsOf(result: unknown): ConnectorRow[] {
  const rows = Array.isArray(result) ? list(result) : isRecord(result) ? list(result.connectors) : [];
  return rows.map((row) => ({
    connector: text(row.connector) ?? text(row.name) ?? text(row.id),
    target: text(row.target),
    state: text(row.state) ?? text(row.status),
    detail: text(row.detail) ?? text(row.message) ?? text(row.step) ?? text(row.next_step),
  }));
}
