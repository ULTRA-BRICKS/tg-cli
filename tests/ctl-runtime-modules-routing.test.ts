// Pure decision helpers behind daemon-runtime inbound-inject / agent-routes (guardian-817 modular refactor).
import { describe, expect, test } from "bun:test"
import { goneNotice, goneOriginLabel } from "../features/tg-ctl/daemon-runtime/agent-routes-reply"
import { pickerTapReaction, resolveAgentTap } from "../features/tg-ctl/daemon-runtime/agent-routes-command"
import { outcomeOf, routableText } from "../features/tg-ctl/daemon-runtime/inbound-inject-delivery"
import { sessionKeyAtPaneOnServer } from "../features/tg-ctl/daemon-runtime/inbound-inject"
import type { AgentCandidate } from "../features/tg-ctl/agent-match"
import type { PendingAgentEntry, DeferredInbound } from "../features/tg-ctl/daemon-runtime/daemon-types"
import type { SessionEntry } from "../features/tg-ctl/session-registry"

const candidate = (paneId: string): AgentCandidate => ({ paneId, windowName: paneId, agent: "claude" }) as AgentCandidate

// The picker's expiry timer is never fired here; an inert, already-cleared handle stands in for it.
const inertTimer = setTimeout(() => {}, 0)
clearTimeout(inertTimer)

const pendingWith = (over: Partial<PendingAgentEntry>): PendingAgentEntry => ({
  message: "hi",
  candidates: [candidate("%1"), candidate("%2")],
  messageId: 50,
  sourceMessageId: 7,
  relatedReactionMessageId: null,
  timer: inertTimer,
  ...over,
})

describe("routableText", () => {
  test.each([
    [undefined, null],
    ["", null],
    ["  \n ", null],
    ["fix it", "fix it"],
    [" padded ", " padded "],
  ])("%p → %p", (input, expected) => expect(routableText(input)).toBe(expected))
})

describe("outcomeOf", () => {
  test("a delivered sink is ok without an error", () => expect(outcomeOf({ ok: true })).toEqual({ ok: true }))
  test("a failed sink keeps its error text", () => expect(outcomeOf({ ok: false, error: "boom" })).toEqual({ ok: false, error: "boom" }))
})

describe("sessionKeyAtPaneOnServer", () => {
  const entry = (serverPid: number | undefined) => ({ key: "s1", locators: { tmux: serverPid === undefined ? undefined : { serverPid } } }) as unknown as SessionEntry
  test("no registry entry → no key", () => expect(sessionKeyAtPaneOnServer(null, 10)).toBeUndefined())
  test("unknown daemon server → the entry is trusted", () => expect(sessionKeyAtPaneOnServer(entry(99), null)).toBe("s1"))
  test("same tmux server → the entry's key", () => expect(sessionKeyAtPaneOnServer(entry(10), 10)).toBe("s1"))
  test("another tmux server's entry for the same pane id is another session's", () => expect(sessionKeyAtPaneOnServer(entry(11), 10)).toBeUndefined())
  test("an entry without a tmux server pid never matches a known server", () => expect(sessionKeyAtPaneOnServer(entry(undefined), 10)).toBeUndefined())
})

describe("goneOriginLabel / goneNotice", () => {
  test("the recorded project dir's basename names the gone agent", () => expect(goneOriginLabel({ cwd: "/home/u/proj/", paneId: "%3" })).toBe("proj"))
  test("a root cwd has no basename → the pane id", () => expect(goneOriginLabel({ cwd: "/", paneId: "%3" })).toBe("%3"))
  test("no recorded cwd → the pane id", () => expect(goneOriginLabel({ paneId: "omp:42" })).toBe("omp:42"))
  test("no recognized route → generic wording", () => expect(goneOriginLabel(null)).toBe("the agent you replied to"))
  test("notice names the agent", () => expect(goneNotice("proj")).toBe("That agent (proj) is no longer running — pick a live one:"))
})

describe("resolveAgentTap", () => {
  test("unknown token → stale", () => expect(resolveAgentTap(undefined, { messageId: 50, index: 0 })).toBeNull())
  test("a tap from another Telegram message (reused token after restart) → stale", () => {
    expect(resolveAgentTap(pendingWith({ messageId: 50 }), { messageId: 51, index: 0 })).toBeNull()
  })
  test("an index outside the candidates → stale", () => expect(resolveAgentTap(pendingWith({}), { messageId: 50, index: 2 })).toBeNull())
  test("matching message picks the indexed candidate", () => {
    const pending = pendingWith({})
    expect(resolveAgentTap(pending, { messageId: 50, index: 1 })).toEqual({ pending, target: pending.candidates[1] })
  })
  test("a tap without a message id, or a prompt without one, skips the message check", () => {
    const pending = pendingWith({})
    expect(resolveAgentTap(pending, { messageId: null, index: 0 })?.target.paneId).toBe("%1")
    expect(resolveAgentTap(pendingWith({ messageId: null }), { messageId: 99, index: 0 })?.target.paneId).toBe("%1")
  })
})

describe("pickerTapReaction", () => {
  const item = (state: DeferredInbound["state"]) => ({ state }) as DeferredInbound
  test("queued behind an open question → ✍️ on the source message", () => {
    expect(pickerTapReaction({ ok: true, deferred: true, deferredItem: item("queued") }, 7)).toEqual({ kind: "defer", messageId: 7 })
    expect(pickerTapReaction({ ok: true, deferred: true }, 7)).toEqual({ kind: "defer", messageId: 7 })
  })
  test("already flushed by the time of the tap → 👀; dead-lettered → no reaction", () => {
    expect(pickerTapReaction({ ok: true, deferred: true, deferredItem: item("delivered") }, 7)).toEqual({ kind: "seen" })
    expect(pickerTapReaction({ ok: true, deferred: true, deferredItem: item("dead-lettered") }, 7)).toEqual({ kind: "none" })
  })
  test("a deferred tap with no source message falls to the delivered rule (👀)", () => {
    expect(pickerTapReaction({ ok: true, deferred: true }, null)).toEqual({ kind: "seen" })
  })
  test("delivered → 👀; failed → nothing", () => {
    expect(pickerTapReaction({ ok: true }, 7)).toEqual({ kind: "seen" })
    expect(pickerTapReaction({ ok: false, error: "inject failed" }, 7)).toEqual({ kind: "none" })
  })
})
