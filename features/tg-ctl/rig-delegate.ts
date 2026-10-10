// Rig-aware delegation for `tg-ctl install-hooks` (tg#8672). The ONE impure module here (it
// spawns `python3`, like voice-probe.ts spawns `which` — see that file's header for the house
// convention) — everything else in features/tg-ctl/ stays pure.
//
// WHY: `tg-ctl install-hooks` writes a Codex Stop usage-telemetry hook straight into
// `~/.codex/hooks.json`. When `rig` is also installed, rig separately writes ITS OWN codex hook
// bridge into `~/.codex/config.toml` (see rig-cli's `_do_register_codex_hook_bridge`). Codex then
// warns `loading hooks from both ~/.codex/hooks.json and ~/.codex/config.toml` — two sources of
// truth for the same mechanism. The fix is the shared decision every ecosystem CLI makes
// (agent-tools PR #282, `lib/agenttools_rig_delegate`): when rig is present, let rig own the
// hooks; tg-ctl only self-installs when rig is absent.
//
// tg-ctl is Bun/TS and cannot import the Python library directly, so it shells out to the CLI
// mirror: `python3 -m agenttools_rig_delegate {detect|delegate}` (see that package's README).
//
// CAVEAT (documented, not silently papered over): rig does not YET fold the codex
// usage-telemetry Stop hook into its own bridge — `rig apply` only provisions rig's OWN codex
// hooks, not this one. So unconditionally skipping the direct `hooks.json` write the moment rig
// is present would LOSE telemetry until rig catches up. The caller (installHooks in ../../tg-ctl)
// therefore ALWAYS re-checks whether the telemetry hook ended up installed after delegating, and
// only skips the direct write when it actually finds it there. Until rig folds this hook in, both
// files may carry codex hook content (the dual-source warning does not fully go away) — but
// telemetry itself is never lost. Revisit this check once rig provisions the Stop hook itself.

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ADMIN_SPAWN } from '../util/spawn-timeout';

// Mirrors rig-cli's own `_DEFAULT_SOURCE_CANDIDATES` (riglib/catalog.py) so both tools agree on
// where an agent-tools checkout is expected to live when no override is set.
const AGENT_TOOLS_DEFAULT_CANDIDATES = ['~/xp/agent-tools', '~/work/agent-tools', '~/agent-tools'];

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// Resolve the `lib/` directory that must go on PYTHONPATH for
// `python3 -m agenttools_rig_delegate` to import. Order: RIG_AGENT_TOOLS_SOURCE env → default
// candidates. Returns null if no checkout carrying the package can be found — the "delegation
// is unavailable, fall back" signal.
export function resolveAgentToolsLib(env: Record<string, string | undefined>): string | null {
  const explicit = env.RIG_AGENT_TOOLS_SOURCE;
  const candidates = explicit ? [explicit] : AGENT_TOOLS_DEFAULT_CANDIDATES;
  for (const candidate of candidates) {
    const lib = join(expandHome(candidate), 'lib');
    if (existsSync(join(lib, 'agenttools_rig_delegate', '__init__.py'))) return lib;
  }
  return null;
}

function delegateEnv(baseEnv: Record<string, string | undefined>, lib: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) merged[k] = v;
  merged.PYTHONPATH = merged.PYTHONPATH ? `${lib}:${merged.PYTHONPATH}` : lib;
  return merged;
}

export interface RigDetection {
  present: boolean;
  rigPath?: string;
}

// "is rig here?" — never throws; any spawn failure (no python3, no agent-tools checkout, ...)
// reports absent so the caller runs its own direct installer.
export function detectRig(env: Record<string, string | undefined> = process.env): RigDetection {
  const lib = resolveAgentToolsLib(env);
  if (!lib) return { present: false };
  try {
    const proc = Bun.spawnSync(['python3', '-m', 'agenttools_rig_delegate', 'detect'], {
      env: delegateEnv(env, lib),
      stdout: 'pipe',
      stderr: 'ignore',
      ...ADMIN_SPAWN,
    });
    if (proc.exitCode === 0) {
      const rigPath = proc.stdout.toString().trim();
      return { present: true, rigPath: rigPath || undefined };
    }
    return { present: false };
  } catch {
    return { present: false };
  }
}

export interface RigDelegateResult {
  ran: boolean;
  exitCode: number | null;
  stderr: string;
}

// The exit code the shared `agenttools_rig_delegate` CLI's `delegate` subcommand returns when it
// finds NO rig — the "rig absent, run your own fallback" sentinel. Mirrors the Python library's
// exported `agenttools_rig_delegate.NO_RIG_EXIT` (agent-tools#282). It MUST agree with that
// value: #282 moved it OFF 3 (which collided with rig's own `EXIT_DRIFT=3`, making a real
// `rig apply` drift indistinguishable from "rig absent") to 97 — clear of rig's whole 0-8 range
// and the 126/127/128+ shell-reserved codes. A caller that treats this sentinel as a rig FAILURE
// (propagate, no fallback) would wrongly refuse to self-install when rig is merely absent; one
// that treats a REAL failure as the sentinel (fall back) would double-write. So branch on it
// EXACTLY, never on "any nonzero".
export const NO_RIG_EXIT = 97;

// Best-effort `rig <rigArgs>` via the shared delegate CLI. Assumes the caller already confirmed
// rig is present (detectRig) — this function only reports whether it managed to RUN rig and
// rig's own exit code; it never decides fallback policy itself (the caller does, per tg#8672's
// telemetry-preservation rule above).
export function runRigDelegate(
  rigArgs: string[],
  env: Record<string, string | undefined> = process.env,
  cwd?: string,
): RigDelegateResult {
  const lib = resolveAgentToolsLib(env);
  if (!lib) return { ran: false, exitCode: null, stderr: '' };
  try {
    const proc = Bun.spawnSync(['python3', '-m', 'agenttools_rig_delegate', 'delegate', ...rigArgs], {
      env: delegateEnv(env, lib),
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      ...ADMIN_SPAWN,
    });
    return { ran: true, exitCode: proc.exitCode, stderr: proc.stderr.toString() };
  } catch (err) {
    return { ran: false, exitCode: null, stderr: err instanceof Error ? err.message : String(err) };
  }
}

// The marker rig writes into ~/.codex/config.toml when it provisions the codex hook bridge.
// Must match rig-cli's `_CODEX_BRIDGE_BEGIN` (riglib/actions/runner.py).
const RIG_CODEX_BRIDGE_MARKER = '# >>> rig managed: codex hook bridge';

// True iff rig actually manages the codex hooks — its bridge marker is present in
// ~/.codex/config.toml (honoring CODEX_HOME). ONLY then is bypassing codex's per-invocation
// hook-trust gate justified: rig vouches for the hooks it writes. On a machine without rig, a
// user's own untrusted codex hooks must keep facing codex's trust gate.
export function codexHooksRigManaged(env: Record<string, string | undefined> = process.env): boolean {
  const codexHome = env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
  try {
    return readFileSync(join(codexHome, 'config.toml'), 'utf8').includes(RIG_CODEX_BRIDGE_MARKER);
  } catch {
    return false;
  }
}

// Append codex's `--dangerously-bypass-hook-trust` to a spawn argv — but ONLY for a codex spawn
// AND only when codex hooks are rig-managed (see codexHooksRigManaged). claude/opencode and
// non-rig-managed codex are returned unchanged (never bypass a user's own untrusted hooks).
export function applyCodexHookTrustBypass(
  argv: string[],
  modelKind: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (modelKind !== 'codex') return argv;
  if (!codexHooksRigManaged(env)) return argv;
  // Codex's CLI is `codex [OPTIONS] [PROMPT]`, and spawnArgvWithTask inserts a `--` before an
  // initial task prompt. The bypass is an OPTION, so it MUST land before that `--` separator —
  // appended after it, codex parses it as part of the prompt and the hook-trust gate still
  // fires (codex review). No `--` (no task) -> append at the end.
  const flag = '--dangerously-bypass-hook-trust';
  if (argv.includes(flag)) return argv; // idempotent: never emit a duplicate bypass flag
  const sep = argv.indexOf('--');
  if (sep === -1) return [...argv, flag];
  return [...argv.slice(0, sep), flag, ...argv.slice(sep)];
}
