import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync, symlinkSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { runPreSendPhotoHooks, toolHooksDir, trustFile } from '../features/hooks/run-photo-hooks';
import { invocationDigest } from '../features/hooks/types';
import { createHash } from 'crypto';
import { tempDir } from './helpers/test-temp';

// Unit tests for `looks_like_empty_vscode_watermark()` in
// features/hooks/review-descriptor/pre_send_photo.py — the WARN-only
// heuristic that detects VS Code's "no tabs open" watermark (a small,
// compact glyph cluster on an overwhelmingly flat background, dead center
// of the editor pane). Most fixtures here are SYNTHETIC images built with
// assumed shape characteristics (generated via a tiny Python/PIL helper —
// Pillow is already a soft dependency of this hook); tg#6651/tg#6672 added
// the first REAL reference screenshots (tests/fixtures/vscode-empty-
// watermark-*.png, see the dedicated tests below) after the synthetic-only
// calibration turned out to miss the real watermark entirely.

const REPO = join(import.meta.dir, '..');
const PY_HOOK = join(REPO, 'features', 'hooks', 'review-descriptor', 'pre_send_photo.py');

// Pillow is a SOFT dependency of the hook itself (fails open with no PIL),
// but most of these tests need it to build fixture PNGs -- skip the whole
// file's PNG-fixture tests (review finding) rather than hard-fail if
// python3/Pillow aren't on this machine, matching the existing
// tmuxAvailable skipIf pattern in tests/ctl-tmux-integration.test.ts.
// A few tests (pure-logic _trimmed_span_ratio calls, a fail-open path that
// never opens a real image) need only python3, not real PIL -- gating those
// on pilAvailable too would silently skip the one thing they exist to catch
// in exactly the environment (no Pillow) that motivated the gate at all
// (review finding), so they get their own, narrower pythonAvailable check.
function checkAvailable(importLine: string): boolean {
  try {
    const proc = Bun.spawnSync(['python3', '-c', importLine], { stdout: 'ignore', stderr: 'ignore' });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
const pythonAvailable = checkAvailable('pass');
const pilAvailable = checkAvailable('import PIL');

// Full-image size: large enough to clear the detector's 800x500 floor, and
// realistic for a HyperIDE full-window proof screenshot.
const W = 1600;
const H = 900;

// Read WATERMARK_BOX from the module itself rather than hardcoding its
// fraction values a second time here (review finding, tg#6651/tg#6672
// follow-up): several fixtures below need to know exactly which region of
// the image the detector will sample, to place/space content meaningfully
// relative to that box (e.g. "two clusters half the BOX width apart"). A
// copy-pasted literal silently drifts out of sync the next time the box is
// recalibrated -- exactly what happened here, when WATERMARK_BOX narrowed
// from (0.20, 0.90, ...) to (0.25, 0.72, ...) and a fixture computed from
// the old literal kept "passing" for a geometry it no longer actually
// tested. Falls back to the pre-fix literal if python/PIL aren't available
// (this read itself only needs python3, not PIL) so the pilAvailable-gated
// skip below still works without this value.
function readWatermarkBox(): [number, number, number, number] {
  if (!pythonAvailable) return [0.2, 0.9, 0.15, 0.65];
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(import.meta.dir, '..', 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import WATERMARK_BOX
print(",".join(str(v) for v in WATERMARK_BOX))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`reading WATERMARK_BOX failed: ${proc.stderr.toString()}`);
  }
  const [x0, x1, y0, y1] = proc.stdout.toString().trim().split(',').map(Number);
  return [x0, x1, y0, y1];
}
const [BOX_X0, BOX_X1, BOX_Y0, BOX_Y1] = readWatermarkBox();

let home: string;

beforeEach(() => {
  home = tempDir('tg-watermark-');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Build a PNG via PIL and return whether looks_like_empty_vscode_watermark()
// says it looks like the empty-editor watermark. `draw` is a Python snippet
// that receives `im`/`px` (RGB Image + PixelAccess) already sized W x H.
function detect(draw: string): boolean {
  const pngPath = join(home, 'fixture.png');
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from PIL import Image
im = Image.new("RGB", (${W}, ${H}), (30, 30, 30))
px = im.load()
${draw}
im.save(${JSON.stringify(pngPath)})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`fixture python failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim() === 'True';
}

// A compact rectangle of glyph-colored pixels near the geometric center of
// the image — inside the detector's central box (WATERMARK_BOX, read live
// from the module above, not hardcoded here) — on the flat (30,30,30)
// background, sized to land the sampled
// non-bg ratio inside WATERMARK_NONBG_RATIO_RANGE and the span well under
// the compactness caps.
const CENTER_GLYPH_CLUSTER = `
gx0, gy0 = ${Math.round(W * 0.42)}, ${Math.round(H * 0.36)}
for y in range(gy0, gy0 + 60):
    for x in range(gx0, gx0 + 180):
        px[x, y] = (150, 150, 150)
`;

test.skipIf(!pilAvailable)('compact central glyph cluster on flat background -> detected', () => {
  expect(detect(CENTER_GLYPH_CLUSTER)).toBe(true);
});

test.skipIf(!pilAvailable)('glyph cluster shifted right (simulating an Explorer sidebar with no docked right panel) -> still detected', () => {
  // review finding: VS Code's watermark centers on the EDITOR PART, not the
  // window. On the common "Explorer open, nothing docked right" layout, the
  // editor part -- and its watermark -- sits well right of the window's
  // horizontal center (Activity Bar + Explorer eat ~15-20% of width with
  // nothing compensating on the right). Place the cluster around 65% of
  // window width (vs. 42%+90px-wide for the centered fixture) to prove the
  // widened WATERMARK_BOX still catches this common, right-shifted case.
  const draw = `
gx0, gy0 = ${Math.round(W * 0.6)}, ${Math.round(H * 0.36)}
for y in range(gy0, gy0 + 60):
    for x in range(gx0, gx0 + 180):
        px[x, y] = (150, 150, 150)
`;
  expect(detect(draw)).toBe(true);
});

test.skipIf(!pilAvailable)('oversized (4K) screenshot triggers the BOX-downscale path and still detects the cluster', () => {
  // review finding: WATERMARK_BOX_MAX_DIM=1200 downscaling in _sample_box
  // only activates when the CROPPED BOX's longest side exceeds 1200px --
  // every other fixture in this file uses a 1600x900 source (box ~1120px,
  // under the cap), so the resize branch itself was never exercised by any
  // test. A 3840x2160 (4K) source crops to a ~2688x1080 box, comfortably
  // over the cap, forcing the Image.Resampling.BOX downscale path. Proves
  // detection still works post-resize, not just that the code path doesn't
  // crash.
  const bigW = 3840;
  const bigH = 2160;
  const pngPath = join(home, 'big.png');
  const script = `
from PIL import Image
im = Image.new("RGB", (${bigW}, ${bigH}), (30, 30, 30))
px = im.load()
gx0, gy0 = ${Math.round(bigW * 0.42)}, ${Math.round(bigH * 0.36)}
for y in range(gy0, gy0 + 144):
    for x in range(gx0, gx0 + 432):
        px[x, y] = (150, 150, 150)
im.save(${JSON.stringify(pngPath)})
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('True');
});

test.skipIf(!pilAvailable)('oversized (4K) screenshot with THIN sparse strokes (not a bulky block) still detected post-downscale', () => {
  // review finding: the "oversized (4K)" test above only proves a SOLID
  // block survives BOX-averaging downscale -- CHANGELOG's own caveat is
  // that area-averaging could blend a very thin stroke into the background
  // closely enough to fall inside WATERMARK_BG_TOL and push non_bg_ratio
  // below the floor, i.e. a false negative on exactly the combination
  // (large screenshot + thin realistic watermark) this feature targets.
  // Neither the 4K fixture (solid block) nor the thin-stroke fixture
  // (1600x900, under the resize cap) exercised BOTH conditions together.
  // Empirically: unscaled (absolute-pixel) icon+text-row strokes on a 4K
  // canvas are proportionally even smaller than at 1600x900, so if
  // anything this is a HARDER case than the 1600x900 sparse test -- and it
  // still detects, because BOX-downscaling a ~2688px-wide box down to 1200
  // is only a ~2.24x reduction, not enough to fully erase a 3px stroke into
  // the background tolerance.
  const bigW = 3840;
  const bigH = 2160;
  const pngPath = join(home, 'big-thin.png');
  const script = `
from PIL import Image
im = Image.new("RGB", (${bigW}, ${bigH}), (30, 30, 30))
px = im.load()
gx0, gy0 = ${Math.round(bigW * 0.6)}, ${Math.round(bigH * 0.32)}
icon_size, row_h, row_gap, n_rows, row_w = 24, 3, 18, 5, 160
for y in range(gy0, gy0 + icon_size):
    for x in range(gx0, gx0 + icon_size):
        px[x, y] = (140, 140, 140)
for row in range(n_rows):
    ly = gy0 + icon_size + 16 + row * row_gap
    for y in range(ly, ly + row_h):
        for x in range(gx0, gx0 + row_w):
            px[x, y] = (130, 130, 130)
im.save(${JSON.stringify(pngPath)})
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('True');
});

test.skipIf(!pilAvailable)('sparse thin-row glyphs (small icon block + 5 thin text-hint rows, NOT a bulky block) -> still detected', () => {
  // review finding (twice): every other positive fixture uses a solid 180x60
  // filled rectangle (non_bg_ratio ~0.021), but VS Code's real watermark is
  // sparse icon/text strokes. An EARLIER version of this fixture drew 1px
  // lines by raw pixel writes and was itself an aliasing bug: the detector
  // samples every 3rd pixel (WATERMARK_SAMPLE_STEP=3), and 1px-tall rows
  // landed on sampled rows only by phase-luck (the reviewer proved the text
  // rows contributed ZERO sampled pixels in that version -- only the icon's
  // edges did, coincidentally). Fixed by making every stroke >=3px in BOTH
  // dimensions, which guarantees at least one sampled pixel per stroke
  // REGARDLESS of grid phase (any 3 consecutive rows/columns contain exactly
  // one multiple of 3) -- verified stable across multiple (gx0, gy0) phase
  // offsets, not just the one this test happens to use.
  const draw = `
gx0, gy0 = ${Math.round(W * 0.6)}, ${Math.round(H * 0.32)}
icon_size, row_h, row_gap, n_rows, row_w = 24, 3, 18, 5, 160
for y in range(gy0, gy0 + icon_size):
    for x in range(gx0, gx0 + icon_size):
        px[x, y] = (140, 140, 140)
for row in range(n_rows):
    ly = gy0 + icon_size + 16 + row * row_gap
    for y in range(ly, ly + row_h):
        for x in range(gx0, gx0 + row_w):
            px[x, y] = (130, 130, 130)
`;
  expect(detect(draw)).toBe(true);
});

test.skipIf(!pilAvailable)('REAL empty VS Code window screenshot (tg#6651/tg#6672) -> detected', () => {
  // Every fixture above this point is SYNTHETIC (high-contrast, ~120-level
  // glyph-on-background) and was blind to the actual bug this locks in: a
  // real captured VS Code Dark Modern "no tabs open" watermark is a single
  // flat translucent LOGO mark with only ~6-7 RGB levels of contrast against
  // the editor background -- an order of magnitude subtler than every
  // synthetic fixture in this file, and invisible under the OLD
  // WATERMARK_BG_TOL=20. Two independently captured real screenshots (same
  // window layout -- Explorer + a docked Chat panel, zero editor tabs --
  // differing only in Explorer tree state) both returned False under the
  // pre-fix constants; investigating why found the OLD WATERMARK_BOX also
  // physically overlapped the docked Chat panel, polluting the signal with
  // panel content/divider lines instead of the watermark itself. See the
  // CALIBRATION comment above WATERMARK_BOX in pre_send_photo.py for the
  // full pixel-level analysis.
  const fixture1 = join(REPO, 'tests', 'fixtures', 'vscode-empty-watermark-1.png');
  const fixture2 = join(REPO, 'tests', 'fixtures', 'vscode-empty-watermark-2.png');
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(fixture1)}))
print(looks_like_empty_vscode_watermark(${JSON.stringify(fixture2)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  const lines = proc.stdout.toString().trim().split('\n');
  expect(lines[0]).toBe('True');
  expect(lines[1]).toBe('True');
});

test.skipIf(!pilAvailable)('REAL busy full-window screenshot (code editor + preview pane) -> NOT detected (review finding)', () => {
  // review finding: recalibrating for the real-watermark positive case above
  // (lowering WATERMARK_BG_TOL, widening WATERMARK_NONBG_RATIO_RANGE and
  // WATERMARK_MAX_SPAN_RATIO) is a sensitivity INCREASE, and this file's own
  // history (HYP-891) is entirely about a prior heuristic that false-
  // positived on legitimate busy screenshots. The "dense random content" /
  // "12000 scattered points" negative fixtures above are SYNTHETIC noise,
  // not a real HyperIDE layout -- they don't prove the recalibrated
  // constants stay quiet on an actual busy window. This fixture is a real
  // capture (Explorer + a real code file open in the editor + the Hyper
  // Canvas preview pane showing a readonly-mode notice with an icon and a
  // table -- a shape not unlike a watermark at a glance) pulled from an
  // unrelated HyperIDE e2e run. Locks in the false-positive direction the
  // two real positive fixtures above don't cover.
  const fixture = join(REPO, 'tests', 'fixtures', 'vscode-busy-content-1.png');
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(fixture)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('False');
});

test.skipIf(!pythonAvailable)('_trimmed_span_ratio: a single far outlier does not blow up the span at small n (review finding)', () => {
  // Unit-tests _trimmed_span_ratio directly (bypassing the full detector's
  // density-floor gate) because the realistic small-n regime this guards --
  // roughly 3-19 non-bg samples -- can sit below the current
  // WATERMARK_NONBG_RATIO_RANGE floor, making it unreachable through the
  // full looks_like_empty_vscode_watermark() pipeline; the function itself
  // must still be correct in isolation (defense in depth if the floor is
  // ever lowered again, and the function is documented as a general-purpose
  // "robust to a lone outlier" utility, not one only valid above ~20 points).
  //
  // 13 clustered coords in [30, 39] plus ONE outlier at 1119 (near the far
  // edge of a size=1120 span; n=14 total). The OLD implementation
  // (`int(n*trim)` with no floor) computed a trim count of 0 for n=14, so
  // the outlier was never removed: span = 1119-30 = 1089, ratio ~0.972 --
  // comfortably over ANY reasonable compactness threshold, exactly the
  // false-negative the docstring claims not to have. The fixed version
  // guarantees >=1 point trimmed off each end once n>=4 (n=3 stays
  // untrimmed -- see the dedicated n=3 test below), which removes exactly
  // this outlier.
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import _trimmed_span_ratio
coords = [30, 30, 30, 33, 33, 33, 36, 36, 36, 39, 39, 39, 39, 1119]
print(_trimmed_span_ratio(coords, 1120))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  const ratio = Number.parseFloat(proc.stdout.toString().trim());
  expect(ratio).toBeLessThan(0.05);
});

test.skipIf(!pythonAvailable)('_trimmed_span_ratio: n=3 does NOT collapse to a degenerate 0 span (review finding)', () => {
  // Directly asserts the exact degenerate case the fix's own docstring
  // names as motivation: 3 evenly-spread points must NOT trim to a single
  // midpoint (which would read as maximally "compact" regardless of the
  // real spread). max_k = (n-2)//2 = 0 for n=3, so trimming is skipped
  // entirely and the raw span is returned -- 1.0, not 0.0.
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import _trimmed_span_ratio
print(_trimmed_span_ratio([0, 500, 1000], 1000))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  const ratio = Number.parseFloat(proc.stdout.toString().trim());
  expect(ratio).toBeCloseTo(1.0);
});

test.skipIf(!pythonAvailable)('_trimmed_span_ratio: a single point has zero span', () => {
  // Locks in the n=1 edge case as an explicit contract, not just an
  // untested implication of the general formula (review finding) -- the
  // function is documented as a general-purpose, independently-tested
  // utility, so its behavior at the smallest possible input should be
  // asserted directly, not just reasoned about.
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import _trimmed_span_ratio
print(_trimmed_span_ratio([500], 1000))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  const ratio = Number.parseFloat(proc.stdout.toString().trim());
  expect(ratio).toBe(0);
});

test.skipIf(!pilAvailable)('compact glyph cluster on a NOISY near-flat background (JPEG-like re-compression) -> still detected', () => {
  // A real screenshot's "flat" editor background is rarely one exact
  // repeating RGB tuple (PNG re-encoding, Telegram's JPEG re-compression,
  // font-AA bleed). Perturb every background pixel by a small random amount
  // around (30,30,30) so no single exact color is a majority -- this is what
  // defeated an earlier exact-tuple mode-color implementation.
  const draw = `
import random
random.seed(11)
bx0, bx1 = int(${W} * ${BOX_X0}), int(${W} * ${BOX_X1})
by0, by1 = int(${H} * ${BOX_Y0}), int(${H} * ${BOX_Y1})
for y in range(by0, by1, 2):
    for x in range(bx0, bx1, 2):
        n = random.randint(-4, 4)
        px[x, y] = (30 + n, 30 + n, 30 + n)
${CENTER_GLYPH_CLUSTER}
`;
  expect(detect(draw)).toBe(true);
});

test.skipIf(!pilAvailable)('dense random content filling the central pane -> NOT detected', () => {
  // Real content (code, a rendered preview, a webview) has no single
  // dominant flat color across the sampled grid. IMPORTANT: paint every
  // pixel (step 1), not a coarser step -- a draw step that shares a small
  // common multiple with the detector's own WATERMARK_SAMPLE_STEP=3 (e.g.
  // step 5: only 1-in-25 sampled points ever land on a drawn pixel) makes
  // this fixture accidentally clear the DENSITY check and get rejected by
  // the SPAN check instead, leaving the density/non_bg_ratio branch --
  // the actual thing that distinguishes "real content" rejection from the
  // removed heuristic -- completely untested (review finding).
  const draw = `
import random
random.seed(7)
bx0, bx1 = int(${W} * ${BOX_X0}), int(${W} * ${BOX_X1})
by0, by1 = int(${H} * ${BOX_Y0}), int(${H} * ${BOX_Y1})
for y in range(by0, by1):
    for x in range(bx0, bx1):
        px[x, y] = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
`;
  expect(detect(draw)).toBe(false);
});

test.skipIf(!pilAvailable)('two compact clusters ~54% of the box apart (moderate spread, still low density) -> NOT detected', () => {
  // review finding: the two existing span-negative fixtures only test the
  // extremes -- "dense random" fails on DENSITY, "12000 scattered points"
  // fails with span ~0.9 (the whole box). Nothing exercised the middle
  // ground: a pattern with density comfortably inside
  // WATERMARK_NONBG_RATIO_RANGE (real content could plausibly produce this)
  // but spread widely enough that it should NOT read as "small, compact".
  // Two separate compact glyph-sized blocks ~54% of the box width apart
  // (non_bg_ratio ~0.01, well within range) locks in that the tightened
  // WATERMARK_MAX_SPAN_RATIO (0.35, 0.40) actually rejects this, not just
  // the two extremes.
  const draw = `
bx0 = int(${W} * ${BOX_X0})
by0 = int(${H} * ${BOX_Y0})
box_w = int(${W} * ${BOX_X1}) - bx0
c1x, c1y = bx0 + 40, by0 + 150
c2x, c2y = bx0 + 40 + int(box_w * 0.5), by0 + 150
for gx, gy in [(c1x, c1y), (c2x, c2y)]:
    for y in range(gy, gy + 40):
        for x in range(gx, gx + 60):
            px[x, y] = (150, 150, 150)
`;
  expect(detect(draw)).toBe(false);
});

test.skipIf(!pilAvailable)('perfectly solid flat pane with zero glyphs (blank/crashed render) -> NOT detected', () => {
  // No draw() at all: the whole image stays the single flat background
  // color. Zero glyphs is a DIFFERENT bug signature (a blank/crashed
  // webview), not the watermark this detector targets.
  expect(detect('')).toBe(false);
});

test.skipIf(!pilAvailable)('glyph pixels scattered across the whole pane (not compact) -> NOT detected', () => {
  // The detector samples the box on a step-3 grid, so only ~1/9 of raw pixel
  // writes actually land on a sampled point -- draw enough scattered pixels
  // (12000, chosen so the SAMPLED non-bg ratio lands mid-range, ~0.04, well
  // inside [0.005, 0.10]) that a low-density false pass is ruled out and a
  // False verdict here can only come from the compactness (span) check, the
  // thing this test means to isolate -- not from the density check as well.
  const draw = `
bx0, bx1 = int(${W} * ${BOX_X0}), int(${W} * ${BOX_X1})
by0, by1 = int(${H} * ${BOX_Y0}), int(${H} * ${BOX_Y1})
import random
random.seed(3)
for _ in range(12000):
    x = random.randint(bx0, bx1 - 1)
    y = random.randint(by0, by1 - 1)
    px[x, y] = (150, 150, 150)
`;
  expect(detect(draw)).toBe(false);
});

test.skipIf(!pilAvailable)('KNOWN LIMITATION: ANY small compact UI element on a flat pane also warns, not just VS Code watermark glyphs', () => {
  // review finding (twice, widened wording): the detector cannot distinguish
  // VS Code's specific watermark glyphs from any other small, compact,
  // roughly-centered non-background patch on an otherwise flat pane. The
  // false-positive surface is broader than "dialog/spinner/toast" -- it's
  // ANY of: a centered modal dialog, a loading spinner, a toast, an
  // almost-empty terminal with just a prompt, a nearly-empty file with a
  // couple of lines near vertical-center, a preview pane showing a single
  // logo on a white background. This is a DELIBERATE, accepted
  // false-positive surface for a WARN-only, unvalidated heuristic (see
  // warn_empty_watermark_if_detected's docstring) -- documented here as an
  // executable spec of the limitation, not a bug to fix. Promoting this
  // detector to a block would need to close this gap first.
  const draw = `
gx0, gy0 = ${Math.round(W * 0.55)}, ${Math.round(H * 0.4)}
for y in range(gy0, gy0 + 40):
    for x in range(gx0, gx0 + 140):
        px[x, y] = (170, 170, 170)
`;
  expect(detect(draw)).toBe(true);
});

test.skipIf(!pilAvailable)('image smaller than the detector floor (800x500) -> NOT detected', () => {
  const pngPath = join(home, 'small.png');
  const script = `
from PIL import Image
im = Image.new("RGB", (400, 300), (30, 30, 30))
im.save(${JSON.stringify(pngPath)})
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('False');
});

test.skipIf(!pythonAvailable)('unreadable/nonexistent image path -> fails open (False), never throws', () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark("/does/not/exist.png"))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('False');
});

test.skipIf(!pilAvailable)('image at EXACTLY the detector floor (800x500) is NOT skipped (boundary check)', () => {
  // review finding: the floor check is `if w < 800 or h < 500: return
  // empty` -- strict less-than, so 800x500 itself must proceed to
  // sampling, not be skipped. The test above only proves a SMALLER image
  // (400x300) is skipped; nothing locked in that the boundary itself
  // (`<` vs `<=`) is on the intended side. A watermark-shaped cluster
  // scaled to fit an 800x500 canvas must still be DETECTED -- if the floor
  // were accidentally `<=`, _sample_box would return empty samples and this
  // would silently read as "not detected" for the wrong reason.
  const pngPath = join(home, 'exact-floor.png');
  const script = `
from PIL import Image
im = Image.new("RGB", (800, 500), (30, 30, 30))
px = im.load()
gx0, gy0 = ${Math.round(800 * 0.42)}, ${Math.round(500 * 0.36)}
for y in range(gy0, gy0 + 30):
    for x in range(gx0, gx0 + 90):
        px[x, y] = (150, 150, 150)
im.save(${JSON.stringify(pngPath)})
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('True');
});

test.skipIf(!pilAvailable)('a truncated/corrupt image file fails open (False) via the outer except, not a crash', () => {
  // review finding: the guards cover "file too big" and "path doesn't
  // exist", but the likeliest real-world failure on a BAD (not just
  // absent/oversized) image -- a truncated write, a corrupted download --
  // is `Image.open(...).convert("RGB")` raising OSError partway through
  // decoding. Nothing exercised that specific path; prove it's caught by
  // the blanket `except Exception -> False` like every other failure mode,
  // not a special case that was missed.
  const pngPath = join(home, 'truncated.png');
  const script = `
from PIL import Image
import io
buf = io.BytesIO()
im = Image.new("RGB", (1600, 900), (30, 30, 30))
im.save(buf, format="PNG")
full = buf.getvalue()
# Write only the first half -- a valid PNG header/signature but a truncated,
# undecodable data stream (Image.open reads the header lazily and succeeds;
# .convert("RGB") is what forces the full decode and raises).
with open(${JSON.stringify(pngPath)}, "wb") as f:
    f.write(full[: len(full) // 2])
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('False');
});

test.skipIf(!pythonAvailable)('a file over WATERMARK_MAX_FILE_BYTES skips the heuristic without decoding it (False)', () => {
  // review finding: Image.open(...).convert("RGB") forces a full decode of
  // the SOURCE resolution before WATERMARK_BOX_MAX_DIM's sampling cap can
  // even apply, with no timeout -- unlike a bounded PixelAccess loop, PIL's
  // decode time isn't something this module controls. A cheap
  // os.path.getsize stat (no decode at all) skips the heuristic outright
  // above a size floor. Prove it via a file that ISN'T even a valid PNG --
  // if the size guard didn't fire first, Image.open would raise (caught by
  // the outer except, also False) but for the WRONG reason; this asserts
  // the guard triggers before any attempt to open the file.
  //
  // Written under `home` (this test's own temp dir, cleaned by
  // afterEach), not the repo root (review finding) -- a repo-root path
  // risks leaving an untracked >20MB junk file behind if the subprocess
  // is ever killed between the write and the `os.remove` cleanup below.
  const script = `
import sys, os
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
import pre_send_photo as m
huge_path = ${JSON.stringify(join(home, '__huge_fake_fixture.bin'))}
with open(huge_path, "wb") as f:
    f.seek(m.WATERMARK_MAX_FILE_BYTES + 1)
    f.write(b"\\0")
try:
    print(m.looks_like_empty_vscode_watermark(huge_path))
    bw, bh, samples = m._sample_box(huge_path)
    print("samples:", len(samples))
finally:
    os.remove(huge_path)
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  const lines = proc.stdout.toString().trim().split('\n');
  expect(lines[0]).toBe('False');
  expect(lines[1]).toBe('samples: 0');
});

test.skipIf(!pilAvailable)('a small FILE with a huge DECODED pixel count is skipped WITHOUT the full RGB decode (False)', () => {
  // review finding: WATERMARK_MAX_FILE_BYTES bounds the COMPRESSED size on
  // disk, not the decoded pixel count -- a flat-color (or otherwise highly
  // compressible) source can be tiny on disk yet decode to tens of
  // megapixels, and `.convert("RGB")` forces that full decode with no
  // timeout. A flat 8000x6000 (48MP) PNG compresses to well under 1MB, so
  // it clears WATERMARK_MAX_FILE_BYTES but must still be rejected by the
  // pixel-count guard (`im.size` is read from the file header before any
  // pixel decode, so this check is cheap regardless of the image's true
  // resolution).
  const pngPath = join(home, 'huge_pixels.png');
  const script = `
from PIL import Image
import os
im = Image.new("RGB", (8000, 6000), (30, 30, 30))
im.save(${JSON.stringify(pngPath)})
print("file_mb:", os.path.getsize(${JSON.stringify(pngPath)}) / 1e6)
import sys
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
import pre_send_photo as m
assert 8000 * 6000 > m.WATERMARK_MAX_PIXELS, "fixture must exceed the guard to prove anything"
print(m.looks_like_empty_vscode_watermark(${JSON.stringify(pngPath)}))
bw, bh, samples = m._sample_box(${JSON.stringify(pngPath)})
print("samples:", len(samples))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  const lines = proc.stdout.toString().trim().split('\n');
  expect(lines[1]).toBe('False');
  expect(lines[2]).toBe('samples: 0');
});

test.skipIf(!pythonAvailable)('PIL genuinely unavailable (ImportError inside the detector) -> fails open (False), never throws', () => {
  // Needs only python3, NOT real Pillow -- this test exists specifically to
  // simulate Pillow's ABSENCE, so gating it on pilAvailable would skip the
  // one thing it covers in exactly the no-Pillow environment that matters
  // (same class of gate mismatch as the two tests above, review finding).
  //
  // The "unreadable path" test above only exercises the "bad path" branch of
  // the try/except -- PIL itself is installed in this environment, so it
  // never hits the `from PIL import Image` line's own failure mode. Force
  // that specific failure by poisoning sys.modules['PIL'] before
  // pre_send_photo is imported, so `_sample_box`'s deferred `from PIL import
  // Image` raises ImportError -- the exact case the docstring claims
  // fail-open for. The image path is never actually OPENED as an image
  // (the poisoned import raises first) -- but it DOES need to exist and be
  // small, because `_sample_box` now checks `os.path.getsize` (the
  // WATERMARK_MAX_FILE_BYTES guard, added later in this same diff) BEFORE
  // `from PIL import Image` runs. A nonexistent placeholder path used to
  // work here, but now short-circuits on `getsize`'s own FileNotFoundError
  // before ever reaching the poisoned import -- passing for the WRONG
  // reason, not exercising the ImportError branch at all (review finding).
  // PY_HOOK (this hook's own source file) is a convenient existing, small,
  // non-image file -- its content is irrelevant since it's never opened.
  const script = `
import sys
sys.modules['PIL'] = None
sys.path.insert(0, ${JSON.stringify(join(REPO, 'features', 'hooks', 'review-descriptor'))})
from pre_send_photo import looks_like_empty_vscode_watermark
print(looks_like_empty_vscode_watermark(${JSON.stringify(PY_HOOK)}))
`;
  const proc = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('False');
});

// --- end-to-end through the hook: WARN, never block ------------------------

function installDescriptorTrusted(): void {
  const dir = toolHooksDir(home);
  Bun.spawnSync(['mkdir', '-p', dir]);
  writeFileSync(
    join(dir, 'review-visual.pre-send-photo.json'),
    JSON.stringify({ id: 'review-visual', point: 'pre-send-photo', cmd: PY_HOOK, timeout_ms: 60000, on_error: 'open' }),
  );
  const sha = createHash('sha256').update(readFileSync(PY_HOOK)).digest('hex');
  const invSha = createHash('sha256').update(invocationDigest(PY_HOOK, undefined, 60000), 'utf8').digest('hex');
  writeFileSync(
    trustFile(home),
    JSON.stringify({
      'review-visual.pre-send-photo': {
        cmd_sha256: sha,
        invocation_sha256: invSha,
        point: 'pre-send-photo',
        on_error: 'open',
      },
    }),
  );
}

// Generate a watermark-shaped fixture PNG and install a fake `review` binary
// emitting the given verdict. Returns the fixture path + the PATH-augmented
// binDir the caller must splice into process.env.PATH.
function setupWatermarkFixture(jsonVerdict: string, exitCode: number): { pngPath: string; binDir: string } {
  const binDir = join(home, 'bin');
  Bun.spawnSync(['mkdir', '-p', binDir]);
  const review = join(binDir, 'review');
  writeFileSync(review, `#!/usr/bin/env bash\ncat <<'JSON'\n${jsonVerdict}\nJSON\nexit ${exitCode}\n`);
  Bun.spawnSync(['chmod', '+x', review]);

  const pngPath = join(home, 'watermark.png');
  const script = `
from PIL import Image
im = Image.new("RGB", (${W}, ${H}), (30, 30, 30))
px = im.load()
${CENTER_GLYPH_CLUSTER}
im.save(${JSON.stringify(pngPath)})
`;
  const gen = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(gen.exitCode).toBe(0);
  return { pngPath, binDir };
}

// Run runPreSendPhotoHooks() while capturing everything the runner passes to
// its `warn` sink (console.error, per buildRunnerDeps) -- the only place the
// hook's stderr (and thus the watermark WARN text) surfaces to the caller.
function runCapturingWarnings(pngPath: string, binDir: string): { blocked: boolean; warnings: string[] } {
  installDescriptorTrusted();
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'hi' }, process.env, home);
    return { blocked: v.blocked, warnings };
  } finally {
    console.error = originalError;
    // savedPath is realistically always defined (PATH is always set in any
    // shell this suite runs under), but `process.env.PATH = undefined`
    // would coerce to the literal string "undefined" rather than clearing
    // it -- guard explicitly instead of relying on that assumption.
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
  }
}

test.skipIf(!pilAvailable)('a watermark-shaped screenshot WARNS and still SENDS when review visual says keep', () => {
  const { pngPath, binDir } = setupWatermarkFixture('{"decision":"keep"}', 0);
  const { blocked, warnings } = runCapturingWarnings(pngPath, binDir);
  expect(blocked).toBe(false);
  expect(warnings.some((w) => w.includes('possible empty-editor watermark'))).toBe(true);
});

test.skipIf(!pilAvailable)('a watermark-shaped screenshot still BLOCKS when review visual says rollback (warn does not suppress block)', () => {
  // Proves warn_empty_watermark_if_detected and the main()->run_review_visual/
  // decide_from_review_result split coexist correctly: the watermark WARN
  // fires, but a genuine rollback verdict still blocks the send.
  const { pngPath, binDir } = setupWatermarkFixture('{"decision":"rollback","reason":"Unstyled render"}', 10);
  const { blocked, warnings } = runCapturingWarnings(pngPath, binDir);
  expect(blocked).toBe(true);
  expect(warnings.some((w) => w.includes('possible empty-editor watermark'))).toBe(true);
});

test.skipIf(!pilAvailable)('watermark WARN still fires when `review` itself is NOT on PATH (independent of the block gate)', () => {
  // review finding: main()'s own comment claims the watermark scan is
  // "INTENTIONAL...independently useful audit-trail signal...regardless of
  // whether the `review visual` block-gate is even installed on this host"
  // -- but every other e2e test in this file always installs a fake
  // `review` binary via setupWatermarkFixture's binDir. That claimed
  // invariant was never actually exercised. Build an ISOLATED PATH with NO
  // `review` binary at all (only a symlinked python3, so the hook's
  // `#!/usr/bin/env python3` shebang still resolves -- same isolation
  // pattern as the "review missing on PATH" test in
  // hooks-review-descriptor.test.ts) and confirm: the send still proceeds
  // (fail-open, run_review_visual returns None) AND the watermark WARN
  // still appears in the audit trail.
  const binDir = join(home, 'bin-no-review');
  Bun.spawnSync(['mkdir', '-p', binDir]);
  const realPython = Bun.which('python3');
  expect(realPython).toBeTruthy();
  symlinkSync(realPython as string, join(binDir, 'python3'));
  expect(Bun.which('review', { PATH: `${binDir}:/usr/bin:/bin` })).toBeNull();

  const pngPath = join(home, 'watermark-no-review.png');
  const script = `
from PIL import Image
im = Image.new("RGB", (${W}, ${H}), (30, 30, 30))
px = im.load()
${CENTER_GLYPH_CLUSTER}
im.save(${JSON.stringify(pngPath)})
`;
  const gen = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(gen.exitCode).toBe(0);

  installDescriptorTrusted();
  const isolatedEnv = { ...process.env, PATH: `${binDir}:/usr/bin:/bin` };
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'hi' }, isolatedEnv, home);
    expect(v.blocked).toBe(false);
    expect(warnings.some((w) => w.includes('possible empty-editor watermark'))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test.skipIf(!pilAvailable)('a REAL-content full-window screenshot produces NO watermark warning (symmetric false-positive check)', () => {
  // The two tests above only ever exercise a watermark-shaped fixture -- they
  // cannot catch a regression where the detector starts firing on ANY
  // full-window screenshot (exactly the HYP-891 failure mode). Prove the
  // negative explicitly: dense, varied content through the same end-to-end
  // path produces zero watermark-related lines in the audit trail. Paint
  // every pixel (step 1), not a coarser step -- see the "dense random
  // content" unit test's comment for why a coarser step can accidentally
  // clear the DENSITY check (aliasing against WATERMARK_SAMPLE_STEP=3) and
  // leave this end-to-end path rejecting only via the span check.
  const binDir = join(home, 'bin');
  Bun.spawnSync(['mkdir', '-p', binDir]);
  const review = join(binDir, 'review');
  writeFileSync(review, '#!/usr/bin/env bash\ncat <<\'JSON\'\n{"decision":"keep"}\nJSON\nexit 0\n');
  Bun.spawnSync(['chmod', '+x', review]);

  const pngPath = join(home, 'busy.png');
  const script = `
import random
random.seed(42)
from PIL import Image
im = Image.new("RGB", (${W}, ${H}), (30, 30, 30))
px = im.load()
for y in range(0, ${H}):
    for x in range(0, ${W}):
        px[x, y] = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
im.save(${JSON.stringify(pngPath)})
`;
  const gen = Bun.spawnSync(['python3', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(gen.exitCode).toBe(0);

  const { blocked, warnings } = runCapturingWarnings(pngPath, binDir);
  expect(blocked).toBe(false);
  expect(warnings.some((w) => w.includes('possible empty-editor watermark'))).toBe(false);
});
