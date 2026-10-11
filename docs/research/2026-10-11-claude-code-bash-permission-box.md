# How Claude Code draws a Bash command in its permission box (tg-cli#283)

Date: 2026-10-11. Claude Code 2.1.296 (npm `@anthropic-ai/claude-code`), tmux 3.6a, Linux.
Captures: `docs/cc-tmux-evidence/283-multiline-bash/<scenario>/` (`pending-J.txt` is
`tmux capture-pane -p -J`, the daemon's own capture; `pending-e.txt` keeps the colours;
`second-J.txt` is the next prompt after pressing `1` on the first).

## Method

`tools/cc-study/283-multiline-bash/`: the real `claude` binary runs in a private tmux server
with a throwaway `HOME`/`CLAUDE_CONFIG_DIR`, `--permission-mode default`, and
`ANTHROPIC_BASE_URL` pointed at `fake-api.ts`, a scripted Messages API that answers with the
Bash tool calls in `scenarios.json` (a fake API key; no login, no Anthropic traffic). The
model is scripted; the screen is drawn by Claude Code. Re-run: `bun fake-api.ts &` then
`CLAUDE_BIN=… ./run.sh <scenario> [approve]` (`WIDTH=80` for `width`).

## Findings

1. **The command sits between two dashed rules (`╌`, full pane width), directly above the menu.**
   The description (`tool_input.description`, or `Run shell command` when absent) is ABOVE the
   upper rule, under `Bash command` and a tip line (`single`, `ml3`, `ml3nodesc`). At most a
   `This command requires approval` line separates the lower rule from `Do you want to proceed?`
   (`ml3`). This differs from 2.1.261 (#304 study, `bash-pending`): there the command came first
   at a 3-space indent with the description UNDER it and no rules.
2. **A short one-line command is one unprefixed row** (` echo study-283 > out.txt`, `single`).
3. **A multi-line command is one ` │ ` row per line**, between the same rules; a blank line is
   ` │`, indentation after the `│ ` is kept (`heredoc`, `ml3`).
4. **Claude Code wraps long rows itself, and a wrapped row is ALSO a ` │ ` row** — the same shape
   as a real newline (`wide`, `longsingle`: a single-line `touch file000.txt … file039.txt` is
   three ` │ ` rows). Content width = rule width − 4 (`width`, 80 columns: 76 characters fit,
   77 wrap; a word that does not fit moves down whole, a word longer than a row is cut).
   `-J` does not join these: they are real rows Claude Code printed, not tmux wraps.
5. **Whitespace is not shown faithfully.** A tab is expanded to the next multiple of 8 columns
   from the start of the command line (`midtab`, `tabs`); trailing spaces are invisible; a run of
   spaces long enough to fill a row wraps into rows that look exactly like separate lines
   (`spacerun`: `touch xyz` + 400 spaces + `uvw` shows as `touch xyz` / blank / indented `uvw`).
6. **A command taller than the pane loses its top**: the alternate screen keeps no history, so
   the description and the upper rule are simply not in any capture (`longhd`, 42 rows in 50 lines).
7. **Older commands do not stay above as boxes.** After approving one prompt the transcript area
   shows the NEXT command's echo (`  ⎿  $ touch live-one.txt` / `     touch live-two.txt`) right
   above the new box (`stale/second-J.txt`, `two/second-J.txt`).
8. **The description is model-written text on its own row** inside the 12-line context
   (`descspoof`: description `touch harmless.txt` over a live `touch live-one.txt` /
   `touch live-two.txt`).

## Consequences for `permission-menu.ts`

Before this change, a tap was bound to the live menu when ANY whitespace-normalized line of the
12 lines above `Do you want to proceed?` equalled the request's command. On 2.1.296 that
approves a different command: the description row (finding 8) and the transcript echo of the
live command (finding 7) are both such lines (`descspoof`, `stale/second-J.txt`). A multi-line
command never matched at all (finding 3: its rows carry `│`).

`permission-menu.ts` (same PR, tg-cli#283) therefore reads the command block structurally: the
rows between the two rules directly above the live marker, and a tap matches only when those
rows equal the command's lines exactly (tabs expanded per finding 5, trailing whitespace
ignored), every row is visible (finding 6), nothing is shown shortened, no row before the last
ends in `\` (a hidden trailing space after it would end the line instead of continuing it —
`continuation`), and no row break could be a word wrap (finding 4). Finding 5's space-run wrap
cannot be told from a real newline on screen at all: tg-cli#683.
