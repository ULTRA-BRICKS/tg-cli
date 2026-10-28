// `tg obligations …` — the follow-ups the intent gate recorded (tg-cli#706): list,
// --check (exit 1 while any is open), dismiss. Exact leading-token match only.
import { writeStdoutLine } from "../stdout-line"
import { appendFileSync, readFileSync } from "fs"
import { join } from "path"
import { fsRoutesLockIo, withRoutesLock } from "../../tg-ctl/routes"
import {
  dismissLine,
  formatObligations,
  OBLIGATIONS_FILE,
  OBLIGATIONS_USAGE,
  openObligations,
  parseObligationsArgs,
  type ObligationsCommand,
} from "../obligations"

type DismissCommand = Extract<ObligationsCommand, { action: "dismiss" }>

function readStoreOrEmpty(storePath: string): string {
  try {
    return readFileSync(storePath, "utf8")
  } catch {
    return "" // no store yet: nothing owed
  }
}

// Same lock as a reply's settlement, so a dismiss and a concurrent reply pick
// different items (subject to the shared lockfile's known gap, tg-cli#680).
// undefined → lock busy; false → nothing open under that id; true → dismissed.
function dismissUnderLock(storePath: string, cmd: DismissCommand): boolean | undefined {
  return withRoutesLock(
    fsRoutesLockIo(`${storePath}.lock`),
    () => {
      let current = ""
      try {
        current = readFileSync(storePath, "utf8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
      }
      const dismissed = dismissLine(openObligations(current), cmd.id, cmd.reason, Math.floor(Date.now() / 1000))
      if (dismissed !== null) appendFileSync(storePath, dismissed, { mode: 0o600 })
      return dismissed !== null
    },
    { attempts: 200, delayMs: 10, onContended: "skip" },
  )
}

function runDismiss(storePath: string, cmd: DismissCommand): never {
  const result = dismissUnderLock(storePath, cmd)
  if (result === undefined) {
    console.error("Error: the obligations store is busy (another tg holds its lock). Retry in a moment.")
    process.exit(1)
  }
  if (!result) {
    console.error(`Error: no open follow-up '${cmd.id}'. See \`tg obligations\`.`)
    process.exit(1)
  }
  writeStdoutLine(`dismissed ${cmd.id}`)
  process.exit(0)
}

export function runObligationsSubcommand(rawArgs: string[], configDir: string): void {
  if (rawArgs[0] !== "obligations") return
  const cmd = parseObligationsArgs(rawArgs.slice(1))
  const storePath = join(configDir, OBLIGATIONS_FILE)
  const store = readStoreOrEmpty(storePath)
  if (cmd.action === "help") {
    writeStdoutLine(OBLIGATIONS_USAGE)
    process.exit(0)
  }
  if (cmd.action === "error") {
    console.error(`${cmd.message}\n\n${OBLIGATIONS_USAGE}`)
    process.exit(2)
  }
  const open = openObligations(store)
  if (cmd.action === "dismiss") runDismiss(storePath, cmd)
  writeStdoutLine(cmd.json ? JSON.stringify(open, null, 2) : formatObligations(open))
  process.exit(cmd.check && open.length > 0 ? 1 : 0)
}
