# tg-cli — autolink-tasks feature spec

Repo: `~/.files/repos/tg-cli`. Feature lives in `features/autolink-tasks/`, tests in
`tests/autolink.test.ts`. Built on top of the auto-attach architecture (feature flags,
`renderText` hook, post-render SendPlan transforms).

## North star

Ticket-like codes in the message text (e.g. `HYP-576`) are verified against Linear via
the `linear` CLI (schpet/linear-cli) and turned into links. The ticket title is surfaced:
on the first line for a single ticket, as a collapsed reference block for several.
ON by default, toggled like any feature: `--no-feature autolink-tasks` or
`features: { autolink-tasks: false }` in `~/.config/tg-cli/config.yaml`.

## Detection

- A ticket code is exactly **3 uppercase Latin letters, a dash, then digits**, written
  as one token: `[A-Z]{3}-[0-9]+`.
- Boundaries: the char before/after the match must not be alphanumeric — `XHYP-576`,
  `HYP-576a` are NOT codes; `(HYP-576)`, `HYP-576,`, `HYP-576.` are.
- Tokens containing `://` are skipped entirely: a pasted URL
  (`https://linear.app/glide-vc/issue/HYP-576/slug`) must never be linkified inside.
- A code embedded in a file-path-looking token is a FILE mention, not a ticket:
  `HYP-123.ts:10`, `src/HYP-124/x.ts` are skipped (this also keeps line-spec quote
  anchors contiguous — codex review finding). A trailing sentence period
  (`fixed HYP-576.`) still counts.
- Codes are deduplicated preserving first-appearance order.
- Detection runs on the decoded caption (after `\n` escapes), BEFORE extraction/render.
  The tmux `[window]` prefix is NOT scanned (metadata, not message text).

## `--title` guard

`--title` is a one-line header (`✳️ [window] <title>`) that is never linkified, so a
ticket code there is inert and only duplicates a reference the reader can follow in the
body. `tg` refuses such a send at parse time (usage error, exit 1, nothing sent):
`Refusing: --title contains a ticket reference (HYP-1234) — move it into the message body.`

- Detection is the SAME `detectTicketCodesExpanded` the body linkifies with (exactly
  `[A-Z]{3}-[0-9]+`), so a compound list such as `HYP-1/2/3` is caught too; the FIRST
  detected code names the offender.
- Coupled to this feature's flag: with `--no-feature autolink-tasks` (or
  `features: { autolink-tasks: false }`) a code is inert plain text in title AND body, so
  the title guard is off as well — never banned in one place and allowed in the other.
- GitHub-style `#N` is not a ticket code and stays allowed (`closes #42` is a legitimate
  title). The sibling `tg#<id>` title refusal is coupled to `autolink-msgrefs` the same way.

## Verification (linear CLI)

One live Linear probe per send, only when detection found codes. The probe runs
`linear api '<GraphQL>'` once, with one immediate retry using the same query if the
first attempt fails unexpectedly:

```
query { issues(filter: { or: [
  { and: [ { team: { key: { eq: "HYP" } } }, { number: { in: [576, 99999] } } ] },
  ...one and-clause per team key...
] }, first: 250) { nodes { identifier title url } } }
```

- Codes are grouped by team key; numbers with >9 digits are dropped (parseInt precision;
  no real Linear issue number is that long).
- Issues missing in Linear simply don't come back → those codes are **ignored** (stay
  plain text). This also survives the aliased-`issue(id:)` pitfall: a single missing id
  there nukes the whole response (`data: null`), the filter query does not.
- Spawn timeout 10s per attempt. A transient unexpected failure is retried once; if
  the retry also fails, the message is sent UNCHANGED with a one-line stderr warning.
  Autolink must never block or fail a send.

### CLI missing / not authenticated → hint ONCE

- Spawn fails (binary not found) → stderr hint to install:
  `brew install schpet/tap/linear` (NOT bare `brew install linear` — that's the desktop
  app cask). Shown ONCE ever, recorded in `~/.config/tg-cli/autolink-tasks.json`
  (`{"install": true}`).
- Exit ≠ 0 with `No API key configured` / `No workspaces configured` in output → stderr
  hint to run `linear auth login`. Also shown once (`{"login": true}`).
- The hint state file is best-effort: unreadable/corrupt → treated as empty; write
  failures are swallowed.
- In both cases the message is sent unchanged.

## Rendering (post-render transform, like line-spec quotes)

When ≥1 detected code resolves to a real ticket, the render is forced to HTML (same
mechanism as `hasQuotes`: plain prose gets `&<>`-escaped). The transform then runs on
`plan.textMessages[0]` — which also covers the media-caption ride, since the transmitter
promotes that same message to a caption. It runs BEFORE line-spec quote insertion so
injected `<pre>` quote bodies are never linkified.

1. **Linkify**: every occurrence of a verified code in text segments becomes
   `<a href="URL">CODE</a>`. Skipped inside existing tags, inside `<a>…</a>` text
   (no nested links), inside `<pre>`/`<code>` (Telegram forbids nested entities),
   and inside `://` tokens.
2. **Single ticket** → its title goes on the FIRST line:
   - with an `<emoji> [window]` prefix line: appended to that line — `✳️ [win] Title`;
   - without a prefix: the title becomes its own first line above the text.
   Title is HTML-escaped.
3. **Several tickets** → a collapsed reference block appended at the end:
   `<blockquote expandable>` with one `<a href>CODE</a>: title` line per ticket, in
   first-appearance order.

Edge cases:
- All prose stripped by R2/R4 → no text message → transform skipped silently.
- A code whose only mention sat inside an extracted (R4) block: linkify finds no
  occurrence (no-op), but the title line / reference block still applies — the ticket
  WAS mentioned in the original text.
- Window name containing a verified code gets linkified too (harmless, deliberate).

## Non-goals

- No write operations against Linear, ever.
- No scanning of attachments' contents.
- Lowercase codes (`hyp-576`) are not tickets.
- No second hint after the first (per kind), even across months.

## v1.2 amendment: response cache

Linear API calls are cached to avoid spawning a `linear api` subprocess on every `tg`
invocation when the same codes appear repeatedly (common in agent workflows that send
multiple progress updates per task).

### Cache location and TTL

- File: `~/.cache/tg-cli/linear-cache.json`
- TTL: **1 hour** per entry, measured from the time of the last verified lookup.
- The cache directory is created on first write if absent.

### What is cached

Both **positive** (ticket found, title + URL stored) and **negative** (ticket confirmed
absent from Linear) verdicts are cached. Negative caching is intentional: an unknown code
is not retried on every send — it stays absent for 1 hour. This prevents repeated API
calls for typos or codes from other systems.

Cache shape: `{ entries: { "<CODE>": { t: <unix ms>, info: TicketInfo | null } } }` —
`info: null` is a cached verified-absent verdict. Expired entries are pruned on write.

### Behavior

1. On each send, all detected codes are looked up in the cache.
2. Only codes with no valid (non-expired) cache entry trigger a `linear api` spawn.
3. If all codes hit the cache, no subprocess is spawned at all.
4. Fresh results from the API are merged back and written with a plain best-effort
   `writeFileSync` (no atomic rename — a torn write just parses as corrupt and the
   cache self-heals on the next probe).

### Degradation policy

Cache read/write failures (permission error, corrupt JSON, disk full) are caught and
swallowed silently. The feature degrades to the pre-cache behavior: spawn `linear api` for
all codes on that invocation. A failed write does not retry and does not block the send.
Cache errors are never surfaced to the user.
