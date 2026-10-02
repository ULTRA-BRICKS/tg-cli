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
  It is whitespace-collapsed but not length-truncated; the standard anchor
  format still appends the concluding `…`.
- **Item 3** — the anchor is `«[<date> <time>] <beginning of the message>…»`:
  the replied-to message's timestamp plus the start of its text and an ellipsis.
- **Original id (tg-cli#130)** — `tg#<id>` is `reply_to_message.message_id`, the
  Telegram id of the message you're answering (almost always the agent's own
  prior report). The whole-message fallback preview is truncated to 60 chars,
  so if the agent's context has compacted and that fallback preview isn't enough
  to place it, it can pull the full original back with
  `tg replies agent --all-sessions --json | jq
  '.[] | select(.id == 5975)'` (or `tg replies find <snippet>`) instead of
  guessing. Renders even when the id happens to be `0` in a test fixture — the
  token is never silently dropped for a falsy-but-present id.

When both apply, the partial selection is the quoted content and it still carries
the `[date time]` + `…` framing.

## `buildReplyAnchor(m, opts)` / `buildReplyInject(m, name, opts)` (pure)

1. `original` = `reply_to_message.text` (or `.caption`), whitespace-collapsed.
2. `selected` = `m.quote.text` (the partial selection), whitespace-collapsed.
3. If `selected` is non-empty, `head` = `selected + …` with no length cap.
4. Otherwise `head` = first `60` chars of `original` + `…` (always ellipsised
   — item 3).
5. `when` = `opts.fmtTime(reply_to_message.date)`; defaults to a deterministic
   **UTC** `YYYY-MM-DD HH:MM`. The daemon injects a **local-time** formatter so
   the human sees Belgrade time while the pure module + tests stay deterministic.
6. `origId` = `reply_to_message.message_id`, rendered `tg#<id> ` — same
   convention as the `{id}` substitution in `wrapInbound` (tg-cli#28).
7. Result (`buildReplyAnchor`): `↩ origId«[when] head»`. `buildReplyInject`
   appends a newline + the normal `wrap(name, replyText, m.message_id)` — note
   THIS is the reply's own id (for `tg --reply-to`), distinct from `origId`
   above (the message being answered).

## Routing into the step function

In `stepUpdates`, a text message that **is a reply** and whose text is **not a
`/command`** becomes a `reply-route` action carrying the replied-to message id +
the `buildReplyInject` text; a reply whose text starts with `/` still runs the
command verbatim (so you can reply `/stop` to a message).

## Reply routing: recognized origin vs LRU/MRU picker (v1.6.0)

`tg` records every outbound message id → `{paneId, cwd, ts}` into a bounded
routes map (`features/tg-ctl/routes.ts`, `tg-ctl.<botid>.routes.json`, tmux-only,
last 300). The daemon's `handleReplyRoute`:

- **Recognized** — the replied-to id maps to a pane that STILL hosts an agent →
  inject the reply (with its anchor) straight into that origin pane. This is the
  multi-agent fan-in: replying to agent X's report reaches X, not the last
  sender.
- **Unrecognized** (id not in the map, or the pane is gone) → show the
  session-grouped **window picker** ordered by **LRU+MRU**: most-recently-messaged
  panes first, send-frequency as the tiebreaker, panes with no history last. Both
  signals are derived from the same routes map (`aggregateUsage` + `orderByLruMru`)
  — no separate usage state. A single agent skips the picker and injects directly.

The picker reuses the `/agent` selection machinery (`pendingAgent`, `tga:`
callbacks); the reply's pending message is stored `prewrapped` so the tap injects
the anchored text verbatim (no double-wrap).

### No-reply auto-bind to the most-recently-active agent (tg-cli#75)

A plain message that is **not** a reply has no anchor to recognize, so it goes
through `discoverTarget` → `pickTargetPaneFromSet`. With several live agent panes
and no registration pinning one, that picker returns `ambiguous`. Rather than
immediately asking, `resolveAmbiguousByActivity` binds the message to the
**most-recently-active agent** — the pane whose last outbound `tg` send is newest,
the SAME `aggregateUsage` LRU/MRU signal the reply picker ranks by. The CTO almost
always means "the agent I was just talking to", so a fresh message after a burst
of activity lands there without a tap. Precedence is preserved: a recognized reply
route still wins first; the auto-bind only resolves an otherwise-ambiguous
**non-reply**; and when there is genuinely **no** "last agent" to prefer — no
activity history, or a tie at the most-recent timestamp — it stays ambiguous and
the button picker / ambiguous-target reply fires (the unscoped fail-closed). The
auto-bind REDUCES how often the picker fires; it never replaces it.

Both paths honor defer-while-waiting: a reply to a pane with an open question is
queued (✍️) and flushed when the question is answered (see
`docs/q-buttons-prerequisites.md`).

## Non-goals

- No multi-line `> quote` block — a single compact anchor line keeps the
  injected prompt readable (the full original is one tap away in Telegram).
- No forwarding of media in the replied-to message — text/caption only.
