#!/usr/bin/env python3
"""agents-hooks/v1 pre-send-photo hook -> `review visual`.

REFERENCE executable for the `review-visual` descriptor. In production this file
is owned by review-cli and installed under ~/.agents/skills/review/hooks/ by
`review install-hook tg`; it is vendored here so the tg-cli hook framework has a
runnable, testable counterpart for the contract.

Contract (agents-hooks/v1):
  - stdin: a JSON event
      {tool:"tg", point:"pre-send-photo", args:{image_path, caption, chat_id}, ...}
  - stdout: protocol JSON only  -> {"hook_api":"agents-hooks/v1","decision":...,"message":...}
  - stderr: human logs
  - exit code is the CANONICAL block signal:
      exit 0  -> allow (decision:"allow")
      exit 10 -> BLOCK (decision:"block", message = the verdict reason)
      any other exit -> hook error (the host applies its on_error policy)

Verdict mapping (architecture spec §7.3):
  - review verdict keep                 -> allow, exit 0
  - review verdict rollback (unstyled / broken / blank)
                                        -> block, exit 10, message from reason
  - review verdict rollback, SOLELY from the selection-highlight module veto
                                        -> allow + WARN (tg-cli#163), exit 0
    (caption-text-triggered CV check can't tell a HyperCanvas canvas selection
    from a non-canvas one -- see decide_from_review_result / _sole_blocking_module)
  - human_review / unverified / no API  -> allow + WARN (fail-open), exit 0
    (a missing API key or an indecisive vision call must never brick a send)
"""

# PEP 563: defer annotation evaluation so `str | None` / `tuple[...]` parse on
# Python 3.7+ (generic `/usr/bin/env python3` may be 3.9). Without this, the
# module fails to import on <3.10 and — with on_error=open — every photo would
# send UNGATED. Must be the first statement after the docstring.
from __future__ import annotations

import json
import shutil
import subprocess
import sys

BLOCK_EXIT_CODE = 10
HOOK_API = "agents-hooks/v1"
REVIEW_TIMEOUT_S = 55

# --- HYP-1120 live-hatch-approval bypass (narrowed scope, Alex tg#10233 "Option C") --
#
# HYP-1120 as originally filed asked for a GENERAL downgrade of this file's
# unstyled/broken/blank-render veto from hard-block to warn-only, mirroring the
# already-shipped selection-highlight downgrade below (tg-cli#163). An attempt to
# implement that literal, wider scope was denied by an auto-mode security classifier
# as "disabling this org's visual-proof validation gate for ALL cases" -- it would
# have removed the ONLY safety net for a genuinely broken/unstyled/blank screenshot
# with no replacement signal.
#
# Alex chose the narrower alternative instead (tg#10233, replying to the decision
# request at tg#10231): the DEFAULT hard block stays EXACTLY as it was -- this section
# only ADDS a one-time, per-send bypass for a send Alex has already live-approved over
# Telegram. The motivating incident: PR #665's screenshot was live-approved by Alex via
# hatch escalation, but this hook had no code path to consume that approval, so the
# hard block still fired with no way to use the approval that was already given.
#
# Mechanism: this hook itself REQUESTS the live approval (mirrors every other
# hatch-using gate in this org -- e.g. agent-tools' visual-proof-gate) via the shared
# `agenttools_hatch_escalation` helper (agent-tools/lib, importable when agent-tools is
# installed -- see _load_hatch_escalation). It reads the per-hook env var
# (RIG_HATCH_REQUEST_PRE_SEND_PHOTO="<justification>") from the hook process
# environment, and if present, synchronously calls `tg-ctl ask` and BLOCKS on Alex's
# live Telegram reply before resolving. Unset (the default -- no env var) means "no
# hatch requested", and the pre-existing unconditional block() path is untouched.
#
# APPROVAL SCOPE (test (c) below): a hatch approval is per-invocation of THIS hook
# process -- there is no persistent store keyed by image/send that a later, unrelated
# send could accidentally read. `tg-ctl ask`'s live Telegram round-trip is inherently
# scoped to the ONE pending `tg-ctl ask` call this process makes; a different photo
# send is a different hook process with its own env and its own (independent) ask.
#
# TIMEOUT BUDGET: HATCH_ASK_TIMEOUT_S must stay comfortably UNDER the descriptor's own
# timeout_ms (review-visual.pre-send-photo.json, raised to 420000ms/7min for exactly
# this) so this Python process always returns its OWN explicit block/allow decision
# well before the descriptor's outer kill could fire -- a descriptor-level timeout
# kill resolves via on_error:"open" (fail-open / ALLOW), which would silently let an
# un-actioned hatch request bypass a genuinely broken render just by outlasting the
# clock. Explicitly deciding (approved -> allow, denied/timed-out-at-tg-ctl-level ->
# block) inside this process, well inside the descriptor's budget, is what keeps "no
# response" resolving to the safe default (block), not the fail-open default.
HATCH_HOOK_ID = "pre-send-photo"
HATCH_ASK_TIMEOUT_S = 300.0


def emit(decision: str, message: str | None = None) -> None:
    out = {"hook_api": HOOK_API, "decision": decision}
    if message:
        out["message"] = message
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def warn(msg: str) -> None:
    sys.stderr.write(f"review-visual: {msg}\n")
    sys.stderr.flush()


def allow(message: str | None = None) -> int:
    emit("allow", message)
    return 0


def block(message: str) -> int:
    emit("block", message)
    return BLOCK_EXIT_CODE


def _load_hatch_escalation():
    """Best-effort import of agent-tools' shared `agenttools_hatch_escalation`
    helper. Returns None when it can't be imported (agent-tools not installed /
    its lib/ not on sys.path on this machine) -- the live-approval bypass is a
    pure ADDITION on top of the pre-existing hard block; its unavailability must
    never weaken or change the default block-on-broken-render behavior. Matches
    this file's existing fail-open-on-missing-tool pattern (see run_review_visual's
    `shutil.which("review")` check) -- except here "tool missing" means "no bypass
    is possible", not "allow", since the bypass is opt-in via env var, not the
    hook's core function."""
    try:
        import agenttools_hatch_escalation as module
    except ImportError:
        return None
    return module


def _consume_live_hatch_approval(reason: str, *, cwd: str, image_path: str) -> int | None:
    """Consume an already-requested live hatch approval for THIS pending photo
    send (RIG_HATCH_REQUEST_PRE_SEND_PHOTO env var), if one was requested. See the
    HYP-1120 module-level comment above HATCH_HOOK_ID for the full design.

    Returns an exit code (0 allow / 10 block) when a hatch WAS requested (the env
    var is present) -- the request itself decides allow vs. block via a live
    `tg-ctl ask` round trip. Returns None when no hatch was requested at all, in
    which case the caller must fall through to its own unconditional block()."""
    hatch = _load_hatch_escalation()
    if hatch is None:
        return None
    result = hatch.request_hatch_approval(
        HATCH_HOOK_ID,
        {"hook": HATCH_HOOK_ID, "image_path": image_path, "reason": reason},
        cwd=cwd,
        timeout_s=HATCH_ASK_TIMEOUT_S,
    )
    if not result.should_stop:
        return None  # env var unset -- no hatch requested, normal block path
    message = reason or "review visual: unstyled / broken render"
    if result.approved:
        note = f"pre-send-photo veto allowed via live hatch approval ({result.reason})"
        warn(note)
        return allow(note)
    warn(f"pre-send-photo hatch escalation denied: {result.reason}")
    return block(f"hatch escalation denied: {result.reason}\n{message}")


# Telegram captions cap out around 1024 characters, but this hook is a defensive
# gate that runs BEFORE the send — it must not lean on an upstream limit it can't
# see. A generous ceiling well past that real-world cap, chosen to stay far under
# Linux's ~128KB single-arg / macOS's ~256KB total-argv exec limits (an oversized
# --intent would otherwise raise OSError "Argument list too long" at subprocess.run
# call time, caught by the widened except below, and disable verification for that
# photo entirely — review found).
_MAX_INTENT_CHARS = 4096


def _safe_intent(caption: object) -> str:
    """Sanitize an outgoing photo caption into a value safe to append as a single
    subprocess argv element, or "" if it can't be made safe (in which case `review
    visual` still runs, just without --intent — see the call site for why dropping
    it beats letting a malformed caption crash the whole verification call)."""
    if not isinstance(caption, str):
        return ""
    text = caption.replace("\x00", "").strip()[:_MAX_INTENT_CHARS]
    if not text:
        return ""
    try:
        text.encode(sys.getfilesystemencoding(), "strict")
    except (UnicodeEncodeError, LookupError):
        return ""
    return text


# --- empty-editor watermark heuristic (WARN-only, see main()) --------------
#
# VS Code renders a small, muted "watermark" dead center of the editor PART
# only when the active editor group has ZERO open tabs — a genuinely empty
# editor/preview pane. This is a much NARROWER signal than the removed
# looks_like_vscode_window() (HYP-891): that one matched ANY full window via
# a dark, uniform left activity-bar strip and false-positived on legitimate
# content-full screenshots at least twice in one day. A watermark only ever
# renders over a perfectly flat editor background with a compact glyph
# cluster — a real code file, canvas render, or webview fills the same
# region with dense, varied content and cannot produce this pattern,
# regardless of whether the surrounding Explorer/Inspector/Logs panels are
# busy (they usually are, per Alex's tg#6041 full-window proof standard, so
# the check is scoped to a central box rather than the whole image).
#
# CALIBRATION (tg#6651/tg#6672 follow-up — first REAL reference data this
# heuristic has ever had): every threshold below used to be reasoned from
# VS Code's assumed watermark layout (a short list of keybinding-hint TEXT
# rows), never verified against an actual empty-editor-group screenshot —
# and that assumption was wrong. Two real screenshots of a genuinely empty
# VS Code Dark Modern window (Explorer docked left, a Chat panel docked
# right, zero editor tabs — see tests/fixtures/vscode-empty-watermark-*.png)
# show the CURRENT VS Code watermark is a single big flat translucent LOGO
# mark, not hint-text rows, and `looks_like_empty_vscode_watermark()`
# returned False on BOTH real screenshots under the old constants. Direct
# pixel analysis of both (identical results on both, since they differ only
# in Explorer tree state, irrelevant to this box) found two compounding
# bugs, not one:
#
#   1. The OLD box (0.20-0.90 x) physically overlaps a docked right panel on
#      this common layout. That panel's own background is a DIFFERENT
#      near-black shade ((25,26,27) vs the editor's (18,19,20), diff ~7) —
#      itself invisible at the old tol=20 — but real panel foreground pixels
#      (text/icons) and the thin Explorer|Editor / Editor|panel divider
#      border lines (~(42,43,44), diff ~22-24, sitting right at the box's own
#      edges by construction) DID cross tol=20 and were the actual "non-bg"
#      signal detected — not the watermark. Because those artifacts sit at
#      the box's extreme edges, the measured span blew up to ~0.93 (x) /
#      ~0.80-0.86 (y), correctly rejected by WATERMARK_MAX_SPAN_RATIO but for
#      the WRONG reason (panel bleed, not "real content is spread out").
#   2. Once the box is narrowed clear of both docked panels, the real logo's
#      own fill color — (13,13,14) against the editor's (18,19,20) bg — is a
#      contrast of only ~6-7 RGB levels: still invisible at tol=20. At that
#      point _sample_box detects ZERO non-bg pixels at all (ratio 0), a
#      different false negative ("no signal") than bug #1's ("signal spans
#      too much").
#
# Fixing both (narrower box + lower tol) reproduces the SAME numbers on both
# real screenshots: non_bg_ratio ≈ 0.116, span_x ≈ 0.315, span_y ≈ 0.448 —
# the values the constants below are now calibrated against, with margin.
# Verified NOT to false-positive against 7 real BUSY full-window screenshots
# pulled from other HyperIDE e2e runs (code editor + Hyper Canvas preview +
# error/warning panes, some with a centered icon+table not unlike a
# watermark shape) — all still return False under the new constants, mostly
# rejected on span (0.55-0.9, comfortably over the new 0.35/0.50 caps).
#
# HONEST LIMITS (not solved by this pass): both real reference screenshots
# are the SAME window layout (Explorer + Chat panel, same widths) — one data
# point on panel geometry, not two. A materially different sidebar/panel
# width could still bleed into the box the same way bug #1 did; the box
# below is a measured-safe value for this one layout, not a proven-general
# one. Separately, the real logo's contrast (~7) sits only 2-3 RGB levels
# above the noise floor the "noisy near-flat background" synthetic test
# already exercises (±4) — WATERMARK_BG_TOL rides a narrow, real window
# between those two numbers, not a comfortable margin. Both are exactly why
# this stays WARN-only, not a block: an unvalidated pixel heuristic
# hard-blocking a legitimate send is the HYP-891 failure mode this file
# already exists to avoid repeating.
#
# BOX PLACEMENT (review finding, still true): the watermark centers on the
# EDITOR PART, not the WINDOW -- on a real full-window screenshot the editor
# part is offset right by the Activity Bar + Explorer sidebar (~15-20% of
# width). The box below stays asymmetric (biased right of window-center) for
# that reason, just narrower than before on both ends to also clear a
# docked right panel (see calibration note above).

WATERMARK_BOX = (0.25, 0.72, 0.15, 0.65)  # (x0, x1, y0, y1) fractions of W,H
WATERMARK_SAMPLE_STEP = 3
WATERMARK_QUANT = 8  # bucket size for the background-color estimate, see _mode_color
# Lowered from 20 (review finding, see CALIBRATION above): tol=20 made the
# real VS Code watermark logo (~6-7 level contrast against editor bg)
# completely invisible to this detector -- it never fired on either real
# reference screenshot. 6 sits just under the measured 7-level logo contrast
# and just above the ±4 perturbation the "noisy near-flat background" test
# already covers -- a narrow but real, measured window, not a comfortable
# margin (see HONEST LIMITS above).
WATERMARK_BG_TOL = 6
# Upper bound raised from 0.10 (review finding, see CALIBRATION above): the
# real watermark logo measures ~0.116 non-bg density in a properly-scoped
# box -- already over the old 0.10 ceiling on its own, independent of the
# tol fix. 0.15 admits that with margin. Verified this does not re-admit
# genuinely busy content: 7 real full-window screenshots with dense code /
# preview / table content measure 0.045-0.49 here -- the ones under 0.15
# still get rejected by the span cap below, not this range.
#
# Lower bound (review finding): VS Code's real hint rows are THIN text/icon
# strokes, not a filled block. A synthetic icon block + 5 thin (3px) text
# rows -- deliberately sized so every stroke is guaranteed at least one
# sampled pixel regardless of the WATERMARK_SAMPLE_STEP=3 grid's phase --
# samples at ratio ~0.006 on the box+grid size above, just above the
# original 0.005 floor. Real hint text could plausibly render even thinner
# (sub-3px strokes / anti-aliasing) than that synthetic floor case, so this
# is lowered with a safety margin below it rather than exactly at the
# measured value. Still > 0 so a perfectly solid/blank pane (zero glyphs, a
# different bug signature) stays rejected.
WATERMARK_NONBG_RATIO_RANGE = (0.001, 0.15)
# y-cap raised from 0.40 to 0.50 (review finding, see CALIBRATION above): the
# real watermark logo's own shape -- a chunky mark, not thin rows -- measures
# span_y ≈ 0.448 in a properly-scoped box, over the old 0.40 cap on its own.
# 0.50 admits that with margin. x-cap stays at 0.35: the real logo measures
# span_x ≈ 0.315 there already, no change needed. Re-verified against the
# existing "two compact clusters ~54% apart" / "scattered glyph pixels"
# negative fixtures (still span 0.5-1.0 -- still rejected) and 7 real busy
# screenshots (span 0.55-0.9 -- still rejected).
WATERMARK_MAX_SPAN_RATIO = (0.35, 0.50)  # (x span, y span) vs box size


WATERMARK_BOX_MAX_DIM = 1200  # cap the CROPPED box before per-pixel sampling, see _sample_box
WATERMARK_MAX_FILE_BYTES = 20 * 1024 * 1024  # skip the heuristic outright above this, see _sample_box
WATERMARK_MAX_PIXELS = 24_000_000  # skip above this DECODED pixel count too, see _sample_box


def _downscale_box_if_needed(box):
    """Cap the per-pixel work regardless of source resolution (review
    finding: an uncapped Retina/4K screenshot's box can be ~2700x1100 -- a
    few hundred ms of pure-Python PixelAccess work on every send, with no
    timeout unlike the `review visual` call). The span/compactness ratios
    are scale-invariant; the density ratio is APPROXIMATELY so (review
    finding: BOX/area-averaging can blend a very thin, single-pixel stroke
    into the background enough to fall inside WATERMARK_BG_TOL, nudging
    non_bg_ratio down -- accepted for a WARN-only heuristic, not a proven
    equivalence). BOX resampling still beats NEAREST here: it keeps a thin
    stroke visible as a blended gray pixel rather than a coordinate gap that
    could drop it entirely on an unlucky NEAREST sample point.

    `Image.Resampling` (the enum) only exists on Pillow >= 9.1 -- on older
    Pillow this attribute access raises AttributeError, which the caller's
    blanket `except Exception` swallows into a silent False, meaning the
    heuristic would NEVER fire on exactly the large screenshots this cap
    targets (review finding). `getattr(Image, "Resampling", Image).BOX`
    falls back to the pre-9.1 flat `Image.BOX` constant."""
    from PIL import Image

    resampling = getattr(Image, "Resampling", Image)
    bw, bh = box.size
    longest = max(bw, bh)
    if longest <= WATERMARK_BOX_MAX_DIM:
        return box
    scale = WATERMARK_BOX_MAX_DIM / longest
    return box.resize((max(1, round(bw * scale)), max(1, round(bh * scale))), resampling.BOX)


def _sample_box(image_path: str) -> tuple:
    """Load image_path and return (box_w, box_h, samples) for the central
    watermark box, where samples is a list of (x, y, (r,g,b)) within the box,
    coordinates relative to the box's own origin."""
    import os

    # WATERMARK_BOX_MAX_DIM (see _downscale_box_if_needed) only bounds the
    # SAMPLING loop -- it can't bound `Image.open(...).convert("RGB")`
    # itself, which forces a full decode of the SOURCE resolution first
    # (review finding: unlike the `review visual` subprocess call, this has
    # no timeout, and a large photo -- e.g. a 24MP phone photo sent through
    # the same pre-send-photo point -- would add real, unbounded decode
    # latency to every send). A cheap `os.path.getsize` stat (no decode, and
    # deliberately BEFORE `from PIL import Image` -- review finding: an
    # earlier version imported PIL first, so this short-circuit wasn't
    # actually PIL-free and broke in a no-Pillow environment) skips the
    # heuristic outright for anything pathologically large; ordinary
    # screenshots (a few MB at most) are unaffected.
    try:
        if os.path.getsize(image_path) > WATERMARK_MAX_FILE_BYTES:
            return 0, 0, []
    except OSError:
        return 0, 0, []

    from PIL import Image

    im = Image.open(image_path)  # header-only: does NOT decode pixel data yet
    w, h = im.size

    # WATERMARK_MAX_FILE_BYTES bounds the COMPRESSED size on disk, not the
    # decoded pixel count (review finding): a highly-compressed JPEG can be a
    # few MB but decode to tens of megapixels, and `.convert("RGB")` below
    # forces that full decode with no timeout -- there is no subprocess
    # boundary here to enforce one, unlike `review visual`. `im.size` is
    # metadata read from the file header -- cheap, no pixel decode -- so
    # this check runs BEFORE paying that cost, not just before the
    # file-size guard's cost. 24MP (~6000x4000, a common phone/DSLR
    # resolution) caps worst-case decode+convert time in the low hundreds
    # of ms rather than leaving it fully open-ended; still fail-open (skip
    # the heuristic, never blocks the send) above the cap.
    if w * h > WATERMARK_MAX_PIXELS:
        return 0, 0, []
    if w < 800 or h < 500:
        return 0, 0, []

    im = im.convert("RGB")

    fx0, fx1, fy0, fy1 = WATERMARK_BOX
    box = im.crop((int(w * fx0), int(h * fy0), int(w * fx1), int(h * fy1)))
    box = _downscale_box_if_needed(box)

    bw, bh = box.size
    bpx = box.load()

    samples = []
    for y in range(0, bh, WATERMARK_SAMPLE_STEP):
        for x in range(0, bw, WATERMARK_SAMPLE_STEP):
            samples.append((x, y, bpx[x, y]))
    return bw, bh, samples


def _trimmed_span_ratio(coords: list, size: int, trim: float = 0.05) -> float:
    """Compactness span, robust to a lone outlier. A raw (max - min) span is
    blown up to ~1.0 by a single stray non-bg pixel far from the hint-row
    cluster (a minimap sliver, a scrollbar edge, an AA fringe) that can land
    inside the sample box on a real full-window screenshot — which would make
    the detector MISS the very watermark it exists to catch (review finding).
    Trimming the outer `trim` fraction of coordinates at each end absorbs a
    few stray pixels while still rejecting genuinely spread-out content.

    `int(n * trim)` alone rounds to 0 for any n below ~1/trim -- with
    trim=0.05 that's every n <= 19, exactly the sparse-cluster sample counts
    the lowered density floor (WATERMARK_NONBG_RATIO_RANGE) now allows
    through (review finding: a real sparse watermark can land in that exact
    range). At those counts the trim was silently a no-op. Guarantee at
    least ONE point trimmed off each end once there are enough points for
    that to leave a non-empty core; below that, trimming would erase the
    signal entirely, so skip it. "Non-empty" specifically means a core of
    >= 2 points (n - 2*k >= 2), not merely >= 1 (review finding): a 1-point
    core collapses to span=0 regardless of the real spread -- e.g. 3 points
    at [0, 500, 1000] would trim to the single midpoint and read as
    perfectly compact. That's unreachable through the full detector
    pipeline today (the density floor guarantees far more samples than
    that), but this function is documented as a general-purpose, unit-
    tested-in-isolation utility, so its own contract must hold regardless.

    KNOWN LIMIT (review finding): trimming is per-axis and caps at ~`trim`
    fraction of the mass on each end, so it defends against a LONE outlier
    (a handful of stray pixels), not a genuine second cluster that happens
    to hold less than that fraction of the total -- an asymmetric bimodal
    split (e.g. 95% of the mass in one cluster, 5% in a second, far-away
    one) could still trim the minority cluster away and read as "compact".
    Same root cause at small n (review finding): for 4 <= n <= 19,
    `max(1, int(n*trim))` forces k=1 regardless of n, so exactly ONE stray
    point is absorbed per end -- TWO outliers on the SAME side at that n
    range aren't both trimmed, and the span can still blow up. Accepted for
    a WARN-only, unvalidated heuristic; a real fix needs actual clustering
    (e.g. connected components), not a 1D span statistic."""
    if not coords or size == 0:
        return 1.0
    ordered = sorted(coords)
    n = len(ordered)
    max_k = (n - 2) // 2  # largest k that still leaves a >=2-point core
    k = min(max(1, int(n * trim)), max_k) if max_k >= 1 else 0
    lo = ordered[k]
    hi = ordered[n - 1 - k]
    return (hi - lo) / size


def _mode_color(samples: list) -> tuple:
    """Estimate the dominant background color by counting QUANTIZED buckets,
    not exact RGB tuples: a real screenshot (PNG re-encoding, Telegram's JPEG
    re-compression, sub-pixel font AA bleeding into nearby pixels) rarely
    repeats one EXACT color across a majority of samples even over a
    genuinely flat editor background — the true signal is a tight CLUSTER of
    near-identical colors, not one literal recurring tuple."""
    counts: dict = {}
    q = WATERMARK_QUANT
    for _, _, c in samples:
        bucket = (c[0] // q, c[1] // q, c[2] // q)
        counts[bucket] = counts.get(bucket, 0) + 1
    bucket = max(counts, key=counts.get)
    return tuple(v * q + q // 2 for v in bucket)


def looks_like_empty_vscode_watermark(image_path: str) -> bool:
    """True if the central editor-pane box looks like VS Code's empty-editor-
    group watermark: overwhelmingly flat background, plus a small, compact,
    non-zero cluster of non-background pixels (the watermark logo/glyphs —
    see the CALIBRATION note above WATERMARK_BOX: current VS Code renders a
    single flat logo mark here, not the hint-text rows this detector was
    originally reasoned from) — not dense content, and not a perfectly
    solid/blank region either (a
    blank/crashed webview is a DIFFERENT bug signature with zero glyphs, left
    to `review visual` to catch). Best-effort: any error / no PIL -> False
    (fail-open, never brick a send on this heuristic alone)."""
    try:
        bw, bh, samples = _sample_box(image_path)
        if not samples:
            return False

        bg = _mode_color(samples)
        tol = WATERMARK_BG_TOL
        non_bg = [
            (x, y)
            for x, y, c in samples
            if abs(c[0] - bg[0]) > tol or abs(c[1] - bg[1]) > tol or abs(c[2] - bg[2]) > tol
        ]
        total = len(samples)
        non_bg_ratio = len(non_bg) / total
        lo, hi = WATERMARK_NONBG_RATIO_RANGE
        if not (lo <= non_bg_ratio <= hi):
            return False

        xs = [p[0] for p in non_bg]
        ys = [p[1] for p in non_bg]
        span_x_ratio = _trimmed_span_ratio(xs, bw)
        span_y_ratio = _trimmed_span_ratio(ys, bh)
        max_span_x, max_span_y = WATERMARK_MAX_SPAN_RATIO
        return span_x_ratio <= max_span_x and span_y_ratio <= max_span_y
    except Exception:  # noqa: BLE001 - any failure must fail OPEN, never brick a send
        return False


def warn_empty_watermark_if_detected(image_path: str) -> None:
    """WARN-only, NOT a block: unlike the removed looks_like_vscode_window()
    heuristic (HYP-891, which matched ANY full window via a dark left
    activity-bar strip and false-positived on legitimate content-full
    screenshots at least twice in one day), this one targets a narrow,
    specific signal — VS Code's own "no tabs open" watermark in the editor
    pane — that IS a real defect for a proof screenshot: an empty
    editor/preview pane proves nothing. But its thresholds are reasoned from
    VS Code's layout, not calibrated against a captured reference screenshot,
    and the exact HYP-891 failure mode (an unvalidated pixel heuristic
    hard-blocking a legitimate send) is one bad threshold away from
    recurring. Surfacing it as a warning — visible in the audit trail without
    bricking the send — is the deliberate choice until it's field-validated;
    promoting it to a block is a follow-up once real false-positive/negative
    data exists."""
    if looks_like_empty_vscode_watermark(image_path):
        # This hook runs on every pre-send-photo event, not just IDE
        # screenshots (review finding) -- the message names the VS Code
        # signature this pattern was DESIGNED to catch, but stays hedged
        # ("possible" / "consistent with") since the same small-compact-
        # element-on-flat-background shape is also produced by, say, a
        # centered dialog or a lone logo on a plain background.
        warn(
            "possible empty-editor watermark: a small compact element on an otherwise "
            "flat central pane, consistent with VS Code's 'no tabs open' logo mark — this "
            "screenshot may not actually show what the caption claims; not blocking "
            "(WARN-only pending field validation on live traffic, see HYP-891 follow-up)"
        )


def run_review_visual(image_path: str, intent: str = "") -> subprocess.CompletedProcess | None:
    """Invoke `review visual --json --strict` on image_path, forwarding intent
    (the sanitized outgoing caption, see _safe_intent) as --intent when
    non-empty. Returns None on any fail-open condition (no `review` on PATH,
    timeout, OSError/ValueError) — the caller must treat None as an
    immediate allow()."""
    review_bin = shutil.which("review")
    if not review_bin:
        warn("`review` not on PATH — allowing (fail-open)")
        return None

    cmd = [review_bin, "visual", image_path, "--json", "--strict"]
    if intent:
        # `--intent=<value>` as ONE token, not two ([`--intent`, intent]): a caption
        # starting with `-`/`--` (e.g. "-> selected", "--fix applied") would otherwise
        # be parsed by argparse as the NEXT option rather than --intent's value,
        # breaking the whole `review visual` call for that caption (review found).
        cmd.append(f"--intent={intent}")

    try:
        return subprocess.run(  # noqa: S603 - args are fixed, image_path from the host event
            cmd,
            capture_output=True,
            text=True,
            timeout=REVIEW_TIMEOUT_S,  # < descriptor timeout_ms (60s) so we own the timeout
        )
    except subprocess.TimeoutExpired:
        warn("`review visual` timed out — allowing (fail-open)")
        return None
    except (OSError, ValueError) as exc:
        # ValueError alongside OSError: subprocess.run raises it (not OSError) for a
        # malformed argv — e.g. an embedded NUL byte, or an unencodable character
        # (a lone UTF-16 surrogate) that can't be encoded for the OS's argv/exec
        # call. `intent` can no longer trigger either (pre-validated by
        # `_safe_intent` above — a NUL or an unencodable caption drops `--intent`
        # entirely rather than reaching subprocess.run), so this is NOT protecting
        # the --intent path; it guards `image_path`, which comes from the event
        # args unfiltered (a pre-existing, still-open channel).
        #
        # Verified WHERE a NUL in image_path actually surfaces (checked, not assumed —
        # review flagged this as exactly the kind of claim that needs proof, not a
        # docstring): `looks_like_empty_vscode_watermark()` (via `_sample_box`) calls
        # `Image.open(image_path)`, which raises this SAME ValueError first — but that
        # function's own `except Exception` already swallows it and returns False, so
        # execution reaches this `cmd`/subprocess.run unchanged. subprocess.run then
        # raises its OWN ValueError for the same NUL, still present in argv, and THAT
        # is what this except catches. Manually confirmed by running the corresponding
        # test ('NUL byte in imagePath...' in hooks-review-descriptor.test.ts) and
        # reading its console stderr output: the warning text is this branch's own
        # "could not run `review visual`: embedded null byte", not a message from
        # anywhere else — i.e. NOT a silent pass-through of the watermark check, NOT a
        # bare uncaught crash resolved by the JS harness. That specific text is not
        # itself asserted in the test (HookRunResult exposes no stderr-capture field to
        # assert against), so re-verify by eye if this code path changes.
        #
        # Also confirmed this is not a fail-CLOSED -> fail-open regression for THIS
        # descriptor: review-visual.pre-send-photo.json sets on_error:"open", and
        # run-photo-hooks.ts's resolveDecision() already treats ANY abnormal exit
        # (crash/timeout/non-canonical code) as a hook ERROR resolved by that policy —
        # an uncaught exception here was ALREADY fail-open end-to-end before this
        # change, just resolved one layer up (in the JS harness) instead of here.
        # Catching it here only changes WHERE the same allow() decision is made, not
        # what it resolves to, under the on_error the shipped descriptor actually uses.
        warn(f"could not run `review visual`: {exc} — allowing (fail-open)")
        return None


# --- selection-highlight veto downgrade (WARN-only, see decide_from_review_result) --
#
# tg-cli#163 (Alex, tg#7133, re tg#6691): review-cli's selection-highlight module
# (reviewlib/features/visual/contrib/selection_highlight.py) activates whenever the
# outgoing caption/--intent matches a "selected"/"выбран"/"выделен"/"highlight"
# keyword (intent_keywords.py synonyms), and vetoes with decision:"block" if it
# can't find a 2px rgb(59,130,246) HyperCanvas selection outline in the image. That
# activation is PURELY caption-text-based -- it has no way to know whether the
# "selected" thing is actually a HyperCanvas canvas element (which SHOULD carry that
# outline) or something else entirely: a file selected in the VS Code Explorer,
# selected editor text, a selected checkbox/dropdown outside the canvas. In the
# non-canvas case there is genuinely nothing to highlight, so a hard block was a
# false positive with no escape hatch except rewording the caption (tg#6691: "попал
# в блок на отправку фото" for exactly this).
#
# The fix downgrades ONLY this specific veto shape to a warn-and-allow. Everything
# else that can produce a rollback verdict -- an unstyled/broken/blank render,
# selection-highlight PLUS another module vetoing together, or a rollback with no
# module breakdown at all -- still hard-blocks exactly as before. This module's own
# CV check is real signal when it IS a canvas element (the outline genuinely should
# be there), so the warn message is written as an urgent "go verify this", not a
# shrug -- it is a downgrade of ENFORCEMENT, not of the underlying suspicion.
#
# SCOPE (deliberately NOT touched here, per Alex): review-cli's
# policy_engine.py module-veto aggregation ("any module block is a hard veto,
# modules can only tighten, never loosen") stays exactly as-is -- other consumers
# (e.g. PR screenshot gates) depend on that hard-veto semantics, and loosening it
# there would be a much bigger, out-of-scope architecture change reaching outside
# this repo. This carve-out lives entirely in the tg-cli hook layer, downstream of
# review-cli's own verdict, the same pattern warn_empty_watermark_if_detected()
# uses for a different heuristic above.
#
# HONEST LIMITS (two, both verified against review-cli source, both deliberately
# NOT "fixed" here because the fix would reach into review-cli — out of scope):
#
#   1. PARTIAL modules array on a CV-phase short-circuit. review-cli's module CV
#      phase (pipeline.py: `for m in modules: ... if mv.decision == "block": return
#      Verdict(...)`) stops at the FIRST blocking module and returns a
#      module_verdicts list containing only the modules checked so far. So if
#      selection-highlight's own CV check blocks first (no outline found), any
#      module ordered AFTER it never runs, and this hook sees selection-highlight as
#      the SOLE block even though a later module MIGHT have blocked too. The downgrade
#      then allows a send that a not-yet-run module could have vetoed. Detecting that
#      is impossible from the verdict alone (the other module produced no entry), and
#      the only real fixes -- have review-cli mark the list "complete", or re-run
#      remaining checks -- live in review-cli, which this ticket explicitly forbids
#      touching. Accepted: the ticket's whole intent IS to stop selection-highlight
#      alone from blocking, and blank/unstyled -- the dangerous class -- is caught by
#      the core cvGate BEFORE any module runs (it surfaces as a rollback with an EMPTY
#      modules array, which still hard-blocks here). The multi-MODULE-veto case that
#      DOES survive into one verdict is the post-vision judge phase (policy_engine.py
#      aggregates every module `block` at once), and that shape -- two blocks -- still
#      hard-blocks correctly.
#
#   2. The `decision == "block"` string is load-bearing. `_sole_blocking_module`
#      keys the whole carve-out on that exact literal. That is deliberate and correct:
#      it MIRRORS review-cli's own authoritative blocking predicate
#      (policy_engine.py: `blocking = [m for m in module_verdicts if m.decision ==
#      "block"]`) -- the two must agree on what "a module veto" means, or this hook
#      would downgrade a shape review-cli considers blocking (or vice versa).
#      Inverting to "treat any unknown decision as a potential veto" (a reviewer
#      suggestion) would DIVERGE from that source of truth -- "abstain"/"pass"/
#      "loaded"/... are explicitly non-blocking there -- and defeat the feature. If
#      review-cli ever adds a second veto string, its OWN policy_engine line above
#      needs the same update, so the two move together; this is a shared-contract
#      coupling, tracked by that mirror, not an unguarded assumption.
_SELECTION_HIGHLIGHT_MODULE = "selection-highlight"


def _sole_blocking_module(verdict: dict) -> str | None:
    """Return the module name iff EXACTLY ONE `modules` entry vetoed with
    decision=="block" AND that lone entry carries a non-empty string `module`
    name; None in every other case (zero blocking entries, more than one, a
    malformed/missing modules field, or a lone blocking entry whose module name
    is missing/non-string/empty). `modules` is Verdict.to_dict()'s shape --
    reviewlib/features/visual/policy_engine.py -- a list of
    {"module": str, "decision": "block"|"pass"|"abstain"|..., "reason": str}.

    Deliberately structural (module/decision fields), not string-matching the
    combined `reason` text (tg-cli#163 review: text matching would silently break
    the moment either module's wording changes).

    CRITICAL — the blocking COUNT is taken over EVERY candidate entry, BEFORE any
    check on the module NAME (tg-cli#163 review found this, twice): an earlier draft
    filtered on `isinstance(module, str)` inside the counting comprehension, so a
    SECOND genuine veto that happened to carry a corrupted/empty module field was
    dropped from the count entirely -- shrinking the count back to 1 and silently
    downgrading a real multi-module block to allow. That is a fail-open in the
    dangerous direction. A follow-up review flagged the same hole for a NON-dict
    sibling (a stray string/None in `modules`): `isinstance(m, dict)` in the count
    would swallow it too. So the rule is uncompromising: ANY non-dict entry makes the
    whole `modules` array malformed -> ambiguous -> return None (caller still
    blocks); and a block entry with an unusable module name is likewise ambiguous.
    Ambiguity never renders a real veto INVISIBLE."""
    modules = verdict.get("modules")
    if not isinstance(modules, list):
        return None
    # A non-dict entry is unparseable -- it could itself be a veto we can't read.
    # Refuse to reason about the array at all rather than silently skip it.
    if any(not isinstance(m, dict) for m in modules):
        return None
    blocking = [m for m in modules if m.get("decision") == "block"]
    if len(blocking) != 1:
        return None
    name = blocking[0].get("module")
    if isinstance(name, str) and name:
        return name
    return None


def _warn_and_allow_selection_highlight(reason: str) -> int:
    """tg-cli#163 WARN-and-allow path for a rollback whose ONLY blocking module is
    selection-highlight. The message is deliberately LONGER than the file's other
    one-line stderr warns (Alex's explicit ask on this ticket): it must spell out
    WHEN proceeding is legitimate, because the whole point is that the CV check
    cannot tell the two cases apart. It reads as an urgent "go verify", not a
    shrug -- a genuinely-selected HyperCanvas element SHOULD carry the outline, so
    its absence there is a real defect; proceeding is only fine when the selected
    thing is NOT a canvas element and there is nothing to highlight."""
    warn(
        "review visual: selection-highlight veto downgraded to WARN "
        f"(tg-cli#163) -- reason: {reason or 'no outline detected'}. "
        "If a HyperCanvas canvas element IS actually selected in this "
        "screenshot, the 2px rgb(59,130,246) selection outline SHOULD be "
        "visible -- its absence is a real defect signal, so double-check "
        "this render before treating the send as done. Proceeding without "
        "the outline is only legitimate when the selected thing is NOT a "
        "canvas element (a VS Code Explorer file, selected editor text, a "
        "non-canvas UI control) -- there is genuinely nothing to highlight "
        "in that case."
    )
    # The URGENT recommendation reaches a human via the warn() STDERR above --
    # that is the load-bearing channel here, and the runner surfaces it (the
    # `Warning: hook review-visual stderr: ...` line, asserted by the tg-cli#163
    # console-capture test). The `reason` passed to allow() below rides on the
    # hook's own emitted `{"decision":"allow","message":...}` protocol JSON, but a
    # tg-cli#163 review finding verified the runner DROPS `message` for a clean
    # (non-errored) allow -- runner.ts resolveDecision returns `{decision:"allow"}`
    # with no message on that path -- so do NOT rely on it reaching the audit line
    # or the caller; it is passed for symmetry with the indecisive-verdict fallback
    # below and for any future runner that chooses to preserve it, nothing more.
    return allow(reason or None)


def decide_from_review_result(
    proc: subprocess.CompletedProcess, *, cwd: str = "", image_path: str = ""
) -> int:
    """Map a completed `review visual` run to the hook's allow/block decision
    (architecture spec §7.3 verdict mapping). `cwd`/`image_path` feed the
    HYP-1120 live-hatch-approval bypass on the hard-block path -- see
    _consume_live_hatch_approval."""
    # KEEP stdout parsing OUTSIDE run_review_visual's try above: json.JSONDecodeError
    # is itself a ValueError subclass. If a future edit folded
    # `parse_review_output(proc.stdout)` into that try, a malformed/empty JSON
    # response from `review` would silently resolve to allow() there instead of
    # hitting the dedicated "malformed stdout" handling below (review found this as
    # a latent trap in the widened except).
    verdict, malformed = parse_review_output(proc.stdout)
    decision = verdict.get("decision") or verdict.get("verdict")
    reason = verdict.get("reason") or verdict.get("message") or ""

    # `review visual --strict` itself exits 10 on a rollback verdict; honour
    # that directly (it is the same canonical block signal).
    if proc.returncode == BLOCK_EXIT_CODE or decision == "rollback":
        # tg-cli#163: a rollback caused SOLELY by selection-highlight is a caption-
        # text false-positive risk (see the module doc above) -- downgrade to
        # warn-and-allow. Any other shape (another module vetoing too, or no
        # single-module breakdown at all -- e.g. an unstyled/broken/blank render,
        # which arrives as a rollback with an EMPTY modules array) still hard-
        # blocks below, unchanged.
        if _sole_blocking_module(verdict) == _SELECTION_HIGHLIGHT_MODULE:
            return _warn_and_allow_selection_highlight(reason)
        block_reason = reason or "review visual: unstyled / broken render"
        hatch_decision = _consume_live_hatch_approval(block_reason, cwd=cwd, image_path=image_path)
        if hatch_decision is not None:
            return hatch_decision
        return block(block_reason)

    # A zero exit with NON-EMPTY but UNPARSEABLE stdout is a broken/noisy review
    # binary, NOT a clean keep — warn and fail open (don't masquerade as keep).
    if proc.returncode == 0 and malformed:
        warn("review visual emitted malformed stdout (not JSON) — allowing (fail-open)")
        return allow()

    # A clean "keep" verdict is the only unconditional allow. A zero exit with NO
    # decision field AND empty/clean stdout is also a clean allow.
    if decision == "keep" or (proc.returncode == 0 and decision is None and not malformed):
        return allow()

    # Everything else — human_review / unverified / unknown decision, or a
    # non-zero-but-not-10 exit — is INDECISIVE. Fail open, but WARN + audit so an
    # unverified visual check is never silently indistinguishable from a clean
    # keep (architecture spec §7.3: human_review/unverified default allow + warn).
    warn(
        f"review visual indecisive (decision={decision!r}, rc={proc.returncode}) "
        f"— allowing (fail-open)"
    )
    return allow(reason or None)


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        # We could not read the event — fail open (do not brick the send).
        warn(f"could not parse stdin event: {exc}")
        return allow()

    args = event.get("args") or {}
    image_path = args.get("image_path")
    if not image_path:
        warn("no image_path in event args — allowing")
        return allow()

    # Forward the outgoing caption as --intent: it is the ONLY signal `review visual`
    # has of what the sender claims the screenshot shows (e.g. "element selected").
    # Without it, an intent-gated check like selection-highlight's hard CV veto never
    # activates for ANY tg-sent photo, in ANY language (tg#6188) — the caption was
    # already in the event args and simply ignored. --intent is documented as
    # UNTRUSTED, read-only free text on review's side: it can only TIGHTEN which
    # checks run / how strict the contract is, never loosen a verdict — this hook's
    # whole safety case rests on that being true, since it now hands the sender's own
    # text a channel into the gate. Verified directly against review-cli's source (not
    # just its docstring) as of alex-mextner/review-cli#110:
    #   - reviewlib/features/visual/contract.py::derive_contract / _intent_raises_risk
    #     only ever RAISES risk from intent, never lowers it (`if risk != "high"` guard).
    #   - reviewlib/features/visual/registry.py::ContributedModule.activates and
    #     reviewlib/features/visual/contrib/selection_highlight.py's own `activates`
    #     only ever ADD activation from intent (an OR of independent conditions) — there
    #     is no path where intent text can turn OFF a check.
    # No code path lets intent DEACTIVATE a check or LOWER risk, so forwarding arbitrary
    # caption text here is safe by that existing, source-verified contract.
    #
    # NOT runtime-enforced: `review_bin` resolves via PATH to WHATEVER review-cli is
    # installed, not pinned to the commit this was verified against — there is no
    # version check here. If a future review-cli release ever let intent loosen a
    # verdict, this hook would silently inherit that (the sender-controlled caption
    # would gain real leverage over the gate). Deliberately not adding version
    # enforcement for that here — out of proportion to this fix — but flagging it as an
    # assumption this hook depends on, not a runtime-checked guarantee.
    #
    # ACCEPTED TRADE-OFF: this now applies to EVERY tg photo, not just ones an actor
    # deliberately marked for verification. An ordinary caption that happens to mention
    # a visual concept unrelated to this specific render (e.g. "selected the file in the
    # sidebar") can now trigger an intent-gated CV veto that stayed silent before. That
    # is accepted for the same reason review-cli's own synonym trade-off is (tg#6188):
    # a spurious block is loud and recoverable (resend without that wording, or with
    # --check), a silently-passed false "selected" screenshot is not.
    #
    # Trimmed (not byte-for-byte "verbatim"): only leading/trailing whitespace is
    # stripped; NUL bytes are dropped too, since embedding one in a subprocess argv
    # raises ValueError at call time.
    #
    # CRITICAL: an unencodable caption must DROP --intent, not crash the subprocess
    # call. A NUL byte is not the only argv-breaking input — an unpaired UTF-16
    # surrogate (e.g. a lone "\ud800", which survives a JS JSON.stringify ->
    # Python json.loads round-trip intact) raises UnicodeEncodeError when
    # subprocess.run encodes argv, and that is ALSO a ValueError subclass. If that
    # were allowed to propagate into run_review_visual's `except (OSError, ValueError)`,
    # a sender crafts one caption and the ENTIRE `review visual` call — not just
    # --intent — never runs, resolving to allow(): a caption would then be able to
    # disable visual verification outright, exactly the "intent can loosen a
    # verdict" case the safety comment above says can't happen (review found this
    # as a real, security-relevant gap in an earlier draft of this fix — a bare NUL
    # strip did not cover it). So: pre-flight-encode `intent` here, and on ANY
    # failure drop it to "" (verification still runs, just without --intent) rather
    # than let a malformed value reach subprocess.run at all.
    caption = args.get("caption")
    intent = _safe_intent(caption)

    # NOTE: this hook previously ran a `looks_like_vscode_window()` pixel heuristic
    # that BLOCKED every full VS Code window screenshot (dark left activity-bar
    # strip = block), forcing callers to crop to the preview pane/iframe. Removed
    # 2026-07-03 (HYP-891) at Alex's explicit direction: his tg#6041 standard made
    # full-window screenshots (Explorer/Inspector/Logs panels visible) the DEFAULT
    # desired HyperIDE diagnostic proof format, and the heuristic — which only
    # detected "is this a full window", not "is the preview inside it broken" —
    # hard-blocked that default, legitimate case at least twice in one day.
    #
    # KNOWN TRADEOFF (accepted, not solved): the `review visual --strict` call
    # below is the only remaining gate on a full-window shot, and it judges the
    # WHOLE image — the same limitation the original heuristic's author cited as
    # the reason a broken/unstyled preview pane could get visually diluted behind
    # busy editor chrome. That risk is real and UNVERIFIED either way (no
    # regression test proves `review visual` does or doesn't catch it on a full
    # window). Alex explicitly weighed this and chose to accept it rather than
    # keep gating the now-default proof format — see tg#6063/6064.
    #
    # INTENTIONAL: the watermark scan runs BEFORE the `review` PATH check
    # below, unlike the old fast-path order (review finding: `review`-absent
    # hosts now decode+sample every image, ~tens of ms, where they previously
    # did zero image work). Kept unconditional on purpose — the watermark
    # WARN is independently useful audit-trail signal ("this screenshot may
    # not show what the caption claims") regardless of whether the `review
    # visual` block-gate is even installed on this host, not something that
    # should silently go dark just because the OTHER check is unavailable.
    warn_empty_watermark_if_detected(image_path)

    proc = run_review_visual(image_path, intent)
    if proc is None:
        return allow()
    cwd = event.get("cwd")
    return decide_from_review_result(
        proc, cwd=cwd if isinstance(cwd, str) else "", image_path=image_path
    )


def parse_review_output(stdout: str) -> tuple[dict, bool]:
    """Return (verdict, malformed). malformed is True when stdout is NON-EMPTY
    but not a JSON object — distinct from empty stdout (a clean, structured-less
    success)."""
    stdout = stdout.strip()
    if not stdout:
        return {}, False
    try:
        parsed = json.loads(stdout)
        if isinstance(parsed, dict):
            return parsed, False
        return {}, True
    except (json.JSONDecodeError, ValueError):
        return {}, True


if __name__ == "__main__":
    sys.exit(main())
