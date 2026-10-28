// daemon-runtime/late-api: the few daemon operations a part of runDaemon calls that are built
// by a part initialised AFTER it (picker <-> execute <-> /new flows call each other).
//
// runDaemon builds each part once, in order, and hands later parts the earlier ones' APIs. A call
// that points the other way cannot be a value at build time, so it arrives as a forwarding
// function from here: it resolves the real operation when called, never while the parts are
// being built. The types are written out because inferring them from the later parts would make
// the earlier parts' types depend on themselves.
import type { AgentCandidate } from "../agent-match"
import type { NewSession } from "../new-command"
import type { Action } from "../types"

export interface LateApi {
  postRoutePicker(
    subset: AgentCandidate[],
    prewrappedText: string,
    notice?: string,
    sourceMessageId?: number | null,
    relatedReactionMessageId?: number | null,
  ): Promise<boolean>
  executeAction(action: Action, precedingOk: boolean): Promise<boolean>
  handlePostTimeoutQuestionReply(action: Extract<Action, { kind: "post-timeout-question-reply" }>, status?: string): Promise<boolean>
  handleNewAnswer(action: Extract<Action, { kind: "new-answer" }>, bindThreadId?: number): Promise<boolean>
  askNewDir(session: NewSession): Promise<void>
  spawnNewSession(session: NewSession, modelId: string, promptMessageId: number | null): Promise<boolean>
  spawnNewSessionWithTopic(
    session: NewSession,
    modelId: string,
    threadId: number,
    slug: string,
    promptMessageId: number | null,
    task?: NewSession["task"],
  ): Promise<boolean>
}
