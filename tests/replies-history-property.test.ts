// Property tests for the `tg replies` history log (features/replies/history.ts, select.ts;
// tg-cli#606): any record survives the JSONL round trip, the bounded append keeps exactly
// the newest N, and `--limit` keeps whole multi-part sends — never a fragment of one.
import { expect, test } from 'bun:test';
import type { RepliesQuery } from '../features/replies/args';
import { appendRecordsToBlob, type HistoryRecord, parseHistory } from '../features/replies/history';
import { buildOutboundHistoryRecords } from '../features/replies/outbound';
import { collapseMultiPartSends, selectHistory } from '../features/replies/select';
import { anyText, arrayOf, forAll, type Gen, int, oneOf, pick } from './helpers/prop';

// Text a history row really carries: anything, plus JSON-hostile and line-hostile bits.
const rowText: Gen<string> = oneOf(anyText(0, 30), pick(['"message_id":5,', '\u2028\u2029', '\\"q\\"', '\r\n', '{"ts":1}', '\ud800 lone']));

let groupSeq = 0;
// One logical event: an inbound user message, or an outbound send of 1..4 parts.
const event: Gen<HistoryRecord[]> = (rng) => {
  const ts = int(1_700_000_000, 1_700_000_100)(rng);
  const chat = pick([-100, -200])(rng);
  const thread = pick<number | null | undefined>([undefined, null, 7, 9])(rng);
  if (rng() < 0.4) {
    return [{
      ts,
      message_id: int(1, 60)(rng),
      chat_id: chat,
      direction: 'user',
      from: pick(['Alex', 'Ж'])(rng),
      text: rowText(rng),
      pane: pick(['%1', '%2', null])(rng),
      ...(thread !== undefined ? { threadId: thread } : {}),
    }];
  }
  const ids = arrayOf(int(1, 60), 1, 4)(rng);
  const threads = new Map<number, number | null>(ids.map((id) => [id, thread ?? null]));
  return buildOutboundHistoryRecords(ids, rowText(rng), ts, pick(['%1', '%2'])(rng), `g${++groupSeq}`, chat, pick([undefined, 'ext'])(rng), undefined, threads);
};
const history: Gen<HistoryRecord[][]> = arrayOf(event, 0, 25);

test('every record survives serialize → append → parse unchanged', () => {
  forAll('history-roundtrip', history, (events) => {
    const recs = events.flat();
    expect(parseHistory(appendRecordsToBlob(null, recs, 10_000))).toEqual(recs);
  });
});

test('batched appends keep exactly the newest N records, in order', () => {
  forAll('history-trim', (rng) => ({ events: history(rng), max: int(1, 12)(rng) }), ({ events, max }) => {
    let blob: string | null = null;
    for (const batch of events) blob = appendRecordsToBlob(blob, batch, max);
    const all = events.flat();
    expect(parseHistory(blob)).toEqual(all.slice(Math.max(0, all.length - max)));
    if (all.length > 0) expect(blob?.endsWith('\n')).toBe(true);
  });
});

const query = (over: Partial<RepliesQuery>): RepliesQuery => ({
  kind: 'query',
  direction: 'all',
  action: 'list',
  limit: 3,
  full: false,
  json: true,
  regex: false,
  agentScope: { mode: 'all' },
  allSessions: true,
  ...over,
});

test('--limit keeps the last N whole sends: never a fragment of a multi-part send', () => {
  const q: Gen<RepliesQuery> = (rng) =>
    query({
      limit: int(1, 6)(rng),
      direction: pick(['all', 'user', 'agent'] as const)(rng),
      ...(rng() < 0.3 ? { since: int(1_700_000_000, 1_700_000_100)(rng) } : {}),
      ...(rng() < 0.3 ? { action: 'find' as const, query: pick(['a', 'hello', 'Ж', '"'])(rng) } : {}),
    });
  forAll('history-select-groups', (rng) => ({ events: history(rng), q: q(rng) }), ({ events, q }) => {
    const recs = events.flat();
    const out = selectHistory(recs, q);
    // the sends that pass the filters, as whole groups
    const passing = events.filter((ev) => selectHistory(ev, { ...q, limit: 1 }).length > 0);
    const kept = passing.slice(Math.max(0, passing.length - q.limit));
    expect(out).toEqual(kept.flat());
    // one collapsed line per send, and it is the send's FIRST part
    expect(collapseMultiPartSends(out)).toEqual(kept.map((ev) => ev[0]));
  });
});
