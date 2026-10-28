// The daemon-host half of the remote ctl feature, PURE (docs/specs/2026-10-28-remote-ctl-server.md
// §4.2, §5 "Reply", §6). Everything that decides WHAT to do with a `tg-remote hub …` answer, which
// chat notice to post and what `tg-ctl status` prints lives here; the spawns and files are in
// daemon-runtime/remote-hub.ts.
//
// The one rule that shapes the mapping: a reply is typed into a person's agent, so the daemon never
// sends it twice. Only an answer that PROVES the text was not delivered is a plain failure; every
// shape that leaves it open (link dropped after the write, timeout, garbage, a replay that does not
// say "delivered") is `uncertain` — final, reported, never re-sent (the ledger's existing semantics).

import type { SinkResult } from './delivery-ledger';
import { isRecord } from './guards';
import { MACHINE_RE, type RemoteRouteBody } from './remote-routes';

/** Hard cap for one `tg-remote hub deliver` run (the Python side has its own 15 s deadline inside). */
export const HUB_DELIVER_TIMEOUT_MS = 20_000;
/** Hello probe cap for `tg-ctl status`. */
export const HUB_HELLO_TIMEOUT_MS = 6_000;

export interface HubMachine {
  name: string;
  target: string;
}

export type HubVerdict =
  | { outcome: 'delivered'; sink?: string }
  | { outcome: 'failed'; error: string; detail?: string }
  | { outcome: 'uncertain'; detail?: string };

/** What one spawned `tg-remote` run produced. `started:false`: the process never started. */
export interface HubRun {
  started: boolean;
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** The deliver request `tg-remote hub deliver <machine>` reads on stdin (spec §4.2 minus op/v/machine). */
export interface HubDeliverRequest {
  idem: string;
  route: RemoteRouteBody;
  text: string;
  replyTo: { id: number };
}

export function buildDeliverRequest(chat: string, messageId: number, route: RemoteRouteBody, text: string, replyTo: number): HubDeliverRequest {
  return { idem: `${chat}:${messageId}`, route, text, replyTo: { id: replyTo } };
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (line === undefined) return null;
  try {
    const doc: unknown = JSON.parse(line);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function verdictOfAnswer(doc: Record<string, unknown>): HubVerdict {
  const detail = typeof doc.detail === 'string' ? doc.detail.slice(0, 200) : undefined;
  // A replay (the marker on the client already existed) reports the ORIGINAL outcome: only an
  // explicit `delivered` is delivered. Anything else about a replay is open.
  if (doc.duplicate === true) return doc.outcome === 'delivered' && doc.ok === true ? { outcome: 'delivered' } : { outcome: 'uncertain', detail };
  if (doc.ok === true) return { outcome: 'delivered', ...(typeof doc.sink === 'string' ? { sink: doc.sink } : {}) };
  if (doc.ok !== false) return { outcome: 'uncertain', detail: 'unrecognised answer' };
  const error = typeof doc.error === 'string' ? doc.error.slice(0, 80) : typeof doc.code === 'string' ? doc.code.slice(0, 80) : 'failed';
  // `uncertain` must be spelled out as false: a missing flag is not a proof of non-delivery.
  return doc.uncertain === false ? { outcome: 'failed', error, detail } : { outcome: 'uncertain', detail };
}

/** Map one finished `tg-remote hub deliver` run to a verdict. Pure; every malformed shape is `uncertain`. */
export function verdictOfHubRun(run: HubRun): HubVerdict {
  // The process never started: the request was never handed to anything.
  if (!run.started) return { outcome: 'failed', error: 'spawn' };
  if (run.timedOut) return { outcome: 'uncertain', detail: 'timed out waiting for the remote machine' };
  const doc = lastJsonLine(run.stdout);
  if (doc === null) return { outcome: 'uncertain', detail: `no answer (exit ${run.exitCode ?? '?'})` };
  return verdictOfAnswer(doc);
}

const GONE_ERRORS = ['gone', 'no-session'];

/** The ledger sink result of a verdict; `error` is the chat notice the owner reads. */
export function sinkResultOf(verdict: HubVerdict, machine: string, messageId: number): SinkResult {
  if (verdict.outcome === 'delivered') return { ok: true };
  if (verdict.outcome === 'uncertain') {
    return {
      ok: false,
      uncertain: true,
      error: `${machine}: tg#${messageId} may or may not have reached its session (the link failed after the reply was sent) — it was NOT sent again, check before resending.`,
    };
  }
  if (GONE_ERRORS.includes(verdict.error)) return { ok: false, error: `${machine}: the agent you replied to is no longer running there; tg#${messageId} not delivered` };
  return { ok: false, error: `${machine} unreachable; tg#${messageId} not delivered` };
}

export const routeNotRecordedNotice = (machine: string): string => `${machine}: route not recorded — that message's route never reached this server, so the reply was not delivered anywhere.`;

export const remoteMediaRefusedNotice = (machine: string): string => `${machine}: photos and files cannot be forwarded to a remote machine (their paths are local to this host); send text or a voice note instead.`;

export const linkMaybeDownLine = (machines: string[]): string => `if this was for a ${machines.join(' or ')} agent, its link may be down`;

/**
 * The known machine a reply's quote anchor names (`↩ tg#5 «[date] [clvm/proj] …»`), or null. The
 * anchor is the head of the replied-to message, whose header a client machine brackets as
 * `[<machine>/<window>]`. Only the first line (the anchor itself) is read, never the reply body.
 */
export function anchorMachine(injectText: string, machines: string[]): string | null {
  const anchor = injectText.split('\n', 1)[0];
  const match = /«\[[^\]]*\]\s*\[([a-z][a-z0-9-]{0,31})\//.exec(anchor);
  return match !== null && machines.includes(match[1]) ? match[1] : null;
}

// --- Status facts (CtlPaths.remoteStatus) ------------------------------------------------------

/** How the last reply to a machine ended; the same three words as a verdict's outcome. */
export type DeliverResult = 'delivered' | 'failed' | 'uncertain';

export interface RemoteMachineFacts {
  records: number;
  lastRecordAt: number | null;
  lastDeliver: { at: number; result: DeliverResult } | null;
}

export type RemoteStatusFacts = Record<string, RemoteMachineFacts>;

const EMPTY_FACTS: RemoteMachineFacts = { records: 0, lastRecordAt: null, lastDeliver: null };

export function factsOf(all: RemoteStatusFacts, machine: string): RemoteMachineFacts {
  return all[machine] ?? EMPTY_FACTS;
}

const DELIVER_RESULTS = ['delivered', 'failed', 'uncertain'] as const;

function parseLastDeliver(value: unknown): RemoteMachineFacts['lastDeliver'] {
  if (!isRecord(value) || typeof value.at !== 'number') return null;
  const result = DELIVER_RESULTS.find((r) => r === value.result);
  return result === undefined ? null : { at: value.at, result };
}

export function parseRemoteStatus(raw: string | null): RemoteStatusFacts {
  if (!raw) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(doc)) return {};
  const out: RemoteStatusFacts = {};
  for (const [machine, value] of Object.entries(doc)) {
    if (!isRecord(value) || !MACHINE_RE.test(machine)) continue;
    const { records, lastRecordAt, lastDeliver } = value;
    out[machine] = {
      records: typeof records === 'number' && Number.isSafeInteger(records) && records >= 0 ? records : 0,
      lastRecordAt: typeof lastRecordAt === 'number' ? lastRecordAt : null,
      lastDeliver: parseLastDeliver(lastDeliver),
    };
  }
  return out;
}

export function noteRecordApplied(all: RemoteStatusFacts, machine: string, applied: boolean, now: number): RemoteStatusFacts {
  const prev = factsOf(all, machine);
  return { ...all, [machine]: { ...prev, records: prev.records + (applied ? 1 : 0), lastRecordAt: now } };
}

export function noteDeliver(all: RemoteStatusFacts, machine: string, result: DeliverResult, now: number): RemoteStatusFacts {
  return { ...all, [machine]: { ...factsOf(all, machine), lastDeliver: { at: now, result } } };
}

// --- `tg-ctl status` hub block -----------------------------------------------------------------

/** One machine's hello probe: the answer of `tg-remote hub hello`, or why there is none. */
export type HubHello = { ok: true; ms: number; version: string | null } | { ok: false; reason: string };

export function parseHelloRun(run: HubRun, ms: number): HubHello {
  if (!run.started) return { ok: false, reason: 'cannot start tg-remote' };
  if (run.timedOut) return { ok: false, reason: `no answer within ${HUB_HELLO_TIMEOUT_MS / 1000} s` };
  const doc = lastJsonLine(run.stdout);
  if (doc === null) return { ok: false, reason: `no answer (exit ${run.exitCode ?? '?'})` };
  if (doc.ok === true) return { ok: true, ms, version: typeof doc.version === 'string' ? doc.version.slice(0, 40) : null };
  const code = typeof doc.code === 'string' ? doc.code.slice(0, 40) : 'failed';
  const detail = typeof doc.detail === 'string' ? `: ${doc.detail.slice(0, 120)}` : '';
  return { ok: false, reason: `${code}${detail}` };
}

// "5s ago" up to 90 s, "12m ago" up to 90 min, then hours: the resolution an operator glancing at status wants.
function ago(at: number, now: number): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 90) return `${sec}s ago`;
  return sec < 5400 ? `${Math.round(sec / 60)}m ago` : `${Math.round(sec / 3600)}h ago`;
}

/** The status block of a hub: one paragraph per machine. Never empty for a configured hub. */
export function formatHubStatus(machines: HubMachine[], facts: RemoteStatusFacts, hellos: Record<string, HubHello>, now: number): string[] {
  const lines = [`remote machines: ${machines.length}`];
  for (const { name, target } of machines) {
    const hello = hellos[name];
    const f = factsOf(facts, name);
    lines.push(`  - ${name} → ${target}`);
    lines.push(`    hello: ${hello === undefined ? 'not probed' : hello.ok ? `ok (${hello.ms} ms${hello.version ? `, tg-remote ${hello.version}` : ''})` : `FAILED — ${hello.reason}`}`);
    lines.push(`    records: ${f.records}, last ${f.lastRecordAt === null ? 'never' : ago(f.lastRecordAt, now)}`);
    lines.push(`    last deliver: ${f.lastDeliver === null ? 'never' : `${f.lastDeliver.result} ${ago(f.lastDeliver.at, now)}`}`);
  }
  return lines;
}
