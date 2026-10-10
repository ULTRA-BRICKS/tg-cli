# Claude Code prompts inside tmux: when is a prompt still pending? (tg-cli#304)

Study run 2026-09-04 against a real Claude Code in an isolated `HOME` inside a private,
headless tmux server. It answers, with captures, the question the daemon kept guessing at:
is a permission or question still waiting for the human, and what reaches it.

- **Versions:** Claude Code 2.1.261 (Haiku 4.5), tmux 3.5a, macOS 26.5.1; opencode 1.18.20 and
  codex-cli 0.153.2 for the side probes (`docs/cc-tmux-evidence/*/meta.txt`).
- **Re-run:** `tools/cc-study/NN-*.sh` — one script per finding, macOS only (Keychain auth,
  `sysctl` memory gate, `CC_BIN` defaults to `/Users/ultra/.local/bin/claude`). Each run rewrites
  `docs/cc-tmux-evidence/NN-*/`: `*-screen.txt` (plain `capture-pane -p`, first line = time and
  `alternate_on`/`pane_in_mode` flags), `*.ansi.txt` (with escapes), `*-process.txt`
  (`<config>/sessions/<pid>.json` + open sockets), `*-transcript.txt` (transcript JSONL tail),
  `hooks/NNN-<Event>.json|.env` + `hooks/log.tsv` (hook stdin, scrubbed env, timing), and
  `frames/` (a 1 Hz screen poller; `frames/index.tsv` has one line per tick with tmux flags and the
  session-registry status).
- **Code:** the findings are encoded in `features/tg-ctl/claude-prompt-state.ts`
  (`readPendingClaudePrompt`, `parseClaudeSessionRecord`), tested against verbatim copies of these
  captures in `tests/fixtures/claude-prompt/` (`tests/claude-prompt-state.test.ts`).

## (a) What each prompt looks like

Every prompt replaces the idle input box with a numbered list; the selected row carries `❯`.
The idle input box is a `❯` line between two full-width `─` rules, followed by the status line
(`? for shortcuts` when idle, `esc to interrupt` while working). In every idle capture that line is
`❯` + U+00A0 (no-break space), not a plain space.

| Shape | Marker line above the options | Options | Footer | Evidence |
|---|---|---|---|---|
| Bash permission | `Do you want to proceed?` (box header `Bash command`, command on its own line, then its description) | `1. Yes` / `2. Yes, and always allow access to <dir> from this project` / `3. No` | `Esc to cancel · Tab to amend` | `01-bash-permission/pending-screen.txt`, `pending-options.txt` |
| Edit permission | `Do you want to make this edit to README.md?` (box header `Edit file`, path relative to cwd, then the diff) | `1. Yes` / `2. Yes, and switch to accept edits (…) for this session (shift+tab)` / `3. No` | `Esc to cancel · Tab to amend` | `02-edit-permission/pending-screen.txt` |
| Plan approval | `Claude has written up a plan and is ready to execute. Would you like to proceed?` | `1. Yes, auto-accept edits` / `2. Yes, manually approve edits` / `3. Tell Claude what to change` (+ hint `shift+tab to approve with this feedback`) | `ctrl+g to edit in VS Code · ~/.claude/plans/<name>.md` | `03-plan-approval/pending-screen.txt` |
| AskUserQuestion, one question | the question text (`Which color?`), below a `☐ <header>` tab line | each option with its description on the next, deeper-indented line, then `Type something.`, a rule, `Chat about this` | `Enter to select · ↑/↓ to navigate · Esc to cancel` | `04-ask-single/pending-screen.txt` |
| AskUserQuestion, several | same, one tab per question: `←  ☐ Color  ☐ Size  ✔ Submit  →` (`☒` once answered) | as above | `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` | `05-ask-multi/pending-q1-screen.txt`, `after-q1-digit-screen.txt` |
| AskUserQuestion review | `Ready to submit your answers?` under `Review your answers` and the chosen answers | `1. Submit answers` / `2. Cancel` | none | `05-ask-multi/after-q2-digit-screen.txt` |

The deny option of both tool permissions is a plain `No` — not "No, and tell Claude what to do
differently" (tg-cli#268 worried about that form). Plan approval has no plain deny: its third
option opens free-text feedback.

## (b) Hooks and their timeouts

- **PermissionRequest stdin** (`06-hook-timeout-permission/hooks/001-PermissionRequest.json`):
  `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`,
  `hook_event_name`, `tool_name`, `tool_input` (`{command, description}` for Bash),
  `permission_suggestions`. The hook env carries `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_MESSAGING_SOCKET` and, in tmux, `TMUX` and `TMUX_PANE` (`…/001-PermissionRequest.env`).
- **The terminal permission menu is up while the hook runs.** Hook started at …998545, the menu was
  visible at …999257, the hook was SIGTERMed at its 5 s timeout at …003512
  (`06-…/hooks/log.tsv`, `timeline.txt`). The Notification hook (`notification_type:
  "permission_prompt"`, "Claude needs your permission") fires about 1 s after the kill.
- **A hook reply after the timeout is ignored.** The killed hook printed its allow at +20 s; the menu
  was still up 22 s later (`06-…/after-late-reply-screen.txt`, `timeline.txt`). A forked child
  holding the same stdout and writing the allow after the kill is ignored too
  (`after-detached-late-reply-screen.txt`). The hook is not re-invoked for the same prompt.
- **A reply inside the timeout answers it:** the transcript shows `Allowed by PermissionRequest
  hook` and the session registry showed `waiting` for the two seconds the hook took
  (`06-…/control-hook-allowed-screen.txt`, `frames/index.tsv`).
- **AskUserQuestion** fires `PreToolUse` (tool `AskUserQuestion`, `tool_input.questions`) first; the
  dialog appears only after that hook returns or is killed at its timeout, then a `PermissionRequest`
  for `AskUserQuestion` fires too (`07-hook-timeout-ask/hooks/log.tsv`). A late `updatedInput`
  answers reply is ignored and the dialog stays (`07-…/after-late-reply-screen.txt`); the same reply
  inside the timeout answers the question with no dialog (`control-hook-answered-screen.txt`).
  Plan approval likewise fires `PreToolUse` then `PermissionRequest` for `ExitPlanMode`
  (`03-plan-approval/hooks/log.tsv`).

## (c) Is the asker still there? The session registry

Claude Code keeps `<config>/sessions/<pid>.json` per interactive process: `pid`, `sessionId`,
`cwd`, `startedAt`, `procStart`, `version`, `tmux` (`<session>:@<window>.%<pane>`),
`messagingSocketPath`, `name`, `status`, `statusUpdatedAt` and, while blocked, `waitingFor`
(`09-process-lifecycle/*-process.txt`).

| State | `status` | `waitingFor` | Evidence |
|---|---|---|---|
| idle at the input box | `idle` | — | `09-…/idle-process.txt` |
| running a tool | `busy` | — | `09-…/working-tool-running-process.txt` |
| permission or plan approval pending | `waiting` | `permission prompt` | `09-…/waiting-permission-process.txt`, `03-…/pending-process.txt` |
| AskUserQuestion pending | `waiting` | `input needed` | `04-…/pending-process.txt`, `05-…/pending-q1-process.txt` |

`waiting` covers the whole blocked time, including the seconds a PermissionRequest hook is
deciding — it says the harness is blocked, not that the terminal menu is the only way out. A clean
`/exit` removes both the JSON and `/tmp/cc-socks/<pid>.sock`
(`sessions-after-clean-exit.txt`); after `kill -9` both stay behind for a dead pid
(`sessions-after-sigkill.txt`). So "asker gone" is `kill -0 pid` plus a `procStart` match (pid
reuse), never the file's existence.

## (d) Keys sent with `tmux send-keys`

No tmux client is attached at any point, so focus plays no part.

| Input on a pending prompt | Result | Evidence |
|---|---|---|
| bare digit of a permission option (no Enter) | submits instantly | `01-bash-permission/after-digit-screen.txt`, `repo-after.txt` |
| `send-keys -l 1` (literal) | same as the bare digit | `08-key-handling/k1-after-literal-digit-1.txt` |
| digit that is not an option (`9`) | nothing; menu unchanged | `08-…/k1-after-nonoption-digit-9.txt` |
| digit while the pane is in copy-mode | swallowed by copy-mode; menu unchanged (`pane_in_mode=1` in the header) | `08-…/k1-after-digit-in-copy-mode.txt` |
| digit + `Enter` | digit answers, the Enter lands in the idle input box (empty, harmless) | `08-…/k2-after-digit-plus-enter.txt` |
| `Escape` | denies: `Interrupted · What should Claude do instead?`, transcript `[Request interrupted by user for tool use]` | `08-…/k3-after-escape.txt`, `k3-transcript-after-escape.txt` |
| `Down Down` then `Enter` | cursor to `3. No`, Enter denies (same transcript as Escape) | `08-…/k4-after-down-down.txt`, `k4-transcript-after-no.txt` |
| deny digit on Edit (`3`) | `User rejected update to README.md` | `02-edit-permission/after-deny-screen.txt` |
| `3` on plan approval | only moves the cursor to `Tell Claude what to change`; still pending | `03-plan-approval/after-deny-screen.txt` |
| AskUserQuestion: digit | selects that option and moves to the next tab (several questions); the review screen then needs Enter | `05-ask-multi/after-q1-digit-screen.txt`, `after-q2-digit-screen.txt`, `after-enter-screen.txt` |
| AskUserQuestion: `Down`, `Enter` | moves the cursor, Enter answers | `04-ask-single/after-down-screen.txt`, `after-enter-screen.txt` |

## The pending check

A Claude Code prompt is pending exactly when the capture has a `❯ N.` cursor row and no idle input
box below it. This held for every shape above, and every answered, denied, escaped or busy capture
in the study reads as not pending. `readPendingClaudePrompt` also reports the shape (from the marker
line), the options and the selected digit. Shapes the study did not capture (Write, WebFetch, MCP
permissions, other `Do you want to …?` menus) still read as pending, with kind `unknown`. Text alone
cannot see copy-mode: a caller that types into the pane must check `#{pane_in_mode}` or re-capture
after typing, as the permission pane-inject path already does.

## Other harnesses (side probes, not covered by the check)

- **opencode 1.18.20:** a shell permission renders `△ Permission required` / `# Shell command` /
  `Allow once   Allow always   Reject` with `⇆ select  enter confirm`; Enter on the default
  `Allow once` ran the command. Its server SSE stream reports `session.status` busy/idle/retry
  (`10-opencode/pending-screen.txt`, `sse-events.tsv`, `repo-after.txt`).
- **codex-cli 0.153.2:** the run never reached a permission prompt (the capture shows `Working`
  and no `out.txt` was written), so nothing is established for Codex
  (`11-codex/pending-screen.txt`, `repo-after.txt`).

## Not covered

- Write, WebFetch, MCP and other permission menus; Codex prompts.
- Answering in the terminal while a PermissionRequest hook is still waiting (the hook's fate then).
- Linux; Claude Code versions other than 2.1.261 (the layout is version-sensitive — re-run the
  scripts and refresh the fixtures on an upgrade).
- Wiring: the daemon's abandoned/queued card wording and late delivery do not use this check yet
  (tg-cli#304).
