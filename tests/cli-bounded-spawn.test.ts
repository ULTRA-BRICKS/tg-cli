import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// tg-cli#481: `tg` resolves its session identity through local probes — `ps` for the agent
// ancestor, `lsof` on an omp ancestor for its session jsonl and cwd, `tmux display-message` for
// the pane. Each ran through Bun.spawnSync with no timeout, so one slow child (lsof walking a
// long-lived omp's fds, a wedged tmux server) stalled the whole send for as long as it hung.
// These run the REAL `tg` against a mock Bot API with a sleeping `lsof` / `tmux` first on
// PATH and require the send to finish in a bounded time, without the identity that probe
// would have supplied.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
// A probe is bounded at 2 s (features/util/spawn-timeout.ts) and `tg` stops asking a binary
// that already timed out once, so one wedged binary costs one bound plus bun startup.
const SEND_BOUND_MS = 6000;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// `ps` reporting this tg's parent as the given agent command (or no agent at all), the shape
// tests/cli-omp-route-notmux.test.ts uses for an omp ancestor.
function writeFakePs(binDir: string, parentCommand: string | null): void {
  const parent = parentCommand ?? 'zsh';
  writeFileSync(
    join(binDir, 'ps'),
    '#!/bin/sh\n' +
      'TG="$PPID"\n' +
      'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
      '[ -z "$TGPPID" ] && TGPPID=900000\n' +
      'echo "$TG $TGPPID bun run tg"\n' +
      `echo "$TGPPID 1 ${parent}"\n`,
    { mode: 0o755 },
  );
}

// A binary that records it was called, then hangs far past any reasonable bound.
function writeHangingBinary(binDir: string, name: string, marker: string): void {
  writeFileSync(join(binDir, name), `#!/bin/sh\necho "$@" >> '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
}

async function sendWithin(
  env: Record<string, string>,
  text: string,
): Promise<{ elapsedMs: number; exitCode: number | null; stderr: string; received: Array<Record<string, unknown>> }> {
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/sendMessage')) {
        received.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 41 } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  try {
    const started = Date.now();
    const proc = Bun.spawn(['bun', TG_SCRIPT, text], {
      env: { ...env, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // A real-clock watchdog, not a wait: the race settles the moment tg exits. Fake timers
    // cannot stand in — the bound under test is a child process's wall-clock hang.
    const stderrText = new Response(proc.stderr).text();
    const finished = await Promise.race([proc.exited.then(() => true), Bun.sleep(SEND_BOUND_MS * 2).then(() => false)]);
    if (!finished) proc.kill('SIGKILL');
    const elapsedMs = Date.now() - started;
    return { elapsedMs, exitCode: finished ? proc.exitCode : null, stderr: await stderrText, received };
  } finally {
    server.stop(true);
  }
}

function baseEnv(binDir: string): Record<string, string> {
  const home = tempDir('tg-bounded-home-');
  const configDir = tempDir('tg-bounded-cfg-');
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TG_CTL_CONFIG_DIR: configDir };
}

test('tg under an omp whose lsof hangs still sends, in bounded time', async () => {
  const binDir = tempDir('tg-bounded-bin-');
  const lsofCalls = join(binDir, 'lsof.calls');
  writeFakePs(binDir, '/opt/homebrew/bin/omp');
  writeHangingBinary(binDir, 'lsof', lsofCalls);

  const res = await sendWithin(baseEnv(binDir), 'report from a slow-lsof omp');

  expect(res.elapsedMs).toBeLessThan(SEND_BOUND_MS);
  expect(res.exitCode).toBe(0);
  expect(res.received).toHaveLength(1);
  expect(res.received[0].text as string).toContain('report from a slow-lsof omp');
  // procfs answers the omp's open files and cwd where it exists (Linux) — lsof is the
  // fallback for hosts without it (macOS), where the bound above is what holds.
  if (existsSync('/proc/self/fd')) expect(existsSync(lsofCalls)).toBe(false);
}, 20_000);

test('tg in a pane whose tmux server hangs still sends, in bounded time, and asks tmux only once', async () => {
  const binDir = tempDir('tg-bounded-bin-');
  const tmuxCalls = join(binDir, 'tmux.calls');
  writeFakePs(binDir, null);
  writeHangingBinary(binDir, 'tmux', tmuxCalls);
  const env = { ...baseEnv(binDir), TMUX: '/tmp/tg-bounded-tmux,1,0', TMUX_PANE: '%7' };

  const res = await sendWithin(env, 'report from a wedged tmux');

  expect(res.elapsedMs).toBeLessThan(SEND_BOUND_MS);
  expect(res.exitCode).toBe(0);
  expect(res.received).toHaveLength(1);
  expect(res.received[0].text as string).toContain('report from a wedged tmux');
  // The first query timed out; every later one (pane name, origin pane, history label) is skipped.
  expect(readFileSync(tmuxCalls, 'utf8').trim().split('\n')).toHaveLength(1);
}, 30_000);
