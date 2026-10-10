// tg-cli#554: daemon notices about a session go into that session's topic, where its cards and
// posts are — the limit/overload stall notice (`tg-ctl harness-event`), the hatch critical
// reminder and the unanswered-question reminder. A real tg-ctl against a fake Bot API, asserting
// message_thread_id on the wire.
import { afterAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import {
  SERVER_PID, TG_CTL, ccEntry, makeTopicFixture, removeTopicFixtures, startTopicApi, startTopicDaemon, topicEnv, waitFor,
  type FakeTopicApi, type TopicFixture,
} from './helpers/topic-fixture';
import { writeFileSync } from 'fs';
import { join } from 'path';

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

// A live cc session in pane %5 that already owns topic 42.
function sessionWithTopic(): TopicFixture {
  const fx = makeTopicFixture([
    ccEntry('sess1', { threadId: 42, locators: { pid: 99991, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99990 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n');
  return fx;
}

async function harnessEvent(fx: TopicFixture, api: FakeTopicApi, args: string[], payload: string): Promise<number> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'harness-event', ...args], {
    env: topicEnv(fx, api.port),
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  procs.push(proc);
  proc.stdin.write(payload);
  proc.stdin.end();
  return proc.exited;
}

const limitPayload = JSON.stringify({ reason: 'session_limit', message: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' });

test('a limit stall notice for a session with a topic is posted into that topic', async () => {
  const fx = sessionWithTopic();
  const api = startTopicApi(500);
  apis.push(api);
  expect(await harnessEvent(fx, api, ['--agent', 'claude', '--pane', '%5'], limitPayload)).toBe(0);
  const notice = api.delivered.find((m) => String(m.text).includes('session limit'));
  expect(notice?.message_thread_id).toBe(42);
  // A notice never opens a topic.
  expect(api.createdTopics).toBe(0);
}, 30_000);

test('a stall notice whose topic rejects the send falls back to General', async () => {
  const fx = sessionWithTopic();
  const api = startTopicApi(500);
  apis.push(api);
  api.threadMode = 'not-found';
  expect(await harnessEvent(fx, api, ['--agent', 'claude', '--pane', '%5'], limitPayload)).toBe(0);
  const attempts = api.sent.filter((m) => String(m.text).includes('session limit'));
  expect(attempts.map((m) => m.message_thread_id)).toEqual([42, undefined]);
  expect(api.delivered.some((m) => String(m.text).includes('session limit'))).toBe(true);
}, 30_000);

test('a stall notice for a pane with no session stays in General', async () => {
  const fx = sessionWithTopic();
  const api = startTopicApi(500);
  apis.push(api);
  expect(await harnessEvent(fx, api, ['--agent', 'claude', '--pane', '%9'], limitPayload)).toBe(0);
  const notice = api.delivered.find((m) => String(m.text).includes('session limit'));
  expect(notice).toBeDefined();
  expect(notice?.message_thread_id).toBeUndefined();
}, 30_000);

function startAsk(fx: TopicFixture, api: FakeTopicApi, request: Record<string, unknown>, pane = '%5'): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: topicEnv(fx, api.port, { TMUX_PANE: pane }),
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  procs.push(ask);
  ask.stdin.write(`${JSON.stringify({ agent: 'claude', origin: { sessionId: 'sess1' }, cwd: fx.cfgDir, ...request })}\n`);
  ask.stdin.end();
  return ask;
}

const quietOff = { TG_CTL_QUIET_HOURS_START_HOUR: '0', TG_CTL_QUIET_HOURS_END_HOUR: '0' };

test('the unanswered-question reminder is posted into the topic of the card it refers to', async () => {
  const fx = sessionWithTopic();
  const api = startTopicApi(500);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs, { ...quietOff, TG_CTL_UNANSWERED_REMINDER_AFTER_MS: '400' });
  startAsk(fx, api, {
    requestId: 'q-remind',
    kind: 'question',
    title: 'Question',
    question: 'Pick one for q-remind?',
    options: [{ label: 'A' }, { label: 'B' }],
  });
  const card = await waitFor('card', () => api.delivered.find((m) => String(m.text).includes('Pick one for q-remind?')));
  expect(card.message_thread_id).toBe(42);
  const reminder = await waitFor('reminder', () => api.delivered.find((m) => String(m.text).startsWith('⏳')));
  expect(reminder.message_thread_id).toBe(42);
}, 60_000);

test('an unanswered-question reminder listing cards of two sessions stays in General', async () => {
  const fx = makeTopicFixture([
    ccEntry('sess1', { threadId: 42, locators: { pid: 99991, tmux: { serverPid: SERVER_PID, paneId: '%5', panePid: 99990 }, durableSession: null } }),
    ccEntry('sess2', { threadId: 43, name: { primary: 'beta', secondary: null }, locators: { pid: 99993, tmux: { serverPid: SERVER_PID, paneId: '%6', panePid: 99992 }, durableSession: null } }),
  ]);
  writeFileSync(join(fx.cfgDir, 'procs.txt'), '99990 1 -zsh\n99991 99990 claude\n99992 1 -zsh\n99993 99992 claude\n');
  const api = startTopicApi(500);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs, { ...quietOff, TG_CTL_UNANSWERED_REMINDER_AFTER_MS: '1500' });
  const question = (id: string) => ({ requestId: id, kind: 'question', title: 'Q', question: `Pick one for ${id}?`, options: [{ label: 'A' }] });
  startAsk(fx, api, question('q-one'));
  startAsk(fx, api, { ...question('q-two'), origin: { sessionId: 'sess2' } }, '%6');
  const cardOf = (id: string) => api.delivered.find((m) => String(m.text).includes(`Pick one for ${id}?`));
  expect((await waitFor('card one', () => cardOf('q-one'))).message_thread_id).toBe(42);
  expect((await waitFor('card two', () => cardOf('q-two'))).message_thread_id).toBe(43);
  const both = await waitFor('reminder listing both', () =>
    api.delivered.find((m) => String(m.text).startsWith('⏳ 2 agent questions')),
  );
  expect(both.message_thread_id).toBeUndefined();
}, 60_000);

test('the hatch critical reminder is posted into the topic of the card it refers to', async () => {
  const fx = sessionWithTopic();
  const api = startTopicApi(500);
  apis.push(api);
  await startTopicDaemon(fx, api.port, procs, { ...quietOff, TG_CTL_CRITICAL_REMINDER_INTERVAL_MS: '400' });
  startAsk(fx, api, {
    requestId: 'hatch-crit-hook-eeeeeeeeeeee',
    kind: 'permission',
    question: 'Allow rig hatch escalation: crit-hook?',
    permissionEvent: 'PermissionRequest',
    critical: true,
    hookId: 'crit-hook',
    operation: { kind: 'bash', fingerprint: 'sha256:fp-crit-1', cwd: fx.cfgDir },
  });
  const card = await waitFor('card', () => api.delivered.find((m) => m.reply_markup !== undefined));
  expect(card.message_thread_id).toBe(42);
  const reminder = await waitFor('reminder', () => api.delivered.find((m) => String(m.text).startsWith('⏳ still waiting')));
  expect(reminder.message_thread_id).toBe(42);
}, 60_000);
