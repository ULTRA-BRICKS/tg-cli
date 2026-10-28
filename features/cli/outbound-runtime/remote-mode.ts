// Stage 2b of the outbound `tg` pipeline: which machine role is this (docs/specs/2026-10-28-remote-ctl-server.md §3).
//
// Runs right after argv parsing and BEFORE the --dry-run exit and every network/daemon effect, so a
// misconfigured remote setup stops a send — dry-run included — with exit 78 instead of silently
// behaving as a plain local machine. With none of the control.server/machine/remote_machines
// keys set resolveRemoteMode spawns nothing and the result is {mode:'local'}: byte-identical to before.
import { parseControlConfig, resolveControlConfig } from "../../tg-ctl/config"
import { resolveRemoteMode, type RemoteMode } from "../../tg-ctl/remote-config"
import type { Invocation, OutboundRun, RuntimePaths } from "./types"

export function enforceRemoteMode(inv: Invocation, paths: RuntimePaths): RemoteMode {
  // `--detect-agent`, `--session-id` and the like never post anything; only a send and the
  // session-topic request (a daemon/Telegram effect) are gated.
  if (inv.parsed.action !== "send" && inv.parsed.action !== "sessionTopic") return { mode: "local" }
  const cfg = resolveControlConfig(parseControlConfig(inv.configYamlRaw))
  const mode = resolveRemoteMode(cfg, process.env, { configDir: paths.configDir })
  if (mode.mode === "invalid") {
    for (const error of mode.errors) console.error(`tg: invalid remote config: ${error}`)
    // 78 = EX_CONFIG, same as the missing-credentials exit.
    process.exit(78)
  }
  return mode
}

/** The machine role resolved for this send: local, ctl client, or the daemon host of clients. */
export function remoteModeOf(run: OutboundRun): RemoteMode {
  return run.remote
}
