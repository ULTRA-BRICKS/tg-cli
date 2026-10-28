// daemon-runtime/satellite-deliver: `tg-ctl satellite-deliver`, run on the CLIENT machine by
// `tg-remote satellite serve` over SSH (docs/specs/2026-10-28-remote-ctl-server.md §4.2).
//
// One-shot and stateless: no daemon, no delivery ledger (the idempotency marker lives in the Python
// that spawned this), no config or credentials. stdin: one JSON line `{idem,route,text,replyTo?}`;
// stdout: exactly ONE JSON line, `{"ok":true,"sink":…}` or `{"ok":false,"error":…,"uncertain":…}`; the
// exit code is 0 whenever a line was printed. Everything else (diagnostics) goes to stderr.
//
// The target is resolved HERE, from this machine's live sessions, never from the route alone: a route is
// only a hint (resolveSatelliteTarget). The typing then uses the sinks the daemon already uses —
// deliverOriginalOmp, injectInbound over buildTextInjectPlan, typeIntoHost — not a new typing path.
// deliverInboundOnce passes straight through outside the daemon (no ledger is open), so these sinks
// type exactly once per call.

import { writeStdoutLine } from "../../cli/stdout-line"
import { emptyRegistry, reconcile, type Registry } from "../session-registry"
import { listLiveSessions, serverPidAcross } from "../harness-sessions"
import { buildTextInjectPlan } from "../inject"
import { matchLiveOmpOrigin } from "../omp"
import { answerOfSink, BAD_REQUEST, NO_SESSION, parseSatelliteRequest, resolveSatelliteTarget, type SatelliteAnswer, type SatelliteRequest, type SatelliteTarget } from "../remote-satellite"
import { log, readStdinText } from "./ctx-io"
import { deliverOriginalOmp, runInjectSteps, typeIntoHost, withPaneTypingLock } from "./delivery"
import { listLiveOmpAgents, refreshOriginalHosts } from "./session-registry"
import { readPaneTitles, readTmuxServerPid, snapshot } from "./tmux-probe"

// The registry as this machine looks right now. The daemon's refreshSessionRegistry keeps module state
// tied to a daemon context, so a one-shot reconciles a fresh scan into an EMPTY registry instead: every
// entry in it is live, keyed exactly as the daemon would key it (cc/codex stay provisional, no hook
// ever bound them here). Panes and processes are read fresh on every call (a pane may have changed hands
// since the last one); the omp list is cached for a few seconds, which only feeds session ids. The tmux
// server pid is read on both sides of the pane list and only trusted when both agree (a restart in
// between would pair this list with the wrong server).
function scanLiveRegistry(now: number): Registry {
  const serverBefore = readTmuxServerPid()
  const omp = listLiveOmpAgents()
  const { panes, procs } = snapshot()
  const serverPid = serverPidAcross(serverBefore, readTmuxServerPid())
  const scan = listLiveSessions({ panes, procs, serverPid, paneTitles: readPaneTitles(), omp, hookSessions: [] })
  return reconcile(emptyRegistry(), scan, now).next
}

type TmuxTarget = Extract<SatelliteTarget, { kind: "tmux" }>

// Another message may be mid-typing in this pane (the typing lock), and the pane can change hands while
// this waits for it. The session is therefore resolved AGAIN once the lock is held, and the text is typed
// only when it is still the very session the first resolution named. (The plan's own verify-pane only
// proves SOME agent is there, and its session guard reads the daemon's registry, which a one-shot has not.)
function typeIntoTmux(request: SatelliteRequest, target: TmuxTarget): Promise<SatelliteAnswer> {
  return withPaneTypingLock(target.paneId, async () => {
    const again = resolveSatelliteTarget(scanLiveRegistry(Date.now()), request.route)
    if (again?.kind !== "tmux" || again.paneId !== target.paneId || again.sessionKey !== target.sessionKey) return NO_SESSION
    return answerOfSink(await runInjectSteps(buildTextInjectPlan(target.paneId, request.text)), "tmux")
  })
}

// typeIntoHost's own queue is per process, and every request here is a fresh process: two replies to the
// same wrapper-hosted session would interleave their text and Enters. The same file lock a tmux pane's
// typing takes (keyed `host:<name>`) orders them across processes.
function typeIntoHostLocked(request: SatelliteRequest, target: Extract<SatelliteTarget, { kind: "host" }>): Promise<SatelliteAnswer> {
  return withPaneTypingLock(`host:${target.name}`, async () => answerOfSink(await typeIntoHost(target.name, request.text, "remote reply", target.pid), "host"))
}

async function deliverToTarget(request: SatelliteRequest, target: SatelliteTarget): Promise<SatelliteAnswer> {
  switch (target.kind) {
    case "host":
      return typeIntoHostLocked(request, target)
    case "tmux":
      return typeIntoTmux(request, target)
    case "omp": {
      const live = matchLiveOmpOrigin(target.originId, listLiveOmpAgents())
      return live === null ? NO_SESSION : answerOfSink(await deliverOriginalOmp(live, request.text, undefined, live.paneId), "omp-live")
    }
  }
}

/** Resolve and deliver one request on this machine. Never throws: a crash is an uncertain answer. */
export async function satelliteDeliver(request: SatelliteRequest): Promise<SatelliteAnswer> {
  try {
    await refreshOriginalHosts()
    const target = resolveSatelliteTarget(scanLiveRegistry(Date.now()), request.route)
    if (target === null) return NO_SESSION
    log(`satellite-deliver: ${request.idem} → ${target.kind}`)
    return await deliverToTarget(request, target)
  } catch (err) {
    // Whatever threw may have thrown after typing: say so rather than claim nothing happened.
    log(`satellite-deliver: ${request.idem} failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, error: "internal", uncertain: true }
  }
}

export async function runSatelliteDeliver(): Promise<number> {
  const parsed = parseSatelliteRequest(await readStdinText())
  const answer = parsed.ok ? await satelliteDeliver(parsed.request) : BAD_REQUEST
  writeStdoutLine(JSON.stringify(answer))
  return 0
}
