// PURE (de)serialization for the daemon's durable defer-while-waiting backlog
// (CtlPaths.deferred). The tg-ctl entrypoint owns the file I/O (atomicWrite +
// readFileOrNull) and the DeferQueues it snapshots/restores; this module owns
// only the on-disk FORMAT — the versioned envelope, per-pane record validation,
// and a pane cap.
//
// Why persist at all: the daemon held the defer-while-waiting queue ONLY in
// memory. Inbound Telegram messages queued behind an agent's OPEN question (so
// they are not typed INTO the prompt, spec tg#30) were lost on ANY daemon exit —
// a deliberate `tg-ctl restart`, a launchd bootout/bootstrap reload, or a
// crash-relaunch. The human's queued messages vanished silently and had to be
// resent. Persisting the backlog (keyed by pane, exactly like the questions
// store) lets a restored daemon flush it once the pane's restored question is
// answered — so a graceful reload loses no queued message.
//
// The item shape mirrors the daemon's DeferredInbound MINUS its runtime-only
// `delivered` flag (always false for a still-queued item): the durable fields
// are the wrapped text and the two Telegram message ids used for ack reactions
// on delivery. `req`-style re-validation is not needed — these are plain strings
// and ids the daemon re-wraps into DeferredInbound (delivered:false) on restore.

// One queued inbound message, durable fields only.
export interface DeferredStoreItem {
  text: string; // the already-wrapped inbound text to inject
  sourceMessageId: number | null; // Telegram message_id of the queued message (ack target)
  relatedReactionMessageId: number | null; // a related reaction message id, if any
  // The session the pane hosted when this was queued (session registry key,
  // spec §2.6). The flush delivers only while the pane still hosts it. Absent for
  // an untracked harness and for items queued before this field existed.
  sessionKey?: string;
}

// One pane's FIFO backlog.
export interface DeferredStorePane {
  paneId: string; // tmux pane id ("%N")
  items: DeferredStoreItem[];
}

export interface DeferredStoreData {
  panes: DeferredStorePane[];
}

const STORE_VERSION = 1;

// Far above any plausible number of panes concurrently blocked on a question at
// once; bounds the on-disk file so a pathological fan-out can't grow it without
// limit. On overflow the FIRST panes in iteration order are kept (insertion
// order == the live Map's order, oldest backlog first). Applied at serialize
// (bound on write) — parse trusts a file we wrote but the daemon caps again by
// only restoring what it reads.
export const MAX_DEFERRED_PANES = 200;

export function serializeDeferredStore(data: DeferredStoreData): string {
  return JSON.stringify({
    v: STORE_VERSION,
    panes: data.panes.slice(0, MAX_DEFERRED_PANES),
  });
}

// Parse the on-disk backlog. Anything malformed, an unknown format version, or a
// pane/item that fails validation is skipped — never thrown: a corrupt state
// file degrades to "no restored backlog", never wedges daemon startup. A pane
// that ends up with zero valid items is omitted entirely (an empty backlog is
// indistinguishable from no backlog and must not resurrect one).
export function parseDeferredStore(raw: string | null): DeferredStoreData {
  const empty: DeferredStoreData = { panes: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const rec = parsed as Record<string, unknown>;
  // Forward-compat guard: only the version we wrote is understood. A future
  // format bump this daemon can't read is ignored (no restored backlog) rather
  // than mis-parsed.
  if (rec.v !== STORE_VERSION) return empty;
  if (!Array.isArray(rec.panes)) return empty;
  const panes: DeferredStorePane[] = [];
  for (const p of rec.panes) {
    if (!p || typeof p !== 'object') continue;
    const pr = p as Record<string, unknown>;
    if (typeof pr.paneId !== 'string' || !pr.paneId) continue;
    const items = parseItems(pr.items);
    if (items.length === 0) continue; // omit empty backlogs
    panes.push({ paneId: pr.paneId, items });
    if (panes.length >= MAX_DEFERRED_PANES) break;
  }
  return { panes };
}

function parseItems(value: unknown): DeferredStoreItem[] {
  if (!Array.isArray(value)) return [];
  const out: DeferredStoreItem[] = [];
  for (const it of value) {
    if (!it || typeof it !== 'object') continue;
    const ir = it as Record<string, unknown>;
    if (typeof ir.text !== 'string') continue; // the payload is required; a non-string is corrupt
    out.push({
      text: ir.text,
      sourceMessageId: numOrNull(ir.sourceMessageId),
      relatedReactionMessageId: numOrNull(ir.relatedReactionMessageId),
      ...(typeof ir.sessionKey === 'string' && ir.sessionKey ? { sessionKey: ir.sessionKey } : {}),
    });
  }
  return out;
}

// A Telegram message id or null; anything non-finite/non-number coerces to null
// (a queued item is still deliverable without its ack ids — losing an id only
// forgoes the ack reaction, never the message).
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
