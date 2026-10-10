import { describe, expect, test } from 'bun:test';
import {
  daemonAuthStep,
  markAuthBound,
  markAuthFailed,
  matchStart,
  newNonce,
  nonceHash,
  parsePending,
  serializePending,
  startLink,
  waitingPending,
  type AuthUpdate,
} from '../features/auth/binding';
import { ctlPaths } from '../features/tg-ctl/lock';

// docs/specs/tg-auth.md §3–§4: the one-time /start nonce, the pending file the
// daemon reads, and the exact acceptance rules.

const BYTES = Uint8Array.from({ length: 24 }, (_, i) => i * 7 + 3);
const NONCE = newNonce(BYTES);
const NOW = 1_800_000_000_000;

function startUpdate(id: number, text: string, chat: Partial<{ id: number; type: string; first_name: string; username: string; title: string }> = {}): AuthUpdate {
  return {
    update_id: id,
    message: {
      message_id: id * 10,
      text,
      chat: { id: 42, type: 'private', first_name: 'Alex', username: 'alex', ...chat },
      from: { id: chat.id ?? 42, first_name: 'Alex' },
    },
  };
}

describe('nonce + link', () => {
  test('newNonce is 32 base64url chars from the injected bytes (deterministic)', () => {
    expect(NONCE).toHaveLength(32);
    expect(NONCE).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newNonce(BYTES)).toBe(NONCE);
  });

  test('newNonce rejects a wrong byte count', () => {
    expect(() => newNonce(new Uint8Array(8))).toThrow();
  });

  test('only a 32-char base64url payload is a tg auth start (dropped from routing)', () => {
    const step = daemonAuthStep(
      [startUpdate(1, `/start ${NONCE}x`), startUpdate(2, `/start ${NONCE.slice(0, 31)}!`), startUpdate(3, '/start abc'), startUpdate(4, `/start ${NONCE}`)],
      () => null,
      NOW,
    );
    expect([...step.drop]).toEqual([4]);
  });

  test('startLink is a t.me bot deep link carrying the nonce', () => {
    expect(startLink('my_bot', NONCE)).toBe(`https://t.me/my_bot?start=${NONCE}`);
  });

  test('nonceHash is sha256 hex and never the nonce itself', () => {
    const h = nonceHash(NONCE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(NONCE);
  });
});

describe('pending file', () => {
  test('waiting pending round-trips and stores only the hash', () => {
    const p = waitingPending(NONCE, NOW + 60_000);
    const raw = serializePending(p);
    expect(raw).not.toContain(NONCE);
    expect(parsePending(raw)).toEqual(p);
  });

  test('malformed / foreign / missing content parses to null', () => {
    expect(parsePending(null)).toBeNull();
    expect(parsePending('not json')).toBeNull();
    expect(parsePending('{"v":2,"status":"waiting"}')).toBeNull();
    expect(parsePending('{"v":1,"status":"waiting","nonceHash":"x"}')).toBeNull();
  });

  test('bound and failed records round-trip', () => {
    const w = waitingPending(NONCE, NOW + 1);
    const b = markAuthBound(w, { id: 42, type: 'private', first_name: 'Alex' }, NOW);
    expect(parsePending(serializePending(b))).toEqual(b);
    const f = markAuthFailed(w, 'disk full');
    expect(parsePending(serializePending(f))).toEqual(f);
  });

  test('ctlPaths carries the per-bot pending path', () => {
    expect(ctlPaths('/cfg', '123').authPending).toBe('/cfg/tg-ctl.123.auth-pending.json');
  });
});

describe('matchStart', () => {
  const pending = waitingPending(NONCE, NOW + 60_000);

  test('accepts exactly `/start <nonce>` from a private chat', () => {
    const hit = matchStart([startUpdate(1, 'hello'), startUpdate(2, `/start ${NONCE}`)], pending, NOW);
    expect(hit?.update.update_id).toBe(2);
    expect(hit?.chat).toEqual({ id: 42, type: 'private', first_name: 'Alex', username: 'alex' });
  });

  test('a wrong nonce, a group chat, or extra text is ignored', () => {
    const other = newNonce(new Uint8Array(24));
    expect(matchStart([startUpdate(1, `/start ${other}`)], pending, NOW)).toBeNull();
    expect(matchStart([startUpdate(1, `/start ${NONCE}`, { id: -100, type: 'group', title: 'g' })], pending, NOW)).toBeNull();
    expect(matchStart([startUpdate(1, `/start ${NONCE} now`)], pending, NOW)).toBeNull();
    expect(matchStart([startUpdate(1, `/start  ${NONCE}`)], pending, NOW)).toBeNull();
    expect(matchStart([startUpdate(1, `/start${NONCE}`)], pending, NOW)).toBeNull();
  });

  test('a chat with no type is not trusted as private', () => {
    const u: AuthUpdate = { update_id: 1, message: { message_id: 10, text: `/start ${NONCE}`, chat: { id: 42 } } };
    expect(matchStart([u], pending, NOW)).toBeNull();
  });

  test('expired, already bound, or absent pending never matches', () => {
    expect(matchStart([startUpdate(1, `/start ${NONCE}`)], pending, NOW + 60_001)).toBeNull();
    expect(matchStart([startUpdate(1, `/start ${NONCE}`)], markAuthBound(pending, { id: 1, type: 'private' }, NOW), NOW)).toBeNull();
    expect(matchStart([startUpdate(1, `/start ${NONCE}`)], null, NOW)).toBeNull();
  });
});

describe('daemonAuthStep', () => {
  const raw = serializePending(waitingPending(NONCE, NOW + 60_000));

  test('claims the matching update and drops it from routing', () => {
    const step = daemonAuthStep([startUpdate(5, 'hi'), startUpdate(6, `/start ${NONCE}`)], () => raw, NOW);
    expect(step.claim?.chat.id).toBe(42);
    expect(step.claim?.pending.status).toBe('waiting');
    expect([...step.drop]).toEqual([6]);
  });

  test('drops every nonce-shaped deep-link start even with no pending binding (a stale tap never reaches a pane)', () => {
    const stale = newNonce(new Uint8Array(24).fill(9));
    const step = daemonAuthStep([startUpdate(7, `/start ${stale}`), startUpdate(8, '/start'), startUpdate(9, '/start the build')], () => null, NOW);
    expect(step.claim).toBeNull();
    expect([...step.drop]).toEqual([7]);
  });

  test('a bound pending file is not claimed twice (journal replay)', () => {
    const bound = serializePending(markAuthBound(waitingPending(NONCE, NOW + 60_000), { id: 42, type: 'private' }, NOW));
    const step = daemonAuthStep([startUpdate(6, `/start ${NONCE}`)], () => bound, NOW);
    expect(step.claim).toBeNull();
    expect([...step.drop]).toEqual([6]);
  });
});
