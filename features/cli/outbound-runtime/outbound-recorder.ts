// Route / history bookkeeping of one outbound send (tg-cli#817). Everything here is best-effort:
// a corrupt or unwritable file just degrades the reply picker, it never breaks a send.
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { SendPlan } from "../../auto-attach/types"
import type { HistoryRecord } from "../../replies/history"
import { appendHistoryFile } from "../../replies/history-file"
import { buildOutboundHistoryRecords, outboundHistoryText } from "../../replies/outbound"
import { hostDisplayName } from "../../tg-ctl/host-registry"
import { botIdFromToken, ctlPaths } from "../../tg-ctl/lock"
import { lineageParentOriginId, outboundOriginPaneId } from "../../tg-ctl/omp"
import { appendRoute, fsRoutesLockIo, parseRoutes, resolveRouteCwd, serializeRoutes, withRoutesLock } from "../../tg-ctl/routes"
import { paneLocatorOf, SYSTEM_ORIGIN } from "../../tg-ctl/session-topics"
import type { OutboxRoute } from "../../transport/outbox"
import {
  makeOriginPaneReader,
  makeOriginSessionResolver,
  makePanePathQuery,
  type OriginSession,
} from "./origin-session"
import { currentPaneAgentName, ownSessionKey, readSessionRegistry } from "./session-helpers"
import type { OutboundRecorder, RuntimePaths, SenderContext } from "./types"

// Record an outbound message_id → this origin so the daemon can route a REPLY
// to the agent that produced it, and order the unrecognized-reply picker by
// LRU/MRU (docs/specs/reply-quotes.md). Tmux pane if present; otherwise the
// omp ancestor pid as omp:<pid> so an out-of-tmux omp is still recognizable
// (tg-cli#339); otherwise the abduco session a rig wrapper hosts it in, as
// host:<name> (docs/specs/2026-09-30-harness-agnostic-control.md).
//
// tg-cli#709: a pinned send's origin is the pinned session's own locator (never the sender's
// inherited pane or wrapper host); a sessionless send records the `system` origin, which no
// live agent matches, so a reply to it always gets the picker — never the lone live agent.
function resolveOriginPaneId(sender: SenderContext, tmuxPane: string | undefined): string | null {
  if (sender.pinned) return paneLocatorOf(sender.pinned) ?? SYSTEM_ORIGIN
  if (sender.sessionless) return SYSTEM_ORIGIN
  return outboundOriginPaneId({
    tmuxPane,
    ompAncestorPid: sender.ompAncestorPid,
    hostName: sender.ownHost?.name,
  })
}

// The agent name a history row is stamped with. This session's own agent name
// (resolveSessionName().primary over its pane) is the SAME label the daemon stamps on inbound, so
// `tg replies` groups a session's outbound and its inbound under one current-agent scope.
// Out of tmux it is the registry entry's name; undefined → untagged.
function historyAgentName(sender: SenderContext, entryName: string | null | undefined): string | undefined {
  const { sessionless, pinned, ownHost } = sender
  return (
    (sessionless || pinned ? undefined : currentPaneAgentName()) ??
    (ownHost && !pinned ? hostDisplayName(ownHost) : undefined) ??
    entryName ??
    undefined
  )
}

// Route fields past `id`/`cwd`/`ts`: the origin locators, the resolved session and the lineage parent.
function routeOriginFields(origin: OriginSession, parentPaneId: string | null) {
  return {
    ...origin.locators,
    ...(origin.sessionKey ? { sessionKey: origin.sessionKey } : {}),
    ...(parentPaneId ? { parentPaneId } : {}),
  }
}

// Serialize the read-modify-write across concurrent agents: two `tg` sends
// racing this RMW would last-writer-wins-clobber each other's route entries,
// dropping the very origin→message_id mapping the daemon needs to recognize a
// reply. The O_EXCL lockfile (fsRoutesLockIo) is the cross-process mutex; only
// a dead-owner (or aged pid-less) lock is broken, so a live writer is normally
// not clobbered (the rare residual double-holder paths: tg-cli#680).
// onContended:'skip' — if we can't get the lock within the budget, we SKIP rather
// than write unlocked (an unlocked write could clobber the concurrent holder's
// entry; skipping drops only THIS send's bookkeeping).
function appendRouteLocked(routesPath: string, newRoute: Parameters<typeof appendRoute>[1]): void {
  withRoutesLock(
    fsRoutesLockIo(`${routesPath}.lock`),
    () => {
      // Read race-free under the lock: one readFileSync, ENOENT (first ever
      // write) → empty. NOT existsSync-then-read (a TOCTOU check-then-use).
      let raw: string | null
      try {
        raw = readFileSync(routesPath, "utf8")
      } catch {
        raw = null
      }
      writeFileSync(routesPath, serializeRoutes(appendRoute(parseRoutes(raw), newRoute)))
    },
    { onContended: "skip" },
  )
}

export function createOutboundRecorder(ctx: {
  paths: RuntimePaths
  sender: SenderContext
  plan: SendPlan
  /** Sees the history rows of a plain (non-queued) send; the client-mode remote recorder's tap. */
  onHistory?: (recs: HistoryRecord[]) => void
}): OutboundRecorder {
  const { paths, sender, plan } = ctx
  const { home } = paths
  const { pinnedKey, sessionless, ancestor, currentChatId } = sender
  const tmuxPane = process.env.TMUX_PANE
  const originPaneId = resolveOriginPaneId(sender, tmuxPane)
  // A nested out-of-tmux omp (a disposable `omp --print` child) names the omp that
  // started it: once the child exits, a reply goes there (#503). Process ancestry
  // only — a live session that merely shares this cwd is never recorded.
  const parentPaneId = lineageParentOriginId({ tmuxPane, ancestry: sender.ancestry })
  const configDir = process.env.TG_CTL_CONFIG_DIR || join(home, ".config", "tg-cli")
  const ctlFiles = originPaneId ? ctlPaths(configDir, botIdFromToken(sender.botToken!)) : null
  const routesPath = ctlFiles?.routes ?? null

  const readOriginPane = makeOriginPaneReader(tmuxPane, sender)
  const queryPanePath = makePanePathQuery(tmuxPane, sender, readOriginPane)
  // `originPaneId` is non-null whenever a route can be written (every use is guarded on it).
  const resolveOriginSession = makeOriginSessionResolver(originPaneId!, sender, readOriginPane)

  // EVERY outbound message id of THIS send (a multi-chunk >4096 split or a
  // media-group send emits several Telegram message_ids for one logical
  // agent message — recordOutboundHistory logs a recall-able history record
  // for each one, not just the first).
  const outboundIds: number[] = []
  // The thread each outbound message landed in (null = General), as the transport reports it.
  const outboundThreads = new Map<number, number | null>()

  const recordRoute = (messageId: number, threadId: number | null): void => {
    outboundIds.push(messageId)
    outboundThreads.set(messageId, threadId)
    if (!routesPath || !originPaneId) return
    try {
      // Resolve the route cwd (a tmux display-message lookup) BEFORE taking the
      // lock — it's the slow part, and keeping it out of the critical section
      // shrinks the lock hold to a fast read-append-write so contention timeouts
      // are essentially impossible (the codex #55 scenario was a writer blocked on
      // exactly this lookup WHILE holding the lock). Snapshot ts here too so the
      // locked body is pure file I/O.
      const origin = resolveOriginSession()
      const newRoute = {
        id: messageId,
        cwd: resolveRouteCwd({ queryPanePath, fallbackCwd: process.cwd() }),
        ts: Math.floor(Date.now() / 1000),
        ...routeOriginFields(origin, parentPaneId),
      }
      appendRouteLocked(routesPath, newRoute)
    } catch {
      // best-effort: never let route bookkeeping break a send
    }
  }

  // Append `agent` history record(s) for this send so `tg replies` can recall
  // what the agent sent (mirror of the daemon's inbound writer). Best-effort:
  // swallow-all — history bookkeeping must never break a send. Gated on
  // originPaneId (not TMUX_PANE) the SAME way the routes path is above: a tmux
  // pane if present, else the omp:<pid> synthetic origin, so an omp session
  // with no tmux pane also gets a real outbound record — tg-cli#363's daemon
  // nudge needs this as its last-tg-sent signal for exactly the headless
  // population it targets. The text is the message body (or a [photo]/[document]
  // placeholder for a media-only send). One record is written per outbound
  // message_id — see `buildOutboundHistoryRecords` (features/replies/outbound.ts) for why.
  // Called AFTER transmit so the ids are known.
  // `write` defaults to the history file; a queued send (tg-cli#710) takes the rows as
  // the template its replayed message ids are recorded with.
  const recordOutboundHistory = (body: string, write?: (recs: HistoryRecord[]) => void): void => {
    if (!ctlFiles || !originPaneId) return
    const text = outboundHistoryText(body, { photos: plan.photos.length, documents: plan.documents.length })
    if (text === null) return
    try {
      // The registry session this send comes from (spec §3.3, tg-cli#460): the
      // identity `tg replies` scopes on, so a later rename never splits it. It
      // also names an out-of-tmux omp, which has no pane to derive a name from.
      const registry = readSessionRegistry(ctlFiles.sessions)
      const sessionKey = sessionless ? null : pinnedKey !== undefined ? pinnedKey : ownSessionKey(registry, ancestor)
      const entry = registry.sessions.find((e) => e.key === sessionKey)
      // randomUUID() only actually lands in a record when the send is truly
      // multi-part (buildOutboundHistoryRecords ignores it otherwise) — a
      // random token, not the group's first id, so it can't collide across
      // two different chats sharing this bot's history file (tg-cli#131 f/u).
      const recs = buildOutboundHistoryRecords(
        outboundIds,
        text,
        Math.floor(Date.now() / 1000),
        originPaneId,
        randomUUID(),
        currentChatId,
        historyAgentName(sender, entry?.name.primary),
        sessionKey ?? undefined,
        // The thread each message actually landed in (null = General, also after a fallback): a
        // later `tg --reply-to` of any of these ids finds its topic from it (tg-cli#551).
        outboundThreads,
      )
      // The remote recorder (client machines) takes the rows BEFORE the local file write: an
      // unwritable local history must not cost the server its record of a delivered message.
      if (!write) ctx.onHistory?.(recs)
      // Under the history lock shared with the daemon's inbound writer (tg-cli#136).
      if (write) write(recs)
      else appendHistoryFile(ctlFiles.history, recs)
    } catch {
      // best-effort: never let history bookkeeping break a send
    }
  }

  // The route recordRoute would have written, for a queued send's replayed message ids.
  const outboxRoute = (): OutboxRoute | undefined => {
    if (!routesPath || !originPaneId) return undefined
    const origin = resolveOriginSession()
    return {
      cwd: resolveRouteCwd({ queryPanePath, fallbackCwd: process.cwd() }),
      ...routeOriginFields(origin, parentPaneId),
    }
  }

  return { outboundIds, outboundThreads, recordRoute, recordOutboundHistory, outboxRoute }
}
