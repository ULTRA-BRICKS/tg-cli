// Inbound album hold (tg-cli#280). PURE — the daemon owns the clock, the journal file and the
// poll loop.
//
// Telegram sends an album (photos or files picked together, the caption typed once) as one
// message per item sharing a `media_group_id`, and the items land in one getUpdates batch or
// across consecutive ones. stepUpdates bundles the items it sees together into ONE delivery,
// so the daemon must not step an album until every item is in hand: it holds album items
// here and releases an album when
//   (a) a later message from the same chat that is not part of it arrives — a client sends an
//       album's items back to back, so that message proves the album complete, and the album
//       is stepped before it to keep the order the CTO sent them in; or
//   (b) the quiet window passed since its last item arrived.
// Held albums are journaled (CtlPaths.pendingAlbums) so a restart neither loses nor splits
// one; the delivery ledger keeps a replayed album from going out twice.

import { isRecord } from './guards';
import type { TgMessage, TgUpdate } from './types';
import { isAlbumItem } from './updates';

export const ALBUM_QUIET_MS = 1500;

export interface HeldAlbum {
  chat: number;
  groupId: string; // media_group_id
  updates: TgUpdate[]; // update_id order
  lastPartAtMs: number; // when the newest item arrived (daemon clock)
}

export interface AlbumStep {
  held: HeldAlbum[]; // still waiting for more items
  released: HeldAlbum[]; // complete: stepped now
  ready: TgUpdate[]; // what to step now — the batch's other updates plus released albums, update_id order
}

const byUpdateId = (a: TgUpdate, b: TgUpdate): number => a.update_id - b.update_id;

// `isOwner`: the daemon's sender + chat allowlist — a stranger's album is never held or
// journaled; it passes straight to stepUpdates, which drops it.
export function holdAlbumParts(
  held: HeldAlbum[],
  updates: TgUpdate[],
  nowMs: number,
  quietMs = ALBUM_QUIET_MS,
  isOwner: (m: TgMessage) => boolean = () => true,
): AlbumStep {
  const albums = held.map((a) => ({ ...a, updates: [...a.updates] }));
  const others: TgUpdate[] = [];
  for (const u of updates) {
    // Only what stepUpdates bundles is held (isAlbumItem): photos and documents.
    const m = u.message;
    if (!m || !isAlbumItem(m) || !isOwner(m)) {
      others.push(u);
      continue;
    }
    let album = albums.find((a) => a.chat === m.chat.id && a.groupId === m.media_group_id);
    if (!album) {
      album = { chat: m.chat.id, groupId: m.media_group_id, updates: [], lastPartAtMs: nowMs };
      albums.push(album);
    }
    // A redelivered item (Telegram, or the pending-batch journal) is already held.
    if (album.updates.some((p) => p.update_id === u.update_id)) continue;
    album.updates.push(u);
    album.updates.sort(byUpdateId);
    album.lastPartAtMs = nowMs;
  }

  // Any later message of the chat that is not an item of this album — a video item of the
  // same album is neither held nor a sign the album ended.
  const closedBy = (album: HeldAlbum): boolean => {
    const last = album.updates[album.updates.length - 1].update_id;
    return updates.some((u) => u.update_id > last && u.message?.chat.id === album.chat && u.message.media_group_id !== album.groupId);
  };
  const keep: HeldAlbum[] = [];
  const released: HeldAlbum[] = [];
  for (const album of albums) {
    if (nowMs - album.lastPartAtMs >= quietMs || closedBy(album)) released.push(album);
    else keep.push(album);
  }
  return { held: keep, released, ready: [...others, ...released.flatMap((a) => a.updates)].sort(byUpdateId) };
}

// How long until the earliest held album is due (0 = due now); null when nothing is held.
export function albumWaitMs(held: HeldAlbum[], nowMs: number, quietMs = ALBUM_QUIET_MS): number | null {
  if (held.length === 0) return null;
  return Math.max(0, Math.min(...held.map((a) => a.lastPartAtMs + quietMs - nowMs)));
}

// At startup: an album whose every update the ledger already recorded `processed` was fully
// handled before the restart (a kill landed before its journal entry was removed).
export function dropProcessedAlbums(held: HeldAlbum[], processedUpdates: ReadonlySet<number>): HeldAlbum[] {
  return held.filter((a) => !a.updates.every((u) => processedUpdates.has(u.update_id)));
}

export function serializeHeldAlbums(held: HeldAlbum[]): string {
  return `${JSON.stringify(held)}\n`;
}

// A missing, torn or foreign journal holds nothing; a malformed entry is skipped.
export function parseHeldAlbums(content: string | null): HeldAlbum[] {
  if (content === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: HeldAlbum[] = [];
  for (const a of parsed) {
    if (!isRecord(a) || typeof a.chat !== 'number' || typeof a.groupId !== 'string' || typeof a.lastPartAtMs !== 'number') continue;
    if (!Array.isArray(a.updates) || a.updates.length === 0) continue;
    const updates = a.updates.filter((u): u is TgUpdate => isRecord(u) && typeof u.update_id === 'number' && isRecord(u.message));
    if (updates.length !== a.updates.length) continue;
    out.push({ chat: a.chat, groupId: a.groupId, updates, lastPartAtMs: a.lastPartAtMs });
  }
  return out;
}
