// Runs the credential-free Python adapter/security regression suite from Bun's normal test path.
import { test, expect } from "bun:test"
import { join } from "node:path"

test("independent Telegram clients: auth guards, SQLite WAL snapshot and one-shot claims", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "telegram-client.test.py")], {
    cwd: join(import.meta.dir, ".."), timeout: 20000,
  })
  expect(new TextDecoder().decode(result.stderr)).toContain("OK")
  expect(result.exitCode).toBe(0)
})

for (const suite of ["telegram-conversation.test.py", "telegram-duplex.test.py", "telegram-providers.test.py"]) {
  test(suite, () => {
    const result = Bun.spawnSync(["python3", join(import.meta.dir, suite)], {
      cwd: join(import.meta.dir, ".."), timeout: 20000,
    })
    expect(new TextDecoder().decode(result.stderr)).toContain("OK")
    expect(result.exitCode).toBe(0)
  })
}
