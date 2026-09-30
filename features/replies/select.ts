// `tg replies` selection + formatting. PURE — the entrypoint reads the history
// file + detects the pane, then calls these to filter, search, order, and
// render. Time formatting is INJECTED (fmtTime) so the daemon can render local
// time while tests stay deterministic — the same pattern updates.ts uses.

import type { HistoryRecord } from './history';
import type { AgentScope, Direction, RepliesQuery } from './args';

export type { HistoryRecord } from './history';

// --- filters ---

// Keep only records in the requested direction. `all` is a pass-through.
export function filterByDirection(records: HistoryRecord[], direction: Direction): HistoryRecord[] {
  if (direction === 'all') return records;
  return records.filter((r) => r.direction === direction);
}

// Case-insensitive agent-name match (window names are compared loosely so a
// typed `--agent RIG` finds `rig`). An untagged record (no targetAgent) never
// matches a concrete name.
function agentMatches(rec: HistoryRecord, name: string): boolean {
  return rec.targetAgent !== undefined && rec.targetAgent.toLowerCase() === name.toLowerCase();
}

// One registry session as `tg replies` sees it (sessions.json, spec §3.3): its
// key, its current primary name and the primaries it had before renames.
export interface SessionView {
  key: string;
  name: string;
  aliases: string[];
}

// The registry at read time, plus the key of the reader's own session when `tg`
// resolved it (null: not registered, or the daemon has not scanned it yet).
export interface SessionScope {
  sessions: SessionView[];
  current: string | null;
}

// A row belongs to session `s` when it carries s's key. A row with no key, or
// with a key the registry no longer knows (a promoted provisional key, a pruned
// entry), joins through its name snapshot: s's current name or an alias.
function belongsTo(rec: HistoryRecord, s: SessionView, known: ReadonlySet<string>): boolean {
  if (rec.sessionKey !== undefined && known.has(rec.sessionKey)) return rec.sessionKey === s.key;
  return agentMatches(rec, s.name) || s.aliases.some((a) => agentMatches(rec, a));
}

// Scope the records to a set of AGENTS. `currentAgent` is the reader's own agent
// name (resolved from its tmux pane), or null when it couldn't be determined.
// `sessions` is the registry view, when readable:
//   • all       → pass-through (every agent + untagged)
//   • untagged  → only rows with NO targetAgent and NO sessionKey
//   • named     → rows of every session whose current name or alias is that
//                 name, plus rows whose name snapshot is that name
//   • current   → the reader's registry session when known; else rows for
//                 `currentAgent`; when that is null too the scope DEGRADES to
//                 `untagged` (the caller prints a note) so we never pretend an
//                 unknown reader owns every tagged message.
export function filterByAgent(
  records: HistoryRecord[],
  scope: AgentScope,
  currentAgent: string | null,
  sessions: SessionScope | null = null,
): HistoryRecord[] {
  const known = new Set(sessions?.sessions.map((s) => s.key) ?? []);
  switch (scope.mode) {
    case 'all':
      return records;
    case 'untagged':
      return records.filter((r) => r.targetAgent === undefined && r.sessionKey === undefined);
    case 'named': {
      const want = scope.name.toLowerCase();
      const hits = (sessions?.sessions ?? []).filter((s) => [s.name, ...s.aliases].some((n) => n.toLowerCase() === want));
      return records.filter((r) => agentMatches(r, scope.name) || hits.some((s) => belongsTo(r, s, known)));
    }
    case 'current': {
      const own = sessions?.sessions.find((s) => s.key === sessions.current);
      if (own) return records.filter((r) => belongsTo(r, own, known));
      if (currentAgent === null) return records.filter((r) => r.targetAgent === undefined && r.sessionKey === undefined);
      return records.filter((r) => agentMatches(r, currentAgent));
    }
  }
}

// Keep only records at or after a unix-seconds lower bound. Undefined = no filter.
export function filterBySince(records: HistoryRecord[], since: number | undefined): HistoryRecord[] {
  if (since === undefined) return records;
  return records.filter((r) => r.ts >= since);
}

// Keep only records at or before a unix-seconds upper bound. Undefined = no filter.
export function filterByUntil(records: HistoryRecord[], until: number | undefined): HistoryRecord[] {
  if (until === undefined) return records;
  return records.filter((r) => r.ts <= until);
}

// Scope to a SET of tmux panes. A single `--session %7` resolves to one pane; a
// `--session <windowName>` resolves to EVERY pane of every window with that name
// (a name can repeat across sessions), so the scope is a set and membership is a
// union. A null set means "no scope" (--all-sessions or no detectable pane) —
// pass-through. An empty set matches nothing. A record whose own pane is null
// never matches a concrete set — it was logged outside tmux and belongs to no
// session.
export function filterByPanes(records: HistoryRecord[], panes: string[] | null): HistoryRecord[] {
  if (panes === null) return records;
  return records.filter((r) => r.pane !== null && panes.includes(r.pane));
}

// --- search ---

// Case-insensitive substring (default) or regex search over record text. A
// regex is compiled with the `i` flag; an invalid pattern throws (the
// entrypoint turns that into a clean stderr error + exit 1).
export function searchHistory(records: HistoryRecord[], query: string, regex: boolean): HistoryRecord[] {
  if (regex) {
    const re = new RegExp(query, 'i'); // may throw — caller catches
    return records.filter((r) => re.test(r.text));
  }
  const needle = query.toLowerCase();
  return records.filter((r) => r.text.toLowerCase().includes(needle));
}

// --- multi-part sends ---
//
// A >4096 split or a media-group album writes one history record PER
// outbound message_id, every sibling stamped with the SAME `groupId` (see
// buildOutboundHistoryRecords, review: tg-cli#131) — needed so `--json |
// select(.id == <tg#>)` can recall ANY chunk/item. Group ADJACENT records
// sharing a (defined) groupId into one logical send; a record with no
// groupId is always its own group of one. Grouping by this authoritative
// write-time marker — rather than by coincidental field equality (same ts/
// text/pane) — means two genuinely different messages sent in the same
// second with identical text are NEVER wrongly merged (each lacks a
// groupId, so `undefined !== undefined` never matches).
//
// ADJACENCY dependency: this only groups CONSECUTIVE same-groupId records,
// so it relies on siblings of one send staying contiguous in `records` —
// true today because (a) buildOutboundHistoryRecords' output is written in
// one `writeFileSync` call, so siblings land as consecutive JSONL lines, and
// (b) every filter upstream in selectHistory (direction/panes/since/until/
// search) keeps-or-drops a whole group atomically, since siblings share
// direction/pane/ts/text/from. A future filter keyed on a field that
// DIFFERS across siblings (e.g. message_id itself), or any reordering of
// `records`, would silently split a group and strand a non-first id as
// collapseMultiPartSends' representative — keep that invariant in mind
// before adding either.
function groupMultiPartSends(records: HistoryRecord[]): HistoryRecord[][] {
  const groups: HistoryRecord[][] = [];
  for (const r of records) {
    const lastGroup = groups[groups.length - 1];
    const prev = lastGroup?.[lastGroup.length - 1];
    const samePart = r.groupId !== undefined && prev?.groupId === r.groupId;
    if (samePart) lastGroup.push(r);
    else groups.push([r]);
  }
  return groups;
}

// The plain (non-JSON) listing renders one line per record, so without
// collapsing, a single logical send would print as N identical-looking
// lines. Collapse each group down to its first record (matching the pre-fix
// single-record behavior); only json output (buildJsonOutput, called on the
// un-collapsed `selected`) exposes every id.
export function collapseMultiPartSends(records: HistoryRecord[]): HistoryRecord[] {
  return groupMultiPartSends(records).map((group) => group[0]);
}

// --- selection pipeline ---

// direction → agent → panes → since/until → (find ? search) → keep the LAST
// `limit`, oldest→newest. The pane SET is resolved by the entrypoint (a %-pane
// id, a window name → its pane ids, the detected pane, or null for
// --all-sessions) and passed in, like the registry view; keeping them params
// keeps this pure.
export function selectHistory(
  records: HistoryRecord[],
  args: RepliesQuery,
  panes: string[] | null = null,
  currentAgent: string | null = null,
  sessions: SessionScope | null = null,
): HistoryRecord[] {
  let out = filterByDirection(records, args.direction);
  out = filterByAgent(out, args.agentScope, currentAgent, sessions);
  out = filterByPanes(out, panes);
  out = filterBySince(out, args.since);
  out = filterByUntil(out, args.until);
  if (args.action === 'find' && args.query !== undefined) {
    out = searchHistory(out, args.query, args.regex);
  }
  // `--limit` counts LOGICAL sends, not raw stored records: a multi-part
  // send must count as ONE toward `-n`, and must never be truncated
  // mid-send (a partial group would strand a non-first id as if it were the
  // group's representative, breaking collapseMultiPartSends' "first id"
  // contract — review: tg-cli#131 follow-up). Group first, keep the LAST N
  // groups, then flatten back to records: buildJsonOutput (which wants every
  // id) gets the full membership of the N kept sends; collapseMultiPartSends
  // (which wants one line per send) gets exactly those N groups back. Known
  // limitation this doesn't cover: `appendRecordsToBlob`'s ~5000-line file
  // TRIM (history.ts) cuts from the head and could, in principle, remove an
  // old group's first sibling while keeping its later ones — the "first id"
  // contract is a promise about THIS function's own slicing, not about what
  // survived a prior on-disk trim. Purely cosmetic (a stale group's
  // collapsed line would show a non-first id); `--json` recall of a
  // surviving sibling is unaffected.
  const groups = groupMultiPartSends(out);
  const keptGroups = groups.length > args.limit ? groups.slice(groups.length - args.limit) : groups;
  return keptGroups.flat();
}

// --- formatting ---

// Default truncation for a list/find line (the CTO asked for "~200 chars").
export const TEXT_TRUNCATE = 200;

// Deterministic UTC `YYYY-MM-DD HH:MM` — the default when no fmtTime is given.
// The entrypoint injects a LOCAL-time formatter (Europe/Belgrade for the CTO).
export function fmtTimeUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}`;
}

export interface FormatLineOpts {
  showMarker: boolean; // prefix ←/→ (used for `all`; off for single-direction)
  full: boolean; // skip the ~200-char truncation
  fmtTime: (unixSec: number) => string;
  // Session key → its CURRENT name (the registry), so every row of a renamed
  // session is marked with the name it has now. Absent → the row's snapshot.
  names?: ReadonlyMap<string, string>;
}

// The agent-attribution mark: `[→ <agent>]`, or `[→ ?]` for an untagged row
// (legacy history, a broadcast, or a send whose target couldn't be resolved).
// Shown on EVERY line, in every scope, so a reader always sees which agent each
// message belongs to. A row of a known session shows that session's current
// name; any other row the name it was written with.
function agentMark(rec: HistoryRecord, names: ReadonlyMap<string, string> | undefined): string {
  const current = rec.sessionKey === undefined ? undefined : names?.get(rec.sessionKey);
  return `[→ ${current ?? rec.targetAgent ?? '?'}]`;
}

// One record → one line: `[<time>] #<id> [→ <agent>] <text>`, optionally prefixed
// with a direction marker (← user / → agent) for `all` mode. The `[→ <agent>]`
// mark names the routed-to / sent-from agent and is ALWAYS present. Internal
// newlines are collapsed to spaces so each record stays one grep-able line; long
// text is truncated with an ellipsis unless `full`.
export function formatLine(rec: HistoryRecord, opts: FormatLineOpts): string {
  const time = opts.fmtTime(rec.ts);
  const id = rec.message_id === null ? '?' : String(rec.message_id);
  const oneLine = rec.text.replace(/\s*\n\s*/g, ' ');
  const body = !opts.full && oneLine.length > TEXT_TRUNCATE ? `${oneLine.slice(0, TEXT_TRUNCATE)}…` : oneLine;
  const core = `[${time}] #${id} ${agentMark(rec, opts.names)} ${body}`;
  if (!opts.showMarker) return core;
  const marker = rec.direction === 'agent' ? '→' : '←';
  return `${marker} ${core}`;
}

export interface FormatLinesOpts {
  direction: Direction;
  full: boolean;
  fmtTime: (unixSec: number) => string;
  names?: ReadonlyMap<string, string>;
}

// Render a list of records. Markers are shown ONLY for `all` (a single-direction
// view doesn't need to repeat ←/→ on every line).
export function formatLines(records: HistoryRecord[], opts: FormatLinesOpts): string[] {
  const showMarker = opts.direction === 'all';
  return records.map((r) => formatLine(r, { showMarker, full: opts.full, fmtTime: opts.fmtTime, names: opts.names }));
}

// --- JSON output (--json) ---

export interface HistoryJson {
  ts: number; // epoch MILLISECONDS (history stores seconds; ms is the JS norm)
  id: number | null;
  direction: Direction;
  from: string;
  text: string;
  pane: string | null;
  targetAgent: string | null; // routed-to / sent-from agent name at write time; null when untagged
  sessionKey: string | null; // registry session (`omp:<id>`, …); null on rows written before tg-cli#460
}

export function buildJsonOutput(records: HistoryRecord[]): HistoryJson[] {
  return records.map((r) => ({
    ts: r.ts * 1000,
    id: r.message_id,
    direction: r.direction,
    from: r.from,
    text: r.text,
    pane: r.pane,
    targetAgent: r.targetAgent ?? null,
    sessionKey: r.sessionKey ?? null,
  }));
}
