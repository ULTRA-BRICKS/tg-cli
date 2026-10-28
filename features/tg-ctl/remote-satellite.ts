// `tg-ctl satellite-deliver`, the CLIENT machine's half of a remote reply (docs/specs/2026-10-28-remote-ctl-server.md
// §4.2), PURE: parse the request, pick the target session on THIS machine from a live registry, map a
// sink's result to the one JSON line `tg-remote satellite serve` relays back. The scans and the typing
// are in daemon-runtime/satellite-deliver.ts, using the sinks the daemon already has.
//
// The route comes from another process's recording of a send, so it is only ever a HINT at a session:
// a tmux pane id is reused after a restart and a pid after a reboot. A target is accepted only when
// the session identity (registry key) or the exact origin locators (server pid + pane id + pane pid +
// agent pid) still name the same live process; a bare `%3` is never enough.

import { isRecord } from './guards';
import { hostNameFromOriginId } from './host-registry';
import { liveOmpPaneId } from './omp';
import { MAX_REMOTE_TEXT_BYTES, parseRemoteRouteBody, type RemoteRouteBody } from './remote-routes';
import { isProvisionalKey, type Registry, type SessionEntry } from './session-registry';
import { resolveRouteSession } from './session-target';

/** Longest stdin a satellite request may have: the text cap plus the route and framing. */
export const MAX_SATELLITE_STDIN_BYTES = MAX_REMOTE_TEXT_BYTES + 64 * 1024;

/** The marker `tg-ctl capabilities --json` reports: this build has `satellite-deliver`, so a hub can reply into it. */
export const SATELLITE_CAPABILITY = 'remote-satellite-v1';

export interface SatelliteRequest {
  idem: string;
  route: RemoteRouteBody;
  text: string;
  replyTo?: { id: number };
}

export type SatelliteAnswer = { ok: true; sink: 'omp-live' | 'tmux' | 'host' } | { ok: false; error: string; uncertain: boolean };

const refuse = (error: string, uncertain = false): SatelliteAnswer => ({ ok: false, error, uncertain });

const IDEM_RE = /^-?[0-9]{1,19}:[0-9]{1,19}$/;

/** Closed schema of the stdin line. A malformed request is `bad-request`, never a guess. */
export function parseSatelliteRequest(raw: string): { ok: true; request: SatelliteRequest } | { ok: false } {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SATELLITE_STDIN_BYTES) return { ok: false };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!isRecord(doc) || Object.keys(doc).some((k) => !['idem', 'route', 'text', 'replyTo'].includes(k))) return { ok: false };
  const { idem, text } = doc;
  if (typeof idem !== 'string' || !IDEM_RE.test(idem)) return { ok: false };
  if (typeof text !== 'string' || text.includes('\u0000') || Buffer.byteLength(text, 'utf8') > MAX_REMOTE_TEXT_BYTES) return { ok: false };
  const route = parseRemoteRouteBody(doc.route);
  if (!route.ok) return { ok: false };
  const replyTo = doc.replyTo;
  if (replyTo !== undefined && (!isRecord(replyTo) || !Number.isSafeInteger(replyTo.id) || Object.keys(replyTo).length !== 1)) return { ok: false };
  return { ok: true, request: { idem, route: route.route, text, ...(replyTo === undefined ? {} : { replyTo: { id: Number(replyTo.id) } }) } };
}

/** Where on this machine the text goes. `originId`: the omp's pane id, else `omp:<pid>`. */
export type SatelliteTarget =
  | { kind: 'host'; name: string; pid: number | undefined }
  | { kind: 'omp'; originId: string }
  | { kind: 'tmux'; paneId: string; sessionKey: string };

function targetOfEntry(entry: SessionEntry): SatelliteTarget | null {
  if (entry.harness === 'omp') {
    const originId = entry.locators.tmux?.paneId ?? (entry.locators.pid === null ? null : liveOmpPaneId(entry.locators.pid));
    return originId === null ? null : { kind: 'omp', originId };
  }
  return entry.locators.tmux ? { kind: 'tmux', paneId: entry.locators.tmux.paneId, sessionKey: entry.key } : null;
}

/**
 * The live session the route's sender was, or null (`no-session`). `reg`: a registry reconciled from a
 * scan taken now, so every entry in it is live. A `host:<name>` origin is a rig-wrapper session; the
 * sink re-verifies it against the host registry and the process table.
 */
export function resolveSatelliteTarget(reg: Registry, route: RemoteRouteBody): SatelliteTarget | null {
  const host = route.paneId === null ? null : hostNameFromOriginId(route.paneId);
  if (host !== null) return { kind: 'host', name: host, pid: route.agentPid };
  // The session identity first: a resumed omp keeps its key under a new pid or pane. A PROVISIONAL key
  // (`cc:pane:<server>/<pane>/<panePid>`) names a pane, not a process: when its agent exits and another
  // starts in the same shell the key is unchanged, so it also needs the recorded agent pid to still hold.
  const byKey = route.sessionKey === undefined ? undefined : reg.sessions.find((e) => e.key === route.sessionKey && e.state === 'live');
  const keyHolds = byKey !== undefined && (!isProvisionalKey(byKey.key) || route.agentPid === undefined || byKey.locators.pid === route.agentPid);
  const key = keyHolds ? byKey.key : resolveRouteSession(reg, { paneId: route.paneId ?? '', agentPid: route.agentPid, serverPid: route.serverPid, panePid: route.panePid });
  const entry = key === null ? undefined : reg.sessions.find((e) => e.key === key);
  return entry === undefined ? null : targetOfEntry(entry);
}

/** What a delivery sink reports (delivery.ts SinkResult + InjectFailure). */
export type SinkOutcome = { ok: true } | { ok: false; error: string; uncertain?: boolean; unsubmitted?: true; sessionMismatch?: true };

// The bridge text of an omp whose endpoint took the text or may have: busy/connection lost after the
// write (delivery.ts originalBridgeRejection). Every other bridge code means it was rejected.
const OMP_MAYBE_DELIVERED = /Original OMP bridge: (endpoint_timeout|endpoint_connection_lost)\b/;
const NO_LONGER = /no longer (hosts an agent|running)/;

/** The wire answer for a sink result; every shape that may have typed the text is `uncertain:true`. */
export function answerOfSink(res: SinkOutcome, sink: 'omp-live' | 'tmux' | 'host'): SatelliteAnswer {
  if (res.ok) return { ok: true, sink };
  if (res.unsubmitted) return refuse('unsubmitted', true);
  if (res.sessionMismatch) return refuse('no-session');
  if (res.uncertain) return refuse('uncertain', true);
  if (OMP_MAYBE_DELIVERED.test(res.error)) return refuse('endpoint-busy', true);
  if (NO_LONGER.test(res.error)) return refuse('gone');
  if (res.error.startsWith('Original OMP bridge:')) return refuse('unavailable');
  // A tmux step that failed mid-plan may already have typed: never claim it did not.
  return refuse('inject-failed', true);
}

export const NO_SESSION: SatelliteAnswer = { ok: false, error: 'no-session', uncertain: false };
export const BAD_REQUEST: SatelliteAnswer = { ok: false, error: 'bad-request', uncertain: false };
