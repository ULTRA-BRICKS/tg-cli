// daemon-runtime/poll-loop-fetch: where the next batch of updates comes from — the crash-recovery
// journal first, then the getUpdates long-poll with its 409 backoff. Split out of poll-loop.ts (guardian-817).
import { api, log } from "./ctx-io"
import { kickOutboxFlush, sendMessage } from "./telegram-api"
import type { TgUpdate } from "../types"
import type { PollLoopDeps } from "./poll-loop"
import type { PollLoopState } from "./poll-loop-batch"

interface GetUpdatesResponse {
  ok: boolean
  result?: TgUpdate[]
  description?: string
}

// Another consumer is long-polling this bot (other machine, or a
// lingering server-side poll right after a restart) — the flock can't
// prevent that. Back off 1,2,4…60s; warn ONCE per streak.
async function backOffAfter409(d: PollLoopDeps): Promise<void> {
  const { ctx, state } = d
  state.consecutive409 += 1
  if (state.consecutive409 === 5 && !state.warned409) {
    state.warned409 = true
    log("5 consecutive 409s — another consumer is polling this bot")
    await sendMessage(ctx, "another consumer is polling this bot")
  }
  await d.lifecycle.drainAwareSleep(Math.min(2 ** (state.consecutive409 - 1), 60) * 1000)
}

// The batch, or null when the poll failed and the loop must start its next iteration.
async function longPollUpdates(d: PollLoopDeps): Promise<TgUpdate[] | null> {
  const { ctx, state } = d
  // The idle long-poll is abortable by SIGTERM (beginGracefulShutdown) so a
  // reload doesn't wait out the 50s poll; the timeout is the normal ceiling.
  // Re-check shuttingDown AFTER creating the controller and pre-abort if set:
  // a SIGTERM that landed between the loop-top check and here fired abort() on
  // the PREVIOUS (settled) controller — a no-op — and would otherwise let this
  // fresh long-poll run to its full ceiling (drain would then rely on the 8s
  // fallback instead of the snappy hand-off). Pre-aborting the current
  // controller makes the fetch reject at once → the catch exits gracefully.
  state.pollAbort = new AbortController()
  if (state.shuttingDown) state.pollAbort.abort()
  const resp = await fetch(
    // codeql[js/file-access-to-http] Intentional: the request goes to the operator-configured Bot API base
    // (TG_API_BASE) with the operator's own bot token, both read from ~/.config/tg-cli/.env / process env by
    // cli-main (the daemon's trust root, 0600 owner file). Offset is the daemon's own integer; the
    // allowed_updates value is a constant. No attacker-controlled file data reaches the URL host. Covered by
    // the ctl-*-integration tests that run the daemon against a fake Bot API.
    `${api(ctx)}/getUpdates?timeout=50&offset=${state.offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`,
    { signal: AbortSignal.any([AbortSignal.timeout(60_000), state.pollAbort.signal]) },
  )
  if (resp.status === 409) {
    await backOffAfter409(d)
    return null
  }
  if (!resp.ok) {
    log(`getUpdates HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    await d.lifecycle.drainAwareSleep(5000)
    return null
  }
  const json = (await resp.json()) as GetUpdatesResponse
  if (!json.ok || !Array.isArray(json.result)) {
    log(`getUpdates API error: ${json.description ?? "malformed response"}`)
    await d.lifecycle.drainAwareSleep(5000)
    return null
  }
  state.consecutive409 = 0
  state.warned409 = false
  kickOutboxFlush(ctx)
  return json.result
}

// The recovery queue is consumed exactly once, and skips the network (and its 409 bookkeeping).
export async function nextBatch(d: PollLoopDeps, loop: PollLoopState): Promise<TgUpdate[] | null> {
  if (loop.recoveryQueue !== null) {
    const recovered = loop.recoveryQueue
    loop.recoveryQueue = null
    return recovered
  }
  return longPollUpdates(d)
}
