// Where the send posts (docs/specs/session-registry-and-topics.md §4.3, tg-cli#467, #551).
// `--topic` / `TG_TOPIC` were resolved earlier and win. Otherwise a REPLY (`--reply-to`) goes
// where the message it answers sits: Telegram does not put a reply into its anchor's topic in a
// private chat with topics — without message_thread_id it lands in General — so the thread is
// read from the anchor's history row (a topic id, or null = General: it stays there). An anchor
// no row records (older than the history, a legacy row) and every non-reply send ask the daemon
// which registry session this `tg` runs in; it answers with that session's topic, creating it
// on the first ask. Skipped outside any session and when topics are off. The thread is
// ADVISORY: a rejection retries once after 1 s for a session topic, then falls back to
// General, and the outcome is reported so the daemon counts misses.
import { readFileSync } from "fs"
import { threadOfMessageInBlob } from "../../replies/history"
import { parseControlConfig, resolveControlConfig } from "../../tg-ctl/config"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import { parseInboxState } from "../../tg-ctl/question-inbox"
import type { CtlPaths } from "../../tg-ctl/types"
import { askDaemon, parseResolvedSession, tmuxServerPidFromEnv, type ResolvedSession } from "../session-topic"
import { SESSION_LOOKUP_TIMEOUT_MS } from "./constants"
import type { PreparedMessage, RuntimePaths, SendAction, SenderContext, ThreadResolution, ThreadSelection } from "./types"

/** The daemon's 📥 Inbox topic (tg-cli#705) holds only its question-card copies: a `tg` send
 * never goes there — not by --topic/TG_TOPIC, not by replying to a message posted in it, not
 * by a session lookup. Such a send takes the session's own topic, else General. */
function inboxThreadOf(ctlFiles: CtlPaths, topicsOn: boolean, currentChatId: number | undefined): number | null {
  if (!topicsOn || currentChatId === undefined) return null
  try {
    return parseInboxState(readFileSync(ctlFiles.questionInbox, "utf8"), currentChatId).threadId
  } catch {
    // no Inbox state — no Inbox topic to keep clear of
    return null
  }
}

/** The thread the replied-to message sits in: undefined = unknown anchor, null = General. */
function anchorThreadOf(ctlFiles: CtlPaths, currentChatId: number, replyTo: number): number | null | undefined {
  try {
    return threadOfMessageInBlob(readFileSync(ctlFiles.history, "utf8"), currentChatId, replyTo)
  } catch {
    // no readable history — the anchor is unknown
    return undefined
  }
}

/** Ask the daemon which registry session this `tg` runs in. */
async function askResolveSession(sender: SenderContext, ctlFiles: CtlPaths): Promise<ResolvedSession | null> {
  const { pinned, ancestor } = sender
  return parseResolvedSession(
    await askDaemon(ctlFiles.socket, {
      kind: "resolve-session",
      tmuxPane: pinned ? null : (process.env.TMUX_PANE ?? null),
      tmuxServerPid: tmuxServerPidFromEnv(process.env.TMUX),
      ancestorPids: ancestor ? [ancestor.pid] : [],
      sessionKey: pinned?.key ?? null,
    }, SESSION_LOOKUP_TIMEOUT_MS),
  )
}

/** An explicit/env topic that IS the Inbox is dropped (with a notice), advisory flag included. */
function guardInboxSelection(selection: ThreadSelection, inboxThread: number | null): ThreadSelection {
  if (inboxThread === null || selection.messageThreadId !== inboxThread) return selection
  console.error(`tg: topic ${inboxThread} is the 📥 Inbox (question cards only) — posting to this session's topic or General instead`)
  return { messageThreadId: undefined, threadIdAdvisory: false }
}

/** The reply anchor's thread (only for a reply on a topics-on chat with no topic chosen yet). */
function replyAnchorThread(
  send: SendAction,
  sender: SenderContext,
  ctlFiles: CtlPaths,
  topicsOn: boolean,
  inboxThread: number | null,
): number | null | undefined {
  const { replyTo } = send
  const { currentChatId } = sender
  if (replyTo === undefined || !topicsOn || currentChatId === undefined) return undefined
  const anchorThread = anchorThreadOf(ctlFiles, currentChatId, replyTo)
  // A reply to something in the Inbox (a copy, or a message the human wrote there) is not
  // threaded there: it goes where a reply to an unknown anchor goes — the session's topic.
  return inboxThread !== null && anchorThread === inboxThread ? undefined : anchorThread
}

export async function resolveThread(
  send: SendAction,
  prepared: PreparedMessage,
  sender: SenderContext,
  configYamlRaw: string,
  paths: RuntimePaths,
): Promise<ThreadResolution> {
  const ctlCfg = resolveControlConfig(parseControlConfig(configYamlRaw))
  const ctlFiles = ctlPaths(paths.configDir, botIdFromToken(sender.botToken))
  const topicsOn = ctlCfg.topics || ctlCfg.privateTopics
  const inboxThread = inboxThreadOf(ctlFiles, topicsOn, sender.currentChatId)
  let { messageThreadId, threadIdAdvisory } = guardInboxSelection(prepared.thread, inboxThread)
  let resolvedSession: ResolvedSession | null = null
  const anchorThread =
    messageThreadId === undefined ? replyAnchorThread(send, sender, ctlFiles, topicsOn, inboxThread) : undefined
  if (messageThreadId === undefined && anchorThread !== undefined) {
    if (anchorThread !== null) {
      messageThreadId = anchorThread
      threadIdAdvisory = true
    }
  } else if (messageThreadId === undefined && sender.hasSessionIdentity && !sender.sessionless && topicsOn) {
    resolvedSession = await askResolveSession(sender, ctlFiles)
    if (resolvedSession?.threadId && resolvedSession.threadId !== inboxThread) {
      messageThreadId = resolvedSession.threadId
      threadIdAdvisory = true
    }
  }
  const sessionTopic = resolvedSession?.threadId ? resolvedSession : null
  return { messageThreadId, threadIdAdvisory, sessionTopic, ctlFiles, ctlCfg }
}
