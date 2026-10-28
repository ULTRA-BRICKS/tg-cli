// Characterization of daemon-runtime/delivery.ts inject-plan executors, sendOriginalOmp's
// rejection mapping (guardian-817 modular refactor).
import { describe, expect, test } from "bun:test"
import { runInjectSteps, runInjectStepsSync, sendOriginalOmp } from "../features/tg-ctl/daemon-runtime/delivery"
import type { InjectStep } from "../features/tg-ctl/types"

const NO_ENDPOINT_PID = 2147483000

const plans: Array<[string, InjectStep[], { ok: true } | { ok: false; error: string }]> = [
  ["an empty plan is delivered", [], { ok: true }],
  ["tmux steps run in order and succeed", [{ kind: "tmux", argv: ["true"] }, { kind: "sleep", ms: 1 }, { kind: "tmux", argv: ["cat"], stdin: "hi" }], { ok: true }],
  ["a failing tmux step ends the plan with its stderr", [{ kind: "tmux", argv: ["sh", "-c", "echo boom >&2; exit 3"] }, { kind: "tmux", argv: ["false"] }], { ok: false, error: "sh -c echo boom >&2; exit 3 failed: boom" }],
  ["verify-pane with no agent in the pane fails before any later step", [{ kind: "verify-pane", paneId: "%9999" }, { kind: "tmux", argv: ["false"] }], { ok: false, error: "pane %9999 no longer hosts an agent — message not injected" }],
]

describe("inject plan executors", () => {
  for (const [name, steps, expected] of plans) {
    test(`async: ${name}`, async () => expect(await runInjectSteps(steps)).toEqual(expected))
    test(`sync: ${name}`, () => expect(runInjectStepsSync(steps)).toEqual(expected))
  }

  test("a permission menu that cannot be read stops the plan before the digit", async () => {
    const step: InjectStep = { kind: "verify-permission-menu", paneId: "%9999", target: { identity: "x", decision: "allow", digit: "1", box: "b" } as never }
    const expected = { ok: false, error: "permission menu changed before the digit was sent — nothing typed" }
    expect(await runInjectSteps([step])).toEqual(expected)
    expect(runInjectStepsSync([step])).toEqual(expected)
  })
})

describe("sendOriginalOmp with no endpoint and no hosting terminal", () => {
  test("endpoint_unavailable falls through to the install hint", async () => {
    const res = await sendOriginalOmp({ pid: NO_ENDPOINT_PID } as never, "hello", 1, null)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/^Original OMP bridge: [a-z_]+\./)
  })
})
