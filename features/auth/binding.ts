// --- tg auth chat binding (docs/specs/tg-auth.md §3–§4) ---
//
// The one-time `/start <nonce>` proof: nonce + deep link, the pending file the
// running daemon reads (`<configDir>/tg-ctl.<botId>.auth-pending.json`), and the
// acceptance rules shared by tg auth's own poll and the daemon's claim. Pure:
// randomness arrives as bytes, time as a number; sha256 is computation, not I/O.
import { createHash } from 'node:crypto';

export const NONCE_BYTES = 24;
const START_RE = /^\/start ([A-Za-z0-9_-]{32})$/;

/** A Telegram chat as getChat / a message carries it (the fields tg auth shows). */
export interface AuthChat {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** The slice of a getUpdates update binding needs. */
export interface AuthUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; chat: AuthChat; from?: { id: number; first_name?: string; username?: string } };
}

interface PendingBase {
  v: 1;
  nonceHash: string;
  expiresAt: number; // epoch ms
}
export type PendingWaiting = PendingBase & { status: 'waiting' };
export type PendingAuth =
  | PendingWaiting
  | (PendingBase & { status: 'bound'; chat: AuthChat; boundAt: number })
  | (PendingBase & { status: 'failed'; error: string });

/** 24 random bytes → a 32-char base64url start payload (Telegram allows [A-Za-z0-9_-], ≤ 64). */
export function newNonce(bytes: Uint8Array): string {
  if (bytes.length !== NONCE_BYTES) throw new Error(`nonce needs ${NONCE_BYTES} random bytes, got ${bytes.length}`);
  return Buffer.from(bytes).toString('base64url');
}

export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export function startLink(botUsername: string, nonce: string): string {
  return `https://t.me/${botUsername}?start=${nonce}`;
}

export function waitingPending(nonce: string, expiresAt: number): PendingWaiting {
  return { v: 1, nonceHash: nonceHash(nonce), expiresAt, status: 'waiting' };
}

export function markAuthBound(p: PendingAuth, chat: AuthChat, boundAt: number): PendingAuth {
  return { v: 1, nonceHash: p.nonceHash, expiresAt: p.expiresAt, status: 'bound', chat, boundAt };
}

export function markAuthFailed(p: PendingAuth, error: string): PendingAuth {
  return { v: 1, nonceHash: p.nonceHash, expiresAt: p.expiresAt, status: 'failed', error };
}

export function serializePending(p: PendingAuth): string {
  return `${JSON.stringify(p)}\n`;
}

/** A Bot API chat object → AuthChat, or null when it has no numeric id. */
export function parseChat(raw: unknown): AuthChat | null {
  if (typeof raw !== 'object' || raw === null || !('id' in raw) || typeof raw.id !== 'number') return null;
  const chat: AuthChat = { id: raw.id };
  for (const key of ['type', 'title', 'first_name', 'last_name', 'username'] as const) {
    const value: unknown = key in raw ? Reflect.get(raw, key) : undefined;
    if (typeof value === 'string') chat[key] = value;
  }
  return chat;
}

/** A getUpdates `result` → the updates binding can read; malformed entries keep only their id. */
export function parseUpdates(raw: unknown): AuthUpdate[] {
  if (!Array.isArray(raw)) return [];
  const updates: AuthUpdate[] = [];
  for (const u of raw) {
    if (typeof u !== 'object' || u === null || !('update_id' in u) || typeof u.update_id !== 'number') continue;
    const m: unknown = 'message' in u ? u.message : undefined;
    const chat = typeof m === 'object' && m !== null && 'chat' in m ? parseChat(m.chat) : null;
    if (typeof m !== 'object' || m === null || !chat || !('message_id' in m) || typeof m.message_id !== 'number') {
      updates.push({ update_id: u.update_id });
      continue;
    }
    const text = 'text' in m && typeof m.text === 'string' ? m.text : undefined;
    updates.push({ update_id: u.update_id, message: { message_id: m.message_id, text, chat } });
  }
  return updates;
}

/** Pending-file content → record; anything malformed or from another version → null (ignored). */
export function parsePending(raw: string | null): PendingAuth | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  if (!('v' in data) || data.v !== 1) return null;
  if (!('nonceHash' in data) || typeof data.nonceHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.nonceHash)) return null;
  if (!('expiresAt' in data) || typeof data.expiresAt !== 'number') return null;
  if (!('status' in data)) return null;
  const base = { v: 1 as const, nonceHash: data.nonceHash, expiresAt: data.expiresAt };
  if (data.status === 'waiting') return { ...base, status: 'waiting' };
  if (data.status === 'failed') {
    return 'error' in data && typeof data.error === 'string' ? { ...base, status: 'failed', error: data.error } : null;
  }
  if (data.status === 'bound') {
    const chat = 'chat' in data ? parseChat(data.chat) : null;
    const boundAt = 'boundAt' in data && typeof data.boundAt === 'number' ? data.boundAt : null;
    return chat && boundAt !== null ? { ...base, status: 'bound', chat, boundAt } : null;
  }
  return null;
}

/**
 * The first update that proves control (§3.7): text exactly `/start <nonce>`, a
 * PRIVATE chat, a still-waiting unexpired pending record whose hash matches.
 */
export function matchStart(updates: readonly AuthUpdate[], pending: PendingAuth | null, nowMs: number): { update: AuthUpdate; chat: AuthChat } | null {
  if (pending?.status !== 'waiting' || nowMs > pending.expiresAt) return null;
  for (const u of updates) {
    const m = u.message;
    const payload = m?.text?.match(START_RE)?.[1];
    if (!m || !payload || m.chat.type !== 'private') continue;
    if (nonceHash(payload) !== pending.nonceHash) continue;
    return { update: u, chat: m.chat };
  }
  return null;
}

/**
 * The daemon's per-batch step (§4): a claim when the batch carries the live
 * nonce, and the update ids to keep out of routing — every nonce-shaped
 * deep-link `/start`, claimed or stale, so a Start tap never reaches a pane.
 * `readPending` runs only when the batch holds such a `/start`.
 */
export function daemonAuthStep(
  updates: readonly AuthUpdate[],
  readPending: () => string | null,
  nowMs: number,
): { claim: { chat: AuthChat; pending: PendingAuth } | null; drop: Set<number> } {
  const drop = new Set<number>();
  for (const u of updates) {
    if (u.message?.text && START_RE.test(u.message.text)) drop.add(u.update_id);
  }
  if (drop.size === 0) return { claim: null, drop };
  const pending = parsePending(readPending());
  const hit = matchStart(updates, pending, nowMs);
  return { claim: hit && pending ? { chat: hit.chat, pending } : null, drop };
}
