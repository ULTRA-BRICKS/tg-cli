// Real I/O wiring for the pre-send-photo hook point.
//
// This is the ONLY hook module that touches disk / spawns subprocesses; the
// runner.ts decision logic is pure. The tg seam calls runPreSendPhotoHooks once
// per send, AFTER it has confirmed (with a single `stat`) that
// ~/.agents/hooks/tg/ exists — so on a machine with no descriptors this module
// is never even imported into the hot path.

import { createHash } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fsRoutesLockIo, withRoutesLock } from '../tg-ctl/routes';
import {
  freshEventId,
  MAX_AUDIT_LINES,
  orderDescriptors,
  runHooks,
  trimAuditLines,
  validateDescriptor,
  type AuditLine,
  type RunnerDeps,
  type SpawnResult,
} from './runner';
import { HOOK_API, type HookEvent, type HooksVerdict, type LoadedDescriptor, type TrustStore } from './types';

export const TOOL = 'tg';

// ~/.agents/hooks layout (data only; hook CODE lives with its owner).
export function hooksRoot(home = homedir()): string {
  return join(home, '.agents', 'hooks');
}
export function toolHooksDir(home = homedir()): string {
  return join(hooksRoot(home), TOOL);
}
export function trustFile(home = homedir()): string {
  return join(hooksRoot(home), 'trust.json');
}
export function auditFile(home = homedir()): string {
  return join(hooksRoot(home), 'audit.jsonl');
}

// The opt-in, off-by-default untrusted-input guard. When set, the legacy TOFU
// quarantine + sha-pin re-engages (the rare paranoid case — a descriptor dropped
// by something you don't fully control). Unset (the DEFAULT) = trust-by-default:
// every loaded descriptor runs with no ceremony.
//
// AGENTS_HOOKS_TRUST=auto is the batch/agent escape hatch that runs UNDER the
// guard but auto-trusts (bypasses the pins), so it counts as guard-active too.
export function untrustedGuardActive(env: NodeJS.ProcessEnv): boolean {
  const v = (env.AGENTS_HOOKS_TRUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'auto';
}

// AGENTS_HOOKS_TRUST=auto: under the guard, pins are bypassed (the batch/agent
// escape hatch). Parsed with the SAME trim+lowercase as the guard check so a
// value like `AUTO` or ` auto ` that activates the guard ALSO auto-trusts —
// otherwise it would be guard-active but not auto-trusted, silently quarantining
// every hook.
export function trustAutoActive(env: NodeJS.ProcessEnv): boolean {
  return (env.AGENTS_HOOKS_TRUST ?? '').trim().toLowerCase() === 'auto';
}

// THE non-breaking guard. The tg seam calls this first; if it returns false the
// send path is byte-for-byte today's behaviour (one `stat`, nothing else).
// AGENTS_HOOKS=0 hard-bypasses everything.
export function hooksActive(env: NodeJS.ProcessEnv, home = homedir()): boolean {
  if (env.AGENTS_HOOKS === '0') return false;
  try {
    return statSync(toolHooksDir(home)).isDirectory();
  } catch {
    return false;
  }
}

// Load every descriptor for `point` from ~/.agents/hooks/tg/. A corrupt or
// malformed drop-in is skipped (warned) — it kills only itself, never the send.
export function loadDescriptors(point: string, home = homedir()): LoadedDescriptor[] {
  const dir = toolHooksDir(home);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LoadedDescriptor[] = [];
  for (const f of files) {
    const file = join(dir, f);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`Warning: tg hooks: skipping malformed descriptor ${f}`);
      continue;
    }
    const v = validateDescriptor(parsed);
    if (!v.ok) {
      console.error(`Warning: tg hooks: skipping invalid descriptor ${f}: ${v.reason}`);
      continue;
    }
    if (v.descriptor.point !== point) continue;
    out.push({ descriptor: v.descriptor, file });
  }
  return orderDescriptors(out);
}

export function loadTrust(home = homedir()): TrustStore {
  try {
    const raw = readFileSync(trustFile(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as TrustStore;
    return {};
  } catch {
    return {};
  }
}

function sha256OfFile(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

function sha256OfString(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// --- audit.jsonl rotation, under a cross-process lock ----------------------
//
// A bare read-existing + append + trim + write-back (no lock) is a lost-update
// race: two `tg` sends firing hooks concurrently could both read the same
// bytes, then each write back a trimmed blob — the SECOND writer's write wins
// and silently drops the FIRST writer's just-appended line. In a fail-open
// system, that line is the only thing telling "honestly allowed" from
// "silently bypassed" (see the module header in types.ts) — losing it is
// exactly the failure this file exists to prevent.
//
// REVIEW FINDING (fixed): a first pass here hand-rolled its own O_EXCL +
// pid-liveness lock instead of reusing features/tg-ctl/routes.ts's
// `withRoutesLock` + `fsRoutesLockIo` — which already solves this EXACT
// problem (routes.jsonl has the identical concurrent-append hazard) and is
// unit-tested. The hand-rolled copy reintroduced a bug that pattern had
// already fixed once: it treated an EMPTY lockfile (the SIGKILL window
// between `openSync('wx')` and writing the pid) as "owner unknown, not dead"
// forever, permanently wedging rotation. `fsRoutesLockIo` models that exact
// case as `'unparseable'` (routes.ts's own comment explains why) and breaks
// it once it is older than ORPHAN_LOCK_AGE_MS (a younger one may be a live
// writer between those two calls). So: reuse it directly rather than re-fix the
// same bug twice. `lockPath`/`fsRoutesLockIo` are generic despite the
// "routes" name (the lock path is just a constructor argument) — nothing
// here is routes-specific.
//
// `onContended: 'skip'` means the READ-TRIM-WRITE body simply does not run
// when the lock can't be acquired within the budget — it never falls through
// to an UNLOCKED destructive write-back, which is what would let it race a
// live holder's own write-back. The budget is generous (~1.5s of spinning)
// so 'skip' is reached only in a genuinely pathological case (a live holder
// stuck mid critical-section for over a second — the read+trim+write of a
// small JSON file normally takes microseconds). When skipped, the caller
// falls back to a bare atomic appendFileSync (O_APPEND) so THIS line still
// lands in the common case — see that fallback's own comment for the one
// residual scenario where even that isn't guaranteed.
const AUDIT_LOCK_ATTEMPTS = 300;
const AUDIT_LOCK_DELAY_MS = 5;

// Exported for the audit-lock regression tests (tests/hooks-audit-lock.test.ts)
// — not part of the public hook-firing API, just the audit-write primitive
// itself. `lockOpts` lets tests shrink the spin budget instead of paying the
// full ~1.5s on every contended-path test; production callers never pass it.
export function appendAudit(
  home: string,
  line: AuditLine,
  lockOpts: { attempts?: number; delayMs?: number } = {},
): void {
  const file = auditFile(home);
  const jsonLine = JSON.stringify(line) + '\n';
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return; // best-effort; an audit failure must never break a send
  }

  const lockPath = `${file}.lock`;
  // body returns `true` on completion — 'skip' also resolves to `undefined`
  // (withRoutesLock's own not-acquired sentinel), so a truthy check is the
  // only way to tell "ran" from "skipped" apart (both would look like
  // `undefined` if body itself returned void).
  //
  // The WHOLE call is wrapped in try/catch (review finding): `writeFileSync`
  // can throw (ENOSPC/EACCES/EROFS), and `fsRoutesLockIo`'s own `acquire()`
  // deliberately re-throws any lock-open failure that ISN'T plain contention
  // (its own comment: "any other errno... is a hard failure: signal it by
  // THROWING so withRoutesLock doesn't waste the full spin budget" — its
  // caller is expected to catch). Letting either propagate out of
  // appendAudit would break the "an audit failure must never break a send"
  // invariant this whole module exists to uphold; the body itself also
  // swallows a write failure so a bad write still counts as "ran" (no
  // pointless fallback-append retry of a write that just failed the same way).
  let ran: true | undefined;
  try {
    ran = withRoutesLock(
      fsRoutesLockIo(lockPath),
      (): true => {
        try {
          let existing = '';
          try {
            existing = readFileSync(file, 'utf8');
          } catch {
            // first write — no existing file yet
          }
          // Review finding: below the cap, APPEND instead of rewriting the
          // whole file. We still read the file above to count lines (so we
          // know whether we're at the cap yet) — that read+split is O(file),
          // but the file is bounded at MAX_AUDIT_LINES short JSONL lines
          // (well under a MB), so it's sub-millisecond. What the fast path
          // actually saves is the far more expensive part: the temp-file
          // write + renameSync (extra open/write/rename syscalls) on EVERY
          // append. Only AT/OVER the cap do we pay for the full trim +
          // atomic temp-file+rename rewrite (a crash mid-write there can't
          // truncate the log). We hold the lock throughout, so the bare
          // appendFileSync on the fast path can't interleave with another
          // writer.
          const existingLines = existing === '' ? 0 : existing.split('\n').filter((l) => l.trim() !== '').length;
          if (existingLines < MAX_AUDIT_LINES) {
            appendFileSync(file, jsonLine);
          } else {
            const tmpFile = `${file}.tmp-${process.pid}`;
            writeFileSync(tmpFile, trimAuditLines(existing + jsonLine));
            renameSync(tmpFile, file);
          }
        } catch {
          // best-effort; an audit failure must never break a send
        }
        return true;
      },
      {
        attempts: lockOpts.attempts ?? AUDIT_LOCK_ATTEMPTS,
        delayMs: lockOpts.delayMs ?? AUDIT_LOCK_DELAY_MS,
        onContended: 'skip',
      },
    );
  } catch {
    ran = undefined; // fall through to the atomic-append fallback below
  }
  if (ran) return;

  // Pathological last resort: the spin budget above was exhausted by a LIVE
  // holder that never released (should not happen for a microsecond-scale
  // read+trim+write — see the header comment). Rotation is skipped this
  // round; fall back to a bare atomic append so THIS line still lands.
  try {
    appendFileSync(file, jsonLine);
  } catch {
    // best-effort; an audit failure must never break a send
  }
}

// Spawn a hook executable, write the event JSON to its stdin, enforce a timeout.
// exitCode null = the process was killed (timeout) or never started.
//
// IMPORTANT: Bun.spawnSync snapshots the env at PROCESS START and ignores later
// `process.env` mutations, so we pass the caller-provided `env` explicitly. This
// is correct for production (the hook sees the user's live PATH / config) and is
// required for tests that adjust PATH to install a mock hook target.
function spawnHook(
  cmd: string,
  args: string[],
  stdinJson: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): SpawnResult {
  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      stdin: new TextEncoder().encode(stdinJson),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      env: (env ?? process.env) as Record<string, string>,
    });
    // Bun sets exitCode null and signalCode on a timeout kill.
    const timedOut = proc.exitCode === null;
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
      timedOut,
    };
  } catch (e) {
    return {
      exitCode: null,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
      timedOut: false,
    };
  }
}

// Build the real RunnerDeps from the live environment.
export function buildRunnerDeps(env: NodeJS.ProcessEnv, home = homedir()): RunnerDeps {
  return {
    trust: loadTrust(home),
    // Trust-by-default: the TOFU quarantine + pin only re-engages under the
    // opt-in AGENTS_HOOKS_TRUST=1 guard. AGENTS_HOOKS_TRUST=auto (the legacy
    // batch escape) also implies the guard is in play — it just auto-trusts.
    untrustedGuard: untrustedGuardActive(env),
    trustAuto: trustAutoActive(env),
    sha256: sha256OfFile,
    sha256Str: sha256OfString,
    // Bind the caller's env so the hook subprocess resolves cmd/PATH against the
    // same environment the runner was given (Bun.spawnSync ignores live mutations
    // to process.env — see spawnHook).
    spawn: (cmd, args, stdinJson, timeoutMs) => spawnHook(cmd, args, stdinJson, timeoutMs, env),
    audit: (line) => appendAudit(home, line),
    warn: (msg) => console.error(`Warning: ${msg}`),
    now: () => Date.now(),
    isoNow: () => new Date().toISOString(),
  };
}

export interface PhotoHookInput {
  imagePath: string;
  caption?: string;
  chatId?: string;
}

// Run the pre-send-photo point for ONE photo. Returns the aggregate verdict.
// The caller (tg seam) iterates plan.photos and acts on `blocked`.
export function runPreSendPhotoHooks(input: PhotoHookInput, env: NodeJS.ProcessEnv, home = homedir()): HooksVerdict {
  const loaded = loadDescriptors('pre-send-photo', home);
  if (loaded.length === 0) {
    return { blocked: false, results: [] };
  }
  const deps = buildRunnerDeps(env, home);
  const buildEvent = (): HookEvent => ({
    hook_api: HOOK_API,
    event_id: freshEventId(),
    tool: TOOL,
    point: 'pre-send-photo',
    command: 'send-photo',
    cwd: process.cwd(),
    args: {
      image_path: input.imagePath,
      caption: input.caption ?? '',
      chat_id: input.chatId ?? '',
    },
  });
  return runHooks(loaded, buildEvent, deps);
}

// Convenience for the tg seam: given resolved disk-photo paths, run the gate for
// each and return the first block (path + message) if any. Memory-source photos
// (no disk path) are skipped — the gate inspects a file on disk.
export interface PhotoGateResult {
  blocked: boolean;
  blockedPath?: string;
  message?: string;
}

export function gatePhotos(
  diskPhotoPaths: string[],
  ctx: { caption?: string; chatId?: string },
  env: NodeJS.ProcessEnv,
  home = homedir(),
): PhotoGateResult {
  for (const imagePath of diskPhotoPaths) {
    if (!existsSync(imagePath)) continue;
    const verdict = runPreSendPhotoHooks({ imagePath, caption: ctx.caption, chatId: ctx.chatId }, env, home);
    if (verdict.blocked) {
      return { blocked: true, blockedPath: imagePath, message: verdict.blockMessage };
    }
  }
  return { blocked: false };
}
