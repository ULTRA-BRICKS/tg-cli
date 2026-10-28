// Model-render dimension gate runner (features/cli/dimension-gate.ts, tg-cli#785).
//
// An image sent from a 3D context (a 3D project cwd/path, or a caption naming 3D work) must carry
// legible dimensions: a `<image>.dims.json` sidecar from `3d dimension` that passes
// `3d dimension --check`. Same senders as the unattached-file gate (agents, not --automated). It
// runs AFTER the other local gates and before --dry-run, so an owner approval is never spent on a
// message a later gate would still refuse. The only way past it for a non-model image is a written
// reason in RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP, sent to the owner as one approval request —
// never under --dry-run, which makes no network call.
import { existsSync } from "fs"
import { join } from "path"
import type { DictionaryField } from "../dict-gate"
import {
  decideDimensionGate,
  type CheckResult,
  type DimensionDecision,
  formatDimensionGateError,
  type ImageVerdict,
  isWrittenReason,
  realOr,
  SKIP_ENV as DIMENSION_SKIP_ENV,
  skipRequestText as dimensionSkipRequestText,
  verifyImages,
} from "../dimension-gate"
import type { MergedEnv, RuntimePaths, SendAction } from "./types"

/** `3d dimension --check` for one image; the verdict input of `verifyImages`. */
function runDimensionCheck(path: string, env: MergedEnv): CheckResult {
  try {
    const res = Bun.spawnSync(["3d", "dimension", "--check", path], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: 60_000 })
    return { code: res.exitCode ?? null, output: `${res.stdout.toString()}${res.stderr.toString()}` }
  } catch (err) {
    // Bun throws when the executable is not on PATH: the check could not run.
    return { code: null, output: String(err) }
  }
}

/**
 * The owner's answer to the skip request. The approver is the tg-ctl next to this tg — no env
 * override, or an agent could name its own.
 */
function askOwnerApproval(request: string, env: MergedEnv, rootDir: string): { approved: boolean; askStderr: string } {
  try {
    // `--timeout 300` bounds the owner's answer; the spawn timeout bounds a hung tg-ctl itself.
    const ask = Bun.spawnSync([join(rootDir, "tg-ctl"), "ask", request, "--timeout", "300"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: 330_000 })
    return { approved: ask.exitCode === 0, askStderr: ask.stderr.toString().trim() }
  } catch (err) {
    return { approved: false, askStderr: `could not ask the owner: ${String(err)}` }
  }
}

function refuseWithoutApproval(refusal: string, askStderr: string): never {
  console.error(refusal)
  if (askStderr !== "") console.error(`tg-ctl ask: ${askStderr}`)
  console.error("Blocked: nothing was sent.")
  return process.exit(1)
}

/** Failing images: refuse, unless a written skip reason is approved by the owner (never under dry-run). */
function resolveDimensionFailure(
  scope: DimensionDecision,
  verdicts: ImageVerdict[],
  send: SendAction,
  env: MergedEnv,
  rootDir: string,
): void {
  const reason = env[DIMENSION_SKIP_ENV]
  const refusal = `Error: ${formatDimensionGateError(scope.contexts, verdicts, reason, send.dryRun)}`
  if (!isWrittenReason(reason)) {
    console.error(refusal)
    process.exit(1)
  }
  const request = dimensionSkipRequestText(reason, scope.images, scope.contexts)
  if (send.dryRun) {
    console.error(`${refusal}\n${request}`)
    process.exit(1)
  }
  const { approved, askStderr } = askOwnerApproval(request, env, rootDir)
  if (!approved) refuseWithoutApproval(refusal, askStderr)
  console.error(`tg: dimension gate skipped with the owner's approval (${reason.trim()}).`)
}

export function runDimensionGate(
  send: SendAction,
  dictFields: DictionaryField[],
  env: MergedEnv,
  paths: RuntimePaths,
): void {
  // The authored fields, as the neighbouring gates read them: the rendered caption hides --table rows in a <pre>.
  const scope = decideDimensionGate(dictFields.map((field) => field.text).join("\n"), send.items, {
    cwd: process.cwd(),
    home: paths.home,
    exists: existsSync,
    real: realOr,
  })
  if (scope.contexts.length === 0) return
  const verdicts = verifyImages(scope.images, { exists: existsSync, real: realOr, check: (path) => runDimensionCheck(path, env) })
  if (verdicts.some((v) => v.problems.length > 0)) resolveDimensionFailure(scope, verdicts, send, env, paths.rootDir)
}
