// `tg user …` shorthand and `tg replies …` — recall what was sent over Telegram (the CTO's
// "вспомнить что писал пользователь"). Reads the daemon's append-only history.jsonl,
// defaults to THIS tmux pane's session + inbound (user) messages.
import { writeStdoutLine } from "../stdout-line"
import { readFileSync } from "fs"
import { join } from "path"
import { loadEnv } from "../../config/env"
import { runReplies } from "../../replies/cli"
import { resolveWindowPanes } from "../../replies/window"
import { detectAgentAncestry } from "../../branding/detect"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import { currentPaneAgentName, ownSessionKey, readSessionRegistry } from "./session-helpers"

// `tg user [list | find <query>] [flags]` — shorthand for `tg replies user`.
// Exact-match leading token only, so `tg "user ..."` as a plain message sends.
export function applyUserShorthand(rawArgs: string[]): void {
  if (rawArgs[0] !== "user") return
  process.argv.splice(2, 1, "replies", "user")
  rawArgs.splice(0, 1, "replies", "user")
}

const detectRepliesPane = (): string | null => {
  const pane = process.env.TMUX_PANE
  return pane && pane.length > 0 ? pane : null
}

// The real `tmux list-panes` spawn for `--session <windowName>` resolution
// lives HERE (the entrypoint owns I/O); features/replies/window.ts stays pure
// and just parses this output. pane_id FIRST + TAB so space-containing window
// names survive the split.
const runTmuxListPanes = (): { exitCode: number; stdout: string } | null => {
  try {
    const res = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{window_name}"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return { exitCode: res.exitCode, stdout: new TextDecoder().decode(res.stdout) }
  } catch {
    return null // tmux binary not on PATH
  }
}

// Local time (Europe/Belgrade for the CTO) — matches the daemon's wrap.
const fmtTime = (unixSec: number): string => {
  const d = new Date(unixSec * 1000)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// The registry view + this session's key: the default scope is the SESSION,
// so a rename never splits its history (spec §3.3, tg-cli#460).
function sessionSnapshot(sessionsPath: string) {
  const reg = readSessionRegistry(sessionsPath)
  if (reg.sessions.length === 0) return null
  return {
    sessions: reg.sessions.map((e) => ({ key: e.key, name: e.name.primary, aliases: e.aliases })),
    current: ownSessionKey(reg, detectAgentAncestry()[0] ?? null),
  }
}

function readHistoryOrNull(historyPath: string): string | null {
  try {
    return readFileSync(historyPath, "utf8")
  } catch {
    return null
  }
}

// Returns when argv is not a replies subcommand (or runReplies declines) → fall through to send.
// Exact-match leading token only, so `tg "replies ..."` as a plain message still sends.
export function runRepliesSubcommand(rawArgs: string[], configDir: string): void {
  if (rawArgs[0] !== "replies") return
  // Resolve the bot id from the SAME config dir whose history we read (now the
  // one shared `configDir`), so an alternate TG_CTL_CONFIG_DIR can't mix
  // a different dir's token with a different dir's history file. process.env
  // still wins over the dir's `.env`.
  const repliesEnv = {
    ...loadEnv(join(configDir, ".env")),
    ...process.env,
  }
  const botToken = repliesEnv.TG_BOT_TOKEN ?? ""
  const repliesPaths = ctlPaths(configDir, botIdFromToken(botToken))
  const historyPath = repliesPaths.history
  const code = runReplies(rawArgs, {
    readHistory: () => readHistoryOrNull(historyPath),
    detectPane: detectRepliesPane,
    // The reader's OWN agent name (this pane's window/project) — the default
    // `current` scope filters history to it. SAME derivation the daemon stamps
    // as targetAgent, so the default view actually matches the tagged rows.
    currentAgent: currentPaneAgentName,
    sessions: () => sessionSnapshot(repliesPaths.sessions),
    // `--session ext` → the pane ids of every tmux window named exactly "ext".
    resolveWindow: (name: string) => resolveWindowPanes(name, runTmuxListPanes),
    fmtTime,
    log: (m) => writeStdoutLine(m),
    errlog: (m) => console.error(m),
  })
  if (code !== null) process.exit(code)
}
