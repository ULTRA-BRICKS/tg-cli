// --- Telegram Bot API transport ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 2, docs/specs/
// tg-decomposition.md). The main()-side closures captured the bot endpoint
// (API) + chat id (CHAT_ID) and the route recorder; here they arrive via
// createTelegramTransport(ctx). main() keeps recordRoute — it owns the daemon
// ROUTES_PATH / TMUX_PANE bookkeeping — and injects it. The returned object is
// exactly the transmitter's Transport (sendMessage/sendPhoto/sendDocument/
// sendMediaGroup); the transmitter drives caption-overflow, the >4096 split and
// the photos→text→documents ordering on top of it.
import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { BOM_MAX_BYTES, maybeAddBom } from '../auto-attach/encoding';
import { type Transport } from '../auto-attach/transmitter';
import { type SendItem } from '../auto-attach/types';
import { type EmojiEntity } from '../branding/emoji';
import { type Format } from '../cli/args';
import { convertEntitiesToHtml, parseModeFor } from '../render/html';
import { normalizeRichHtml, validateRichHtml } from '../render/rich';

export interface TelegramCtx {
  // Bot endpoint base, e.g. `https://api.telegram.org/bot<token>`.
  api: string;
  // Target chat id.
  chatId: string;
  // Best-effort route bookkeeping: main owns the daemon ROUTES_PATH/TMUX_PANE
  // state and injects this recorder. Called once per returned message id so a
  // reply to any sent message routes back to this pane. `threadId` is the topic the message
  // landed in (null = General), so its history row can answer a later `--reply-to` (tg-cli#551).
  recordRoute: (messageId: number, threadId: number | null) => void;
  // Threaded reply target (`--reply-to <message_id>`). When set, the FIRST
  // outbound sendMessage carries reply_to_message_id so it threads UNDER that
  // inbound Telegram message. Only the first message is threaded — a >4096
  // split's continuation chunks must not each re-reply to the same anchor.
  replyToMessageId?: number;
  // Forum-topic target (`--topic <id>` / `TG_TOPIC`). When set, EVERY outbound
  // send carries message_thread_id so the message threads into that topic
  // instead of General (docs/specs/tg-forum-topics.md §8). Unlike
  // replyToMessageId this is NOT consumed after the first message: every send in
  // a topic — including >4096 split continuations and album items — must carry
  // the SAME thread id, or the continuation lands in General.
  messageThreadId?: number;
  // Is the thread id ADVISORY (TG_TOPIC env, or the topic the daemon resolved for
  // this session — not an explicit --topic flag)? An agent's shell can inherit a
  // stale/closed/foreign TG_TOPIC and a private-chat topic can reject writes, and a
  // daily-critical send must NOT hard-fail because of an ambient default: when this
  // is true and Telegram rejects a send specifically because of the thread id
  // (topic closed/not found, or the chat isn't a forum), the send is resent ONCE
  // without message_thread_id (it lands in General) instead of exiting. An EXPLICIT
  // --topic stays strict — the agent asked for that topic, so a failure is a real
  // error worth surfacing.
  threadIdAdvisory?: boolean;
  // Advisory only: retry the topic once after this delay before falling back to
  // General (a freshly created private-chat topic rejects bot writes for a moment,
  // telegram-bot-api #905).
  threadRetryDelayMs?: number;
  // Advisory only: called once, with Telegram's description, when a send fell back
  // to General; the rest of the send then skips the topic.
  onThreadFallback?: (description: string) => void | Promise<void>;
}

// Read a send response and return its error `description` when the send FAILED —
// covering both shapes the Bot API uses: an HTTP non-2xx (description carried in
// the text/JSON body) and a 200 with `{ ok:false, description }`. Returns null
// when the send succeeded (so the caller does NOT treat a success as an error).
// Best-effort: an unparseable body yields the raw text (still matchable) or '',
// never a throw — the caller falls back to the strict checkResponse path on null.
export async function readErrorDescription(resp: Response): Promise<string | null> {
  const text = await resp.text().catch(() => '');
  let parsed: { ok?: boolean; description?: string } | null = null;
  try {
    parsed = JSON.parse(text) as { ok?: boolean; description?: string };
  } catch {
    parsed = null;
  }
  if (parsed && parsed.ok === false) return parsed.description ?? '';
  if (parsed && parsed.ok === true) return null; // a real success
  if (!resp.ok) return parsed?.description ?? text; // HTTP error, non-JSON or no description
  return null; // 2xx with no parseable {ok:false} → treat as success
}

// Telegram error descriptions that mean "the send was rejected because of the
// message_thread_id" — a closed/deleted topic, a thread id that doesn't exist,
// or a non-forum chat. Matched case-insensitively against the API's `description`
// so an ADVISORY (env-sourced) thread id can be dropped and the send retried to
// General rather than killing a daily-critical send. Deliberately narrow: only
// thread-specific rejections fall back; any other error still fails loud.
export function isThreadRejection(description: string | undefined): boolean {
  if (!description) return false;
  const d = description.toLowerCase();
  return (
    d.includes('message thread not found') ||
    d.includes('topic_closed') ||
    d.includes('topic closed') ||
    d.includes('thread not found') ||
    (d.includes('forum') && d.includes('disabled')) ||
    d.includes('chat is not a forum') ||
    d.includes('message_thread_id')
  );
}

// Telegram's answer for a topic that no longer exists — unlike `message thread not found`,
// which a fresh private-chat topic also returns transiently (§4.5). Also a thread
// rejection for the advisory fallback, but never worth the retry.
export function isTopicDeletedError(description: string): boolean {
  const d = description.toLowerCase();
  return d.includes('topic_id_invalid') || d.includes('topic_deleted');
}

// Exit-on-error response check, shared by every send. A non-2xx response or an
// { ok:false } body prints to stderr and exits 1; otherwise the `result`
// payload is returned (a Message or an array of Messages).
export async function checkResponse(resp: Response, method: string): Promise<unknown> {
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Telegram API error (${method}): ${resp.status} ${body}`);
    process.exit(1);
  }
  const json = (await resp.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) {
    console.error(`Telegram API error (${method}): ${json.description ?? 'unknown error'}`);
    process.exit(1);
  }
  return json.result;
}

// Read a file into memory ONLY when it is at most `maxBytes`, using a single
// file descriptor for the size check and the read. Opening once and calling
// fstat + read on that SAME fd closes the check-then-read race (js/file-system-
// race): a path-based statSync()+readFileSync() pair can observe two different
// inodes if the path is swapped in between, whereas an fd is pinned to the inode
// it opened. Returns the bytes, or null when the file is unreadable, empty, or
// larger than the cap (the caller then streams it via Bun.file unchanged).
export function readSmallFile(path: string, maxBytes: number): Uint8Array | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0 || size > maxBytes) return null;
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break; // file shrank under us mid-read
      read += n;
    }
    // A short read means the file changed beneath us; bail to null so the caller
    // streams the file via Bun.file unchanged rather than stitching a BOM onto a
    // truncated body (which would defeat the very encoding fix this serves).
    if (read !== size) return null;
    // Guard the other direction too: if the file GREW after the initial fstat we
    // would have read only a prefix while still satisfying read === size. Re-stat
    // the same fd and reject a size change so we never BOM a partial body.
    if (fstatSync(fd).size !== size) return null;
    return new Uint8Array(buf.subarray(0, read));
  } catch {
    return null; // unreadable here → let Bun.file surface the real error downstream
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed / invalid fd — nothing to do
      }
    }
  }
}

// Upload bytes for an item. Text DOCUMENTS with non-ASCII UTF-8 content get
// a BOM prepended to the uploaded copy (features/auto-attach/encoding.ts) so
// Telegram's preview stops guessing legacy codepages for Cyrillic; the file
// on disk is never modified. Photos and big/binary files stream unchanged.
function blobFor(item: SendItem): { body: Blob | ReturnType<typeof Bun.file>; name?: string } {
  if (item.source.kind === 'memory') {
    const bytes = new TextEncoder().encode(item.source.content);
    const processed = item.type === 'document' ? maybeAddBom(bytes, item.source.filename) : bytes;
    return { body: new Blob([processed]), name: item.source.filename };
  }
  if (item.type === 'document') {
    const bytes = readSmallFile(item.source.path, BOM_MAX_BYTES);
    if (bytes && bytes.length > 0) {
      const processed = maybeAddBom(bytes, item.source.path);
      if (processed !== bytes) {
        const name = item.source.path.slice(item.source.path.lastIndexOf('/') + 1);
        return { body: new Blob([processed]), name };
      }
    }
  }
  return { body: Bun.file(item.source.path) };
}

// Build the transmitter's Transport bound to a bot endpoint + chat + route
// recorder. All four send primitives funnel their result through
// recordRouteFromResult so a reply to any sent message (including each item of
// a media group) routes back to the producing pane.
export function createTelegramTransport(ctx: TelegramCtx): Transport {
  const { api, chatId, recordRoute, replyToMessageId, messageThreadId, threadIdAdvisory, threadRetryDelayMs, onThreadFallback } = ctx;
  // A reply threads under ONE anchor: consume the target on the first
  // sendMessage so split-continuation chunks (and any later sends) do not each
  // re-reply to the same inbound message.
  let pendingReplyTo = replyToMessageId;
  // Set once an advisory thread fell back to General: the remaining parts of this
  // send (split chunks, attachments) go straight to General instead of each paying
  // for another rejected attempt and retry delay.
  let threadDropped = false;

  // How one send body is built. `thread`: stamp message_thread_id. `anchor`: keep the
  // reply anchor. The forum-topic thread id rides EVERY send (NOT consumed like the
  // reply anchor): a >4096 split or an album must keep all parts in the same topic.
  // With no topic set nothing is stamped, so a non-topic send stays byte-identical to
  // before (the daily-critical 1:1 path).
  type BuildBody = (opts: { thread: boolean; anchor: boolean }) => Record<string, unknown> | FormData;

  const post = (method: string, body: Record<string, unknown> | FormData): Promise<Response> =>
    fetch(
      `${api}/${method}`,
      body instanceof FormData
        ? { method: 'POST', body }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );

  // Is this response a rejection BECAUSE of the thread id? Peeked on a CLONE so
  // checkResponse can still read the original. A thread rejection arrives EITHER as
  // HTTP 400 (the common Telegram shape) OR as a 200 with { ok:false } (some proxies).
  const threadRejection = async (resp: Response): Promise<string | null> => {
    const description = await readErrorDescription(resp.clone());
    return description !== null && (isThreadRejection(description) || isTopicDeletedError(description)) ? description : null;
  };

  // POST a send and validate the response, with the advisory-thread fallback: when
  // the thread id is ADVISORY (TG_TOPIC env, or the daemon's session lookup) and
  // Telegram rejects this send specifically because of the thread id (a stale /
  // closed / foreign topic, or a non-forum chat), the send lands in General instead
  // of killing a daily-critical send. With `threadRetryDelayMs` it first retries the
  // topic once after that delay (fresh private-chat topics reject bot writes for a
  // moment, telegram-bot-api #905). Every other failure path is unchanged —
  // checkResponse still exits on a real error, and an explicit --topic
  // (threadIdAdvisory false) stays strict.
  const send = async (method: string, build: BuildBody): Promise<unknown> => {
    const threaded = messageThreadId !== undefined && !threadDropped;
    let resp = await post(method, build({ thread: threaded, anchor: true }));
    if (!threaded || !threadIdAdvisory) return checkResponse(resp, method);
    let description = await threadRejection(resp);
    if (description === null) return checkResponse(resp, method);
    if (threadRetryDelayMs !== undefined && !isTopicDeletedError(description)) {
      await Bun.sleep(threadRetryDelayMs);
      resp = await post(method, build({ thread: true, anchor: true }));
      description = await threadRejection(resp);
      if (description === null) return checkResponse(resp, method);
    }
    threadDropped = true;
    // Sanitize the server-supplied description before logging (strip control chars /
    // cap length), so a crafted API description can't inject into the local terminal.
    const safe = description.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
    console.error(`tg: topic ${messageThreadId} was rejected (${safe}) — resending to General`);
    await onThreadFallback?.(description);
    // Drop BOTH the thread id AND the reply anchor for the General resend: an anchor
    // pointing at a message INSIDE the rejected topic would otherwise make Telegram
    // re-bind the resend to that topic's thread (un-doing the fallback) or fail again
    // on a deleted/closed anchor (message to reply not found).
    return checkResponse(await post(method, build({ thread: false, anchor: false })), method);
  };

  // The multipart upload body shared by photo/document/album sends.
  const form = (thread: boolean, fields: (f: FormData) => void): FormData => {
    const f = new FormData();
    f.append('chat_id', chatId);
    if (thread && messageThreadId !== undefined) f.append('message_thread_id', String(messageThreadId));
    fields(f);
    return f;
  };

  // A Bot API send `result` is a Message (text/photo/document) or an array of
  // Messages (sendMediaGroup) — record a route for every message id so a reply
  // to ANY of them (including a media report) routes to this pane.
  const recordRouteFromResult = (result: unknown): void => {
    if (Array.isArray(result)) {
      for (const m of result) recordRouteFromResult(m);
      return;
    }
    if (result && typeof result === 'object' && typeof (result as { message_id?: unknown }).message_id === 'number') {
      // The thread THIS message landed in: a later chunk's fallback must not relabel earlier ones.
      recordRoute((result as { message_id: number }).message_id, !threadDropped && messageThreadId !== undefined ? messageThreadId : null);
    }
  };

  const sendMessage = async (text: string, formatValue: Format, entities: EmojiEntity[]): Promise<void> => {
    const parseMode = parseModeFor(formatValue);
    let outText = text;
    if (parseMode && entities.length > 0) {
      outText = convertEntitiesToHtml(text, entities);
    }
    // Thread the FIRST message under the reply target, then clear it so
    // continuation chunks aren't all re-replied to the same anchor.
    const replyTo = pendingReplyTo;
    pendingReplyTo = undefined;
    const build: BuildBody = ({ thread, anchor }) => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: outText,
      };
      if (parseMode) {
        body.parse_mode = parseMode;
      } else if (entities.length > 0) {
        body.entities = entities;
      }
      if (thread) body.message_thread_id = messageThreadId;
      if (anchor && replyTo !== undefined) body.reply_to_message_id = replyTo;
      return body;
    };
    recordRouteFromResult(await send('sendMessage', build));
  };

  // Rich message send (Bot API sendRichMessage). The HTML body is passed as
  // `rich_message.html` (NOT a parse_mode) — exactly one of html/markdown is
  // allowed. The body is first normalized (basic-only `<span class="tg-spoiler">`
  // → the rich `<tg-spoiler>` the rich parser accepts) and pre-flighted against
  // the documented limits locally, so a bad body fails with a clear message
  // instead of an opaque API 400. Threading uses `reply_parameters`
  // (sendRichMessage has no reply_to_message_id field); the first send consumes
  // the anchor, same as sendMessage.
  const sendRich = async (rawHtml: string): Promise<void> => {
    const html = normalizeRichHtml(rawHtml);
    const check = validateRichHtml(html);
    if (!check.ok) {
      console.error(`tg: ${check.error}`);
      process.exit(1);
    }
    const replyTo = pendingReplyTo;
    pendingReplyTo = undefined;
    const build: BuildBody = ({ thread, anchor }) => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        rich_message: { html },
      };
      if (thread) body.message_thread_id = messageThreadId;
      if (anchor && replyTo !== undefined) body.reply_parameters = { message_id: replyTo };
      return body;
    };
    recordRouteFromResult(await send('sendRichMessage', build));
  };

  return {
    sendMessage: (text, fmt) => sendMessage(text, fmt, []),
    sendRich,
    sendPhoto: async (item, cap, fmt) => {
      const parseMode = parseModeFor(fmt);
      const build: BuildBody = ({ thread }) =>
        form(thread, (f) => {
          const { body, name } = blobFor(item);
          if (name) f.append('photo', body, name);
          else f.append('photo', body);
          if (cap) f.append('caption', cap);
          if (parseMode) f.append('parse_mode', parseMode);
        });
      recordRouteFromResult(await send('sendPhoto', build));
    },
    sendDocument: async (item, cap, fmt) => {
      const parseMode = parseModeFor(fmt);
      const build: BuildBody = ({ thread }) =>
        form(thread, (f) => {
          const { body, name } = blobFor(item);
          if (name) f.append('document', body, name);
          else f.append('document', body);
          if (cap) f.append('caption', cap);
          if (parseMode) f.append('parse_mode', parseMode);
        });
      recordRouteFromResult(await send('sendDocument', build));
    },
    // Album send (FIX 2): 2..10 same-type items as a single Telegram media
    // group. Each item is uploaded as a multipart field and referenced from the
    // `media` JSON via `attach://<field>`. The caption (if any) rides the FIRST
    // InputMedia item — Telegram shows it as the album caption.
    sendMediaGroup: async (kind, mediaItems, cap, fmt) => {
      const parseMode = parseModeFor(fmt);
      const build: BuildBody = ({ thread }) =>
        form(thread, (f) => {
          const media = mediaItems.map((item, i) => {
            const { body, name } = blobFor(item);
            const field = `file${i}`;
            // A memory item needs an explicit filename so Telegram keeps the ext;
            // a disk item is uploaded under a stable field name (its own name is
            // carried by Bun.file). attach:// binds the JSON entry to the field.
            if (name) f.append(field, body, name);
            else f.append(field, body);
            const entry: Record<string, string> = { type: kind, media: `attach://${field}` };
            if (i === 0 && cap) {
              entry.caption = cap;
              if (parseMode) entry.parse_mode = parseMode;
            }
            return entry;
          });
          f.append('media', JSON.stringify(media));
        });
      recordRouteFromResult(await send('sendMediaGroup', build));
    },
  };
}
