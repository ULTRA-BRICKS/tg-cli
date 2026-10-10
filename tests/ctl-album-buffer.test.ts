// Unit tests for the inbound album hold (features/tg-ctl/album-buffer.ts, tg-cli#280).
//
// Telegram sends an album as one message per item sharing a media_group_id, in one
// getUpdates batch or across consecutive ones. The daemon holds the items until the album
// is complete, then steps them together so stepUpdates emits ONE delivery.

import { describe, expect, test } from 'bun:test';
import {
  ALBUM_QUIET_MS,
  albumWaitMs,
  dropProcessedAlbums,
  holdAlbumParts,
  parseHeldAlbums,
  serializeHeldAlbums,
  type HeldAlbum,
} from '../features/tg-ctl/album-buffer';
import type { TgMessage, TgUpdate } from '../features/tg-ctl/types';

const CHAT = 1000;

function upd(id: number, msg: Partial<TgMessage> = {}, chat = CHAT): TgUpdate {
  return { update_id: id, message: { message_id: id, from: { id: CHAT, first_name: 'Alex' }, chat: { id: chat }, date: 1, ...msg } };
}

const photo = (id: number, group: string, extra: Partial<TgMessage> = {}, chat = CHAT): TgUpdate =>
  upd(id, { photo: [{ file_id: `p${id}`, file_size: 10 }], media_group_id: group, ...extra }, chat);

const ids = (us: TgUpdate[]): number[] => us.map((u) => u.update_id);

describe('holdAlbumParts', () => {
  test('a batch with no album passes through untouched, in update order', () => {
    const r = holdAlbumParts([], [upd(3, { text: 'b' }), upd(2, { text: 'a' })], 0);
    expect(ids(r.ready)).toEqual([2, 3]);
    expect(r.held).toEqual([]);
    expect(r.released).toEqual([]);
  });

  test('album items are held, not stepped, while the album may still grow', () => {
    const r = holdAlbumParts([], [photo(10, 'g1', { caption: 'look' }), photo(11, 'g1')], 5_000);
    expect(r.ready).toEqual([]);
    expect(r.held).toHaveLength(1);
    expect(ids(r.held[0].updates)).toEqual([10, 11]);
    expect(r.held[0].lastPartAtMs).toBe(5_000);
  });

  test('items of one album across two batches join one hold; the quiet window restarts per item', () => {
    const first = holdAlbumParts([], [photo(10, 'g1')], 1_000);
    const second = holdAlbumParts(first.held, [photo(11, 'g1'), photo(12, 'g1')], 1_600);
    expect(second.ready).toEqual([]);
    expect(second.held).toHaveLength(1);
    expect(ids(second.held[0].updates)).toEqual([10, 11, 12]);
    expect(second.held[0].lastPartAtMs).toBe(1_600);
  });

  test('the album is released whole once the quiet window passed since its last item', () => {
    const held = holdAlbumParts([], [photo(10, 'g1'), photo(11, 'g1')], 1_000).held;
    expect(holdAlbumParts(held, [], 1_000 + ALBUM_QUIET_MS - 1).ready).toEqual([]);
    const r = holdAlbumParts(held, [], 1_000 + ALBUM_QUIET_MS);
    expect(ids(r.ready)).toEqual([10, 11]);
    expect(r.held).toEqual([]);
    expect(r.released).toHaveLength(1);
  });

  test('a later message from the same chat proves the album complete and is stepped after it', () => {
    const held = holdAlbumParts([], [photo(10, 'g1'), photo(11, 'g1')], 1_000).held;
    const r = holdAlbumParts(held, [photo(12, 'g1'), upd(13, { text: 'what do you see?' })], 1_100);
    expect(ids(r.ready)).toEqual([10, 11, 12, 13]);
    expect(r.held).toEqual([]);
  });

  test('a second album closes the first; the second keeps waiting', () => {
    const r = holdAlbumParts([], [photo(10, 'g1'), photo(11, 'g1'), photo(12, 'g2')], 1_000);
    expect(ids(r.ready)).toEqual([10, 11]);
    expect(r.held.map((a) => a.groupId)).toEqual(['g2']);
  });

  test('another chat, a button tap or an earlier update does not close an album', () => {
    const held = holdAlbumParts([], [photo(10, 'g1')], 1_000).held;
    const r = holdAlbumParts(
      held,
      [
        upd(9, { text: 'older' }),
        upd(11, { text: 'stranger' }, 77),
        { update_id: 12, callback_query: { id: 'cb', from: { id: CHAT, first_name: 'Alex' }, data: 'x' } },
      ],
      1_100,
    );
    expect(ids(r.ready)).toEqual([9, 11, 12]);
    expect(r.held).toHaveLength(1);
  });

  test('the same media_group_id in two chats is two albums', () => {
    const r = holdAlbumParts([], [photo(10, 'g1'), photo(11, 'g1', {}, 77)], 1_000);
    expect(r.held).toHaveLength(2);
  });

  test("a stranger's album is never held or journaled: it passes through for stepUpdates to drop", () => {
    const r = holdAlbumParts([], [photo(10, 'g1', {}, 77), photo(11, 'g1', {}, 77)], 1_000, ALBUM_QUIET_MS, (m) => m.chat.id === CHAT);
    expect(ids(r.ready)).toEqual([10, 11]);
    expect(r.held).toEqual([]);
  });

  test('a redelivered item is merged by update_id, never held twice', () => {
    const held = holdAlbumParts([], [photo(10, 'g1'), photo(11, 'g1')], 1_000).held;
    const r = holdAlbumParts(held, [photo(11, 'g1')], 1_200);
    expect(ids(r.held[0].updates)).toEqual([10, 11]);
    // A redelivery adds nothing, so it does not extend the quiet window either.
    expect(r.held[0].lastPartAtMs).toBe(1_000);
  });

  test('only photos and documents are held: a video item passes through without ending its album', () => {
    const r = holdAlbumParts([], [photo(10, 'g1'), upd(11, { video: { file_id: 'v' }, media_group_id: 'g1' })], 1_000);
    expect(ids(r.ready)).toEqual([11]);
    expect(ids(r.held[0].updates)).toEqual([10]);
  });

  test('an audio album passes through, note by note', () => {
    const r = holdAlbumParts([], [upd(12, { audio: { file_id: 'a' }, media_group_id: 'g3' }), upd(13, { audio: { file_id: 'b' }, media_group_id: 'g3' })], 1_000);
    expect(ids(r.ready)).toEqual([12, 13]);
    expect(r.held).toEqual([]);
  });

  test('a document album is held like a photo album', () => {
    const r = holdAlbumParts([], [upd(10, { document: { file_id: 'd' }, media_group_id: 'g1' })], 1_000);
    expect(r.held).toHaveLength(1);
  });
});

describe('albumWaitMs', () => {
  test('null with nothing held; else the time left until the earliest album is due, never negative', () => {
    expect(albumWaitMs([], 0)).toBeNull();
    const held = [...holdAlbumParts([], [photo(10, 'g1')], 1_000).held, ...holdAlbumParts([], [photo(20, 'g2')], 1_300).held];
    expect(albumWaitMs(held, 1_200)).toBe(ALBUM_QUIET_MS - 200);
    expect(albumWaitMs(held, 1_000 + ALBUM_QUIET_MS + 50)).toBe(0);
  });
});

describe('album journal', () => {
  test('round-trips through serialize/parse', () => {
    const held = holdAlbumParts([], [photo(10, 'g1', { caption: 'c' }), photo(11, 'g1')], 1_000).held;
    expect(parseHeldAlbums(serializeHeldAlbums(held))).toEqual(held);
  });

  test('a missing, torn or foreign journal holds nothing; a malformed entry is skipped', () => {
    expect(parseHeldAlbums(null)).toEqual([]);
    expect(parseHeldAlbums('{"torn')).toEqual([]);
    expect(parseHeldAlbums('{"a":1}')).toEqual([]);
    const good: HeldAlbum = { chat: CHAT, groupId: 'g1', lastPartAtMs: 5, updates: [photo(10, 'g1')] };
    expect(parseHeldAlbums(JSON.stringify([{ chat: 'x' }, good, { chat: CHAT, groupId: 'g2', lastPartAtMs: 1, updates: [] }]))).toEqual([good]);
  });

  test('an album whose every update was already processed is dropped at restart; a partly processed one is kept', () => {
    const held: HeldAlbum[] = [
      { chat: CHAT, groupId: 'g1', lastPartAtMs: 5, updates: [photo(10, 'g1'), photo(11, 'g1')] },
      { chat: CHAT, groupId: 'g2', lastPartAtMs: 5, updates: [photo(20, 'g2'), photo(21, 'g2')] },
    ];
    expect(dropProcessedAlbums(held, new Set([10, 11, 20])).map((a) => a.groupId)).toEqual(['g2']);
  });
});
