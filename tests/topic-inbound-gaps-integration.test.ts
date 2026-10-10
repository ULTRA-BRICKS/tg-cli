// tg-cli#555: inbound triage inside a forum topic (docs/specs/session-registry-and-topics.md
// §4.4) against a real daemon and a fake Bot API — a path typed in the topic where a /new asked
// for it answers that /new; /stop and /kill act on the topic's own session; a voice note that
// cannot be transcribed because voice is off is answered in the topic, never dropped silently.
import { afterAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  SERVER_PID, TG_CTL, ccEntry, entryOf, makeTopicFixture, removeTopicFixtures, startTopicApi, startTopicDaemon, topicEnv, waitFor,
  type FakeTopicApi, type TopicFixture,
} from './helpers/topic-fixture';

const THREAD = 50;
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

let nextUpdate = 1000;
function topicMsg(fields: Record<string, unknown>): unknown {
  const id = nextUpdate++;
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: Math.floor(Date.now() / 1000),
      message_thread_id: THREAD,
      is_topic_message: true,
      ...fields,
    },
  };
}

const tmuxCalls = (fx: TopicFixture): string[] => {
  const path = join(fx.cfgDir, 'tmux.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
};
const inTopic = (api: FakeTopicApi, needle: string): Record<string, unknown> | undefined =>
  api.delivered.find((m) => m.message_thread_id === THREAD && String(m.text).includes(needle));

// A cc session `alpha` owning topic 50 runs in pane %5 with agent pid `agentPid`. It starts gone
// and is re-adopted by its first hook, the way a cc session id reaches the daemon.
async function liveSession(opts: { agentPid?: number; config?: string } = {}): Promise<{ fx: TopicFixture; api: FakeTopicApi }> {
  const agentPid = opts.agentPid ?? 99991;
  const fx = makeTopicFixture(
    [ccEntry('sess1', { state: 'gone', threadId: THREAD, locators: { pid: 99971, tmux: { serverPid: SERVER_PID, paneId: '%3', panePid: 99970 }, durableSession: null } })],
    { chatId: 1, config: opts.config },
  );
  const api = startTopicApi(900);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs);
  writeFileSync(join(fx.cfgDir, 'panes.txt'), `main\t0\t%5\t99990\tclaude\talpha\t\t${fx.cfgDir}\n`);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), `99990 1 -zsh\n${agentPid} 99990 claude\n`);
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: topicEnv(fx, api.port, { TMUX_PANE: '%5' }),
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  procs.push(ask);
  ask.stdin.write(`${JSON.stringify({ requestId: 'r1', agent: 'claude', kind: 'question', title: 'Q', question: 'Pick one?', options: [{ label: 'A' }], origin: { sessionId: 'sess1' }, cwd: fx.cfgDir })}\n`);
  ask.stdin.end();
  await waitFor('re-adoption', () => {
    const e = entryOf(fx, 'cc:sess1');
    return e?.state === 'live' && e.locators.tmux?.paneId === '%5';
  });
  ask.kill(9);
  await ask.exited;
  return { fx, api };
}

test('a path typed in the topic where /new asked for it answers that /new, not the session', async () => {
  const { fx, api } = await liveSession();
  api.updates.push([topicMsg({ text: '/new foo' })]);
  await waitFor('dir prompt in the topic', () => api.delivered.find((m) => m.message_thread_id === THREAD && m.reply_markup !== undefined));
  const before = api.delivered.length;
  api.updates.push([topicMsg({ text: '/tmp' })]);
  // The /new advances to its harness/model step, asked in the same topic.
  const next = await waitFor('model prompt in the topic', () =>
    api.delivered.slice(before).find((m) => m.message_thread_id === THREAD && JSON.stringify(m.reply_markup ?? {}).match(/"tn[hm]:/)),
  );
  expect(next).toBeDefined();
  // Never typed into the topic's session.
  expect(tmuxCalls(fx).some((l) => l.includes('send-keys') && l.includes('/tmp'))).toBe(false);
}, 60_000);

test('/stop in a bound topic presses Escape in that session\'s pane and is not typed as text', async () => {
  const { fx, api } = await liveSession();
  api.updates.push([topicMsg({ text: '/stop' })]);
  await waitFor('Escape to %5', () => tmuxCalls(fx).find((l) => /^send-keys -t %5 Escape$/.test(l)));
  expect(tmuxCalls(fx).some((l) => l.includes('send-keys') && l.includes('-l') && l.includes('/stop'))).toBe(false);
}, 60_000);

test('/kill in a bound topic sends SIGINT to that session\'s agent and answers in the topic', async () => {
  const agent = Bun.spawn(['sleep', '120']);
  procs.push(agent);
  const { api } = await liveSession({ agentPid: agent.pid });
  api.updates.push([topicMsg({ text: '/kill' })]);
  await waitFor('kill reply in the topic', () => inTopic(api, 'session killed'));
  expect(await agent.exited).not.toBe(0);
  expect(agent.signalCode).toBe('SIGINT');
}, 60_000);

test('a voice note in a topic with voice disabled is answered in the topic', async () => {
  const { api } = await liveSession({ config: 'control:\n  enabled: true\n  topics: true\nvoice:\n  enabled: false\n' });
  api.updates.push([topicMsg({ voice: { file_id: 'v1', file_unique_id: 'u1', duration: 2, file_size: 1000 } })]);
  await waitFor('voice-off reply in the topic', () => inTopic(api, 'voice notes are off'));
}, 60_000);
