// autolink transform of the send plan body (tg-cli#817, baseline `tg` 2564-2603).
//
// Tasks + PRs + message refs: linkify verified Linear codes and GitHub #N refs, then append reference
// blocks. Single ticket → title on the first line; several tickets / any GitHub issue → a collapsed
// block (tickets then issues); PRs → their own collapsed block after that. Runs BEFORE line-spec quote
// insertion so injected <pre> bodies are never linkified. plan.textMessages[0] also covers the
// media-caption ride — the transmitter promotes that same message to a caption. hasAutolink forced HTML
// in renderText, so the body is already escaped/rendered HTML here.
import { applyAutolink, linkifyTicketsCompound } from "../../autolink-tasks/render"
import { buildEntries, linkifyRefsCompound } from "../../autolink-prs/render"
import {
  detectLinkableMsgRefs,
  linkifyMsgRefs,
  msgRefUrl,
  resolveMsgRefs,
  type MsgRefRender,
} from "../../autolink-msgrefs/render"
import type { SendPlan } from "../../auto-attach/types"
import { styleTaskTitle } from "../../prefix-style/style"
import type { PrefixParts } from "../../render/prefix"
import type { AutolinkFindings } from "./types"

/** `tg#<id>` resolution over the body: previews + bottom excerpt entries (empty when no msgrefs). */
function resolveBodyMsgRefs(
  body: string,
  autolinks: AutolinkFindings,
  currentChatId: number | undefined,
  msgRefUrlFor: (id: number) => string | null,
): MsgRefRender {
  const linkableMsgRefIds = autolinks.hasMsgRefs ? detectLinkableMsgRefs(body) : []
  return resolveMsgRefs(
    autolinks.readMsgRefHistory(linkableMsgRefIds),
    linkableMsgRefIds,
    msgRefUrlFor,
    currentChatId,
    autolinks.msgRefPreviewOn,
  )
}

export function applyAutolinkToPlan(
  plan: SendPlan,
  autolinks: AutolinkFindings,
  prefix: PrefixParts,
  currentChatId: number | undefined,
): void {
  if (!autolinks.hasAutolink || plan.textMessages.length === 0) return
  const { tickets, refs, refOrder, hasTickets, hasRefs, hasMsgRefs } = autolinks
  const { issues, prs } = buildEntries(refs, refOrder)
  // tg#28 / tg-cli#116: the `tg#<id>` pass runs LAST over the body (linkifyLast),
  // after the ticket/#N passes — a quoted preview is arbitrary user text and must
  // never be linkified by them. They leave a raw `tg#3715` alone (their boundary
  // rule rejects the `g` before `#`), so it is never offered to the PR resolver.
  // A previewed id leaves the bottom excerpt block; the others keep their entry.
  const body = plan.textMessages[0].text
  const msgRefUrlFor = (id: number) => msgRefUrl(currentChatId, id)
  const msgRefs = resolveBodyMsgRefs(body, autolinks, currentChatId, msgRefUrlFor)
  plan.textMessages[0] = {
    text: applyAutolink(body, tickets, prefix.present, {
      linkifyTickets: hasTickets
        ? (html: string): string => linkifyTicketsCompound(html, new Map(tickets.map((t) => [t.code, t])))
        : undefined,
      linkify: hasRefs ? (html: string): string => linkifyRefsCompound(html, refs) : undefined,
      linkifyLast: hasMsgRefs ? (html: string): string => linkifyMsgRefs(html, msgRefUrlFor, msgRefs.previews) : undefined,
      issues: [...msgRefs.entries, ...issues],
      prs,
      styleTitle: styleTaskTitle,
    }),
    format: "html",
  }
}
