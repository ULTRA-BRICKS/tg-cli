// Who is this `tg`? The session identity of an invocation: the process-tree ancestry (or a pinned
// registry session), the tmux pane / omp session / wrapper host it runs in, and the resolver of the
// `[window]` header name built from them (tg-cli#455 / #709).
//
// --- Session name → the `[window]` header bracket + the auto `--title` badge ---
// ONE resolver (resolveSessionName, tg-cli#455) names the session everywhere —
// the header, the /agent picker, `tg-ctl status`, history. In tmux the PRIMARY
// name is the tmux window name (a bare auto-rename default falls back to the cwd
// project → `rig-cli`, not `2.1.207`) and the harness's own session title is the
// SECONDARY name, rendered as the auto `--title` badge — never a substitute for
// the window (Alex escalation point 5: "[Fix Missing Provisioned Skills in Rig]"
// with no tmux window shown). Outside tmux the harness title IS the primary name.
import { readFileSync } from "fs"
import { detectSenderAncestry } from "../../branding/detect"
import type { AgentAncestor, SenderAncestry } from "../../tg-ctl/discover"
import type { HostRecord } from "../../tg-ctl/host-registry"
import { readOwnHostRecord } from "../../tg-ctl/host-registry-fs"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import type { SessionEntry } from "../../tg-ctl/session-registry"
import { parseLsofJsonlPaths, parseOmpSessionMeta, pickPrimaryOmpSessionFile } from "../../tg-ctl/omp"
import { resolveSessionName, titleFromPaneTitle } from "../../tg-ctl/session-name"
import { pinnedSession } from "../../tg-ctl/session-registry-store"
import { HARNESS_AGENT } from "../../tg-ctl/session-topics"
import type { ParseResult } from "../args"
import { readSessionRegistry } from "./session-helpers"
import type { MergedEnv, SenderContext } from "./types"

/** The identity slice of `SenderContext` (everything that comes from the process / registry, not credentials). */
export type SessionIdentity = Pick<
  SenderContext,
  | "sessionsPath"
  | "pinId"
  | "pinned"
  | "pinnedKey"
  | "ancestry"
  | "ancestor"
  | "ompAncestorPid"
  | "sessionless"
  | "hasSessionIdentity"
  | "ownHost"
  | "harnessTitle"
  | "sessionNameFor"
>

type TmuxPane = { windowName: string; panePath: string }
type OmpSession = { title: string; cwd: string }

// `null` = not in tmux, or tmux could not resolve this pane (tg-cli#448: that
// edge used to print a false literal "no tmux" from inside a real pane). tmux 3.5a
// answers `display-message -t <gone pane>` with exit 0 and EMPTY fields, and a live
// pane always has a pane_current_path — so an empty answer is "unresolved" too.
function getTmuxPane(): TmuxPane | null {
  const pane = process.env.TMUX_PANE
  if (!process.env.TMUX || !pane) return null
  try {
    const result = Bun.spawnSync(
      ["tmux", "display-message", "-p", "-t", pane, "#{window_name}\t#{pane_current_path}"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode === 0) {
      const raw = new TextDecoder().decode(result.stdout).replace(/\r?\n$/, "")
      const tab = raw.indexOf("\t")
      const windowName = tab >= 0 ? raw.slice(0, tab) : raw
      const panePath = tab >= 0 ? raw.slice(tab + 1) : ""
      if (windowName || panePath) return { windowName, panePath }
    }
  } catch {
    // ignore — tmux not available or not in a pane
  }
  return null
}

// The harness title a non-omp agent (Claude Code: `✳ <title>`) paints into its tmux
// pane title; '' when the pane title carries no harness mark (e.g. the host name).
function getPaneTitle(): string {
  const pane = process.env.TMUX_PANE
  if (!process.env.TMUX || !pane) return ""
  try {
    const result = Bun.spawnSync(["tmux", "display-message", "-p", "-t", pane, "#{pane_title}"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0 ? titleFromPaneTitle(new TextDecoder().decode(result.stdout)) : ""
  } catch {
    return ""
  }
}

// The omp session's own title + cwd, from its primary session jsonl (`type:title` /
// `session.title`, `session.cwd`) found via lsof on the omp pid.
function getOmpSession(ompPid: number | null): OmpSession {
  if (ompPid === null) return { title: "", cwd: "" }
  try {
    const lsof = Bun.spawnSync(["lsof", "-a", "-p", String(ompPid), "-Fn", "-n", "-P"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (lsof.exitCode !== 0) return { title: "", cwd: "" }
    const paths = parseLsofJsonlPaths(new TextDecoder().decode(lsof.stdout))
    const sessionFile = pickPrimaryOmpSessionFile(paths)
    if (!sessionFile) return { title: "", cwd: "" }
    const meta = parseOmpSessionMeta(readFileSync(sessionFile, "utf8"))
    return { title: meta.title ?? "", cwd: meta.cwd ?? "" }
  } catch {
    return { title: "", cwd: "" }
  }
}

// The two stderr notes of a send that ends up with NO session: a pin naming no live session, or an
// unpinned omp background job whose process tree stops at the shared worker broker.
function warnSessionlessSend(
  parsed: ParseResult,
  pinId: string | null,
  pinnedKey: string | null | undefined,
  senderTree: SenderAncestry,
): void {
  if (parsed.action !== "send") return
  if (pinnedKey === null) {
    const safe = (pinId ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 80)
    // codeql[js/clear-text-logging] False positive: the logged value is the user-supplied
    // --session/TG_SESSION id, a session label rather than a credential, already restricted to printable
    // ASCII and 80 chars above. The bot token is never part of it.
    console.error(`tg: ${parsed.session !== undefined ? "--session" : "TG_SESSION"} '${safe}' names no live session — sending with no session (no session topic, no reply route to an agent)`)
  } else if (pinId === null && senderTree.viaOmpBroker && senderTree.agents.length === 0) {
    console.error(
      "tg: running as an omp background job (shared worker broker) — the process tree cannot name its session, so this is sent with none. " +
        "Launch the job with TG_SESSION=<id> (run `tg --session-id` in the agent's own shell) to post into its session.",
    )
  }
}

type PinResolution = Pick<SessionIdentity, "sessionsPath" | "pinId" | "pinned" | "pinnedKey" | "ancestry"> & {
  senderTree: SenderAncestry
}

// Agent ancestors of this `tg`, nearest first: the nearest is the sender, the
// rest its process lineage (the route's parent, #503). One ps read for both.
// The climb stops at omp's shared worker broker, whose parent omp does not own the
// background jobs it hosts (tg-cli#709). A session pin (`--session <id>` / TG_SESSION)
// replaces the tree with the pinned session's own process, so every lookup below — the
// header title, the session topic, the route and history session — names that session;
// a pin naming no live session leaves no ancestry and no session at all.
function resolvePin(parsed: ParseResult, env: MergedEnv, configDir: string): PinResolution {
  const senderTree = detectSenderAncestry()
  const pinId = (parsed.action === "send" ? parsed.session : undefined) ?? (env.TG_SESSION?.trim() || null)
  const sessionsPath = ctlPaths(configDir, botIdFromToken(env.TG_BOT_TOKEN ?? "")).sessions
  const pinned = pinId === null ? null : pinnedSession(readSessionRegistry(sessionsPath), pinId)
  // undefined: no pin, the tree decides; null: the pin named no live session.
  const pinnedKey = pinId === null ? undefined : (pinned?.key ?? null)
  const ancestry: AgentAncestor[] =
    pinned && pinned.locators.pid !== null
      ? [{ agent: HARNESS_AGENT[pinned.harness], pid: pinned.locators.pid }]
      : pinId === null
        ? senderTree.agents
        : []
  return { senderTree, pinId, sessionsPath, pinned, pinnedKey, ancestry }
}

// omp's adapter title wins, then a pinned session's registry title; any other agent's
// title comes from its pane title.
function pickHarnessTitle(ompTitle: string, pinned: SessionEntry | null, ancestor: AgentAncestor | null): string {
  return ompTitle || (pinned ? (pinned.name.secondary ?? pinned.name.primary) : "") || (ancestor && ancestor.agent !== "omp" ? getPaneTitle() : "")
}

interface NameSources {
  pinned: SessionEntry | null
  hasSessionIdentity: boolean
  sessionless: boolean
  tmuxPane: TmuxPane | null
  ompSession: OmpSession
  ownHost: HostRecord | null
}

// A pinned session is named by its registry entry outright: an inherited $TMUX pane must not
// put another window's name on its header (tg-cli#709).
function makeSessionNameFor(src: NameSources): SenderContext["sessionNameFor"] {
  const { pinned, hasSessionIdentity, sessionless, tmuxPane, ompSession, ownHost } = src
  return (title) =>
    pinned
      ? { primary: pinned.name.primary, secondary: pinned.name.secondary }
      : hasSessionIdentity && !sessionless
        ? resolveSessionName({
            tmuxWindow: tmuxPane?.windowName ?? null,
            cwd: tmuxPane?.panePath || ompSession.cwd || ownHost?.cwd || process.cwd(),
            harnessTitle: title,
            hostLabel: ownHost?.label,
          })
        : { primary: "", secondary: null }
}

// Resolve the window label only when needed: the `--detect-agent` info action and the real send need
// it, but the emoji/model info flags must NOT pay for ps/lsof/tmux subprocesses they never read.
export function resolveSessionIdentity(parsed: ParseResult, env: MergedEnv, configDir: string): SessionIdentity {
  const { senderTree, pinId, sessionsPath, pinned, pinnedKey, ancestry } = resolvePin(parsed, env, configDir)
  warnSessionlessSend(parsed, pinId, pinnedKey, senderTree)
  // A send with NO session: a pin that named no live session, or an unpinned omp background
  // job (nothing below the broker). Its inherited $TMUX / pane is not trusted either — no
  // session name in the header, no topic ask, no route or history row a reply could follow,
  // so a reply to it reaches the agent picker (tg-cli#709).
  const sessionless = pinnedKey === null || (pinId === null && senderTree.viaOmpBroker && senderTree.agents.length === 0)
  const ancestor = ancestry[0] ?? null
  const ompAncestorPid = ancestor?.agent === "omp" ? ancestor.pid : null
  const tmuxPane = getTmuxPane()
  const ompSession = getOmpSession(ompAncestorPid)
  const harnessTitle = pickHarnessTitle(ompSession.title, pinned, ancestor)
  // The record of the rig-wrapper abduco session this `tg` runs in ($RIG_SESSION): outside tmux
  // its label is the `[window]` name and `host:<name>` the route origin
  // (docs/specs/2026-09-30-harness-agnostic-control.md §2–§3).
  const ownHost = readOwnHostRecord(configDir, process.env.RIG_SESSION, process.getuid?.() ?? -1)
  // A session identity exists inside tmux, under an agent ancestor or in a wrapper-hosted session.
  // A bare, non-agent invocation outside tmux (a cron job, a plain script) gets NO bracket.
  const hasSessionIdentity = tmuxPane !== null || Boolean(process.env.TMUX) || ancestor !== null || ownHost !== null
  const sessionNameFor = makeSessionNameFor({ pinned, hasSessionIdentity, sessionless, tmuxPane, ompSession, ownHost })
  return {
    sessionsPath,
    pinId,
    pinned,
    pinnedKey,
    ancestry,
    ancestor,
    ompAncestorPid,
    sessionless,
    hasSessionIdentity,
    ownHost,
    harnessTitle,
    sessionNameFor,
  }
}
