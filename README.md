# tg — Telegram bridge for AI coding agents

The best way to monitor several coding agents at once: they push only what matters — status updates, blockers, a question — and you reply from your phone. Agent questions and permission prompts arrive as **tappable inline buttons**; no terminal round-trip needed.

Works with any agent in tmux: Claude Code, Codex, opencode, aider, and more. omp also works outside tmux (omp-live); every other agent started outside tmux is listed as unreachable, with how to restart it inside tmux.

## What it looks like

**An agent finishes a task:**
```bash
tg --format html "<b>HYP-576 done</b>\nAll tests pass. PR #42 opened."
# → Telegram message with ticket title inlined, PR linked, agent emoji prefix
```

**An agent asks a question — arrives as buttons:**
```
[Claude 🤖] Should I delete the old migration files?
  [Yes, delete]  [No, keep them]
```
Tap a button. The answer injects directly into the agent's tmux pane.

**An agent sends a generated artifact:**
```bash
tg --file report.md "Weekly summary"
# .md files are auto-converted to PDF before upload
```

---

## Install

Pick one — each ends with `tg` (and `tg-ctl`) on your PATH. Needs [Bun](https://bun.sh);
macOS and Linux.

```bash
# 1. one-liner — clones to ~/.local/share/tg-cli, installs deps via bun, links tg into ~/.local/bin, registers the agent skill
curl -fsSL https://git.hyperide.ai/ultrabricks/tg-cli/raw/branch/main/install.sh | bash

# 2. from a clone — to hack on it; `git pull` updates the installed tool
git clone https://git.hyperide.ai/ultrabricks/tg-cli && cd tg-cli && ./install.sh
```

- **Update:** re-run the one-liner · `git pull` (see *Update / deploy a merged change* below).
- **Via rig:** list `tg` under `tools.items` (with `repo:` pointing at your clone) in
  `~/.config/rig/config.yaml` — `rig apply commit` runs its `install.sh` and keeps the clone fresh.
- **No uv / pipx:** `tg` is a Bun script, not a Python package. **Windows:** the `#!/usr/bin/env bun`
  entry doesn't run from Cygwin / Git Bash yet.

> The canonical repo is **git.hyperide.ai/ultrabricks/tg-cli**; `github.com/alex-mextner/tg-cli` is a
> frozen, archived mirror.

**Register the skill manually** (idempotent; run automatically by the installer):
```bash
tg install-skill
```

`tg install-skill` makes agent harnesses aware of `tg`. It writes a skill file to
`~/.agents/skills/tg/` and, **for each detected harness**, appends a short always-on
blurb to its global instruction file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.config/opencode/AGENTS.md`, `~/.gemini/GEMINI.md`) and adds a Claude Code
`SessionStart` hook that surfaces installed agent CLIs at session start. All edits are
marked and idempotent — safe to re-run, and trivial to remove (delete the marked
blocks). Run automatically by the installer.

> Notes: the `SessionStart` hook prints the contents of `~/.agents/skills/.blurbs/*.md`
> into each session, so treat that directory as trusted (only the installers write there).
> `install-skill` is an exact-match subcommand — to send the literal text `install-skill`
> as a message, pipe it (`echo install-skill | tg -`) or add any other token.

**Requirements:** [Bun](https://bun.sh)

**Connect to Telegram** — one command:
```bash
tg auth                 # paste the token from @BotFather, then tap Start in Telegram
tg auth status          # which bot sends, to which chat — plus your user/caller accounts
```
`tg auth` validates the token, prints a one-time `https://t.me/<bot>?start=…` link, and
once you tap **Start** writes `TG_BOT_TOKEN` and `TG_CHAT_ID` to `~/.config/tg-cli/.env`
(0600; `$TG_CTL_CONFIG_DIR/.env` when set) — no chat-id lookup. Non-interactive:
`tg auth login --token <token>` (or `--token -` from stdin). A running `tg-ctl` reads the
Start tap itself and switches to the bound chat without a restart. `tg auth logout`
removes the two keys. A `tg` send without them exits `78` and points at `tg auth`.
Details and exit codes: `tg help auth`, [docs/specs/tg-auth.md](docs/specs/tg-auth.md).

### Update / deploy a merged change

`tg` is a committed Bun script run directly via the symlink (`tg` → `<checkout>/tg`),
so the checked-out file **is** the running binary — there is no build step. Deploying a
merged change is a fast-forward `git pull` in the checkout the symlink points at:
```bash
scripts/deploy.sh                    # update the checkout the `tg` on PATH points at
scripts/deploy.sh --dry-run          # show what would land, change nothing (always safe)
scripts/deploy.sh --checkout DIR     # update a specific checkout
scripts/deploy.sh --no-restart-ctl   # update, but leave a stale tg-ctl daemon running
```
When up to date nothing is pulled; otherwise it advances the checkout's `HEAD` to
`origin/<branch>`. It refuses to pull over tracked local changes (untracked files such
as a stray `node_modules` do not block it — though `git`'s own fast-forward will still
abort if an incoming path collides with an untracked file) and refuses a
non-fast-forward divergence. `tg` itself needs no restart — the next invocation reads
the new file. Exit codes: `0` deployed (or up to date), `1` usage/environment error,
`2` non-fast-forward (needs a human), `3` the tg-ctl restart failed.

> **`tg-ctl` daemon:** the inbound control daemon (`tg-ctl run`) loads its code into
> memory at start and records which commit that was, so a merged fix only runs once it
> restarts. Every deploy — including one that finds the checkout already up to date —
> ends with `tg-ctl restart --if-stale`: a graceful reload (queued messages, questions and
> pane registrations are on disk and survive) only when the daemon's loaded code differs
> from the checkout in daemon files; under launchd it comes back under the same job. It
> exits non-zero unless the old process is gone and a successor holds the lock.
> `tg-ctl status` shows the loaded commit on its `code:` line (`STALE` when a restart is
> due). A plain `curl … | install.sh` re-run also refreshes a clone (it does
> `git pull --ff-only`), but does not handle the daemon.

---

## Outbound — agents push to Telegram

### Text and HTML reports

```bash
# Plain text (auto-detects agent, adds branded emoji prefix)
tg "Build finished, 0 errors"

# HTML — use Telegram's supported tag subset
tg --format html "<b>Status</b>\nAll checks green."

# HTML auto-detected when tags are present — --format html is optional
tg "<b>Important</b>: migration complete"
```

### Files, photos, and PDFs

```bash
tg --photo screenshot.png "Looks good"
tg --photo before.png --photo after.png "Comparison"
tg --file report.md "Weekly summary"    # .md auto-converted to PDF
tg --file data.csv --file chart.png "Results"
```

Markdown files (`*.md`, `*.markdown`) are silently converted to PDF via pandoc + headless Chrome before upload. On conversion failure the original file is sent instead — the send is never blocked. Requires `pandoc` and Chrome/Chromium 112+. Disable with `--no-feature md-as-pdf`.

### Only explicit flags attach files

Only `--file` and `--photo` attach a file from disk. A path written in the message text (`tg "see AGENTS.md"`) stays plain text and is never attached, even when the file exists — naming a file in a report must not upload it (tg-cli#648). To quote lines of a file, attach it and name the range: `tg --file src/a.ts "bug at src/a.ts:42"` shows those lines inline below the mention. (A fenced code block over 1024 characters pasted into the message itself is still sent as a fragment document.)

An attached file that goes missing, gets truncated to empty, or loses read permission between parsing and send is skipped with a stderr warning naming the path and the reason — it never fails the whole send (tg-cli#207).

### Message-flood cap

A message long enough that Telegram's 4096-char limit would fragment it into more than 6 separate sends is refused up front, with a local error naming the exact character count and how many messages it would have produced — instead of silently flooding the recipient with dozens of fragments. Override with `--no-feature flood-cap` (tg-cli#208). Rich messages (`--format html` bodies using table/heading/list/formula tags) are unaffected — they always send whole.

### Secret-file denylist

Secret-looking files are **never** attached: `.env` family, SSH private keys, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.ppk`, credential rc-files (`.netrc`, `.npmrc`, `.git-credentials`, …), shell histories, `*.tfvars`, `credentials.json`/`client_secret*.json`, `kubeconfig`. An explicit `--file prod.env` is a hard error. Override: `--no-feature attach-denylist`.

### Garbled-token guard (`cjk-guard`)

One feature catches two "a garbled token slipped into the message" shapes on the final caption and `--title`, both a **hard error** before send. Override either with `--no-feature cjk-guard`.

**Stray CJK.** A message whose dominant script is Latin/Cyrillic but that carries a **lone** CJK / ideographic codepoint stuck mid-word — the "hieroglyph in a normal word" garble an LLM occasionally emits (e.g. `ка<CJK>eat`, `<CJK>ляет`) — is blocked, naming the offending character, its `U+XXXX` codepoint and position so you re-send clean. Precision over recall: a lone CJK codepoint is flagged only when a Latin/Cyrillic **letter immediately follows** it (the ideograph splits or prefixes a word). So a genuinely CJK message, a multi-character bilingual word (`Deploy到生产`, `3D打印`), a CJK suffix or particle that ends a token (`iOS版`, `React를 배포`), a space-delimited CJK quote, emoji, and accented Latin all pass.

**Mixed-script "garbage word".** A single **contiguous run of letters** whose script switches back and forth between Cyrillic and a foreign alphabet (Latin, Greek, …) — the homoglyph/mojibake signature — is blocked, naming the offending token and its position. The check is **bidirectional**: a foreign fragment sandwiched inside Cyrillic (`почčesна`, meant `починена`) and a Cyrillic letter sandwiched inside a foreign word (`mіr` with a Cyrillic `і`) are both blocked. The trigger is **interleaving**: the run's script must switch **twice or more** (`…Cyr → Lat → Cyr…` or `…Lat → Cyr → Lat…`). Invisible format characters (zero-width space, ZWNJ, soft hyphen, word joiner) do not split a run, so they cannot hide a garbage word. The check is deliberately narrow so legitimate tokens pass — a message using both scripts across **separate words** (`влил PR`, `gh ship готово`, `dev-cli`), a Latin acronym **hyphen-joined** to a Cyrillic word (`PR-ревью`, `MCP-сервер`), a Latin acronym with a **glued** Cyrillic case/diminutive suffix (`IDшник`, `PRы`, `APIшка`), Russian dev slang that wraps **one English stem or acronym** in a Cyrillic prefix and suffix (`заpushил`, `заmergeил`, `отdebugил`, `антиDDoSный` — the island must be plain ASCII, at least two letters, and not made only of letters that look Cyrillic, so `пеpeход` with Latin `p`/`e` is still blocked), a pure-Cyrillic or pure-Latin word, accented Latin, and Cyrillic mixed only with digits/punctuation/emoji all pass. CJK letters are their own class, kept orthogonal to the stray-CJK check above.

### Screenshot-attach gate (`screenshot-guard`)

A message (or `--title`) that mentions **screenshot** or **скриншот** (any case) with **no photo attached** is a **hard error** before send. Attach the image with `tg --photo <path>`. Do not dodge by deleting the word — attach the screenshot. A send that already has `--photo` is allowed. Override: `--no-feature screenshot-guard`.

### Dictionary gate (banned wording)

Alex keeps a machine-readable dictionary of banned words with their replacements at `~/.claude/DICT.json` (path override: `TG_DICT_PATH`) — the twin of the "Dictionary" section of his global `CLAUDE.md`. Prose bans failed three times (an agent keeps inventing a new form of a banned stem), so `tg` enforces them at the sending tool: the `--title`, the body, and `--photo`/`--file` captions of **every** send (all tags, both formats, `--dry-run` included) are matched against every rule. A hit is a **hard refusal** (exit 1, nothing sent) that prints each match — rule id, matched text with ~20 chars of context, the replacement — so the agent rewrites the wording and resends in one step. **There is no bypass flag or env var by design**; only the human editing the file changes what is banned.

- Gated text: the `--title`, the `--subagent` label, the body / caption, and the `--table` heading + rows. Not gated, deliberately (same scope as the garbled-token guard): externally sourced text spliced in after the gate — autolink-inlined ticket / PR titles, quoted `tg#` messages, line-spec excerpts — and the filename of a `--file` upload.
- The text is matched as the reader will see it. Under `--format html`, text inside `<code>`/`<pre>` is exempt (quoting a banned word to discuss it is legitimate), and every other tag is stripped and HTML entities are decoded before matching, so a tag boundary (`почт<b>ил</b>`) or an entity cannot hide a word. Under plain format (the default) everything is literal text — `<code>почтил</code>` is delivered with the word visible, so it is refused.
- A **missing** file at the default path turns the gate off silently; an explicit `TG_DICT_PATH` (environment or `~/.config/tg-cli/.env`) that does not exist refuses every send — a misconfiguration, not an off-switch. A **malformed** file — bad JSON, wrong shape, a rule whose regex does not compile — refuses every send with a warning naming the file (and the rule) until it is fixed: fail closed, because a silently dead gate is exactly how the words would leak.
- Format: `{"version": 1, "rules": [{"id", "pattern", "flags": "iu", "only_if_cyrillic"?: true, "replacement", "why"}]}`. `pattern` is a JavaScript regex source, always compiled with the `u` flag added; `\b` is rewritten to a **Unicode-aware** word boundary at load time (JS `\b` is ASCII-only even under `u`, which would leave Cyrillic stem rules dead). A rule with `only_if_cyrillic` applies only when the message (title + body) contains Cyrillic — e.g. English `landing` is banned inside Russian text but fine in an all-English message. `tg help format` prints the same reference.

### When Telegram is down — retry, then the outbox

A Bot API answer of `429`, `500`, `502`, `503` or `504`, a dropped or refused connection, or an attempt that hangs past 30 s (120 s for a photo/file upload) is retried with backoff (1 s, 2 s, 4 s, 8 s, 8 s …; a `429` waits Telegram's `retry_after`), one short stderr line per retry, until 60 s have passed (`TG_SEND_RETRY_BUDGET_MS` overrides it; `0` = no retry; the first attempt always runs to its own timeout, so a hung upload takes up to 120 s to queue). Any other error (`400 chat not found`, `403`) still fails at once with exit `1`. If Telegram is still failing when the budget runs out, the part of the send that did not go out — parts already delivered are not repeated — is saved, with copies of its photos and files, in `~/.config/tg-cli/tg-ctl.<bot>.outbox/`, and `tg` exits `75` (EX_TEMPFAIL): nothing is lost. The `tg-ctl` daemon sends the queue, oldest first, on startup and after each successful poll of Telegram; every delayed message starts with `⏳ доставлено с задержкой, написано в HH:MM UTC` and lands in its original topic, under its original reply anchor. A queued message Telegram then refuses (a `4xx`) is moved to `outbox/failed/` and logged, never retried forever (tg-cli#710).

Retries are at-least-once: when Telegram took a request but its answer was lost (a timeout or a reset after the upload), the retry or the replay sends that message a second time. A duplicate was judged better than a lost report.

Send exit codes: `0` sent, `1` failed, `75` queued for later delivery, `78` not connected (`tg auth`).

### Intent gate — questions, problems and reports in their format, tagged or not (v1.64.0)

Agents skipped `--tag decision`, so the decision-format gate never ran and bare prose questions ("Решай, оставлять его или закрыть") reached the CTO. `tg` now reads every **agent-written** body itself (`features/cli/intent-gate.ts`):

- A **question** to the reader — a sentence ending in `?` or a decision imperative ("решай", "выбери", "жду твоего решения", "let me know") — is a decision request and needs the decision-request format (Context, Glossary, Options with pros/cons, Recommendation, Where to look, Rich Message structure). Quoted speech, code, URLs and a narrow set of self-answered questions ("Почему падало? Флейк в …") are not asks.
- A **problem** (an explicit blocker: "блокер", "нет доступа", "blocked on") needs Context, evidence / where to look, the ask ("нужен доступ к …"), and ≥2 headings with `<hr>`.
- A **report** of finished work ("готово", "смержил", "merged") needs a reference (`#123`, `ABC-123`, a URL) and verification (tests / CI / a live check); over 500 characters, headings or a list. `tg report` builds one.

| The message is… | Outcome |
| --- | --- |
| a malformed decision / problem / report | **blocked** (exit 1, nothing sent), with the exact list of what is missing |
| a decision, a problem **and** a report at once | **blocked** — send them separately |
| a valid report / problem / answer that also asks a question outside the decision format, carries several decisions, or hides a blocker in a report | **sent**, and tg prints and **records** one follow-up per item: each goes out as its own `tg --reply-to <id> --tag decision …` reply |
| everything in its format, or no ask / blocker / finished work at all | sent |

`tg obligations` lists what is still owed (`--check` exits 1 while any is open, `--json`, `dismiss <id> --reason "…"`); a reply under the original that passes the gate settles the oldest open item of its kind, and the next send from the same sender reminds it of older ones. `--dry-run` shows the verdict without sending or recording.

Scope: an agent process above `tg` or an agent's env marker (`TG_AI_MODEL`, `CLAUDECODE`, `RIG_AGENT_ID`, …). A cron job is not gated; a program spawned from an agent session passes `--automated` (tg-ctl's alerts and usage digests do), which skips the problem/report formats but still refuses a prose question. `ESCALATION_GATE_ENFORCE=0` downgrades a block to a warning, as for `--tag decision`.

**laya** (task-cli's local classifier, the PyPI `laya` package) is asked only when the heuristic found no question, only through task-cli's **already-warm** classify server (a unix socket under `~/.local/state/task-cli/classify/`; `tg` never starts it and never loads a model), within `TG_LAYA_TIMEOUT_MS` (default 1200). A high P(asks the reader) adds a hint; it never blocks or passes a message on its own — measured on Russian agent messages, both laya checkpoints missed questions the regex detector catches. `TG_LAYA=0` turns the lookup off.

### Autolinks

**Linear tickets** (`HYP-576` style) — verified via the `linear` CLI, title inlined or appended. Requires `brew install schpet/tap/linear` + `linear auth login`. Disable: `--no-feature autolink-tasks`.

**GitHub PRs and issues** (`#42` style) — resolved against the cwd repo via `gh`. PRs get a state annotation (`(merged)`/`(open)`/`(draft)`). Disable: `--no-feature autolink-prs`.

Both features are ON by default. Both cache verdicts for 1 hour. Both degrade gracefully to plain text if the CLI is missing or not authenticated.

**Telegram message refs** (`tg#5663` style — the id the inbound wrap shows) — never mistaken for a GitHub `#N`. When the referenced message is in this machine's `tg replies` history, the ref is quoted inline: `«first 48 chars of that message…» (𝒕𝒈#5663)`; in a supergroup the quote links to the message (`t.me/c/…`). A private DM gets no link — Telegram has no per-message link that works there on Desktop, macOS or iOS. Up to 8 refs per message are quoted; the rest, and every ref with `--no-feature autolink-msgref-preview`, keep the marker plus a collapsed excerpt block at the bottom. An id this machine never saw (another machine, trimmed history) stays a bare marker. Disable all of it: `--no-feature autolink-msgrefs`.

---

## Inbound — you reply from your phone

`tg-ctl` is the inbound daemon. It starts automatically on the first outbound `tg` send from a tmux pane with a detected agent. Stop it with `tg-ctl stop`.

### Sending a reply
Plain text from Telegram is injected into the agent's tmux pane as:
```
[TG from you] your message — reply via tg
```
The agent reads it and responds by calling `tg`.

**Reply with a quote (v1.6.0)** — reply to a message (optionally highlighting a
part of it) and the agent receives a quote anchor identifying what you answered:
`↩ tg#5975 «[date time] the quoted text…»` above your message. `tg#5975` is the
replied-to message's own Telegram id (tg-cli#130) — if the preview isn't enough
to place it (e.g. after the agent's context compacted), it can pull the full
original back with `tg replies`. The quote is the message's text, a media caption, or
— for a rich report (`<ul>`/`<table>`/headings) — its flattened content; a captionless
photo/file quotes a label (`«[date] [document report.pdf]»`); with nothing quotable the
anchor is just `↩ tg#5975` (tg-cli#461).

### Addressing a specific agent (v1.6.0)
With several agents running, `/agent <window> <message>` routes to one of them.
The window name is fuzzy-matched (phonetic, Cyrillic-aware), so `/agent апи deploy`
finds the `api-bot` window. Out-of-tmux omp is also addressed by a unique project
token (`/agent landing` -> cwd `conloca-landing`) or a unique first segment
(`/agent rig-fable` -> cwd `rig-cli`). Picker buttons name each session the same way
the message header does: `<tmux window> · <harness title>` (an omp's own session title,
or the title Claude Code / omp paints into the tmux pane), and an out-of-tmux omp by its
title with the project next to it. An omp that rig runs under `abduco` inside a tmux pane
is that pane's agent. If the target is ambiguous or omitted, you get inline
buttons grouped by tmux session; tap one to route. Bare `/agent` lists the agents.

### Agents outside tmux — the rig wrapper, omp-live, or unreachable (v1.46.0, v1.55.0)
tg-ctl types replies into the terminal that hosts an agent: its **tmux pane** (`send-keys`), or,
outside tmux, the **abduco session the rig wrapper runs it in**. Start any harness with
`rig harness run <claude|codex|opencode|omp> --name <label>`: the wrapper keeps it alive
(crash → relaunch and resume the same session), writes `~/.config/tg-cli/hosts/<name>.json`,
and exports `RIG_SESSION`. From then on `/agent <label> <text>`, a reply to its message, or a
plain message when it is the only agent is typed into its terminal exactly once, and its `tg`
messages carry `[<label>]` as the `[window]` bracket. `tg-ctl status` lists it under
`hosted (abduco, outside tmux)`. Spec: `docs/specs/2026-09-30-harness-agnostic-control.md`.

An interactive agent started from a plain terminal tab — no `$TMUX`, not under the wrapper — has
nothing for tg-ctl to type into. It is **listed as unreachable with the reason** — `tg-ctl
status`, `/status` and the no-agent reply show
`landing · claude — unreachable: not in tmux (tty ttys004, cwd …, name landing, pid …)` —
and `/agent landing <text>` to it gets a one-line refusal naming
`rig harness run claude --name landing` (or a tmux window); nothing is queued (tg-cli#456). The
Stop-hook inbox that used to take such messages delivered only at the agent's next turn end, so
an idle session never got them; its leftover messages were listed to you once and archived under
`~/.config/tg-cli/inbox/*/stranded-*.jsonl`. omp outside tmux is reached through its
original-process bridge (`tg-ctl omp-live`, see `docs/omp-original-process.md`), and through its
wrapper session when the bridge is not loaded. `tg-ctl inbox` shows what the inbox still holds (an
omp grant notice waiting for that omp's next turn, and the archive).

### Monitoring alerts reach the responsible agent (`tg-ctl alert`, v1.60.0)
A live omp session binds a **temporary alert subscription**: from a shell inside the session
`tg-ctl alert subscribe` (or `--pid <omp pid>` / `--session <omp session id>` from anywhere;
`--sources sysmon,supervisor` narrows it, `--ttl 12h` is the default, `--ttl 0` never expires).
A monitor then fires `tg-ctl alert send --source sysmon --severity critical --key load --text "…"`:
the alert is posted to Telegram through `tg` with a footer line per bound session —
`↳ также адресовано агенту: <title> (pid N)` — and delivered into each bound session as
`[alert tg#<id> · sysmon · critical] …`, so the agent follows up on that very message with
`tg --reply-to <id>` once the issue is fixed. The subscription is keyed by the omp **session id**
and resolved against the omp-live registry at send time: when the session closes it is unbound
(listed `suspended`, nothing is delivered), when the same session is resumed it is bound again
under its new pid — nothing to re-run. A repeat of the same (source, key, severity) inside
`--window` (default 10 min) is throttled (`throttled tg#<id>`); an escalation to another severity
goes through. `tg-ctl alert list` / `unsubscribe [--pid|--session|--all]`. rig sysmon's Telegram
alert and the omp-supervisor watcher's OVERLOAD/EMERGENCY reports feed it.

### Q→buttons (v1.5.0, seamless setup in v1.6.0)
Agent questions and permission prompts are forwarded to Telegram as inline buttons — no need to touch the terminal. Tap to answer; the answer is injected back into the pane immediately. Supports Claude Code question/permission shapes, Codex `PermissionRequest`, and opencode `question.asked`/`permission.asked` events.

**📥 Inbox (tg-cli#705):** in topics mode every question/permission/hatch card still open
gets a silent copy in one "📥 Inbox" forum topic, with the card's own buttons plus
"✕ Dismiss"; a tap or reply on the copy acts on the card. A card stays open until something
makes it irrelevant — an answer (tap, reply, or a plain message to a session with exactly one
open card), a newer hatch request for the same hook and directory, a decision on a sibling
hatch card, the asker withdrawing (`tg-ctl withdraw`, or the `tg-ctl ask` client being
stopped), or Dismiss — never on a timer. The old "⏳ still waiting" reminders are gone.

**Setup:** run `tg-ctl install-hooks` once — it idempotently wires the Claude Code hooks into `~/.claude/settings.json` and the Codex usage collector into Codex's hooks file (`$CODEX_HOME/hooks.json` when set, otherwise `~/.codex/hooks.json`; backup first, existing hooks preserved), then restart the agent session. If either settings file is malformed, `install-hooks` reports it and exits without clobbering the file. `tg-ctl status` reports q→buttons, StopFailure, Claude statusLine usage telemetry, and Codex usage telemetry separately, including project/local Claude `statusLine` overrides that shadow the user-level collector. If you run `install-hooks` from such a project, it wraps that local statusLine too and backs the file up. Codex requires a manual `/hooks` trust review for the new `tg-ctl codex-usage-hook` Stop hook before it can run. (opencode: see the command's printed guidance.)

`tg-ctl harness-event` also accepts externally-piped proactive limit telemetry
from confirmed contracts: Claude Code statusLine `rate_limits` (and
`context_window` when called with `--agent claude`), Codex `token_count.rate_limits` / app-server
`account/rateLimits/*`, Pi RPC `get_session_stats.data.contextUsage.percent`
(with `--agent pi`), and an explicit `schema: "tg-cli.usageLimit.v1"` envelope
for custom collectors such as an OpenCode plugin. Native OpenCode token/cost
events are not treated as quota telemetry because they do not carry a
percentage/reset contract. `--agent` is a selector for agent-specific telemetry,
not just a display label: Claude `context_window` requires `--agent claude`, and
Pi session stats require `--agent pi`. When supported usage is **90% or higher**, tg-cli
sends a deduped Telegram warning in the detected user language (`--language`,
then `language`/`locale`/`user_language` payload fields, then `LANG`/`LC_*`);
if the language cannot be determined, the warning falls back to English.
Duplicate warnings for the same agent/limit are suppressed for the current reset
window, or for one hour when no reset is known.
Every supported telemetry sample is also saved as the latest snapshot for
`/limit [<agent>]`, even below the 90% warning threshold, so `/limit claude` can
show both `5-hour` and `weekly` buckets when Claude statusLine reports them.
For StopFailure compatibility, `--transcript` or a `transcript_path` payload with
no supported usage telemetry is treated as failure input and the last assistant
message in that transcript is scanned for the limit/error text.
`install-hooks` wires Claude StopFailure, Claude statusLine proactive telemetry,
and Codex Stop-hook proactive telemetry automatically. Existing visible statusLine
output is preserved; when no statusLine exists, the installed Claude collector is
silent. The Claude collector samples statusLine payloads at most every 30 seconds
(`TG_CTL_STATUSLINE_MIN_INTERVAL_SEC=0` disables the throttle for tests). Codex
does not expose a stable statusLine-equivalent quota hook today: its Stop-hook
payload documents `transcript_path`, while the transcript JSONL format is explicitly
not a stable hook interface. `tg-ctl codex-usage-hook` is therefore a best-effort
local collector that reads only the transcript tail (not the whole file, for
performance and hook-time stability) and forwards only supported
`token_count.rate_limits` samples into `tg-ctl harness-event --agent codex`; a
quota sample older than the scanned tail can be missed.
Other proactive telemetry collectors must pipe their payloads to
`tg-ctl harness-event`.

While an agent is **waiting on a question**, new messages you send it are **deferred** (queued, marked ✍️ on the message) and delivered once the question is answered — they don't interrupt the prompt.
If the hook window closes or times out while the terminal prompt is still active,
the Telegram question is kept visible as an expired-timeout card: the old option
buttons are replaced with **Close**, and you can still reply to that card with
plain text to send the answer into the agent pane post-factum.

### Blocking approval for scripts and hooks (`tg-ctl ask "<question>"`, v1.55.10)
Any process — a safety hook, a CI step, a harness with no question hook of its own — can
ask you a yes/no question and wait for the answer:

```bash
tg-ctl ask "Force-push feature/x to origin?" --timeout 600 && git push --force-with-lease
```

The daemon posts an **Approve / Reject** card and the command blocks. It exits **0 only when
you approve that card** — tap Approve, or reply `yes` to it — and the decision is read from the
daemon's own `getUpdates` stream, from an allowed sender (every call gets a fresh random
request id; nothing in a local file, the history log or another card can approve it). Reject,
a timeout (`--timeout` seconds, default 300, max 900), an unreachable daemon, missing
credentials or an empty question all exit **1** with the reason on stderr and nothing on
stdout; an approval prints `approved` (or `approved: <detail>`). It needs no tmux and no
session registration, and while it waits your messages to agents are delivered normally
(it does not defer inbound the way an open agent question does).

**As rig's `agent_hooks.approval_cmd`:** agent-tools safety hooks (e.g. block-reset-hard,
pin-primary-worktree) run the repo's committed `approval_cmd` and allow the blocked
command only on exit 0 — nonzero or a timeout blocks. Point it at `tg-ctl ask` in the
consuming repo's `rig.yaml`:

```yaml
agent_hooks:
  # Runs in a shell; the hook passes its context as RIG_APPROVAL_* env vars.
  # Call tg-ctl by absolute path (the live symlink), never via ambient PATH.
  approval_cmd: '"$HOME/.files/bin/tg-ctl" ask "Allow the blocked ${RIG_APPROVAL_HOOK:-safety-hook} action in $PWD?" --timeout 600'
  # Keep the hook's own budget ABOVE --timeout, or the hook kills the ask first.
  approval_cmd_timeout_s: 630
```

The harness hook that runs the safety check must itself allow a wait this long (Claude
Code's per-hook `timeout`). These keys are read by agent-tools at hook runtime; rig's
`rig.yaml` schema does not list them yet (rig-cli#183).

### Commands
| Command | Effect |
|---------|--------|
| `/stop` | Inject Escape — interrupts the current agent turn, session survives |
| `/kill` | SIGINT the agent — session ends |
| `/status` | Report daemon state |
| `/limit [<agent>]` | Show the latest saved 5-hour/weekly/context usage telemetry for all agents or one agent |
| `/tasks [<agent>] [<status>]` | Show the task board; defaults to work that needs attention, with filters and pages |
| `/agent [<window>] <msg>` | Route a message to a specific agent (fuzzy window match, else selection buttons); a Claude Code / Codex outside tmux (exact `--name` / cwd basename) gets a one-line refusal naming how to start it in tmux |
| `/daily` | What-shipped report: merged PRs since the last run (`rig daily`) |
| `/spend [day\|week\|month]` | Token/cost usage report (`rig usage`) — also pushed automatically weekly/monthly, see `tg-ctl usage-schedule enable` |

`/tasks` renders a rich task table for the resolved project. The default view is
the attention view: blocked/stuck/problem tasks plus ready tasks, not every task.
Each title cell starts with a compact status group emoji (green ready/done,
yellow active, red problem/blocked/stuck, gray canceled), rows group by agent and
project when that context is available (for example `ext` or `rig • tg-cli`),
and the bottom inline keyboard provides quick filters
(`Needs`, `Active`, `Ready`, `Done`, `All`) plus pagination when there is more
than one page. Status-specific commands such as `/tasks done` still work; tapping
a quick filter switches back to the full lifecycle view. Old task-board buttons
expire after a daemon restart.

Photos and documents sent from Telegram are downloaded to `~/.cache/tg-cli/inbound/` and the local path is injected for the agent to read.

A successfully handled message gets a 👀 reaction as a delivery receipt.

### Opt out
```yaml
# ~/.config/tg-cli/config.yaml
control:
  enabled: false
```

> **One bot token per machine.** Telegram allows a single `getUpdates` consumer per token. Outbound `tg` is unaffected.

### Forum topics — one topic per agent (opt-in, experimental)

When the bot chat is a **forum supergroup** (Topics enabled), tg-ctl can route per **topic**:
a message in topic *T* injects into that topic's bound agent pane. Opt in:

```yaml
control:
  topics: true   # default false — leave off for normal 1:1 routing
```

Default **OFF**: with the flag off, a forum-topic message falls through to the normal flat
routing, so existing 1:1 behaviour is unchanged. With it on, each session posts into its own
topic and an inbound topic message routes to its bound pane.

Caveats while this is experimental:

- **A topic never spawns anything.** Creating, renaming, closing or reopening a topic is only
  recorded. A message in a topic that is not linked to a session (a topic you created, or an
  implicit one) is held and the bot posts an **attach picker** there: tap a live session and the
  held messages reach it in order. If that session has no topic yet, this topic becomes its topic
  (renamed to the session's name); otherwise the reply links its own topic. Held messages expire
  after 10 minutes with a "N messages not delivered" reply, and survive a daemon restart.
- **Daemon verbs work in any topic.** `/status`, `/agent`, `/new`, `/tasks`, `/limit`, `/daily`
  and `/spend` are answered inside the topic, linked or not. `/stop` and `/kill` reach the topic's
  session.
- **A gone session answers, it does not respawn.** A message in a topic whose session exited gets
  "`<name>` is not running — resume with …"; nothing is delivered elsewhere.
- **A topic reaches its session wherever it runs.** Text, voice notes (transcribed), photos and
  files in a session's topic take the same delivery as the flat chat — the omp-live bridge (or,
  without one, the omp's own tmux pane), cc/codex send-keys — to the pane or process the session
  lives in now: a resumed or moved session is followed, and a pane that hosts a different session
  now is refused. A live session's topic is never answered "not running" or held behind the
  attach picker.
- **Renaming a session renames its topic.** A tmux window rename or a harness-title change
  retitles the session's topic (`<name> · <title>`) once the new name has been stable for 20 s, at
  most once a minute (the latest name wins). Renaming the topic in Telegram changes nothing in tmux
  or in the session's name.
- **An agent's own posts go to its session's topic.** Each session gets one bot-created topic on
  its first `tg` send or question/permission card; `tg` finds it by asking the daemon, so no
  `--topic`/`TG_TOPIC` is needed (either one still overrides). A `--reply-to` answer goes where
  the message it answers sits: in the topic the CTO wrote in (Telegram does not infer it from the
  reply anchor in a private chat with topics — without the thread the answer lands in General),
  in General for a General message, in the session's own topic when no record of the message
  survives. A resumed session keeps its topic and says "reattached" there. A topic that
  rejects a post is retried once, then the post (text or media) goes to General with a notice; a
  deleted topic is recreated on the next post.

See `docs/specs/tg-forum-topics.md` (§9 increment plan) for the design of this shipped behaviour. It
is superseded by `docs/specs/session-registry-and-topics.md` (one bot-created topic per existing
session, no spawn wizard; epic #476), which replaces it slice by slice.

### Recalling messages (`tg replies`, v1.11.0)

`tg replies` lets an agent (or you) quickly recall what was sent over Telegram —
with timestamps and `#message-ids` — without scrolling the pane.

```
tg replies [user|agent|all] [list | find <query>] [flags]
```

By default it shows the messages **you** sent to **this agent** (resolved from
the current tmux pane's window / project), oldest first, each line marked with
the agent it went to (`[→ <agent>]`, or `[→ ?]` for an untagged / legacy / no-target
row):

```
$ tg replies
[2026-06-15 10:42] #4821 [→ rig] deploy the canary and watch error rates
[2026-06-15 10:58] #4827 [→ rig] roll it back, latency spiked
```

- **Direction** (1st positional, default `user`): `user` (what you sent),
  `agent` (what the agent sent via `tg`), or `all` (both, prefixed `←` you /
  `→` agent).
- **Action** (2nd positional, default `list`): `list`, or `find <query>` for a
  case-insensitive substring search (`--regex` for a regular expression).
- **Agent scope** (default: the **current agent** — this pane's window / project
  name). Every inbound and outbound history row is stamped with the agent it was
  routed to / sent from (`targetAgent`); the default view shows only the current
  agent's. `--agent <name>` shows one named agent (case-insensitive), `--all`
  shows every agent (tagged and untagged), `--untagged` shows only untagged /
  legacy / no-target rows. The three are mutually exclusive. When the current
  agent can't be resolved (e.g. outside tmux) the default degrades to untagged
  only, with a note on stderr. Old history written before this field is treated
  as untagged and is reachable via `--all` / `--untagged`.
- **Pane scope**: by default the current pane (in the default agent scope only —
  `--all`/`--agent`/`--untagged` search across panes). `--all-sessions` searches
  every pane, `--session <window|paneId>` targets one scope — either a tmux
  **window name** (`--session ext`: exact match, all panes of every window named
  `ext` across sessions) or a raw pane id (`--session %7`).
- **Date range**: `--since <date>` / `--until <date>` keep only messages at or
  after / at or before the date (both inclusive). A date is an ISO date
  (`2026-06-28`, midnight UTC), an ISO datetime (`2026-06-28T10:00`, UTC), or
  relative (`3d` / `24h` — N days or hours ago from now).
- `-n/--limit N` (default 20, counts SENDS not raw rows — a >4096-char split
  or a media-group album is one send, never truncated mid-send), `--full`
  (no truncation), `--json` (a machine-readable array: `ts` ms, `id`,
  `direction`, `from`, `text`, `pane`, `targetAgent` — one row per Telegram
  message_id, so a multi-part send is several rows and `--json -n N` can return
  more than N rows), `--help`.

```
tg replies all                  # the full back-and-forth for this agent
tg replies --all                # every agent's inbound messages
tg replies --agent rig          # messages routed to the "rig" agent
tg replies --untagged           # legacy / no-target messages only
tg replies --session ext        # messages in the tmux window named "ext"
tg replies user find deploy     # your messages mentioning "deploy"
tg replies agent --all --all-sessions # everything the agents have sent, anywhere
tg replies user --since 3d      # your messages in the last 3 days
tg replies all --since 2026-06-28 --until 2026-06-30  # a date range
tg replies --json -n 5          # the last 5 sends, as JSON
```

History is an append-only `~/.config/tg-cli/tg-ctl.<botid>.history.jsonl` (one
JSON object per line, trimmed to the last ~5000 messages). The `tg-ctl` daemon
records inbound messages; `tg` records its own outbound. Both writers are
best-effort and never block a send or an inject.

### Structured result reports (`tg report`, v1.53.0)

`tg report` formats a structured result report — ticket/PR link(s), user impact,
a "what changed" summary, evidence, and required verification proof — as a
Telegram Rich Message and sends it with `--tag report` (🟢 REPORT badge). It
bridges the `/result-report` convention (which only produced a chat-visible
report + an HTML file, never a Telegram push) to a real send: it re-enters
the same pipeline every other `tg` send uses (dictionary gate, autolink,
`--dry-run`, …).

```
tg report --title <text> (--ticket <id-or-url> | --pr <num-or-url>) \
          --impact <text> --verify-cmd <cmd> --verify-result <result> \
          [--evidence <text>]... [--summary <text>]... \
          [--reply-to <id>] [--subagent <name>] [--topic <id>] [--dry-run]
```

`--title`, at least one of `--ticket`/`--pr`, `--impact`, `--verify-cmd`, and
`--verify-result` are required — a report with no verification proof is
refused before anything is sent. `--evidence`/`--summary`/`--ticket`/`--pr`
are repeatable.

```
tg report --title "Fix the crash on empty input" --ticket HYP-123 \
  --impact "users no longer see a crash when submitting an empty form" \
  --verify-cmd "bun test tests/form.test.ts" --verify-result "12 pass, 0 fail" \
  --summary "added a guard for the empty-string case" \
  --evidence "reproduced pre-fix, confirmed fixed post-fix"

tg report --dry-run --title "..." --pr owner/repo#456 --impact "..." \
  --verify-cmd "..." --verify-result "..."   # validate without sending
```

See `tg help report` for the full flag reference.

---

## Your own Telegram account — calls and sends

The bot can't call anyone or write as you. `tg` can, through your own Telegram account
(MTProto, a Python sidecar on pyrofork + py-tgcalls — spec:
[docs/specs/independent-telegram-clients.md](docs/specs/independent-telegram-clients.md)).

```sh
tg auth user                         # once: phone + code (+ 2FA) on this terminal; or --qr
tg call @alice --say "Встреча через 5 минут"   # ring and speak (or --audio file.ogg)
tg user send @alice "on my way"      # send as you (text or stdin)
tg auth caller                       # a SECOND account, so tg can ring you:
tg call me --say "Тони написал в Telegram"
tg call @alice --audio note.ogg --dry-run       # check everything, connect to nothing
tg call @alice --say="-5 °C outside"           # dash-leading text needs the = form
tg auth user status --online         # who is logged in; exit 3 when nobody
tg auth status                       # bot + user + caller in one view (offline for accounts)
```

- **Login**: Telegram requires an app registration for any user login — the first
  `tg auth user` asks for the API ID/hash from https://my.telegram.org/apps (or set
  `TG_API_ID`/`TG_API_HASH` in the env or `~/.config/tg-cli/.env`); later logins reuse it.
  Everything is prompted hidden; nothing goes in argv or chat.
- **Sessions** live in `~/.config/tg-cli/mtproto/` (0700; files 0600, never overwritten).
  A session file IS your account — keep it private. `tg auth user logout` deletes it;
  terminate the login itself in Telegram → Settings → Devices.
- **Runtime**: the first account command builds a Python 3.12 venv under
  `~/.cache/tg-cli/` with `uv` from the hash-locked `requirements-call.txt`
  (needs `uv`; calls also need `ffmpeg`; `--say` needs macOS `say` or `espeak-ng`).
  `TG_MTPROTO_SIDECAR=<executable>` uses a runtime you built yourself instead.
- **Calls**: one dial, never retried; success = the audio played to the end. An account
  cannot ring itself, so `tg call me` uses the caller account.
- **Import** instead of login (e.g. HyperCalendarBot's service account):
  `tg auth caller --import-session voice_caller.session --import-config calendar/.env`.
  The key is then shared with that app, so every online use needs `--source-idle-confirmed`
  (that app must be stopped).

---

## Agent branding

`tg` auto-detects which agent is running by walking the tmux pane's process tree and prefixes every message with the agent's custom emoji icon. No configuration needed.

<img src="emoji-icons/mini_claude.png" width="16" height="16" align="top" alt="Claude" /> <b>Claude</b> — Anthropic<br/>
<img src="emoji-icons/mini_codex.png" width="16" height="16" align="top" alt="Codex" /> <b>Codex</b> — OpenAI<br/>
<img src="emoji-icons/mini_kimi.png" width="16" height="16" align="top" alt="Kimi" /> <b>Kimi</b> — Moonshot AI<br/>
<img src="emoji-icons/mini_gemini.png" width="16" height="16" align="top" alt="Gemini" /> <b>Gemini</b> — Google<br/>
<img src="emoji-icons/mini_deepseek.png" width="16" height="16" align="top" alt="DeepSeek" /> <b>DeepSeek</b><br/>
<img src="emoji-icons/mini_qwen.png" width="16" height="16" align="top" alt="Qwen" /> <b>Qwen</b> — Alibaba<br/>
<img src="emoji-icons/mini_mistral.png" width="16" height="16" align="top" alt="Mistral" /> <b>Mistral</b><br/>
<img src="emoji-icons/mini_grok.png" width="16" height="16" align="top" alt="Grok" /> <b>Grok</b> — xAI<br/>
<img src="emoji-icons/mini_copilot.png" width="16" height="16" align="top" alt="Copilot" /> <b>Copilot</b> — GitHub<br/>
<img src="emoji-icons/mini_perplexity.png" width="16" height="16" align="top" alt="Perplexity" /> <b>Perplexity</b><br/>
<img src="emoji-icons/mini_cursor.png" width="16" height="16" align="top" alt="Cursor" /> <b>Cursor</b><br/>
<img src="emoji-icons/mini_windsurf.png" width="16" height="16" align="top" alt="Windsurf" /> <b>Windsurf</b><br/>
<img src="emoji-icons/mini_ollama.png" width="16" height="16" align="top" alt="Ollama" /> <b>Ollama</b><br/>
<img src="emoji-icons/mini_hyperide.png" width="16" height="16" align="top" alt="HyperIDE" /> <b>HyperIDE</b><br/>

Branding follows the **model**, not the harness: a harness that runs an identifiable model is branded with that model's icon (so an opencode or router session shows whichever model it's driving — DeepSeek, Kimi, etc.). When no model can be determined, branding falls back to a 📁 folder icon. This is why the table above is keyed by model, not by tool.

**Detection precedence.** Explicit signals from the agent's environment (`TG_AI_MODEL`, then per-harness env vars) always take priority over `pgrep` process-tree fallbacks — so a stray background daemon (e.g. an `ollama` server running for unrelated reasons) can never shadow the real agent. Override anytime with `TG_AI_MODEL`.

Override if needed:
```bash
TG_AI_MODEL=kimi tg "message"
```

List all emoji helpers: `tg --ls-emoji-helpers`

Manual emoji in message text: `tg "done :codex: :gemini:"` — use any agent name as a `:name:` token.

See [docs/custom-emoji-system.md](docs/custom-emoji-system.md) for the full spec.

---

## Agent / subagent identification

The header carries the sender's identity in up to two brackets: `✳️ [window] [subagent]`.

**`[window]` — the session name, automatic, no flag.** The first bracket is the pane's
tmux window name. When that name is a bare auto-rename default — a numeric window index,
a shell/launcher/wrapper name (`node`/`zsh`/`bun`/`abduco`), or Claude Code's version
string (`2.1.207`, which tmux `automatic-rename` stamps as the window name because the cc
process reports its version as its command) — it carries no project signal, so `tg`
falls back to the pane's **cwd project basename**. An orchestrator working in
`~/xp/rig-cli` therefore auto-labels `[rig-cli]` with no flag, whatever the window is
named. The harness's own session title (omp's title, or the `✳ <title>` Claude Code paints
into the pane) follows as the header title. Outside tmux the harness title IS the bracket
(falling back to the cwd project). This is the MAIN/orchestrator agent's identity; it
never needs a flag. Check what the current shell resolves to: `tg --detect-agent`.

**`[subagent]` — a subagent label.** Agent branding (above) identifies
which MODEL is talking; it cannot tell apart the several subagents an orchestrator fans
work out to (Claude Code's Task tool and equivalents). A subagent adds a second bracket
by passing its name explicitly:

```bash
tg --subagent hyperide-fixer "fixed the layout bug, PR #123 open"
# → ✳️ [window] [hyperide-fixer]
#   fixed the layout bug, PR #123 open
```

`--subagent <label>` renders its own `[label]` bracket right after `[window]`, styled the
same way (Sans-Serif Bold, `<b>` fallback for Cyrillic). `TG_AGENT` is the env
equivalent (same effect as the flag; the explicit flag wins). The deprecated `--agent`
alias still parses to the same field.

**Which signals label a subagent** (`docs/specs/agent-role-model.md`): precedence is
`--subagent` > `TG_AGENT` > `RIG_AGENT_ID` > `RIG_DETACHED_AGENT=1` (→ `[detached]`). The last
two are written by the harness or the launcher on the child process — omp sets
`RIG_AGENT_ID` on each task subagent's shell (and clears it on the main session's), and
detached children (`omp -p`, `claude -p`, `codex exec`, `opencode run` started by a rig
launcher) get them at exec — so those subagents need no flag. Claude Code, Codex and
opencode run their in-process subagents with the SAME environment as the coordinator, so
those MUST pass `--subagent`. There is no positive "coordinator" marker, and
`CLAUDE_CODE_CHILD_SESSION` is NOT a signal (Claude Code sets it on the main thread too —
it once mislabelled the orchestrator as a generic `[subagent]`; that auto-detection is gone).

Note: `tg-ctl`'s OWN `--agent <name>` is a DIFFERENT flag on a DIFFERENT binary, and
comes in two shapes: `tg-ctl ask --agent codex` takes a CLOSED harness-kind selector
(`claude`/`codex`/`opencode`/`pi`/`aider`/`omp` — the `HOOK_AGENT_KINDS` list) for
classifying inbound hook payloads, while `tg-ctl harness-event --agent` accepts a
free-form label for telemetry reports. Neither is an outbound sender label. They never
collide with `tg`'s `--subagent` (separate argv parsers), but don't confuse them.

---

## Screenshots

<table align="center" width="100%">
  <tr>
    <td align="center" width="33%">
      <img src="screenshots/report-1.png" width="300" alt="Status report with HTML formatting" />
      <br/>
      <sub><b>Status report</b> — HTML + custom emoji</sub>
    </td>
    <td align="center" width="33%">
      <img src="screenshots/report-2.png" width="300" alt="Visual evidence with multiple photos" />
      <br/>
      <sub><b>Visual evidence</b> — 3 photos + caption</sub>
    </td>
    <td align="center" width="33%">
      <img src="screenshots/report-3.png" width="300" alt="Summary with formatted list" />
      <br/>
      <sub><b>Summary</b> — structured findings</sub>
    </td>
  </tr>
</table>

---

## How tg compares

tg differs on three independent axes, which the tables below score separately:
- **Direction** — outbound-first (the agent *curates* what's worth sending) vs. inbound-first (a chat-driven remote terminal mirroring the session). Most tools are the latter; tg is the former.
- **Agent coverage** — any agent in tmux vs. Claude-only.
- **Control depth** — a thin, optional inbound layer (poke-back) vs. a full session mirror.

tg sits at outbound-first / any-agent / thin-inbound; the "remote terminal" tools cluster at inbound-first / Claude-only / full-mirror — but the axes are independent, which is why each column is scored on its own.

### Philosophy

| Tool | Direction | Mental model | Agents |
|---|---|---|---|
| **tg** | Outbound-first, thin inbound | Curated agent reporting + poke-back | Any (multi-agent) |
| Anthropic Channels / Remote Control | Inbound-first | Remote terminal / chat bridge (first-party) | Claude only |
| Imolatte/tg-claude | Full-duplex | Remote terminal | Claude |
| oscarsterling/claude-telegram-remote | Full-duplex | Remote terminal (tmux) | Claude |
| RichardAtCT/claude-code-telegram | Full-duplex | Remote terminal (SDK) | Claude |
| JessyTsui/Claude-Code-Remote | Full-duplex | Remote terminal + trace delivery | Claude |
| jsayubi/ccgram | Full-duplex | Approvals + remote terminal | Claude |

### Features

| Tool | Curated out | Multi-agent brand | Media out | Inbound | Q→buttons | Full mirror |
|---|---|---|---|---|---|---|
| **tg** | ✓ | ✓ | ✓ | ✓ | ✓ | — (by design) |
| Anthropic Channels / RC | ~ (reply-only) | — | ✓ | ✓ | — | ✓ (RC) |
| Imolatte/tg-claude | — | — | ✓ | ✓ | ✓ | ✓ |
| oscarsterling | ~ (channel reply) | — | — | ✓ | ✓ | ~ |
| RichardAtCT | — | — | ✓ | ✓ | ~ | ✓ |
| JessyTsui | — (full trace) | — | — | ✓ | — | ✓ |
| ccgram | — | — | — | ✓ | ✓ | ✓ |

---

## Ecosystem

Part of the [HyperIDE.ai](https://hyperide.ai) agent toolchain:

- **[review-cli](https://git.hyperide.ai/ultrabricks/review-cli)** — agentic, priority-ordered failover multi-model code-review board (brainstorm/quorum, spec-web, dashboard)
- **[rig-cli](https://git.hyperide.ai/ultrabricks/rig-cli)** — umbrella dev-env driver: sets up a repo from config — skills, hooks, CI, dep-bootstrap; reconciles drift
- **[agent-tools](https://git.hyperide.ai/ultrabricks/agent-tools)** — the shared catalog `rig` applies: portable agent skills, agent-hooks, the global git-hook dispatcher, CI gates, and MCP servers
- **[draw-cli](https://github.com/alex-mextner/draw-cli)** — text-to-image via Hugging Face
- **[3d-cli](https://github.com/alex-mextner/3d-cli)** — scriptable CLI for the full 3D FDM lifecycle: modeling, mesh repair, slicing, and print monitoring
- **[hyperide.ai](https://hyperide.ai)** — Figma replacement inside VS Code. Edit React components directly through AST/LSP without AI hallucinations, token waste, or context-window limits. Works for indie vibe-coding and for enterprise teams with split design/dev roles.

Each CLI registers a skill into your agent harnesses (`<tool> install-skill`) so agents know it exists — see Install.

---

## Telegram sidecar internals (expert)

`tg-mtproto` (personal account) and `tg-call` (caller account) are the sidecar's own
entrypoints — the same code `tg` spawns as `python -m telegram_client personal|caller`,
with the same store (`--store`, default `~/.config/tg-cli/mtproto`). Run them with the
runtime's Python (`~/.cache/tg-cli/mtproto-runtime-*/bin/python`). Output is JSON lines;
errors are codes, never library exception text. Exit 3 = refused with a code (missing
session, safety gate); 1 = operation failed; 130 = interrupted.

```sh
./tg-mtproto doctor             # offline; never prompts for login
./tg-call status                # offline; never rings
./tg-mtproto status --online    # get_me; refuses missing/foreign auth
./tg-mtproto dialogs --limit 30
./tg-mtproto history --peer <confirmed-id> --limit 30 --before-id <message-id>
```

History uses MTProto reads without marking chats read.

Notification trigger — after confirming the contact from actual history, preparing the
speech audio, and coordinating ownership of the calling session:

```sh
./tg-mtproto arm --peer <confirmed-contact-id> --trigger ~/.config/tg-cli/triggers/tony.sqlite
./tg-mtproto watch-call --trigger ~/.config/tg-cli/triggers/tony.sqlite \
  --audio /private/path/tony-wrote.wav
```

The watcher subscribes to new incoming updates; it does not poll. It makes at most
one attempt. A failure or crash after claiming requires manual reconciliation, so
an uncertain call never repeats automatically. The recipient is the verified personal
account owner. This is not activated by installation and needs process supervision
on an always-on host. Neither live auth nor a real call is established by the module
tests. No trigger for Tony is currently configured. `requirements-call.txt` is the hash-pinned
PyPI runtime; a patched ntgcalls binary still needs its own media acceptance.

### Independent conversational transport checkpoint

`python3 tg-call live-smoke` runs an entirely offline duplex integration with fake
native I/O and mock STT/CallAgent/TTS; it never logs in, dials, or contacts a provider.
It exercises actual PCM framing, VAD boundaries, private WAV playback, interruption,
reconnect and hangup cleanup. `tg-call doctor` reports authorization separately from
conversation readiness. Run the native event binding test with the dedicated runtime:

```
~/.cache/tg-cli/mtproto-runtime-*/bin/python tests/telegram-duplex.test.py
```

`telegram_client.duplex.native_transport(calls, peer, vad)` binds installed
PyTgCalls callbacks for an already connected call. The auth/call owner remains
responsible for independent `connected(store, "caller")` lifetime; constructing this
adapter never starts a client or dials. `Conversation` accepts injected streaming
STT, model and PCM TTS ports. `CallAgentAdapter` preserves the generic
`run({userId, transcript}) -> {responseText, endCall}` contract.
STT adapters must stamp final callbacks with captured transport epoch and turn
generation (`final(text, epoch, generation)`) to reject stale utterances.

Production readiness is deliberately false: provider bindings, pinned local VAD
weights and the Bracho provider/voice ID still need explicit configuration. No new
provider credentials were copied. Output uses serialized WAV chunks and native
PLAY_DONE, not a continuous PCM output device. Real remote-audio latency, native
late PLAY_DONE ordering after STOP, and live reconnect behavior remain unverified.
A real call requires separate authorization. See `features/telegram_client/NOTICE`
for source provenance and unresolved source licensing.

Provider adapters are in `telegram_client.providers`: Nova-3 RU streaming via
pinned aiohttp; the generic CallAgent JSON stdin executable contract; cancellable
local Silero TTS worker; hash-verified local Silero TorchScript VAD. No adapter
activates on import or doctor. `providers.example.json` contains no credentials;
`credential_env` names an explicitly supplied environment variable. Run:

```
python3 tg-call doctor --providers-config features/telegram_client/providers.example.json
```

`build_providers(config)` explicitly activates the configured bindings;
`attach_configured_session(calls, peer, config)` attaches them to a caller-owned,
already connected native call. It does not create authorization or dial. The
caller must separately authorize provider use. The configured generic agent
executable receives `{userId, transcript}` on stdin and returns JSON
`{responseText, endCall}` on stdout; it owns persistent user context/tool policy.
TTS requires an explicit supported speaker, local Silero `v5_ru` package and its
SHA-256; VAD requires a local Silero TorchScript model and its SHA-256. Do not map
Bracho to a built-in Silero voice without the actual confirmed preset. If the
existing Bracho profile uses another engine, configure that engine adapter rather
than relabeling a Silero speaker. `requirements-voice.txt` records the existing
calbot macOS CPU Torch/numpy dependency closure; it was not installed in this step.
The model paths and hashes are deliberately unset; no weight or key was copied.

Provider validation is offline or local mock I/O only. Silero synthesis runs in a
killable process per text chunk (cold-start latency remains to measure); native
output remains serialized WAV playback. RU Nova is implemented; Flux EN is not
wired into this independent provider layer. No real provider health is claimed.

Pinned PyTgCalls 2.2.11 does not implement `skip_stream`. The native adapter uses
its existing NTgCalls `set_stream_sources(CAPTURE, MediaDescription())` operation
to clear outgoing sources instead; it never falls back to buffered `pause` or
`play(None)` (which could redial a disconnected peer). This private binding seam
is version-sensitive and covered by the installed-native contract test; remote
buffer flushing remains unverified without a separately approved live call.

With `--providers-config`, doctor exits 3 until both caller auth metadata and
provider configuration checks pass; a zero status still does not claim live
Telegram/provider audio verification.

### Shared call-lib and conversational start

The `tg-call-lib` wheel packages this same `telegram_client` source; there is no
second implementation. `tg-call library-info` and `tg-call-json`'s `describe`
request report distribution version and module path. The prepared Bun consumer
is in `adapters/calbot/`; it has not been deployed into the running application.

`tg-call start --providers-config CONFIG` is fail-closed. A real start additionally
requires `--confirm-call --allow-provider-network --source-session-idle-confirmed`,
ready provider/media checks, `voice.status: "confirmed"`, an explicit Bracho
mapping and `agent.protocol: "call-agent-json-v1"`. Before Telegram connects,
the configured agent's metadata handshake must identify a production-ready
wrapper. `call-agent-mock` is deterministic and always rejected for live use.
Missing authorization never invokes login. One dial attempt is owned by the
shared library, with a 30-second dial bound and at most 1800 seconds of conversation;
CLI cancellation/JSON-runner SIGTERM close the session and release its auth lock.

Build the local wheel with an already available setuptools backend; install the
result with `pip --no-index --no-deps` into a separate test/runtime venv. Runtime
and voice dependencies remain governed by the supplied hashed locks. Local VAD
weights/license receipts live outside the code repository and are not bundled.
See `adapters/calbot/README.md` for the JSON wrapper and consumer protocol.

---

## License

MIT
