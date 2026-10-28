// The path of the `tg-ctl` entry script, for code that re-executes or inspects it.
//
// The daemon modules live in features/tg-ctl/daemon-runtime/, so their own
// `import.meta.path` is no longer the script a user runs. The root `tg-ctl`
// registers its real path once at load (an in-memory assignment, no I/O); a module
// loaded without the root (a unit test importing one module) falls back to the
// repo-relative location of the script.
import { join } from "path"

let registeredPath: string | null = null

export function registerRootScript(path: string): void {
  registeredPath = path
}

export function rootScriptPath(): string {
  return registeredPath ?? join(import.meta.dir, "..", "..", "..", "tg-ctl")
}
