// daemon-runtime/daemon-lifecycle-runtime: signals, graceful shutdown and the hook socket server.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { unlinkSync } from "fs"
import { type Server } from "net"
import { ownsPidFile } from "../lock"
import { log, readFileOrNull } from "./ctx-io"
import { GRACEFUL_SHUTDOWN_MS } from "./constants"
import { startHookServer } from "./hook-socket"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { DeferQueueApi } from "./defer-queue"
import type { PickerApi } from "./picker-state"

export type LifecycleDeps = {
  ctx: Ctx
  state: DaemonState
  deferQueue: DeferQueueApi
  picker: PickerApi
}

export function createLifecycle(d: LifecycleDeps) {
  const { ctx, state } = d
  const { persistDeferred, questionRuntime } = d.deferQueue
  const { flushingPanes } = d.picker

  let hookServer: Server | null = null

  const cleanExit = (code: number): never => {
    // Flush the durable defer-while-waiting backlog on EVERY exit path (graceful
    // drain, idle-exit, SIGINT, AND the hard-exit fallback timer) so the last
    // queue mutations are never lost — the timer used to call cleanExit directly,
    // skipping the persist the cooperative paths do. Best-effort; a persist error
    // must never keep the daemon from vacating.
    try {
      persistDeferred()
    } catch {}
    // Remove the pidfile ONLY when it still names OUR pid (tg#93). On a launchd
    // relaunch a newer instance can take ownership and rewrite the pidfile with
    // ITS pid before this departing daemon's cleanExit runs; a blind unlink would
    // then delete the LIVE successor's pidfile, and `tg-ctl status` would read no
    // pid and falsely report "not running" while the real daemon is long-polling.
    try {
      if (ownsPidFile(readFileOrNull(ctx.paths.pid), process.pid)) unlinkSync(ctx.paths.pid)
    } catch {}
    try {
      hookServer?.close()
    } catch {}
    try {
      unlinkSync(ctx.paths.socket)
    } catch {}
    process.exit(code)
  }

  // Graceful exit that first DRAINS any in-flight deferred flush (codex #198).
  // Answering a question starts flushDeferred(pane) fire-and-forget — an 800ms
  // settle, then the queued backlog is pasted and the store re-persisted. Exiting
  // (cleanExit) while that flush is mid-settle would snapshot a queue that is
  // either still full but has no pending question left to release it (wedged after
  // restart) or half-taken by the flush (dropped items). So wait for flushingPanes
  // to empty before cleanExit persists the now-consistent backlog. Bounded: the
  // GRACEFUL_SHUTDOWN_MS backstop timer (beginGracefulShutdown) force-cleanExits a
  // flush that hangs, and a second SIGTERM gives up immediately.
  const cleanExitAfterFlushDrain = async (): Promise<never> => {
    while (flushingPanes.size > 0) await Bun.sleep(50)
    return cleanExit(0)
  }

  // Cooperative graceful shutdown (graceful-reload). A launchd bootout/bootstrap
  // reload — and `tg-ctl restart` — SIGTERMs the daemon. An IMMEDIATE cleanExit
  // mid-batch would drop the current getUpdates batch's not-yet-executed actions
  // (the offset is persisted BEFORE acting → at-most-once: those messages are lost
  // and Telegram won't redeliver them). Instead, SIGTERM sets a flag and aborts
  // only the IDLE long-poll; the loop finishes the in-flight batch's actions, then
  // exits at the top of the next iteration — so a batch that drains within
  // GRACEFUL_SHUTDOWN_MS misses no update across the swap. The hard-exit fallback
  // bounds a hung/oversized batch: if the remaining actions exceed the ceiling it
  // exits mid-batch and that tail is lost at-most-once (the normal non-graceful
  // behaviour) — in practice a batch is a few send-keys: ~1.2 s per text delivery
  // (~2 s when the #463 submit check retries Enter); a batch's deliveries run
  // concurrently, even into one pane.
  // (launchd would SIGKILL after its own grace period regardless.)
  state.shuttingDown = false

  state.pollAbort = null

  const beginGracefulShutdown = (): void => {
    if (state.shuttingDown) {
      cleanExit(0) // a second SIGTERM → give up on draining and go now
    }
    state.shuttingDown = true
    log("SIGTERM — draining in-flight batch, then exiting (graceful reload)")
    state.pollAbort?.abort() // wake the idle long-poll immediately
    setTimeout(() => cleanExit(0), GRACEFUL_SHUTDOWN_MS).unref?.()
  }

  process.on("SIGTERM", beginGracefulShutdown)

  // SIGINT (interactive Ctrl-C / explicit kill -INT) exits immediately — a human
  // at a terminal wants it gone now, not a drain.
  process.on("SIGINT", () => cleanExit(0))

  // A backoff/idle sleep that returns EARLY once a graceful shutdown begins, so a
  // reload during an error/409 backoff doesn't wait out the full delay before the
  // loop can see `shuttingDown` and exit (keeping the drain — and thus the
  // restart hand-off — snappy). Polled in small steps rather than racing a timer
  // against the signal.
  const drainAwareSleep = async (ms: number): Promise<void> => {
    const start = Date.now()
    while (!state.shuttingDown) {
      const remaining = ms - (Date.now() - start)
      if (remaining <= 0) return
      await Bun.sleep(Math.min(200, remaining))
    }
  }

  hookServer = startHookServer(ctx, questionRuntime)

  if (ctx.cfg.transport === "channel") {
    log("transport 'channel' is reserved for v1.2+ — falling back to tmux")
  }

  return { cleanExit, cleanExitAfterFlushDrain, drainAwareSleep }
}

export type LifecycleApi = ReturnType<typeof createLifecycle>
