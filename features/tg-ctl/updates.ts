// Update→action step function for the tg-ctl daemon (spec §9, §10, §13).
//
// stepUpdates turns one getUpdates batch into a list of Actions plus the next
// offset. Everything here is PURE — the entrypoint executes the actions and
// owns all I/O. The wrap template function is injected via opts so this module
// never imports inject.ts (the entrypoint binds wrapInbound to the config
// template).
//
// The entrypoint durably journals the raw batch (ctx.paths.pendingBatch, atomic
// temp+rename) BEFORE persisting the offset returned here, so a crash before the
// offset is written is recovered either by Telegram's own redelivery (offset
// never advanced) or by replaying the journal on daemon startup (offset advanced,
// journal not yet cleared) — see runDaemon. stepUpdates's own per-update offset
// advance is no longer the sole loss-prevention point. Owner messages are NOT
// dropped by age (#183): if Telegram delivered the update after daemon downtime,
// it is still a real instruction and must reach the agent.

import type { Action, ControlConfig, MediaFile, StepResult, TgMessage, TgPhotoSize, TgUpdate, TopicPayload, TopicStatus } from './types';
import { parseButtonCallback, parseQuestionCloseCallback, parseDecisionReplyToken } from './questions';
import { isAgentCommand, parseAgentCallback, parseAgentCancelCallback, parseAgentCommand } from './agent-match';
import { parseTopicAttachCallback } from './topics';
import { parseNewCommand, parseNewDirCallback, parseNewHarnessCallback, parseNewModelCallback, parseNewRetryCallback, parseNewPrivateTopicFallbackCallback } from './new-command';
import { parseTasksCallback, parseTasksCommand } from './tasks-command';
import { parseContinueCallback } from './limits';
import { botCommandNames } from './bot-commands';
import { shellPassthroughGate } from './shell-danger-gate';
import { safeSliceEnd } from './text-util';
import { mediaLabel, messagePlainText } from './reply-preview';

// Bot API getFile hard limit; larger files cannot be downloaded by bots.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const TOO_LARGE_REPLY = 'file too large for Bot API (>20 MB)';

export interface StepOpts {
  cfg: ControlConfig;
  chatId: number;
  nowSec: number;
  currentOffset: number; // returned as newOffset when the batch is empty
  // Wrap an inbound message for injection. `messageId` is the inbound Telegram
  // message_id; the wrap surfaces it as `tg#<id>` so the agent can reply with
  // `tg --reply-to <id>` (threaded replies). Omitted where no id applies.
  wrap: (name: string, msg: string, messageId?: number) => string;
  // Format a reply's quote-anchor timestamp (item 3). Injected so the daemon
  // can use local time while tests stay deterministic; defaults to UTC.
  fmtTime?: (unixSec: number) => string;
  // Forum-topics mode (docs/specs/session-registry-and-topics.md §4.4). OFF by default: when
  // unset/false a topic message falls through to the normal flat handling. When on, the
  // entrypoint injects `topicStatusOf` (threadId → current binding status, or null when the topic
  // is unknown) so stepUpdates triages a topic message purely — bound → topic-route, unknown →
  // topic-hold — without owning the binding store (the entrypoint owns it, like routes).
  topicsEnabled?: boolean;
  topicStatusOf?: (threadId: number) => TopicStatus | null;
  // Flat-chat `/new` command (issue #27). The `/new` slash is ALWAYS recognized (it's a real bot
  // command, not gated by topics mode). `newSessionAwaitingDir` is injected by the entrypoint and
  // returns true while a flat `/new` is in its awaiting-dir step — so a plain text message is a
  // path ANSWER to it rather than an inject. The entrypoint owns the pending-session store (in
  // memory), like it owns routes/topics. Unset → no /new in flight → plain text injects as normal,
  // keeping 1:1 byte-identical when the feature isn't triggered.
  newSessionAwaitingDir?: () => boolean;
  // Retained post-timeout question cards are answered by replying to the card with text.
  // The entrypoint owns the retained-question store, so the pure step only asks whether
  // the replied-to Telegram message_id is one of those cards.
  postTimeoutQuestionRequestIdForMessage?: (messageId: number) => string | null;
  // Plain-text-reply-as-decision (human-requested): the entrypoint owns pendingButtons/
  // abandonedButtons, so the pure step only asks "is the replied-to message_id a LIVE-or-
  // retained PERMISSION-kind, non-multiQuestion card?" — the lookup itself does NOT check
  // retention/expiry (a stale-but-still-retained abandoned entry can still match); that
  // enforcement happens downstream at delivery time (lateDeliverAbandonedQuestion's
  // isAbandonedExpired check), the same as a real button tap on the same entry.
  // Returns its callbackRequestId (the same id `resolveButtonCallback` expects), else null.
  permissionRequestIdForMessage?: (messageId: number) => string | null;
}

// Default quote-anchor time format: deterministic UTC `YYYY-MM-DD HH:MM`.
function fmtQuoteTimeUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// First chars of the whole-message fallback body, separators collapsed, with a
// trailing ellipsis (item 3: «… начало сообщения и многоточие …»). A partial
// selection is never cut (HYP-907): Telegram already bounds it (quote_length_max).
const QUOTE_HEAD_MAX = 60;

// The quote anchor for a REPLY (items 2, 3): `↩ tg#<id> «[date time] <quote>…»`.
// The quoted content is the user's PARTIAL selection when present (item 2),
// otherwise the beginning of the replied-to message (item 3) — its text, caption or
// flattened rich_message body (tg-cli#461). Shared by text replies and voice-note
// replies so both anchor identically.
//
// `tg#<id>` is the replied-to message's OWN Telegram message_id — same
// convention as the `{id}` substitution in wrapInbound (tg-cli#28) — so an
// agent whose context has compacted/forgotten the original can still recover
// it verbatim via `tg replies --json` (grep the id) instead of relying on the
// truncated whole-message `head` preview below (tg-cli#130).
//
// tg-cli#461: the preview is never an empty `«[date] …»`. A message with no text
// quotes a media label (`«[date] [photo]»`, no ellipsis — nothing was cut); a message
// with nothing quotable at all drops the «…» part and keeps only `↩ tg#<id>`.
export function buildReplyAnchor(m: TgMessage, opts: StepOpts): string {
  const rtm = m.reply_to_message;
  const origId = rtm ? ` tg#${rtm.message_id}` : '';
  const selected = m.quote?.text?.replace(/\s+/g, ' ').trim();
  const original = !selected && rtm ? messagePlainText(rtm) : '';
  // Precedence: selection → replied-to text → media label. Both text tiers end in `…`
  // UNCONDITIONALLY (even when nothing was cut) so every text anchor has the same shape;
  // a media label carries no text to continue, so it gets none.
  // Deliberately NOT `truncateWithEllipsis` for the fallback: it cuts at the full
  // QUOTE_HEAD_MAX rather than reserving a unit for the ellipsis — a different contract
  // from the reserve-one-unit shape `truncateWithEllipsis` gives everyone else. Still
  // routed through `safeSliceEnd` so the cut itself never splits a surrogate pair.
  const head = selected
    ? `${selected}…`
    : original
      ? `${original.length > QUOTE_HEAD_MAX ? original.slice(0, safeSliceEnd(original, QUOTE_HEAD_MAX)) : original}…`
      : rtm
        ? mediaLabel(rtm)
        : '';
  if (!head) return `↩${origId}`;
  const when = rtm ? (opts.fmtTime ?? fmtQuoteTimeUtc)(rtm.date) : '';
  return `↩${origId} «[${when}] ${head}»`;
}

// Build the injected text for a REPLY (items 2, 3). The agent sees which message
// is being answered — the quote anchor — followed by the wrapped reply. The wrap
// carries THIS reply's own message_id (`tg#<id>`) so the agent can in turn thread
// its answer under the reply with `tg --reply-to <id>`.
export function buildReplyInject(m: TgMessage, name: string, opts: StepOpts): string {
  return `${buildReplyAnchor(m, opts)}\n${opts.wrap(name, m.text ?? '', m.message_id)}`;
}

// A forum topic service message (created / renamed / closed / reopened) carries no user
// instruction — it is Telegram reporting a topic-state change, recorded only (§4.4 row 5).
function forumEventOf(m: TgMessage): 'created' | 'edited' | 'closed' | 'reopened' | null {
  if (m.forum_topic_created) return 'created';
  if (m.forum_topic_edited) return 'edited';
  if (m.forum_topic_closed) return 'closed';
  if (m.forum_topic_reopened) return 'reopened';
  return null;
}

export function stepUpdates(updates: TgUpdate[], opts: StepOpts): StepResult {
  const callbackActions: Action[] = [];
  const actions: Action[] = [];
  let maxId = -1;

  // The photos/files of one album (tg-cli#280). The daemon holds an album's items until all of
  // them are in one batch (album-buffer.ts); here they become ONE delivery, stepped at — and
  // keyed by the message id of — the album's lead item (albumLead).
  const albums = new Map<string, StepItem[]>();
  for (const u of updates) {
    const m = u.message;
    if (!m || !isAlbumItem(m)) continue;
    const key = `${m.chat.id}:${m.media_group_id}`;
    albums.set(key, [...(albums.get(key) ?? []), { updateId: u.update_id, m }]);
  }

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const cb = u.callback_query;
    if (cb) {
      if (!senderAllowed(cb.from?.id, opts)) {
        callbackActions.push({ kind: 'answer-callback', callbackQueryId: cb.id, text: 'not allowed' });
        continue;
      }
      // Attach-picker taps (tgt:<thread>:<pane>) deliver a held topic queue. Appended to the
      // ordered action stream, not callbackActions: a same-batch message to that topic must join
      // the queue BEFORE the tap drains it. With topics mode off a stray tap falls through to the
      // question parser, which answers it as expired.
      const attachCb = opts.topicsEnabled ? parseTopicAttachCallback(cb.data) : null;
      if (attachCb) {
        actions.push({
          kind: 'topic-attach',
          callbackQueryId: cb.id,
          threadId: attachCb.threadId,
          paneId: attachCb.paneId,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      // Flat-chat /new taps (tnh: harness, tnm: model, tnp: recent-dir) route the new-session flow. NOT gated by
      // topics mode — /new is a flat-chat command. A stale tap whose session expired is rejected by
      // the entrypoint (no pending session → "expired"), never spawns.
      const newHarnessCb = parseNewHarnessCallback(cb.data);
      if (newHarnessCb) {
        callbackActions.push({
          kind: 'new-harness',
          callbackQueryId: cb.id,
          token: newHarnessCb.token,
          harness: newHarnessCb.harness,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const newModelCb = parseNewModelCallback(cb.data);
      if (newModelCb) {
        callbackActions.push({
          kind: 'new-model',
          callbackQueryId: cb.id,
          token: newModelCb.token,
          modelId: newModelCb.modelId,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const newDirCb = parseNewDirCallback(cb.data);
      if (newDirCb) {
        callbackActions.push({
          kind: 'new-dir',
          callbackQueryId: cb.id,
          token: newDirCb.token,
          index: newDirCb.index,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const newPrivateTopicFallbackCb = parseNewPrivateTopicFallbackCallback(cb.data);
      if (newPrivateTopicFallbackCb) {
        actions.push({
          kind: 'new-private-topic-fallback',
          callbackQueryId: cb.id,
          token: newPrivateTopicFallbackCb.token,
          choice: newPrivateTopicFallbackCb.choice,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const newRetryCb = parseNewRetryCallback(cb.data);
      if (newRetryCb) {
        callbackActions.push({
          kind: 'new-retry',
          callbackQueryId: cb.id,
          token: newRetryCb.token,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const tasksCb = parseTasksCallback(cb.data);
      if (tasksCb) {
        callbackActions.push({
          kind: 'tasks',
          agent: null,
          status: null,
          replyToMessageId: null,
          view: tasksCb.view,
          page: tasksCb.page,
          callbackKind: tasksCb.kind,
          callbackQueryId: cb.id,
          messageId: cb.message?.message_id ?? null,
          chatId: cb.message?.chat?.id ?? null,
          threadId: cb.message?.message_thread_id ?? null,
        });
        continue;
      }
      // /agent selection taps (tgac:/tga:…) are appended to the normal action
      // stream, not callbackActions: a same-batch earlier message must not be
      // consumed by a later picker tap. Question callbacks still stay
      // callback-first below so they can unblock slower same-batch message work.
      const agentCancelCb = parseAgentCancelCallback(cb.data);
      if (agentCancelCb) {
        actions.push({
          kind: 'agent-cancel',
          callbackQueryId: cb.id,
          token: agentCancelCb.token,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const agentCb = parseAgentCallback(cb.data);
      if (agentCb) {
        actions.push({
          kind: 'agent-callback',
          callbackQueryId: cb.id,
          token: agentCb.token,
          index: agentCb.index,
          from: cb.from?.first_name || cb.from?.username || 'tg',
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      // Auto-continue taps (lc:<pane>:<resetAt>) arm the reset-time injection.
      const contCb = cb.data ? parseContinueCallback(cb.data) : null;
      if (contCb) {
        callbackActions.push({
          kind: 'limit-continue',
          callbackQueryId: cb.id,
          paneId: contCb.paneId,
          resetAt: contCb.resetAt,
          sourceMessageId: contCb.sourceMessageId,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const closeQuestionCb = parseQuestionCloseCallback(cb.data);
      if (closeQuestionCb) {
        callbackActions.push({
          kind: 'close-question-card',
          callbackQueryId: cb.id,
          requestId: closeQuestionCb.requestId,
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const parsed = parseButtonCallback(cb.data);
      callbackActions.push(
        parsed
          ? {
              kind: 'answer-question',
              callbackQueryId: cb.id,
              requestId: parsed.requestId,
              value: parsed.value,
              messageId: cb.message?.message_id ?? null,
            }
          : { kind: 'answer-callback', callbackQueryId: cb.id, text: 'expired' },
      );
      continue;
    }

    const m = u.message;
    if (!m) continue; // non-message/callback update → advance silently

    // Sender allowlist FIRST (spec §9: from.id, not chat id — a group member
    // must not inject prompts).
    if (!senderAllowed(m.from?.id, opts)) continue;
    // Only the configured chat: every reply, ack and delivery-ledger key (tg-cli#299) is that
    // chat's, and Telegram message ids are unique per chat only — an allowed sender writing
    // from another chat would collide with, and be suppressed as, an earlier message here.
    if (m.chat.id !== opts.chatId) continue;

    // Owner text/media inbound is NOT dropped by age (#183): a message Telegram
    // delivered after daemon downtime or while agents were busy is still a real
    // request and must reach the agent, not vanish behind a "skipped N stale"
    // notice.
    const name = m.from?.first_name || m.from?.username || 'tg';
    // An album is stepped once, at its lead item, which goes first in `items` — the message the
    // delivery is wrapped, acked and keyed under. A video item of an album is not grouped.
    const album = isAlbumItem(m) ? albums.get(`${m.chat.id}:${m.media_group_id}`) : undefined;
    const lead = album ? albumLead(album) : undefined;
    if (lead && lead.m !== m) continue; // delivered with the album's lead item
    const items = album && lead ? [lead, ...album.filter((i) => i !== lead)] : [{ updateId: u.update_id, m }];

    // Forum-topics mode: a topic service message or ANY message inside a forum topic is
    // triaged here and the flat dispatch is skipped (§4.4). topicActionFor returns null ONLY
    // when this is not a topic message (General, or a non-forum reply-thread) → the normal
    // flat handling, unchanged. Every topic message either delivers or answers in its topic.
    if (opts.topicsEnabled) {
      const topicActions = topicActionFor(items, name, opts);
      if (topicActions) {
        actions.push(...topicActions);
        // Delivery receipt, as in the flat path: not for a service message (nothing was sent)
        // nor for a pure error reply (the reply IS the "did not land" signal).
        if (topicActions.some((a) => a.kind !== 'reply' && a.kind !== 'topic-event')) {
          actions.push({ kind: 'ack', messageId: m.message_id });
        }
        continue;
      }
    }

    let action: Action | null = null;
    if (m.text) {
      // POSITIVE gate (review #1): a flat-`/new` dir answer is an ABSOLUTE PATH — `startsWith('/')` —
      // that is NOT one of the daemon's own slash-commands, and is not a reply. Gating on the path
      // FORM (not `!isLikelySlashCommand`) fixes two inversions: (a) ordinary prose to the agent
      // (`fix the bug`) is NOT swallowed while a /new is pending — it falls through to the normal
      // inject, so a forgotten /new can't mute 1:1 routing; (b) a single-component path (`/tmp`,
      // `/srv`) IS accepted (it starts with `/` and isn't a command), where the old
      // isLikelySlashCommand test wrongly rejected it. A real /command (`/status`, a second `/new`)
      // or a reply is never consumed as the answer. Topic messages (control.topics on) are already
      // routed + `continue`d by the topics block above, so they never reach this gate. (issue #27)
      const isDirAnswerCandidate = !m.reply_to_message && m.text.startsWith('/') && !isDaemonSlashCommand(m.text);
      if (isDirAnswerCandidate && (opts.newSessionAwaitingDir?.() ?? false)) {
        action = { kind: 'new-answer', text: m.text, from: name, messageId: m.message_id };
      } else {
        // A reply carrying prose forwards the quote anchor (items 2,3) via
        // reply-route — the daemon picks the recognized origin pane or a LRU/MRU
        // picker. A reply whose text is a /command still runs the command verbatim.
        // A `!` shell-command reply ALSO routes to the origin pane via reply-route
        // (codex #192: otherwise it falls to the default/last-message pane), but
        // with the RAW `!…` as injectText and NO quote anchor — a prepended anchor
        // would knock the `!` off column 0 and defeat the harness passthrough.
        const isVerbatimText = m.text.startsWith('/') || m.text.startsWith('!');
        const isBangReply = !!m.reply_to_message && m.text.startsWith('!');
        // Gate a `!` shell-command reply the same as the flat/topic bang paths — a
        // catastrophic shape must not reach the origin pane just because it arrived
        // as a reply. Computed once here (not inside the ternary below) so both the
        // warning short-circuit and the injectText line below read the same result.
        const bangGate = isBangReply ? shellPassthroughGate(m.text) : null;
        // Bound once so every branch below narrows against the SAME reference —
        // a decoupled `m.reply_to_message!` non-null assertion (one expression
        // asserting non-null based on an entirely separate expression's truthy
        // check) is exactly the kind of coupling a future edit can silently
        // desync into a runtime TypeError (review finding).
        const reply = m.reply_to_message;
        const cardReply = cardReplyAction(m, name, opts);
        // bangGate?.warning is checked FIRST: isBangReply implies isVerbatimText, and a card
        // reply is never verbatim text, so cardReply is already null for a bang reply — this only
        // intercepts the reply-route branch a blocked bang reply would otherwise take.
        action = bangGate?.warning
          ? { kind: 'reply', text: bangGate.warning }
          : cardReply
          ? cardReply
          : reply && (!isVerbatimText || isBangReply)
            ? {
                kind: 'reply-route',
                replyToMessageId: reply.message_id,
                // A `!` reply keeps its raw text (verbatim, `!` at column 0); a
                // prose reply gets the quote anchor + wrap.
                injectText: isBangReply && bangGate ? bangGate.injectText : buildReplyInject(m, name, opts),
                from: name,
                messageId: m.message_id,
              }
            : textAction(
                m.text,
                name,
                opts,
                m.message_id,
                m.chat.id,
                reply?.message_id ?? null,
                opts.topicsEnabled && m.is_topic_message ? (m.message_thread_id ?? null) : null,
              );
      }
    } else if (m.voice ?? m.audio) action = voiceAction(u.update_id, m, name, opts);
    else if (m.photo?.length || m.document) {
      // A too-large reply (an item over 20 MB) goes out ahead of the delivery of the rest.
      const media = mediaActions(items, name, opts);
      action = media.pop() ?? null;
      actions.push(...media);
    }
    // Anything else (sticker, …) → advance silently.
    if (action) {
      actions.push(action);
      // Delivery receipt (👀 reaction) follows every action that represents
      // handling the message — but NOT a pure error reply (e.g. the too-large
      // verdict): there the reply itself is the "did not land" signal.
      if (action.kind !== 'reply') actions.push({ kind: 'ack', messageId: m.message_id });
    }
  }

  return {
    actions: [...callbackActions, ...actions],
    newOffset: updates.length ? maxId + 1 : opts.currentOffset,
    skippedStale: 0, // legacy field; owner inbound is no longer skipped by age (#183)
  };
}

// Durable local journal (tg-cli#322): the raw batch is written to
// ctx.paths.pendingBatch BEFORE the offset advances, so a crash between "told
// Telegram we have it" and "finished acting on it" is recovered by replaying
// this file on the next startup instead of being silently lost.
export function serializePendingBatch(updates: TgUpdate[]): string {
  return `${JSON.stringify(updates)}\n`;
}

export function parsePendingBatch(content: string | null): TgUpdate[] {
  if (content === null) return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as TgUpdate[]) : [];
  } catch {
    return [];
  }
}

function senderAllowed(sender: number | undefined, opts: StepOpts): boolean {
  return sender !== undefined && (sender === opts.chatId || opts.cfg.allowedSenders.includes(sender));
}

// The daemon's OWN slash-commands (the verbs textAction handles). Used to tell a `/new` dir answer
// (an absolute path) apart from a control command typed mid-flow: a `/status` while a /new awaits its
// dir is still the command, not a path. Matched on the first whitespace token (tolerating
// /cmd@botname). A path like `/tmp` or `/Users/...` is NOT in this set, so it reads as a dir answer.
//
// DERIVED from botCommandNames() — the SINGLE SOURCE OF TRUTH the ctl-bot-commands test pins to the
// set of verbs textAction actually dispatches (review #1: a hand-kept parallel list would silently
// drift, mis-routing a newly-handled command into the agent as a passthrough mid-/new). A new daemon
// command added to BOT_COMMANDS therefore lands here automatically.
const DAEMON_SLASH_COMMANDS = new Set(botCommandNames().map((c) => `/${c}`));
function isDaemonSlashCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const verb = text.split(/\s+/, 1)[0].replace(/@\w+$/, '');
  return DAEMON_SLASH_COMMANDS.has(verb);
}

// Command-vs-prompt split (spec §13). Verbs match on the first whitespace
// token; unknown slash commands pass through VERBATIM so the harness
// interprets its own (/compact, /clear, …) — no wrap on those.
function textAction(
  text: string,
  name: string,
  opts: StepOpts,
  messageId: number,
  chatId: number,
  replyToMessageId: number | null,
  threadId: number | null = null,
): Action {
  // `!` passthrough (harness `!` convention): a message STARTING with `!` reaches
  // the harness VERBATIM — no `[TG from …]` wrap — so it runs the rest as an
  // in-session shell command. The harness only honours a `!` at column 0, so the
  // text must be injected raw (no wrap, no reply quote-anchor). Owner-gated by
  // `senderAllowed` upstream — a non-owner never reaches here. A catastrophic
  // shape (`!rm -rf /`, `!git push --force`, …) is intercepted by
  // shellPassthroughGate BEFORE injection — the sender must resend it with a
  // doubled `!!` to confirm and run it anyway (tg-cli shell-danger-gate).
  if (text.startsWith('!')) {
    const shellGate = shellPassthroughGate(text);
    if (shellGate.warning) return { kind: 'reply', text: shellGate.warning, threadId };
    return { kind: 'inject-text', text: shellGate.injectText, messageId };
  }
  if (text.startsWith('/')) {
    const verb = text.split(/\s+/, 1)[0];
    const cmd = verb.replace(/@\w+$/, ''); // tolerate /cmd@botname in groups
    const topic = typeof threadId === 'number' ? { threadId } : {};
    if (cmd === '/stop') return { kind: 'inject-key', key: 'Escape' };
    if (cmd === '/kill') return { kind: 'kill-agent' };
    if (cmd === '/status') return { kind: 'status', ...topic };
    if (cmd === '/limit') {
      const rest = text.slice(verb.length).trim();
      return { kind: 'limit-status', agent: rest || null, ...topic };
    }
    if (cmd === '/tasks') {
      const p = parseTasksCommand(text);
      return { kind: 'tasks', agent: p.agent, status: p.status, replyToMessageId, threadId };
    }
    if (cmd === '/daily') return { kind: 'daily-report', ...topic };
    if (cmd === '/spend') {
      const rest = text.slice(verb.length).trim().toLowerCase();
      const period = rest === 'day' || rest === 'week' || rest === 'month' ? rest : null;
      return { kind: 'usage-report', period, ...topic };
    }
    if (cmd === '/agent') {
      const p = parseAgentCommand(text);
      return { kind: 'agent-route', selector: p.selector, rest: p.rest, all: p.all, from: name, messageId, ...topic };
    }
    if (cmd === '/new') {
      const p = parseNewCommand(text);
      return { kind: 'new-command', harness: p.harness, model: p.model, dir: p.dir, name: p.name, task: p.task, dirAfterName: p.dirAfterName, from: name, messageId, chatId, ...topic };
    }
    return { kind: 'inject-text', text, messageId };
  }
  // A plain inbound message: surface its message_id in the wrap so the agent can
  // thread its answer with `tg --reply-to <id>` (threaded replies).
  return { kind: 'inject-text', text: opts.wrap(name, text, messageId), messageId };
}

// A harness/daemon slash-command (`/compact`, `/stop now`) vs a path-or-prose message that
// merely starts with `/` (`/etc/hosts is broken`). A command is `/` + a letter + word chars,
// optionally Telegram's group-chat `@botname` suffix, then a space or end — so a SECOND slash
// (a path) or a leading non-letter is NOT a command.
export function isLikelySlashCommand(text: string): boolean {
  return /^\/[a-zA-Z][\w-]*(@\w+)?(\s|$)/.test(text);
}

// A plain TEXT reply to a card the daemon posted — a permission/hatch card ("yes"/"no" and kin)
// or an abandoned question card (any prose is its deferred answer) — answers that card instead of
// reaching the agent as chat. A /command or !shell reply never does. `threadId`: the forum topic
// the reply was written in, so the answer's notices stay there. null for any other message.
function cardReplyAction(m: TgMessage, name: string, opts: StepOpts, threadId?: number): Extract<Action, { kind: 'answer-question' | 'post-timeout-question-reply' }> | null {
  const reply = m.reply_to_message;
  const text = m.text;
  if (!reply || !text || text.startsWith('/') || text.startsWith('!')) return null;
  const thread = threadId !== undefined ? { threadId } : {};
  const decisionToken = parseDecisionReplyToken(text);
  const decisionRequestId = decisionToken ? (opts.permissionRequestIdForMessage?.(reply.message_id) ?? null) : null;
  if (decisionRequestId && decisionToken) {
    return { kind: 'answer-question', callbackQueryId: '', requestId: decisionRequestId, value: decisionToken, messageId: reply.message_id, ...thread };
  }
  const postTimeoutRequestId = opts.postTimeoutQuestionRequestIdForMessage?.(reply.message_id) ?? null;
  if (postTimeoutRequestId) {
    return { kind: 'post-timeout-question-reply', requestId: postTimeoutRequestId, questionMessageId: reply.message_id, text, from: name, messageId: m.message_id, ...thread };
  }
  return null;
}

// Daemon verbs answered in ANY forum topic, bound or not (§4.4 row 1). `/stop` and `/kill` are
// deliberately absent: in a bound topic they reach that topic's session, and in an unknown topic
// they are held like any other message.
const TOPIC_GLOBAL_CMDS = new Set(['/status', '/agent', '/new', '/tasks', '/limit', '/daily', '/spend']);

// Inbound topic triage (docs/specs/session-registry-and-topics.md §4.4). Returns the actions for
// a topic service message or a message inside a forum topic, else null ("not a topic message":
// General, or a non-forum supergroup reply-thread) so the flat handling runs unchanged. PURE:
// the bound/unknown decision uses the injected `topicStatusOf`; whether a bound session is still
// alive is I/O, so the entrypoint answers "not running" for a gone one. No branch returns an
// empty list for a user message: each delivers, holds, or replies in the topic.
function topicActionFor(items: StepItem[], name: string, opts: StepOpts): Action[] | null {
  const m = items[0].m;
  const event = forumEventOf(m);
  if (event) {
    // The service message's thread id IS the topic id (its own message_id as a fallback).
    const threadId = m.message_thread_id ?? m.message_id;
    const topicName = m.forum_topic_created?.name ?? m.forum_topic_edited?.name;
    return [{ kind: 'topic-event', threadId, event, ...(topicName ? { name: topicName } : {}) }];
  }
  const threadId = m.message_thread_id;
  // A non-forum supergroup reply-thread also carries message_thread_id; only a real forum topic
  // message sets is_topic_message.
  if (threadId === undefined || !m.is_topic_message) return null;
  const text = m.text ?? '';
  const verb = text.split(/\s+/, 1)[0].replace(/@\w+$/, '');
  if (TOPIC_GLOBAL_CMDS.has(verb)) {
    return [textAction(text, name, opts, m.message_id, m.chat.id, m.reply_to_message?.message_id ?? null, threadId)];
  }
  // A text reply to a question/permission/hatch card answers the card — the cards are posted into
  // the session's topic, so the answer arrives here (tg-cli#551).
  const cardReply = cardReplyAction(m, name, opts, threadId);
  if (cardReply) return [cardReply];
  const payload = topicPayloadOf(items, name, opts);
  if (typeof payload === 'string') return [{ kind: 'reply', text: payload, threadId }];
  // An album item too large to download is left out of the payload; the CTO is told, the rest still go.
  const tooLarge: Action[] = payload.type === 'media' && payload.files.length < items.length ? [{ kind: 'reply', text: TOO_LARGE_REPLY, threadId }] : [];
  return (opts.topicStatusOf?.(threadId) ?? null) === null
    ? [...tooLarge, { kind: 'topic-hold', threadId, payload }]
    : [...tooLarge, { kind: 'topic-route', threadId, payload }];
}

// The deliverable form of a topic message, or the reply text when it cannot be delivered.
function topicPayloadOf(items: StepItem[], name: string, opts: StepOpts): TopicPayload | string {
  const { updateId, m } = items[0];
  const messageId = m.message_id;
  if (m.text) {
    const text = m.text;
    // A `!shell` passthrough is VERBATIM (harness `!` convention): no wrap and no quote-anchor,
    // so the `!` stays at column 0 — same rule as the flat path. Checked before the reply-anchor
    // branch so a `!` reply is verbatim too. A catastrophic shape is answered instead.
    if (text.startsWith('!')) {
      const shellGate = shellPassthroughGate(text);
      return shellGate.warning ?? { type: 'text', text: shellGate.injectText, from: name, messageId };
    }
    // A prose reply carries the same ↩ «…» quote-anchor as a flat-chat reply; a /command reply
    // stays verbatim.
    if (m.reply_to_message && !text.startsWith('/')) {
      return { type: 'text', text: buildReplyInject(m, name, opts), from: name, messageId };
    }
    // The command test is narrow (`/word` …, no second slash) so a path-like message —
    // `/etc/hosts is broken` — is prose and gets wrapped, not injected as a command. A
    // group-chat `@botname` suffix is Telegram's addressing, not part of the harness verb:
    // `/compact@my_bot` reaches the harness as `/compact` (#298).
    if (isLikelySlashCommand(text)) return { type: 'text', text: text.replace(/^(\/[a-zA-Z][\w-]*)@\w+/, '$1'), from: name, messageId };
    return { type: 'text', text: opts.wrap(name, text, messageId), from: name, messageId };
  }
  const anchor = m.reply_to_message ? { anchor: buildReplyAnchor(m, opts) } : {};
  const voice = m.voice ?? m.audio;
  if (voice) {
    if ((voice.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return TOO_LARGE_REPLY;
    return { type: 'voice', fileId: voice.file_id, suggestedName: `${updateId}.ogg`, ...anchor, from: name, messageId };
  }
  if (m.photo?.length || m.document) {
    const media = mediaOf(items, opts);
    if (media.files.length === 0) return TOO_LARGE_REPLY;
    return {
      type: 'media',
      files: media.files,
      ...(media.caption ? { caption: media.caption } : {}),
      ...(media.replyAnchor ? { anchor: media.replyAnchor } : {}),
      from: name,
      messageId,
    };
  }
  return UNSUPPORTED_TOPIC_MESSAGE_REPLY;
}

const UNSUPPORTED_TOPIC_MESSAGE_REPLY = 'not delivered — a session only receives text, voice, photos and files';

// Telegram sends several renditions; take the largest by file_size. Ties and missing sizes
// resolve to the LATER entry — the array is size-ascending.
function largestPhoto(photos: TgPhotoSize[]): TgPhotoSize {
  let best = photos[0];
  for (const p of photos) {
    if ((p.file_size ?? 0) >= (best.file_size ?? 0)) best = p;
  }
  return best;
}

// One message to step, with its update id (the downloaded file is named after it). An album
// is stepped as the list of its items, first item first.
interface StepItem {
  updateId: number;
  m: TgMessage;
}

// The download list of a photo/document message or of a whole album (tg-cli#280): the
// largest rendition of each photo, every document, under a daemon-chosen name. An item over
// the Bot API limit is left out (`tooLarge`). The album's captions are kept in item order;
// the first item that is a reply gives the quote anchor.
function mediaOf(items: StepItem[], opts: StepOpts): { files: MediaFile[]; tooLarge: boolean; caption?: string; replyTo?: number; replyAnchor?: string } {
  const ordered = [...items].sort((a, b) => a.m.message_id - b.m.message_id);
  const files: MediaFile[] = [];
  let tooLarge = false;
  for (const { updateId, m } of ordered) {
    const isPhoto = !!m.photo?.length;
    const file = isPhoto ? largestPhoto(m.photo!) : m.document;
    if (!file) continue;
    if (!downloadable(m)) {
      tooLarge = true;
      continue;
    }
    files.push({
      fileId: file.file_id,
      suggestedName: `${updateId}.${isPhoto ? 'jpg' : sanitizedExt(m.document?.file_name)}`,
      mediaKind: isPhoto ? 'photo' : 'document',
      ...(file.file_size !== undefined ? { fileSize: file.file_size } : {}),
    });
  }
  const caption = ordered.flatMap(({ m }) => (m.caption ? [m.caption] : [])).join('\n');
  const replying = ordered.find(({ m }) => m.reply_to_message)?.m;
  return {
    files,
    tooLarge,
    ...(caption ? { caption } : {}),
    ...(replying?.reply_to_message ? { replyTo: replying.reply_to_message.message_id, replyAnchor: buildReplyAnchor(replying, opts) } : {}),
  };
}

// An item of an album (tg-cli#280): a photo or document carrying a media_group_id. A video or
// audio item keeps its own handling (videos are not delivered; audio is transcribed note by
// note). THE predicate both the daemon's album hold (album-buffer.ts) and stepUpdates' grouping
// use — an item one holds and the other does not group would be dropped or split.
export function isAlbumItem(m: TgMessage): m is TgMessage & { media_group_id: string } {
  return !!m.media_group_id && !!(m.photo?.length || m.document);
}

// Whether a photo/document is within the Bot API download limit.
function downloadable(m: TgMessage): boolean {
  const file = m.photo?.length ? largestPhoto(m.photo) : m.document;
  return !!file && (file.file_size ?? 0) <= MAX_DOWNLOAD_BYTES;
}

// The album's lead item: its first downloadable item (else its first item). The album is
// stepped, acked and wrapped under the lead's message id, and the delivery ledger keys the
// album on it — an item over 20 MB is never delivered, so it never carries the delivery.
function albumLead(items: StepItem[]): StepItem {
  const ordered = [...items].sort((a, b) => a.m.message_id - b.m.message_id);
  return ordered.find((i) => downloadable(i.m)) ?? ordered[0];
}

// The message ids the delivery of an album covers, its lead first, for the ledger's `album`
// event: every downloadable item. An item over 20 MB is answered "too large", not delivered.
export function albumDeliveryIds(album: TgMessage[]): number[] {
  return album
    .filter(downloadable)
    .map((m) => m.message_id)
    .sort((a, b) => a - b);
}

// A photo/document — or a whole album, as ONE delivery keyed by its lead item (items[0]) —
// becomes a download-media action. A caption starting with `/agent` routes it by that selector instead of
// the replied-to origin; otherwise a reply carries the quote anchor for reply-routing after the
// download. An item over 20 MB gets the too-large reply (before the delivery of the rest).
function mediaActions(items: StepItem[], name: string, opts: StepOpts): Action[] {
  const media = mediaOf(items, opts);
  const tooLarge: Action[] = media.tooLarge ? [{ kind: 'reply', text: TOO_LARGE_REPLY }] : [];
  if (media.files.length === 0) return tooLarge;
  const action: Extract<Action, { kind: 'download-media' }> = {
    kind: 'download-media',
    files: media.files,
    ...(media.caption ? { caption: media.caption } : {}),
    from: name,
    messageId: items[0].m.message_id,
  };
  if (media.caption && isAgentCommand(media.caption)) action.agentRoute = parseAgentCommand(media.caption);
  else if (media.replyTo !== undefined) {
    action.replyToMessageId = media.replyTo;
    action.replyAnchor = media.replyAnchor;
  }
  return [...tooLarge, action];
}

// A voice/audio note → transcribe-voice. The OGG is downloaded under a
// daemon-chosen name (<update_id>.ogg — never the remote basename, spec §5.2),
// then the entrypoint transcodes + transcribes + routes. A note that is itself a
// reply carries the same quote anchor a typed reply would (items 2,3) so the
// transcript routes to the replied-to origin pane. Over-20MB notes can't be
// fetched by a bot → too-large reply, same as photo/document.
function voiceAction(updateId: number, m: TgMessage, name: string, opts: StepOpts): Action {
  const v = (m.voice ?? m.audio)!;
  if ((v.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: 'reply', text: TOO_LARGE_REPLY };
  const action: Extract<Action, { kind: 'transcribe-voice' }> = {
    kind: 'transcribe-voice',
    fileId: v.file_id,
    suggestedName: `${updateId}.ogg`,
    fileSize: v.file_size,
    from: name,
    messageId: m.message_id,
  };
  if (m.reply_to_message) {
    action.replyToMessageId = m.reply_to_message.message_id;
    action.replyAnchor = buildReplyAnchor(m, opts);
  }
  return action;
}

// The saved filename is ALWAYS daemon-chosen — <update_id>.<ext> — and only
// the extension survives from the Telegram-supplied name, sanitized (spec
// §5.2: never trust the remote basename). Anything longer than 10 chars after
// sanitization is not a real extension; fall back to bin.
function sanitizedExt(fileName: string | undefined): string {
  const dot = fileName ? fileName.lastIndexOf('.') : -1;
  if (!fileName || dot === -1) return 'bin';
  const ext = fileName
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ext && ext.length <= 10 ? ext : 'bin';
}
