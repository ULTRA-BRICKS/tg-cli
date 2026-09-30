import { expect, test } from 'bun:test';
import {
  collapseMultiPartSends,
  filterByDirection,
  filterByPanes,
  filterBySince,
  filterByUntil,
  searchHistory,
  selectHistory,
  formatLine,
  formatLines,
  buildJsonOutput,
  type HistoryRecord,
} from '../features/replies/select';

const R = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1000,
  message_id: 1,
  direction: 'user',
  from: 'Alex',
  text: 'hello',
  pane: '%1',
  ...over,
});

const sample: HistoryRecord[] = [
  R({ ts: 1700000000, message_id: 10, direction: 'user', from: 'Alex', text: 'deploy the canary', pane: '%1' }),
  R({ ts: 1700000060, message_id: 11, direction: 'agent', from: 'agent', text: 'deployed canary OK', pane: '%1' }),
  R({ ts: 1700000120, message_id: 12, direction: 'user', from: 'Alex', text: 'roll it BACK now', pane: '%2' }),
  R({ ts: 1700000180, message_id: 13, direction: 'agent', from: 'agent', text: 'rolled back', pane: '%2' }),
];

test('filterByDirection: user keeps inbound only', () => {
  expect(filterByDirection(sample, 'user').map((r) => r.message_id)).toEqual([10, 12]);
});

test('filterByDirection: agent keeps outbound only', () => {
  expect(filterByDirection(sample, 'agent').map((r) => r.message_id)).toEqual([11, 13]);
});

test('filterByDirection: all keeps everything', () => {
  expect(filterByDirection(sample, 'all').length).toBe(4);
});

test('filterByPanes: a single-pane set scopes to that pane; null set = no scope', () => {
  expect(filterByPanes(sample, ['%1']).map((r) => r.message_id)).toEqual([10, 11]);
  expect(filterByPanes(sample, null).length).toBe(4);
});

test('filterByPanes: a multi-pane set is a UNION across panes (window name → several panes)', () => {
  expect(filterByPanes(sample, ['%1', '%2']).map((r) => r.message_id)).toEqual([10, 11, 12, 13]);
});

test('filterByPanes: an empty set matches nothing', () => {
  expect(filterByPanes(sample, [])).toEqual([]);
});

test('filterByPanes: records with a null pane never match a concrete pane set', () => {
  const withNull = [...sample, R({ message_id: 99, pane: null, direction: 'agent' })];
  expect(filterByPanes(withNull, ['%1']).map((r) => r.message_id)).toEqual([10, 11]);
  expect(filterByPanes(withNull, ['%1', '%2']).map((r) => r.message_id)).toEqual([10, 11, 12, 13]);
});

test('searchHistory: case-insensitive substring', () => {
  expect(searchHistory(sample, 'CANARY', false).map((r) => r.message_id)).toEqual([10, 11]);
  expect(searchHistory(sample, 'back', false).map((r) => r.message_id)).toEqual([12, 13]);
});

test('searchHistory: regex mode', () => {
  // `roll.*back` matches both "roll it BACK now" and "rolled back".
  expect(searchHistory(sample, 'roll.*back', true).map((r) => r.message_id)).toEqual([12, 13]);
  // `^deploy ` (trailing space) anchors to the start AND the word boundary, so
  // it matches "deploy the canary" but not "deployed canary OK".
  expect(searchHistory(sample, '^deploy ', true).map((r) => r.message_id)).toEqual([10]);
});

test('searchHistory: regex is case-insensitive too', () => {
  expect(searchHistory(sample, 'CANARY', true).map((r) => r.message_id)).toEqual([10, 11]);
});

test('searchHistory: invalid regex throws a typed error', () => {
  expect(() => searchHistory(sample, '(', true)).toThrow();
});

test('selectHistory: list, default user direction, scoped to pane-set [%1], oldest→newest, limited', () => {
  // The entrypoint resolves the effective pane SET (--session / detected / null)
  // and passes it in; here [%1] is the resolved scope.
  const out = selectHistory(
    sample,
    {
      kind: 'query',
      agentScope: { mode: 'all' },
      direction: 'user',
      action: 'list',
      allSessions: false,
      session: '%1',
      limit: 20,
      full: false,
      json: false,
      regex: false,
    },
    ['%1'],
  );
  expect(out.map((r) => r.message_id)).toEqual([10]); // only user+%1
});

test('selectHistory: a multi-pane set (window→several panes) unions across them', () => {
  const out = selectHistory(
    sample,
    {
      kind: 'query',
      agentScope: { mode: 'all' },
      direction: 'user',
      action: 'list',
      allSessions: false,
      limit: 20,
      full: false,
      json: false,
      regex: false,
    },
    ['%1', '%2'],
  );
  expect(out.map((r) => r.message_id)).toEqual([10, 12]); // user rows across %1 and %2
});

test('selectHistory: limit keeps the LAST N but renders oldest→newest', () => {
  const many: HistoryRecord[] = [];
  for (let i = 0; i < 10; i++) many.push(R({ ts: 1000 + i, message_id: i, direction: 'user', pane: '%1' }));
  const out = selectHistory(many, {
    kind: 'query',
    agentScope: { mode: 'all' },
    direction: 'user',
    action: 'list',
    allSessions: true,
    limit: 3,
    full: false,
    json: false,
    regex: false,
  });
  expect(out.map((r) => r.message_id)).toEqual([7, 8, 9]); // last 3, ascending
});

test('selectHistory: limit counts a multi-part send as ONE, never truncates it mid-send', () => {
  // Two single-record sends, then a 3-record multi-part send (shared
  // groupId — a >4096 split or an album, review: tg-cli#131 follow-up), then
  // one more single-record send: 6 raw records, 4 LOGICAL sends. `-n 2` must
  // keep the last 2 SENDS (the multi-part one + the final one) — 4 raw
  // records — not the last 2 RAW records (which would slice the multi-part
  // group in half and strand a non-first id as its "first").
  const records: HistoryRecord[] = [
    R({ ts: 1000, message_id: 1, direction: 'agent', from: 'agent', text: 'a', pane: '%1' }),
    R({ ts: 2000, message_id: 2, direction: 'agent', from: 'agent', text: 'b', pane: '%1' }),
    R({ ts: 3000, message_id: 201, groupId: 'grp-201', direction: 'agent', from: 'agent', text: 'long', pane: '%1' }),
    R({ ts: 3000, message_id: 202, groupId: 'grp-201', direction: 'agent', from: 'agent', text: 'long', pane: '%1' }),
    R({ ts: 3000, message_id: 203, groupId: 'grp-201', direction: 'agent', from: 'agent', text: 'long', pane: '%1' }),
    R({ ts: 4000, message_id: 4, direction: 'agent', from: 'agent', text: 'd', pane: '%1' }),
  ];
  const out = selectHistory(records, {
    kind: 'query',
    agentScope: { mode: 'all' },
    direction: 'agent',
    action: 'list',
    allSessions: true,
    limit: 2,
    full: false,
    json: false,
    regex: false,
  });
  // All 3 multi-part ids survive (not truncated) + the final single send.
  expect(out.map((r) => r.message_id)).toEqual([201, 202, 203, 4]);
  // The plain listing still collapses to exactly 2 lines, first id 201 (not
  // 202/203 — the group was never cut, so "first id" holds).
  expect(collapseMultiPartSends(out).map((r) => r.message_id)).toEqual([201, 4]);
});

test('selectHistory: find applies the query after direction + pane scoping', () => {
  const out = selectHistory(sample, {
    kind: 'query',
    agentScope: { mode: 'all' },
    direction: 'all',
    action: 'find',
    query: 'canary',
    allSessions: true,
    limit: 20,
    full: false,
    json: false,
    regex: false,
  });
  expect(out.map((r) => r.message_id)).toEqual([10, 11]);
});

test('selectHistory: find keeps a matching multi-part group ATOMIC — every id survives, none stranded', () => {
  // search is the most nontrivial filter (a computed match, not a plain
  // field compare) — the group-atomicity invariant `groupMultiPartSends`
  // relies on holds here too, since siblings share `text` (search matches
  // or misses ALL of them identically). Guards against a future search
  // implementation that could inspect a per-record field instead of `text`.
  const albumSiblings: HistoryRecord[] = [
    R({ ts: 1700000300, message_id: 301, groupId: 'grp-301', direction: 'agent', from: 'agent', text: '[3 photos]', pane: '%2' }),
    R({ ts: 1700000300, message_id: 302, groupId: 'grp-301', direction: 'agent', from: 'agent', text: '[3 photos]', pane: '%2' }),
    R({ ts: 1700000300, message_id: 303, groupId: 'grp-301', direction: 'agent', from: 'agent', text: '[3 photos]', pane: '%2' }),
  ];
  const out = selectHistory([...sample, ...albumSiblings], {
    kind: 'query',
    agentScope: { mode: 'all' },
    direction: 'agent',
    action: 'find',
    query: 'photos',
    allSessions: true,
    limit: 20,
    full: false,
    json: false,
    regex: false,
  });
  expect(out.map((r) => r.message_id)).toEqual([301, 302, 303]); // whole group, no id dropped
  expect(collapseMultiPartSends(out).map((r) => r.message_id)).toEqual([301]); // one line
});

test('formatLine: user line shape `[YYYY-MM-DD HH:MM] #id text` with no marker for single-direction', () => {
  const line = formatLine(R({ ts: 1700000000, message_id: 10, text: 'hi', direction: 'user' }), {
    showMarker: false,
    full: false,
    fmtTime: () => '2026-06-15 10:00',
  });
  expect(line).toBe('[2026-06-15 10:00] #10 [→ ?] hi');
});

test('formatLine: null message_id renders #? ', () => {
  const line = formatLine(R({ message_id: null, text: 'hi', direction: 'agent' }), {
    showMarker: false,
    full: false,
    fmtTime: () => '2026-06-15 10:00',
  });
  expect(line).toBe('[2026-06-15 10:00] #? [→ ?] hi');
});

test('formatLine: all-mode prefixes ← for user, → for agent', () => {
  const u = formatLine(R({ message_id: 10, text: 'hi', direction: 'user' }), {
    showMarker: true,
    full: false,
    fmtTime: () => 'T',
  });
  const a = formatLine(R({ message_id: 11, text: 'yo', direction: 'agent' }), {
    showMarker: true,
    full: false,
    fmtTime: () => 'T',
  });
  expect(u).toBe('← [T] #10 [→ ?] hi');
  expect(a).toBe('→ [T] #11 [→ ?] yo');
});

test('formatLine: truncates to ~200 chars unless full', () => {
  const long = 'x'.repeat(500);
  const truncated = formatLine(R({ message_id: 1, text: long, direction: 'user' }), {
    showMarker: false,
    full: false,
    fmtTime: () => 'T',
  });
  // body part after the "#1 [→ ?] " prefix (id + agent mark)
  const body = truncated.split('[→ ?] ')[1];
  expect(body.length).toBe(201); // 200 + ellipsis
  expect(body.endsWith('…')).toBe(true);

  const fullLine = formatLine(R({ message_id: 1, text: long, direction: 'user' }), {
    showMarker: false,
    full: true,
    fmtTime: () => 'T',
  });
  expect(fullLine.split('[→ ?] ')[1].length).toBe(500);
});

test('formatLine: collapses internal newlines to spaces so each record is one line', () => {
  const line = formatLine(R({ message_id: 1, text: 'a\nb\nc', direction: 'user' }), {
    showMarker: false,
    full: false,
    fmtTime: () => 'T',
  });
  expect(line).toBe('[T] #1 [→ ?] a b c');
});

test('formatLines: all-mode shows markers; single-direction omits them', () => {
  const all = formatLines(sample, { direction: 'all', full: false, fmtTime: () => 'T' });
  expect(all[0].startsWith('←')).toBe(true);
  expect(all[1].startsWith('→')).toBe(true);

  const userOnly = formatLines(filterByDirection(sample, 'user'), {
    direction: 'user',
    full: false,
    fmtTime: () => 'T',
  });
  expect(userOnly[0].startsWith('[')).toBe(true);
});

test('buildJsonOutput: machine shape (ts ms, id, direction, from, text, pane)', () => {
  const json = buildJsonOutput([
    R({ ts: 1700000000, message_id: 10, direction: 'user', from: 'Alex', text: 'hi', pane: '%1' }),
  ]);
  expect(json).toEqual([
    { ts: 1700000000000, id: 10, direction: 'user', from: 'Alex', text: 'hi', pane: '%1', targetAgent: null, sessionKey: null },
  ]);
});

test('buildJsonOutput: ts is epoch MS (history stores seconds)', () => {
  const json = buildJsonOutput([R({ ts: 1700000000, message_id: 1 })]);
  expect(json[0].ts).toBe(1700000000 * 1000);
});

// collapseMultiPartSends (review: tg-cli#131 fix's own follow-up regression —
// buildOutboundHistoryRecords now writes one record per outbound id, tagged
// with a shared `groupId`, so the plain listing must collapse them back to
// one line per logical send).

test('collapseMultiPartSends: a >4096-split send (3 ids, same groupId) collapses to ONE record', () => {
  const parts = [
    R({ ts: 1700000000, message_id: 201, groupId: 'grp-201', direction: 'agent', from: 'agent', text: 'long report', pane: '%1' }),
    R({ ts: 1700000000, message_id: 202, groupId: 'grp-201', direction: 'agent', from: 'agent', text: 'long report', pane: '%1' }),
    R({ ts: 1700000000, message_id: 203, groupId: 'grp-201', direction: 'agent', from: 'agent', text: 'long report', pane: '%1' }),
  ];
  const out = collapseMultiPartSends(parts);
  expect(out.length).toBe(1);
  expect(out[0].message_id).toBe(201); // first id — matches the pre-fix single-record behavior
});

test('collapseMultiPartSends: distinct sends (different text) are never merged', () => {
  const out = collapseMultiPartSends(sample);
  expect(out.length).toBe(sample.length); // none of `sample`'s records carry a groupId
});

test('collapseMultiPartSends: two DIFFERENT messages sent in the SAME second with IDENTICAL text are NEVER merged', () => {
  // The exact false-positive the old ts/text/pane-equality heuristic risked
  // (review: tg-cli#131 follow-up) — e.g. the agent sends "ok" twice in one
  // second via two separate `tg` invocations. Neither is part of a real
  // multi-part send, so NEITHER carries a groupId — grouping must not merge
  // them just because every other field happens to match.
  const records = [
    R({ ts: 5000, message_id: 1, direction: 'agent', from: 'agent', text: 'ok', pane: '%1' }), // no groupId
    R({ ts: 5000, message_id: 2, direction: 'agent', from: 'agent', text: 'ok', pane: '%1' }), // no groupId
  ];
  const out = collapseMultiPartSends(records);
  expect(out.map((r) => r.message_id)).toEqual([1, 2]); // both survive — NOT collapsed
});

test('collapseMultiPartSends: two unrelated real multi-part sends (different groupIds) stay separate', () => {
  const records = [
    R({ ts: 1000, message_id: 1, groupId: 'grp-1', direction: 'agent', from: 'agent', text: 'ok', pane: '%1' }),
    R({ ts: 1000, message_id: 2, groupId: 'grp-1', direction: 'agent', from: 'agent', text: 'ok', pane: '%1' }),
    R({ ts: 2000, message_id: 3, groupId: 'grp-3', direction: 'agent', from: 'agent', text: 'ok', pane: '%1' }),
    R({ ts: 2000, message_id: 4, groupId: 'grp-3', direction: 'agent', from: 'agent', text: 'ok', pane: '%1' }),
  ];
  const out = collapseMultiPartSends(records);
  expect(out.map((r) => r.message_id)).toEqual([1, 3]); // one line per group
});

test('collapseMultiPartSends: two DIFFERENT chats sharing one bot history, coincidentally starting at the SAME Telegram message_id, stay separate', () => {
  // Telegram message_id is sequential PER CHAT — a bot in two different
  // chats can see both chats' multi-part sends start at the same id (e.g.
  // both albums' first item happens to be #301). The history file is keyed
  // by bot, not by chat, so these could land adjacent. A groupId DERIVED
  // from the first message_id would collide here; the caller-supplied
  // random token does not (review: tg-cli#131 follow-up).
  const records = [
    R({ ts: 1000, message_id: 301, groupId: 'random-token-chatA', direction: 'agent', from: 'agent', text: 'album A', pane: null }),
    R({ ts: 1000, message_id: 302, groupId: 'random-token-chatA', direction: 'agent', from: 'agent', text: 'album A', pane: null }),
    R({ ts: 1000, message_id: 301, groupId: 'random-token-chatB', direction: 'agent', from: 'agent', text: 'album A', pane: null }),
    R({ ts: 1000, message_id: 302, groupId: 'random-token-chatB', direction: 'agent', from: 'agent', text: 'album A', pane: null }),
  ];
  // Note: identical ts/text/pane across BOTH sends (worst case) — only the
  // groupId distinguishes them, which is exactly the point of this test.
  const out = collapseMultiPartSends(records);
  expect(out.length).toBe(2); // NOT merged into one — two logical sends survive
});

test('collapseMultiPartSends: empty input → empty output', () => {
  expect(collapseMultiPartSends([])).toEqual([]);
});

test('collapseMultiPartSends: --json (buildJsonOutput on the UN-collapsed input) still exposes every id', () => {
  const parts = [
    R({ ts: 1700000300, message_id: 301, groupId: 'grp-301', direction: 'agent', from: 'agent', text: '[3 photos]', pane: '%2' }),
    R({ ts: 1700000300, message_id: 302, groupId: 'grp-301', direction: 'agent', from: 'agent', text: '[3 photos]', pane: '%2' }),
    R({ ts: 1700000300, message_id: 303, groupId: 'grp-301', direction: 'agent', from: 'agent', text: '[3 photos]', pane: '%2' }),
  ];
  // The JSON path must NOT collapse — a reply to the album's 2nd item (302)
  // has to be findable via `select(.id == 302)`.
  expect(buildJsonOutput(parts).map((r) => r.id)).toEqual([301, 302, 303]);
  // While the plain-listing path DOES collapse to one line.
  expect(collapseMultiPartSends(parts).length).toBe(1);
});

// filterBySince / filterByUntil

test('filterBySince: undefined is a pass-through', () => {
  expect(filterBySince(sample, undefined).length).toBe(4);
});

test('filterBySince: keeps only records at or after the lower bound', () => {
  // ts values: 1700000000, 1700000060, 1700000120, 1700000180
  const out = filterBySince(sample, 1700000060);
  expect(out.map((r) => r.message_id)).toEqual([11, 12, 13]);
});

test('filterBySince: exact match is inclusive', () => {
  const out = filterBySince(sample, 1700000000);
  expect(out.length).toBe(4);
});

test('filterBySince: value after last record returns empty', () => {
  expect(filterBySince(sample, 1700000999)).toEqual([]);
});

test('filterByUntil: undefined is a pass-through', () => {
  expect(filterByUntil(sample, undefined).length).toBe(4);
});

test('filterByUntil: keeps only records at or before the upper bound', () => {
  const out = filterByUntil(sample, 1700000060);
  expect(out.map((r) => r.message_id)).toEqual([10, 11]);
});

test('filterByUntil: exact match is inclusive', () => {
  const out = filterByUntil(sample, 1700000180);
  expect(out.length).toBe(4);
});

test('filterByUntil: value before first record returns empty', () => {
  expect(filterByUntil(sample, 999999999)).toEqual([]);
});

test('selectHistory: --since and --until filter the window correctly', () => {
  const out = selectHistory(
    sample,
    {
      kind: 'query',
      agentScope: { mode: 'all' },
      direction: 'all',
      action: 'list',
      allSessions: true,
      limit: 20,
      full: false,
      json: false,
      regex: false,
      since: 1700000060,
      until: 1700000120,
    },
    null,
  );
  expect(out.map((r) => r.message_id)).toEqual([11, 12]);
});
