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
//
// Children read `process.env.PATH` at spawn time through the tests' explicit `env:` objects;
// Bun.spawn with NO `env` option sees only the environment bun started with, which this cannot
// change — every test that needs isolation passes its env explicitly, as they all already do.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAUNCHCTL_NO_JOBS_SHIM, PS_NO_AGENTS_SHIM } from './helpers/hermetic-host';

const shimDir = mkdtempSync(join(tmpdir(), 'tg-hermetic-bin-'));
for (const [name, body] of Object.entries({ ps: PS_NO_AGENTS_SHIM, launchctl: LAUNCHCTL_NO_JOBS_SHIM })) {
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
const tmuxTmpDir = mkdtempSync('/tmp/tg-hermetic-');
process.env.TMUX_TMPDIR = tmuxTmpDir;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

process.on('exit', () => {
  rmSync(shimDir, { recursive: true, force: true });
  rmSync(tmuxTmpDir, { recursive: true, force: true });
});
