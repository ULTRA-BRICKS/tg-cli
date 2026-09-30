# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.54.5

**Live Telegram e2e harness (#468): `bun scripts/e2e-telegram.ts`.**

- Sends as the CTO from qa-cli's headless Telegram Web client (`qa telegram chat`,
  qa-cli#28) to the live bot — never a second poller — against fixture sessions it
  creates and removes itself: omp in tmux, Claude Code in tmux, omp outside tmux (abduco
  pty), optionally codex. Asserts delivery into the intended fixture (tmux scrollback,
  omp/cc transcript) and the fixture agent's `tg` reply for `/agent` routing, reply
  routing, the `/agent <name>` select card and its Cancel button, a voice/audio note
  through local Whisper, and an AskUserQuestion card tapped in the client. Topic routing
  is reported as skipped until M4.
- Every harness message is a Telegram reply to a main-chat message: with the bot's
  threaded mode on, a client message that is not a reply opens a new topic and starts the
  spawn wizard (observed live 2026-09-29).
- Fixture `/agent` selectors are random and rejected when `matchWindows` would match any
  live window, cwd or omp title, so a test message can never resonate into a real
  session; the CTO's last-user-target anchor is restored when the run moved it onto a
  fixture and left alone when he routed elsewhere meanwhile.
- `--dry-run` runs the preflight only (daemon running, Telegram Web login, binaries,
  selectors, Claude account); a missing login exits 3 with the one command to run.
  Reports land in `~/.cache/tg-cli-e2e/<run>/report.json` plus `chat.png`.

## 1.54.4

**Merged means running: stale-daemon detection, verified restarts, auto-restart on deploy
(#279, #438); docs/status drift and dead ACP code (#469).**

- The daemon records which commit it loaded (`tg-ctl.<botid>.run.json`). `tg-ctl status`
  prints a `code:` line — `current`, `checkout at … — no daemon code changed`, or
  `STALE — daemon runs X but <checkout> is at Y` with the fix — so a merged-but-not-restarted
  fix is visible (it sat inert for weeks before).
- `tg-ctl stop` / `restart` find the daemon through the same launchd → flock holder → pidfile
  chain as `status`: a vanished pidfile no longer makes them no-op against a live daemon, and
  a live pidfile pid that does not hold the flock (a reused pid — including one whose daemon
  died and freed the lock) is never signalled. `stop` exits 1 when the process outlives the
  SIGTERM drain; `enable` / `disable` then fail too instead of reporting success over it.
- `tg-ctl restart` is verified: exit 0 only once the old process is dead AND a successor
  holds the lock (a successor that died right after writing its pidfile does not count); it
  never launches a replacement over a still-alive daemon. A
  launchd-owned daemon comes back under its job (`launchctl kickstart`) instead of as a
  detached stray. New `--if-stale`: restart only when a daemon runs whose loaded code is not
  current (docs/tests-only merges don't bounce it).
- `scripts/deploy.sh` ends every run — including an already-up-to-date one — with
  `tg-ctl restart --if-stale`, instead of a warning; `--no-restart-ctl` opts out (the old
  `--restart-ctl` is gone), exit 3 when the restart fails. Restarts keep queued messages,
  questions and registrations (all on disk); the old "restart drops registration" warning
  was stale.
- AGENTS.md names the live launchd job (`ai.hyperide.tg-ctl`, installed by rig) next to the
  `com.agenttools.tg-ctl.tg-ctl` label `tg-ctl enable` would install, and documents deploy /
  restart. Removed the dead ACP helpers (frame codec, `session/*` builders, permission
  mapping, `omp acp` argv), the `replyOmpAcpPermission` stub and the unreachable
  `ButtonRequest.omp` branches.

## 1.54.3

**One session name everywhere; abduco-wrapped omp is a tmux session (#454, #455, #75, #448).**

- Discovery follows an abduco CLIENT in a tmux pane to the same-session abduco SERVER's
  children. A rig `omp run` session (`abduco -f -A omp-restored-<id> omp --resume …`; omp
  re-parented under a pid-1 abduco server) is now that pane's agent: a reply to its message
  routes to it instead of the false "That agent … is no longer running" picker,
  `/agent <window>` selects it, and `tg-ctl status` shows `pane %N` instead of `no tmux`.
- One pure resolver, `resolveSessionName` (`features/tg-ctl/session-name.ts`), returns
  `{primary, secondary}` for the `tg` header, the `/agent` picker, `tg-ctl status`, the
  history label and question cards. In tmux the window name is primary (bare auto-rename
  names — now also `bun`/`abduco` — fall back to the cwd project) and the harness title is
  secondary; outside tmux the harness title is primary, then the cwd project. The picker
  and status no longer overwrite the tmux window name with the omp title.
- The harness title is the omp endpoint/jsonl title, else a harness-painted tmux
  `#{pane_title}` (omp `π > …` / `π ⠹ …`, Claude Code `✳ …`), marks and spinner frames
  stripped; the host-name default and generic names (`Claude Code`) are ignored.
- `tg` never prints a literal `[no tmux]` (#448): outside tmux — or when tmux cannot
  resolve the pane — the bracket is the harness title (or the cwd project), and a title
  dropped by the content guards falls back to the project. Decision: no `--no-title`
  opt-out; the CTO asked to see the harness session name, the guards already drop an
  unfit title, and an explicit `--title` replaces it.
- `tg`'s omp-session lsof now passes `-n -P`: without them lsof reverse-resolved the
  omp's network sockets and an out-of-tmux send stalled for 20 s+ (measured live;
  0.15 s with the flags).
- The no-agent reply is one harness-neutral line ("No live agent found → not delivered.
  Run Claude Code / Codex inside tmux …; omp is reachable in or outside tmux.") instead
  of "Claude Code not in tmux", which was sent for an omp that was in tmux (tg#17036).

## 1.54.1

**OMP subagents no longer withdraw the Telegram bridge; self-heal and tmux fallback (#462, #458).**

- OMP 18.3 binds the omp-live extension factory again for every in-process task subagent,
  and each bind closed the previous owner's endpoint while the subagent itself refused to
  publish — the first task spawn permanently removed the main session's bridge
  (`endpoint_unavailable`). Only the original interactive TUI session now claims the
  endpoint; a subagent's bind, start, turns and shutdown never touch it (#462).
- The owner republishes a missing endpoint at `turn_end`/`agent_end`; a failed publish
  warns once per outage. A status probe that times out (now 1 s, was 350 ms) lists the
  host as alive-busy instead of dropping it, and a timed-out send says the text may still
  arrive instead of suggesting a reinstall. A socket error after connect is now
  `endpoint_connection_lost`, never `endpoint_unavailable`.
- An OMP in a tmux pane without an endpoint is reached by `tmux send-keys` into its own
  pane (its original TUI: no second writer, no spawn), only when the endpoint is proven
  absent; outside tmux it still fails closed. Omp reply-routes defer while the pane has an
  open forwarded question, like every tmux pane.
- `tg-ctl status` shows each live OMP's bridge state and names every one without a bridge;
  the daemon installs the omp-live extension at startup when `~/.omp/agent` exists.

## 1.54.0

**Original-process OMP delivery; no ACP history clones (#450).**

- Telegram replies, `/agent`, late grants and reminders now use an authenticated private
  Unix socket hosted by the ORIGINAL interactive OMP process. Missing or stale endpoints
  fail explicitly; no live-delivery path spawns `omp acp`, `session/load`, or `--resume -p`.
- `tg-ctl omp-live install` installs the extension; existing OMPs need a saved stop/resume
  once (verified `/reload` does not load new JS extensions in OMP 18.3).
  `omp-live status --json` exposes verified PID/session/durable-session metadata without
  bot credentials or authentication tokens. `omp-live send` supports stable request IDs.
- Bind delivery to PID + random process instance + exact session. Retries are idempotent,
  conflicting IDs reject, callbacks are serialized, and a queued receipt never claims
  that the model has read or completed a request. Native hook-based approvals stay intact.
- Stop anonymous reminder-created sessions. Old ACP question cards fail visibly rather
  than approving a different process. A cwd or title alone cannot select a grant target.
- Replace obsolete ACP child/eviction tests with original-socket tests for busy queues,
  error retention, stale identities and no-takeover; retain no-tmux routing, picker/anchor,
  durable batch recovery and late-grant regression scenarios against the real daemon.

## 1.53.3

**Install from git.hyperide.ai; CI runs on Forgejo runners.**

- README and `install.sh` install from `https://git.hyperide.ai/ultrabricks/tg-cli` (the GitHub
  repo is an archived mirror), with the same install options as the rest of the ecosystem.
- CI, CodeQL, secret-scan and the review-threads gate run on Forgejo's runners:
  `review-threads.sh` counts unresolved Forgejo review conversations, and the gitleaks
  release archive is checked against its pinned sha256 before it is unpacked.

## 1.53.2

**Fix (tg-ctl): a reply auto-rerouted to a same-project fallback (its recorded origin is gone) now surfaces a visible Telegram notice — it was previously silent.**

- Confirmed production incident (Alex escalation, 2026-09-25, point 4): `handleReplyRoute`'s
  dead-sender fallback already correctly refuses to guess when TWO OR MORE live sessions
  share the replied-to message's project directory (falls to the existing button picker,
  `tests/ctl-reply-dead-sender-integration.test.ts`), but the exactly-one-candidate fast
  path delivered the reply SILENTLY — only a server log line recorded the reroute. The CTO
  had no way to tell "delivered exactly where I replied" from "your original target died,
  I redirected this to a different, unrelated session" — exactly what happened with the
  duplicate PID 49221/77332 `omp` sessions in `/Users/ultra/tmp` today.
- The single-candidate auto-route now sends a fire-and-forget Telegram notice
  (`↩️ <project> is gone — routed to <label> instead`) after a successful delivery, using
  the same distinct-label logic (`labelFor`/`distinctLabels`) the `/agent` picker already
  uses. Never blocks or delays the actual delivery.
- Tests: `tests/ctl-reply-dead-sender-integration.test.ts`'s single-candidate case now also
  asserts the notice is sent with the expected content; the pre-existing two-candidate
  ambiguity test is unchanged (still the picker, no regression).

**Fix (tg): the `[window]` header bracket no longer silently substitutes the omp/harness session title for the real tmux window name — both now always show, separately.**

- Confirmed production incident (Alex escalation, 2026-09-25, point 5): the window-label
  resolution `getOmpSessionTitle(ompAncestorPid) || getTmuxWindow()` let a live omp
  ancestor's own session jsonl title REPLACE the tmux window name even from inside a real
  tmux pane — a message sent from a tmux window rendered e.g.
  `[Fix Missing Provisioned Skills in Rig]` (the omp session title) with no tmux window
  shown at all. The two facts are orthogonal (which tmux window vs. what the agent is
  working on this turn); conflating them silently dropped the window every time an omp
  ancestor was present.
- The `[window]` bracket is now ALWAYS the tmux window name (or its cwd-basename
  fallback), an explicit `no tmux` marker for a detached/headless omp ancestor (e.g. one
  orphaned by a tmux crash), or empty for a bare non-agent invocation — never the harness
  title. The harness/session title (renamed `getHarnessTitle`), when present, is now
  surfaced as SEPARATE additional info: a second `title: …` line on `--detect-agent`, and
  the auto `--title` default on a real send. A review finding fixed alongside this: the
  CJK/screenshot/dictionary hard-fail guards now scope to an explicit `--title` only — the
  auto harness title is silently dropped on a guard hit instead of blocking the send (the
  CTO never typed the session's own auto-generated title and cannot fix it).
- Tests: `tests/tg-omp-session-title-integration.test.ts` — a real tmux window name is
  never replaced by the omp session title (both show); a detached omp ancestor with no
  tmux shows the `no tmux` marker plus the title line; a stray-CJK harness title never
  blocks an otherwise-clean send.

## 1.53.1

**Fix (tg-ctl): serialize ACP `session/prompt` delivery per session (tg-cli#353 relapse).**

- Confirmed production bug: a Telegram reply routed to the correct live `omp` ACP agent
  session never reached it, with zero error surfaced, whenever that session was busy
  (mid-turn) when the reply arrived. Root cause: `promptOmpAcp` wrote `session/prompt` ACP
  JSON-RPC frames fire-and-forget with no per-client serialization — if a human replied a
  second time before the agent's first turn completed, `tg-ctl` wrote a SECOND
  `session/prompt` frame into the same ACP session pipe while the first was still
  outstanding. ACP `session/prompt` is one-turn-at-a-time per session — the same shape as
  the already-documented, already-relapsed tg-cli#353 "session already owned by another
  live process" wedge bug.
- `OmpAcpClient` now tracks `promptInFlightId` (the id of an outstanding, unacknowledged
  `session/prompt`) and `promptQueue` (texts waiting behind it). `promptOmpAcp` writes
  immediately when no prompt is in flight; otherwise it queues. The prompt's own JSON-RPC
  response id is now registered in `client.pending` (previously discarded entirely), so a
  real response resolves the in-flight slot and flushes the next queued text.
- The watchdog that guards against a genuinely dead pipe uses a SLIDING checkpoint: a
  session that is still provably alive (streaming `session/update` notifications past the
  timeout, or a human mid-decision on a permission) re-arms and keeps waiting instead of
  ever advancing the queue — an earlier draft of this fix advanced on "still alive" too,
  which raced a second frame into a still-busy pipe at the watchdog boundary instead of
  immediately, reproducing the identical wedge just delayed. Only a real response or
  genuine silence releases the queue slot.
- On genuine eviction (a watchdog-detected dead pipe), the client is killed and BOTH the
  in-flight text and everything queued behind it are redelivered through a fresh client,
  sequentially, so one wedge never spawns more than one replacement process. Previously
  only queued texts were redelivered, silently dropping the very message that discovered
  the wedge. (Known accepted tradeoff, not fixed here: a false-positive eviction — the
  session was genuinely still working with no ACP traffic for a full watchdog window — now
  redelivers as a duplicate turn instead of silently losing the message; a full fix needs
  an ACP-level heartbeat, out of scope.)
- An explicit ACP JSON-RPC error reply to `session/prompt` (previously silently discarded
  with zero log line) is now logged and the queue advances normally — deliberately NOT
  treated as eviction: an earlier draft did evict-and-immediately-redeliver on every error,
  which produced an unbounded, zero-backoff respawn loop for any session with a persistent
  per-prompt error (reverted after review, 2026-09-18).
- Fixed a critical id-namespace collision this fix's own new `client.pending` registration
  exposed: an inbound ACP `session/request_permission` REQUEST carries the agent's own,
  independently-counted id, which can numerically collide with `client.nextId`-assigned ids
  for OUR outbound `session/prompt`/`initialize`/`session/load` calls. The pending-response
  matcher now requires `rec.method === undefined` (a genuine JSON-RPC response never carries
  `method`) before matching on id alone — previously a colliding permission request could be
  mistaken for the prompt's own response, skipping the permission card entirely and flushing
  the next queued text into a session still actually blocked on that unanswered decision.
- Fixed a concurrent-spawn race: two Telegram replies to the same not-yet-cached session
  landing in one dispatch batch (same-target messages with no per-session resource key can
  run concurrently) previously each saw an empty client cache and spawned their own
  `omp acp`, both `session/load`-ing the identical underlying session — the double-ownership
  wedge this whole file exists to prevent, reached through concurrent first contact instead
  of a raced write. `ensureOmpAcp` now coalesces concurrent callers for the same key onto one
  in-flight spawn attempt.
- Eviction now `kill("SIGKILL")`s the wedged process and awaits its actual exit (matching
  this file's existing `spawnGuarded` convention) before spawning its replacement — the
  previous unawaited `SIGTERM` could let the fresh client's `session/load` race a still-alive
  wedged owner, reproducing the exact double-ownership wedge eviction exists to resolve.
- `writeAcp` no longer lets a write against an already-dead pipe (EPIPE / write-after-close)
  escape uncaught from a resolve/reject callback invoked synchronously off the ACP read
  loop, which could otherwise crash the daemon.
- New regression coverage: `tests/ctl-omp-acp-prompt-serialize.test.ts` (the core
  serialization fix), `tests/ctl-omp-acp-prompt-serialize-watchdog-busy.test.ts` (the
  watchdog must never advance a genuinely busy session), `tests/ctl-omp-acp-prompt-serialize-id-collision.test.ts`
  (the permission/prompt id-collision fix), and `tests/ctl-omp-acp-prompt-serialize-error-reply.test.ts`
  (a persistent ACP error must drain the queue without evict-and-respawn) — each verified to
  fail against its specific pre-fix behavior and pass against the fix.

## 1.53.0

**Feature (tg report): structured result-report subcommand, bridging `/result-report` to Telegram.**

- The `/result-report` slash-command convention (a Claude Code command backed by rig-cli's
  `rig report`) has been repeatedly expected to also push to Telegram, but it only ever produced
  a chat-visible report + an HTML file — nothing wired it to `tg`. `tg --tag report` was the
  existing "push a report to Telegram" primitive, but free-form: nothing enforced that a report
  actually carried a ticket/PR link, the user impact, and verification proof.
- New `tg report --title <text> (--ticket <id-or-url> | --pr <num-or-url>) --impact <text>
  --verify-cmd <cmd> --verify-result <result> [--evidence <text>]... [--summary <text>]...`
  (`features/cli/report.ts`, pure formatter). All five required fields (title, at least one of
  ticket/PR, impact, verify-cmd, verify-result) are enforced before anything sends; a missing
  field lists every gap at once rather than failing on the first. `--evidence`/`--summary`/
  `--ticket`/`--pr` are repeatable. `--reply-to`/`--subagent`/`--topic`/`--dry-run` pass through
  unchanged. `tg help report` / `tg report --help` / bare `tg report` all print the usage.
- The formatted body is Rich-Message HTML (`<h2>`/`<h3>`/`<p>`/`<ul>`/`<pre>`, all user text
  HTML-escaped) and re-enters the SAME send pipeline every other `tg` subcommand uses via
  `--tag report --format html` — the dictionary gate, autolink-tasks/autolink-prs, `--dry-run`,
  and every other guard apply exactly as they do to a hand-written `--tag report` send. A
  ticket/PR value that already looks like a ticket code or `owner/repo#N` is left as plain text
  for the existing autolink features to resolve; an http(s) URL is wrapped in a real `<a href>`.
- `--title` is never re-emitted as the global `--title` flag (only into the body's `<h2>`):
  routing it through the global flag hard-refused the most natural report headline shape
  (`--title "HYP-123: fix the crash"`, since `--title` values are checked for embedded ticket
  codes) and duplicated the headline on both the branded header and the body. Dropping it also
  means the header stays just the `[window] 🟢 REPORT` badge, matching every other tag-only send.
- A bare-number `--pr` value (e.g. `--pr 456`, one of the two forms `REPORT_USAGE` documents) is
  normalized to `#456` before rendering, so autolink-prs (which only recognizes the `#N` shape)
  can resolve it — previously it rendered as inert, unlinked text.

## 1.52.14

**Feature (tg-cli#398): late-approval grant protocol for expired hatch asks.**

- Expired hatch asks stay addressable for a 24h grace window (restart-safe 0600 store).
- A late Approve mints a single-use grant (`hgr-<12hex>`, bound to hook_id + operation fingerprint + cwd + the daemon-observed route), confirms on the card, and routes the consume instructions to the origin (omp ACP / Stop-hook inbox) — never through a permission menu or pane, fixing the production no-menu delivery skip.
- New client forms consume a grant: `ask --verify-grant <id> --hook <id>` (token, route-agnostic) and `--verify-grant --pull` (route-bound, no blank-route fallback), replying the standard hookSpecificOutput allow/deny JSON with requestId/approvalId at top level, exit 0 always.
- Per-request timeoutMs honored up to a 15-min cap (absent keeps the 115s/110s defaults); additive payload fields (hookId/timeoutMs/origin/operation) normalized tolerantly at both ends.
- Replaces the over-broad silent queuedDecision mechanism for hatch requests: a plain retry without a grant now re-asks with a fresh card.

**Fix (tg-cli#398 follow-up): rebase merge left a dead block referencing an undeclared `hookId`, crashing every non-hatch permission's late tap.**

- The grant protocol diverts hatch late-taps to `routeGrantNotice` before reaching the older scoped-permission reconnect-queue UI, but a leftover critical-proactive-push block (superseded by `routeGrantNotice`) still referenced `hookId`, which no declaration in scope provided. Any non-hatch permission tap that fell through to the queued-decision path threw `ReferenceError: hookId is not defined`, silently dropping its toast and card update. Removed the dead block; `liveOmpAgentForHatchRequest`/`hatchProactiveDecisionText` (now unused) removed with it.
- `handleHatchLateTap`'s deny and grant-approved card edits were missing `hatchParseMode(req)`, so a hatch card's final edit rendered its embedded HTML as literal tag soup instead of formatted text. Both call sites now thread `parse_mode: 'HTML'` like every other hatch-shaped edit in the file.

## 1.52.13

**Fix (tg-ctl reply/agent picker, live incident tg#17245): a truncated quote/preview that split an emoji mid-character made `sendMessage` fail outright with `400 Bad Request: strings must be encoded in UTF-8`, so the CTO saw "couldn't post the reply picker" instead of a picker.**

- Root cause, confirmed via `~/.config/tg-cli/launchd.tg-ctl.err.log`: a reply to a message whose origin pane was no longer visible (`reply-route: replyTo=17245 → origin omp:93571 NOT visible in snapshot → picker (2 candidates)`) built the picker text from `buildReplyAnchor`'s 60-char quote head and `buildAgentSelectMessage`'s 80-char message preview — both truncate with a raw `s.slice(0, n)` on UTF-16 code-unit count. When the cut lands between the two halves of a surrogate pair (any astral character, most commonly an emoji), it orphans a lone surrogate; `JSON.stringify` escapes that as a literal `\uD83D` (still valid ASCII on the wire), but Telegram's Bot API decodes the JSON string server-side and rejects the resulting invalid Unicode with a flat 400 that fails the WHOLE request — `sendMessage failed: 400 {"description":"Bad Request: strings must be encoded in UTF-8"}`, immediately followed by the picker's own `couldn't post the reply picker` fallback.
- New `safeSliceEnd` (`features/tg-ctl/text-util.ts`) backs a truncation cut up by one UTF-16 code unit when it would otherwise land on a lone high surrogate, so a split pair is always dropped together rather than orphaned; `truncateWithEllipsis(s, max)` wraps it as the shared cut-then-ellipsis shape used everywhere a preview/detail/cell is truncated. Wired into `buildReplyAnchor`'s quote head (`updates.ts`, via `safeSliceEnd` directly — it has a different, always-appends-`…` contract), `buildAgentSelectMessage`'s prompt preview (`agent-match.ts`), the harness-failure notification's detail line (`limits.ts`), and the `/tasks` table's title cell (`tasks-command.ts`).
- Multi-model review (Opus/Codex/GLM/Sonnet) caught two more live call sites in the SAME bug class that the first pass missed: `clampPlan`'s 3000-char cut, which feeds the ExitPlanMode plan-approval card, and `summarizeInput`'s 100-char cut, which feeds the permission-prompt question (`features/tg-ctl/hook-normalize.ts`) — both now route through the same helpers. Review also flagged that hand-copying `s.slice(0, max - 1)}…` into each of the first four files re-created exactly the duplication the fix was meant to close; `truncateWithEllipsis` now owns that shape in one place so a new truncation site can't reopen this class by hand.
- Regression tests (`tests/text-util.test.ts`, plus one per call site including the two hook-normalize sites) construct an emoji landing exactly on each cut boundary and assert the output never contains an unpaired surrogate (shared `hasUnpairedSurrogate` detector, also in `text-util.ts`); each fails on the pre-fix `.slice(0, n)` and passes after.
- `safeSliceEnd` backs up over a WHOLE run of consecutive high surrogates, not just one (review finding): `JSON.parse` doesn't validate that `\uXXXX` escapes pair up, so a hook payload's `tool_input.plan`/`.command` could in principle carry two-or-more consecutive high surrogates, and a single-step backup would land on the second one — itself still unpaired.
## 1.52.12

**Feature (tg-ctl `/agent` routing, live report 2026-09-18): fall back to the CTO's last-user-target anchor when a named `/agent <selector>` is gone, instead of dropping the message.**

- A `/agent <name> <text>` (or media-caption equivalent) whose selector matched NO live agent ANYWHERE tg-ctl can see (tmux window, live omp process, out-of-tmux process) used to just reply "no agent matching" and drop the message. Live CTO reaction, verbatim: "О хороший кейс. Если субагента нету больше надо в агента отправлять" (if the subagent no longer exists, it needs to be routed to [its parent] agent).
- tg-ctl has no session-tree / parent-pid bookkeeping for a subagent that already exited — by the time its name stops resolving, the process (and every trace of who spawned it) is gone from `ps`/tmux alike, so there is genuinely no "parent" to look up. `handleAgentRoute` and `routePrewrappedAgentMessage` (root `tg-ctl`) now fall back to the CTO's own last-user-target anchor (tg-cli#78) — the session he was last CONFIRMED talking to — when it still resolves to a live candidate, and reply explicitly: `agent '<name>' is gone — delivered to '<label>' instead (your last active session)` (or `queued for` when the anchor pane has an open forwarded question, mirroring the existing `routedReply` idiom). New pure `goneAgentFallbackReplyText` (`features/tg-ctl/agent-match.ts`).
- Deliberately does NOT also fall back to "the only agent currently live": that exact heuristic previously caused a real production misroute (the `/agent ext` → lone `rig` pane incident, guarded by `ctl-agent-nomatch-integration.test.ts` / `ctl-agent-selector-nomatch-integration.test.ts`) where a plain typo/no-match selector silently absorbed into whatever one unrelated agent happened to be running. tg-ctl cannot tell "this name is a gone subagent" apart from "this is a typo", so the fallback bar is a signal the CTO actually chose (the anchor), never a candidate count. No anchor at all (or several live candidates with no anchor hit) keeps the existing explicit "no agent matching" error.
- The text-route fallback is FLAT-chat only (`action.threadId == null`): a `/agent <gone>` typed inside a BOUND topic keeps the plain "no agent matching" error rather than reaching for the flat anchor, which may point at a completely different project's pane than the one the topic is bound to (multi-model review finding — this mirrors the function's existing "topic-originated `/agent <name>` keeps the plain hint" precedent for the select-only arm).
- The media route's photo/document `/agent <gone>` fallback (`routePrewrappedAgentMessage`) never carries topic context at all — a bound-topic message is acked by `topicActionFor` before the flat photo/document dispatch ever runs (verified: no threadId is even plumbed into this handler), so it needs no equivalent guard. Both routes now share one small `resolveGoneAgentAnchor` helper (resolve anchor, label, log) to keep the two call sites from drifting; the media route also now refreshes the tg-cli#78 anchor (`recordLastUserTarget`) on a successful fallback delivery, matching the text route (multi-model review findings).

## 1.52.11

**Fix (tg-ctl omp discovery, tg-cli#413 follow-up): recognize omp run from source (`bun --preload`) as a live agent.**

- `matchAgentCommand` (`features/tg-ctl/discover.ts`) identified an omp session ONLY by checking that argv0's basename is exactly `omp` — true for the compiled binary (`/opt/homebrew/bin/omp`), but not for a dev checkout run from source via its own JS runtime: `bun --preload <...>/scripts/omp.ts <...>/src/cli.ts`, where argv0 is `bun`. That single miss cascaded: `isOmpLiveSessionCommand` (`features/tg-ctl/omp.ts`) requires `matchAgentCommand(command) === 'omp'`, so `findLiveOmpAgents` never listed the session even after 1.52.10's tty-or-pane fix (which only helps once a process already clears this gate); `findUnreachableAgents` couldn't pick up the slack either, since `matchAgentCommand` returning `null` means the process isn't recognized as ANY agent kind. Net effect: a bun-source-invoked omp session was 100% invisible to `tg-ctl status`, the `/agent` picker, and inbound-message routing — it fell straight to the legacy "Claude Code not in tmux" bare reply. Verified live on this dev machine (a real `bun --preload .../omp.ts .../cli.ts` session, pid 73711): `tg-ctl status` showed neither an `omp (ACP):` section nor an `unreachable (not in tmux):` section for it before this fix. Likely the real root cause of the "tg-ctl can't see agent sessions" backlog complaint on machines where every live omp session is started this way rather than via the compiled binary.
- `matchAgentCommand` now additionally recognizes `base === 'bun'`: it checks `tokens[1]` (bun's own direct script/binary argument) or any value inside bun's leading run of `--preload`/`--preload=<value>` flags (bun genuinely accepts both forms; verified live) — for a token whose basename, with its file extension stripped, is exactly `omp`. This covers both real shapes: `bun --preload <...>/omp.ts <...>/cli.ts` (the real dev-checkout launcher) and `bun <tmp>/bin/omp acp ...` (a dev/test PATH shim, no flags at all). Two review rounds (Opus/Sonnet/GLM, both against a broader draft) each caught a real false-positive class from checking a wider surface: an early draft scanned every whitespace token (misclassified `bun run deploy.ts --target omp`, `bun test --grep omp`); a second draft accepted `--preload` at ANY position (misclassified `bun test --preload ./test/omp.ts` — bun's own `--preload` flag on `bun test`, pointing at an unrelated test-setup file merely named `omp.ts`). Restricting the scan to `tokens[1]` plus bun's LEADING `--preload` run only — never a later position — closes both classes at once (see bullet below for why the leading run, not just its first flag). The existing `__omp_worker_` exclusion applies identically to this shape; the daemon's own bun-invoked ACP child stays excluded from `findLiveOmpAgents` via the pre-existing, unmodified `isOmpLiveSessionCommand` acp/`--print`/`-p` checks downstream. Regression tests pin all of the above.
- `isBunOmpLaunch` scans bun's whole LEADING run of `--preload`/`--preload=<value>` flags (stopping at the first non-preload token) rather than only the first one — tolerating any ordering of chained preloads (e.g. a hypothetical future instrumentation preload alongside omp's own) without reopening either false-positive class above, since the scan still only starts when `tokens[1]` is itself a `--preload` flag.

**Fix (tg-ctl unreachable-agent discovery, PR #413 follow-up): discover a fully headless claude/codex/opencode session with no controlling tty and no tmux pane.**

- `findUnreachableAgents` (`features/tg-ctl/unreachable.ts`) required a tty map entry before treating an interactive claude/codex/opencode process as unreachable-but-visible ("drop anything with no controlling terminal"). This silently dropped a genuinely live, fully headless session (launched detached, no tty at all — e.g. under launchd/a daemon supervisor) even though delivery here never needs a tty: the whole mechanism is the Stop-hook inbox (pid/cwd/name only). `isInteractiveAgentCommand` already independently excludes headless CLI *shapes* (`--print`, `daemon`, `exec`, …) per harness, so the tty requirement added nothing but a silent drop — the same bug class PR #413 fixed for `findLiveOmpAgents`, never touched by that PR.
- `listUnreachableAgents` (root `tg-ctl`) compounded the gap with `if (ttyByPid.size > 0) { ...scan... }` — skipping the ENTIRE unreachable-agent scan whenever the host has zero usable tty entries at all, exactly the live bug scenario. Removed the guard; it now unconditionally scans, matching the sibling `listLiveOmpAgents`.
- `UnreachableAgent.tty` is now `string | null` (matching `LiveOmpAgent.tty`); `ttyByPid` is consulted only to fill this optional display field, never to gate inclusion, for the three harnesses with a per-shape headless table (claude/codex/opencode). `pi`/`aider`/`omp`/`unknown` have no such table (`ALWAYS_INTERACTIVE_SHAPE`), so a real tty remains the only signal that separates a live session from a one-shot cron/launchd invocation for them — unchanged. `describeUnreachable`/`queuedReplyText` render `tty none` for a null tty. New shared `normalizeTty` helper (used by both `unreachable.ts` and `omp.ts`) replaces a duplicated tty-sentinel ternary.
- `CLAUDE_SHAPE.headlessSubcommands` gained `mcp` (mirroring the existing `codex`/`opencode` rows): with the tty backstop gone, this per-harness table is now the ONLY thing separating a real interactive claude session from a one-shot `claude mcp serve`/`claude mcp list` — review caught it missing `mcp`, which would have made a detached `claude mcp serve` show up as a phantom unreachable agent.
## 1.52.10

**Fix (tg-ctl omp discovery, PR #405 follow-up): discover a headless omp session with no controlling tty and no tmux pane.**

- `findLiveOmpAgents` (`features/tg-ctl/omp.ts`) additionally required a tty OR a tmux pane before treating an interactive omp process as a live agent ("drop daemons with neither"). This silently dropped a genuinely live omp session started detached/headless — no terminal at all, not in tmux. `listUnreachableAgents` cannot cover the gap either, since it explicitly excludes `agent === "omp"` (that coverage is `findLiveOmpAgents`'s job). The session fell through every candidate list straight to the bare legacy `NO_AGENT_REPLY` ("Claude Code not in tmux...") even though ACP delivery (`promptOmpAcp`/`ensureOmpAcp`) needs only the process's pid/cwd, never a tty or a pane.
- Removed the tty-or-pane gate entirely: any process that already passes `isOmpLiveSessionCommand` (which already excludes workers, `omp acp` children, and `-p`/`--print` one-shots) is a genuine live session regardless of tty/pane presence.

## 1.52.9

**Feature (tg-cli#403, agent-tools#754): critical/no-timeout hatch approval mode — quiet-hours-aware reminders, reminder-message replacement, and proactive live-session delivery of late decisions.**

- `ButtonRequest` gains an opt-in `critical` flag. When a hatch/permission ask sets it, `tg-ctl ask`'s daemon round-trip no longer applies `ASK_TOTAL_TIMEOUT_MS`, and the daemon never arms its `UNSCOPED_ABANDON_MS` backstop for it either — the ask waits for a real decision no matter how long it takes, rather than reporting a timeout while the human is still deciding. Non-critical (default) hatch/permission behavior is byte-for-byte unchanged.
- While a critical ask is pending, the human gets a periodic reminder ping (`TG_CTL_CRITICAL_REMINDER_INTERVAL_MS`, default 15 min), suppressed during quiet hours (`TG_CTL_QUIET_HOURS_START_HOUR`/`TG_CTL_QUIET_HOURS_END_HOUR`, default 23:00-08:00 local) and deferred to exactly one reminder right after quiet hours end. Each new reminder deletes (or, on delete failure, edits-away) the previous one — the original request card is never touched. New pure scheduler: `features/tg-ctl/hatch-critical-reminder.ts`.
- The moment a critical decision lands — however late — it is pushed proactively into a matching LIVE omp session via `promptOmpAcp`, in addition to the existing durable-record + retry-command card text. Never attaches to (or spawns) a session `listLiveOmpAgents()` doesn't already report as live.
- New `deleteMessage` Bot API helper.

## 1.52.8

**Feat (tg-cli#402): resolve permission cards via a plain-text reply.**

- A plain-text REPLY to a PENDING or still-answerable-abandoned permission card (covers hatch
  cards, but works for any permission-kind, non-multiQuestion card) resolves it exactly like
  tapping Allow/Deny — no button tap required. Recognized tokens (case-insensitive, trimmed):
  affirmative `t/y/yes/yep/yeah/ya/ok/okay/k/go/да/ок/го` → allow; negative
  `n/no/nope/nah/stop/deny/нет` → deny (`parseDecisionReplyToken`,
  `features/tg-ctl/questions.ts`).
- Implemented by synthesizing the existing `'answer-question'` Action from the reply, with an
  empty-string `callbackQueryId` sentinel — the SAME downstream code a real button tap hits
  (`resolveButtonCallback`, the hook-socket delivery, the card edit, `flushDeferred`). No new
  Action kind. `answerCallbackQuery` now no-ops on the empty sentinel (there is no real Telegram
  callback query to acknowledge; the card's own edit is the visible feedback).
- An unrecognized reply body, or a reply to a message that isn't a currently-decidable
  permission card, falls straight through to the existing reply-route / post-timeout-question
  handling unchanged — never hijacks an unrelated reply.
- A failure branch that reports its outcome ONLY via the toast (expired / already-answered /
  mismatched card, or an omp ACP reply failure) can't rely on the empty-sentinel no-op — that
  would silently swallow the human's "yes" with no feedback at all. Those call sites now fall
  back to a plain chat reply carrying the same text (`answerCallbackQueryOrNotify`); a success
  branch that already edits the card is unaffected.
- `DECISION_REPLY_TOKENS` is built on a null-prototype object so a reply body like
  `"constructor"`/`"__proto__"`/`"toString"` can never resolve through `Object.prototype` to a
  spurious truthy value.

## 1.52.7

**Feat (tg-cli#402): render hatch approval cards as HTML.**

- `buildButtonMessage()` skips the generic heading/source/title wrapper for a hatch-permission
  request (`isHatchPermissionRequest`) and renders its `question` field verbatim with
  `parse_mode: 'HTML'` — the companion `agent-tools` change emits a structured HTML card
  (title/agent/branch/path/hook/justification up top, the rest collapsed in a
  `<blockquote expandable>`) instead of a plain-text wall.
- `parse_mode` threads through every Telegram API call site that can post or edit a hatch
  card's text across its whole lifecycle: the initial `forwardAndPostQuestion`/
  `ompPermissionSink` sends, the hook-reconnect `editMessageText` card restore, and every
  status edit that concatenates the raw HTML body onto a plain-text suffix (abandoned,
  long-outage, queued-decision recorded/delivered, a live tap) — a headless hatch request's
  process exits almost immediately, so the abandon-edit is the NORMAL path, not an edge case,
  and omitting `parse_mode` there would garble a freshly-rendered card back to literal
  `<b>`/`<code>` tags within seconds of posting (review finding).
- Each status builder's plain-text suffix is HTML-escaped (`hatchSafeStatus`) before riding
  along with the raw HTML body under the same `parse_mode: 'HTML'` — two of them embed a
  literal `="<justification>"` placeholder that would otherwise break Telegram's entity parser
  and silently drop the edit.
- Every other request kind (including plan approval) is unaffected — `parse_mode` stays unset,
  the existing "Permission request from …" wrapper stays byte-identical.
- **Deployment order:** must ship AFTER the sibling `agent-tools` PR. Shipping this first would
  have Telegram reject hatch cards outright (400) on unescaped `&`/`<`/`>` in the old plain-text
  `_question()` output.

## 1.52.6

**Fix (tg-cli omp delivery reliability): restore wedged-ACP-client eviction under fire-and-forget delivery, and fix a silent lsof timeout in live-session discovery.**

- `jsonlPathsOfPid`/`cwdOfPid` now pass `-n` to `lsof` (skip reverse-DNS hostname lookups). Without
  it, a real omp process's open API sockets made `lsof -p <pid> -Fn` take ~30s on this network —
  15x past the hardcoded 2s `LSOF_TIMEOUT_MS` — so the daemon's live-session discovery silently
  failed almost every time, and `promptOmpAcp` delivered into a disconnected ephemeral `session/new`
  instead of the live `session/load`'d one. Measured: 30.117s → 0.048s for the identical call.
- 1.52.4/1.52.5's fire-and-forget `promptOmpAcp` (tg-cli#322/#357) deleted the wedged-client
  eviction path 1.49.2/1.51.1 shipped (tg-cli#353), with no replacement — `ACP_PROMPT_TIMEOUT_MS`
  became unused dead code, and its two regression tests were deleted outright. A cached ACP client
  whose pipe stops responding was reused forever; every later prompt into it silently vanished
  while `promptOmpAcp` kept reporting `{ok:true}`. Restored the SAME 1.51.1-reviewed eviction
  predicate (no traffic since the prompt was written, no permission reply still owed), scheduled
  via `setTimeout` so it stays off the fire-and-forget critical path — no new `await` added.
- New regression test `tests/ctl-omp-acp-prompt-evict.test.ts` (recreates the deleted
  `ctl-omp-acp-prompt-evict.test.ts`, adapted to assert the new deferred eviction log line instead
  of the old awaited-call failure log line).
## 1.52.5

**Fix (tg-cli#322): fire-and-forget omp ACP delivery; journal getUpdates batches before offset advance.**

- `promptOmpAcp` writes `session/prompt` without awaiting the turn (Telegram delivery no longer blocks up to 120s).
- Daemon persists raw batches to `pending-batch.json` before advancing offset, with startup replay after crash/kill.
- Builds on #362's concurrent per-target dispatch; journal unlink runs after the batch fully completes.

## 1.52.4

**Fix (tg-cli#357): stop ACP action delivery head-of-line blocking across the agent fleet.**

- Added a per-target concurrent dispatch queue (`features/tg-ctl/concurrent-dispatch.ts`) so each
  target's actions are delivered independently instead of through one shared sequential loop.
- Reduced the per-action delivery timeout from 120s to 15s so a stuck target fails fast instead of
  blocking every other queued target.
- Topic-thread actions remain serialized per thread after the main merge.
- New regression coverage in `tests/ctl-concurrent-dispatch.test.ts`.

## 1.52.3

**Fix (ci): stop `dependency-review`'s SBOM preflight probe aborting under the runner's default `set -e`.**

GitHub Actions' default Linux runner shell is `bash -e {0}`, which combined with the
workflow's own `set -uo pipefail` aborted the preflight step's `code="$(gh api ... | awk
...)"` assignment whenever `gh api` returned a non-2xx status — including the intentional
"dependency graph disabled -> 404" path the probe exists to detect, not just transient
blips. Appended `|| true` to that one assignment so the script always reaches its own
if/else instead of aborting; no other behavior changes.

## 1.52.2

**Fix (tg-cli#369): non-reply auto-bind (tg-cli#78 anchor) now applies with 2+ out-of-tmux omp candidates.**

- `injectViaTarget`'s no-tmux-pane fallback (`found.reason === "no-agent"`) now
  consults the tg-cli#78 last-user-target anchor via a new
  `resolveLastUserTargetCandidate` helper before falling back to the agent
  picker, when 2+ live omp agents are running outside tmux and `autoBind` is
  set. Previously it picked purely by candidate count and always re-posted the
  picker for 2+ candidates, silently dropping the #78 guarantee for the
  out-of-tmux-omp case.
- New regression test `tests/ctl-omp-anchor-multicandidate.test.ts`.

## 1.52.1

**Fix (tg-cli#349): the hatch approval retention fix now also covers the raw `UNSCOPED_ABANDON_MS` backstop timer, not just socket close.**

#350's original fix made `retainAbandonedQuestion`/`expireDeadCard` retention reachable only
from `armPendingSocketClose`'s socket `'close'` handler. A separate raw `UNSCOPED_ABANDON_MS`
(110s) `setTimeout` in `forwardAndPostQuestion` also retires the same pending entry, and called
`expireDeadCard` directly — bypassing retention. A hatch request's own requesting process stays
connected for ~120s (its own hook budget), longer than the 110s default abandon window, so in
the DEFAULT production scenario the raw timer fired first while the socket was still open,
destroying the card before retention ever ran. Only the edge case where the process exited or
was killed early went through the already-fixed path.

- Extracted the retain-or-expire decision into a shared `retireAbandonedEntry`, called from both
  the socket-close handler and the raw abandon timer, so both retirement paths converge on the
  same retention check.
- New regression test reproduces the default scenario exactly: the requesting process is never
  killed and its socket never closes; only the raw backstop timer (shrunk via
  `TG_CTL_UNSCOPED_TIMEOUT_MS`) retires the entry. Fails against the pre-fix code (generic
  "expired — answer in terminal" text instead of the hatch-specific disconnect text) and passes
  with the fix.
## 1.52.0

**Feature: tg-ctl active-silence nudge for tg-unaware agent sessions (tg-cli#363).**

Alex has repeatedly asked agents to reliably use tg-cli. The `tg` skill's own
triggers (finish a task, hit a question/blocker) only fire at a natural decision
point — a long, heads-down working stretch never produces one, so passive skill
discovery alone can't close the gap. This adds the ACTIVE side.

- The `tg-ctl` daemon's poll loop now sweeps every live omp ACP session
  (`listLiveOmpAgents`) and sends a short reminder — via the existing
  `promptOmpAcp` channel, no tmux send-keys — once a session has gone an hour
  with zero outbound `tg` traffic. At most one nudge per silence *episode*: a
  key becomes eligible again only after a real `tg` send, then another full
  hour of silence. Durable per-key state in a new `tg-ctl.<botid>.awareness-nudge.json`
  file (same convention as `schedules`/`questions`), pure decision logic in
  `features/tg-ctl/tg-awareness-nudge.ts`.
- Fixed a gap this surfaced: `tg`'s outbound history writer
  (`recordOutboundHistory`) previously gated on `TMUX_PANE` alone, so a
  headless omp session (no tmux pane — exactly the nudge's target population)
  never got an outbound `history.jsonl` record at all. Now gated on the same
  `originPaneId` (tmux pane, else the synthetic `omp:<pid>` origin) already
  used for outbound routing.
- Review finding: a failed/dropped nudge delivery no longer permanently
  forecloses the rest of that silence episode. `planAwarenessNudges` decides
  who is due without marking anyone nudged; only a confirmed-successful send
  now commits the "nudged" marker via the new `markAwarenessNudgeSent`, so a
  transient `promptOmpAcp` failure (the exact busy/loaded-agent case this
  feature targets) is retried on the next sweep instead of silently giving up
  for the rest of the hour-plus silence stretch.
- Review findings: a replacement session in the same key (a tmux pane whose
  agent was restarted, e.g. Ctrl-C then a fresh `omp`) no longer inherits the
  old session's nudge state — the store now tracks each key's last-observed
  `sessionId` and resets `firstSeenAt`/the nudge markers when it changes,
  instead of either silently suppressing the new session's own first nudge or
  firing one immediately off a stale clock. Separately, a session's silence
  clock can no longer be backdated by a stale `tg`-send record left under a
  reused key (`silenceStart` is now clamped to never precede `firstSeenAt`),
  and the daemon's "did the key set actually change" persistence check is now
  a real set comparison (`AwarenessNudgePlan.keysChanged`) instead of a
  length check that missed simultaneous add+remove churn.

## 1.51.1

**Fix (tg-cli#353): ACP `session/prompt` eviction no longer kills a healthy turn or a live permission prompt (P1 review-quorum finding on #352).**

The 1.49.2 wedged-client eviction fix (tg-cli#353, shipped below) evicted + killed the cached ACP
client on **any** `session/prompt` timeout. Two independent review passes on
PR #352 (Opus-omp and Sonnet-omp, posted at
https://git.hyperide.ai/ultrabricks/tg-cli/pull/352#issuecomment-5610743766)
found this was too broad: `session/prompt` only resolves at *turn
completion* per ACP semantics, so (a) a healthy turn still legitimately
running past the timeout got killed mid-turn, and (b) worse, a
still-outstanding `session/request_permission` — a human slowly answering a
Telegram permission prompt, covered by the documented 12h
`ABANDONED_PERMISSION_RETAIN_MS` "never lose the tap" guarantee — had its
pipe destroyed, and `replyOmpAcpPermission` never respawns a client, so
every later tap on that permission failed identically forever.

- **`promptOmpAcp`** now evicts + kills the cached client only when **both**
  no ACP traffic has arrived since the prompt was sent (`lastActivityAt` is
  a proxy for "the child is still alive, not wedged") **and** no
  `session/request_permission` reply is still owed on that client
  (`pendingPermissions === 0`). A genuinely wedged session (no traffic, no
  outstanding permission) is still reaped exactly as in 1.49.2.
- `OmpAcpClient` tracks `lastActivityAt` (updated on every inbound ACP frame)
  and `pendingPermissions` (incremented on each `session/request_permission`,
  decremented when `replyOmpAcpPermission` writes the reply).
- New regression test `ctl-omp-acp-prompt-evict-permission-pending.test.ts`
  proves a session with an outstanding permission survives repeated
  `session/prompt` timeouts against the same cached client, while the
  existing `ctl-omp-acp-prompt-evict.test.ts` (zero traffic, zero pending
  permissions) still gets reaped unmodified.

## 1.51.0

**The asking side tells the truth about an approval card (tg-cli#317).**

Incident 2026-09-05: an agent asked Alex for a one-time exception; the daemon posted the
card (its log says `ask-forward posted … messageId=14880`), nobody tapped within the
110-second unscoped window, and the daemon closed the hook socket with the same bare
`null` it uses for a request it refuses at the door. The client logged "ask-forward
not-posted … daemon declined or unreachable", the agent-tools hatch helper forwarded that,
and the agent was told a card visible in Telegram had never been sent.

- The daemon now writes an interim status line on the hook socket before its final reply:
  `posted` (with the messageId), `dropped` (with the daemon's reason, e.g. `not-registered`),
  or `expired` (messageId + age). The final reply is unchanged, so an older client keeps working.
- `tg-ctl ask` reads those lines and logs the real outcome: `ask-forward expired …
  posted to Telegram; no decision within Nms`, `ask-forward not-posted … daemon declined:
  reason=<reason>`, `ask-forward timed-out …` (client budget, card posted), or
  `ask-forward unreachable …` (no daemon). "not-posted" is never said about a posted card.
- The daemon half activates when the running daemon is restarted; the client half is live
  as soon as the file is checked out (`~/.files/bin/tg-ctl` is the repo file).
- The reconnect re-attach path (a still-live card whose socket dropped and got resent
  under the same requestId) now writes the same `posted` status line the fresh-forward
  path writes, so a reconnect that then also drops or times out before a tap is reported
  as `declined-after-post`/`timed-out … messageId=…`, never `unreachable`/`no status line`
  for a card that is genuinely still live in Telegram (review finding: this was the one
  path the original fix missed, and the more common one — it covers every ordinary
  scoped permission/question, not just the paneless hatch case #317 was raised from).
- The `expired` message no longer claims a card reached Telegram when the send was still
  in flight: the unscoped-abandon timer can fire before `sendMessage` resolves, and
  `messageId` staying `null` in that case now reads "the send to Telegram had not
  completed" instead of asserting delivery that never happened (review finding).
- The reconnect loop no longer discards an earlier `posted` status once a later
  reconnect attempt can't even connect: it accumulates status truth across attempts
  instead of replacing it, so a card posted on attempt 1 that then stays unreachable
  for the rest of the hook budget is still reported as `declined-after-post`/
  `timed-out … messageId=…`, not `unreachable` (review finding, independently found
  by two reviewers — the daemon-stays-down-past-the-deadline case this file's own
  "never unreachable for a live card" guarantee had missed).
- A resend that lands after the human already answered via pane injection (the
  daemon's `already-pane-delivered` drop) no longer reports `declined-after-post …
  the daemon closed with no decision` — a real decision WAS made, just delivered
  outside this socket. It now reports `answered-via-pane` (review finding: the
  generic `posted` branch outranked this case, misreporting a genuine answer as
  a non-decision).

Not changed here: the 115-second hook budget / 110-second unscoped expiry (tg-cli#303) and
the empty routing fields (`agent=claude pane=-`) for a request raised from a codex session.
## 1.50.0

**Fix: tg-ctl asks once before falling back from private topics to flat `/new` spawns (tg-cli#181).**

- When Bot API reports `getMe.has_topics_enabled=false`, tg-ctl now asks once
  before continuing `/new` without topic routing, then remembers that choice for
  later `/new` spawns in the same daemon run.
- A stale/replayed fallback tap can no longer clobber a different session's
  live pending fallback decision (`handleNewPrivateTopicFallback` only resets
  the global state when nothing is actually awaiting an answer).

## 1.49.2

**A wedged ACP `session/prompt` no longer stays wedged forever (tg-cli#353, #346-adjacent).**

The NDJSON framing fix (#346) made ACP `initialize`/`session/load` succeed, but a
`session/prompt` call that never got a reply -- e.g. the target omp session
already owned by another live process -- left the ACP child cached forever
with `exitCode===null`. Every later reply into that same session reused the
dead pipe and repeated the identical "ACP session/prompt timed out" failure.
Live evidence: the same session id timed out 3x over 30 minutes under a
daemon that already had the NDJSON fix, leaking a 35+ minute child holding
90+ open sockets.

- **`promptOmpAcp`** evicts the client from `ompAcpClients` and kills its
  process on any session/prompt failure, so the next attempt spawns a fresh
  child instead of reusing a permanently wedged pipe.
- The prompt timeout is overridable via `TG_CTL_ACP_PROMPT_TIMEOUT_MS`
  (defaults to the existing 120s) so tests can exercise the eviction path
  without a 120s wait.

**Fix (tg-cli#358): omp session title in outbound `[window]` header and `/agent` picker.**

- Outbound `tg` now prefers the live omp session jsonl title for the `[window]` bracket
  when this process runs under an omp ancestor — including headless sessions with
  `TMUX` unset — falling back to the tmux window name / cwd-basename label for every
  other harness.
- `tg-ctl` reads the full session jsonl when resolving omp agent labels; a
  `title_change` record past the old 64KB scan window is no longer invisible to the
  `/agent` picker.
## 1.49.1

**Telegram `/agent landing` and `/agent rig-fable` reach the live omp sessions (tg-cli#342).**

Ask 108: those Hyper-tab omp processes were listed only by ephemeral titles
(`Save requests to memory/TodoList`, `Finish rig-zerobug session work`), so
`/agent landing` and `/agent rig-fable` reported no match.

- **`matchWindows` / `matchLiveOmp`** also match a unique cwd project token
  (`landing` -> `conloca-landing`) and a unique first segment of a hyphenated
  selector (`rig-fable` -> `rig-cli`). A prefix of an undivided basename still
  does not route (`dev` does not hit `development`). Ambiguous token sets stay unmatched.
- **`--name`** on a live omp argv wins over title and cwd token.
- **Picker labels** keep the title and append the project dir so the stable
  names are visible next to the changing title.

## 1.49.0

**Feature: dictionary gate — `tg` refuses to send a message containing a banned word from the shared dictionary, printing the replacement (tg-cli#302).**

- Every outgoing message — the `--title`, the body, and `--photo`/`--file` captions, for every `--tag`
  and both formats, `--dry-run` included — is checked against `~/.claude/DICT.json` (path override:
  `TG_DICT_PATH`), the machine-readable twin of the "Dictionary" section of the global `CLAUDE.md`.
  A hit refuses the send (exit 1, nothing sent) and prints every match with the rule id, the matched
  text in ~20 chars of context, and the replacement. There is deliberately no bypass flag or env var.
- The text is matched as the reader will see it: under `--format html`, `<code>`/`<pre>` contents are
  exempt and every other tag / entity is resolved before matching, so markup cannot hide a word; under
  plain format everything is literal text, so nothing is exempt there. Rules with `only_if_cyrillic` apply only when the
  message contains Cyrillic. `\b` in a rule is rewritten to a Unicode-aware boundary at load time
  (JS `\b` is ASCII-only, which would have left every Cyrillic stem rule dead).
- Gated text: `--title`, the `--subagent` label, body / caption, `--table` heading + rows.
- A missing dictionary at the default path disables the gate silently; an explicit `TG_DICT_PATH`
  (environment or `~/.config/tg-cli/.env`) that does not exist refuses to send; a malformed one (bad JSON, bad shape, a regex that
  does not compile) or an unreadable one refuses every send, naming the file and the rule, until fixed.
- Documented in `tg help format`, the installed skill and the README. Tests run against a byte copy of
  the real dictionary and prove stem-based catching of forms not listed in any pattern.

## 1.48.2

**Fix (tg-cli#341): ACP initialize speaks NDJSON, not Content-Length.**

Live omp 18.1.14 `omp acp` answers one JSON-RPC object per line. Sending LSP
Content-Length made the child exit 0 with empty stdout, so Telegram `/agent`
and replies failed with `ACP initialize timed out` (15s).

- `encodeAcpFrame` writes NDJSON; `decodeAcpFrames` parses NDJSON lines so
  `pumpAcpClient` / `acpCall` actually see the initialize result.
- Fake `omp acp` servers in tests speak the same framing.

## 1.48.1

**Telegram replies reach live omp sessions that have no tmux pane (tg-cli#339).**

Alex 2026-09-08: listing omp titles on `/agent` is not reply routing. A reply to an
out-of-tmux omp, `/agent` pick then text, and plain inbound with no pane must land
in that live process via process-table + ACP — never tmux send-keys.

- **`tg` records routes outside tmux.** When there is no `TMUX_PANE` but an omp
  ancestor, the outbound route paneId is `omp:<pid>` so a Telegram reply recognizes
  that origin.
- **`handleReplyRoute`** injects `omp:<pid>` origins via ACP (`session/load` of the
  process-table session id, then `session/prompt`), not `send-keys` and not the
  gone-pane picker.
- **ACP attaches to the live session.** `omp acp` drops `--no-session` and calls
  `session/load` when the jsonl session id is known; `session/new` remains only
  for untitled/no-jsonl processes.
- **Inbound without a pane:** a sole live omp is injected; several live agents
  (including out-of-tmux omp) get the picker.

## 1.48.0

**Feature (tg-cli#337): block a send that mentions screenshot/скриншот with no image attached.**

- `tg "see screenshot foo.png"` (no `--photo`) is a hard error before transmit. The
  error tells the sender to attach the image with `tg --photo`, and not to dodge by
  deleting the word — attach the screenshot.
- `tg --photo x.png "screenshot of …"` is allowed: a photo is already attached. A
  `--photo` whose path is missing or empty does not count — that file is later
  skipped and the caption would otherwise go out as text-only.
- Case-insensitive English `screenshot` and Cyrillic `скриншот`. ON by default
  (feature `screenshot-guard`); `--no-feature screenshot-guard` opts out.

## 1.47.0

**tg-ctl controls live omp via ACP, not tmux send-keys (tg-cli#323).**

Alex 2026-09-07/08: harnesses that can be driven without tmux must work without it,
and an omp pane plus the API at once must not fight over send-keys. PR 322's
`omp --resume --print` path forks session history — this does not use it.

- **Discovery** finds interactive omp from the process table (pid, session jsonl,
  title from omp itself) whether or not a tmux pane exists. Worker helpers
  (`__omp_worker_*`) are not the user session. Tmux still classifies kind=omp (243),
  including a pane whose `pane_current_command` is a version string.
- **Inject** uses ACP JSON-RPC (`initialize`, `session/new`, `session/prompt`) on
  `omp acp --no-session --allow-home --cwd …`. Wrapped `[TG from …]` text, same as
  other harnesses. If a tmux pane AND ACP both exist, ACP wins — never `send-keys`.
- **Questions/permissions** from `session/request_permission` become Telegram
  buttons; a tap replies with the JSON-RPC result, not a tmux digit.
- An omp session outside tmux is no longer the Stop-hook inbox fallback.
- Bare `/agent` lists every live omp as a tappable button (`omp:<pid>` → ACP).
  Body is only `Pick an agent to send message:`. Label is the session title, or
  `omp · <pid>` if untitled — never the cwd basename. No "Outside tmux (not tappable)" notice.

Known bound: `session/load` against a running TUI's session file is not assumed to
attach to that process (it may fork). Live Telegram proof of a TUI already in a
pane is still outstanding; the unit/integration tests drive a fake/live `omp acp`
child with `TMUX` unset.

## 1.46.2

**Fix (tg-cli#316): `tg-ctl status` no longer lies "not running" while launchd owns a live daemon.**
The pidfile is informational (spec §6); a KeepAlive LaunchAgent (`ai.hyperide.tg-ctl`, pid 11062)
can run for days after the pidfile is gone. Status now consults, in order: a live pidfile, the
flock holder (`lsof` on `tg-ctl.<bot>.lock`), and a launchd job that supervises this binary for
this config dir. A launchd-owned process is reported as `running (launchd, pid N) (job <label>)`
even when the pidfile is missing or stale. `tg-ctl ask` is unchanged: it still talks to the unix
socket and does not consult status, so a lying status can no longer be the reason a hatch skips
the ask.

## 1.46.1

**Fix: a bad attachment or an oversized body no longer breaks or floods a send.**

Minor bump (not a patch): the new flood cap can refuse a send that previously
succeeded, so this is a behavior change, not a pure bugfix.

- A disk attachment (auto-detected from a path mention, or an explicit
  `--photo`/`--file`) that goes missing, gets truncated to empty, or loses read
  permission between detection and send is now skipped with a stderr warning
  naming the path and the reason — the primary text still delivers. Previously
  Telegram's "file must be non-empty" rejection killed the WHOLE send, including
  the text (tg-cli#207). If every attachment is bad and no text remains, the send
  now refuses loudly (non-zero exit) instead of a silent no-op success.
- A message long enough to fragment into more than 6 separate Telegram sends is
  now refused up front, with a local error naming the exact character count and
  the number of messages it would have produced, instead of silently flooding
  the recipient with dozens of fragments. Override with `--no-feature
  flood-cap`. Rich messages (tables/headings/lists/formulas) are unaffected —
  they always send whole (tg-cli#208).

## 1.46.0

**Agents running OUTSIDE tmux are visible and reachable (tg-cli#306).**

Incident 2026-09-05: two agents started from plain terminal tabs (no `$TMUX`) did not
exist for tg-ctl — `tg-ctl status` listed neither, and Telegram messages to them vanished
without a reply. Discovery was tmux-only (`tmux list-panes` + `send-keys`).

- **Discovery scans the process table too.** An interactive `claude` / `codex` / `opencode`
  with a controlling tty but no tmux pane is listed by `tg-ctl status`, `/status` and the
  bare `/agent` picker as `unreachable: not in tmux (tty …, cwd …, name …, pid …)`, with
  the hint how to reach it. Headless runs (`-p`/`--print`, `codex exec`, Claude's
  `daemon`/`bg-*` helpers) are ignored.
- **A second delivery channel: the Stop-hook inbox.** `/agent <name> <text>` addressed to
  such an agent is appended to `<config dir>/inbox/<key>/pending.jsonl` and answered with
  an explicit reply ("… is running outside tmux — queued to its Stop-hook inbox; delivered
  when the agent next ends a turn"). The agent-tools Stop hook (`cc_hook_bridge` /
  `codex_hook_bridge`, agent-tools#526) reads that inbox at every turn end and hands the
  text to the agent as its next instruction. The daemon reacts 👌 on the Telegram message
  once the hook reports delivery. **Limit:** an idle agent receives it only at its next
  turn end — nothing can wake a tty-less Claude Code.
- **The no-agent reply lists them** instead of the bare "not in tmux" text when such an
  agent exists; a selector that matches nothing keeps its error reply.
- `tg-ctl inbox` lists pending entries per agent; `tg-ctl inbox queue <name|dir> <text>`
  queues by hand. The daemon no longer idle-exits while an agent outside tmux is up.
- The inbox KEY is shared with agent-tools byte-for-byte (`--name` sanitized — a dots-only
  name never escapes `inbox/` — else `cwd-<sha256(cwd)[:16]>`; `features/tg-ctl/unreachable.ts`,
  vectors in `tests/ctl-unreachable.test.ts` mirrored by agent-tools' `tests/test_tg_inbox.py`).
  Two live sessions whose keys collide (`a/b` vs `a?b`, or two unnamed sessions in one cwd)
  are refused rather than guessed. Inbox dirs are 0700 and files 0600. The hook publishes each
  delivery as a complete `delivered-<pid>-<ns>-<rnd>.jsonl` (no shared append target, so the
  daemon's ack sweep can never lose an in-flight hook write); a batch whose 👌 reaction hit a
  transient Bot API failure is kept and retried on the next sweep.

## 1.45.3

**Feature: delegate codex hooks to rig (scoped) + gate the codex hook-trust bypass.** Codex hook
provisioning is now delegated to rig within a scoped boundary, and the codex hook-trust bypass is
gated behind the explicit `NO_RIG` sentinel (aligned with #282) instead of being implicit, with the
hook-trust flag placed before the prompt separator.

## 1.45.2

**Fix: bare `harness-event` StopFailure alerts mislabel the agent with the tmux window name, not the live harness (#263).**

- The installed Claude Code StopFailure hook runs bare (`tg-ctl harness-event`,
  no `--agent` flag). Its fallback resolver, `resolveAgentForPane`, read
  `.windowName` (a tmux window's static, spawn-time-or-hand-set label) instead
  of `.agent` (the live, process-tree-detected harness kind) from
  `listAgentCandidates()` — a copy-paste mismatch against the parallel
  `resolveWindowNameForPane`, which correctly uses `.windowName` for its own
  distinct purpose. A window named `codex` that was later reused for a
  `claude` session reported `codex` in the Telegram alert, and only some of
  the time (whenever the stored window name and the live process happened to
  disagree) — matching a live report of intermittent mislabeling. Also fixes
  three latent misattributions gated on the same value: the codex hard-limit
  diagnostic, the codex-specific `/usage` advice, and `allowCodexTryAgainReset`
  could previously fire for the wrong harness.
- Regression test: a pane whose tmux window is named `codex` but whose live
  process is `claude` now renders `⚠️ <b>claude</b> hit its session limit`,
  not `codex`.
- Follow-up filed (#264): after this fix, two panes running the *same*
  harness render an identical alert head with no per-pane identity — the
  window name is already resolved separately and could be carried into the
  notification text to restore disambiguation without reintroducing the bug.
- Note: the resolved value also feeds the bare hook's usage-limit telemetry
  gates (`extractUsageLimitEvents`). A `claude` session in a non-`claude`-named
  window previously normalized to no agent and never got context-window 90%
  warnings; it now correctly does, same as any other bare-hook `claude`
  session. Expect a one-time uptick in these warnings for such panes — that's
  the fix reaching cases it silently missed before, not a new false positive.

## 1.45.1

**Feature: `/spend` and `/daily` bot commands + a scheduled weekly/monthly usage push (tg-cli#290).**

- `/spend [day|week|month]` replies with `rig usage`'s token/cost report (hypothetical API-list-price
  estimate over the Claude.ai subscription accounts). Named `/spend`, NOT `/usage`/`/cost`/`/stats`:
  those are native commands in Codex and/or Claude Code and must keep reaching the agent pane
  untouched (tests pin the whole reserved set in both routing modes).
- `/daily` replies with `rig daily`'s what-shipped report over merged PRs since the last run.
- `tg-ctl usage-schedule enable|disable` installs a launchd job (macOS only) that checks daily at
  23:50 and sends one report per COMPLETED week and month. It compares a persisted per-bot
  watermark (`tg-ctl.<bot>.usage-schedule.json`) against the current completed period, so the
  check is idempotent (never a double send) and retryable: a period whose `rig usage` run,
  Telegram send, or watermark persist fails stays (or becomes) due again for the next day. A
  boundary day (a Sunday, a month's last day) isn't treated as complete until the scheduled fire
  time itself (23:50) — a run earlier that day (a wake from an unrelated missed firing, a manual
  invocation) simply isn't due yet, so it never sends a partial-day report and marks it done. A
  firing genuinely missed at 23:50 (launchd runs a missed job at wake) is reported EXPLICITLY —
  "was NOT generated, run `rig usage` by hand" — instead of silently skipped or sent over the
  wrong window (`rig usage` can only report the CURRENT period; a real catch-up needs an as-of
  flag in rig-cli first). A gap spanning more than one boundary collapses to a single notice for
  the latest missed period — the notice says so, it does not claim every gap is enumerated. `enable`
  seeds the watermark to the in-progress period so a fresh install's first night never claims a
  period was "missed while asleep" (nothing was being watched yet). The job pins PATH and a
  non-default `TG_CTL_CONFIG_DIR` into the plist (launchd's own env has neither). `disable`
  tolerates a never-loaded plist left by a half-failed `enable`.
- Reports longer than Telegram's 4096-char limit are split into ordered chunks (the shared
  `splitMessage`). A `/daily` report whose send fails part-way is persisted
  (`tg-ctl.<bot>.daily-pending.txt`) and prepended to the next `/daily` — `rig daily` advances its
  own watermark while generating, so an undelivered report would otherwise be gone for good.
- The scheduled push escapes the report at the HTML boundary (`rig usage` really emits a
  `<synthetic>` model name); `rig usage --json` periods are shape-validated before formatting, and
  an all-unpriced period renders as "unpriced" instead of "~$0.00".

## 1.45.0

**`--tag question` is removed — only the standard tags stay (`answer`, `decision`, `problem`, `report`); an open question IS a decision request (tg-cli#301).**

Alex (2026-09-05): agents use one typed vocabulary. There is no separate "question"
message type — an open question for him is a decision he has to make, so it goes out as
`--tag decision` in the decision-request format (options, pros/cons, a recommendation).
Two names for the same escalation split the format rules and let agents pick the softer one.

- **`--tag question` is refused** at parse time (non-zero exit, nothing sent) with a one-line
  redirect instead of the generic off-list error:

  ```
  --tag question was removed: an open question is a decision request — use --tag decision in the decision-request format
  ```

  It is refused even when the body is a fully compliant decision request — the problem is the
  vocabulary, not the format. `--dry-run` refuses it the same way.
- `--help`, `tg help format`, and the installed `tg` skill / blurb list exactly
  `answer` / `decision` / `problem` / `report`; `decision` is now the single ESCALATION tag
  behind the deny-by-default decision-request gate (`ESCALATION_TAGS`).
- The QUESTION wordmark/emoji branding (`TAG_PILL_IDS` / `TAG_PILL_DOT` / `TAG_PILL_FALLBACK`
  entries, the orange `🟠 QUESTION` fallback badge) is deleted; the header renderer is
  unchanged (the placeholder-id guard stays, it is generic).
- Companion change in agent-tools (#524): the `decision-request-format` hook's escalation tag
  set becomes `decision` + `problem`, it blocks a `tg --tag question` command with the same
  hint, and the `decision-request-discipline` skill no longer mentions `question`.

## 1.44.5

**Fix: tg-ctl gave up on permission prompts too early, falsely reporting them as "never delivered" (tg-cli#182).**

- A `permission`-kind entry (an approve/reject request whose hook socket closed) now uses its own,
  much longer retention window (`TG_CTL_ABANDONED_PERMISSION_RETAIN_MS`, default 12h) before the
  daemon gives up and tells the human "this was never delivered over Telegram" — previously it shared
  the 30-minute question window (`TG_CTL_ABANDONED_RETAIN_MS`), so a permission left unanswered for
  as little as half an hour (easily overnight, or a few hours away from the phone) was falsely
  reported as unrecoverable even though the harness might still be sitting on its own terminal
  fallback prompt, fully answerable.
- A separate, related fix (multi-line command matching for the late-delivery pane-injection path,
  tg-cli#267) was attempted but reverted after a 3-round review surfaced an unresolved escalation
  risk and an unverified rendering assumption — tracked as tg-cli#283 for a live-verified redesign.

## 1.44.4

**Fix: renamed the 1.44.3 routing-anchor feature's identifiers/filenames off the repo owner's own name.**

- `last-alex-target.ts`/`LastAlexTarget`/`recordLastAlexTarget` (and siblings)
  and the on-disk `tg-ctl.<bot>.last-alex-target.json` state file are renamed
  to their `User` equivalents throughout. A daemon upgrading from 1.44.3
  migrates a pre-existing anchor forward automatically (once it holds its
  singleton lock); the denylist still blocks both the new and legacy
  filenames from ever riding a Telegram attach.

## 1.44.3

**Fix: a non-reply message could route to whichever agent pane merely spoke last, instead of the pane the CTO was actually addressing.**

- An unrelated agent proactively messaging the CTO — right before the CTO sent
  his own fresh, non-reply message — could hijack that message: routing bound
  to `routes.json`'s "last outbound sender" (`lastMessagePane`), which
  conflated "who spoke last" with "who the CTO was addressing" (live
  incident). Fixed by adding a dedicated anchor
  (`tg-ctl.<bot>.last-user-target.json`) that records ONLY the CTO's own last
  CONFIRMED inbound delivery — an auto-bound inject, a picker tap, a reply, or
  a named `/agent` — never an agent's own outbound send and never a failed
  inject. Guarded against tmux pane-id reuse the same way reply-routing
  already was, and shared between inbound message routing and `/tasks`'s
  default project scoping so the two no longer disagree.
- Also fixed the same class of bug in the git-state-check banner (it could
  silently check the daemon's own repo instead of skipping the banner when a
  pane reported no known path), and widened the never-attach denylist to
  cover the new anchor file's temp-write staging form.

## 1.44.2

**Fix: `/agent <selector> <message>` dropped the inbound `tg#<id>` wrap tag, breaking threaded replies for anything routed by name.**

- `injectToPane` (the daemon's `/agent`-routing inject path) accepted a
  `sourceMessageId` parameter — used only for deferred-queue bookkeeping — but
  never forwarded it into `wrapInbound`. Every other inbound path (auto-bind
  inject, reply-quote, deferred flush) already passed its message id and
  rendered `[TG from Alex tg#<id>] <msg>`; a message sent via
  `/agent <selector> <message>` rendered `[TG from Alex] <msg>` instead,
  silently losing the id an agent needs for `tg --reply-to <id>` threading.
  Present since the `/agent` selector routing was added (June 12) — the
  `{id}` wrap convention landed later (PR #34) and was only wired into the
  OTHER inject paths, never into this one. Fixed by forwarding
  `sourceMessageId` into the existing `wrapInbound` call; covers the direct
  hit, the ambiguous-picker confirm, and the defer-flush replay, since all
  three share this one function. Three integration tests cover it:
  `ctl-agent-route-message-id-integration.test.ts` (confident direct route),
  a new case in `ctl-ambiguous-picker-integration.test.ts` (the picker-tap
  call site of the same shared `injectToPane`), and
  `ctl-agent-route-defer-flush-message-id-integration.test.ts` (a message
  deferred behind an open question flushes with the id exactly once — no
  double-tag from re-wrapping an already-wrapped deferred item). Also
  corrected two stale doc comments (`inject.ts`, `types.ts`) that still
  claimed a `/agent` route carries no id.

## 1.44.1

**Fix: `--tag question|decision`'s escalation-format gate rejected realistic decision-request content while only the tool's own toy template passed (#261, #262).**

- `hasWallOfText` split a message body on literal `\n` only. A fully structured
  Rich Message (`<h3>`/`<p>`/`<table>`/`<ul>`/`<hr>`) assembled as one
  continuous string, with no literal newline between sections, still renders
  as separate visual lines in Telegram — but the raw source string was one
  giant "line" whose character count blew past the 350-char wall-of-text
  threshold the moment the content was realistic. Fixed by scanning "visual
  lines" (a virtual break before each opening block tag, after each
  closing/void one) instead of literal-newline-split lines, so the same
  content gets the same verdict regardless of the caller's newline
  formatting. `hasContextProse` had the identical bug (found during review of
  this fix) and got the same normalization, plus a matching
  `blockquote`/`pre`/`code` skip-list so quoted text or a code dump can't
  satisfy the Context requirement with none of the agent's own prose.

## 1.44.0

**Feature: late-deliver a permission tap by injecting the digit into the still-showing terminal menu (#267).**

- A Telegram Approve/Reject tap that lands after a permission's hook socket
  already closed (Claude Code's ~120s hook budget elapsed, harness fell back
  to its own terminal "Do you want to proceed?" prompt) now re-checks the
  pane via `tmux capture-pane` and, if the menu is still showing FOR THIS SAME
  request, injects the matching digit directly — no waiting process, no
  dependency on a hook reconnect that may never come. Previously the tap was
  only ever QUEUED for delivery on a hook reconnect (tg-cli#31/#98), which
  meant a terminal-fallback permission could wait forever despite the human
  having already answered.
- Scoped to `claude`: its numbered menu layout and bare-digit-submits-instantly
  behavior (verified live, 2026-08-18 — a bare digit resolves the prompt in
  well under a second, no trailing Enter) are the only ones confirmed; every
  other agent kind, and claude when the menu can't be re-verified live, falls
  through unchanged to the existing queue-and-wait-for-reconnect path.
- The captured menu must ALSO still identify the SAME command/question the
  request was originally asking about — not whatever permission happens to be
  pending right now. Without this binding, a stale tap could inject "Yes" into
  a newer, unrelated prompt within the retention window (review finding).
- New pure module `features/tg-ctl/permission-menu.ts` parses the captured
  pane text for the menu (from the LAST "Do you want to proceed?" occurrence,
  not the first — the marker can also appear in scrollback) and picks the
  digit matching an allow/deny decision by an EXACT "Yes"/"No" label match,
  not a prefix — Claude Code has other wide "yes" variants beyond "don't ask
  again" (e.g. auto-accepting edits for the session), and an exact allowlist
  match is what actually enforces "never silently grant a broader standing
  decision than the tapped Approve button represents."

## 1.43.1

**Fix: `tg --detect-model` misbrands omp sessions as claude (#246).**

- omp sessions export `CLAUDECODE=1` (pi heritage, verified live), and
  `detectAiModel` checked that env var BEFORE walking the ancestor process
  tree — so every outbound send from an omp session was branded `claude ✳️`
  instead of `omp 🥧`. Detection is now LINEAGE-FIRST: the ancestor process
  walk runs right after the explicit `TG_AI_MODEL` override, and env markers
  become fallbacks for detached spawns whose launcher is not in the tree.
  Env vars are inheritable — an agent inside another agent's pane carries the
  outer agent's markers — so the nearest recognizable ancestor is the truth
  in those topologies (a nested claude-inside-opencode stays claude, pinned
  with a two-agent process tree). An opencode ancestor is still refined to
  the session's actual model name via `opencode debug config` (extracted as
  `opencodeModelFromConfig`), with the generic kind as the unreadable-config
  fallback at BOTH call sites. The env-fallback chain keeps the pre-existing
  relative order (CLAUDECODE → OPENCODE → CODEX): CLAUDECODE is
  self-published by the inner agent (one hop of evidence), the others are
  inherited (two hops). KNOWN LIMITATION: a DETACHED spawn from an omp
  session has no lineage and no omp-specific marker (omp sets none — verified
  live), so it still brands claude; only attached spawns brand omp.
- Regression pins: `CLAUDECODE=1` + omp ancestry → `omp`; `CLAUDECODE=1` +
  claude ancestry → `claude`; opencode ancestor → config model name;
  inherited `OPENCODE` marker loses to a codex ancestor; nearest-wins with
  two agents in one tree; detached nested spawn → `claude`; unreadable
  opencode config → generic `opencode` at both call sites; env-only
  CLAUDECODE tests pin a neutral fake ancestry so they stay deterministic
  inside a real agent pane.

## 1.43.0

**Feature: omp (Oh My Pi) harness support — inbound discovery + outbound branding (#243).**

- `matchAgentCommand` (features/tg-ctl/discover.ts) now recognizes the `omp`
  binary by argv0 basename (`omp` is a compiled Bun binary, e.g.
  `/opt/homebrew/bin/omp`). This ONE row fixes every gate that keys off it:
  inbound pane discovery (`findAgentInPane` BFS), the inject verify-pane
  checks, reply-route liveness, and candidate discovery — an omp pane is now
  classified as agent kind `omp` and is injectable at the tmux floor, exactly
  like `pi`/`aider`.
- Outbound branding: `detectAgentViaAncestry` (surfaced by `tg --detect-model`)
  labels a session launched under omp as `omp`; the emoji
  maps carry `omp` (custom ID shares Claude's ✳️, Unicode fallback 🥧), so
  `tg` sends from an omp session get the agent emoji and `:omp:` works as an
  emoji helper.
- `questionCapability` intentionally unchanged: omp defaults to `unsupported`
  (the honest tmux-floor behavior — inbound works, no native question
  buttons), same as `pi`/`aider`. No hook/permission integration this round.
  `tg-ctl ask --agent omp` classifies payloads as omp (pinned by test), so an
  explicit omp ask gets the honest "unsupported" path instead of silently
  falling back to claude semantics.

## 1.42.0

**Feature: `--dry-run` — validate/render a message locally, never send it.**

- `tg --dry-run [...]` runs every LOCAL guard on the fully assembled message
  (the `--tag decision|question` escalation-format gate, the `--table` final
  check, the cjk/mixed-script guard, markdown-pipe→`<table>` conversion) and
  prints the outcome — but makes NO network call and requires NO
  `TG_BOT_TOKEN`/`TG_CHAT_ID`. On success it prints `tg --dry-run: OK` plus the
  rendered body; a malformed `--tag decision|question` still hard-blocks
  exactly as it would for a real send (deny-by-default), just without ever
  touching the network.
- Fixes a real incident: an agent iterating against the strict escalation
  gate had no way to test structural compliance except a REAL send. A
  structurally-valid-but-still-placeholder draft (the gate's own
  `foo.ts:42` / `Option A: fast/risky` example, half-edited) passed the gate
  and went out for real — six live messages in one incident, two of them
  still carrying literal placeholder text ("foo bar baz test.", "Option A"
  pros "ok" cons "bad"). `--dry-run` removes the reason to ever test a
  decision/question format against the live chat.


## 1.41.2

**Fix: a queued permission tap is never silently expired/demoted on a timer
again (tg#9982).** 1.41.1 introduced a 10-minute `TG_CTL_QUEUED_DECISION_DELIVERY_MS`
window after which a QUEUED Telegram decision on a disconnected permission was
silently discarded (the card fell back to plain "hook disconnected" text, with no
proactive notice) — a real violation of the standing rule that a pending question
must stay pending in Telegram until there's 100% confirmation it was resolved, and
that a long outage must be *reported*, never silently dropped.

- The queue no longer expires. A reconnecting hook that matches the queued
  decision's requestId and full payload (`permissionPayloadMatches`) gets it
  delivered no matter how long the reconnect takes.
- What made the old timer necessary is fixed at the root, for PERMISSIONS
  specifically: `requestId` for a `permission`/plan-approval is now scoped to
  the exact INVOCATION, not just the session or even the prompt turn. `tg-ctl
  ask` generates a random nonce ONCE PER PROCESS (`HookEnv.invocationNonce`) —
  the harness spawns a fresh process for every tool/permission hook event — and
  folds it into the requestId hash. A first attempt at this used only Claude
  Code's `prompt_id` / Codex's `turn_id`, but those scope to the whole prompt
  TURN, not the individual tool call: two DISTINCT permission invocations of an
  identical command in the SAME turn would still have shared a requestId under
  that scheme (caught in review before shipping). The per-process nonce closes
  that gap completely for permissions — a materially later, unrelated request
  (whether a later turn or a second identical call within the same turn)
  always gets a DIFFERENT requestId and can never be mistaken for a reconnect
  of an earlier one, timer or not; `prompt_id`/`turn_id` are still folded in as
  extra hash entropy but are no longer relied on for safety. Auto-delivery
  additionally REQUIRES this identity proof (`ButtonRequest.promptTurnId`) to
  be present on the retained request at all — the ONE remaining case it can be
  absent is a manual/back-compat caller that hand-builds an already-normalized
  request (not real harness traffic) or a pre-upgrade on-disk record; either
  way the tap still stays queued and re-tappable, a reconnect there just shows
  a fresh live prompt instead, and the tap-time/notice text never claims
  automatic delivery for it (`queuedPermissionDecisionText`,
  `queuedDecisionStillWaitingText`).
- `question`-kind requests (`AskUserQuestion`, and anything routed through
  `ExitPlanMode`'s sibling question path) DELIBERATELY do NOT get the
  per-process nonce — a question has no queuedDecision auto-delivery hazard,
  and the existing multi-question retry contract needs a re-asked question
  from a genuinely new process (same content) to hash IDENTICALLY so it
  re-attaches to its retained card instead of duplicating. Only `prompt_id`/
  `turn_id` scope a question's requestId, same as before this release; a
  question re-asked in a NEW turn still gets a fresh card either way.
- `TG_CTL_QUEUED_DECISION_DELIVERY_MS` is renamed `TG_CTL_QUEUED_DECISION_NOTICE_MS`
  and repurposed: past that threshold with no reconnect, the human gets a
  ONE-TIME proactive "still waiting to reconnect" notice — the queue itself is
  never cleared by it.
- The existing full-retention "still no connection" give-up notice now names the
  queued decision when one was pending, instead of implying nothing was ever
  chosen.
- Upgrade note: a `permission`'s `requestId` hash SEED changed (it now folds in
  `env.invocationNonce`), so a permission card retained across the
  1.41.1→1.41.2 daemon upgrade won't requestId-match a subsequent reconnect
  and won't auto-deliver — it falls through to an ordinary fresh live prompt
  instead (a one-time transient on upgrade, not a regression in steady state).
  A `question`'s hash seed ALSO changed (it now folds in `prompt_id`/`turn_id`
  when the harness sends one), so a question card retained across the upgrade
  and re-asked with a `prompt_id`/`turn_id` present may likewise fail to
  re-attach — for a question this means a duplicate card rather than a missed
  auto-delivery (a question never auto-delivers anything), same one-time
  transient severity.


## 1.41.1

**Fix: `tg-ctl` no longer sends an unidentifiable, overclaiming "hook disconnected"
card, and never silently drops a Telegram tap on a disconnected permission.**

- The abandoned-hook card now names the pane (reusing the same resolver the
  outbound `[window]` header uses) and never promises a reconnect it can't
  guarantee, while keeping the original question/permission text visible and
  preserving the inline keyboard on every such edit (a real pre-existing gap
  this release also closes).
- A tap on a disconnected PERMISSION is now QUEUED instead of silently
  discarded, and delivered automatically the instant a reconnecting hook
  re-attaches with a matching payload — bounded by a short delivery window so
  a coincidentally-identical later request is never auto-approved from a stale
  tap. The queue survives a daemon restart and demotes back to the plain
  disconnected text if it never gets delivered.
- An entry that never reconnects within the retention window now gets a
  proactive "still no connection" notice instead of sitting silently forever.

**Fix: the usage-limit "banked/earned reset — redeem via `/usage`" advice no
longer appears for every harness.** That mechanic is Codex-specific; other
agents (including Claude) now get a plain "plan around it / switch agents"
line with no redemption claim.

## 1.41.0

**Feature: the `cjk-guard` also blocks mixed-script "garbage word" tokens.**

- The `cjk-guard` feature now catches a second garbled-token shape besides stray
  CJK: a single CONTIGUOUS run of letters where a foreign alphabet (Latin, Greek,
  …) is SANDWICHED inside Cyrillic — the homoglyph/mojibake signature an LLM
  sometimes emits, e.g. `почčesна` where it meant `починена`. A message (or
  `--title`) carrying such a token is now a HARD ERROR before send, naming the
  offending token and its position so the sender re-sends clean.
- The trigger is INTERLEAVING: the run's script must switch TWICE OR MORE. That
  keeps legitimate two-segment tokens sending — both scripts across SEPARATE words
  (`влил PR`, `gh ship готово`, `dev-cli`), a Latin acronym HYPHEN-joined to a
  Cyrillic word (`PR-ревью`, `MCP-сервер`), a Latin acronym with a GLUED Cyrillic
  case/diminutive suffix (`IDшник`, `PRы`, `APIшка`, `ORMка`), a pure-Cyrillic or
  pure-Latin word, accented Latin, and Cyrillic mixed only with digits /
  punctuation / emoji all pass untouched. CJK letters are their own class (the
  shared `isCjk` predicate), so this stays orthogonal to the stray-CJK check.
- Shares the existing `cjk-guard` toggle: `--no-feature cjk-guard` (or
  `features.cjk-guard: false`) disables both checks.

## 1.40.1

**Fix: `tg-ctl` self-heals the Claude hooks on daemon start.** If the Claude hook wiring is
missing or stale when the daemon starts, it is repaired automatically instead of silently
staying broken.

## 1.40.0

**Feature: escalation-format enforcement for `--tag decision|question`, and markdown
pipe tables now render.**

- **Markdown pipe tables auto-convert to real Telegram `<table>` HTML.** A body typed as a
  markdown grid (`| a | b |` / `| --- | --- |` / `| A | B |`) used to arrive as literal
  plain text (Telegram renders no markdown tables). `tg` now detects that shape and rewrites
  it to a `<table>` routed as a Rich Message, so it renders — surrounding prose is preserved
  (and HTML-escaped for a plain-text send). See `pipeTableToHtml` in `features/render/table.ts`.
- **`--tag decision` and `--tag question` now REQUIRE the decision-request format,
  deny-by-default.** A malformed escalation is BLOCKED (exit 1) with a checklist of what's
  missing. Required: Options as a real table/list with pros/cons, a Recommendation, Context,
  a "where to look" `file:line`, AND readability structure — each section under its own
  `<h3>`/`<h4>`, enumerations as short `<ul>`/`<li>` items (no inline comma-runs), `<hr>`
  dividers, no wall-of-text run-ons — sent with `--format html`. Implemented in
  `features/cli/escalation-format.ts` (pure validator) + the parse-time gate in
  `features/cli/args.ts`.
- **The `ESCALATION_GATE_ENFORCE` flag now defaults to ON** (deny-by-default). The one
  documented escape for a genuine non-escalation / urgent edge case is
  `ESCALATION_GATE_ENFORCE=0`, which downgrades the block to an advisory warning.
- `report` / `answer` / `problem` tags are unaffected. `tg help format` and the installed
  `tg` skill document the good-vs-bad structured shape.

## 1.39.0

**Feature: `/tasks` gains a Review column, and `--title` bans bare ticket codes too.**

- `/tasks` (the lifecycle board) now shows a Review column alongside the existing ones.
- The `--title` guard already refused a `tg#<id>` message reference (inert in the one-line
  header, only duplicates a followable body reference). It now also refuses a bare ticket
  code (`HYP-1234`, any 3-uppercase-letter `TEAM-<n>`), naming the first offending code in
  the error. A compound list (`HYP-1/2/3`) is caught too; GitHub-style `#N` stays allowed
  since it is not a code and `closes #42` is legitimate.

## 1.38.2

**Fix: label the main session by project window/cwd, not version/subagent.** The main session's
Telegram label now derives from the project window name / working directory instead of the tool
version or subagent name, so reports are attributed to the right project.

## 1.38.1

**Fix: `tg-ctl` control-surface routing, subagent-name attribution, and #183 stale-inbound.**
Control messages route to the right surface, subagent replies carry the correct agent name, and
stale inbound messages are no longer replayed after a restart.

## 1.38.0

**Feature: graceful `tg-ctl` reload preserves the defer-while-waiting backlog.** A reload no
longer drops messages deferred while the daemon was waiting; the backlog carries across the
reload so nothing queued is lost.

## 1.37.0

**Feature: agent-scoped tg replies.** A reply is now attributed to and routed for the current
agent, with `--agent` / `--all` / `--untagged` selection, so multi-agent sessions no longer cross
their inbound replies.

## 1.36.0

**Feature: `!shell` messages are injected verbatim for harness passthrough.** A `!shell`-prefixed
message is passed through to the harness unchanged, and a `!shell` reply is routed back to the
origin pane, so a shell command typed from Telegram reaches the intended session verbatim.

## 1.35.0

**Feature: stray-CJK guard blocks garbled hieroglyphs stuck into normal text.**

- A message (or `--title`) whose dominant script is Latin/Cyrillic but that
  carries a LONE CJK / ideographic codepoint stuck mid-word (e.g. a garbled
  `ка<CJK>eat` or `<CJK>ляет`, the shape an LLM occasionally emits) is now a HARD
  ERROR before send. The error names each offending character, its `U+XXXX`
  codepoint, and its position so the sender re-sends clean.
- Precision over recall: a lone CJK codepoint is flagged only when a
  Latin/Cyrillic LETTER immediately FOLLOWS it (the ideograph splits or prefixes
  a word). A genuinely CJK message (dominant script is CJK), a multi-character
  bilingual word (`Deploy到生产`, `3D打印`, `Word文書`), a CJK suffix/particle that
  ends a token (`iOS版`, `React를 배포`), a space-delimited CJK quote, emoji, and
  accented Latin all pass untouched.
- ON by default (feature `cjk-guard`); escape with `--no-feature cjk-guard` or
  `features.cjk-guard: false` in `~/.config/tg-cli/config.yaml`.

## 1.34.7

**Fix: flat `/new` spawns reliably, honors an inline directory, accepts args in any order, and never loops on a spawn failure.**

- `tmux new-window` now targets the session unambiguously (`-a -t =<session>:`),
  so a numeric session name (e.g. a session literally named `1`) is no longer
  misparsed as a window index — the `create window failed: index 1 in use`
  collision that aborted every `/new` in such a session is gone.
- An inline absolute directory is used in ANY position, including after the name
  (`/new hyperos /path`), and skips the "pick a project" prompt.
- `/new` parses its arguments (name, directory, harness, model) by shape in any
  order, so only the genuinely-missing pieces are asked interactively.
- A spawn failure now reports the real error once and offers a single "Retry
  spawn" button that keeps the already-chosen name/dir/harness/model, instead of
  silently re-asking the model question in a loop.

## 1.34.6

**Fix: tg-ctl keeps daemon replies in their Telegram topic and reports private-topic setup accurately.**

- Daemon-owned commands such as `/status`, `/limit`, `/agent`, and flat `/new`
  prompts now preserve the source topic thread instead of replying in General.
- Private-chat topic setup now follows the Bot API private-topic capability path:
  it checks `getMe.has_topics_enabled`, uses `createForumTopic`, and reports
  explicit fallback diagnostics without telling users to convert the chat to a
  forum.
- Telegram API 4xx error bodies are parsed for their `description`, so setup
  warnings show the actionable Bot API error instead of raw JSON.

## 1.34.5

**Fix: Telegram `/tasks` now opens on the work that needs attention.**

- The default `/tasks` board now filters to stuck/problem or ready tasks instead
  of dumping every lifecycle state.
- Task title cells start with compact status-group emoji, and rows group by
  agent/project when that context is available.
- The Telegram task board now includes quick filter buttons and pagination
  callbacks for larger result sets.
- Developer note: `matchPrsToTasks` now keys its returned map by `taskKey(task)`
  so duplicate task ids from different projects do not overwrite each other.

## 1.34.4

**Fix: Codex usage telemetry now has an automatic local collector.**

- `tg-ctl install-hooks` now installs a Codex `Stop` hook that runs
  `tg-ctl codex-usage-hook`; after the user trusts it in Codex `/hooks`, it reads
  the local Codex transcript tail and forwards supported `token_count.rate_limits`
  samples into `tg-ctl harness-event --agent codex`.
- The collector reuses the existing latest-sample store and warning dedupe, so
  repeated high samples do not duplicate Telegram warnings and below-threshold
  samples stay quiet while still updating `/limit codex`.
- Codex documents `transcript_path` for hooks but does not make the transcript
  JSONL format stable. The collector is therefore best-effort until Codex exposes
  a stable quota/status hook payload.

## 1.34.3

**Fix: dirty-pane routing warnings now guide clarification and subagent routing.**

- Dirty-pane warnings no longer suggest finishing or committing unrelated work
  before handling a new inbound Telegram message. They now ask the agent to
  clarify cross-project messages, route clarifications to the active subagent,
  or start a new subagent for genuinely new tasks.

## 1.34.2

**Fix: StopFailure overloads auto-continue and Codex hard limits explain missing telemetry.**

- Retryable StopFailure API overloads such as provider 529 responses now arm a
  delayed automatic continue for the originating pane. The retry attempt is
  persisted per pane/session with the delayed child PID, uses an increasing
  logarithmic backoff, re-arms a lost child, and duplicate-pending events do not
  spawn a tight retry loop. A retry window stops after eight auto-continue attempts.
- Russian sessions inject a localized continue command; other sessions inject
  `continue`. Non-retryable auth, billing, invalid-request, missing-model, and
  max-output-token failures only notify.
- Codex hard usage-limit StopFailure prose now parses `try again at ...` reset
  times. The Telegram notification now diagnoses either missing/unsupported/
  shadowed/deduped Codex quota telemetry, a stale stored sample, or a recent
  supported telemetry sample that stayed below the 90% warning threshold.
- Near-limit and hard-stop messages now state that the shown reset is the
  natural reset, and that banked/earned resets require an explicit `/usage`
  redemption. tg-cli does not silently auto-spend banked resets.

## 1.34.1

**Fix: send UX now reports tg refs and warns on dense plain reports.**

- Successful sends now print reusable `tg#<message_id>` refs on stdout while
  keeping `OK` first for compatibility. Multi-message sends print every returned
  ref in wire order.
- `tg --help` now documents the success output refs and nudges longer agent
  reports toward headings, blank-line paragraphs, lists, and tables, including
  `--format html` and `tg --table` where appropriate.
- Sending a long text-only plain message with no visible structure now emits a
  non-blocking stderr warning before sending. Short pings, structured plain text,
  `--format html`, `--table`, and media/file sends are left quiet.
- Added pure helper coverage and real-CLI smoke tests against a mock Bot API,
  including split sends, media albums, and failure paths that print no fake refs.

## 1.34.0

**Feature: escalation-format gate — `question` tag + `pre-send-text` hook point.**

Non-breaking: the escalation-format check is ADVISORY (warn-mode) by default —
nothing that worked before hard-fails now.

- New canonical `--tag question` (renders like `decision` — same orange dot —
  but stays on the unicode fallback badge for every viewer, since it has no
  dedicated pill asset yet).
- `--tag decision`/`--tag question` should carry a literal table in the message
  body (a markdown pipe table, `tg --table`, or an HTML `<table>`). A send with
  none is WARNED — the actionable, copy-pasteable guidance is printed to stderr
  and **the send still proceeds**. Set `ESCALATION_GATE_ENFORCE=1` (default OFF)
  to make a table required (the send then hard-errors, exit 1). This is a
  skill-first → warn → flip-to-block rollout: a later release flips the enforce
  default once the tg skill documents the requirement and a warn period passes.
- New `pre-send-text` agents-hooks/v1 point (the sibling of the existing
  `pre-send-photo` point): fires for every text send, on the final assembled
  body, right before the transmitter sends it. A trust-by-default drop-in
  descriptor under `~/.agents/hooks/tg/` can inspect/warn/block a text send
  the same way an existing photo hook does.
- Ships a reference `escalation-format-gate` hook (WARN MODE ONLY — never
  blocks) that checks the FINAL body for a literal table and prints an
  actionable warning when missing; nothing installs it automatically yet.
- `audit.jsonl` gains a generic `gate_*` / `body_sha256` field extension any
  hook can report, and is now rotated (capped, mirroring the reply-history
  cap) under a cross-process lock instead of growing forever.

## 1.33.4

**Fix: Claude Code subagent auto labels now use sidechain metadata when available.**

- `tg` still treats `--agent` and `TG_AGENT` as the explicit source of truth, but a
  Claude Code Task-tool child now tries to read
  `~/.claude/projects/<project>/<session>/subagents/*.meta.json` before falling back
  to the generic `[subagent]` label.
- Matching is conservative: agent id and `toolUseId` are exact, and the freshness
  fallback is used only when there is a single unambiguous recent metadata record.
  Ambiguous parallel subagents continue to render `[subagent]` rather than risk the
  wrong name.
- `CLAUDE_CODE_CHILD_SESSION=0` / `false` no longer marks a top-level process as a
  subagent, which protects shells that carry false-like Claude flags.
- Added unit and real-CLI send coverage for metadata-derived labels, ambiguous
  fallback, explicit-override precedence, and false-like child-session values.

## 1.33.3

**Fix: bare `/agent` button selection now routes the next message.**

- Tapping an agent after a bare `/agent` now arms a one-shot route for the next
  ordinary inbound message, instead of only editing the prompt to suggest
  `/agent <selector> <message>`.
- The selected prompt keeps a `Cancel` button. Tapping it removes the pending
  one-shot route, so a later message falls back to the normal router/picker.
- Added daemon integration coverage for both the next-message route and Cancel
  clearing the selection.

## 1.33.2

**Fix: Telegram photo/document routing now honors replies and `/agent` captions.**

- Photo/document replies now carry the replied-to message id and quote anchor
  through the `download-media` action. After the file is downloaded, the daemon
  routes the `sent photo:` / `sent file:` receipt through the same origin-pane
  reply handler as typed replies, so a screenshot reply to an `ext` report lands
  in `ext`, not in the last active agent.
- Photo/document captions that start with `/agent ...` are parsed before
  download and routed to the selected agent after the local file path is known.
  The injected receipt keeps the caption body and source message id, but does not
  inject the `/agent <selector>` command line itself.
- Added parser and daemon integration coverage for media reply routing,
  `/agent` media captions, and history pane stamping for media replies.

## 1.33.1

**Fix (tg#6651/tg#6672): calibrate the empty-editor watermark heuristic against real VS Code screenshots.**

- `looks_like_empty_vscode_watermark()` (`features/hooks/review-descriptor/pre_send_photo.py`)
  never actually fired on a real empty-VS-Code-window screenshot, despite being
  designed exactly to catch that case — every prior test fixture was synthetic and
  ~15x higher contrast than reality. Two real reference screenshots (Dark Modern
  theme, Explorer + a docked Chat panel, zero editor tabs) both returned `False`
  under the old constants.
- Two compounding bugs found by direct pixel analysis: (1) the old sample box
  (20-90% of window width) physically overlapped the docked right panel, so panel
  divider lines and foreground content — not the watermark — were the actual
  "non-bg" signal detected, blowing the compactness span up to ~0.8-0.93; (2) even
  past that, the real watermark logo's own contrast against the editor background
  is only ~6-7 RGB levels, invisible under the old `WATERMARK_BG_TOL=20`.
- Recalibrated four constants together against the real screenshots: narrowed
  `WATERMARK_BOX` to 25-72% of width (clear of the docked panel), lowered
  `WATERMARK_BG_TOL` 20 -> 6, raised `WATERMARK_NONBG_RATIO_RANGE`'s ceiling
  0.10 -> 0.15, raised `WATERMARK_MAX_SPAN_RATIO`'s y-cap 0.40 -> 0.50. Verified
  against 7 real BUSY full-window screenshots (code editor + preview + error/table
  panes) pulled from other HyperIDE e2e runs — none false-positive under the new
  constants.
- New tests: `tests/hooks-watermark-detector.test.ts` gained real-screenshot
  fixture tests — two positive (`tests/fixtures/vscode-empty-watermark-{1,2}.png`)
  and one real-busy negative (`vscode-busy-content-1.png`, a code editor + Hyper
  Canvas preview pane) — alongside the existing synthetic ones, so the
  false-positive direction is locked in against a real capture too, not only
  synthetic noise (review finding). Three synthetic negative fixtures that
  hardcoded the OLD box fractions now read `WATERMARK_BOX` live from the module
  instead, so they can't silently drift out of sync with the box again. Still
  WARN-only, not a block — see the CALIBRATION comment in `pre_send_photo.py`
  for the honest limits of this pass (both real positive fixtures are the same
  panel layout; the tol margin is narrow, not comfortable).

## 1.33.0

**Feature: git-state-check banner — warn before a message lands in an occupied pane.**

- Root cause fix for a real incident: tg-ctl routes an inbound message to a tmux
  PANE, not to "the agent's current task". A fresh, unrelated message can land
  in a pane that is mid-flight on unrelated feature work, and the pane — human
  or AI — has no signal that this is a NEW thread, not a continuation of what
  it was just doing.
- `tg-ctl` now checks the destination pane's cwd (uncommitted changes, or a
  branch other than main/master) right before a SILENT auto-bind delivery
  (plain inbound text, a photo/document notice, a standalone voice transcript)
  and, when the pane is mid-flight, prepends a warning banner naming the branch
  and file count, so neither a human nor an AI agent silently treats the new
  message as more of the same task.
- Deliberately scoped to the un-anchored auto-bind path only: a reply (already
  anchored to a specific prior message), a forum-topic route, a fresh `/new`
  spawn, and a picker-tap delivery (the human already chose the pane) are
  unaffected.
- New `control.git_state_banner` config flag (default `true`) opts out per
  machine. Honest tradeoff: an agent that always works on a feature branch sees
  this banner on every delivery to that pane — the check detects "this pane
  has work in flight", not "this message is off-topic", and those are not the
  same thing.

## 1.32.2

**Fix: deferred Telegram replies now flush after question release instead of asking for a resend.**

- Queued inbound messages behind an unscoped timeout, hook socket close, or
  question-card send failure now drain into the target pane once the blocking
  question is released, instead of sending the misleading `were NOT delivered.
  Resend them.` notice.
- Source message reactions keep the visible lifecycle: queued messages still get
  **✍️** immediately and now flip to **👀** after the post-timeout/post-close/
  send-failure flush succeeds.
- The live-question guard remains: if another question is still pending on that
  pane, the backlog stays queued for that question rather than being flushed over
  its prompt.

## 1.32.1

**Fix: `tg-ctl start` no longer inherits a soon-to-be-deleted worktree cwd.**

- Root cause for the false "Claude Code not in tmux" replies after deploying
  1.32.0: the detached `tg-ctl run` daemon inherited the caller's current
  directory. When deploy was run from a feature worktree and that worktree was
  removed after merge, the live daemon kept a deleted cwd; later `tmux`/`ps`
  discovery calls failed and the daemon reported no agent even though Claude was
  still alive.
- `tg-ctl start` now launches the detached daemon through the deployed
  `~/.files/bin/tg-ctl` path when available and pins `PWD` to that stable bin
  directory, so cleanup of the caller's worktree cannot break inbound routing.
- Telegram question/permission cards now show their source (`agent`,
  `subagent`, tmux window/pane/session, and cwd), and the answered card keeps
  that context with the selected answer.
- `/tasks` without an explicit agent now scopes to the replied-to or routed
  project, not to the daemon's own stable cwd. Ambiguous multi-agent cases now
  ask for an explicit `/tasks <agent>` instead of guessing the newest
  registration.

## 1.32.0

**Feature: timed-out Telegram questions stay answerable, and `/limit` reports latest agent quotas.**

- Scoped question cards are no longer erased when the hook socket closes or the
  harness falls back to the terminal prompt. Telegram now shows the original
  question, marks the time-out as expired, replaces option buttons with **Close**,
  and accepts a reply to that card as the post-factum answer.
- Answered question cards keep the original prompt context and selected answer
  instead of collapsing to `answered: ...`, so later readers can see what was
  asked, what was chosen, and which agent asked.
- Deferred inbound text behind a scoped terminal-fallback question is no longer
  reported as "not delivered"; it drains through the pane contract instead of
  leaving misleading stale ✍️ state.
- Added `/limit [<agent>]` to the Telegram control daemon. Claude/Codex/Pi/custom
  usage telemetry samples are saved as latest snapshots, including below-warning
  buckets, so `/limit claude` can show both 5-hour and weekly usage.

## 1.31.1

**Fix: `tg-ctl install-hooks` now wires Claude proactive usage telemetry.**

- Root cause for missed Claude weekly-limit warnings: `tg-ctl harness-event` already
  understood Claude Code `statusLine.rate_limits`, but `install-hooks` only installed
  q→buttons and StopFailure. A session could reach 98% weekly usage without any
  StopFailure, and nothing was piping the statusLine payload into `harness-event`.
- `install-hooks` now wraps the existing Claude `statusLine` command, preserves its
  visible output, and sends a secure private copy of the statusLine JSON to
  `tg-ctl harness-event --agent claude` for the existing >=90% deduped warning path.
  If no `statusLine` existed, it installs a silent collector instead of changing the
  visible Claude UI.
- `tg-ctl status` reports the proactive `usage telemetry` channel separately from the
  StopFailure hook, including project/local `statusLine` overrides that shadow the user
  hook, so a future missing collector is visible instead of silently dead.
- Running `install-hooks` from a shadowed project wraps that project-local statusLine
  override too, and the statusLine collector is throttled to one `harness-event` launch
  per 30 seconds by default.

## 1.31.0

**Feature (HYP-903 follow-up): harness-aware `/new` spawning for Codex and opencode.**

- Flat `/new` now accepts either a harness or a concrete model around the session name:
  `/new codex task-cli msg`, `/new task-cli opencode msg`, `/new oc task-cli msg`,
  `/new gpt-5.5 task-cli msg`, and `/new task-cli glm-5.2 msg` all parse as expected.
- When no harness/model is supplied, the interactive flow now asks for the harness first
  (Claude, Codex, opencode), then filters the model buttons to that harness. The old generic
  "Which model should ..." prompt no longer shows Claude choices after the user intended Codex.
- Added verified Codex and opencode model catalog entries. Codex launches with
  `codex --model <id>`; opencode launches with `opencode --model <provider/model>`.
- The initial `/new` task is passed into the spawned agent for both plain flat sessions and
  private-topic-backed sessions; opencode receives it through `--prompt=<text>`.
- The flat `/new` callback namespace gained `tnh:` for harness picks; existing `tnp:` directory
  picks and `tnm:` model picks remain unchanged.

## 1.30.1

**Feature (tg#6254): subagent identification — `--agent <label>` + auto-detection.**

- An orchestrator that fans work out to several subagents (Claude Code's Task tool)
  loses the sender's identity once a subagent calls `tg` directly — the recipient could
  see a message with no way to tell "the orchestrator" from "subagent #3" apart, only that
  some AI sent it. `--agent <label>` renders its own `[label]` bracket right after
  `[window]`, styled identically (Sans-Serif Bold, `<b>` Cyrillic fallback).
- `TG_AGENT` env is the same-precedence fallback as `TG_AI_MODEL`: explicit `--agent` flag
  wins, then `TG_AGENT`, then auto-detection.
- Auto-detection (`features/agent-detect/detect.ts`): investigated against every harness on
  the dev machine. Claude Code sets `CLAUDE_CODE_CHILD_SESSION=1` ONLY in a Task-tool
  subagent's own process — the one reliable automatic "is this a subagent" signal found —
  so `tg` auto-labels it the generic `subagent`. It cannot say WHICH subagent (no per-agent
  id/description reaches the child env); an orchestrator wanting a specific name must still
  pass `--agent` itself. No equivalent signal exists today for Codex CLI (0.142.4) or
  opencode (1.17.10) — `--agent`/`TG_AGENT` is the only path there.
- `--detect-agent` prints what the current shell would auto-detect (mirrors
  `--detect-model`).
- Not to be confused with `tg-ctl`'s own `--agent <name>` (a closed harness-kind selector
  for `tg-ctl ask`/`harness-event` telemetry) — same word, different binary, different
  parser, no collision.

## 1.30.0

**Feature (HYP-891 follow-up): empty-editor watermark WARN heuristic in `pre-send-photo`.**

- Added `looks_like_empty_vscode_watermark()` to
  `features/hooks/review-descriptor/pre_send_photo.py` — detects VS Code's own "no
  tabs open" watermark (a small, compact cluster of hint-row glyphs on an
  overwhelmingly flat background, centered in the editor pane), the signal Alex
  proposed (tg#6071) as a precise replacement for the removed 1.26.1 heuristic. Unlike
  that removed check (which matched ANY full window via a dark left activity-bar
  strip), this one is scoped to a central box and requires a small, compact glyph
  cluster on a flat field — real content (code, a rendered preview, a webview) cannot
  produce the pattern regardless of how busy the surrounding Explorer/Inspector/Logs
  panels are.
- **WARN-only, not a block** — a deliberate choice, not an automatic carry-over of the
  old block behavior. The detector's thresholds are reasoned from VS Code's known
  watermark layout, not calibrated against a captured reference screenshot; blocking
  on an unvalidated pixel heuristic is exactly the HYP-891 failure mode. It surfaces a
  stderr warning in the audit trail without bricking the send. Promoting it to a block
  is a follow-up once real false-positive/negative field data exists.
- New tests: `tests/hooks-watermark-detector.test.ts` (synthetic PIL fixtures — no
  real VS Code screenshot exists to calibrate against).
- `review diff` findings addressed pre-merge: background-color estimation is
  quantized-bucket based (not exact-tuple) to survive PNG/JPEG re-compression
  and font-AA noise; the compactness (span) check trims outlier coordinates
  instead of raw min/max so a single stray non-bg pixel elsewhere in the box
  can't blow the span up and hide the real cluster; the sample box was widened
  and shifted (20-90% W, 15-65% H, was a symmetric 28-72%/18-62%) because the
  watermark centers on the EDITOR PART, not the window — a symmetric box
  misses it on the common "Explorer open, nothing docked right" layout where
  the editor part sits right of window-center; the density lower bound was
  lowered 0.005 -> 0.001 (safety margin below a measured ~0.006 for a
  realistic sparse icon+text-row fixture) since real hint text could render
  thinner than that synthetic floor case; two test-fixture aliasing bugs
  were found and fixed where a draw pattern's pixel spacing shared a common
  factor with the detector's own WATERMARK_SAMPLE_STEP=3 sampling grid,
  making a fixture pass/fail for the wrong reason (a "dense random content"
  negative fixture, and an earlier "sparse glyph" positive fixture whose 1px
  rows landed on zero sampled pixels by phase) — both rewritten so every
  drawn stroke is >=3px in each dimension, which guarantees a grid hit
  regardless of phase, verified across multiple phase offsets.
- `from __future__ import annotations` (already present, first statement
  after the module docstring) makes the new `X | None` return annotations
  safe on Python <3.10 — confirmed, not changed; called out here because
  `review diff` flagged it twice without visibility into the file header
  (outside the diff hunk it reviews).
- Two more tests added post-review: an explicit symmetric check that a REAL,
  busy full-window screenshot produces zero watermark-related warnings
  end-to-end (only the positive/watermark-shaped path was covered before),
  and a documented KNOWN LIMITATION test — the detector cannot distinguish
  VS Code's specific watermark glyphs from any other small, compact UI
  element on a flat background (a centered dialog, a spinner, a toast, an
  almost-empty terminal, a lone logo on a white preview); this is an
  accepted false-positive surface for a WARN-only, unvalidated heuristic,
  now captured as an executable spec rather than tribal knowledge.
- Final review round: `_trimmed_span_ratio`'s outlier trim was silently a
  no-op for any n <= 19 (`int(n * 0.05) == 0` in that range) — fixed to
  guarantee at least one point trimmed off each end once there are enough
  points for that to leave a >=2-point core (n >= 4; a later fix tightened
  this from an initial >=1-point-core version, see below), with a direct
  unit test (a single far outlier no longer blows up the span).
  Tests now `test.skipIf(!pilAvailable)` the whole file — Pillow is a soft
  dependency of the hook itself, and hard-failing the suite when it's
  missing would make this file flap by environment, matching the existing
  `tmuxAvailable` skipIf pattern in `tests/ctl-tmux-integration.test.ts`.
- `WATERMARK_MAX_SPAN_RATIO` tightened 0.70/0.80 -> 0.35/0.40 (review
  finding): the old caps let a cluster cover up to 70-80% of the sample box
  and still count as "compact", effectively disabling the check the
  docstring/CHANGELOG claim distinguishes a watermark from real content.
  Every measured positive fixture spans <=0.26 on either axis; the new caps
  keep real margin above that while now correctly rejecting a moderate-
  spread pattern (two compact glyph-sized blocks ~54% of the box apart,
  density still in-range) that the old caps let through. New test locks in
  that specific boundary — previously only the two extremes (whole-box
  scatter, and density rejection) were covered, leaving the actual
  false-positive-prone middle ground untested.
- Performance (review finding): `_sample_box` had no upper bound on the
  cropped box before per-pixel `PixelAccess` sampling — a Retina/4K
  screenshot's box can be ~2700x1100, adding a few hundred ms of pure-Python
  work to every `pre-send-photo` send, unbounded and untimed (unlike the
  `review visual` subprocess call). Now caps the box's longest side at 1200px
  via `Image.Resampling.BOX` downscaling (area-averaging, so a thin stroke
  survives as a blended gray pixel instead of vanishing under a NEAREST
  gap) before sampling; the span/compactness ratios are scale-invariant, and
  the density ratio approximately so (walked back an earlier overclaim —
  area-averaging COULD blend a very thin stroke enough to fall inside
  WATERMARK_BG_TOL, nudging density down; accepted for a WARN-only,
  unvalidated heuristic). Verified on a synthetic 3840x2160 image: ~42ms
  (was unbounded), still detects the scaled-up cluster; new dedicated test
  exercises the resize branch (every other fixture is 1600x900, whose box is
  under the 1200px cap, so it was previously untested).
- `Image.Resampling` (the enum) only exists on Pillow >= 9.1 (review
  finding): on older Pillow, `Image.Resampling.BOX` raised AttributeError,
  silently swallowed by the detector's blanket fail-open `except Exception`
  — meaning it would NEVER fire on exactly the large screenshots the new cap
  targets, on any host with an older Pillow. Fixed with
  `getattr(Image, "Resampling", Image).BOX`, which falls back to the
  pre-9.1 flat `Image.BOX` constant.
- `_trimmed_span_ratio` degenerated to span=0 for any n where trimming left
  only a 1-point core (e.g. 3 points at [0, 500, 1000] trimmed to a single
  midpoint, reading as maximally "compact" regardless of real spread) —
  review finding. Fixed to require a >=2-point core before trimming at all.
  Unreachable through the full detector pipeline today (the density floor
  guarantees far more samples), but the function is documented and
  unit-tested as a general-purpose utility, so its own contract now holds
  independent of the caller.
- WARN message text softened (review finding): it named "VS Code's 'no tabs
  open' hint rows" unconditionally, but the detector runs on every
  `pre-send-photo` event, not just IDE screenshots — a compact logo on a
  plain background in an unrelated photo would get the same VS-Code-specific
  wording. Now hedged ("possible" / "consistent with") without changing the
  detection logic.
- `_trimmed_span_ratio` docstring now states its known limit explicitly
  (review finding): per-axis trimming caps at ~5% of the mass on each end,
  so it defends a LONE outlier, not a genuine minority second cluster below
  that fraction — accepted for a WARN-only heuristic; a real fix would need
  actual clustering, not a 1D span statistic.
- The "REAL-content full-window" end-to-end negative test also switched to a
  step-1 (every pixel) fill for the same aliasing reason as the unit-level
  "dense random content" test, so it exercises the density check too, not
  only the span check.
- Two more review nits fixed: the `_trimmed_span_ratio` unit test and the
  "unreadable path" fail-open test need only `python3`, not real Pillow —
  gating them on `pilAvailable` meant they'd silently skip in exactly the
  no-Pillow environment they exist to cover; split into a separate, narrower
  `pythonAvailable` check. And `runCapturingWarnings`'s PATH restore now
  guards the `savedPath === undefined` case explicitly instead of assigning
  `process.env.PATH = undefined`, which JS coerces to the literal string
  `"undefined"`.
- Last review pass — all cosmetic/test nits, no further correctness issues
  found: fixed a stale coord-count in the outlier unit test's comment (said
  "14 clustered / n=15", the array is 13 clustered + 1 outlier = n=14); the
  "PIL genuinely unavailable" test was gated on `pilAvailable` when it exists
  specifically to simulate Pillow's ABSENCE (same class of gate mismatch as
  the two tests fixed earlier) and referenced a real repo screenshot path
  that's never actually opened (the poisoned import raises first) — moved to
  `pythonAvailable`, path swapped for an explicit placeholder; added a direct
  `_trimmed_span_ratio([single point])` test locking in the n=1 edge case.
- `_trimmed_span_ratio`'s own degenerate case (a >=2-point-core requirement
  fix, above) now has a direct assertion: `[0, 500, 1000]` at n=3 must read
  as span 1.0 (not compact), not 0.0 — the exact case the fix's docstring
  names as motivation, previously only implied by the code, not asserted.
- `WATERMARK_BOX_MAX_DIM` only bounds the per-pixel SAMPLING loop, not the
  `Image.open(...).convert("RGB")` decode itself, which forces a full
  source-resolution decode first and has no timeout — unlike the amount of
  work capped by `WATERMARK_BOX_MAX_DIM`, unlike `review visual`'s
  subprocess call (review finding: a large phone photo sent through the
  same `pre-send-photo` point would add unbounded decode latency to every
  send). Added a cheap `os.path.getsize` guard (`WATERMARK_MAX_FILE_BYTES`
  = 20MB, no decode at all) that skips the heuristic outright above that
  size; ordinary screenshots are unaffected.
- Added a fixture combining BOTH conditions CHANGELOG flagged as an
  unverified false-negative risk together (a large/downscaled screenshot
  AND thin, realistic (not bulky-block) hint-row strokes) — previously the
  "4K" test used a solid block and the "thin strokes" test used a
  1600x900 source under the resize cap, so neither test alone proved BOX-
  averaging preserves a thin stroke through an actual downscale. It does:
  unscaled (absolute-pixel) strokes on a 4K canvas are proportionally
  smaller than the 1600x900 case, and still detect after the ~2.24x BOX
  downscale.
- The new `os.path.getsize` guard (above) still imported `from PIL import
  Image` BEFORE the guard's own check, so the "skip large files without
  decoding" short-circuit wasn't actually PIL-free -- a direct
  `_sample_box()` call in a no-Pillow environment would raise `ImportError`
  *outside* the fail-open wrapper (review finding), breaking exactly the
  `pythonAvailable`-without-Pillow test scenario the guard's own test is
  gated for. Reordered so the size check runs first; also extracted the
  downscale step into its own `_downscale_box_if_needed()` helper.
- That same reorder broke the "PIL genuinely unavailable" test's own intent
  (review finding): it used a nonexistent placeholder path, which now hits
  `os.path.getsize`'s `FileNotFoundError` and short-circuits BEFORE `from
  PIL import Image` ever runs — passing regardless of whether the poisoned
  `sys.modules['PIL'] = None` import actually fails, i.e. no longer testing
  what it claims to. Switched to the hook's own (small, existing) source
  file as the path, so `getsize` passes and the poisoned import is reached.
- `WATERMARK_MAX_FILE_BYTES` bounds the COMPRESSED size on disk, not the
  DECODED pixel count (review finding): a highly compressible source (e.g.
  flat-color, or a heavily-compressed JPEG) can be a few MB on disk yet
  decode to tens of megapixels, and `.convert("RGB")` forces that full
  decode with no timeout — there's no subprocess boundary here to enforce
  one, unlike `review visual`. Added `WATERMARK_MAX_PIXELS`, checked via
  `im.size` BEFORE `.convert("RGB")` (Pillow reads dimensions from the file
  header lazily, without a full pixel decode, so this check is cheap
  regardless of true resolution). Verified: a flat 8000x6000 (48MP) PNG
  compresses to <1MB — clears the byte guard, correctly rejected by the
  pixel guard. Set to 24M (~6000x4000, a common phone/DSLR resolution) —
  lowered from an initial 40M (review finding: still leaves worst-case
  decode+convert latency effectively open-ended for a legitimate-but-huge
  photo) to bound that cost to the low hundreds of ms.
- Added the e2e test the "watermark scan runs before the `review`-on-PATH
  check" comment in `main()` claimed but nothing exercised (review finding):
  an isolated PATH with no `review` binary at all (same isolation pattern as
  `hooks-review-descriptor.test.ts`'s "review missing on PATH" test) still
  produces the watermark WARN, proving that invariant instead of just
  asserting it in a comment.
- Two more test gaps closed (review finding): the `w < 800 or h < 500` floor
  was only tested from the "too small" side (400x300); added an exact
  800x500 fixture proving the strict `<` boundary doesn't accidentally skip
  the floor value itself. And a truncated/corrupt PNG (half the bytes of a
  valid file — `Image.open` succeeds lazily on the header, `.convert("RGB")`
  raises `OSError` partway through decode) now has a dedicated test proving
  that specific, arguably most-likely-in-practice failure mode is caught by
  the same blanket fail-open as every other error path, not a missed case.

## 1.29.2

**Fix (#141, closes #140): forward the outgoing photo caption as `--intent` to
`review visual`.** (Retroactive entry — #141 merged to main without a
CHANGELOG update; added here while reconciling it with the #133/HYP-891 branch
above, so the version ladder has no undocumented gap.)

- The pre-send-photo hook receives the outgoing caption in the event args
  (`args.caption`) but never forwarded it — `review visual` was always invoked
  as `[visual, image_path, --json, --strict]`, no `--intent`. review-cli's
  intent-gated contributed modules (e.g. `selection-highlight`'s hard CV veto)
  only activate when `--intent`/`--check` mentions their tag, so that whole
  activation path was inert for every tg-sent photo, in any language
  (tg#6188).
- `--intent=<value>` is forwarded as ONE argv token (not two) so a caption
  starting with `-`/`--` doesn't get misparsed by argparse as the next option.
- `_safe_intent()` sanitizes the caption before it reaches `--intent`: strips
  NUL bytes, trims to `_MAX_INTENT_CHARS` (4096), and pre-validates
  encodability — an unencodable caption (e.g. a lone UTF-16 surrogate) drops
  `--intent` rather than letting `subprocess.run`'s own `UnicodeEncodeError`
  (a `ValueError` subclass) crash the entire `review visual` call and
  silently disable verification for that photo. The `except` around
  `subprocess.run` is widened to `(OSError, ValueError)` to still fail open
  on `image_path`-side NUL bytes without that widening ever being reachable
  via a crafted `--intent` value.
- 18 tests in `tests/hooks-review-descriptor.test.ts`: canonical argv,
  non-English forwarding, leading-dash forwarding, whitespace trimming,
  embedded-NUL stripping, oversized-caption truncation, lone-surrogate
  handling (proves `review visual` still runs), and no-caption/blank-caption
  cases.

## 1.29.3

**Fix (HYP-891): remove the `pre-send-photo` full-window-screenshot block.**

- Removed `looks_like_vscode_window()` from
  `features/hooks/review-descriptor/pre_send_photo.py` — the pixel heuristic that
  hard-blocked EVERY full VS Code window screenshot (dark, uniform left activity-bar
  strip) regardless of whether the content inside it was actually broken. Added
  2026-07-01 (commit `87b4522`) to force cropped preview-pane proofs; superseded by
  Alex's 2026-07-03 standard (tg#6041) that full-window screenshots with
  Explorer/Inspector/Logs panels visible ARE the desired HyperIDE diagnostic proof
  format. The heuristic false-positived on legitimate full-window proofs at least
  twice in one day before removal — done at Alex's explicit direction (tg#6063/6064).
- `review visual --strict` (a vision-model verdict on the actual image content)
  remains the only gate left for a full-window send. Whether it reliably catches a
  broken/unstyled preview pane diluted behind busy editor chrome is UNVERIFIED —
  this is a known, accepted tradeoff, not a proven equivalent replacement. See the
  comment in `pre_send_photo.py` and HYP-891 for the follow-up if this needs
  strengthening later (e.g. a targeted vision check module scoped to the preview
  region instead of the whole window).

## 1.29.1

**Fix:** deferred `tg-ctl` messages now complete their Telegram reaction lifecycle.

- Messages queued behind an agent question still get the `✍️` queued reaction first,
  then flip to `👀` after the deferred text is successfully flushed into the agent pane.

## 1.29.0

**Feature (#138): `--title` refuses a `tg#<id>` reference.**

- `--title` is a one-line header that is never linkified downstream (unlike the
  body/caption, which the existing `autolink-msgrefs` feature handles). A `tg#<id>`
  typed there is dead text, so `parseArgs` now refuses it at parse time with a
  message pointing the reference at the body instead — the same rule task-cli/
  gh-ship enforce on a PR/ticket title.
- Gated on the same `autolink-msgrefs` feature flag the body-detection call uses:
  with the feature disabled, `--title` is exactly as permissive as the body.

## 1.28.1

**Fix (tg#6006): Telegram message references now link and carry compact excerpts.**

- `tg#<id>` and the already-rendered `𝒕𝒈#<id>` form are both detected in outbound
  `tg` messages. Supergroup/channel refs become `t.me/c/...` links; private-DM refs
  stay visibly styled but unlinked.
- When the referenced id exists in `tg replies` history, the outbound message adds a
  collapsed reference block with only the start of the original message plus `…` on
  truncation, rather than copying the whole referenced Telegram message. Excerpts use
  the same tag-safe walk as linking and are scoped by `chat_id` on new history rows.

## 1.28.0

**Feature (tg-cli#132): proactive harness usage warnings at 90%.**

- `tg-ctl harness-event` accepts externally-piped proactive usage telemetry when a
  confirmed limit contract reaches `>=90%`: Claude Code statusLine
  rate-limits/context, Codex `rate_limits`, Pi RPC `contextUsage`, or tg-cli's
  explicit `schema: "tg-cli.usageLimit.v1"` envelope for custom collectors such
  as an OpenCode plugin.
- Generic token/cost payloads are ignored rather than guessed. Warnings are
  deduped per agent/limit for the current reset window (or a one-hour cooldown
  when no reset is known), localize from payload/locale hints when possible, and
  otherwise render in English.

## 1.27.0

**Feature (tg-cli#130): reply quote-anchor carries the original message's
`tg#<id>`.** From Alex (tg#5978).

- `buildReplyAnchor`/`buildReplyInject` (`features/tg-ctl/updates.ts`) now
  render `↩ tg#<id> «[date time] head…»` — `tg#<id>` is
  `reply_to_message.message_id`, the Telegram id of the message being
  answered (almost always the agent's own prior report), rendered with the
  same `tg#` convention as the inbound wrap's own-message `{id}`. Previously
  only the reply's OWN id was surfaced (via the `[TG from {name} {id}]` wrap);
  the id of the message being REPLIED TO was invisible, so an agent whose
  context had compacted had no way to recover the original beyond the ~60-char
  truncated preview. Now it can pull the full text back with `tg replies` (or
  `tg replies --json` filtered by id) instead of guessing.
- Applies uniformly to text replies, voice-note replies, and prose replies
  inside a bound forum topic (all three route through the same
  `buildReplyAnchor`).
- Docs: `docs/specs/reply-quotes.md` and the README inbound-reply section
  updated to the new anchor format.
- **Fix (review: tg-cli#131):** a reply anchored to a non-first chunk of a
  >4096 split, or a non-first item of a media-group album, was NOT
  recall-able via `tg replies --json | select(.id == <tg#>)` — `tg` only
  wrote ONE history record, keyed to the first outbound message id, even
  though the route map (used to route an inbound reply back to its origin
  pane) already tracked every id. `buildOutboundHistoryRecords`
  (`features/replies/outbound.ts`) now writes one `agent` history record per
  outbound message_id, so every anchored id stays recall-able.
  `outboundHistoryText` also now combines a mixed photo+document send into
  one placeholder (`[2 photos, 3 files]`) instead of silently dropping the
  document count.
- **Fix (tg-cli#134, review: tg-cli#131 follow-up):** writing multiple
  records per send meant the plain (non-`--json`) `tg replies agent` listing
  printed one logical send as N duplicate-looking lines, and `-n`/`--limit`
  counted raw records instead of sends. Every true multi-part send is now
  tagged with a shared `groupId` (a caller-supplied random token, not the
  group's first id — Telegram message_id is per-chat-sequential, so reusing
  it as the key could collide across two chats sharing one bot's history
  file) and `select.ts` groups by that authoritative marker; `-n`/`--limit`
  now counts logical sends (not raw records) for BOTH the plain listing and
  `--json` — a kept multi-part send is never truncated mid-group, so a
  `--json -n N` result can carry more than N rows when the tail includes a
  multi-part send. The plain listing additionally collapses each group to
  one line; `--json` always returns every id of the kept sends, uncollapsed.

## 1.26.0

**Features (tg-cli#113, #114, #115): harness-limit notifications, reaction
lifecycle, and the `/tasks` board.** From Alex (tg#5698, tg#5699).

- **Harness limit/error notify + auto-continue (#113).** `tg-ctl harness-event`
  is a `StopFailure`-hook subcommand: fed the payload on stdin (+ transcript
  tail), it extracts the reason and reset time and messages the operator that a
  session hit its limit / errored. When the reset time is parseable the message
  carries an inline **auto-continue** button; tapping it arms a timer that
  injects `continue` into the originating pane at reset time (immediately if
  already past). Schedules persist to `*.schedules.json` and re-arm on daemon
  restart. `tg-ctl install-hooks` now also provisions the StopFailure hook.
  `--dry-run` renders WITHOUT sending. A **staleness guard** suppresses any
  alert whose reset time already passed, and every string is a real template
  (no leaked `%`-placeholder) — the two bugs a prior WIP leaked live.
- **Reaction lifecycle (#114).** 👀 working → 😴 stalled (limit-stop) → 👌 done.
  Alex's literal ⏳/✅ are `REACTION_INVALID` for a bot (verified live); 😴 and
  👌 are the allowed proxies. `tg --tag answer --reply-to <id>` now flips
  message `<id>` to the done mark.
- **`/tasks [<agent>] [<status>]` (#115).** A new bot command that composes
  `task list --json` + `gh pr list --json` into a rich-HTML board table (id,
  title, state, due, PR, CI), filterable by normalized status and scoped to a
  fuzzy-matched agent's project. Missing PR/CI renders as an em dash, never
  fabricated. Published in the bot menu.

## 1.25.0

**Feature (tg-cli#121): `tg replies --session` accepts a tmux WINDOW NAME, not only a pane id.**

- **`--session <name>` now scopes recall by tmux window name** (`tg replies --session ext`).
  Pane ids (`%7`) are un-typeable from memory; a human window name is what you actually know.
  A `%`-prefixed argument is still treated as a pane id (backward compatible); anything else is
  resolved as a window name.
- **Exact match, unioned across sessions.** `--session ext` matches ONLY the window literally
  named `ext` (never `ext: diagram`), and if several tmux sessions each have a window named `ext`
  it recalls the union of all their panes. Resolution shells out to
  `tmux list-panes -a -F "#{pane_id}\t#{window_name}"` (pane id first, TAB-delimited, so window
  names containing spaces survive intact).
- **An unknown window name is a structured error** — non-zero exit + `no tmux window named '<name>'`
  — rather than a silent empty recall. `--all-sessions` and the default (current pane) scope are
  unchanged.

## 1.24.0

**Fix (tg#5741): question buttons — the tapped answer never reached the agent; multi-question support.**

- **Answer envelope now stamps the REQUIRED `hookSpecificOutput.hookEventName`.** Claude Code
  ≥2.1.198 validates hook JSON output and DISCARDS the entire output when `hookSpecificOutput`
  lacks `hookEventName` — the Telegram card read "answered: …" while the agent fell back to the
  local question dialog and the answer never arrived. (The 2.1.170-era live spike passed without
  it; the spec's predicted contract drift happened.) The envelope also echoes the ORIGINAL
  `tool_input` (CC schema-validates `updatedInput` wholesale; option `description` is a required
  field there) with the collected `answers` merged in.
- **Multi-question AskUserQuestion (2-4 questions) now forwards** as one sequential Telegram card
  per question (`(i/N)` title suffix, per-question stable requestIds); the ask client composes ONE
  combined reply from the collected answers, so the tool completes with no local dialog and no
  extra final Enter. ALL-OR-NOTHING: any multiSelect/free-form question or any declined/timed-out
  card bails the whole call to the local UI — a partial answers record is never emitted.
- **Stale-daemon repair:** the ask client rebuilds a single-question reply from a RUNNING daemon
  that predates `hookEventName`, so the fix takes effect the moment the client updates. Restart
  the daemon (`tg-ctl restart`) to update the daemon side too.
- **A late tap on an abandoned multi-question member is refused** (review finding): after the
  ask client's budget elapses mid-collection, the local dialog owns ALL the questions — injecting
  one lone late answer could answer the WRONG prompt. The tap answers "the terminal took over";
  the retained entry and keyboard survive untouched, so reconnect re-attach across a daemon
  bounce (no duplicate card) keeps working; stale members expire via the retention window.
- **A re-attached card is restored to its live prompt** (review finding): the socket-close path
  edits the card to "window closed …"; when a resend re-attaches it, the original question text
  and keyboard are re-sent (Telegram's editMessageText detaches the keyboard when reply_markup
  is omitted), so the one card that works again no longer tells the user not to use it.
- **Question requestIds are seeded with the ordered option labels** (review finding): a later
  call re-asking the same question text with DIFFERENT options gets a fresh id, so it can never
  re-attach a stale retained card whose buttons would resolve by index against the new options.
  True re-fires (same text and options) keep their id — tg-cli#97 dedup/replay unchanged.
- **Multi-question member answers are never cached for replay** (review finding): an aborted
  round's partial answer must not silently stitch into a later identical re-ask — the re-run
  posts fresh cards (an outstanding member still re-attaches to its retained card).
- **`tool_input` now survives the daemon socket boundary** (review finding): the daemon-side
  request parser dropped it, silently downgrading a PreToolUse ExitPlanMode "Proceed" to a bare
  allow — which the hooks docs say is not sufficient for user-interactive tools. New round-trip
  integration test guards it. Duplicate question texts in one call (schema-invalid) now bail to
  the local UI instead of colliding requestIds / collapsing the answers record.

## 1.23.1

**Fix (tg-cli#57): permission card durability — retain on socket close, re-attach on reconnect.**

- `retainAbandonedQuestion` extended to cover `kind === "permission"` cards alongside questions.
- Socket-close text differentiation so permission cards are not discarded on disconnect.
- Delivery guard and persist filter ensure the tap reaches the harness after reconnect.
- 19/19 integration tests pass.

## 1.23.0

**Fix: `review visual` argv rename + VS Code window crop enforcement in pre-send-photo hook.**

- **`review visual` (no `--`) canonical argv** — the pre-send-photo hook and all references
  throughout now call `review visual <png> --json --strict` (subcommand form) instead of
  `review --visual`. The hook's argv test verifies the exact call surface.
- **Full VS Code window screenshot blocked** — `looks_like_vscode_window()` heuristic detects
  a full-editor screenshot by sampling the dark, uniform activity-bar strip on the left edge
  (calibrated: channel mean < 60, spread < 40) and blocks the send with an explicit crop
  instruction. A cropped preview-pane or narrow image passes through. Fail-open: any PIL
  error or missing dep treats the image as NOT a window.
- **Hook Caller Discipline** (AGENTS.md) — when a hook needs clearer callee semantics, fix
  the callee command surface and invoke that surface directly; do not change cwd or add
  caller-side env hacks.
## 1.22.0

**Feature (tg-cli#31): §11 forum-topic deferrals — reply anchor, slash intercept, rename persistence.**
Three behavioral completions for forum-topics mode:

- **Reply anchor in bound topics.** A reply to a message inside a bound forum topic now carries
  the same `↩ «…»` quote-anchor as flat-chat replies (`buildReplyInject`), so the topic agent
  knows which earlier message is being addressed.
- **Daemon-global slash commands intercepted.** `/status`, `/agent`, and `/new` sent from inside
  a bound topic are now routed to the daemon (not injected verbatim into the topic pane). `/stop`
  and `/kill` are explicitly not intercepted — they still reach the topic's harness session.
- **`forum_topic_edited` persists rename.** A topic rename service message now emits a
  `topic-rename` action: the daemon persists the new name in `TopicBinding` and calls
  `tmux rename-window` to keep the window slug in sync.

## 1.21.0

**Fix (tg-cli#102): `tg --file report.md` → PDF closes two egress/exfil surfaces
the sibling `.html` report path (tg-cli#96) had already closed.** The markdown→PDF
render had two gaps:

- **No network blackhole.** The Chrome `--print-to-pdf` invocation lacked
  `--host-resolver-rules=MAP * ~NOTFOUND`, so a markdown document with a remote
  resource (`![x](http://host/p.png)`, a remote font/iframe) made Chrome FETCH it
  at print time — a tracking-pixel / SSRF / network-egress surface. The print now
  runs with the DNS blackhole, so no remote subresource can resolve a host.
- **pandoc-stage local-file inlining.** pandoc was invoked with `--embed-resources`
  `--resource-path`, which base64-inlines ANY local file the markdown references
  (`![x](/etc/passwd)`, `![x](../secret)`) into the produced HTML — with zero
  attacker effort, for every referenced path — and fetches remote `src=`s at the
  pandoc stage. Both flags are dropped (matching the #96 decision). Cost: a relative
  LOCAL image in the markdown now shows broken in the PDF; remote images were
  blackholed regardless. A report is text-formatting, not an image document.

This is NOT yet full parity with the `.html` path, and the change does not claim
to be. Two residuals remain on the md path, both tracked:
- **tg-cli#103** (shared with the `.html` path): Chrome still loads an
  ABSOLUTE-path / `file:`-scheme `<img>` from the `file://` document into the PDF
  (the blackhole doesn't apply to `file://`). Relative refs are safe.
- **tg-cli#104** (md path only): unlike the `.html` path, `convertMdToPdf` does
  NOT run the element/handler sanitization (`sanitizeReportHtml` /
  `stripEventHandlerAttrs`), so a hostile `.md` with raw `<iframe src="file://…">`
  or `<script>` still reaches Chrome. pandoc keeps `raw_html` on for gfm.

This change removes the primary, zero-effort exfil/egress surfaces (#102's scope);
the sanitization and `file:`-subresource scrub are the #103/#104 follow-ups.

The Chrome print step (with the blackhole + empty-PDF check) is now a single shared
`printToPdf` helper used by BOTH the md-pdf path AND the code-pdf fence / html-report
paths, so the print sandbox flags live in one place and the md path can never again
silently diverge from the hardened code-pdf paths — which is the exact gap that
caused this issue.

## 1.20.0

**Feature (tg-cli#99): forwarded-question state survives a socket close and a
daemon restart — a late tap is late-delivered, a restart loses nothing within the
retention window (default 30 min).** The
`tg-ctl` daemon held all forwarded-question state ONLY in memory, so two failures
hurt the question channel: a Telegram tap that arrived AFTER a question's hook
socket closed (the agent's 120s hook budget elapsed, or the agent process died)
hit the `!pending` branch and was DROPPED — you pressed a button and nothing
reached the harness; and a daemon restart (crash-relaunch / stop+start) wiped
every pending and recently-answered question. One mechanism fixes both:

- **Persist** scoped questions + the answered-replay cache to a new durable file
  (`tg-ctl.<bot>.questions.json`, atomic temp+rename write) on every mutation,
  and restore them on daemon bootstrap.
- **Late-deliver**: a tap with no live pending socket now injects the chosen
  option into the asking tmux pane (the same text-reply injection path as a voice
  or typed reply) instead of dropping. The retained card keeps its keyboard so a
  late tap still works.
- **Reconnect**: the `tg-ctl ask` client for a SCOPED question reconnects and
  resends the same requestId across a mid-block socket drop; the restored daemon
  re-attaches the pending entry (no duplicate card) or replays the stored answer.
- **UX**: a genuinely-dead card (an unscoped question with no pane to deliver to,
  or a send-failed forward) now has its inline keyboard cleared on expiry so it
  isn't tappable.

Permissions and unscoped questions keep the single-attempt path unchanged (they
aren't retained across a restart, so resending would post a duplicate). The #98
answered-replay behavior is extended, not changed — it is now persisted too.

The retention window (`TG_CTL_ABANDONED_RETAIN_MS`, default 30 min) is enforced at
delivery time, not only on restore: a retained question whose window has elapsed
expires even on a quiet daemon. This bounds late-delivery — a question the human
left untapped for longer than the window (with a daemon restart in between) expires
rather than injecting a long-stale answer into a pane whose agent has moved on. A
question whose hook reconnects (the agent is still blocked) re-attaches as live and
is not subject to the window.

## 1.19.3

**Fix (tg-cli#95): `tg --file report.html` now renders a FORMATTED PDF instead
of printing raw HTML tags.** An attached `.html`/`.htm` file is a Telegram-subset
HTML *report* meant to be rendered, but it matched `CODE_EXT_LANG` and took the
code-as-pdf path, which fenced the whole file into a syntax-highlighted code
block — so the PDF showed literal `<b>`/`<code>`/`<table>`/`<h1>` tags as
monospace text. `.html`/`.htm` now take a new HTML→PDF render path
(`convertHtmlToPdf`): pandoc `-f html` parses the document and Chrome prints it,
so the tags become real bold/italic/headings/tables/lists/code/blockquotes. The
code/config→syntax-PDF path (`.ts`/`.json`/`.yaml`/…) is unchanged. The Chrome
print is network-blackholed (`--host-resolver-rules=MAP * ~NOTFOUND`) so a
report's remote `<img>`/font can't beacon out during the print. The report HTML
is sanitized in two layers: executable/embed elements (`<script>`/`<iframe>`/…)
are stripped from the raw report before pandoc, and `on*=` event handlers
(`onerror`/`onclick`/…) are stripped from pandoc's *normalized* output before the
print — the only place a `>`-inside-a-quoted-attribute can't shield a handler
from the strip and then be re-preserved by pandoc on a `<img>`/`<div>` it models.
`<svg>`/`<math>` subtrees are stripped whole before pandoc (they are not in the
Telegram report subset, and are the one place the `on*=` regex can't be trusted —
pandoc may pass an `<svg onload=…>` / nested `<script>` / external `<use href>`
through as raw markup). Local relative `<img>` are deliberately NOT inlined (no
pandoc `--embed-resources`): a report is text-formatting, not an image document,
and inlining would read arbitrary referenced local files into the uploaded PDF.

## 1.19.2

**Fix (tg-cli#97): an `AskUserQuestion` no longer forwards a duplicate Telegram
card whose tap reads as "expired".** The `requestId` is a stable hash of (session,
question text), and the in-flight dedup (`activeButtonKeys`) is released the instant
the question is answered — so the same `AskUserQuestion` re-firing afterwards posted
a SECOND, superseded card; tapping it showed an "expired" toast though the first tap
had already landed. Two complementary fixes: (a) the daemon now keeps an
answered-request replay cache, so a re-forward of an already-answered `requestId`
replays the stored answer down the hook socket and posts NO new card (scoped to
questions; a permission's stable `requestId` is never silently re-replayed), bounded
by a 5-minute window after which the entry is pruned and a genuinely new question
reusing the hash gets a fresh card; and (b) `hook-normalize` drops the
`AskUserQuestion` copy delivered by the `PermissionRequest *` catch-all matcher, so
only the dedicated `PreToolUse:AskUserQuestion` matcher forwards it (the
double-coverage that re-fired the same `requestId`). Observability: the answer path
now logs `ask-answered:` (previously silent), the tap toast reads "✓ sent to the
agent", and a tap on an already-answered card reads "already answered" instead of
"expired". Known trade-off: within the replay window a genuine human re-ask of the
exact same question (same session + text) is indistinguishable from a re-fire and is
auto-answered with the prior answer; the window bounds how long that lasts.

## 1.19.1

**Fix (tg-cli#93): `tg-ctl status` no longer falsely reports "not running" on a
launchd relaunch.** The daemon's `cleanExit` unlinked its pidfile unconditionally,
so a departing daemon — or one whose ownership a newer instance had already taken
over by rewriting `tg-ctl.<bot>.pid` with its own pid — would delete the **live**
successor's pidfile. `status` (which reads the pidfile) then reported "not running"
while the real daemon was alive and long-polling. `cleanExit` now removes the
pidfile only when its content is still its own pid (new `ownsPidFile` guard); the
flock loser is unaffected (it exits before writing any pidfile) and a graceful
exit still removes the owner's pidfile.

## 1.19.0

A new **`/new` slash command** (tg-cli#27) spawns a fresh agent session straight from
the flat chat: `/new [<model>] [<dir>] <name> [<task>]`. Omitted parts are chosen
interactively via inline buttons — a recent-project picker for `<dir>` (the in-use
project dirs **and their `..` parents**, normalized, deduped, LRU/MRU-ranked) and a
model picker for `<model>`. A `<name>` that collides with a live tmux window is a
non-blocking warning. With name + dir + model all supplied the agent spawns
immediately, passing the optional `<task>` as its initial prompt; otherwise the
daemon walks the interactive flow. This is the NON-topic sibling of the forum-topics
`/new` flow: it carries its own in-memory pending-state machine and its own button
callbacks (`tnm:`/`tnp:`), so it never collides with the topic flow, and it works
regardless of `control.topics`. The whole feature is fail-soft (no path is allowed
to throw into the poll loop) and 1:1 routing stays byte-identical when no `/new` is
in flight.

## 1.18.2

An **unscoped** forwarded question (the hook ran without `TMUX_PANE`) that expires
unanswered no longer silently strands the inbound messages deferred behind it
(tg-cli#58). An unscoped question defers inbound for **any** pane, so its backlog
can sit on several panes at once and there was no single pane key to dead-letter —
the expiry timer dropped the queue without telling anyone. Now, on the unscoped
abandon (timeout / hook socket close / send failure), the daemon **sweeps every
pane that still holds a backlog** and dead-letters the idle ones, emitting the same
`⚠️ … were NOT delivered. Resend them.` notice the scoped socket-close path already
gave.

- The sweep reuses the existing per-pane abandon guard, so a pane that still has
  **another** live question (its answer flushes the queue legitimately) or an
  in-flight flush (it owns the queue) is left untouched — no other handler's
  messages are dropped.
- The no-wedge guarantee is unchanged: the stale text is never pasted into the
  freed pane (the agent has moved on), and routing un-wedges immediately.

## 1.18.1

`tg-ctl status` no longer lies about autostart when the daemon is supervised by an
EXTERNAL launchd job (tg-cli#88). It previously recognized only tg-ctl's own `enable`
unit (`com.agenttools.tg-ctl.tg-ctl`), so when launchd kept the daemon alive across
reboots via a separately-wired job (e.g. an `ai.hyperide.tg-ctl` LaunchAgent), status
printed `autostart: NOT enabled` while it actually autostarts on boot.

- **status probes launchd** (`launchctl list` + `launchctl print`) for any loaded job —
  other than tg-ctl's own unit — whose `ProgramArguments` runs THIS tg-ctl binary with the
  `run` subcommand, discovered by what the job RUNS (not a hardcoded label), and reports
  `autostart: enabled (via launchd: <label>)`. The own-`enable` mechanism is unchanged and
  takes precedence.
- Robust: non-macOS / launchctl-unavailable falls back to the existing logic and never
  crashes; root (uid 0) uses the `system` domain, not `gui/0`; binPath matching is
  basename-aware so a symlink-vs-realpath mismatch still resolves.

## 1.18.0

Forum-topics increment 4 — lifecycle polish (spec §9.4; tg-cli#86, refs #31/#85). Builds
on the increment-2 spawn executor with the deferred recovery + UX items:

- **Recent-repo path buttons** on the awaiting-path step (`tgp:<threadId>:<index>:<nonce>`):
  the prompt offers recent project cwds (routes store + per-pane registrations, newest-first,
  deduped to absolute existing dirs) as one-tap buttons, with a free-text fallback. A per-prompt
  nonce pins each button to its prompt, so a stale button from a superseded prompt is rejected
  rather than resolving its index against a newer choice list.
- **Model keyboard cleared on bind** (and on a restart-to-path) via `editMessageReplyMarkup`.
- **Re-spawn on a dead/closed pane:** a message to a topic whose pane died marks it `closed` and
  offers a one-tap *Re-spawn* button (`tgr:<threadId>`) that re-launches with the retained path +
  model — or restarts the `/new` flow when the path/model is missing or the dir vanished. The offer
  is throttled (one per dead topic), only stamped on a successful send, and a re-spawn failure
  restores `closed` so the next message re-offers.
- **Daemon auto-stamps `TG_TOPIC`** into the spawned window's env (`new-window -e TG_TOPIC=<id>`),
  so a topic agent's plain `tg "reply"` threads back into the topic without `--topic`.
- **Crash-window orphan reconcile** on startup re-binds a crash-orphaned agent to its topic instead
  of double-spawning, proven by a per-spawn token stored as a `@tg_spawn_token` window option
  (queryable via the pane format; `new-window -e` process env is not) plus a recorded-paneId
  fallback. Adoption requires same slug + same cwd + (token OR paneId), so a same-slug/cwd stranger
  is never adopted; a flaky startup snapshot is skipped (no mass-close); a model tap on a still-
  pending binding re-probes (just-in-time adoption) so a missed reconcile can't double-spawn.
- **Same-batch races handled:** a re-spawn tap + a text message in one batch routes the text to the
  re-bound pane (not dropped); a second same-batch message to a just-closed topic uses the throttled
  recovery, never the old "recreate the topic" dead-end.

All gated behind `control.topics` (default OFF → 1:1 byte-identical). Extensive tests in
`tests/ctl-topic-spawn-integration.test.ts`, `tests/ctl-topics.test.ts`, `tests/ctl-discover.test.ts`.

## 1.17.0

Forum-topics: spawn an agent on topic creation (the `/new` flow trigger, spec
increment 2; tg-cli#85, refs #27). When a Telegram forum topic is created the daemon
runs an interactive `/new` flow and launches a fresh agent bound to that topic — one
topic = one agent. The routing half (#56/#61) and the pure foundation already shipped;
this wires the `topic-new`/`topic-answer` entrypoint actions to a real `tmux new-window`
spawn plus a model-pick button.

- **Flow:** `forum_topic_created` → ask for a working directory → validate it
  (absolute + existing dir) → post model-catalog buttons → on a tap, spawn
  `tmux new-window -P -F '#{pane_id}' -- <model argv>` and bind the returned pane. The
  topic name is only the tmux-window slug; path + model come from the interactive flow.
- **Safety:** every spawn step is exception-guarded (a bad path / missing tmux / spawn
  error posts an error into the topic and never throws into the poll loop); no
  double-spawn (duplicate create filtered, already-bound refused, model validated once,
  sequential action dispatch); gated behind `control.topics` (default OFF → 1:1
  behaviour byte-identical).

## 1.16.0

Single-source the tool version (tg-cli#80). `tg --version` now reads the version
from `package.json` at runtime instead of a hardcoded `VERSION` literal, so the
two can no longer drift. The literal had already diverged (`1.15.0` in source vs
`1.0.0` in `package.json`); `package.json` is now the sole declaration and is the
field the ship version-bump gate tracks.

- **`package.json` is the single source of truth.** New `resolveVersion(scriptDir)`
  reads `package.json`'s `version` relative to the running script's directory (the
  tool runs directly via bun from the repo root, so `package.json` sits next to the
  `tg` entrypoint). `VERSION` is now sourced from it at module load rather than a
  literal; `versionOutput` resolves the version the same way. The runtime git-hash
  suffix is unchanged. A drift-guard test pins `tg --version`'s numeric part to
  `package.json`'s `version` so they can never diverge again.

## 1.15.0

Two `tg-ctl` routing/picker fixes (tg-cli#75): no-reply auto-bind to the
most-recently-active agent, and `/agent` picker labels by the real tmux window
name instead of the cwd basename.

- **No-reply auto-bind to the last-active agent.** A plain (non-reply) message to
  a multi-agent fleet used to fall to `ambiguous target — candidates: …`. It now
  binds to the **most-recently-active agent** — the pane whose last outbound `tg`
  send is newest (the same `aggregateUsage` LRU/MRU signal the reply picker ranks
  by). A recognized reply route still wins first; the auto-bind only resolves an
  otherwise-ambiguous non-reply; and with no activity history or a tie at the
  most-recent timestamp it stays ambiguous so the button picker still fires (the
  unscoped fail-closed). New pure `resolveAmbiguousByActivity`
  (`features/tg-ctl/discover.ts`).
- **`/agent` picker uses the tmux WINDOW NAME, not the cwd.** The picker labelled
  agents by the cwd basename ("hyperide · claude") instead of the user-set window
  name ("ext"). Root cause: window names were fetched in a SEPARATE `tmux
  list-panes` call that skipped the UTF-8 locale env, so under launchd the
  tab-mangle blanked every name and the label fell back to the cwd. `#{window_name}`
  is now a fixed field in the core, locale-safe `PANE_FORMAT` (`PaneInfo.windowName`,
  carried through `parsePaneList`). A bare default — a number, a shell/launcher
  command (`zsh`/`node`), or a cc version string (`2.1.181`) — is treated as
  non-distinguishing and the label leans on the cwd project dir.

## 1.14.0

Help-UX cleanup: deduped usage, standard topic-help, and a configured-vs-pending
status glyph on `tg voice setup` (ROADMAP "tg help specifics").

- **Usage block no longer repeats `[--format plain|html]` on every line.**
  `--format` is a global modifier shown ONCE in `Options:`; the usage examples
  now read cleanly (`tg "text"`, `tg --photo … "caption"`, …) with a one-line
  note that the global options apply to any form.
- **`tg help format` is the canonical formatting reference** — the standard
  topic-help convention (`tg help <topic>`), advertised in the main `tg --help`.
  `tg help` with no topic prints the main help; an unknown topic
  (`tg help bogus`) errors with a 3-part message and a non-zero exit. The old
  `--format-help` flag is kept as a back-compat alias (byte-identical output).
- **`tg voice setup` shows actual STATUS** — a green `✓` when voice transcription
  is configured, a yellow `○` when it is still pending (the install-* state
  principle). The glyph is plain unicode so it is meaningful on BOTH surfaces:
  colorized for the terminal, and ANSI-free in the Telegram onboarding reply.

## 1.14.0

Scripted, idempotent deploy step for installed `tg` checkouts.

- **New `scripts/deploy.sh`** — updates the checkout the `tg` symlink points at
  (resolved from PATH, or `--checkout DIR`) by fast-forwarding it to
  `origin/<branch>`. `tg` is a committed Bun script with no build step, so the
  deploy is just a guarded `git pull --ff-only`. Idempotent (no-op when up to
  date), refuses a dirty tree (exit 1) and a non-fast-forward divergence
  (exit 2), and `--dry-run` reports what would land without changing anything.
- **tg-ctl-aware**: detects when a deploy changes daemon code (the `tg-ctl` entry
  or anything under `features/`, which the daemon imports) and tells you to
  restart the running daemon (which drops its pane/cwd/session registration);
  `--restart-ctl` does the stop/start automatically. `tg` itself needs no restart.
- **README "Update / deploy" section** documents the step. Closes the ROADMAP
  "tg-cli #36 merged but NOT deployed" gap — there is now a documented, scripted
  way to deploy a merged change to a live checkout.


## 1.13.0

`tg#<id>` message-ref convention + GitHub-anchor line specs.

- **Inbound wrap renders the message id as `tg#<id>`** (was bare `#<id>`):
  `[TG from Alex tg#1234] …`. The `tg#` prefix is what lets the outbound
  autolink layer tell a Telegram-message reference apart from a GitHub
  issue/PR `#<id>` so a quoted-back `tg#3715` is never mis-resolved as #3715.
- **New `autolink-msgrefs` feature** (ON by default). Links `tg#<id>` refs in
  outbound text: a `t.me/c/` deep link in a supergroup chat, a marked-but-
  unlinked styled reference in a private DM (no public per-message URL exists).
  Runs BEFORE the `#N` PR pass. Toggle with `--no-feature autolink-msgrefs`.
- **File line-specs now accept the GitHub permalink-anchor forms** `file#L10`,
  `file#L10-L20`, and `file#L10-20` (the second endpoint's `L` is optional),
  alongside the existing `file:N` / `:N-M` / `:N:C`. A pasted GitHub line link
  gets the same inline excerpt + marker-injected attachment.

## 1.12.0

`--tag` is now LOWERCASE-ENGLISH ONLY, and `--help` is colorized to match the
rest of the agent-CLI ecosystem (review / rig / draw).

- **`--tag` accepts only `answer` / `decision` / `problem` / `report`** (the
  lowercase-english tag words). Russian aliases (`ОТВЕТ`/`РЕШЕНИЕ`/`ПРОБЛЕМА`/
  `ОТЧЁТ`) and uppercase / mixed-case / unknown values are now **rejected** at
  parse time with a 3-part error and a non-zero exit, instead of the old
  soft-render-and-warn:

  ```
  invalid --tag 'ANSWER': tags must be lowercase english.
  Use one of: answer, decision, problem, report
  ```

  The `answer` tag still requires `--reply-to`. Validation lives in
  `validateTag` (`features/render/tag.ts`) and runs in `parseArgs`, so every
  send path fails before touching Telegram.
- **Colorized help.** `tg --help` and `tg --format-help` now colorize section
  headers (bold cyan) and option names (green), matching review/rig/draw. Color
  is dependency-free ANSI, auto-disabled when stdout is not a TTY or `NO_COLOR`
  is set, so piped/redirected help stays plain.

## 1.11.0

`tg replies` — recall what was sent over Telegram, so an agent can quickly
remember what the user asked without scrolling its own pane.

- **New subcommand `tg replies [user|agent|all] [list | find <query>]`.**
  - Direction (1st positional, default `user`): `user` = inbound messages the
    user sent, `agent` = outbound messages the agent sent via `tg`, `all` = both
    (prefixed `←` user / `→` agent).
  - Action (2nd positional, default `list`): `list` shows recent messages
    oldest→newest; `find <query>` is a case-insensitive substring search
    (`--regex` for a regular expression).
  - Line format: `[YYYY-MM-DD HH:MM] #<id> <text>` (local time, Telegram
    message id). Long text truncates to ~200 chars unless `--full`.
  - **Default scope = the current tmux session/pane.** The pane is detected from
    `$TMUX_PANE`; `--all-sessions` drops the scope, `--session <paneId>` targets
    a specific pane. `-n/--limit N` (default 20), `--json` (machine-readable
    array: ts ms, id, direction, from, text, pane), and `--help` round it out.
- **Append-only history log.** A new `tg-ctl.<botid>.history.jsonl` (next to the
  daemon's `routes` map, under `~/.config/tg-cli`) records one JSON object per
  line: `{ts, message_id, direction, from, text, pane}`. The `tg-ctl` daemon
  writes inbound messages (stamped with the routed pane); `tg` writes outbound
  messages (stamped with `$TMUX_PANE`). Both writers are best-effort — a corrupt
  or unwritable log never breaks a send or an inject — and the file is trimmed to
  its last ~5000 lines on write.
- Pure logic (`features/replies/`: arg parsing, JSONL parse/append/trim,
  direction + pane filters, substring/regex search, line + JSON formatters)
  stays out of the effectful entrypoints, mirroring the `tg-ctl` module split.

## 1.10.1

Inbound media downloads no longer drop a message on a transient network blip.

- **Retry-with-backoff on inbound media download (`tg-ctl`).** The control
  daemon's `downloadFileToCache` did a single `getFile` fetch and a single
  file-bytes fetch; ANY transient failure on either — a dropped connection, a
  5xx, a timeout — logged "media download failed", returned null, and (because
  the poll offset was already persisted) silently lost the inbound voice note /
  photo / doc forever. Both network steps now run under a bounded
  retry-with-backoff (`features/tg-ctl/retry.ts`): 3 attempts with jittered
  exponential backoff (~300ms → 900ms → 2.7s), retrying on a thrown network
  error / abort / timeout or a non-2xx HTTP response. A permanent Telegram-level
  error (HTTP 200 with `{ok:false}`) is left alone, not retried. The success
  path and the caller contract are unchanged — it still returns the cached path
  or null — and each retry plus the final give-up is logged with the step name
  and attempt count.

## 1.10.0

Native Telegram **Rich Messages** (tables, headings, lists, LaTeX formulas),
folded into the EXISTING `--format html` path — no new flag, no new `--format`
value.

- **Rich messages via `--format html` (auto-routed).** Bot API 10.1 (June 2026)
  added `sendRichMessage`, which renders a much larger HTML tag set than the
  basic `parse_mode=HTML` path: native bordered tables (`<table>`/`<tr>`/`<td>`
  with `align`/`valign`/`colspan`/`rowspan`/`<caption>`), headings (`<h1>`..
  `<h6>`), lists (`<ul>`/`<ol>`/`<li>`), dividers (`<hr>`), paragraphs (`<p>`),
  collapsible `<details>`, pull quotes (`<aside>`), footers, and LaTeX formulas
  (`<tg-math>` inline / `<tg-math-block>` block). `tg` now decides by CONTENT:
  HTML using only the basic inline tags (b/i/u/s/code/pre/a/blockquote/tg-emoji/
  tg-time/spoiler) sends as before (`sendMessage`); HTML containing any rich-only
  tag auto-sends a Rich Message (`sendRichMessage` with `rich_message.html`).
  ONE flag (`--format html`); the tool routes on what's inside.
- A rich body is sent **whole** — never 4096-split (splitting a `<table>` would
  corrupt it; rich has a 32768-char budget) and never used as a media caption.
- `--tag` / `--title` / `--reply-to` compose with rich messages: the branded
  header line (custom-emoji tag pill + styled title — all basic tags valid inside
  a rich body) sits above the rich content; threading uses `reply_parameters`
  (sendRichMessage has no `reply_to_message_id` field).
- **Rich limits pre-flighted locally** (≤ 32768 chars, ≤ 500 blocks, ≤ 16
  nesting levels, ≤ 50 media, ≤ 20 table columns) so an oversize body fails with
  a clear `tg:` error instead of an opaque API 400.
- **`tg --format-help` corrected.** It no longer claims "Telegram has NO tables".
  It now documents the BASIC vs RICH tiers, the rich tag set, a `<table>`
  example, and the rich limits. The monospace `tg --table` (`<pre>`) stays as the
  plain fallback grid.

## 1.9.7

Tag-badge notification clarity.

- **Tag pill fallback dots are now `[color, neutral, neutral]`.** Each `--tag`
  badge (ANSWER/DECISION/PROBLEM/REPORT) is a wordmark pill made of N custom-emoji
  CELLS. In a push notification — rendered by the OS, which can't load the
  custom-emoji image — each cell shows its fallback dot in place of the image.
  Previously every cell fell back to the SAME color dot, so the badge appeared as
  `🔵🔵🔵` (three loud identical dots). Now only the FIRST cell keeps the tag's
  colored dot and the rest fall back to a neutral white square (`▫️`), so the
  badge appears as `🔵▫️▫️`: one colored dot tells you WHICH tag by color (🔵
  answer / 🟠 decision / 🔴 problem / 🟢 report), the rest stay quiet. (The tag
  WORD is not part of the badge — the HTML header carries only the pill cells; any
  text after the dots in a notification is the `--title`/body, not the tag word.)
  The in-app pill IMAGE is unchanged (premium clients still see the full
  wordmark); only the per-cell fallback alt changes. The live sticker-set alts
  were synced to match (`scripts/sync-tag-pill-alts.ts`), so the rendered
  `<tg-emoji>` inner text still equals each cell's Telegram-side alt (required or
  Telegram drops the entity).

## 1.9.6

Three formatting/reply additions.

- **Threaded replies (`--reply-to <message_id>`).** Pass an inbound Telegram
  `message_id` and the outbound message threads UNDER it (`reply_to_message_id`
  on `sendMessage`), so an answer visibly attaches to the message it answers.
  Only the FIRST message of a >4096 split is threaded. The `tg-ctl` daemon now
  surfaces the inbound id in the injected wrap — `[TG from Alex #1234] …` — so
  the agent reading its pane knows the id to reply to. The id IS Telegram's own
  per-chat sequential `message_id` (no parallel id scheme invented). The
  **ANSWER / ОТВЕТ** tag now REQUIRES `--reply-to` (answering means answering a
  specific message); a clear error fires if it is missing. The other tags are
  unchanged.
- **`tg --table`.** Reads delimited rows from STDIN (TSV, or `a | b` per line),
  auto-sizes columns, draws box borders, HTML-escapes cells, and sends an
  aligned monospace table wrapped in `<pre>` — Telegram has no native HTML
  tables, a padded `<pre>` is the only way. Composes with `--tag`/`--title`;
  argv text becomes a heading above the table. Cells with double-width glyphs
  (emoji/CJK) trigger a one-line alignment warning but still send.
- **`tg --format-help`.** Prints a concise, copy-pasteable reference for what
  Telegram message formatting actually supports (the HTML-tag allowlist, the
  four HTML entities, the `<pre>` table pattern, the `--tag`/`--title` badge) so
  agents stop guessing. Referenced from `tg --help`.

## 1.9.5

- **Voice transcripts now inject as a 🎤-marked quote.** An inbound voice note's
  transcription is wrapped `🎤 «…»` (mirroring the `↩ «…»` reply anchor) before it
  reaches the agent pane, so the agent — and a human glancing at the pane — can tell
  it is machine-transcribed speech (which may carry recognition errors), not text
  typed verbatim. Both the reply and standalone routes apply it.

## 1.9.4

Inbound voice messages → text (local Whisper STT). Talk instead of type.

- **A Telegram VOICE note now becomes agent input.** When you send a voice note
  to the bot, the `tg-ctl` daemon downloads the OGG/OPUS, transcodes it to WAV
  16 kHz mono with `ffmpeg`, runs a local Whisper, cleans the transcript, and
  injects the resulting text into the SAME agent pane a typed message would
  reach — reusing the existing reply-routing (a voice note sent as a reply
  carries the same quote anchor and routes to the replied-to origin pane). Audio
  notes take the same path. Transcription runs through an ASYNC (non-blocking)
  spawn, so the daemon's poll loop and q→buttons hook server stay responsive
  while Whisper works.
- **Whisper is discovered, not bundled.** `tg voice setup` (or the auto-prompt
  on the first unconfigured voice note) probes the host — `~/xp/whisper.cpp`
  first, then conventional clone locations and `PATH` — finds the built
  `whisper-cli` binary and a real `ggml-*.bin` model (preferring multilingual
  large/medium over English-only over the test fixtures), checks for `ffmpeg`,
  and persists the runner/binary/model/language into `config.yaml`. faster-whisper
  (an import-verified project `.venv`) is supported as a fallback runner.
- **First-use onboarding, never a silent drop.** A voice note that arrives before
  Whisper is configured triggers a guided reply: it points at an existing `~/xp`
  install when present, or tells you to build whisper.cpp + download a model (or
  install `ffmpeg`), then run `tg voice setup`. Once a working install is found
  on the fly it is persisted so the next note transcribes without re-prompting.
  Download / transcribe / persist failures are caught and reported — a note is
  never lost after the at-most-once offset advances.
- **Config:** a new top-level `voice:` block in `~/.config/tg-cli/config.yaml`
  (`enabled`, `runner`, `bin_path`, `model_path`, `language` — default language
  `auto`, covering ru + en). No secrets are written — only binary/model paths.
  Reloaded per note, so `tg voice setup` takes effect without a daemon restart;
  an explicit `enabled: false` is honored as the opt-out.

## 1.9.3

Cleaner tag header + emoji tooling reads its bot token from config.

- **No more duplicate tag word on the header line.** A `--tag` with real pill ids
  now renders ONLY the wordmark pill cells in the HTML header — the appended
  plain tag word (e.g. a second "ANSWER" next to the pill) is gone. The wordmark
  is already baked into the sticker art, so the duplicate was redundant and (when
  combined with `--title`) clashed with the styled title. The first line is now
  the `--title` text (styled) only; the tag is just the pill badge. Non-premium
  viewers fall back to the per-cell colored dots — an accepted trade for a clean
  premium first line. The `plain` form (non-HTML / >4096 split) keeps the
  readable unicode fallback (`🔵 ANSWER`). Unknown tags still soft-render as
  `[WORD]`. (`features/render/prefix.ts`.)
- **Emoji-set scripts read their bot token from config, decoupled from the
  sender.** `scripts/create-tag-emoji.ts` and `scripts/create-ai-emoji-set.ts`
  now read `TG_EMOJI_BOT_TOKEN` (the dedicated emoji-owning bot) from
  `~/.config/tg-cli/.env`, falling back to `TG_BOT_TOKEN` only when unset; owner
  id is `TG_OWNER_ID` then `TG_CHAT_ID`. They use the shared config loader
  (`features/config/env.ts`, extracted from the `tg` entrypoint) so the config
  `.env` → process.env precedence applies and a token set only in config works
  with no transient shell export. The token is never printed.
  (`features/config/env.ts`, `scripts/create-tag-emoji.ts`,
  `scripts/create-ai-emoji-set.ts`, `tg`.)

## 1.9.2

Code/config files → mobile, syntax-highlighted PDF (and by default ONLY the PDF
is sent).

- **`code-as-pdf` feature (ON by default).** Attaching a code/config file —
  `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`, `.jsonc`, `.yaml`,
  `.yml`, `.toml`, `.ini`, `.py`, `.go`, `.rs`, `.rb`, `.php`, `.java`, `.kt`,
  `.swift`, `.c`, `.cpp`, `.h`, `.cs`, `.sh`, `.bash`, `.zsh`, `.sql`, `.css`,
  `.scss`, `.less`, `.html`, `.xml`, `.svg`, `.graphql`, `.proto`, `.lua`, `.r`,
  `.dart`, `Dockerfile`, `Makefile`, `CMakeLists.txt`, … (full map in
  `features/code-pdf/convert.ts`) — is rendered to a **mobile-sized,
  syntax-highlighted, soft-wrapped PDF** before sending. Telegram's iOS client
  previews raw source uselessly; the PDF is the readable artifact on a phone.
  Pipeline reuses the md-pdf machinery: fence the content in the detected
  language → pandoc (skylighting highlighting) → headless Chrome
  `--print-to-pdf` at the phone page size. Long lines **soft-wrap** (CSS
  `white-space: pre-wrap` + `overflow-wrap: anywhere`) so there is NO horizontal
  scroll. Monospace, light theme (`tango`), optional line numbers.
- **BY DEFAULT only the PDF is sent — the raw file is NOT attached.** On iOS the
  raw `.ts` is noise; the PDF is what you actually read. Two flags adjust:
    - **`--with-original`** — also attach the raw file alongside the PDF.
    - **`--no-pdf`** — skip the render and attach the raw file (the prior
      behavior). Equivalent to `--no-feature code-as-pdf`.
- **`--pdf-device <name>`** (or `TG_PDF_DEVICE`) — page geometry preset:
  `iphone15pro` (default, 393pt wide), `iphone15promax`, `iphonese`, `a4`.
  `TG_PDF_THEME` overrides the pandoc highlight style (default `tango`).
- Markdown keeps its own `.md`→PDF path (`detectCodeLang` returns null for it);
  images / `.pdf` / other documents are untouched. On any render failure the raw
  file is attached unchanged (same fail-open policy as md-as-pdf).
  (`features/code-pdf/convert.ts`, `features/cli/args.ts`,
  `features/auto-attach/feature-flags.ts`, `tg`.)

## 1.9.1

Wider tag pills, hosted under @hyperidebot.

- **ANSWER and REPORT widened to 3 cells.** 1.9.0 sliced the two 6-letter
  wordmarks into 2 cells each, so the rounded caps squished the text. Both now
  use 3 cells (matching DECISION / PROBLEM), giving the wordmark breathing room.
  The generator (`scripts/build-tag-pills.py`) sets all four canonical tags to 3
  cells; the upload script and render path follow.
- **Pill set re-created under @hyperidebot.** The custom-emoji set moved from
  `replytags_by_UltraClaudeCodeBot` to
  [`replytags_by_hyperidebot`](https://t.me/addemoji/replytags_by_hyperidebot)
  (12 cells, 3 per tag). The sending bot does NOT need to own the set — it can
  reference a set owned by a different bot (verified live). The old set was
  deleted.

## 1.9.0

Custom-emoji tag pills go live.

- **`--tag` now renders a real custom-emoji wordmark PILL.** 1.8.0 shipped the
  `--tag` plumbing with PLACEHOLDER pill ids, so every tag fell back to the
  unicode badge (`🔵 ANSWER`). This release uploads the pill sticker set
  (`replytags_by_UltraClaudeCodeBot`, https://t.me/addemoji/replytags_by_UltraClaudeCodeBot)
  and wires the real `custom_emoji_id`s into `TAG_PILL_IDS`. Premium clients now
  see the wordmark chip; everyone else sees the unicode fallback. The four pills
  (🔵 ANSWER / 🟠 DECISION / 🔴 PROBLEM / 🟢 REPORT) are sliced into 2–3 cells
  each. (`features/branding/emoji.ts`, `scripts/create-tag-emoji.ts`.)
- **Fix: pill cells wrap a single emoji, not a slice of the word.** Telegram
  rejects a `custom_emoji` entity whose fallback text is not exactly one emoji
  with `ENTITY_TEXT_INVALID`. The renderer now emits one `<tg-emoji>` per cell
  wrapping the canonical dot (`🔵`), and appends the readable WORD as plain text
  after the cells (`<pill cells> ANSWER`) so the label is never lost — premium
  clients see the pill image + word, non-premium see `🔵🔵 ANSWER`. The dead
  `splitForCells` word-distributor (the discarded slice approach) is removed.
  (`features/render/prefix.ts`.)

## 1.8.0

Header tag/title; revert the body-pull from 1.7.1.

- **The message body is no longer pulled onto the `✳️ [window]` header line.**
  1.7.1 joined the body's first line onto the header (the prefix ended with a
  space instead of a newline). That was a mistake: the message text must NOT be
  pulled up. `buildPrefix` now ends the header with a newline again, so the body
  always sits BELOW `✳️ [window]` (the pre-1.7.1 behavior). The single-ticket
  autolink title still renders on the header line (it is a ticket title, not
  message text), and the 1.7.1 reply-routing fix is untouched.
  (`features/render/prefix.ts`, `features/autolink-tasks/render.ts`, `tg`.)
- **`--title <text>`** — set an explicit header title: `✳️ [window] <title>`.
  ONLY an explicit `--title` ever appears there; the message body is never
  pulled up. No `--title` → the header is just `✳️ [window]` with the body
  below. The title is styled Bold Italic (a Cyrillic title falls back to `<i>`).
- **`--tag <TAG>`** — an emoji badge labeling what the message is. Canonical
  tags are Russian and case-insensitive; English aliases map to them:
  ОТВЕТ/ANSWER (🔵 💬), РЕШЕНИЕ/DECISION (🟠 ⚖️), ПРОБЛЕМА/PROBLEM (🔴 🚨),
  ОТЧЁТ/REPORT (🟢 📋). It composes with `--title`:
  `✳️ [window] 🔵 💬 ОТВЕТ — <title>`. An unknown tag soft-renders as a plain
  `[TAG]` badge plus a one-line stderr note (it never blocks a send). The
  default emoji mapping lives in one editable constant (`TAG_EMOJI` in
  `features/render/tag.ts`).
- **Skill advertising** — `tg install-skill` now documents `--tag`/`--title`,
  the four canonical tags, their English aliases, and their meanings in both the
  generated `SKILL.md` and the always-on blurb, so agents discover the
  convention from the skill itself.

## 1.7.1

Reply-routing + message-header fixes.

- **Reply routing no longer always opens the picker** — replying in Telegram to a
  message an agent sent now routes straight to that agent's pane. `tg` recorded
  the route's project identity as `process.cwd()`, but agents run `tg` from
  `/tmp`, so it never matched the daemon's check against the pane's
  `pane_current_path` and every reply fell through to the "choose an agent"
  picker. `tg` now records the origin pane's `pane_current_path` at send time, so
  send-time and reply-time compare the same quantity. The pane-id-reuse guard
  (a reply can't leak into a different project that reused the pane) is preserved.
  (`recordRoute` in `tg`, `resolveRouteCwd` / `routeMatchesPane` in
  `features/tg-ctl/routes.ts`.)
- **Task title / message body on the same line as `[window]`** — the agent
  header rendered `✳️ [window]` and dropped the task title / message text to line
  2. The prefix now joins the body with a space, so it reads
  `✳️ [window] 𝑻𝒂𝒔𝒌 𝒕𝒊𝒕𝒍𝒆` on one line. (`buildPrefix` in
  `features/render/prefix.ts`.)

## 1.7.0

Pre-send-photo hook framework + `review visual` unstyled guard.

- **Pre-send-photo hook point** — `tg` now runs an extensible hook chain
  (`agents-hooks/v1`) over every outgoing `--photo` before it leaves. Drop a
  descriptor under `~/.agents/hooks/tg/<id>.pre-send-photo.json` (an executable
  with a priority / timeout / on-error policy) and it runs against the PNG; a
  hook can `allow` the send or `block` it with the canonical exit code 10.
  (`features/hooks/`, `tg hooks list|trust`.)
- **`review visual` unstyled guard** — the bundled `review-visual` descriptor
  pipes the outgoing photo through `review visual <png> --json --strict` and
  blocks an unstyled / broken / blank render before it ships. Vision is slow, so
  the hook runs with a 60s timeout and `on_error: open`: a slow or unavailable
  vision call NEVER blocks a send — only an explicit rollback verdict does.
  (`review install-hook tg` substitutes the absolute cmd path.)
- **Trust by default** — drop-in descriptors LOAD AND RUN with no `tg hooks
  trust` ceremony on the user's own machine. The legacy TOFU quarantine + SHA
  pin re-engages only under `AGENTS_HOOKS_TRUST=1` (the rare untrusted-input
  case); `AGENTS_HOOKS_TRUST=auto` runs under the guard but auto-trusts.
- **Fail-open, non-breaking** — no descriptors dir ⇒ a single `stat` and a
  byte-identical send (zero behavior change for existing users). A hook crash,
  timeout, or malformed output warns and sends anyway; only exit-10 blocks.
  Every run is recorded to an append-only `audit.jsonl`.

## 1.6.1

- **Task-title styling restyled** — the single-ticket autolink task title now
  renders in **Mathematical Bold Italic** (`𝑭𝒊𝒙`) instead of the gaudier Bold
  Script (`𝓕𝓲𝔁`). The whole-token `<i>` fallback for Cyrillic / foreign-letter
  titles (which the math block can't represent) is unchanged.
  (`features/prefix-style/`, docs/specs/unicode-prefix-styling.md.)

## 1.6.0

Agent addressing, reply quotes, prefix styling, and compound autolinks.

- **`/agent [<window>] <message>`** — address a specific agent when several run
  at once. The window is fuzzy-matched with phonetic normalization (Cyrillic→
  Latin, sound-folding), a confident match routes the message straight to that
  pane, and an ambiguous / unspecified target shows session-grouped inline
  selection buttons. Bare `/agent` lists the addressable agents.
  (`features/tg-ctl/agent-match.ts`, docs/specs/agent-addressing.md.)
- **Reply quotes + routing** — replying to a message forwards a quote anchor
  into the agent: `↩ «[date time] <quote>…»` (partial Telegram selection wins,
  else the start of the replied-to message). A reply to a **recognized** message
  routes to the pane that produced it (message_id→pane routes map written by
  `tg`); an **unrecognized** reply shows the window picker ordered by **LRU+MRU**.
  (docs/specs/reply-quotes.md.)
- **q→buttons, now seamless** — `tg-ctl install-hooks` idempotently wires the
  Claude Code agent-question/permission hooks into `~/.claude/settings.json`
  (backup first; existing hooks preserved); `tg-ctl ask` normalizes the raw
  harness payload so the hook is trivial; `tg-ctl status` reports whether it is
  installed. While an agent is blocked on a question, new inbound messages to it
  are **deferred** (queued, marked ✍️) and flushed when the question is answered.
  (docs/q-buttons-prerequisites.md.)
- **Unicode prefix styling** — the tmux window name in `[]` renders in
  Mathematical Sans-Serif Bold and a single-ticket task title in Bold Script,
  with a `<b>`/`<i>` fallback for Cyrillic names the math blocks can't represent.
  (`features/prefix-style/`, docs/specs/unicode-prefix-styling.md.)
- **Compound autolinks** — one token may carry a range or list of refs
  (`HYP-100..103/110`, `#5-7,9`): the body links only the written numbers
  (range endpoints), and the bottom reference block enumerates the full range.
  (`features/autolink-refs/`, docs/specs/autolink-compound.md.)
- Documented the q→buttons prerequisites and the missing hook installer
  (docs/q-buttons-prerequisites.md), and a WhatsApp companion-transport
  implementation spec (docs/specs/whatsapp-transport.md, spec only).

## 1.5.1

Agent detection fix (outbound branding):

- `tg` now identifies a `codex` (and `aider`/`pi`/`opencode`) session by walking
  its own ancestor process tree, not just an env marker. Codex exports no env
  signal for the shell commands it spawns (`CODEX` unset, `CODEX_HOME` empty),
  so detection used to fall through to the `pgrep` fallbacks where a background
  `ollama` daemon (common on macOS) won — mislabeling codex reports as `ollama`.
  The ancestry walk runs before the `pgrep` block, so the launching agent wins
  and a sibling daemon can no longer hijack the label. Mirrors `tg-ctl`'s
  inbound `findAgentInPane` (new `findAgentInAncestry`, shared `matchAgentCommand`).

## 1.5.0

Q→buttons (`tg-ctl`, spec §8 core path):

- New `tg-ctl ask` hook client: reads a normalized question / permission JSON
  request, hands it to the running daemon over a bot-scoped Unix socket
  (`tg-ctl.<botid>.sock`), sends Telegram inline buttons, consumes
  `callback_query` updates in the same poll stream, immediately
  `answerCallbackQuery`s every tap, edits expired/answered prompts, enforces
  the active registration guard (`paneId`/`cwd`/`sessionName`), and returns
  agent-specific hook output. A missing daemon/socket, timeout, or send
  failure returns no decision so the local agent UI takes over.
- Claude Code question and permission shapes are supported; Codex
  `PermissionRequest` emits the documented
  `hookEventName: "PermissionRequest"` decision shape; opencode
  `question.asked` / `question.v2.asked` / `permission.asked` /
  `permission.v2.asked` adapter helpers map to the matching native reply
  endpoints; `pi` is detected but reports native Q→buttons as unsupported.
- Hardening (post-review): the hook socket is `chmod 0600` on listen and
  caps requests at 64 KiB; taps are validated against the prompt's own
  Telegram `message_id` (a stale tap on an earlier message that reused the
  callback key answers "expired"); the registration guard treats `paneId` as
  authoritative — a pane mismatch fast-passes even when `cwd`/`sessionName`
  agree, so a second keyboard session in the same cwd never blocks on
  Telegram.
- Deferred (recorded in the spec): hook installer/canary automation,
  long-running opencode SSE ownership.

## 1.4.0

Inbound control v1 (`tg-ctl`, spec §16 — poll/tmux transport, ON by default;
opt out with `control.enabled: false`):

- New `tg-ctl` entrypoint at the repo root: `start` / `run` / `stop` / `status`.
  A singleton daemon long-polls Telegram `getUpdates` and injects inbound
  messages into the target agent's tmux pane, wrapped as
  `[TG from {name}] {msg} — reply via tg`. Outbound stays `tg`-only.
- Hard singleton via real `flock(2)` (`bun:ffi` → libSystem/libc): the launcher
  spawns the daemon detached and never takes the lock; the daemon flocks as its
  first action and exits 0 if another instance holds it.
- Lazy auto-start: a successful `tg` send from a tmux pane with a detected
  agent fire-and-forgets `tg-ctl start`, handing over the `TMUX_PANE`/cwd
  registration snapshot (gated on `control.enabled`).
- Pane-id targeting with pre-inject verification: the agent process is located
  by walking the pane's process tree (a Claude Code pane reports its version
  string, not `claude`, as the pane command); injection refuses + replies in
  Telegram if the pane no longer hosts an agent — text never lands in a shell.
- Commands: `/stop` (Escape inject — interrupts the turn, session survives),
  `/kill` (SIGINT + "restore via `claude --resume`"), `/status`; any other
  `/cmd` passes through verbatim; plain text is a wrapped prompt.
- Photo/document inbound: `getFile` download (≤20 MB) to
  `~/.cache/tg-cli/inbound/`, the local path is injected for the agent to read.
- Safety/robustness: sender-id allowlist, at-most-once offset persistence,
  staleness window (default 300 s) with a "skipped N stale" notice, 409
  backoff with a one-shot warning, idle TTL (default 30 min), multi-line
  injection via bracketed paste.
- Delivery receipts: a successfully handled inbound message gets a 👀
  reaction; every failure answers with an error reply instead.
- Config: new `control:` block (`enabled`, `transport`, `session`,
  `inject_wrap`, `staleness_sec`, `idle_exit_min`, `allowed_senders`).
  One bot token per machine for inbound (Telegram allows a single `getUpdates`
  consumer); outbound `tg` is unaffected.
- Deferred (recorded in the spec): question/permission forwarding with inline
  buttons (v1.1), opencode native adapter (v1.1), `/rename`+`/new` (v1.2),
  channel mode (v1.2+), configurable Escape prelude.

Also in this release:

- New `autolink-prs` feature (ON by default): GitHub `#N` references in the
  message text are resolved against the cwd repo via `gh` (one `gh repo view`
  for identity + one batched `gh api graphql` with aliased `issueOrPullRequest`
  fields) and linkified. Resolved ISSUES merge into the existing
  `autolink-tasks` reference block (`#N — Title`); PULL REQUESTS get their own
  collapsed `PRs:` block at the END of the message with a state annotation
  (`(merged)`/`(closed)`/`(draft)`/`(open)`). Verdicts (positive and negative)
  are cached 1 h in `~/.cache/tg-cli/gh-cache.json`, keyed by `owner/repo#N` so
  the same `#260` in different repos never collides. Every failure mode (no
  `gh`, not authenticated, non-GitHub cwd, partial/missing numbers) keeps the
  send going as plain text; missing-CLI / not-authenticated emit a one-time
  stderr hint reusing the `autolink-tasks` hint-state file. Disable with
  `--no-feature autolink-prs`.
- New `recursive-attach` feature (ON by default): a file mentioned by bare
  name or path suffix that misses plain and worktree-root resolution is now
  found recursively under the worktree roots (or cwd outside a git repo) —
  BFS, shallowest match wins, `node_modules`/`.git`/`dist`-style directories
  pruned, depth/size caps. `2026-06-10-tg-ctl-control-design.md` mentioned
  from the repo root now attaches from `docs/specs/`.
- `autolink-tasks` now retries one unexpected `linear api` failure before
  degrading to plain text, so transient Linear CLI/API failures do not silently
  drop ticket links.

## 1.3.0

Never-attach denylist (`attach-denylist` feature, ON by default):

- Secret-looking files are never attached: the `.env` family, SSH private
  keys (`id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`), credential
  rc-files (`.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`,
  `.my.cnf`, `.htpasswd`), shell/REPL histories, `*.tfvars`,
  `credentials.json` / `client_secret*.json`, `kubeconfig`.
- Auto-detected mentions in the text are silently skipped (the token stays);
  an explicit `--photo`/`--file` of a denylisted file is a hard ERROR before
  anything is sent.
- Conscious override: `--no-feature attach-denylist` or
  `features.attach-denylist: false` in `~/.config/tg-cli/config.yaml`.

## 1.2.0

Attachment quality pass:

- Markdown as PDF (`md-as-pdf` feature, ON by default): attached `.md` files
  are converted to PDF via pandoc + headless Chrome — emoji and Cyrillic
  render correctly. Any conversion failure attaches the original `.md`.
- UTF-8 BOM for text attachments: documents with non-ASCII UTF-8 content get
  a BOM prepended to the uploaded copy (disk file untouched), fixing
  Telegram's preview mojibake for Cyrillic. Scripts (`.sh`) and `.json` are
  deliberately excluded.
- Extensionless files (LICENSE, Makefile, `.env`) are no longer auto-attached;
  explicit `--photo`/`--file` still attach anything.
- Linear response cache: autolink-tasks verdicts (including verified-absent)
  are cached for 1 hour in `~/.cache/tg-cli/linear-cache.json` — repeated
  reports about the same tickets no longer spawn the `linear` CLI each send.

## 1.1.0

Autolink tasks (`autolink-tasks` feature, ON by default):

- Ticket-like codes in the message text (3 uppercase letters + dash + digits,
  e.g. `HYP-576`) are verified against Linear via the `linear` CLI and turned
  into links.
- A single mentioned ticket gets its title on the first line (after the
  emoji/[window] prefix when present); several tickets get a collapsed
  `<blockquote expandable>` reference block (`code: title`) at the end.
- Codes Linear doesn't know stay plain text. A missing `linear` CLI or missing
  auth produces a one-time stderr hint; the message is always sent unchanged
  on any autolink failure.
- Toggle with `--no-feature autolink-tasks` or
  `features.autolink-tasks: false` in `~/.config/tg-cli/config.yaml`.

## 1.0.0

CLI ergonomics pass:

- `-v` / `--version`: print version, the running git commit hash, and this
  changelog, then exit 0.
- Help anywhere: `-h`/`--help` (or no arguments at all) prints usage to stdout
  and exits 0 instead of sending an empty message.
- Auto-attach paths: existing file paths found in the message text are attached
  automatically (images as photos, everything else as documents) and excised
  from the caption.
- `OK` on success: a successful send prints `OK` to stdout.
- Unknown dashed flags are an error: a stray `--foo` prints help to stderr and
  exits non-zero instead of being sent as message text. All real flags
  (`--format`, `--photo`, `--file`, `--ls-emoji-helpers`, `--detect-model`) are
  still recognized — the unknown-flag check runs only after they are matched.
