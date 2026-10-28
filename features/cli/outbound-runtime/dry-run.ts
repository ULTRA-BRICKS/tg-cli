// `--dry-run` stage of the outbound `tg` pipeline (tg-cli#817): the local-validation-only
// short-circuit, plus the real fs wiring of the pure attachment check it shares with the send.
import { writeStdoutLine } from "../stdout-line"
import { accessSync, constants as fsConstants, statSync } from "fs"
import { checkAttachmentFile, type FileCheckDeps } from "../../auto-attach/file-check"
import { formatIntentVerdict } from "../intent-gate"
import type { PreparedMessage, SendAction } from "./types"

// Real fs wiring for the pure checkAttachmentFile (tg-cli#207) — the
// entrypoint owns I/O, the feature module stays disk-free/testable. Shared by
// the --dry-run attachment report and the real send's missing/empty
// filtering (hoisted so both read the same checks).
export function makeFileCheckDeps(): FileCheckDeps {
  return {
    stat: (p) => statSync(p),
    canRead: (p) => {
      try {
        accessSync(p, fsConstants.R_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

const SKIP_REASONS: Record<"missing" | "empty" | "unreadable", string> = {
  missing: "file not found",
  empty: "file is empty",
  unreadable: "file is unreadable",
}

function dryRunHeadline(send: SendAction, prepared: PreparedMessage): string {
  const { intent, effectiveFormat } = prepared
  const tag = send.tag ?? "(none)"
  if (intent.action === "follow-up") {
    return (
      `tg --dry-run: OK — sendable, but FOLLOW-UP REQUIRED (${intent.followUps.length} item(s), tag=${tag}, format=${effectiveFormat}). ` +
      "No network call was made and nothing was sent or recorded; a real send records the follow-ups (tg obligations)."
    )
  }
  return (
    `tg --dry-run: OK — message is well-formed (tag=${tag}, format=${effectiveFormat}). ` +
    "No network call was made and nothing was sent."
  )
}

// Attachments (photo/file): --dry-run validates the SAME per-file checks a send makes
// (the never-attach denylist already ran at parse time, the screenshot gate) and
// lists each one's verdict — present, or "would be skipped" for a missing/empty/unreadable
// file exactly as the send would — but uploads nothing. The code→pdf / md→pdf conversion
// is not exercised here (tg-cli#775).
function reportAttachments(items: SendAction["items"], fileCheckDeps: FileCheckDeps): void {
  if (items.length === 0) return
  writeStdoutLine(`attachments (not uploaded): ${items.length}`)
  for (const it of items) {
    const result = checkAttachmentFile(it.path, fileCheckDeps)
    if (result === "ok") {
      writeStdoutLine(`  ${it.type}: ${it.path} — ok`)
    } else {
      writeStdoutLine(`  ${it.type}: ${it.path} — would be skipped (${SKIP_REASONS[result]})`)
    }
  }
}

// Everything before this point is LOCAL validation/rendering: the escalation-format gate,
// the cjk/mixed-script guard, the screenshot-attach gate, the dictionary gate and the
// pipe-table→<table> conversion have all already run against the FINAL assembled
// caption. A failing gate already exits(1) without ever reaching here or touching the
// network — the gap this closes is the PASSING case: a structurally-compliant message
// used to fall straight through to the real send, which is exactly how
// scaffold/placeholder drafts (an agent testing whether its markup satisfies the strict
// gate) reached the live chat. --dry-run stops here: no credential check, no
// autolink/network lookups, no transport, no send.
export function reportDryRunAndExit(send: SendAction, prepared: PreparedMessage, fileCheckDeps: FileCheckDeps): never {
  writeStdoutLine(dryRunHeadline(send, prepared))
  if (prepared.intent.action === "follow-up") writeStdoutLine(formatIntentVerdict(prepared.intent))
  // NOTE: this is the body as assembled so far (post table/pipe-table
  // conversion, pre-autolink) — autolink-tasks/autolink-msgrefs run AFTER
  // this point and can still rewrite it before a real send. It is the exact
  // text every guard just validated, but it is not a byte-exact
  // preview of the final wire body.
  reportAttachments(send.items, fileCheckDeps)
  writeStdoutLine("--- rendered body (pre-autolink) ---")
  writeStdoutLine(prepared.caption)
  process.exit(0)
}
