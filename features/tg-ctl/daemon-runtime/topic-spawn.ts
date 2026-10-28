import { readCreatedTopic, reportsTopicsDisabled } from "./topic-spawn-private"
// daemon-runtime/topic-spawn: spawning agent windows for topics and the /new flow's prompts.
// Extracted from runDaemon's closure (guardian-817): the statements below keep their original order and text;
// what other parts of the daemon used to reach by closure now arrives through `d`.
import { statSync } from "fs"
import { basename, isAbsolute } from "path"
import { findAgentInPane } from "../discover"
import { parseRegistrations } from "../registration-store"
import { applyCodexHookTrustBypass } from "../rig-delegate"
import { parseRoutes, routeMatchesPane } from "../routes"
import { markBound, markClosed, slugifyTopicName } from "../topics"
import { findModel, harnessLabel, MODEL_CATALOG, modelsForHarness, spawnArgvWithTask } from "../models"
import { buildNewDirKeyboard, buildNewHarnessKeyboard, buildNewModelKeyboard, buildNewRetryKeyboard, rankNewDirChoices, sessionTargetArgs, type NewSession } from "../new-command"
import type { PaneInfo, TopicBinding } from "../types"
import { log, readFileOrNull } from "./ctx-io"
import { botPostResult, clearMessageKeyboard, sendMessage } from "./telegram-api"
import { SUBPROC_ENV, snapshot } from "./tmux-probe"
import type { Ctx } from "./ctx-io"
import type { DaemonState } from "./daemon-state"
import type { TargetRoutingApi } from "./target-routing"
import type { LateApi } from "./late-api"
import type { PrivateTopicResult } from "./daemon-types"

export type TopicSpawnDeps = {
  ctx: Ctx
  state: DaemonState
  targetRouting: TargetRoutingApi
  late: Pick<LateApi, "spawnNewSession">
}

export function createTopicSpawn(d: TopicSpawnDeps) {
  const { ctx, state } = d
  const { replyContext } = d.targetRouting
  const { spawnNewSession } = d.late

  // --- flat /new private-topic spawn helpers (issue #186) ---
  // A flat `/new` with control.private_topics creates a topic for the new session and spawns it
  // into its own tmux window. SAFETY (this is the CTO's daily lifeline daemon): every step is
  // exception-guarded — a bad path, a missing tmux, an unknown model, or a spawn error NEVER
  // throws into the poll loop; it logs and posts a human-readable error.

  // statSync throws on a broken symlink / EACCES — guard so a malformed path answer can never
  // bubble into the poll loop. A non-existent or non-directory path → false (re-ask the human).
  const isExistingDirectory = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  // The tmux session to spawn the new window into: the configured pin, else the session a live
  // agent already runs in (so the new window lands beside the existing agents), else undefined
  // (tmux new-window without -t targets the current/only session). Best-effort, never throws.
  const sessionForSpawn = (): string | undefined => {
    if (ctx.cfg.session) return ctx.cfg.session
    const { panes, procs } = snapshot()
    for (const p of panes) {
      if (findAgentInPane(p, procs) !== null) return p.sessionName
    }
    return panes[0]?.sessionName
  }

  // Run `tmux new-window … -- <agent argv>` and return the created pane id, or an error.
  // -P -F '#{pane_id}' prints the new pane id on stdout → bound immediately (no discovery race,
  // spec §5). `-e TG_TOPIC=<threadId>` stamps the topic id into the NEW window's environment so the
  // spawned agent's plain `tg "reply"` threads back INTO this topic automatically — no `--topic`
  // needed (spec §9.4 deferral; codex r8 #1). The `tg` send side already reads TG_TOPIC and fails
  // soft on a stale/closed topic. Fully guarded: a spawn throw (tmux missing) or a non-zero exit
  // becomes a typed error, never an exception. `task` is passed through the model catalog as the
  // spawned agent's initial prompt. The path + argv are discrete argv elements (never shell-split),
  // so a directory with spaces is safe.
  const spawnTopicWindow = (
    threadId: number,
    windowSlug: string,
    path: string,
    model: string,
    task = "",
  ): { ok: true; paneId: string } | { ok: false; error: string } => {
    const argvBase = spawnArgvWithTask(model, path, task)
    if (!argvBase) return { ok: false, error: `unknown model \`${model}\` — pick a model again` }
    // tg#8708 (option a): add codex --dangerously-bypass-hook-trust ONLY when codex hooks are
    // rig-managed (rig vouches for them); never bypass a user's own untrusted hooks.
    const argv = applyCodexHookTrustBypass(argvBase, findModel(model)?.kind, process.env)
    try {
      // sessionForSpawn() runs snapshot() (tmux list-panes / ps), which CAN throw if a binary is
      // missing — it MUST be inside this try, else the throw escapes the local guard, past
      // the /new spawn, into the poll loop (exactly the "never throws" guarantee this defends).
      const session = sessionForSpawn()
      const tmuxArgv = [
        "tmux",
        "new-window",
        // `=<session>:` (not a bare name) so a NUMERIC session name isn't misparsed as a window
        // index — a bare `-t 1` fails `create window failed: index 1 in use`. See sessionTargetArgs.
        ...sessionTargetArgs(session),
        // -e sets the spawned PROCESS env so the agent's plain `tg` threads back into this topic.
        "-e",
        `TG_TOPIC=${threadId}`,
        "-n",
        windowSlug,
        "-c",
        path,
        "-P",
        "-F",
        "#{pane_id}",
        "--",
        ...argv,
      ]
      const proc = Bun.spawnSync(tmuxArgv, { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
      if (proc.exitCode !== 0) {
        return { ok: false, error: `couldn't start the agent (tmux: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`})` }
      }
      const paneId = proc.stdout.toString().trim()
      if (!paneId) return { ok: false, error: "tmux did not return a pane id — agent not started" }
      return { ok: true, paneId }
    } catch (err) {
      return { ok: false, error: `couldn't start the agent (${err})` }
    }
  }

  // Stamp the per-spawn token as a WINDOW USER OPTION on the just-created pane (codex r11): a
  // `@user_option` IS queryable after a restart via `#{@tg_spawn_token}` in PANE_FORMAT, unlike
  // `new-window -e` process env. Best-effort — a failure only weakens token-based orphan adoption
  // (the recorded paneId is the fallback proof — codex r12 P1), never the spawn. Never throws.
  const stampSpawnToken = (paneId: string, spawnToken: string): void => {
    try {
      const proc = Bun.spawnSync(["tmux", "set-option", "-w", "-t", paneId, "@tg_spawn_token", spawnToken], {
        stdout: "pipe",
        stderr: "pipe",
        env: SUBPROC_ENV,
      })
      // LOG a non-zero exit (codex r19 P2): the stamp is best-effort (the recorded paneId is the
      // fallback proof), but a silent failure would quietly weaken token-based orphan adoption — so
      // surface it for observability rather than swallowing it.
      if (proc.exitCode !== 0) {
        log(`set @tg_spawn_token for ${paneId} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`)
      }
    } catch (err) {
      log(`set @tg_spawn_token failed for ${paneId}: ${err}`)
    }
  }

  // (The per-spawn token is now read directly from each pane's snapshot `spawnToken` field — the
  // `@tg_spawn_token` window user option in PANE_FORMAT — so no extra per-candidate tmux call.)

  // The set of panes a `bound` binding LEGITIMATELY holds (so an orphan adoption never steals one).
  // Only a bound binding whose live pane STILL MATCHES its recorded project counts: a path-mismatched
  // (tmux-reused `%N`) bound pane is NOT a legit claim, so it doesn't block a real spawnPending orphan
  // (codex r8 #2). A pathless bound binding claims by pane id alone.
  const legitimatelyClaimedPanes = (topics: TopicBinding[], liveAgentPanes: PaneInfo[]): Set<string | undefined> =>
    new Set(
      topics
        .filter((t) => {
          if (t.status !== "bound" || !t.paneId) return false
          if (t.path === undefined) return true
          const live = liveAgentPanes.find((p) => p.paneId === t.paneId)
          return live !== undefined && routeMatchesPane({ recognizedCwd: t.path, panePath: live.panePath })
        })
        .map((t) => t.paneId),
    )

  // Reconcile ONE binding against the live tmux state on startup. Returns the SAME object when
  // nothing changes (the caller uses identity to detect a change), else a new transitioned binding:
  //   - a `bound` binding whose recorded pane is gone → markClosed (agent died while down);
  //   - an `awaiting-model` binding whose topic-slug window hosts a live UNCLAIMED agent → markBound
  //     (adopt the crash-orphan, no second spawn). `claimed` excludes panes already bound elsewhere.
  const reconcileOneTopic = (
    binding: TopicBinding,
    liveAgentPanes: PaneInfo[],
    claimed: Set<string>,
    ts: number,
  ): TopicBinding => {
    if (binding.status === "bound") {
      // Close the binding ONLY when the recorded pane no longer hosts an agent (genuinely gone). A
      // mere PATH MISMATCH on a live pane is NOT closed here: it can be a transient empty-path read
      // (the launchd flake) or a legit `cd`, and closing on that would irreversibly kill a live topic
      // on a flaky startup read — exactly what the routing-time guard deliberately avoids (see the
      // ctl-topics-integration "REUSED pane … NOT closed" test). The ROUTING path already prevents a
      // leak into a reused-pane stranger (it refuses to inject on a mismatch), so a reused-`%N` case
      // is contained there and self-heals; reconcile must not over-close (codex r4 P2 declined — the
      // transient-read safety wins over closing early). An out-of-tmux omp (`omp:<pid>`) has no
      // pane in this snapshot at all; routing checks its pid per message, so it is left as is.
      if (binding.paneId?.startsWith("omp:")) return binding
      const stillLive = binding.paneId && liveAgentPanes.some((p) => p.paneId === binding.paneId)
      if (stillLive) return binding
      log(`topic ${binding.threadId}: bound pane ${binding.paneId} gone on startup — marking closed`)
      return markClosed(binding, ts)
    }
    // Adopt a crash-orphan ONLY for the EXACT crash-gap state: `awaiting-model` WITH path + model AND
    // the `spawnPending` marker SET. That marker is armed right before `tmux new-window` and the
    // binding is dropped on spawn FAILURE, so only a binding whose new-window actually RAN (and whose
    // `bound` write was lost to a crash) is a real orphan. Without the marker, a legacy awaiting-model
    // row (codex r5 #1 / r7 P1) could be wrongly bound to an unrelated same-slug/cwd pane (parseTopics
    // already drops such rows). A `closed` topic's session is gone (never
    // resurrect — codex r2 #2).
    if (
      binding.status !== "awaiting-model" ||
      !binding.spawnPending ||
      !binding.spawnToken ||
      !binding.path ||
      !binding.model ||
      !findModel(binding.model)
    )
      return binding
    // Adopt a live agent pane that is PROVABLY the one we launched. Candidates: an unclaimed pane in
    // the topic-slug window with the same cwd. Among those, the proof is EITHER the recorded paneId
    // (set right after new-window — codex r12 P1) OR our per-spawn token. Since `@tg_spawn_token` is a
    // WINDOW option, EVERY pane in the window exposes it, so a multi-pane window (the user split it)
    // could token-match more than one pane (codex r23 #2): prefer the EXACT recorded paneId; fall back
    // to a token match ONLY when it is UNAMBIGUOUS (exactly one). Never bind a guessed pane.
    const slug = slugifyTopicName(binding.name, binding.threadId)
    const candidates = liveAgentPanes.filter(
      (p) =>
        p.windowName === slug &&
        !claimed.has(p.paneId) &&
        routeMatchesPane({ recognizedCwd: binding.path, panePath: p.panePath }),
    )
    const byPaneId = binding.paneId !== undefined ? candidates.find((p) => p.paneId === binding.paneId) : undefined
    const tokenMatches = candidates.filter((p) => p.spawnToken.length > 0 && p.spawnToken === binding.spawnToken)
    const orphan = byPaneId ?? (tokenMatches.length === 1 ? tokenMatches[0] : undefined)
    if (!orphan) {
      if (tokenMatches.length > 1) log(`topic ${binding.threadId}: ambiguous token match (${tokenMatches.length} panes) — not adopting`)
      return binding
    }
    log(`topic ${binding.threadId}: adopting orphan pane ${orphan.paneId} (window ${slug}) on startup`)
    return markBound(binding, orphan.paneId, ts)
  }

  // --- flat-chat `/new` command (issue #27, NON-topic) ---
  // The flat sibling of the forum-topics /new flow: a `/new [<harness>|<model>] [<dir>] name
  // [<task>]` slash command in the flat chat spawns a fresh agent in a named tmux window. SAFETY
  // (this is the CTO's daily lifeline): every step is exception-guarded — a bad path, missing tmux,
  // unknown model, or spawn error NEVER throws into the poll loop; it logs and replies, leaving the pending
  // session so the user can retry/answer again. Unlike the topic flow there is NO persistent
  // binding: once the agent spawns the pending session is deleted (the new pane is a plain pane,
  // addressed by /agent afterwards). The pending store is in-memory (pendingNew).

  // The recent project dirs to offer as `/new` dir buttons, parents-aware + LRU/MRU (issue #27).
  // Source = the routes store (every `tg` send stamps its pane's cwd) + the per-pane registrations,
  // merged newest-first; rankNewDirChoices ALSO adds each cwd's `..` parents. Best-effort: any read
  // error → [].
  const gatherNewDirChoices = (): string[] => {
    try {
      const stamped: Array<{ cwd: string | undefined; ts: number }> = [
        ...parseRoutes(readFileOrNull(ctx.paths.routes)).map((r) => ({ cwd: r.cwd, ts: r.ts })),
        ...parseRegistrations(readFileOrNull(ctx.paths.registration)).map((r) => ({ cwd: r.cwd, ts: r.registeredAt ?? 0 })),
      ]
      stamped.sort((a, b) => b.ts - a.ts) // newest first
      return rankNewDirChoices(stamped.map((s) => s.cwd), (p) => isAbsolute(p) && isExistingDirectory(p))
    } catch (err) {
      log(`gatherNewDirChoices failed: ${err}`)
      return []
    }
  }

  // The live tmux window names (for the name-uniqueness warning). Best-effort → [] on any flake.
  const liveWindowNames = (): string[] => {
    try {
      return snapshot().panes.map((p) => p.windowName).filter((n) => n.length > 0)
    } catch {
      return []
    }
  }

  state.privateTopicFallbackState = "unknown"

  const privateTopicWarning = (reason: string): string =>
    `tg-ctl private_topics is enabled, but ${reason}. This chat does not need to be converted to a forum. Spawning without a topic for now; after the bot capability/provisioning reports true, run \`tg-ctl restart\` and retry \`/new\`.`

  const privateTopicFallbackPrompt = (reason: string): string =>
    `tg-ctl private_topics is enabled, but ${reason}. Continue without topic routing?`

  // Create a private-chat topic via Bot API 9.4 `createForumTopic` and return the new
  // `message_thread_id`, or a user-visible failure reason (the daemon falls back to flat-chat behaviour).
  // Graceful: a failure is logged and returned to the caller so Telegram gets an explicit
  // capability diagnostic instead of hiding "chat is not a forum" in the daemon log.
  const createPrivateTopic = async (name: string): Promise<PrivateTopicResult> => {
    if (state.privateTopicFallbackState === "accepted") return { kind: "fallback" }
    const me = await botPostResult(ctx, "getMe", {})
    if (me.ok && reportsTopicsDisabled(me.json.result)) {
      log("private chat topic create unavailable — getMe.has_topics_enabled=false")
      if (state.privateTopicFallbackState === "pending") return { kind: "waiting" }
      if (state.privateTopicFallbackState === "unknown") {
        state.privateTopicFallbackState = "pending"
        return {
          kind: "ask",
          message: privateTopicFallbackPrompt("Telegram Bot API currently reports `getMe.has_topics_enabled=false` for this bot, so `createForumTopic` cannot create a private-chat topic"),
        }
      }
    }
    const topicResp = await botPostResult(ctx, "createForumTopic", { chat_id: ctx.chatId, name })
    if (!topicResp.ok) {
      log(`private chat topic create unavailable — createForumTopic: ${topicResp.description}`)
      return {
        kind: "fallback",
        message: privateTopicWarning(`Telegram Bot API rejected \`createForumTopic\`: ${topicResp.description}`),
      }
    }
    const created = readCreatedTopic(topicResp.json.result)
    if (!created.ok) {
      log(created.logLine)
      return { kind: "fallback", message: privateTopicWarning(created.reason) }
    }
    return { kind: "topic", threadId: created.threadId }
  }

  // Spawn a flat `/new` agent into a named tmux window and return the pane id, or a typed error.
  // Mirrors spawnTopicWindow but WITHOUT TG_TOPIC (a flat /new agent is not bound to a topic — it
  // registers itself normally via `tg` and is addressed by /agent). When a task is given it is the
  // agent's initial prompt argv (claude accepts a positional prompt), so the agent starts working
  // immediately. Fully guarded: a throw or non-zero exit becomes a typed error, never an exception.
  const spawnNewWindow = (
    windowSlug: string,
    path: string,
    model: string,
    task: string,
    spawnToken: string,
  ): { ok: true; paneId: string } | { ok: false; error: string } => {
    const argvBase = spawnArgvWithTask(model, path, task)
    if (!argvBase) return { ok: false, error: `unknown model \`${model}\` — pick a model again` }
    // tg#8708 (option a): add codex --dangerously-bypass-hook-trust ONLY when codex hooks are
    // rig-managed (rig vouches for them); never bypass a user's own untrusted hooks.
    const argv = applyCodexHookTrustBypass(argvBase, findModel(model)?.kind, process.env)
    try {
      const session = sessionForSpawn()
      const tmuxArgv = [
        "tmux",
        "new-window",
        // `=<session>:` (not a bare name) so a NUMERIC session name isn't misparsed as a window
        // index — a bare `-t 1` fails `create window failed: index 1 in use`. See sessionTargetArgs.
        ...sessionTargetArgs(session),
        // Stamp the per-spawn token into the window env too, mirroring the topic spawn — harmless
        // for a flat /new (no reconcile depends on it) but keeps spawn provenance greppable.
        "-e",
        `TG_SPAWN_TOKEN=${spawnToken}`,
        "-n",
        windowSlug,
        "-c",
        path,
        "-P",
        "-F",
        "#{pane_id}",
        "--",
        ...argv,
      ]
      const proc = Bun.spawnSync(tmuxArgv, { stdout: "pipe", stderr: "pipe", env: SUBPROC_ENV })
      if (proc.exitCode !== 0) {
        return { ok: false, error: `couldn't start the agent (tmux: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`})` }
      }
      const paneId = proc.stdout.toString().trim()
      if (!paneId) return { ok: false, error: "tmux did not return a pane id — agent not started" }
      return { ok: true, paneId }
    } catch (err) {
      return { ok: false, error: `couldn't start the agent (${err})` }
    }
  }

  // Post the dir-pick prompt for a pending /new session (recent dirs as buttons + free-text). The
  // session is already stored (awaiting-dir); this offers the choices and records the prompt id.
  const askNewDir = async (session: NewSession): Promise<void> => {
    const choices = gatherNewDirChoices()
    session.dirChoices = choices
    const out = replyContext(session.threadId)
    const extra: Record<string, unknown> =
      choices.length > 0 ? { ...out, reply_markup: { inline_keyboard: buildNewDirKeyboard(session.token, choices) } } : out
    const subject = session.bindThreadId !== undefined ? "New session for this topic" : `New agent \`${session.name}\``
    const prompt =
      choices.length > 0
        ? `${subject}. Pick a recent project below, or send an absolute path (e.g. /Users/you/project).`
        : `${subject}. Which directory should it work in? Send an absolute path (e.g. /Users/you/project).`
    session.promptMessageId = await sendMessage(ctx, prompt, extra)
  }

  // Post the harness-pick prompt for a pending /new session (one button per agent harness).
  const askNewHarness = async (session: NewSession): Promise<void> => {
    session.status = "awaiting-harness"
    session.ts = Math.floor(Date.now() / 1000)
    session.promptMessageId = await sendMessage(ctx, `Which harness should \`${session.name}\` use?`, {
      ...replyContext(session.threadId),
      reply_markup: { inline_keyboard: buildNewHarnessKeyboard(session.token) },
    })
  }

  // Post the model-pick prompt for a pending /new session (filtered to the chosen harness).
  const askNewModel = async (session: NewSession): Promise<void> => {
    session.status = "awaiting-model"
    session.ts = Math.floor(Date.now() / 1000)
    const catalog = session.harness ? modelsForHarness(session.harness) : MODEL_CATALOG
    const harnessName = session.harness ? `${harnessLabel(session.harness)} ` : ""
    session.promptMessageId = await sendMessage(ctx, `Which ${harnessName}model should \`${session.name}\` run?`, {
      ...replyContext(session.threadId),
      reply_markup: { inline_keyboard: buildNewModelKeyboard(session.token, catalog) },
    })
  }

  const advanceNewAfterDir = async (session: NewSession): Promise<boolean> => {
    // A ➕ New session (tg-cli#735) is named after its directory: the topic it came from has no
    // name of the CTO's choosing (Telegram names an implicit topic after the message's first words).
    if (session.bindThreadId !== undefined && session.dir) session.name = basename(session.dir)
    if (session.model && findModel(session.model)) return spawnNewSession(session, session.model, null)
    if (session.harness) await askNewModel(session)
    else await askNewHarness(session)
    return true
  }

  // After a spawn FAILURE, report the tmux error ONCE and offer a single "Retry spawn" button —
  // NEVER re-enter the questionnaire (the earlier bug: a failure fell back to re-asking the model,
  // so the user answered the same question in a loop while the real error scrolled away). The
  // session keeps name+dir+harness+model and moves to `awaiting-retry`; a tap re-runs the spawn with
  // those preserved answers. Clears the old prompt keyboard so no stale button lingers.
  const offerNewRetry = async (
    session: NewSession,
    errorText: string,
    oldPromptMessageId: number | null,
  ): Promise<boolean> => {
    if (oldPromptMessageId !== null) await clearMessageKeyboard(ctx, oldPromptMessageId)
    session.status = "awaiting-retry"
    session.ts = Math.floor(Date.now() / 1000)
    session.promptMessageId = await sendMessage(ctx, `${errorText}\n\nYour picks are kept — tap Retry to try again.`, {
      ...replyContext(session.threadId),
      reply_markup: { inline_keyboard: buildNewRetryKeyboard(session.token) },
    })
    return false
  }

  return { isExistingDirectory, spawnTopicWindow, stampSpawnToken, legitimatelyClaimedPanes, reconcileOneTopic, liveWindowNames, createPrivateTopic, spawnNewWindow, askNewDir, askNewModel, advanceNewAfterDir, offerNewRetry }
}

export type TopicSpawnApi = ReturnType<typeof createTopicSpawn>
