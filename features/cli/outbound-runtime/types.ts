// Shared stage contracts of the outbound `tg` pipeline (tg-cli#817).
//
// The `tg` entrypoint used to be one 2400-line `if (import.meta.main)` block whose locals flowed
// from each step to the next. The runtime is now a fixed sequence of stages; every value a later
// stage read from an earlier stage's locals is a named field below. The stages run in the original
// order — stderr/stdout order, exits, and side effects (processes spawned, files written) are part
// of the CLI contract — see `run.ts`.
//
// Types only: no code, no I/O.
import type { FileCheckDeps } from "../../auto-attach/file-check"
import type { FeatureMap } from "../../auto-attach/feature-flags"
import type { SendPlan } from "../../auto-attach/types"
import type { GhRef } from "../../autolink-prs/resolve"
import type { TicketInfo } from "../../autolink-tasks/linear"
import type { HistoryRecord } from "../../replies/history"
import type { AgentAncestor } from "../../tg-ctl/discover"
import type { HostRecord } from "../../tg-ctl/host-registry"
import type { SessionEntry } from "../../tg-ctl/session-registry"
import type { ControlConfig, CtlPaths } from "../../tg-ctl/types"
import type { OutboxRoute } from "../../transport/outbox"
import type { Format, ParseResult } from "../args"
import type { DictionaryField } from "../dict-gate"
import type { IntentVerdict } from "../intent-gate"
import type { ResolvedSession } from "../session-topic"

/** The merged environment: config `.env` first, then `process.env` wins. */
export type MergedEnv = Record<string, string | undefined>

/** Where this `tg` lives and reads its config from. `rootDir` is the entrypoint's `import.meta.dir`. */
export interface RuntimePaths {
  /** Directory of the `tg` entrypoint (sibling `tg-ctl` lives here). Never `import.meta.dir` of a module. */
  rootDir: string
  /** `process.env.HOME ?? "~"` */
  home: string
  /** `process.env.TG_CTL_CONFIG_DIR || join(home, ".config", "tg-cli")` */
  configDir: string
}

export type SendAction = Extract<ParseResult, { action: "send" }>
export type { FeatureMap }

/** Result of the argv/feature/stdin stage (`parse-invocation.ts`). */
export interface Invocation {
  /** Never `help` / `version` / `formatHelp` / `error` here: those exit inside the stage. */
  parsed: ParseResult
  features: FeatureMap
  configYamlRaw: string
  /** argv after the entrypoint's subcommand rewrites (`user` → `replies user`, `report` splice). */
  rawArgs: string[]
}

export interface SessionNameParts {
  primary: string
  secondary: string | null
}

/** Who is sending: model/emoji brand, credentials and the session identity (`sender-*.ts`). */
export interface SenderContext {
  env: MergedEnv
  /** `detectAiModel()` result, "" when undetermined. */
  model: string
  /** `detectAiEmoji()` result. */
  aiEmoji: string
  botToken: string | undefined
  chatId: string | undefined
  /** `Number(chatId)` when finite, else undefined. */
  currentChatId: number | undefined
  /** `${TG_API_BASE || https://api.telegram.org}/bot${botToken}` */
  api: string
  /** `ctlPaths(configDir, botIdFromToken(env.TG_BOT_TOKEN ?? "")).sessions` */
  sessionsPath: string
  /** `--session` flag, else `TG_SESSION` env (trimmed), else null. */
  pinId: string | null
  pinned: SessionEntry | null
  /** undefined: no pin (tree decides); null: the pin named no live session; else the pinned key. */
  pinnedKey: string | null | undefined
  ancestry: AgentAncestor[]
  ancestor: AgentAncestor | null
  ompAncestorPid: number | null
  /** A send with NO session (unmatched pin / unpinned omp broker job). */
  sessionless: boolean
  hasSessionIdentity: boolean
  ownHost: HostRecord | null
  /** The harness title candidate (dropped by content guards when unfit). */
  harnessTitle: string
  /** `sessionNameFor` of the original: resolves the `[window]` name from a (possibly dropped) title. */
  sessionNameFor: (title: string) => SessionNameParts
}

/** The `TG_TOPIC` env / `--topic` selection that the thread stage may later adjust. */
export interface ThreadSelection {
  messageThreadId: number | undefined
  /** true when the topic came from the TG_TOPIC env (a rejection falls back to General). */
  threadIdAdvisory: boolean
}

/** The authored message after assembly and every local content gate (`prepare-message*.ts`). */
export interface PreparedMessage {
  /** Final assembled caption/body (table / pipe-table converted, escapes decoded). */
  caption: string
  effectiveFormat: Format
  dictFields: DictionaryField[]
  /** Explicit `--title`, else the session's secondary name, else undefined. */
  title: string | undefined
  /** `sessionName.primary` — the `[window]` bracket. */
  sessionNamePrimary: string
  /** `senderRole(subagent, env).label` */
  agentLabel: string | undefined
  intent: IntentVerdict
  agentAuthored: boolean
  thread: ThreadSelection
}

/** Verified ticket/PR/message-reference lookups (`autolink-resolve.ts`). */
export interface AutolinkFindings {
  tickets: TicketInfo[]
  hasTickets: boolean
  refs: Map<number, GhRef>
  refOrder: number[]
  hasRefs: boolean
  rawMsgRefIds: number[]
  msgRefPreviewOn: boolean
  hasMsgRefs: boolean
  /** hasTickets || hasRefs || hasMsgRefs */
  hasAutolink: boolean
  readMsgRefHistory: (ids: number[]) => HistoryRecord[]
}

/** The built plan plus the temp dirs the PDF passes created (removed after transmit). */
export interface BuiltPlan {
  plan: SendPlan
  pdfTempDirs: string[]
}

/** Route / history bookkeeping of one send (`outbound-recorder.ts`). */
export interface OutboundRecorder {
  /** Every outbound message id of this send, in order. */
  outboundIds: number[]
  /** The thread each outbound message landed in (null = General). */
  outboundThreads: Map<number, number | null>
  recordRoute: (messageId: number, threadId: number | null) => void
  recordOutboundHistory: (body: string, write?: (recs: HistoryRecord[]) => void) => void
  /** The route a queued send replays (undefined when this send has no origin). */
  outboxRoute: () => OutboxRoute | undefined
}

/** Where the send posts (`topic-resolution.ts`). */
export interface ThreadResolution {
  messageThreadId: number | undefined
  threadIdAdvisory: boolean
  /** Non-null only when the daemon answered with a topic thread. */
  sessionTopic: ResolvedSession | null
  ctlFiles: CtlPaths
  ctlCfg: ControlConfig
}

/** Everything the delivery stage needs. */
export interface OutboundRun {
  paths: RuntimePaths
  send: SendAction
  features: FeatureMap
  sender: SenderContext
  prepared: PreparedMessage
  built: BuiltPlan
  recorder: OutboundRecorder
  thread: ThreadResolution
  fileCheckDeps: FileCheckDeps
}
