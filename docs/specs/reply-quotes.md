# tg-cli — reply quotes forwarded into the agent (items 2, 3)

Repo: `~/.files/repos/tg-cli`. Pure logic in `features/tg-ctl/updates.ts`
(`buildReplyInject`), tests in `tests/ctl-reply-quote.test.ts`. Telegram shapes
in `features/tg-ctl/types.ts` (`reply_to_message`, `quote`).

## North star

When you **reply** (Telegram reply) to a message in the control chat — typically
an agent's own report — the agent should see *what you are answering*. The daemon
injects the reply with a one-line quote anchor:

```
↩ tg#5975 «[2026-06-12 14:30] migrated the DB…»
[TG from Alex] fix this — reply via tg
```

- **Item 2** — if you highlighted a **partial quote** (Telegram's quote
  selection, `message.quote.text`), that exact selection is the forwarded quote.
- **Item 3** — the anchor is `«[<date> <time>] <beginning of the message>…»`:
  the replied-to message's timestamp plus the start of its text and an ellipsis.
- **Original id (tg-cli#130)** — `tg#<id>` is `reply_to_message.message_id`, the
  Telegram id of the message you're answering (almost always the agent's own
  prior report). The `head` preview is truncated to 60 chars, so if the agent's
  context has compacted and the preview isn't enough to place it, it can pull
  the full original back with `tg replies agent --all-sessions --json | jq
  '.[] | select(.id == 5975)'` (or `tg replies find <snippet>`) instead of
  guessing. Renders even when the id happens to be `0` in a test fixture — the
  token is never silently dropped for a falsy-but-present id.

When both apply, the partial selection is the quoted content and it still carries
the `[date time]` + `…` framing.

## `buildReplyAnchor(m, opts)` / `buildReplyInject(m, name, opts)` (pure)

1. `original` = `reply_to_message.text`, else `.caption`, else the flattened
   `.rich_message.blocks` text (tg-cli#461 — a report sent via `sendRichMessage`
   has NO `text`; its paragraphs/headings/list items/table cells/captions are
   joined in reading order, `features/tg-ctl/reply-preview.ts`), whitespace-collapsed.
2. `selected` = `m.quote.text` (the partial selection), whitespace-collapsed.
3. `body` = `selected || original` — item 2 wins when a selection exists.
4. `head` = first `60` chars of `body` + `…` (always ellipsised — item 3). When
   `body` is empty, `head` = a media label of the replied-to message
   (`[photo]`, `[document report.pdf]`, `[voice note]`, `[sticker 👍]`, …), with no
   ellipsis.
5. `when` = `opts.fmtTime(reply_to_message.date)`; defaults to a deterministic
   **UTC** `YYYY-MM-DD HH:MM`. The daemon injects a **local-time** formatter so
   the human sees Belgrade time while the pure module + tests stay deterministic.
6. `origId` = `reply_to_message.message_id`, rendered `tg#<id> ` — same
   convention as the `{id}` substitution in `wrapInbound` (tg-cli#28).
7. Result (`buildReplyAnchor`): `↩ origId«[when] head»`; when there is no `head`
   at all (no text, no known media) the quote is omitted: just `↩ tg#<id>` —
   never an empty `«[when] …»` (tg-cli#461). `buildReplyInject`
   appends a newline + the normal `wrap(name, replyText, m.message_id)` — note
   THIS is the reply's own id (for `tg --reply-to`), distinct from `origId`
   above (the message being answered).

## Routing into the step function

In `stepUpdates`, a text message that **is a reply** and whose text is **not a
`/command`** becomes a `reply-route` action carrying the replied-to message id +
the `buildReplyInject` text; a reply whose text starts with `/` still runs the
command verbatim (so you can reply `/stop` to a message).

A **`!shell` reply is a special case** (codex #192): it also becomes a
`reply-route` (so it runs in the replied-to origin pane, not the default
last-message pane), but its `injectText` is the **raw `!…` text** — no wrap, no
quote anchor — so `!` stays at column 0 for the harness passthrough. The daemon's
history-stamping predicate (`isRoutedReply` in `tg-ctl`) mirrors this: a text
reply is stamped under its origin pane iff it is **not a `/command`** (which
includes `!shell`).

Photo/document replies first become `download-media` actions because the daemon
must fetch the file before it knows the local path to inject. The action still
carries the same `replyToMessageId` + `replyAnchor`; after download the executor
wraps `sent photo: <path>` / `sent file: <path>` plus the caption, prepends the
anchor, and hands it to the same `reply-route` handler. A screenshot reply to an
`ext` report therefore reaches `ext`, not the last active/default pane.
Exception: when the media caption itself starts with `/agent ...`, the explicit
agent selector wins over the replied-to origin. In that case the daemon routes
the media receipt as a `/agent` command and does not prepend the reply anchor.

## Reply routing: recognized origin vs LRU/MRU picker (v1.6.0)

`tg` records every outbound message id → `{paneId, cwd, ts}` into a bounded
routes map (`features/tg-ctl/routes.ts`, `tg-ctl.<botid>.routes.json`, tmux pane or `omp:<pid>`
last 300). The daemon's `handleReplyRoute`:

- **Recognized** — the replied-to id maps to a pane that STILL hosts an agent →
  inject the reply (with its anchor) straight into that origin pane. This is the
  multi-agent fan-in: replying to agent X's report reaches X, not the last
  sender.
- **Recognized, origin gone** (a disposable one-shot sender that exited — a nested
  `omp --print`, a headless script) → the reply goes to the route's **lineage
  parent** when `tg` recorded one and it is still a live candidate, with a visible
  `↩️ <origin> is gone — routed to <label>, the session that started it` notice.
  `tg` records `parentPaneId` (`omp:<pid>`) only from the process tree: running
  outside tmux, the nearest agent ancestor is an omp (the route origin) and a
  further omp ancestor started it. A live agent that merely shares the dead
  sender's cwd is **never** its parent — unrelated sessions share `/tmp` or a
  repository root, and the old exact-cwd guess (#423) typed replies into them
  (#503). No recorded or live parent → the picker below, with a named
  "that agent is no longer running" notice.
- **Unrecognized** (id not in the map) → show the
  session-grouped **window picker** ordered by **LRU+MRU**: most-recently-messaged
  panes first, send-frequency as the tiebreaker, panes with no history last. Both
  signals are derived from the same routes map (`aggregateUsage` + `orderByLruMru`)
  — no separate usage state. A single agent skips the picker and injects directly.

The picker reuses the `/agent` selection machinery (`pendingAgent`, `tga:`
callbacks); the reply's pending message is stored `prewrapped` so the tap injects
the anchored text verbatim (no double-wrap).

### No-reply auto-bind to the CTO's own last-addressed pane (tg-cli#78)

A plain message that is **not** a reply has no anchor to recognize, so it goes
through `discoverTarget` → `pickTargetPaneFromSet`. With several live agent panes
and no registration pinning one, that picker returns `ambiguous`. Rather than
immediately asking, `discoverForInject` binds the message to the pane of the
**CTO's own last resolved inbound delivery** — persisted in
`tg-ctl.<bot>.last-user-target.json` (`features/tg-ctl/last-user-target.ts`) and
written ONLY on a confirmed delivery: an auto-bound inject, an explicit picker
tap, a named `/agent`, or a recognized reply — never on a failed inject, and
never on an agent's own outbound send. `resolveTasksScopeDir` (the `/tasks`
command's ambiguous-fleet default) shares this SAME anchor, so both surfaces
agree on "the default target".

This deliberately does **not** track "whoever spoke last" (an earlier mechanism,
`lastMessagePane` over the outbound-send routes map): an unrelated agent
proactively messaging the CTO could otherwise hijack his very next message —
the live incident this fix closes. `resolveLastUserTarget` also guards against
tmux pane-id reuse: the anchor's recorded cwd must match the live candidate's
`pane_current_path` (mirroring `routeMatchesPane`'s reply-route protection,
including rejecting an EMPTY live path, which would otherwise resolve to the
daemon's own cwd) — a stale/mismatched anchor is rejected, not trusted on
paneId alone.

Precedence is preserved: a recognized reply route still wins first; the
auto-bind only resolves an otherwise-ambiguous **non-reply**; and when there is
genuinely **no** anchor to prefer — none recorded yet, or its pane is
gone/pane-id-reused — it stays ambiguous and the button picker / ambiguous-target
reply fires (the unscoped fail-closed). The auto-bind REDUCES how often the
picker fires; it never replaces it.

Both paths honor defer-while-waiting: a reply to a pane with an open question is
queued (✍️) and flushed when the question is answered or released with no other
live question owning that pane. Successful deferred delivery flips the source
reaction to 👀 (see `docs/q-buttons-prerequisites.md`).

## Non-goals

- No multi-line `> quote` block — a single compact anchor line keeps the
  injected prompt readable (the full original is one tap away in Telegram).
- No forwarding of media in the replied-to message — text/caption only.
