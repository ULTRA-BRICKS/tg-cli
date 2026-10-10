import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { PS_ROW_LAUNCHD } from './helpers/hermetic-host';

// The preload (bunfig.toml -> tests/hermetic-env.ts) keeps every test off the host it runs on
// (tg-cli#545): a test that spawns `tg` or `tg-ctl run` must find no agent on the machine, however
// many omp/claude/codex sessions and tmux panes the developer has open while the suite runs.

function run(argv: string[]): { code: number; stdout: string } {
  const proc = Bun.spawnSync(argv, { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString() };
}

test('the process table a test reads has launchd and nothing else — never the developer\'s agents', () => {
  expect(run(['ps', '-axo', 'pid=,ppid=,command=']).stdout.trim()).toBe(PS_ROW_LAUNCHD.trim());
  expect(run(['ps', '-axo', 'pid=,tty=']).stdout.trim()).toBe('1 ??');
});

test('any other `ps` call is the real one: a process can still be looked up by pid', () => {
  const { code, stdout } = run(['ps', '-p', String(process.pid), '-o', 'pid=']);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe(String(process.pid));
});

// The shim matches the table listings by exact argv; a flag change in the product would fall
// through to the real `ps` and leak the host again with every test still green. Every
// `ps -axo …` table listing the product spawns must therefore be one the shim answers.
test('every `ps -axo` table listing in the product is answered by the shim, not the real ps', () => {
  const root = `${import.meta.dir}/..`;
  const sources = ['tg', 'tg-ctl', ...new Bun.Glob('features/**/*.ts').scanSync(root)];
  const listings = new Set<string>();
  for (const rel of sources) {
    const text = readFileSync(`${root}/${rel}`, 'utf8');
    for (const m of text.matchAll(/\[\s*["']ps["']\s*,\s*["']-axo["']\s*,\s*["']([^"']+)["']\s*\]/g)) listings.add(m[1]);
  }
  expect(listings.size).toBeGreaterThan(0);
  for (const fmt of listings) {
    // The host table has many rows; the shim's has launchd alone.
    expect({ fmt, rows: run(['ps', '-axo', fmt]).stdout.trim().split('\n').length }).toEqual({ fmt, rows: 1 });
  }
});

test('a tmux server started outside the suite is not reachable: no server, non-zero exit', () => {
  if (Bun.which('tmux') === null) return; // no tmux installed (CI image): nothing to isolate from
  const { code, stdout } = run(['tmux', 'list-panes', '-a']);
  expect(code).not.toBe(0);
  expect(stdout).toBe('');
  expect(process.env.TMUX).toBeUndefined();
  expect(process.env.TMUX_PANE).toBeUndefined();
});

// Bun hands a child spawned with an `env` that names no PATH its own built-in default PATH
// (/usr/bin:/bin), and a child spawned with NO `env` the environment bun STARTED with — neither
// sees the shim dir prepended above. Such a `tg-ctl harness-event --pane %3` read the real process
// table and lsof'd every live omp on the host: ~500 ms unloaded, over 5 s under suite load
// (tg-cli#550). A hook in production always runs with a PATH, so the child gets the suite's.
test('a child spawned with an env that names no PATH still reads the hermetic process table', () => {
  const proc = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,command='], { env: { HOME: '/nonexistent' }, stdout: 'pipe' });
  expect(proc.stdout.toString().trim()).toBe(PS_ROW_LAUNCHD.trim());
});

test('a child spawned with no env gets the hermetic PATH and tmux dir, not the host environment bun started with', () => {
  const proc = Bun.spawnSync(['sh', '-c', 'printf "%s\\n%s\\n%s" "$PATH" "$TMUX_TMPDIR" "${TMUX_PANE-unset}"'], { stdout: 'pipe' });
  expect(proc.stdout.toString().split('\n')).toEqual([process.env.PATH, process.env.TMUX_TMPDIR, 'unset']);
});

test('an env that sets its own PATH keeps it: a per-test shim dir still wins', () => {
  const proc = Bun.spawnSync(['/bin/sh', '-c', 'printf %s "$PATH"'], { env: { PATH: '/only/this' }, stdout: 'pipe' });
  expect(proc.stdout.toString()).toBe('/only/this');
});

// features/branding/detect.ts asks `pgrep -x <name>` whether a local model server runs; the
// developer's own processes must never answer it. The test runner itself is a live `bun`.
test('pgrep finds no process, not even the bun running this test', () => {
  const proc = Bun.spawnSync(['pgrep', '-x', 'bun'], { env: process.env, stdout: 'pipe' });
  expect({ code: proc.exitCode, stdout: proc.stdout.toString() }).toEqual({ code: 1, stdout: '' });
});
