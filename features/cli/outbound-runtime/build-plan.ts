// Build the SendPlan of one outbound send (tg-cli#817, baseline `tg` 2435-2777).
//
// The stages mutate one plan object in place (later stages — transmit, the recorder — read it through
// the object, e.g. `plan.documents` is reassigned), in the baseline's forced order:
// line-spec planning → render hook → R2 contents → buildSendPlan → photo hooks → autolink →
// line-spec quotes + marker copies → skip unusable attachments → code-as-pdf → md-as-pdf →
// empty-message check → text hooks.
import type { FileCheckDeps } from "../../auto-attach/file-check"
import { planLineSpecs } from "../../auto-attach/line-spec"
import { buildSendPlan } from "../../auto-attach/normalize"
import { buildPrefix } from "../../render/prefix"
import { applyAutolinkToPlan } from "./plan-autolink"
import { applyLineSpecs, skipUnusableAttachments } from "./plan-attachments"
import { runPhotoHookGate, runTextHookGate } from "./plan-hooks"
import { applyCodePdfPass, applyMdPdfPass, makePdfDeps } from "./plan-pdf"
import { createRenderText, readDocumentContents, readText } from "./plan-render"
import type { AutolinkFindings, BuiltPlan, FeatureMap, PreparedMessage, SendAction, SenderContext } from "./types"

export function buildPlan(
  send: SendAction,
  prepared: PreparedMessage,
  sender: SenderContext,
  autolinks: AutolinkFindings,
  features: FeatureMap,
  fileCheckDeps: FileCheckDeps,
): BuiltPlan {
  const { items, tag, withOriginal, noPdf, pdfDevice } = send
  const { caption, effectiveFormat } = prepared
  const { env } = sender

  // Line-spec quotes + marker-injected copies (in-memory): for each text-readable item that carried a
  // trailing line-spec, a TG quote of the referenced range ±2 (AST-aware) goes directly below the path
  // mention in the caption, and an in-memory copy of the whole file with marker comments around the
  // range REPLACES the disk source (never touches the original). Images with a line-spec are attached
  // as-is. Pure `planLineSpecs` (features/auto-attach/line-spec.ts) does the work with a disk reader.
  const lsPlan = planLineSpecs(items, readText)
  const prefix = buildPrefix({
    aiEmoji: sender.aiEmoji,
    model: sender.model,
    tmuxWindow: prepared.sessionNamePrimary,
    agentLabel: prepared.agentLabel,
    tag,
    title: prepared.title,
  })
  const renderText = createRenderText({
    prefix,
    hasQuotes: lsPlan.quotes.length > 0,
    hasAutolink: autolinks.hasAutolink,
  })

  // Normalization layer: R2/R3/R4 + render.
  const plan = buildSendPlan(items, caption, effectiveFormat, {
    fileContents: readDocumentContents(items),
    renderText,
  })

  runPhotoHookGate(plan, features, caption, sender.chatId, env)
  applyAutolinkToPlan(plan, autolinks, prefix, sender.currentChatId)
  applyLineSpecs(plan, lsPlan)
  skipUnusableAttachments(plan, fileCheckDeps)

  const pdfTempDirs: string[] = [] // dirs to rm after transmit (both PDF passes)
  const pdfDeps = makePdfDeps(env)
  applyCodePdfPass(plan, features, { noPdf, pdfDevice, withOriginal }, pdfDeps, env, pdfTempDirs)
  applyMdPdfPass(plan, features, pdfDeps, pdfTempDirs)

  if (plan.photos.length === 0 && plan.documents.length === 0 && plan.textMessages.length === 0) {
    console.error("Error: no message text provided")
    process.exit(1)
  }

  runTextHookGate(plan, features, tag, sender.chatId, env)
  return { plan, pdfTempDirs }
}
