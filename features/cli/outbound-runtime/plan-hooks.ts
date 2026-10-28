// pre-send-photo / pre-send-text hook gates of the send plan (tg-cli#817, baseline `tg` 2521-2561, 2758-2777).
//
// agents-hooks/v1. NON-BREAKING SEAM: guarded by ONE `stat ~/.agents/hooks/tg/` (hooksActive). With no
// descriptors dir the whole block is skipped and the send path is byte-for-byte today's behaviour.
// A `block` (a hook exits 10) HOLDS the send; everything else (hook error, timeout) fails open per the
// runner policy.
// SECURITY: descriptors are trust-by-default — a drop-in names an executable that runs on EVERY send,
// with no trust step. Only the user / their own tools should ever write to ~/.agents/hooks/tg/.
// AGENTS_HOOKS_TRUST=1 re-engages the TOFU quarantine for the rare untrusted-input case.
import type { FeatureMap } from "../../auto-attach/feature-flags"
import type { SendPlan } from "../../auto-attach/types"
import { gatePhotos, hooksActive } from "../../hooks/run-photo-hooks"
import { gateText } from "../../hooks/run-text-hooks"
import type { MergedEnv } from "./types"

/**
 * Photo hooks fire ONLY on the photo subcommand — plain `tg "msg"` never reaches them.
 * `env` is the merged config+process env, so AGENTS_HOOKS=0 / AGENTS_HOOKS_TRUST=auto / API keys set
 * in ~/.config/tg-cli/.env are honored and forwarded to the hook subprocess.
 * NOTE on `caption`: this is the RAW parsed caption, BEFORE the autolink / line-spec transforms mutate
 * plan.textMessages[0]. The gate sits before those mutations to keep the non-breaking seam in one clean
 * place and gate on the IMAGE — the shipped `review visual` hook judges the screenshot and ignores
 * caption. A future hook that needs the FINAL rendered caption should read the image, not this caption.
 */
export function runPhotoHookGate(
  plan: SendPlan,
  features: FeatureMap,
  caption: string,
  chatId: string | undefined,
  env: MergedEnv,
): void {
  if (features["hooks"] === false || plan.photos.length === 0 || !hooksActive(env)) return
  const diskPhotoPaths = plan.photos.flatMap((p) => (p.source.kind === "disk" ? [p.source.path] : []))
  const gate = gatePhotos(diskPhotoPaths, { caption, chatId }, env)
  if (!gate.blocked) return
  console.error(
    `Blocked: pre-send-photo hook rejected ${gate.blockedPath}` + (gate.message ? `\n  ${gate.message}` : ""),
  )
  process.exit(10)
}

/**
 * The `pre-send-text` sibling of the photo gate: same `hooksActive` guard, same trust-by-default /
 * fail-open policy. Fires for EVERY text message in the plan (plain `tg "msg"` included, not just photo
 * captions), on the FINAL assembled body — after render/autolink/line-spec quotes, right before the
 * transmitter splits/sends it, so a hook sees exactly what the recipient will read. Every entry is gated
 * (gating only textMessages[0] silently skipped any later text message the plan carries), mirroring
 * gatePhotos looping over every disk photo.
 */
export function runTextHookGate(
  plan: SendPlan,
  features: FeatureMap,
  tag: string | undefined,
  chatId: string | undefined,
  env: MergedEnv,
): void {
  if (features["hooks"] === false || !hooksActive(env)) return
  for (const tm of plan.textMessages) {
    const gate = gateText(tm.text, { tag, chatId }, env)
    if (!gate.blocked) continue
    console.error(`Blocked: pre-send-text hook rejected the message` + (gate.message ? `\n  ${gate.message}` : ""))
    process.exit(10)
  }
}
