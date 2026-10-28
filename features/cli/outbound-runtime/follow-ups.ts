// Intent-gate follow-ups (tg-cli#706). Record what this message still owes (one reply per
// item, keyed by its first id), settle an obligation this reply answers, and remind the sender
// of older ones. The read → select → append runs under the store's lockfile, so two replies
// under one message settle two different items (the shared lockfile's known gap — a writer
// frozen between creating the file and writing its pid — is tg-cli#680). The message is already
// delivered: a store failure is reported loudly, never fatal.
import { appendFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { formatIntentVerdict, type IntentVerdict } from "../intent-gate"
import { fulfilmentLine, OBLIGATIONS_FILE, openObligations, owedLines, type Obligation } from "../obligations"
import { fsRoutesLockIo, withRoutesLock } from "../../tg-ctl/routes"
import type { OutboundRun } from "./types"

interface LockOutcome {
  settled: string | null
  older: Obligation[]
}

interface FollowUpContext {
  storePath: string
  chatId: string
  originalId: number
  sender: string
  now: number
  replyTo: number | undefined
  replyKind: string | null
  intent: IntentVerdict
  owed: string
}

function readStore(storePath: string): string {
  try {
    return readFileSync(storePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
    return ""
  }
}

/** The lock body: read → select the settlement → append, all while the lock is held. */
function settleAndAppend(ctx: FollowUpContext): LockOutcome {
  const { storePath, chatId, originalId, now, replyTo, replyKind, owed } = ctx
  const store = readStore(storePath)
  const settled =
    replyTo !== undefined && replyKind !== null
      ? fulfilmentLine(openObligations(store), { chatId, replyTo, kind: replyKind, by: originalId, at: now })
      : null
  if (owed !== "" || settled !== null) appendFileSync(storePath, `${settled ?? ""}${owed}`, { mode: 0o600 })
  return { settled, older: openObligations(store + (settled ?? "")) }
}

function reportLockedStore(ctx: FollowUpContext): void {
  const { storePath, owed, replyTo, replyKind } = ctx
  if (owed !== "") appendFileSync(storePath, owed, { mode: 0o600 })
  if (replyTo !== undefined && replyKind !== null) {
    console.error(
      `tg: WARNING — the obligations store stayed locked; this reply did NOT settle a follow-up under tg#${replyTo}. ` +
        "Check `tg obligations` and dismiss the item it answered.",
    )
  }
}

function reportOutcome(ctx: FollowUpContext, outcome: LockOutcome | undefined): void {
  const { chatId, originalId, sender, replyTo, intent } = ctx
  if (outcome === undefined) reportLockedStore(ctx)
  if (outcome?.settled) console.error(`tg: follow-up settled under tg#${replyTo}.`)
  if (intent.action === "follow-up") {
    console.error(formatIntentVerdict(intent, originalId))
    console.error(`tg: recorded — \`tg obligations\` lists it until a reply to tg#${originalId} settles it.`)
  }
  const older = (outcome?.older ?? []).filter((o) => o.chatId === chatId && o.sender === sender)
  if (older.length > 0) {
    console.error(`tg: reminder — ${older.length} earlier follow-up(s) still owed: tg obligations`)
  }
}

function recordUnderLock(ctx: FollowUpContext, configDir: string): void {
  mkdirSync(configDir, { recursive: true })
  const outcome = withRoutesLock(
    fsRoutesLockIo(`${ctx.storePath}.lock`),
    () => settleAndAppend(ctx),
    // ~2 s, then SKIP: a settlement is chosen only under the lock (never the same
    // item twice). The owed lines are still appended — a single O_APPEND
    // write of whole lines needs no lock, and an owed item must never be lost.
    { attempts: 200, delayMs: 10, onContended: "skip" },
  )
  reportOutcome(ctx, outcome)
}

export function recordFollowUps(run: OutboundRun): void {
  const { intent, sessionNamePrimary, agentLabel } = run.prepared
  const originalId = run.recorder.outboundIds[0]
  const chatId = run.sender.chatId
  if (originalId === undefined || !chatId) return
  const { configDir } = run.paths
  const storePath = join(configDir, OBLIGATIONS_FILE)
  const sender = agentLabel ? `[${sessionNamePrimary}] [${agentLabel}]` : `[${sessionNamePrimary}]`
  const now = Math.floor(Date.now() / 1000)
  const replyKind = intent.action === "pass" ? (intent.valid ?? null) : null
  try {
    const owed = intent.action === "follow-up" ? owedLines(intent.followUps, { chatId, originalId, at: now, sender }) : ""
    const ctx: FollowUpContext = { storePath, chatId, originalId, sender, now, replyTo: run.send.replyTo, replyKind, intent, owed }
    recordUnderLock(ctx, configDir)
  } catch (err) {
    console.error(`tg: WARNING — the message was sent, but its follow-ups could not be recorded in ${storePath}: ${(err as Error).message}`)
    if (intent.action === "follow-up") console.error(formatIntentVerdict(intent, originalId))
  }
}
