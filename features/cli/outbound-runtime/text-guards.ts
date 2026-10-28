// Local content guards on the agent-authored text (tg-cli#817 stage split): stray-CJK /
// mixed-script, screenshot-attach and the dictionary gate.
//
// The harness session title (secondary name in tmux, primary outside it) is auto content — but
// these guards must enforce ONLY on text the AGENT actually typed, matching their documented scope.
// `safeHarnessTitle` starts as the candidate and each guard DROPS it (never hard-fails) on a hit —
// the user did not author the session's own auto-generated title and cannot fix it, so it must
// never be able to block an otherwise-clean outgoing message (review finding). Every guard takes
// the current title and RETURNS the surviving one; the session name is resolved from it after
// every guard has run.
import { readFileSync, statSync } from "fs"
import { findStrayCjk, formatStrayCjkError } from "../cjk-guard"
import {
  FAIL_CLOSED_NOTE,
  checkDictionary,
  formatDictionaryHits,
  loadDictionary,
  resolveDictionaryPath,
  type DictionaryField,
  type DictionaryRule,
} from "../dict-gate"
import { findMixedScriptTokens, formatMixedScriptError } from "../mixed-script-guard"
import { formatScreenshotAttachError, mentionsScreenshot } from "../screenshot-guard"
import type { MergedEnv, SendAction } from "./types"

/**
 * Stray-CJK guard (feature `cjk-guard`, ON by default): hard-block a send that carries a LONE
 * CJK/ideographic codepoint stuck mid-word into otherwise Latin/Cyrillic text (the "hieroglyph in
 * a normal word" bug). Runs on the caption (escapes resolved, --table body assembled) and the
 * --title (as-is: buildPrefix renders it verbatim), i.e. the text the AGENT AUTHORED.
 *
 * SCOPE (deliberate, not an oversight): the bug originates in the agent's own typed message, so
 * the guard checks exactly that. It intentionally runs BEFORE the autolink/line-spec pass appends
 * externally-sourced excerpts (Linear/GitHub titles, tg# message quotes, file-sourced line-spec
 * snippets); CJK in that external content is legitimate and must NOT be blocked. It also scans raw
 * markup for a `--format html` message rather than the rendered visible text — an LLM garble is a
 * raw codepoint in prose, which this covers; an HTML entity / tag-split hieroglyph is out of
 * scope. Quoted/code content is NOT exempted (the guard can't tell a quoted garble from a real
 * one) — use `--no-feature cjk-guard` for the rare legitimately-CJK message. See
 * features/cli/cjk-guard.ts.
 */
export function guardStrayCjk(caption: string, explicitTitle: string | undefined, safeHarnessTitle: string): string {
  for (const text of [caption, explicitTitle ?? ""].filter(Boolean)) {
    const stray = findStrayCjk(text)
    if (stray) {
      console.error(`Error: ${formatStrayCjkError(stray)}`)
      process.exit(1)
    }
    // Same feature, same gate: a homoglyph/mixed "garbage word" that mixes Cyrillic with a foreign
    // alphabet in ONE token (e.g. "почčesна") is the same "garbled token slipped in" class. See
    // features/cli/mixed-script-guard.ts.
    const mixed = findMixedScriptTokens(text)
    if (mixed) {
      console.error(`Error: ${formatMixedScriptError(mixed)}`)
      process.exit(1)
    }
  }
  // The harness-title candidate gets the SAME checks, but a hit silently drops it instead of exiting.
  if (safeHarnessTitle && (findStrayCjk(safeHarnessTitle) || findMixedScriptTokens(safeHarnessTitle))) return ""
  return safeHarnessTitle
}

/**
 * A photo item whose path is missing/empty is later skipped by checkAttachmentFile and the
 * caption still goes out as text — that is NOT an attached image (review finding on tg-cli#337).
 * Only a real on-disk non-empty photo file counts. Documents do not count.
 */
function hasAttachedPhoto(items: SendAction["items"]): boolean {
  return items.some((it) => {
    if (it.type !== "photo") return false
    try {
      const st = statSync(it.path)
      return st.isFile() && st.size > 0
    } catch {
      return false
    }
  })
}

/**
 * Screenshot-attach gate (feature `screenshot-guard`, ON by default): a caption/--title that
 * mentions screenshot/скриншот with no photo attached is a hard error before dry-run/transmit
 * (tg-cli#337). Runs before the dry-run short-circuit so --dry-run also catches it. A --photo in
 * `items` skips the gate — that path already has a file.
 */
export function guardScreenshotMention(send: SendAction, caption: string, safeHarnessTitle: string): string {
  if (hasAttachedPhoto(send.items)) return safeHarnessTitle
  for (const text of [caption, send.title ?? ""].filter(Boolean)) {
    if (mentionsScreenshot(text)) {
      console.error(`Error: ${formatScreenshotAttachError(send.tag === "report")}`)
      process.exit(1)
    }
  }
  return safeHarnessTitle && mentionsScreenshot(safeHarnessTitle) ? "" : safeHarnessTitle
}

/** One readFileSync, ENOENT → absent: not existsSync-then-read (TOCTOU). */
function readDictionaryFile(dictPath: string, explicit: boolean): string | null {
  try {
    return readFileSync(dictPath, "utf8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT" && explicit) {
      console.error(`Error: dictionary ${dictPath} (TG_DICT_PATH) does not exist. ${FAIL_CLOSED_NOTE}`)
      process.exit(1)
    }
    if (code !== "ENOENT") {
      console.error(`Error: dictionary ${dictPath} cannot be read (${code ?? String(e)}). ${FAIL_CLOSED_NOTE}`)
      process.exit(1)
    }
    return null
  }
}

/**
 * The --title and the --subagent label are header text the agent authors; both are always plain
 * (the header renderer escapes them). A hit refuses the send; the harness-title candidate gets the
 * SAME dictionary check, but a hit silently drops it instead of refusing.
 */
function applyDictionaryRules(
  rules: DictionaryRule[],
  dictPath: string,
  send: SendAction,
  dictFields: DictionaryField[],
  safeHarnessTitle: string,
): string {
  const hits = checkDictionary(rules, [
    { label: "--title", text: send.title ?? "", format: "plain" },
    { label: "--subagent", text: send.subagent ?? "", format: "plain" },
    ...dictFields,
  ])
  if (hits.length > 0) {
    console.error(formatDictionaryHits(hits, dictPath))
    process.exit(1)
  }
  const titleHit = safeHarnessTitle && checkDictionary(rules, [{ label: "harness-title", text: safeHarnessTitle, format: "plain" }]).length > 0
  return titleHit ? "" : safeHarnessTitle
}

/**
 * Dictionary gate (tg-cli#302, ALWAYS on, no bypass flag): refuse to send a message carrying a
 * banned word from the shared dictionary (~/.claude/DICT.json, override: $TG_DICT_PATH), printing
 * every hit with the rule id, the matched text in context and the replacement. Runs on the SAME
 * agent-authored text as the guards above and BEFORE the dry-run short-circuit, so --dry-run runs
 * the identical check and a refusal never touches the network. A MISSING file disables the gate
 * silently; a malformed / unreadable one refuses every send until fixed (fail closed — a silently
 * dead gate is how the words leak). Only ENOENT at the DEFAULT path means "absent": an EXPLICIT
 * TG_DICT_PATH that does not exist, or ENOTDIR (a path component is a file), is a
 * misconfiguration — and would otherwise be the agent's own off-switch — so it refuses. Reads the
 * MERGED config env (`~/.config/tg-cli/.env` under the real environment), like every other TG_*
 * setting. See features/cli/dict-gate.ts.
 */
export function guardDictionary(env: MergedEnv, send: SendAction, dictFields: DictionaryField[], safeHarnessTitle: string): string {
  const dictLocation = resolveDictionaryPath(env)
  if (dictLocation === null) return safeHarnessTitle
  const dictPath = dictLocation.path
  const dictRaw = readDictionaryFile(dictPath, dictLocation.explicit)
  const dict = loadDictionary(dictRaw, dictPath)
  if (dict.kind === "error") {
    console.error(`Error: ${dict.message}`)
    process.exit(1)
  }
  if (dict.kind !== "ok") return safeHarnessTitle
  return applyDictionaryRules(dict.rules, dictPath, send, dictFields, safeHarnessTitle)
}
