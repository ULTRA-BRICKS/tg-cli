// Shared alert constants and persisted-record guards (tg-cli#817 decomposition of
// alert-subscriptions.ts). Dependency-free so the argv grammar and the throttle-receipt
// reader can use them without importing the store module that re-exports them.

import { isRecord } from '../guards';
import type { AlertSeverity } from '../alert-subscriptions';

export const SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical'];
export const STORE_VERSION = 1;
export const DEFAULT_ALERT_TTL_MS = 12 * 60 * 60_000;
export const DEFAULT_ALERT_WINDOW_MS = 10 * 60_000;
// Ordinary throttle history expires. Unresolved internal delivery identity must not.
export const THROTTLE_RETAIN_MS = 24 * 60 * 60_000;
export const SOURCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const KEY_MAX = 256;
export const TITLE_MAX = 256;
// Telegram splits a long post; the omp-live transport refuses a body over 64 000 bytes, so
// the session copy (head + tail lines + the text) must stay well below that.
export const TEXT_MAX = 32_000;
// The omp-live transport refuses a body over 64 000 BYTES (TEXT_MAX counts characters).
export const HOLDER_TEXT_MAX_BYTES = 64_000;

// Type guards (narrowing is what makes them worth a name): a positive pid-like integer and
// a non-negative ms-epoch.
export const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export const validSessionId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;

// The envelope every store shares: a parse of a different version is an empty store (the
// caller logs it), never a silent reinterpretation.
export function parseEnvelope(blob: string | null, listField: string): Record<string, unknown> | null {
  if (blob === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed[listField])) return null;
  return parsed;
}
