import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "./helpers/test-temp"

const CTL = join(import.meta.dir, "..", "tg-ctl")
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

function setup(withEnv: boolean) {
  const home = tempDir("ctl-help-home-")
  const cfg = tempDir("ctl-help-cfg-")
  if (withEnv) writeFileSync(join(cfg, ".env"), "TG_BOT_TOKEN=123:fake\nTG_CHAT_ID=1\n")
  let requests = 0
  const server = Bun.serve({ port: 0, fetch() { requests++; return Response.json({ ok: true, result: [] }) } })
  cleanups.push(() => { server.stop(true) })
  return { home, cfg, base: `http://127.0.0.1:${server.port}`, count: () => requests }
}

async function run(args: string[], s: ReturnType<typeof setup>) {
  const p = Bun.spawn(["bun", CTL, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: s.home, TG_CTL_CONFIG_DIR: s.cfg, TG_API_BASE: s.base },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => p.kill(), 15000)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  clearTimeout(timer)
  return { out, err, code }
}

describe("tg-ctl ask --help", () => {
  for (const flag of ["--help", "-h"]) {
    test(`ask ${flag} prints usage with no side effects`, async () => {
      const s = setup(true)
      const before = readdirSync(s.cfg).sort()
      const r = await run(["ask", flag], s)
      expect(r.code).toBe(0)
      expect(r.out).toContain("tg-ctl ask <question>")
      expect(s.count()).toBe(0)
      expect(readdirSync(s.cfg).sort()).toEqual(before)
    })
  }

  test("ask '--help me?' --timeout 1 stays a real ask (fails closed, no usage)", async () => {
    const s = setup(false)
    const r = await run(["ask", "--help me?", "--timeout", "1"], s)
    expect(r.code).toBe(1)
    expect(r.out).not.toContain("tg-ctl ask <question>")
    expect(r.err + r.out).toContain("denied: no bot credentials configured")
  })

  test("ask --help extra is not help", async () => {
    const s = setup(false)
    const r = await run(["ask", "--help", "extra"], s)
    expect(r.out).not.toContain("tg-ctl ask <question>")
  })
})
