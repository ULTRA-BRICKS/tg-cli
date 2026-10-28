// daemon-runtime/late-taps-hatch: grant protocol v1.1 (tg-cli#398) — a late tap on an EXPIRED hatch card.
// Split out of late-taps.ts (guardian-817): handleHatchLateTap's statements keep their original order and text,
// grouped into named steps (late deny, late approve, mint, notice). `LateTapsContext` carries what the
// original closure reached directly.
import { hatchGrantApprovedText, hatchParseMode, buildAnsweredQuestionText, type ButtonAnswer, type ButtonRequest } from "../questions"
import { CLOSE_STATUS, hatchSiblingsOf } from "../question-inbox"
import { buildGrantRecord, closeDecidedCard, hatchDenyNoticeText, hatchGrantNoticeText, isGrantableRequest, retireGraceRecord, routeForRequest } from "../grants"
import type { Action } from "../types"
import { log } from "./ctx-io"
import { GRACE_WINDOW_MS, GRANT_TTL_MS, decidedRetainMs, describeAskRequest } from "./button-requests"
import { answerCallbackQuery, answerCallbackQueryOrNotify, clearMessageKeyboard, editMessageText } from "./telegram-api"
import { routeGrantNotice } from "./stranded-inbox"
import type { Ctx } from "./ctx-io"
import type { QuestionInboxApi } from "./question-inbox-runtime"
import type { StartupApi } from "./daemon-startup"
import type { DeferQueueApi } from "./defer-queue"
import type { TargetRoutingApi } from "./target-routing"

/** Everything the late-tap flows reach that the original runDaemon closure held directly. */
export interface LateTapsContext {
  ctx: Ctx
  persistQuestions: QuestionInboxApi["persistQuestions"]
  grantsData: QuestionInboxApi["grantsData"]
  persistGrants: QuestionInboxApi["persistGrants"]
  answeredButtons: StartupApi["answeredButtons"]
  abandonedButtons: StartupApi["abandonedButtons"]
  closableCards: StartupApi["closableCards"]
  shouldDeferInbound: DeferQueueApi["shouldDeferInbound"]
  onQuestionReleased: DeferQueueApi["onQuestionReleased"]
  closeOpenCard: DeferQueueApi["closeOpenCard"]
  replyContext: TargetRoutingApi["replyContext"]
}

export type AnswerQuestionAction = Extract<Action, { kind: "answer-question" }>
export type GivenAnswer = Extract<ButtonAnswer, { status: "answered" }>
type GrantRecord = QuestionInboxApi["grantsData"]["grants"][number]

// Nothing a tap does on this card can change any more: retire its buttons and say why on the card.
function retireCardWithText(lc: LateTapsContext, cardId: number | null, text: string): void {
  if (cardId === null) return
  void clearMessageKeyboard(lc.ctx, cardId)
  void editMessageText(lc.ctx, cardId, text)
}

function closeDecidedSiblings(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest): void {
  for (const key of hatchSiblingsOf(lc.closableCards(), req, action.requestId)) lc.closeOpenCard(key, CLOSE_STATUS.decided)
}

// A Deny is FINAL (tg-cli#433): retire the grace record so no later tap on this
// card — a raced or duplicate Approve, a text reply — can mint, record the card as
// decided so a restart that still finds it in the best-effort questions store does
// not re-open it, and revoke a grant an earlier Approve minted that the agent has
// not consumed yet. Durable BEFORE the denial is confirmed (the mint's fail-closed
// rule): a lost write rolls back and asks for another tap. Returns false when the write failed
// (the user has been told to tap again).
async function recordLateDeny(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, grant: GrantRecord | null, now: number): Promise<boolean> {
  const { ctx, grantsData, persistGrants } = lc
  const grantIndex = grant ? grantsData.grants.indexOf(grant) : -1
  if (grant) grantsData.grants.splice(grantIndex, 1)
  const undoClose = closeDecidedCard(grantsData, action.requestId, "deny", now, decidedRetainMs(req))
  if (!persistGrants()) {
    undoClose()
    if (grant) grantsData.grants.splice(grantIndex, 0, grant)
    log(`hatch-late-deny-failed: ${describeAskRequest(req)} key=${action.requestId} — grant store write failed`)
    await answerCallbackQueryOrNotify(ctx, action, "could not record the denial — tap again")
    return false
  }
  return true
}

/**
 * Proactive delivery (tg-cli#403 (d)): the requester learns the outcome instead
 * of waiting. Past the grace window the ask is long dead and a notice is noise —
 * unless it carries a revocation the agent must hear about.
 */
export function lateDenyNoticeWanted(now: number, expiredAt: number, revokedApprovalId: string | null): boolean {
  return now < expiredAt + GRACE_WINDOW_MS || revokedApprovalId !== null
}

/** The callback toast confirming a late deny: what was revoked and whether the agent was told. */
export function lateDenyToast(revokedApprovalId: string | null, shouldNotify: boolean, delivered: boolean): string {
  const told = delivered ? " — the agent was told" : shouldNotify ? " — could not reach the agent" : ""
  return revokedApprovalId ? `denied — grant ${revokedApprovalId} revoked${told}` : `denied${told}`
}

async function announceLateDeny(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, revoked: string | null, now: number, expiredAt: number): Promise<void> {
  const { ctx } = lc
  const shouldNotify = lateDenyNoticeWanted(now, expiredAt, revoked)
  const delivered = shouldNotify
    ? await routeGrantNotice(
        ctx,
        req,
        hatchDenyNoticeText({ requestId: req.requestId, question: req.question, deniedAt: now, revokedApprovalId: revoked }),
        `deny:${req.requestId}`,
      )
    : false
  log(`hatch-late-deny: ${describeAskRequest(req)} key=${action.requestId} revoked=${revoked ?? "-"} notice=${shouldNotify ? (delivered ? "delivered" : "failed") : "-"}`)
  await answerCallbackQuery(ctx, action.callbackQueryId, lateDenyToast(revoked, shouldNotify, delivered))
  closeDecidedSiblings(lc, action, req)
}

async function handleHatchLateDeny(
  lc: LateTapsContext,
  action: AnswerQuestionAction,
  req: ButtonRequest,
  cardId: number | null,
  answer: GivenAnswer,
  now: number,
  expiredAt: number,
): Promise<boolean> {
  const { ctx, grantsData } = lc
  const grant = grantsData.grants.find((g) => g.request_id === req.requestId) ?? null
  if (grant && grant.consumed_at !== null) {
    log(`hatch-late-deny-too-late: ${describeAskRequest(req)} key=${action.requestId} approvalId=${grant.approval_id} — grant already used`)
    // Nothing a tap does on this card can change any more: retire its buttons.
    if (cardId !== null) void clearMessageKeyboard(ctx, cardId)
    await answerCallbackQueryOrNotify(ctx, action, `too late to deny — grant ${grant.approval_id} was already used`)
    return true
  }
  if (!(await recordLateDeny(lc, action, req, grant, now))) return true
  const revoked = grant?.approval_id ?? null
  if (cardId !== null) {
    const label = revoked ? `${answer.label} — grant ${revoked} revoked` : answer.label
    void editMessageText(ctx, cardId, buildAnsweredQuestionText(req, label), undefined, hatchParseMode(req))
  }
  await announceLateDeny(lc, action, req, revoked, now, expiredAt)
  return true
}

// Beyond the 24h grace window: NO grant (contract §4's too-late branch).
// Retire the stale grace record so this card can never mint later. A card
// whose Approve already minted a grant still unused keeps its record (it
// outlives the window so a Deny can revoke that grant) and re-routes the
// grant instead.
async function refuseLateApproveTooLate(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, cardId: number | null, now: number, expiredAt: number): Promise<void> {
  if (retireGraceRecord(lc.grantsData.grace, action.requestId)) lc.persistGrants()
  retireCardWithText(lc, cardId, "too late — the 24h late-approval window has closed; the agent must request approval again")
  log(`hatch-grant-too-late: ${describeAskRequest(req)} key=${action.requestId} ageMs=${now - expiredAt}`)
  await answerCallbackQuery(lc.ctx, action.callbackQueryId, "too late — the agent must re-request")
}

// Fail-closed mint gate: a grant is useless unless it can be BOUND (an
// old-lib ask carries no hookId/operation fields — grants.ts's
// isGrantableRequest). Tell the user plainly instead of minting an
// unconsumable grant.
async function refuseUngrantableApprove(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, cardId: number | null): Promise<void> {
  retireCardWithText(
    lc,
    cardId,
    "this expired request came from an older agent-tools version without grant fields — a late approval cannot be bound to it; the agent must re-request",
  )
  log(`hatch-grant-not-grantable: ${describeAskRequest(req)} key=${action.requestId} — no hookId/operation on the ask`)
  await answerCallbackQuery(lc.ctx, action.callbackQueryId, "cannot grant — the agent must re-request")
}

// Double-mint guard: this approval was already USED — never mint another.
async function refuseApproveAlreadyUsed(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, cardId: number | null, grant: GrantRecord): Promise<void> {
  retireCardWithText(lc, cardId, `grant ${grant.approval_id} was already used — grants are single-use; the agent must re-request`)
  log(`hatch-grant-already-used: ${describeAskRequest(req)} key=${action.requestId} approvalId=${grant.approval_id}`)
  await answerCallbackQuery(lc.ctx, action.callbackQueryId, "a grant for this request was already used")
}

// Mint a fresh single-use grant. Durable BEFORE confirming (single-use invariant): a failed write rolls
// the mint back — the user is told to tap again rather than being handed an approval a restart would
// lose. Returns null when the write failed (already answered).
async function mintGrant(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, now: number): Promise<GrantRecord | null> {
  const { ctx, grantsData, persistGrants } = lc
  const approvalId = `hgr-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}`
  const grant = buildGrantRecord(req, approvalId, routeForRequest(req), now, GRANT_TTL_MS)
  grantsData.grants.push(grant)
  if (!persistGrants()) {
    grantsData.grants.pop()
    log(`hatch-grant-mint-failed: ${describeAskRequest(req)} key=${action.requestId} — grant store write failed`)
    await answerCallbackQueryOrNotify(ctx, action, "could not record the grant — tap again")
    return null
  }
  log(
    `hatch-grant-minted: ${describeAskRequest(req)} key=${action.requestId} hookId=${grant.hook_id} approvalId=${grant.approval_id} route=${grant.route ?? "-"}`,
  )
  return grant
}

// Route the consume-instructions notice (a first mint, or a re-tap re-routing an unconsumed grant),
// confirm on the card, and close the decided card's siblings.
async function announceGrant(lc: LateTapsContext, action: AnswerQuestionAction, req: ButtonRequest, cardId: number | null, grant: GrantRecord): Promise<void> {
  const { ctx } = lc
  const notice = hatchGrantNoticeText({
    requestId: req.requestId,
    question: req.question,
    hookId: grant.hook_id,
    approvalId: grant.approval_id,
    approvedAt: grant.approved_at,
    expiresAt: grant.expires_at,
  })
  const delivered = await routeGrantNotice(ctx, req, notice, `grant:${grant.approval_id}`)
  if (cardId !== null) {
    void clearMessageKeyboard(ctx, cardId)
    void editMessageText(ctx, cardId, hatchGrantApprovedText(req, grant.approval_id, delivered), undefined, hatchParseMode(req))
  }
  log(`hatch-grant-notice-${delivered ? "delivered" : "failed"}: approvalId=${grant.approval_id} route=${grant.route ?? "-"} key=${action.requestId}`)
  await answerCallbackQuery(
    ctx,
    action.callbackQueryId,
    delivered ? "✓ grant issued and sent to the agent" : "grant issued — could not reach the agent (the token path still works)",
  )
  closeDecidedSiblings(lc, action, req)
}

async function handleHatchLateApprove(
  lc: LateTapsContext,
  action: AnswerQuestionAction,
  req: ButtonRequest,
  cardId: number | null,
  now: number,
  expiredAt: number,
): Promise<boolean> {
  const { grantsData } = lc
  const unusedGrant = grantsData.grants.some((g) => g.request_id === req.requestId && g.consumed_at === null)
  if (now >= expiredAt + GRACE_WINDOW_MS && !unusedGrant) {
    await refuseLateApproveTooLate(lc, action, req, cardId, now, expiredAt)
    return true
  }
  if (!isGrantableRequest(req)) {
    await refuseUngrantableApprove(lc, action, req, cardId)
    return true
  }
  let grant = grantsData.grants.find((g) => g.request_id === req.requestId) ?? null
  if (grant && grant.consumed_at !== null) {
    await refuseApproveAlreadyUsed(lc, action, req, cardId, grant)
    return true
  }
  if (!grant) {
    grant = await mintGrant(lc, action, req, now)
    if (grant === null) return true
  }
  // An unconsumed grant already existed (a re-tap — e.g. after a delivery
  // failure or a duplicate tap): RE-ROUTE the notice instead of minting.
  await announceGrant(lc, action, req, cardId, grant)
  return true
}

// Grant protocol v1.1 (tg-cli#398): a late tap on an EXPIRED hatch card. This
// REPLACES the old silent queuedDecision mechanism for hatch requests, which
// authorized ANY later operation behind the same hookId. A late Approve inside
// the 24h grace window mints a single-use grant (bound to hook_id + operation
// fingerprint + cwd + the daemon-observed route), confirms on the card, and
// routes the contract's consume-instructions message to the origin (omp ACP /
// inbox — never a live permission menu, the exact no-menu skip this fixes); a
// tap beyond grace is told it is too late (the agent must re-request) and
// mints NOTHING. A belated Deny is final: it retires the grace record, revokes
// an unconsumed grant an earlier Approve minted, and routes a deny notice to
// the same origin (tg-cli#433, #403). `expiredAt` is the ask's
// expiry moment (the grace anchor): the card's grace record's `expiredAt` whenever it
// has one — a restored pending ask's retained `at` is its posting time, not its expiry
// (tg-cli#510) — else the retained entry's `at`.
export async function handleHatchLateTap(
  lc: LateTapsContext,
  action: AnswerQuestionAction,
  req: ButtonRequest,
  cardId: number | null,
  answer: GivenAnswer,
  expiredAt: number,
): Promise<boolean> {
  const now = Date.now()
  if (answer.decision === "deny") return handleHatchLateDeny(lc, action, req, cardId, answer, now, expiredAt)
  return handleHatchLateApprove(lc, action, req, cardId, now, expiredAt)
}
