// I/O seams of the autolink stage (tg-cli#817): the CLI spawn runner, the once-only hint state file
// and the best-effort response caches. Real I/O stays here so `autolink-resolve.ts` is flow only.
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { Runner } from "../../autolink-tasks/linear"
import { markHint, parseHintState, serializeHintState, type HintKind } from "../../autolink-tasks/state"

/** Spawn a CLI with a 10 s budget; null when the spawn itself fails (binary not installed). */
export function makeSpawnRunner(binary: "linear" | "gh"): Runner {
  return (cliArgs) => {
    try {
      const proc = Bun.spawnSync([binary, ...cliArgs], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      })
      return {
        exitCode: proc.exitCode ?? 1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      }
    } catch {
      // spawn itself failed → the binary is not installed
      return null
    }
  }
}

export type HintOnce = (kind: HintKind, message: string) => void

// The once-only hint state lives under the HOME-based config dir (not TG_CTL_CONFIG_DIR).
export function makeHintOnce(home: string): HintOnce {
  const statePath = join(home, ".config", "tg-cli", "autolink-tasks.json")
  return (kind, message) => {
    let raw: string | null = null
    try {
      raw = readFileSync(statePath, "utf8")
    } catch {
      raw = null
    }
    const state = parseHintState(raw)
    if (state[kind]) return
    console.error(message)
    try {
      mkdirSync(join(home, ".config", "tg-cli"), { recursive: true })
      writeFileSync(statePath, serializeHintState(markHint(state, kind)))
    } catch {
      // best-effort: a hint shown twice beats a send blocked by bookkeeping
    }
  }
}

export function readCacheFile(cachePath: string): string | null {
  try {
    return readFileSync(cachePath, "utf8")
  } catch {
    return null
  }
}

// `buildContent` runs inside the guard: serializing the merged cache is part of the best-effort bookkeeping.
export function writeCacheFileBestEffort(home: string, cachePath: string, buildContent: () => string): void {
  try {
    mkdirSync(join(home, ".cache", "tg-cli"), { recursive: true })
    writeFileSync(cachePath, buildContent())
  } catch {
    // best-effort cache; never block a send over bookkeeping
  }
}
