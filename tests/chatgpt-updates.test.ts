import { describe, expect, test } from 'bun:test';
import { stepUpdates, type StepOpts } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type TgUpdate } from '../features/tg-ctl/types';
import { BOT_COMMANDS } from '../features/tg-ctl/bot-commands';

const OWNER = 1000;
const NOW = 1_750_000_000;

function opts(over: Partial<StepOpts> = {}): StepOpts {
  return { cfg: { ...DEFAULT_CONTROL }, chatId: OWNER, nowSec: NOW, currentOffset: 1, wrap: (n, m) => `[${n}] ${m}`, ...over };
}

function cbUpdate(data: string, from: number, chat: number, id = 1): TgUpdate {
  return {
    update_id: id,
    callback_query: { id: `cbq${id}`, from: { id: from, first_name: 'X' }, data, message: { message_id: 9, chat: { id: chat }, date: NOW } },
  } as TgUpdate;
}

function msg(text: string, from = OWNER, chat = OWNER): TgUpdate {
  return { update_id: 2, message: { message_id: 2, from: { id: from, first_name: 'X' }, chat: { id: chat }, date: NOW, text } };
}

describe('/chatgpt routing', () => {
  test('/chatgpt is a published bot command', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toContain('chatgpt');
  });
  test('/chatgpt from the owner becomes a chatgpt-menu action, never an inject', () => {
    const r = stepUpdates([msg('/chatgpt')], opts());
    expect(r.actions.some((a) => a.kind === 'inject-text')).toBe(false);
    expect(r.actions[0]).toMatchObject({ kind: 'chatgpt-menu', workspace: 'all' });
  });
  test('/chatgpt home and /chatgpt@bot glide.vc select a workspace; junk is flagged', () => {
    expect(stepUpdates([msg('/chatgpt home')], opts()).actions[0]).toMatchObject({ kind: 'chatgpt-menu', workspace: 'home' });
    expect(stepUpdates([msg('/chatgpt@MyBot glide.vc')], opts()).actions[0]).toMatchObject({ kind: 'chatgpt-menu', workspace: 'glide.vc' });
    expect(stepUpdates([msg('/chatgpt junk')], opts()).actions[0]).toMatchObject({ kind: 'chatgpt-menu', workspace: null });
  });
  test('/chatgpt from a stranger or another chat does nothing', () => {
    expect(stepUpdates([msg('/chatgpt', 777, OWNER)], opts()).actions).toEqual([]);
    expect(stepUpdates([msg('/chatgpt', OWNER, 555)], opts()).actions).toEqual([]);
  });
});

describe('cgp: callback routing', () => {
  test('owner tap in the owner chat routes to chatgpt-callback with the opaque ref only', () => {
    const r = stepUpdates([cbUpdate('cgp:ref0000000000000001', OWNER, OWNER)], opts());
    expect(r.actions).toEqual([expect.objectContaining({ kind: 'chatgpt-callback', callbackQueryId: 'cbq1', data: 'cgp:ref0000000000000001', chatId: OWNER, messageId: 9 })]);
  });
  test('a sender outside the allowlist is "not allowed"', () => {
    const r = stepUpdates([cbUpdate('cgp:ref0000000000000001', 777, OWNER)], opts());
    expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cbq1', text: 'not allowed' }]);
  });
  test('an allowed sender tapping a button that sits in another chat is "not allowed"', () => {
    const r = stepUpdates([cbUpdate('cgp:ref0000000000000001', OWNER, -4242)], opts());
    expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cbq1', text: 'not allowed' }]);
  });
  test('an extra allowed sender (not the owner user) is refused even in the owner chat', () => {
    const o = opts({ cfg: { ...DEFAULT_CONTROL, allowedSenders: [31] } });
    const r = stepUpdates([cbUpdate('cgp:ref0000000000000001', 31, OWNER)], o);
    expect(r.actions[0]).toMatchObject({ kind: 'answer-callback', text: 'not allowed' });
  });
  test('no configured owner fails closed', () => {
    for (const chatId of [0, Number.NaN]) {
      const r = stepUpdates([cbUpdate('cgp:ref0000000000000001', chatId, chatId)], opts({ chatId }));
      expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cbq1', text: 'not allowed' }]);
    }
  });
  test('a callback with no message (inline) is "not allowed"', () => {
    const u = cbUpdate('cgp:ref0000000000000001', OWNER, OWNER);
    delete (u.callback_query as { message?: unknown }).message;
    expect(stepUpdates([u], opts()).actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cbq1', text: 'not allowed' }]);
  });
});
