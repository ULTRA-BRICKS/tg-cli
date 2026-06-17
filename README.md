# tg — Telegram bridge for AI coding agents

The best way to monitor several coding agents at once: they push only what matters — status updates, blockers, a question — and you reply from your phone. Agent questions and permission prompts arrive as **tappable inline buttons**; no terminal round-trip needed.

Works with any agent in tmux: Claude Code, Codex, opencode, aider, and more.

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

**One-liner** (installs deps via bun, links `tg` into PATH, registers the agent skill):
```bash
curl -fsSL https://raw.githubusercontent.com/alex-mextner/tg-cli/main/install.sh | bash
```

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

**Manual clone:**
```bash
git clone git@github.com:alex-mextner/tg-cli.git
cd tg-cli
ln -sf "$(pwd)/tg" ~/.local/bin/tg
```

**Requirements:** [Bun](https://bun.sh)

**Config** — create `~/.config/tg-cli/.env`:
```
TG_BOT_TOKEN=<your bot token from @BotFather>
TG_CHAT_ID=<your chat or user ID>
```

### Update / deploy a merged change

`tg` is a committed Bun script run directly via the symlink (`tg` → `<checkout>/tg`),
so the checked-out file **is** the running binary — there is no build step. Deploying a
merged change is a fast-forward `git pull` in the checkout the symlink points at:
```bash
scripts/deploy.sh                  # update the checkout the `tg` on PATH points at
scripts/deploy.sh --dry-run        # show what would land, change nothing (always safe)
scripts/deploy.sh --checkout DIR   # update a specific checkout
```
When up to date the script is a no-op; otherwise it advances the checkout's `HEAD` to
`origin/<branch>`. It refuses to pull over tracked local changes (untracked files such
as a stray `node_modules` do not block it — though `git`'s own fast-forward will still
abort if an incoming path collides with an untracked file) and refuses a
non-fast-forward divergence. `tg` itself needs no restart — the next invocation reads
the new file. Exit codes: `0` up-to-date or deployed, `1` usage/environment error,
`2` non-fast-forward (needs a human).

> **`tg-ctl` daemon:** the inbound control daemon (`tg-ctl run`) loads its code into
> memory at start, so a deploy that changes daemon code (the `tg-ctl` entry or anything
> under `features/`, which the daemon imports) only takes effect after a restart — which
> **drops the daemon's pane/cwd/session registration**. `deploy.sh` detects this and prints exactly what to restart (re-binding
> the same pane); pass `--restart-ctl` to stop/start it automatically (re-register the
> pane afterwards). A plain `curl … | install.sh` re-run also refreshes a clone (it does
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

### Auto-attach from message text

File paths mentioned in the message text are detected and attached automatically (images as photos, everything else as documents). The path token stays in the caption verbatim — it's only detected and attached, never removed. Recursive search across the worktree finds files by bare name or path suffix — `BFS`, shallowest match wins, `node_modules`/`.git`/`dist`-style dirs pruned.

### Secret-file denylist

Secret-looking files are **never** attached: `.env` family, SSH private keys, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.ppk`, credential rc-files (`.netrc`, `.npmrc`, `.git-credentials`, …), shell histories, `*.tfvars`, `credentials.json`/`client_secret*.json`, `kubeconfig`. Auto-detected mentions are silently skipped; an explicit `--file prod.env` is a hard error. Override: `--no-feature attach-denylist`.

### Autolinks

**Linear tickets** (`HYP-576` style) — verified via the `linear` CLI, title inlined or appended. Requires `brew install schpet/tap/linear` + `linear auth login`. Disable: `--no-feature autolink-tasks`.

**GitHub PRs and issues** (`#42` style) — resolved against the cwd repo via `gh`. PRs get a state annotation (`(merged)`/`(open)`/`(draft)`). Disable: `--no-feature autolink-prs`.

Both features are ON by default. Both cache verdicts for 1 hour. Both degrade gracefully to plain text if the CLI is missing or not authenticated.

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
`↩ «[date time] the quoted text…»` above your message.

### Addressing a specific agent (v1.6.0)
With several agents running, `/agent <window> <message>` routes to one of them.
The window name is fuzzy-matched (phonetic, Cyrillic-aware), so `/agent апи deploy`
finds the `api-bot` window. If the target is ambiguous or omitted, you get inline
buttons grouped by tmux session; tap one to route. Bare `/agent` lists the agents.

### Q→buttons (v1.5.0, seamless setup in v1.6.0)
Agent questions and permission prompts are forwarded to Telegram as inline buttons — no need to touch the terminal. Tap to answer; the answer is injected back into the pane immediately. Supports Claude Code question/permission shapes, Codex `PermissionRequest`, and opencode `question.asked`/`permission.asked` events.

**Setup:** run `tg-ctl install-hooks` once — it idempotently wires the Claude Code hook into `~/.claude/settings.json` (backup first, existing hooks preserved), then restart the agent session. `tg-ctl status` tells you whether the hook is installed. (Codex/opencode: see the command's printed guidance.)

While an agent is **waiting on a question**, new messages you send it are **deferred** (queued, marked ✍️ on the message) and delivered once the question is answered — they don't interrupt the prompt.

### Commands
| Command | Effect |
|---------|--------|
| `/stop` | Inject Escape — interrupts the current agent turn, session survives |
| `/kill` | SIGINT the agent — session ends |
| `/status` | Report daemon state |
| `/agent [<window>] <msg>` | Route a message to a specific agent (fuzzy window match, else selection buttons) |

Photos and documents sent from Telegram are downloaded to `~/.cache/tg-cli/inbound/` and the local path is injected for the agent to read.

A successfully handled message gets a 👀 reaction as a delivery receipt.

### Opt out
```yaml
# ~/.config/tg-cli/config.yaml
control:
  enabled: false
```

> **One bot token per machine.** Telegram allows a single `getUpdates` consumer per token. Outbound `tg` is unaffected.

### Recalling messages (`tg replies`, v1.11.0)

`tg replies` lets an agent (or you) quickly recall what was sent over Telegram —
with timestamps and `#message-ids` — without scrolling the pane.

```
tg replies [user|agent|all] [list | find <query>] [flags]
```

By default it shows the messages **you** sent in **this tmux session**, oldest
first:

```
$ tg replies
[2026-06-15 10:42] #4821 deploy the canary and watch error rates
[2026-06-15 10:58] #4827 roll it back, latency spiked
```

- **Direction** (1st positional, default `user`): `user` (what you sent),
  `agent` (what the agent sent via `tg`), or `all` (both, prefixed `←` you /
  `→` agent).
- **Action** (2nd positional, default `list`): `list`, or `find <query>` for a
  case-insensitive substring search (`--regex` for a regular expression).
- **Scope** defaults to the current pane's session; `--all-sessions` searches
  everywhere, `--session <paneId>` targets one pane.
- `-n/--limit N` (default 20), `--full` (no truncation), `--json` (a
  machine-readable array: `ts` ms, `id`, `direction`, `from`, `text`, `pane`),
  `--help`.

```
tg replies all                  # the full back-and-forth in this session
tg replies user find deploy     # your messages mentioning "deploy"
tg replies agent --all-sessions # everything the agent has sent, anywhere
tg replies --json -n 5          # the last 5, as JSON
```

History is an append-only `~/.config/tg-cli/tg-ctl.<botid>.history.jsonl` (one
JSON object per line, trimmed to the last ~5000 messages). The `tg-ctl` daemon
records inbound messages; `tg` records its own outbound. Both writers are
best-effort and never block a send or an inject.

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

- **[review-cli](https://github.com/alex-mextner/review-cli)** — agentic, priority-ordered failover multi-model code-review board (brainstorm/quorum, spec-web, dashboard)
- **[rig-cli](https://github.com/alex-mextner/rig-cli)** — umbrella dev-env driver: sets up a repo from config — skills, hooks, CI, dep-bootstrap; reconciles drift
- **[agent-tools](https://github.com/alex-mextner/agent-tools)** — the shared catalog `rig` applies: portable agent skills, agent-hooks, the global git-hook dispatcher, CI gates, and MCP servers
- **[draw-cli](https://github.com/alex-mextner/draw-cli)** — text-to-image via Hugging Face
- **[3d-cli](https://github.com/alex-mextner/3d-cli)** — scriptable CLI for the full 3D FDM lifecycle: modeling, mesh repair, slicing, and print monitoring
- **[hyperide.ai](https://hyperide.ai)** — Figma replacement inside VS Code. Edit React components directly through AST/LSP without AI hallucinations, token waste, or context-window limits. Works for indie vibe-coding and for enterprise teams with split design/dev roles.

Each CLI registers a skill into your agent harnesses (`<tool> install-skill`) so agents know it exists — see Install.

---

## License

MIT
