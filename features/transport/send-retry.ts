// --- Bot API send retry (tg-cli#710) ---
//
// One outbound Bot API request, retried while Telegram is TRANSIENTLY unavailable: the
// fetch threw (connection reset/refused, socket closed, DNS, or this attempt's own
// timeout) or Telegram answered 429 / 500 / 502 / 503 / 504. Any other answer — a 2xx,
// a 400 "chat not found", a 403 — is Telegram's verdict and is returned at once, so the
// caller's existing handling (the advisory-thread fallback, exit 1) is unchanged.
//
// Retries are bounded by a total time budget, not a count: on 2026-10-14 sendMessage
// answered 504 only after ~121 s, so each attempt carries its own timeout and the backoff
// (1 s, 2 s, 4 s, 8 s, 8 s … with up to +25 % jitter; a 429 waits its retry_after) stops
// once the next attempt would not fit. The caller then queues the send (outbox.ts).
// fetch, sleep, clock and randomness are injected so tests run instantly.

export interface SendRetryPolicy {
  // Total time a send may spend retrying. 0 = one attempt, no retry.
  budgetMs: number;
  // Ceiling for one attempt; a later attempt is also cut to the budget left.
  attemptTimeoutMs: number;
  // The same for a photo/document/album upload: a 50 MB file on a slow uplink must not be
  // cut off as a "hang".
  uploadAttemptTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_SEND_RETRY: SendRetryPolicy = {
  budgetMs: 60_000,
  attemptTimeoutMs: 30_000,
  uploadAttemptTimeoutMs: 120_000,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

// A retry is only worth it when the next attempt still has this long to run.
const MIN_ATTEMPT_MS = 1_000;

// `TG_SEND_RETRY_BUDGET_MS` overrides the budget (a non-negative safe integer — an
// overflow to Infinity would retry forever instead of queueing); anything else keeps
// the default.
export function sendRetryPolicyFromEnv(env: Record<string, string | undefined>): SendRetryPolicy {
  const raw = env.TG_SEND_RETRY_BUDGET_MS?.trim();
  const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return { ...DEFAULT_SEND_RETRY, budgetMs: Number.isSafeInteger(parsed) ? parsed : DEFAULT_SEND_RETRY.budgetMs };
}

export interface SendRetryIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  // One short stderr line per retry.
  warn: (line: string) => void;
}

export const REAL_SEND_RETRY_IO: SendRetryIo = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  random: Math.random,
  warn: (line) => console.error(line),
};

// `ok: true` — Telegram answered with something that is not worth a retry (success or
// a permanent error). `ok: false` — still transient when the budget ran out.
export type PostOutcome = { ok: true; resp: Response } | { ok: false; reason: string };

export function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// "ECONNRESET: The socket connection was closed unexpectedly", "TimeoutError: …".
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = 'code' in err && typeof err.code === 'string' && err.code !== '' ? err.code : err.name;
  return `${code}: ${err.message}`;
}

// The reason line and, for a 429, Telegram's own wait (parameters.retry_after, seconds).
export async function readTransientAnswer(resp: Response): Promise<{ reason: string; retryAfterMs?: number }> {
  const text = await resp.text().catch(() => '');
  let description = text;
  let retryAfterMs: number | undefined;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // a non-JSON gateway page: its raw text is the description
  }
  if (json && typeof json === 'object') {
    description = 'description' in json && typeof json.description === 'string' ? json.description : '';
    const parameters = 'parameters' in json ? json.parameters : null;
    if (parameters && typeof parameters === 'object' && 'retry_after' in parameters && typeof parameters.retry_after === 'number' && parameters.retry_after > 0) {
      retryAfterMs = parameters.retry_after * 1000;
    }
  }
  // Server-supplied text goes to the local terminal: printable ASCII only, capped.
  const safe = description.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
  return { reason: `HTTP ${resp.status}${safe ? ` ${safe}` : ''}`, retryAfterMs };
}

export async function postWithRetry(
  url: string,
  init: () => RequestInit,
  label: string,
  policy: SendRetryPolicy,
  io: SendRetryIo,
): Promise<PostOutcome> {
  const start = io.now();
  for (let attempt = 1; ; attempt++) {
    const left = policy.budgetMs - (io.now() - start);
    const timeoutMs = attempt === 1 ? policy.attemptTimeoutMs : Math.min(policy.attemptTimeoutMs, left);
    let reason: string;
    let waitMs = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs) * (1 + 0.25 * io.random());
    try {
      // A fresh body per attempt: a FormData upload stream is consumed by the first send.
      const resp = await io.fetch(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
      if (!isTransientStatus(resp.status)) return { ok: true, resp };
      const answer = await readTransientAnswer(resp);
      reason = answer.reason;
      if (answer.retryAfterMs !== undefined) waitMs = answer.retryAfterMs;
    } catch (err) {
      reason = describeFetchError(err);
    }
    waitMs = Math.round(waitMs);
    if (io.now() - start + waitMs + MIN_ATTEMPT_MS > policy.budgetMs) return { ok: false, reason };
    io.warn(`tg: ${label} failed (${reason}) — retry ${attempt} in ${(waitMs / 1000).toFixed(1)}s`);
    await io.sleep(waitMs);
  }
}
