# Session registry, naming and forum topics

Status: **DESIGN**, 2026-09-30. Epics #473 (M1 identity) and #476 (M4 topics). This spec replaces
`docs/specs/tg-forum-topics.md`, whose "topic = spawn a new agent" model is retired (§4.1). Builds on
merged #485 (v1.54.3: `features/tg-ctl/session-name.ts` resolver + abduco pane discovery in
`discover.ts`) and merged #483 (v1.54.1: omp-live endpoint self-heal + in-tmux send-keys fallback).
Evidence behind every "today" claim is in `docs/ROADMAP.md` ("What is broken today") and in the
linked tickets, with `file:line` citations.

Standing rules this spec implements (CTO):

- The tmux window name is the primary name and the harness title is secondary. Outside tmux, the
  harness title is the name.
- A rename updates the session and its topic in place. It never creates a new session or topic.
- omp works in and out of tmux. Claude Code (cc) and codex work in tmux only.
- Harness-specific logic lives behind harness-cli adapters (tg#16810). tg-ctl owns the
  harness-neutral parts: the registry, naming, routing and topics.

## 1. omp-telegram: what it is, what we borrow, what we reject

`omp-telegram` (npm 0.14.0, github.com/TerrifiedBug/omp-telegram) is a third-party **omp extension**.
It runs inside every omp process. A laptop-wide daemon owns `getUpdates` and hands each topic
message to the owning session through filesystem envelopes; the session's extension then calls
`pi.sendUserMessage`. omp's control API for a live TUI exists only in-process, which is why this
plugin and our own `tg-omp-live` extension (#450) both exist.

| Idea | Decision | Reason |
|---|---|---|
| Session identity = `sessionFile` > `sessionId`; pid is liveness only | **Borrow** (§2) | The pid churns on restart and resume. Keying on the pid is what makes our routes die today (#459). |
| One topic per top-level session; subagents share the parent's topic | **Borrow** (§4.2) | This is the CTO's "one topic per session". Subagents have no endpoint (`!agentId` in the omp-live extension), so the same exclusion falls out for free. |
| Re-adopt the topic on resume and post "reattached" | **Borrow** (§2.5, §4.2) | A resume must not create a second topic. |
| Topic routing fails closed: never fall back to another session | **Borrow** (§4.4) | A wrong-session injection is worse than a visible failure. |
| Doctor checks `has_topics_enabled` and warns on `allows_users_to_create_topics` | **Borrow** (§4.6) | That setting is on today and unreported, so every plain DM message opens an implicit topic that starts the spawn wizard and swallows the text. |
| Durable envelope ledger (queued → accepted, no auto-replay of uncertain) | **Defer** to M2 #299 | Exactly-once delivery is a delivery concern, not an identity concern. The topic path reuses whatever M2 ships. |
| Topic name from herdr agent / cwd, computed once at claim time | **Reject** | We need tmux-primary names and `editForumTopic` on rename (§3). omp-telegram never renames. |
| Its own `getUpdates` poller / in-extension poll fallback | **Reject** | A second poller on the same token gets 409s against tg-ctl and creates a second topic registry. |
| Auto-mirroring assistant output to Telegram | **Reject** | It duplicates the explicit `tg` reporting model. |
| herdr coupling (spawn / auto-resume through herdr) | **Reject** | Our multiplexer is tmux (+ abduco via `rig omp run`). Resume goes through `rig`. |
| Installing omp-telegram next to tg-ctl | **Reject** | It uses the same bot token (409) and is omp-only, with no cc or codex support. |

## 2. Session registry

### 2.1 Entry and key

There is one store, `tg-ctl.<bot>.sessions.json` (path in `features/tg-ctl/lock.ts`). The daemon is
its **only writer**, using an atomic tmp+rename like the other stores. `tg` reads it and never
writes it.

```ts
type SessionKey = `${Harness}:${string}`          // "omp:<sessionId>", "cc:<session_id>", "codex:<threadId>"
interface SessionEntry {
  key: SessionKey
  harness: 'omp' | 'cc' | 'codex'
  sessionId: string
  sessionFile: string | null                      // omp jsonl, cc transcript, codex rollout
  locators: {                                     // re-resolved on every scan; never identity
    pid: number | null
    tmux: { serverPid: number; paneId: string; panePid: number } | null
    durableSession: string | null                 // abduco name from `rig harness run` ($RIG_SESSION)
  }
  cwd: string
  name: { primary: string; secondary: string | null }   // resolveSessionName (#485)
  aliases: string[]                               // previous primaries, newest first, max 5
  threadId: number | null                         // §4
  topicMisses: { count: number; firstAt: string } | null   // consecutive "thread not found", §4.5
  state: 'live' | 'gone'
  firstSeen: string; lastSeen: string             // ISO
}
```

- **omp**: `sessionId` comes from the omp-live endpoint snapshot. Without an endpoint it comes from
  the session jsonl header that `omp.ts` already reads. Two sightings are the same session when their
  `sessionFile` matches, or their `sessionId` matches (omp-telegram's `sameSession`).
- **cc / codex**: the session id comes from hook payloads (`session_id`), which reach the daemon over
  the existing hook socket (`startHookServer`, JSON lines). The adapter records `pane → session_id`
  on each hook. A cc/codex pane seen before its first hook gets a **provisional** key,
  `cc:pane:<serverPid>/<paneId>/<panePid>`, or `codex:pane:…` in the same form. The first hook from
  that pane **promotes** the provisional key in place, rewriting every store reference in the same
  write.
- **Not registered**: task subagents (no endpoint, `agentId` set) and cc/codex outside tmux. The
  latter are listed in `tg-ctl status` only and answered by the #456 refusal.

### 2.2 Adapter boundary (tg#16810)

tg-ctl consumes one interface, `listLiveSessions(): LiveSession[]`, where `LiveSession` is
`{harness, sessionId|null, sessionFile|null, pid, tmux|null, durableSession|null, windowName|null,
paneTitle|null, harnessTitle|null, cwd}`. Its only implementation lives in the new
`features/tg-ctl/harness-sessions.ts`, which wraps today's `discover.ts` (panes, including the #485
abduco walk), `omp.ts` (ps/lsof + endpoints) and the hook-captured cc/codex ids. Nothing
outside that file branches on a harness name for identity. When harness-cli (`harness agents`, #377)
returns these fields, the file becomes a thin client, with no caller changes.

### 2.3 Reconcile (pure)

`features/tg-ctl/session-registry.ts` exports
`reconcile(prev: Registry, scan: LiveSession[], now, pending) → { next: Registry, events: RegistryEvent[], pending }`
(`pending`: the in-memory §3.2 rename candidates).
It is pure, and the daemon runs it on the existing snapshot tick (2 s TTL).

| Scan observation | Result | Event |
|---|---|---|
| Unknown key | new entry, `live` | `added` |
| Known key, different pid/pane | same entry, locators replaced | `relocated`; when the prior state was `gone`, the distinct variant `readopted` instead. It carries the entry's `threadId`, and its consumer posts "reattached" (§2.5). |
| Known key missing from the scan | `state: 'gone'`; locators kept for display, never for delivery | `gone` |
| Pane locator of entry A now hosts key B | A's `tmux` locator cleared; B gets the pane | `paneReused` (§2.6) |
| Name differs from stored | pending rename (§3.2) | `renamed` after the debounce |

Gone entries are kept for 30 days, so that a later resume re-adopts the topic and history, and are
then pruned. A gone entry keeps its topic, which is never deleted. The daemon posts one line into it,
`⏹ <name> — exited`. In a forum supergroup it also closes the topic (`closeForumTopic`); Bot API 9.3
private-chat topics only support edit and delete, so there the topic stays open.

### 2.4 Persistence and migration

Stores that key on a locator today switch to `sessionKey`:

| Store | Today | After | Migration (one-shot, idempotent, `schemaVersion: 2`) |
|---|---|---|---|
| `routes.json` | `paneId` (`%N` / `omp:<pid>`) + cwd | `sessionKey` + `paneId` kept as a hint | Resolve `paneId` against the first live scan; if the pane hosts exactly one registry entry and the cwd matches, set `sessionKey`. Otherwise keep the row read-only as `legacy`, used only for "that session is gone" answers, and drop it 7 days after migration. Today the store has no TTL, only the `MAX_ROUTES` FIFO cap in `routes.ts`, so without this a legacy row could live forever. |
| `registration.json` | `paneId` + cwd | `sessionKey` | Same resolution. An unresolved row is dropped and logged only when its pane is dead; a live pane (an untracked harness, or cwd drift) and the paneless slot keep theirs. Registrations are re-announced by live sessions. |
| `last-user-target.json` | `paneId` + cwd | `sessionKey` | Resolve, else drop when its pane is dead; a live pane keeps it. It is only a hint. |
| `deferred.json`, `questions.json` | `paneId` | `sessionKey` + `paneId` | Resolve or keep the pane-only form. The §2.6 guard applies at delivery. |
| `awareness-nudge.json` | `omp:<pid>` | `sessionKey` | Resolve or drop. |
| `history.jsonl` | `targetAgent` = name | new rows add `sessionKey` + `name` snapshot | Append-only, so no rewrite and no seeding. At read time, an old row joins a key through that key's current `name.primary` or its `aliases` (§3.3). |
| `topics.json` | `threadId → paneId` (spawn-wizard bindings) | `threadId → sessionKey` inside `sessions.json`; file removed | Bound rows whose pane resolves to an entry become that entry's `threadId`. Others are dropped and logged. The file does not exist on the live machine today. |

The migration runs once at daemon start, after the first trusted scan. It writes the new files first and
then deletes the old ones, and logs `migrated N/M` per store. Re-running it on migrated files is a
no-op. With no tmux server running, pane liveness is unknown: the migration completes but drops
nothing for a dead pane. An empty pane list from a live server is a flake, so the migration waits
for a later scan.

Live writers keep `sessionKey`: `tg start` re-registering the same pane and cwd keeps the row's
key, and a confirmed delivery writes the last-user target with the registry's key for its pane.
After the migration, every trusted scan re-derives a `registration.json` or
`last-user-target.json` key that is missing or names no live session. It never drops a row.

### 2.5 Resume re-adoption

When a session resumes, a new process reports a known `sessionFile`/`sessionId`. This covers
`omp --resume`, `rig omp run` restore, `claude --resume` and `codex resume`. [INFERENCE:
`claude --resume` keeps `session_id` unless `--fork-session`; the adapter must verify it, and a fork
is a new session by design.] The entry turns `live` with new locators and keeps its routes,
history, aliases and `threadId`. If the entry has a topic, the daemon keeps posting into the same
`threadId` and posts one line into it: `📂 <name> — reattached`. In a forum supergroup it first
reopens the topic (`reopenForumTopic`). Private-chat topics were never closed (§2.3), so there is
nothing to reopen there.

### 2.6 Pane-reuse guard (#354, #100)

A pane locator counts only when `(serverPid, paneId, panePid)` all match. A tmux server restart
changes `serverPid` (`#{pid}`), and a respawned pane changes `panePid`. Before any delivery through
a pane (inject, late answer, deferred), the daemon re-scans that pane and requires the hosted
session key to equal the target key. On a mismatch it does not deliver. It replies "`<name>` is no
longer in pane %N (now `<other>`)" and offers the picker. A cwd match is never enough.

## 3. Naming and rename detection

### 3.1 One resolver

`resolveSessionName` (#485) is the only name source:

- In tmux: primary = the window name, unless it is bare, then the cwd basename. Secondary = the
  harness title.
- Out of tmux: primary = the harness title → cwd basename → `omp · <sid8>`.

It feeds the `tg` header, the `/agent` picker, `tg-ctl status`, `tg replies`, question cards and
topic names. The topic title is `primary · secondary`, truncated to Telegram's 128 characters.

The harness title comes from the adapter: the omp endpoint, the omp jsonl `title`/`title_change`,
or a harness-painted `#{pane_title}`. The omp-live extension must report `pi.getSessionName()` at
status time. Today it reports `getHeader().title` [INFERENCE: stale after `/rename`].

### 3.2 Debounced rename

On each tick, `reconcile` compares the resolved name with `entry.name`. A different name becomes
`pendingName` (in memory, with a timestamp). It is committed only after it has stayed stable for
**20 s**. That absorbs omp's auto-title on first input and spinner or `π >` churn that
normalisation misses.

On commit, the entry is updated in place, the old primary is pushed into `aliases`, and a
`renamed` event is emitted. Nothing re-keys: the key is the session id.

### 3.3 History keyed by session

New history rows carry `sessionKey` plus the name snapshot at send time. `tg replies` defaults to
the caller's session key: `tg` resolves it through §4.3 `resolve-session`, or falls back to
matching locators in `sessions.json`. `--agent <name>` matches current names and aliases and
expands to keys. Old rows without a key join a key when their `targetAgent` equals that key's
current name or an alias. Non-tmux omp sends are already recorded, but untagged: `tg` passes
`currentPaneAgentName()`, which needs a real `TMUX_PANE`, so those rows fall out of the agent-scoped
default. S4 tags them with `sessionKey` (#460).

## 4. Forum topics

### 4.1 Model

In a chat with topics enabled (the private DM with threaded mode on, or a forum supergroup), **each
live registry entry gets at most one bot-created topic**. The topic is an address for an existing
session. It never spawns anything. The `forum_topic_created → awaiting-path → awaiting-model →
spawn` state machine (`topics.ts`, `tg-forum-topics.md` §4) is deleted. `/new` stays the
flat `/new` command (#186) wherever it is typed; a session it spawns gets its topic like any other.

General (no `message_thread_id`) is the **control channel**. The flat path is unchanged there:
reply routing, `/agent`, last-user-target, daemon verbs.

### 4.2 Lazy creation and re-adoption

The daemon is the **only caller of `createForumTopic`**, through `ensureTopic(key)`. That function
is serialised per key: a promise map in memory, and it returns the existing `threadId` when set. The
new `threadId` is persisted before the first send into it. A daemon crash between
`createForumTopic` and that write can leave one orphan topic. We accept that bounded case: the daemon
logs `topic created <threadId> for <key>` before the write, so the orphan can be found in the log and
closed by hand. We do not list and match topics by name. `ensureTopic` runs lazily, on the first outbound for
the entry: a `tg` send (via §4.3) or a question/permission card. Merely being seen by a scan does
not create a topic, so idle sessions do not spam topics.

- The name is the §3.1 topic title.
- A resumed entry (§2.5) reuses its `threadId`. It never creates a new topic.
- A topic that Telegram reports as deleted (`TOPIC_ID_INVALID`, or `message thread not found`
  persisting past §4.5) is recreated once per detected deletion (at most once per 24 h per entry),
  and the new `threadId` replaces the old one.
- Topics are off (`control.topics: false`, or `getMe.has_topics_enabled=false`): `ensureTopic`
  returns null and everything stays flat.

### 4.3 Outbound and cards threaded by session lookup

`tg` gets a request type on the existing hook socket, which takes JSON lines:
`{"kind":"resolve-session","tmuxPane","ancestorPids":[…],"sessionFile"?}` →
`{"key","name","threadId"}`. The daemon matches locators, calls `ensureTopic`, and answers within
1.5 s. `tg` then posts with `message_thread_id`.

- When the daemon is down or times out, `tg` posts to General with the `[name]` header, as today.
- `--topic` / `TG_TOPIC` still win when set explicitly.
- No env stamping is needed for existing sessions.
- **Detached workers (tg-cli#553).** A one-shot `omp -p --no-session` worker is not a session (§2.1)
  and a `nohup` launch reparents it to pid 1, so the ancestry the daemon matches on is gone: its `tg`
  calls, and those of tools that shell out to `tg` (the task-cli `[task created]` notifier), find no
  session and post to General. §1 says subagents share the parent's topic; the hand-off is the
  launcher's. `tg --session-topic` prints the topic of the session it runs in (the §4.3 lookup,
  creating it on the first ask; nothing, exit 0, when there is none), and a launcher run from the
  parent session exports it for the child: `TG_TOPIC="$(tg --session-topic 2>/dev/null)"`. The
  worker's sends then follow the `TG_TOPIC` rule above. A child whose launcher ran outside any
  session still posts to General; it is never guessed into another session's topic (§4.4).

Question, permission and hatch cards (`questions.ts` `buildButtonMessage`) resolve the card's
session key and add `message_thread_id` the same way. Callback handling is unchanged, because
callbacks carry message ids, not threads.

### 4.4 Inbound triage (`features/tg-ctl/updates.ts`)

Decision table, evaluated in order for a message with `message_thread_id = T`:

| # | Condition | Action |
|---|---|---|
| 1 | Daemon verb: the `TOPIC_GLOBAL_CMDS` set in `updates.ts` (`/status`, `/agent`, `/new`, `/tasks`, `/limit`, `/daily`, `/spend`) | Run it and answer **in T**, in any topic, bound or not. `/stop` and `/kill` are deliberately not in the set: in a bound topic they reach that topic's session, and in an unknown topic they go through row 4. (Motivation: today the intercept runs only in bound topics, so an unknown topic drops even `/status`.) |
| 2 | T is bound to a `live` entry | Deliver the text, voice, photo, document or album through the **same delivery function as the flat path**, `deliverToSession(key, payload)`: the omp-live bridge → in-tmux send-keys fallback (#483) → cc/codex send-keys, voice transcription, media download. Acknowledge the way the flat path does. Never fall back to another session. |
| 3 | T is bound to a `gone` entry | Reply in T: "`<name>` is not running — resume with `rig omp run --resume …`", or the harness's hint from the adapter. Do not deliver. Do not spawn. |
| 4 | T is unknown: a user-created topic, an `is_name_implicit` topic, or a topic whose binding was lost | Queue the payload for T (FIFO, 10 min from the first item; album parts and later messages join the same queue) and post the **attach picker** in T once. The queue is its own store keyed by `threadId`, persisted with the same pattern as `deferred.json` (atomic tmp+rename, restored on bootstrap, covered by the SIGTERM drain), so a daemon restart neither loses it nor skips its expiry reply. The buttons are live entries, the most recent first. Choosing entry E delivers every queued payload to E, in order. If E has no topic, T becomes E's topic and is renamed to E's title. If E already has one, T stays unbound and the reply links E's topic. When the queue expires, the bot replies "N messages not delivered — pick a session" in T. |
| 5 | `forum_topic_created` / `_edited` / `_closed` service messages | Record them only. There is no spawn wizard and no `tmux rename-window`. A user topic rename is left alone until the next session rename overwrites it (§4.7). |

No path drops a message silently. Every branch either delivers or answers in T.

### 4.5 Private-topic "thread not found"

Freshly created private-chat topics sometimes reject bot writes with `message thread not found`
(tdlib/telegram-bot-api #905). The fallback:

1. Retry once after 1 s.
2. If it fails again, post to General with the `[name]` header and increment `entry.topicMisses`
   (setting `firstAt` on the first miss of a run).
3. On the 3rd or any later consecutive miss, once at least 10 min have passed since `firstAt`, treat
   the topic as deleted: recreate it (§4.2, subject to its 24 h cap) and log. Until then, keep
   falling back.

Any successful threaded send resets `topicMisses` to `null`, clearing `firstAt`. `tg` keeps its
existing `TG_TOPIC` → General retry.

### 4.6 Doctor

`tg-ctl status` (and `tg-ctl topics doctor`) shows:

- the chat type;
- `has_topics_enabled` and `allows_users_to_create_topics` (warn when true: every non-reply DM
  message then opens an implicit topic, and §4.4 row 4 shows a picker each time);
- the count of bound, gone and missing topics;
- per-entry `threadId`.

The BotFather "disallow users to create threads" switch is a pending CTO decision (ROADMAP).
Nothing in this spec depends on it.

### 4.7 Rename → `editForumTopic`

A `renamed` event (§3.2) on an entry with a `threadId` calls `editForumTopic(name=<topic title>)`.
Calls are rate-limited per entry to one per 60 s, trailing: the latest name wins. Nothing is sent
when the title is unchanged. The reverse direction does not exist: `markRenamed`'s
`tmux rename-window` is deleted, so there is no feedback loop and no clobbering of the CTO's tmux
names.

## 5. Slices

Each slice is one PR. The file owner is the only slice that edits a file during its window;
`tg-ctl` (the entrypoint) is touched by several slices, which must land in order. S0 has landed
(#485, v1.54.3); its tickets stay open until their live proof.

| Slice | Ticket(s) | Owns | Depends on |
|---|---|---|---|
| S0 resolver + abduco discovery | #454 #455 #75 #448 (merged #485) | `session-name.ts`, `discover.ts`, `agent-match.ts` | — |
| S1 registry core + migration | **#487** (new), #67 | new `session-registry.ts`, `session-registry-store.ts`, `harness-sessions.ts`; `lock.ts`; `tg-ctl` scan + hook-socket session_id capture | S0 |
| S2 route/registration/target by session key; resume re-adoption | #459, #339 | `routes.ts`, `registration-store.ts`, `last-user-target.ts`, `omp.ts` route ids, `tg` `recordRoute`, `tg-ctl` reply routing | S1 |
| S3 pane-reuse guard | #354, #100 | `inject.ts`, `defer.ts`, `deferred-store.ts`, `tg-ctl` delivery guard | S1 |
| S4 debounced rename + history by session | #460 (+#136 lock) | `features/replies/*`, `agent-name.ts`, rename logic in `session-registry.ts`, `omp-live-extension.mjs` (title via `getSessionName`), `tg` history rows | S1, S2 |
| S5 inbound topic triage; delete spawn wizard | #457 | `updates.ts`, `topics.ts` (rewritten as triage + picker hold), `tg-ctl` topic handlers | S1 |
| S6 one topic per entry; outbound + cards threaded; re-adopt; thread-not-found | #467 | `ensureTopic` in `tg-ctl`, hook-socket `resolve-session`, `tg` lookup, `questions.ts` | S2, S5 |
| S7 topic delivery = flat delivery path | #465 | `deliverToSession` extracted in `tg-ctl`, `voice.ts` / media call sites, bound branch of `updates.ts` | S5, S6 |
| S8 rename → `editForumTopic`; delete topic → tmux | #466 | `tg-ctl` rename event consumer, `topics.ts` (`markRenamed` removal) | S4, S6 |
| S9 e2e scenarios | #468 | qa-cli scenarios + fixtures | S1 onward (each slice adds its scenario) |

Order: S0 → S1 → (S2 ∥ S3 ∥ S5) → S4 → S6 → (S7 ∥ S8). M4 slices (S5–S8) start after the M1 exit
(ROADMAP), but S5 may land early: it only removes behaviour and adds replies.

Acceptance per slice (on top of each ticket's criteria; every slice ends with a live qa-cli proof,
per the ROADMAP definition of done):

- **S1**: every live tmux omp/cc/codex session and every out-of-tmux omp appears once in
  `sessions.json`. Abduco omp carries both a tmux locator and a `durableSession`. Running the
  migration twice on a copy of `~/.config/tg-cli` gives byte-identical output.
- **S2**: after a `rig omp run --resume` restart, a reply to a pre-restart message reaches the same
  session (same key, new pid) with no picker. Logs show no "routing to live parent … same project".
- **S3**: `tmux kill-server`, then a new server whose `%0` hosts a different session: a late answer
  addressed to the old `%0` is refused with the named reply. Nothing is typed into the new pane.
- **S4**: rename a tmux window and `/rename` an omp session. Within 20 s the header, picker, status
  and `tg replies` show the new name, and `tg replies` still shows the pre-rename rows in one
  session. `/agent <oldname>` still matches through aliases.
- **S5**: a message in a user-created topic gets a picker, not a path prompt. After a pick it is
  delivered exactly once. `/status` works in any topic. No code path returns `[]` for a topic
  message without replying.
- **S6**: the first `tg` send from an existing session creates exactly one topic, and later sends
  and its cards land there. Restarting the session reuses the topic and posts "reattached". Two
  concurrent first sends create one topic.
- **S7**: voice, a photo and text sent in the topic of (a) an omp in tmux with no endpoint, (b) an
  omp out of tmux with an endpoint, and (c) a cc in tmux all arrive once in the right session.
- **S8**: a tmux rename edits the topic title once within 80 s. Renaming the topic in Telegram
  changes no tmux window name.

## 6. Test plan

**Unit (pure, `tests/*.test.ts`)**

- `reconcile`: every row of the §2.3 table, provisional → promoted key, gone → readopted, and the
  pane reused by another key.
- Migration: fixtures of today's store shapes. It must be idempotent, and unresolved rows must end
  up `legacy` or dropped exactly as §2.4 says. A legacy route is dropped 7 days after migration.
- Rename debounce: a flip-flop inside 20 s commits nothing; a stable change commits once; aliases
  are capped at 5.
- Triage: the §4.4 decision table, including the verb in an unknown topic, a gone entry, hold
  expiry, and a pick onto an entry that already has a topic.
- `ensureTopic` serialisation.
- The §4.5 miss counter: a burst of 3 within 10 min does not recreate, a later miss does, success
  resets `firstAt`, and a second deletion within 24 h is not recreated.
- The unknown-topic queue survives a daemon restart and still sends its expiry reply.

**Integration (existing `tests/ctl-*-integration.test.ts` style: fake Bot API, real tmux)**

- An abduco-wrapped omp fixture keeps its identity across `abduco` detach/attach and an omp
  restart.
- Media and voice in a bound topic reach the omp-live fixture endpoint and the tmux fixture pane.
- A `thread not found` fake for a new topic triggers the General fallback and then the recreate.
- Existing topic-wizard tests are deleted with the wizard. Tests that pin `topics.json` shapes are
  rewritten against `sessions.json`.

**qa-cli live e2e (#468)**, against the real bot and fixture sessions (omp in tmux, omp in tmux via
abduco, omp outside tmux, cc in tmux, codex in tmux, cc outside tmux):

1. Identity: each fixture appears once in status with the §3.1 name. cc outside tmux gets the
   "run it in tmux" reply.
2. Rename: tmux rename + omp `/rename` → the header, picker, `tg replies` and topic title follow,
   with no new topic.
3. Restart and resume of each omp fixture: the same topic, "reattached", and a reply to an old
   message is delivered.
4. Topics: first send → one topic; card threaded; voice, photo and text in the topic delivered once;
   a user-created topic → picker → delivered; `/status` in a topic; a message in the General
   thread takes the flat path.
5. Pane reuse: a tmux server restart → no delivery to the wrong pane.

Each slice's PR adds its scenario to the qa-cli suite, and the ticket is closed with that run's
evidence.
