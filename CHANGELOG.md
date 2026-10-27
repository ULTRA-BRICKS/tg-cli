# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.71.1

- **Python port skeleton (#768).** Added the `tg-cli` Python package and facade with
  TypeScript fall-through, JS-compatible JSON, atomic file writes and UTF-16 slicing.
  Moved the unchanged `tg-call-lib` distribution metadata into the `features` uv workspace
  member, and added locked dependencies and Python CI checks. Existing entrypoints keep
  running TypeScript until a later migration task installs and selects the switch shims.

## 1.71.0

- **Model-render dimension gate (#785).** An agent send that attaches an image from a 3D context
  (a `garage-band`/`3d-cli` project path or a caption naming 3D work) is refused unless the image
  carries a `<image>.dims.json` sidecar from `3d dimension` that passes `3d dimension --check`
  (legible labels: font, overlap, contrast, inside the frame). A non-model image goes out only
  with `RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP="<why>"` approved by the owner. See `tg help`.

## 1.70.0

- **`tg-ctl capabilities --json`.** Prints `{"schema_version":1,"capabilities":["ask-owner-only-v1"]}`
  and exits 0 with no config, env, network or daemon access; any other argv is a usage error (2).
- **`tg-ctl ask --owner-only <question> [--timeout SEC]`.** The card can only be answered by the
  owner: the tapping/replying user id AND the chat must equal `TG_CHAT_ID`, which must be a
  positive private chat id (groups, non-numeric ids: exit 1 `denied`, no send). Other allowlisted
  senders get "not allowed"; the bit survives the socket and disk restore, and a bare chat message
  never answers an owner-only card. A missing question or `--help`/`-h` with the flag is usage
  (exit 2, before any send). Without the flag behaviour is unchanged.
- **`/chatgpt` owner enforcement.** `cgp:` taps now also require the tapping user to be the owner
  in a private owner chat, and a `/chatgpt` command from any other allowlisted sender is dropped.
- **`tg-ctl ask --help` / `-h` is help.** With exactly one argument equal to `--help` or `-h`,
  `tg-ctl ask` now prints usage and exits 0 before any config, auth, daemon or network call (it
  previously posted "--help" as a question). `ask '--help me?'` and `ask --help extra` remain real
  asks. The generic ask approve/reject schema is unchanged.
- **ChatGPT session control (#780).** `tg chatgpt accounts|list|show|events|requests|watch|unwatch|
  pause|resume|continue|service start|stop|connector list|request guardian` is a client of the frozen
  `pm chatgpt api` JSON contract: fixed argv (no shell), method allowlist, stdout capped at 256 KiB,
  per-call timeouts, the child's whole process group ended on timeout/oversize, schema-bounded
  envelope parsing, secret redaction, `--json` envelope. Mutations only queue an owner approval
  inside pm; `continue` first reads `sessions.get` and binds the current latest turn (refused when
  unknown). A timeout of a mutating call exits 75 and is never retried. Exit codes: 0 ok,
  1 pm error, 2 usage (never a Telegram send), 69 pm unavailable, 75 outcome unknown. `tg help
  chatgpt` documents it.
- **Owner-only `/chatgpt` bot menu.** Sessions per account as escaped HTML with Details / Pause /
  Resume / Watch / Continue buttons plus Requests / Refresh. Buttons carry opaque one-use `cgp:`
  references resolved from a durable 0600 store with a fixed schema (`CtlPaths.chatgptRefs`); taps
  need the configured owner chat (fail closed with none), a replayed/forged/expired ref makes no pm
  call, a Continue is refused with "state changed" when the latest turn moved, and a tap only queues
  an approval in pm. See `docs/chatgpt.md`.
- **Mid-argv `-` appends the stdin body last.** `tg "Header" -` with piped text sends `Header`
  followed by the piped body (covered by `tests/cli-stdin-body.test.ts`).


## 1.69.0

- **Message body from stdin.** `tg --tag report < msg.txt` or `cat msg.txt | tg -` sends the piped text; an argv body still wins and a TTY stdin is never read.

## 1.68.0

- **`tg report` takes attachments (#775).** `tg report` accepts repeatable `--photo <path>` and
  `--file <path>` with exactly the plain send's semantics: they ride the same pipeline, so the
  screenshot-attach gate is satisfied by a real `--photo` (a report that cites a screenshot is no
  longer unsendable), the never-attach denylist refuses secret-looking files, a missing/empty/
  unreadable attachment is skipped with a warning while the report still goes out, and code/
  markdown `--file`s are converted to PDF as usual. A rich report cannot ride as a media caption,
  so the photos arrive first as their own message (an album for 2+), then the report, then any
  documents — the plain send's order. `--dry-run` no longer refuses attachments (it used to exit 1):
  it lists each one as `ok` or `would be skipped (<reason>)`, uploads nothing, and the
  unattached-file refusal's resend command now keeps `--dry-run`. The screenshot-attach error
  of a `--tag report` send names `tg report --photo <path>`.

## 1.67.0

- **Identified calls and private history (#761).** `tg call`, `call-cli`, and
  `tg-call call` share one call service: a short identified introduction, a private
  intent journal, an exact-recipient transcript before dialing, and a status anchor.
  A claimed attempt is never automatically repeated. Configured Fish speech has
  bounded synthesis, private output, and per-segment signal/timing metrics; host
  speech requires explicit configuration. Offline dry-run inspects configuration
  without resolving credentials or synthesizing. See `docs/761-integration.md`
  for offline evidence and the remaining live acceptance requirements.

## 1.66.0

- **One session holds a source's alerts (#747).** `tg-ctl alert subscribe --exclusive --source
  sysmon` makes the calling omp session the only **holder** of that source; another session is
  refused with exit 3 naming the holder and the `handoff-request` command. A request delivers a
  note to the holder, which runs `handoff --to <session>` (live sessions only) or `--deny`; a
  request unanswered for 10 minutes lets the requester `take` the slot, as does a vacant one.
  `release` and `holder [--json]` (exit 3 when vacant) complete the set. The holder is keyed by
  the omp session id: a resume keeps it under the new pid, a vanished endpoint keeps it for 10
  minutes (suspended), deliveries failing for 10 minutes free it. `tg-ctl alert send
  --to-holder` delivers `[alert <source> · <severity> · <key>] <text>` into the holder only —
  never Telegram, never the non-exclusive subscribers — and exits 0 / 3 (`VACANT`) / 5
  (`SUSPENDED`, `FAILED`), releasing its throttle claim when nothing was delivered so the
  monitor's retry goes through. Stores written by older versions load unchanged; `unsubscribe
  --all` leaves holders alone.

## 1.65.2

- **A pid that answers EPERM is alive (#748).** `kill(pid, 0)` fails with EPERM when the
  process exists but the caller may not signal it: another uid, or an agent session running in
  its own Landlock signal domain (rig-cli#704). Two probes read every failure as death.
  omp-live discovery (`omp-steer list`, `tg-ctl omp-live status`/`send`) then deleted the
  other sessions' bridge records and sockets, so they could no longer be steered and alerts
  stopped reaching them; `tg-ctl status` printed `not running (stale pidfile)` for a running
  daemon. Both now read a pid as gone only when kill(2) answers ESRCH (or rejects the pid
  before any syscall, e.g. one above pid_t); `tg`'s session probe and the routes lock already
  counted EPERM as alive.

## 1.65.1

- **An unknown topic's picker can start a new session (#735).** The attach picker (and the
  "no session is running" notice) ends with **➕ New session**. A tap runs the `/new` directory →
  harness → model buttons inside the topic (a typed absolute path answers the directory prompt
  there too, a mistyped one gets "not a directory") and keeps the held messages for the 10 minutes
  those prompts live. The agent spawns with THAT topic as its own — `TG_TOPIC=<thread>`, a bound
  binding, no second topic — named after its directory, and the topic is renamed to it. The held
  text messages, in order, are its initial prompt; held photos, files and voice notes are answered
  "not passed — send them here again". A button from an earlier, finished hold starts nothing, and
  a hold that an attach pick delivered or that expired meanwhile spawns nothing.

## 1.65.0

- **An agent message that names a local document has to attach it (#743).** tg#22056 told
  the CTO "Черновик … ~/work/weekly-report-mari.md, проверь перед отправкой" and attached
  nothing, so the phone showed a path. A new gate (feature `file-mention-guard`, ON) refuses an
  agent send whose own prose (`--table` rows included) names an existing local document that
  no `--file`/`--photo` attaches, before any API call and under `--dry-run` too, and prints
  the exact resend command (`tg --file /abs/path <same flags> '<the same message text>'`). A
  document is an absolute, `~/` or `./` path to a non-empty, non-executable,
  group/other-readable regular file whose symlink-resolved path is under home or the temp
  dir, within the 50 MB upload limit; paths in code, `$ ` command lines, URLs, directories,
  missing, system, executable, private (0600) and never-attach files do not
  count. On the live history it would have stopped 8 of 1684 agent messages, all of them
  pointing at a report or plan. The text still never attaches a file by itself (#648).
  `--automated` sends and non-agent senders are not gated; `--no-feature file-mention-guard`
  turns it off.

## 1.64.5

- **`tg-ctl status` and `/status` show the bot's topic settings (#736).** With topics or
  private topics on, a `topics:` line reports `has_topics_enabled` and
  `allows_users_to_create_topics` from getMe, and warns when users may create topics: every
  message sent from Telegram's "New Chat" entry then opens a new topic that waits behind the
  session picker (spec §4.6). A getMe failure, or no answer within 3 s, prints
  `topics: getMe unavailable (…)`; status never fails or stalls on it.

## 1.64.3

- **A session with a browser relay gets its Telegram messages again (#731).** An omp session that ran `omp browser-relay` had that helper listed as a second live omp in its tmux pane. Pane delivery picked it (the lower pid) instead of the session, and every message failed with `Original OMP bridge: endpoint_unavailable … Save/stop the original before resuming it`, although the session's bridge was up. `omp browser-relay` as omp spawns it (the subcommand right after the program) is no longer an agent. A pane now belongs only to the agent it runs (its shallowest one), never to an omp nested under it, and a pane delivery that knows that agent's pid targets exactly it. A relay started by hand with global flags before the subcommand is still listed outside panes (#737).

## 1.64.2

- **📥 Inbox copies and old reminders survive a Telegram outage (#722, #723).** A copy whose
  card closed stays in `tg-ctl.<bot>.question-inbox.json` (`removing`) until Telegram deletes it
  or refuses for good, retried on every sync; before, a delete that failed in an outage left a
  dead copy with buttons in the Inbox for good. A copy already gone counts as removed. The
  startup reminder migration now queues the old "⏳ still waiting" ids in
  `tg-ctl.<bot>.reminder-retire.json` before dropping their sources, and retries them at startup
  and once a minute until retired.
- **A chat answer no longer lands on another tmux server's card (#722).** A plain message to a
  session answers a card asked from the same pane only when the asker ran on the daemon's tmux
  server (`%1` repeats across servers); the session key still matches anywhere. The asking
  session (and so the card's topic) is no longer taken from a same-numbered pane on another
  server either.
- **Two racing posts of one hatch leave one open card (#723).** The newer card, once posted,
  also closes an older one whose post had not returned yet ("↻ superseded").

## 1.64.1

- **Open question cards are never dropped on restart (#707).** `tg-ctl.<bot>.questions.json`
  kept only the 200 newest records, so with more than 200 open cards a restart silently lost the
  oldest: their Inbox copies went and a tap said "expired". Every open card (pending or
  abandoned) is now kept on write and restored on read; only the answered-replay cache (closed
  records) is capped at 200 (`MAX_ANSWERED_RECORDS`).
- **An edit that changes nothing is success, not a logged failure (#728).** Telegram answers
  `editMessageText` / `editMessageReplyMarkup` with HTTP 400 "message is not modified" when the
  message already shows that text and keyboard (a card closed twice, a keyboard already cleared,
  a restored card re-rendered). The daemon's one Bot API path (`botPostResult`) now treats that
  as success, so restarts and withdraws no longer log false `… failed: 400` lines. Any other
  refusal of an edit is still logged.

## 1.64.0

- **Intent gate: questions, problems and reports must be in their format, tagged or not
  (#706).** Agents skipped `--tag decision`, so bare prose questions ("Решай, оставлять его или
  закрыть") went straight to the CTO. `tg` now reads every agent-written body: a question to the
  reader (a `?` sentence or a decision imperative, RU/EN) needs the decision-request format; an
  explicit blocker needs the problem format (context, evidence, the ask, headings + `<hr>`); a
  report of finished work needs a reference and verification. A malformed one is **blocked**
  (exit 1, the exact missing list); a decision + problem + report mix is blocked ("send
  separately"). A valid report / problem / answer that also asks a question outside the format,
  carries several decisions, or hides a blocker is **sent**, and each item is **recorded** as a
  follow-up owed as its own `--reply-to` reply — `tg obligations` lists / checks (`--check`
  exits 1) / dismisses them; a passing reply settles one. Scope: agent ancestry or an agent env
  marker; `--automated` (now passed by tg-ctl's alert and usage sends) skips the problem/report
  formats. laya is consulted only through task-cli's already-warm classify server, within
  `TG_LAYA_TIMEOUT_MS`, as an advisory hint — tg never loads a model.
- **The decision format requires a Glossary** (skill point 2): every internal name explained in
  one phrase, under a Glossary / Глоссарий heading or an inline "Глоссарий: …". The `tg help
  format` example now carries one and passes the gate itself.
- The test suite no longer inherits the agent session it runs in (agent env markers scrubbed,
  `TG_LAYA=0`), so a run inside omp and a CI run see the same sender.
- **📥 Inbox replaces the "⏳ still waiting" reminders (#705).** The #403 critical-hatch reminder and the #464 unanswered-question reminder are deleted (with `TG_CTL_CRITICAL_REMINDER_INTERVAL_MS`, `TG_CTL_UNANSWERED_REMINDER_AFTER_MS`, `TG_CTL_QUIET_HOURS_*`). In topics mode every open card gets a silent copy in one "📥 Inbox" topic (`tg-ctl.<bot>.question-inbox.json`) with the same buttons plus "✕ Dismiss"; taps and replies on the copy act on the card; the copy is deleted when the card closes. A one-shot startup migration retires reminder messages the old sweeps left and removes `tg-ctl.<bot>.unanswered-reminder.json`.
- **Questions close on relevance, not on a timer.** `TG_CTL_ABANDONED_RETAIN_MS` / `TG_CTL_ABANDONED_PERMISSION_RETAIN_MS` and the "still no connection" give-up are gone. Close signals: an answer typed in chat when the session has exactly one open card other than a hatch gate (more → one "reply to the card you mean" notice), a newer hatch request for the same (hookId, cwd), a decision on a sibling hatch card or a consumed grant, a socket `{"withdraw": …}` / `{"withdrawHookId": …}` line, the new `tg-ctl withdraw` command, `tg-ctl ask` withdrawing on SIGTERM/SIGINT/SIGHUP or when the process that asked exits (a hatch ask is not withdrawn, so a late Approve still mints a grant), and Dismiss.
- **A card goes to the topic of the session that asked (#717).** A question, permission or hatch card is posted with a notification into the requesting session's topic: the hook's session id, else the asker's `TG_SESSION` pin (1.61.1) when it names a live session, else the session owning the asking process (ancestor pid chain or tmux pane, after a registry rescan). It never lands in another session's topic. When topics are on and no session resolves, the card itself goes into the 📥 Inbox with a notification instead of silently into General. `tg-ctl.log` records `ask-forward posted: … thread=<id|inbox:N|general> session=<key|->`.

## 1.63.0

- **A Telegram outage no longer loses a send (#710).** On 2026-10-14 the Bot API answered
  `sendMessage` with `504 Gateway Timeout` after ~2 minutes and `tg` exited 1 — the message was
  gone. A send now retries a `429`/`500`/`502`/`503`/`504`, a dropped/refused connection or an
  attempt hung past 30 s (120 s for an upload), with backoff (1 s, 2 s, 4 s, 8 s …, Telegram's `retry_after` on a
  `429`) until 60 s have passed (`TG_SEND_RETRY_BUDGET_MS`), one stderr line per retry. Past that, the
  undelivered rest of the send (with copies of its photos and files) goes to the bot's outbox
  under the config dir and `tg` exits **75** (EX_TEMPFAIL). The `tg-ctl` daemon sends the queue
  on startup and after each successful getUpdates, oldest first, into the original topic and
  under the original reply anchor, each message marked `⏳ доставлено с задержкой, написано в
  HH:MM UTC`; the replayed ids get their routes and `tg replies` history like a normal send. A
  queued message Telegram refuses (`4xx`) is moved to `outbox/failed/` and logged. A `400` or
  `403` still fails at once with exit 1, as before. The outbox is bounded: a queued send older
  than 24 h, or the oldest beyond 200 queued sends or 200 MB, moves to `outbox/archive/`
  unsent, with a warning in the daemon log; the daemon checks the limits before each replay.

## 1.62.0

- **`tg voice setup` installs a fast, prebuilt Whisper on macOS and Linux (#711).** With no
  usable Whisper on the machine, setup used to say "build whisper.cpp". It now installs one —
  prebuilt only, nothing is compiled — into `~/.local/share/tg-cli-voice` (`$XDG_DATA_HOME`):
  - **macOS:** `brew install whisper.cpp` (the Homebrew bottle, Metal) and
    `ggml-large-v3-turbo-q8_0.bin` from Hugging Face.
  - **Linux:** a uv venv with `faster-whisper==1.2.1` and `av<16` from wheels
    (`--only-binary :all:`), plus the `nvidia-cublas-cu12` / `nvidia-cudnn-cu12==9.*` wheels
    when the PCI bus shows an NVIDIA GPU (even before its driver loads), and the
    `large-v3-turbo` CT2 model.

  The host is probed again afterwards, and the config is written only for an install that
  works; a model download cut off midway is resumed by the next `tg voice setup`. A missing
  Homebrew, uv or ffmpeg prints the exact command that installs it. `tg voice setup --dry-run`
  prints the plan, or the `voice:` block it would write, and changes nothing. The daemon never
  installs: an unconfigured voice note gets a reply that lists the commands `tg voice setup`
  will run.
- **A re-run keeps your voice config.** If the binary and model in `voice:` still exist,
  `tg voice setup` keeps them; it used to replace them with what it discovered. When nothing is
  configured, Linux now prefers faster-whisper over whisper.cpp (about 6x faster on a CPU) and
  macOS prefers whisper.cpp (Metal). The default faster-whisper model is `large-v3-turbo`
  (was `large-v3`), and a `large-v3-turbo` CT2 dir next to the venv is used directly.
- **Faster transcription.** The built-in faster-whisper script (`tg-faster-whisper.py`) is
  rewritten whenever it changes. It detects the language in the same encoder pass that decodes
  (`multilingual=True`, not `language=None`, which ran the encoder twice); a venv with
  faster-whisper older than 1.1, which has no `multilingual`, keeps the separate detection pass.
  It runs int8 on the physical cores with VAD, uses CUDA float16 on an NVIDIA GPU, and falls
  back to CPU when CUDA fails to load or to decode. On an i7-11800H a 15 s note takes about
  5 s to transcribe (stock: 10–11 s; whisper.cpp q5_0 on the CPU: 30–35 s). whisper.cpp now
  gets `-t <physical cores>` (it defaulted to 4). The new optional `voice.threads` overrides
  the thread count for both runners.

## 1.61.2

- **Concurrent history writers no longer lose rows (#519).** The shared lockfile protocol
  (`fsRoutesLockIo`: history, routes, registration, the photo-hook audit log, inject locks) creates
  the lockfile and writes the owner pid in two calls. A contender that read the file in between
  saw no pid, took it for a SIGKILL orphan and broke a LIVE lock, so two writers ran the
  read-modify-write at once. Under CPU load the history test lost a row whose append had reported
  success (CI run 1816: 149/150). A pid-less lockfile is now broken only once it is older than
  5 s (`ORPHAN_LOCK_AGE_MS`), so a real orphan still clears itself, and the break re-checks that
  age right before it unlinks. A writer frozen for more than 5 s inside that window can still
  lose its lock; a kernel lock (#680) removes that. The test now checks the contract: the file
  holds exactly the rows whose append returned true. A skipped append returns false; it was
  never zero-loss.

## 1.61.1

- **A hatch approval card reaches the session that asked for it (#717).** A
  `RIG_HATCH_REQUEST_*` ask is headless: no harness session id, and the `TMUX_PANE` it inherits
  may host no live session. The card then had no topic and went to General, where nobody saw
  it, and the approval timed out. `tg-ctl ask` now forwards the asker's `TG_SESSION` pin, and
  the daemon posts the card, with its buttons, in that session's topic.
- **An open hatch card no longer holds the user's messages (#717).** The card's `TMUX_PANE` is
  only inherited — no prompt waits in that pane — yet the daemon deferred the pane's inbound
  behind it as if one did. A critical hatch ask also outlived its asker (a `gh ship` killed by
  its timeout): it waited forever, so its card stayed open and the agent in that pane got none of
  the user's messages. Hatch cards never defer pane inbound now, and `tg-ctl ask` exits once the
  process that asked is gone, which releases the card.

## 1.61.0

- **A background job started by omp no longer posts as another session (#709).** omp runs bash
  services and watchers under ONE shared `__omp_worker_daemon_broker`, whose parent is whichever
  omp started the broker. `tg` climbed through it and took that omp as the sender: a U1 vision
  watchdog launched by the MODEL session posted with the FREEZE session's header and into FREEZE's
  topic, and the CTO's replies went to FREEZE. The ancestry walk now stops at the broker (also for
  `tg-ctl alert`): such a send carries no session — its inherited tmux pane is not trusted either,
  so its route origin is `system`, which no agent matches (a reply reaches the picker) — goes to General and
  warns on stderr.
- **`tg --session <id>` / `TG_SESSION` pin a send to a session (#709).** The pinned session's
  process replaces the process tree for the header title, the session topic and the route/history
  session, so a reply reaches it. `tg --session-id` prints the id to hand a background job. A pin
  naming no live session warns and sends with no session — never the tree's or the pane's.
- **A reply in a gone session's topic gets the agent picker (#709).** Instead of the dead-end
  "not running — resume with …", a Telegram reply to a message in that topic takes the flat reply
  fallback: the replied-to message's lineage parent when live, else the picker, posted in the topic
  with the "no longer running" notice; the daemon logs a warning. A plain message still gets the
  "not running" reply.
- **A session topic never looks like the system 📥 Inbox (#709).** A leading 📥 in a session topic
  title becomes ✉, and a title opening with the word "inbox" gets ✉ in front — a session titled
  "📥 INBOX: …" was taken for the Inbox topic.

## 1.60.3

- **`dependency-review` audits the call sidecar's Python pins and passes again (#714).** Since
  tg-call-lib's `pyproject.toml` landed, every PR failed closed: nothing pinned to audit. The
  sidecar's hash-locked pins moved to the root, where the audit reads them —
  `features/telegram_client/runtime.lock` → `requirements-call.txt` (the venv `tg call` / `tg user`
  builds; its sha changes, so the venv is rebuilt once) and `voice-runtime.lock` →
  `requirements-voice.txt` — and the workflow installs a pinned `pip-audit`. The first audit found
  two advisories in the locks: `multidict` 6.7.1 → 6.9.1
  (CVE-2026-104874) and `fsspec` 2026.2.0 → 2026.6.0 (CVE-2026-104851).

## 1.60.2

- **CI gates no longer pass having checked nothing (#326).** `dependency-review` was a skip on
  Forgejo: it probed GitHub's Dependency Graph, the probe always failed there, and the check went
  green with no audit. It now runs the trusted base copy of `ci/dependency-review/dep-audit.sh`
  under `pull_request_target` over the PR head, every time. The script audits the PR's
  lockfiles as data: it copies only manifests/lockfiles into a staging dir (the PR's
  `bunfig.toml` / `.npmrc` / `.cargo/audit.toml` can't repoint or silence an auditor), refuses a
  symlinked manifest, resolves a lockfile-less `package.json` with
  `bun install --lockfile-only --ignore-scripts` only when every dependency is a plain registry
  range (a git / URL / file / alias spec fails closed), and gives pip-audit only fully pinned
  requirements files (`--disable-pip --no-deps`) — an editable / URL / VCS / path / `-r` / `-c` /
  index-option / unpinned line, including one smuggled behind a `--hash`, fails closed instead of
  being built. A go module fails closed too (govulncheck builds the source). An auditor that
  can't reach its advisory database fails the gate, and the message says so rather than
  claiming advisories.
- **CodeQL no longer skips a language it should scan.** The detect step piped
  `git ls-files | grep -q` under `pipefail`; on a large tree the early `grep` exit SIGPIPEd
  `git ls-files` and the language was reported as absent. The list is materialized first, and a
  listing or grep error fails the job.
- **`leftover-grep` fails closed.** An explicit `LEFTOVER_BASE` that doesn't resolve, or a diff
  that can't be computed, now fails the gate (before: a silent fallback, or a swallowed `git diff`
  error and a pass). The workflow fetches the PR head with history and checks for a merge-base;
  a head with none is scanned with a two-dot diff. A bare `=======` line is no longer reported
  as a merge marker.

## 1.60.1

- **Main is green again (#636).** The `tg-ctl alert` lifecycle test made its temp home with a
  direct `mkdtempSync`, which the temp-hygiene guard (#638) rejects; it now uses `tempDir()` and
  tracks its spawned processes with `trackChild()`, so the run-scoped cleanup owns both.

## 1.60.0

- **Monitoring alerts reach the agent responsible (`tg-ctl alert`, #636).** A live omp
  session binds a temporary subscription (`tg-ctl alert subscribe [--pid N | --session ID]
  [--sources a,b] [--ttl 12h]`), keyed by its omp session id. `tg-ctl alert send --source S
  --severity info|warning|critical --key K --text T` posts the alert to Telegram through `tg`
  with a footer per bound session (`↳ также адресовано агенту: <title> (pid N)`) and delivers
  `[alert tg#<id> · S · severity] T` into each bound session over omp-live, so the agent follows
  up on that message with `tg --reply-to <id>`. Bound state is resolved against the omp-live
  registry at send time: a closed session is suspended (nothing delivered), a resumed one (same
  session id, new pid) is bound again with nothing to re-run; a TTL expires the record. Repeats
  of (source, key, severity) inside `--window` (default 10 min) are throttled; `--force`
  bypasses. `alert list [--json]`, `alert unsubscribe [--pid|--session|--all]`. State:
  `tg-ctl.<bot>.alert-subscriptions.json`, `tg-ctl.<bot>.alert-throttle.json`. Sources: rig
  sysmon's Telegram alert and the omp-supervisor watcher's OVERLOAD/EMERGENCY reports.
- `formatAge` moved from `unanswered-reminder.ts` to `text-util.ts` (shared).

## 1.59.0

- **A `tg#<id>` in an outbound message now quotes the message it points at (#116).** The CTO asked
  (tg#5663) that a ref read as the beginning of that message, not as an opaque id: in the private DM
  the styled `𝒕𝒈#5663` could not even be tapped. When the id is in this machine's
  `tg-ctl.<bot>.history.jsonl` (same chat scoping as the excerpt block), the ref becomes
  `«first 48 chars of that message…» (𝒕𝒈#5663)`; in a supergroup the quote is the `t.me/c` link and
  the marker stays plain beside it. DMs get no link: `tg://openmessage` works only on Android and
  opens the chat, not the message. The preview counts grapheme clusters (no half emoji, no lone
  surrogate), collapses whitespace, is HTML-escaped, and quotes each id once, at its first mention.
  At most 8 ids per message are quoted; the rest keep the marker and their bottom excerpt entry, and a
  quoted id leaves the excerpt block. An id the history does not have renders exactly as before.
  The `tg#` pass now runs after the ticket/`#N` linkifiers, so a quote containing `#42` or `HYP-100`
  gains no links. The substitution happens before the transmitter, so a body that a preview pushes
  past 4096 is split rather than rejected. Works in both the basic and the rich tier. New feature
  `autolink-msgref-preview`, ON by default; `--no-feature autolink-msgref-preview` restores the old
  output (plain markers plus the excerpt block). One change applies with the flag off too: when the
  history holds two rows for one id in the same chat, the first-written row is quoted (was: the last),
  and the bottom excerpt is cut by grapheme cluster too (it used to split a ZWJ emoji at its cut).

## 1.58.2

- **The live Telegram e2e runs on Linux (#563).** `bun scripts/e2e-telegram.ts` always required
  macOS `say` and every selected fixture's harness, so on Linux even `--dry-run` exited 4
  (`missing required binaries: say, claude`). Requirements are now per scenario: a fixture whose
  binary is missing (`claude`, `codex`, `omp`, `abduco`) is reported as a `skip` row in
  `report.json` and the rest of the run goes on; `--require <kinds>` makes a missing one fatal
  (exit 4) again. The voice note is made by `say` on macOS, else `espeak-ng`, `espeak`, `piper`
  (with `TG_E2E_PIPER_MODEL`) or ffmpeg's libflite filter; with none of them the voice-note
  scenario is skipped with the reason instead of failing the run. A generated tone is not used:
  the scenario checks that Whisper heard the spoken number. `--help` and AGENTS.md list the
  Linux prerequisites.

## 1.58.1

- **Fixed a CI flake in the queued-permission notice test (#656).** The test read the card's last
  edit as soon as the daemon logged the still-waiting notice. The daemon writes that log line
  before the edit reaches Telegram, so a slow runner saw the previous text. Both notice checks now
  wait for the edit itself.

## 1.58.0

- **A file path in the message text is never attached any more (#648).** `tg "see AGENTS.md"`
  used to find `AGENTS.md` (in the cwd, any git worktree, or anywhere down the tree) and upload
  it, md → PDF — so naming a file in a report leaked it into the chat. Now only `--file` and
  `--photo` attach a file from disk; every path in the text stays plain text (a pasted code
  block over 1024 chars is still sent as a fragment document, as before). `tg --dry-run "see
  AGENTS.md"` validates the text instead of refusing with "does not support attachments".
  Removed with it: the `auto-attach` and `recursive-attach` features (no opt-in remains;
  `--no-feature auto-attach` is an inert unknown name), the worktree and recursive path
  lookup, and the extensionless-file gate. A line-spec still works for a file you attach:
  `tg --file a.ts "bug at a.ts:42"` quotes the lines inline and marks them in the copy.

## 1.57.3

- **A hatch grant notice reaches only the project that asked (#433 item 3, security).** When an omp's
  live endpoint was unreachable, the late-approval notice (approval id + consume instructions) was
  queued to an inbox keyed by the ask's subagent label whenever it had one, dropping its cwd. No
  reader drains such an inbox (the omp Stop bridge reads `agent_key(None, cwd)`), and every project
  escalating under the same label shared it. The pull identity had the same flaw: `inbox:<label>`
  let a pull from another project under that label match the grant route. The notice now goes to
  the asking project's cwd inbox and the route is `inbox:cwd-<sha256(cwd)[:16]>` (`grants.ts`
  `grantInboxKey`); an ask without a cwd has no inbox route, so its notice is not queued and the
  card names the token path. The shared key and its agent-tools test vectors are unchanged. An
  unconsumed grant minted before this release keeps its old route: its pull no longer matches, its
  token path still works.

## 1.57.2

- **A test run no longer leaves temp dirs or daemons behind (#486, #550).** Every test made its
  dirs with a bare `mkdtempSync` and never removed most of them — ~7000 `tgctl-*`/`tg-*` dirs and
  6.7 GB an hour on a RAM-backed /tmp under agent load — and real-abduco tests left their
  `abduco -n` servers running. All tests now get dirs from `tempDir()` in
  `tests/helpers/test-temp.ts`, which the preload removes when the run ends — also when the run is
  cut short by Ctrl-C or SIGTERM — after killing every process the run started (tracked with
  `trackChild`, or found by the run's unique shim/tmux dir in its environment: detached
  `tg-ctl start` daemons, abduco servers). The per-test cleanup hunks from 1.57.1 now go through
  the same helper. `tests/temp-hygiene.test.ts` forbids direct `mkdtemp` in tests/, checks that a
  SIGTERMed child run leaves its TMPDIR empty, and, in a whole-suite run only (no file, `-t` or
  `--watch` filter; ~25 s), runs integration files in a child `bun test` with a private TMPDIR,
  asserting it comes back empty with no surviving process.

## 1.57.1

- **Daemon integration tests no longer depend on host load or the host's processes (#375, #550,
  #545).** Test-only; no product change.
  1. **Children spawned without an env, or with an env lacking `PATH`, escaped the hermetic host.**
     `tests/hermetic-env.ts` now wraps `Bun.spawn`/`spawnSync`: such children get the suite's
     `PATH` and `TMUX_TMPDIR` (a `PATH` the test sets itself still wins). Before, `tg-ctl
     harness-event` ran the real `ps` and one `lsof` per live omp on the machine — ~0.5 s per
     spawn idle, ~2 s loaded — so the harness-event tests hit their 5 s timeout under load (0/10).
     `pgrep` is shimmed too (`pgrep -x bun` used to match the test runner).
  2. **Guessed delays replaced by observed events.** The hook-disconnect tests (from #585) kill
     the hook only after the daemon logs `ask-forward posted`, or hold `sendMessage` open until
     the retired question is persisted. The buttons-failure, voice-picker and persist-before-ack
     tests hold fake Bot API responses until the event they assert on instead of sleeping, and
     the stale-tap and ✍️ assertions wait for the later request that carries them.
  3. **Leftovers.** `abduco-client` tests now stop the abduco servers they start (removing the
     socket dir left them running), and the touched tests remove their temp dirs.

## 1.57.0

- **`tg` now works as YOUR Telegram account and can place voice calls (Refs #562).**
  `tg auth user` logs your account in with one command (phone + code + 2FA, or `--qr`);
  `tg call <@user|id|me> --say "…"|--audio <file>` rings once and plays the audio;
  `tg user send <peer> [text]` sends as you. `tg auth caller` logs in a second account so
  `tg call me` can ring you. It runs over MTProto in the Python sidecar from
  `feat/independent-mtproto-call-20261002` (pyrofork + py-tgcalls + ntgcalls), now driven
  from `tg`: the first account command builds a hash-checked venv under `~/.cache/tg-cli/`
  with `uv`. `--dry-run` checks everything without connecting; HyperCalendarBot's session
  can be imported with `--import-session`/`--import-config`.
- **One `tg auth` for the bot and your own accounts.** `tg auth user|caller …` is parsed by
  the same `tg auth` parser and documented in the same help (`tg help auth` = `tg auth --help`
  = `tg auth user --help`); `tg auth status` now lists `user:` and `caller:` next to the bot
  and chat, read offline from the session files (no Python, no network, exit code unchanged —
  still 78 without a bot). `tg auth login|status|logout` never reach the sidecar.
- **A flag is never taken as another flag's value.** `tg call @a --say --dry-run` is a usage
  error (exit 2), never a real call that speaks "--dry-run"; the same holds for every value-taking
  flag of `tg call`, `tg auth user|caller` and `tg auth login` (`--token --test`) followed by
  a dash word. Dash-leading text uses `--say=<text>`; `tg user send <peer> -- <text>` ends
  options. `tg` passes values to the sidecar as one `--flag=value` token.
- Two first runs build the runtime once: the second waits as long as a live build can
  legitimately take (both install steps at their 10-minute timeout, plus slack), takes over
  only a dead builder's lock, and if the builder is still alive after that, names its pid —
  it never advises deleting the lock.
- **Sessions are stored in `~/.config/tg-cli/mtproto/` (0700/0600), not
  `~/.local/share/tg-cli/auth`.** `install.sh` clones this repo into `~/.local/share/tg-cli`,
  so the old default put account keys inside a git checkout, unignored.
- Sidecar commands renamed for the cutover: `import-calendar` → `import-session` (any
  role), `notify --recipient` → `call --peer`; `login` no longer needs `--begin-login` or
  `--expected-id` (optional now) and reuses the other account's app credentials by itself.
  An imported session needs `--source-session-idle-confirmed` for every online use; a
  session `tg` logged in itself does not.
- `tg call` and `tg user send` are new exact-match leading words: `tg call me later`
  (unquoted) no longer sends that text — quote it.

## 1.56.0

- **`tg auth` connects tg to Telegram in one step (#561).** Paste the BotFather token (or pass
  `--token <token>` / `--token -`), tap **Start** on the one-time `https://t.me/<bot>?start=…`
  link it prints (a terminal QR too when `qrencode` is installed), and `TG_BOT_TOKEN` +
  `TG_CHAT_ID` are written to the config `.env` (atomic, 0600, every other line kept) — no
  numeric chat-id lookup. Only an exact `/start <nonce>` from a private chat, before the link
  expires, binds; the pending file stores only the nonce's hash. `tg auth status` shows the bot
  (@username, name, id), the target chat by name/@username/id, the config path and whether
  tg-ctl runs; `tg auth logout` removes the two keys; `tg help auth` lists the exit codes
  (3 rejected token, 4 timed out, 5 another consumer/webhook, 78 not configured). Nothing is
  sent to the chat unless `--test`.
- **A running tg-ctl takes the Start tap itself — tg auth never competes for `getUpdates`.**
  The daemon claims the `/start` in its poll loop, writes `TG_CHAT_ID`, and switches to that chat
  without a restart. Without a daemon tg auth reads the tap itself, and when a chat is already
  bound it only peeks, so a stopped daemon loses no pending message. A 409 hands over to a daemon
  that appeared mid-flow, else stops with exit 5. Deep-link Start taps are never typed into an
  agent's pane.
- **`tg` without credentials now says how to fix it:** the error names the resolved `.env` path
  and `tg auth`, and exits **78** (was 1) so scripts can tell "not set up" from a failed send.
  `tg-ctl` started without a chat names `tg auth` too.

## 1.55.17

- **CodeQL passes on main again.** The format gate added in 1.55.16 strips tags from a message
  only to measure it or match its sections, and never renders the result as HTML. Its four
  `js/incomplete-multi-character-sanitization` alerts now carry `codeql[...]` markers with that
  justification.

## 1.55.16

- **The `--tag decision` format gate checks each section by its own content (#216).** Options now
  needs ONE table with at least two option rows (with its pros/cons cells filled) or ONE top-level
  list of at least two items. When the body has an Options heading ("Options", "Варианты",
  "Предлагаемые варианты"), only that section counts; otherwise any section but Context /
  Recommendation / Where to look does. A single-option table, an empty-cells table, one option
  with a nested pros/cons sub-list, a table above the first heading standing in for an empty
  Options section, or one bullet under Recommendation plus one under Where to look no longer
  pass; a table with no `<th>` row keeps all its rows as options. A `Recommendation` heading with
  nothing under it no longer counts as a recommendation (a heading that states one, "I recommend
  A", does). A `# comment` line inside `<pre>` or a fence no longer opens a section.
- **"Where to look" must be a real `file:line` (#217, #221).** A bare path (`features/foo.ts`),
  and prose like `and/or`, `A/B`, `12:30` or `step:2` no longer satisfy it; `foo.ts:42`,
  `features/cli/args:12`, `./tg:1219`, `Makefile:12` and forge `#L42` links do. `tg help format`
  now states that a `--file`/`--photo` attachment does not count — write the `file:line` into the
  body.
- **The wall-of-text check measures visible text and respects code (#259, #270).** Tags and link
  URLs no longer count toward a paragraph's length; tag-shaped text inside `<pre>`/`<code>` no
  longer gets a virtual line break that split the code block into "prose"; `<details>`,
  `<summary>`, `<aside>`, `<caption>`, `<thead>`/`<tbody>`/`<tfoot>`, `<footer>`, `<figure>` and
  `<tg-math-block>` now break lines like the other Rich Message block tags (`<aside>` and
  `<tg-math-block>` are skipped like `<blockquote>`/`<pre>`).
- **Mixed-script guard: Russian dev slang passes, invisible characters no longer hide garbage
  (#215, #226, #227, #224).** One plain-ASCII English stem or acronym wrapped in a Cyrillic prefix
  and suffix (`заpushил`, `заmergeил`, `отdebugил`, `антиDDoSный`) is no longer blocked;
  `почčesна`, a homoglyph-only island like `пеpeход`, and two islands still are. A zero-width
  space, ZWNJ, soft hyphen, word joiner or BOM inside a word no longer splits it into two clean
  halves. README, `tg --help` and the JSDoc now say the guard is bidirectional (`mіr` with a
  Cyrillic `і` is blocked too).

## 1.55.16

- **`/tasks` reports a task-list failure instead of an empty board (Refs #201).** A `task list`
  that exited non-zero, printed malformed JSON or printed non-array JSON rendered the same
  "No matching tasks." board as a clean backlog, and the only trace was a daemon log line. The
  board fans out one `task list` per lifecycle state, so one failed call also dropped that whole
  column silently. `/tasks` now replies `couldn't load tasks — <reason>` (exit code and stderr, or
  the parse failure) in the same topic/reply context; blank stdout with exit 0 is still an empty
  backlog. Rescued from the closed PR #129/#135 review finding (branch
  `fix/tasks-noop-guard-tg129`); its selector no-match half is already on main.

## 1.55.15

- **A highlighted partial reply quote reaches the agent whole (#565, HYP-907).** `tg-ctl` cut
  the CTO's Telegram quote selection at the 60-char whole-message preview limit, so the `↩`
  anchor dropped the end of the very words being answered. A non-empty selection is now
  forwarded whole (whitespace-collapsed, still ending in `…`; Telegram itself bounds a
  selection at 1024 chars). A reply without a selection — or with a whitespace-only one — keeps
  the 60-char, surrogate-safe preview of the replied-to message.

## 1.55.14

- **A reply to an exited one-shot sender no longer goes to whichever live agent shares its
  working directory (#503, replaces the #423 heuristic).** The dead-sender fallback picked the
  only live agent whose cwd equalled the dead sender's recorded cwd — but unrelated sessions
  routinely share `/tmp` or a repository root, so replies were typed into the wrong session
  (tg#17659). Parentage is now proven at send time: `tg` running outside tmux under a nested omp
  (a disposable `omp --print` child of a live orchestrator) records the omp that started it as the
  route's `parentPaneId` (`omp:<pid>`), read from the process tree. When the child is gone — never
  seen by the registry, or registered and since exited — the reply goes to that parent if it is
  live (its own `omp:<pid>` row, or the tmux pane it runs in), with a `↩️ <origin> is gone —
  routed to <label>, the session that started it` notice; otherwise the picker with the named
  "no longer running" notice. A shared cwd alone never routes. `parseRoutes` keeps
  `parentPaneId` only in the `omp:<pid>` shape `tg` writes.
- `findAgentInAncestry` → `findAgentsInAncestry` (every agent ancestor, nearest first) and
  `detectAncestorAgent` → `detectAgentAncestry`; one `ps` read serves both the sender and its
  lineage parent.
- Tests: `ctl-reply-dead-sender-integration` (a sole same-cwd agent and a dead recorded parent
  both get the picker, nothing typed), `ctl-omp-reply-no-tmux-integration` (an unregistered and
  a registered-then-gone nested omp both reach their live parent through its original-process
  bridge), `cli-omp-route-notmux` (a nested omp records `parentPaneId`, a lone one does not),
  plus unit tests for the ancestry chain, `lineageParentOriginId`, `lineageParentCandidate` and
  the route round-trip.

## 1.55.12

- **`tg-ctl audit-delivery --since/--until` and `tg replies --since/--until` accept standard ISO
  timestamps with a zone (#524).** `2026-09-29T16:45:00Z` (and fractional seconds, `+00:00` or any
  other offset) used to exit 2 with "cannot parse date"; a bare `2026-09-29T16:45:00` still means UTC.
- **A `/command@botname` typed in a group topic reaches the bound session as the bare `/command`
  (#298).** Telegram's group-chat suffix made it read as prose and get wrapped as chat.
- **The stranded-inbox report is retried on a throttled or corrupt first send (#526).** A
  200-status `{ok:false, error_code:429}` (or 5xx) answer is now transient like an HTTP 429, and an
  archived message holding an unpaired surrogate no longer makes Telegram reject the whole report.
- **Unanswered-question reminders (#518):** a plain-text question keeps its `<word>`s and
  `&amp;`s verbatim (only HTML hatch cards are tag-stripped); with
  `TG_CTL_UNANSWERED_REMINDER_AFTER_MS=0` a reminder an earlier run left in the chat is withdrawn;
  both this reminder and the critical-hatch reminder remember the chat they were posted in and are
  replaced/withdrawn there after `TG_CHAT_ID` changes.
- `tg-ctl status`'s "started before the installed bridge code changed" verdict is computed by a
  pure, tested function: any missing bridge file still gives no verdict (#520).
- Removed the never-installed pre-send-text escalation-format hook template and its test; the
  parse-time `--tag decision` gate is the one enforcement (#488).
- Docs: the inbound message ref is `tg#<id>` in `tg --help`, the installed skill and code comments
  (#277); the autolink-tasks spec documents the `--title` ticket-code refusal and its feature-flag
  coupling, and the `PrRef` comment no longer claims a `state` field (#214).

## 1.55.11

- **A late Telegram Approve/Reject on a permission can no longer type its digit into a DIFFERENT
  command's menu (#309).** The pane-inject path matched a request whose question summary had been
  cut at 100 characters by its prefix, so a long command could be approved through a live menu for
  another command sharing those first 100 characters. Matching is now line-exact over the FULL
  command only; with no exact identity (a truncated summary, or a box that shows the command
  shortened) the decision stays queued, and the command line must sit in the live menu's own box —
  a resolved box left in scrollback right above it no longer counts. The digit plan also re-captures
  the pane inside the pane's typing turn, directly before `send-keys`, and sends nothing unless the
  very same menu box is still live — the first capture could be seconds old, with another permission
  rendered in its place. The post-inject check tells "this command is still asking" (not confirmed)
  from "a different permission now shows" (resolved, logged `after=next-menu`).
- **A live question on the same pane now logs why a late permission tap was not typed
  (`reason=pane-busy`), with an integration test for that guard (#268).**

## 1.55.10

- **`tg-ctl ask "<question>" [--timeout SEC]`: a blocking human approval for any script or
  hook (#149).** It posts an Approve / Reject card and exits 0 only when you approve that card
  (tap, or reply `yes`), read from the daemon's own update stream from an allowed sender; reject,
  timeout (default 300 s, max 900 s), an unreachable daemon, missing credentials or an empty
  question exit 1. Before, `tg-ctl ask` with a question argument fell into the hook client and
  exited 0 with no prompt at all. Every call gets a fresh request id, so nothing in the history
  log, another card or a stranger's tap can approve it. Works without tmux or a session
  registration, and does not hold agents' inbound messages while it waits. README documents
  wiring it as `agent_hooks.approval_cmd` in a consuming repo's `rig.yaml`; the installed `tg`
  skill mentions it.

## 1.55.9

- **`tg-ctl restart` (and the deploy's `restart --if-stale`) no longer leaves NO daemon running
  (#490).** While waiting for the successor, restart checked "does the new pid hold the lock?" by
  taking the daemon flock for an instant, and a starting daemon tried the flock exactly once — a
  successor whose attempt landed in that instant exited 0 as a "duplicate", and restart ended
  `restart FAILED` with nothing serving Telegram. On Linux the check now reads the kernel's lock
  table (`/proc/locks`) and never touches the lock; `stop`/`restart`/`status` also find the lock
  holder there, so a vanished pidfile is handled even without `lsof` (#438). Where no lock table
  exists (macOS) the check — now asked only for a pid `lsof` shows with the lock file open — still
  takes the lock for an instant, so a starting daemon retries a taken lock for 1 s before the
  duplicate no-op exit. `restart --if-stale` stops exactly the daemon it probed instead of probing
  twice.
- **`scripts/deploy.sh` warns that tg/tg-ctl calls run unbounded on the already-up-to-date path
  too** when neither `timeout` nor `gtimeout` exists — that path still runs
  `tg-ctl restart --if-stale`.

## 1.55.8

- **The daemon's Claude Code hook self-heal no longer replaces a symlinked
  `~/.claude/settings.json` with a regular 0600 file (#212).** It now resolves the link and
  atomically replaces the TARGET, keeping the file's existing mode, so dotfile managers keep
  owning the file.
- **Hook installs that predate the opt-in sentinel are migrated (#211).** When
  `claude-hooks-installed` is absent but settings.json already carries every tg-ctl hook, the
  daemon writes the sentinel on startup so self-heal applies; a partial install stays opted out.

## 1.55.7

- **Answering a question that had no tmux pane now delivers the messages queued behind it (#127).**
  An unscoped question defers inbound for every pane, but its answer only flushed a pane when the
  question carried one, so the CTO's text stayed ✍️ forever. The answer now releases every pane's
  backlog via the same path the unscoped abandon/expiry already used. A deferred message whose
  delivery fails no longer keeps its ✍️: the reaction is cleared next to the "was not delivered"
  reply, so nothing claims it is still queued.

## 1.55.6

- **The test suite no longer reads the machine it runs on, and no longer parks the daemon under test
  in `sleepSync` (#545).** A full `bun test ./tests` on a developer machine failed 29–46 tests
  (callback taps, ask-forward logging, hatch grants, `/tasks` pages, omp-live, `html-auto-detect`,
  `dry-run`, `dict-gate-cli`). No product bug and no shared-state race: neither full log contains an
  EPIPE. Three test-environment causes, each measured:
  1. **Empty shims.** A daemon test whose `tmux` exits 0 with no output, or whose `ps` prints no
     rows, is read by the daemon as the launchd flake: three attempts with a synchronous 120 ms
     sleep each, four snapshots per poll tick. The mock Bot API answers `getUpdates` at once (Telegram
     holds it ~50 s), so ticks run back to back and the hook socket — asks, taps — is served only
     between them. One tick took ~4 s (3 polls in 15 s; 108 with a realistic shim); `tg-ctl ask` to
     card took 3.1–4.2 s against 57–350 ms, inside a 5 s test budget that had to cover several hops.
     The shims now behave like a host with tmux unused: `tmux` exits 1 (no server), `ps` lists launchd.
  2. **The host's process table.** A daemon test without its own `ps` shim enumerated every live omp on
     the machine each tick (two `lsof` and a session-jsonl read per omp). `tg` climbed from the test
     process to the omp session that launched `bun test` and took its title as the `[window]` name — a
     Cyrillic title made `html-auto-detect` red deterministically (every plain message went out as
     HTML) — and spent 1.3 s of `ps` + `lsof` + jsonl read on it per run, which pushed `dry-run` and
     `dict-gate-cli` past bun's 5 s timeout under load.
  3. **Load.** The remaining failures of the first run came while the machine's swap was full (load
     average ~400, every process runnable); they are not reproducible on a calm host.

  `bunfig.toml` now preloads `tests/hermetic-env.ts`: a `ps` that lists only launchd (every other
  `ps` call reaches the real one), a `launchctl` with no jobs, a private empty `TMUX_TMPDIR` and no
  inherited `TMUX`/`TMUX_PANE` sit in front of every test's PATH; a test's own shim still wins.
  `tests/helpers/hermetic-host.ts` holds the shim bodies (`TMUX_NO_SERVER_SHIM`, `tmuxNoServerShim`,
  `PS_NO_AGENTS_SHIM`), and the daemon tests that shipped empty ones use them. No product code changed.

## 1.55.5

- **An agent's `tg --reply-to <id>` answer to a message written inside a topic now lands in that
  topic, not in General (#551).** Telegram does not put a reply into its anchor's topic in a
  private chat with topics, and `tg` skipped the session-topic lookup for every `--reply-to`
  send — while the `answer` tag *requires* `--reply-to`, so every answer to a topic message left
  the topic (tg#19001, the CTO's tg#19003 complaint). History rows now record where a message
  sits (`threadId`: a topic id, `null` = General, absent = unknown): the daemon stamps inbound
  messages, `tg` its outbound ones. A reply posts into its anchor's topic on every chunk, stays
  in General for a General anchor, and falls back to the session's own topic when no row records
  the anchor; `--topic` / `TG_TOPIC` still win, and a topic Telegram refuses falls back to
  General like any advisory thread.
- **A text reply to a permission/hatch card or an abandoned question card now answers the card
  inside a topic too.** Cards are posted into the session's topic, but the topic triage skipped the
  decision and post-timeout-answer handling the flat chat has, so "yes" / "no" / the answer was
  typed into the agent as prose and the card stayed pending. Its notices ("expired", "agent is
  busy", "session left its pane", …) now reach the CTO — before, a text reply had no callback
  query to toast and some were silent — and stay in the topic. (A reply to a still-LIVE question
  card is routed to the agent as in the flat chat.)
- **A message inside a topic is logged under the topic's session.** Its `tg replies` row was
  stamped from the flat chat's default target (or no pane at all), so the session's own recall
  missed the CTO's topic messages and another agent's recall could show them. Topic service
  messages (created / renamed / closed) no longer leave `[message]` rows. The "not delivered"
  notice for a topic message is posted in that topic.

## 1.55.4

- **A Telegram message sent to an omp that is mid-turn now reaches it (#552).** The omp-live
  bridge delivered a message to a busy omp as a `followUp`, which omp drains only when the whole
  run ends, and the `wait` tool is woken by steering only. An orchestrator parked in `wait` on
  its subagents therefore never saw the CTO's message, while the daemon logged `accepted` and the
  delivery ledger said `delivered` (tg#19011: absent from the session file minutes after
  acceptance, while tg#19003, sent to the idle agent, arrived in a second). A busy omp now gets
  the message as `steer`, exactly like text typed into its TUI; an idle one still starts a turn
  as an `aside`.
- **`tg --session-topic` hands a detached worker its parent's topic (#553).** A `nohup`-detached
  `omp -p` worker (`rig-detached-omp`) is reparented to pid 1, so the daemon cannot tie its `tg`
  calls, nor those of tools that shell out to `tg` such as the task-cli `[task created]`
  notifier, to any session, and they posted to General. The new flag prints the forum topic of
  the session it runs in, creating it on the first ask, or nothing (exit 0) when there is none, so
  a launcher can run `TG_TOPIC="$(tg --session-topic 2>/dev/null)" nohup … &` and every message
  of the child lands in the parent's topic. Spec §4.3 and the `tg` skill text describe it.

## 1.55.3

- **A message typed into a tmux pane but never submitted is caught and reported (#463).** After the
  paced Enter, tg-ctl reads the agent's input box (`tmux capture-pane`) and, if the message is
  still sitting there — the Enter was lost — presses Enter once more. If it is still there after
  that, the CTO gets a chat reply naming the pane, the agent and the message ("typed but NOT
  sent … press Enter in that pane, or clear the box and resend") instead of a silent "delivered";
  it is never typed a second time. How each harness draws its input box (claude and omp: the
  bottom-most pair of column-0 `───` rules, claude's opening with its `❯` prompt, so a `───` line
  inside a pasted message never splits the box; codex: the last `›` composer; plus each one's
  collapsed-paste placeholder and empty-box hint — "Ask Codex to do anything" is not input)
  lives in one adapter, `features/tg-ctl/input-box.ts`, built from real captures of claude 2.1,
  codex 0.153 and omp 18.3 — the transcript echo of a submitted message never counts. Any other
  harness, or a box that is not on screen, is logged as unverified and never retried. The pane is
  re-checked before its box is read and before the retry Enter: if it no longer runs the agent
  process the text was typed into (the pane was reused during the wait), neither happens.
  An unsubmitted message is reported on every path that types into a pane: inbound messages,
  deferred (queued) messages, late question answers (button taps and text replies keep their
  claim, so a re-tap never types the answer twice), grant notices, and auto-continue. The
  delivery ledger records it as `unsubmitted` — final, like a delivered message — so a replayed
  update never types it into the same box again, and `tg-ctl audit-delivery` lists it as not
  delivered ("typed into the pane but never submitted"). A deferred message left unsubmitted gets
  that one report, not a second "was not delivered … resend it" notice.
  Every plan typed into a pane — text, a late button tap, auto-continue — takes that pane's turn
  (in the daemon, and across processes via a lock file in `pane-locks/` of the config dir, a dead
  owner's lock broken), so a retry Enter never submits two messages joined in one box.
- **Auto-continue flips the source message to 👀 only when "continue" was actually delivered.**
  A failed or unsubmitted inject leaves it as it was instead of claiming the agent resumed.

## 1.55.2

- **Hatch approval taps that did not take effect now do (#403, #433).** Every way to resolve a
  hatch card was replayed against a real daemon and a fake Bot API that tracks each card's
  buttons, and the failing ones are fixed:
  - A restart of the daemon (deploy, idle exit, crash) while a paneless hatch ask was waiting
    dropped it, so every tap on its card answered "expired". The ask is now persisted and
    restored with its 24h grace record: a tap mints the grant and notifies the agent (an omp;
    a paneless Claude Code / Codex is tmux-only, #456, so its card names the token path). The
    24h count from the restart that ended the wait, not from when the card was posted.
  - At the 12h retention the card lost its Approve/Reject buttons although its text promised a
    tap works until the 24h grace window closes. The buttons now stay, and the tap mints the grant.
  - A text reply ("да", "ok", "нет" …) to a card past its 12h retention now decides it, like a
    tap.
  - A late Deny is final: it retires the grace record, so a raced or repeated Approve on the
    same card can no longer mint a grant (#433 item 1). It stays final across a daemon restart:
    the grant store records the decided card, and the restore skips it even when the
    best-effort questions store still holds it. A Deny after an Approve revokes the grant if
    the agent has not used it yet — also after the 24h grace window closed, since the grant
    lives 24h from the Approve and the card's grace record now lasts as long as that unused
    grant. The agent is told either way, through the same route as a grant notice, instead of
    waiting on an approval that never comes.
  - A live answer on a hatch card is final too: it retires the card's grace record (an ask that
    re-attached after a restart has one), so a raced tap cannot re-open it, and records the
    decided card, so a restart cannot re-open it even when the answer's questions-store write
    was lost. If that cannot be written to the grant store, the answer is refused ("could not
    record the answer — tap again") and the card stays live. A card on disk still marked as
    waiting but posted longer ago than any ask can wait (15 minutes) is such a stale copy and
    gets no fresh grace window. A critical ask waits without limit, so the record of its
    decided card is kept as long as a copy of the card is on disk, not a day.
  - A tap on a card nothing answers for any more (a hatch card whose 24h grace window closed, a
    card whose grant was already used, or any other dead card) removes its buttons along with
    the toast.
  - Grant and deny notices clamp the quoted question without splitting an emoji (#433 item 5).

## 1.55.1

- **The omp-live extension reports the abduco session name from `$RIG_SESSION`** (the `rig harness run`
  contract; `$RIG_OMP_SESSION` is retired), so a pane of a launcher-hosted omp is matched to its
  omp-live host by `rig omp save-panes` (#538). An omp already running keeps its old env and stays
  matched through its abduco ancestry.
- **Reading a host record no longer checks the file by path before reading it** (CodeQL
  `js/file-system-race` in `features/tg-ctl/host-registry-fs.ts`, which had turned the CodeQL
  self-gate red on `main`): the record is opened with `O_NOFOLLOW` and classified through that
  descriptor, so a symlink, FIFO or socket planted in the hosts directory is still rejected as "not a
  regular file".

## 1.55.0

- **Any harness in a rig-wrapper session is reachable outside tmux.** A Claude Code, Codex, opencode
  or omp that `rig harness run <harness> --name <label>` hosts in abduco is registered by the wrapper
  in `~/.config/tg-cli/hosts/<name>.json`; `tg-ctl` trusts a record only while the process table shows
  its abduco server with exactly one harness of the recorded kind under it, and types inbound
  Telegram text into the session's PTY through abduco's client socket (low-priority attach, a
  one-line message typed as is, a multi-line one as a bracketed paste, a gap, a separate Enter). It
  goes through `deliverInboundOnce` with target `host:<name>`, so it is sent exactly once; a
  connection lost after text was written is ledger `uncertain` (never re-sent, the CTO is told).
  `/agent <label|name|project>`, a reply to its message, the sole-agent auto-bind and the picker all
  reach it; a tmux pane that shows the same session keeps priority, and so does omp-live (the PTY is
  an omp's fallback only on a proven-absent endpoint). `tg-ctl status` lists `hosted (abduco, outside
  tmux)`. Spec: `docs/specs/2026-09-30-harness-agnostic-control.md`.
- **`tg` inside a hosted session** reads `$RIG_SESSION`: the record's label is the `[window]` bracket
  outside tmux (resolver tier: host label, then harness title, then cwd project; the title is secondary
  under a label) and `host:<name>` is the route origin, so a CTO reply routes back into the PTY.
- **Hosted-session delivery details.** Two messages for one host are typed one after the other
  (never interleaved). Inbound is deferred while the hosted session has an open question and the
  deferred backlog is flushed through the PTY, not tmux. A PTY write that fails part-way through a
  packet is ledger `uncertain`; a server that stops reading fails the delivery after 5 s instead of
  hanging the daemon; C1 controls (U+0080-009F, incl. the one-character CSI) are stripped from typed
  text. A wrapper-hosted omp is selectable by its wrapper label. The unreachable refusal names
  `rig harness run` only for the four harnesses the wrapper hosts.
- **Refusal text no longer names `claude-rotate`** (retired): an agent outside tmux and outside the
  wrapper is listed as unreachable and `/agent` to it answers with
  `rig harness run <harness> --name <label>` (or a tmux window). The one-time stranded-inbox report and
  AGENTS.md/README/skill/spec no longer call Claude Code and Codex "tmux-only".

## 1.54.33

- **The live e2e harness no longer depends on `claude-rotate` (retired).** The `cc` fixture runs
  the stock `claude` against `~/.claude` (`CLAUDE_CONFIG_DIR` is unset for it, so a run started
  from inside another Claude Code session cannot leak that session's account dir). The
  preflight now checks `claude auth status`: a missing login exits 3 with `claude auth login`,
  an answer it cannot read (old claude, timeout) exits 4 without that advice. The report field
  `claudeAccountForwardsQuestions` is now `claudeForwardsQuestions` and `claudeConfigDir` is
  gone. Comment-only rewording in `omp.ts` / `tg-awareness-nudge.ts`; no runtime change for
  the daemon.

## 1.54.32

- **One coordinator-vs-subagent model (`docs/specs/agent-role-model.md`).** A run is a subagent
  only when a trusted signal says so: the harness's own top-level `agent_id`/`agent_type` on a
  Claude Code / Codex hook payload, an opencode session's `parentID`, or the launcher env
  (`RIG_AGENT_ID=<name>`, `RIG_DETACHED_AGENT=1`; omp sets the former on every task subagent's
  shell and clears it on the main session's). Everything else is the coordinator — there is no
  positive "I am the coordinator" marker to leak into children. New `features/agent-role/` with
  per-harness fixtures (`tests/fixtures/agent-role/`: a live Claude Code subagent capture, omp
  subagent/main bash env, Codex hook schema + recorded rollouts, opencode.db sessions).
- **`tg` labels omp/detached subagents with no flag.** The `[subagent]` bracket precedence is now
  `--subagent` > `TG_AGENT` > `RIG_AGENT_ID` > `RIG_DETACHED_AGENT=1` (→ `[detached]`). Claude
  Code / Codex / opencode in-process subagents share their parent's env, so they still pass
  `--subagent`. A label from the flag, env, hook payload or opencode session is one line of at
  most 80 characters, and `tg --detect-agent` prints `subagent: <label>` when the shell's env
  marks a subagent.
- **`tg-ctl ask` cards name the real subagent.** `ButtonRequest.subagent` comes from the hook
  payload's top-level `agent_id` first (label `<agent_type>#<last 8 id chars>`), then the hook process
  env. The `features/agent-detect/` auto-detection is deleted: `tg-ctl ask` still ran it, and
  `CLAUDE_CODE_CHILD_SESSION=1` is set on the Claude Code MAIN thread too, so every permission
  card, coordinator's included, was labelled `subagent=subagent`. The opencode adapter takes the
  session record (`opencodeEventToButtonRequest(event, session)`) and labels a child session's ask;
  the daemon has no opencode SSE subscriber yet (tg-cli#533), so that path is adapter-only.

## 1.54.31

- **Claude Code and Codex are tmux-only (#456).** `/agent <name> <text>` (or a bare
  `/agent <name>`) to a Claude Code / Codex session running outside tmux gets a one-line
  refusal naming how to start it in tmux — `claude-rotate --tmux <name>`, or
  `tmux new-window -n <name> codex` — and nothing is queued. The Stop-hook inbox that used to
  take such messages delivered only at the agent's next turn end, so an idle session never
  got them. A belated hatch approval for a Claude Code / Codex ask with no tmux pane is not
  queued either; the card names the token path. omp outside tmux is unchanged (omp-live, with
  its grant-notice inbox fallback). `tg-ctl status` and the no-agent reply list agents outside
  tmux with the restart hint instead of a queue count; `tg-ctl inbox queue` is gone and
  `tg-ctl inbox` shows omp's pending grant notices and the archive.
- **The stranded inbox is reported once and archived.** On its first poll the daemon moves
  every leftover `inbox/<key>/pending.jsonl` entry to `stranded-<stamp>.jsonl` — except an
  omp grant notice whose grant is still live, which stays pending for the omp hook — lists
  those messages in one Telegram message (oldest first, key and preview each; unreadable lines
  are counted, not dropped), and writes `inbox-stranded-report.json` so a restart does not
  repeat it (only a kill between the send and that write lists them again — a duplicate,
  never a loss). A transient send failure (network, 429, 5xx) keeps the built report and the
  next poll retries only the send; the inbox is not swept again. Telegram rejecting the
  report (4xx) is final and logged; the archive keeps every message. A key whose backlog could not be claimed or archived keeps
  it (`pending.jsonl` or `claim-sweep-*.jsonl`) and the marker records an incomplete sweep
  and the archives already reported, so the next start sweeps again and reports only what
  was not listed yet — without duplicating what a crashed sweep had already archived or put
  back.

## 1.54.28

- **Inbound Telegram messages reach an agent exactly once (#517, #299).** Root cause of the 7x copy of
  tg#17641 in one omp session (2026-09-21): the since-removed ACP watchdog (#352/#359, removed by
  #451) evicted a "wedged" `omp acp` client after 120 s without traffic and re-sent its in-flight
  prompt through a fresh `session/load` — six times while the machine's network was down. The
  replay paths that remained could still repeat a message: Telegram redelivering an update after a
  lost offset write, the pending-batch journal replayed after a kill, a deferred backlog restored
  after a SIGKILL mid-flush, an omp restarted between two sends. Now every sink (the omp-live
  bridge, tmux send-keys, the Stop-hook inbox) consults a durable ledger keyed by
  (chat_id, message_id) — `tg-ctl.<bot>.delivery.jsonl`, append-only and fsynced: a claim before
  the send, the outcome after. A delivered message is never sent again; an update already
  processed is skipped whole; a claim a kill left without an outcome is reported to the CTO
  ("may not have reached …"), never re-typed.
  A message whose claim cannot be written to the ledger (full or read-only disk) is not sent and
  is reported like any failed delivery.
- **Only the configured chat is served (#517).** A message from any chat other than `TG_CHAT_ID`
  is ignored, even from an allowed sender: Telegram message ids are unique per chat, so another
  chat's message 42 would collide in the ledger with this chat's message 42, and every reply and
  reaction already went to `TG_CHAT_ID`.
- **Undeliverable messages are reported, not dropped (#517).** A deferred message the flush cannot
  type, a picker nobody tapped within 10 minutes, and a picker the daemon lost on restart each get
  a "⚠️ tg#N was not delivered …" reply under the CTO's message.
- **`tg-ctl audit-delivery` (#517).** Read-only report over the whole retained history: messages
  delivered, not delivered (a failure the ledger recorded), sent per the daemon log but with no
  transcript left, and with no evidence left either way (no ledger record, transcript pruned — not
  counted as lost); messages typed more than once into one session; held messages; update-id gaps,
  with dates. Reads omp, Claude Code (including prompts queued while the agent was busy) and Codex
  transcripts. `--since/--until`, `--json`, `--transcripts`, `--history`, `--log`.

## 1.54.27

- **Reply quotes are never empty (#461).** A reply to an agent's rich report (anything `tg
  --format html` sent through `sendRichMessage` — lists, tables, headings) reached the agent as
  `↩ tg#17821 «[2026-09-24 19:46] …»`: Telegram carries such a message's content in
  `rich_message.blocks` with no `text`, and the anchor read only `text`/`caption`. All 30 empty
  previews logged 09-18..09-25 were rich reports. The anchor now quotes the flattened rich text
  (paragraphs, headings, list items, table cells, details, captions in reading order); a
  captionless photo/file/voice/sticker quotes a label (`«[date] [document report.pdf]»`); with
  nothing quotable the anchor is only `↩ tg#<id>`. New pure `features/tg-ctl/reply-preview.ts`.
- **Unanswered-question reminder (#464).** A question/permission card still open 20 min after it
  opened (`TG_CTL_UNANSWERED_REMINDER_AFTER_MS`, `0` = off; below the 30-min question retention)
  gets ONE reminder, a plain message listing every card still waiting — session, question head,
  `tg#<card id>`, age. A later reminder (another question crossing the threshold) deletes the
  previous one (edit-to-placeholder if the delete is refused), so reminders never stack; once no
  listed card is still open (answered or expired) the reminder is withdrawn. Quiet hours are #403's (`TG_CTL_QUIET_HOURS_*`,
  default 23:00-08:00): a night-time question is reminded once, right after they end. Critical hatch
  requests are excluded — #403 already reminds them. State (first-seen time per open card, reminded
  cards, the live reminder's id) persists in `tg-ctl.<bot>.unanswered-reminder.json`, so neither a
  restart nor a card's hook disconnect/re-attach restarts its clock or re-reminds. The #403 and #464
  sweeps share one `retireReminderMessage` helper. New pure `features/tg-ctl/unanswered-reminder.ts`.

## 1.54.23

**`tg-ctl status` says why an omp has no bridge: started before the bridge code, or a real failure (#458).**

- Each omp in the "omp without bridge" block now compares its process start with when the
  installed bridge last changed: the managed `~/.omp/agent/extensions/tg-omp-live.ts` loader and
  the files it imports. OMP binds an extension once per process and reuses it for every
  in-process subagent, and 18.3 cannot reload JS extensions, so an omp started before a bridge
  fix (or before the loader was installed) keeps what it loaded (before #483 the bridge dropped
  its endpoint at the first subagent spawn) until it is saved/stopped and resumed once. An omp
  started after that and still unbridged is flagged as a bridge failure with its log path.

## 1.54.22

**CI flakes that blocked every merge (#494), and the double spawn behind one of them.**

- Private-topic `/new` no longer spawns twice after a daemon crash. A crash mid-spawn left the
  `/new` in the pending-batch journal; after restart, reconcile adopted the orphan agent and the
  replay then created a second topic and a second agent. The topic binding now records the
  `/new`'s chat + message id (`sourceChatId` / `sourceMessageId` in `tg-ctl.<bot>.topics.json`,
  written before `new-window`), and a replay matching both is skipped with a "recovered after a
  daemon restart" reply where the `/new`'s replies go. Not covered yet (#500): a crash between topic
  creation and the first binding write, and the flat fallback spawn.

Test fixes:

- `ctl-private-topics-integration`: the crash-after-new-window case waits for the crashed
  daemon to exit instead of sleeping 150ms and killing it, then for the restarted daemon's
  adoption log and the pending-batch journal unlink (the end of replay) before asserting. Its
  `waitFor` throws with the daemon log on timeout instead of falling through. The file's daemon
  scenarios get a 30s budget — bun's 5s default was shorter than their own 8s lifecycle waits.
- `ctl-question-durable-integration`: the reconnect case with no `promptTurnId` waits for the
  restoring edit itself; the reattach log line can land before that edit is sent.
- `ctl-question-durable-integration` RECONNECT: waits for the pending question to be persisted
  before SIGKILLing the daemon. The mock records the card when the send arrives; the daemon
  persists only after the response returns, so a kill in between left nothing to restore and the
  restart never logged `questions restored` (#506).
- `ctl-omp-acp-integration`: the name-selector case awaits the original host's input callback
  and the `ReviewFix` confirmation `sendMessage` as events. The daemon posts that confirmation
  after delivering, so checking sent messages the moment the input landed read `undefined`.
- `ctl-daemon-integration` round-trip: `launchctl` is shimmed (the `/status` reply no longer
  probes every host launchd job) and the event wait is bounded by 45s instead of 10s.
- `ctl-service-cli`: `status` runs against shimmed `launchctl` / `tmux` / `ps`, not the
  developer's machine — the host scan made it outlast the 5s test timeout. The file's tests
  get a 20s budget: a hermetic `status` still takes ~2s per bun process under load.
- `deploy`, `ctl-service-cli`, `ctl-status-liveness-integration`: every `Bun.spawnSync` has a
  30s deadline (`tests/helpers/spawn-sync.ts`); a hung child is SIGKILLed and fails its test
  instead of stalling the CI job until the job limit.
- Daemons started through `spawnDaemon` lead their own process group; teardown SIGKILLs the
  group, so children a daemon forked no longer outlive it.
- CI runs `bun test` through `ci/test/bun-test-watchdog.sh` (#506): when the output stops for
  180s (`BUN_TEST_STALL_SECS`), the step fails naming the test file it hung in, with the process
  table, instead of idling silently until the runner kills the job. The job also has a 30-minute
  `timeout-minutes`.

## 1.54.16

- **Forum topics: a topic reaches its session through the flat delivery path (#465).** A message in
  a session's topic — text, a voice note (transcribed), a photo or a file — goes to the registry
  session that owns the topic, wherever it runs now (a resumed omp under its new pid, a moved
  session in its new pane), through the same path as the flat chat: the omp-live bridge, the omp's
  own tmux pane when it has no bridge, cc/codex send-keys. A pane that hosts a different session
  now is refused (§2.6). The registry, not a topics.json pane binding, decides: a live session's
  topic is never held behind the attach picker nor answered "not running" because its binding went
  stale, and a gone session's topic answers with its harness's resume hint. The attach picker
  delivers by session too and makes the picked topic the session's registry topic.
- **Forum topics: renaming a session renames its topic (#466).** A committed rename (tmux window
  or harness title, stable for 20 s) retitles the session's topic via `editForumTopic`
  (`<name> · <title>`), at most once a minute per topic with the latest name winning; nothing is
  sent for an unchanged title. A topic renamed in Telegram — including the echo of this edit — is
  only logged: it never renames a tmux window or the session, so there is no rename loop.

## 1.54.14

- **Forum topics: one bot-created topic per session (#467).** With `control.topics` (or
  `private_topics`) on, a registry session gets its own topic on its first outbound — a `tg` send
  or a question/permission card — so idle sessions open none. The daemon is the only caller of
  `createForumTopic`; the topic is stored as the session's `threadId` and bound in topics.json, so
  replies in it route back to the session. A topic already bound to the session's pane is adopted
  instead. `tg` needs no `--topic`/`TG_TOPIC`: with neither (and no `--reply-to`) it asks the
  daemon over the hook socket which session it runs in and posts into that topic. A resumed or
  restarted session keeps its topic and posts "📂 name — reattached" there. A topic that rejects a
  post (fresh private topic, closed, deleted) gets one retry after 1 s, then the post goes to
  General with a notice; a deleted topic (or one that keeps failing for 10 min) is recreated on the
  next outbound, at most once per 24 h. The General fallback now also covers photos, documents and
  albums, not just text.

## 1.54.13

- **Forum topics: inbound triage replaces the spawn wizard (#457).** Creating a topic no longer
  starts the path → model → spawn flow; `forum_topic_created` / `_edited` / `_closed` /
  `_reopened` are only logged. A message in an unknown topic (user-created, implicit, or a lost
  binding) is held and answered with an attach picker of live sessions (most recent first); a pick
  delivers the held text, photos, files and voice notes in order, exactly once, and binds the topic
  (renamed via `editForumTopic`) or links the session's existing topic. Holds persist in
  `tg-ctl.<bot>.topic-holds.json`, survive a restart, and expire after 10 min with an "N messages
  not delivered" reply. At most 200 topics are held at once: a new one evicts the oldest hold,
  which gets the same reply. With no session running, the "start one" notice is posted once per
  hold, not per message. A `/new` topic whose spawn failed or never finished becomes unknown again
  (its next message gets the attach picker). Daemon verbs (`/status`, `/agent`, …) answer in any
  topic; a gone session answers "not running — resume with …" (the harness's own resume command;
  a harness without one gets a generic hint); bound-topic media is delivered instead of silently
  acked. No topic message is dropped without a reply.

## 1.54.11

**Debounced rename in place; `tg replies` keyed by session; locked history writes (#460, #136).**

- A session rename (tmux window rename, omp `/rename`, harness title change) updates the SAME
  registry entry once the new name has been stable for 20 s: a flip-flop inside the window
  commits nothing, the old primary becomes the newest alias (max 5), and a `renamed` event is
  logged. The daemon runs the committing scan on its first poll tick after the debounce ends. Nothing re-keys.
- The omp-live extension reports the session's current name (`getSessionName()`) at status
  time instead of the header title, so `/rename` reaches the registry without a republish.
- `/agent <oldname>` still reaches a renamed session through its aliases, unless a window now
  carries that name exactly.
- History rows carry `sessionKey` plus the name snapshot. Out-of-tmux omp sends are now tagged
  too. `tg replies` defaults to the caller's registry session (agent pid, then pane / `omp:<pid>`),
  across renames and panes; `--agent <name>` expands through current names and aliases; rows
  written before the key existed join a session through its name or aliases; every row of a
  known session is marked with its current name; `--json` adds `sessionKey`.
- `tg` and the daemon append to `history.jsonl` under a shared O_EXCL lockfile (the routes.json
  protocol), so concurrent writers no longer lose each other's rows (#136).

## 1.54.10

**Routes, registrations and late answers follow the session, not the pane or pid (#459, #354, #100).**

- `tg` writes the sending session's registry key (`<harness>:<sessionId>`) on each reply route,
  together with exact locators: the agent pid and, in tmux, the tmux server pid and pane pid. A
  route written before the daemon scanned the session is stamped by the next registry scan, but
  only from those exact locators. A tmux origin needs the full pane triple and, when recorded,
  the same agent pid, so a reused pid in another pane never claims it.
- A reply follows the route's session through a fresh registry scan to its current pane or pid,
  so replying to a message sent before `omp --resume` reaches the resumed omp. A gone or unknown
  session, a legacy route without a key, or an unkeyed route whose exact origin has left the
  registry gets the agent picker with a named notice; the same-project guess is no longer used
  for a route that carries a session identity.
- Pane registrations and the last-user target resolve through the registry the same way: a
  keyed row follows its session, and a gone session never falls back to its old pane. The
  last-user anchor skips its cwd check only on a registry the daemon has scanned itself, not the
  persisted file read before its first scan.
- Pane-reuse guard: before typing into a pane on a session's behalf, the daemon re-scans and
  refuses unless the pane still hosts that session, replying "<name> is no longer in pane %N (now
  <other>)". A scan shared inside the 2 s refresh window is redone when the pane now holds a
  different process. Queued (deferred) messages persist their target session in
  `deferred.json`, and a flush into a pane that changed hands posts the refusal and a picker.
- Each ask is stamped with its session key on arrival (the hook's `session_id`, else the pane's
  occupant). A late button tap, a permission digit, a reply after the question timed out and the
  grant-notice pane route all check it before typing.
- The awareness nudge keys its state by `omp:<sessionId>` when omp has published one, so a resume
  into another pane keeps its silence clock. Existing pane-keyed rows for the same session carry
  over.

## 1.54.6

**Session registry keyed by harness session id, plus the one-shot store migration (#487).**

- The daemon keeps `tg-ctl.<bot>.sessions.json`: one entry per omp/cc/codex session, keyed
  `<harness>:<sessionId>`. A pid, a tmux pane `(serverPid, paneId, panePid)` and an abduco name
  are locators, re-resolved on each registry scan; they are never identity. The scan runs off
  the poll hot path: at most every 30 s (sooner after a cc/codex hook sighting), deferred behind
  the long-poll, one at a time, reusing the tick's cached discovery instead of its own
  `ps`/`lsof`. Every tmux omp/cc/codex session and every out-of-tmux omp gets one entry. An
  abduco-wrapped omp carries both its tmux pane and its `durableSession`. Entries that leave the
  scan turn `gone`, are re-adopted when
  the same session resumes, and are pruned after 30 days. An untrusted snapshot (empty `ps`,
  unreadable tmux server pid, or an empty pane list while a registered process is alive) is
  skipped, so a launchd flake never marks sessions gone. The tmux server pid is read on both
  sides of the pane snapshot it belongs to; a server restart in between makes the scan untrusted.
- cc/codex asks now carry the hook's `session_id` as `origin.sessionId`. The hook socket
  records pane → session id, so a cc/codex pane's provisional `pane:` key is promoted to its
  session key in place, and every store row that referenced the provisional key is rewritten.
- One-shot, idempotent migration after the first trusted scan, with one marker per store:
  `routes.json`, `registration.json` and `last-user-target.json` rows that resolve to exactly
  one live entry (with a matching cwd) gain `sessionKey`, and `paneId` stays as a hint.
  Unresolved routes become `legacy` and are dropped 7 days later. Unresolved registrations and
  last-user targets are dropped only when their pane is dead; a live pane keeps its row even
  when its cwd drifted. With no tmux server running the migration still completes, dropping
  nothing; an empty pane list from a live server (the launchd flake) waits for a later scan.
  Bound `topics.json` rows set the entry's `threadId`. No consumer reads the keys yet; that
  starts in S2.
- `sessionKey` survives the live writers: `tg start` re-registering the same pane and cwd keeps
  the row's key, and a confirmed delivery writes the anchor with the registry's key for that
  pane (or keeps the anchor's key for the same pane and cwd). Every later trusted scan
  re-derives a registration or last-user-target key that is missing or names no live session.
- An omp is keyed by its session id even when it holds its main session jsonl closed (omp
  opens it only to write). Its open subagent transcripts (`…/<ts>_<sessionId>/<agent>.jsonl`)
  name the parent session (used only if that file exists); transcripts of two different
  sessions resolve nothing. With no jsonl open at all, omp's own terminal breadcrumb
  (`~/.omp/agent/terminal-sessions/<tty>`, or `tmux-%N` without a tty) supplies the session
  file when its cwd is the process's cwd, a relative file resolved against that cwd.
  A provisional `omp:pane:…` entry is promoted in place once the id resolves.
- `sessions.json` is on the auto-attach never-attach list, like `routes.json`.

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
