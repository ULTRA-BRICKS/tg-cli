// `tg replies` keyed by registry session (docs/specs/session-registry-and-topics.md
// §3.3, tg-cli#460): rows carry `sessionKey` + a name snapshot, so renaming a tmux
// window (or `/rename` of an omp) never splits one session's history. Rows written
// before the key existed join a session through its current name or its aliases.
import { expect, test } from 'bun:test';
import { appendRecordsToBlob, type HistoryRecord } from '../features/replies/history';
import { runReplies, type RepliesCliDeps } from '../features/replies/cli';
import type { SessionScope } from '../features/replies/select';

const R = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1700000000,
  message_id: 1,
  direction: 'user',
  from: 'Alex',
  text: 'hi',
  pane: '%1',
  ...over,
});

const A = 'omp:aaaa';
const B = 'cc:bbbb';
// Session A was "deploy", is now "prod". Session B is currently named "deploy".
const REGISTRY: SessionScope = {
  sessions: [
    { key: A, name: 'prod', aliases: ['deploy'] },
    { key: B, name: 'deploy', aliases: [] },
  ],
  current: A,
};

const HISTORY: HistoryRecord[] = [
  R({ message_id: 1, text: 'legacy to deploy', targetAgent: 'deploy' }), // pre-key row: joins via A's alias (and B's name)
  R({ message_id: 2, text: 'keyed before rename', targetAgent: 'deploy', sessionKey: A }),
  R({ message_id: 3, text: 'keyed after rename', targetAgent: 'prod', sessionKey: A, pane: 'omp:42' }),
  R({ message_id: 4, text: 'the other deploy', targetAgent: 'deploy', sessionKey: B, pane: '%2' }),
  R({ message_id: 5, text: 'legacy untagged' }),
  R({ message_id: 6, text: 'promoted provisional', targetAgent: 'prod', sessionKey: 'omp:pane:1/%9/2' }), // key no longer in the registry
  R({ message_id: 7, text: 'agent reply from another pane', direction: 'agent', from: 'agent', targetAgent: 'prod', sessionKey: A, pane: '%5' }),
];

function run(argv: string[], sessions: SessionScope | null, over: Partial<RepliesCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReplies(['replies', ...argv], {
    readHistory: () => appendRecordsToBlob(null, HISTORY),
    detectPane: () => '%1',
    currentAgent: () => null,
    sessions: () => sessions,
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
    ...over,
  });
  return { code, out, err };
}

const ids = (out: string[]) => out.map((l) => Number(/#(\d+)/.exec(l)?.[1]));

test('the default view is the caller\'s session: pre- and post-rename rows, any pane, never another session with the old name', () => {
  const { code, out, err } = run([], REGISTRY);
  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(ids(out)).toEqual([1, 2, 3, 6]);
});

test('every row of a known session is marked with its current name', () => {
  const { out } = run([], REGISTRY);
  expect(out).toEqual([
    '[T] #1 [→ deploy] legacy to deploy',
    '[T] #2 [→ prod] keyed before rename',
    '[T] #3 [→ prod] keyed after rename',
    '[T] #6 [→ prod] promoted provisional',
  ]);
});

test('--agent <oldname> expands through aliases to the renamed session, plus the session that holds the name now', () => {
  expect(ids(run(['--agent', 'DEPLOY'], REGISTRY).out)).toEqual([1, 2, 3, 4, 6]);
  expect(ids(run(['--agent', 'prod'], REGISTRY).out)).toEqual([1, 2, 3, 6]);
});

test('the agent direction shows the session\'s own outbound rows across panes', () => {
  expect(ids(run(['agent'], REGISTRY).out)).toEqual([7]);
  expect(ids(run(['all'], REGISTRY).out)).toEqual([1, 2, 3, 6, 7]);
});

test('--untagged shows only rows with neither a session key nor an agent name', () => {
  expect(ids(run(['--untagged'], REGISTRY).out)).toEqual([5]);
});

test('--json exposes the session key of each row', () => {
  const rows = JSON.parse(run(['--json', '--all'], REGISTRY).out[0]) as Array<{ id: number; sessionKey: string | null }>;
  expect(rows.map((r) => [r.id, r.sessionKey])).toEqual([
    [1, null],
    [2, A],
    [3, A],
    [4, B],
    [5, null],
    [6, 'omp:pane:1/%9/2'],
  ]);
});

test('without a registered caller session the view falls back to the pane + tmux name', () => {
  const { out } = run([], { ...REGISTRY, current: null }, { currentAgent: () => 'deploy' });
  expect(ids(out)).toEqual([1, 2]);
});
