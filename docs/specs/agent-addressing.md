# tg-cli — /agent addressing (item 1)

Repo: `~/.files/repos/tg-cli`. Pure logic in `features/tg-ctl/agent-match.ts`,
tests in `tests/agent-match.test.ts` + `tests/ctl-agent-route.test.ts`. Daemon
wiring in `tg-ctl` (`listAgentCandidates`, `handleAgentRoute`,
`handleAgentCallback`); command + callback routing in
`features/tg-ctl/updates.ts`.

## North star

A new inbound command lets you address a **specific** agent from Telegram when
several agents run side by side:

```
/agent [<window>] <message>
```

- `<window>` is fuzzy-matched (phonetic) against tmux window names.
- A confident unique match routes `<message>` straight to that agent's pane.
- Ambiguous / no selector → inline **selection buttons**, grouped by
  tmux session, each carrying the pending message; the tap injects it.
- **No match** (selector given but nothing matched) → error reply naming the
  selector and the running agents; the message is **not** delivered.
- Bare `/agent` → an inline-keyboard **picker** (tappable buttons), one
  distinct-labelled button per addressable agent. A tap arms a one-shot route:
  the next ordinary inbound message goes to that selected agent. The confirmation
  card keeps a `Cancel` button to clear the pending route before anything is sent.

This complements the existing default routing (the per-pane registration set —
every live session that ran `tg` is registered; tg-cli#67): `/agent` is the
explicit override when the auto-picked target is not who you mean.

## Command grammar

`parseAgentCommand(text)` → `{ selector, rest, all }`:

- `selector` = the first whitespace token after `/agent` (a *possible* window),
  or `null` for bare `/agent`.
- `rest` = the message when `selector` IS a window (everything after it).
- `all` = the message when there is NO selector (everything after `/agent`).

The daemon decides which interpretation holds *after* matching, because only it
knows the live window names. Tolerates `/agent@botname` (group chats).

The same command grammar applies when `/agent ...` is the **caption** of an
inbound photo/document. Telegram delivers that as media, not as text, so
`stepUpdates` keeps the parsed agent route on the `download-media` action. After
the daemon downloads the file, it injects the pre-wrapped
`sent photo: <local-path>` / `sent file: <local-path>` receipt plus the caption
body into the selected agent. The `/agent <selector>` command line itself is not
injected. Explicit caption routing wins over default last-active auto-bind and
over reply-route metadata. An album routes whole: its caption's `/agent` line moves every
file of the album, delivered as one `sent N photos:` receipt (tg-cli#280).

## Phonetic normalization

`phoneticKey(s)`:

1. lowercase + **Cyrillic→Latin transliteration** (so `апи`, `кодекс` match
   `api`, `codex`);
2. strip separators/spaces;
3. sound-equivalences: `ph→f`, `ck→k`, `qu→kw`, `x→ks`, hard `c→k`, `w→v`,
   `y→i`;
4. collapse doubled letters.

`matchWindows(selector, candidates)` scores each candidate against the selector
key — `0` exact · `1` prefix · `2` substring · `3+` within an edit-distance band
(`⌈maxlen/4⌉`) — and returns the tied best matches. `confident` = exactly one
best match → route without asking. The Cyrillic table makes a Russian-typed
selector usable; this is deliberately a *light* fold, not full Metaphone.

## Selection buttons

When a choice is needed (a bare `/agent`, OR an ambiguous route),
`buildAgentSelectMessage(chatId, candidates, token, preview)` builds a message
that is a SHORT prompt plus one inline button per candidate, each labelled with
`<label>`. The message text is the prompt ONLY — there is **no** per-agent text
list and **no** `▸ <session>` group header (both were redundant noise that just
duplicated the buttons; #63). The buttons carry the distinct labels; they stay
grouped by session for a stable row order. Callback data is `tga:<token>:<index>`
(index into the candidate list). `token` keys the daemon's `pendingAgent` store
(message + candidate subset + button message id + `selectOnly`), TTL 10 min. With
no `preview` (bare `/agent`) the prompt is `Pick an agent:`; with one it is
`Route to which agent?` followed by the quoted message preview.

### Distinct labels (`distinctLabels`)

`<label>` is NOT a bare `<window> · <agent>` — several `claude` panes in the same
numeric window (e.g. window "4", no window names set → all fall back to the
session name "4") would otherwise render as three identical `4 · claude` buttons,
impossible to tell apart (the reported bug). `distinctLabels(candidates)`:

- base = the session name from `resolveSessionName` (`session-name.ts`, the ONE
  resolver shared with the `tg` header, `tg-ctl status` and history, tg-cli#455):
  `<window> · <harness title>` when the pane shows a harness title (a live omp's
  endpoint/jsonl title, else a harness-painted `#{pane_title}` — omp `π > …`,
  Claude Code `✳ …`, marks stripped, cut to 40 chars), else `<window> · <agent>`.
  The tmux window name is NEVER replaced by the title. When the window name is
  **bare** (empty, numeric, a version string, or a shell/launcher/wrapper such as
  `zsh`/`node`/`bun`/`abduco`) it leads with the **cwd project dir**
  (`pane_current_path` basename) instead → `<project> · <agent>` (e.g. `rig`,
  `3d-cli`, `hyperide`);
- an omp shown in NO tmux pane (`omp:<pid>` row) is named by its title, else its
  cwd project, else `omp · <sid8|pid>`, with the project appended when the title
  does not contain it;
- any label still shared by >1 candidate gets the project appended, then — as the
  last-resort, always-unique distinguisher — the pane id (`%N`).

An abduco-wrapped agent (rig `omp run`: the pane shows the abduco CLIENT, omp is the
child of a pid-1 abduco SERVER of the same session) is discovered as that pane's
agent, so it gets a normal pane row and `/agent <window>` selects it (tg-cli#454).

`AgentCandidate` therefore carries `panePath` (the pane's cwd). `dedupeCandidates`
drops any pane id listed twice (a merged/flaky snapshot guard; pane ids are
unique per server, so it never collapses two real agents).

### Tap

A tap (`tga:…`) is parsed by `parseAgentCallback` and emitted as an
`agent-callback` action; the daemon looks up the token. For a **route** picker it
injects the pending message into `candidates[index]`'s pane (re-verifying the
pane still hosts an agent), answers the callback, and edits the prompt to
`→ <label>`. For a **bare-`/agent`** (`selectOnly`) picker there is no message to
inject yet: it answers `selected`, arms a one-shot route for the next ordinary
inbound message, and edits the prompt to `selected <label> — send the next
message here` with a `Cancel` button. A successful/queued/failed delivery edits
that same prompt to its final state and removes the button.

`tga:` callbacks are routed BEFORE `tgq:` (q→buttons) in `stepUpdates`, so the
two button systems never collide.

## Discovery (daemon)

`listAgentCandidates()` runs the same `snapshot()` (panes + process tree) the
target picker uses and finds every pane hosting an agent (`findAgentInPane`). The
window name comes from the core `PANE_FORMAT` itself — `#{window_name}` is a fixed
field carried through `parsePaneList` alongside the pane id (tg-cli#75). It used to
be a **separate** `tmux list-panes -F '#{pane_id}\t#{window_name}'` call, but that
call skipped the UTF-8 locale env, so under launchd the tab-mangle blanked every
name and the picker fell back to the cwd basename; folding it into the locale-safe,
retried core snapshot fixed that. A pane with no name falls back to its session
name; a bare default (a number, a shell/launcher command, or a version string) is
treated as non-distinguishing and the label leans on the cwd project dir instead.

## Edge cases

- **No agents** → `NO_AGENT_REPLY`.
- **Single agent + a message** → injected directly, no buttons (asking would be
  silly).
- **Confident match but empty message** (`/agent feat-bot`) → reply naming the
  match and asking for the message; nothing injected.
- **Selector matches nothing** → error reply ("No agent matching X found. Running:
  …") is sent back to the user; the message is **not** delivered to any agent
  and the request ends there (no picker fallthrough).
- Injection always goes through `buildTextInjectPlan` (verify-pane → literal /
  bracketed-paste → paced Enter), so a pane that lost its agent is refused, not
  executed as a shell command.

## Non-goals / future

- The bare `/agent` selection is intentionally one-shot: it is remembered only
  until the next ordinary inbound message, `Cancel`, TTL expiry, or another
  explicit `/agent` command. (Earlier this was "lists only, no buttons"; the
  picker replaced the text list because three indistinguishable `4 · claude`
  rows were useless and there were no buttons to tap — CTO bug report.)
- No persistence of `pendingAgent` across a daemon restart (10-min in-memory TTL).
- When a bare-`/agent` button is tapped, the daemon re-runs `listAgentCandidates()`
  and verifies the handed-back selector against the FULL LIVE fleet at tap time
  (not the stale picker-time subset) — so the suggestion never points at a pane
  outside the original picker. The user then sends `/agent <selector> <message>`,
  re-resolved against the live fleet again; if the fleet changed between tap and
  send (an agent started/exited, a cwd changed) the selector may become ambiguous
  (→ the picker re-opens — safe) or, in the worst case, route to a different pane.
  That residual window is bounded by the 10-min TTL and is the same
  last-write-wins staleness the whole `/agent` flow already tolerates.
- The cwd is an EXACT-only tie-breaker, and only when no window name matched — a
  fuzzy or even prefix window-name token never silently routes via someone else's
  cwd (a short `/agent dev` won't land in a `…/development` project).
- After that exact cwd miss, a **unique project token** (hyphen/underscore/dot
  piece of length >= 4, or the full basename) may route: `/agent landing` hits
  the sole `conloca-landing` omp. A hyphenated selector with no token hit may
  then use a **unique first segment** (`/agent rig-fable` -> sole `rig-cli`).
  Ambiguous token/segment sets do not guess. Picker labels for an omp in no tmux
  pane append the project dir so those names stay visible next to the session title.
- Live end-to-end requires an inbound tap from the chat owner (the unit + step
  tests cover the logic; the button round-trip is the same mechanism as
  q→buttons, which has integration coverage).
