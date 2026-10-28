// daemon-runtime/run-daemon: the composition root of `tg-ctl run`.
//
// The daemon used to be one 5500-line closure. It is now a fixed sequence of parts, each a
// factory in its own module that receives the shared `ctx`, the cross-part mutable `state`, and
// the APIs of the parts built before it. The order below is the order the closure's
// statements ran in, so every start-up side effect (flock, state restore, signal handlers,
// hook socket, first Inbox sync) happens at the same point as before.
//
// A part sometimes calls an operation that a LATER part builds (the picker, /new and
// action-execution flows call each other). Those calls go through `late`: forwarding functions
// that look the operation up when called, never while the parts are being built.
import type { Ctx } from "./ctx-io"
import { createAgentRoutes } from "./agent-routes"
import { createReactions } from "./ack-reactions"
import { createAutoContinue } from "./auto-continue"
import { createStartup } from "./daemon-startup"
import { createDaemonState } from "./daemon-state"
import { createLifecycle } from "./daemon-lifecycle-runtime"
import { createDeferQueue } from "./defer-queue"
import { createExecute, type ExecuteApi } from "./execute-action"
import { createInboundInject, type InboundInjectApi } from "./inbound-inject"
import { createLateTaps, type LateTapsApi } from "./late-taps"
import type { LateApi } from "./late-api"
import { createMedia } from "./media-voice"
import { createNewSession, type NewSessionApi } from "./new-session"
import { createPicker } from "./picker-state"
import { runPollLoop } from "./poll-loop"
import { createQuestionInbox } from "./question-inbox-runtime"
import { createReminders } from "./reminders-restore"
import { createTargetRouting } from "./target-routing"
import { createTopicRouting } from "./topic-routing"
import { createTopicSpawn, type TopicSpawnApi } from "./topic-spawn"

/** The parts that are built after some earlier part already needs one of their operations. */
export interface LaterParts {
  inboundInject?: InboundInjectApi
  lateTaps?: LateTapsApi
  execute?: ExecuteApi
  topicSpawn?: TopicSpawnApi
  newSession?: NewSessionApi
}

function built<T>(part: T | undefined, name: string): T {
  if (part === undefined) throw new Error(`daemon part "${name}" was called before it was built`)
  return part
}

export function lateBindings(later: LaterParts): LateApi {
  return {
    postRoutePicker: (...args) => built(later.inboundInject, "inbound-inject").postRoutePicker(...args),
    executeAction: (...args) => built(later.execute, "execute-action").executeAction(...args),
    handlePostTimeoutQuestionReply: (...args) => built(later.lateTaps, "late-taps").handlePostTimeoutQuestionReply(...args),
    handleNewAnswer: (...args) => built(later.newSession, "new-session").handleNewAnswer(...args),
    askNewDir: (...args) => built(later.topicSpawn, "topic-spawn").askNewDir(...args),
    spawnNewSession: (...args) => built(later.newSession, "new-session").spawnNewSession(...args),
    spawnNewSessionWithTopic: (...args) => built(later.newSession, "new-session").spawnNewSessionWithTopic(...args),
  }
}

export async function runDaemon(ctx: Ctx): Promise<never> {
  const state = createDaemonState(ctx)
  const later: LaterParts = {}
  const late = lateBindings(later)

  const startup = createStartup({ ctx, state })
  const questionInbox = createQuestionInbox({ ctx, state, startup })
  const reminders = createReminders({ ctx, state, questionInbox, startup })
  const picker = createPicker({ ctx, state })
  const reactions = createReactions({ ctx, state })
  const deferQueue = createDeferQueue({ ctx, state, startup, picker, reactions, questionInbox, late })
  const lifecycle = createLifecycle({ ctx, state, deferQueue, picker })
  const targetRouting = createTargetRouting({ ctx, state })
  const inboundInject = createInboundInject({ ctx, state, startup, targetRouting, deferQueue, picker, reactions, late })
  later.inboundInject = inboundInject
  const agentRoutes = createAgentRoutes({ ctx, state, picker, targetRouting, inboundInject, deferQueue, reactions })
  const media = createMedia({ ctx, state, inboundInject, agentRoutes, targetRouting })
  const topicRouting = createTopicRouting({ ctx, state, targetRouting, media, inboundInject, agentRoutes, picker, reactions, late })
  const topicSpawn = createTopicSpawn({ ctx, state, targetRouting, late })
  later.topicSpawn = topicSpawn
  const newSession = createNewSession({ ctx, state, targetRouting, topicSpawn, topicRouting, picker, inboundInject })
  later.newSession = newSession
  const autoContinue = createAutoContinue({ ctx, state })
  const lateTaps = createLateTaps({ ctx, state, questionInbox, startup, deferQueue, targetRouting })
  later.lateTaps = lateTaps
  const execute = createExecute({ ctx, state, questionInbox, startup, targetRouting, lateTaps, deferQueue, autoContinue, agentRoutes, inboundInject, media, topicRouting, newSession, reactions })
  later.execute = execute

  return runPollLoop({ ctx, state, newSession, topicRouting, startup, picker, lifecycle, targetRouting, questionInbox, reminders, autoContinue, execute })
}
