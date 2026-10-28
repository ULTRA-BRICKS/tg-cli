// Attachment-side transforms of the send plan (tg-cli#817, baseline `tg` 2605-2663):
// line-spec quote insertion, marker-copy swap, and the skip-missing-attachment filter.
import { checkAttachmentFile, type FileCheckDeps } from "../../auto-attach/file-check"
import type { LineSpecPlan, QuoteRender } from "../../auto-attach/line-spec"
import type { SendPlan } from "../../auto-attach/types"
import { escapeHtml } from "../../render/html"

/**
 * Anchor one quote on the line that contains its (kept) path token, then splice the quote in on the
 * line directly below. Token-anchored, so it is robust to length changes from emoji/HTML rendering.
 */
function insertQuote(body: string, r: QuoteRender): string {
  const lines = body.split("\n")
  // The render may have HTML-escaped the prose (forced HTML for the
  // quote), which also escapes &<> inside the token — so match both the
  // raw token and its escaped form.
  const escapedToken = escapeHtml(r.token)
  const idx = lines.findIndex((l) => l.includes(r.token) || l.includes(escapedToken))
  if (idx === -1) {
    // Token not found in the rendered text (shouldn't happen) → append.
    lines.push(r.quote)
  } else {
    lines.splice(idx + 1, 0, r.quote)
  }
  return lines.join("\n")
}

function insertQuotesIntoText(plan: SendPlan, quotes: QuoteRender[]): void {
  if (plan.textMessages.length === 0) {
    // No prose survived but quotes exist → send the quotes as the message.
    plan.textMessages.push({ text: quotes.map((r) => r.quote).join("\n"), format: "html" })
    return
  }
  let body = plan.textMessages[0].text
  for (const r of quotes) body = insertQuote(body, r)
  // A quote is HTML, so the message must be sent as HTML.
  plan.textMessages[0] = { text: body, format: "html" }
}

/**
 * Replace each line-spec document's disk source with the in-memory marker-injected copy (never modifies
 * the original file on disk). Every readable line-spec text file is attached (decision C) and has an
 * entry in `lsPlan.marked`; a binary/unreadable one has none, so `.find` returns undefined and the swap
 * no-ops, leaving it attached as-is.
 */
function swapMarkedCopies(plan: SendPlan, marked: LineSpecPlan["marked"]): void {
  for (const m of marked) {
    const doc = plan.documents.find((d) => d.source.kind === "disk" && d.source.path === m.path)
    if (doc) doc.source = { kind: "memory", filename: m.filename, content: m.content }
  }
}

/** Insert line-spec quotes (post-render) + swap in marker-injected copies. */
export function applyLineSpecs(plan: SendPlan, lsPlan: LineSpecPlan): void {
  if (lsPlan.quotes.length === 0) return
  insertQuotesIntoText(plan, lsPlan.quotes)
  swapMarkedCopies(plan, lsPlan.marked)
}

const SKIP_REASON: Record<"missing" | "empty" | "unreadable", string> = {
  missing: "file not found",
  empty: "file is empty",
  unreadable: "file is unreadable",
}

/**
 * Drop disk documents that are missing/empty/unreadable (tg-cli#207). `fileCheckDeps` is the same real
 * fs wiring the dry-run report uses. This runs BEFORE code-as-pdf/md-as-pdf so a document that is
 * already missing/empty/unreadable is dropped before conversion ever runs on it — otherwise a bad
 * ORIGINAL source could be silently replaced by a generated PDF that passes validation on its own,
 * never revalidating what the user actually pointed at.
 */
export function skipUnusableAttachments(plan: SendPlan, fileCheckDeps: FileCheckDeps): void {
  plan.documents = plan.documents.filter((d) => {
    if (d.source.kind !== "disk") return true
    const result = checkAttachmentFile(d.source.path, fileCheckDeps)
    if (result === "ok") return true
    console.error(`tg: skipping attachment ${d.source.path}: ${SKIP_REASON[result]}`)
    return false
  })
}
