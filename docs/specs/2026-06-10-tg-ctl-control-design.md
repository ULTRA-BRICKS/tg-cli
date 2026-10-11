# tg-ctl — Control Channel for tg-cli

- **Status:** Reviewed 2026-06-10 — multi-agent adversarial review (4 lenses; every
  blocker/major finding independently verified or refuted, two refuted by live
  experiment). Decisions D1–D4 resolved in §12; v1 scope in §16. Corrections are
  marked inline as "(corrected by review …)".
- **Date:** 2026-06-10
- **Branch:** `feat/tg-ctl-control`

## 1. Concept & goals

`tg-cli` today is a one-shot outbound sender (agent → Telegram). This spec adds a
thin, **optional inbound control path** so you can talk back to a running agent
session from Telegram — without turning `tg-cli` into a remote-terminal mirror.

**Philosophy (the differentiator):** moderated, agent-curated signal. The agent
already decides what is worth sending out (it calls `tg "..."` deliberately).
Inbound = inject a message/question into the live session; the answer comes back
**only** as what the agent explicitly sends (via `tg`, or a channel reply). No
full-session mirror, no scraped firehose, no completion-detection heuristics.

**Goals:**
- Send a message from Telegram into a running, **normally-started** agent session.
- Get a curated answer back (agent calls `tg`, or replies via channel).
- Forward agent-initiated questions / permission prompts to Telegram, answerable
  with inline buttons.
- Two transports: **tmux/poll (primary)** and **Channel (deferred experiment, v1.2+)**
  — priority inverted by review, see §3/§12 D1.
- Single daemon, strictly **singleton**, lazily auto-started by `tg`.

## 2. Non-goals (explicit)

- **No normal completion detection** — do not infer "done" from turn-complete hooks or
  terminal output. `StopFailure` is the only Stop-family hook used: it reports explicit
  harness failures/limits and optional proactive usage telemetry, not successful
  completion.
- **No full-session streaming / terminal mirror** — that is `/rc` and every competitor.
- **No screen-scraping** (`capture-pane`) for the round-trip. (Delivery checks may read the
  agent's input box — the #463 submit check below — but agent output never travels to Telegram
  that way.)
- **No arbitrary remote shell** — the only injection target is the agent session.

## 3. Architecture overview

**Components:**
- `tg` (existing one-shot sender) — outbound unchanged; gains a guarded lazy
  auto-start of `tg-ctl`.
- `tg-ctl` — the control daemon / channel server. One binary, two modes:
  - **Poll mode (primary):** standalone daemon, long-polls Telegram
    `getUpdates`, injects into the target tmux pane via `send-keys` /
    `paste-buffer`. Photo/file inbound works here too via `getFile` download
    (corrected by review F6 — media was never channel-only).
  - **Channel mode (deferred, v1.2+):** runs as a Claude Code channel (MCP
    server) spawned by `claude`. Owns Telegram I/O; inbound-only (outbound stays
    `tg`, §4).
- **Hook installer** — writes the question/permission-forwarding hooks into
  `~/.claude/settings.json`. `install-hooks` writes the opt-in sentinel
  `<configDir>/claude-hooks-installed`; on startup the daemon re-merges dropped
  hooks only when the sentinel exists (restore-only, never first-install). A
  settings.json that already carries every tg-ctl hook but has no sentinel
  (an install that predates it) is migrated: the daemon writes the sentinel
  (#211). Self-heal writes go THROUGH a symlinked settings.json to its target
  and keep the file's existing mode (#212).

**Transport selection / priority (corrected by review F3/F5):**
- **Poll/tmux is the primary transport**, not the fallback. "Channel has
  priority" was unenforceable as designed: the flock is first-come-first-served,
  so a poll daemon already holding the lock silently kills a later channel
  instance (it fails the lock and exits 0 — channel dead until a manual
  `tg-ctl stop`), and the spec's own "restart with channels" advice walked
  straight into that deadlock.
- If a channel instance ever owns the bot, poll-mode `tg-ctl` must **not** also
  poll (avoids Telegram 409, the competitor bug class #36800) — both modes take
  the same singleton lock keyed on the bot token (§6). A takeover protocol
  (channel reads pidfile → SIGTERM the poll daemon → bounded wait → acquire) is
  specced together with channel mode in v1.2+.

## 4. Round-trip mechanic

- **Poll/tmux mode:** `tg-ctl` injects the inbound message **wrapped**:
  `[TG from <name>] <message> — reply via tg`. The agent does the work and calls
  `tg "answer"` (curated, branded). Loop closes with no scrape, no completion hook.
- **Channel mode:** the message arrives as a native `<channel>` event, wrapped the
  same way (`… — reply via tg`). **Outbound is always `tg`** — one branded, curated
  voice. The channel is **inbound-only** (one-way channels are supported); we do not
  implement a channel reply tool, so there is never a second, unbranded outbound
  format. Photo/file inbound is delivered as a downloaded path the agent can read.
  Trade-off: a channel reply tool would give native threading / typing indicators but
  would lose `tg`'s branding / auto-attach — rejected to keep a single voice (see D2, §12).

## 5. Transports

### 5.1 Channel (priority)

- **Recommendation: build our own custom inbound-only channel** (an MCP server
  implementing the channel protocol), not the official plugin. Rationale: the official
  plugin is a two-way bridge whose `reply` is the generic, unbranded voice we avoid;
  an inbound-only channel pushes messages in, leaves all outbound to `tg`, and shares
  the singleton lock so it can't double-poll the bot.
- **Risk:** custom channels ride `--dangerously-load-development-channels`
  (research preview, gated) with known preview bugs (#40064 permission relay,
  #36800 duplicate instances / 409). Document and keep poll/tmux as the stable
  fallback.
- **Alternative (faster, less control):** reuse `telegram@claude-plugins-official`
  and run `tg-ctl` in poll/tmux only when the official channel is absent.
  **DECISION DEFERRED TO REVIEW (§12).**
- **Capabilities (inbound-only):** inbound text + photo/file (auto-download). Outbound
  stays exclusively `tg`. Photo/file is the channel-only capability tmux cannot match.
  A one-way (inbound) channel is explicitly supported by the protocol, so no reply tool
  is implemented.
- **Launch (corrected by review EXT-2):** `claude --channels` alone does NOT load
  a development channel — the working invocation is
  `claude --dangerously-load-development-channels server:<name>`. The channel
  server is spawned by `claude` as a subprocess; its lifetime equals `claude`'s.
- **Deferred to v1.2+ (review D1):** research-preview flag with consent dialogs,
  preview bugs #36800/#40064, and no `bun test`-able e2e (the claude-spawned path
  is manual-only; the MCP-protocol layer itself IS testable with a fake host —
  see §11). Poll/tmux covers v1 including media inbound (§5.2).

### 5.2 tmux (fallback + control verbs)

- **Target discovery (corrected by review F2/F7):** target a concrete **pane id**
  (`%N`), never a session name — a session's active pane may be a shell prompt,
  where injected text + Enter would EXECUTE as a command. Sources: the
  registration snapshot `tg` hands over at auto-start (`TMUX_PANE` + cwd), plus
  outside-in discovery by walking the process tree under `pane_pid` from
  `tmux list-panes -a` (note: a Claude Code pane reports its VERSION string as
  `pane_current_command`, e.g. `2.1.150`, not `claude` — match the `claude`
  child process under `pane_pid`, verified live). Before EVERY injection,
  re-verify the pane still hosts the agent process; refuse + reply in TG
  otherwise. `tg`'s own env-based `detectAiModel` does NOT transfer to the
  daemon (it relies on inherited session env) — only the snapshot does.
- **Injection (proven recipe, extracted from competitor source):**
  - Single-line: `tmux send-keys -t <pane> -l "<text>"` — literal mode
    (special-char safe).
  - Multi-line: `tmux load-buffer -` + `tmux paste-buffer -p -t <pane>`
    (bracketed paste). Live experiment showed Claude Code treats a literal
    `send-keys -l` LF as "insert newline" (review F10 refuted the submit-early
    fear for CC specifically), but bracketed paste is the universally safe path
    across the tmux floor (canonical-mode REPLs DO submit on LF).
  - `sleep ~0.5s` (competitor source uses 0.5s, not 0.4s).
  - `tmux send-keys -t <pane> Enter`.
  - Text and Enter are **separate** calls with a gap — a combined/too-fast Enter is
    dropped by the Ink TUI (the single most common failure in the other bots).
  - Submit check (tg-cli#463): even a paced Enter is sometimes lost, leaving the message typed
    in the input box. ~0.7s after Enter, `capture-pane -pJ` and ask the input-box adapter
    (`features/tg-ctl/input-box.ts` — the only file that knows how claude, codex and omp draw
    their box) whether the text is still there; if so send Enter ONCE more, re-check, and if it
    is still typed report it to the CTO in the chat. A harness without an adapter, or a box not
    on screen, is not verified (logged), never retried. Before the capture and before the retry
    Enter the pane must still run the same agent process (pid) the text was typed into; a pane
    reused during the wait is not verified (logged), never read, never sent that Enter.
  - Control verbs (raw keys, no `-l`): `Escape` (exit picker), `BTab` (cycle
    permission mode).
- **`/stop` / interrupt (corrected by review EXT-1):** `tmux send-keys -t <pane>
  Escape` — interrupts the current turn, the session survives (verified live on
  CC 2.1.170). A single `kill -SIGINT <claude-pid>` KILLS the interactive
  `claude` process (~1s, idle or mid-turn) — it is reserved for an explicit
  `/kill` verb whose TG reply says "session killed — restore via
  `claude --resume`". The pid comes from the registered pane's process tree,
  never a global `pgrep -f claude` (matches every claude on the machine).
- **Photo/file inbound works in poll mode (corrected by review F6):**
  `getUpdates` delivers `file_id` → `getFile` download (≤20 MB; polite size
  error above) into `~/.cache/tg-cli/inbound/<update_id>.<ext>` (daemon-chosen
  filename, never Telegram-supplied) → inject the wrapped local path. The old
  "restart with channels" reply is dropped — media was never channel-only.
  Channel mode's residual advantages are only: works without tmux, and native
  event delivery instead of keystroke fragility.
- **No-agent guard:** inbound arrives but no live agent session is found → reply
  in TG with ONE harness-neutral line: "No live agent found → not delivered. Start
  Claude Code / Codex in a tmux window or under the rig wrapper (`rig harness run
  <harness> --name <label>`); omp is reachable in or outside tmux." (tg-cli#454: the old
  "Claude Code not in tmux" text was sent for an omp that was in tmux. Sessions the rig
  wrapper hosts outside tmux are reachable through their abduco PTY —
  `docs/specs/2026-09-30-harness-agnostic-control.md`, which owns that transport.)

## 6. Singleton / idempotency (HARD requirement)

- **Exactly one poller per bot token.** Never two `tg-ctl` instances; never
  poll-mode + channel-mode polling the same bot.
- **Mechanism (pinned by review F1/F2/F4 — F1 was the blocker):** non-blocking
  `flock(2)` on `~/.config/tg-cli/tg-ctl.<botid>.lock`, held for the daemon's
  lifetime. Neither Bun nor Node expose flock and macOS has no `flock(1)` CLI,
  so the implementation is `bun:ffi`: `dlopen` of `libSystem.B.dylib` (darwin) /
  `libc.so.6` (linux), symbol `flock(i32, i32)`, `LOCK_EX|LOCK_NB = 6`, fd kept
  open for the daemon's lifetime — the kernel releases the lock on ANY exit,
  including SIGKILL (verified working on this machine, contention included).
  A second start fails the `flock` → retries for `DAEMON_LOCK_GRACE_MS` (1 s) → exits 0
  (idempotent no-op). The grace exists because a lock probe on a platform without a
  readable kernel lock table (macOS) takes the flock for an instant; a start landing in
  that instant must not become the no-op (tg-cli#490). PID file
  `tg-ctl.<botid>.pid` is purely informational; stale pidfile cleared via `kill -0`.
  `tg-ctl status` must not treat a missing/stale pidfile as "not running" while the
  flock is held or a launchd job supervises this binary (tg-cli#316).
- **Who holds the flock** is read, never taken, where the kernel allows it: on Linux
  `/proc/locks` (FLOCK entries on the lock file's inode, each pid confirmed to have the
  file open via `/proc/<pid>/fd`); elsewhere `lsof -t` names the processes with the file
  open and "does pid P hold it" — asked only for such a P — falls back to taking the flock
  for an instant (absorbed by the grace above).

- **Launcher/daemon split (review F1, blocker):** `tg-ctl start` (and the lazy
  auto-start from `tg`) spawns the daemon with
  `{detached: true, stdio: ['ignore', logFd, logFd]}` + `unref()` and exits
  immediately, WITHOUT taking the lock. The daemon process itself (internal
  `tg-ctl run`) opens the lockfile and takes the flock as its FIRST action,
  exiting 0 on failure. Rationale, both verified on Bun 1.4.0: (a) flock is
  bound to the open file description — a launcher-held lock dies with the
  launcher, opening a two-daemon window; (b) piped/inherited stdio makes the
  launcher (and therefore every agent `tg` call) hang for the daemon's entire
  lifetime.
- Channel mode takes the **same** lock (our custom channel can — a reason to prefer
  custom over official). If the lock is held by a channel instance, poll-mode
  auto-start is a no-op.
- **Race:** two concurrent `tg` calls both attempt auto-start → `flock` serializes;
  the loser exits.
- **Scope boundary (local-only):** `flock` guarantees one `tg-ctl` per *machine*.
  Telegram `getUpdates` allows one consumer per bot token *globally* — two machines
  polling the same `TG_BOT_TOKEN` → 409. So inbound control is **one machine per bot
  token**; multi-machine fleets need a bot-per-machine or a central router (D3, §12).
  Outbound `tg` (`sendMessage`) is unaffected — it works from any number of machines.

## 7. Lifecycle & auto-start

- **Commands:**
  - `tg-ctl start` — spawn the detached daemon and exit (no lock here — §6).
    No-op if already running.
  - `tg-ctl run` — internal: the daemon itself. flock first, then pidfile, then the
    run-info file `tg-ctl.<botid>.run.json` (`{pid, commit, codeDir, startedAt}` — the
    checkout HEAD it loaded), then the poll loop.
  - `tg-ctl stop` — locate the daemon through the same chain as `status` (launchd job,
    flock holder, then a live pidfile pid; a live pidfile pid that does not hold the flock
    is a reused pid and never signalled — tg-cli#438), `SIGTERM`, wait out the drain
    (`GRACEFUL_SHUTDOWN_MS` + margin), clean the pidfile only if it still names that pid.
    Exit 1 when the process is still alive after the wait.
  - `tg-ctl restart [--if-stale]` — `stop`, then relaunch: a launchd-owned daemon via
    `launchctl kickstart <domain>/<label>` (it stays under launchd), otherwise the detached
    `start` spawn. Exit 0 only when the old pid is dead AND a new pid is in the pidfile,
    alive and holding the flock within 15 s; never launches a replacement over a still-alive
    old process. `--if-stale` probes the run state once and stops exactly what it probed.
    `--if-stale` (the deploy step, tg-cli#279): no-op when nothing runs or the loaded code
    is current; restarts when the checkout HEAD moved with daemon-code changes (any path
    except docs/tests/scripts/CI/`*.md`/`tg`) or the code identity is unknown.
  - `tg-ctl status` — running? (pidfile, flock holder, launchd — not pidfile alone)
    loaded code (`code:` line: current / checkout moved without daemon changes / `STALE`
    / unknown)? mode? target pane? bot id? last update age?
- **Deploy (tg-cli#279):** `scripts/deploy.sh` fast-forwards the live checkout and runs
  `tg-ctl restart --if-stale` (also when already up to date, so a hand-pulled checkout
  converges); exit 3 when that restart fails.

- **Lazy auto-start from `tg`:** on `tg` invocation, auto-start `tg-ctl` **only if both hold**:
  - inside a tmux pane (`TMUX` set) with a detected AI agent, **and**
  - config `control.enabled: true`.
  - **No TTY check.** The agent calls `tg` through Claude Code's Bash tool with stdout
    piped, so `isatty` is false in the *exact* scenario we want to fire — a TTY gate
    would kill the headline trigger. The `TMUX` check already excludes CI/cron (no
    `TMUX` there), doing the protective work without breaking the feature. (Verify
    `isatty` under the Bash tool before relying on this.)
  - **Cleaner alternative / complement:** a `SessionStart` hook starts `tg-ctl` once
    when `claude` launches in tmux, instead of on every `tg` call. Auto-start-from-`tg`
    stays as a fallback; both are idempotent via `flock`.
- Auto-start is fire-and-forget and idempotent (`flock` guarantees a single instance).

## 8. Question / permission forwarding and harness status hooks

Core handoff shipped in `tg-ctl`: a hook process runs `tg-ctl ask`, writes a
normalized question/permission JSON request on stdin, and waits on the running
daemon over a bot-scoped Unix domain socket (`tg-ctl.<botid>.sock`). The daemon
sends Telegram inline buttons, consumes `callback_query` updates in the same
poll stream as messages, immediately `answerCallbackQuery`s every tap, edits
answered/expired prompt messages, and returns agent-specific JSON to the hook
client. A missing daemon/socket or timeout returns no decision so the local
agent UI takes over. The daemon also checks the hook request against the active
registration: `paneId` is authoritative — when both sides know the pane, a
mismatch fast-passes even if `cwd`/`sessionName` agree (a second keyboard
session in the same cwd must never block on Telegram); `cwd` and `sessionName`
match only when the pane is unknown on either side. Mismatches fast-pass with
no Telegram prompt so globally installed hooks cannot block unrelated keyboard
sessions.

Hardening: the daemon `chmod 0600`s the socket on listen (the guard trusts
client-supplied fields, so other local users must not reach it); hook requests
are capped at 64 KiB per connection; a tap is matched against the prompt's own
Telegram `message_id`, so a stale tap on an earlier message that reused the
callback key answers "expired" instead of resolving a later hook (skipped only
while `sendMessage` is in flight — that race resolves in the tap's favor).

Claude Code hook installation remains an automation layer over that handoff
(backup first):
- `PreToolUse` matcher `AskUserQuestion` → call `tg-ctl ask` with question +
  options → return
  `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"allow",
  updatedInput:{...tool_input, answers:{<q>:<label>}}}}`. `hookEventName` is
  REQUIRED here too (tg#5741): Claude Code (verified on 2.1.198) validates hook
  JSON output and DISCARDS the entire output when `hookSpecificOutput` lacks it
  ("hookSpecificOutput is missing required field hookEventName"), so the card
  reads "answered" while the agent falls back to the local dialog. `updatedInput`
  echoes the ORIGINAL `tool_input` (CC schema-validates it wholesale against the
  tool's input schema — option `description` is a required field there, previews
  must survive) with the collected `answers` merged in; the rebuilt-from-request
  shape remains only as the fallback for manual callers that carry no tool_input.
  A MULTI-question call (2-4 questions, the tool's schema cap) forwards as one
  SEQUENTIAL card per question — each with a `(i/N)` title suffix and its own
  stable per-question requestId, seeded by session + question text + ORDERED
  option labels so a later same-text/different-options call never re-attaches a
  stale card (replay/reconnect dedup for true re-fires unchanged) — and the ask
  client composes ONE combined reply from the collected answers. ALL-OR-NOTHING:
  any multiSelect/free-form question, or any declined/timed-out card, bails the
  whole call to the local UI — a PARTIAL answers record must never be emitted
  (once a hook supplies `updatedInput` no dialog is shown, so CC would silently
  record the unanswered questions as "(no option selected)"). For the same
  reason a set member is never LATE-DELIVERED: once the local dialog takes over
  it owns ALL the questions, and injecting one lone late answer could answer
  the WRONG prompt — a late tap on an abandoned member is refused with a "the
  terminal took over" toast WITHOUT mutating state, so the retained entry keeps
  doubling as the daemon-bounce reconnect anchor (re-attach, no duplicate card)
  and stale members still expire via the retention window. The client also
  REPAIRS a single-question reply from a stale RUNNING daemon that predates
  `hookEventName` (live-symlink deploys update the hook client before the
  daemon restarts).
- `PermissionRequest` → call `tg-ctl ask` with tool + args → Approve/Reject
  buttons → return
  `{hookSpecificOutput:{decision:{behavior:"allow"|"deny"}}}`.
- **Plan-approval (`ExitPlanMode`)** is the harness BLOCKING plan-mode prompt
  (ROADMAP "Forward harness confirmation / permission prompts to TG"). It is
  recognized by `tool_name === "ExitPlanMode"` and forwarded as a permission with
  **relabeled buttons — Proceed (allow) / Keep planning (deny)** — carrying the
  plan text in the message body (clamped to stay inside Telegram's 4096-char
  limit). It gets **NO dedicated PreToolUse matcher**: per the live hooks docs
  BOTH `PreToolUse` and `PermissionRequest` can fire for the same ExitPlanMode
  call, so a second matcher would double-forward the plan (and leave the losing
  `tg-ctl ask` blocked until timeout). The `PermissionRequest *` catch-all already
  delivers it exactly once. The hook reply shape follows the event that fired —
  the request carries `permissionEvent`, and `tg-ctl ask` returns
  `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior}}}`
  for `PermissionRequest` — on a relabeled deny the keep-planning reason rides
  `decision.message` (the live hooks reference documents it "for deny only: tells
  Claude why the permission was denied" — the MODEL-facing channel, unlike
  top-level `systemMessage`, which is user-only). vs
  `{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision,
  permissionDecisionReason?,updatedInput?}}` for `PreToolUse` (deny carries the
  tapped label as `permissionDecisionReason` so the model gets the keep-planning
  intent). `hookEventName` is REQUIRED in `hookSpecificOutput`. For a PreToolUse
  ALLOW of ExitPlanMode the live hooks docs require `updatedInput` ALONGSIDE allow
  ("Returning allow alone is not sufficient for these tools"), so the original
  `tool_input` is echoed back unchanged as `updatedInput` (all confirmed against
  the live hooks docs).

Codex uses the same `tg-ctl ask` handoff for `PermissionRequest` and returns
the documented Codex shape:
`{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"|"deny"}}}`.
Codex hooks still require manual trust via `/hooks` on first run.

These work **without** channels (pure hook return-value path). There is still **no
completion hook** for successful turns. A separate, quick `StopFailure` hook shells
`tg-ctl harness-event`: it notifies Telegram when the harness reports an explicit
limit/error and, when a reset time is known, includes the auto-continue button.
Transient overload API stops (for example a 529/overloaded provider response)
also arm an automatic delayed retry: the hook records the pane/session attempt
and one-shot injector PID, spawns the delayed injector, then returns quickly.
StopFailure JSON payloads may include `session_id` or `sessionId`; when present,
that value scopes the retry. The retry key is pane id + session id + tmux window
name (`--window-name` when supplied, otherwise inferred), so a later session in
the same pane/window can replace an older pending retry.
The injected command is localized for English and Russian sessions, with an
increasing logarithmic backoff, duplicate-pending suppression, and an eight
attempt cap per 30-minute failure window so repeated hook events cannot form a
tight retry loop. If the recorded child process is gone before its delay elapses,
the next matching overload event may re-arm the same attempt instead of silently
dropping recovery. Non-retryable failures such as auth, billing, invalid request,
missing model, or max-output-token stops only notify.
The same subcommand also accepts confirmed proactive usage telemetry contracts
piped by a harness hook or collector (Claude Code statusLine `rate_limits`, Codex
`token_count.rate_limits` / `account/rateLimits/*`, Pi
`get_session_stats.data.contextUsage.percent`, and tg-cli's explicit
`schema: "tg-cli.usageLimit.v1"` envelope). Generic token/cost events remain
ignored because they do not carry a quota percent/reset contract, and repeated
warnings for the same agent/limit are deduped for the current reset window (or a
one-hour cooldown when no reset is known).
When Codex reports a hard usage-limit StopFailure, the notification explains why
the proactive 90% warning did not precede it: if no recent supported Codex
telemetry was seen, it points at missing, unsupported, shadowed, or deduped
telemetry; if only stale stored telemetry exists, it says the last sample is no
longer current; if recent supported telemetry exists but stayed below threshold,
it reports the latest below-threshold sample instead of claiming telemetry was
absent. Hard-stop and near-limit copy also distinguishes the natural reset time
from banked/earned resets: tg-cli does not auto-consume banked resets, and the
operator must explicitly redeem one through `/usage` unless a future
configuration explicitly opts into auto-redemption.
`--agent` is a contract selector as well as a report label: Claude
`context_window` telemetry is accepted only with `--agent claude`, and Pi session
stats only with `--agent pi`. For StopFailure compatibility, `--transcript` or a
payload `transcript_path` with no supported usage telemetry is treated as failure
input; the last assistant transcript message is scanned for the limit/error text.
`tg-ctl install-hooks` installs Claude's StopFailure hook and wraps Claude's
statusLine command so the same payload is also sent to
`tg-ctl harness-event --agent claude`. It preserves an existing visible
statusLine command, installs a silent collector when no statusLine exists, and
`tg-ctl status` reports project/local statusLine overrides that shadow the
user-level collector. Running `install-hooks` from a shadowed project wraps that
project-local statusLine too. The statusLine collector samples at most every 30
seconds by default. `install-hooks` also installs a Codex `Stop` hook in
`$CODEX_HOME/hooks.json` when set, otherwise `~/.codex/hooks.json`, that runs
`tg-ctl codex-usage-hook`, which reads the
documented Codex hook `transcript_path`, extracts the latest supported
`token_count.rate_limits` sample from the transcript tail, and forwards it into
`tg-ctl harness-event --agent codex`. Codex documents the hook field, but not the
transcript JSONL format as a stable hook contract; this collector is the local
best-effort bridge until Codex exposes a stable quota/status hook payload.
Codex still requires the user to trust the new hook hash in `/hooks`; other
harness collectors wire their own payload pipe.
The question/permission hook process awaits the button answer over the UDS
request/response path with a hard client-side timeout.

**Verification status (review F5/F7 — live spike PASSED on CC 2.1.170):** a
PreToolUse hook on `AskUserQuestion` returning
`{hookSpecificOutput:{permissionDecision:"allow", updatedInput:{questions,
answers:{<question text>:<label>}}}}` pre-answers the question with NO dialog
rendered — the mechanism works as written. Caveats that go into the
implementation: `answers` is keyed by the QUESTION TEXT (not header); multiSelect
answers are a comma-joined string; `updatedInput` replaces the input wholesale so
it MUST include `questions`; and the contract is an UNDOCUMENTED internal of the
permission component — add a canary e2e (synthetic payload against a real
`claude -p`) that fails loudly on contract drift. The `PermissionRequest` shape
(`hookSpecificOutput.decision.behavior`) is documented and exact.

**Contract drift CONFIRMED (tg#5741, CC 2.1.198):** the predicted drift happened —
2.1.198 hard-requires `hookEventName` inside `hookSpecificOutput` (its hook-output
parser rejects the whole output otherwise, with the dedicated error
"hookSpecificOutput is missing required field hookEventName"), so the 2.1.170-era
question envelope silently stopped delivering answers: the daemon logged
`ask-answered`, the card read "answered: <label>", and the agent still opened the
local dialog. The envelope now stamps `hookEventName:"PreToolUse"` and echoes the
original `tool_input` (2.1.198 also schema-validates `updatedInput` wholesale;
unknown keys are tolerated, missing required option `description` is not). The
`answers` field is part of the tool's input schema on 2.1.198 ("User answers
collected by the permission component"), and the tool's `call()` returns
`input.answers` directly — a complete record finishes the tool with zero local
keypresses, including the multi-question case (previously: local dialog + the
extra final Enter). The deferred canary is still worth adding.

**Timeout semantics (review F6):** set an explicit per-hook `timeout` (~120 s) in
settings.json; the daemon's own deadline is slightly shorter. On expiry the hook
returns NO decision → the normal local dialog takes over; the daemon edits the TG
message to "expired — answer in terminal". Late button taps get
`answerCallbackQuery("expired")`; every callback_query is acked with
`answerCallbackQuery` immediately (review EXT-5 — otherwise the client spins).
The daemon must also expire the TG message when the hook process dies (local
Esc abort), not only on timeout.

**SUPERSEDED for scoped requests (a `paneId` is present) by the durable
forwarded-question state** (see AGENTS.md's "Durable forwarded-question state" and
"Queued permission decisions" entries): a SCOPED question or SCOPED permission is
retained on socket close instead of immediately expiring — a question late-delivers
into its pane, a permission's decision is QUEUED and delivered automatically on a
matching reconnect within its retention window (safety WITHIN that window comes
from requestId being scoped to the prompt turn, not a delivery timer —
`TG_CTL_QUEUED_DECISION_NOTICE_MS` only triggers a one-time proactive notice past
a shorter threshold, it never clears the queue by itself), and only past its
retention window with no delivery does the card actually
expire/give up (with a proactive "still no connection" notice, not a silent drop) —
`ABANDONED_RETAIN_MS` (default 30 min) for a question, or the much longer
`ABANDONED_PERMISSION_RETAIN_MS` (default 12h, tg-cli#182) for a permission,
since its answer stays fully actionable for hours (the harness may still be sitting
on its own terminal fallback prompt) unlike a question's fast-fading value.
The plain "expire on timeout, reject a late tap" behavior described just above
still applies UNSCOPED (no `paneId` — no pane to late-deliver to, no card worth
retaining).

**Shipped core path (user request 2026-06-10):** UDS protocol, inline buttons,
callback routing, expiry editing, Claude/Codex hook output formatting, opencode
adapter helpers, and `pi` limited-status handling. Deferred: idempotent hook
installer, Claude canary test, and long-running opencode SSE ownership.

**Fast-passthrough guard (critical):** these hooks live in `~/.claude/settings.json`
and fire for **every** Claude Code session, including keyboard sessions with no
Telegram. They MUST return *no decision* instantly unless **(a)** `tg-ctl` is running
**and (b)** this session is the active TG-control target (matched by tmux session / cwd
via a registration file written by `tg-ctl`). Otherwise they passthrough with zero added
latency — a normal keyboard session, or any session with no `tg-ctl`, is never blocked,
delayed, or hung waiting for a button tap.

**Generic blocking approval — `tg-ctl ask "<question>" [--timeout SEC]` (tg-cli#149):**
a shell-callable human yes/no for callers that are not harness hooks (agent-tools'
`agent_hooks.approval_cmd`, CI steps, harnesses with no question hook).

- *Mode selection.* The internal ask submodes are recognized POSITIVELY: no args (hook
  client, payload on stdin), exactly `--agent <kind>`, or an argv made ENTIRELY of the
  grant client's grammar (`--verify-grant [<id>]`, `--pull`, `--hook <id>`). Every other
  argv is a generic question, checked before the grant client — `--timeout` first,
  `--timeout=N`, a question that starts with `--` or contains a `--verify-grant` word must
  never fall into a client that exits 0. The question is every token except a valid
  `--timeout N`/`--timeout=N` or a valueless `--timeout`, joined in order (an invalid
  timeout value or an unknown flag stays visible in the question); an empty question is
  denied. Timeout: default 300 s, clamped to [1, 900] with a stderr warning.
- *Request.* An unscoped `permission` ButtonRequest (agent `claude`, Approve/Reject),
  `requestId` = a fresh random UUID per call, `origin.agent = "tg-ctl-generic"`,
  `timeoutMs` = client timeout + 15 s (the daemon's unscoped-abandon backstop, so the
  client's own deadline fires first; the daemon caps it at 15 min).
- *Daemon.* A generic ask (`isGenericAskRequest`: that origin and no pane) is accepted
  without a registration — the fast-passthrough guard above protects keyboard harness
  sessions, and this caller is neither. It does not defer inbound to any pane: it is not a
  prompt open in a pane and may wait 15 minutes, far past the ~110 s that makes the
  unscoped-question defer safe.
- *Verdict (fail closed).* Exit 0 and stdout `approved` (`approved: <detail>` when the
  reply carries one) only for an `allow` decision the daemon produced from an update it
  received on its own `getUpdates` stream, from an allowed sender, for this card: an
  Approve tap on it, or a yes-token text reply to it (`parseDecisionReplyToken`, the
  same rule every permission card uses). Exit 1 with the reason on stderr for: an
  explicit Reject, the daemon's `null` decline, the client timeout, an unreachable or
  dropped socket, a malformed reply, an empty question, missing bot credentials. Nothing
  on disk (history log, questions store) is consulted, so a local writer cannot forge an
  approval; a tap on another card or by a non-allowed sender is ignored.

## 9. Config

- `~/.config/tg-cli/.env`: `TG_BOT_TOKEN`, `TG_CHAT_ID` (existing).
- **Allowlist (corrected by review F13): sender user ids**, not chat id —
  checked on `message.from.id` AND `callback_query.from.id`. Default:
  `TG_CHAT_ID` (correct for DMs, where they coincide); optional
  `control.allowed_senders` for extras. Gating on chat id alone would let any
  member of a group chat inject prompts into the agent session.
- `config.yaml` — a new `control:` block. NOTE (review F1/repo-fit): the existing
  feature-flag parser reads only a boolean `features:` block; `control.*` needs
  its own tiny parser in the same hand-rolled style (strings + booleans + ints,
  one nesting level, no yaml dependency):
  - `control.enabled`: bool, default `true` (flipped from `false` by user
    decision 2026-06-10 post-review) — gates inbound + auto-start. Inbound is
    armed out of the box; opt OUT per machine with `enabled: false`. This makes
    D3 (bot-per-machine) a practical requirement, not just a recommendation.
  - `control.transport`: `auto | tmux` in v1 (`channel` reserved for v1.2+),
    default `auto`.
  - `control.session`: optional fixed tmux session name (else auto-discover).
  - `control.inject_wrap`: template, default `[TG from {name}] {msg} — reply via tg`.
  - `control.staleness_sec`: int, default `300` — inbound older than this is
    dropped on arrival (§10).
  - `control.idle_exit_min`: int, default `30` — daemon exits when no agent pane
    has existed for this long (§10).
  - `control.allowed_senders`: comma-separated extra sender ids.
- `TG_API_BASE` (env, default `https://api.telegram.org`) — injectable Bot API
  base URL; exists so tests can point the spawned daemon at a local fake
  (review F12).

## 10. Error handling / edge cases

- Bot token shared by `tg` (`sendMessage`) and `tg-ctl` (`getUpdates`): `sendMessage`
  does not conflict with the long-poll; only one `getUpdates` consumer is allowed →
  enforced by the singleton.
- **Offset persistence & delivery semantics (revised, tg-cli#322):** persist the
  last-confirmed `update_id` per bot id in `~/.config/tg-cli/tg-ctl.<botid>.offset`,
  shared between modes so a future handover doesn't replay. Semantics:
  **at-least-once** — the raw batch is durably journaled to
  `~/.config/tg-cli/tg-ctl.<botid>.pending-batch.json` (atomic temp-file + rename)
  BEFORE the offset advances, not after. A crash before that journal write means
  the offset never advanced, so Telegram itself redelivers the update on the next
  `getUpdates` call (an update is only consumed once `getUpdates` is called with
  `offset > update_id` — failing to advance the offset redelivers indefinitely, up
  to the 24h server retention window). A crash after the journal write but before
  the batch's actions fully dispatch is recovered LOCALLY on the next daemon
  startup, by replaying the leftover pending-batch file through the exact same
  `stepUpdates` + action-dispatch path before normal polling resumes. Net effect:
  delivery is at-least-once with idempotent/dedupe-tolerant downstream handling
  (matching how the rest of the codebase already treats double-delivery, e.g. the
  Stop-hook inbox fallback's own dedup checks) — replacing the previous
  at-most-once design (advance the offset before acting; a crash mid-action
  silently lost the message).
- **Stale flood (review F4):** offset persistence does NOT stop the 24 h Telegram
  backlog accumulated while the daemon was down. Drop every inbound whose
  `message.date` is older than `control.staleness_sec` (default 300 s) and send
  ONE summary notice: "skipped N stale messages".
- **409 in the poll loop (review F9):** exponential backoff with cap; after N
  consecutive 409s send one TG/log notice "another consumer is polling this bot"
  and idle. The flock cannot prevent a lingering server-side long poll right
  after a restart, nor a consumer on another machine.
- **Idle TTL (review F12):** if no agent pane has existed for
  `control.idle_exit_min` (default 30 min), exit cleanly — lazy auto-start
  resurrects the daemon on the next `tg` call. No stray processes.
- **Delivery receipts (user request 2026-06-10):** every inbound message whose
  handling fully succeeded gets a **👀 reaction** (`setMessageReaction`,
  best-effort) — the human sees at a glance that the message landed in the
  session. Every failure path replies with an error instead (no-agent,
  ambiguous target, inject abort, kill/download failures, too-large media);
  a failed message NEVER gets the reaction. Stale-dropped and
  disallowed-sender messages get neither.
- `claude` not running → inbound reply: "no active session".
- Multiple tmux sessions with `claude` → pick the one matching the registration
  snapshot (pane id), else `control.session`, else most recently active agent
  pane; if still ambiguous, reply in TG naming the candidates (buttons arrive
  with v1.1 hooks work).
- Channel preview bugs → poll/tmux is the primary transport (§3).
- send-keys into an open picker → optional `Escape` prelude (configurable), matching
  oscarsterling.
- Hook fires but `tg-ctl` is not running, or this session is not the TG-control target
  → **fast passthrough**, no decision, no latency (§8). A keyboard session is never blocked.

## 11. Testing (corrected by review F3/F12)

- **Unit (pure modules, injected I/O):** arg parse; config `control:` block
  parsing; update→action step function (allowlist, staleness, command split,
  offset advance); inject plan building (single-line, multi-line, control
  verbs); discovery from canned `list-panes` + process-tree output.
- **Process-level (NOT unit — it spawns real processes):** flock singleton —
  spawn two `tg-ctl run` against a tmpdir lock path, assert exactly one
  survives, assert the loser exits 0.
- **Auto-start gating:** the skip test asserts on **no `TMUX`**, not no TTY —
  §7 explicitly mandates NO TTY gate (the old "no-TTY auto-start skip" test
  item contradicted §7 and is gone).
- **Integration (tmux, `test.skipIf(!tmuxAvailable)`):** throwaway tmux session
  running a stub TUI (a tiny Bun readline script); assert single-line
  `send-keys -l` + delayed `Enter` lands one submission; assert a 3-line
  message via `load-buffer`/`paste-buffer -p` lands as ONE submission; assert
  the `Escape` verb. Tests MAY use `capture-pane` for assertions — the §2 ban
  is on the production round-trip only.
- **No live Telegram in CI:** a local `Bun.serve` fake of the Bot API
  (`getUpdates`/`sendMessage`/`getFile`), reached via `TG_API_BASE` (§9); the
  daemon is spawned as a real subprocess against the fake.
- **Hook (v1.1):** feed a synthetic `AskUserQuestion` payload on stdin; assert
  correct `updatedInput` JSON after a simulated button answer; plus the canary
  e2e against a real `claude -p` for contract drift (§8).
- **Channel (v1.2+):** the MCP-protocol layer is testable with a fake host
  (spawn `tg-ctl`, JSON-RPC initialize, assert
  `capabilities.experimental['claude/channel']`, feed a fake update, assert the
  channel notification); the claude-spawned e2e is manual-only.

## 12. Decisions (RESOLVED by review, 2026-06-10)

- **D1 — RESOLVED: custom inbound-only channel, but deferred to v1.2+.** When
  built, it is the custom inbound-only channel (one branded voice, shares the
  singleton lock; one-way channels are officially supported — omit
  `capabilities.tools`), NOT the official two-way plugin: the official plugin
  owns the bot's update stream, which silently breaks hook-button routing
  (review F8) and double-forwards permissions. Channel mode is demoted from
  "priority" to a config-gated experiment for the research preview's duration
  (permanent `--dangerously-load-development-channels`, consent dialogs, bugs
  #36800/#40064 — both confirmed real). A side fact in the design's favor:
  #40064 breaks the native channel permission relay for `server:` channels, and
  this spec routes permissions through hooks anyway, so the bug is contained.
- **D2 — RESOLVED: `tg`-only outbound.** Matches the repo's positioning
  (curated, branded outbound IS the moat), reuses auto-attach/limits/branding
  for free, avoids a second unbranded voice and a second outbound codepath.
- **D3 — RESOLVED: bot-per-machine.** Config-only (one BotFather call per
  machine), keeps "one lock = one bot = one machine" exactly right. A central
  router is a new always-on service with its own SPOF — defer until a real
  fleet need exists. README gets one sentence: "one bot token per machine for
  inbound". The 409 symptom of ignoring this is documented in §10.
- **D4 — UPDATED: v1 plus Q→buttons core.** v1 = `cc` via the tmux floor
  (poll daemon; §16). Hooks forwarding core (§8) is now shipped through
  `tg-ctl ask` + UDS + Telegram callbacks; opencode has pure native adapter
  helpers against the live 1.16.2 OpenAPI, while daemon-owned SSE subscription
  remains deferred. `/rename`, `/new`, `HarnessAdapter` → v1.2 (an
  interface with one implementation is premature). Channel mode → v1.2+.
  `codex` now supports `PermissionRequest` hook output; `pi`/`aider` stay on
  the tmux floor with honest limited replies. **`gemini` is dropped entirely**:
  Gemini CLI stops serving
  requests 2026-06-18; its successor (`agy`) gets a new row when verified.

## 13. Command layer

Telegram messages starting with `/` are commands; everything else is a prompt (§4).
Two commands are harness-aware; the rest pass through.

**v1 command set (review D4):** `/stop` (Escape inject — §5.2), `/kill` (SIGINT
to the registered pane's agent pid + "restore via `claude --resume`" reply),
`/status` (daemon + target info). `/rename` and `/new` ship in v1.2 with the
adapter layer; until then unknown `/cmd` passes through verbatim (below).

- **`/rename <name>`** — rename the harness session **and** the tmux window together:
  - tmux window: `tmux rename-window -t <pane> <name>` (universal).
  - harness session: via the adapter (§14) — CC `/rename <name>`; opencode
    `PATCH /session/{id}` `{title}`; harnesses without a rename → tmux window only, and
    the bot replies "session rename not supported for `<harness>` — renamed the tmux
    window only."
- **`/new [<name>]`** — reset the session and (re)name it:
  - reset via the adapter — CC `/clear`; opencode `POST /session` (fresh) / `session_new`;
    codex `/new`; aider `/reset`. Where reset is weak (gemini `/clear` clears only the
    screen), the bot says so.
  - if `<name>` is omitted **and** the harness supports naming → ask for a name in TG
    (free-text or buttons), then apply rename. If naming is unsupported → reset only.
- **Any other `/cmd …`** — passthrough verbatim into the harness:
  - TUI harnesses: inject `/cmd …` via `send-keys -l` + `Enter` (the harness interprets
    its own slash command).
  - opencode: `POST /session/{id}/command` (native), no keystrokes.
- **`!<shell command>`** — a message STARTING with `!` (column 0, no leading space) is a
  harness `!` shell-command: injected **VERBATIM**, with **no `[TG from …]` wrapper and no
  reply quote-anchor**, so the harness runs the rest as an in-session shell command. Any
  wrapper/prefix would knock the `!` off column 0 and defeat the convention. Owner-gated by
  the same sender allowlist as every other inbound message (§9) — a non-owner never reaches
  the passthrough. A `!` reply is verbatim too (the quote-anchor is dropped). Multi-line `!`
  bodies inject whole via bracketed paste. Before injection — on every verbatim-`!` surface,
  including a closed topic's `topic-dead` recovery path (whose injectText can replay VERBATIM
  into a freshly re-spawned pane on a same-batch re-spawn) — `shellPassthroughGate`
  (`features/tg-ctl/shell-danger-gate.ts`) checks the command against a narrow named-shape
  denylist (`rm -rf`, `sudo rm`, `git reset --hard`, force-push, a fork bomb, `curl | sh`, …).
  A match is NOT injected — the sender gets a plain-text reply naming the matched rule and is
  told to resend prefixed with a doubled `!!` to confirm and run it anyway; doubling the bang
  peels one `!` and skips the denylist entirely. This is a content gate layered on top of the
  identity gate above, not a replacement for it — same honest non-goal as
  agent-hooks/workflow-danger-gate: a narrow denylist, not a sandbox.

## 14. Multi-harness support

Inbound injection via tmux `send-keys` works for **any** terminal TUI; outbound stays
`tg` for any harness whose agent can run shell (it calls `tg` itself). On that universal
floor, each harness gets an **adapter** exposing native capabilities; where a capability
is missing, the bot states it plainly rather than faking it.

**`HarnessAdapter` interface:** `inject(text)`, `rename(name)`, `reset(name?)`,
`forwardQuestions()` (native | tmux-scrape | none), `detect()` (claim a running
process/pane). The CC adapter is the channel+hooks+tmux design of §5/§8; other adapters
plug into the same `tg-ctl` lifecycle.

**Capability matrix (verified June 2026; re-verified by review against the live
OpenAPI of opencode 1.16.2 at `GET /doc` — all opencode claims confirmed,
including `/question/{requestID}/reply`, `/permission/{requestID}/reply`, the v2
session question/permission reply routes, and the `question.asked` /
`question.v2.asked` / `permission.asked` / `permission.v2.asked` SSE events. Pin the
opencode version in the adapter and validate routes against the live `/doc` at startup:
v2 event variants signal churn. Codex caveat: its hooks must be explicitly trusted by
hash via `/hooks` — first run is manual. Gemini row kept for history only —
dropped per D4):**

| Harness | Native inject | Native question/perm forward | Rename | Reset | Feedback strategy |
|---|---|---|---|---|---|
| **opencode** (`oc`) | `POST /session/{id}/prompt_async` | **YES** — SSE question/permission events + reply endpoints | `PATCH /session {title}` | `POST /session` | **Native HTTP+SSE — best, no tmux** |
| **Claude Code** (`cc`) | tmux (no public inject API) | YES — hooks `PreToolUse`/`PermissionRequest`/`Notification` | `/rename` | `/clear` | hooks + channel + tmux |
| **Codex** | `codex exec` / app-server | YES — `PermissionRequest` hook | — | `/new` | hooks + tmux |
| **pi** | tmux | NO verified native API — no scraping | — | — | tmux + agent-calls-`tg`; Q→buttons says limited |
| **omp** (Oh My Pi) | tmux | NO verified native API — no scraping | — | — | tmux + agent-calls-`tg`; Q→buttons says limited (added 2026-07, tg-cli#243) |
| **Aider** | `--message` (one-shot) | **NO** | — | `/reset` | tmux-only; bot says "limited" |
| **Gemini CLI** | `-p` | **NO** (retiring 2026-06-18 → Antigravity `agy`) | — | `/clear` (screen only) | tmux-only; bot says "limited" |

**opencode is the standout** — server-first (the TUI is one client of a local HTTP
server). The bot owns `opencode serve` on a fixed port; the user's TUI/web attaches to
it. The bot subscribes to `GET /event` (SSE), forwards legacy/v2 question and
permission events to Telegram as inline buttons, answers via `/question/{id}/reply`,
`/permission/{id}/reply`, or the v2 session-scoped question/permission reply routes.
No tmux, no scraping, no core patch (it's MIT and accepts PRs, but none is needed). A
single single-select `QuestionInfo` with concrete `options[]` and `custom: false` maps
to Telegram buttons; multi-question, multi-select, and free-form prompts fall back
until the bot has a multi-answer UI. Caveat: a user-launched TUI binds a random port
unless started with a fixed `--port` (or discovered via `--mdns`) — so the clean path is
"bot owns the server, clients attach", not "inject into an arbitrary TUI".

**Shipped (tg-cli#533) — the daemon-owned subscription, against opencode 2.0.20.** The
bot does not own `opencode serve`: opencode 2.x already runs one background service per
user that every TUI attaches to, announced in `$XDG_STATE_HOME/opencode/service.json`
(`{url, pid, password}`; `/api/*` routes, HTTP Basic `opencode:<password>`). `tg-ctl run`
re-discovers servers every 15 s — that service, plus 1.x per-session servers found from the
listening ports (`lsof`) of `opencode` processes and kept when `GET /session` answers a JSON
list — and holds one `GET /api/event` (1.x `/event`) stream per server: async, reconnecting
with 1→30 s backoff, event size and open-ask count capped. 2.x wire, recorded from the live
service: the envelope is `{type, data}`; `permission.asked` `{id, sessionID, action,
resources}` replies `POST /api/session/{sid}/permission/{id}/reply {decision: once|reject}`;
questions are `form.created` forms (`data.form`), and one `custom: false` single-choice
string field maps to buttons, replied `POST /api/session/{sid}/form/{id}/reply {answer:
{key: optionValue}}`. Each ask enters the daemon through its own hook socket as a
`ButtonRequest` (cwd = the session's directory, so the registration gate applies), with the
subagent label from the fetched session record; `*.replied` / `form.cancelled` from another
client retires the card. A session record that cannot be read, or carries no directory (3
tries, 1 s apart), leaves the ask without a directory for the gate, so it is not forwarded;
Telegram gets a notice naming only the session id and the error, telling the user to answer
in opencode.

**Late answers (tg-cli#687).** opencode holds an ask until someone answers it, so while the
daemon that posted the card runs, the card stays live too. A bridge ask (paneless, `agent:
opencode`, `opencode.serverUrl` set) defers no pane, so the daemon arms no unscoped-ask timer
for it (`TG_CTL_UNSCOPED_TIMEOUT_MS`, 110 s): its socket stays open until a tap, a settle
event, or its server going away. The durable question store carries the card across a daemon
restart: a live bridge ask is persisted like a scoped one and restores as abandoned, keeping
its `opencode` ref (sessionId, requestId, replyKind, form map, serverUrl). A restored card is
bounded by the usual abandoned-retention windows from its posting (question 30 min,
permission 12 h), even though opencode may still hold the ask. A tap on a restored card
replies through the bridge (`OpencodeBridge.reply`), only to a server the bridge currently
discovers (a failed discovery forgets them all), with that server's current credentials. The
entry leaves the store before the POST. Sent → the card reads answered; any other 4xx (the
ask is gone) → the card expires; no live server, a failed request, 401 / 403 (credentials a
rediscovery may rotate), or 408 / 429 / 5xx → the entry goes back for another tap. A restored
card answered in the opencode TUI meanwhile is not retired by the settle event (the new bridge
has no socket for it); a tap on it is refused by opencode and expires it.

**The "not supported" rule:** when a harness lacks native question-forwarding (aider,
gemini, pi-for-now, omp), the bot does NOT silently scrape-and-hope; it forwards what tmux can
see and replies once: "native question forwarding isn't available for `<harness>` —
inbound works, but I can't reliably forward its prompts; answer in the terminal."

**Detection:** reuse `tg`'s existing process/pane detection (it already brands by model)
to pick the adapter; `pgrep` / pane-command disambiguates cc vs opencode vs codex vs pi.

**Scope for v1:** ship `cc` (channel+hooks+tmux) and `opencode` (native) first-class;
`codex` (hooks+tmux) and `pi`/`aider`/`omp`/`gemini` (tmux floor + honest "limited" replies) as
the long tail. See D4 (§12).

## 15. Out of scope / future

- Voice inbound, file-preview tunnels, multi-machine fleet routing, web dashboard
  (the monetization-hypothesis layer) — separate specs.

## 16. v1 scope (review verdict — what this branch implements)

**Integration with the repo (review F14):** `tg-ctl` is a second single-file
entrypoint at the repo root mirroring `tg` (`#!/usr/bin/env bun`,
`import.meta.main` guard, exported helpers so tests can import it). It shares
`tg`'s release: one `CHANGELOG.md` `## 1.4.0` section, `VERSION = "1.4.0"` in
`tg`. Deploy adds a `~/.files/bin/tg-ctl` symlink **after merge to main** (the
live-symlink rule: the main checkout IS the deployed tool). Pure logic lives in
`features/tg-ctl/` with injected I/O per AGENTS.md.

**v1 modules:**
1. `tg-ctl` (root) — thin wiring: `start`/`run`/`stop`/`status`, real flock via
   `bun:ffi` (§6), detached spawn, fetch loop against `TG_API_BASE`, real tmux
   spawns, `getFile` media download.
2. `features/tg-ctl/config.ts` — `control:` block parser (§9), pure.
3. `features/tg-ctl/lock.ts` — singleton decision logic (flock + kill-0
   injected), pidfile staleness, pure.
4. `features/tg-ctl/updates.ts` — pure step function:
   `(updates, state, now) → {actions, replies, newOffset}`; sender allowlist,
   staleness drop, command-vs-prompt split, media→download actions.
5. `features/tg-ctl/inject.ts` — pure: wrap template + tmux command plans as
   data (single-line `send-keys -l`, multi-line `load-buffer`/`paste-buffer -p`,
   separate delayed `Enter`, `Escape` verb, pre-inject pane verification step).
6. `features/tg-ctl/discover.ts` — pure: pick the target pane from injected
   `list-panes -a` output + process-tree info (cc shows VERSION as pane command
   — match the `claude` child under `pane_pid`).
7. `tg` wiring: ~20 gated lines — fire-and-forget auto-start after a successful
   send, only if `TMUX` is set AND `control.enabled: true`; hands over the
   `TMUX_PANE`/cwd registration snapshot.
8. Tests per §11 (unit + process-level singleton + skipIf tmux integration +
   `Bun.serve` Telegram fake).

**Shipped after v1 scope:** §8 hooks forwarding core (`tg-ctl ask` + inline
buttons + callback routing + UDS protocol) for Claude Code/Codex normalized
hook requests, plus opencode native adapter helpers and `pi` limited handling.
**Deferred:**
**reply-routing → v1.1** (user request 2026-06-10, after the first live
round-trip): `tg` records `message_id → {paneId, cwd}` into a routing map on
every outbound send; the daemon routes an inbound that carries
`reply_to_message` to the mapped pane, while plain (non-reply) text keeps the
v1 last-write-wins registration target. This turns one-bot-many-sessions into
a usable fan-in without threads; opencode daemon-owned SSE subscription → v1.1 (shipped, §14, tg-cli#533);
`/rename`, `/new`, `HarnessAdapter` → v1.2; channel mode + takeover protocol
→ v1.2+; the §10 Escape prelude is built in `inject.ts` but not wired (no
config key yet). Each deferral is annotated at its section.
