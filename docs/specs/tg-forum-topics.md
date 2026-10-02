# tg-ctl — Telegram forum-topics mode (one topic = one agent)

Status: **DRAFT design** (CTO 2026-06-19 "делай"). Implemented incrementally — see
§9 Increment plan. Supersedes the flat `/agent` phonetic selector as the primary
addressing model when Telegram topics are available. Forum-supergroup routing stays
opt-in; private-chat `/new` topics are attempted by default through Bot API
`createForumTopic`.

## 1. Goal

Each background agent lives in its **own Telegram forum topic** (`message_thread_id`).
The topic IS the address — no phonetic disambiguation. Concretely:

- **Creating a topic spins up an agent.** In a forum supergroup, a `forum_topic_created`
  service message starts a per-topic `/new` flow that asks the working **PATH** and the
  **MODEL**, then launches a fresh agent (`claude --model <model>` in `<path>`, in its own
  tmux window) bound to that topic. In a private chat, the flat `/new` flow asks Telegram to
  create the topic via `createForumTopic` before spawning, then binds the returned
  `message_thread_id`.
- **Routing is per-topic.** An inbound message carrying `message_thread_id = T` injects into
  topic `T`'s bound pane; that agent's `tg` replies post back **into the same topic** T.
- The legacy flat-chat behaviour (`/agent`, reply-routing, `/status`, …) is unchanged for
  messages without `message_thread_id`; `/new` only upgrades to a private topic when
  `createForumTopic` succeeds.

## 2. Why forum topics (vs the flat `/agent` picker)

The flat selector fuzzy-matches a window name out of an ambiguous pool and re-asks on every
collision. A forum topic is a **durable, unambiguous, user-visible address**: the binding is
created once (on topic creation), Telegram renders each agent as its own thread, and the user
never disambiguates. It also gives each agent an isolated transcript.

## 3. Telegram surface used

- **Forum-supergroup topics** require the chat to be a **forum** (supergroup, `Topics`
  enabled). The bot must be an admin with `can_manage_topics` to create/close topics; it can
  always *post into* an existing topic with `message_thread_id`.
- **Private-chat topics** use Bot API 9.4 `createForumTopic(chat_id, name)` in the normal
  user-bot chat. No special forum supergroup is required for this path, and BotFather is not
  a hard prerequisite for creation; if Telegram rejects the API call, the daemon falls back to
  a flat `/new` spawn.
- **Service messages** (read-only, delivered as `message`): `forum_topic_created`
  (`{ name, icon_color?, icon_custom_emoji_id? }`), `forum_topic_edited`, `forum_topic_closed`,
  `forum_topic_reopened`. Each carries `message_thread_id` = the topic's id (== the id of the
  topic's first message).
- **Posting into a topic**: `sendMessage(..., { message_thread_id: T })`. Replies emitted by
  topic-bound agent actions MUST carry `message_thread_id: T` or they land in General; daemon-global
  command replies follow their own daemon action contract.
- **Inbound**: a user message in topic T arrives as a normal `message` with
  `message_thread_id: T` and `is_topic_message: true`.

## 4. Lifecycle / state machine (per topic)

A topic moves through a small pure state machine (`features/tg-ctl/topics.ts`):

```
(none) --forum_topic_created--> awaiting-path
awaiting-path --user sends a path (or picks a recent-repo button)--> awaiting-model
awaiting-model --user picks a model button--> spawning --(pane up)--> bound
bound --forum_topic_closed / agent death--> closed   (re-open re-binds or re-spawns)
```

- **awaiting-path**: the bot posts (into topic T) "Which directory should this agent work in?"
  with inline buttons for recent/known repos (from the routes/registration history) + a
  free-text fallback ("or send an absolute path").
- **awaiting-model**: "Which model?" buttons — the model catalog (see §6). Default highlighted.
- **spawning**: the entrypoint runs `tmux new-window` (see §5); on success → `bound`, else an
  error is posted into the topic and the state returns to `awaiting-model` (retry).
- **bound**: `{ threadId, paneId, path, model, name }` persisted; messages route here.
- **closed**: binding retained but marked closed; a `forum_topic_reopened` or a new message
  re-attaches (re-spawn if the pane is gone).

The state machine is PURE: `(topicState, inbound|callback) -> { nextState, action? }`. The
entrypoint owns the spawn, the sendMessage, and persistence.

## 5. Spawning (the new capability)

The daemon has only ever *attached* to existing panes; topic-mode adds **spawning**. On
`spawning`:

```
tmux new-window -t <session> -n <topic-name-slug> -c <path> -P -F '#{pane_id}' \
  -- claude --model <model>
```

- `-P -F '#{pane_id}'` returns the new pane id → bound to the topic immediately (no discovery
  race). `-c <path>` sets the cwd. The agent command mirrors how a human starts the agent
  (`claude --model …`); other kinds (codex/opencode) are a follow-up via the model catalog's
  `kind`.
- The window name is a slug of the topic name (so `/agent` still works as a fallback address).
- Guardrails: `<path>` must exist and be a directory (else re-ask in `awaiting-path`); the model
  must be in the catalog; refuse to spawn a second pane for an already-`bound` topic.

## 6. Model catalog

A small declared catalog `features/tg-ctl/models.ts` (pure data) → the `awaiting-model`
buttons and the spawn command. Each entry: `{ id, label, kind: 'claude'|'codex'|'opencode',
argv: (path) => string[] }`. v1 ships the claude tiers (opus/sonnet/haiku) + a "default"
(no `--model`); codex/opencode entries land when their spawn recipe is verified. The catalog
is the single source of truth for both the buttons and the spawn argv (no drift).

## 7. Persistence

A new state file `topics` (added to `CtlPaths`): a JSON array of `TopicBinding`
`{ threadId, paneId, path, model, name, status, ts }`, written by the entrypoint on every
transition (same pattern as `routes`). On daemon restart the bindings reload; a binding whose
pane is gone is re-spawned on the next message (or marked `closed`). Capped like routes.

## 8. Routing changes (updates.ts)

`stepUpdates` gains, BEFORE the existing flat-chat dispatch:

- `message.forum_topic_created` → `{ kind: 'topic-new', threadId, name, from }` (start the flow).
- `message.message_thread_id` present AND topic is `bound` → route the (wrapped) text to that
  topic's pane via a `{ kind: 'topic-route', threadId, injectText }` action (the entrypoint maps
  `threadId → paneId`). Replies/acks for it carry `message_thread_id`.
- `message.message_thread_id` present AND topic is `awaiting-*` → feed the path/model answer to
  the state machine (`{ kind: 'topic-answer', … }`).
- `forum_topic_closed`/`reopened` → `{ kind: 'topic-close'|'topic-reopen', threadId }`.
- No `message_thread_id` (General / non-forum) → the existing behaviour, untouched.

Outbound threading: the entrypoint threads every topic-originated reply with
`message_thread_id`. The `tg` send side learns a `--topic <T>` / `TG_TOPIC` so an agent's
replies thread correctly even though `tg` runs from the pane (the binding supplies T; the agent
need not know it — the daemon stamps the route with the threadId and `tg`'s reply path reads it,
mirroring how `routes.cwd` already flows).

## 9. Increment plan (ship small, each green + reviewed)

> Note: the items below are listed in **landing order** (1 → 3 → 2 → 4), NOT renumbered — the
> routing half (3) shipped before the spawn executor (2) because routing carries no agent-launch
> risk and is independently testable against a seeded binding. The numbers are the original plan ids.

1. **Foundation (pure core + tests)** — LANDED (2157f09): `types.ts` (thread/forum fields +
   `TopicBinding` + topic Actions), `features/tg-ctl/topics.ts` (binding store parse/append/lookup
   + the pure state machine), `features/tg-ctl/models.ts` (catalog), `stepUpdates` recognising the
   topic updates and emitting the new Actions, full unit tests. The pure layer only — the entrypoint
   did not yet consume the Actions (dead-wired behind a not-yet-existent `control.topics` flag).
3. **Per-topic routing + outbound threading (routing half)** — LANDED: the `control.topics` config
   flag (default OFF for forum-supergroup routing), default-on `control.private_topics`, and the
   `topics` state file (`CtlPaths.topics`); the poll loop passes
   `topicsEnabled = topics || privateTopics` plus `topicStatusOf` into `stepUpdates`;
   `executeAction` handles `topic-route` (map
   `threadId → paneId` from the store, re-verify the pane still hosts an agent, inject the wrapped
   text with the flat path's defer-guard — a dead/missing pane marks the binding `closed` and posts
   an error INTO the topic, never leaking to a flat agent) and `topic-close`/`topic-reopen` (persist
   the transition). All topic-originated daemon output carries `message_thread_id`. Integration test
   `tests/ctl-topics-integration.test.ts` proves: 1:1 routing unchanged (flag off AND on), topic
   routing into the bound pane, and the dead-pane no-leak + threaded error.
   **`tg --topic` (the agent's own `tg` reply threading) — LANDED (increment 2):** the OUTBOUND
   `tg` send learned a `--topic <id>` flag and a `TG_TOPIC` env fallback (the flag wins). When set,
   EVERY outbound primitive (sendMessage/sendRich/sendPhoto/sendDocument/sendMediaGroup) carries
   `message_thread_id` — NOT consumed after the first message, so a >4096 split and album items all
   stay in the topic. With neither flag nor env the wire payload is byte-identical to before (the
   1:1 path is untouched). The `TG_TOPIC` env is **ADVISORY** (an agent shell can inherit a stale
   value): a malformed value is logged and ignored (posts to General), and a well-formed but
   server-REJECTED value (closed/deleted topic, non-forum chat → `message thread not found` /
   `TOPIC_CLOSED`) makes the send retry ONCE without the thread id rather than hard-fail — so a
   daily-critical send never dies because of a stale ambient default. An EXPLICIT `--topic` stays
   strict: the agent asked for that topic, so a rejection surfaces as a real error. The DAEMON
   auto-stamping `TG_TOPIC` into the spawned window's env (so the agent need not pass `--topic`)
   LANDED in increment 4 (`new-window -e TG_TOPIC=<id>`); the advisory fallback above keeps that
   ambient default safe against a since-closed topic.
2. **Spawn + bind executor (the remaining seam)** — LANDED: the entrypoint handles
   `topic-new`/`topic-answer` plus a new `topic-model` model-button callback. `forum_topic_created`
   → an `awaiting-path` binding + a "which directory?" prompt; a path message → validated (must
   exist + be a dir) → `awaiting-model` + the model-catalog button keyboard
   (`tgm:<threadId>:<modelId>`); a model tap → `tmux new-window -c <path> -P -F '#{pane_id}' -- <argv>`
   (the catalog argv) → bind the returned pane → `bound` + a confirmation into the topic. SAFETY: every
   spawn step is exception-guarded so a bad path / missing tmux / spawn error never throws into the poll
   loop — it posts a human-readable error into the topic and leaves the binding mid-flow for a retry;
   an already-`bound` topic refuses a second spawn (a duplicate `forum_topic_created` is already filtered
   in `stepUpdates`, so a restart/dup can't double-spawn); forum-supergroup spawn flow only runs when
   `control.topics` is on (default OFF → 1:1 byte-identical), while private-chat `/new` attempts
   `createForumTopic` by default and falls back flat if it is rejected. Tests:
   `tests/ctl-topic-spawn-integration.test.ts` (valid
   spawn, malformed path, spawn failure survives, no double-spawn, flag-off no-op) + the pure
   parser/keyboard/callback-emission units in `tests/ctl-topics.test.ts`. (The recent-repo path
   buttons and re-spawn-on-dead-pane were deferred to increment 4 — now LANDED, see below.)
4. **Lifecycle polish — LANDED.** All increment-4 items shipped together:
   - **Recent-repo path buttons** on the awaiting-path step (`tgp:<threadId>:<index>:<nonce>`): the
     prompt offers recent project cwds (from the routes store + per-pane registrations, newest-first,
     deduped to absolute existing dirs) as one-tap buttons; the chosen list + a per-prompt NONCE are
     persisted on the binding so a STALE button from a superseded prompt is rejected (never resolves
     its index against a newer choice list). Free-text remains a fallback.
   - **Model keyboard cleared on bind** via `editMessageReplyMarkup` (and on a restart-to-path) so the
     stale buttons can't be re-tapped.
   - **Re-spawn on a dead/closed pane**: a message to a topic whose bound pane died marks it `closed`
     and offers a one-tap **Re-spawn** button (`tgr:<threadId>`) that re-launches with the retained
     path + model (else restarts the /new flow when the path/model is missing or the dir vanished).
     The offer is THROTTLED (one per dead topic, `respawnOffered`), only stamped when the button send
     succeeds, and a re-spawn failure restores `closed` so the next message re-offers.
   - **DAEMON auto-stamps `TG_TOPIC`** into the spawned window's env (`new-window -e TG_TOPIC=<id>`)
     so the agent's plain `tg "reply"` threads back into the topic without `--topic`.
   - **Crash-window orphan reconcile** on startup: a binding stuck `awaiting-model` after a crash
     between `new-window` and the `bound` write is RE-BOUND to its live orphan pane (no second spawn)
     — proven by a per-spawn token stamped as a `@tg_spawn_token` WINDOW USER OPTION (queryable via
     `#{@tg_spawn_token}` in the pane format; `new-window -e` process env is NOT queryable later),
     with the recorded paneId as a fallback proof. Adoption requires same slug + same cwd + (token OR
     recorded paneId), so a same-slug/cwd STRANGER is never adopted; only `awaiting-model + path +
     model + spawnPending` bindings are candidates (a normal pre-model or failed-spawn state is not).
     A flaky/empty startup snapshot is skipped (never mass-closes live bindings); a model tap on a
     still-`spawnPending` binding re-probes (the just-in-time adoption) so a missed startup reconcile
     can't double-spawn. A `bound` binding whose pane is gone is marked `closed`.
   - **Same-batch races**: a re-spawn tap + a text message in one getUpdates batch routes the text to
     the re-bound pane (not dropped); a second same-batch message to a just-closed topic goes through
     the throttled recovery, never the old "recreate the topic" dead-end.
   Residual (accepted): a daemon crash in the sub-ms gap between `new-window` returning and the token
   stamp leaves an orphan with neither a token nor a recorded paneId — bounded by the JIT re-probe and
   astronomically unlikely; a stranded orphan is recoverable by hand.

## 10. Edge cases / decisions

- **Not a forum / no admin rights**: topic-mode silently inert; flat `/agent` stays the address.
  A `forum_topic_created` in a chat where the bot lacks `can_manage_topics` still binds on the
  *first user message* (the bot can post into an existing topic without managing it).
- **Path doesn't exist / not a dir** → re-ask, never spawn into a bad cwd.
- **Agent dies** → next topic message re-spawns (status posted into the topic).
- **Two messages during `spawning`** → queued; the second injects once `bound` (no double-spawn).
- **Staleness / sender allow-list / at-most-once offset** semantics are unchanged — topic updates
  ride the same `stepUpdates` offset discipline.
- **Security**: spawning runs `claude` in a user-chosen path — same trust boundary as the human
  starting it; the sender allow-list still gates who can drive the bot.

## 11. Closed parity items

- **Reply quote-anchor.** Closed: topic replies use the same quote anchor as the flat path when
  the message is prose. Agent-local slash commands such as `/stop`, `/kill`, and `/compact` still
  route verbatim to the topic agent.
- **Daemon-level slash commands inside a topic.** Closed: daemon-global verbs (`/status`, `/agent`,
  `/new`, `/tasks`) are intercepted by the daemon even when sent inside a bound topic; they are not
  injected into the topic's agent. Only agent-local slash commands are injected into the topic's
  agent.
- **Topic rename name persistence.** Closed: `forum_topic_edited` emits `topic-rename`; the
  entrypoint persists `TopicBinding.name` and renames the tmux window.
