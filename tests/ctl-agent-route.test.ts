import { expect, test } from 'bun:test';
import { stepUpdates } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type TgUpdate } from '../features/tg-ctl/types';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;

const opts = {
  cfg: { ...DEFAULT_CONTROL },
  chatId: CHAT_ID,
  nowSec: NOW,
  currentOffset: 0,
  wrap: (name: string, msg: string) => `[TG from ${name}] ${msg}`,
};

function textUpd(id: number, text: string): TgUpdate {
  return {
    update_id: id,
    message: { message_id: id, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW, text },
  };
}

function cbUpd(id: number, data: string): TgUpdate {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: CHAT_ID, first_name: 'Alex' }, data, message: { message_id: 77, chat: { id: CHAT_ID }, date: NOW } },
  };
}

test('/agent <win> <msg> → agent-route with selector + rest + ack', () => {
  const r = stepUpdates([textUpd(1, '/agent feat-bot deploy now')], opts);
  expect(r.actions[0]).toEqual({
    kind: 'agent-route',
    selector: 'feat-bot',
    rest: 'deploy now',
    all: 'feat-bot deploy now',
    from: 'Alex',
    messageId: 1,
  });
  // a non-reply action earns the 👀 receipt
  expect(r.actions[1]).toEqual({ kind: 'ack', messageId: 1 });
});

test('bare /agent → agent-route with null selector and empty message', () => {
  const r = stepUpdates([textUpd(2, '/agent')], opts);
  expect(r.actions[0]).toMatchObject({ kind: 'agent-route', selector: null, all: '' });
});

test('/agent@botname tolerated', () => {
  const r = stepUpdates([textUpd(3, '/agent@mybot api ping')], opts);
  expect(r.actions[0]).toMatchObject({ kind: 'agent-route', selector: 'api', rest: 'ping' });
});

test('tga: callback → agent-callback action', () => {
  const r = stepUpdates([cbUpd(4, 'tga:a1:2')], opts);
  expect(r.actions[0]).toEqual({
    kind: 'agent-callback',
    callbackQueryId: 'cb4',
    token: 'a1',
    index: 2,
    from: 'Alex',
    messageId: 77,
    languageCode: null,
  });
});

test('tgq: callback still routes to answer-question (no regression)', () => {
  const r = stepUpdates([cbUpd(5, 'tgq:req1:o0')], opts);
  expect(r.actions[0]).toMatchObject({ kind: 'answer-question', requestId: 'req1', value: 'o0' });
});

test('other slash commands still pass through verbatim', () => {
  const r = stepUpdates([textUpd(6, '/compact')], opts);
  expect(r.actions[0]).toEqual({ kind: 'inject-text', text: '/compact', messageId: 6 });
});
