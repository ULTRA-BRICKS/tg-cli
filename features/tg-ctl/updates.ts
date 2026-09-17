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

import type { Action, ControlConfig, StepResult, TgMessage, TgUpdate, TopicStatus } from './types';
import { parseButtonCallback, parseQuestionCloseCallback, parseDecisionReplyToken } from './questions';
import { isAgentCommand, parseAgentCallback, parseAgentCancelCallback, parseAgentCommand } from './agent-match';
import { parseTopicModelCallback, parseTopicPathCallback, parseTopicRespawnCallback } from './topics';
import { parseNewCommand, parseNewDirCallback, parseNewHarnessCallback, parseNewModelCallback, parseNewRetryCallback, parseNewPrivateTopicFallbackCallback } from './new-command';
import { parseTasksCallback, parseTasksCommand } from './tasks-command';
import { parseContinueCallback } from './limits';
import { botCommandNames } from './bot-commands';

// Bot API getFile hard limit; larger files cannot be downloaded by bots.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const TOO_LARGE_REPLY = 'file too large for Bot API (>20 MB)';

export interface StepOpts {
  cfg: ControlConfig;
  chatId: number;
  nowSec: number;
  currentOffset: number; // returned as newOffset when the batch is empty
  // Wrap an inbound message for injection. `messageId` is the inbound Telegram
  // message_id; the wrap surfaces it as `#<id>` so the agent can reply with
  // `tg --reply-to <id>` (threaded replies). Omitted where no id applies.
  wrap: (name: string, msg: string, messageId?: number) => string;
  // Format a reply's quote-anchor timestamp (item 3). Injected so the daemon
  // can use local time while tests stay deterministic; defaults to UTC.
  fmtTime?: (unixSec: number) => string;
  // Forum-topics mode (docs/specs/tg-forum-topics.md). OFF by default: when unset/false a
  // topic message falls through to the normal flat handling (behaviour unchanged). When on,
  // the entrypoint injects `topicStatusOf` (threadId → current binding status, or null when
  // untracked) so stepUpdates can route a topic message purely — bound → inject, awaiting →
  // /new answer — without owning the binding store (the entrypoint owns it, like routes).
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

// First chars of the quote-anchor body, separators collapsed, with a trailing
// ellipsis (item 3: «… начало сообщения и многоточие …»).
const QUOTE_HEAD_MAX = 60;

// The quote anchor for a REPLY (items 2, 3): `↩ tg#<id> «[date time] <quote>…»`.
// The quoted content is the user's PARTIAL selection when present (item 2),
// otherwise the beginning of the replied-to message (item 3). Shared by text
// replies and voice-note replies so both anchor identically.
//
// `tg#<id>` is the replied-to message's OWN Telegram message_id — same
// convention as the `{id}` substitution in wrapInbound (tg-cli#28) — so an
// agent whose context has compacted/forgotten the original can still recover
// it verbatim via `tg replies --json` (grep the id) instead of relying on the
// truncated `head` preview below (tg-cli#130).
export function buildReplyAnchor(m: TgMessage, opts: StepOpts): string {
  const rtm = m.reply_to_message;
  const original = (rtm?.text ?? rtm?.caption ?? '').replace(/\s+/g, ' ').trim();
  const selected = m.quote?.text?.replace(/\s+/g, ' ').trim();
  const body = selected || original;
  const head = body.length > QUOTE_HEAD_MAX ? `${body.slice(0, QUOTE_HEAD_MAX)}…` : `${body}…`;
  const when = rtm ? (opts.fmtTime ?? fmtQuoteTimeUtc)(rtm.date) : '';
  const origId = rtm ? `tg#${rtm.message_id} ` : '';
  return `↩ ${origId}«[${when}] ${head}»`;
}

// Build the injected text for a REPLY (items 2, 3). The agent sees which message
// is being answered — the quote anchor — followed by the wrapped reply. The wrap
// carries THIS reply's own message_id (`#<id>`) so the agent can in turn thread
// its answer under the reply with `tg --reply-to <id>`.
export function buildReplyInject(m: TgMessage, name: string, opts: StepOpts): string {
  return `${buildReplyAnchor(m, opts)}\n${opts.wrap(name, m.text ?? '', m.message_id)}`;
}

// A forum LIFECYCLE service message (topic created / renamed / closed / reopened)
// carries no user instruction — it is Telegram reporting a topic-state change.
// Unlike owner text/media, a stale TRANSITION (close/reopen/renamed) is ignored
// by age (see the drop below and the same-batch lifecycle pre-scan); a stale
// CREATION is the exception and is still processed so the topic gets tracked.
function isForumServiceMessage(m: TgMessage): boolean {
  return !!(m.forum_topic_created || m.forum_topic_edited || m.forum_topic_closed || m.forum_topic_reopened);
}

export function stepUpdates(updates: TgUpdate[], opts: StepOpts): StepResult {
  const callbackActions: Action[] = [];
  const actions: Action[] = [];
  let maxId = -1;

  // PRE-SCAN for threads this batch undergoes a LIFECYCLE TRANSITION (close OR reopen): callbacks
  // are buffered and executed BEFORE message/service actions, so a same-batch
  // `[forum_topic_closed/reopened, tgr/tgm/tgp:<thread>]` would otherwise run the spawn tap FIRST and
  // the lifecycle transition AFTER. For a CLOSE that orphans the just-spawned agent into a closed
  // topic (codex r21); for a REOPEN, markReopened drops the freshly-bound paneId → orphans it too
  // (codex r27). So suppress any topic spawn-flow callback (model/path/re-spawn) for a thread the
  // SAME batch closes OR reopens, letting the lifecycle transition win. Apply the SAME filters the
  // message loop uses (codex r22): an UNAUTHORIZED service message is ignored there, so it
  // must NOT suppress a valid same-batch tap here either. Only an allowed, TRACKED-topic one.
  // Map each such thread to the EARLIEST lifecycle update_id (codex r30): suppression is ORDER-AWARE
  // for text/media messages — only a message that came AFTER the transition (higher update_id) is
  // suppressed; one that came BEFORE it is processed normally (it happened before the close/reopen).
  const lifecycleInBatch = new Map<number, number>();
  if (opts.topicsEnabled) {
    for (const u of updates) {
      const m = u.message;
      const t = m?.message_thread_id;
      if (!(m?.forum_topic_closed || m?.forum_topic_reopened) || t === undefined) continue;
      if (!senderAllowed(m.from?.id, opts)) continue;
      // A stale-dated close/reopen is ignored HERE (codex r22): an old lifecycle
      // service message must not suppress a valid same-batch tap. This is about
      // lifecycle ORDERING within a batch, not owner-message delivery — owner
      // text/media is never dropped by age (#183, main loop below).
      if (opts.nowSec - m.date > opts.cfg.stalenessSec) continue;
      if ((opts.topicStatusOf?.(t) ?? null) === null) continue;
      const prior = lifecycleInBatch.get(t);
      if (prior === undefined || u.update_id < prior) lifecycleInBatch.set(t, u.update_id);
    }
  }

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const cb = u.callback_query;
    if (cb) {
      if (!senderAllowed(cb.from?.id, opts)) {
        callbackActions.push({ kind: 'answer-callback', callbackQueryId: cb.id, text: 'not allowed' });
        continue;
      }
      // Forum-topic /new-flow taps (tgm: model, tgp: recent-path, tgr: re-spawn) route the spawn
      // flow — checked first and only when topics mode is on (with the flag off a stray topic tap
      // falls through to the question/agent parsers, which reject it as expired — never spawns). A
      // tap whose thread is CLOSED in this SAME batch is answered as expired, NOT routed to the spawn
      // flow (codex r21: the close wins over a same-batch spawn tap, so no spawn-into-a-closed-topic).
      if (opts.topicsEnabled) {
        const modelCb = parseTopicModelCallback(cb.data);
        if (modelCb) {
          callbackActions.push(
            lifecycleInBatch.has(modelCb.threadId)
              ? { kind: 'answer-callback', callbackQueryId: cb.id, text: 'topic changed — try again' }
              : {
                  kind: 'topic-model',
                  callbackQueryId: cb.id,
                  threadId: modelCb.threadId,
                  modelId: modelCb.modelId,
                  messageId: cb.message?.message_id ?? null,
                },
          );
          continue;
        }
        const pathCb = parseTopicPathCallback(cb.data);
        if (pathCb) {
          callbackActions.push(
            lifecycleInBatch.has(pathCb.threadId)
              ? { kind: 'answer-callback', callbackQueryId: cb.id, text: 'topic changed — try again' }
              : {
                  kind: 'topic-path',
                  callbackQueryId: cb.id,
                  threadId: pathCb.threadId,
                  index: pathCb.index,
                  nonce: pathCb.nonce,
                  messageId: cb.message?.message_id ?? null,
                },
          );
          continue;
        }
        const respawnThreadId = parseTopicRespawnCallback(cb.data);
        if (respawnThreadId !== null) {
          callbackActions.push(
            lifecycleInBatch.has(respawnThreadId)
              ? { kind: 'answer-callback', callbackQueryId: cb.id, text: 'topic changed — try again' }
              : {
                  kind: 'topic-respawn',
                  callbackQueryId: cb.id,
                  threadId: respawnThreadId,
                  messageId: cb.message?.message_id ?? null,
                },
          );
          continue;
        }
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

    // Owner text/media inbound is NOT dropped by age (#183): a message Telegram
    // delivered after daemon downtime or while agents were busy is still a real
    // request and must reach the agent, not vanish behind a "skipped N stale"
    // notice. A stale forum lifecycle TRANSITION (close/reopen/renamed) IS still
    // ignored by age — consistent with the same-batch lifecycle pre-scan above
    // (codex r22): an old topic-state event must not re-drive routing after
    // downtime, and processing it here while the pre-scan ignores it would let a
    // same-batch spawn tap orphan into a closing topic. CREATION is the exception
    // (codex #195): a topic created while the daemon was down > stalenessSec must
    // STILL reach topicActionFor so it emits topic-new and TRACKS the topic —
    // else later messages in it are untracked and never bound to an agent.
    if (isForumServiceMessage(m) && !m.forum_topic_created && opts.nowSec - m.date > opts.cfg.stalenessSec) continue;

    const name = m.from?.first_name || m.from?.username || 'tg';

    // Forum-topics mode: a topic service message or a message inside a TRACKED topic is
    // handled here and the flat dispatch is skipped. topicActionFor returns null ONLY when
    // this is not a topic message we own (topics OFF, General, a non-forum reply-thread, or
    // an untracked topic) → fall through to the normal handling, unchanged. A KNOWN topic
    // returns a (possibly empty) action list so its messages can NEVER leak to a flat agent
    // (the media/closed mis-routing the review caught).
    if (opts.topicsEnabled) {
      // A text/media message in a thread the SAME batch CLOSES or REOPENS, and that arrived AFTER the
      // transition (higher update_id), must NOT emit a topic-route or a dead-topic recovery (codex r24
      // P1b / r27): it would route into / offer a re-spawn for a topic the lifecycle transition is
      // about to change. Ack only — the transition wins. ORDER-AWARE (codex r30): a message BEFORE the
      // transition (lower update_id) is processed normally. Service messages flow through below.
      const tid = m.message_thread_id;
      const lifeId = tid !== undefined ? lifecycleInBatch.get(tid) : undefined;
      if (
        lifeId !== undefined &&
        u.update_id > lifeId &&
        !m.forum_topic_closed &&
        !m.forum_topic_reopened &&
        !m.forum_topic_created
      ) {
        actions.push({ kind: 'ack', messageId: m.message_id });
        continue;
      }
      const topicActions = topicActionFor(m, name, opts);
      if (topicActions) {
        actions.push(...topicActions);
        actions.push({ kind: 'ack', messageId: m.message_id });
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
        // Bound once so every branch below narrows against the SAME reference —
        // a decoupled `m.reply_to_message!` non-null assertion (one expression
        // asserting non-null based on an entirely separate expression's truthy
        // check) is exactly the kind of coupling a future edit can silently
        // desync into a runtime TypeError (review finding).
        const reply = m.reply_to_message;
        const decisionToken = !isVerbatimText ? parseDecisionReplyToken(m.text) : null;
        const decisionRequestId = decisionToken && reply
          ? (opts.permissionRequestIdForMessage?.(reply.message_id) ?? null)
          : null;
        const postTimeoutRequestId = reply
          ? (opts.postTimeoutQuestionRequestIdForMessage?.(reply.message_id) ?? null)
          : null;
        action = decisionRequestId && decisionToken && reply
          ? {
              kind: 'answer-question',
              callbackQueryId: '',
              requestId: decisionRequestId,
              value: decisionToken,
              messageId: reply.message_id,
            }
          : postTimeoutRequestId && !isVerbatimText && reply
            ? {
                kind: 'post-timeout-question-reply',
                requestId: postTimeoutRequestId,
                questionMessageId: reply.message_id,
                text: m.text,
                from: name,
                messageId: m.message_id,
              }
          : reply && (!isVerbatimText || isBangReply)
            ? {
                kind: 'reply-route',
                replyToMessageId: reply.message_id,
                // A `!` reply keeps its raw text (verbatim, `!` at column 0); a
                // prose reply gets the quote anchor + wrap.
                injectText: isBangReply ? m.text : buildReplyInject(m, name, opts),
                from: name,
                messageId: m.message_id,
              }
            : textAction(
                m.text,
                name,
                opts,
                m.message_id,
                reply?.message_id ?? null,
                opts.topicsEnabled && m.is_topic_message ? (m.message_thread_id ?? null) : null,
              );
      }
    } else if (m.voice ?? m.audio) action = voiceAction(u.update_id, m, name, opts);
    else if (m.photo?.length) action = photoAction(u.update_id, m, name, opts);
    else if (m.document) action = documentAction(u.update_id, m, name, opts);
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
  replyToMessageId: number | null,
  threadId: number | null = null,
): Action {
  // `!` passthrough (harness `!` convention): a message STARTING with `!` reaches
  // the harness VERBATIM — no `[TG from …]` wrap — so it runs the rest as an
  // in-session shell command. The harness only honours a `!` at column 0, so the
  // text must be injected raw (no wrap, no reply quote-anchor). Owner-gated by
  // `senderAllowed` upstream — a non-owner never reaches here.
  if (text.startsWith('!')) return { kind: 'inject-text', text, messageId };
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
      return { kind: 'new-command', harness: p.harness, model: p.model, dir: p.dir, name: p.name, task: p.task, dirAfterName: p.dirAfterName, from: name, ...topic };
    }
    return { kind: 'inject-text', text, messageId };
  }
  // A plain inbound message: surface its message_id in the wrap so the agent can
  // thread its answer with `tg --reply-to <id>` (threaded replies).
  return { kind: 'inject-text', text: opts.wrap(name, text, messageId), messageId };
}

// A harness/daemon slash-command (`/compact`, `/stop now`) vs a path-or-prose message that
// merely starts with `/` (`/etc/hosts is broken`). A command is `/` + a letter + word chars,
// then a space or end — so a SECOND slash (a path) or a leading non-letter is NOT a command.
export function isLikelySlashCommand(text: string): boolean {
  return /^\/[a-zA-Z][\w-]*(\s|$)/.test(text);
}

// Forum-topics routing (docs/specs/tg-forum-topics.md §8). Returns the action list for a
// topic service-message or a message inside a TRACKED topic, else null to fall through to the
// flat handling. PURE: the bound/awaiting decision uses the injected `topicStatusOf` lookup;
// the entrypoint owns the binding store and resolves threadId→pane.
//
// A KNOWN topic always returns a list (possibly empty) so its messages can NEVER fall through
// to a flat agent — leaking a topic message to the flat picker injects it into the wrong agent
// and replies in General (the media/closed mis-routing the review caught). null is reserved for
// "not ours": General, a non-forum reply-thread (message_thread_id present but is_topic_message
// absent — a supergroup reply thread, NOT a forum topic), or an untracked topic.
function topicActionFor(m: TgMessage, name: string, opts: StepOpts): Action[] | null {
  if (m.forum_topic_created) {
    // The service message's thread id IS the topic id (== its own message_id as a fallback).
    const threadId = m.message_thread_id ?? m.message_id;
    // Guard against a DUPLICATE create for a topic already in-flight or bound: re-emitting
    // topic-new would let the entrypoint reset it to awaiting-path (createTopic + upsert) and
    // lose the live pane. Only an untracked or previously-closed topic starts the flow.
    const created = opts.topicStatusOf?.(threadId) ?? null;
    if (created === 'bound' || created === 'awaiting-path' || created === 'awaiting-model') return [];
    return [{ kind: 'topic-new', threadId, name: m.forum_topic_created.name, from: name }];
  }
  const threadId = m.message_thread_id;
  if (threadId === undefined) return null; // General / non-topic message → flat handling
  // close/reopen are gated on the topic being TRACKED — an untracked topic (created before the
  // bot joined / before topics were enabled) closing is not ours, so don't emit an action the
  // entrypoint has no binding for (keeps the "untracked → not ours" symmetry; review catch).
  if (m.forum_topic_closed) return (opts.topicStatusOf?.(threadId) ?? null) !== null ? [{ kind: 'topic-close', threadId }] : [];
  if (m.forum_topic_reopened) return (opts.topicStatusOf?.(threadId) ?? null) !== null ? [{ kind: 'topic-reopen', threadId }] : [];
  // A topic RENAME (forum_topic_edited) is a recognized service message — never leak to flat.
  // If the edit carries a new name and the topic is tracked, emit topic-rename so the entrypoint
  // can persist the new name and rename the live tmux window slug. An icon-only edit (no name
  // field) or an untracked topic → ack quietly (same "known topic stays ours" invariant).
  if (m.forum_topic_edited) {
    const newName = m.forum_topic_edited.name;
    if (newName && opts.topicStatusOf?.(threadId) != null) {
      return [{ kind: 'topic-rename', threadId, name: newName }];
    }
    return [];
  }
  // A non-forum supergroup reply-thread also carries message_thread_id; only a real forum
  // topic message sets is_topic_message. Without it we'd false-capture a reply thread whose id
  // happened to match a tracked topic — so require the flag for non-service messages.
  if (!m.is_topic_message) return null;
  const status = opts.topicStatusOf?.(threadId) ?? null;
  // A real forum-topic message (is_topic_message) for a topic the daemon hasn't bound yet is still
  // OURS — acked, not leaked to a flat agent (which would reply in General, out of the topic). The
  // increment-2 entrypoint binds it (e.g. spawns on first message); until then it is a no-op ack,
  // never a mis-route (review: untracked must not reply in General, spec §10).
  if (status === null) return [];
  if (status === 'bound') {
    // A message to the topic's agent. A real slash-command is injected verbatim (so /compact,
    // /stop, … reach the agent); everything else is PROSE — wrapped so the agent gets the
    // sender + message_id and can `tg --reply-to <id>` back into the topic. The command test is
    // narrow (`/word` …, no second slash) so a path-like message — `/etc/hosts is broken`,
    // `/tmp/foo crashed` — is treated as prose, not mis-read as a command (review catch). A
    // media-only message (no text) is acked but NOT injected here — routing media into the topic
    // is increment 2; the point is it must never leak to a flat agent.
    const text = m.text ?? '';
    if (!text) return [];
    // §11 deferral 2: intercept the 3 daemon-global verbs (/status, /agent, /new) even inside
    // a bound topic — they control the daemon, not the topic agent. /stop and /kill are NOT
    // intercepted: they must still reach the topic's pane (kill/escape the harness session).
    // Using an explicit set (not isDaemonSlashCommand) to avoid over-intercepting.
    const TOPIC_GLOBAL_CMDS = new Set(['/status', '/agent', '/new', '/tasks', '/limit', '/daily', '/spend']);
    const verb = text.split(/\s+/, 1)[0].replace(/@\w+$/, '');
    if (TOPIC_GLOBAL_CMDS.has(verb)) return [textAction(text, name, opts, m.message_id, m.reply_to_message?.message_id ?? null, threadId)];
    // A `!shell` passthrough is VERBATIM into the topic pane (harness `!` convention): no wrap and
    // no reply quote-anchor, so the `!` stays at column 0 — same rule as the flat path. Checked
    // before the reply-anchor branch so a `!` reply is verbatim too.
    if (text.startsWith('!')) return [{ kind: 'topic-route', threadId, injectText: text, from: name, messageId: m.message_id }];
    // §11 deferral 1: a prose reply carries the same ↩ «…» quote-anchor as flat-chat replies.
    // A /command reply still goes verbatim (the startsWith('/') guard above already passed it
    // through to the injectText path below).
    if (m.reply_to_message && !text.startsWith('/')) {
      return [{ kind: 'topic-route', threadId, injectText: buildReplyInject(m, name, opts), from: name, messageId: m.message_id }];
    }
    const injectText = isLikelySlashCommand(text) ? text : opts.wrap(name, text, m.message_id);
    return [{ kind: 'topic-route', threadId, injectText, from: name, messageId: m.message_id }];
  }
  if (status === 'closed') {
    // The topic's agent died (pane gone). A message here is not lost: emit topic-dead so the
    // entrypoint offers a one-tap re-spawn (increment 4) instead of the old silent dead-end.
    // Carry the wrapped text so a SAME-BATCH re-spawn (which re-binds before this runs) can route
    // it to the now-live pane rather than dropping it (codex r9 #1). Never leaks to a flat agent.
    const deadText = m.text ?? '';
    const deadVerbatim = deadText.startsWith('!') || isLikelySlashCommand(deadText);
    const deadInject = deadText ? (deadVerbatim ? deadText : opts.wrap(name, deadText, m.message_id)) : '';
    return [{ kind: 'topic-dead', threadId, injectText: deadInject, messageId: m.message_id }];
  }
  // awaiting-path / awaiting-model: a text answer to the /new flow. A path message advances the
  // flow (the model is picked by the `tgm:` button callback handled in the callback branch above,
  // NOT as text — an awaiting-model text message just re-shows the buttons in the entrypoint).
  return [{ kind: 'topic-answer', threadId, text: m.text ?? '', from: name, messageId: m.message_id }];
}

function attachMediaReplyRoute(
  action: Extract<Action, { kind: 'download-media' }>,
  m: TgMessage,
  opts: StepOpts,
): Extract<Action, { kind: 'download-media' }> {
  if (m.caption && isAgentCommand(m.caption)) {
    return { ...action, agentRoute: parseAgentCommand(m.caption) };
  }
  if (m.reply_to_message) {
    return {
      ...action,
      replyToMessageId: m.reply_to_message.message_id,
      replyAnchor: buildReplyAnchor(m, opts),
    };
  }
  return action;
}

function photoAction(updateId: number, m: TgMessage, name: string, opts: StepOpts): Action {
  // Telegram sends several renditions; take the largest by file_size. Ties and
  // missing sizes resolve to the LATER entry — the array is size-ascending.
  let best = m.photo![0];
  for (const p of m.photo!) {
    if ((p.file_size ?? 0) >= (best.file_size ?? 0)) best = p;
  }
  if ((best.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: 'reply', text: TOO_LARGE_REPLY };
  return attachMediaReplyRoute(
    {
      kind: 'download-media',
      fileId: best.file_id,
      suggestedName: `${updateId}.jpg`,
      mediaKind: 'photo',
      fileSize: best.file_size,
      caption: m.caption,
      from: name,
      messageId: m.message_id,
    },
    m,
    opts,
  );
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

function documentAction(updateId: number, m: TgMessage, name: string, opts: StepOpts): Action {
  const doc = m.document!;
  if ((doc.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: 'reply', text: TOO_LARGE_REPLY };
  return attachMediaReplyRoute(
    {
      kind: 'download-media',
      fileId: doc.file_id,
      suggestedName: `${updateId}.${sanitizedExt(doc.file_name)}`,
      mediaKind: 'document',
      fileSize: doc.file_size,
      caption: m.caption,
      from: name,
      messageId: m.message_id,
    },
    m,
    opts,
  );
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
