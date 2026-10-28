import { describe, expect, test } from "bun:test"
import { attachSummary, isStalePicker } from "../features/tg-ctl/daemon-runtime/topic-routing-attach"
import { payloadsNotPassed, planHeldTask } from "../features/tg-ctl/daemon-runtime/topic-routing-hold"
import { planCommandDir, newSessionFromCommand, replayedNewReply } from "../features/tg-ctl/daemon-runtime/new-session-plan"
import { readCreatedTopic, reportsTopicsDisabled } from "../features/tg-ctl/daemon-runtime/topic-spawn-private"
import type { TopicHold } from "../features/tg-ctl/topics"
import type { TopicPayload } from "../features/tg-ctl/types"

const text = (messageId: number, t: string): TopicPayload => ({ type: "text", text: t, plain: t, messageId }) as TopicPayload

describe("attach picker decisions", () => {
  const hold = { threadId: 7, pickerMessageId: 100, payloads: [] } as unknown as TopicHold
  test("a tap on another message than the current picker is stale", () => {
    expect(isStalePicker(hold, 99)).toBe(true)
    expect(isStalePicker(hold, 100)).toBe(false)
    expect(isStalePicker(hold, null)).toBe(false)
  })
  test("a hold without a picker is never stale", () => {
    expect(isStalePicker({ ...hold, pickerMessageId: null }, 5)).toBe(false)
  })
  test("summary reports failures and the stop reason", () => {
    expect(attachSummary("api", 3, 3, null)).toBe("→ api: 3 delivered")
    expect(attachSummary("api", 1, 3, "api stopped before delivery")).toBe("→ api: 1 delivered, 2 failed — api stopped before delivery")
  })
})

describe("held queue → first task", () => {
  test("texts join after the /new task, attachments are skipped", () => {
    const media = { type: "media", messageId: 2 } as unknown as TopicPayload
    const { texts, task } = planHeldTask("start", [text(1, "a"), media, text(3, "b")])
    expect(texts.map((p) => p.messageId)).toEqual([1, 3])
    expect(task).toBe("start\n\na\n\nb")
    expect(payloadsNotPassed([text(1, "a"), media, text(3, "b")], texts).map((p) => p.messageId)).toEqual([2])
  })
  test("blank task contributes nothing; stops at the first text past the cap", () => {
    const big = "x".repeat(64 * 1024)
    const { texts, task } = planHeldTask("", [text(1, "a"), text(2, big), text(3, "b")])
    expect(texts.map((p) => p.messageId)).toEqual([1])
    expect(task).toBe("a")
  })
})

describe("/new command planning", () => {
  test("a usable or absent dir passes through", () => {
    expect(planCommandDir("/p", "t", false, true)).toEqual({ dir: "/p", task: "t", rejected: null })
    expect(planCommandDir(null, "t", false, false)).toEqual({ dir: null, task: "t", rejected: null })
  })
  test("a command-shaped token after the name becomes the task front", () => {
    expect(planCommandDir("/compact", "now", true, false)).toEqual({ dir: null, task: "/compact now", rejected: null })
    expect(planCommandDir("/compact", "", true, false)).toEqual({ dir: null, task: "/compact", rejected: null })
  })
  test("a bad path is rejected, also when it precedes the name", () => {
    expect(planCommandDir("/no/such", "t", true, false).rejected).toBe("/no/such")
    expect(planCommandDir("/compact", "t", false, false).rejected).toBe("/compact")
  })
  test("session carries chat/source ids, harness and dir", () => {
    const s = newSessionFromCommand("n1", { name: "api", harness: "codex", model: null, chatId: 9, messageId: 4, threadId: 3 }, { dir: "/p", task: "t", rejected: null }, 1000)
    expect(s).toMatchObject({ token: "n1", name: "api", status: "awaiting-dir", task: "t", ts: 1000, threadId: 3, sourceChatId: 9, sourceMessageId: 4, dir: "/p", harness: "codex" })
    expect(newSessionFromCommand("n2", { name: "x", harness: null, model: null, chatId: 1, messageId: 2 }, { dir: null, task: "", rejected: null }, 5)).not.toHaveProperty("dir")
  })
  test("replayed /new reply depends on binding status", () => {
    expect(replayedNewReply({ name: "api", status: "bound" })).toContain("use `/agent api`")
    expect(replayedNewReply({ name: "api", status: "closed" })).toContain("topic state `closed`, not created again")
  })
})

describe("private topic API readers", () => {
  test("only has_topics_enabled === false counts as disabled", () => {
    expect(reportsTopicsDisabled({ has_topics_enabled: false })).toBe(true)
    expect(reportsTopicsDisabled({ has_topics_enabled: true })).toBe(false)
    expect(reportsTopicsDisabled({})).toBe(false)
    expect(reportsTopicsDisabled(null)).toBe(false)
  })
  test("createForumTopic result: thread id or the specific failure", () => {
    expect(readCreatedTopic({ message_thread_id: 42 })).toEqual({ ok: true, threadId: 42 })
    expect(readCreatedTopic(undefined)).toMatchObject({ ok: false, reason: expect.stringContaining("no topic object") })
    expect(readCreatedTopic({ message_thread_id: "42" })).toMatchObject({ ok: false, reason: expect.stringContaining("message_thread_id") })
  })
})
