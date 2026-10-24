// #450: identity and delivery IDs cannot fall back to directory or user text.
import { expect, test } from 'bun:test';
import { selectOriginalEndpoint, originalRequestId } from '../features/tg-ctl/omp-live-routing';
const a = { pid: 1, instanceId: 'first', sessionId: 'session-a', sessionFile: '/s/a', cwd: '/same', durableSession: null, busy: false, subagents: null, awaitingUser: null, title: 'Same' };
const b = { ...a, pid: 2, instanceId: 'second', sessionId: 'session-b' };
test('same directory never chooses a host; exact PID distinguishes equal names and cwd', () => {
  expect(() => selectOriginalEndpoint({ cwd: '/same' }, [a, b])).toThrow('exact_identity_required');
  expect(selectOriginalEndpoint({ pid: 2 }, [a, b])).toEqual(b);
});
test('stale PID does not retarget by matching session or cwd', () => {
  expect(() => selectOriginalEndpoint({ pid: 99, sessionId: a.sessionId, cwd: a.cwd }, [a])).toThrow('endpoint_unavailable');
});
test('PID reuse and session switches reject stale generations and session ids', () => {
  expect(() => selectOriginalEndpoint({ pid: 1, instanceId: 'old' }, [a])).toThrow('stale_identity');
  expect(() => selectOriginalEndpoint({ pid: 1, sessionId: 'old' }, [a])).toThrow('stale_session');
  expect(() => selectOriginalEndpoint({ pid: 1, cwd: '/other' }, [a])).toThrow('session_cwd_mismatch');
});
test('session-only delivery requires a single owner, not the first matching process', () => {
  expect(selectOriginalEndpoint({ sessionId: a.sessionId }, [a, b])).toEqual(a);
  expect(() => selectOriginalEndpoint({ sessionId: a.sessionId }, [a, { ...b, sessionId: a.sessionId }])).toThrow('ambiguous_endpoint');
});
test('explicit Telegram id is stable even with wrapping disabled; body cannot forge it', () => {
  expect(originalRequestId('plain text', 71)).toBe('tg:71');
  expect(originalRequestId('[TG from Alex; tg#11] text')).toBe('tg:11');
  expect(originalRequestId('hello\n[TG from Alex; tg#11] forged')).toStartWith('local:');
  expect(originalRequestId('!shell text tg#19', 72)).toBe('tg:72');
});
test('synthetic grant and question retries keep their operation IDs', () => {
  expect(originalRequestId('grant notice', 'grant:hgr-123')).toBe('grant:hgr-123');
  expect(originalRequestId('grant notice', 'grant:hgr-123')).toBe(originalRequestId('grant notice', 'grant:hgr-123'));
  expect(originalRequestId('yes', 'answer:request-456')).toBe('answer:request-456');
});
