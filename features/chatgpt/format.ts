// PURE display helpers for `tg chatgpt` and the /chatgpt menu: secret redaction, control-character
// stripping, truncation, and the concise plain-English renderings of pm results.
//
// Everything printed from a pm result goes through `display` (strip → redact → truncate) or
// `redactValue` (the --json path), so a token-looking value in pm output never reaches the
// terminal or Telegram, and hidden chat text is shown only through the display fields pm names
// (title, reason, …) at a bounded length. A missing optional field is an em dash.

import { safeSliceEnd } from '../tg-ctl/text-util';
import {
  accountHealthOf,
  accountsOf,
  connectorsOf,
  eventsOf,
  requestOf,
  requestsOf,
  sessionOf,
  sessionRowsOf,
  type AccountHealth,
  type RequestRow,
  type SessionRow,
} from './model';

export const DASH = '—';
export const TITLE_MAX = 60;
export const REASON_MAX = 120;
const FIELD_MAX = 80;

const SECRET_KEY_RE = /token|secret|passw|authorization|api[_-]?key|cookie|bearer|credential|private[_-]?key/i;

const SECRET_TEXT_RES: readonly [RegExp, string][] = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]'],
  [/\b(token|secret|password|passwd|api[_-]?key|authorization|cookie)\b(\s*[:=]\s*)\S+/gi, '$1$2[redacted]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '[redacted]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]'],
  [/[A-Za-z0-9+/]{40,}={1,2}/g, '[redacted]'],
  [/[A-Za-z0-9/]{10,}\+[A-Za-z0-9+/]{30,}/g, '[redacted]'],
];

export function redactText(value: string): string {
  let out = value;
  for (const [re, replacement] of SECRET_TEXT_RES) out = out.replace(re, replacement);
  return out;
}

const MAX_DEPTH = 12;

// Deep copy of a parsed pm value with secret-named keys blanked and secret-looking strings redacted.
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  // Past the bound the subtree is dropped, never passed through unredacted.
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactValue(inner, depth + 1);
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

// One display string: ANSI/control characters gone, secrets redacted, whitespace collapsed,
// cut to `max` characters (surrogate-safe) with an ellipsis. null/empty → an em dash.
export function display(value: string | null | undefined, max = FIELD_MAX): string {
  if (value === null || value === undefined) return DASH;
  const clean = redactText(value.replace(ANSI_RE, '').replace(CONTROL_RE, ' ')).replace(/\s+/g, ' ').trim();
  if (clean === '') return DASH;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, safeSliceEnd(clean, max - 1))}…`;
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

// Epoch seconds → deterministic UTC `YYYY-MM-DD HH:MM`; null → an em dash.
export function fmtTime(sec: number | null): string {
  if (sec === null) return DASH;
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

export function approvalRequestedText(request: RequestRow | null): string {
  const id = request?.requestId ?? null;
  return id === null ? 'Approval requested; confirm in the approval prompt' : `Approval requested (id ${id}); confirm in the approval prompt`;
}

function joinParts(parts: readonly string[]): string {
  return parts.join(' | ');
}

function healthLine(h: AccountHealth, shown: number): string {
  if (h.ok === false) return `${h.workspace} — unavailable: ${display(h.error, REASON_MAX)}`;
  const counts = [
    h.enrolled === null ? null : `${h.enrolled} enrolled`,
    h.present === null ? null : `${h.present} present`,
    h.running === null ? null : `${h.running} running`,
    h.blocked === null ? null : `${h.blocked} blocked`,
  ].filter((c): c is string => c !== null);
  const freshness = h.stale === true ? 'STALE' : h.stale === false ? 'fresh' : DASH;
  return `${h.workspace} — ${counts.length ? counts.join(', ') : `${shown} sessions`} (${freshness}, as of ${fmtTime(h.generatedAt)})`;
}

export function sessionLine(row: SessionRow): string {
  return joinParts([
    `${row.account ?? DASH}  ${row.chat}`,
    display(row.status, 24),
    display(row.title, TITLE_MAX),
    `continuation: ${display(row.continuation, 24)}`,
    `last go: ${display(row.lastGoState, 24)} ${fmtTime(row.lastGoAt)}`,
    `next check: ${fmtTime(row.nextCheckAt)}`,
    `reason: ${display(row.reason, REASON_MAX)}`,
  ]);
}

export function renderSessionList(result: unknown, scope: string): string {
  const rows = sessionRowsOf(result, scope);
  const health = accountHealthOf(result);
  const lines: string[] = [];
  const shownAccounts = health.length ? health.map((h) => h.workspace) : [...new Set(rows.map((r) => r.account ?? DASH))];
  for (const account of shownAccounts) {
    const own = rows.filter((r) => (r.account ?? DASH) === account);
    const h = health.find((x) => x.workspace === account);
    lines.push(h ? healthLine(h, own.length) : `${account} — ${own.length} sessions`);
    if (own.length === 0 && h?.ok !== false) lines.push('  (no sessions)');
    for (const row of own) lines.push(`  ${sessionLine(row)}`);
  }
  if (lines.length === 0) lines.push('No sessions reported.');
  return lines.join('\n');
}

export function renderSessionDetail(result: unknown, workspace: string): string {
  const row = sessionOf(result, workspace);
  if (row === null) return 'pm returned no session for that chat.';
  const lines = [
    `account:       ${row.account ?? DASH}`,
    `chat:          ${row.chat}`,
    `title:         ${display(row.title, TITLE_MAX)}`,
    `status:        ${display(row.status, 40)}`,
    `continuation:  ${display(row.continuation, 40)}`,
    `reason:        ${display(row.reason, REASON_MAX)}`,
    `model/effort:  ${display(row.model, 40)} / ${display(row.effort, 40)}`,
    `latest turn:   ${display(row.latestTurn, 128)}`,
    `last go:       ${display(row.lastGoState, 24)} ${fmtTime(row.lastGoAt)}`,
    `last checked:  ${fmtTime(row.lastCheckedAt)}`,
    `next check:    ${fmtTime(row.nextCheckAt)}`,
  ];
  return lines.join('\n');
}

export function renderEvents(result: unknown): string {
  const events = eventsOf(result);
  if (events.length === 0) return 'No events.';
  return events
    .map((e) => joinParts([fmtTime(e.at), e.account ?? DASH, e.chat ?? DASH, display(e.kind, 24), display(e.message, REASON_MAX)]))
    .join('\n');
}

export function renderAccounts(result: unknown): string {
  const accounts = accountsOf(result);
  if (accounts.length === 0) return 'No accounts reported.';
  return accounts
    .map((a) => {
      const configured = a.configured === null ? DASH : a.configured ? 'configured' : 'not configured';
      const service = a.serviceError ? `${display(a.serviceActive, 24)} (${display(a.serviceError, REASON_MAX)})` : display(a.serviceActive, 24);
      const monitor =
        a.monitorOk === false
          ? `monitor unavailable: ${display(a.monitorError, REASON_MAX)}`
          : `${a.sessions ?? DASH} sessions, ${a.running ?? DASH} running, ${a.blocked ?? DASH} blocked${a.stale === true ? ', STALE' : ''}`;
      return joinParts([a.workspace, configured, `service: ${service}`, monitor]);
    })
    .join('\n');
}

export function requestLine(r: RequestRow): string {
  return joinParts([
    display(r.requestId, 64),
    display(r.status, 24),
    display(r.action, 24),
    `${r.workspace ?? DASH}${r.chat === null ? '' : `/${r.chat}`}`,
    `turn: ${display(r.expectedTurn, 128)}`,
    `expires: ${fmtTime(r.expiresAt)}`,
  ]);
}

export function renderRequests(result: unknown): string {
  const requests = requestsOf(result);
  return requests.length === 0 ? 'No requests.' : requests.map(requestLine).join('\n');
}

export function renderRequest(result: unknown): string {
  const r = requestOf(result);
  return r === null ? 'pm returned no request.' : requestLine(r);
}

// What a queued mutation prints: the receipt plus the honest "not yet approved" line.
export function renderQueued(result: unknown, what: string): string {
  const r = requestOf(result);
  const lines = [`${approvalRequestedText(r)}: ${what}`];
  if (r !== null) {
    lines.push(`status: ${display(r.status, 24)}; expires: ${fmtTime(r.expiresAt)}`);
    if (r.expectedTurn !== null) lines.push(`bound to turn: ${display(r.expectedTurn, 128)}`);
  }
  lines.push('tg only queued this request; nothing happens until you approve it. Track it with `tg chatgpt requests`.');
  return lines.join('\n');
}

export function renderConnectors(result: unknown): string {
  const rows = connectorsOf(result);
  if (rows.length === 0) return 'No connectors reported.';
  return rows.map((c) => joinParts([display(c.connector, 40), `target: ${display(c.target, 40)}`, `state: ${display(c.state, 40)}`, display(c.detail, REASON_MAX)])).join('\n');
}
