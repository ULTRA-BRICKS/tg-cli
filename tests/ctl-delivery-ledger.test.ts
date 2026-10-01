// Unit tests for the inbound delivery ledger (features/tg-ctl/delivery-ledger.ts,
// tg-cli#299): the single rule every sink applies before sending an inbound
// Telegram message, and the fold of the durable event log that feeds it.

import { describe, expect, test } from 'bun:test';
import {
  applyLedgerEvents,
  decideDelivery,
  emptyLedgerState,
  ledgerKey,
  lostPickerHolds,
  orphanedClaims,
  parseLedger,
  serializeLedgerEvents,
  sinkOutcomeEvent,
  type LedgerEvent,
} from '../features/tg-ctl/delivery-ledger';

const CHAT = 5;

function fold(events: LedgerEvent[]) {
  return applyLedgerEvents(emptyLedgerState(), parseLedger(serializeLedgerEvents(events)));
}

describe('decideDelivery', () => {
  test('a message never seen, or one whose earlier attempt failed, is delivered', () => {
    const state = fold([{ ts: 1, event: 'failed', chat: CHAT, msg: 2, target: '%1', error: 'pane gone' }]);
    expect(decideDelivery(state.messages.get(ledgerKey(CHAT, 1))).kind).toBe('deliver');
    expect(decideDelivery(state.messages.get(ledgerKey(CHAT, 2))).kind).toBe('deliver');
  });

  test('a delivered, in-flight or uncertain message is never sent again', () => {
    const state = fold([
      { ts: 1, event: 'claimed', chat: CHAT, msg: 1, target: '%1' },
      { ts: 2, event: 'delivered', chat: CHAT, msg: 1, target: '%1' },
      { ts: 3, event: 'claimed', chat: CHAT, msg: 2, target: 'omp:9' },
      { ts: 4, event: 'uncertain', chat: CHAT, msg: 3, target: '%2' },
    ]);
    for (const msg of [1, 2, 3]) expect(decideDelivery(state.messages.get(ledgerKey(CHAT, msg))).kind).toBe('suppress');
  });

  test('a held message is released through the same gate', () => {
    const state = fold([{ ts: 1, event: 'queued', chat: CHAT, msg: 1, target: '%1', hold: 'deferred' }]);
    expect(decideDelivery(state.messages.get(ledgerKey(CHAT, 1))).kind).toBe('deliver');
  });

  test('re-queueing a delivered message (a replayed update) keeps it delivered', () => {
    const state = fold([
      { ts: 1, event: 'delivered', chat: CHAT, msg: 1, target: '%1' },
      { ts: 2, event: 'queued', chat: CHAT, msg: 1, target: '%1', hold: 'deferred' },
    ]);
    expect(decideDelivery(state.messages.get(ledgerKey(CHAT, 1))).kind).toBe('suppress');
  });

  test('the same message id in another chat is a different message', () => {
    const state = fold([{ ts: 1, event: 'delivered', chat: CHAT, msg: 1, target: '%1' }]);
    expect(decideDelivery(state.messages.get(ledgerKey(CHAT + 1, 1))).kind).toBe('deliver');
  });
});

describe('restart bookkeeping', () => {
  test('a claim without an outcome is orphaned; one with an outcome is not', () => {
    const state = fold([
      { ts: 1, event: 'claimed', chat: CHAT, msg: 1, target: '%1' },
      { ts: 2, event: 'claimed', chat: CHAT, msg: 2, target: '%1' },
      { ts: 3, event: 'delivered', chat: CHAT, msg: 2, target: '%1' },
    ]);
    expect(orphanedClaims(state)).toEqual([{ chat: CHAT, msg: 1, target: '%1' }]);
  });

  test('only picker holds are lost by a restart', () => {
    const state = fold([
      { ts: 1, event: 'queued', chat: CHAT, msg: 1, target: '%1', hold: 'picker' },
      { ts: 2, event: 'queued', chat: CHAT, msg: 2, target: '%1', hold: 'deferred' },
      { ts: 3, event: 'queued', chat: CHAT, msg: 3, target: 'thread:7', hold: 'topic-hold' },
      { ts: 4, event: 'queued', chat: CHAT, msg: 4, target: '%1', hold: 'picker' },
      { ts: 5, event: 'delivered', chat: CHAT, msg: 4, target: '%2' },
    ]);
    expect(lostPickerHolds(state)).toEqual([{ chat: CHAT, msg: 1, target: '%1' }]);
  });

  test('processed updates are remembered', () => {
    const state = fold([{ ts: 1, event: 'processed', update: 700 }]);
    expect(state.processedUpdates.has(700)).toBe(true);
    expect(state.processedUpdates.has(701)).toBe(false);
  });
});

test('a torn trailing line (a kill mid-append) is skipped, earlier events survive', () => {
  const raw = `${serializeLedgerEvents([{ ts: 1, event: 'delivered', chat: CHAT, msg: 1, target: '%1' }])}{"ts":2,"event":"claim`;
  expect(parseLedger(raw)).toEqual([{ ts: 1, event: 'delivered', chat: CHAT, msg: 1, target: '%1' }]);
});

describe('sinkOutcomeEvent', () => {
  const base = { chat: CHAT, msg: 9, target: 'host:claude-3f9a0c1d2e4b' };

  test('a sink that delivered records delivered; one that proved nothing arrived records failed', () => {
    expect(sinkOutcomeEvent(5, base, { ok: true })).toEqual({ ts: 5, event: 'delivered', ...base });
    expect(sinkOutcomeEvent(5, base, { ok: false, error: 'socket gone' })).toEqual({ ts: 5, event: 'failed', ...base, error: 'socket gone' });
  });

  test('a sink whose bytes may have arrived records uncertain — the message is then never re-sent', () => {
    const ev = sinkOutcomeEvent(5, base, { ok: false, error: 'dropped mid-write', uncertain: true });
    expect(ev).toEqual({ ts: 5, event: 'uncertain', ...base });
    const state = fold([ev]);
    expect(decideDelivery(state.messages.get(ledgerKey(CHAT, 9))).kind).toBe('suppress');
  });
});
