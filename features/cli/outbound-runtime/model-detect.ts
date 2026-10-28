// AI model / brand-emoji detection for the sender header, plus the `--ls-emoji-helpers` listing.
import {
  EMBEDDABLE_EMOJI_MAP,
  SUBSTRING_FALLBACK_EXCLUDED_KEYS,
  MODEL_EMOJI_MAP,
  extractBaseModel,
} from "../../branding/emoji"
import { detectAgentViaAncestry, isProcessRunning } from "../../branding/detect"
import type { MergedEnv } from "./types"

const shortModelId = (fullId: string): string => (fullId.includes("/") ? (fullId.split("/").pop() || fullId) : fullId)

// The opencode session's actual model name, read from `opencode debug
// config` (single provider model wins; a '*router*' id preferred over an
// arbitrary first). null when unreadable — the caller decides the fallback.
function opencodeModelFromConfig(): string | null {
  try {
    const result = Bun.spawnSync(["opencode", "debug", "config"], {
      stdout: "pipe",
      stderr: "pipe",
      // Branding-only read: a wedged opencode binary must never block a
      // send — on timeout the kill makes exitCode non-zero → null below.
      timeout: 2000,
      killSignal: "SIGKILL",
    })
    if (result.exitCode !== 0) return null
    const cfg = JSON.parse(new TextDecoder().decode(result.stdout))
    const providers = cfg.provider || {}
    for (const [_name, p] of Object.entries(providers)) {
      const prov = p as { models?: Record<string, unknown> }
      if (!prov.models) continue
      const ids = Object.keys(prov.models)
      if (ids.length === 1) return shortModelId(ids[0])
      const router = ids.find((id) => id.includes("router"))
      if (router) return shortModelId(router)
      return shortModelId(ids[0])
    }
  } catch {
    // ignore — unreadable config
  }
  return null
}

// Step 2: walk the ancestor process tree. An agent that launched `tg` as a
// subprocess (codex, aider, pi, opencode, omp, claude) is the real sender
// even when it exports no env marker — codex notably sets neither CODEX
// nor CODEX_HOME for the shell commands it runs. An opencode ancestor is
// refined to the session's actual model name (config read), falling back
// to the generic kind when unreadable.
function modelFromAncestry(): string | null {
  const ancestorAgent = detectAgentViaAncestry()
  if (ancestorAgent === "opencode") return opencodeModelFromConfig() ?? "opencode"
  return ancestorAgent || null
}

// Step 3: env-marker fallbacks (no recognizable ancestor — detached spawn, or
// the launcher is not a known agent). The chain keeps the PRE-EXISTING
// relative order (CLAUDECODE → OPENCODE → CODEX) — the smallest possible
// behavior delta. The hop argument behind it covers the OBSERVED nesting
// (claude inner): CLAUDECODE is self-published by the inner agent (one
// hop), OPENCODE/CODEX are inherited from an outer pane (two hops). The
// reverse nesting in a DETACHED spawn (opencode inner, claude outer) is
// mislabeled by this order — accepted, lineage-first already covers the
// attached case. OPENCODE still refines to the config model name; an
// unreadable config falls through to CODEX (never to the pgrep block,
// where a background `ollama` daemon would otherwise win) and finally to
// the generic kind. CLAUDECODE ahead of pgrep covers the original ollama
// hazard for claude sessions. KNOWN LIMITATION (#246): a DETACHED spawn
// from an omp session lands here with only CLAUDECODE=1 (omp sets no
// marker of its own — verified live: no OMP_* in the process env) and
// brands claude; only attached spawns brand omp.
function modelFromEnvMarkers(env: MergedEnv): string | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude"
  if (env.OPENCODE) {
    const model = opencodeModelFromConfig()
    if (model) return model
    if (env.CODEX) return "codex"
    return "opencode"
  }
  if (env.CODEX) return "codex"
  return null
}

// Step 4: other known CLI tools, in order.
function modelFromRunningProcesses(): string {
  if (isProcessRunning("aider")) return "aider"
  if (isProcessRunning("cursor")) return "cursor"
  if (isProcessRunning("windsurf")) return "windsurf"
  if (isProcessRunning("llama")) return "llama"
  if (isProcessRunning("ollama")) return "ollama"
  if (isProcessRunning("opencode") || isProcessRunning("opencode.exe")) return "opencode"
  return ""
}

// Precedence: explicit env override → process LINEAGE (the agent that
// actually launched this tg) → env-marker fallbacks (CLAUDECODE → OPENCODE
// → CODEX) → pgrep fallbacks. Lineage leads because env vars are
// INHERITABLE: an agent spawned inside another agent's pane carries the
// outer agent's markers (omp exports CLAUDECODE=1 via its pi heritage —
// #246; a claude session inside an opencode pane inherits OPENCODE). The
// nearest recognizable ancestor is the truth in those topologies. The env
// markers remain the fallback for detached spawns whose launcher is not in
// the process tree. Runs once per process, so the ps walk is
// paid once per send, not per message part.
export function detectAiModel(env: MergedEnv): string {
  // 1. Explicit env var wins
  if (env.TG_AI_MODEL) return env.TG_AI_MODEL
  return modelFromAncestry() ?? modelFromEnvMarkers(env) ?? modelFromRunningProcesses()
}

export function detectAiEmoji(env: MergedEnv, model: string): string {
  // 1. Explicit env var wins
  if (env.TG_AI_EMOJI) return env.TG_AI_EMOJI

  // 2. Derive from detected model name
  if (model) {
    const base = extractBaseModel(model)
    // typeof guard, not truthiness: prototype keys ('constructor', …) are
    // truthy non-strings on a plain object map and must fall through.
    const exact = MODEL_EMOJI_MAP[base]
    if (typeof exact === "string") return exact
    // Fallback to substring matching for partial matches — minus the
    // SUBSTRING_FALLBACK_EXCLUDED_KEYS (short substrings like 'omp' would
    // misbrand unrelated names such as 'computer-use-preview').
    for (const [key, emoji] of Object.entries(MODEL_EMOJI_MAP)) {
      if (SUBSTRING_FALLBACK_EXCLUDED_KEYS.has(key)) continue
      if (base.includes(key)) return emoji
    }
  }

  // Unknown / undeterminable model (e.g. an opencode session whose inner model
  // couldn't be read) — a neutral folder icon rather than misbranding.
  return "📁"
}

// --- Emoji helpers listing ---
export function listEmojiHelpers(): string {
  const lines = [
    "Available emoji helpers:",
    "",
  ]
  for (const [key, emoji] of Object.entries(MODEL_EMOJI_MAP)) {
    const id = EMBEDDABLE_EMOJI_MAP[key]
    if (id) {
      lines.push(`  :${key}: → ${emoji} <tg-emoji emoji-id="${id}">`)
    } else {
      lines.push(`  :${key}: → ${emoji} (no emoji-id set — add TG_EMOJI_ID_${key})`)
    }
  }
  lines.push("")
  lines.push("Set emoji IDs via env vars:")
  lines.push("  TG_EMOJI_ID_claude=5274170649227600531")
  lines.push("  TG_EMOJI_IDS='{\"claude\":\"5274170649227600531\",\"codex\":\"5273797309195393626\"}'")
  return lines.join("\n")
}
