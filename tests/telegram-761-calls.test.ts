// Registers the hermetic #761 call integration suite and the acceptance-runner suite in the normal Bun
// test path (default CI). Both are credential-free, network-free Python suites with their own fakes.
// Bounds allow for real media processing on a loaded CI host.
import { test, expect } from "bun:test"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

for (const [suite, bound] of [
  ["telegram-761-call-integration.test.py", 180_000],
  ["telegram-761-verify-calls.test.py", 150_000],
  ["telegram-761-runner-safety.test.py", 45_000],
  ["telegram-761-nested-process.test.py", 30_000],
  ["telegram-761-process-bounds.test.py", 20_000],
  ["telegram-761-probe-contracts.test.py", 45_000],
] as const) {
  test(suite, () => {
    const result = Bun.spawnSync(["python3", join(import.meta.dir, suite)], {
      cwd: ROOT,
      stdin: "ignore",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: bound,
    })
    const stderr = new TextDecoder().decode(result.stderr)
    expect(stderr).toMatch(/^OK$/m)
    expect(result.exitCode).toBe(0)
  }, bound + 10_000)
}
