// Generic, one-shot human approval asks for external safety gates (tg-cli#149,
// Alex tg#6554/tg#6660): `tg-ctl ask "<question>" [--timeout <seconds>]`.
//
// This mode is a THIRD-PARTY caller's primitive (e.g. an agent-tools safety hook
// wanting a live, justified, one-time override) -- distinct from the existing bare
// `tg-ctl ask` (no positional arg), which is the Claude-Code-hook stdin-JSON client
// and is untouched by anything in this file. Generic-mode requests are built as an
// ordinary unscoped ButtonRequest (kind: 'permission', agent: 'claude') and sent
// through the SAME battle-tested socket/Telegram transport as every other
// permission request -- there is no separate callback namespace or daemon-side
// state to maintain. The one-time property falls out of construction: every call
// generates a fresh random requestId, so it can never collide with (or replay) a
// past answer cached under a different id.

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
// Daemon-side backstop margin on top of the client's own wait, so the client's
// timeout always fires first/primarily and the daemon's unscopedAbandonMs is a
// pure cleanup safety net, not the active timeout signal.
const DAEMON_ABANDON_MARGIN_MS = 15_000;

export interface GenericAskTimeout {
  seconds: number;
  warning?: string;
}

// Parses argv positional/flag shape for generic mode. Returns null when this
// invocation is NOT generic mode (no positional question arg AND no `--timeout`
// anywhere) -- the caller falls through to the existing bare stdin-JSON `ask`
// path unchanged.
//
// `--timeout` is recognized ANYWHERE in argv, not just after a leading
// positional -- review finding (security-critical): checking only `argv[0]` let
// a caller using the ordinary CLI convention of putting flags first
// (`tg-ctl ask --timeout 60 "delete production"`) fall through to the LEGACY
// stdin-JSON hook-client path, which can exit 0 with NO Telegram prompt and NO
// human ever consulted -- a silent, unearned approval for a primitive whose
// entire purpose is requiring one. `--timeout` is a generic-mode-ONLY flag (the
// hook client recognizes only `--agent`), so its presence anywhere is an
// unambiguous generic-mode signal.
//
// The question is EVERY token that is neither the `--timeout` flag nor its
// value, in original order, up to the first OTHER `--`-prefixed (unrecognized)
// flag -- not just the tokens before `--timeout`. A caller running
// `tg-ctl ask deploy to prod --timeout 60` (forgot to quote) or
// `tg-ctl ask --timeout 60 delete production` must not have the approver see a
// silently truncated question: for a primitive whose whole job is showing a
// human exactly what they're approving, swallowing part of the question
// without so much as a warning is a real risk, not a cosmetic one.
// The ONLY two argv shapes the LEGACY stdin-JSON hook-client path is ever
// installed with (tg-ctl:2059, hookAgentFromArgv): no args at all, or exactly
// `--agent <kind>`. Detecting legacy mode POSITIVELY -- instead of trying to
// positively detect every possible generic-mode shape -- means an unexpected
// argv (an unrecognized flag, a different flag spelling, a question that
// itself starts with `--`) fails toward the SAFE side (a real Telegram prompt)
// rather than the dangerous one (a silent exit-0 approval). Review findings:
// checking only `argv.indexOf('--timeout')` missed the equally-valid
// `--timeout=60` GNU spelling entirely (HIGH: a caller using that form fell
// straight through to the legacy no-stdin exit-0 path with NO prompt and NO
// human consulted -- exactly the "silent, unearned approval" this file exists
// to prevent), and checking only `!argv[0].startsWith('--')` did the same for
// any question that happens to start with `--` (e.g. `tg-ctl ask "--force wipe
// prod?"`). Both are now generic mode by construction: they are not the
// legacy shape, so they can't be anything else.
function isLegacyHookInvocation(argv: string[]): boolean {
  if (argv.length === 0) return true;
  if (argv.length === 2 && argv[0] === '--agent') return true;
  // Grant protocol v1.1 is another INTERNAL ask submode. It can carry several
  // flags/positionals, so it cannot be recognized by the old exact-argv rule.
  // Never reinterpret a grant-consume request as a human generic question.
  if (argv.includes('--verify-grant')) return true;
  return false;
}

// Parses argv positional/flag shape for generic mode. Returns null when this
// invocation is the LEGACY shape (see isLegacyHookInvocation) -- the caller
// falls through to the existing bare stdin-JSON `ask` path unchanged.
//
// The question is EVERY token that is neither a recognized `--timeout` /
// `--timeout=N` flag (and, for the space-separated form, its value), in
// original order, up to the first OTHER `--`-prefixed (unrecognized) flag --
// not just the tokens before `--timeout`. A caller running
// `tg-ctl ask deploy to prod --timeout 60` (forgot to quote) or
// `tg-ctl ask --timeout 60 delete production` must not have the approver see a
// silently truncated question: for a primitive whose whole job is showing a
// human exactly what they're approving, swallowing part of the question
// without so much as a warning is a real risk, not a cosmetic one.
export function parseGenericAskArgv(
  argv: string[],
): { question: string; timeout: GenericAskTimeout; warning?: string } | null {
  if (isLegacyHookInvocation(argv)) return null;

  // Remove ONLY a syntactically valid timeout option. Invalid or unknown
  // flag-looking tokens stay verbatim in the human-visible question: this
  // primitive must never approve text the human did not actually see.
  let timeout = clampGenericAskTimeoutSec(undefined, false);
  const questionTokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--timeout') {
      const raw = argv[i + 1];
      const n = raw === undefined ? NaN : Number(raw);
      timeout = clampGenericAskTimeoutSec(raw, true);
      if (raw !== undefined && Number.isFinite(n) && n > 0) {
        i += 1;
        continue;
      }
      questionTokens.push(token);
      if (raw !== undefined) {
        questionTokens.push(raw);
        i += 1;
      }
      continue;
    }

    if (token.startsWith('--timeout=')) {
      const raw = token.slice('--timeout='.length);
      const n = Number(raw);
      timeout = clampGenericAskTimeoutSec(raw, true);
      if (Number.isFinite(n) && n > 0) continue;
      questionTokens.push(token);
      continue;
    }

    questionTokens.push(token);
  }

  const question = questionTokens.join(' ');
  return { question, timeout };
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
  // Floor happens AFTER the `> 0` guard above, so a fractional value in (0,1)
  // (e.g. "0.5") passed the positive check but used to floor to 0 -- a
  // 0-second budget that denies the request INSTANTLY with no warning at all
  // (review finding). A human-facing approval timeout under 1 second is never
  // a real budget; clamp it up to 1s instead of down to 0, with a warning so
  // the caller knows their requested value did not survive as given.
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
  // A legitimate "no answer" decline (rejected/expired/not-registered) arrives
  // as the raw daemon line `socket.end("null\n")` -- which oneAskAttempt hands
  // back as the non-empty STRING "null", not the JS value null (its own
  // `raw.trim() || null` only collapses to actual null on an EMPTY string).
  // Treating only `raw === null` as "no answer" left every genuine decline
  // falling through to JSON.parse("null") -> JS null -> the "malformed" branch
  // below, contradicting this mode's own documented contract (tg-ctl USAGE: an
  // unregistered cwd "is denied the same as a real reject") -- review finding.
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
  return { exitCode: 1, reason: `denied: rejected by Alex${message}` };
}
