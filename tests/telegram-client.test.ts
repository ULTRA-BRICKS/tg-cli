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

for (const suite of [
  "telegram-conversation.test.py",
  "telegram-duplex.test.py",
  "telegram-providers.test.py",
  "telegram-call-lib.test.py",
  "telegram-user-account.test.py",
  "telegram-call-service.test.py",
  "telegram-call-journal.test.py",
  "telegram-cli-hardening.test.py",
  "telegram-call-preparation.test.py",
  "telegram-tts.test.py",
  "telegram-tts-metrics.test.py",
  "telegram-761-tts-integration.test.py",
  "telegram-761-watch.test.py",
  "telegram-761-identity.test.py",
]) {
  test(suite, () => {
    const result = Bun.spawnSync(["python3", join(import.meta.dir, suite)], {
      cwd: join(import.meta.dir, ".."), timeout: 20000,
    })
    expect(new TextDecoder().decode(result.stderr)).toContain("OK")
    expect(result.exitCode).toBe(0)
  })
}
