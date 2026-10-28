// Text-rendering and file-content inputs of the send plan (tg-cli#817, baseline `tg` 2440-2519).
//
// `buildSendPlan` (features/auto-attach/normalize.ts) takes two injected inputs: the R2 file
// contents and the `renderText` hook. Both are built here from the already-assembled message.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { convertEntitiesToHtml, detectHtmlTags, parseEmojiHelpers } from "../../render/html"
import type { PrefixParts } from "../../render/prefix"
import type { Format } from "../args"
import type { SendAction } from "./types"

export interface RenderedText {
  text: string
  format: Format
}

export type RenderText = (stripped: string, fmt: Format) => RenderedText

export interface RenderInputs {
  prefix: PrefixParts
  hasQuotes: boolean
  hasAutolink: boolean
}

/**
 * Disk reader injected into the pure `planLineSpecs`. The planner's own TEXT_EXTS gate decides ext
 * eligibility, so this reader only ever runs on a text-ext path; a null result (missing/unreadable)
 * makes the planner fall through to attach-as-is and never silently drop a file.
 */
export function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

/**
 * renderText hook: prefix + emoji → inline <tg-emoji> HTML.
 * Pipeline order (forced, see normalize.ts): decode → extract(R2/R4) → THIS
 * hook on the surviving prose → assemble. Rendering AFTER extraction keeps
 * emoji-entity offsets valid (a strip would otherwise shift them) and avoids
 * substituting :helper: markers inside text we're about to remove. Line-spec
 * quotes are inserted AFTER this hook (anchored on the token) so the injected
 * <pre> can't flip the userHtml/escape decision below.
 */
export function createRenderText({ prefix, hasQuotes, hasAutolink }: RenderInputs): RenderText {
  return (stripped, fmt) => {
    const parsedCaption = parseEmojiHelpers(stripped)
    // buildPrefix already rendered the prefix to finished html/plain (its emoji
    // tag and styled [window] are OURS, not user-authored HTML), so userHtml is
    // decided by the CAPTION alone. The caption's own custom-emoji entities are
    // rendered to inline <tg-emoji> here (offset-based, they would be
    // invalidated by the >4096 splitter); the trusted prefix is then prepended.
    //   "User HTML"  = caption asked for --format html or wrote real tags.
    //   "Forced HTML" = a custom emoji / <b> window fallback, line-spec quotes,
    //     or autolink — escape the caption's plain text so literals can't break
    //     parsing.
    // Auto-detect Telegram HTML tags in the body: if the text contains known
    // Telegram markup (<b>, <i>, <code>, <pre>, <a>, etc.) treat it as HTML even
    // without an explicit --format html. This lets agents write HTML-formatted
    // reports naturally without the flag, while comparison operators like `2 < 3`
    // or unknown tags like `<foo>` are never mis-treated (detectHtmlTags only
    // matches the Telegram-supported tag set).
    const userHtml = fmt === "html" || detectHtmlTags(parsedCaption.text)
    const renderToHtml =
      userHtml || prefix.forceHtml || parsedCaption.entities.length > 0 || hasQuotes || hasAutolink
    if (!renderToHtml) return { text: prefix.plain + parsedCaption.text, format: "plain" }
    const captionHtml = convertEntitiesToHtml(parsedCaption.text, parsedCaption.entities, !userHtml)
    return { text: prefix.html + captionHtml, format: "html" }
  }
}

const R2_MAX_BYTES = 256 * 1024

/**
 * Reads at most `cap` bytes from an already-open descriptor; null when more than `cap` bytes are
 * actually there. The size is never taken from fstat: a growing file can pass a size precheck and
 * then exceed the cap, so the real byte count decides. At most `cap + 1` bytes are ever allocated.
 */
export function readBoundedUtf8(fd: number, cap: number): string | null {
  const buf = Buffer.allocUnsafe(cap + 1)
  let total = 0
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, null)
    if (n === 0) break
    total += n
  }
  return total > cap ? null : buf.toString("utf8", 0, total)
}

function readCappedContent(path: string): { path: string; content: string } | null {
  let fd: number | null = null
  try {
    // Type is checked on the OPENED descriptor (no stat-then-open race); O_NONBLOCK keeps a FIFO
    // from stalling the open, and only a regular file is read. The size cap is enforced on the
    // bytes actually read, not on the (changeable) fstat size.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return null
    const content = readBoundedUtf8(fd, R2_MAX_BYTES)
    return content === null ? null : { path, content }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * File contents for R2 (duplicated-paste detection).
 * Only DOCUMENT items, read from disk, size-capped — string-matching a binary
 * photo against pasted text is pointless and potentially huge. Every mentioned
 * doc is attached (decision C), so all of them participate in R2: if a doc's
 * full content was also pasted verbatim, R2 strips the paste and the file
 * rides as the attachment — no size exception.
 */
export function readDocumentContents(items: SendAction["items"]): { path: string; content: string }[] {
  return items
    .filter((it) => it.type === "document")
    .map((it) => readCappedContent(it.path))
    .filter((f): f is { path: string; content: string } => f !== null)
}
