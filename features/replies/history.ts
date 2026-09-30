// Append-only message history for `tg replies` (the CTO's "вспомнить что писал
// пользователь"). PURE — the `tg` and `tg-ctl` entrypoints own the file I/O
// (read/append/trim) and feed these helpers plain strings; tests construct the
// same data by hand. Storage is JSONL: ONE HistoryRecord per line so a crash
// mid-append never corrupts earlier lines and a tail-read is O(file) at worst.
//
// Two producers write the SAME log next to the daemon's `routes` map:
//   • tg-ctl (inbound): every message the CTO sends, with the routed pane.
//   • tg      (outbound): every message the agent sends, with $TMUX_PANE.
// Both are best-effort: a corrupt or unwritable history never breaks a send or
// an inject (the bookkeeping is strictly informational, like `routes`).

export type Direction = 'user' | 'agent';

export interface HistoryRecord {
  ts: number; // unix SECONDS (send/receive time) — matches routes.ts convention
  message_id: number | null; // Telegram message_id; null when unknown (some outbound paths)
  chat_id?: number; // Telegram chat id; absent on legacy history rows
  direction: Direction; // 'user' = inbound from the CTO, 'agent' = outbound from the agent
  from: string; // display name ('Alex', 'agent', …)
  text: string; // the message body, verbatim (UNWRAPPED — no `[TG from …]` envelope)
  pane: string | null; // tmux pane id this message was routed to / sent from; null outside tmux
  // The human AGENT NAME this message was routed to (inbound) or sent from
  // (outbound) — derived from the target pane's window name / cwd project by
  // `resolveSessionName().primary`. This is the attribution `tg replies` filters + marks on.
  // ABSENT on a legacy row (written before this field existed) or when no
  // specific target could be resolved (a broadcast / no discovered agent); the
  // reader treats absent as "untagged / unknown" (marked `[→ ?]`), never hiding
  // it from `--all` / `--untagged`.
  targetAgent?: string;
  // Set ONLY on a true multi-part send (a >4096 split or a media-group album —
  // buildOutboundHistoryRecords, review: tg-cli#131) to a random per-send
  // token; every sibling record of that ONE send carries the same value.
  // Absent on a normal single-record send/receive. This is an authoritative
  // WRITE-TIME marker, not a read-time heuristic: grouping by coincidental
  // field equality (same ts/text/pane) would wrongly merge two genuinely
  // different messages sent in the same second with the same text. A random
  // token (not the group's first message_id) also avoids a theoretical
  // collision across two different chats sharing one bot's history file —
  // Telegram's message_id is sequential PER CHAT, so two chats' multi-part
  // sends could otherwise start at the same id (review: tg-cli#131 follow-up).
  groupId?: string;
}

// Keep the tail only — recency is what `replies` shows, and the file must not
// grow unbounded across a long-lived machine. ~5000 lines is a few hundred KB.
export const MAX_HISTORY = 5000;

function isDirection(v: unknown): v is Direction {
  return v === 'user' || v === 'agent';
}

// One JSONL line → a record, or null when the line is blank/garbage/incomplete.
function parseLine(line: string): HistoryRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.ts !== 'number') return null;
  if (!(typeof r.message_id === 'number' || r.message_id === null)) return null;
  if (!isDirection(r.direction)) return null;
  if (typeof r.from !== 'string') return null;
  if (typeof r.text !== 'string') return null;
  if (!(typeof r.pane === 'string' || r.pane === null)) return null;
  // groupId is optional/informational — an absent or malformed value just
  // means "not part of a known multi-part group", never an invalid record.
  // An empty string is treated the same as absent: groupMultiPartSends'
  // adjacency check is `r.groupId !== undefined && prev?.groupId === r.groupId`,
  // and two DIFFERENT records both carrying `groupId: ''` (a hand-edited or
  // corrupted line — the write path only ever emits crypto.randomUUID(),
  // never '') would otherwise satisfy that check and wrongly merge.
  const groupId = typeof r.groupId === 'string' && r.groupId !== '' ? r.groupId : undefined;
  // targetAgent is optional/informational, symmetric with groupId: an absent or
  // empty value is "untagged / unknown" (a legacy row, or a send with no
  // resolvable target), never an invalid record.
  const targetAgent = typeof r.targetAgent === 'string' && r.targetAgent !== '' ? r.targetAgent : undefined;
  return {
    ts: r.ts,
    message_id: r.message_id,
    ...(typeof r.chat_id === 'number' ? { chat_id: r.chat_id } : {}),
    direction: r.direction,
    from: r.from,
    text: r.text,
    pane: r.pane,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(targetAgent !== undefined ? { targetAgent } : {}),
  };
}

// Parse a whole JSONL blob, dropping any line that doesn't decode into a valid
// record (blank lines, partial writes, future-version fields). Order preserved.
export function parseHistory(raw: string | null): HistoryRecord[] {
  if (!raw) return [];
  const out: HistoryRecord[] = [];
  for (const line of raw.split('\n')) {
    const rec = parseLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

// A single record → one JSONL line (no trailing newline; the writer adds it).
// JSON.stringify escapes any embedded newline, so a multi-line message stays on
// ONE physical line — the JSONL invariant the reader relies on.
export function serializeHistoryRecord(rec: HistoryRecord): string {
  return JSON.stringify(rec);
}

// Append a record to the in-memory list, capped to the last MAX_HISTORY (FIFO by
// position = chronological by write). Used by tests + any in-memory path.
export function appendHistory(
  existing: HistoryRecord[],
  rec: HistoryRecord,
  max: number = MAX_HISTORY,
): HistoryRecord[] {
  const next = [...existing, rec];
  return next.length > max ? next.slice(next.length - max) : next;
}

// Trim an on-disk JSONL blob to its last `max` non-empty lines, re-emitting a
// trailing newline so the file stays append-ready. Pure string transform — the
// entrypoint reads the file, calls this, writes it back (or trims on append).
export function trimHistoryLines(raw: string, max: number = MAX_HISTORY): string {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= max) {
    // Already within bound: hand back a normalized blob (data lines + newline).
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }
  return lines.slice(lines.length - max).join('\n') + '\n';
}

// The whole read-append-trim transform as ONE pure string function: take the
// current file contents (or null), the new records, and return the next blob to
// write back. The entrypoints (`tg`, `tg-ctl`) only do the readFile/writeFile
// around this — keeping ALL history logic pure and testable. Bounded to `max`.
export function appendRecordsToBlob(
  existing: string | null,
  records: HistoryRecord[],
  max: number = MAX_HISTORY,
): string {
  const base = existing ?? '';
  const appended = records.map(serializeHistoryRecord).join('\n');
  const combined = appended ? (base ? `${base}\n${appended}\n` : `${appended}\n`) : base;
  return trimHistoryLines(combined, max);
}
