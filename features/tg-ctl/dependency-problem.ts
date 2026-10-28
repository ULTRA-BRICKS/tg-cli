// Owner-facing wording for a dependency the daemon or the `tg` CLI could not run (tg-cli#804).
// Pure leaf module: shared by the pm client (/chatgpt, `tg chatgpt`) and the tg-ctl /spend and
// /daily replies. The directory list below mirrors `fallbackDirs` in ./dependency-path.ts (a test
// keeps the two in step).

export type KnownCli = 'pm' | 'rig';

// absent / invisible (both: no executable in the search path — one lookup cannot tell "not
// installed" from "installed somewhere the service cannot see") versus broken (an executable was
// found but the OS refused to start it).
export type DependencyProblem =
  | { kind: 'not-found'; searchedPath: string }
  | { kind: 'not-startable'; path: string; reason: string };

// Where the message is read: the Telegram reply of the long-running daemon, or a one-shot shell command.
export type ProblemSurface = 'telegram' | 'shell';

export const SEARCHED_PLACES = '~/.local/bin, ~/.files/bin, /opt/homebrew/bin and /usr/local/bin';
const PATH_SHOWN_MAX = 200;

export function spawnFailureReason(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : '';
  return code || (err instanceof Error ? err.message : 'spawn failed');
}

// A `#!/usr/bin/env interp` script whose interpreter is missing makes env exit 127 AFTER the
// executable started. env prints `env: 'python3': No such file or directory` (GNU; with a
// `/usr/bin/` prefix and curly quotes when env was invoked by path) or
// `env: python3: No such file or directory` (BSD/macOS). Only that stderr shape proves the tool
// itself never ran; any other 127 is the tool's own answer and keeps its own output (and a mutating
// pm request that exits 127 otherwise stays `uncertain`).
export const EXIT_COMMAND_NOT_FOUND = 127;
const ENV_INTERPRETER_MISSING = /^(?:\S*\/)?env: .*: No such file or directory/m;

export function isInterpreterMissing(exitCode: number | null, stderr: string): boolean {
  return exitCode === EXIT_COMMAND_NOT_FOUND && ENV_INTERPRETER_MISSING.test(stderr);
}

export function interpreterFailureReason(stderr: string): string {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => ENV_INTERPRETER_MISSING.test(l)) ?? 'exited 127';
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

const FEATURE: Record<KnownCli, string> = {
  pm: 'ChatGPT session control (/chatgpt, `tg chatgpt`)',
  rig: 'the usage and shipping reports (/spend, /daily)',
};
const TELEGRAM_RETRY: Record<KnownCli, string> = { pm: 'send /chatgpt again', rig: 'send the command again' };

function shortPath(searchedPath: string): string {
  if (searchedPath === '') return 'empty';
  return searchedPath.length <= PATH_SHOWN_MAX ? searchedPath : `${searchedPath.slice(0, PATH_SHOWN_MAX - 1)}…`;
}

// Names the feature, the classified problem and the fix FIRST and the (possibly long) PATH last, so
// a length cap can only ever cut the diagnostic tail. The daemon re-checks on every command, so a fix
// needs no restart; the PATH shown is the daemon's own, not the owner's shell.
export function describeDependencyProblem(name: KnownCli, problem: DependencyProblem, surface: ProblemSurface = 'telegram'): string {
  const retry =
    surface === 'telegram'
      ? `Then ${TELEGRAM_RETRY[name]}: the daemon re-checks on every command, so no restart is needed (after updating tg-cli itself, run \`tg-ctl restart --if-stale\`).`
      : 'Then run the command again.';
  if (problem.kind === 'not-startable') {
    return `${FEATURE[name]} needs the \`${name}\` CLI. It was found at ${problem.path} but could not be started (${problem.reason}). Check that its interpreter exists, e.g. run \`${problem.path} --version\`. ${retry}`;
  }
  const where = surface === 'telegram' ? 'the tg-ctl daemon cannot find it' : 'it was not found';
  const fix =
    surface === 'telegram'
      ? `Install \`${name}\`, or link it into ~/.local/bin, on the machine running tg-ctl.`
      : `Install \`${name}\` or add it to PATH.`;
  const owner = surface === 'telegram' ? "the daemon's PATH" : 'PATH';
  return `${FEATURE[name]} needs the \`${name}\` CLI, but ${where}. ${fix} ${retry} Searched: ${SEARCHED_PLACES} and ${owner} (${shortPath(problem.searchedPath)}).`;
}
