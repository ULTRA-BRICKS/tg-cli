// Stage 2 of the outbound `tg` pipeline: feature flags, config.yaml, stdin body and argv parsing.
// The pure no-send exits (help / version / formatHelp / error) happen here, before any credential
// or session lookup, so they work without Telegram configured.
import { writeStdoutLine } from "../stdout-line"
import { fstatSync } from "fs"
import { applyFeatureFlags, parseFeatureConfig, resolveFeatures } from "../../auto-attach/feature-flags"
import { readConfigFile } from "../../config/config-file"
import { formatHelp } from "../../render/format-help"
import { colorizeHelp, shouldColorize } from "../../render/help-color"
import { parseArgs, type ParseResult } from "../args"
import { versionOutput } from "../version"
import type { FeatureMap, Invocation, RuntimePaths } from "./types"
import { USAGE } from "./usage"

type ParseOpts = { attachDenylist: boolean; msgrefAutolink: boolean; ticketAutolink: boolean }

// Message body from stdin: a bare `-` argv token is replaced by stdin's text; with no
// other body, piped/redirected stdin (FIFO or file — never a TTY) is appended. `--table`
// keeps its own stdin handling, so it never triggers the implicit read.
function stdinIsData(): boolean {
  try {
    const st = fstatSync(0)
    return st.isFIFO() || st.isFile()
  } catch {
    return false
  }
}

// Telegram caps a message near 4 KB; reading past 1 MiB only buffers bytes that are dropped.
async function readStdinBody(): Promise<string> {
  const limit = 1 << 20
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk)
    size += chunk.length
    if (size >= limit) break
  }
  const text = Buffer.concat(chunks).toString("utf8")
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--
  return text.slice(0, end)
}

// The feature flags the parser itself honours: the same flags the body-detection calls later gate on,
// threaded into parseArgs so the --title guards honour a disabled feature identically
// (tg-cli#138 review finding on PR #139: --title must not ban a literal the body allows).
function parseOptsFor(features: FeatureMap): ParseOpts {
  return {
    attachDenylist: features["attach-denylist"] !== false,
    msgrefAutolink: features["autolink-msgrefs"] !== false,
    ticketAutolink: features["autolink-tasks"] !== false,
  }
}

async function parseWithStdin(args: string[], home: string, parseOpts: ParseOpts): Promise<ParseResult> {
  const dashIdx = args.includes("--table") ? -1 : args.indexOf("-")
  if (dashIdx !== -1) {
    const body = stdinIsData() ? await readStdinBody() : ""
    return parseArgs([...args.slice(0, dashIdx), ...args.slice(dashIdx + 1)], process.cwd(), home, { ...parseOpts, bodyText: body })
  }
  const parsed = parseArgs(args, process.cwd(), home, parseOpts)
  const wantsHelp = parsed.action === "help" && !args.includes("-h") && !args.includes("--help")
  const emptySend = parsed.action === "send" && !parsed.table && !parsed.caption && parsed.items.length === 0
  if ((wantsHelp || emptySend) && stdinIsData()) {
    const body = await readStdinBody()
    if (body.trim()) return parseArgs(args, process.cwd(), home, { ...parseOpts, bodyText: body })
  }
  return parsed
}

// No-send actions resolve BEFORE the credential gate so help/version/info
// flags work without Telegram credentials configured.
function exitOnNoSendAction(parsed: ParseResult, rootDir: string): void {
  if (parsed.action === "help") {
    writeStdoutLine(colorizeHelp(USAGE, shouldColorize()))
    process.exit(0)
  }
  if (parsed.action === "version") {
    writeStdoutLine(versionOutput(rootDir))
    process.exit(0)
  }
  if (parsed.action === "formatHelp") {
    writeStdoutLine(colorizeHelp(formatHelp(), shouldColorize()))
    process.exit(0)
  }
  if (parsed.action === "error") {
    console.error(`Error: ${parsed.message}`)
    // Errors go to stderr; colorize only when stderr is the terminal.
    console.error(colorizeHelp(USAGE, shouldColorize({ isTTY: Boolean(process.stderr.isTTY) })))
    process.exit(1)
  }
}

export async function parseInvocation(rawArgs: string[], paths: RuntimePaths): Promise<Invocation> {
  // Resolve feature flags FIRST: pull --feature/--no-feature out of argv, load
  // ~/.config/tg-cli/config.yaml, and merge (default → config → CLI). The
  // transmitter safety nets (caption overflow + 4096 split) are NOT a feature
  // and always run.
  const flagResult = applyFeatureFlags(rawArgs)
  if (flagResult.error) {
    console.error(`Error: ${flagResult.error}`)
    console.error(colorizeHelp(USAGE, shouldColorize({ isTTY: Boolean(process.stderr.isTTY) })))
    process.exit(1)
  }
  // config.yaml is read ONCE; the raw text feeds both the features: block
  // parser here and the control: block parser for tg-ctl auto-start later.
  const configYamlRaw = readConfigFile(paths.configDir, { readOnly: true })
  const featureConfig = parseFeatureConfig(configYamlRaw)
  const features = resolveFeatures(featureConfig, {
    enable: flagResult.enable,
    disable: flagResult.disable,
  })
  const parsed = await parseWithStdin(flagResult.rest, paths.home, parseOptsFor(features))
  exitOnNoSendAction(parsed, paths.rootDir)
  return { parsed, features, configYamlRaw, rawArgs }
}
