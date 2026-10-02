# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.30.2

**Fix (HYP-907): preserve selected Telegram reply quotes; enable private topics automatically.**

- When a Telegram reply includes a highlighted partial quote, `tg` now forwards
  the whole selected span into the agent quote anchor instead of truncating it to
  the whole-message preview limit.
- Whole-message reply fallback previews are still capped at 60 characters, and
  empty/whitespace-only selections fall back to that preview.
- `tg-ctl /new` now attempts private-chat topic creation by default via Bot API
  `createForumTopic`, with no special forum chat or BotFather setup step in the
  normal path. If Telegram rejects the API call, the daemon falls back to the flat
  `/new` spawn. Set `control.private_topics: false` to opt out.
- Updated the reply-quote and forum-topic specs to match current topic reply,
  daemon-command, topic-rename, and private-topic behavior.

## 1.30.0

**Feature (HYP-891 follow-up): empty-editor watermark WARN heuristic in `pre-send-photo`.**

- Added `looks_like_empty_vscode_watermark()` to
  `features/hooks/review-descriptor/pre_send_photo.py` — detects VS Code's own "no
  tabs open" watermark (a small, compact cluster of hint-row glyphs on an
  overwhelmingly flat background, centered in the editor pane), the signal Alex
  proposed (tg#6071) as a precise replacement for the removed 1.26.1 heuristic. Unlike
  that removed check (which matched ANY full window via a dark left activity-bar
  strip), this one is scoped to a central box and requires a small, compact glyph
  cluster on a flat field — real content (code, a rendered preview, a webview) cannot
  produce the pattern regardless of how busy the surrounding Explorer/Inspector/Logs
  panels are.
- **WARN-only, not a block** — a deliberate choice, not an automatic carry-over of the
  old block behavior. The detector's thresholds are reasoned from VS Code's known
  watermark layout, not calibrated against a captured reference screenshot; blocking
  on an unvalidated pixel heuristic is exactly the HYP-891 failure mode. It surfaces a
  stderr warning in the audit trail without bricking the send. Promoting it to a block
  is a follow-up once real false-positive/negative field data exists.
- New tests: `tests/hooks-watermark-detector.test.ts` (synthetic PIL fixtures — no
  real VS Code screenshot exists to calibrate against).
- `review diff` findings addressed pre-merge: background-color estimation is
  quantized-bucket based (not exact-tuple) to survive PNG/JPEG re-compression
  and font-AA noise; the compactness (span) check trims outlier coordinates
  instead of raw min/max so a single stray non-bg pixel elsewhere in the box
  can't blow the span up and hide the real cluster; the sample box was widened
  and shifted (20-90% W, 15-65% H, was a symmetric 28-72%/18-62%) because the
  watermark centers on the EDITOR PART, not the window — a symmetric box
  misses it on the common "Explorer open, nothing docked right" layout where
  the editor part sits right of window-center; the density lower bound was
  lowered 0.005 -> 0.001 (safety margin below a measured ~0.006 for a
  realistic sparse icon+text-row fixture) since real hint text could render
  thinner than that synthetic floor case; two test-fixture aliasing bugs
  were found and fixed where a draw pattern's pixel spacing shared a common
  factor with the detector's own WATERMARK_SAMPLE_STEP=3 sampling grid,
  making a fixture pass/fail for the wrong reason (a "dense random content"
  negative fixture, and an earlier "sparse glyph" positive fixture whose 1px
  rows landed on zero sampled pixels by phase) — both rewritten so every
  drawn stroke is >=3px in each dimension, which guarantees a grid hit
  regardless of phase, verified across multiple phase offsets.
- `from __future__ import annotations` (already present, first statement
  after the module docstring) makes the new `X | None` return annotations
  safe on Python <3.10 — confirmed, not changed; called out here because
  `review diff` flagged it twice without visibility into the file header
  (outside the diff hunk it reviews).
- Two more tests added post-review: an explicit symmetric check that a REAL,
  busy full-window screenshot produces zero watermark-related warnings
  end-to-end (only the positive/watermark-shaped path was covered before),
  and a documented KNOWN LIMITATION test — the detector cannot distinguish
  VS Code's specific watermark glyphs from any other small, compact UI
  element on a flat background (a centered dialog, a spinner, a toast, an
  almost-empty terminal, a lone logo on a white preview); this is an
  accepted false-positive surface for a WARN-only, unvalidated heuristic,
  now captured as an executable spec rather than tribal knowledge.
- Final review round: `_trimmed_span_ratio`'s outlier trim was silently a
  no-op for any n <= 19 (`int(n * 0.05) == 0` in that range) — fixed to
  guarantee at least one point trimmed off each end once there are enough
  points for that to leave a >=2-point core (n >= 4; a later fix tightened
  this from an initial >=1-point-core version, see below), with a direct
  unit test (a single far outlier no longer blows up the span).
  Tests now `test.skipIf(!pilAvailable)` the whole file — Pillow is a soft
  dependency of the hook itself, and hard-failing the suite when it's
  missing would make this file flap by environment, matching the existing
  `tmuxAvailable` skipIf pattern in `tests/ctl-tmux-integration.test.ts`.
- `WATERMARK_MAX_SPAN_RATIO` tightened 0.70/0.80 -> 0.35/0.40 (review
  finding): the old caps let a cluster cover up to 70-80% of the sample box
  and still count as "compact", effectively disabling the check the
  docstring/CHANGELOG claim distinguishes a watermark from real content.
  Every measured positive fixture spans <=0.26 on either axis; the new caps
  keep real margin above that while now correctly rejecting a moderate-
  spread pattern (two compact glyph-sized blocks ~54% of the box apart,
  density still in-range) that the old caps let through. New test locks in
  that specific boundary — previously only the two extremes (whole-box
  scatter, and density rejection) were covered, leaving the actual
  false-positive-prone middle ground untested.
- Performance (review finding): `_sample_box` had no upper bound on the
  cropped box before per-pixel `PixelAccess` sampling — a Retina/4K
  screenshot's box can be ~2700x1100, adding a few hundred ms of pure-Python
  work to every `pre-send-photo` send, unbounded and untimed (unlike the
  `review visual` subprocess call). Now caps the box's longest side at 1200px
  via `Image.Resampling.BOX` downscaling (area-averaging, so a thin stroke
  survives as a blended gray pixel instead of vanishing under a NEAREST
  gap) before sampling; the span/compactness ratios are scale-invariant, and
  the density ratio approximately so (walked back an earlier overclaim —
  area-averaging COULD blend a very thin stroke enough to fall inside
  WATERMARK_BG_TOL, nudging density down; accepted for a WARN-only,
  unvalidated heuristic). Verified on a synthetic 3840x2160 image: ~42ms
  (was unbounded), still detects the scaled-up cluster; new dedicated test
  exercises the resize branch (every other fixture is 1600x900, whose box is
  under the 1200px cap, so it was previously untested).
- `Image.Resampling` (the enum) only exists on Pillow >= 9.1 (review
  finding): on older Pillow, `Image.Resampling.BOX` raised AttributeError,
  silently swallowed by the detector's blanket fail-open `except Exception`
  — meaning it would NEVER fire on exactly the large screenshots the new cap
  targets, on any host with an older Pillow. Fixed with
  `getattr(Image, "Resampling", Image).BOX`, which falls back to the
  pre-9.1 flat `Image.BOX` constant.
- `_trimmed_span_ratio` degenerated to span=0 for any n where trimming left
  only a 1-point core (e.g. 3 points at [0, 500, 1000] trimmed to a single
  midpoint, reading as maximally "compact" regardless of real spread) —
  review finding. Fixed to require a >=2-point core before trimming at all.
  Unreachable through the full detector pipeline today (the density floor
  guarantees far more samples), but the function is documented and
  unit-tested as a general-purpose utility, so its own contract now holds
  independent of the caller.
- WARN message text softened (review finding): it named "VS Code's 'no tabs
  open' hint rows" unconditionally, but the detector runs on every
  `pre-send-photo` event, not just IDE screenshots — a compact logo on a
  plain background in an unrelated photo would get the same VS-Code-specific
  wording. Now hedged ("possible" / "consistent with") without changing the
  detection logic.
- `_trimmed_span_ratio` docstring now states its known limit explicitly
  (review finding): per-axis trimming caps at ~5% of the mass on each end,
  so it defends a LONE outlier, not a genuine minority second cluster below
  that fraction — accepted for a WARN-only heuristic; a real fix would need
  actual clustering, not a 1D span statistic.
- The "REAL-content full-window" end-to-end negative test also switched to a
  step-1 (every pixel) fill for the same aliasing reason as the unit-level
  "dense random content" test, so it exercises the density check too, not
  only the span check.
- Two more review nits fixed: the `_trimmed_span_ratio` unit test and the
  "unreadable path" fail-open test need only `python3`, not real Pillow —
  gating them on `pilAvailable` meant they'd silently skip in exactly the
  no-Pillow environment they exist to cover; split into a separate, narrower
  `pythonAvailable` check. And `runCapturingWarnings`'s PATH restore now
  guards the `savedPath === undefined` case explicitly instead of assigning
  `process.env.PATH = undefined`, which JS coerces to the literal string
  `"undefined"`.
- Last review pass — all cosmetic/test nits, no further correctness issues
  found: fixed a stale coord-count in the outlier unit test's comment (said
  "14 clustered / n=15", the array is 13 clustered + 1 outlier = n=14); the
  "PIL genuinely unavailable" test was gated on `pilAvailable` when it exists
  specifically to simulate Pillow's ABSENCE (same class of gate mismatch as
  the two tests fixed earlier) and referenced a real repo screenshot path
  that's never actually opened (the poisoned import raises first) — moved to
  `pythonAvailable`, path swapped for an explicit placeholder; added a direct
  `_trimmed_span_ratio([single point])` test locking in the n=1 edge case.
- `_trimmed_span_ratio`'s own degenerate case (a >=2-point-core requirement
  fix, above) now has a direct assertion: `[0, 500, 1000]` at n=3 must read
  as span 1.0 (not compact), not 0.0 — the exact case the fix's docstring
  names as motivation, previously only implied by the code, not asserted.
- `WATERMARK_BOX_MAX_DIM` only bounds the per-pixel SAMPLING loop, not the
  `Image.open(...).convert("RGB")` decode itself, which forces a full
  source-resolution decode first and has no timeout — unlike the amount of
  work capped by `WATERMARK_BOX_MAX_DIM`, unlike `review visual`'s
  subprocess call (review finding: a large phone photo sent through the
  same `pre-send-photo` point would add unbounded decode latency to every
  send). Added a cheap `os.path.getsize` guard (`WATERMARK_MAX_FILE_BYTES`
  = 20MB, no decode at all) that skips the heuristic outright above that
  size; ordinary screenshots are unaffected.
- Added a fixture combining BOTH conditions CHANGELOG flagged as an
  unverified false-negative risk together (a large/downscaled screenshot
  AND thin, realistic (not bulky-block) hint-row strokes) — previously the
  "4K" test used a solid block and the "thin strokes" test used a
  1600x900 source under the resize cap, so neither test alone proved BOX-
  averaging preserves a thin stroke through an actual downscale. It does:
  unscaled (absolute-pixel) strokes on a 4K canvas are proportionally
  smaller than the 1600x900 case, and still detect after the ~2.24x BOX
  downscale.
- The new `os.path.getsize` guard (above) still imported `from PIL import
  Image` BEFORE the guard's own check, so the "skip large files without
  decoding" short-circuit wasn't actually PIL-free -- a direct
  `_sample_box()` call in a no-Pillow environment would raise `ImportError`
  *outside* the fail-open wrapper (review finding), breaking exactly the
  `pythonAvailable`-without-Pillow test scenario the guard's own test is
  gated for. Reordered so the size check runs first; also extracted the
  downscale step into its own `_downscale_box_if_needed()` helper.
- That same reorder broke the "PIL genuinely unavailable" test's own intent
  (review finding): it used a nonexistent placeholder path, which now hits
  `os.path.getsize`'s `FileNotFoundError` and short-circuits BEFORE `from
  PIL import Image` ever runs — passing regardless of whether the poisoned
  `sys.modules['PIL'] = None` import actually fails, i.e. no longer testing
  what it claims to. Switched to the hook's own (small, existing) source
  file as the path, so `getsize` passes and the poisoned import is reached.
- `WATERMARK_MAX_FILE_BYTES` bounds the COMPRESSED size on disk, not the
  DECODED pixel count (review finding): a highly compressible source (e.g.
  flat-color, or a heavily-compressed JPEG) can be a few MB on disk yet
  decode to tens of megapixels, and `.convert("RGB")` forces that full
  decode with no timeout — there's no subprocess boundary here to enforce
  one, unlike `review visual`. Added `WATERMARK_MAX_PIXELS`, checked via
  `im.size` BEFORE `.convert("RGB")` (Pillow reads dimensions from the file
  header lazily, without a full pixel decode, so this check is cheap
  regardless of true resolution). Verified: a flat 8000x6000 (48MP) PNG
  compresses to <1MB — clears the byte guard, correctly rejected by the
  pixel guard. Set to 24M (~6000x4000, a common phone/DSLR resolution) —
  lowered from an initial 40M (review finding: still leaves worst-case
  decode+convert latency effectively open-ended for a legitimate-but-huge
  photo) to bound that cost to the low hundreds of ms.
- Added the e2e test the "watermark scan runs before the `review`-on-PATH
  check" comment in `main()` claimed but nothing exercised (review finding):
  an isolated PATH with no `review` binary at all (same isolation pattern as
  `hooks-review-descriptor.test.ts`'s "review missing on PATH" test) still
  produces the watermark WARN, proving that invariant instead of just
  asserting it in a comment.
- Two more test gaps closed (review finding): the `w < 800 or h < 500` floor
  was only tested from the "too small" side (400x300); added an exact
  800x500 fixture proving the strict `<` boundary doesn't accidentally skip
  the floor value itself. And a truncated/corrupt PNG (half the bytes of a
  valid file — `Image.open` succeeds lazily on the header, `.convert("RGB")`
  raises `OSError` partway through decode) now has a dedicated test proving
  that specific, arguably most-likely-in-practice failure mode is caught by
  the same blanket fail-open as every other error path, not a missed case.

## 1.29.2

**Fix (#141, closes #140): forward the outgoing photo caption as `--intent` to
`review visual`.** (Retroactive entry — #141 merged to main without a
CHANGELOG update; added here while reconciling it with the #133/HYP-891 branch
above, so the version ladder has no undocumented gap.)

- The pre-send-photo hook receives the outgoing caption in the event args
  (`args.caption`) but never forwarded it — `review visual` was always invoked
  as `[visual, image_path, --json, --strict]`, no `--intent`. review-cli's
  intent-gated contributed modules (e.g. `selection-highlight`'s hard CV veto)
  only activate when `--intent`/`--check` mentions their tag, so that whole
  activation path was inert for every tg-sent photo, in any language
  (tg#6188).
- `--intent=<value>` is forwarded as ONE argv token (not two) so a caption
  starting with `-`/`--` doesn't get misparsed by argparse as the next option.
- `_safe_intent()` sanitizes the caption before it reaches `--intent`: strips
  NUL bytes, trims to `_MAX_INTENT_CHARS` (4096), and pre-validates
  encodability — an unencodable caption (e.g. a lone UTF-16 surrogate) drops
  `--intent` rather than letting `subprocess.run`'s own `UnicodeEncodeError`
  (a `ValueError` subclass) crash the entire `review visual` call and
  silently disable verification for that photo. The `except` around
  `subprocess.run` is widened to `(OSError, ValueError)` to still fail open
  on `image_path`-side NUL bytes without that widening ever being reachable
  via a crafted `--intent` value.
- 18 tests in `tests/hooks-review-descriptor.test.ts`: canonical argv,
  non-English forwarding, leading-dash forwarding, whitespace trimming,
  embedded-NUL stripping, oversized-caption truncation, lone-surrogate
  handling (proves `review visual` still runs), and no-caption/blank-caption
  cases.

## 1.29.3

**Fix (HYP-891): remove the `pre-send-photo` full-window-screenshot block.**

- Removed `looks_like_vscode_window()` from
  `features/hooks/review-descriptor/pre_send_photo.py` — the pixel heuristic that
  hard-blocked EVERY full VS Code window screenshot (dark, uniform left activity-bar
  strip) regardless of whether the content inside it was actually broken. Added
  2026-07-01 (commit `87b4522`) to force cropped preview-pane proofs; superseded by
  Alex's 2026-07-03 standard (tg#6041) that full-window screenshots with
  Explorer/Inspector/Logs panels visible ARE the desired HyperIDE diagnostic proof
  format. The heuristic false-positived on legitimate full-window proofs at least
  twice in one day before removal — done at Alex's explicit direction (tg#6063/6064).
- `review visual --strict` (a vision-model verdict on the actual image content)
  remains the only gate left for a full-window send. Whether it reliably catches a
  broken/unstyled preview pane diluted behind busy editor chrome is UNVERIFIED —
  this is a known, accepted tradeoff, not a proven equivalent replacement. See the
  comment in `pre_send_photo.py` and HYP-891 for the follow-up if this needs
  strengthening later (e.g. a targeted vision check module scoped to the preview
  region instead of the whole window).

## 1.29.1

**Fix:** deferred `tg-ctl` messages now complete their Telegram reaction lifecycle.

- Messages queued behind an agent question still get the `✍️` queued reaction first,
  then flip to `👀` after the deferred text is successfully flushed into the agent pane.

## 1.29.0

**Feature (#138): `--title` refuses a `tg#<id>` reference.**

- `--title` is a one-line header that is never linkified downstream (unlike the
  body/caption, which the existing `autolink-msgrefs` feature handles). A `tg#<id>`
  typed there is dead text, so `parseArgs` now refuses it at parse time with a
  message pointing the reference at the body instead — the same rule task-cli/
  gh-ship enforce on a PR/ticket title.
- Gated on the same `autolink-msgrefs` feature flag the body-detection call uses:
  with the feature disabled, `--title` is exactly as permissive as the body.

## 1.28.1

**Fix (tg#6006): Telegram message references now link and carry compact excerpts.**

- `tg#<id>` and the already-rendered `𝒕𝒈#<id>` form are both detected in outbound
  `tg` messages. Supergroup/channel refs become `t.me/c/...` links; private-DM refs
  stay visibly styled but unlinked.
- When the referenced id exists in `tg replies` history, the outbound message adds a
  collapsed reference block with only the start of the original message plus `…` on
  truncation, rather than copying the whole referenced Telegram message. Excerpts use
  the same tag-safe walk as linking and are scoped by `chat_id` on new history rows.

## 1.28.0

**Feature (tg-cli#132): proactive harness usage warnings at 90%.**

- `tg-ctl harness-event` accepts externally-piped proactive usage telemetry when a
  confirmed limit contract reaches `>=90%`: Claude Code statusLine
  rate-limits/context, Codex `rate_limits`, Pi RPC `contextUsage`, or tg-cli's
  explicit `schema: "tg-cli.usageLimit.v1"` envelope for custom collectors such
  as an OpenCode plugin.
- Generic token/cost payloads are ignored rather than guessed. Warnings are
  deduped per agent/limit for the current reset window (or a one-hour cooldown
  when no reset is known), localize from payload/locale hints when possible, and
  otherwise render in English.

## 1.27.0

**Feature (tg-cli#130): reply quote-anchor carries the original message's
`tg#<id>`.** From Alex (tg#5978).

- `buildReplyAnchor`/`buildReplyInject` (`features/tg-ctl/updates.ts`) now
  render `↩ tg#<id> «[date time] head…»` — `tg#<id>` is
  `reply_to_message.message_id`, the Telegram id of the message being
  answered (almost always the agent's own prior report), rendered with the
  same `tg#` convention as the inbound wrap's own-message `{id}`. Previously
  only the reply's OWN id was surfaced (via the `[TG from {name} {id}]` wrap);
  the id of the message being REPLIED TO was invisible, so an agent whose
  context had compacted had no way to recover the original beyond the ~60-char
  truncated preview. Now it can pull the full text back with `tg replies` (or
  `tg replies --json` filtered by id) instead of guessing.
- Applies uniformly to text replies, voice-note replies, and prose replies
  inside a bound forum topic (all three route through the same
  `buildReplyAnchor`).
- Docs: `docs/specs/reply-quotes.md` and the README inbound-reply section
  updated to the new anchor format.
- **Fix (review: tg-cli#131):** a reply anchored to a non-first chunk of a
  >4096 split, or a non-first item of a media-group album, was NOT
  recall-able via `tg replies --json | select(.id == <tg#>)` — `tg` only
  wrote ONE history record, keyed to the first outbound message id, even
  though the route map (used to route an inbound reply back to its origin
  pane) already tracked every id. `buildOutboundHistoryRecords`
  (`features/replies/outbound.ts`) now writes one `agent` history record per
  outbound message_id, so every anchored id stays recall-able.
  `outboundHistoryText` also now combines a mixed photo+document send into
  one placeholder (`[2 photos, 3 files]`) instead of silently dropping the
  document count.
- **Fix (tg-cli#134, review: tg-cli#131 follow-up):** writing multiple
  records per send meant the plain (non-`--json`) `tg replies agent` listing
  printed one logical send as N duplicate-looking lines, and `-n`/`--limit`
  counted raw records instead of sends. Every true multi-part send is now
  tagged with a shared `groupId` (a caller-supplied random token, not the
  group's first id — Telegram message_id is per-chat-sequential, so reusing
  it as the key could collide across two chats sharing one bot's history
  file) and `select.ts` groups by that authoritative marker; `-n`/`--limit`
  now counts logical sends (not raw records) for BOTH the plain listing and
  `--json` — a kept multi-part send is never truncated mid-group, so a
  `--json -n N` result can carry more than N rows when the tail includes a
  multi-part send. The plain listing additionally collapses each group to
  one line; `--json` always returns every id of the kept sends, uncollapsed.

## 1.26.0

**Features (tg-cli#113, #114, #115): harness-limit notifications, reaction
lifecycle, and the `/tasks` board.** From Alex (tg#5698, tg#5699).

- **Harness limit/error notify + auto-continue (#113).** `tg-ctl harness-event`
  is a `StopFailure`-hook subcommand: fed the payload on stdin (+ transcript
  tail), it extracts the reason and reset time and messages the operator that a
  session hit its limit / errored. When the reset time is parseable the message
  carries an inline **auto-continue** button; tapping it arms a timer that
  injects `continue` into the originating pane at reset time (immediately if
  already past). Schedules persist to `*.schedules.json` and re-arm on daemon
  restart. `tg-ctl install-hooks` now also provisions the StopFailure hook.
  `--dry-run` renders WITHOUT sending. A **staleness guard** suppresses any
  alert whose reset time already passed, and every string is a real template
  (no leaked `%`-placeholder) — the two bugs a prior WIP leaked live.
- **Reaction lifecycle (#114).** 👀 working → 😴 stalled (limit-stop) → 👌 done.
  Alex's literal ⏳/✅ are `REACTION_INVALID` for a bot (verified live); 😴 and
  👌 are the allowed proxies. `tg --tag answer --reply-to <id>` now flips
  message `<id>` to the done mark.
- **`/tasks [<agent>] [<status>]` (#115).** A new bot command that composes
  `task list --json` + `gh pr list --json` into a rich-HTML board table (id,
  title, state, due, PR, CI), filterable by normalized status and scoped to a
  fuzzy-matched agent's project. Missing PR/CI renders as an em dash, never
  fabricated. Published in the bot menu.

## 1.25.0

**Feature (tg-cli#121): `tg replies --session` accepts a tmux WINDOW NAME, not only a pane id.**

- **`--session <name>` now scopes recall by tmux window name** (`tg replies --session ext`).
  Pane ids (`%7`) are un-typeable from memory; a human window name is what you actually know.
  A `%`-prefixed argument is still treated as a pane id (backward compatible); anything else is
  resolved as a window name.
- **Exact match, unioned across sessions.** `--session ext` matches ONLY the window literally
  named `ext` (never `ext: diagram`), and if several tmux sessions each have a window named `ext`
  it recalls the union of all their panes. Resolution shells out to
  `tmux list-panes -a -F "#{pane_id}\t#{window_name}"` (pane id first, TAB-delimited, so window
  names containing spaces survive intact).
- **An unknown window name is a structured error** — non-zero exit + `no tmux window named '<name>'`
  — rather than a silent empty recall. `--all-sessions` and the default (current pane) scope are
  unchanged.

## 1.24.0

**Fix (tg#5741): question buttons — the tapped answer never reached the agent; multi-question support.**

- **Answer envelope now stamps the REQUIRED `hookSpecificOutput.hookEventName`.** Claude Code
  ≥2.1.198 validates hook JSON output and DISCARDS the entire output when `hookSpecificOutput`
  lacks `hookEventName` — the Telegram card read "answered: …" while the agent fell back to the
  local question dialog and the answer never arrived. (The 2.1.170-era live spike passed without
  it; the spec's predicted contract drift happened.) The envelope also echoes the ORIGINAL
  `tool_input` (CC schema-validates `updatedInput` wholesale; option `description` is a required
  field there) with the collected `answers` merged in.
- **Multi-question AskUserQuestion (2-4 questions) now forwards** as one sequential Telegram card
  per question (`(i/N)` title suffix, per-question stable requestIds); the ask client composes ONE
  combined reply from the collected answers, so the tool completes with no local dialog and no
  extra final Enter. ALL-OR-NOTHING: any multiSelect/free-form question or any declined/timed-out
  card bails the whole call to the local UI — a partial answers record is never emitted.
- **Stale-daemon repair:** the ask client rebuilds a single-question reply from a RUNNING daemon
  that predates `hookEventName`, so the fix takes effect the moment the client updates. Restart
  the daemon (`tg-ctl restart`) to update the daemon side too.
- **A late tap on an abandoned multi-question member is refused** (review finding): after the
  ask client's budget elapses mid-collection, the local dialog owns ALL the questions — injecting
  one lone late answer could answer the WRONG prompt. The tap answers "the terminal took over";
  the retained entry and keyboard survive untouched, so reconnect re-attach across a daemon
  bounce (no duplicate card) keeps working; stale members expire via the retention window.
- **A re-attached card is restored to its live prompt** (review finding): the socket-close path
  edits the card to "window closed …"; when a resend re-attaches it, the original question text
  and keyboard are re-sent (Telegram's editMessageText detaches the keyboard when reply_markup
  is omitted), so the one card that works again no longer tells the user not to use it.
- **Question requestIds are seeded with the ordered option labels** (review finding): a later
  call re-asking the same question text with DIFFERENT options gets a fresh id, so it can never
  re-attach a stale retained card whose buttons would resolve by index against the new options.
  True re-fires (same text and options) keep their id — tg-cli#97 dedup/replay unchanged.
- **Multi-question member answers are never cached for replay** (review finding): an aborted
  round's partial answer must not silently stitch into a later identical re-ask — the re-run
  posts fresh cards (an outstanding member still re-attaches to its retained card).
- **`tool_input` now survives the daemon socket boundary** (review finding): the daemon-side
  request parser dropped it, silently downgrading a PreToolUse ExitPlanMode "Proceed" to a bare
  allow — which the hooks docs say is not sufficient for user-interactive tools. New round-trip
  integration test guards it. Duplicate question texts in one call (schema-invalid) now bail to
  the local UI instead of colliding requestIds / collapsing the answers record.

## 1.23.1

**Fix (tg-cli#57): permission card durability — retain on socket close, re-attach on reconnect.**

- `retainAbandonedQuestion` extended to cover `kind === "permission"` cards alongside questions.
- Socket-close text differentiation so permission cards are not discarded on disconnect.
- Delivery guard and persist filter ensure the tap reaches the harness after reconnect.
- 19/19 integration tests pass.

## 1.23.0

**Fix: `review visual` argv rename + VS Code window crop enforcement in pre-send-photo hook.**

- **`review visual` (no `--`) canonical argv** — the pre-send-photo hook and all references
  throughout now call `review visual <png> --json --strict` (subcommand form) instead of
  `review --visual`. The hook's argv test verifies the exact call surface.
- **Full VS Code window screenshot blocked** — `looks_like_vscode_window()` heuristic detects
  a full-editor screenshot by sampling the dark, uniform activity-bar strip on the left edge
  (calibrated: channel mean < 60, spread < 40) and blocks the send with an explicit crop
  instruction. A cropped preview-pane or narrow image passes through. Fail-open: any PIL
  error or missing dep treats the image as NOT a window.
- **Hook Caller Discipline** (AGENTS.md) — when a hook needs clearer callee semantics, fix
  the callee command surface and invoke that surface directly; do not change cwd or add
  caller-side env hacks.
## 1.22.0

**Feature (tg-cli#31): §11 forum-topic deferrals — reply anchor, slash intercept, rename persistence.**
Three behavioral completions for forum-topics mode:

- **Reply anchor in bound topics.** A reply to a message inside a bound forum topic now carries
  the same `↩ «…»` quote-anchor as flat-chat replies (`buildReplyInject`), so the topic agent
  knows which earlier message is being addressed.
- **Daemon-global slash commands intercepted.** `/status`, `/agent`, and `/new` sent from inside
  a bound topic are now routed to the daemon (not injected verbatim into the topic pane). `/stop`
  and `/kill` are explicitly not intercepted — they still reach the topic's harness session.
- **`forum_topic_edited` persists rename.** A topic rename service message now emits a
  `topic-rename` action: the daemon persists the new name in `TopicBinding` and calls
  `tmux rename-window` to keep the window slug in sync.

## 1.21.0

**Fix (tg-cli#102): `tg --file report.md` → PDF closes two egress/exfil surfaces
the sibling `.html` report path (tg-cli#96) had already closed.** The markdown→PDF
render had two gaps:

- **No network blackhole.** The Chrome `--print-to-pdf` invocation lacked
  `--host-resolver-rules=MAP * ~NOTFOUND`, so a markdown document with a remote
  resource (`![x](http://host/p.png)`, a remote font/iframe) made Chrome FETCH it
  at print time — a tracking-pixel / SSRF / network-egress surface. The print now
  runs with the DNS blackhole, so no remote subresource can resolve a host.
- **pandoc-stage local-file inlining.** pandoc was invoked with `--embed-resources`
  `--resource-path`, which base64-inlines ANY local file the markdown references
  (`![x](/etc/passwd)`, `![x](../secret)`) into the produced HTML — with zero
  attacker effort, for every referenced path — and fetches remote `src=`s at the
  pandoc stage. Both flags are dropped (matching the #96 decision). Cost: a relative
  LOCAL image in the markdown now shows broken in the PDF; remote images were
  blackholed regardless. A report is text-formatting, not an image document.

This is NOT yet full parity with the `.html` path, and the change does not claim
to be. Two residuals remain on the md path, both tracked:
- **tg-cli#103** (shared with the `.html` path): Chrome still loads an
  ABSOLUTE-path / `file:`-scheme `<img>` from the `file://` document into the PDF
  (the blackhole doesn't apply to `file://`). Relative refs are safe.
- **tg-cli#104** (md path only): unlike the `.html` path, `convertMdToPdf` does
  NOT run the element/handler sanitization (`sanitizeReportHtml` /
  `stripEventHandlerAttrs`), so a hostile `.md` with raw `<iframe src="file://…">`
  or `<script>` still reaches Chrome. pandoc keeps `raw_html` on for gfm.

This change removes the primary, zero-effort exfil/egress surfaces (#102's scope);
the sanitization and `file:`-subresource scrub are the #103/#104 follow-ups.

The Chrome print step (with the blackhole + empty-PDF check) is now a single shared
`printToPdf` helper used by BOTH the md-pdf path AND the code-pdf fence / html-report
paths, so the print sandbox flags live in one place and the md path can never again
silently diverge from the hardened code-pdf paths — which is the exact gap that
caused this issue.

## 1.20.0

**Feature (tg-cli#99): forwarded-question state survives a socket close and a
daemon restart — a late tap is late-delivered, a restart loses nothing within the
retention window (default 30 min).** The
`tg-ctl` daemon held all forwarded-question state ONLY in memory, so two failures
hurt the question channel: a Telegram tap that arrived AFTER a question's hook
socket closed (the agent's 120s hook budget elapsed, or the agent process died)
hit the `!pending` branch and was DROPPED — you pressed a button and nothing
reached the harness; and a daemon restart (crash-relaunch / stop+start) wiped
every pending and recently-answered question. One mechanism fixes both:

- **Persist** scoped questions + the answered-replay cache to a new durable file
  (`tg-ctl.<bot>.questions.json`, atomic temp+rename write) on every mutation,
  and restore them on daemon bootstrap.
- **Late-deliver**: a tap with no live pending socket now injects the chosen
  option into the asking tmux pane (the same text-reply injection path as a voice
  or typed reply) instead of dropping. The retained card keeps its keyboard so a
  late tap still works.
- **Reconnect**: the `tg-ctl ask` client for a SCOPED question reconnects and
  resends the same requestId across a mid-block socket drop; the restored daemon
  re-attaches the pending entry (no duplicate card) or replays the stored answer.
- **UX**: a genuinely-dead card (an unscoped question with no pane to deliver to,
  or a send-failed forward) now has its inline keyboard cleared on expiry so it
  isn't tappable.

Permissions and unscoped questions keep the single-attempt path unchanged (they
aren't retained across a restart, so resending would post a duplicate). The #98
answered-replay behavior is extended, not changed — it is now persisted too.

The retention window (`TG_CTL_ABANDONED_RETAIN_MS`, default 30 min) is enforced at
delivery time, not only on restore: a retained question whose window has elapsed
expires even on a quiet daemon. This bounds late-delivery — a question the human
left untapped for longer than the window (with a daemon restart in between) expires
rather than injecting a long-stale answer into a pane whose agent has moved on. A
question whose hook reconnects (the agent is still blocked) re-attaches as live and
is not subject to the window.

## 1.19.3

**Fix (tg-cli#95): `tg --file report.html` now renders a FORMATTED PDF instead
of printing raw HTML tags.** An attached `.html`/`.htm` file is a Telegram-subset
HTML *report* meant to be rendered, but it matched `CODE_EXT_LANG` and took the
code-as-pdf path, which fenced the whole file into a syntax-highlighted code
block — so the PDF showed literal `<b>`/`<code>`/`<table>`/`<h1>` tags as
monospace text. `.html`/`.htm` now take a new HTML→PDF render path
(`convertHtmlToPdf`): pandoc `-f html` parses the document and Chrome prints it,
so the tags become real bold/italic/headings/tables/lists/code/blockquotes. The
code/config→syntax-PDF path (`.ts`/`.json`/`.yaml`/…) is unchanged. The Chrome
print is network-blackholed (`--host-resolver-rules=MAP * ~NOTFOUND`) so a
report's remote `<img>`/font can't beacon out during the print. The report HTML
is sanitized in two layers: executable/embed elements (`<script>`/`<iframe>`/…)
are stripped from the raw report before pandoc, and `on*=` event handlers
(`onerror`/`onclick`/…) are stripped from pandoc's *normalized* output before the
print — the only place a `>`-inside-a-quoted-attribute can't shield a handler
from the strip and then be re-preserved by pandoc on a `<img>`/`<div>` it models.
`<svg>`/`<math>` subtrees are stripped whole before pandoc (they are not in the
Telegram report subset, and are the one place the `on*=` regex can't be trusted —
pandoc may pass an `<svg onload=…>` / nested `<script>` / external `<use href>`
through as raw markup). Local relative `<img>` are deliberately NOT inlined (no
pandoc `--embed-resources`): a report is text-formatting, not an image document,
and inlining would read arbitrary referenced local files into the uploaded PDF.

## 1.19.2

**Fix (tg-cli#97): an `AskUserQuestion` no longer forwards a duplicate Telegram
card whose tap reads as "expired".** The `requestId` is a stable hash of (session,
question text), and the in-flight dedup (`activeButtonKeys`) is released the instant
the question is answered — so the same `AskUserQuestion` re-firing afterwards posted
a SECOND, superseded card; tapping it showed an "expired" toast though the first tap
had already landed. Two complementary fixes: (a) the daemon now keeps an
answered-request replay cache, so a re-forward of an already-answered `requestId`
replays the stored answer down the hook socket and posts NO new card (scoped to
questions; a permission's stable `requestId` is never silently re-replayed), bounded
by a 5-minute window after which the entry is pruned and a genuinely new question
reusing the hash gets a fresh card; and (b) `hook-normalize` drops the
`AskUserQuestion` copy delivered by the `PermissionRequest *` catch-all matcher, so
only the dedicated `PreToolUse:AskUserQuestion` matcher forwards it (the
double-coverage that re-fired the same `requestId`). Observability: the answer path
now logs `ask-answered:` (previously silent), the tap toast reads "✓ sent to the
agent", and a tap on an already-answered card reads "already answered" instead of
"expired". Known trade-off: within the replay window a genuine human re-ask of the
exact same question (same session + text) is indistinguishable from a re-fire and is
auto-answered with the prior answer; the window bounds how long that lasts.

## 1.19.1

**Fix (tg-cli#93): `tg-ctl status` no longer falsely reports "not running" on a
launchd relaunch.** The daemon's `cleanExit` unlinked its pidfile unconditionally,
so a departing daemon — or one whose ownership a newer instance had already taken
over by rewriting `tg-ctl.<bot>.pid` with its own pid — would delete the **live**
successor's pidfile. `status` (which reads the pidfile) then reported "not running"
while the real daemon was alive and long-polling. `cleanExit` now removes the
pidfile only when its content is still its own pid (new `ownsPidFile` guard); the
flock loser is unaffected (it exits before writing any pidfile) and a graceful
exit still removes the owner's pidfile.

## 1.19.0

A new **`/new` slash command** (tg-cli#27) spawns a fresh agent session straight from
the flat chat: `/new [<model>] [<dir>] <name> [<task>]`. Omitted parts are chosen
interactively via inline buttons — a recent-project picker for `<dir>` (the in-use
project dirs **and their `..` parents**, normalized, deduped, LRU/MRU-ranked) and a
model picker for `<model>`. A `<name>` that collides with a live tmux window is a
non-blocking warning. With name + dir + model all supplied the agent spawns
immediately, passing the optional `<task>` as its initial prompt; otherwise the
daemon walks the interactive flow. This is the NON-topic sibling of the forum-topics
`/new` flow: it carries its own in-memory pending-state machine and its own button
callbacks (`tnm:`/`tnp:`), so it never collides with the topic flow, and it works
regardless of `control.topics`. The whole feature is fail-soft (no path is allowed
to throw into the poll loop) and 1:1 routing stays byte-identical when no `/new` is
in flight.

## 1.18.2

An **unscoped** forwarded question (the hook ran without `TMUX_PANE`) that expires
unanswered no longer silently strands the inbound messages deferred behind it
(tg-cli#58). An unscoped question defers inbound for **any** pane, so its backlog
can sit on several panes at once and there was no single pane key to dead-letter —
the expiry timer dropped the queue without telling anyone. Now, on the unscoped
abandon (timeout / hook socket close / send failure), the daemon **sweeps every
pane that still holds a backlog** and dead-letters the idle ones, emitting the same
`⚠️ … were NOT delivered. Resend them.` notice the scoped socket-close path already
gave.

- The sweep reuses the existing per-pane abandon guard, so a pane that still has
  **another** live question (its answer flushes the queue legitimately) or an
  in-flight flush (it owns the queue) is left untouched — no other handler's
  messages are dropped.
- The no-wedge guarantee is unchanged: the stale text is never pasted into the
  freed pane (the agent has moved on), and routing un-wedges immediately.

## 1.18.1

`tg-ctl status` no longer lies about autostart when the daemon is supervised by an
EXTERNAL launchd job (tg-cli#88). It previously recognized only tg-ctl's own `enable`
unit (`com.agenttools.tg-ctl.tg-ctl`), so when launchd kept the daemon alive across
reboots via a separately-wired job (e.g. an `ai.hyperide.tg-ctl` LaunchAgent), status
printed `autostart: NOT enabled` while it actually autostarts on boot.

- **status probes launchd** (`launchctl list` + `launchctl print`) for any loaded job —
  other than tg-ctl's own unit — whose `ProgramArguments` runs THIS tg-ctl binary with the
  `run` subcommand, discovered by what the job RUNS (not a hardcoded label), and reports
  `autostart: enabled (via launchd: <label>)`. The own-`enable` mechanism is unchanged and
  takes precedence.
- Robust: non-macOS / launchctl-unavailable falls back to the existing logic and never
  crashes; root (uid 0) uses the `system` domain, not `gui/0`; binPath matching is
  basename-aware so a symlink-vs-realpath mismatch still resolves.

## 1.18.0

Forum-topics increment 4 — lifecycle polish (spec §9.4; tg-cli#86, refs #31/#85). Builds
on the increment-2 spawn executor with the deferred recovery + UX items:

- **Recent-repo path buttons** on the awaiting-path step (`tgp:<threadId>:<index>:<nonce>`):
  the prompt offers recent project cwds (routes store + per-pane registrations, newest-first,
  deduped to absolute existing dirs) as one-tap buttons, with a free-text fallback. A per-prompt
  nonce pins each button to its prompt, so a stale button from a superseded prompt is rejected
  rather than resolving its index against a newer choice list.
- **Model keyboard cleared on bind** (and on a restart-to-path) via `editMessageReplyMarkup`.
- **Re-spawn on a dead/closed pane:** a message to a topic whose pane died marks it `closed` and
  offers a one-tap *Re-spawn* button (`tgr:<threadId>`) that re-launches with the retained path +
  model — or restarts the `/new` flow when the path/model is missing or the dir vanished. The offer
  is throttled (one per dead topic), only stamped on a successful send, and a re-spawn failure
  restores `closed` so the next message re-offers.
- **Daemon auto-stamps `TG_TOPIC`** into the spawned window's env (`new-window -e TG_TOPIC=<id>`),
  so a topic agent's plain `tg "reply"` threads back into the topic without `--topic`.
- **Crash-window orphan reconcile** on startup re-binds a crash-orphaned agent to its topic instead
  of double-spawning, proven by a per-spawn token stored as a `@tg_spawn_token` window option
  (queryable via the pane format; `new-window -e` process env is not) plus a recorded-paneId
  fallback. Adoption requires same slug + same cwd + (token OR paneId), so a same-slug/cwd stranger
  is never adopted; a flaky startup snapshot is skipped (no mass-close); a model tap on a still-
  pending binding re-probes (just-in-time adoption) so a missed reconcile can't double-spawn.
- **Same-batch races handled:** a re-spawn tap + a text message in one batch routes the text to the
  re-bound pane (not dropped); a second same-batch message to a just-closed topic uses the throttled
  recovery, never the old "recreate the topic" dead-end.

All gated behind `control.topics` (default OFF → 1:1 byte-identical). Extensive tests in
`tests/ctl-topic-spawn-integration.test.ts`, `tests/ctl-topics.test.ts`, `tests/ctl-discover.test.ts`.

## 1.17.0

Forum-topics: spawn an agent on topic creation (the `/new` flow trigger, spec
increment 2; tg-cli#85, refs #27). When a Telegram forum topic is created the daemon
runs an interactive `/new` flow and launches a fresh agent bound to that topic — one
topic = one agent. The routing half (#56/#61) and the pure foundation already shipped;
this wires the `topic-new`/`topic-answer` entrypoint actions to a real `tmux new-window`
spawn plus a model-pick button.

- **Flow:** `forum_topic_created` → ask for a working directory → validate it
  (absolute + existing dir) → post model-catalog buttons → on a tap, spawn
  `tmux new-window -P -F '#{pane_id}' -- <model argv>` and bind the returned pane. The
  topic name is only the tmux-window slug; path + model come from the interactive flow.
- **Safety:** every spawn step is exception-guarded (a bad path / missing tmux / spawn
  error posts an error into the topic and never throws into the poll loop); no
  double-spawn (duplicate create filtered, already-bound refused, model validated once,
  sequential action dispatch); gated behind `control.topics` (default OFF → 1:1
  behaviour byte-identical).

## 1.16.0

Single-source the tool version (tg-cli#80). `tg --version` now reads the version
from `package.json` at runtime instead of a hardcoded `VERSION` literal, so the
two can no longer drift. The literal had already diverged (`1.15.0` in source vs
`1.0.0` in `package.json`); `package.json` is now the sole declaration and is the
field the ship version-bump gate tracks.

- **`package.json` is the single source of truth.** New `resolveVersion(scriptDir)`
  reads `package.json`'s `version` relative to the running script's directory (the
  tool runs directly via bun from the repo root, so `package.json` sits next to the
  `tg` entrypoint). `VERSION` is now sourced from it at module load rather than a
  literal; `versionOutput` resolves the version the same way. The runtime git-hash
  suffix is unchanged. A drift-guard test pins `tg --version`'s numeric part to
  `package.json`'s `version` so they can never diverge again.

## 1.15.0

Two `tg-ctl` routing/picker fixes (tg-cli#75): no-reply auto-bind to the
most-recently-active agent, and `/agent` picker labels by the real tmux window
name instead of the cwd basename.

- **No-reply auto-bind to the last-active agent.** A plain (non-reply) message to
  a multi-agent fleet used to fall to `ambiguous target — candidates: …`. It now
  binds to the **most-recently-active agent** — the pane whose last outbound `tg`
  send is newest (the same `aggregateUsage` LRU/MRU signal the reply picker ranks
  by). A recognized reply route still wins first; the auto-bind only resolves an
  otherwise-ambiguous non-reply; and with no activity history or a tie at the
  most-recent timestamp it stays ambiguous so the button picker still fires (the
  unscoped fail-closed). New pure `resolveAmbiguousByActivity`
  (`features/tg-ctl/discover.ts`).
- **`/agent` picker uses the tmux WINDOW NAME, not the cwd.** The picker labelled
  agents by the cwd basename ("hyperide · claude") instead of the user-set window
  name ("ext"). Root cause: window names were fetched in a SEPARATE `tmux
  list-panes` call that skipped the UTF-8 locale env, so under launchd the
  tab-mangle blanked every name and the label fell back to the cwd. `#{window_name}`
  is now a fixed field in the core, locale-safe `PANE_FORMAT` (`PaneInfo.windowName`,
  carried through `parsePaneList`). A bare default — a number, a shell/launcher
  command (`zsh`/`node`), or a cc version string (`2.1.181`) — is treated as
  non-distinguishing and the label leans on the cwd project dir.

## 1.14.0

Help-UX cleanup: deduped usage, standard topic-help, and a configured-vs-pending
status glyph on `tg voice setup` (ROADMAP "tg help specifics").

- **Usage block no longer repeats `[--format plain|html]` on every line.**
  `--format` is a global modifier shown ONCE in `Options:`; the usage examples
  now read cleanly (`tg "text"`, `tg --photo … "caption"`, …) with a one-line
  note that the global options apply to any form.
- **`tg help format` is the canonical formatting reference** — the standard
  topic-help convention (`tg help <topic>`), advertised in the main `tg --help`.
  `tg help` with no topic prints the main help; an unknown topic
  (`tg help bogus`) errors with a 3-part message and a non-zero exit. The old
  `--format-help` flag is kept as a back-compat alias (byte-identical output).
- **`tg voice setup` shows actual STATUS** — a green `✓` when voice transcription
  is configured, a yellow `○` when it is still pending (the install-* state
  principle). The glyph is plain unicode so it is meaningful on BOTH surfaces:
  colorized for the terminal, and ANSI-free in the Telegram onboarding reply.

## 1.14.0

Scripted, idempotent deploy step for installed `tg` checkouts.

- **New `scripts/deploy.sh`** — updates the checkout the `tg` symlink points at
  (resolved from PATH, or `--checkout DIR`) by fast-forwarding it to
  `origin/<branch>`. `tg` is a committed Bun script with no build step, so the
  deploy is just a guarded `git pull --ff-only`. Idempotent (no-op when up to
  date), refuses a dirty tree (exit 1) and a non-fast-forward divergence
  (exit 2), and `--dry-run` reports what would land without changing anything.
- **tg-ctl-aware**: detects when a deploy changes daemon code (the `tg-ctl` entry
  or anything under `features/`, which the daemon imports) and tells you to
  restart the running daemon (which drops its pane/cwd/session registration);
  `--restart-ctl` does the stop/start automatically. `tg` itself needs no restart.
- **README "Update / deploy" section** documents the step. Closes the ROADMAP
  "tg-cli #36 merged but NOT deployed" gap — there is now a documented, scripted
  way to deploy a merged change to a live checkout.


## 1.13.0

`tg#<id>` message-ref convention + GitHub-anchor line specs.

- **Inbound wrap renders the message id as `tg#<id>`** (was bare `#<id>`):
  `[TG from Alex tg#1234] …`. The `tg#` prefix is what lets the outbound
  autolink layer tell a Telegram-message reference apart from a GitHub
  issue/PR `#<id>` so a quoted-back `tg#3715` is never mis-resolved as #3715.
- **New `autolink-msgrefs` feature** (ON by default). Links `tg#<id>` refs in
  outbound text: a `t.me/c/` deep link in a supergroup chat, a marked-but-
  unlinked styled reference in a private DM (no public per-message URL exists).
  Runs BEFORE the `#N` PR pass. Toggle with `--no-feature autolink-msgrefs`.
- **File line-specs now accept the GitHub permalink-anchor forms** `file#L10`,
  `file#L10-L20`, and `file#L10-20` (the second endpoint's `L` is optional),
  alongside the existing `file:N` / `:N-M` / `:N:C`. A pasted GitHub line link
  gets the same inline excerpt + marker-injected attachment.

## 1.12.0

`--tag` is now LOWERCASE-ENGLISH ONLY, and `--help` is colorized to match the
rest of the agent-CLI ecosystem (review / rig / draw).

- **`--tag` accepts only `answer` / `decision` / `problem` / `report`** (the
  lowercase-english tag words). Russian aliases (`ОТВЕТ`/`РЕШЕНИЕ`/`ПРОБЛЕМА`/
  `ОТЧЁТ`) and uppercase / mixed-case / unknown values are now **rejected** at
  parse time with a 3-part error and a non-zero exit, instead of the old
  soft-render-and-warn:

  ```
  invalid --tag 'ANSWER': tags must be lowercase english.
  Use one of: answer, decision, problem, report
  ```

  The `answer` tag still requires `--reply-to`. Validation lives in
  `validateTag` (`features/render/tag.ts`) and runs in `parseArgs`, so every
  send path fails before touching Telegram.
- **Colorized help.** `tg --help` and `tg --format-help` now colorize section
  headers (bold cyan) and option names (green), matching review/rig/draw. Color
  is dependency-free ANSI, auto-disabled when stdout is not a TTY or `NO_COLOR`
  is set, so piped/redirected help stays plain.

## 1.11.0

`tg replies` — recall what was sent over Telegram, so an agent can quickly
remember what the user asked without scrolling its own pane.

- **New subcommand `tg replies [user|agent|all] [list | find <query>]`.**
  - Direction (1st positional, default `user`): `user` = inbound messages the
    user sent, `agent` = outbound messages the agent sent via `tg`, `all` = both
    (prefixed `←` user / `→` agent).
  - Action (2nd positional, default `list`): `list` shows recent messages
    oldest→newest; `find <query>` is a case-insensitive substring search
    (`--regex` for a regular expression).
  - Line format: `[YYYY-MM-DD HH:MM] #<id> <text>` (local time, Telegram
    message id). Long text truncates to ~200 chars unless `--full`.
  - **Default scope = the current tmux session/pane.** The pane is detected from
    `$TMUX_PANE`; `--all-sessions` drops the scope, `--session <paneId>` targets
    a specific pane. `-n/--limit N` (default 20), `--json` (machine-readable
    array: ts ms, id, direction, from, text, pane), and `--help` round it out.
- **Append-only history log.** A new `tg-ctl.<botid>.history.jsonl` (next to the
  daemon's `routes` map, under `~/.config/tg-cli`) records one JSON object per
  line: `{ts, message_id, direction, from, text, pane}`. The `tg-ctl` daemon
  writes inbound messages (stamped with the routed pane); `tg` writes outbound
  messages (stamped with `$TMUX_PANE`). Both writers are best-effort — a corrupt
  or unwritable log never breaks a send or an inject — and the file is trimmed to
  its last ~5000 lines on write.
- Pure logic (`features/replies/`: arg parsing, JSONL parse/append/trim,
  direction + pane filters, substring/regex search, line + JSON formatters)
  stays out of the effectful entrypoints, mirroring the `tg-ctl` module split.

## 1.10.1

Inbound media downloads no longer drop a message on a transient network blip.

- **Retry-with-backoff on inbound media download (`tg-ctl`).** The control
  daemon's `downloadFileToCache` did a single `getFile` fetch and a single
  file-bytes fetch; ANY transient failure on either — a dropped connection, a
  5xx, a timeout — logged "media download failed", returned null, and (because
  the poll offset was already persisted) silently lost the inbound voice note /
  photo / doc forever. Both network steps now run under a bounded
  retry-with-backoff (`features/tg-ctl/retry.ts`): 3 attempts with jittered
  exponential backoff (~300ms → 900ms → 2.7s), retrying on a thrown network
  error / abort / timeout or a non-2xx HTTP response. A permanent Telegram-level
  error (HTTP 200 with `{ok:false}`) is left alone, not retried. The success
  path and the caller contract are unchanged — it still returns the cached path
  or null — and each retry plus the final give-up is logged with the step name
  and attempt count.

## 1.10.0

Native Telegram **Rich Messages** (tables, headings, lists, LaTeX formulas),
folded into the EXISTING `--format html` path — no new flag, no new `--format`
value.

- **Rich messages via `--format html` (auto-routed).** Bot API 10.1 (June 2026)
  added `sendRichMessage`, which renders a much larger HTML tag set than the
  basic `parse_mode=HTML` path: native bordered tables (`<table>`/`<tr>`/`<td>`
  with `align`/`valign`/`colspan`/`rowspan`/`<caption>`), headings (`<h1>`..
  `<h6>`), lists (`<ul>`/`<ol>`/`<li>`), dividers (`<hr>`), paragraphs (`<p>`),
  collapsible `<details>`, pull quotes (`<aside>`), footers, and LaTeX formulas
  (`<tg-math>` inline / `<tg-math-block>` block). `tg` now decides by CONTENT:
  HTML using only the basic inline tags (b/i/u/s/code/pre/a/blockquote/tg-emoji/
  tg-time/spoiler) sends as before (`sendMessage`); HTML containing any rich-only
  tag auto-sends a Rich Message (`sendRichMessage` with `rich_message.html`).
  ONE flag (`--format html`); the tool routes on what's inside.
- A rich body is sent **whole** — never 4096-split (splitting a `<table>` would
  corrupt it; rich has a 32768-char budget) and never used as a media caption.
- `--tag` / `--title` / `--reply-to` compose with rich messages: the branded
  header line (custom-emoji tag pill + styled title — all basic tags valid inside
  a rich body) sits above the rich content; threading uses `reply_parameters`
  (sendRichMessage has no `reply_to_message_id` field).
- **Rich limits pre-flighted locally** (≤ 32768 chars, ≤ 500 blocks, ≤ 16
  nesting levels, ≤ 50 media, ≤ 20 table columns) so an oversize body fails with
  a clear `tg:` error instead of an opaque API 400.
- **`tg --format-help` corrected.** It no longer claims "Telegram has NO tables".
  It now documents the BASIC vs RICH tiers, the rich tag set, a `<table>`
  example, and the rich limits. The monospace `tg --table` (`<pre>`) stays as the
  plain fallback grid.

## 1.9.7

Tag-badge notification clarity.

- **Tag pill fallback dots are now `[color, neutral, neutral]`.** Each `--tag`
  badge (ANSWER/DECISION/PROBLEM/REPORT) is a wordmark pill made of N custom-emoji
  CELLS. In a push notification — rendered by the OS, which can't load the
  custom-emoji image — each cell shows its fallback dot in place of the image.
  Previously every cell fell back to the SAME color dot, so the badge appeared as
  `🔵🔵🔵` (three loud identical dots). Now only the FIRST cell keeps the tag's
  colored dot and the rest fall back to a neutral white square (`▫️`), so the
  badge appears as `🔵▫️▫️`: one colored dot tells you WHICH tag by color (🔵
  answer / 🟠 decision / 🔴 problem / 🟢 report), the rest stay quiet. (The tag
  WORD is not part of the badge — the HTML header carries only the pill cells; any
  text after the dots in a notification is the `--title`/body, not the tag word.)
  The in-app pill IMAGE is unchanged (premium clients still see the full
  wordmark); only the per-cell fallback alt changes. The live sticker-set alts
  were synced to match (`scripts/sync-tag-pill-alts.ts`), so the rendered
  `<tg-emoji>` inner text still equals each cell's Telegram-side alt (required or
  Telegram drops the entity).

## 1.9.6

Three formatting/reply additions.

- **Threaded replies (`--reply-to <message_id>`).** Pass an inbound Telegram
  `message_id` and the outbound message threads UNDER it (`reply_to_message_id`
  on `sendMessage`), so an answer visibly attaches to the message it answers.
  Only the FIRST message of a >4096 split is threaded. The `tg-ctl` daemon now
  surfaces the inbound id in the injected wrap — `[TG from Alex #1234] …` — so
  the agent reading its pane knows the id to reply to. The id IS Telegram's own
  per-chat sequential `message_id` (no parallel id scheme invented). The
  **ANSWER / ОТВЕТ** tag now REQUIRES `--reply-to` (answering means answering a
  specific message); a clear error fires if it is missing. The other tags are
  unchanged.
- **`tg --table`.** Reads delimited rows from STDIN (TSV, or `a | b` per line),
  auto-sizes columns, draws box borders, HTML-escapes cells, and sends an
  aligned monospace table wrapped in `<pre>` — Telegram has no native HTML
  tables, a padded `<pre>` is the only way. Composes with `--tag`/`--title`;
  argv text becomes a heading above the table. Cells with double-width glyphs
  (emoji/CJK) trigger a one-line alignment warning but still send.
- **`tg --format-help`.** Prints a concise, copy-pasteable reference for what
  Telegram message formatting actually supports (the HTML-tag allowlist, the
  four HTML entities, the `<pre>` table pattern, the `--tag`/`--title` badge) so
  agents stop guessing. Referenced from `tg --help`.

## 1.9.5

- **Voice transcripts now inject as a 🎤-marked quote.** An inbound voice note's
  transcription is wrapped `🎤 «…»` (mirroring the `↩ «…»` reply anchor) before it
  reaches the agent pane, so the agent — and a human glancing at the pane — can tell
  it is machine-transcribed speech (which may carry recognition errors), not text
  typed verbatim. Both the reply and standalone routes apply it.

## 1.9.4

Inbound voice messages → text (local Whisper STT). Talk instead of type.

- **A Telegram VOICE note now becomes agent input.** When you send a voice note
  to the bot, the `tg-ctl` daemon downloads the OGG/OPUS, transcodes it to WAV
  16 kHz mono with `ffmpeg`, runs a local Whisper, cleans the transcript, and
  injects the resulting text into the SAME agent pane a typed message would
  reach — reusing the existing reply-routing (a voice note sent as a reply
  carries the same quote anchor and routes to the replied-to origin pane). Audio
  notes take the same path. Transcription runs through an ASYNC (non-blocking)
  spawn, so the daemon's poll loop and q→buttons hook server stay responsive
  while Whisper works.
- **Whisper is discovered, not bundled.** `tg voice setup` (or the auto-prompt
  on the first unconfigured voice note) probes the host — `~/xp/whisper.cpp`
  first, then conventional clone locations and `PATH` — finds the built
  `whisper-cli` binary and a real `ggml-*.bin` model (preferring multilingual
  large/medium over English-only over the test fixtures), checks for `ffmpeg`,
  and persists the runner/binary/model/language into `config.yaml`. faster-whisper
  (an import-verified project `.venv`) is supported as a fallback runner.
- **First-use onboarding, never a silent drop.** A voice note that arrives before
  Whisper is configured triggers a guided reply: it points at an existing `~/xp`
  install when present, or tells you to build whisper.cpp + download a model (or
  install `ffmpeg`), then run `tg voice setup`. Once a working install is found
  on the fly it is persisted so the next note transcribes without re-prompting.
  Download / transcribe / persist failures are caught and reported — a note is
  never lost after the at-most-once offset advances.
- **Config:** a new top-level `voice:` block in `~/.config/tg-cli/config.yaml`
  (`enabled`, `runner`, `bin_path`, `model_path`, `language` — default language
  `auto`, covering ru + en). No secrets are written — only binary/model paths.
  Reloaded per note, so `tg voice setup` takes effect without a daemon restart;
  an explicit `enabled: false` is honored as the opt-out.

## 1.9.3

Cleaner tag header + emoji tooling reads its bot token from config.

- **No more duplicate tag word on the header line.** A `--tag` with real pill ids
  now renders ONLY the wordmark pill cells in the HTML header — the appended
  plain tag word (e.g. a second "ANSWER" next to the pill) is gone. The wordmark
  is already baked into the sticker art, so the duplicate was redundant and (when
  combined with `--title`) clashed with the styled title. The first line is now
  the `--title` text (styled) only; the tag is just the pill badge. Non-premium
  viewers fall back to the per-cell colored dots — an accepted trade for a clean
  premium first line. The `plain` form (non-HTML / >4096 split) keeps the
  readable unicode fallback (`🔵 ANSWER`). Unknown tags still soft-render as
  `[WORD]`. (`features/render/prefix.ts`.)
- **Emoji-set scripts read their bot token from config, decoupled from the
  sender.** `scripts/create-tag-emoji.ts` and `scripts/create-ai-emoji-set.ts`
  now read `TG_EMOJI_BOT_TOKEN` (the dedicated emoji-owning bot) from
  `~/.config/tg-cli/.env`, falling back to `TG_BOT_TOKEN` only when unset; owner
  id is `TG_OWNER_ID` then `TG_CHAT_ID`. They use the shared config loader
  (`features/config/env.ts`, extracted from the `tg` entrypoint) so the config
  `.env` → process.env precedence applies and a token set only in config works
  with no transient shell export. The token is never printed.
  (`features/config/env.ts`, `scripts/create-tag-emoji.ts`,
  `scripts/create-ai-emoji-set.ts`, `tg`.)

## 1.9.2

Code/config files → mobile, syntax-highlighted PDF (and by default ONLY the PDF
is sent).

- **`code-as-pdf` feature (ON by default).** Attaching a code/config file —
  `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`, `.jsonc`, `.yaml`,
  `.yml`, `.toml`, `.ini`, `.py`, `.go`, `.rs`, `.rb`, `.php`, `.java`, `.kt`,
  `.swift`, `.c`, `.cpp`, `.h`, `.cs`, `.sh`, `.bash`, `.zsh`, `.sql`, `.css`,
  `.scss`, `.less`, `.html`, `.xml`, `.svg`, `.graphql`, `.proto`, `.lua`, `.r`,
  `.dart`, `Dockerfile`, `Makefile`, `CMakeLists.txt`, … (full map in
  `features/code-pdf/convert.ts`) — is rendered to a **mobile-sized,
  syntax-highlighted, soft-wrapped PDF** before sending. Telegram's iOS client
  previews raw source uselessly; the PDF is the readable artifact on a phone.
  Pipeline reuses the md-pdf machinery: fence the content in the detected
  language → pandoc (skylighting highlighting) → headless Chrome
  `--print-to-pdf` at the phone page size. Long lines **soft-wrap** (CSS
  `white-space: pre-wrap` + `overflow-wrap: anywhere`) so there is NO horizontal
  scroll. Monospace, light theme (`tango`), optional line numbers.
- **BY DEFAULT only the PDF is sent — the raw file is NOT attached.** On iOS the
  raw `.ts` is noise; the PDF is what you actually read. Two flags adjust:
    - **`--with-original`** — also attach the raw file alongside the PDF.
    - **`--no-pdf`** — skip the render and attach the raw file (the prior
      behavior). Equivalent to `--no-feature code-as-pdf`.
- **`--pdf-device <name>`** (or `TG_PDF_DEVICE`) — page geometry preset:
  `iphone15pro` (default, 393pt wide), `iphone15promax`, `iphonese`, `a4`.
  `TG_PDF_THEME` overrides the pandoc highlight style (default `tango`).
- Markdown keeps its own `.md`→PDF path (`detectCodeLang` returns null for it);
  images / `.pdf` / other documents are untouched. On any render failure the raw
  file is attached unchanged (same fail-open policy as md-as-pdf).
  (`features/code-pdf/convert.ts`, `features/cli/args.ts`,
  `features/auto-attach/feature-flags.ts`, `tg`.)

## 1.9.1

Wider tag pills, hosted under @hyperidebot.

- **ANSWER and REPORT widened to 3 cells.** 1.9.0 sliced the two 6-letter
  wordmarks into 2 cells each, so the rounded caps squished the text. Both now
  use 3 cells (matching DECISION / PROBLEM), giving the wordmark breathing room.
  The generator (`scripts/build-tag-pills.py`) sets all four canonical tags to 3
  cells; the upload script and render path follow.
- **Pill set re-created under @hyperidebot.** The custom-emoji set moved from
  `replytags_by_UltraClaudeCodeBot` to
  [`replytags_by_hyperidebot`](https://t.me/addemoji/replytags_by_hyperidebot)
  (12 cells, 3 per tag). The sending bot does NOT need to own the set — it can
  reference a set owned by a different bot (verified live). The old set was
  deleted.

## 1.9.0

Custom-emoji tag pills go live.

- **`--tag` now renders a real custom-emoji wordmark PILL.** 1.8.0 shipped the
  `--tag` plumbing with PLACEHOLDER pill ids, so every tag fell back to the
  unicode badge (`🔵 ANSWER`). This release uploads the pill sticker set
  (`replytags_by_UltraClaudeCodeBot`, https://t.me/addemoji/replytags_by_UltraClaudeCodeBot)
  and wires the real `custom_emoji_id`s into `TAG_PILL_IDS`. Premium clients now
  see the wordmark chip; everyone else sees the unicode fallback. The four pills
  (🔵 ANSWER / 🟠 DECISION / 🔴 PROBLEM / 🟢 REPORT) are sliced into 2–3 cells
  each. (`features/branding/emoji.ts`, `scripts/create-tag-emoji.ts`.)
- **Fix: pill cells wrap a single emoji, not a slice of the word.** Telegram
  rejects a `custom_emoji` entity whose fallback text is not exactly one emoji
  with `ENTITY_TEXT_INVALID`. The renderer now emits one `<tg-emoji>` per cell
  wrapping the canonical dot (`🔵`), and appends the readable WORD as plain text
  after the cells (`<pill cells> ANSWER`) so the label is never lost — premium
  clients see the pill image + word, non-premium see `🔵🔵 ANSWER`. The dead
  `splitForCells` word-distributor (the discarded slice approach) is removed.
  (`features/render/prefix.ts`.)

## 1.8.0

Header tag/title; revert the body-pull from 1.7.1.

- **The message body is no longer pulled onto the `✳️ [window]` header line.**
  1.7.1 joined the body's first line onto the header (the prefix ended with a
  space instead of a newline). That was a mistake: the message text must NOT be
  pulled up. `buildPrefix` now ends the header with a newline again, so the body
  always sits BELOW `✳️ [window]` (the pre-1.7.1 behavior). The single-ticket
  autolink title still renders on the header line (it is a ticket title, not
  message text), and the 1.7.1 reply-routing fix is untouched.
  (`features/render/prefix.ts`, `features/autolink-tasks/render.ts`, `tg`.)
- **`--title <text>`** — set an explicit header title: `✳️ [window] <title>`.
  ONLY an explicit `--title` ever appears there; the message body is never
  pulled up. No `--title` → the header is just `✳️ [window]` with the body
  below. The title is styled Bold Italic (a Cyrillic title falls back to `<i>`).
- **`--tag <TAG>`** — an emoji badge labeling what the message is. Canonical
  tags are Russian and case-insensitive; English aliases map to them:
  ОТВЕТ/ANSWER (🔵 💬), РЕШЕНИЕ/DECISION (🟠 ⚖️), ПРОБЛЕМА/PROBLEM (🔴 🚨),
  ОТЧЁТ/REPORT (🟢 📋). It composes with `--title`:
  `✳️ [window] 🔵 💬 ОТВЕТ — <title>`. An unknown tag soft-renders as a plain
  `[TAG]` badge plus a one-line stderr note (it never blocks a send). The
  default emoji mapping lives in one editable constant (`TAG_EMOJI` in
  `features/render/tag.ts`).
- **Skill advertising** — `tg install-skill` now documents `--tag`/`--title`,
  the four canonical tags, their English aliases, and their meanings in both the
  generated `SKILL.md` and the always-on blurb, so agents discover the
  convention from the skill itself.

## 1.7.1

Reply-routing + message-header fixes.

- **Reply routing no longer always opens the picker** — replying in Telegram to a
  message an agent sent now routes straight to that agent's pane. `tg` recorded
  the route's project identity as `process.cwd()`, but agents run `tg` from
  `/tmp`, so it never matched the daemon's check against the pane's
  `pane_current_path` and every reply fell through to the "choose an agent"
  picker. `tg` now records the origin pane's `pane_current_path` at send time, so
  send-time and reply-time compare the same quantity. The pane-id-reuse guard
  (a reply can't leak into a different project that reused the pane) is preserved.
  (`recordRoute` in `tg`, `resolveRouteCwd` / `routeMatchesPane` in
  `features/tg-ctl/routes.ts`.)
- **Task title / message body on the same line as `[window]`** — the agent
  header rendered `✳️ [window]` and dropped the task title / message text to line
  2. The prefix now joins the body with a space, so it reads
  `✳️ [window] 𝑻𝒂𝒔𝒌 𝒕𝒊𝒕𝒍𝒆` on one line. (`buildPrefix` in
  `features/render/prefix.ts`.)

## 1.7.0

Pre-send-photo hook framework + `review visual` unstyled guard.

- **Pre-send-photo hook point** — `tg` now runs an extensible hook chain
  (`agents-hooks/v1`) over every outgoing `--photo` before it leaves. Drop a
  descriptor under `~/.agents/hooks/tg/<id>.pre-send-photo.json` (an executable
  with a priority / timeout / on-error policy) and it runs against the PNG; a
  hook can `allow` the send or `block` it with the canonical exit code 10.
  (`features/hooks/`, `tg hooks list|trust`.)
- **`review visual` unstyled guard** — the bundled `review-visual` descriptor
  pipes the outgoing photo through `review visual <png> --json --strict` and
  blocks an unstyled / broken / blank render before it ships. Vision is slow, so
  the hook runs with a 60s timeout and `on_error: open`: a slow or unavailable
  vision call NEVER blocks a send — only an explicit rollback verdict does.
  (`review install-hook tg` substitutes the absolute cmd path.)
- **Trust by default** — drop-in descriptors LOAD AND RUN with no `tg hooks
  trust` ceremony on the user's own machine. The legacy TOFU quarantine + SHA
  pin re-engages only under `AGENTS_HOOKS_TRUST=1` (the rare untrusted-input
  case); `AGENTS_HOOKS_TRUST=auto` runs under the guard but auto-trusts.
- **Fail-open, non-breaking** — no descriptors dir ⇒ a single `stat` and a
  byte-identical send (zero behavior change for existing users). A hook crash,
  timeout, or malformed output warns and sends anyway; only exit-10 blocks.
  Every run is recorded to an append-only `audit.jsonl`.

## 1.6.1

- **Task-title styling restyled** — the single-ticket autolink task title now
  renders in **Mathematical Bold Italic** (`𝑭𝒊𝒙`) instead of the gaudier Bold
  Script (`𝓕𝓲𝔁`). The whole-token `<i>` fallback for Cyrillic / foreign-letter
  titles (which the math block can't represent) is unchanged.
  (`features/prefix-style/`, docs/specs/unicode-prefix-styling.md.)

## 1.6.0

Agent addressing, reply quotes, prefix styling, and compound autolinks.

- **`/agent [<window>] <message>`** — address a specific agent when several run
  at once. The window is fuzzy-matched with phonetic normalization (Cyrillic→
  Latin, sound-folding), a confident match routes the message straight to that
  pane, and an ambiguous / unspecified target shows session-grouped inline
  selection buttons. Bare `/agent` lists the addressable agents.
  (`features/tg-ctl/agent-match.ts`, docs/specs/agent-addressing.md.)
- **Reply quotes + routing** — replying to a message forwards a quote anchor
  into the agent: `↩ «[date time] <quote>…»` (partial Telegram selection wins,
  else the start of the replied-to message). A reply to a **recognized** message
  routes to the pane that produced it (message_id→pane routes map written by
  `tg`); an **unrecognized** reply shows the window picker ordered by **LRU+MRU**.
  (docs/specs/reply-quotes.md.)
- **q→buttons, now seamless** — `tg-ctl install-hooks` idempotently wires the
  Claude Code agent-question/permission hooks into `~/.claude/settings.json`
  (backup first; existing hooks preserved); `tg-ctl ask` normalizes the raw
  harness payload so the hook is trivial; `tg-ctl status` reports whether it is
  installed. While an agent is blocked on a question, new inbound messages to it
  are **deferred** (queued, marked ✍️) and flushed when the question is answered.
  (docs/q-buttons-prerequisites.md.)
- **Unicode prefix styling** — the tmux window name in `[]` renders in
  Mathematical Sans-Serif Bold and a single-ticket task title in Bold Script,
  with a `<b>`/`<i>` fallback for Cyrillic names the math blocks can't represent.
  (`features/prefix-style/`, docs/specs/unicode-prefix-styling.md.)
- **Compound autolinks** — one token may carry a range or list of refs
  (`HYP-100..103/110`, `#5-7,9`): the body links only the written numbers
  (range endpoints), and the bottom reference block enumerates the full range.
  (`features/autolink-refs/`, docs/specs/autolink-compound.md.)
- Documented the q→buttons prerequisites and the missing hook installer
  (docs/q-buttons-prerequisites.md), and a WhatsApp companion-transport
  implementation spec (docs/specs/whatsapp-transport.md, spec only).

## 1.5.1

Agent detection fix (outbound branding):

- `tg` now identifies a `codex` (and `aider`/`pi`/`opencode`) session by walking
  its own ancestor process tree, not just an env marker. Codex exports no env
  signal for the shell commands it spawns (`CODEX` unset, `CODEX_HOME` empty),
  so detection used to fall through to the `pgrep` fallbacks where a background
  `ollama` daemon (common on macOS) won — mislabeling codex reports as `ollama`.
  The ancestry walk runs before the `pgrep` block, so the launching agent wins
  and a sibling daemon can no longer hijack the label. Mirrors `tg-ctl`'s
  inbound `findAgentInPane` (new `findAgentInAncestry`, shared `matchAgentCommand`).

## 1.5.0

Q→buttons (`tg-ctl`, spec §8 core path):

- New `tg-ctl ask` hook client: reads a normalized question / permission JSON
  request, hands it to the running daemon over a bot-scoped Unix socket
  (`tg-ctl.<botid>.sock`), sends Telegram inline buttons, consumes
  `callback_query` updates in the same poll stream, immediately
  `answerCallbackQuery`s every tap, edits expired/answered prompts, enforces
  the active registration guard (`paneId`/`cwd`/`sessionName`), and returns
  agent-specific hook output. A missing daemon/socket, timeout, or send
  failure returns no decision so the local agent UI takes over.
- Claude Code question and permission shapes are supported; Codex
  `PermissionRequest` emits the documented
  `hookEventName: "PermissionRequest"` decision shape; opencode
  `question.asked` / `question.v2.asked` / `permission.asked` /
  `permission.v2.asked` adapter helpers map to the matching native reply
  endpoints; `pi` is detected but reports native Q→buttons as unsupported.
- Hardening (post-review): the hook socket is `chmod 0600` on listen and
  caps requests at 64 KiB; taps are validated against the prompt's own
  Telegram `message_id` (a stale tap on an earlier message that reused the
  callback key answers "expired"); the registration guard treats `paneId` as
  authoritative — a pane mismatch fast-passes even when `cwd`/`sessionName`
  agree, so a second keyboard session in the same cwd never blocks on
  Telegram.
- Deferred (recorded in the spec): hook installer/canary automation,
  long-running opencode SSE ownership.

## 1.4.0

Inbound control v1 (`tg-ctl`, spec §16 — poll/tmux transport, ON by default;
opt out with `control.enabled: false`):

- New `tg-ctl` entrypoint at the repo root: `start` / `run` / `stop` / `status`.
  A singleton daemon long-polls Telegram `getUpdates` and injects inbound
  messages into the target agent's tmux pane, wrapped as
  `[TG from {name}] {msg} — reply via tg`. Outbound stays `tg`-only.
- Hard singleton via real `flock(2)` (`bun:ffi` → libSystem/libc): the launcher
  spawns the daemon detached and never takes the lock; the daemon flocks as its
  first action and exits 0 if another instance holds it.
- Lazy auto-start: a successful `tg` send from a tmux pane with a detected
  agent fire-and-forgets `tg-ctl start`, handing over the `TMUX_PANE`/cwd
  registration snapshot (gated on `control.enabled`).
- Pane-id targeting with pre-inject verification: the agent process is located
  by walking the pane's process tree (a Claude Code pane reports its version
  string, not `claude`, as the pane command); injection refuses + replies in
  Telegram if the pane no longer hosts an agent — text never lands in a shell.
- Commands: `/stop` (Escape inject — interrupts the turn, session survives),
  `/kill` (SIGINT + "restore via `claude --resume`"), `/status`; any other
  `/cmd` passes through verbatim; plain text is a wrapped prompt.
- Photo/document inbound: `getFile` download (≤20 MB) to
  `~/.cache/tg-cli/inbound/`, the local path is injected for the agent to read.
- Safety/robustness: sender-id allowlist, at-most-once offset persistence,
  staleness window (default 300 s) with a "skipped N stale" notice, 409
  backoff with a one-shot warning, idle TTL (default 30 min), multi-line
  injection via bracketed paste.
- Delivery receipts: a successfully handled inbound message gets a 👀
  reaction; every failure answers with an error reply instead.
- Config: new `control:` block (`enabled`, `transport`, `session`,
  `inject_wrap`, `staleness_sec`, `idle_exit_min`, `allowed_senders`).
  One bot token per machine for inbound (Telegram allows a single `getUpdates`
  consumer); outbound `tg` is unaffected.
- Deferred (recorded in the spec): question/permission forwarding with inline
  buttons (v1.1), opencode native adapter (v1.1), `/rename`+`/new` (v1.2),
  channel mode (v1.2+), configurable Escape prelude.

Also in this release:

- New `autolink-prs` feature (ON by default): GitHub `#N` references in the
  message text are resolved against the cwd repo via `gh` (one `gh repo view`
  for identity + one batched `gh api graphql` with aliased `issueOrPullRequest`
  fields) and linkified. Resolved ISSUES merge into the existing
  `autolink-tasks` reference block (`#N — Title`); PULL REQUESTS get their own
  collapsed `PRs:` block at the END of the message with a state annotation
  (`(merged)`/`(closed)`/`(draft)`/`(open)`). Verdicts (positive and negative)
  are cached 1 h in `~/.cache/tg-cli/gh-cache.json`, keyed by `owner/repo#N` so
  the same `#260` in different repos never collides. Every failure mode (no
  `gh`, not authenticated, non-GitHub cwd, partial/missing numbers) keeps the
  send going as plain text; missing-CLI / not-authenticated emit a one-time
  stderr hint reusing the `autolink-tasks` hint-state file. Disable with
  `--no-feature autolink-prs`.
- New `recursive-attach` feature (ON by default): a file mentioned by bare
  name or path suffix that misses plain and worktree-root resolution is now
  found recursively under the worktree roots (or cwd outside a git repo) —
  BFS, shallowest match wins, `node_modules`/`.git`/`dist`-style directories
  pruned, depth/size caps. `2026-06-10-tg-ctl-control-design.md` mentioned
  from the repo root now attaches from `docs/specs/`.
- `autolink-tasks` now retries one unexpected `linear api` failure before
  degrading to plain text, so transient Linear CLI/API failures do not silently
  drop ticket links.

## 1.3.0

Never-attach denylist (`attach-denylist` feature, ON by default):

- Secret-looking files are never attached: the `.env` family, SSH private
  keys (`id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`), credential
  rc-files (`.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`,
  `.my.cnf`, `.htpasswd`), shell/REPL histories, `*.tfvars`,
  `credentials.json` / `client_secret*.json`, `kubeconfig`.
- Auto-detected mentions in the text are silently skipped (the token stays);
  an explicit `--photo`/`--file` of a denylisted file is a hard ERROR before
  anything is sent.
- Conscious override: `--no-feature attach-denylist` or
  `features.attach-denylist: false` in `~/.config/tg-cli/config.yaml`.

## 1.2.0

Attachment quality pass:

- Markdown as PDF (`md-as-pdf` feature, ON by default): attached `.md` files
  are converted to PDF via pandoc + headless Chrome — emoji and Cyrillic
  render correctly. Any conversion failure attaches the original `.md`.
- UTF-8 BOM for text attachments: documents with non-ASCII UTF-8 content get
  a BOM prepended to the uploaded copy (disk file untouched), fixing
  Telegram's preview mojibake for Cyrillic. Scripts (`.sh`) and `.json` are
  deliberately excluded.
- Extensionless files (LICENSE, Makefile, `.env`) are no longer auto-attached;
  explicit `--photo`/`--file` still attach anything.
- Linear response cache: autolink-tasks verdicts (including verified-absent)
  are cached for 1 hour in `~/.cache/tg-cli/linear-cache.json` — repeated
  reports about the same tickets no longer spawn the `linear` CLI each send.

## 1.1.0

Autolink tasks (`autolink-tasks` feature, ON by default):

- Ticket-like codes in the message text (3 uppercase letters + dash + digits,
  e.g. `HYP-576`) are verified against Linear via the `linear` CLI and turned
  into links.
- A single mentioned ticket gets its title on the first line (after the
  emoji/[window] prefix when present); several tickets get a collapsed
  `<blockquote expandable>` reference block (`code: title`) at the end.
- Codes Linear doesn't know stay plain text. A missing `linear` CLI or missing
  auth produces a one-time stderr hint; the message is always sent unchanged
  on any autolink failure.
- Toggle with `--no-feature autolink-tasks` or
  `features.autolink-tasks: false` in `~/.config/tg-cli/config.yaml`.

## 1.0.0

CLI ergonomics pass:

- `-v` / `--version`: print version, the running git commit hash, and this
  changelog, then exit 0.
- Help anywhere: `-h`/`--help` (or no arguments at all) prints usage to stdout
  and exits 0 instead of sending an empty message.
- Auto-attach paths: existing file paths found in the message text are attached
  automatically (images as photos, everything else as documents) and excised
  from the caption.
- `OK` on success: a successful send prints `OK` to stdout.
- Unknown dashed flags are an error: a stray `--foo` prints help to stderr and
  exits non-zero instead of being sent as message text. All real flags
  (`--format`, `--photo`, `--file`, `--ls-emoji-helpers`, `--detect-model`) are
  still recognized — the unknown-flag check runs only after they are matched.
