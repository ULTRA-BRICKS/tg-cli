// Characterization of the real `tg-ctl` entry (pre-config exits, token gate) and pure task-board parsing,
// pinned so the cli-main / tasks-board / harness-event decomposition stays behavior-preserving.
import { describe, expect, test } from "bun:test"
import { join } from "path"
import { tempDir } from "./helpers/test-temp"
import { flattenTaskListJson } from "../features/tg-ctl/daemon-runtime/tasks-board"

const ROOT = join(import.meta.dir, "..")

function run(args: string[]): { code: number | null; out: string; err: string } {
  const home = tempDir("ctl-cli-home-")
  const cfg = tempDir("ctl-cli-cfg-")
  const r = Bun.spawnSync(["bun", join(ROOT, "tg-ctl"), ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: home, TG_CTL_CONFIG_DIR: cfg },
    stdin: "ignore",
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe("tg-ctl CLI pre-config exits", () => {
  test("bare and --help print USAGE on stdout, exit 0", () => {
    const bare = run([])
    expect(bare.code).toBe(0)
    expect(bare.out).toContain("usage")
    expect(run(["--help"])).toEqual(bare)
    expect(run(["ask", "--help"])).toEqual(bare)
  })
  test("unknown command prints USAGE on stderr, exit 1", () => {
    const r = run(["bogus"])
    expect(r.code).toBe(1)
    expect(r.out).toBe("")
    expect(r.err).toBe(run([]).out)
  })
  test("capabilities", () => {
    expect(run(["capabilities", "--json"])).toEqual({ code: 0, out: '{"schema_version":1,"capabilities":["ask-owner-only-v1"]}\n', err: "" })
    expect(run(["capabilities"])).toEqual({ code: 2, out: "", err: "usage: tg-ctl capabilities --json\n" })
  })
  test("ask --owner-only usage errors", () => {
    const usage = "usage: tg-ctl ask --owner-only <question> [--timeout SEC]\n"
    expect(run(["ask", "--owner-only"])).toEqual({ code: 2, out: "", err: usage })
    expect(run(["ask", "--owner-only", "--help"])).toEqual({ code: 2, out: "", err: usage })
  })
  test("ask with a question and no credentials fails closed", () => {
    expect(run(["ask", "--owner-only", "x"])).toEqual({ code: 1, out: "", err: "denied: no bot credentials configured\n" })
    expect(run(["ask"]).code).toBe(0)
  })
  test("voice-setup rejects unknown args before the token gate", () => {
    expect(run(["voice-setup", "--bogus"])).toEqual({ code: 2, out: "", err: "tg-ctl voice-setup: unknown argument --bogus (usage: tg-ctl voice-setup [--dry-run])\n" })
  })
  test("bot-token gate and usage-schedule usage", () => {
    const r = run(["status"])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/^Error: TG_BOT_TOKEN and TG_CHAT_ID must be set in .*\/\.env — run `tg auth` to connect\.\n$/)
  })
})

describe("flattenTaskListJson", () => {
  test("flattens flat items and project groups, skipping junk", () => {
    const out = flattenTaskListJson([
      null,
      "x",
      { id: "a", project: "p1" },
      { id: "b" },
      { project: "p2", tickets: [{ id: "c" }, null, { nope: 1 }, { id: "d" }] },
      { project: 3, tickets: [{ id: "z" }] },
      { project: "p3" },
    ])
    expect(out.map((t) => [t.id, t.project])).toEqual([["a", "p1"], ["b", undefined], ["c", "p2"], ["d", "p2"]])
    expect(flattenTaskListJson({})).toEqual([])
  })
})
