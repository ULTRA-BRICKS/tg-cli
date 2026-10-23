/**
 * @file The model-render dimension gate: an agent message that attaches images from a 3D
 * context must attach renders that carry legible dimensions, or it is refused before any API
 * call (tg-cli#785).
 *
 * Accessed via: the `tg` entrypoint, after the intent gate and before `--dry-run`, on the
 * assembled caption and the attached items, for the same senders as the unattached-file gate
 * (an agent in the ancestry or an agent env marker; not `--automated`).
 *
 * WHY: the owner confirms a model before a print by SEEING its sizes. spoon150: the bed was
 * cleared, and a plain render proves nothing about 150 mm or the +25 mm bosses. 3d-cli's
 * `3d dimension` draws the sizes on the render and writes `<image>.dims.json`; its `--check`
 * judges that the labels are legible. This gate makes that the norm for every model render
 * that reaches the owner.
 *
 * WHEN IT APPLIES — a send is a "3D context" when any of these holds:
 *  - the cwd or an attached image sits in a 3D project: under a `garage-band`/`3d-cli` checkout's
 *    `projects/` tree, or below a directory holding a `3d.yaml`;
 *  - the caption names 3D work by a specific term (see THREE_D_TERMS): a .stl/.3mf/.scad file name,
 *    G-code, PLA/PETG filament, "3D print|model|render", the K1 SE, "модель для печати", "ложка" …
 *    Plain words that mean something else in an agent's day ("model" the LLM, "print" a debug line,
 *    the C++ STL, the Filament renderer) do NOT count.
 * and at least one attached image (`--photo`, or a `--file` with an image extension) exists. An
 * empty image file is still gated (fail closed): the send itself would skip it with a warning.
 *
 * WHAT IT REQUIRES per image: a `<image>.dims.json` sidecar and a passing
 * `3d dimension --check <image>` (the legibility rules live in 3d-cli, one definition; the check
 * also verifies the sidecar belongs to exactly this image).
 *
 * OPT-OUT, never silent: a non-model image (a thumbnail, a UI screenshot) is sent with
 * `RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP="<why>"` — the hatch convention shared with the other
 * gates: the written reason becomes ONE approval request to the owner (`tg-ctl ask`); anything
 * but an approval blocks. No flag, no feature toggle and no short reason skips it. This stops
 * an agent that forgets the tool, it is not a defence against one that forges files.
 *
 * PURE — the disk, the `3d` check and the approval are injected.
 */
import { realpathSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { expandHome, isImagePath } from './args';

export const SKIP_ENV = 'RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP';
export const SIDECAR_SUFFIX = '.dims.json';
// A reason must say something: a bare "1" or "skip" is not a justification.
export const MIN_REASON_WORDS = 3;
export const MIN_REASON_CHARS = 15;
// `3d dimension --check` exits 1 when labels are illegible; any other non-zero code (usage error,
// 3d missing) means the check itself could not run. The contract is 3d-cli#477's.
const CHECK_FAILED_EXIT = 1;

export interface AttachedItem {
  type: 'photo' | 'document';
  path: string;
}

// Checkout names whose `projects/` tree holds models, and the file that marks a 3d-cli project.
const PROJECT_REPO_RE = /^(?:garage-band|3d-cli)(?:-[\w.]+)?$/u;
const PROJECT_MARKER = '3d.yaml';
const MARKER_SEARCH_DEPTH = 8;

// Terms that put a caption in 3D work. Whole words only (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`), so
// `imprint`/`sprinter`/`опечатка` never match. Specific on purpose: the gate is always on, and
// "модель" (the LLM), "print" (a log line) or "3d" (three days) are everyday agent vocabulary.
const THREE_D_TERMS = [
  String.raw`openscad`,
  String.raw`g-?code`,
  String.raw`(?:pla|petg|tpu)\s+filament`,
  String.raw`filament\s+\d+\s*(?:g|г)`,
  String.raw`филамент\p{L}*`,
  String.raw`k1\s?se`,
  String.raw`3[dд][\s-]*(?:print\p{L}*|model\p{L}*|render\p{L}*|модел\p{L}*|печат\p{L}*|принт\p{L}*)`,
  String.raw`модел\p{L}*\s+(?:для\s+печати|ложк\p{L}*|детал\p{L}*)`,
  String.raw`печат\p{L}*\s+(?:модел\p{L}*|ложк\p{L}*|детал\p{L}*)`,
  String.raw`ложк\p{L}*`,
  String.raw`(?:print|printing)\s+(?:bed|plate|job)`,
];
const TEXT_3D_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${THREE_D_TERMS.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
// A model file name: `spoon150.stl`, `base.3mf`, `boss.scad` — the extension is what makes it 3D.
const MODEL_FILE_RE = /[\p{L}\p{N}_)-]\.(?:stl|3mf|scad)(?![\p{L}\p{N}])/iu;

export interface FsDeps {
  /** Does a file/dir exist (any kind)? Absolute path. */
  exists: (absolutePath: string) => boolean;
  /** Symlink-resolved path (an image reached through `~/gb -> ~/xp/garage-band`); identity when absent. */
  real?: (absolutePath: string) => string;
}

/** `realpath` that falls back to the absolute path when it does not exist yet; the one resolver the tg gates share. */
export function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface DimensionGateDeps extends FsDeps {
  cwd: string;
  home: string;
}

export interface ImageVerdict {
  path: string;
  /** Why this image fails; empty when it carries legible dimensions. */
  problems: string[];
}

export interface DimensionDecision {
  /** Why the send is 3D work (empty = not gated). */
  contexts: string[];
  /** Attached images (absolute paths) that exist and were examined. */
  images: string[];
}

/** The attached items that are images: every `--photo`, and a `--file` with an image extension. */
export function attachedImages(items: ReadonlyArray<AttachedItem>, cwd: string, home: string): string[] {
  const paths = items
    .filter((item) => item.type === 'photo' || isImagePath(item.path))
    .map((item) => resolve(cwd, expandHome(item.path, home)));
  return [...new Set(paths)];
}

function pathContext(path: string, deps: FsDeps): string | null {
  const segments = path.split('/').filter(Boolean);
  const repoAt = segments.findIndex((s) => PROJECT_REPO_RE.test(s));
  if (repoAt >= 0 && segments.slice(repoAt + 1).includes('projects')) return `${path} is in a 3D project`;
  let dir = path;
  for (let depth = 0; depth < MARKER_SEARCH_DEPTH && dir !== '/' && dir !== '.'; depth += 1) {
    if (deps.exists(`${dir}/${PROJECT_MARKER}`)) return `${dir} holds ${PROJECT_MARKER}`;
    dir = dirname(dir);
  }
  return null;
}

/** Why a send counts as 3D work, or [] when it does not. */
export function threeDContexts(text: string, images: string[], deps: DimensionGateDeps): string[] {
  const out: string[] = [];
  const cwdWhy = pathContext(deps.cwd, deps) ?? (deps.real ? pathContext(deps.real(deps.cwd), deps) : null);
  if (cwdWhy !== null) out.push(`cwd: ${cwdWhy}`);
  for (const image of images) {
    const why = pathContext(dirname(image), deps) ?? (deps.real ? pathContext(dirname(deps.real(image)), deps) : null);
    if (why !== null) out.push(`image ${basename(image)}: ${why}`);
  }
  const hit = TEXT_3D_RE.exec(text) ?? MODEL_FILE_RE.exec(text);
  if (hit !== null) out.push(`the message mentions "${hit[0]}"`);
  return out;
}

/** Apply the gate's scope: what to verify (contexts empty when the send is not 3D work). */
export function decideDimensionGate(text: string, items: ReadonlyArray<AttachedItem>, deps: DimensionGateDeps): DimensionDecision {
  const images = attachedImages(items, deps.cwd, deps.home).filter((p) => deps.exists(p));
  if (images.length === 0) return { contexts: [], images: [] };
  return { contexts: threeDContexts(text, images, deps), images };
}

export interface CheckResult {
  /** Exit code of `3d dimension --check`; null when `3d` could not be run at all. */
  code: number | null;
  /** The check's report (stdout) or the launch error. */
  output: string;
}

export interface ImageCheckDeps extends FsDeps {
  check: (imagePath: string) => CheckResult;
}

function firstLines(text: string, n: number): string {
  return text.trim().split(/\r?\n/u).slice(0, n).join(' | ') || '(no output)';
}

function verifyImage(path: string, deps: ImageCheckDeps): ImageVerdict {
  // A symlinked image has its sidecar beside the real file, and `3d dimension --check` reads that one.
  const target = deps.real ? deps.real(path) : path;
  if (!deps.exists(target + SIDECAR_SUFFIX)) {
    return { path, problems: [`no ${basename(target)}${SIDECAR_SUFFIX} — it was not rendered by \`3d dimension\``] };
  }
  const result = deps.check(target);
  if (result.code === 0) return { path, problems: [] };
  if (result.code === null || result.code !== CHECK_FAILED_EXIT) {
    return { path, problems: [`the legibility check could not run: ${firstLines(result.output, 3)}`] };
  }
  const offenders = result.output
    .split(/\r?\n/u)
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().slice(2));
  return { path, problems: offenders.length > 0 ? offenders : [firstLines(result.output, 3)] };
}

/** Per-image verdicts: sidecar present first (cheap, clear), then the legibility check. */
export function verifyImages(images: string[], deps: ImageCheckDeps): ImageVerdict[] {
  return images.map((path) => verifyImage(path, deps));
}

/** Is `reason` a written justification (enough words and characters, not a bare flag)? */
export function isWrittenReason(reason: string | undefined): reason is string {
  if (reason === undefined) return false;
  const text = reason.trim();
  return text.length >= MIN_REASON_CHARS && text.split(/\s+/u).length >= MIN_REASON_WORDS;
}

/**
 * The refusal text: the contexts, each failing image, and the exact fix. `reasonGiven` is the
 * skip reason the sender already supplied (refused as too short, or not approved) — the text
 * then explains that instead of repeating the advice.
 */
export function formatDimensionGateError(
  contexts: string[],
  verdicts: ImageVerdict[],
  reasonGiven?: string,
  dryRun = false,
): string {
  const bad = verdicts.filter((v) => v.problems.length > 0);
  const optOut =
    reasonGiven === undefined
      ? `Not a model image (a thumbnail, a UI screenshot)? State why in ${SKIP_ENV}="<why>" (at least ${MIN_REASON_WORDS} words and ${MIN_REASON_CHARS} characters) — it is sent to the owner as ONE approval request, deny by default.`
      : isWrittenReason(reasonGiven) && dryRun
        ? `${SKIP_ENV} was given (${reasonGiven.trim()}): a real send would ask the owner to approve it; --dry-run makes no request.`
        : isWrittenReason(reasonGiven)
        ? `${SKIP_ENV} was given (${reasonGiven.trim()}) but the owner did not approve it.`
        : `${SKIP_ENV} was refused: a reason needs at least ${MIN_REASON_WORDS} words and ${MIN_REASON_CHARS} characters, got "${reasonGiven.trim()}".`;
  return [
    'dimension gate: this message sends an image from a 3D context, and the image does not carry legible dimensions.',
    ...contexts.map((c) => `  3D context — ${c}`),
    ...bad.flatMap((v) => [`  ${v.path}`, ...v.problems.map((p) => `    - ${p}`)]),
    'The owner confirms a model by seeing its sizes. Render the model with dimensions and send THAT image:',
    '    3d dimension <model.stl|3mf|scad> -o <render.png> [--bed 220x220] [--dim "name:x,y,z:x,y,z"]',
    '    3d dimension --check <render.png>',
    '    tg --photo <render.png> "<caption: file name, sizes, printer, time, grams>"',
    optOut,
  ].join('\n');
}

/** The approval request the owner sees when an agent asks to skip the gate. */
export function skipRequestText(reason: string, images: string[], contexts: string[]): string {
  return [
    'tg dimension gate: allow sending image(s) WITHOUT dimensions?',
    `Reason: ${reason.trim().replace(/\s+/gu, ' ')}`,
    `Images: ${images.join(', ')}`,
    `3D context: ${contexts.join('; ')}`,
  ].join('\n');
}
