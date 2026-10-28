// Characterization of the pure decision helpers behind daemon-runtime/execute-action.ts and
// late-taps-{hatch,question}.ts (guardian-817 modular refactor). The orchestration itself is pinned by the
// spawned-daemon integration tests (ctl-hatch-*, ctl-question-*, ctl-owner-only-*, ctl-concurrent-dispatch).
import { describe, expect, test } from "bun:test"
import {
  actionResourceKey,
  isCardAnswerAction,
  isStillAnswered,
  liveAnswerFinalText,
  shouldCacheAnswerForReplay,
  withCardMessageId,
} from "../features/tg-ctl/daemon-runtime/execute-action"
import { isForeignCardTap, postInjectFailure, retainedEntryAcceptsLateTap } from "../features/tg-ctl/daemon-runtime/late-taps-question"
import { lateDenyNoticeWanted, lateDenyToast } from "../features/tg-ctl/daemon-runtime/late-taps-hatch"
import { ANSWERED_REPLAY_MS, GRACE_WINDOW_MS } from "../features/tg-ctl/daemon-runtime/button-requests"
import type { ButtonRequest } from "../features/tg-ctl/questions"
import type { Action } from "../features/tg-ctl/types"

const question = (extra: Partial<ButtonRequest> = {}): ButtonRequest => ({ requestId: "q1", agent: "claude", kind: "question", question: "pick?", options: [{ label: "A" }], ...extra })
const HATCH_ID = "hatch-block-reset-hard-0123456789ab"

describe("actionResourceKey", () => {
  const cases: Array<[Action, string | null]> = [
    [{ kind: "topic-route", threadId: 7, payload: {} as never }, "thread:7"],
    [{ kind: "topic-event", threadId: 9, event: "closed" }, "thread:9"],
    [{ kind: "topic-new-session", callbackQueryId: "c", threadId: 7, messageId: null }, "new-session"],
    [{ kind: "agent-cancel", callbackQueryId: "c", token: "tok", messageId: null }, "token:tok"],
    [{ kind: "answer-question", callbackQueryId: "c", requestId: "r1", value: "v", messageId: null }, "req:r1"],
    [{ kind: "close-question-card", callbackQueryId: "c", requestId: "r2", messageId: null }, "req:r2"],
    [{ kind: "limit-continue", callbackQueryId: "c", paneId: "%3", resetAt: 1, sourceMessageId: null, messageId: null }, "pane:%3"],
    [{ kind: "reply", text: "x" } as Action, null],
    [{ kind: "ack", messageId: 1 } as Action, null],
  ]
  for (const [action, key] of cases) test(`${action.kind} → ${key}`, () => expect(actionResourceKey(action)).toBe(key))
})

describe("withCardMessageId (Inbox-copy taps act on the card, tg-cli#705)", () => {
  const toCard = (id: number) => id + 1000
  test("answer-question with a message id is remapped", () => {
    const a: Action = { kind: "answer-question", callbackQueryId: "c", requestId: "r", value: "v", messageId: 5 }
    expect(withCardMessageId(a, toCard)).toEqual({ ...a, messageId: 1005 })
  })
  test("a null message id is left alone", () => {
    const a: Action = { kind: "close-question-card", callbackQueryId: "c", requestId: "r", messageId: null }
    expect(withCardMessageId(a, toCard)).toBe(a)
  })
  test("post-timeout reply remaps the question message id, not the reply's own id", () => {
    const a: Action = { kind: "post-timeout-question-reply", requestId: "r", questionMessageId: 5, text: "t", from: "u", messageId: 77 }
    expect(withCardMessageId(a, toCard)).toEqual({ ...a, questionMessageId: 1005 })
  })
  test("other kinds pass through untouched", () => {
    const a: Action = { kind: "inject-key", key: "Escape" }
    expect(withCardMessageId(a, toCard)).toBe(a)
  })
})

describe("isCardAnswerAction", () => {
  test("covers exactly the three answer paths the owner-only gate guards", () => {
    expect(isCardAnswerAction({ kind: "answer-question", callbackQueryId: "c", requestId: "r", value: "v", messageId: null })).toBe(true)
    expect(isCardAnswerAction({ kind: "close-question-card", callbackQueryId: "c", requestId: "r", messageId: null })).toBe(true)
    expect(isCardAnswerAction({ kind: "post-timeout-question-reply", requestId: "r", questionMessageId: 1, text: "t", from: "u", messageId: 2 })).toBe(true)
    expect(isCardAnswerAction({ kind: "kill-agent" })).toBe(false)
  })
})

describe("isStillAnswered", () => {
  const prior = (at: number) => ({ value: "v", label: "l", at, delivery: "socket" as const })
  test("no prior answer", () => expect(isStillAnswered(undefined, 10_000)).toBe(false))
  test("inside the replay window (inclusive)", () => expect(isStillAnswered(prior(1000), 1000 + ANSWERED_REPLAY_MS)).toBe(true))
  test("past the replay window", () => expect(isStillAnswered(prior(1000), 1000 + ANSWERED_REPLAY_MS + 1)).toBe(false))
})

describe("shouldCacheAnswerForReplay (tg-cli#97)", () => {
  test("a lone question is cached", () => expect(shouldCacheAnswerForReplay(question())).toBe(true))
  test("a multi-question set member is never cached", () => expect(shouldCacheAnswerForReplay(question({ multiQuestion: true }))).toBe(false))
  test("a permission is never cached", () => expect(shouldCacheAnswerForReplay(question({ kind: "permission" }))).toBe(false))
})

describe("liveAnswerFinalText", () => {
  test("a tapped option reads as the selected answer", () => {
    expect(liveAnswerFinalText(question(), "A", undefined)).toContain("Selected answer: A")
  })
  test("a typed chat answer is trimmed and marked answered-in-chat", () => {
    const text = liveAnswerFinalText(question(), "ignored", "  use B  ")
    expect(text).toContain("answered in chat: use B")
    expect(text).not.toContain("Selected answer")
  })
})

describe("retainedEntryAcceptsLateTap", () => {
  test("a pane-scoped question accepts", () => expect(retainedEntryAcceptsLateTap(question({ paneId: "%1" }))).toBe(true))
  test("a paneless question does not", () => expect(retainedEntryAcceptsLateTap(question())).toBe(false))
  test("a paneless hatch permission still accepts (carve-out)", () => {
    expect(retainedEntryAcceptsLateTap(question({ kind: "permission", requestId: HATCH_ID }))).toBe(true)
  })
  test("a paneless non-hatch permission does not", () => {
    expect(retainedEntryAcceptsLateTap(question({ kind: "permission", requestId: "perm-1" }))).toBe(false)
  })
})

describe("isForeignCardTap", () => {
  test("same card", () => expect(isForeignCardTap(5, 5)).toBe(false))
  test("different card", () => expect(isForeignCardTap(5, 6)).toBe(true))
  test("own id unknown (send in flight) → resolved in the tap's favour", () => expect(isForeignCardTap(null, 6)).toBe(false))
  test("tap id unknown", () => expect(isForeignCardTap(5, null)).toBe(false))
})

describe("postInjectFailure", () => {
  test("unreadable re-capture is never confirmed-by-default", () => expect(postInjectFailure("unreadable")).toMatch(/re-capture failed/))
  test("the same menu still pending is not confirmed", () => expect(postInjectFailure("still-pending")).toMatch(/still showing/))
  test("resolved and next-menu both count as delivered", () => {
    expect(postInjectFailure("resolved")).toBeNull()
    expect(postInjectFailure("next-menu")).toBeNull()
  })
})

describe("late hatch deny notice (tg-cli#403 (d))", () => {
  test("inside the grace window a notice is wanted", () => expect(lateDenyNoticeWanted(1000, 1000, null)).toBe(true))
  test("past grace with nothing revoked it is noise", () => expect(lateDenyNoticeWanted(1000 + GRACE_WINDOW_MS, 1000, null)).toBe(false))
  test("past grace a revocation must still be told", () => expect(lateDenyNoticeWanted(1000 + GRACE_WINDOW_MS, 1000, "hgr-1")).toBe(true))
  test("toast variants", () => {
    expect(lateDenyToast(null, false, false)).toBe("denied")
    expect(lateDenyToast(null, true, true)).toBe("denied — the agent was told")
    expect(lateDenyToast(null, true, false)).toBe("denied — could not reach the agent")
    expect(lateDenyToast("hgr-1", true, true)).toBe("denied — grant hgr-1 revoked — the agent was told")
  })
})
