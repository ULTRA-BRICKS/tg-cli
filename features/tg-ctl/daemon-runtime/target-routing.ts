// daemon-runtime/target-routing: poll counters, last-user-target anchor, pane discovery for inbound text.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { renameSync, unlinkSync, writeFileSync } from "fs"
import { type AgentCandidate } from "../agent-match"
import { buildGitStateBanner } from "../git-state"
import { resolveLocatorToSession } from "../session-registry-store"
import { parseLastUserTarget, serializeLastUserTarget, withSessionKey, type LastUserTarget } from "../last-user-target"
import type { DiscoverResult, TargetPane } from "../types"
import { readFileOrNull, readOffset } from "./ctx-io"
import { sendMessage } from "./telegram-api"
import { sessionRegistry } from "./session-registry"
import { discoverTarget, gitStateForPath, listAgentCandidates, noAgentReplyNow, resolveLastUserTarget } from "./pane-discovery"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"

export type TargetRoutingDeps = {
  ctx: Ctx
  state: DaemonState
}

export function createTargetRouting(d: TargetRoutingDeps) {
  const { ctx, state } = d

  state.offset = readOffset(readFileOrNull(ctx.paths.offset))

  state.lastAgentSeenMs = Date.now()

  // grace period from daemon start
  state.consecutive409 = 0

  state.warned409 = false

  // The pane of the CTO's OWN last resolved inbound delivery (tg-cli#78 anchor
  // fix, live incident 2026-08-19/20). The PRIOR mechanism (`lastMessagePane`
  // over routes.json) tracked "who spoke last" — ANY pane's outbound `tg` send,
  // including an agent proactively messaging the CTO unprompted. That was the
  // wrong anchor for a fresh non-reply: it let an unrelated agent's inbound-to-CTO
  // message hijack the CTO's very next message. His own fix, verbatim: "всегда
  // есть самое последнее сообщение его и нужно использовать для определения
  // адресата". Written only in recordLastUserTarget below, on a CONFIRMED
  // delivery to the CTO's own inbound (auto-bound, a picker/`/agent` selection,
  // or a recognized reply) — never on an agent's own outbound send, and never on
  // a failed/unconfirmed attempt. `resolveLastUserTarget` itself (pane-id-reuse
  // guard included) is shared with resolveTasksScopeDir's `/tasks` default
  // scoping (top-level function, above) so both surfaces agree on "the default
  // target" — see that function's docstring.

  // `cwd` is REQUIRED (not optional) — a delivery whose target pane has no known
  // panePath is skipped entirely rather than recorded with an empty cwd: an empty
  // cwd can never pass routeMatchesPane's guard on a later resolve (it fails
  // closed), so writing it would just poison the anchor file with a permanently
  // dead entry until some later delivery happens to overwrite it (review
  // finding). No dedupe-on-unchanged check — see the module docstring on why `ts`
  // is intentionally not staleness-bearing; a plain unconditional write keeps this
  // simple and correct (the write itself is a trivial tmp+rename, not worth an
  // extra disk read to maybe skip).
  const invalidateLastUserTarget = (): void => {
    try {
      unlinkSync(ctx.paths.lastUserTarget)
    } catch {
      // Already absent (or unremovable) — either way there's no stale anchor
      // left to worry about.
    }
  }

  // Explicit routing (a picker tap, a confirmed reply, a named /agent) shares
  // this SAME no-cwd/write-failure fail-closed logic with an ordinary auto-bind
  // delivery, deliberately (Opus review finding raised this as asymmetric —
  // "the CTO just explicitly named this pane"). But an explicit choice of a
  // cwd-less pane still can't be recorded as a pane-id-reuse-safe anchor
  // (architecture review, module docstring: cwd is REQUIRED, invalid states are
  // not representable), and silently KEEPING a stale anchor pointing at whatever
  // pane the CTO addressed BEFORE this explicit choice would be actively wrong,
  // not just imprecise — he just moved away from it. Between "the next ambiguous
  // message asks once more" and "silently routes to a pane the CTO explicitly
  // left", asking is the safer failure, so both paths invalidate the same way.
  const recordLastUserTarget = (paneId: string, cwd: string | undefined): void => {
    // "does the anchor already point at THIS pane" is read LAZILY — only inside
    // the branches that actually need it (the no-cwd branch, the write-failure
    // catch, and carrying the session key over when the registry has no answer)
    // — not unconditionally up front (performance review finding, raised
    // twice): the common case (cwd present, registry resolves the pane, write+rename
    // succeeds) never touches this read at all.
    const readCurrent = (): LastUserTarget | null => parseLastUserTarget(readFileOrNull(ctx.paths.lastUserTarget))
    if (!cwd) {
      // A confirmed delivery whose pane has no known cwd can't record a
      // pane-id-reuse-safe anchor. If the CURRENT anchor already points at this
      // SAME pane, it already carries a good cwd from an earlier delivery —
      // invalidating here would be pure loss, not a safety fix (Opus review
      // finding: an ordinary auto-bound delivery to the pane the anchor already
      // trusts would otherwise wipe it every time panePath happens to come back
      // empty). Only when the anchor points elsewhere (or doesn't exist) is a
      // missing cwd genuinely ambiguous about which pane the CTO is actually
      // addressing now — invalidate so the next ambiguous message asks rather
      // than trusting outdated state (design review finding: that's fail-OPEN on
      // the wrong pane, not fail-closed).
      if (readCurrent()?.paneId === paneId) return
      invalidateLastUserTarget()
      return
    }
    const tmp = `${ctx.paths.lastUserTarget}.tmp.${process.pid}`
    try {
      // Keep the anchor's session registry key (#487): the registry's answer for
      // this pane+cwd, else the key it already carried for the same pane+cwd.
      const resolved = sessionRegistry ? resolveLocatorToSession(sessionRegistry, paneId, cwd) : null
      const target = withSessionKey({ paneId, cwd, ts: Math.floor(Date.now() / 1000) }, resolved, readCurrent)
      writeFileSync(tmp, serializeLastUserTarget(target), { mode: 0o600 })
      renameSync(tmp, ctx.paths.lastUserTarget)
    } catch {
      // A failed renameSync (write succeeded, rename didn't) leaves the tmp file
      // on disk carrying the same sensitive pane id + cwd the denylist protects
      // (Opus review finding) — clean it up best-effort rather than leaving an
      // orphan. The pid suffix means it would be overwritten next time anyway,
      // but a crash before that next call would otherwise leave it indefinitely.
      try {
        unlinkSync(tmp)
      } catch {
        // Nothing to clean up, or unremovable — either way, not worth failing over.
      }
      // A transient write failure (disk full, EINTR) while RE-AFFIRMING the
      // SAME target the anchor already correctly holds must NOT destroy that
      // still-valid on-disk copy (Opus review finding) — the stale write only
      // meant to refresh `ts`, so leaving the existing good record in place is
      // strictly better than deleting it. Only a failure to persist a GENUINE
      // target CHANGE is invalidated: leaving the PRIOR (different) anchor in
      // place there would silently keep routing to a stale pane instead of
      // falling back to the picker as intended (review finding).
      if (readCurrent()?.paneId === paneId) return
      invalidateLastUserTarget()
    }
  }

  // The base discovery: §10 priority chain + liveness bookkeeping, NO last-message
  // bind. Used by liveness/history paths that must NOT silently pick an agent. The
  // no-reply bind lives ONLY in discoverForInject below, so it can never leak onto
  // the reply path (which uses handleReplyRoute's own #49 fail-closed, not discover())
  // or the history-attribution path.
  const discover = (): DiscoverResult => {
    const result = discoverTarget(ctx)
    // Agent panes existing — even ambiguous ones — keep the daemon alive.
    if (result.ok || result.candidates.length > 0) state.lastAgentSeenMs = Date.now()
    return result
  }

  // discover() PLUS the no-reply last-user-message bind (tg-cli#78, anchor fixed
  // 2026-08-20/21): an otherwise-ambiguous NON-reply inbound binds to the pane of
  // the CTO's OWN last resolved message, never to "whichever agent spoke most
  // recently" (routes.json's outbound-send history) — that let an unrelated agent's
  // unprompted message to the CTO hijack his very next message (live incident).
  // This runs BEFORE #76's ambiguous-picker: a fresh message after the CTO's own
  // last one lands in the same place directly; the picker fires only when there is
  // no last-user-target, or its pane is gone / not a candidate. The lookup is LAZY
  // — only on a genuinely ambiguous base result — so the common ok/no-agent path
  // never reads the store. This is the ONLY discovery used by the non-reply INJECT
  // paths (injectViaTarget with autoBind). A no-last-target case stays ambiguous →
  // #76's picker (the unscoped fail-closed, #49).
  const discoverForInject = (): DiscoverResult => {
    const result = discover()
    if (result.ok || result.reason !== "ambiguous") return result
    const hit = resolveLastUserTarget(ctx, result.candidates)
    return hit ? { ok: true, target: hit } : result
  }

  // Prepend the git-state-check banner (git-state.ts) to `text` when `control.git_state_banner`
  // is on (default) AND the destination pane's cwd is mid-flight — uncommitted changes or a
  // non-main/master branch. Scoped to the SILENT auto-bind deliveries only: a fresh, non-reply
  // message that lands in the discovered pane with no human/reply anchor choosing it (plain
  // inject-text, a photo/document notice, a standalone voice transcript). Deliberately NOT applied
  // to reply-route (anchored to a specific prior message — on-topic by construction), topic-route
  // (a per-topic pane, a different targeting model entirely), a /new spawn (a brand-new pane has no
  // prior work to protect), a picker tap (the human explicitly chose that pane), or a message
  // deferred behind an open question (flushed through a separate code path, out of scope here).
  //
  // Never banner a COMMAND passthrough (review catch, PR #153): the flat inject-text action also
  // carries an unrecognized `/command` (e.g. `/compact`, `/clear`) or a `!shell` command VERBATIM so
  // the harness TUI can execute it — updates.ts's textAction only wraps ordinary prose, never a
  // passthrough command. Prepending a banner line ahead of it would push the leading `/` or `!` off
  // the first character, so the harness reads it as plain prompt text instead of a command. A wrapped
  // inject (the normal case) always starts with the injectWrap template, never `/`/`!`, so this guard
  // only ever skips a real passthrough.
  const withGitStateBanner = (panePath: string, text: string): string => {
    // An EMPTY panePath (tmux reporting no pane_current_path) must never reach
    // gitStateForPath (review finding, same bug class as the routeMatchesPane
    // empty-path fix above): `git -C ''` leaves the cwd UNCHANGED, so it would
    // silently check the DAEMON's own inherited cwd — an unrelated repo — and
    // could prepend that repo's git state to a message delivered to an
    // unrelated agent. No path to check → no banner, same as the disabled/
    // command-passthrough cases below.
    if (!ctx.cfg.gitStateBanner || !panePath || text.startsWith("/") || text.startsWith("!")) return text
    const banner = buildGitStateBanner(gitStateForPath(panePath))
    return banner ? `${banner}\n${text}` : text
  }

  const replyContext = (threadId?: number | null): Record<string, unknown> =>
    typeof threadId === "number" ? { message_thread_id: threadId } : {}

  // Resolve a DiscoverResult's ambiguous `TargetPane[]` to the picker's
  // `AgentCandidate[]` (window names + cwd → distinct labels). The TargetPane
  // shape carries no window name, so re-derive over a fresh listAgentCandidates()
  // snapshot, keeping ONLY the discovery-narrowed panes that are STILL a live
  // agent candidate. A pane that raced away between the two snapshots (or no
  // longer passes the agent-candidate criterion) drops out — the picker shows
  // only panes a tap can actually route into, never a synthetic button into a
  // dead/non-agent pane. The set/discovery layer already guarantees ≥2 live
  // candidates on the ambiguous path, so the result is non-empty in practice; if
  // a freak full race emptied it, postRoutePicker/postSelectPicker fall back to
  // the no-agent reply rather than an empty button set.
  const candidatesForPicker = (panes: TargetPane[]): AgentCandidate[] => {
    const want = new Set(panes.map((c) => c.pane.paneId))
    return listAgentCandidates().filter((c) => want.has(c.paneId))
  }

  // The "not found" reply for a target that genuinely has NO agent. The ambiguous
  // case never reaches here anymore — it posts the inline-keyboard PICKER (buttons,
  // like /agent) instead of the old plain-text candidate dump (tg-cli#72). Kept as
  // a tiny helper for the no-agent message + the /kill path's reuse.
  const replyNoAgent = async (): Promise<void> => {
    await sendMessage(ctx, noAgentReplyNow())
  }

  return { recordLastUserTarget, discover, discoverForInject, withGitStateBanner, replyContext, candidatesForPicker, replyNoAgent }
}

export type TargetRoutingApi = ReturnType<typeof createTargetRouting>
