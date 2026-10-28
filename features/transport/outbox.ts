// --- Outbound outbox: sends Telegram did not take, replayed later (tg-cli#710) ---
//
// When a `tg` send is still transiently failing after its retry budget (send-retry.ts),
// the transport hands over the UNSENT remainder of that send (QueuedSend — parts already
// delivered are not included) and `tg` persists it here, then exits 75. The tg-ctl
// daemon replays the queue after a successful getUpdates and on startup.
//
// Layout, per bot, under the tg-cli config dir (CtlPaths.outbox):
//   <id>.json         one entry: the requests as they would have gone out (thread id and
//                     reply anchor already resolved), the original time, and the route +
//                     history bookkeeping `tg` would have written for the message ids
//   <id>.files/       copies of every uploaded photo/document, so a temp file that
//                     vanished after `tg` exited cannot lose the send
//   failed/           entries Telegram refused (a 4xx) or that could not be read — kept
//                     for a human, never retried
//   archive/          entries past the outbox limits (OUTBOX_LIMITS: older than a day, or
//                     the oldest beyond the count/size cap) — kept for a human, never sent
// <id> starts with the zero-padded creation time, so a name sort is FIFO. An entry is
// written to a .tmp sibling and renamed, mode 0600 in a 0700 dir.
//
// Replay sends one request at a time, oldest first, and stops at the first transient
// failure (Telegram is still down; the next successful getUpdates tries again). Every
// replayed message carries a visible delay mark with the original time; a partly
// replayed entry is rewritten with only its unsent requests.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { basename, join } from 'path';
import { visibleLength } from '../auto-attach/transmitter';
import { CAPTION_LIMIT, MESSAGE_LIMIT } from '../auto-attach/types';
import { escapeHtml } from '../render/html';
import { validateRichHtml } from '../render/rich';
import type { HistoryRecord } from '../replies/history';
import { buildOutboundHistoryRecords } from '../replies/outbound';
import type { Route } from '../tg-ctl/routes';
import { describeFetchError, isTransientStatus, readTransientAnswer } from './send-retry';
import { isThreadRejection, isTopicDeletedError, readErrorDescription, type QueuedSend } from './telegram';

// The route `tg` records for each message id of a send, minus the id and time.
export type OutboxRoute = Omit<Route, 'id' | 'ts'>;

// The `agent` history row `tg` writes for a send (buildOutboundHistoryRecords' inputs).
export interface OutboxHistory {
  ts: number;
  text: string;
  pane: string;
  chatId?: number;
  targetAgent?: string;
  sessionKey?: string;
  groupToken: string;
}

export interface OutboxFile {
  field: string;
  // file name inside <id>.files/
  file: string;
  // the upload's own file name
  name: string;
}

// One Bot API request. `files` present = multipart (body holds its string fields).
export interface OutboxOp {
  method: string;
  body: Record<string, unknown>;
  files?: OutboxFile[];
  threadAdvisory?: boolean;
  // The delay mark already went out as its own message: send this request unmarked.
  marked?: boolean;
}

export interface OutboxEntry {
  version: 1;
  id: string;
  // ms epoch: when the agent sent it
  createdAt: number;
  ops: OutboxOp[];
  // message ids replay already delivered for this entry (and the thread each landed in);
  // `mark`: a separate delay-mark message — routed, but not a history row of the report
  delivered: Array<{ id: number; threadId: number | null; mark?: boolean }>;
  route?: OutboxRoute;
  history?: OutboxHistory;
  // `tg --tag answer --reply-to <id>`: the done reaction on the answered message, set once
  // the replay delivered the answer.
  reaction?: { chatId: string; messageId: number; emoji: string };
}

// The outbox is bounded (tg-cli#710): a message a day late is no longer worth sending
// unannounced, and a long outage must not fill the disk with copied uploads. Past a limit an
// entry moves, oldest first, to archive/ with a warning — never deleted, never sent. Only the
// daemon prunes, at the start of a flush: `tg` only ever adds entries, so no other process
// moves an entry the flush is replaying.
export const OUTBOX_LIMITS = { maxAgeMs: 24 * 60 * 60 * 1000, maxEntries: 200, maxBytes: 200 * 1024 * 1024 };

function entryBytes(dir: string, base: string): number {
  let total = statSync(join(dir, `${base}.json`)).size;
  const filesDir = join(dir, `${base}.files`);
  if (existsSync(filesDir)) for (const f of readdirSync(filesDir)) total += statSync(join(filesDir, f)).size;
  return total;
}

function moveTo(dir: string, sub: 'failed' | 'archive', base: string): void {
  const target = join(dir, sub);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  renameSync(join(dir, `${base}.json`), join(target, `${base}.json`));
  if (existsSync(join(dir, `${base}.files`))) renameSync(join(dir, `${base}.files`), join(target, `${base}.files`));
}

// Move every entry past OUTBOX_LIMITS to archive/, oldest first, warning once per entry. The
// parts of an entry that went out before the outage keep their history rows. Returns how
// many moved.
export function pruneOutbox(dir: string, deps: Pick<FlushDeps, 'now' | 'log' | 'appendHistory'>, limits = OUTBOX_LIMITS): number {
  const nowMs = deps.now();
  // An entry whose files can't be sized (a damaged .files) goes to failed/ like any other
  // unreadable entry — it must not stall the rest of the queue.
  const entries: Array<{ base: string; entry: OutboxEntry }> = [];
  const sizes: number[] = [];
  for (const e of readOutbox(dir).entries) {
    try {
      sizes.push(entryBytes(dir, e.base));
      entries.push(e);
    } catch (err) {
      writeHistory(e.entry, deps);
      moveTo(dir, 'failed', e.base);
      deps.log(`outbox: dropped ${e.base} (moved to failed/): its files are unreadable (${err})`);
    }
  }
  let count = entries.length;
  let bytes = sizes.reduce((a, b) => a + b, 0);
  let moved = 0;
  for (const [i, { base, entry }] of entries.entries()) {
    const age = nowMs - entry.createdAt;
    const reason =
      age > limits.maxAgeMs ? `older than ${Math.round(limits.maxAgeMs / 3_600_000)} h`
      : count > limits.maxEntries ? `more than ${limits.maxEntries} queued sends`
      : bytes > limits.maxBytes ? `queue over ${Math.round(limits.maxBytes / 1_048_576)} MB`
      : null;
    if (reason === null) continue;
    writeHistory(entry, deps);
    moveTo(dir, 'archive', base);
    count--;
    bytes -= sizes[i];
    moved++;
    deps.log(`outbox: archived ${base} without sending it (${reason}; queued ${new Date(entry.createdAt).toISOString()}) — see ${join(dir, 'archive')}`);
  }
  return moved;
}

function fsyncPath(path: string, flags: string): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// tmp + fsync + rename + fsync of the dir: `tg` reports "queued" (exit 75) only once the
// entry would survive a power cut.
function writeAtomic(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content) : content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncPath(join(path, '..'), 'r');
}

// One queued send → its outbox request; uploads are copied into <id>.files/ first.
async function toOutboxOp(send: QueuedSend, i: number, filesDir: string): Promise<OutboxOp> {
  const advisory = send.threadAdvisory ? { threadAdvisory: true } : {};
  if (!(send.body instanceof FormData)) return { method: send.method, body: send.body, ...advisory };
  const body: Record<string, unknown> = {};
  const files: OutboxFile[] = [];
  for (const [field, value] of send.body.entries()) {
    if (typeof value === 'string') {
      body[field] = value;
      continue;
    }
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    const file = `${i}-${field}`;
    writeAtomic(join(filesDir, file), new Uint8Array(await value.arrayBuffer()));
    // A Bun.file part is named by its whole path; Telegram gets the base name.
    files.push({ field, file, name: value.name ? basename(value.name) : field });
  }
  return { method: send.method, body, files, ...advisory };
}

export async function writeOutboxEntry(
  dir: string,
  // `delivered`: the parts of this send that went out before the outage. Their routes are
  // already written; their history rows are written with the replayed ones, as one group.
  input: {
    sends: QueuedSend[];
    createdAt: number;
    route?: OutboxRoute;
    history?: OutboxHistory;
    delivered?: Array<{ id: number; threadId: number | null }>;
    reaction?: OutboxEntry['reaction'];
  },
): Promise<{ id: string; path: string }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${String(input.createdAt).padStart(15, '0')}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const filesDir = join(dir, `${id}.files`);
  const ops: OutboxOp[] = [];
  for (const [i, send] of input.sends.entries()) ops.push(await toOutboxOp(send, i, filesDir));
  const entry: OutboxEntry = {
    version: 1,
    id,
    createdAt: input.createdAt,
    ops,
    delivered: input.delivered ?? [],
    ...(input.route ? { route: input.route } : {}),
    ...(input.history ? { history: input.history } : {}),
    ...(input.reaction ? { reaction: input.reaction } : {}),
  };
  const path = join(dir, `${id}.json`);
  writeAtomic(path, JSON.stringify(entry));
  return { id, path };
}

// The method becomes a URL path segment on replay, so only a bare Bot API name is accepted.
const BOT_METHOD = /^[A-Za-z]+$/;

function parseEntry(raw: string): OutboxEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('ops' in parsed) ||
    !Array.isArray(parsed.ops) ||
    !parsed.ops.every(
      (op: unknown) =>
        op && typeof op === 'object' && 'method' in op && typeof op.method === 'string' && BOT_METHOD.test(op.method) && 'body' in op && op.body && typeof op.body === 'object',
    ) ||
    !('createdAt' in parsed) ||
    typeof parsed.createdAt !== 'number' ||
    !('delivered' in parsed) ||
    !Array.isArray(parsed.delivered)
  ) {
    return null;
  }
  // Shape checked above; the file is ours (0600, written by writeOutboxEntry).
  const entry: OutboxEntry = parsed as OutboxEntry;
  return entry;
}

// Entries oldest first, plus the names of files that are not a readable entry.
export function readOutbox(dir: string): { entries: Array<{ base: string; entry: OutboxEntry }>; broken: string[] } {
  if (!existsSync(dir)) return { entries: [], broken: [] };
  const entries: Array<{ base: string; entry: OutboxEntry }> = [];
  const broken: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const base = name.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue; // removed between the listing and the read
    }
    const entry = parseEntry(raw);
    if (entry) entries.push({ base, entry });
    else broken.push(base);
  }
  return { entries, broken };
}

// "⏳ доставлено с задержкой, написано в 19:07 UTC" — with the date once the day changed.
export function formatDelayMark(createdAtMs: number, nowMs: number): string {
  const written = new Date(createdAtMs).toISOString();
  const time = written.slice(11, 16);
  const day = written.slice(0, 10);
  return day === new Date(nowMs).toISOString().slice(0, 10)
    ? `⏳ доставлено с задержкой, написано в ${time} UTC`
    : `⏳ доставлено с задержкой, написано ${day} в ${time} UTC`;
}

// The mark as its own message, in the same thread and under the same anchor. A multipart
// request stored its fields as strings; this JSON request needs integers.
function markMessage(op: OutboxOp, mark: string): OutboxOp {
  const body: Record<string, unknown> = { chat_id: op.body.chat_id, text: mark };
  if (op.body.message_thread_id !== undefined) body.message_thread_id = Number(op.body.message_thread_id);
  if (op.body.reply_to_message_id !== undefined) body.reply_to_message_id = Number(op.body.reply_to_message_id);
  const replyParameters = op.body.reply_parameters;
  if (replyParameters && typeof replyParameters === 'object' && 'message_id' in replyParameters) {
    body.reply_to_message_id = Number(replyParameters.message_id);
  }
  return { method: 'sendMessage', body, ...(op.threadAdvisory ? { threadAdvisory: true } : {}) };
}

// `text` with the mark as its first line, if the result still fits `limit`.
function prefixed(text: string | undefined, parseMode: unknown, mark: string, limit: number): string | null {
  const html = parseMode === 'HTML';
  const line = html ? escapeHtml(mark) : mark;
  const out = text ? `${line}\n${text}` : line;
  return visibleLength(out, html ? 'html' : 'plain') <= limit ? out : null;
}

// The request(s) that replay `op` with the delay mark: the mark rides the text or
// caption when it fits, else it goes out as its own message just before.
export function markOp(op: OutboxOp, mark: string): OutboxOp[] {
  const marked = markedBody(op, mark);
  return marked ? [{ ...op, body: marked }] : [markMessage(op, mark), op];
}

// The request body with the mark folded in, or null when it does not fit / not foldable.
function markedBody(op: OutboxOp, mark: string): Record<string, unknown> | null {
  switch (op.method) {
    case 'sendMessage':
      return markedText(op.body, mark);
    case 'sendRichMessage':
      return markedRich(op.body, mark);
    case 'sendPhoto':
    case 'sendDocument':
      return markedCaption(op.body, mark);
    case 'sendMediaGroup':
      return markedAlbum(op.body, mark);
    default:
      return null;
  }
}

function markedText(body: Record<string, unknown>, mark: string): Record<string, unknown> | null {
  if (typeof body.text !== 'string' || body.entities !== undefined) return null;
  const text = prefixed(body.text, body.parse_mode, mark, MESSAGE_LIMIT);
  return text === null ? null : { ...body, text };
}

function markedRich(body: Record<string, unknown>, mark: string): Record<string, unknown> | null {
  const rich = body.rich_message;
  if (!rich || typeof rich !== 'object' || !('html' in rich) || typeof rich.html !== 'string') return null;
  const html = `<p>${escapeHtml(mark)}</p>${rich.html}`;
  // The extra paragraph is one more block and more text: past a rich limit Telegram
  // would refuse the whole report.
  return validateRichHtml(html).ok ? { ...body, rich_message: { html } } : null;
}

function markedCaption(body: Record<string, unknown>, mark: string): Record<string, unknown> | null {
  const caption = prefixed(typeof body.caption === 'string' ? body.caption : undefined, body.parse_mode, mark, CAPTION_LIMIT);
  return caption === null ? null : { ...body, caption };
}

function markedAlbum(body: Record<string, unknown>, mark: string): Record<string, unknown> | null {
  if (typeof body.media !== 'string') return null;
  let media: unknown = null;
  try {
    media = JSON.parse(body.media);
  } catch {
    // not ours to fix: the mark goes separately and Telegram judges the album
  }
  if (!Array.isArray(media) || !media[0] || typeof media[0] !== 'object') return null;
  const [first, ...rest] = media;
  const caption = prefixed(typeof first.caption === 'string' ? first.caption : undefined, first.parse_mode, mark, CAPTION_LIMIT);
  return caption === null ? null : { ...body, media: JSON.stringify([{ ...first, caption }, ...rest]) };
}

type ReplayOutcome =
  | { kind: 'ok'; ids: Array<{ id: number; threadId: number | null }> }
  | { kind: 'transient'; reason: string; retryAfterMs?: number }
  | { kind: 'permanent'; reason: string };

function requestInit(op: OutboxOp, body: Record<string, unknown>, filesDir: string): RequestInit {
  if (!op.files) return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const form = new FormData();
  for (const [field, value] of Object.entries(body)) form.append(field, String(value));
  // Read into memory: a Bun.file part would be uploaded under its outbox path name.
  for (const f of op.files) form.append(f.field, new File([readFileSync(join(filesDir, f.file))], f.name));
  return { method: 'POST', body: form };
}

function sentIds(result: unknown, threadId: number | null): Array<{ id: number; threadId: number | null }> {
  const messages = Array.isArray(result) ? result : [result];
  return messages.flatMap((m) =>
    m && typeof m === 'object' && 'message_id' in m && typeof m.message_id === 'number' ? [{ id: m.message_id, threadId }] : [],
  );
}

export interface FlushDeps {
  post: (method: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  log: (line: string) => void;
  recordRoutes: (routes: Route[]) => void;
  appendHistory: (records: HistoryRecord[]) => void;
}

type PostResult = { outcome: ReplayOutcome } | { resp: Response };

async function postRequest(op: OutboxOp, body: Record<string, unknown>, filesDir: string, deps: FlushDeps): Promise<PostResult> {
  let init: RequestInit;
  try {
    init = requestInit(op, body, filesDir);
  } catch (err) {
    // The copied upload is gone or unreadable: no later flush can send it either.
    return { outcome: { kind: 'permanent', reason: `outbox file unreadable: ${describeFetchError(err)}` } };
  }
  try {
    return { resp: await deps.post(op.method, init) };
  } catch (err) {
    return { outcome: { kind: 'transient', reason: describeFetchError(err) } };
  }
}

// Bot API answer → outcome; `rejected` = Telegram refused the request (the caller may fall back).
async function interpretResponse(
  resp: Response,
  body: Record<string, unknown>,
): Promise<ReplayOutcome | { kind: 'rejected'; status: number; description: string }> {
  if (isTransientStatus(resp.status)) return { kind: 'transient', ...(await readTransientAnswer(resp)) };
  const description = await readErrorDescription(resp.clone());
  if (description !== null) return { kind: 'rejected', status: resp.status, description };
  const json: unknown = await resp.json().catch(() => null);
  // A 2xx that is not a Telegram answer (a proxy page) proves nothing was sent.
  if (!json || typeof json !== 'object' || !('ok' in json) || json.ok !== true || !('result' in json)) {
    return { kind: 'transient', reason: `HTTP ${resp.status} without a Bot API answer` };
  }
  const threadId = body.message_thread_id === undefined ? null : Number(body.message_thread_id);
  return { kind: 'ok', ids: sentIds(json.result, threadId) };
}

// The advisory-thread fallback a live send has: a stale topic lands in General, once.
function canFallBackToGeneral(op: OutboxOp, body: Record<string, unknown>, description: string, fellBack: boolean): boolean {
  if (fellBack || !op.threadAdvisory || body.message_thread_id === undefined) return false;
  return isThreadRejection(description) || isTopicDeletedError(description);
}

async function replayOp(op: OutboxOp, filesDir: string, deps: FlushDeps): Promise<ReplayOutcome> {
  let body = op.body;
  let fellBack = false;
  for (;;) {
    const posted = await postRequest(op, body, filesDir, deps);
    if ('outcome' in posted) return posted.outcome;
    const answer = await interpretResponse(posted.resp, body);
    if (answer.kind !== 'rejected') return answer;
    // The same advisory-thread fallback a live send has: a stale topic lands in General,
    // without the anchor (it lives in that topic).
    if (!canFallBackToGeneral(op, body, answer.description, fellBack)) {
      // Server text goes to the daemon log: printable characters only, capped.
      return { kind: 'permanent', reason: `HTTP ${answer.status} ${answer.description.replace(/[\x00-\x1f\x7f]/g, '?')}`.slice(0, 200) };
    }
    const general = { ...body };
    delete general.message_thread_id;
    delete general.reply_to_message_id;
    delete general.reply_parameters;
    body = general;
    fellBack = true;
  }
}

// The `agent` history rows of an entry's delivered report parts (the delay marks are not
// part of the report), as one group with the parts `tg` delivered itself.
function writeHistory(entry: OutboxEntry, deps: Pick<FlushDeps, 'appendHistory'>): void {
  const parts = entry.delivered.filter((d) => !d.mark);
  if (!entry.history || parts.length === 0) return;
  const h = entry.history;
  const threads = new Map(parts.map((d) => [d.id, d.threadId]));
  const ids = parts.map((d) => d.id);
  deps.appendHistory(buildOutboundHistoryRecords(ids, h.text, h.ts, h.pane, h.groupToken, h.chatId, h.targetAgent, h.sessionKey, threads));
}

// Move every unreadable entry to failed/ (never retried, kept for a human).
function quarantineBroken(dir: string, broken: string[], deps: FlushDeps, result: { dropped: number }): void {
  for (const base of broken) {
    moveTo(dir, 'failed', base);
    result.dropped++;
    deps.log(`outbox: dropped ${base}: unreadable entry (moved to failed/)`);
  }
}

// Replay the entry's head request: the delay mark (own message or folded in), then the request.
// Progress is persisted after every request that went out. Returns the failure that stopped it.
async function replayHeadOp(
  entry: OutboxEntry,
  mark: string,
  path: string,
  filesDir: string,
  deps: FlushDeps,
): Promise<Exclude<ReplayOutcome, { kind: 'ok' }> | null> {
  const op = entry.ops[0];
  const parts = op.marked ? [op] : markOp(op, mark);
  for (const [i, part] of parts.entries()) {
    const out = await replayOp(part, filesDir, deps);
    if (out.kind !== 'ok') return out;
    const isMark = i < parts.length - 1;
    entry.delivered.push(...out.ids.map((d) => (isMark ? { ...d, mark: true } : d)));
    const route = entry.route;
    if (route) {
      const ts = Math.floor(deps.now() / 1000);
      deps.recordRoutes(out.ids.map(({ id }) => ({ id, ts, ...route })));
    }
    // A separate mark went out: remember it, so a retry sends only the message itself.
    if (isMark) entry.ops[0] = { ...op, marked: true };
    else entry.ops.shift();
    // Persist progress after every request, so a crash never replays a delivered part.
    writeAtomic(path, JSON.stringify(entry));
  }
  return null;
}

// Best-effort, like the live send: the answer is out either way.
async function postDoneReaction(reaction: NonNullable<OutboxEntry['reaction']>, deps: FlushDeps): Promise<void> {
  const { chatId, messageId, emoji } = reaction;
  try {
    await deps.post('setMessageReaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }),
    });
  } catch (err) {
    deps.log(`outbox: done reaction on ${messageId} failed: ${describeFetchError(err)}`);
  }
}

// Every request of the entry went out: history, done reaction, then remove it from the queue.
async function completeEntry(base: string, entry: OutboxEntry, path: string, filesDir: string, deps: FlushDeps): Promise<void> {
  writeHistory(entry, deps);
  if (entry.reaction) await postDoneReaction(entry.reaction, deps);
  rmSync(path, { force: true });
  rmSync(filesDir, { recursive: true, force: true });
  const ids = entry.delivered.map((d) => d.id);
  deps.log(`outbox: delivered ${base} (queued ${new Date(entry.createdAt).toISOString()}; message ids ${ids.join(', ') || 'none'})`);
}

// Replay the queue, oldest first. `delivered`/`dropped` count entries; `stopped` = a
// transient failure ended the flush with entries still queued (`retryAfterMs`: the wait
// Telegram asked for with a 429).
export async function flushOutbox(
  dir: string,
  deps: FlushDeps,
): Promise<{ delivered: number; dropped: number; stopped: boolean; retryAfterMs?: number }> {
  const result: { delivered: number; dropped: number; stopped: boolean; retryAfterMs?: number } = { delivered: 0, dropped: 0, stopped: false };
  pruneOutbox(dir, deps);
  const { entries, broken } = readOutbox(dir);
  quarantineBroken(dir, broken, deps, result);
  for (const { base, entry } of entries) {
    const path = join(dir, `${base}.json`);
    const filesDir = join(dir, `${base}.files`);
    const mark = formatDelayMark(entry.createdAt, deps.now());
    let failure: Exclude<ReplayOutcome, { kind: 'ok' }> | null = null;
    while (entry.ops.length > 0 && failure === null) failure = await replayHeadOp(entry, mark, path, filesDir, deps);
    if (failure?.kind === 'transient') {
      deps.log(`outbox: Telegram still unavailable (${failure.reason}); ${base} stays queued`);
      result.stopped = true;
      if (failure.retryAfterMs !== undefined) result.retryAfterMs = failure.retryAfterMs;
      return result;
    }
    if (failure?.kind === 'permanent') {
      writeHistory(entry, deps);
      moveTo(dir, 'failed', base);
      result.dropped++;
      deps.log(`outbox: dropped ${base} (moved to failed/): ${failure.reason}`);
      continue;
    }
    await completeEntry(base, entry, path, filesDir, deps);
    result.delivered++;
  }
  return result;
}
