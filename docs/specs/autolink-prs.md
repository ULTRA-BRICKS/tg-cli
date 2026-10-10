# tg-cli — autolink-prs feature spec

Repo: `~/.files/repos/tg-cli`. Feature lives in `features/autolink-prs/`, tests in
`tests/autolink-prs.test.ts`. Sibling of `autolink-tasks` (docs/specs/autolink-tasks.md):
the same detection → verify → cache → render pipeline, but for Forgejo `#N` references
instead of Linear ticket codes. The two features compose — a single message can carry
Linear tickets, Forgejo issues, and Forgejo PRs at once.

## North star

Forgejo-style references in the message text (e.g. `#260`) are verified against the
Forgejo repo the send was launched from (its `origin` remote) and turned into links. The
reference title is surfaced in a collapsed reference block at the END of the message.
Forgejo's `GET /repos/{owner}/{repo}/issues/{n}` resolves a `#N` to EITHER an Issue or a
Pull Request (a PR carries a `pull_request` block):

- **Issues** are merged INTO the `autolink-tasks` ticket reference block (issues and
  tickets are "work items" — they read the same way: `#260 — Title`).
- **Pull requests** ALWAYS get their OWN separate collapsed block, placed AFTER the
  tickets/issues block, even for a single PR (`PRs:` header, with a state annotation
  like `(merged)` / `(draft)`).

ON by default, toggled like any feature: `--no-feature autolink-prs` or
`features: { autolink-prs: false }` in `~/.config/tg-cli/config.yaml`.

## Detection

- A reference is a `#` immediately followed by digits, written as one token: `#[1-9][0-9]*`.
  `#0` is not a thing on GitHub — the leading digit must be `1-9`.
- Boundaries: the char before/after the match must not be alphanumeric — `x#1`, `#1a` are
  NOT references; `(#260)`, `#260,`, `#260.` are. (Mirrors the ticket boundary rules.)
- Tokens containing `://` are skipped entirely: a pasted GitHub URL
  (`https://github.com/owner/repo/pull/260`) must never be linkified inside.
- References are deduplicated preserving first-appearance order (by number).
- Detection runs on the decoded caption (after `\n` escapes), BEFORE extraction/render.
  The tmux `[window]` prefix is NOT scanned (metadata, not message text).

## Verification (Forgejo REST API)

fj 0.6.0 prints human-readable text only (no JSON mode), so tg calls the Forgejo REST API
directly (`features/forgejo/client.ts`) with the credential fj stores in its key store
(`$XDG_DATA_HOME/forgejo-cli/keys.json`; one `fj auth login` covers both tools). Only when
detection found references:

1. **Repo identity**: `git remote get-url origin` in the send's cwd, parsed into host +
   `owner/name`. SSH remotes map to the web host through fj's `aliases` table. A
   github.com origin is not a Forgejo repo. An expired fj OAuth token is refreshed once by
   running `fj -H <host> whoami` (fj rewrites its key store).
2. **Per-ref resolve**: one `GET /api/v1/repos/{owner}/{repo}/issues/{n}` per cache miss,
   with `Authorization` + an explicit `User-Agent` (the forge's CDN front rejects
   requests without one). The credential goes only to the origin host; redirects are
   never followed.

- HTTP 404 is a verified absence (the `#N` stays plain text and is cached as absent).
- Each resolved ref carries its kind (`pull_request` present → PR), title, `html_url`,
  state (`OPEN` / `CLOSED` / `MERGED` when `pull_request.merged`) and — for PRs — draft.
- Lookups run 6 at a time, each request bounded at 5s, the whole batch at 8s (a long
  `#1..100` range on a cold cache cannot hold the send). On timeout/any unexpected failure
  the message is sent UNCHANGED with a one-line stderr warning. Autolink must never block
  or fail a send.

### Degradation (mirrors autolink-tasks linear.ts)

Every failure mode is a distinct status and keeps the send going as plain text:

- **no-auth** — no fj credential for the origin host, an OAuth token that stays expired
  after a refresh, or HTTP 401/403. One-time stderr hint to run `fj -H <host> auth login`.
- **no-repo** — no git checkout, no `origin`, or a non-Forgejo (e.g. github.com) origin.
  Silent (no hint — not actionable, and such a cwd is normal); the send proceeds plain.
- **error** — anything else (network, other HTTP status, malformed response): one-line
  stderr warning. The whole batch is dropped — a partial lookup is never cached as absent.

The one-time hint REUSES the existing `autolink-tasks` hint-state mechanism
(`features/autolink-tasks/state.ts`, file `~/.config/tg-cli/autolink-tasks.json`) with the
`'forgejo-login'` kind; the state-file parser stays backward-compatible (old
`{install,login}` files still parse).

## Caching (mirrors autolink-tasks cache.ts)

- File: `~/.cache/tg-cli/forgejo-cache.json` (separate from `linear-cache.json`).
- TTL: **1 hour** per entry.
- Both **positive** (resolved ref stored) and **negative** (confirmed-absent) verdicts are
  cached — a missing `#N` is not re-probed every send.
- **CRITICAL — cache key includes the repo**: the key is `<host>/<owner>/<repo>#<number>`.
  The same `#260` means a different thing in a different repo, so a bare `#260` key would
  be a correctness bug. The repo identity from step 1 is folded into every key.
- Cache shape: `{ entries: { "<host>/<owner>/<repo>#<N>": { t: <unix ms>, info: GhRef | null } } }`.
  Expired entries are pruned on write. Read/write failures degrade silently to a live probe.

## Rendering (post-render transform)

When ≥1 detected reference resolves, the render is forced to HTML (same mechanism as
`hasTickets`/`hasQuotes`). The transform runs on `plan.textMessages[0]` BEFORE line-spec
quote insertion. Both plain-text and `--format html` sends are supported identically — the
forced-HTML body is already escaped by the time the transform runs, exactly like
autolink-tasks.

1. **Linkify**: every occurrence of a verified `#N` in text segments becomes
   `<a href="URL">#N</a>` — Issues and PRs alike. Uses the same segment-safety walk as
   autolink-tasks (no linkify inside `<a>`, `<pre>`/`<code>`, tag attributes, or `://`
   tokens). The autolink-tasks `linkifyCodes` segment walker is reused via a shared
   linkify over a generic ref table.
2. **Issues → tickets block**: resolved issues are appended to the SAME collapsed
   `<blockquote expandable>` that autolink-tasks builds for its tickets, formatted
   `<a href>#260</a> — Title`. Tickets come first (first-appearance order), then issues
   (first-appearance order). If there is exactly one ticket and zero issues, the
   single-ticket "title on the first line" behavior of autolink-tasks is unchanged; a
   present issue forces the block form (issues never go on the first line).
3. **PRs → own block**: resolved PRs ALWAYS get a separate collapsed
   `<blockquote expandable>` AFTER the tickets/issues block, even for a single PR:
   `PRs:` on the first line, then one `<a href>#N</a> — Title (state)` line per PR in
   first-appearance order. State annotation: `(merged)` / `(closed)` / `(draft)` for an
   open draft / `(open)`.

Both the issue→tickets merge and the PR block are produced by extending the autolink-tasks
`applyAutolink` contract so the two features compose in one pass over the body.

## Non-goals

- No write operations against Forgejo, ever (read-only issue GETs).
- No scanning of attachments' contents.
- `#0` and non-numeric `#x` are not references.
- No cross-repo references — `#N` is always resolved against the send's cwd repo only.
- No second hint after the first (per kind), even across months.
