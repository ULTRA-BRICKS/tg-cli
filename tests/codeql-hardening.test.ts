// Regression tests for the CodeQL-gated hardening (tg-cli#817): log line injection, stat-before-open
// races, the outbox method path segment, and the computed-key answers map.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { log, readFileTailOrNull } from "../features/tg-ctl/daemon-runtime/ctx-io"
import { readBoundedUtf8, readDocumentContents } from "../features/cli/outbound-runtime/plan-render"
import { formatAgentHookOutput } from "../features/tg-ctl/questions"
import { readOutbox } from "../features/transport/outbox"
import { spawnSyncBounded } from "./helpers/spawn-sync"
import { tempDir } from "./helpers/test-temp"

let dir: string
beforeEach(() => {
  dir = tempDir("codeql-hardening-")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("daemon log line injection", () => {
  test("untrusted CR/LF/line-separator text cannot forge a second log record", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      log("ask-forward dropped: line=ok\n[2099-01-01T00:00:00.000Z] forged\r\u2028tail")
      const out = String(spy.mock.calls[0]![0])
      expect(out.split(/\r|\n|\u2028|\u2029/u)).toHaveLength(1)
      expect(out).toContain("forged")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("bounded file reads open before checking", () => {
  test("tail read keeps the last bytes of a regular file", () => {
    const p = join(dir, "f.log")
    writeFileSync(p, "0123456789")
    expect(readFileTailOrNull(p, 4)).toBe("6789")
    expect(readFileTailOrNull(p, 0)).toBe("")
  })

  test("tail read refuses a directory and a missing path without blocking", () => {
    expect(readFileTailOrNull(dir, 10)).toBeNull()
    expect(readFileTailOrNull(join(dir, "missing"), 10)).toBeNull()
  })

  test("FIFO reads fail bounded in a Bun child instead of hanging the test process", () => {
    const fifo = join(dir, "pipe")
    expect(spawnSyncBounded(["mkfifo", fifo]).exitCode).toBe(0)
    const program = `
import { readFileTailOrNull } from ${JSON.stringify(fileURLToPath(new URL("../features/tg-ctl/daemon-runtime/ctx-io.ts", import.meta.url)))}
import { readDocumentContents } from ${JSON.stringify(fileURLToPath(new URL("../features/cli/outbound-runtime/plan-render.ts", import.meta.url)))}
const fifo = ${JSON.stringify(fifo)}
process.stdout.write(JSON.stringify({ tail: readFileTailOrNull(fifo, 10), docs: readDocumentContents([{ type: "document", path: fifo }] as never) }))
`
    const childPath = join(dir, "fifo-child.ts")
    writeFileSync(childPath, program)
    const proc = spawnSyncBounded([process.execPath, childPath], { stdout: "pipe", stderr: "pipe" }, 5000)
    expect(proc.exitCode).toBe(0)
    expect(JSON.parse(proc.stdout.toString())).toEqual({ tail: null, docs: [] })
  })

  test("R2 document read honours the size cap, skips directories", () => {
    const small = join(dir, "small.txt")
    const big = join(dir, "big.txt")
    writeFileSync(small, "hello")
    writeFileSync(big, "x".repeat(256 * 1024 + 1))
    mkdirSync(join(dir, "d"))
    const items = [small, big, join(dir, "d"), join(dir, "missing")].map((path) => ({ type: "document" as const, path }))
    expect(readDocumentContents(items as never)).toEqual([{ path: small, content: "hello" }])
  })

  test("bounded read counts the bytes actually read, not a claimed size", () => {
    const p = join(dir, "grown.txt")
    writeFileSync(p, "x".repeat(11))
    const fd = openSync(p, "r")
    try {
      expect(readBoundedUtf8(fd, 10)).toBeNull()
    } finally {
      closeSync(fd)
    }
    writeFileSync(p, "x".repeat(10))
    const fd2 = openSync(p, "r")
    try {
      expect(readBoundedUtf8(fd2, 10)).toBe("x".repeat(10))
    } finally {
      closeSync(fd2)
    }
  })
})

describe("outbox method is a Bot API method name, never a path", () => {
  const base = { version: 1, createdAt: 1, delivered: [] }
  const entry = (method: string) => JSON.stringify({ ...base, ops: [{ method, body: {} }] })
  test("accepts a plain method, rejects path/query smuggling", () => {
    const methods = ["sendMessage", "../deleteWebhook", "sendMessage?x=1", "a/b", "", "send Message"]
    methods.forEach((m, i) => writeFileSync(join(dir, `e${i}.json`), entry(m)))
    const { entries, broken } = readOutbox(dir)
    expect(entries.map((e) => e.base)).toEqual(["e0"])
    expect(broken.sort()).toEqual(["e1", "e2", "e3", "e4", "e5"])
  })
})

describe("question answer map keyed by an untrusted question text", () => {
  test("a __proto__ question becomes an own data property, never the prototype", () => {
    const req = { agent: "claude", kind: "question", question: "__proto__", title: "t", options: [] }
    const out = formatAgentHookOutput(req as never, { status: "answered", value: "polluted" } as never) as {
      hookSpecificOutput: { updatedInput: { answers: Record<string, string> } }
    }
    const answers = out.hookSpecificOutput.updatedInput.answers
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype)
    expect(Object.keys(answers)).toEqual(["__proto__"])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
