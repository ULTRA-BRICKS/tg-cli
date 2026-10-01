// PURE model of the daemon's durable inbound-delivery ledger (tg-cli#299).
//
// Every inbound Telegram message is keyed by (chat_id, message_id). The ledger is
// an append-only JSONL file (CtlPaths.deliveryLedger) the daemon writes and
// fsyncs; this module owns only the record FORMAT, the fold of the event log
// into per-message state, and the single delivery decision every sink consults.
// The entrypoint owns the file I/O.
//
// Why a ledger at the SINKS rather than per path: the same message can reach a
// sink through several replays — Telegram redelivering an update whose offset
// write was lost, the pending-batch journal replayed after a crash, a deferred
// backlog restored from disk after a SIGKILL mid-flush, a topic hold released by
// the attach picker. Each of those used to re-type the text. One check at the
// three places text actually leaves the daemon (the omp-live bridge, tmux
// send-keys, the Stop-hook inbox) covers every path at once, including ones added
// later.
//
// Exactly-once needs a durable CLAIM before the side effect: the claim is written
// and fsynced, then the text is sent, then the outcome is written. A claim with
// no outcome, found when the daemon starts, means the process died between the
// two — the text may or may not have arrived. Such a message is never re-sent
// (that would be the duplicate this ledger exists to stop); the daemon tells the
// CTO instead (`uncertain`).

import { isRecord } from './guards';

export type LedgerEvent =
  // An update was accepted from getUpdates (written before the offset advances). `date` is
  // the message's date, else the receipt time; `chat`/`msg` name the owner message it
  // carries — absent for a button tap or a stranger's message, which only fill the
  // update-id sequence the audit checks for gaps.
  | { ts: number; event: 'received'; update: number; date: number; chat?: number; msg?: number }
  // Every action for this update finished; a replay of the same update is skipped.
  | { ts: number; event: 'processed'; update: number }
  // Delivery to `target` started; written and fsynced BEFORE the side effect.
  | { ts: number; event: 'claimed'; chat: number; msg: number; target: string }
  | { ts: number; event: 'delivered'; chat: number; msg: number; target: string }
  // The sink proved nothing was delivered (or the CTO was told it may not have been).
  | { ts: number; event: 'failed'; chat: number; msg: number; target: string; error: string }
  // Held for later delivery: behind an open question (durable backlog), behind the agent
  // picker (in memory — lost on restart), or in an unknown topic's hold (durable).
  | { ts: number; event: 'queued'; chat: number; msg: number; target: string; hold: LedgerHold }
  // A second delivery of an already delivered/claimed message was suppressed.
  | { ts: number; event: 'duplicate'; chat: number; msg: number; target: string; prior: string }
  // A claim from a previous daemon run had no outcome; the CTO was told, it is never re-sent.
  | { ts: number; event: 'uncertain'; chat: number; msg: number; target: string };

export type LedgerHold = 'deferred' | 'picker' | 'topic-hold';

export type MessageState =
  | { state: 'claimed' | 'delivered' | 'uncertain'; target: string; at: number }
  | { state: 'failed'; target: string; at: number; error: string }
  | { state: 'queued'; target: string; at: number; hold: LedgerHold };

export interface LedgerState {
  messages: Map<string, MessageState>;
  processedUpdates: Set<number>;
}

export function ledgerKey(chat: number, msg: number): string {
  return `${chat}:${msg}`;
}

const HOLDS: Record<LedgerHold, true> = { deferred: true, picker: true, 'topic-hold': true };

function isHold(v: unknown): v is LedgerHold {
  return typeof v === 'string' && Object.hasOwn(HOLDS, v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

// One JSONL line → an event, or null for a blank/torn/foreign line. A torn last line
// (the process died mid-append) is skipped rather than failing the whole ledger.
export function parseLedgerLine(line: string): LedgerEvent | null {
  if (!line.trim()) return null;
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(r) || !isInt(r.ts)) return null;
  const ts = r.ts;
  if (r.event === 'processed') return isInt(r.update) ? { ts, event: 'processed', update: r.update } : null;
  if (r.event === 'received') {
    if (!isInt(r.update) || !isInt(r.date)) return null;
    if (isInt(r.chat) && isInt(r.msg)) return { ts, event: 'received', update: r.update, date: r.date, chat: r.chat, msg: r.msg };
    return { ts, event: 'received', update: r.update, date: r.date };
  }
  if (!isInt(r.chat) || !isInt(r.msg)) return null;
  const chat = r.chat;
  const msg = r.msg;
  switch (r.event) {
    case 'claimed':
    case 'delivered':
    case 'uncertain':
      return isStr(r.target) ? { ts, event: r.event, chat, msg, target: r.target } : null;
    case 'failed':
      return isStr(r.target) && isStr(r.error) ? { ts, event: 'failed', chat, msg, target: r.target, error: r.error } : null;
    case 'queued':
      return isStr(r.target) && isHold(r.hold) ? { ts, event: 'queued', chat, msg, target: r.target, hold: r.hold } : null;
    case 'duplicate':
      return isStr(r.target) && isStr(r.prior) ? { ts, event: 'duplicate', chat, msg, target: r.target, prior: r.prior } : null;
    default:
      return null;
  }
}

export function parseLedger(raw: string | null): LedgerEvent[] {
  if (!raw) return [];
  const out: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    const e = parseLedgerLine(line);
    if (e) out.push(e);
  }
  return out;
}

export function serializeLedgerEvents(events: LedgerEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('');
}

export function emptyLedgerState(): LedgerState {
  return { messages: new Map(), processedUpdates: new Set() };
}

// Fold events (in file order) into `state`, mutating it. `received` and `duplicate`
// are audit-only and never change a message's delivery state.
export function applyLedgerEvents(state: LedgerState, events: LedgerEvent[]): LedgerState {
  for (const e of events) {
    switch (e.event) {
      case 'processed':
        state.processedUpdates.add(e.update);
        break;
      case 'claimed':
      case 'delivered':
      case 'uncertain':
        state.messages.set(ledgerKey(e.chat, e.msg), { state: e.event, target: e.target, at: e.ts });
        break;
      case 'failed':
        state.messages.set(ledgerKey(e.chat, e.msg), { state: 'failed', target: e.target, at: e.ts, error: e.error });
        break;
      case 'queued': {
        // A hold never downgrades a message that already went out: a replayed update can
        // re-queue a message whose earlier copy was delivered.
        const key = ledgerKey(e.chat, e.msg);
        const prior = state.messages.get(key);
        if (prior && (prior.state === 'delivered' || prior.state === 'claimed' || prior.state === 'uncertain')) break;
        state.messages.set(key, { state: 'queued', target: e.target, at: e.ts, hold: e.hold });
        break;
      }
      case 'received':
      case 'duplicate':
        break;
    }
  }
  return state;
}

export type DeliveryDecision = { kind: 'deliver' } | { kind: 'suppress'; prior: MessageState };

// THE rule every sink applies. Only a message with no delivery in flight or done may
// be sent: `delivered` and `uncertain` are final, and a `claimed` seen at runtime is a
// concurrent copy of the same message already on its way (startup converts every
// claim left by a dead run into `uncertain` first — see orphanedClaims). A `failed`
// or `queued` message may be (re)sent: a failure proved nothing arrived, and a hold is
// released through this same gate.
export function decideDelivery(prior: MessageState | undefined): DeliveryDecision {
  if (!prior || prior.state === 'failed' || prior.state === 'queued') return { kind: 'deliver' };
  return { kind: 'suppress', prior };
}

// What a sink reports back after a send. `uncertain`: the send failed AFTER bytes of the
// message were already written (a PTY connection lost mid-paste) — the text may have
// arrived, so unlike a plain failure it must never be sent again.
export type SinkResult = { ok: true } | { ok: false; error: string; uncertain?: boolean };

// The outcome event a sink's result writes, closing the claim that preceded the send.
export function sinkOutcomeEvent(ts: number, base: { chat: number; msg: number; target: string }, res: SinkResult): LedgerEvent {
  if (res.ok) return { ts, event: 'delivered', ...base };
  if (res.uncertain) return { ts, event: 'uncertain', ...base };
  return { ts, event: 'failed', ...base, error: res.error };
}

// Claims a dead daemon left without an outcome — each needs an `uncertain` notice.
export function orphanedClaims(state: LedgerState): Array<{ chat: number; msg: number; target: string }> {
  const out: Array<{ chat: number; msg: number; target: string }> = [];
  for (const [key, s] of state.messages) {
    if (s.state !== 'claimed') continue;
    const [chat, msg] = key.split(':').map(Number);
    out.push({ chat, msg, target: s.target });
  }
  return out;
}

// Picker holds live only in daemon memory, so a restart loses them; each needs a
// "not delivered" notice. Deferred and topic holds are restored from their own
// durable stores and stay pending.
export function lostPickerHolds(state: LedgerState): Array<{ chat: number; msg: number; target: string }> {
  const out: Array<{ chat: number; msg: number; target: string }> = [];
  for (const [key, s] of state.messages) {
    if (s.state !== 'queued' || s.hold !== 'picker') continue;
    const [chat, msg] = key.split(':').map(Number);
    out.push({ chat, msg, target: s.target });
  }
  return out;
}

// Bound the file: keep the newest `keep` events once it exceeds `max`. Dropped events
// are months old at the default sizes — far past any replay window (the journal holds
// one batch; Telegram keeps undelivered updates for 24 h).
export const LEDGER_MAX_EVENTS = 200_000;
export const LEDGER_KEEP_EVENTS = 100_000;

export function compactLedger(events: LedgerEvent[], max = LEDGER_MAX_EVENTS, keep = LEDGER_KEEP_EVENTS): LedgerEvent[] | null {
  return events.length > max ? events.slice(events.length - keep) : null;
}
