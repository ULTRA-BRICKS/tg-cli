// bun test preload (bunfig.toml): the suite never sees the machine it runs on.
//
// Tests spawn the real `tg` and `tg-ctl run`, which look at the host to find agents: the
// process table (`ps`), tmux, launchd. Left alone they read the developer's actual agents —
// 13 live omp sessions, claude, codex on the machine this was found on (tg-cli#545):
//   * `tg` climbs from the test process to the omp session that launched `bun test` and takes
//     its title as the `[window]` name — a Cyrillic title forced parse_mode=HTML on every plain
//     message (html-auto-detect), and the lsof of that omp plus the read of its session jsonl
//     added seconds to every `tg` run (dry-run, dict-gate hit bun's 5 s timeout);
//   * a daemon test without its own `ps` shim enumerates every live omp each tick (lsof twice
//     and a jsonl read per omp), starving the hook socket its asks and taps arrive on.
// Per-test shims prepend their own dir to PATH, so they still win over what is set up here.
import { afterAll } from 'bun:test';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LAUNCHCTL_NO_JOBS_SHIM, PGREP_NO_MATCH_SHIM, PS_NO_AGENTS_SHIM } from './helpers/hermetic-host';
import { cleanupTestRun, sweepRunProcesses, tempDir } from './helpers/test-temp';

// shimDir doubles as the run's fingerprint (tg-cli#486): it is unique to this run and sits on the
// PATH of every child (the spawn wrapper below gives it to children spawned without one too) — and
// so of their children, a detached `tg-ctl start` daemon or an abduco server included. The
// end-of-run sweep kills whatever still carries it.
const shimDir = tempDir('tg-hermetic-bin-');
for (const [name, body] of Object.entries({ ps: PS_NO_AGENTS_SHIM, launchctl: LAUNCHCTL_NO_JOBS_SHIM, pgrep: PGREP_NO_MATCH_SHIM })) {
  const path = join(shimDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;

// A tmux that was started outside the suite is invisible: a client looks for its server socket
// under TMUX_TMPDIR (or /tmp), so an empty private dir means "no server running" — exit 1, the
// steady state of a host that does not use tmux — and the developer's own panes are never
// listed, matched or typed into. `-L <name>` tests still start their own throwaway server there.
// Under /tmp, not tmpdir(): the socket path is <dir>/tmux-<uid>/<label> and a unix socket path
// holds ~104 bytes — macOS's /var/folders/... tmpdir leaves a `-L tgctl-test-<pid>` socket 3 short.
const tmuxTmpDir = tempDir('tg-hermetic-', { short: true });
process.env.TMUX_TMPDIR = tmuxTmpDir;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

// A test's fake Bot API that fails a send (or a closed port that refuses it) gets ONE attempt:
// the real retry budget (tg-cli#710, 60 s of backoff) would outlast bun's 5 s test timeout.
// A test that exercises the retry sets TG_SEND_RETRY_BUDGET_MS itself.
process.env.TG_SEND_RETRY_BUDGET_MS ??= '0';
// The suite never inherits the agent session it runs in (tg-cli#706): `tg` gates an
// agent-written body by content (the intent gate) and brands it by the agent's env markers,
// so a run from inside omp/claude and a run in CI must see the same sender — none. A test
// that wants an agent sender sets the marker in the env it spawns `tg` with. laya is never
// reached from the suite: a developer's warm task-cli classify server is off limits.
for (const key of ['TG_AI_MODEL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OPENCODE', 'CODEX', 'RIG_AGENT_ID', 'RIG_DETACHED_AGENT', 'TG_AGENT', 'RIG_SESSION']) {
  delete process.env[key];
}
process.env.TG_LAYA = '0';

// Bun gives a child spawned with NO `env` the environment bun STARTED with — the PATH,
// TMUX_TMPDIR and TMUX changes above are invisible to it — and a child whose `env` names no PATH
// a built-in default (/usr/bin:/bin). Either way the child ran the real `ps` and then lsof'd every
// live omp on the host: a `tg-ctl harness-event --pane %3` took ~500 ms unloaded and over 5 s
// under suite load (tg-cli#550). A hook always runs with a PATH in production, so such a child
// gets the suite's PATH and private tmux dir; a value the test sets itself still wins.
type SpawnEnv = Record<string, string | undefined>;

function hermeticEnv(env: SpawnEnv | undefined): SpawnEnv {
  if (env === undefined) return { ...process.env };
  const out = { ...env };
  for (const key of ['PATH', 'TMUX_TMPDIR', 'TG_SEND_RETRY_BUDGET_MS']) out[key] ??= process.env[key];
  return out;
}

function hermeticSpawn<Spawn extends typeof Bun.spawn | typeof Bun.spawnSync>(spawn: Spawn): Spawn {
  type Options = { env?: SpawnEnv };
  const wrapped = (cmdOrOptions: string[] | (Options & { cmd: string[] }), options?: Options) =>
    Array.isArray(cmdOrOptions)
      ? spawn(cmdOrOptions, { ...options, env: hermeticEnv(options?.env) })
      : spawn({ ...cmdOrOptions, env: hermeticEnv(cmdOrOptions.env) });
  return wrapped as Spawn;
}

Bun.spawn = hermeticSpawn(Bun.spawn);
Bun.spawnSync = hermeticSpawn(Bun.spawnSync);

// Run-scoped, not per-file: a preload's afterAll fires once, after the last file. Kill first so
// no daemon is still writing into a dir being removed. A run cut short still cleans up: `exit`
// covers a bail-out, and SIGINT/SIGTERM (Ctrl-C, a watchdog's TERM) end the process without
// `exit` firing, so they clean up and then exit with the signal's conventional status. Only a
// SIGKILL leaves the run's dirs behind.
let ended = false;
function endRun(): void {
  if (ended) return;
  ended = true;
  sweepRunProcesses(shimDir, tmuxTmpDir);
  cleanupTestRun();
}
afterAll(endRun);
process.on('exit', endRun);
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    endRun();
    process.exit(status);
  });
}
