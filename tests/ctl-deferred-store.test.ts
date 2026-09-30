// Unit tests for the durable defer-while-waiting queue store
// (features/tg-ctl/deferred-store.ts).
//
// Why this exists: the daemon holds the defer-while-waiting backlog (inbound
// Telegram messages queued behind an agent's open question) ONLY in memory. A
// daemon restart — a deliberate `tg-ctl restart`, a launchd bootout/bootstrap
// reload, or a crash-relaunch — silently dropped that backlog, so the human's
// queued messages vanished and had to be resent. Persisting the backlog (keyed
// by pane, like the questions store) lets a restored daemon flush it once the
// pane's restored question is answered, so a graceful reload loses nothing.
//
// This module owns ONLY the on-disk FORMAT (versioned envelope, per-pane record
// validation, count cap). The daemon owns the file I/O and the DeferQueues it
// snapshots/restores.

import { describe, expect, test } from 'bun:test';
import {
  serializeDeferredStore,
  parseDeferredStore,
  MAX_DEFERRED_PANES,
  type DeferredStoreData,
} from '../features/tg-ctl/deferred-store';

describe('deferred-store round-trip', () => {
  test('serialize→parse preserves per-pane FIFO items', () => {
    const data: DeferredStoreData = {
      panes: [
        {
          paneId: '%1',
          items: [
            { text: 'first', sourceMessageId: 11, relatedReactionMessageId: null },
            { text: 'second', sourceMessageId: 12, relatedReactionMessageId: 99, sessionKey: 'omp:s1' },
          ],
        },
        { paneId: '%2', items: [{ text: 'other', sourceMessageId: null, relatedReactionMessageId: null }] },
      ],
    };
    const restored = parseDeferredStore(serializeDeferredStore(data));
    expect(restored).toEqual(data);
  });

  test('an empty store round-trips to empty', () => {
    expect(parseDeferredStore(serializeDeferredStore({ panes: [] }))).toEqual({ panes: [] });
  });
});

describe('deferred-store fail-closed parsing', () => {
  test('null / empty raw → empty (no throw)', () => {
    expect(parseDeferredStore(null)).toEqual({ panes: [] });
    expect(parseDeferredStore('')).toEqual({ panes: [] });
  });

  test('malformed JSON → empty (never throws)', () => {
    expect(parseDeferredStore('{not json')).toEqual({ panes: [] });
  });

  test('unknown format version → empty (forward-compat guard)', () => {
    const raw = JSON.stringify({ v: 999, panes: [{ paneId: '%1', items: [] }] });
    expect(parseDeferredStore(raw)).toEqual({ panes: [] });
  });

  test('a pane with a non-string text item is dropped, valid items kept', () => {
    const raw = JSON.stringify({
      v: 1,
      panes: [
        {
          paneId: '%1',
          items: [
            { text: 42, sourceMessageId: 1, relatedReactionMessageId: null },
            { text: 'ok', sourceMessageId: 2, relatedReactionMessageId: null },
          ],
        },
      ],
    });
    const restored = parseDeferredStore(raw);
    expect(restored.panes).toEqual([
      { paneId: '%1', items: [{ text: 'ok', sourceMessageId: 2, relatedReactionMessageId: null }] },
    ]);
  });

  test('a pane whose id is not a string is dropped entirely', () => {
    const raw = JSON.stringify({
      v: 1,
      panes: [{ paneId: 7, items: [{ text: 'x', sourceMessageId: null, relatedReactionMessageId: null }] }],
    });
    expect(parseDeferredStore(raw)).toEqual({ panes: [] });
  });

  test('a pane that ends up with no valid items is omitted (no empty backlog)', () => {
    const raw = JSON.stringify({
      v: 1,
      panes: [{ paneId: '%1', items: [{ text: 42 }] }],
    });
    expect(parseDeferredStore(raw)).toEqual({ panes: [] });
  });

  test('a non-numeric sourceMessageId coerces to null (kept, not dropped)', () => {
    const raw = JSON.stringify({
      v: 1,
      panes: [{ paneId: '%1', items: [{ text: 'x', sourceMessageId: 'nope', relatedReactionMessageId: 'nope' }] }],
    });
    expect(parseDeferredStore(raw)).toEqual({
      panes: [{ paneId: '%1', items: [{ text: 'x', sourceMessageId: null, relatedReactionMessageId: null }] }],
    });
  });
});

describe('deferred-store durable-field contract (daemon glue)', () => {
  // The daemon's DeferredInbound carries a RUNTIME-only `delivered` flag that must
  // never round-trip through the store: on restore the entrypoint re-creates each
  // item with `delivered: false`. Prove the store is the authority on the shape —
  // an item raw JSON carrying `delivered` (or any extra field) parses to EXACTLY
  // the three durable fields, so the flag can never leak back across a reload.
  test('parse strips any extra field (e.g. the runtime delivered flag)', () => {
    const raw = JSON.stringify({
      v: 1,
      panes: [
        {
          paneId: '%1',
          items: [
            { text: 'x', sourceMessageId: 7, relatedReactionMessageId: null, delivered: true, junk: 1 },
          ],
        },
      ],
    });
    const restored = parseDeferredStore(raw);
    expect(restored.panes).toEqual([
      { paneId: '%1', items: [{ text: 'x', sourceMessageId: 7, relatedReactionMessageId: null }] },
    ]);
    // exactly the three durable keys — nothing carried over
    expect(Object.keys(restored.panes[0].items[0]).sort()).toEqual([
      'relatedReactionMessageId',
      'sourceMessageId',
      'text',
    ]);
  });

  // Mirrors the daemon's persist→restore mapping: DeferredInbound[] (with
  // delivered) → store items (delivered dropped) → serialize → parse → the daemon
  // re-adds delivered:false. Locks that the two well-tested halves compose losslessly
  // over the durable fields.
  test('a DeferredInbound-shaped payload survives the full persist/restore mapping', () => {
    const live = [
      { text: 'alpha', sourceMessageId: 1, relatedReactionMessageId: 5, delivered: false },
      { text: 'beta', sourceMessageId: null, relatedReactionMessageId: null, delivered: true },
    ];
    // persistDeferred's mapping: drop `delivered`
    const stored = serializeDeferredStore({
      panes: [
        {
          paneId: '%9',
          items: live.map((i) => ({
            text: i.text,
            sourceMessageId: i.sourceMessageId,
            relatedReactionMessageId: i.relatedReactionMessageId,
          })),
        },
      ],
    });
    // restore's mapping: re-add delivered:false
    const parsed = parseDeferredStore(stored);
    const rebuilt = parsed.panes[0].items.map((i) => ({ ...i, delivered: false }));
    expect(rebuilt).toEqual([
      { text: 'alpha', sourceMessageId: 1, relatedReactionMessageId: 5, delivered: false },
      { text: 'beta', sourceMessageId: null, relatedReactionMessageId: null, delivered: false },
    ]);
  });
});

describe('deferred-store pane cap', () => {
  test('serialize caps the number of panes to MAX_DEFERRED_PANES', () => {
    const panes = Array.from({ length: MAX_DEFERRED_PANES + 25 }, (_, i) => ({
      paneId: `%${i}`,
      items: [{ text: `t${i}`, sourceMessageId: i, relatedReactionMessageId: null }],
    }));
    const restored = parseDeferredStore(serializeDeferredStore({ panes }));
    expect(restored.panes.length).toBe(MAX_DEFERRED_PANES);
  });
});
