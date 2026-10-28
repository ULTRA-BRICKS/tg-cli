// Env overrides of the embeddable custom-emoji ids (TG_EMOJI_IDS JSON, TG_EMOJI_ID_<model>).
// Mutates the shared EMBEDDABLE_EMOJI_MAP singleton — that is the contract: every later renderer reads it.
import { EMBEDDABLE_EMOJI_MAP } from "../../branding/emoji"
import type { MergedEnv } from "./types"

const RESERVED_KEYS = ["__proto__", "constructor", "tostring", "valueof"]

function applyEmojiIdsObject(parsedIds: object): void {
  for (const [model, id] of Object.entries(parsedIds)) {
    if (RESERVED_KEYS.includes(model.toLowerCase())) {
      console.error(`Warning: Rejecting reserved key in TG_EMOJI_IDS: ${model}`)
      continue
    }
    if (typeof id === "string" && /^\d{19}$/.test(id)) {
      EMBEDDABLE_EMOJI_MAP[model] = id
    } else if (typeof id === "string") {
      console.error(`Warning: Ignoring invalid emoji ID in TG_EMOJI_IDS for ${model}: ${id} (expected 19 digits)`)
    } else {
      console.error(`Warning: Ignoring non-string emoji ID in TG_EMOJI_IDS for ${model}: ${id} (expected string)`)
    }
  }
}

function applyEmojiIdsJson(raw: string): void {
  try {
    const parsedIds = JSON.parse(raw)
    if (parsedIds !== null && typeof parsedIds === "object" && !Array.isArray(parsedIds)) {
      applyEmojiIdsObject(parsedIds)
    } else {
      console.error("Warning: TG_EMOJI_IDS must be a JSON object, not an array or primitive")
    }
  } catch {
    console.error("Warning: TG_EMOJI_IDS contains invalid JSON, using default emoji IDs")
  }
}

function applyEmojiIdVariable(key: string, val: string | undefined): void {
  const model = key.slice("TG_EMOJI_ID_".length).toLowerCase()
  if (!model) return
  if (RESERVED_KEYS.includes(model)) {
    console.error(`Warning: Rejecting reserved key in TG_EMOJI_ID_${model}: ${val}`)
  } else if (val && /^\d{19}$/.test(val)) {
    EMBEDDABLE_EMOJI_MAP[model] = val
  } else {
    console.error(`Warning: Ignoring invalid emoji ID for ${model}: ${val} (expected 19 digits)`)
  }
}

// Runs before any info-flag handler so --ls-emoji-helpers reflects overrides + emits warnings.
export function applyEmojiEnvOverrides(env: MergedEnv): void {
  if (env.TG_EMOJI_IDS) applyEmojiIdsJson(env.TG_EMOJI_IDS)
  for (const [key, val] of Object.entries(env)) {
    if (key.startsWith("TG_EMOJI_ID_")) applyEmojiIdVariable(key, val)
  }
}
