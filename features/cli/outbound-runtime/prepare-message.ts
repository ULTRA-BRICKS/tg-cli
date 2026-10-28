// Stage 4 of the outbound `tg` pipeline (tg-cli#817): assemble the authored message and run every
// local content gate on it. The order of the steps is the order of their stderr lines and exits in
// the original entrypoint; --dry-run and the transmit step run after this stage.
import { senderRole } from "../../agent-role/role"
import { assembleBody, selectThread, warnLongUnstructured } from "./message-body"
import { checkTableEscalation, guardUnattachedFiles, isAgentAuthored, runIntentGate } from "./agent-gates"
import { runDimensionGate } from "./dimension-gate-run"
import { guardDictionary, guardScreenshotMention, guardStrayCjk } from "./text-guards"
import type { Invocation, PreparedMessage, RuntimePaths, SendAction, SenderContext } from "./types"

/** Content guards on the authored text; each returns the surviving harness-title candidate. */
function guardAuthoredText(
  send: SendAction,
  inv: Invocation,
  sender: SenderContext,
  assembled: { caption: string; dictFields: PreparedMessage["dictFields"] },
): string {
  let safeHarnessTitle = sender.harnessTitle
  if (inv.features["cjk-guard"] !== false) safeHarnessTitle = guardStrayCjk(assembled.caption, send.title, safeHarnessTitle)
  if (inv.features["screenshot-guard"] !== false) safeHarnessTitle = guardScreenshotMention(send, assembled.caption, safeHarnessTitle)
  return guardDictionary(sender.env, send, assembled.dictFields, safeHarnessTitle)
}

export async function prepareMessage(send: SendAction, sender: SenderContext, inv: Invocation, paths: RuntimePaths): Promise<PreparedMessage> {
  const { env } = sender
  // The optional SECOND `[name]` bracket is a SUBAGENT label. `--subagent <name>`
  // (parsed to `subagent`) wins, then the trusted subagent env signals: `TG_AGENT`,
  // then the launcher's `RIG_AGENT_ID` / `RIG_DETACHED_AGENT=1` (omp sets the
  // former on its task subagents) — docs/specs/agent-role-model.md. The
  // MAIN/orchestrator agent passes neither and gets NO second bracket — its
  // identity is the `[window]` label (the session's primary name) above. There is
  // deliberately NO guessing: `CLAUDE_CODE_CHILD_SESSION` is set on a Claude Code
  // main thread too, so it is never a role signal.
  const agentLabel = senderRole(send.subagent, env).label
  const thread = selectThread(send.topic, env, sender.sessionless || sender.pinId !== null)

  const { caption, effectiveFormat, dictFields } = await assembleBody(send)
  warnLongUnstructured(send, caption)

  const safeHarnessTitle = guardAuthoredText(send, inv, sender, { caption, dictFields })
  // Every content guard has now either passed the harness-title candidate or dropped it — resolve
  // the session name from what survived (a dropped title never leaks into the `[window]` bracket
  // either; the cwd project stands in). The primary name is the `[window]` bracket; the secondary
  // name (the title, in tmux) is the default header title. Decision (tg-cli#448): no `--no-title`
  // opt-out — the CTO asked to see the harness session name (2026-09-29) and the content guards
  // already drop an unfit title; an explicit `--title` replaces it.
  const sessionName = sender.sessionNameFor(safeHarnessTitle)
  const title = send.title ?? (sessionName.secondary || undefined)

  checkTableEscalation(send, caption, env)

  const agentAuthored = isAgentAuthored(sender)
  const gatedSender = agentAuthored && send.automated !== true
  if (inv.features["file-mention-guard"] !== false && gatedSender) guardUnattachedFiles(send, dictFields, paths.home)
  const intent = await runIntentGate(send, caption, env, paths.configDir, agentAuthored)
  if (gatedSender) runDimensionGate(send, dictFields, env, paths)

  return { caption, effectiveFormat, dictFields, title, sessionNamePrimary: sessionName.primary, agentLabel, intent, agentAuthored, thread }
}
