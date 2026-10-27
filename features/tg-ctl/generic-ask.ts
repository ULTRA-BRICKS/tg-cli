// Generic, one-shot human approval asks for external safety gates (tg-cli#149,
// tg#6554): `tg-ctl ask "<question>" [--timeout <seconds>]`.
//
// A THIRD-PARTY caller's primitive (a pre-bash hook, a CI step, rig's
// `agent_hooks.approval_cmd`, any script) -- distinct from the bare `tg-ctl ask`
// hook client, which reads a harness hook payload from stdin. A generic request
// is an ordinary unscoped ButtonRequest (kind 'permission', agent 'claude') sent
// over the same owner-only socket and Telegram transport as every other
// permission, so the verdict comes only from a tap the daemon receives through
// its own getUpdates stream, from an allowed sender, on this card. Every call
// mints a fresh random requestId, so no cached or replayed answer can match it.

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
// Daemon-side backstop margin on top of the client's own wait, so the client's
// timeout normally fires first and the daemon's unscoped-abandon timer is only
// cleanup. The daemon caps it at 15 min (clampRequestTimeoutMs): above 885s the
// margin shrinks, at 900s the two deadlines coincide; either one exits 1.
const DAEMON_ABANDON_MARGIN_MS = 15_000;

// `origin.agent` of a generic ask: the one marker the daemon recognizes it by.
export const GENERIC_ASK_ORIGIN_AGENT = 'tg-ctl-generic';

export const OWNER_ONLY_FLAG = '--owner-only';

// Capability markers `tg-ctl capabilities --json` reports; a client verifies the exact marker
// before it relies on the behavior.
export const CAPABILITIES_SCHEMA_VERSION = 1;
export const CAPABILITIES = ['ask-owner-only-v1'] as const;

// True only for a positive safe-integer private chat id ("5153477378"); groups and channels
// are negative, so they and every non-numeric spelling are refused.
export function isPrivateOwnerChatId(raw: string | number | undefined): boolean {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0;
}

// The shared answer predicate for an ownerOnly request: the tapping/replying USER and the chat
// the answer came from must both be the configured private owner chat id. Missing message
// (inline), group chats, other allowlisted senders and synthesized answers (no actor) fail.
export interface AnswerActor { userId: number | null; chatId: number | null }
export function ownerOnlyAnswerAllowed(ownerChatId: number, actor: AnswerActor | undefined): boolean {
  return (
    isPrivateOwnerChatId(ownerChatId) &&
    actor !== undefined &&
    actor.userId === ownerChatId &&
    actor.chatId === ownerChatId
  );
}

// The daemon's test for a generic ask. Paneless by construction: a request that
// names a pane is a harness prompt in that pane, whatever its origin says. Such
// an ask needs no registration (the caller is a script, not a pane-bound
// session the fast-passthrough guard protects) and never defers pane inbound
// (it is not a prompt in any pane, and it may wait 15 minutes).
export function isGenericAskRequest(req: { paneId?: string; origin?: { agent?: string } }): boolean {
  return req.origin?.agent === GENERIC_ASK_ORIGIN_AGENT && !req.paneId;
}

export interface GenericAskTimeout {
  seconds: number;
  warning?: string;
}

// The argv shapes of the INTERNAL ask submodes: no args (hook client, payload
// on stdin), exactly `--agent <kind>` (hook client for another harness;
// hookAgentFromArgv), and the grant consume client (tg-cli#398). They are
// detected POSITIVELY so that anything else -- a flag-first `--timeout 60 "…"`,
// the `--timeout=60` spelling, a question that itself starts with `--` --
// becomes a real Telegram prompt. Falling through to the hook client or the
// grant client instead would exit 0 with no prompt: a silent, unearned approval.
function isInternalAskArgv(argv: string[]): boolean {
  if (argv.length === 0) return true;
  if (argv.length === 2 && argv[0] === '--agent') return true;
  return isVerifyGrantInvocation(argv);
}

// The grant client's grammar (tg-ctl's verifyGrantArgvFrom): `--verify-grant
// [<approval_id>]`, `--pull`, `--hook <hook_id>`, in any order. Every token must
// belong to it -- a `--verify-grant` word inside an unquoted question is a
// question, not a grant consume.
function isVerifyGrantInvocation(argv: string[]): boolean {
  if (!argv.includes('--verify-grant')) return false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--pull') continue;
    if (token === '--verify-grant') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1;
      continue;
    }
    if (token === '--hook' && argv[i + 1] !== undefined) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

// Parses a generic-mode argv; null for an internal submode (see
// isInternalAskArgv). The question is every token except a syntactically
// valid `--timeout N` / `--timeout=N` or a valueless `--timeout`/`--timeout=`,
// joined in original order: an unquoted `deploy to prod --timeout 60` or
// `--timeout 60 delete production` must show the approver the whole question.
export function parseGenericAskArgv(argv: string[]): { question: string; timeout: GenericAskTimeout; ownerOnly: boolean } | null {
  if (isInternalAskArgv(argv)) return null;

  // `--owner-only` (ask-owner-only-v1): consumed here, never shown in the question. The caller
  // validates the private owner chat before posting and stamps ownerOnly on the request.
  const ownerOnly = argv.includes(OWNER_ONLY_FLAG);
  argv = argv.filter((token) => token !== OWNER_ONLY_FLAG);

  // Remove ONLY the timeout option itself. An invalid timeout value or an
  // unknown flag stays verbatim in the human-visible question: this primitive
  // must never approve text the human did not actually see.
  let timeout = clampGenericAskTimeoutSec(undefined, false);
  const questionTokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--timeout') {
      const raw = argv[i + 1];
      timeout = clampGenericAskTimeoutSec(raw, true);
      // No value at all is a flag mistake, not question text.
      if (raw === undefined) continue;
      i += 1;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) continue;
      questionTokens.push(token, raw);
      continue;
    }

    if (token.startsWith('--timeout=')) {
      const raw = token.slice('--timeout='.length);
      timeout = clampGenericAskTimeoutSec(raw === '' ? undefined : raw, true);
      const n = Number(raw);
      if (raw === '' || (Number.isFinite(n) && n > 0)) continue;
      questionTokens.push(token);
      continue;
    }

    questionTokens.push(token);
  }

  const question = questionTokens.join(' ');
  return { question, timeout, ownerOnly };
}

// `timeoutFlagGiven` distinguishes "the caller never passed --timeout at all" (silent
// default, the common/expected case) from "the caller passed --timeout but its value
// is missing or unparseable" (a likely mistake -- warn, symmetric with the >900s
// clamp warning below; an unnoticed silent fallback here would mean the caller
// thinks they set a real budget when they didn't).
export function clampGenericAskTimeoutSec(raw: string | undefined, timeoutFlagGiven = raw !== undefined): GenericAskTimeout {
  if (raw === undefined) {
    if (!timeoutFlagGiven) return { seconds: DEFAULT_TIMEOUT_SEC };
    return {
      seconds: DEFAULT_TIMEOUT_SEC,
      warning: `--timeout given with no value; using default ${DEFAULT_TIMEOUT_SEC}s`,
    };
  }
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) {
    return {
      seconds: DEFAULT_TIMEOUT_SEC,
      warning: `--timeout value ${JSON.stringify(raw)} is not a valid positive number; using default ${DEFAULT_TIMEOUT_SEC}s`,
    };
  }
  // Floor AFTER the `> 0` guard: "0.5" would otherwise floor to a 0-second
  // budget that denies instantly with no warning. Clamp up to 1s instead.
  const seconds = Math.floor(requested);
  if (seconds < 1) {
    return {
      seconds: 1,
      warning: `requested timeout ${requested}s rounds down to less than 1s; clamped to 1s`,
    };
  }
  if (seconds > MAX_TIMEOUT_SEC) {
    return {
      seconds: MAX_TIMEOUT_SEC,
      warning: `requested timeout ${seconds}s exceeds max ${MAX_TIMEOUT_SEC}s; clamped to ${MAX_TIMEOUT_SEC}s`,
    };
  }
  return { seconds };
}

export function genericAskDaemonAbandonMs(timeoutSeconds: number): number {
  return timeoutSeconds * 1000 + DAEMON_ABANDON_MARGIN_MS;
}

// The daemon replies with the SAME shape formatAgentHookOutput builds for a
// claude+permission PermissionRequest: { hookSpecificOutput: { decision: { behavior,
// message? } } }. `raw` is exactly what oneAskAttempt handed back: null (no answer --
// rejected/expired/not-registered; the transport cannot distinguish these), or the
// daemon's JSON line.
export type GenericAskVerdict =
  | { exitCode: 0; detail: string | null }
  | { exitCode: 1; reason: string };

export function resolveGenericAskVerdict(raw: string | null): GenericAskVerdict {
  // The daemon's own "no answer" decline (abandon timer, not registered) is the
  // line `null`, which oneAskAttempt hands back as the STRING "null" -- a
  // decline, not a malformed response.
  if (raw === null || raw === 'null') return { exitCode: 1, reason: 'denied: rejected or not answered' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exitCode: 1, reason: 'denied: malformed daemon response' };
  }
  const behavior = (parsed as { hookSpecificOutput?: { decision?: { behavior?: unknown; message?: unknown } } })
    ?.hookSpecificOutput?.decision;
  if (!behavior || (behavior.behavior !== 'allow' && behavior.behavior !== 'deny')) {
    return { exitCode: 1, reason: 'denied: malformed daemon response' };
  }
  if (behavior.behavior === 'allow') {
    return { exitCode: 0, detail: typeof behavior.message === 'string' && behavior.message ? behavior.message : null };
  }
  const message = typeof behavior.message === 'string' && behavior.message ? `: ${behavior.message}` : '';
  return { exitCode: 1, reason: `denied: rejected in Telegram${message}` };
}
