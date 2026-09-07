# AGENTS.md — tg-cli

Agent-facing documentation. English only.

---

## What This Repo Is

`tg` is a single-file Bun/TypeScript CLI (`#!/usr/bin/env bun`, entrypoint: `tg` at repo root,
no build step) that sends curated agent reports to Telegram via the Bot API.

Credentials: `~/.config/tg-cli/.env` — must contain `TG_BOT_TOKEN` and `TG_CHAT_ID`.

---

## CRITICAL: This Checkout Is the Live Binary

`~/.files/bin/tg` (on PATH) is a symlink to `<repo>/tg`. Whatever branch is checked out in
`~/.files/repos/tg-cli` **IS** the deployed tool, with immediate effect.

- Keep `main` checked out here at all times.
- Never leave the checkout on a half-done feature branch.
- Do all feature work in git worktrees on separate branches.

## Hook Caller Discipline

When a hook needs clearer callee semantics, fix the callee command surface and invoke that
surface directly. Do not change cwd, hide repo context, or add caller-side environment hacks
to coerce a tool into the desired mode; those workarounds make hook behavior depend on the
launch environment and leave help/docs stale.

---

## Architecture

Two single-file entrypoints at the repo root contain only thin wiring (real spawns, file
I/O, fetch, signals, `bun:ffi`):
- `tg` — outbound one-shot sender. Notable flags: `--format html` (HTML send; auto-routes
  to a native **Rich Message** — `sendRichMessage` — when the body contains a rich-only tag
  like `<table>`/`<h1>`/`<ul>`/`<hr>`/`<details>`/`<tg-math>`, otherwise normal `sendMessage`;
  see "Rich messages" below), `--tag`/`--title` (header badge; compose with rich),
  `--subagent <label>` (a SUBAGENT self-label — renders a second `[label]` bracket right
  after `[window]`; the MAIN/orchestrator agent needs NO flag, its `[window]` bracket
  already carries the project via `resolveWindowAgentLabel` — the tmux window name, or its
  cwd basename when the window is auto-renamed to a version/shell; explicit flag wins over
  `TG_AGENT` env; there is NO env-based auto-detection — `CLAUDE_CODE_CHILD_SESSION` is not
  a reliable main-vs-subagent signal; deprecated alias `--agent`; `--detect-agent` prints
  the resolved `[window]` label; NOT the same flag as `tg-ctl`'s own `--agent`),
  `--reply-to <message_id>` (thread the message UNDER an inbound one — `reply_to_message_id`
  on sendMessage, `reply_parameters` on sendRichMessage; the `answer` tag requires it),
  `--topic <id>` (post INTO a forum topic — stamps `message_thread_id` on EVERY outbound
  primitive so an agent's reply threads into its bound topic instead of General; falls back to
  the `TG_TOPIC` env, flag wins; no flag/env → General, byte-identical to before),
  `--table` (render STDIN rows — TSV or `a | b` — as an aligned monospace `<pre>` table; the
  PLAIN fallback grid — a real bordered table comes from `--format html` with `<table>`),
  `tg help format` (print the supported-HTML reference, basic + rich tiers; the topic-help
  convention — `--format-help` is a back-compat alias).
- `tg-ctl` — inbound control daemon (`run`/`start`/`status`/`stop`/`enable`/`disable`):
  singleton via real `flock(2)` over `bun:ffi`, Telegram `getUpdates` long-poll, tmux pane
  injection. The lifecycle subcommands follow the shared agent-tools service-management
  contract (`agenttools_service`): `run` = foreground/blocking; `start` = background detached
  daemon; `status` = running?/pid/bot/target/autostart; `stop` = stop the background daemon;
  `enable` = install OS autostart AND start now; `disable` = remove autostart AND stop. A bare
  `tg-ctl` (no subcommand) prints HELP and never launches. OS-autostart matrix lives in
  `features/tg-ctl/autostart.ts`, mirroring the lib's SEMANTICS: macOS → launchd LaunchAgent
  (label `com.agenttools.tg-ctl.tg-ctl`, `RunAtLoad` + `KeepAlive{SuccessfulExit:false}`,
  legacy `launchctl load`/`unload`); Linux with a usable `systemctl --user` → systemd `--user`
  unit (`agenttools-tg-ctl-tg-ctl.service`, `Restart=on-failure`, `enable --now`); any other host
  (Linux with no `systemctl --user` — containers, no D-Bus session — or an unsupported OS) → a
  no-op fallback that starts now but won't survive reboot. tg-ctl is Bun/TS so it
  reproduces the lib's CONTRACT, not its code; the full Python code-share happens when tg-cli
  grows a Python seam (follow-up). Spec: `docs/specs/2026-06-10-tg-ctl-control-design.md`
  (§16 = shipped v1 scope). After merge to main it gets its own `~/.files/bin/tg-ctl` symlink
  (same live-symlink rule as `tg`).

Feature modules live in `features/<feature-name>/` as **pure TypeScript modules** — no I/O;
all external dependencies (spawns, fetch, file reads) are injected as function parameters so
tests can pass fakes.

### Existing Features

- `features/agent-detect/` — pure `detectAgentLabel(env)`: the historical env-based
  subagent auto-detection (tg#6254). NO LONGER wired into the outbound `[subagent]` label
  (removed because `CLAUDE_CODE_CHILD_SESSION` mislabelled the orchestrator itself); kept
  because open PRs still evolve it. The outbound subagent bracket is explicit-only now
  (`--subagent`/`TG_AGENT`). The `[window]` label lives in
  `resolveWindowAgentLabel` (`features/tg-ctl/agent-match.ts`).
- `features/auto-attach/` — path detection → attach files, R1-R4 text rules, line-spec quotes,
  worktree-aware + recursive path resolution, transmitter with Telegram message/caption limits.
- `features/autolink-tasks/` — detects Linear ticket codes in messages, resolves titles via the
  `linear` CLI, and rewrites text with hyperlinks.
- `features/autolink-prs/` — detects GitHub `#N` refs, resolves them against the cwd repo via
  `gh` (issues merge into the tickets block, PRs get their own block), repo-keyed 1 h cache.
- `features/autolink-msgrefs/` — links `tg#<id>` inbound-message references (the convention the
  inbound inject wrap renders, distinct from a GitHub `#<id>`). Pure detection runs FIRST in the
  outbound transform — before the `#N` PR pass — so a `tg#3715` is never mis-resolved as issue/PR
  #3715. Builds a `t.me/c/` deep link for a supergroup chat; in a private DM the ref is marked but
  unlinked (no public per-message URL exists).
- `features/autolink-refs/` — shared compound-ref parser (ranges/lists like `HYP-100..103/110`,
  `#5-7,9`): body links the written numbers, the bottom block enumerates the full range. Used by
  both autolink features (docs/specs/autolink-compound.md).
- `features/md-pdf/` — disk-sourced `.md`/`.markdown` attachments → PDF (pandoc + headless Chrome)
  before upload, because Telegram mangles non-ASCII text previews. Shared `ConvertDeps` / `findChrome`.
- `features/code-pdf/` — disk-sourced code/config attachments (`.ts`, `.json`, `.yaml`, `Dockerfile`,
  … per a maintainable extension/filename→highlight-language map) → a **mobile-sized,
  syntax-highlighted, soft-wrapped** PDF (reuses the md-pdf pipeline; pandoc skylighting + Chrome
  `--print-to-pdf` at a device page size). **By default ONLY the PDF is sent** (the raw file is
  useless on iOS); `--with-original` sends both, `--no-pdf` sends the raw file. `--pdf-device` /
  `TG_PDF_DEVICE` pick the page geometry. `applyCodePdfToPlan` is the pure attach-decision used by `tg`.
- `features/prefix-style/` — Unicode styling of the outbound prefix: tmux window name → Sans-Serif
  Bold, single-ticket task title → Bold Italic, with `<b>`/`<i>` fallback for Cyrillic
  (docs/specs/unicode-prefix-styling.md).
- `features/render/` — pure outbound-render helpers used by `tg`: `html.ts` (escape, tag detection,
  parse-mode, emoji-entity → `<tg-emoji>`), `rich.ts` (Rich Message detection + limit validation —
  `isRichHtml` flags rich-only tags so a body routes to `sendRichMessage`, `validateRichHtml`
  pre-flights the documented limits), `prefix.ts` (the `✳️ [window]` header + optional
  `[agent]` bracket + tag/title badge), `tag.ts` (the lowercase-english tag set — answer/decision/problem/report — validated
  at parse time via `validateTag`), `table.ts`
  (`--table`: delimited STDIN rows → an aligned, box-drawn, HTML-escaped monospace `<pre>` table —
  alignment is computed on raw cells so escaping never skews columns), and `format-help.ts`
  (the supported-HTML reference, basic + rich tiers — surfaced via `tg help format`, with
  `--format-help` kept as a back-compat alias).
- `features/tg-ctl/` — inbound control logic: `control:` config block parser, singleton/pidfile
  helpers, the update→action step function (allowlist, staleness, command split, `/agent`
  routing, reply-quote forwarding), tmux inject plans as data, agent pane discovery (process-tree
  walk — a Claude Code pane reports its VERSION string as `pane_current_command`, not `claude`),
  `agent-match.ts` (phonetic fuzzy window matching + session-grouped selection buttons),
  `routes.ts` (message_id→pane map for reply recognition + LRU/MRU picker),
  `unreachable.ts` + `inbox.ts` (tg-cli#306: agents OUTSIDE tmux — a `ps pid,tty` scan +
  lsof cwd finds interactive agent processes in no pane; they are listed as `unreachable:
  not in tmux` and a `/agent <name> <text>` is queued to `<config>/inbox/<key>/pending.jsonl`,
  which the agent-tools Stop hook (`cc_hook_bridge`) consumes at the agent's next turn end;
  the inbox KEY — sanitized `--name`, else `cwd-<sha256(cwd)[:16]>` — is shared byte-for-byte
  with agent-tools `lib/agenttools_tg_inbox`, test vectors mirrored in both suites),
  `last-user-target.ts` (tg-cli#78 anchor fix: the pane of the CTO's OWN last CONFIRMED
  inbound delivery — auto-bound, a recognized reply, or an explicit picker/`/agent`
  selection — distinct from the removed `lastMessagePane` mechanism, which used to track
  whichever pane most recently sent an outbound `tg` message, including an agent
  proactively messaging the CTO unprompted; an otherwise-ambiguous non-reply binds here,
  never to "whoever spoke last", cwd-validated against pane-id reuse the same way `routeMatchesPane` guards
  reply routing), `hook-normalize.ts`
  (raw harness hook payload → ButtonRequest(s) — a multi-question AskUserQuestion (2-4 questions)
  yields one request per question via `normalizeHookRequests`, forwarded as sequential cards whose
  answers the ask client composes into ONE combined hook reply (tg#5741); the reply envelope stamps
  the REQUIRED `hookSpecificOutput.hookEventName` and echoes the original `tool_input`, since
  Claude Code ≥2.1.198 discards hook output lacking the event name and schema-validates
  `updatedInput` wholesale; also forwards Claude Code `ExitPlanMode` plan-approval
  — delivered by the `PermissionRequest *` catch-all — as a permission with Proceed/Keep-planning
  buttons + the plan body, stamping `permissionEvent` so the hook reply matches the firing event:
  PreToolUse→`permissionDecision`, PermissionRequest→`decision.behavior`), `hook-install.ts`
  (idempotent q→buttons hook merge for `tg-ctl install-hooks` — PreToolUse matches `AskUserQuestion`,
  plus a `PermissionRequest *` catch-all that also carries plan-approval; ExitPlanMode gets NO
  dedicated matcher to avoid double-forwarding, since both events fire for it), `question-store.ts`
  (PURE (de)serialization for the durable forwarded-question state — the on-disk envelope +
  age/count pruning; the entrypoint owns the atomic file I/O and the authoritative req
  normalization), `defer.ts` (defer-while-waiting queue model: inbound text is
  QUEUED per-pane while that pane has an open question and flushed on answer or release, so it is
  never pasted into the prompt — `driveFlush` re-checks the pane before EACH paste so a follow-up
  question re-defers the untouched tail), and `voice.ts` (inbound VOICE→text: `voice:` config block
  parse/resolve/upsert, ffmpeg + whisper argv builders, transcript cleaning, and the onboarding
  decision). `voice-probe.ts` is the ONE impure module here — it scans `~/xp` for an existing
  Whisper install (whisper.cpp binary + ggml model, or a faster-whisper venv) and checks for
  `ffmpeg`, handing a pure `WhisperProbe` to `decideOnboarding`. `git-state.ts` (git-state-check
  banner, root-cause fix for a fresh unrelated message silently reading as "more of the same task"
  in an occupied pane): PURE parse of raw `git rev-parse --abbrev-ref HEAD` / `git status
  --porcelain` stdout into a `PaneGitState` + `buildGitStateBanner`'s warning text, mirroring
  discover.ts's raw-stdout-in/structured-data-out shape. The entrypoint's `gitStateForPath`
  (timeout-guarded git spawns) and `withGitStateBanner` compose it at the ONE seam that matches the
  failure mode: `injectViaTarget`'s silent auto-bind deliveries (plain inject-text, a
  non-reply download-media notice, a standalone voice transcript) — NOT reply-route (anchored to a specific
  prior message), NOT topic-route (a different, per-topic targeting model), NOT a `/new` spawn (a
  fresh pane has no prior work to protect), and NOT a picker tap (the human already chose the
  pane). Default ON; opt out per machine with `control.git_state_banner: false` — an agent that
  always works on a feature branch sees the banner on every delivery to that pane, which is
  expected noise from the check's design (it detects "pane busy", not "message off-topic"), not a
  bug. Shared shapes in `types.ts`.
- `features/replies/` — the `tg replies` subcommand (message recall). All PURE except `cli.ts`,
  which is effectful-via-DI like `features/hooks/cli.ts` (the I/O — history read, `$TMUX_PANE`
  detection, stdout — is injected as `RepliesCliDeps`, so the orchestration is unit-tested without
  disk/tmux). `history.ts` (the `HistoryRecord` type + JSONL parse/serialize/append/trim, plus
  `appendRecordsToBlob` — the whole read-append-trim as one pure string transform the entrypoints
  wrap with readFile/writeFile), `args.ts` (`tg replies [user|agent|all] [list|find <q>]` + flags),
  `select.ts` (direction + pane filters, substring/regex search, the select pipeline, line + JSON
  formatters), `inbound.ts` (raw `getUpdates` batch → `user` history records, mirroring
  `stepUpdates`' allowlist + staleness), `outbound.ts` (which text to log for a send — body or a
  `[photo]`/`[document]` placeholder).

- **Message history & recall (`tg replies`, v1.11.0):** an append-only JSONL log at
  `tg-ctl.<botid>.history.jsonl` (path added to `CtlPaths`, next to `routes`) records one
  `{ts, message_id, direction, from, text, pane, groupId?, targetAgent?}` object per line. TWO
  writers, both best-effort (a corrupt/unwritable log NEVER breaks a send or an inject, exactly
  like `routes`): the `tg-ctl` poll loop appends every inbound message it processes (stamped with
  the routed target pane AND `targetAgent` — the routed pane's agent NAME via `agentNameForPane`),
  and `tg` appends one `agent` record per OUTBOUND Telegram message_id (stamped with `$TMUX_PANE`
  AND `targetAgent` — the sending session's own agent name, the SAME namespace, so a session's
  inbound and outbound share one label) — a >4096 split or a media-group album emits several ids for one logical
  send, and each gets its own record (same text) so a reply anchored to any of them stays
  recall-able (tg-cli#131). Every sibling of such a multi-part send shares a `groupId` (a random
  per-send token, NOT the group's first id — Telegram message_id is sequential PER CHAT, so
  reusing it as the key could collide across two chats sharing one bot's history file) — `tg
  replies` groups by it so `-n`/`--limit` counts logical sends (not raw records, for BOTH the
  plain listing and `--json`, and never truncates a kept send mid-group); the plain listing
  additionally collapses each group to one line, while `--json` always returns every id of the
  kept sends uncollapsed (tg-cli#131 follow-up, closes #134).
  The file is trimmed to its last ~5000 lines on each write. `tg replies` is AGENT-SCOPED: it
  defaults to the CURRENT agent (resolved from the current pane's window/project via the SAME
  `agentNameForPane`) + `user` direction, and MARKS every line with `[→ <agent>]` (`[→ ?]` =
  untagged/legacy). `--agent <name>` filters to one agent (case-insensitive), `--all` shows every
  agent, `--untagged` shows only untagged/legacy rows (the three are mutually exclusive; an
  explicit one of them drops the current-pane default so the agent filter is the axis). When the
  current agent can't be resolved (outside tmux) the default degrades to untagged + a stderr note.
  The pane axis is orthogonal: `--all-sessions`/`--session`
  override scope — `--session` takes a tmux WINDOW NAME (`--session ext`, exact match → the pane
  set of every window so named, unioned across sessions) or a raw `%`-pane id (`--session %7`);
  `--all-sessions` drops the pane filter entirely (`tg replies agent --all-sessions`);
  `--since`/`--until` bound the range by date, both inclusive — an ISO date (`--since 2026-06-28`,
  midnight UTC), an ISO datetime (`2026-06-28T10:00`, UTC), or relative `Nd`/`Nh` from now
  (`tg replies user --since 3d`, `tg replies all --since 2026-06-28 --until 2026-06-30`);
  `--json` is machine-readable, `find`/`--regex` search. Exact-match leading token
  in `tg` dispatch (like `hooks`/`voice`), so `tg "replies ..."` as a plain message still sends.
  - **Reply pane accuracy:** text, voice, photo, and document replies are stamped with their
    recognized ORIGIN pane (the same pane reply-route delivers them to). Exception: a
    photo/document reply whose caption starts with `/agent <window> …` is stamped like an
    explicit `/agent` routing command, not under the replied-to origin, because the selector
    deliberately overrides reply-route. Plain `/agent <window> …` routing commands are stamped
    with the DEFAULT discovered pane because they route elsewhere by explicit selector rather
    than by the replied-to message.
  - **Known limitation (matches `routes`):** both writers do read-modify-write rather than a true
    `O_APPEND`, so a daemon-inbound write racing a concurrent agent-outbound write could lose a
    record. The daemon is the single inbound writer and outbound writes are short; a file lock is
    out of scope for a best-effort, bounded log (same posture as the `routes` map).

- **Durable forwarded-question state (`tg-ctl.<botid>.questions.json`, v1.20.0):** the daemon held
  all question state ONLY in memory (`pendingButtons`/`activeButtonKeys`/`answeredButtons`), so a
  hook socket close or a daemon restart lost it. The daemon now persists scoped questions + the
  answered-replay cache to this file (path on `CtlPaths`, atomic temp+rename write) on every
  mutation, and restores them on bootstrap. Three guarantees, one mechanism: (a) **late-delivery** —
  a tap that lands after a question's hook socket closed (the agent's 120s budget elapsed, or it
  died) injects the chosen option into the asking pane (the text-reply inject path) instead of
  hitting the `!pending` drop; the retained card keeps its keyboard. A socket-closed scoped question
  moves out of `pendingButtons` into `abandonedButtons` (so it never defers its pane's inbound) and
  is retained for `TG_CTL_ABANDONED_RETAIN_MS` (default 30 min) — a window enforced at delivery time
  (not only on restore), so a tap past the window expires rather than injecting a long-stale answer,
  even on a quiet daemon with no intervening mutation. A `permission`-kind entry uses the separate,
  much longer `TG_CTL_ABANDONED_PERMISSION_RETAIN_MS` (default 12h) instead — tg-cli#182: a
  permission's answer is still fully actionable hours later (the harness may still be sitting on its
  own terminal fallback prompt, or a hook may still reconnect), unlike a question, whose value fades
  fast if stale; every retention/expiry check (`pruneAbandonedButtons`, restore, delivery-time
  enforcement) branches on `req.kind` to use the right window. (b) **lossless reconnect** — the
  `tg-ctl ask` client for a SCOPED question reconnect-and-resends the same requestId across a
  mid-block socket drop; the restored daemon re-attaches the pending entry (no duplicate card) or
  replays the stored answer (#98, now persisted). (c) **dead-card UX** — a genuinely-dead card (an
  unscoped question, or a send-failed forward) has its inline keyboard cleared on expiry. A SCOPED
  permission is reconnectable the same as a scoped question (`askDaemonOnce`); only UNSCOPED
  requests (no `paneId` — no card to late-deliver/re-attach to) keep the single-attempt client path,
  since resending those would post a duplicate card. `question-store.ts` owns the on-disk format
  (PURE); the entrypoint owns the I/O.
- **Pane-inject late-delivery for permissions (`features/tg-ctl/permission-menu.ts`, tg-cli#267):**
  for `claude` specifically, a disconnected permission's hook has already fallen back to Claude
  Code's OWN numbered terminal "Do you want to proceed?" menu — answerable directly by
  `tmux capture-pane -pJ`, re-verifying the menu still identifies THIS request (LINE-EXACT match
  against `extractPermissionIdentity`, never a raw substring — a boundary-only check still lets a
  stale "git push" tap match a live "git push --force" menu, since both genuinely continue at a
  space; only comparing whole lines tells them apart). A multi-line command (a heredoc, or several
  statements written across lines) still cannot match here — tracked as tg-cli#283, needing live
  verification of how Claude Code actually renders a multi-line command's box before a fix can be
  trusted (a real incident, 2026-08-25, confirmed this class of command gets permanently stranded in
  the queue-and-wait path below with no way to ever resolve — the fix attempted for it was reverted
  after a 3-round review surfaced an unresolved escalation risk and unverified rendering assumption,
  see tg-cli#283 for the full history). The daemon injects the matching digit (bare,
  no Enter — Claude Code's menu submits instantly) and re-captures after a pace to CONFIRM the menu is
  actually gone before claiming delivery (a tmux exit code alone doesn't prove the app consumed the
  key — e.g. copy-mode swallows it). No waiting process, no dependency on a hook reconnect that may
  never come for a terminal-fallback permission. Every other agent kind, and claude when the menu
  can't be re-verified live, falls through unchanged to the queuing mechanism below.
- **Queued permission decisions (never drop a tap on a disconnected permission, and never expire it
  on the SHORT question timer — Alex tg#9982):** the pane-inject path above covers claude when its
  menu is live and verifiable; every other case (a permission has no pane-text-injection fallback in
  general — the hook needs a structured JSON reply, not terminal text) still can't be delivered
  immediately when a Telegram tap lands while its hook is disconnected. It is QUEUED on the retained
  entry (`AbandonedButton.queuedDecision`, persisted immediately — survives a daemon crash between the
  tap and the reconnect) and delivered automatically the instant a reconnecting hook re-attaches to
  the same requestId AND its full payload (question text + `toolInput`, `permissionPayloadMatches`)
  still matches — guarding against a stale requestId reused against a materially different action.
  While a decision is pending, its Telegram card stays pending, and it is never silently cleared
  without 100% confirmation it was actually delivered. Delivery IS still bounded, but by the
  permission's own much longer window (`ABANDONED_PERMISSION_RETAIN_MS`, default 12h — tg-cli#182),
  not the 30-min question one; a reconnect past that window falls through to a fresh live prompt
  instead of auto-delivering the stale decision (enforced synchronously at the reconnect point itself,
  not only by the periodic sweep — tg-cli#182 round 4). What makes delivery WITHIN that window safe is
  the identity check upstream in `hook-normalize.ts`, applied ONLY to
  `permission`/plan-approval requests (never `question`-kind — see below): `env.invocationNonce`
  (`HookEnv`), a random id `askDaemon` generates ONCE PER `tg-ctl ask` PROCESS. The harness spawns a
  fresh process for every hook event, so this is a true per-INVOCATION identity, folded into a
  permission's requestId hash and carried as `ButtonRequest.promptTurnId`. This is stronger than (and
  does not depend on) Claude Code's `prompt_id` / Codex's `turn_id` (`hook-normalize.ts`'s
  `invocationSeed`, kept only as extra hash entropy for permissions): those scope to the whole prompt
  TURN, not the individual tool call, so two DISTINCT permission invocations of an identical command in
  the SAME turn would still share a requestId under `prompt_id`/`turn_id` alone — a real gap found in
  review (tg#9982 follow-up) that the per-process nonce closes completely. A genuine reconnect is the
  SAME process's own reconnect-and-resend loop (`requestHookAnswerWithReconnect`), which resends the
  identical serialized request (same nonce), so it still matches; a materially later invocation is
  always a NEW process with a NEW nonce and can never collide, no matter how much wall-clock time
  passes. `permissionPayloadMatches` remains as defense-in-depth against the narrower residual risk of
  a lossy `summarizeInput` digest collision, not a stand-in for identity. **`question`-kind requests
  deliberately keep the OLDER, looser `prompt_id`/`turn_id`-only scoping** (no `env.invocationNonce`):
  a question has no queuedDecision auto-delivery hazard (only pane late-delivery on an explicit human
  tap, or reconnect re-attach), and the existing, tested multi-question retry contract
  (`ctl-multi-question-abandon-integration.test.ts`) requires a re-asked question from a genuinely new
  process (the harness always spawns one per hook event) to hash IDENTICALLY so it re-attaches to its
  retained card instead of duplicating — folding the nonce into a question's hash breaks that (tried
  once during review, reverted). `promptTurnId` rides through as an explicit field, and a permission's
  auto-delivery REQUIRES it on the retained request: the ONE remaining case it can be absent is a
  manual/back-compat caller that hand-builds an already-normalized ButtonRequest JSON (not real harness
  traffic — a genuine Claude Code/Codex hook always sends raw JSON, which always gets a nonce for a
  permission) or a retained record persisted to disk before this field existed (a one-time
  1.41.1→1.41.2 upgrade transient). Either way the queue stays alive and re-tappable, but a reconnect
  just shows an ordinary fresh live prompt instead of risking a stale approval on unproven identity — a
  human who taps that fresh prompt again is never mistold their earlier tap will still auto-apply
  (`queuedPermissionDecisionText` and `queuedDecisionStillWaitingText` both skip the "delivered
  automatically" promise for a `promptTurnId`-less entry). A later tap overwrites
  the queue (last tap wins). Past `TG_CTL_QUEUED_DECISION_NOTICE_MS` (default 10 min) with no
  reconnect, the human gets a ONE-TIME proactive "still waiting to reconnect" notice
  (`queuedDecision.notifiedAt` makes it idempotent) — the queue is NOT cleared by this notice, only
  reported. An entry that never reconnects within the full `TG_CTL_ABANDONED_PERMISSION_RETAIN_MS`
  (default 12h, refreshed by every tap — tg-cli#182, NOT the 30-min `ABANDONED_RETAIN_MS` questions
  use) is the daemon's genuine give-up point and gets its own proactive "still no connection" notice
  (mentioning the queued decision by name if one was pending) — both from the daemon's poll-loop
  sweep while it is up, and on restore if the window elapsed while the daemon was down.

- **Graceful reload — no dropped channel (`tg-ctl.<botid>.deferred.json` + cooperative SIGTERM):**
  a reload (a deliberate `tg-ctl restart`, a launchd `bootout`/`bootstrap`, or a crash-relaunch)
  used to drop the live channel two ways. (1) The **defer-while-waiting backlog** — inbound queued
  behind an agent's open question so it is not typed INTO the prompt (spec tg#30) — lived ONLY in
  memory, so a reload silently lost the human's queued messages. It is now persisted to this file
  (path on `CtlPaths`, atomic temp+rename, on every enqueue/flush mutation) and restored on
  bootstrap into the SAME per-pane `DeferQueues`; the restored question (in `abandonedButtons`)
  flushes its restored backlog when it is answered — `lateDeliverAbandonedQuestion` now calls
  `onQuestionReleased` on delivery (which also closes a latent gap: a socket-closed question's
  backlog was never flushed on answer). `deferred-store.ts` owns the on-disk format (PURE, versioned,
  fail-closed, pane-capped); the entrypoint owns the I/O. (2) **In-flight updates.** SIGTERM used to
  `cleanExit(0)` immediately, which mid-batch dropped the current getUpdates batch's not-yet-executed
  actions (offset is persisted BEFORE acting → at-most-once, so Telegram never redelivers them). It
  now runs a **cooperative drain**: SIGTERM sets a flag and aborts only the IDLE long-poll
  (`AbortSignal.any`), the loop finishes the in-flight batch's actions, then exits at the top of the
  next iteration — so a batch that drains within `GRACEFUL_SHUTDOWN_MS` (default 8 s) loses no
  update across the swap. That ceiling is the honest bound: a pathological batch whose remaining
  actions take longer than 8 s (or a hung await) hits the hard-exit fallback mid-batch, and — since
  the offset was persisted BEFORE acting — that tail is lost at-most-once (the normal, non-graceful
  behaviour); in practice a batch is a few `tmux send-keys`, far under the ceiling. A second SIGTERM
  also exits at once. Offset itself is already durable (persisted before acting + Telegram's 24 h
  retention), so the successor resumes with no gap. SIGINT (interactive Ctrl-C) still exits
  immediately — no drain.

- **Inbound voice (STT):** a Telegram voice/audio note → `transcribe-voice` action (updates.ts).
  The daemon downloads the OGG, transcodes to WAV 16 kHz mono via `ffmpeg`, runs the configured
  local Whisper, cleans the transcript, then routes it through the SAME path a typed message uses
  (reply-route with the quote anchor when the note is a reply, else inject into the discovered
  pane). An unconfigured note triggers a guided onboarding reply — never a silent drop. Configure
  with `tg voice setup` (→ `tg-ctl voice-setup`), which probes `~/xp` and persists the `voice:`
  block. Whisper/ffmpeg/network spawns are all timeout-guarded.

- **Threaded replies:** the injected wrap (`injectWrap` in `DEFAULT_CONTROL`,
  `[TG from {name} {id}] {msg} — reply via tg`) now carries the inbound Telegram `message_id`
  via the `{id}` placeholder, rendered `tg#<id>` (the `tg#` prefix — not a bare `#` — is the
  message-ref convention that keeps it distinct from a GitHub issue/PR `#<id>`, tg#28). It
  collapses cleanly only for a genuinely synthetic/non-inbound injection with no underlying
  Telegram message — e.g. a button-tap answer label. An `/agent <selector> <text>` route DOES
  carry an id, forwarded from `sourceMessageId` through `injectToPane` the same as every other
  inbound path (GH-274; before that fix the id silently collapsed for anything routed by name).
  The agent passes the id's numeric portion (without the `tg#` prefix) to `tg --reply-to <id>`,
  which sets `reply_to_message_id` on the FIRST outbound `sendMessage` so the answer threads
  under the message it answers. The id IS Telegram's own per-chat sequential `message_id` — no
  parallel id scheme. `wrapInbound` takes an optional `messageId`; `stepUpdates`/
  `buildReplyInject` forward `m.message_id`; the `download-media` / `transcribe-voice` actions
  carry it too.

### Feature Flags

Defined in `features/auto-attach/feature-flags.ts` as a default-ON map. Overridable by:
- `~/.config/tg-cli/config.yaml` (`features:` block)
- `--feature <name>` / `--no-feature <name>` CLI flags

### Specs

Specs are authoritative. They live in `docs/specs/<feature>.md`. Read the relevant spec before
touching any feature.

---

## Conventions

- **TDD**: write tests in `tests/*.test.ts` first; run with `bun test ./tests` (scope to `./tests` —
  a bare `bun test` from a parent dir falsely grabs sibling-repo tests). All 1460 tests must pass.
- **Codex review** before committing non-trivial changes: `codex exec review --uncommitted`
  (findings appear at the end of output after thinking/exec noise — use `tail -80`).
- **Version bumps**: the `VERSION` const in `tg` must have a matching `## <version>` section in
  `CHANGELOG.md`. A test asserts this — do not forget it.

---

## Useful Gotchas

**Telegram HTML validation** — Telegram strictly validates HTML in messages. A successful send
(CLI prints `OK`, exit 0) also proves the generated markup is valid. Useful as an e2e smoke
test.

**Message size limits** — Telegram caption limit is 1024 visible chars; message limit is 4096.
The transmitter layer in `features/auto-attach/` handles overflow and splitting automatically.
Never duplicate that logic in feature modules.

**Rich messages (`--format html`, auto-routed)** — Bot API 10.1 (June 2026) added
`sendRichMessage`, which renders a much larger HTML tag set than the basic `parse_mode=HTML`
path: native tables (`<table>`/`<tr>`/`<td>`, `align`/`valign`/`colspan`/`rowspan`/`<caption>`),
headings (`<h1>`..`<h6>`), lists (`<ul>`/`<ol>`/`<li>`), dividers (`<hr>`), paragraphs (`<p>`),
collapsible `<details>`, pull quotes (`<aside>`), footers, and LaTeX formulas (`<tg-math>` /
`<tg-math-block>`). There is **no new flag and no new `--format` value** — rich goes THROUGH
the existing `--format html`. `tg` decides by CONTENT (`isRichHtml` in `features/render/rich.ts`):
a body using only the basic inline tags (b/i/u/s/code/pre/a/blockquote/tg-emoji/tg-time/spoiler)
sends via `sendMessage` as before; a body containing any rich-only tag sends via
`sendRichMessage` with `rich_message.html` (NOT a parse_mode — `InputRichMessage` takes exactly
one of `html`/`markdown`). A rich body is sent WHOLE (never 4096-split — that would corrupt a
`<table>`; rich has a 32768-char budget — and never used as a media caption). `--tag`/`--title`
compose (the branded header uses only basic tags, valid inside a rich body); `--reply-to`
threads via `reply_parameters`. Rich limits (≤ 32768 chars, ≤ 500 blocks, ≤ 16 nesting levels,
≤ 50 media, ≤ 20 table columns) are pre-flighted in `validateRichHtml` before the send. The
monospace `tg --table` (`<pre>`) stays as the plain fallback grid.

**linear CLI** — `autolink-tasks` uses schpet/linear-cli.
- Install: `brew install schpet/tap/linear` (NOT `brew install linear` — that installs the
  Linear desktop app cask).
- Auth: `linear auth login`.
- Batch resolution: use a single `linear api '<GraphQL>'` call with a filter query. Aliased
  `issue(id:)` queries are broken for batches — one missing issue nulls the entire response.

**Manual smoke sends** — the `bun test` suite never sends anything real. During development,
sending a few real messages to the configured chat as proof IS accepted practice in this repo
(the chat owner reads them). Keep them few and informative.
