// daemon-runtime/poll-loop: startup tail and the getUpdates poll loop.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`. The per-batch work
// lives in poll-loop-batch.ts, the long-poll in poll-loop-fetch.ts, nudges in poll-loop-nudge.ts.
import { fileMtimeMs, log } from "./ctx-io"
import { switchChat, recordDelivery, recordFailed } from "./delivery"
import { kickOutboxFlush, publishBotCommands } from "./telegram-api"
import { kickSessionRegistryScan, listLiveOmpAgents, refreshOriginalHosts } from "./session-registry"
import { listUnreachableAgents } from "./pane-discovery"
import { archiveDeliveredInboxes, reportStrandedInbox } from "./stranded-inbox"
import { ensureClaudeHooksOnStartup, ensureOmpLiveExtensionOnStartup } from "./hooks-setup"
import { processBatch, readRecoveryQueue, type PollLoopState } from "./poll-loop-batch"
import { nextBatch } from "./poll-loop-fetch"
import { runAwarenessNudges } from "./poll-loop-nudge"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { NewSessionApi } from "./new-session"
import type { TopicRoutingApi } from "./topic-routing"
import type { StartupApi } from "./daemon-startup"
import type { PickerApi } from "./picker-state"
import type { LifecycleApi } from "./daemon-lifecycle-runtime"
import type { TargetRoutingApi } from "./target-routing"
import type { QuestionInboxApi } from "./question-inbox-runtime"
import type { RemindersApi } from "./reminders-restore"
import type { AutoContinueApi } from "./auto-continue"
import type { ExecuteApi } from "./execute-action"

export type PollLoopDeps = {
  ctx: Ctx
  state: DaemonState
  newSession: NewSessionApi
  topicRouting: TopicRoutingApi
  startup: StartupApi
  picker: PickerApi
  lifecycle: LifecycleApi
  targetRouting: TargetRoutingApi
  questionInbox: QuestionInboxApi
  reminders: RemindersApi
  autoContinue: AutoContinueApi
  execute: ExecuteApi
}

// A killed run's open claims and in-memory picker holds (tg-cli#299): never re-sent — the
// text may already be in the agent — and never silent. Recorded first, so a restart during
// the notice cannot repeat it.
async function reportInterruptedDeliveries(d: PollLoopDeps): Promise<void> {
  const { interruptedClaims, lostPickers } = d.startup
  const { tellUndelivered } = d.picker
  for (const c of interruptedClaims) {
    recordDelivery([{ ts: Date.now(), event: "uncertain", chat: c.chat, msg: c.msg, target: c.target }])
    await tellUndelivered(c.msg, `may not have reached ${c.target}: the daemon restarted while delivering it. Resend it if the agent did not get it.`)
  }

  for (const p of lostPickers) {
    recordFailed(p.msg, p.target, "the daemon restarted while it waited for an agent pick")
    await tellUndelivered(p.msg, "was not delivered: the daemon restarted while it waited for you to pick an agent. Resend it if it still matters.")
  }
}

async function runStartupSteps(d: PollLoopDeps): Promise<void> {
  const { ctx, state } = d
  // Publish the command menu once on startup, before entering the poll loop.
  // Best-effort — publishBotCommands swallows every failure so a Telegram
  // hiccup can never block routing.
  await publishBotCommands(ctx)

  // Reconcile forum-topic bindings against the live tmux state once on startup: adopt a
  // crash-orphaned /new topic-slug window, close a bound binding whose session died while down.
  // No-op when topics mode is off (1:1 startup byte-identical) and fully guarded.
  d.newSession.reconcileTopicsOnStartup()

  // Answer unknown-topic holds that expired while the daemon was down, then keep sweeping.
  // Guarded: a send failure must never escape into the timer (an unhandled rejection).
  const sweepTopicHolds = (): void => {
    d.topicRouting.expireTopicHolds().catch((err) => log(`topic hold expiry failed: ${err}`))
  }

  sweepTopicHolds()

  setInterval(sweepTopicHolds, 30_000).unref?.()

  // Self-heal the Claude Code hooks on startup. Claude Code can re-emit
  // ~/.claude/settings.json with only its own managed keys, silently dropping our
  // q→buttons, StopFailure, and statusLine-telemetry channels — the daemon then
  // keeps running but "question asked" / "tokens running low" never surface until
  // a manual `tg-ctl install-hooks`. Re-merge idempotently here (same pattern as
  // reconcileTopicsOnStartup): a no-op when the hooks are already present, so it
  // only writes when a rewrite actually gutted them. Best-effort — a failure here
  // must never block the daemon from entering its poll loop.
  ensureClaudeHooksOnStartup(ctx)

  await ensureOmpLiveExtensionOnStartup(ctx)

  await refreshOriginalHosts()

  log(`daemon up — pid ${process.pid}, bot ${ctx.botId}, offset ${state.offset}`)

  await reportInterruptedDeliveries(d)
}

// Idle TTL first, so even an error-backoff loop eventually exits. A
// newer registration file also counts as agent activity (the daemon may
// have been retargeted while no pane was discoverable yet).
async function noteAgentActivity(d: PollLoopDeps): Promise<void> {
  const { ctx, state } = d
  const regMtime = fileMtimeMs(ctx.paths.registration)
  if (regMtime !== null && regMtime > state.lastAgentSeenMs) state.lastAgentSeenMs = regMtime
  d.targetRouting.discover()
  // An agent running OUTSIDE tmux keeps the daemon alive too (tg-cli#306): its
  // question cards and hatch asks still come through the daemon socket, and a
  // `/agent` to it must get the tmux-only refusal, not silence. The same tick archives
  // what the omp Stop bridge delivered and, once, reports the stranded cc/codex inbox.
  if (listUnreachableAgents().length > 0 || listLiveOmpAgents().length > 0) state.lastAgentSeenMs = Date.now()
  archiveDeliveredInboxes(ctx)
  await reportStrandedInbox(ctx)
}

async function tickHousekeeping(d: PollLoopDeps): Promise<void> {
  const { ctx, state } = d
  await noteAgentActivity(d)
  if (Date.now() - state.lastAgentSeenMs > ctx.cfg.idleExitMin * 60_000) {
    log(`no agent pane for ${ctx.cfg.idleExitMin} min — idle exit`)
    d.lifecycle.cleanExit(0)
  }

  // The queued-decision notice (a notice, never an expiry) and the 📥 Inbox safety-net
  // sync run every loop iteration (roughly once per ~50s long-poll, sooner if messages keep
  // arriving): persistQuestions only runs on a mutation, and a copy whose send failed is
  // retried here (tg-cli#705).
  if (d.questionInbox.noticeStaleQueuedDecisions(Date.now())) d.questionInbox.persistQuestions()
  await d.questionInbox.syncInbox()
  void d.reminders.retireQueuedReminders()
}

async function pollOnce(d: PollLoopDeps, loop: PollLoopState): Promise<void> {
  await tickHousekeeping(d)

  await refreshOriginalHosts()
  await runAwarenessNudges(d)

  kickSessionRegistryScan(d.ctx)

  const batch = await nextBatch(d, loop)
  if (batch === null) return
  await processBatch(d, loop, batch)
}

export async function runPollLoop(d: PollLoopDeps): Promise<never> {
  const { ctx, state } = d
  const { cleanExitAfterFlushDrain, drainAwareSleep } = d.lifecycle

  await runStartupSteps(d)

  const loop: PollLoopState = { recoveryQueue: readRecoveryQueue(ctx), authChatSwitch: null }

  // Sends `tg` queued while Telegram was failing (tg-cli#710): try them now, and again after
  // every successful getUpdates.
  kickOutboxFlush(ctx)

  for (;;) {
    // Graceful shutdown lands here BETWEEN batches — after the previous batch's
    // actions fully executed, before the next long-poll — so a reload never drops
    // an in-flight batch. Wait out any in-flight deferred flush before exiting so
    // an answered-question backlog is drained, not wedged/dropped (codex #198);
    // cleanExit then persists the durable backlog on its way out.
    if (state.shuttingDown) await cleanExitAfterFlushDrain()
    if (loop.authChatSwitch !== null) {
      switchChat(ctx, loop.authChatSwitch)
      loop.authChatSwitch = null
    }
    try {
      await pollOnce(d, loop)
    } catch (err) {
      // A SIGTERM-aborted long-poll surfaces here as an AbortError — that is a
      // clean graceful exit (no batch was in flight, since fetch never returned),
      // not a fault to back off from. Drain any in-flight deferred flush first
      // (codex #198); cleanExit persists the backlog on its way out.
      if (state.shuttingDown) await cleanExitAfterFlushDrain()
      // The daemon must survive anything — malformed updates, network
      // failures, tmux races. Log and back off.
      log(`poll loop error: ${err}`)
      await drainAwareSleep(5000)
    }
  }
}
