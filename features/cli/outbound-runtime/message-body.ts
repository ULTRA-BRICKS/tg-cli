// Message-body assembly of the outbound `tg` pipeline (tg-cli#817): the forum-topic selection and
// the caption / `--table` / pipe-table rendering that every later content gate inspects.
// Stderr lines (invalid TG_TOPIC, wide glyph, empty stdin, long-unstructured) keep their
// baseline order — the caller runs these steps in the order the entrypoint did.
import type { DictionaryField } from "../dict-gate"
import type { Format } from "../args"
import { LONG_UNSTRUCTURED_MESSAGE_WARNING, shouldWarnLongUnstructuredPlainMessage } from "../message-structure"
import { decodeTextEscapes } from "../text-escapes"
import { detectHtmlTags, escapeHtml } from "../../render/html"
import { detectTableKind, pipeTableToHtml, toTablePre } from "../../render/table"
import type { MergedEnv, SendAction, ThreadSelection } from "./types"

export interface AssembledBody {
  caption: string
  effectiveFormat: Format
  /**
   * The agent-AUTHORED text for the dictionary gate, each piece tagged with how Telegram will
   * render it (the gate matches what the reader SEES). For a --table send that is the heading (in
   * the caller's format) plus the raw stdin rows as PLAIN text (they are rendered escaped inside
   * <pre>), NOT the rendered block — the gate exempts <pre>/<code> contents in HTML, and the table
   * wrapper must not turn every cell into a quote. For a text send it is the caption in the
   * caller's format; a pipe-table auto-conversion escapes the caller's plain text, so it stays
   * plain here.
   */
  dictFields: DictionaryField[]
}

/**
 * Forum-topic thread id (docs/specs/tg-forum-topics.md §8): the explicit `--topic <id>` flag wins;
 * otherwise fall back to the TG_TOPIC env (merged config `.env` → process.env, same precedence as
 * the credentials). A malformed TG_TOPIC is IGNORED (logged) rather than fatal — the env is an
 * ambient default an agent's shell may inherit stale, and a daily-critical send must never die
 * because of it; the message simply goes to General. An explicit `--topic` was already validated
 * to a positive int at parse time.
 *
 * An EXPLICIT --topic is strict (a thread error surfaces). A topic taken from the TG_TOPIC env is
 * ADVISORY: an agent's shell may have inherited a stale / closed / foreign id, so a thread
 * rejection must fall back to General rather than kill the send (handled in the transport via
 * threadIdAdvisory).
 *
 * A sessionless (shared-broker) or --session/TG_SESSION-pinned send ignores the inherited
 * TG_TOPIC: it belongs to whichever session spawned the shell, not this sender (tg-cli#709).
 */
export function selectThread(
  topic: number | undefined,
  env: MergedEnv,
  ignoreEnvTopic: boolean,
): ThreadSelection {
  if (topic !== undefined || !env.TG_TOPIC || ignoreEnvTopic) return { messageThreadId: topic, threadIdAdvisory: false }
  // A launcher/daemon that writes TG_TOPIC via a file or with a trailing
  // newline would otherwise fail the regex and silently degrade to General;
  // trim first (the --topic flag arrives as its own argv token, no trim needed).
  const rawTopic = env.TG_TOPIC.trim()
  if (/^[1-9][0-9]*$/.test(rawTopic)) return { messageThreadId: Number(rawTopic), threadIdAdvisory: true }
  // Strip control chars before logging an env value (avoid log-injection via
  // a crafted TG_TOPIC); the message is for the local terminal only.
  const safe = rawTopic.replace(/[^\x20-\x7e]/g, "?").slice(0, 64)
  console.error(`tg: ignoring invalid TG_TOPIC '${safe}' (expected a positive topic id) — posting to General`)
  return { messageThreadId: topic, threadIdAdvisory: false }
}

/**
 * `tg --table`: read delimited rows from stdin, render an aligned <pre> monospace table (Telegram
 * has no native HTML tables), and use it as the message body. Any argv text becomes a heading
 * ABOVE the table; the table forces HTML format so the <pre> renders. Double-width glyphs
 * (emoji/CJK) in a cell can push columns out of alignment — warn but still send.
 */
async function assembleTableBody(rawCaption: string, format: Format): Promise<AssembledBody> {
  const stdinRaw = await Bun.stdin.text()
  if (stdinRaw.trim() === "") {
    console.error(
      "Error: --table reads rows from stdin but got none. " +
        "Pipe TSV or `a | b` lines, e.g.  printf 'task\\tstatus\\nship\\tdone' | tg --table",
    )
    process.exit(1)
  }
  const rendered = toTablePre(stdinRaw)
  if (rendered.hasWide) {
    console.error(
      "tg: --table: a cell contains a double-width glyph (emoji/CJK) — columns may not align " +
        "in the monospace block. Keep cells ASCII/Cyrillic for clean alignment.",
    )
  }
  // The table is HTML (a <pre> block), so the whole message goes out as HTML.
  // The argv heading is plain user text — escape it UNLESS the user explicitly
  // asked for --format html (then they own their own markup). Without this a
  // heading like "size < 10" would break HTML parsing once the <pre> forces
  // HTML mode on the combined caption.
  const rawHeading = decodeTextEscapes(rawCaption)
  const heading = format === "html" ? rawHeading : escapeHtml(rawHeading)
  return {
    caption: heading ? `${heading}\n${rendered.html}` : rendered.html,
    effectiveFormat: "html",
    dictFields: [
      { label: "table heading", text: rawHeading, format },
      { label: "table rows", text: stdinRaw, format: "plain" },
    ],
  }
}

/**
 * Auto-convert a markdown pipe table typed directly in the body to a real Telegram <table>
 * (Telegram renders NO markdown tables — a `| a | b |` grid arrives as plain text). Escalation
 * messages, and the escalation gate's own suggested example, use markdown pipes, so without this
 * they arrive broken ("таблица сломана"). Non-table lines are HTML-escaped for a plain-text send
 * (the resulting <table> forces HTML mode); left untouched when the caller already asked for
 * --format html and owns their markup.
 */
function convertPipeTable(caption: string, format: Format): { caption: string; effectiveFormat: Format } {
  if (detectTableKind(caption) !== "pipe") return { caption, effectiveFormat: format }
  const escaper = format === "html" ? (s: string): string => s : escapeHtml
  const conv = pipeTableToHtml(caption, escaper)
  return conv.converted ? { caption: conv.html, effectiveFormat: "html" } : { caption, effectiveFormat: format }
}

function assembleTextBody(rawCaption: string, format: Format, itemCount: number): AssembledBody {
  const decoded = decodeTextEscapes(rawCaption)
  // Same implicit-HTML upgrade renderText uses later: a body that contains a
  // Telegram-supported tag is sent as HTML even without --format html, so the
  // dictionary must match what the reader SEES (tags stripped / <code> exempt).
  // A non-tag like <скамейка> stays plain — detectHtmlTags ignores unknown tags.
  const dictFormat = format === "html" || detectHtmlTags(decoded) ? "html" : "plain"
  const dictFields: DictionaryField[] = [{ label: itemCount > 0 ? "caption" : "body", text: decoded, format: dictFormat }]
  const converted = convertPipeTable(decoded, format)
  return { ...converted, dictFields }
}

export async function assembleBody(send: SendAction): Promise<AssembledBody> {
  if (send.table) return assembleTableBody(send.caption, send.format)
  return assembleTextBody(send.caption, send.format, send.items.length)
}

export function warnLongUnstructured(send: SendAction, caption: string): void {
  if (shouldWarnLongUnstructuredPlainMessage({ text: caption, format: send.format, table: send.table, items: send.items })) {
    console.error(LONG_UNSTRUCTURED_MESSAGE_WARNING)
  }
}
