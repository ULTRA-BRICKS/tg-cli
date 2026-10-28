// The client-machine recorder (docs/specs/2026-10-28-remote-ctl-server.md §5, "Send (client)").
//
// The local pipeline is unchanged: the direct Bot API post, the attachments read from this disk, the
// local routes.json / history writes (this machine's own state). On top of it, ONE record per send —
// built from exactly the route and history rows the local recorder produced — goes to the ctl server
// through `tg-remote client record`, which journals it when the server cannot be reached. The send
// is already in Telegram by then, so nothing here can change its exit code: a failed record is a
// stderr line, never an exit status and never a retry from this process.
import type { SendPlan } from "../../auto-attach/types"
import type { HistoryRecord } from "../../replies/history"
import { runRemoteClient } from "../../tg-ctl/remote-client-spawn"
import { createOutboundRecorder } from "./outbound-recorder"
import { buildRemoteRecord, describeRecordRun, RECORD_TIMEOUT_MS, type RemoteRecord, type RemoteRunResult } from "./remote-record"
import type { OutboundRecorder, RuntimePaths, SenderContext } from "./types"

interface ClientTarget {
  server: string
  machine: string
}

/** The record of this send, or null when it has no origin / history / session name to route a reply to. */
function recordOfSend(
  base: OutboundRecorder,
  sender: SenderContext,
  target: ClientTarget,
  history: HistoryRecord | undefined,
): RemoteRecord | null {
  const route = base.outboxRoute()
  if (!route || !history || sender.chatId === undefined) return null
  const ids = [...new Set(base.outboundIds)].map((id) => ({ id, threadId: base.outboundThreads.get(id) ?? null }))
  if (ids.length === 0) return null
  const named = sender.sessionNameFor(sender.harnessTitle)
  const name = { primary: named.bare ?? named.primary, secondary: named.secondary }
  return buildRemoteRecord({
    chat: sender.chatId,
    ids,
    route,
    history: { text: history.text, targetAgent: history.targetAgent, groupToken: history.groupId, ts: history.ts },
    name,
    machine: target.machine,
  })
}

async function sendRecord(record: RemoteRecord, configDir: string): Promise<RemoteRunResult> {
  try {
    return await runRemoteClient("record", { stdin: JSON.stringify(record), timeoutMs: RECORD_TIMEOUT_MS, configDir })
  } catch (error) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) }
  }
}

export function createRemoteRecorder(ctx: {
  paths: RuntimePaths
  sender: SenderContext
  plan: SendPlan
  target: ClientTarget
}): OutboundRecorder {
  let history: HistoryRecord | undefined
  const base = createOutboundRecorder({
    paths: ctx.paths,
    sender: ctx.sender,
    plan: ctx.plan,
    onHistory: (recs) => void (history = recs[0]),
  })
  const publishRemote = async (): Promise<void> => {
    try {
      const record = recordOfSend(base, ctx.sender, ctx.target, history)
      if (!record) return
      const warning = describeRecordRun(await sendRecord(record, ctx.paths.configDir), ctx.target.server)
      if (warning) console.error(warning)
    } catch (error) {
      // A bug in record shaping must not turn a delivered message into a failed command.
      console.error(`tg: ctl server ${ctx.target.server}: record not sent (${error instanceof Error ? error.message : String(error)}); send is out, record NOT journaled`)
    }
  }
  return { ...base, publishRemote }
}
