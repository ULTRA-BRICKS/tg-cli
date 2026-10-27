// Shared contract for the tg-ctl feature modules (spec §16).
//
// Everything in features/tg-ctl/ is PURE — no I/O. The tg-ctl entrypoint owns
// real spawns, fetch, ffi flock and file I/O, and feeds these modules plain
// data. Tests construct the same data by hand.

import type { TaskViewFilter, TasksCallbackKind } from './tasks-command';
import type { PermissionMenuTarget } from './permission-menu';
import type { WorkspaceScope } from '../chatgpt/model';

// --- config (spec §9) ---

export interface ControlConfig {
  enabled: boolean;
  transport: 'auto' | 'tmux' | 'channel'; // 'channel' reserved for v1.2+
  session?: string; // fixed tmux session name (else auto-discover)
  injectWrap: string; // template: {name}, {msg}, {id}
  stalenessSec: number; // legacy config; owner inbound is no longer dropped by age (#183)
  idleExitMin: number; // daemon exits after this long with no agent pane (default 30)
  allowedSenders: number[]; // extra allowed sender user ids
  // Forum-topics mode (docs/specs/tg-forum-topics.md). Default OFF: when false the daemon
  // never enters topic mode and a forum-topic message falls through to the normal flat
  // handling (1:1 behaviour byte-identical). Opt in per machine with `control.topics: true`
  // once the chat is a forum supergroup with the bot as a topic-managing admin.
  topics: boolean;
  // Private-chat topics (Bot API 9.4). Default OFF: when true the daemon calls
  // `createForumTopic` after each flat /new spawn and binds the returned thread to the new
  // agent (same TopicBinding store as supergroup topics). Requires the Bot API private-topic
  // capability for the bot (`getMe.has_topics_enabled`); if `createForumTopic` fails the daemon
  // falls back to the current flat-chat behaviour with a visible diagnostic. Opt in with
  // `control.private_topics: true`.
  privateTopics: boolean;
  // Git-state-check banner (git-state.ts): default ON. Before auto-binding a fresh, non-reply
  // message into the discovered pane, the entrypoint checks that pane's cwd for uncommitted
  // changes / a non-main branch and prepends a warning banner when found — the root-cause fix
  // for a new, unrelated message silently reading as "more of the same task" in an occupied
  // pane. An agent that always works on a feature branch sees this on every delivery to that
  // pane; opt out per machine with `control.git_state_banner: false` if that's too noisy.
  gitStateBanner: boolean;
}

// enabled defaults ON (user decision 2026-06-10, post-review): inbound is armed
// out of the box wherever the bot token exists; opt OUT per machine with
// `control.enabled: false`. The auto-start gate still requires tmux + a
// detected agent, and D3 (bot-per-machine) becomes a practical requirement.
export const DEFAULT_CONTROL: ControlConfig = {
  enabled: true,
  transport: 'auto',
  // `{id}` renders the inbound Telegram message_id as `tg#<id>` — the agent passes
  // it to `tg --reply-to <id>` to thread its answer under this exact message.
  // A `/agent <selector> <text>` route carries an id too (forwarded from
  // sourceMessageId, same as every other inbound path). Only a genuinely
  // synthetic/non-inbound injection has no id — then `{id}` collapses with
  // its leading space (see wrapInbound), so the wrap stays `[TG from {name}] …`.
  injectWrap: '[TG from {name} {id}] {msg}',
  stalenessSec: 300,
  idleExitMin: 30,
  allowedSenders: [],
  // OFF by default — topic mode activates only when the operator opts in (the routing half
  // ships before the spawn executor, so an accidental opt-in must not break the flat path).
  topics: false,
  // OFF by default — private-chat topics auto-degrade when Bot API reports no private-topic
  // capability (createForumTopic fails → fall through to flat behaviour).
  privateTopics: false,
  // ON by default — the banner is a heads-up nudge, not a hard gate; opt out per machine with
  // `control.git_state_banner: false`.
  gitStateBanner: true,
};

// --- Telegram update shapes (only the fields we read) ---

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

// A Telegram VOICE note (OGG/OPUS) or an audio note. Both carry a file_id we
// resolve via getFile, then download → ffmpeg → Whisper → text (inbound STT).
export interface TgVoice {
  file_id: string;
  duration?: number; // seconds
  mime_type?: string; // usually audio/ogg
  file_size?: number;
}

// The user's partial selection when replying (Bot API 7.0+): the substring of
// the replied-to message they highlighted. Forwarded verbatim into the agent.
export interface TgTextQuote {
  text: string;
}

// Bot API 10.1 rich message content (`Message.rich_message`, tg-cli#461). A message sent
// with sendRichMessage — how `tg --format html` ships any report with a list/table/heading —
// carries its content ONLY here: `text` is absent. Typed loosely to just the text-bearing
// fields the reply-quote anchor flattens (features/tg-ctl/reply-preview.ts); every other
// block/inline kind is ignored.
//   RichText: a plain string, an array of RichText, or an inline object (bold/url/…) whose
//   `text` is RichText; custom emoji carry `alternative_text`, formulas `expression`.
export type TgRichText =
  | string
  | TgRichText[]
  | { type?: string; text?: TgRichText; alternative_text?: string; expression?: string };

export interface TgRichBlock {
  type?: string;
  text?: TgRichText; // paragraph / heading / pre / footer / quotes
  summary?: TgRichText; // details
  expression?: string; // mathematical_expression block
  blocks?: TgRichBlock[]; // blockquote / details / collage / slideshow
  items?: { blocks?: TgRichBlock[] }[]; // list
  cells?: { text?: TgRichText }[][]; // table
  caption?: TgRichText; // table: RichText; media: RichBlockCaption `{ text, credit }`
}

export interface TgRichMessage {
  blocks?: TgRichBlock[];
}

// A forum topic service message (Bot API 6.3+). `forum_topic_created` carries the new
// topic's name; closed/reopened carry no extra fields. The owning message's
// `message_thread_id` IS the topic id. See docs/specs/tg-forum-topics.md.
export interface TgForumTopicCreated {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  date: number; // unix seconds
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice; // a voice note (OGG/OPUS) — transcribed to text inbound
  audio?: TgVoice; // an audio file/note — same transcribe path as voice
  // Read only to label a captionless replied-to message in the reply-quote anchor (#461).
  video?: TgDocument;
  animation?: TgDocument;
  video_note?: { file_id: string };
  sticker?: { file_id: string; emoji?: string };
  rich_message?: TgRichMessage; // sendRichMessage content; such a message has no `text` (#461)
  reply_to_message?: TgMessage; // the message this one replies to (items 2,3)
  quote?: TgTextQuote; // the user's partial-quote selection from it (item 2)
  // --- forum topics (docs/specs/tg-forum-topics.md) ---
  message_thread_id?: number; // the topic id; absent in General / non-forum chats
  is_topic_message?: boolean; // true for a user message inside a topic
  forum_topic_created?: TgForumTopicCreated; // service msg: a new topic was created
  forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string }; // service msg: topic renamed/re-iconed
  forum_topic_closed?: Record<string, never>; // service msg: topic closed (empty object)
  forum_topic_reopened?: Record<string, never>; // service msg: topic reopened (empty object)
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: {
    message_id: number;
    chat: { id: number };
    date: number;
    message_thread_id?: number;
  };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// --- update step function (spec §16 module 4) ---

// Agent kinds that `/new` can launch directly from the model catalog. `AgentKind` below is wider:
// it also covers agents we can detect/route to but do not spawn from `/new`.
export type SpawnHarness = 'claude' | 'codex' | 'opencode';

// Actions are data; the entrypoint executes them in order.
export type Action =
  // `plain`: the user's own words, set only for a plain (non-reply, non-command) message — what
  // the daemon answers an open card with when the session has exactly one (tg-cli#705).
  | { kind: 'inject-text'; text: string; messageId: number; plain?: string } // already wrapped, OR verbatim passthrough (`/cmd` or `!shell`)
  | { kind: 'inject-key'; key: 'Escape' } // /stop
  | { kind: 'kill-agent' } // /kill — SIGINT to the registered pane's agent pid
  | { kind: 'status'; threadId?: number | null } // /status — entrypoint composes the reply
  | { kind: 'limit-status'; agent: string | null; threadId?: number | null } // /limit [agent] — latest usage/rate-limit telemetry
  | { kind: 'daily-report'; threadId?: number | null } // /daily — `rig daily`'s categorized what-shipped report over merged PRs
  | { kind: 'usage-report'; period: 'day' | 'week' | 'month' | null; threadId?: number | null } // /spend [day|week|month] — `rig usage`'s token/cost report (named /spend, not /usage/cost/stats — those are reserved by Codex and/or Claude Code, tg-cli#290)
  // /tasks [<agent>] [<status>] and task-board callbacks — entrypoint resolves
  // the agent→project scope, spawns task-cli + gh, composes a rich-HTML board
  // with filters/pagination, sends it (#115/#178).
  | {
      kind: 'tasks';
      agent: string | null;
      status: string | null;
      replyToMessageId: number | null;
      view?: TaskViewFilter | null;
      page?: number;
      callbackKind?: TasksCallbackKind;
      callbackQueryId?: string;
      messageId?: number | null;
      chatId?: number | string | null;
      threadId?: number | null;
    }
  // /chatgpt [home|glide.vc|all] — the owner-only ChatGPT session menu (features/chatgpt). `workspace`
  // is null for an argument that is not a workspace (the entrypoint answers with usage).
  | { kind: 'chatgpt-menu'; workspace: WorkspaceScope | null; threadId?: number | null }
  // A tap on a /chatgpt button (cgp:<opaque ref>). Only the reference and the tapped chat travel:
  // what it means lives in the durable ref store, never in the callback data.
  | { kind: 'chatgpt-callback'; callbackQueryId: string; data: string; chatId: number; messageId: number | null; threadId?: number | null }
  // A tap on a limit-stop's "auto-continue" button (lc:<pane>:<resetAt>): the
  // entrypoint arms a timer that injects "continue" into that pane at reset time
  // (immediately if already past), persisted so a restart re-arms it (#113).
  | { kind: 'limit-continue'; callbackQueryId: string; paneId: string; resetAt: number; sourceMessageId: number | null; messageId: number | null }
  // /agent [<win>] <msg> — entrypoint discovers panes, fuzzy-matches the window
  // (phonetic), routes <msg> to that agent or asks via session-grouped buttons.
  | { kind: 'agent-route'; selector: string | null; rest: string; all: string; from: string; messageId: number; threadId?: number | null }
  // A tap on a /agent selection button (tga:<token>:<index>): the entrypoint
  // looks up the pending message + candidate and injects it into the chosen pane.
  | {
      kind: 'agent-callback';
      callbackQueryId: string;
      token: string;
      index: number;
      from: string;
      messageId: number | null;
    }
  // A tap on the Cancel button shown after a bare `/agent` selection.
  | { kind: 'agent-cancel'; callbackQueryId: string; token: string; messageId: number | null }
  // A reply: route by the recognized origin pane (routes map) when known, else
  // a session-grouped picker ordered LRU/MRU. injectText is injected verbatim.
  // For a prose reply it is wrapped + carries the quote anchor (items 2,3); for a
  // `!shell` reply it is the RAW `!…` text with no wrap/anchor (codex #192) so `!`
  // stays at column 0 for the harness passthrough while still routing to origin.
  // threadId: the forum topic the reply was written in — the fallback picker and notices are
  // answered there (a reply in a gone session's topic, tg-cli#709); absent = General.
  | { kind: 'reply-route'; replyToMessageId: number; injectText: string; from: string; messageId: number; threadId?: number }
  | { kind: 'reply'; text: string; threadId?: number | null } // sendMessage back to the chat (threadId: reply inside a bound topic)
  | { kind: 'answer-callback'; callbackQueryId: string; text: string }
  // messageId is the Telegram message the tapped button belongs to (null when
  // Telegram omits it); the daemon rejects taps whose message does not match
  // the pending prompt, so a stale tap can never answer a later same-key hook.
  | {
      kind: 'answer-question';
      callbackQueryId: string;
      requestId: string;
      value: string;
      messageId: number | null;
      // The forum topic a TEXT-reply answer came from: its "expired"/"already answered" notice
      // (no callback query to toast) is posted there, not to General (tg-cli#551).
      threadId?: number;
      // An answer typed in chat instead of tapped (tg-cli#705): the card's session had exactly
      // one open card, so this text answers it; `value` is unused.
      freeText?: string;
      actor?: { userId: number | null; chatId: number | null };
    }
  | {
      kind: 'close-question-card';
      callbackQueryId: string;
      requestId: string;
      messageId: number | null;
      actor?: { userId: number | null; chatId: number | null };
    }
  | {
      kind: 'post-timeout-question-reply';
      requestId: string;
      questionMessageId: number;
      text: string;
      from: string;
      messageId: number;
      // The forum topic the reply came from: its refusal notices are posted there (tg-cli#551).
      threadId?: number;
      actor?: { userId: number | null; chatId: number | null };
    }
  // Delivery receipt: set a 👀 reaction on the source message IF every action
  // emitted for it succeeded. Follows the message's delivery action(s); never
  // emitted for pure error replies (those ARE the failure signal).
  | { kind: 'ack'; messageId: number }
  | {
      kind: 'download-media';
      fileId: string;
      suggestedName: string; // daemon-chosen: <update_id>.<ext>
      mediaKind: 'photo' | 'document';
      fileSize?: number;
      caption?: string;
      from: string; // display name for the wrap
      messageId: number; // inbound Telegram message_id → surfaced as `tg#<id>` for tg --reply-to
      // Set when the photo/document itself is a reply: after download, route the
      // media receipt through reply-route with this quote anchor prepended (same
      // origin-pane semantics as typed and voice replies).
      replyToMessageId?: number;
      replyAnchor?: string;
      // Set when the media caption itself is `/agent ...`: after download the
      // local-path receipt is routed by that selector instead of auto-binding to
      // the last active pane. Mirrors text `/agent` routing but keeps the media
      // receipt pre-wrapped so the path and message id survive.
      agentRoute?: { selector: string | null; rest: string; all: string };
    }
  // A voice/audio note: download the OGG, ffmpeg→WAV, run local Whisper, then
  // route the transcript EXACTLY like a typed message — wrapped + acked. When
  // the note is a reply (replyToMessageId set) it routes through the same
  // reply-route path a typed reply uses (origin-pane recognition + quote
  // anchor); otherwise it injects into the discovered pane like plain text. The
  // entrypoint, not the step function, knows whether Whisper is configured: an
  // unconfigured note becomes an onboarding reply there, never a silent drop.
  | {
      kind: 'transcribe-voice';
      fileId: string;
      suggestedName: string; // daemon-chosen: <update_id>.ogg
      fileSize?: number;
      from: string; // display name for the wrap
      messageId: number; // inbound Telegram message_id → surfaced as `tg#<id>` for tg --reply-to
      // Set when the voice note itself is a reply: route via reply-route with
      // this quote anchor prepended (built from the replied-to message).
      replyToMessageId?: number;
      replyAnchor?: string;
    }
  // --- forum topics: inbound triage (docs/specs/session-registry-and-topics.md §4.4) ---
  // A message in a topic BOUND to a session → deliver the payload to that session (the
  // entrypoint answers in the topic when the session is gone). Never spawns, never falls back.
  | { kind: 'topic-route'; threadId: number; payload: TopicPayload }
  // A message in an UNKNOWN topic (user-created, implicit, or a lost binding) → queue it for the
  // topic and post the attach picker there once. Delivered to the picked session, in order.
  | { kind: 'topic-hold'; threadId: number; payload: TopicPayload }
  // A tap on an attach-picker button (tgt:<threadId>:<paneId>) → deliver the topic's queue to
  // that session and bind the topic to it when the session has no topic yet.
  | { kind: 'topic-attach'; callbackQueryId: string; threadId: number; paneId: string; messageId: number | null }
  // A tap on the picker's ➕ New session row (tgn:<threadId>) → run the /new flow in that topic and
  // spawn the agent with the topic as its own; the held text becomes its first task (tg-cli#735).
  | { kind: 'topic-new-session'; callbackQueryId: string; threadId: number; messageId: number | null }
  // forum_topic_created / _edited / _closed / _reopened service messages: recorded (logged)
  // only. They never spawn and never touch tmux.
  | { kind: 'topic-event'; threadId: number; event: 'created' | 'edited' | 'closed' | 'reopened'; name?: string }
  // --- flat-chat /new command (issue #27; NON-topic) ---
  // A `/new [<harness>|<model>] [<dir>] name [<task>]` slash command in the flat chat → start
  // the interactive new-session flow (ask dir, then harness/model, then spawn). All parts but
  // `name` are optional; omitted model/dir are picked via inline buttons. A flat /new carries no
  // forum thread, so the entrypoint mints a token.
  | {
      kind: 'new-command';
      harness: SpawnHarness | null;
      model: string | null;
      dir: string | null;
      name: string;
      task: string;
      // True when `dir` was an inline token AFTER the name: if the entrypoint then
      // rejects it as non-existent it prepends the raw token onto the task rather
      // than dropping it (codex #187), preserving `/new api /compact first`.
      dirAfterName: boolean;
      from: string;
      // The `/new` message's own id and its chat. A private-topic spawn records both on the binding
      // (TopicBinding.sourceChatId/sourceMessageId) so a REPLAY of this same update — the
      // pending-batch recovery after a crash mid-spawn — is recognized and not run a second time.
      // The chat is part of the key: message ids are sequential PER CHAT.
      messageId: number;
      chatId: number;
      threadId?: number | null;
    }
  // A tap on a flat-/new harness button (tnh:<token>:<harness>) → ask models for that harness.
  // callbackQueryId answers the tap; messageId is the prompt (its keyboard is cleared on advance).
  | {
      kind: 'new-harness';
      callbackQueryId: string;
      token: string;
      harness: SpawnHarness;
      messageId: number | null;
    }
  // A tap on a flat-/new model button (tnm:<token>:<modelId>) → spawn the agent with that model.
  // callbackQueryId answers the tap; messageId is the prompt (its keyboard is cleared on spawn).
  | { kind: 'new-model'; callbackQueryId: string; token: string; modelId: string; messageId: number | null }
  // A tap on a flat-/new recent-dir button (tnp:<token>:<index>) → resolve the index against the
  // pending session's dirChoices and advance like a typed path. callbackQueryId answers the tap.
  | { kind: 'new-dir'; callbackQueryId: string; token: string; index: number; messageId: number | null }
  // A tap on the "Retry spawn" button (tnr:<token>) offered after a spawn FAILURE → re-run the
  // spawn with the pending session's already-chosen name/dir/harness/model (never re-asks).
  | { kind: 'new-retry'; callbackQueryId: string; token: string; messageId: number | null }
  // A tap on the private-topic fallback prompt (tnf:<token>:continue|cancel) → either continue the
  // same pending /new session without topic routing or cancel that spawn.
  | {
      kind: 'new-private-topic-fallback';
      callbackQueryId: string;
      token: string;
      choice: 'continue' | 'cancel';
      messageId: number | null;
    }
  // A free-text message answering an in-flight flat-/new prompt (the awaiting-dir step — an
  // absolute path typed instead of tapping a button). `text` is the raw user text. The entrypoint
  // matches it to the SINGLE pending session in awaiting-dir (a flat chat has at most one /new in
  // flight at a time); a stray one with no pending session falls through to normal handling.
  | { kind: 'new-answer'; text: string; from: string; messageId: number };

export interface StepResult {
  actions: Action[];
  newOffset: number; // next getUpdates offset (last update_id + 1)
  skippedStale: number; // legacy field; always 0 — owner inbound is no longer skipped by age (#183)
}

// --- tmux injection plans (spec §16 module 5) ---

export type InjectStep =
  // The entrypoint re-checks an agent is still in the pane; with `sessionKey`,
  // that the pane still hosts THAT session (spec §2.6 pane-reuse guard).
  | { kind: 'verify-pane'; paneId: string; sessionKey?: string }
  | { kind: 'tmux'; argv: string[]; stdin?: string } // tmux command; stdin for load-buffer -
  // tg-cli#309: re-capture the pane and continue only if the permission menu
  // `target` was resolved from is still the live one (permissionMenuUnchanged);
  // otherwise the plan fails before the digit's send-keys.
  | { kind: 'verify-permission-menu'; paneId: string; target: PermissionMenuTarget }
  | { kind: 'sleep'; ms: number }
  // tg-cli#463: is `text` still in the harness's input box after its Enter? No (or the
  // box cannot be read) → the plan ends, delivered. Yes → run the steps that follow (the
  // one retry Enter); yes on the `final` check → fail, reporting the text as unsubmitted.
  | { kind: 'submit-check'; paneId: string; text: string; final?: true };

// --- pane discovery (spec §16 module 6) ---

export interface PaneInfo {
  sessionName: string;
  windowIndex: number;
  paneId: string; // "%N"
  panePid: number;
  paneCommand: string; // pane_current_command — VERSION string for cc!
  // pane's window NAME (#{window_name}) — the user-set tmux window label
  // ("rig", "3d"). Carried in the core snapshot so the /agent picker labels it
  // reliably (tg-cli#75 fix C); a separate tmux call mis-aligned/blanked under
  // the launchd no-locale tab-mangle. Empty when tmux gives no name.
  windowName: string;
  // The `@tg_spawn_token` window user option (forum-topics increment 4): the per-spawn token set
  // via `tmux set-option -w @tg_spawn_token` right after a topic agent is launched. Empty string
  // when unset. Startup orphan reconcile matches it against the binding's recorded spawnToken to
  // PROVE a candidate pane is the one we launched (a queryable alternative to `new-window -e`, which
  // sets process env not readable via tmux later — codex r11).
  spawnToken: string;
  panePath: string; // pane_current_path
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string; // full command line
}

export type AgentKind = SpawnHarness | 'pi' | 'aider' | 'omp' | 'unknown';

// The closed harness-kind selector for `tg-ctl ask --agent <kind>` (the entrypoint's
// hookAgentFromArgv). Derived from a Record so EXHAUSTIVENESS is compile-checked:
// adding a kind to AgentKind without adding it here (or vice versa) is a compile
// compile error, never a silent fallthrough to claude semantics. 'unknown' is deliberately
// excluded — it is not an installable harness. INVARIANT: every non-unknown AgentKind
// is ask-addressable here; a kind with no payload format is still safe because the
// questionCapability gate drops it downstream (the honest tmux floor). If a future
// kind must be discoverable but NOT ask-selectable, this Record constraint must be
// split. (`harness-event --agent` is a separate, free-form telemetry label and does
// NOT use this list.)
const HOOK_AGENT_KINDS_MAP = {
  claude: true,
  codex: true,
  opencode: true,
  pi: true,
  aider: true,
  omp: true,
} as const satisfies Record<Exclude<AgentKind, 'unknown'>, true>;

export type HookAgentKind = keyof typeof HOOK_AGENT_KINDS_MAP;

export const HOOK_AGENT_KINDS = Object.keys(HOOK_AGENT_KINDS_MAP) as readonly HookAgentKind[];

// Cast-free narrow for argv validation (hookAgentFromArgv): a present-but-invalid
// `--agent` value fails this guard instead of being coerced. Object.hasOwn (NOT
// `in`) so Object.prototype keys ('toString', 'constructor', …) are rejected.
export function isHookAgentKind(v: string): v is HookAgentKind {
  return Object.hasOwn(HOOK_AGENT_KINDS_MAP, v);
}

// Snapshot written by `tg` / `tg-ctl start` at auto-start time (spec §5.2).
export interface Registration {
  paneId?: string;
  cwd?: string;
  sessionName?: string;
  registeredAt?: number; // unix seconds
  sessionKey?: string; // session registry key (session-registry-and-topics §2.4)
}

export interface TargetPane {
  pane: PaneInfo;
  agent: AgentKind;
  agentPid?: number;
}

export type DiscoverResult =
  | { ok: true; target: TargetPane }
  | { ok: false; reason: 'no-agent' | 'ambiguous'; candidates: TargetPane[] };

// --- lock/status helpers (spec §16 module 3) ---

export interface CtlPaths {
  lock: string;
  pid: string;
  offset: string;
  registration: string;
  socket: string;
  log: string;
  routes: string; // message_id→pane map for reply recognition + LRU/MRU picker
  history: string; // append-only JSONL message log for `tg replies` recall
  topics: string; // threadId→agent binding map for forum-topics mode (always allocated)
  topicHolds: string; // messages held for unknown topics until an attach-picker pick (restored on reload)
  questions: string; // durable forwarded-question state (pending/abandoned + answered-replay)
  grants: string; // late-approval grant + grace store (tg-cli#398; 0600, daemon is the ONLY authority)
  schedules: string; // durable auto-continue schedules (re-armed on restart, #113)
  overloadRetries: string; // retry-attempt state for transient overload auto-continue
  usageWarnings: string; // recent proactive usage warnings, for duplicate suppression (#132)
  usageLatest: string; // latest supported usage/rate-limit telemetry for /limit
  deferred: string; // durable defer-while-waiting backlog (restored on reload, no message loss)
  lastUserTarget: string; // pane of the CTO's own last resolved inbound delivery (tg-cli#78 anchor fix)
  usageSchedule: string; // watermark of the last week/month period reported via the /spend scheduled push (#290)
  dailyPending: string; // a /daily report whose Telegram send failed, re-delivered on the next /daily (#290)
  pendingBatch: string; // durable local journal of a not-yet-fully-processed getUpdates batch —
  // written BEFORE the offset advances so a crash between telling Telegram we have it and
  // finishing the work can never lose it; see runDaemon recovery-on-startup
  // Append-only, fsynced inbound delivery ledger keyed by (chat_id, message_id): every sink
  // checks it so a replayed message is never sent twice (tg-cli#299, delivery-ledger.ts)
  deliveryLedger: string;
  awarenessNudge: string; // durable per-agent silence-nudge state (tg-ctl#363)
  questionInbox: string; // the 📥 Inbox topic and the copy of each open question (tg-cli#705); not the Stop-hook inbox/
  runInfo: string; // which commit the running daemon loaded (pid + sha), for stale-code detection (tg-cli#279)
  sessions: string; // session registry keyed by harness session id; the daemon is its ONLY writer (#487)
  authPending: string; // `tg auth` one-time /start binding the daemon claims (docs/specs/tg-auth.md §4)
  alertSubscriptions: string; // temporary alert subscriptions of live omp sessions, keyed by omp session id (tg-cli#636)
  alertThrottle: string; // last `tg-ctl alert send` per (source,key,severity), for the dedup window (tg-cli#636)
  outbox: string; // dir of `tg` sends Telegram did not take, replayed by the daemon (tg-cli#710)
  chatgptRefs: string; // opaque one-use /chatgpt callback references (features/chatgpt/refs.ts; 0600)
}

// --- forum topics (docs/specs/session-registry-and-topics.md §4) ---

// Where a topic's binding stands.
//   awaiting-model — a flat `/new` created this private topic and its spawn is in flight
//   bound          — the topic addresses a session; messages deliver there
//   closed         — the bound session is gone; messages get a "not running" reply
export type TopicStatus = 'awaiting-model' | 'bound' | 'closed';

// One forum topic's binding to a session. Persisted as a JSON array (CtlPaths.topics),
// written by the entrypoint on every transition (same pattern as routes). The session is
// addressed by its pane locator (`%N`, or `omp:<pid>` for an omp outside tmux).
export interface TopicBinding {
  threadId: number; // message_thread_id (the topic id)
  name: string; // the session's display name (used in replies and the /new tmux window slug)
  status: TopicStatus;
  path?: string; // the session's working directory (the pane-reuse guard compares it)
  model?: string; // catalog model id, when a flat /new spawned the session
  harness?: AgentKind; // the session's harness, for the "resume with …" hint when it is gone
  paneId?: string; // the session's pane locator, set once bound
  ts: number; // unix seconds of the last transition
  // Set on an awaiting-model binding IMMEDIATELY before `tmux new-window` and dropped on bind (a
  // failed spawn drops the whole binding). It marks the CRASH-GAP state (a crash hit AFTER a
  // successful new-window but BEFORE the `bound` write — a live orphan pane may exist). Only a
  // spawnPending binding is an orphan-adoption candidate at startup (codex r7 P1); one reconcile
  // cannot adopt is dropped by the next message in its topic.
  spawnPending?: boolean;
  // A per-spawn unique token stamped into the new window's env (`TG_SPAWN_TOKEN`) and recorded here
  // BEFORE `tmux new-window`. Startup orphan adoption requires the candidate window to carry the
  // MATCHING token, so a same-slug/same-cwd STRANGER pane (or a crash BEFORE new-window ran, where
  // no window carries the token) is never wrongly adopted (codex r10 P1). Paired with spawnPending.
  spawnToken?: string;
  // The chat + message_id of the flat-chat `/new` that created this private topic (set on the
  // preliminary binding, BEFORE new-window). A crash mid-spawn leaves that `/new` in the
  // pending-batch journal, and the restarted daemon replays it AFTER startup reconcile adopted the
  // orphan: without this marker the replay would create a second topic and spawn a second agent.
  // Both halves are compared — a message id alone collides across chats (ids are per-chat).
  sourceChatId?: number;
  sourceMessageId?: number;
}

// One inbound topic message, in the form the entrypoint delivers (and the unknown-topic
// hold persists). Text is already wrapped, or verbatim for a `/cmd` / `!shell` passthrough;
// media and voice carry the Telegram file id and are downloaded/transcribed at delivery.
// `replyTo`: the message it replies to — a reply in the topic of a gone session takes the
// flat reply fallback (lineage parent or picker) instead of "not running" (tg-cli#709).
export type TopicPayload =
  | { type: 'text'; text: string; from: string; messageId: number; replyTo?: number; plain?: string }
  | {
      type: 'media';
      mediaKind: 'photo' | 'document';
      fileId: string;
      suggestedName: string; // daemon-chosen: <update_id>.<ext>
      caption?: string;
      anchor?: string; // quote anchor when the media itself is a reply
      from: string;
      messageId: number;
      replyTo?: number;
    }
  | { type: 'voice'; fileId: string; suggestedName: string; anchor?: string; from: string; messageId: number; replyTo?: number };
