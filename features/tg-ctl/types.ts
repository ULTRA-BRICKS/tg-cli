// Shared contract for the tg-ctl feature modules (spec §16).
//
// Everything in features/tg-ctl/ is PURE — no I/O. The tg-ctl entrypoint owns
// real spawns, fetch, ffi flock and file I/O, and feeds these modules plain
// data. Tests construct the same data by hand.

import type { TaskViewFilter, TasksCallbackKind } from './tasks-command';

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
  // `{id}` renders the inbound Telegram message_id as `#<id>` — the agent passes
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
  | { kind: 'inject-text'; text: string; messageId: number } // already wrapped, OR verbatim passthrough (`/cmd` or `!shell`)
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
  | { kind: 'reply-route'; replyToMessageId: number; injectText: string; from: string; messageId: number }
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
    }
  | {
      kind: 'close-question-card';
      callbackQueryId: string;
      requestId: string;
      messageId: number | null;
    }
  | {
      kind: 'post-timeout-question-reply';
      requestId: string;
      questionMessageId: number;
      text: string;
      from: string;
      messageId: number;
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
      messageId: number; // inbound Telegram message_id → surfaced as `#<id>` for tg --reply-to
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
      messageId: number; // inbound Telegram message_id → surfaced as `#<id>` for tg --reply-to
      // Set when the voice note itself is a reply: route via reply-route with
      // this quote anchor prepended (built from the replied-to message).
      replyToMessageId?: number;
      replyAnchor?: string;
    }
  // --- forum topics (docs/specs/tg-forum-topics.md) ---
  // A new topic was created → start the per-topic /new flow (ask path, then model).
  | { kind: 'topic-new'; threadId: number; name: string; from: string }
  // A user message inside a topic still in the /new flow → feed the path answer (a working
  // directory) to the state machine. `text` is the raw user text (the path the user typed).
  | { kind: 'topic-answer'; threadId: number; text: string; from: string; messageId: number }
  // A tap on a model button (tgm:<threadId>:<modelId>) inside an awaiting-model topic → spawn
  // the agent with that model. callbackQueryId answers the tap; messageId is the prompt message
  // (carried for editMessageReplyMarkup that clears the buttons on bind — increment 4).
  | { kind: 'topic-model'; callbackQueryId: string; threadId: number; modelId: string; messageId: number | null }
  // A tap on a recent-path button (tgp:<threadId>:<index>:<nonce>) inside an awaiting-path topic →
  // resolve the index against the binding's persisted pathChoices (only if the nonce matches the
  // binding's pathChoicesNonce — else a stale button) and advance like a typed path. callbackQueryId
  // answers the tap; messageId is the prompt (its keyboard is cleared on advance).
  | { kind: 'topic-path'; callbackQueryId: string; threadId: number; index: number; nonce: number; messageId: number | null }
  // A tap on a re-spawn button (tgr:<threadId>) for a topic whose pane died → re-launch the
  // agent with the retained path + model and re-bind. callbackQueryId answers the tap.
  | { kind: 'topic-respawn'; callbackQueryId: string; threadId: number; messageId: number | null }
  // A user message inside a BOUND topic → inject into that topic's pane. injectText is already
  // wrapped for prose, OR verbatim for a `/cmd`/`!shell` passthrough (never re-decorate it); the
  // entrypoint maps threadId→paneId and threads the ack with threadId.
  | { kind: 'topic-route'; threadId: number; injectText: string; from: string; messageId: number }
  // A user message inside a CLOSED topic (its pane died earlier) → the entrypoint offers a
  // one-tap re-spawn (retained path + model) instead of a silent dead-end (increment 4). Carries
  // the wrapped text + messageId so that if a SAME-BATCH re-spawn tap already re-bound the topic
  // before this action runs, the entrypoint routes the message to the now-live pane instead of
  // dropping it (codex r9 #1). injectText is empty for a media-only message (offer only).
  | { kind: 'topic-dead'; threadId: number; injectText: string; messageId: number }
  // Topic closed / reopened service messages → mark the binding (entrypoint persists).
  | { kind: 'topic-close'; threadId: number }
  | { kind: 'topic-reopen'; threadId: number }
  // Topic renamed service message → persist new name + update the tmux-window slug.
  | { kind: 'topic-rename'; threadId: number; name: string }
  // --- flat-chat /new command (issue #27; NON-topic) ---
  // A `/new [<harness>|<model>] [<dir>] name [<task>]` slash command in the flat chat → start
  // the interactive new-session flow (ask dir, then harness/model, then spawn). All parts but
  // `name` are optional; omitted model/dir are picked via inline buttons. Distinct from topic-new
  // (which is keyed to a forum threadId) — a flat /new carries no thread, so the entrypoint mints
  // a token.
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
  | { kind: 'verify-pane'; paneId: string } // entrypoint re-checks agent still in pane
  | { kind: 'tmux'; argv: string[]; stdin?: string } // tmux command; stdin for load-buffer -
  | { kind: 'sleep'; ms: number };

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
  awarenessNudge: string; // durable per-agent silence-nudge state (tg-ctl#363)
  runInfo: string; // which commit the running daemon loaded (pid + sha), for stale-code detection (tg-cli#279)
}

// --- forum topics (docs/specs/tg-forum-topics.md) ---

// Where a topic is in the per-topic /new lifecycle.
//   awaiting-path  — created; asked for the working directory
//   awaiting-model — got a path; asked for the model
//   bound          — agent spawned + pane bound; messages route here
//   closed         — topic closed or its pane died; re-attaches on reopen/next message
export type TopicStatus = 'awaiting-path' | 'awaiting-model' | 'bound' | 'closed';

// One forum topic's binding to an agent. Persisted as a JSON array (CtlPaths.topics),
// written by the entrypoint on every state transition (same pattern as routes).
export interface TopicBinding {
  threadId: number; // message_thread_id (the topic id)
  name: string; // the topic name (used for the tmux window slug + display)
  status: TopicStatus;
  path?: string; // chosen working directory (set at awaiting-model)
  model?: string; // chosen model id from the catalog (set at spawn)
  paneId?: string; // the spawned tmux pane ("%N"), set at bound
  ts: number; // unix seconds of the last transition
  // The recent-repo paths OFFERED as awaiting-path buttons (increment 4). Persisted so a
  // `tgp:<threadId>:<idx>` button tap recovers the chosen path by INDEX — callback_data is
  // capped at 64 bytes, far too small for an absolute path, and recomputing the candidate
  // list at tap time could drift if a new route was written meanwhile. Cleared once the path
  // is chosen (it is only meaningful while awaiting-path).
  pathChoices?: string[];
  // The nonce embedded in this prompt's path buttons (the offering binding's ts). A `tgp` tap must
  // carry a matching nonce or it's a STALE button from a superseded prompt (e.g. after a setup
  // restart replaced pathChoices) — the entrypoint rejects the mismatch rather than resolving the
  // index against the wrong list (codex r3 P1). Paired with pathChoices; cleared with it.
  pathChoicesNonce?: number;
  // True once a re-spawn button has been offered for this (closed) topic (increment 4). Stops a
  // burst of messages to a dead topic from posting an offer PER message — the offer is sent once,
  // then further messages are quietly acked until the user taps Re-spawn (which clears the flag by
  // re-binding) or recreates the topic. Only meaningful while status === 'closed'.
  respawnOffered?: boolean;
  // Set on an awaiting-model binding IMMEDIATELY before `tmux new-window`, cleared on spawn
  // failure, and dropped on bind. It distinguishes the CRASH-GAP state (a crash hit AFTER a
  // successful new-window but BEFORE the `bound` write — a live orphan pane exists) from a normal
  // awaiting-model (model chosen, never spawned) or a FAILED spawn (window never created). Only a
  // spawnPending binding is an orphan-adoption candidate at startup, so a failed spawn + restart
  // can't bind the topic to an unrelated same-slug/cwd pane (increment 4 / codex r7 P1).
  spawnPending?: boolean;
  // A per-spawn unique token stamped into the new window's env (`TG_SPAWN_TOKEN`) and recorded here
  // BEFORE `tmux new-window`. Startup orphan adoption requires the candidate window to carry the
  // MATCHING token, so a same-slug/same-cwd STRANGER pane (or a crash BEFORE new-window ran, where
  // no window carries the token) is never wrongly adopted (codex r10 P1). Paired with spawnPending.
  spawnToken?: string;
}
