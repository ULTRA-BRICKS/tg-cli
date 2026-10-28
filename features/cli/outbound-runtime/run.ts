// The outbound `tg` pipeline (tg-cli#817): the root entrypoint only wires `import.meta.dir` in; the
// work is a fixed sequence of stages. Order is behaviour — what a stage prints, exits on or
// writes happens before the next stage starts, exactly as in the single-block entrypoint this
// replaced. Contracts between stages: ./types.ts.
import { join } from "path"
import { resolveAutolinks } from "./autolink-resolve"
import { buildPlan } from "./build-plan"
import { createOutboundRecorder } from "./outbound-recorder"
import { deliver } from "./deliver"
import { makeFileCheckDeps, reportDryRunAndExit } from "./dry-run"
import { recordFollowUps } from "./follow-ups"
import { parseInvocation } from "./parse-invocation"
import { prepareMessage } from "./prepare-message"
import { resolveSender } from "./resolve-sender"
import { resolveThread } from "./topic-resolution"
import { runSubcommands } from "./subcommands"
import type { OutboundRun, RuntimePaths } from "./types"

function runtimePaths(rootDir: string): RuntimePaths {
  const home = process.env.HOME ?? "~"
  // Honors TG_CTL_CONFIG_DIR (the override tg-ctl's daemon and `replies` respect) so a
  // non-default dir never silently falls back to ~/.config/tg-cli with the WRONG bot's credentials.
  const configDir = process.env.TG_CTL_CONFIG_DIR || join(home, ".config", "tg-cli")
  return { rootDir, home, configDir }
}

export async function runOutbound(rootDir: string): Promise<void> {
  const rawArgs = process.argv.slice(2)
  const paths = runtimePaths(rootDir)
  await runSubcommands(rawArgs, paths)
  const inv = await parseInvocation(rawArgs, paths)
  const { send, sender } = await resolveSender(inv, paths)
  const prepared = await prepareMessage(send, sender, inv, paths)
  const fileCheckDeps = makeFileCheckDeps()
  if (send.dryRun) reportDryRunAndExit(send, prepared, fileCheckDeps)
  const autolinks = resolveAutolinks(prepared.caption, inv.features, paths, sender.botToken)
  const built = buildPlan(send, prepared, sender, autolinks, inv.features, fileCheckDeps)
  const recorder = createOutboundRecorder({ paths, sender, plan: built.plan })
  const thread = await resolveThread(send, prepared, sender, inv.configYamlRaw, paths)
  const run: OutboundRun = { paths, send, features: inv.features, sender, prepared, built, recorder, thread, fileCheckDeps }
  await deliver(run)
  recordFollowUps(run)
}
