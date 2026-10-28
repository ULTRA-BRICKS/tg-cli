// Gates that apply to agent-authored sends (tg-cli#817 stage split): the --table escalation final
// check, the agent-authorship test, the unattached-file gate and the intent gate.
import { realpathSync, statSync } from "fs"
import { tmpdir } from "os"
import { escalationGateEnforced } from "../args"
import { realOr } from "../dimension-gate"
import type { DictionaryField } from "../dict-gate"
import { escalationFormatMessage, validateEscalationFormat } from "../escalation-format"
import { formatUnattachedFileError, unattachedFileMentions } from "../file-mention-gate"
import { classifyIntent, formatIntentVerdict, layaWorthAsking, type IntentVerdict } from "../intent-gate"
import { layaAskProbability, layaProblemAssessment } from "../laya-socket"
import { isEscalationTag } from "../../render/tag"
import { enforceEscalationGate } from "./escalation-gate"
import type { MergedEnv, SendAction, SenderContext } from "./types"

/**
 * Close the --table bypass: the parse-time gate (features/cli/args.ts) skips a --table send because
 * the rows arrive on stdin, which parseArgs never sees. So for an ESCALATION sent via --table,
 * validate the FINAL rendered body here (a boxed table alone is not a decision-request: it still
 * lacks a recommendation, context, a file ref, and the section structure).
 */
export function checkTableEscalation(send: SendAction, caption: string, env: MergedEnv): void {
  const { tag } = send
  if (tag === undefined || !isEscalationTag(tag) || !send.table) return
  const fin = validateEscalationFormat(caption)
  if (fin.missing.length > 0) enforceEscalationGate(escalationFormatMessage(tag, fin.missing), tag, env)
}

const AGENT_ENV_MARKERS = ["TG_AI_MODEL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "OPENCODE", "CODEX", "RIG_AGENT_ID", "RIG_DETACHED_AGENT", "TG_AGENT", "RIG_SESSION"]

/**
 * Scope of the intent / unattached-file / dimension gates: an agent in the process ancestry or an
 * agent's own env marker. A cron job or a monitor has neither and is not gated unless it uses
 * --tag problem; a program spawned from an agent session (it inherits the markers) passes
 * --automated, which skips the layouts but never the problem action/result requirements, and still
 * detects asks.
 */
export function isAgentAuthored(sender: SenderContext): boolean {
  return sender.ancestor !== null || AGENT_ENV_MARKERS.some((key) => Boolean(sender.env[key]))
}

/**
 * Unattached-file gate (feature `file-mention-guard`, features/cli/file-mention-gate.ts): same
 * senders as the intent gate below, minus --automated (a program cannot act on the refusal, and a
 * dropped alert costs more than a path in it). A body whose prose names an existing local file the
 * send does not attach is refused with the `--file` command: the reader cannot open a path on a
 * phone (tg#22056), and the text never attaches a file by itself (tg-cli#648). It reads the
 * agent-authored fields the dictionary gate reads: for --table the raw rows, which the rendered
 * caption hides inside a <pre>.
 */
export function guardUnattachedFiles(send: SendAction, dictFields: DictionaryField[], home: string): void {
  const authored = dictFields.map((field) => field.text).join("\n")
  const unattached = unattachedFileMentions(authored, send.items.map((it) => it.path), {
    cwd: process.cwd(),
    home,
    documentRoots: [realOr(home), realOr(tmpdir())],
    stat: (path) => {
      try {
        const st = statSync(path)
        return { isFile: st.isFile(), size: st.size, mode: st.mode, id: `${st.dev}:${st.ino}`, realPath: realpathSync(path) }
      } catch {
        return null
      }
    },
  })
  if (unattached.length > 0) {
    console.error(`Error: ${formatUnattachedFileError(unattached, process.argv.slice(2), send.table === true)}`)
    process.exit(1)
  }
}

function passVerdict(): IntentVerdict {
  return { action: "pass", kinds: [], hints: [] }
}

/**
 * Laya uses the existing warm socket within TG_LAYA_TIMEOUT_MS: ask scores are hints, problem
 * negatives can block. Unavailable inference falls back to deterministic checks with an explicit
 * diagnostic. Dry-run never connects to either classifier.
 */
async function classifyWithLaya(
  send: SendAction,
  caption: string,
  env: MergedEnv,
  intentInput: { body: string; tag: string | undefined; automated: boolean },
): Promise<IntentVerdict> {
  const { tag, dryRun } = send
  return classifyIntent({
    ...intentInput,
    layaAskProbability: !dryRun && tag !== "problem" && layaWorthAsking(intentInput) ? await layaAskProbability(caption, env) : null,
    layaProblemAssessment: tag === "problem"
      ? dryRun ? { status: "skipped", reason: "dry-run" } : await layaProblemAssessment(caption, env)
      : undefined,
  })
}

/** Reports (and, when enforced, stops on) a blocking verdict; prints hints of a passing one. */
function reportIntentVerdict(intent: IntentVerdict, tag: string | undefined, env: MergedEnv): void {
  if (intent.action === "pass" && intent.hints.length > 0) console.error(formatIntentVerdict(intent))
  if (intent.action !== "block") return
  // A malformed --tag decision body was already reported (and, when enforced,
  // stopped) by the escalation-format gate above: never print that checklist twice.
  if (tag !== undefined && isEscalationTag(tag) && intent.reason === "malformed-decision") return
  console.error(formatIntentVerdict(intent))
  if (intent.reason === "incomplete-problem-remediation" || escalationGateEnforced(env)) {
    console.error("Blocked: nothing was sent. Fix the message and resend (iterate with --dry-run).")
    process.exit(1)
  }
  console.error("tg: ESCALATION_GATE_ENFORCE=0 — the intent gate is advisory; sending anyway.")
}

/**
 * Intent gate (tg-cli#706, features/cli/intent-gate.ts): every agent-written body, tagged or not:
 * a question outside the decision-request format, a malformed problem/report, or a
 * decision+problem+report mix BLOCKS (exit 1); a sendable message that also asks something,
 * carries several decisions or hides a blocker is SENT and owes one reply per item (recorded after
 * the send). Every explicit problem also requires actual actions/results plus current recovery.
 * Scope: see `isAgentAuthored`.
 */
export async function runIntentGate(send: SendAction, caption: string, env: MergedEnv, agentAuthored: boolean): Promise<IntentVerdict> {
  const { tag } = send
  const automatedFlag = send.automated === true
  // A sender with no agent identity (cron, monitor) keeps only the remediation requirement; the
  // report layout checks stay agent-only, as they were before the problem gate became unconditional.
  const intentInput = { body: caption, tag, automated: automatedFlag || (tag === "problem" && !agentAuthored) }
  const nonAgentProblem = tag === "problem" && !agentAuthored && !automatedFlag
  const verdict: IntentVerdict =
    agentAuthored || intentInput.automated || tag === "problem" ? await classifyWithLaya(send, caption, env, intentInput) : passVerdict()
  // Only a missing-remediation block applies to a sender with no agent identity: a cron's "threshold
  // reached?" must not record an obligation that fails every later `tg obligations --check`, nor
  // mail a classifier-unavailable hint on every run.
  const intent: IntentVerdict = nonAgentProblem && verdict.action !== "block" ? passVerdict() : verdict
  reportIntentVerdict(intent, tag, env)
  return intent
}
