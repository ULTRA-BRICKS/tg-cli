# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.74.0

- **Laya can be pinned in config (#830).** `laya.socket: /abs/path.sock` (env `TG_LAYA_SOCKET` wins) durably pins a private external classify socket; it is never autostarted, and an unreachable one is a typed unavailable reason naming the pinned path.
- **A configurable ctl server for a second machine (#831).** `control.server: ssh://<ssh_config alias>` +
  `control.machine: <name>` (client) and `control.remote_machines: "name=user@host"` (the machine that runs
  `tg-ctl`). A client keeps its local pipeline (local attachments, direct Bot API post) and records every send
  (machine-qualified route and history) on the server over a fixed SSH stdio RPC; a Telegram reply to such a
  message is typed by the daemon into that exact session on that machine (never into a local process with the
  same pane id or pid), at most once: a lost link after the request was written is recorded `uncertain` and
  never re-sent. The RPC is the new stdlib-only Python package `tgcli.remote`, launcher `tg-remote` (`config
  check`, `client record|hello|status|flush`, `doctor`, `server --peer`, `satellite serve`, `hub hello|deliver`),
  always run as `python3 -I`. A client never polls Telegram: `tg-ctl run|start|restart|enable` exit 78 and the
  lazy autostart is off; an invalid remote key exits 78 for `tg` (also `--dry-run`), `tg-ctl` and `tg config
  validate`, never a silent local fallback. While `remote_machines` is set an unrecognised reply is never
  auto-injected into the single local agent. `tg-ctl status` shows server, transport and real link health on
  both sides. Not supported in this version (refused explicitly): session topics and question/permission
  cards for client sessions, `tg-ctl ask|withdraw|alert|inbox|audit-delivery|harness-event` on a client, inbound
  media to a client session, outbox replay on a client. Design: `docs/specs/2026-10-28-remote-ctl-server.md`.
- **Laya starts itself and never goes missing silently (#830).** When no classify server answers, `tg` runs
  `task classify-server start` once (own process group, sanitized env, bounded by `laya.cold_timeout_sec`,
  default 75 s; measured cold start 6.4 s on a CPU host), checks that the printed socket sits in a private
  directory you own, and asks with `laya.warm_timeout_ms` (default 3000 ms, was 1200 ms for the ask check;
  measured warm calls 31-64 ms fast host, 267-1395 ms CPU host). A failed start is remembered in
  `~/.local/state/tg-cli/laya-autostart.json` and not retried for 300 s; concurrent senders start one server.
  `--dry-run` never spawns, connects or loads anything. To start Laya by hand: `task classify-server start`.
- **Every "no answer" has a typed reason, also on the ask path.** `disabled`, `invalid-config`, `no-socket`,
  `no-task`, `untrusted-socket`, `autostart-failed`, `autostart-skipped`, `cold-timeout`, `timeout`,
  `connection-error`, `invalid-response`, `payload-too-large`, `helper-failed`, `helper-timeout`; the hint names
  the reason, what was tried and the next step. The ask check used to return nothing without a word.
- **`laya.required: true` (or `TG_LAYA_REQUIRED=1`) fails the send before any Bot API request** (exit 1) when Laya
  was consulted and is unavailable for any reason: `tg: Laya is required (laya.required: true) but unavailable:
  <reason>. Tried: <attempt>. Next: <remedy>.` It is also enforced when the Python caller itself cannot run.
- **New `laya:` config block** (`enabled`, `autostart`, `required`, `cold_timeout_sec`, `warm_timeout_ms`,
  `task_bin`) with env overrides `TG_LAYA`, `TG_LAYA_AUTOSTART`, `TG_LAYA_REQUIRED`, `TG_LAYA_TIMEOUT_MS`,
  `TG_LAYA_COLD_TIMEOUT_SEC`, `TG_LAYA_SOCKET` (still wins and is never autostarted). Validation is strict: an
  unknown key, non-boolean, non-positive timeout, relative `task_bin`, or `required: true` with Laya disabled
  exits 78 where Laya is consulted and is listed by `tg config validate`. `config.schema.json`,
  `docs/configuration.md` and `tg help config` describe it.
- **The Laya caller is Python** (`src/tgcli/laya`, stdlib only, started as `python3 -I <repo>/tg-laya` with a
  sanitized environment so nothing in the cwd or `PYTHON*` can shadow it); the TypeScript socket client is gone.
  The test suite sets `TG_LAYA=0` for every child process so a stray consult can never autostart a model.

## 1.73.1

- **/chatgpt, /spend and /daily find `pm` / `rig` from the daemon environment (#804).** The daemon looks for the
  two CLIs by absolute path in its own `PATH`, then `~/.local/bin`, `~/.files/bin`, `/opt/homebrew/bin` and
  `/usr/local/bin`, on every command (a tool installed or repaired while the daemon runs works on the next
  command, no restart), and runs them with those directories appended to the child `PATH`. A tool that cannot
  be run now yields a Telegram reply naming the feature and the class of problem (not found / found but not
  startable) with the `tg-ctl restart --if-stale` hint, instead of `spawn rig failed` / `could not start pm`.
  Not included: the one-button Install/Repair action (#803), pinning `PATH` in the autostart unit (#767) and
  a real macOS launchd host proof.

## 1.73.0

- **Problem reports state actual actions and results (tg-cli#800, subset).** Every explicit
  `tg --tag problem` body — including `--automated`, stdin and the Python facade, which runs this
  sender — must describe a concrete action already performed with its observed result and the
  recovery step being attempted now (or an exact hard dependency plus the check to run when it
  clears). Headings alone, passive monitoring, future-only promises and quoted examples are
  rejected before the Bot API; a request to the human is no longer required. The warm local Laya
  classifier (existing `TG_LAYA*` settings) is asked separately for completed action and current
  recovery: a confident negative blocks, middling or positive scores never clear a deterministic
  failure, and an unavailable classifier is reported while the deterministic check still decides.
  `--dry-run` never contacts Laya. `tg-ctl alert send` routes raw warning/critical signals without
  that evidence to the exclusive source holder (or subscribers) as internal incidents with durable,
  uncertainty-aware receipts instead of posting them to Telegram. Untagged bodies (apart from
  the shared problem layout check, which now requires these facts instead of an explicit
  request to the human), per-item classification, metrics and the justified override of #800
  are not part of this change; see `docs/problem-reports.md`.
  The offline check treats a line break or `<br>` inside one sentence as a wrap (so "I am not
  <br>checking" is still a negation, while independent lines never share one), ignores result
  words inside code literals and file names (`output.log`, `result.json`) when locating the
  observed result, and accepts the Russian recovery verbs «чиню/чиним».
  A short report is enough: one named object plus an observed result («Перезапустил браузер;
  результат: вкладка не появилась», "Restarted Chrome; result: the tab is still missing", `exit 1`,
  `unknown host`) satisfies the action requirement, while filler targets and deferred results
  ("unknown.", "will know later") still do not. Validation time is now linear in the body size (a
  24 KiB body of repeated actions took 83 s before; it takes milliseconds). `classifyIntent`, the evidence
  extractor and the `tg`/`tg-ctl` entrypoints are split into small modules (`features/cli/
  outbound-runtime/`, `features/cli/args-*.ts`, `features/tg-ctl/alert-remediation/`; older
  changelog sections moved verbatim to `docs/changelog/`) so the changed runtime modules meet
  the strict complexity and file-size limits.

## 1.72.1

- Add complete call integration, regression and mutation verification with JSON/JUnit evidence (#761).
- Verify installed state through read-only commands and repair the hash-locked call runtime constraint.
  Live provider playback, calls and two-way conversation remain unverified.
- Align the Python package metadata (`pyproject.toml`, `uv.lock`) with the 1.72.1 release, as
  `tests/py/test_version.py` requires, and fix the `tg-impl` test fixture so a releasing lock owner
  publishes `-1` before unlocking instead of overwriting its successor's ready marker.

## 1.72.0

- **Configuration schema, help and `tg config validate` (#809).** `tg help config` (also
  `tg config help|--help|-h`) lists all 28 settings with type, default and behavior, generated with
  `config.schema.json` and `docs/configuration.md` from one registry (`bun run schema:gen`,
  `schema:check` in CI). Normal config reads and writes keep a sibling `config.schema.json` and the
  yaml-language-server modeline. `control.enabled` semantics and the `TG_CTL_CONFIG_DIR` handling
  are corrected. New read-only `tg config validate` reports unknown keys, values the runtime would
  silently ignore or heal, and YAML the one-level readers skip, with line numbers (exit 1 on
  errors; legacy yes/no forms are warnings), then runs `Bun.YAML.parse` (Bun 1.2.21+) as a final
  syntax check. Python defaults are tested for parity with the schema.

## 1.71.4

- **Per-entrypoint Python implementation switch (#768).** Added executable shims for `tg`,
  `tg-ctl` and `call-cli`, plus `tg-impl` to inspect selections and perform parity-gated switches
  and rollback. Verification preserves stopped daemons, validates service targets and proves
  daemon flock ownership before signaling or accepting a successor. The standalone switch
  remains usable when the project venv is broken, with Python 3.9 compatibility checked in CI.
  Installer/caller wiring and production selection remain separate migration tasks.

## 1.71.3

- **Python render layer (#768).** Added HTML and emoji-entity helpers, rich-message validation,
  table rendering, tag badges, branded prefixes and terminal help coloring for the Python port.
  Preserved UTF-16 entity offsets, JavaScript number diagnostics and the formatting reference;
  prefix fallbacks use the canonical Bun Unicode letter set across supported Python versions.
  These pure modules prepare the sender migration; existing entrypoints continue using TypeScript.

## 1.71.2

- **Python shared config primitives (#768).** Ported environment/config parsing, bot-scoped
  state paths, feature flags, send receipts and shared text helpers for the Python migration.
  Preserved JavaScript Unicode whitespace, binary64 number conversion and nullish defaults,
  with focused parity tests and a TypeScript-captured path fixture. These modules prepare
  later Python send/daemon tasks; the active command entrypoints continue using TypeScript.

## 1.71.1

- **Python port skeleton (#768).** Added the `tg-cli` Python package and facade with
  TypeScript fall-through, JS-compatible JSON, atomic file writes and UTF-16 slicing.
  Moved the unchanged `tg-call-lib` distribution metadata into the `features` uv workspace
  member, and added locked dependencies and Python CI checks. Existing entrypoints keep
  running TypeScript until a later migration task installs and selects the switch shims.

- **Dependency security refresh.** Lock certifi 2026.10.19, filelock 4.2.1 and setuptools
  84.1.0; refresh the matching hashed sender and voice requirements.

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

## Earlier releases

- [1.54.16 through 1.44.3](docs/changelog/1.54.16-to-1.44.3.md)
- [1.44.2 through 1.25.0](docs/changelog/1.44.2-to-1.25.0.md)
- [1.24.0 through 1.0.0](docs/changelog/1.24.0-to-1.0.0.md)
