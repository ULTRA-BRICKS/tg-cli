// Reader for the persisted alert-throttle receipts (tg-cli#817 decomposition of
// alert-subscriptions.ts). Every record is validated field by field: an invalid or
// non-finite field drops that record only, never the store, and an unresolved internal
// receipt is kept past the ordinary retention window because its delivery identity
// (text, recipients, generation pins) must survive a restart.

import { isRecord } from '../guards';
import type { AlertThrottleEntry, AlertThrottleStore, InternalAlertAttempt } from '../alert-subscriptions';
import { HOLDER_TEXT_MAX_BYTES, THROTTLE_RETAIN_MS, isMs, isPositiveInt, parseEnvelope, validSessionId } from './alert-primitives';

export function unresolvedInternalReceipt(entry: AlertThrottleEntry): boolean {
  if (entry.messageId !== 0 || !entry.key.startsWith('internal:') || entry.internalText === undefined) return false;
  if (entry.pending.length > 0 || entry.internalAttempts === undefined) return true;
  // A withdrawn recipient may still have accepted its in-flight request. Withdrawal
  // is not an acknowledgement; keep its generation pin if it later subscribes again.
  return entry.internalAttempts.some((attempt) => !entry.internalRecipients?.includes(attempt.sessionId));
}

const stringItems = (v: unknown[]): string[] => v.filter((s): s is string => typeof s === 'string');
const INSTANCE_ID_RE = /^[a-f0-9]{32}$/;

function validAttempt(attempt: unknown): attempt is InternalAlertAttempt {
  return isRecord(attempt) && validSessionId(attempt.sessionId) && isPositiveInt(attempt.pid)
    && typeof attempt.instanceId === 'string' && INSTANCE_ID_RE.test(attempt.instanceId);
}

// All-or-nothing: one malformed or duplicate-session attempt discards the whole pin list.
function parseInternalAttempts(raw: unknown): InternalAlertAttempt[] | undefined {
  if (!Array.isArray(raw) || !raw.every(validAttempt)) return undefined;
  if (new Set(raw.map((attempt) => attempt.sessionId)).size !== raw.length) return undefined;
  return raw.map((a) => ({ sessionId: a.sessionId, pid: a.pid, instanceId: a.instanceId }));
}

// A claim in flight has a null id; a holder-only or internal receipt carries id 0; any
// other record must hold a real Telegram message id.
function messageIdAllowed(raw: Record<string, unknown> & { key: string }, internal: boolean): boolean {
  if (raw.messageId === null || isPositiveInt(raw.messageId) || internal) return true;
  return raw.messageId === 0 && raw.key.startsWith('holder:');
}

function isInternalReceipt(raw: Record<string, unknown> & { key: string }): boolean {
  return raw.messageId === 0 && raw.key.startsWith('internal:') && typeof raw.internalText === 'string'
    && raw.internalText.length > 0 && Buffer.byteLength(raw.internalText) <= HOLDER_TEXT_MAX_BYTES;
}

function parseThrottleEntry(raw: unknown): AlertThrottleEntry | null {
  if (!isRecord(raw) || typeof raw.key !== 'string' || !isMs(raw.at)) return null;
  const keyed = raw as Record<string, unknown> & { key: string };
  const internal = isInternalReceipt(keyed);
  if (!messageIdAllowed(keyed, internal)) return null;
  const pending = Array.isArray(raw.pending) ? stringItems(raw.pending) : [];
  if (!internal) return { key: keyed.key, at: raw.at, messageId: raw.messageId as number | null, pending };
  const attempts = parseInternalAttempts(raw.internalAttempts);
  return {
    key: keyed.key, at: raw.at, messageId: raw.messageId as number | null, pending,
    internalText: raw.internalText as string,
    internalRecipients: Array.isArray(raw.internalRecipients) ? stringItems(raw.internalRecipients) : pending,
    ...(attempts ? { internalAttempts: attempts } : {}),
  };
}

export function parseAlertThrottle(blob: string | null, now: number): AlertThrottleStore {
  const sent: AlertThrottleEntry[] = [];
  for (const raw of (parseEnvelope(blob, 'sent')?.sent as unknown[] | undefined) ?? []) {
    const entry = parseThrottleEntry(raw);
    if (entry && (unresolvedInternalReceipt(entry) || now - entry.at < THROTTLE_RETAIN_MS)) sent.push(entry);
  }
  return { sent };
}
