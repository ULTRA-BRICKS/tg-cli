import { describe, expect, test } from "bun:test"
import { restoreCard, type RestoreContext } from "../features/tg-ctl/daemon-runtime/reminders-restore"
import { sentMessageId } from "../features/tg-ctl/daemon-runtime/question-inbox-runtime"
import { carryOverLegacyRow, collectNudgeInputs } from "../features/tg-ctl/daemon-runtime/poll-loop-nudge"
import { isRoutedReply, stampPaneForRecognizedReply } from "../features/tg-ctl/daemon-runtime/poll-loop-history"
import {
  findPostTimeoutQuestionId,
  formatLocalMinute,
  offsetPastBatch,
  receivedLedgerEvent,
  resourceKeyOfGroup,
  withoutProcessed,
} from "../features/tg-ctl/daemon-runtime/poll-loop-batch"
import type { LiveOmpAgent } from "../features/tg-ctl/omp"
import type { Action, TgMessage, TgUpdate } from "../features/tg-ctl/types"
import type { AwarenessNudgeStore } from "../features/tg-ctl/tg-awareness-nudge"
import type { Ctx } from "../features/tg-ctl/daemon-runtime/ctx-io"
import type { BotPostResult } from "../features/tg-ctl/daemon-runtime/telegram-api"

const upd = (id: number): TgUpdate => ({ update_id: id }) as TgUpdate

describe("batch bookkeeping", () => {
  test("offsetPastBatch advances past the highest update id, never backwards", () => {
    expect(offsetPastBatch([upd(5), upd(9), upd(7)], 3)).toBe(10)
    expect(offsetPastBatch([upd(1)], 50)).toBe(50)
    expect(offsetPastBatch([], 4)).toBe(4)
  })

  test("withoutProcessed drops only finished updates; no ledger keeps the whole batch", () => {
    const batch = [upd(1), upd(2), upd(3)]
    expect(withoutProcessed(batch, new Set([2])).map((u) => u.update_id)).toEqual([1, 3])
    expect(withoutProcessed(batch, undefined).map((u) => u.update_id)).toEqual([1, 2, 3])
  })

  const ctx = { chatId: 100, cfg: { allowedSenders: [200] } } as unknown as Pick<Ctx, "chatId" | "cfg">
  const message = (chat: number, from: number | undefined): TgUpdate =>
    ({ update_id: 8, message: { message_id: 77, date: 1234, chat: { id: chat }, from: from === undefined ? undefined : { id: from } } }) as unknown as TgUpdate

  test("receivedLedgerEvent carries chat+msg only for the bound chat from an allowed sender", () => {
    const full = { ts: 5, event: "received", update: 8, date: 1234, chat: 100, msg: 77 }
    expect(receivedLedgerEvent(message(100, 100), ctx, 999, 5)).toEqual(full)
    expect(receivedLedgerEvent(message(100, 200), ctx, 999, 5)).toEqual(full)
    const bare = { ts: 5, event: "received", update: 8, date: 1234 }
    expect(receivedLedgerEvent(message(100, 300), ctx, 999, 5)).toEqual(bare)
    expect(receivedLedgerEvent(message(555, 100), ctx, 999, 5)).toEqual(bare)
    expect(receivedLedgerEvent(message(100, undefined), ctx, 999, 5)).toEqual(bare)
  })

  test("receivedLedgerEvent falls back to the receive time for a non-message update", () => {
    expect(receivedLedgerEvent(upd(3), ctx, 999, 5)).toEqual({ ts: 5, event: "received", update: 3, date: 999 })
  })

  test("formatLocalMinute is a zero-padded local YYYY-MM-DD HH:MM", () => {
    const local = new Date(2026, 0, 2, 3, 4, 5)
    expect(formatLocalMinute(local.getTime() / 1000)).toBe("2026-01-02 03:04")
  })

  test("resourceKeyOfGroup takes the first action that has a key", () => {
    const a = { kind: "a" } as Action
    const b = { kind: "b" } as Action
    const c = { kind: "c" } as Action
    const keyOf = (x: Action): string | null => (x.kind === "a" ? null : `key-${x.kind}`)
    expect(resourceKeyOfGroup([a, b, c], keyOf)).toBe("key-b")
    expect(resourceKeyOfGroup([a], keyOf)).toBeNull()
    expect(resourceKeyOfGroup([], keyOf)).toBeNull()
  })
})

describe("post-timeout question card lookup", () => {
  const card = (messageId: number | null, kind: string, extra: { multiQuestion?: boolean; paneId?: string } = {}) => ({ messageId, req: { kind, ...extra } })

  test("a live question card matches without needing a pane", () => {
    const pending = new Map([["live", card(10, "question")]])
    expect(findPostTimeoutQuestionId(pending, new Map(), 10)).toBe("live")
  })

  test("a retained card must be scoped to a pane and not multi-question", () => {
    const retained = new Map([
      ["unscoped", card(10, "question")],
      ["multi", card(10, "question", { multiQuestion: true, paneId: "%1" })],
      ["perm", card(10, "permission", { paneId: "%1" })],
      ["ok", card(10, "question", { paneId: "%1" })],
    ])
    expect(findPostTimeoutQuestionId(new Map(), retained, 10)).toBe("ok")
    expect(findPostTimeoutQuestionId(new Map(), retained, 11)).toBeNull()
  })

  test("live entries win over retained ones", () => {
    const pending = new Map([["live", card(10, "question")]])
    const retained = new Map([["old", card(10, "question", { paneId: "%1" })]])
    expect(findPostTimeoutQuestionId(pending, retained, 10)).toBe("live")
  })
})

describe("reply history stamping", () => {
  const msg = (m: Partial<TgMessage>): TgMessage => m as TgMessage

  test("isRoutedReply: prose and voice reply-route, a /command does not", () => {
    expect(isRoutedReply(msg({ text: "hello" }))).toBe(true)
    expect(isRoutedReply(msg({ text: "/status" }))).toBe(false)
    expect(isRoutedReply(msg({ text: "!ls" }))).toBe(true)
    expect(isRoutedReply(msg({ voice: {} as TgMessage["voice"] }))).toBe(true)
    expect(isRoutedReply(msg({}))).toBe(false)
  })

  test("stampPaneForRecognizedReply: confirmed → origin, missing pane → origin, reused visible pane → default", () => {
    expect(stampPaneForRecognizedReply("%3", true, true)).toBe("%3")
    expect(stampPaneForRecognizedReply("%3", false, false)).toBe("%3")
    expect(stampPaneForRecognizedReply("%3", true, false)).toBeNull()
  })
})

describe("awareness nudge inputs", () => {
  const agent = (over: Partial<LiveOmpAgent>): LiveOmpAgent => ({ pid: 1, cwd: null, sessionFile: null, sessionId: null, title: null, paneId: null, tty: null, ...over })
  const row = (sessionId: string | null, firstSeenAt = 1) => ({ firstSeenAt, lastTgSentAt: null, sessionId })

  test("a session-keyed agent adopts the pre-#459 locator row for the same session", () => {
    const store = { "%4": row("s1") } as unknown as AwarenessNudgeStore
    const next = carryOverLegacyRow(store, "omp:s1", "%4", "s1")
    expect(next["omp:s1"]).toBe(store["%4"])
  })

  test("carry-over never overwrites an existing row, a different session, or a locator-keyed agent", () => {
    const store = { "%4": row("s1"), "omp:s1": row("s1", 99) } as unknown as AwarenessNudgeStore
    expect(carryOverLegacyRow(store, "omp:s1", "%4", "s1")).toBe(store)
    const other = { "%4": row("s2") } as unknown as AwarenessNudgeStore
    expect(carryOverLegacyRow(other, "omp:s1", "%4", "s1")).toBe(other)
    expect(carryOverLegacyRow(other, "%4", "%4", "s2")).toBe(other)
  })

  test("collectNudgeInputs keys by session when published, else by locator, and reads sent-at through the locator", () => {
    const withSession = agent({ pid: 11, paneId: "%4", sessionId: "s1" })
    const anonymous = agent({ pid: 12 })
    const store = { "%4": row("s1") } as unknown as AwarenessNudgeStore
    const sentAt = new Map([["%4", 500], ["omp:12", 700]])
    const inputs = collectNudgeInputs([withSession, anonymous], sentAt, store)
    expect(inputs.keys).toEqual(["omp:s1", "omp:12"])
    expect(inputs.sentAtByKey.get("omp:s1")).toBe(500)
    expect(inputs.sentAtByKey.get("omp:12")).toBe(700)
    expect(inputs.sessionIdByKey.get("omp:s1")).toBe("s1")
    expect(inputs.sessionIdByKey.get("omp:12")).toBeNull()
    expect(inputs.store["omp:s1"]).toBe(store["%4"])
    expect(inputs.agentByKey.get("omp:12")).toBe(anonymous)
  })
})

describe("question restore", () => {
  const request = (over: Record<string, unknown>) => ({ requestId: "r1", agent: "claude", kind: "question", question: "pick?", paneId: "%1", options: [{ label: "yes", value: "yes" }], ...over })

  const context = (decidedKeys: string[] = [], graceFor = false) => {
    const graceCalls: Array<{ messageId: number | null; expiredAt: number }> = []
    const rc: RestoreContext = {
      ctx: {} as Ctx,
      grantsData: { grace: [], grants: [], decided: decidedKeys.map((key) => ({ key })) } as unknown as RestoreContext["grantsData"],
      abandonedButtons: new Map(),
      answeredButtons: new Map(),
      ensureHatchGrace: (_req, _key, messageId, expiredAt) => {
        graceCalls.push({ messageId, expiredAt })
        return graceFor
      },
      persistGrants: () => true,
      persistQuestions: () => {},
      reminderRetirePath: "/unused",
    }
    return { rc, graceCalls }
  }

  test("a scoped question is restored into abandonedButtons", () => {
    const { rc } = context()
    const restored = restoreCard(rc, { req: request({}), messageId: 5, at: 1000 }, 9000)
    expect(restored).toEqual({ decided: false, pending: false, grace: false })
    expect(rc.abandonedButtons.get("r1")?.messageId).toBe(5)
  })

  test("unscoped, option-less and malformed records are skipped", () => {
    const { rc } = context()
    const skipped = { decided: false, pending: false, grace: false }
    expect(restoreCard(rc, { req: request({ paneId: undefined }), messageId: 5, at: 1 }, 9)).toEqual(skipped)
    expect(restoreCard(rc, { req: request({ options: [] }), messageId: 5, at: 1 }, 9)).toEqual(skipped)
    expect(restoreCard(rc, { req: { nonsense: true }, messageId: 5, at: 1 }, 9)).toEqual(skipped)
    expect(rc.abandonedButtons.size).toBe(0)
  })

  test("an already-decided card stays closed and asks for a persist", () => {
    const { rc } = context(["r1"])
    expect(restoreCard(rc, { req: request({}), messageId: 5, at: 1 }, 9)).toEqual({ decided: true, pending: false, grace: false })
    expect(rc.abandonedButtons.size).toBe(0)
  })

  test("a pending non-critical ask expires no later than ASK_LIVE_MAX_MS after posting; a critical one expires now", () => {
    const { rc, graceCalls } = context([], true)
    const now = 10_000_000_000
    const stale = restoreCard(rc, { req: request({}), messageId: 5, at: 1, pending: true }, now)
    expect(stale).toEqual({ decided: false, pending: true, grace: true })
    expect(graceCalls[0].expiredAt).toBeLessThan(now)
    expect(graceCalls[0].expiredAt).toBeGreaterThan(1)
    restoreCard(rc, { req: request({ requestId: "r2", critical: true }), messageId: 6, at: 1, pending: true }, now)
    expect(graceCalls[1].expiredAt).toBe(now)
    restoreCard(rc, { req: request({ requestId: "r3" }), messageId: 7, at: 42 }, now)
    expect(graceCalls[2].expiredAt).toBe(42)
  })

  test("a queued decision survives only on a permission record", () => {
    const { rc } = context()
    const queuedDecision = { value: "allow", label: "Allow", decision: "allow" as const, at: 3 }
    restoreCard(rc, { req: request({ requestId: "q" }), messageId: 1, at: 1, queuedDecision }, 9)
    expect(rc.abandonedButtons.get("q")?.queuedDecision).toBeUndefined()
    restoreCard(rc, { req: request({ requestId: "p", kind: "permission" }), messageId: 2, at: 1, queuedDecision }, 9)
    expect(rc.abandonedButtons.get("p")?.queuedDecision).toEqual(queuedDecision)
  })
})

describe("inbox post result parsing", () => {
  test("sentMessageId reads a numeric message_id and nothing else", () => {
    expect(sentMessageId({ ok: true, json: { ok: true, result: { message_id: 12 } } } as unknown as BotPostResult)).toBe(12)
    expect(sentMessageId({ ok: true, json: { ok: true, result: { message_id: "12" } } } as unknown as BotPostResult)).toBeUndefined()
    expect(sentMessageId({ ok: true, json: { ok: true, result: true } } as unknown as BotPostResult)).toBeUndefined()
    expect(sentMessageId({ ok: false, description: "nope" } as unknown as BotPostResult)).toBeUndefined()
  })
})
