// daemon-runtime/new-session-plan: pure decisions of the /new command flow, on plain data.
// Split out of handleNewCommand (guardian-817) so they are testable without a daemon.
import { findModel } from "../models"
import type { NewSession } from "../new-command"
import { isLikelySlashCommand } from "../updates"
import type { SpawnHarness, TopicBinding } from "../types"

/** The `/new` command fields the session is built from. */
export interface NewCommandFields {
  name: string
  harness: SpawnHarness | null
  model: string | null
  chatId: number
  messageId: number
  threadId?: number | null
}

/** What to do with the dir token of a `/new` line. `rejected` is the dir to report back as unusable. */
export interface CommandDirPlan {
  dir: string | null
  task: string
  rejected: string | null
}

/**
 * Validate a supplied dir up front; an invalid one is dropped (→ asked) rather than failing.
 * A COMMAND-SHAPED inline token after the name (`/compact`, `/clear`) is a harness passthrough,
 * not a dir (codex #187): it is preserved at the FRONT of the task instead of being rejected.
 * A multi-component path that merely doesn't exist is a genuine dir typo and is `rejected`.
 * (A dir BEFORE the name is always a dir attempt — dirAfterName is false there.)
 */
export function planCommandDir(dir: string | null, task: string, dirAfterName: boolean, dirUsable: boolean): CommandDirPlan {
  if (!dir || dirUsable) return { dir, task, rejected: null }
  if (dirAfterName && isLikelySlashCommand(dir)) return { dir: null, task: task ? `${dir} ${task}` : dir, rejected: null }
  return { dir: null, task, rejected: dir }
}

/** The pending session a `/new` line opens: model, when supplied, fixes the harness too. */
export function newSessionFromCommand(token: string, action: NewCommandFields, plan: CommandDirPlan, now: number): NewSession {
  const modelEntry = action.model ? findModel(action.model) : null
  const session: NewSession = {
    token,
    name: action.name,
    status: "awaiting-dir",
    task: plan.task,
    ts: now,
    threadId: action.threadId ?? null,
    sourceChatId: action.chatId,
    sourceMessageId: action.messageId,
    ...(plan.dir ? { dir: plan.dir } : {}),
    ...(action.harness ? { harness: action.harness } : {}),
  }
  if (modelEntry) {
    session.model = modelEntry.id
    session.harness = modelEntry.kind
  }
  return session
}

/** The reply to a replayed `/new` whose first run already created its topic (#500). */
export function replayedNewReply(created: Pick<TopicBinding, "name" | "status">): string {
  const state = created.status === "bound"
    ? `its agent is running there — use \`/agent ${created.name}\` to talk to it`
    : `topic state \`${created.status}\`, not created again`
  return `recovered after a daemon restart: \`/new ${created.name}\` already opened its topic; ${state}`
}
