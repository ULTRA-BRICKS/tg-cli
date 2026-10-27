// PURE logic of the owner-only /chatgpt bot menu (effects injected; tg-ctl wires the real ones).
//
// buildMenu renders the sessions per account as escaped HTML with per-session inline buttons.
// Every button carries an opaque one-use reference (./refs.ts); handleCallback resolves it:
//   - not the configured owner chat, or no configured owner      → "not allowed" (fail closed)
//   - unknown / forged / expired / already-used reference        → "expired" (no pm call)
//   - otherwise the reference is marked used DURABLY first, then the pm call runs, so a replay or
//     a concurrent double tap can never produce a second request.
// A tap never approves anything: state-changing taps call actions.request, which only QUEUES an
// owner approval inside pm (answered by the existing approval prompt). Continue additionally
// re-reads the session and refuses when the latest turn is no longer the one the button was
// rendered against ("state changed, refresh").

import { escapeHtml } from '../render/html';
import {
  DASH,
  REASON_MAX,
  TITLE_MAX,
  approvalRequestedText,
  display,
  fmtTime,
  requestLine,
} from './format';
import { accountHealthOf, latestTurnOf, requestOf, requestsOf, sessionOf, sessionRowsOf, isWorkspace, type SessionRow, type Workspace, type WorkspaceScope } from './model';
import { callPm, type PmMethod, type PmOutcome, type PmParams, type PmRunner } from './pm-client';
import {
  REF_TTL_MS,
  idOfRefData,
  isStateChanging,
  pruneRefs,
  parseRefStore,
  refData,
  serializeRefStore,
  type RefKind,
  type RefRecord,
  type RefStore,
  type StateChangingKind,
} from './refs';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export interface BotReply {
  html: string;
  keyboard?: InlineKeyboard;
}

export interface CallbackResult {
  toast: string;
  reply?: BotReply;
}

export interface BotDeps {
  run: PmRunner;
  now: () => number; // ms epoch
  randomId: () => string;
  readStore: () => string | null;
  writeStore: (content: string) => void; // atomic; throws on failure
  ownerChatId: number; // the configured owner chat; anything not a positive/negative safe integer is "none"
}

export const MENU_SESSION_LIMIT = 10;
const MENU_TEXT_BUDGET = 2400;
const TOAST_MAX = 190;
const MENU_REASON = 'requested via /chatgpt menu';
const REQUEST_STATUS_BUTTONS = 5;
const NOT_ALLOWED: CallbackResult = { toast: 'not allowed' };
const EXPIRED: CallbackResult = { toast: 'expired' };

function hasOwner(deps: BotDeps): boolean {
  return Number.isSafeInteger(deps.ownerChatId) && deps.ownerChatId !== 0;
}

function esc(value: string | null, max: number): string {
  return escapeHtml(display(value, max));
}

function errorReply(prefix: string, message: string): BotReply {
  return { html: `${escapeHtml(prefix)}: ${esc(message, REASON_MAX)}` };
}

type MintSpec = { kind: RefKind; workspace: WorkspaceScope; chat?: string | null; expectedTurn?: string | null; requestId?: string | null };

// Mints into `store` (the caller commits). Ids never repeat inside the store.
function mint(deps: BotDeps, store: RefStore, spec: MintSpec): string {
  let id = deps.randomId();
  while (store.refs.some((r) => r.id === id)) id = deps.randomId();
  const now = deps.now();
  store.refs.push({
    id,
    kind: spec.kind,
    workspace: spec.workspace,
    chat: spec.chat ?? null,
    expectedTurn: spec.expectedTurn ?? null,
    requestId: spec.requestId ?? null,
    ownerChatId: deps.ownerChatId,
    createdAt: now,
    expiresAt: now + REF_TTL_MS,
    used: false,
  });
  return refData(id);
}

function loadStore(deps: BotDeps): RefStore {
  return parseRefStore(deps.readStore());
}

function commit(deps: BotDeps, store: RefStore): void {
  deps.writeStore(serializeRefStore(pruneRefs(store, deps.now())));
}

function button(text: string, data: string): InlineButton {
  return { text, callback_data: data };
}

// Per-session buttons. Continue exists only when the turn it binds is known.
function sessionRows(deps: BotDeps, store: RefStore, row: SessionRow, label: string, withDetails: boolean): InlineButton[][] {
  if (row.account === null || !isWorkspace(row.account)) return [];
  const workspace: Workspace = row.account;
  const ref = (kind: RefKind, turn: string | null = null): string => mint(deps, store, { kind, workspace, chat: row.chat, expectedTurn: turn });
  const first: InlineButton[] = [];
  if (withDetails) first.push(button(`${label} Details`, ref('details')));
  first.push(button(`${label} Pause`, ref('pause')), button(`${label} Resume`, ref('resume')));
  const second: InlineButton[] = [button(`${label} Watch`, ref('watch'))];
  if (row.latestTurn !== null) second.push(button(`${label} Continue`, ref('continue', row.latestTurn)));
  return [first, second];
}

function countsText(workspace: string, row: { enrolled: number | null; present: number | null; running: number | null; blocked: number | null; stale: boolean | null; ok: boolean | null; error: string | null }): string {
  if (row.ok === false) return `<b>${escapeHtml(workspace)}</b> — unavailable: ${esc(row.error, REASON_MAX)}`;
  const parts = [
    row.enrolled === null ? null : `${row.enrolled} enrolled`,
    row.running === null ? null : `${row.running} running`,
    row.blocked === null ? null : `${row.blocked} blocked`,
  ].filter((p): p is string => p !== null);
  const fresh = row.stale === true ? ' · STALE' : '';
  return `<b>${escapeHtml(workspace)}</b> — ${parts.length ? parts.join(', ') : DASH}${fresh}`;
}

export async function buildMenu(deps: BotDeps, scope: WorkspaceScope): Promise<BotReply> {
  if (!hasOwner(deps)) return { html: 'ChatGPT control is unavailable: no owner chat is configured.' };
  const outcome = await callPm(deps.run, 'sessions.list', { workspace: scope });
  if (outcome.kind !== 'ok') return errorReply('ChatGPT sessions unavailable', outcome.message);
  const rows = sessionRowsOf(outcome.result, scope);
  const health = accountHealthOf(outcome.result);
  const accounts = health.length ? health.map((h) => h.workspace) : [...new Set(rows.map((r) => r.account ?? DASH))];
  const store = loadStore(deps);
  const lines: string[] = ['<b>ChatGPT sessions</b>'];
  const keyboard: InlineButton[][] = [];
  let shown = 0;
  for (const account of accounts) {
    const h = health.find((x) => x.workspace === account);
    lines.push('', h ? countsText(account, h) : `<b>${escapeHtml(account)}</b>`);
    const own = rows.filter((r) => (r.account ?? DASH) === account);
    if (own.length === 0 && h?.ok !== false) lines.push('(no sessions)');
    for (const row of own) {
      // Telegram caps a message at 4096 chars; escaping can inflate a row ~5x, so stop early (rest -> "+N more").
      if (shown >= MENU_SESSION_LIMIT || lines.join('\n').length > MENU_TEXT_BUDGET) break;
      shown++;
      lines.push(
        `${shown}. <b>${esc(row.title, TITLE_MAX)}</b>`,
        `   <code>${escapeHtml(row.chat)}</code> · ${esc(row.status, 24)} · continuation ${esc(row.continuation, 24)}`,
      );
      if (row.reason !== null) lines.push(`   ${esc(row.reason, REASON_MAX)}`);
      keyboard.push(...sessionRows(deps, store, row, String(shown), true));
    }
  }
  if (rows.length > shown) lines.push('', `+${rows.length - shown} more — see <code>tg chatgpt list</code>`);
  keyboard.push([button('Requests', mint(deps, store, { kind: 'requests', workspace: 'all' })), button('Refresh', mint(deps, store, { kind: 'refresh', workspace: scope }))]);
  try {
    commit(deps, store);
  } catch {
    return { html: 'ChatGPT control is unavailable: the callback store could not be written.' };
  }
  return { html: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

function toastOf(text: string): string {
  return display(text, TOAST_MAX);
}

function failure(prefix: string, outcome: Exclude<PmOutcome, { kind: 'ok' }>): CallbackResult {
  const message = outcome.message;
  return { toast: toastOf(`${prefix}: ${message}`), reply: errorReply(prefix, message) };
}

async function pm(deps: BotDeps, method: PmMethod, params: PmParams): Promise<PmOutcome> {
  return callPm(deps.run, method, params);
}

async function detailsReply(deps: BotDeps, workspace: Workspace, chat: string): Promise<CallbackResult> {
  const outcome = await pm(deps, 'sessions.get', { workspace, chat });
  if (outcome.kind !== 'ok') return failure('Could not load the session', outcome);
  const row = sessionOf(outcome.result, workspace);
  if (row === null) return { toast: 'no such session', reply: { html: 'pm returned no session for that chat.' } };
  const html = [
    `<b>${esc(row.title, TITLE_MAX)}</b>`,
    `account <b>${escapeHtml(workspace)}</b> · chat <code>${escapeHtml(row.chat)}</code>`,
    `status: ${esc(row.status, 40)} · continuation: ${esc(row.continuation, 40)}`,
    `reason: ${esc(row.reason, REASON_MAX)}`,
    `model/effort: ${esc(row.model, 40)} / ${esc(row.effort, 40)}`,
    `latest turn: <code>${esc(row.latestTurn, 128)}</code>`,
    `last go: ${esc(row.lastGoState, 24)} ${escapeHtml(fmtTime(row.lastGoAt))}`,
    `last checked: ${escapeHtml(fmtTime(row.lastCheckedAt))} · next: ${escapeHtml(fmtTime(row.nextCheckAt))}`,
  ].join('\n');
  const store = loadStore(deps);
  const rows = sessionRows(deps, store, { ...row, account: workspace }, '', false).map((r) => r.map((b) => ({ ...b, text: b.text.trim() })));
  try {
    commit(deps, store);
  } catch {
    return { toast: 'details loaded', reply: { html } };
  }
  return { toast: 'details', reply: { html, keyboard: { inline_keyboard: rows } } };
}

function statusKeyboard(deps: BotDeps, requestId: string | null): InlineKeyboard | undefined {
  if (requestId === null) return undefined;
  const store = loadStore(deps);
  const data = mint(deps, store, { kind: 'request-status', workspace: 'all', requestId });
  try {
    commit(deps, store);
  } catch {
    return undefined;
  }
  return { inline_keyboard: [[button('Request status', data)]] };
}

function queuedReply(deps: BotDeps, outcome: PmOutcome, what: string, turn: string | null): CallbackResult {
  if (outcome.kind === 'uncertain') {
    return { toast: toastOf('Outcome unknown — check `tg chatgpt requests`; not retried'), reply: errorReply(`Outcome unknown for ${what}`, outcome.message) };
  }
  if (outcome.kind !== 'ok') return failure(`Could not request ${what}`, outcome);
  const request = requestOf(outcome.result);
  const text = approvalRequestedText(request);
  const html = [`<b>${escapeHtml(text)}</b>`, `${escapeHtml(what)}${turn === null ? '' : ` · turn <code>${escapeHtml(turn)}</code>`}`, 'The tap only queued this request — nothing happens until you approve it in the approval prompt.'].join('\n');
  return { toast: toastOf(text), reply: { html, keyboard: statusKeyboard(deps, request?.requestId ?? null) } };
}

async function requestAction(deps: BotDeps, ref: RefRecord, kind: StateChangingKind): Promise<CallbackResult> {
  const workspace = ref.workspace as Workspace;
  const chat = ref.chat as string;
  const what = `${kind} ${workspace}/${chat}`;
  if (kind === 'continue') {
    const current = await pm(deps, 'sessions.get', { workspace, chat });
    if (current.kind !== 'ok') return failure('Could not verify the session; nothing was requested', current);
    const turn = latestTurnOf(current.result);
    if (turn === null || turn !== ref.expectedTurn) {
      const message = turn === null ? 'State changed or unknown (no latest turn) — refresh the /chatgpt menu; nothing was requested.' : 'State changed since this menu was rendered — refresh the /chatgpt menu; nothing was requested.';
      return { toast: toastOf(message), reply: { html: escapeHtml(message) } };
    }
    const outcome = await pm(deps, 'actions.request', { workspace, chat, action: 'continue', expected_turn: turn, reason: MENU_REASON });
    return queuedReply(deps, outcome, what, turn);
  }
  const outcome = await pm(deps, 'actions.request', { workspace, chat, action: kind, reason: MENU_REASON });
  return queuedReply(deps, outcome, what, null);
}

async function requestsReply(deps: BotDeps): Promise<CallbackResult> {
  const outcome = await pm(deps, 'requests.list', {});
  if (outcome.kind !== 'ok') return failure('Could not load requests', outcome);
  const requests = requestsOf(outcome.result);
  if (requests.length === 0) return { toast: 'no requests', reply: { html: 'No requests.' } };
  const store = loadStore(deps);
  const keyboard: InlineButton[][] = [];
  const lines = ['<b>Approval requests</b>'];
  for (const r of requests.slice(0, REQUEST_STATUS_BUTTONS)) {
    lines.push(escapeHtml(requestLine(r)));
    if (r.requestId !== null) keyboard.push([button(`Status ${r.requestId}`.slice(0, 40), mint(deps, store, { kind: 'request-status', workspace: 'all', requestId: r.requestId }))]);
  }
  try {
    commit(deps, store);
  } catch {
    return { toast: 'requests', reply: { html: lines.join('\n') } };
  }
  return { toast: 'requests', reply: { html: lines.join('\n'), keyboard: { inline_keyboard: keyboard } } };
}

async function requestStatusReply(deps: BotDeps, requestId: string): Promise<CallbackResult> {
  const outcome = await pm(deps, 'requests.get', { request_id: requestId });
  if (outcome.kind !== 'ok') return failure('Could not load the request', outcome);
  const request = requestOf(outcome.result);
  const line = request === null ? 'pm returned no request.' : requestLine(request);
  return { toast: toastOf(request?.status ?? 'status'), reply: { html: `<b>Request status</b>\n${escapeHtml(line)}`, keyboard: statusKeyboard(deps, requestId) } };
}

export interface CallbackInput {
  data: string;
  chatId: number; // the chat the tapped message sits in
}

export async function handleCallback(deps: BotDeps, input: CallbackInput): Promise<CallbackResult> {
  if (!hasOwner(deps) || input.chatId !== deps.ownerChatId) return NOT_ALLOWED;
  const id = idOfRefData(input.data);
  if (id === null) return EXPIRED;
  const store = loadStore(deps);
  const ref = store.refs.find((r) => r.id === id);
  if (ref === undefined || ref.used || ref.expiresAt <= deps.now()) return EXPIRED;
  if (ref.ownerChatId !== deps.ownerChatId) return NOT_ALLOWED;
  // Consume durably BEFORE any pm call. Everything up to here is synchronous, so a concurrent
  // second tap of the same reference already sees `used`.
  ref.used = true;
  try {
    commit(deps, store);
  } catch {
    return { toast: 'could not record the tap — nothing was requested' };
  }
  if (isStateChanging(ref.kind)) return requestAction(deps, ref, ref.kind);
  switch (ref.kind) {
    case 'details':
      return detailsReply(deps, ref.workspace as Workspace, ref.chat as string);
    case 'refresh': {
      const reply = await buildMenu(deps, ref.workspace);
      return { toast: 'refreshed', reply };
    }
    case 'requests':
      return requestsReply(deps);
    case 'request-status':
      return requestStatusReply(deps, ref.requestId as string);
  }
  return EXPIRED;
}
