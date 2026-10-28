import { describe, expect, test } from 'bun:test';
import { stepUpdates, type StepOpts } from '../features/tg-ctl/updates';
import { botCommandNames } from '../features/tg-ctl/bot-commands';
import { DEFAULT_CONTROL, type TgUpdate, type TopicStatus } from '../features/tg-ctl/types';

const OWNER = 1000;
const THREAD = 99;
const NOW = 1_750_000_000;

function topicMessage(text: string, sender = OWNER, chat = OWNER): TgUpdate {
  return { update_id: 7, message: { message_id: 77, from: { id: sender, first_name: 'Owner' },
    chat: { id: chat }, date: NOW, text, is_topic_message: true, message_thread_id: THREAD,
    reply_to_message: { message_id: 55, chat: { id: chat }, date: NOW, text: 'Previous report' } } };
}

function options(binding: TopicStatus | null): StepOpts {
  return { cfg: { ...DEFAULT_CONTROL, allowedSenders: [31] }, chatId: OWNER,
    nowSec: NOW, currentOffset: 1, wrap: (name, text) => `[${name}] ${text}`,
    topicsEnabled: true, topicStatusOf: () => binding };
}

describe('owner ChatGPT commands remain control commands inside topics', () => {
  for (const binding of ['bound', null] as const) {
    for (const [text, workspace] of [['/chatgpt', 'all'], ['/chatgpt home', 'home'],
      ['/chatgpt@UltraClaudeCodeBot glide.vc', 'glide.vc']] as const) {
      test(`${text} in ${binding ?? 'unbound'} topic opens the menu without prompting an agent`, () => {
        const result = stepUpdates([topicMessage(text)], options(binding));
        expect(result.actions).toEqual([
          { kind: 'chatgpt-menu', workspace, threadId: THREAD },
          { kind: 'ack', messageId: 77 },
        ]);
      });
    }
  }
  test('extra allowed sender and a foreign chat are still refused', () => {
    expect(stepUpdates([topicMessage('/chatgpt', 31)], options('bound')).actions).toEqual([]);
    expect(stepUpdates([topicMessage('/chatgpt', OWNER, -500)], options('bound')).actions).toEqual([]);
    expect(stepUpdates([topicMessage('/chatgpt', 777)], options('bound')).actions).toEqual([]);
  });
  for (const text of ['/stop', '/kill']) {
    test(`${text} remains scoped to the bound agent`, () => {
      const result = stepUpdates([topicMessage(text)], options('bound'));
      expect(result.actions[0]).toMatchObject({ kind: 'topic-route', threadId: THREAD });
    });
  }
});


test('every published non-session daemon verb remains in the topic control plane', () => {
  for (const command of botCommandNames()) {
    if (command === 'stop' || command === 'kill') continue;
    for (const binding of ['bound', null] as const) {
      const result = stepUpdates([topicMessage(`/${command}`)], options(binding));
      expect(result.actions.length).toBeGreaterThan(0);
      expect(['inject-text', 'topic-route', 'topic-hold']).not.toContain(result.actions[0].kind);
    }
  }
});
