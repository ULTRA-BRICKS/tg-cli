// tg-cli#556: topic ownership edge cases against a real daemon and a fake Bot API.
import { afterAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  SERVER_PID, TG_CTL, ccEntry, entryOf, makeTopicFixture, removeTopicFixtures, startTopicApi, startTopicDaemon, topicEnv, waitFor,
  type FakeTopicApi,
} from './helpers/topic-fixture';

const procs: Subprocess[] = [];
const apis: FakeTopicApi[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const a of apis) a.stop();
  removeTopicFixtures();
});

// (1) A pane-bound topic that another registry entry already owns is not adopted: when that
// entry resumes, two live sessions would share one topic.
test('a session never adopts a pane-bound topic another registry entry owns', async () => {
  const fx = makeTopicFixture([
    ccEntry('sess1', { locators: { pid: 99991, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99990 }, durableSession: null } }),
    ccEntry('old', { state: 'gone', threadId: 77, name: { primary: 'old', secondary: null }, locators: { pid: 99981, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99980 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  // The old session's binding still names pane %5 (with the same cwd).
  writeFileSync(fx.topicsPath, JSON.stringify([{ threadId: 77, name: 'old', status: 'bound', paneId: '%5', path: '/tmp', harness: 'claude', ts: 1 }]));
  const api = startTopicApi(500);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs);
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: topicEnv(fx, api.port, { TMUX_PANE: '%5' }), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  procs.push(ask);
  ask.stdin.write(`${JSON.stringify({ requestId: 'q1', agent: 'claude', kind: 'question', title: 'Q', question: 'Pick one for q1?', options: [{ label: 'A' }], origin: { sessionId: 'sess1' }, cwd: fx.cfgDir })}\n`);
  ask.stdin.end();
  const card = await waitFor('card', () => api.delivered.find((m) => String(m.text).includes('Pick one for q1?')));
  expect(card.message_thread_id).toBe(500);
  expect(api.createdTopics).toBe(1);
  expect(entryOf(fx, 'cc:sess1')?.threadId).toBe(500);
  expect(entryOf(fx, 'cc:old')?.threadId).toBe(77);
}, 60_000);


// tg-cli#498 (1): the at-most-once-per-24h recreate cap (§4.2) is persisted on the entry, so a
// daemon restart does not forget a recreate it did an hour ago.
test('a topic recreated less than 24h before a daemon restart is not recreated again after it', async () => {
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const fx = makeTopicFixture([
    ccEntry('sess1', { threadId: 42, topicRecreatedAt: anHourAgo, locators: { pid: 99991, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99990 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  const api = startTopicApi(500);
  apis.push(api);
  api.threadMode = 'deleted';
  await startTopicDaemon(fx, api.port, procs);
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: topicEnv(fx, api.port, { TMUX_PANE: '%5' }), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  procs.push(ask);
  ask.stdin.write(`${JSON.stringify({ requestId: 'q1', agent: 'claude', kind: 'question', title: 'Q', question: 'Pick one for q1?', options: [{ label: 'A' }], origin: { sessionId: 'sess1' }, cwd: fx.cfgDir })}\n`);
  ask.stdin.end();
  const card = await waitFor('card in General', () => api.delivered.find((m) => String(m.text).includes('Pick one for q1?')));
  expect(card.message_thread_id).toBeUndefined();
  // Still within the cap: the topic is kept (a miss is counted), not dropped for a recreate.
  await waitFor('miss recorded', () => entryOf(fx, 'cc:sess1')?.topicMisses?.count === 1);
  expect(entryOf(fx, 'cc:sess1')?.threadId).toBe(42);
  expect(api.sent.some((m) => String(m.text).includes('its topic is gone'))).toBe(false);
}, 60_000);

// tg-cli#498 (2): a session that exits gets one "⏹ exited" line in its topic and, in a forum
// supergroup, the topic is closed; re-adopting the session reopens the topic before "reattached".
test('an exiting session posts "exited" and closes its forum topic; re-adoption reopens it first', async () => {
  const fx = makeTopicFixture([
    ccEntry('sess1', { state: 'gone', threadId: 42, locators: { pid: 99971, tmux: { serverPid: SERVER_PID, paneId: '%3', panePid: 99970 }, durableSession: null } }),
  ]);
  const api = startTopicApi(500);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs);
  const shellPane = `main\t0\t%9\t99960\tzsh\tshell\t\t${fx.cfgDir}\n`;
  const agentPane = `main\t0\t%5\t99990\tclaude\talpha\t\t${fx.cfgDir}\n`;
  writeFileSync(join(fx.cfgDir, 'panes.txt'), shellPane + agentPane);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99960 1 -zsh\n99990 1 -zsh\n99991 99990 claude\n');
  const readopt = (): void => {
    const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: topicEnv(fx, api.port, { TMUX_PANE: '%5' }), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    procs.push(ask);
    ask.stdin.write(`${JSON.stringify({ requestId: `r${procs.length}`, agent: 'claude', kind: 'question', title: 'Q', question: 'Pick?', options: [{ label: 'A' }], origin: { sessionId: 'sess1' }, cwd: fx.cfgDir })}\n`);
    ask.stdin.end();
  };
  readopt();
  await waitFor('first re-adoption', () => entryOf(fx, 'cc:sess1')?.state === 'live');
  const callsBefore = api.calls.length;

  // The agent exits to its shell: the next trusted scan sees the pane without it.
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99960 1 -zsh\n99990 1 -zsh\n');
  const exited = await waitFor('exited line', () => api.delivered.find((m) => m.message_thread_id === 42 && String(m.text).startsWith('⏹ alpha — exited')), 40_000);
  expect(String(exited.text)).toContain('claude --resume');
  await waitFor('topic closed', () => api.calls.slice(callsBefore).find((c) => c.method === 'closeForumTopic' && c.body.message_thread_id === 42));

  // It comes back: reopened first, then "reattached".
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99960 1 -zsh\n99990 1 -zsh\n99995 99990 claude\n');
  readopt();
  const reattached = await waitFor('reattached', () => api.delivered.find((m) => m.message_thread_id === 42 && String(m.text).includes('— reattached') && api.delivered.indexOf(m) > api.delivered.indexOf(exited)), 40_000);
  expect(reattached).toBeDefined();
  expect(api.calls.some((c) => c.method === 'reopenForumTopic' && c.body.message_thread_id === 42)).toBe(true);
}, 120_000);

// tg-cli#498 (3): a pruned session's topic was closed when it exited, so its topics.json pane
// binding goes with the entry: a later session in that pane must open a topic, not adopt a closed
// one whose every post bounces to General.
test('pruning a gone session unbinds its topic, so the next session in its pane opens a new one', async () => {
  const old = new Date(Date.now() - 31 * 24 * 3600_000).toISOString();
  const fx = makeTopicFixture([
    ccEntry('old', { state: 'gone', threadId: 77, cwd: '/tmp', firstSeen: old, lastSeen: old, locators: { pid: 99971, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99990 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'panes.txt'), `main\t0\t%5\t99990\tclaude\talpha\t\t/tmp\n`);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  writeFileSync(fx.topicsPath, JSON.stringify([{ threadId: 77, name: 'old', status: 'bound', paneId: '%5', path: '/tmp', harness: 'claude', ts: 1 }]));
  const api = startTopicApi(500);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs);
  await waitFor('pruned', () => entryOf(fx, 'cc:old') === undefined);
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: topicEnv(fx, api.port, { TMUX_PANE: '%5' }), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  procs.push(ask);
  ask.stdin.write(`${JSON.stringify({ requestId: 'p1', agent: 'claude', kind: 'question', title: 'Q', question: 'Pick one for p1?', options: [{ label: 'A' }], origin: { sessionId: 'sess9' }, cwd: fx.cfgDir })}\n`);
  ask.stdin.end();
  const card = await waitFor('card', () => api.delivered.find((m) => String(m.text).includes('Pick one for p1?')), 40_000);
  expect(card.message_thread_id).toBe(500);
  expect(api.createdTopics).toBe(1);
}, 90_000);
