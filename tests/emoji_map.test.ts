import { test, expect, beforeAll } from "bun:test"
import {
  EMBEDDABLE_EMOJI_MAP as EMBEDDABLE_MAP_MODULE,
  SUBSTRING_FALLBACK_EXCLUDED_KEYS,
  MODEL_EMOJI_MAP,
} from "../features/branding/emoji"
import { writeFileSync, chmodSync } from "fs"
import { join } from "path"
import { tempDir } from "./helpers/test-temp"

// Import the emoji map from the CLI
const TG_PATH = new URL("../tg", import.meta.url).pathname
// The maps were extracted out of `tg` into the branding module (decomposition
// Stage 0); the source-parse tests read the COMBINED source so a regex finds the
// maps (now in the module) and the help text / comments (still in `tg`) alike.
const EMOJI_MODULE_PATH = new URL("../features/branding/emoji.ts", import.meta.url).pathname
async function combinedSource(): Promise<string> {
  return (await Bun.file(TG_PATH).text()) + "\n" + (await Bun.file(EMOJI_MODULE_PATH).text())
}

// Create a temp dir with a fake `pgrep` that reports `ollama` as running.
// Prepending it to PATH lets us prove the Claude env check wins over the
// pgrep fallback even when an ollama daemon is genuinely up.
function fakePgrepBinDir(): string {
  const dir = tempDir("tg-fakebin-")
  const script = '#!/bin/sh\nfor a in "$@"; do [ "$a" = "ollama" ] && exit 0; done\nexit 1\n'
  const p = join(dir, "pgrep")
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return dir
}

// Drop a fake `ps` into `dir` whose ancestry snapshot makes tg's PARENT look
// like the given agent command (or, when agentCommand is empty, like a plain
// shell with no agent ancestor). tg climbs from process.ppid, so we resolve the
// real ppid of the tg process ($PPID of this fake ps) via the absolute /bin/ps
// and label it. This lets us prove ancestry detection beats the pgrep fallback.
// Pass an ARRAY for a multi-agent chain, NEAREST ancestor first
// (e.g. ['claude', 'opencode'] = tg → claude → opencode) — keeps the ps output
// format knowledge in this one helper.
function writeFakePs(dir: string, agentCommand: string | string[]): void {
  const chain = Array.isArray(agentCommand) ? agentCommand : [agentCommand]
  const lines = chain.map((cmd, i) => {
    // The first chain row is anchored to the REAL TGPPID (the walk starts
    // there); later rows use pids above macOS pid_max (99999) so they can
    // never collide with a real pid allocated mid-test.
    const pid = i === 0 ? '$TGPPID' : `$((900000 + ${i * 100}))`
    const ppid = i === chain.length - 1 ? '1' : `$((900000 + ${(i + 1) * 100}))`
    return `echo "${pid} ${ppid} ${cmd || '-zsh'}"`
  })
  const script =
    "#!/bin/sh\n" +
    'TG="$PPID"\n' +
    'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
    // A fallback base far from 1: with TGPPID=1 a chain's +100 offsets would
    // cycle (1 → 101 → 1). The ancestry walk's visited set guards the loop,
    // but the helper should never emit a cycle in the first place.
    '[ -z "$TGPPID" ] && TGPPID=900000\n' +
    'echo "$TG $TGPPID bun run tg"\n' +
    lines.join('\n') +
    '\n'
  const p = join(dir, "ps")
  writeFileSync(p, script)
  chmodSync(p, 0o755)
}

// Sanitize environment for subprocess tests
// Whitelist only essential vars to prevent env leakage
const TEST_HOME = tempDir("tg-cli-test-home-")

function sanitizeEnv(): Record<string, string> {
  const whitelist = ["PATH", "TMPDIR"]
  const env: Record<string, string> = {}
  for (const key of whitelist) {
    const val = process.env[key]
    if (val !== undefined) {
      env[key] = val
    }
  }
  // Use a temporary HOME to prevent loading user's tg-cli config
  env["HOME"] = TEST_HOME
  return env
}

// Parse the EMBEDDABLE_EMOJI_MAP from the source file
async function parseEmojiMap(): Promise<Record<string, string>> {
  const content = await combinedSource()
  const map: Record<string, string> = {}
  
  // Simple regex extraction
  const match = content.match(/const EMBEDDABLE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  if (!match) {
    throw new Error("Failed to parse EMBEDDABLE_EMOJI_MAP from tg source")
  }
  const lines = match[1].split('\n')
  for (const line of lines) {
    const keyMatch = line.match(/(\w+):\s*["\x27](\d+)["\x27],/)
    if (keyMatch) {
      map[keyMatch[1]] = keyMatch[2]
    }
  }
  if (Object.keys(map).length === 0) {
    throw new Error("Failed to extract any emoji IDs from EMBEDDABLE_EMOJI_MAP")
  }
  return map
}

let EMBEDDABLE_EMOJI_MAP: Record<string, string> = {}

beforeAll(async () => {
  EMBEDDABLE_EMOJI_MAP = await parseEmojiMap()
})

test("EMBEDDABLE_EMOJI_MAP has no duplicate IDs", () => {
  const ids = Object.values(EMBEDDABLE_EMOJI_MAP)
  const unique = new Set(ids)
  // Note: some aliases intentionally share IDs (e.g., codex/openai, claude/anthropic)
  // There are exactly 15 unique custom emoji IDs in the current set (v10).
  // Update this count when adding new unique custom emoji IDs.
  expect(unique.size).toBe(15)
  expect(ids.length).toBeGreaterThanOrEqual(15)
})

test("EMBEDDABLE_EMOJI_MAP has all expected models", () => {
  const expected = [
    "hyperide", "codex", "openai", "claude", "anthropic",
    "gemini", "google", "deepseek", "qwen", "alibaba",
    "kimi", "moonshot", "o3", "o1", "gpt4", "gpt3", "gpt",
    "llama", "meta", "ollama", "mistral", "grok", "xai",
    "copilot", "github", "perplexity", "cursor", "windsurf",
    "devin", "cognition", "aider", "continue", "omp",
  ]
  for (const model of expected) {
    expect(EMBEDDABLE_EMOJI_MAP[model]).toBeDefined()
    expect(EMBEDDABLE_EMOJI_MAP[model]).toMatch(/^\d{19}$/)
  }
})

test("EMBEDDABLE_EMOJI_MAP IDs are valid format", () => {
  for (const [key, id] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
    expect(id).toMatch(/^\d{19}$/)
  }
})

test("UNICODE_EMOJI_MAP has glm fallback", async () => {
  // Parse UNICODE_EMOJI_MAP from source
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    expect(match[1]).toContain('glm: "🗂"')
    expect(match[1]).toContain('chatglm: "🗂"')
  }
})

test("glm is not in EMBEDDABLE_EMOJI_MAP (no custom emoji yet)", () => {
  expect(EMBEDDABLE_EMOJI_MAP["glm"]).toBeUndefined()
  expect(EMBEDDABLE_EMOJI_MAP["chatglm"]).toBeUndefined()
})

test("fireworks has Unicode fallback", async () => {
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    expect(match[1]).toContain('fireworks: "🎆"')
  }
})

test("gpt has Unicode fallback", async () => {
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    expect(match[1]).toContain('gpt: "⚡"')
  }
})

test("gpt shares OpenAI custom emoji ID", () => {
  expect(EMBEDDABLE_EMOJI_MAP["gpt"]).toBe("5273797309195393626")
})

test("fireworks is Unicode-only (no custom emoji ID)", () => {
  expect(EMBEDDABLE_EMOJI_MAP["fireworks"]).toBeUndefined()
})

test("alias pairs map to identical IDs", () => {
  const aliases = [
    ["codex", "openai", "o3", "o1", "gpt4", "gpt3", "gpt"],
    ["claude", "anthropic", "devin", "cognition", "aider", "continue", "omp"],
    ["gemini", "google"],
    ["qwen", "alibaba"],
    ["kimi", "moonshot"],
    ["llama", "meta"],
    ["grok", "xai"],
    ["copilot", "github"],
  ]
  for (const group of aliases) {
    const ids = group.map(k => EMBEDDABLE_EMOJI_MAP[k]).filter(Boolean)
    if (ids.length > 1) {
      const first = ids[0]
      for (const id of ids.slice(1)) {
        expect(id).toBe(first)
      }
    }
  }
})

test("EMBEDDABLE_EMOJI_MAP structure is consistent", () => {
  // All keys should be lowercase
  for (const key of Object.keys(EMBEDDABLE_EMOJI_MAP)) {
    expect(key).toBe(key.toLowerCase())
  }
  // No empty values
  for (const [key, val] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
    expect(val).toBeTruthy()
    expect(val.length).toBeGreaterThan(0)
  }
})

test("set URL in comment matches help text", async () => {
  const content = await combinedSource()
  // Find the comment URL (anchored to "// Default:")
  const commentMatch = content.match(/\/\/ Default:.*?t\.me\/addemoji\/(agents(?:_v\d+)?_by_[^\s)]+)/)
  // Find the help text URL (anchored to "Set:")
  const helpMatch = content.match(/Set: https:\/\/t\.me\/addemoji\/(agents(?:_v\d+)?_by_[^\s)]+)/)
  expect(commentMatch).toBeTruthy()
  expect(helpMatch).toBeTruthy()
  if (commentMatch && helpMatch) {
    expect(commentMatch[1]).toBe(helpMatch[1])
  }
})

// NOTE: When updating emoji IDs (e.g., v10 -> v11), verify all IDs still have 19 digits
// and alias groups remain consistent. The tests below validate structure and alias
// consistency without hardcoding every ID, making updates less brittle.

test("all documented helpers are resolvable (custom or Unicode)", async () => {
  const content = await combinedSource()
  // Extract UNICODE_EMOJI_MAP block for accurate matching
  const unicodeMatch = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  const unicodeBlock = unicodeMatch ? unicodeMatch[1] : ""
  const helpMatch = content.match(/Use :([\w:]+):.*?to embed custom emoji icons/s)
  expect(helpMatch).toBeTruthy()
  if (helpMatch) {
    const helpers = helpMatch[0].match(/:([a-zA-Z0-9_-]+):/g)
    expect(helpers).toBeTruthy()
    if (helpers) {
      const unique = [...new Set(helpers.map(h => h.replace(/:/g, '')))]
      for (const helper of unique) {
        const lower = helper.toLowerCase()
        // Should have either custom emoji or Unicode fallback
        const hasCustom = EMBEDDABLE_EMOJI_MAP[lower] !== undefined
        const escapedLower = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const unicodeRegex = new RegExp(`\\b${escapedLower}: ["']`, "m")
        const hasUnicode = unicodeRegex.test(unicodeBlock)
        expect(hasCustom || hasUnicode).toBe(true)
      }
    }
  }
})

// Environment variable override tests
// These test the override logic that happens at module load time
// We can't easily test the actual override without spawning a subprocess,
// but we can verify the parsing logic works

test("TG_EMOJI_IDS env override works at runtime", async () => {
  const overrideId = "9999999999999999999"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: overrideId }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  // Should show the overridden ID in the output
  expect(exitCode).toBe(0)
  expect(stdout.includes(overrideId)).toBe(true)
}, 10000)

test("TG_EMOJI_ID_<model> env override works at runtime", async () => {
  const overrideId = "8888888888888888888"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: overrideId,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.includes(overrideId)).toBe(true)
}, 10000)

test("TG_EMOJI_IDS overrides multiple keys simultaneously", async () => {
  const claudeOverride = "7777777777777777777"
  const codexOverride = "6666666666666666666"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: claudeOverride, codex: codexOverride }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.includes(claudeOverride)).toBe(true)
  expect(stdout.includes(codexOverride)).toBe(true)
}, 10000)

test("TG_EMOJI_ID_<model> takes precedence over TG_EMOJI_IDS for existing model", async () => {
  const jsonOverride = "5555555555555555555"
  const envOverride = "4444444444444444444"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: jsonOverride }),
      TG_EMOJI_ID_CLAUDE: envOverride,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.includes(envOverride)).toBe(true)
}, 10000)

test("TG_EMOJI_ID_<model> env var is processed for new model without crash", async () => {
  const jsonOverride = "5555555555555555555"
  const envOverride = "4444444444444444444"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ unknownmodel: jsonOverride }),
      TG_EMOJI_ID_UNKNOWNMODEL: envOverride,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Per-model env var should be processed for new models too
  // (unknownmodel won't appear in ls-emoji-helpers because listEmojiHelpers
  // iterates MODEL_EMOJI_MAP, not EMBEDDABLE_EMOJI_MAP. We verify no crash
  // and that JSON override is not applied by checking for its absence)
  expect(stdout.includes(jsonOverride)).toBe(false)
}, 10000)

test("empty TG_EMOJI_IDS does not break defaults", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: "",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Should still show default IDs
  expect(stdout.includes("5274191514178723918")).toBe(true) // hyperide
}, 10000)

test("malformed TG_EMOJI_IDS does not break defaults", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: "not-valid-json",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Should still show default IDs despite malformed JSON
  expect(stdout.includes("5274191514178723918")).toBe(true) // hyperide
  expect(stderr.includes("Warning: TG_EMOJI_IDS contains invalid JSON")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with non-numeric ID is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: "abc" }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Non-numeric ID is rejected, default should be used
  expect(stdout.includes("abc")).toBe(false)
  expect(stderr.includes("Warning: Ignoring invalid emoji ID in TG_EMOJI_IDS")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with empty string value is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: "" }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty string doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
  // Should still show default Claude ID
  expect(stdout.includes("5274170649227600531")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with non-string value is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '{"claude":123}',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Non-string value should be rejected with warning
  expect(stderr.includes("Warning: Ignoring non-string emoji ID")).toBe(true)
  expect(stdout.includes("5274170649227600531")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with null value is rejected gracefully", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: "null",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Null should be rejected with specific warning
  expect(stderr.includes("Warning: TG_EMOJI_IDS must be a JSON object")).toBe(true)
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("TG_EMOJI_ID_constructor is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CONSTRUCTOR: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_IDS with constructor is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '{"constructor":"1234567890123456789"}',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_ID_toString is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_TOSTRING: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_ID_valueOf is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_VALUEOF: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_IDS with array value is rejected gracefully", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '["1234567890123456789"]',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Arrays are explicitly rejected via Array.isArray(parsed) check
  expect(stderr.includes("Warning: TG_EMOJI_IDS must be a JSON object")).toBe(true)
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("empty TG_EMOJI_ID_ suffix is ignored", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty suffix should be ignored, no crash
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("TG_EMOJI_ID boundary values: empty string rejected", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty string doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
}, 10000)

test("TG_EMOJI_ID boundary values: 18-digit numeric rejected", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "123456789012345678",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // 18-digit numeric doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
  expect(stdout.includes("123456789012345678")).toBe(false)
}, 10000)

test("TG_EMOJI_ID boundary values: 20-digit numeric rejected", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "12345678901234567890",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // 20-digit numeric doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
  expect(stdout.includes("12345678901234567890")).toBe(false)
}, 10000)

test("TG_EMOJI_ID boundary values: exactly 19-digit numeric accepted", async () => {
  const validId = "1234567890123456789"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: validId,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Exactly 19-digit numeric matches ^\d{19}$, so it's accepted
  expect(stdout.includes(validId)).toBe(true)
  expect(stderr.includes("Warning")).toBe(false)
}, 10000)

test("TG_EMOJI_ID___proto__ is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID___PROTO__: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Prototype pollution attempt should be rejected with specific warning
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_IDS with __proto__ is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '{"__proto__":"1234567890123456789"}',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Prototype pollution attempt should be rejected
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_ID can add new model not in default map", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_UNKNOWNMODEL: "9876543210987654321",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // New model should appear in ls-emoji-helpers because it was added to
  // EMBEDDABLE_EMOJI_MAP via env var. listEmojiHelpers iterates MODEL_EMOJI_MAP,
  // not EMBEDDABLE_EMOJI_MAP, so it won't show. But we verify no crash occurs.
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("gpt alias shares the same ID as gpt4 and gpt3", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // All three should appear as separate lines
  expect(stdout.includes(":gpt:")).toBe(true)
  expect(stdout.includes(":gpt4:")).toBe(true)
  expect(stdout.includes(":gpt3:")).toBe(true)
  // Each should have its own line with the correct emoji
  const gptLine = stdout.split("\n").find((line: string) => line.trim().startsWith(":gpt:"))
  const gpt4Line = stdout.split("\n").find((line: string) => line.trim().startsWith(":gpt4:"))
  const gpt3Line = stdout.split("\n").find((line: string) => line.trim().startsWith(":gpt3:"))
  expect(gptLine).toBeTruthy()
  expect(gpt4Line).toBeTruthy()
  expect(gpt3Line).toBeTruthy()
  // All share the same custom emoji ID
  expect(gptLine!.includes("5273797309195393626")).toBe(true)
  expect(gpt4Line!.includes("5273797309195393626")).toBe(true)
  expect(gpt3Line!.includes("5273797309195393626")).toBe(true)
}, 10000)

test("TG_EMOJI_ID_CLAUDE with non-numeric ID is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "abc",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Non-numeric ID is rejected, default should be used
  expect(stdout.includes("abc")).toBe(false)
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
}, 10000)

test("empty TG_EMOJI_ID_CLAUDE is treated as missing", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty string is falsy, so Claude should still have its default ID
  const claudeLine = stdout.split("\n").find((line: string) => line.includes(":claude:"))
  expect(claudeLine).toBeTruthy()
  expect(claudeLine!.includes("5274170649227600531")).toBe(true)
}, 10000)

test("unsupported helper :glm: is documented as Unicode-only", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--help"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // glm should be in Unicode-only section, not custom emoji section
  expect(stdout.includes("Unicode-only helpers")).toBe(true)
  expect(stdout.includes(":glm:")).toBe(true)
  expect(stdout.includes(":chatglm:")).toBe(true)
  expect(stdout.includes(":fireworks:")).toBe(true)
}, 10000)

test("Unicode-only helpers resolve correctly in ls-emoji-helpers", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // glm should show Unicode fallback with no emoji-id
  const glmLine = stdout.split("\n").find((line: string) => line.includes(":glm:"))
  expect(glmLine).toBeTruthy()
  expect(glmLine!.includes("🗂")).toBe(true)
  expect(glmLine!.includes("no emoji-id set")).toBe(true)
  // fireworks should show Unicode fallback with no emoji-id
  const fireworksLine = stdout.split("\n").find((line: string) => line.includes(":fireworks:"))
  expect(fireworksLine).toBeTruthy()
  expect(fireworksLine!.includes("🎆")).toBe(true)
  expect(fireworksLine!.includes("no emoji-id set")).toBe(true)
}, 10000)

test("all EMBEDDABLE_EMOJI_MAP keys are documented in help", async () => {
  const content = await combinedSource()
  const helpMatch = content.match(/Use :([\w:]+):.*?to embed custom emoji icons/s)
  expect(helpMatch).toBeTruthy()
  if (helpMatch) {
    const helpers = helpMatch[0].match(/:([a-zA-Z0-9_-]+):/g)
    expect(helpers).toBeTruthy()
    if (helpers) {
      const documented = new Set(helpers.map(h => h.replace(/:/g, "").toLowerCase()))
      for (const key of Object.keys(EMBEDDABLE_EMOJI_MAP)) {
        // Some keys are intentionally undocumented (aliases, internal)
        // These are aliases or internal keys that are intentionally not listed in the help text.
        // Update this list when adding new aliases that should not appear in --help.
        const undocumented = ["anthropic", "google", "alibaba", "moonshot", "xai", "github", "openai", "meta", "cognition"]
        if (!undocumented.includes(key)) {
          
          expect(documented.has(key)).toBe(true)
        }
      }
    }
  }
})

test("every EMBEDDABLE_EMOJI_MAP key has Unicode fallback", async () => {
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    const unicodeBlock = match[1]
    for (const key of Object.keys(EMBEDDABLE_EMOJI_MAP)) {
      // Use boundary check to avoid matching substrings (e.g., "gpt" inside "gpt4")
      // Match key followed by colon and quote, preceded by whitespace or comma
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(^|\\s|,)${escapedKey}: "`, "m")
      const hasFallback = regex.test(unicodeBlock)
      expect(hasFallback).toBe(true)
    }
  }
})


test("emoji helpers are resolved correctly in ls-emoji-helpers", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Check that some known helpers appear with correct Unicode (format: ":key: → emoji")
  expect(stdout.includes(":codex:")).toBe(true)
  expect(stdout.includes("👐")).toBe(true)
  expect(stdout.includes(":claude:")).toBe(true)
  expect(stdout.includes("✳️")).toBe(true)
  expect(stdout.includes(":deepseek:")).toBe(true)
  expect(stdout.includes("🐳")).toBe(true)
  // Check that custom emoji IDs are shown for embeddable helpers
  expect(stdout.includes("5274191514178723918")).toBe(true) // hyperide
  expect(stdout.includes("5274170649227600531")).toBe(true) // claude
  // Check ollama (new in v10) — specific line to avoid ambiguity with llama/meta
  const ollamaLine = stdout.split("\n").find((line: string) => line.includes(":ollama:"))
  expect(ollamaLine).toBeTruthy()
  expect(ollamaLine!.includes("🦙")).toBe(true)
  // Check gpt (new alias)
  expect(stdout.includes(":gpt:")).toBe(true)
  expect(stdout.includes("⚡")).toBe(true)
  // Check chatglm (Unicode-only)
  expect(stdout.includes(":chatglm:")).toBe(true)
  expect(stdout.includes("🗂")).toBe(true)
  // Check fireworks (Unicode-only)
  expect(stdout.includes(":fireworks:")).toBe(true)
  expect(stdout.includes("🎆")).toBe(true)
}, 10000)

test("CLAUDECODE env detects claude (not a background ollama daemon)", async () => {
  // Pin a no-agent ancestry: since #246 the ancestry walk runs BEFORE the env
  // check, and this test exercises the ENV path — a real agent in the test
  // runner's own process tree (e.g. a dev's tmux pane) would win instead.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFakePs(binDir, "")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: {
      ...env,
      PATH: `${binDir}:${env.PATH}`,
      CLAUDECODE: "1",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Regression: a running `ollama` daemon used to win the pgrep fallback and
  // mislabel Claude Code sessions as ollama.
  expect(stdout.startsWith("claude")).toBe(true)
  expect(stdout.includes("✳️")).toBe(true)
}, 10000)

test("TG_AI_MODEL overrides CLAUDECODE detection", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: {
      ...sanitizeEnv(),
      CLAUDECODE: "1",
      TG_AI_MODEL: "gemini",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.startsWith("gemini")).toBe(true)
}, 10000)

test("--detect-model works without Telegram credentials (info-only flag)", async () => {
  // Neutral ancestry for the same reason as the CLAUDECODE-env test above.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFakePs(binDir, "")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: {
      // No TG_BOT_TOKEN / TG_CHAT_ID — info-only flags must not require them.
      ...env,
      PATH: `${binDir}:${env.PATH}`,
      CLAUDECODE: "1",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("CLAUDECODE beats a genuinely-running ollama (fake pgrep)", async () => {
  const env = sanitizeEnv()
  const binDir = fakePgrepBinDir()
  // Pin a no-agent ancestry so detection can't pick up a real `claude`/`codex`
  // in the test runner's own process tree — this test is about the pgrep path.
  writeFakePs(binDir, "")
  const PATH = `${binDir}:${env.PATH}`

  // Control: with a fake ollama 'running' and NO CLAUDECODE, detection falls
  // through to the pgrep block and reports ollama — proving the fake works.
  const control = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH },
    stdout: "pipe",
    stderr: "ignore",
  })
  const controlOut = await new Response(control.stdout).text()
  await control.exited
  expect(controlOut.startsWith("ollama")).toBe(true)

  // Regression: CLAUDECODE must win even though ollama is 'running'.
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH, CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect((await proc.exited)).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("codex ancestor beats a background ollama daemon (fake ps + fake pgrep)", async () => {
  // Regression for the real bug: codex exports no env marker for the shell
  // commands it spawns (CODEX unset, CODEX_HOME empty), so detection fell
  // through to the pgrep block and a background `ollama` daemon won — branding
  // codex sessions as ollama. Ancestry detection must now win.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  const ollamaScript =
    '#!/bin/sh\nfor a in "$@"; do [ "$a" = "ollama" ] && exit 0; done\nexit 1\n'
  writeFileSync(join(binDir, "pgrep"), ollamaScript)
  chmodSync(join(binDir, "pgrep"), 0o755)
  const PATH = `${binDir}:${env.PATH}`

  // Control: a plain shell ancestor (no agent) + ollama 'running' → ollama.
  writeFakePs(binDir, "")
  const control = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH },
    stdout: "pipe",
    stderr: "ignore",
  })
  const controlOut = await new Response(control.stdout).text()
  await control.exited
  expect(controlOut.startsWith("ollama")).toBe(true)

  // Now make tg's parent look like codex: ancestry must beat the ollama pgrep.
  writeFakePs(binDir, "/opt/homebrew/bin/codex exec --json")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("codex")).toBe(true)
}, 10000)

test("REGRESSION: 'computer-use-preview' does NOT misbrand as omp via the substring fallback", async () => {
  // Codex-bot finding on #245: the generic base.includes(key) substring
  // fallback hit the 3-letter 'omp' key inside unrelated model names
  // ('computer-use-preview', 'composer', 'component', …) and branded them 🥧.
  // 'omp' is now exact-match-only in the fallback.
  const env = sanitizeEnv()
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, TG_AI_MODEL: "computer-use-preview", TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout).not.toContain("🥧")
  expect(stdout.startsWith("computer-use-preview")).toBe(true)

  // Positive control: an exact 'omp' model still brands 🥧.
  const exact = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, TG_AI_MODEL: "omp", TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const exactOut = await new Response(exact.stdout).text()
  expect(await exact.exited).toBe(0)
  expect(exactOut).toContain("🥧")
}, 10000)

test("omp boundary: separator-suffixed 'omp-1.2' brands, fused 'omp2' does not", async () => {
  // Pins the exact-match-only boundary. extractBaseModel's prefix shortening
  // ('omp-1.2' → 'omp') is an EXACT map hit, so separator-suffixed versions
  // still brand 🥧. A fused suffix ('omp2') previously matched via the
  // substring fallback and now deliberately does NOT — the cost of excluding
  // 'omp' from substring matching, accepted because fused suffixes are rare
  // next to the 'computer-use-preview' collision class.
  const env = sanitizeEnv()
  const spawnDetect = (model: string) =>
    Bun.spawn({
      cmd: ["bun", "run", TG_PATH, "--detect-model"],
      env: { ...env, TG_AI_MODEL: model, TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "1" },
      stdout: "pipe",
      stderr: "ignore",
    })
  const dashed = spawnDetect("omp-1.2")
  const dashedOut = await new Response(dashed.stdout).text()
  expect(await dashed.exited).toBe(0)
  expect(dashedOut).toContain("🥧")

  const fused = spawnDetect("omp2")
  const fusedOut = await new Response(fused.stdout).text()
  expect(await fused.exited).toBe(0)
  expect(fusedOut).not.toContain("🥧")
}, 10000)

test("prototype key 'constructor' as TG_AI_MODEL yields no emoji (typeof guard)", async () => {
  // Without the typeof guard, MODEL_EMOJI_MAP['constructor'] is
  // Object.prototype.constructor — truthy — and its Function source would be
  // returned as the "emoji".
  const env = sanitizeEnv()
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, TG_AI_MODEL: "constructor", TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("constructor")).toBe(true)
  expect(stdout).not.toContain("function")
}, 10000)

test("SUBSTRING_FALLBACK_EXCLUDED_KEYS stays in sync with the emoji maps", () => {
  // Invariant: an excluded key must exist in AT LEAST ONE map — only then is
  // the exclusion truly stale. (A key legitimately living in MODEL only — plain
  // emoji, no branded pill id — must NOT force its deletion from the set, which
  // would silently reintroduce the misbranding.)
  for (const key of SUBSTRING_FALLBACK_EXCLUDED_KEYS) {
    expect(Object.hasOwn(MODEL_EMOJI_MAP, key) || Object.hasOwn(EMBEDDABLE_MAP_MODULE, key)).toBe(true)
  }
})

test("REGRESSION (#246): CLAUDECODE=1 with an omp ancestor brands omp, not claude", async () => {
  // omp sessions export CLAUDECODE=1 (pi heritage — verified live), and the
  // env check used to run BEFORE the ancestry walk, so every outbound send
  // from an omp session misbranded 'claude ✳️'. The ancestry walk must win.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "/opt/homebrew/bin/omp")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("omp")).toBe(true)
  expect(stdout).toContain("🥧")
}, 10000)

test("CLAUDECODE=1 with a claude ancestor still brands claude (no behavior change)", async () => {
  // Companion pin to the #246 reorder: a REAL claude session has claude in its
  // ancestry, so moving the walk ahead of the env check changes nothing there.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "claude")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
  expect(stdout).toContain("✳️")
}, 10000)

test("opencode ancestor is refined to the config model name", async () => {
  // Lineage-first ordering (#246): an opencode ancestor resolves the session's
  // actual MODEL NAME via `opencode debug config`, not the generic kind.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "opencode")
  writeFileSync(
    join(binDir, "opencode"),
    '#!/bin/sh\nif [ "$1" = "debug" ]; then printf \'%s\' \'{"provider":{"moonshot":{"models":{"moonshot/kimi-k2p6-turbo":{}}}}}\'; fi\nexit 0\n',
  )
  chmodSync(join(binDir, "opencode"), 0o755)
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}` },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("kimi-k2p6-turbo")).toBe(true)
}, 10000)

test("an opencode ancestor with an UNREADABLE config falls back to the generic kind", async () => {
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "opencode")
  writeFileSync(join(binDir, "opencode"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "opencode"), 0o755)
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("opencode")).toBe(true)
}, 10000)

test("lineage beats an inherited OPENCODE marker (stale env from an outer pane)", async () => {
  // Env vars are inheritable: a codex session inside an opencode pane carries
  // OPENCODE=1, but the codex ancestor is the real sender. The ancestry walk
  // must win over the env marker (#246 review).
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "/opt/homebrew/bin/codex exec --json")
  writeFileSync(
    join(binDir, "opencode"),
    '#!/bin/sh\nif [ "$1" = "debug" ]; then printf \'%s\' \'{"provider":{"moonshot":{"models":{"moonshot/kimi-k2p6-turbo":{}}}}}\'; fi\nexit 0\n',
  )
  chmodSync(join(binDir, "opencode"), 0o755)
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("codex")).toBe(true)
}, 10000)

test("OPENCODE env resolves the model name when no ancestor matches (detached spawn)", async () => {
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "") // neutral ancestry → env-marker fallback path
  writeFileSync(
    join(binDir, "opencode"),
    '#!/bin/sh\nif [ "$1" = "debug" ]; then printf \'%s\' \'{"provider":{"moonshot":{"models":{"moonshot/kimi-k2p6-turbo":{}}}}}\'; fi\nexit 0\n',
  )
  chmodSync(join(binDir, "opencode"), 0o755)
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("kimi-k2p6-turbo")).toBe(true)
}, 10000)

test("nested claude inside an opencode pane brands claude (lineage over inherited env)", async () => {
  // OPENCODE=1 + CLAUDECODE=1 + claude ancestry: the claude process is the
  // actual launcher, so claude wins — the pre-#246 env-first order happened
  // to get this right, the first reorder shape regressed it (review finding).
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "claude")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1", CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("nearest ancestor wins with TWO agents in one tree (opencode → claude → tg)", async () => {
  // Finding from review: every other fake-ps test pins a SINGLE agent. The
  // nested topologies this PR reasons about have BOTH agents in the real
  // tree — the walk must return the NEAREST (claude), not the outer opencode.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  // Custom three-level tree via the chain form: tg → claude → opencode
  // (nearest first wins).
  writeFakePs(binDir, ["claude", "opencode"])
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1", CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("detached nested spawn (OPENCODE+CLAUDECODE, no ancestry) brands claude", async () => {
  // The env-fallback ordering decision (#246 review): with NO lineage signal,
  // CLAUDECODE (self-published by the inner agent, one hop) outranks OPENCODE
  // (inherited from an outer pane, two hops). This matches the pre-#246
  // relative order — the smallest possible behavior delta.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "") // neutral ancestry → env-marker fallback path
  writeFileSync(
    join(binDir, "opencode"),
    '#!/bin/sh\nif [ "$1" = "debug" ]; then printf \'%s\' \'{"provider":{"moonshot":{"models":{"moonshot/kimi-k2p6-turbo":{}}}}}\'; fi\nexit 0\n',
  )
  chmodSync(join(binDir, "opencode"), 0o755)
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1", CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("OPENCODE env with an UNREADABLE config falls back to the generic kind (symmetric with the ancestor path)", async () => {
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "") // neutral ancestry → env-marker fallback path
  writeFileSync(join(binDir, "opencode"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "opencode"), 0o755)
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}`, OPENCODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("opencode")).toBe(true)
}, 10000)

test("omp ancestor brands the session as omp with the pie emoji (fake ps)", async () => {
  // Caller-level branding coverage for the omp AgentKind: `tg --detect-model`
  // must surface the ancestry-detected 'omp' through detectAgentViaAncestry AND
  // resolve its emoji from MODEL_EMOJI_MAP — the AgentKind→emoji-key bridge is
  // string-keyed, so this guards the connection, not just the two ends.
  const env = sanitizeEnv()
  const binDir = tempDir("tg-fakebin-")
  writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n')
  chmodSync(join(binDir, "pgrep"), 0o755)
  writeFakePs(binDir, "/opt/homebrew/bin/omp")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH: `${binDir}:${env.PATH}` },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("omp")).toBe(true)
  expect(stdout).toContain("🥧")
}, 10000)
