// agents-hooks/v1 — vendored subprocess-hook contract for tg-cli.
//
// This is the universal hook framework described in
// docs/specs (review-cli architecture-visual-verification.md §7) and
// /tmp/detector-cli/design.md. The whole point: a host tool (tg) can run an
// OUT-OF-PROCESS hook (e.g. a Python `review visual` gate) before an action,
// with the hook deciding allow/block over a tiny JSON-on-stdin / exit-code
// protocol. No shared runtime between host and hook.
//
// Design invariants baked into these types:
//   - Block is signalled by RESERVED EXIT CODE 10 (un-corruptible). stdout JSON
//     carries the human message and future fields. A hook that *intends* to
//     block but emits malformed JSON still blocks, because exit 10 is the
//     canonical signal — malformed-JSON can never silently bypass a gate.
//   - Fail-open by DEFAULT (on_error: 'open'): a hook crash / timeout / bad
//     output must NEVER break a daily `tg` send. A security gate may opt into
//     on_error: 'closed'.
//   - TRUST-BY-DEFAULT: a dropped descriptor LOADS AND RUNS by default — this is
//     the user's own machine, so the TOFU ceremony is needless. The legacy TOFU
//     quarantine + sha-pin re-engages ONLY under the opt-in, off-by-default guard
//     AGENTS_HOOKS_TRUST=1 (the rare paranoid / untrusted-input case). Under the
//     guard a freshly-dropped, not-yet-trusted descriptor is QUARANTINED-AS-ABSENT
//     (treated as if it does not exist) until pinned; AGENTS_HOOKS_TRUST=auto is
//     the batch/agent escape hatch that bypasses the pins inside the guard.
//   - SECURITY NOTE: a drop-in hook descriptor names an EXECUTABLE that `tg`
//     runs on EVERY photo send. Since they run with no trust step by default,
//     ONLY the user (or their own tools) should ever write to ~/.agents/hooks/tg/.
//   - Append-only audit.jsonl: in a fail-open system the only thing telling
//     "honestly allowed" from "silently bypassed" is the log line. Kept in BOTH
//     the trust-by-default and the guarded paths.

export const HOOK_API = 'agents-hooks/v1';

// Reserved exit code meaning "block this action". Everything else that is not 0
// is treated as a hook error (and subject to on_error policy).
export const BLOCK_EXIT_CODE = 10;

// A hook descriptor — one drop-in JSON file = one hook. Lives under
// ~/.agents/hooks/<tool>/<id>.<point>.json. The descriptor PROPOSES on_error /
// timeout; the user's trust pin is authoritative for on_error.
export interface HookDescriptor {
  // Stable hook id, e.g. "review-visual". Combined with `point` to identify it.
  id: string;
  // The host hook point this descriptor binds to, e.g. "pre-send-photo".
  point: string;
  // Absolute path to the executable to run (the owner's code, NOT in this repo).
  cmd: string;
  // Extra argv passed to `cmd` before the JSON-on-stdin protocol (rare).
  args?: string[];
  // Lower runs first; ties broken by descriptor filename. Default 50.
  priority?: number;
  // Per-hook timeout in ms. Default DEFAULT_TIMEOUT_MS. Vision hooks set higher.
  timeout_ms?: number;
  // Proposed failure policy. 'open' = warn + proceed (default), 'closed' = a
  // hook error blocks the action. The TRUST PIN overrides this at run time.
  on_error?: OnError;
  // Optional human label for banners / audit.
  description?: string;
}

export type OnError = 'open' | 'closed';

// A loaded descriptor plus the file it came from (for ordering tie-break and
// trust banners).
export interface LoadedDescriptor {
  descriptor: HookDescriptor;
  // Absolute path to the descriptor JSON file.
  file: string;
}

// The trust pin for one hook, keyed by `${id}.${point}` in trust.json. Pins are
// ONLY consulted under the AGENTS_HOOKS_TRUST=1 guard; in the trust-by-default
// common path there is no pin to read. Under the guard we pin cmd_sha256 +
// invocation_sha256 + on_error so neither a one-byte descriptor edit
// ("closed"→"open") NOR an invocation swap can silently change what runs:
//   - cmd_sha256:        the executable's bytes (catches a swapped binary).
//   - invocation_sha256: a digest of cmd + args + timeout_ms (catches a
//     descriptor that keeps `cmd` = an interpreter like `python3` but repoints
//     `args` at a different script, or drops `--strict`, OR lowers `timeout_ms`
//     so a fail-open gate is forced to time out and allow). Without this, a
//     trusted interpreter is a universal-execution primitive and a trusted gate
//     is defeatable by a one-field timeout edit that survives the pin.
//   - on_error:          authoritative failure policy (the descriptor only proposes).
export interface TrustPin {
  cmd_sha256: string;
  invocation_sha256?: string; // optional only for forward-compat reads; absent → re-trust
  point: string;
  on_error: OnError;
}

// Digest the FULL invocation (cmd + args + timeout) so a descriptor edit that
// changes what actually runs — or how long it is allowed to run — requires
// re-trust even when the executable bytes are unchanged. The timeout matters
// because a fail-open gate forced to time out becomes an allow: lowering
// timeout_ms under the guard must re-quarantine, exactly like an args swap.
export function invocationDigest(cmd: string, args: string[] | undefined, timeoutMs?: number): string {
  // A NUL separator can't appear in argv, so this is unambiguous. timeout_ms is
  // appended in a separate field so an undefined timeout (use the default) and an
  // explicit one are distinguishable from any argv token.
  return [cmd, ...(args ?? []), `\0timeout=${timeoutMs ?? ''}`].join('\0');
}

export type TrustStore = Record<string, TrustPin>;

// The JSON event written to a hook's stdin.
export interface HookEvent {
  hook_api: typeof HOOK_API;
  event_id: string;
  tool: string; // "tg"
  point: string; // "pre-send-photo"
  command: string; // e.g. "send-photo"
  cwd: string;
  args: Record<string, unknown>; // { image_path, caption, chat_id }
}

export type Decision = 'allow' | 'block';

// What a hook prints on stdout (protocol only — logs go to stderr).
//
// The gate_* / body_sha256 fields are an OPTIONAL, generic extension: any
// hook may report structured "gate" context about what it checked, and the
// runner copies it straight through into that hook's audit.jsonl line (see
// AuditLine in runner.ts). They carry no meaning to the runner itself and no
// shipped hook uses them today; any gate can report them to share one audit
// shape instead of inventing its own.
export interface HookOutput {
  hook_api?: string;
  decision?: Decision;
  message?: string;
  // The --tag value the gate evaluated (e.g. "decision").
  gate_tag?: string;
  // Comma-separated list of what the gate found missing (e.g. "table"). Empty
  // or absent when nothing was missing.
  gate_missing?: string;
  // What kind of literal table (if any) the gate found — see TableKind in
  // features/render/table.ts ('html' | 'boxed' | 'pipe' | 'none').
  gate_table_kind?: string;
  // Non-empty when the send bypassed the gate (e.g. a future RIG_HATCH_REQUEST
  // override) and, if so, by what mechanism. Empty/absent = no bypass used.
  gate_bypass?: string;
  // sha256 of the message body the gate evaluated, so an audit line can be
  // correlated back to the exact content without storing the body itself.
  body_sha256?: string;
  // The gate's own logic/version tag, so a later behavior change (e.g. the
  // flip from warn to block) is distinguishable in historical audit lines.
  gate_version?: string;
}

// Why the trust gate let a hook run, or refused it.
export type TrustState =
  | 'trusted-default' // trust-by-default: guard off, descriptor runs with no pin
  | 'trusted' // sha matched a pin (under the AGENTS_HOOKS_TRUST=1 guard)
  | 'auto' // AGENTS_HOOKS_TRUST=auto bypassed the pin (under the guard)
  | 'quarantined-new' // guard on, never seen — inert, banner printed
  | 'quarantined-changed' // guard on, executable changed since pin — inert
  | 'untrusted-missing-cmd'; // descriptor points at a non-existent executable

// The outcome of running ONE hook, for audit + aggregation.
export interface HookRunResult {
  hookId: string;
  point: string;
  cmdSha256: string;
  decision: Decision; // resolved decision after on_error policy applied
  rawExitCode: number | null; // null = timeout/spawn failure
  message?: string;
  durationMs: number;
  onErrorApplied: OnError;
  trustState: TrustState;
  errored: boolean; // the hook crashed / timed out / bad protocol
  quarantined: boolean; // treated as absent (did not run)
  // Optional gate_* passthrough from the hook's own stdout (see HookOutput).
  // Undefined for a quarantined hook or one that never reported them.
  gateTag?: string;
  gateMissing?: string;
  gateTableKind?: string;
  gateBypass?: string;
  bodySha256?: string;
  gateVersion?: string;
}

// The aggregate verdict the host acts on.
export interface HooksVerdict {
  // true → the host MUST hold/abort the gated action.
  blocked: boolean;
  // Block message to surface to the user (first blocking hook).
  blockMessage?: string;
  // Per-hook results, in execution order.
  results: HookRunResult[];
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_PRIORITY = 50;
export const DEFAULT_ON_ERROR: OnError = 'open';
