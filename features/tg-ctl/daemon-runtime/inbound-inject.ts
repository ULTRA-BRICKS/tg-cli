// daemon-runtime/inbound-inject: injecting inbound text into panes and posting pickers.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { buildAgentSelectMessage, distinctLabels, matchWindows, goneAgentFallbackReplyText, type AgentCandidate, type ParsedAgentCommand } from "../agent-match"
import { matchUnreachable, outsideTmuxRefusalText } from "../unreachable"
import { liveOmpLabel, liveOmpForPane, matchLiveOmp, preferOmpApiOverTmux } from "../omp"
import { sessionAtPane } from "../session-target"
import type { SessionEntry } from "../session-registry"
import { CLOSE_STATUS, sessionCardKeys } from "../question-inbox"
import type { DiscoverResult, InjectStep, TargetPane } from "../types"
import { log } from "./ctx-io"
import { deliverOriginalOmp, injectInbound } from "./delivery"
import { injectPrewrappedToPaneWith, injectWrappedToPane, routableText, type PaneDeliveryEnv, type PaneInjectOutcome, type PrewrappedOptions } from "./inbound-inject-delivery"
import { editMessageText, sendMessage } from "./telegram-api"
import { currentSessionRegistry, listLiveOmpAgents } from "./session-registry"
import { describeOmpLines, listAgentCandidates, listUnreachableAgents, noAgentReplyNow, resolveLastUserTargetCandidate } from "./pane-discovery"
import { readTmuxServerPid, snapshot } from "./tmux-probe"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { StartupApi } from "./daemon-startup"
import type { TargetRoutingApi } from "./target-routing"
import type { DeferQueueApi } from "./defer-queue"
import type { PickerApi } from "./picker-state"
import type { ReactionsApi } from "./ack-reactions"
import type { LateApi } from "./late-api"

// The registry key of the session at a tmux pane, only when that entry is on the daemon's own tmux
// server (`serverPid`; null = unknown, trust it). An entry from another server is another session's.
export function sessionKeyAtPaneOnServer(entry: SessionEntry | null, serverPid: number | null): string | undefined {
  if (!entry) return undefined
  return serverPid === null || entry.locators.tmux?.serverPid === serverPid ? entry.key : undefined
}

export type InboundInjectDeps = {
  ctx: Ctx
  state: DaemonState
  startup: StartupApi
  targetRouting: TargetRoutingApi
  deferQueue: DeferQueueApi
  picker: PickerApi
  reactions: ReactionsApi
  late: Pick<LateApi, "executeAction" | "handlePostTimeoutQuestionReply">
}

export function createInboundInject(d: InboundInjectDeps) {
  const { ctx, state } = d
  const { pendingButtons, abandonedButtons, openCards } = d.startup
  const { recordLastUserTarget, discover, discoverForInject, replyContext, candidatesForPicker, replyNoAgent } = d.targetRouting
  const { shouldDeferInbound, enqueueDeferred, markDeferredForAck } = d.deferQueue
  const { armPendingAgent, SELECTED_AGENT_TTL_MS, cancelSelectedAgentRoute, cancelSelectedAgentRouteForAgentCommand } = d.picker
  const { queueAckReaction, DEFER_REACTION } = d.reactions
  const { executeAction, handlePostTimeoutQuestionReply } = d.late
  const deliveryEnv: PaneDeliveryEnv = { ctx, recordLastUserTarget, shouldDeferInbound, enqueueDeferred, markDeferredForAck }

  // tg-cli#705: a plain message typed to a session that has open cards. With exactly ONE open
  // card, the message is the answer to it — a live card answers its asker (a question takes the
  // text, a permission reads yes/no, any other text denies with the text as the reason); a
  // retained question is typed into its pane as the answer. A retained permission or hatch card
  // is never decided from chat. With several open cards nothing is guessed: the human is asked
  // once to reply to the card he means, and the message takes its normal path. True when the
  // message was consumed as an answer (the caller delivers nothing else).
  const answerOpenCardInChat = async (
    paneId: string,
    plain: string | undefined,
    sourceMessageId: number | null,
    threadId: number | null,
    sessionKey?: string,
  ): Promise<boolean> => {
    if (plain === undefined || !plain.trim() || sourceMessageId === null) return false
    // The pane is on the daemon's own tmux server (every inject goes there): a card from the
    // same pane id on another server is another session's, and so is a registry entry for that
    // pane id on another server (tg-cli#722).
    const serverPid = readTmuxServerPid()
    const reg = sessionKey === undefined ? currentSessionRegistry() : null
    const paneKey = sessionKeyAtPaneOnServer(reg ? sessionAtPane(reg, paneId) : null, serverPid)
    const cards = sessionCardKeys(openCards(), { sessionKey: sessionKey ?? paneKey, paneId, serverPid })
    if (cards.length === 0) return false
    const thread = threadId !== null ? { threadId } : {}
    if (cards.length > 1) {
      await sendMessage(
        ctx,
        `this session has ${cards.length} open questions — reply to the card you mean`,
        replyContext(threadId),
      )
      return false
    }
    return answerSoleOpenCard(cards[0], plain, sourceMessageId, thread)
  }

  // The one open card of a session takes the chat text as its answer (see answerOpenCardInChat).
  const answerSoleOpenCard = async (
    cardKey: string,
    plain: string,
    sourceMessageId: number,
    thread: { threadId?: number },
  ): Promise<boolean> => {
    // An owner-only card is never answered from bare chat text: no verified actor there.
    if ((pendingButtons.get(cardKey) ?? abandonedButtons.get(cardKey))?.req.ownerOnly) return false
    const pending = pendingButtons.get(cardKey)
    if (pending) {
      log(`ask-answered-in-chat: key=${cardKey} source=${sourceMessageId}`)
      await executeAction(
        { kind: "answer-question", callbackQueryId: "", requestId: cardKey, value: "", messageId: pending.messageId, freeText: plain, ...thread },
        true,
      )
      return true
    }
    const retained = abandonedButtons.get(cardKey)
    if (!retained || retained.req.kind !== "question" || !retained.req.paneId || retained.req.multiQuestion || retained.messageId === null) return false
    log(`ask-answered-in-chat: key=${cardKey} source=${sourceMessageId} (retained question → pane)`)
    await handlePostTimeoutQuestionReply(
      { kind: "post-timeout-question-reply", requestId: cardKey, questionMessageId: retained.messageId, text: plain, from: "tg", messageId: sourceMessageId, ...thread },
      CLOSE_STATUS.answeredInChat(plain.trim()),
    )
    return true
  }

  // Pick a target, run the plan; every failure mode turns into a TG reply so
  // the human is never left wondering whether the message landed. Returns
  // true only when the plan actually executed — the caller uses it to decide
  // whether the source message earns its 👀 delivery receipt.
  //
  // `autoBind` (default off, tg-cli#78) opts a HARMLESS content inject
  // (text/photo/voice) into the no-reply last-message bind: an otherwise-ambiguous
  // non-reply message lands on the agent of the LAST MESSAGE in the chat FIRST
  // (discoverForInject), so the picker below fires LESS often. It is OFF for control
  // keys (/stop's Escape) — interrupting a GUESSED agent is the wrong default; an
  // ambiguous control verb asks.
  //
  // When the target is STILL ambiguous (auto-bind off, or no last message to prefer)
  // and the inject carries routable text, it posts the agent PICKER (tappable buttons,
  // tg-cli#76) and arms the pending route — a tap injects `deferText` verbatim, exactly
  // like the /agent picker. A control verb with no text (inject-key /stop) has nothing
  // to route through a tap, so it falls back to the picker WITHOUT a pending route
  // (select-only) — the buttons still tell the human which agents are live, not a
  // text dump.
  // `buildPlan` receives the resolved TargetPane (not a bare paneId): the git-state-check banner
  // (git-state.ts) needs the pane's `panePath` (cwd) to check, and that path only exists on the
  // TargetPane `found` resolves to HERE — never re-`discover()`/re-`snapshot()` inside a caller to
  // look it up by paneId alone, which would race against (and could disagree with) the pane this
  // function actually delivers into.
  const injectViaTarget = async (
    buildPlan: (target: TargetPane) => InjectStep[],
    deferText?: string,
    autoBind = false,
    sourceMessageId: number | null = null,
    // The user's own words of a plain message (tg-cli#705): may answer the target's open card.
    plain?: string,
  ): Promise<boolean> => {
    const found = autoBind ? discoverForInject() : discover()
    if (!found.ok) return injectWithoutTarget(found, deferText, autoBind, sourceMessageId, plain)
    return injectIntoFoundTarget(found.target, buildPlan, deferText, autoBind, sourceMessageId, plain)
  }

  // Deliver `text` to an already-chosen candidate: an open card of its session takes the message as
  // its answer, otherwise it is injected verbatim. Shared by the sole-candidate and anchor-bind paths.
  const answerOrInjectPrewrapped = async (
    target: AgentCandidate,
    text: string,
    plain: string | undefined,
    sourceMessageId: number | null,
  ): Promise<boolean> => {
    if (await answerOpenCardInChat(target.paneId, plain, sourceMessageId, null)) return true
    return injectPrewrappedToPane(target.paneId, text, sourceMessageId, target.panePath ?? "/")
  }

  // No tmux pane could be resolved (discovery found none or several): route the text through the
  // picker or the only live agent, else tell the human there is no agent. false = the plan did not run.
  const injectWithoutTarget = async (
    found: Extract<DiscoverResult, { ok: false }>,
    deferText: string | undefined,
    autoBind: boolean,
    sourceMessageId: number | null,
    plain: string | undefined,
  ): Promise<boolean> => {
    // Routable text present (a real message) → route picker: a tap injects it
    // verbatim. Empty/whitespace deferText is treated as "no text" (same rule as
    // postAgentPicker's selectOnly), so it never arms a pending route that would
    // inject nothing on tap.
    const text = routableText(deferText)
    if (found.reason === "ambiguous") {
      if (text !== null) return postRoutePicker(candidatesForPicker(found.candidates), text, undefined, sourceMessageId)
      // No routable text (a /stop with several agents): show the live agents as
      // a select-only picker rather than dumping them as text. A select-only tap
      // does NOT re-run the control verb (it only hands back the selector), so
      // the verb did NOT execute — return false so the source message earns no
      // 👀 "delivered" receipt (matching the kill-agent ambiguous branch below
      // and this function's "true only when the plan executed" contract).
      await postSelectPicker(candidatesForPicker(found.candidates))
      return false
    }
    if (found.reason === "no-agent" && text !== null) {
      const delivered = await injectViaLiveCandidates(text, autoBind, sourceMessageId, plain)
      if (delivered !== null) return delivered
    }
    await replyNoAgent()
    return false
  }

  // Discovery saw no tmux pane but out-of-tmux agents are live (omp:<pid>): the sole one gets the
  // text, several get the anchor bind (autoBind) or the picker. null: no live candidate at all.
  const injectViaLiveCandidates = async (
    text: string,
    autoBind: boolean,
    sourceMessageId: number | null,
    plain: string | undefined,
  ): Promise<boolean | null> => {
    const candidates = listAgentCandidates()
    if (candidates.length === 1) {
      log(`inject: no tmux pane, sole candidate ${candidates[0].paneId}/${candidates[0].windowName}`)
      return answerOrInjectPrewrapped(candidates[0], text, plain, sourceMessageId)
    }
    if (candidates.length === 0) return null
    if (autoBind) {
      const anchored = resolveLastUserTargetCandidate(ctx, candidates)
      if (anchored) {
        log(`inject: no tmux pane, anchor bind ${anchored.paneId}/${anchored.windowName}`)
        return answerOrInjectPrewrapped(anchored, text, plain, sourceMessageId)
      }
    }
    return postRoutePicker(candidates, text, undefined, sourceMessageId)
  }

  // Deliver to the one tmux pane discovery chose: the open-card answer first, then the omp
  // original-process bridge, the defer queue, or the plan `buildPlan` builds for the resolved target.
  const injectIntoFoundTarget = async (
    target: TargetPane,
    buildPlan: (target: TargetPane) => InjectStep[],
    deferText: string | undefined,
    autoBind: boolean,
    sourceMessageId: number | null,
    plain: string | undefined,
  ): Promise<boolean> => {
    const paneId = target.pane.paneId
    if (await answerOpenCardInChat(paneId, plain, sourceMessageId, null)) {
      if (autoBind) recordLastUserTarget(paneId, target.pane.panePath)
      return true
    }
    const textPreview = deferText?.slice(0, 60).replace(/\n/g, " ")
    log(`inject: target=${paneId} autoBind=${autoBind} text="${textPreview ?? "(key)"}"`)
    const recordIfAutoBound = () => {
      if (autoBind) recordLastUserTarget(paneId, target.pane.panePath)
    }
    if (preferOmpApiOverTmux(target.agent)) return injectViaOmpBridge(target, deferText, sourceMessageId, recordIfAutoBound)
    if (deferText !== undefined && shouldDeferInbound(paneId)) {
      markDeferredForAck(enqueueDeferred(paneId, deferText, sourceMessageId))
      recordIfAutoBound()
      return true
    }
    const result = await injectInbound(sourceMessageId, paneId, buildPlan(target))
    if (!result.ok) {
      log(`inject aborted: ${result.error}`)
      await sendMessage(ctx, result.error)
      return false
    }
    recordIfAutoBound()
    return true
  }

  // An omp target is reached through its original-process bridge, never tmux send-keys.
  const injectViaOmpBridge = async (
    target: TargetPane,
    deferText: string | undefined,
    sourceMessageId: number | null,
    recordIfAutoBound: () => void,
  ): Promise<boolean> => {
    const paneId = target.pane.paneId
    if (deferText === undefined) {
      log(`inject: omp target=${paneId} — refusing tmux send-keys for a control verb`)
      await sendMessage(ctx, "OMP control keys are not supported by the original-process bridge; use the original terminal. No replacement was started.")
      return false
    }
    if (shouldDeferInbound(paneId)) {
      markDeferredForAck(enqueueDeferred(paneId, deferText, sourceMessageId))
      recordIfAutoBound()
      return true
    }
    const live = liveOmpForPane(listLiveOmpAgents(), paneId, target.agentPid)
    const cwd = target.pane.panePath || live?.cwd || "/"
    log(`inject: omp original-process pane=${paneId} cwd=${cwd} (endpoint first; own-pane tmux only without one)`)
    const result = await deliverOriginalOmp(live ?? { cwd, pid: target.agentPid }, deferText, sourceMessageId ?? undefined, paneId)
    if (!result.ok) {
      log(`inject aborted: ${result.error}`)
      await sendMessage(ctx, result.error)
      return false
    }
    recordIfAutoBound()
    return true
  }

  // Inject a wrapped message into ONE specific pane (the /agent target); see injectWrappedToPane.
  const injectToPane = (
    paneId: string,
    from: string,
    msg: string,
    sourceMessageId: number | null,
    deferReactionViaAck = false,
  ): Promise<PaneInjectOutcome> => injectWrappedToPane(deliveryEnv, paneId, from, msg, sourceMessageId, deferReactionViaAck)

  // `label` identifies the chosen agent: `<window> · <agent>` for a direct/
  // confident route, or the picker's DISTINCT label (cwd-derived) when several
  // agents shared a bare window name — so the confirmation never reads an
  // ambiguous "4 · claude".
  const routedReply = (label: string, deferred?: boolean): string =>
    deferred ? `⏳ queued for ${label} (answering a question)` : `→ ${label}`

  // The distinct label for `target` within `fleet` (cwd-derived disambiguation),
  // falling back to `<window> · <agent>` if the target isn't in the fleet.
  const labelFor = (target: AgentCandidate, fleet: AgentCandidate[]): string => {
    const i = fleet.indexOf(target)
    return i >= 0 ? distinctLabels(fleet)[i] : `${target.windowName} · ${target.agent}`
  }

  // Resolve + log the gone-agent anchor fallback target shared by handleAgentRoute (text)
  // and routePrewrappedAgentMessage (media) — see agent-match.ts's "gone-agent (dead
  // subagent) fallback" comment for the full rationale. `allowed` is the caller's
  // topic-scope gate (the text route passes `action.threadId == null`; the media route
  // always passes `true` — a topic message never carries media through this handler at
  // all, `topicActionFor` acks it before the flat photo/document dispatch ever runs, so
  // no such guard is needed there). Returns null when there is no live anchor to try (or
  // the caller disallowed it); the caller then keeps its explicit "no agent matching" error.
  const resolveGoneAgentAnchor = (
    logPrefix: string,
    selector: string,
    candidates: AgentCandidate[],
    allowed: boolean,
  ): { anchor: AgentCandidate; label: string } | null => {
    if (!allowed) return null
    const anchor = resolveLastUserTargetCandidate(ctx, candidates)
    if (!anchor) return null
    const label = labelFor(anchor, candidates)
    log(`${logPrefix}: selector="${selector}" → gone → anchor fallback ${anchor.paneId}/${anchor.windowName}`)
    return { anchor, label }
  }

  const armSelectedAgentRoute = (target: AgentCandidate, label: string, messageId: number | null, threadId: number | null): string => {
    const previous = cancelSelectedAgentRoute()
    if (previous && previous.messageId !== null && previous.messageId !== messageId) {
      void editMessageText(ctx, previous.messageId, `cancelled ${previous.label} — replaced by another selection`)
    }
    const token = `s${++state.selectedAgentTokenSeq}`
    const timer = setTimeout(() => {
      if (state.selectedAgentRoute?.token !== token) return
      state.selectedAgentRoute = null
      if (messageId !== null) void editMessageText(ctx, messageId, `selected ${label} — expired`)
    }, SELECTED_AGENT_TTL_MS)
    state.selectedAgentRoute = { token, paneId: target.paneId, label, messageId, threadId, timer }
    return token
  }

  // Post the session-grouped inline-keyboard agent PICKER and arm its pending
  // selection. `message` empty ⇒ a select-only picker; bare `/agent` additionally
  // sets `armNextMessage` so a tap routes the next ordinary inbound message.
  // Non-empty ⇒ the route picker (a tap injects the message). Returns false only
  // when the picker send itself failed.
  const postAgentPicker = async (
    subset: AgentCandidate[],
    message: string,
    sourceMessageId: number | null,
    options: { armNextMessage?: boolean; messageExtra?: Record<string, unknown>; threadId?: number | null; notice?: string } = {},
  ): Promise<boolean> => {
    const token = `a${++state.agentTokenSeq}`
    const payload = buildAgentSelectMessage(ctx.chatId, subset, token, message, false, options.notice)
    const messageExtra = options.messageExtra ?? {}
    const messageId = await sendMessage(ctx, payload.text, { ...messageExtra, reply_markup: payload.reply_markup })
    // Picker send failed (Telegram rejected / >4096-char list / network): do NOT
    // store a pending route it can never resolve, and do NOT earn a 👀 receipt.
    if (messageId === null) {
      await sendMessage(ctx, "couldn't post the agent picker — try a narrower /agent <window>", messageExtra)
      return false
    }
    armPendingAgent(token, {
      message,
      candidates: subset,
      messageId,
      sourceMessageId,
      relatedReactionMessageId: null,
      selectOnly: message.trim() === "",
      armNextMessage: message.trim() === "" && options.armNextMessage === true,
      threadId: options.threadId ?? null,
    })
    if (message.trim() !== "") queueAckReaction(sourceMessageId, DEFER_REACTION)
    return true
  }

  // Select-only picker (buttons, no pending route): fallback for an ambiguous
  // control verb that carries no routable text (a /stop or /kill across several
  // agents) — the buttons show the live agents instead of a plain-text dump, and
  // a tap hands back the selector to address one.
  // Guards an empty subset (a freak full race where candidatesForPicker filtered
  // every discovery pane out) → the no-agent reply, never a button-less picker
  // (mirrors postRoutePicker; matches the candidatesForPicker fallback comment).
  const postSelectPicker = async (subset: AgentCandidate[]): Promise<boolean> => {
    if (subset.length === 0) {
      await replyNoAgent()
      return false
    }
    return postAgentPicker(subset, "", null)
  }

  // Route picker for ALREADY-WRAPPED text (a tap injects it VERBATIM, prewrapped:
  // true) — the ambiguous-target path (injectViaTarget) and, with a gone-target
  // `notice`, the reply-route picker. Unlike postReplyPicker it does NOT reorder by
  // LRU/MRU: the ambiguous fleet has no prior reply usage to rank by. Returns false
  // only when the picker send itself failed.
  const postRoutePicker = async (
    subset: AgentCandidate[],
    prewrappedText: string,
    notice?: string,
    sourceMessageId: number | null = null,
    relatedReactionMessageId: number | null = null,
  ): Promise<boolean> => {
    if (subset.length === 0) {
      await replyNoAgent()
      return false
    }
    const token = `a${++state.agentTokenSeq}`
    const payload = buildAgentSelectMessage(ctx.chatId, subset, token, prewrappedText, false, notice)
    const messageId = await sendMessage(ctx, payload.text, { reply_markup: payload.reply_markup })
    if (messageId === null) {
      await sendMessage(ctx, "couldn't post the agent picker — try a narrower /agent <window>")
      return false
    }
    armPendingAgent(token, {
      message: prewrappedText,
      candidates: subset,
      messageId,
      sourceMessageId,
      relatedReactionMessageId,
      prewrapped: true,
    })
    queueAckReaction(sourceMessageId, DEFER_REACTION)
    return true
  }

  const injectPrewrappedToPane = (
    paneId: string,
    prewrappedText: string,
    sourceMessageId: number | null,
    cwd: string,
    options: PrewrappedOptions = {},
  ): Promise<boolean> => injectPrewrappedToPaneWith(deliveryEnv, paneId, prewrappedText, sourceMessageId, cwd, options)

  // `/agent <selector> …` that matched no candidate (a tmux pane, omp-live or a rig-wrapper
  // host), checked against the non-omp agents running outside tmux AND outside the wrapper
  // (tg-cli#456): a ONE-line refusal naming how to restart it under the wrapper — nothing is
  // sent or queued (the Stop-hook inbox this replaces delivered only at a turn end an idle
  // session never reached). true when it refused (the caller stops), false when nothing matches.
  const refuseOutsideTmux = async (selector: string, out: Record<string, unknown> = {}): Promise<boolean> => {
    const hits = matchUnreachable(selector, listUnreachableAgents())
    if (hits.length === 0) return false
    log(`agent-route: selector="${selector}" → outside tmux and the rig wrapper (${hits.map((a) => `${a.agent} pid ${a.pid}`).join(", ")}) — refused`)
    await sendMessage(ctx, outsideTmuxRefusalText(selector, hits), out)
    return true
  }

  // A `/agent <selector> <message>` whose selector matched NO tmux pane: try the agents
  // running OUTSIDE tmux. An omp gets the (already wrapped) text through its original-
  // process bridge; any other harness gets the refusal. No match returns null
  // so the caller keeps its legacy "no agent matching" error. Never a silent drop.
  const tryRouteOutsideTmux = async (
    selector: string,
    wrapped: string,
    messageId: number | null,
    out: Record<string, unknown> = {},
  ): Promise<boolean | null> => {
    const ompHits = matchLiveOmp(selector, listLiveOmpAgents())
    if (ompHits.length > 1) {
      const lines = describeOmpLines(ompHits)
      await sendMessage(ctx, `'${selector}' matches several omp sessions:\n${lines.join("\n")}`, out)
      return false
    }
    if (ompHits.length === 1) {
      const target = ompHits[0]
      const cwd = target.cwd ?? "/"
      log(`agent-route: selector="${selector}" → omp original-process pid=${target.pid} title=${liveOmpLabel(target)} cwd=${cwd}`)
      const res = await deliverOriginalOmp(target, wrapped, messageId ?? undefined, target.paneId)
      if (!res.ok) {
        await sendMessage(ctx, res.error, out)
        return false
      }
      await sendMessage(ctx, `→ ${liveOmpLabel(target)} · omp (original-process)`, out)
      return true
    }
    return (await refuseOutsideTmux(selector, out)) ? false : null
  }

  // `route.selector` matched at least one candidate: a confident match injects, an ambiguous one asks.
  // Returns null when the selector matched nothing (the caller tries outside-tmux / the gone anchor).
  const routeMediaToMatches = async (
    selector: string,
    candidates: AgentCandidate[],
    prewrappedText: string,
    sourceMessageId: number,
    msgPreview: string,
  ): Promise<boolean | null> => {
    const m = matchWindows(selector, candidates)
    if (m.matches.length === 0) return null
    if (m.confident) {
      const target = m.matches[0]
      log(`media-agent-route: selector="${selector}" → ${target.paneId}/${target.windowName} confident=true msg="${msgPreview}"`)
      return injectPrewrappedToPane(target.paneId, prewrappedText, sourceMessageId, target.panePath)
    }
    const names = m.matches.map((c) => c.windowName).join(", ")
    log(`media-agent-route: selector="${selector}" → ambiguous (${m.matches.length} matches: ${names}) → picker`)
    return postRoutePicker(m.matches, prewrappedText, undefined, sourceMessageId)
  }

  // A named selector no live candidate matches: outside-tmux omp / refusal, then the gone-agent
  // anchor fallback, else the "no agent matching" error. Never a silent fallback to a random agent.
  const routeMediaToUnmatchedSelector = async (
    selector: string,
    candidates: AgentCandidate[],
    prewrappedText: string,
    sourceMessageId: number,
  ): Promise<boolean> => {
    const routed = await tryRouteOutsideTmux(selector, prewrappedText, sourceMessageId)
    if (routed !== null) return routed
    const found = resolveGoneAgentAnchor("media-agent-route", selector, candidates, true)
    if (found) {
      const { anchor, label } = found
      const ok = await injectPrewrappedToPane(anchor.paneId, prewrappedText, sourceMessageId, anchor.panePath ?? "/")
      if (ok) {
        recordLastUserTarget(anchor.paneId, anchor.panePath)
        await sendMessage(ctx, goneAgentFallbackReplyText(selector, label))
      }
      return ok
    }
    const names = candidates.map((c) => c.windowName).join(", ")
    log(`media-agent-route: selector="${selector}" → NO match among [${names}] — reporting error`)
    await sendMessage(ctx, `no agent matching '${selector}' (running: ${names}) — try /agent to pick`)
    return false
  }

  const routePrewrappedAgentMessage = async (
    route: ParsedAgentCommand,
    prewrappedText: string,
    sourceMessageId: number,
  ): Promise<boolean> => {
    cancelSelectedAgentRouteForAgentCommand()
    const candidates = listAgentCandidates()
    const msgPreview = prewrappedText.slice(0, 60).replace(/\n/g, " ")
    if (candidates.length === 0) {
      if (route.selector) {
        const routed = await tryRouteOutsideTmux(route.selector, prewrappedText, sourceMessageId)
        if (routed !== null) return routed
      }
      log(`media-agent-route: no candidates — selector=${route.selector || "(none)"} msg="${msgPreview}"`)
      await sendMessage(ctx, noAgentReplyNow())
      return false
    }

    if (route.selector) {
      const matched = await routeMediaToMatches(route.selector, candidates, prewrappedText, sourceMessageId, msgPreview)
      if (matched !== null) return matched
      return routeMediaToUnmatchedSelector(route.selector, candidates, prewrappedText, sourceMessageId)
    }

    if (candidates.length === 1) {
      const target = candidates[0]
      log(`media-agent-route: no selector, single candidate → ${target.paneId}/${target.windowName} msg="${msgPreview}"`)
      return injectPrewrappedToPane(target.paneId, prewrappedText, sourceMessageId, target.panePath)
    }

    log(`media-agent-route: no selector, ${candidates.length} candidates → picker msg="${msgPreview}"`)
    return postRoutePicker(candidates, prewrappedText, undefined, sourceMessageId)
  }

  return { answerOpenCardInChat, injectViaTarget, injectToPane, routedReply, labelFor, resolveGoneAgentAnchor, armSelectedAgentRoute, postAgentPicker, postSelectPicker, postRoutePicker, injectPrewrappedToPane, refuseOutsideTmux, tryRouteOutsideTmux, routePrewrappedAgentMessage }
}

export type InboundInjectApi = ReturnType<typeof createInboundInject>
