// daemon-runtime/daemon-startup: flock, pid file, delivery ledger and the shared in-memory card maps.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { existsSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { TargetDispatchQueues } from "../concurrent-dispatch"
import { planLegacyLastUserTargetMigration } from "../lock"
import { type OpenCard } from "../question-inbox"
import { lostPickerHolds, orphanedClaims } from "../delivery-ledger"
import { pollSync, recordRunInfo } from "./daemon-service"
import { LOCK_EX_NB, flock } from "./daemon-lock"
import { DAEMON_LOCK_GRACE_MS } from "./constants"
import { openDeliveryLedger } from "./delivery"
import { type AbandonedButton, type AnsweredButton, type PendingButton } from "./button-requests"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"

export type StartupDeps = {
  ctx: Ctx
  state: DaemonState
}

export function createStartup(d: StartupDeps) {
  const { ctx } = d

  mkdirSync(ctx.configDir, { recursive: true })

  // flock FIRST (spec §6): bound to the open file description, released by the
  // kernel on ANY exit including SIGKILL. The fd stays open for the daemon's lifetime.
  const lockFd = openSync(ctx.paths.lock, "w")

  if (pollSync(() => (flock(lockFd, LOCK_EX_NB) === 0 ? true : null), DAEMON_LOCK_GRACE_MS) === null) {
    // Another daemon owns this bot — idempotent no-op (spec §6).
    process.exit(0)
  }

  writeFileSync(ctx.paths.pid, `${process.pid}\n`)

  recordRunInfo(ctx)

  // One-time migration (tg-cli#281): best-effort rename a pre-existing
  // last-alex-target.json forward so the CTO's routing anchor survives the
  // upgrade instead of silently resetting to the ambiguity picker — or, if a
  // new-name file already exists, remove the now-redundant legacy file so a
  // FUTURE restart (after a legitimate invalidation clears the new file
  // again) can never resurrect it (review finding, round 3). Deliberately
  // placed AFTER the flock is held (review finding, round 2): running this
  // from every CLI invocation (send/status/ask/etc, not just the daemon)
  // could race a still-running pre-rename daemon and clobber ITS fresh anchor
  // write with the stale legacy file — only the flock-holding daemon may
  // touch either file. Non-fatal: a failed rename/unlink just means the
  // legacy file lingers (still denylisted) or the daemon starts with no
  // anchor, same as a fresh install.
  const legacyAction = planLegacyLastUserTargetMigration(ctx.configDir, ctx.botId, existsSync)

  if (legacyAction) {
    try {
      if (legacyAction.kind === "migrate") renameSync(legacyAction.from, legacyAction.to)
      else unlinkSync(legacyAction.path)
    } catch {
      // best-effort; see comment above
    }
  }

  // Before anything can deliver: every sink consults it (tg-cli#299). The claims and picker
  // holds a previous run left open are reported right before the poll loop starts.
  const ledgerAtStart = openDeliveryLedger(ctx.paths.deliveryLedger, ctx.chatId)

  const interruptedClaims = orphanedClaims(ledgerAtStart)

  const lostPickers = lostPickerHolds(ledgerAtStart)

  const pendingButtons = new Map<string, PendingButton>()

  // Per-resource-key concurrent dispatch (tg-cli#357): actions sharing a key (same topic
  // thread, same pending token, same question requestId) still run strictly in enqueue order;
  // actions with different keys run fully concurrently so one stuck target can never head-of-
  // line-block delivery to any other target. See actionResourceKey below and concurrent-dispatch.ts.
  const dispatchQueues = new TargetDispatchQueues()

  const activeButtonKeys = new Set<string>()

  // Answered-request replay cache (tg-cli#97): requestId → the answer just given,
  // so a re-forward of the same question within ANSWERED_REPLAY_MS replays it
  // instead of posting a duplicate card. Swept on every record (pruneAnsweredButtons)
  // so it stays bounded to the last window's answers, never unbounded.
  const answeredButtons = new Map<string, AnsweredButton>()

  // Socket-closed SCOPED questions retained for late-delivery + reconnect (this PR):
  // a question whose hook socket died (the 120s window OR a daemon restart) but whose
  // chosen answer can still reach the pane it asked from. NOT in `pendingButtons`, so
  // it never defers its pane's inbound. Keyed by callbackRequestId, like the others.
  const abandonedButtons = new Map<string, AbandonedButton>()

  // Every card not yet delivered — live, or retained, including a retained permission with a
  // tap queued on it — oldest first: what a newer hatch request or a sibling's decision makes
  // irrelevant (tg-cli#705). A card still being posted (no message id yet) is not listed.
  const closableCards = (): Array<OpenCard & { messageId: number }> =>
    [
      ...[...pendingButtons].map(([key, e]) => ({ key, req: e.req, at: e.at, messageId: e.messageId })),
      ...[...abandonedButtons].map(([key, e]) => ({ key, req: e.req, at: e.at, messageId: e.messageId })),
    ]
      .filter((c): c is OpenCard & { messageId: number } => c.messageId !== null)
      .sort((a, b) => a.at - b.at)

  // The cards still waiting for the human — closable ones with no tap queued: what the 📥 Inbox
  // mirrors and what an answer typed in chat can answer.
  const openCards = (): Array<OpenCard & { messageId: number }> => closableCards().filter((c) => !abandonedButtons.get(c.key)?.queuedDecision)

  return { interruptedClaims, lostPickers, pendingButtons, dispatchQueues, activeButtonKeys, answeredButtons, abandonedButtons, closableCards, openCards }
}

export type StartupApi = ReturnType<typeof createStartup>
