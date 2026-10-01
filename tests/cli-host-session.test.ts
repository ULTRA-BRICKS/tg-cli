import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// docs/specs/2026-09-30-harness-agnostic-control.md §2–§3: a harness a rig wrapper hosts in
// abduco outside tmux finds its registration record through $RIG_SESSION. `tg` takes the
// `[window]` label from the record (the wrapper's --name) and stamps the outbound route with
// the synthetic origin `host:<name>`, so a CTO reply routes back into the session's PTY.

const TG = join(import.meta.dir, '..', 'tg');
const NAME = 'claude-3f9a0c1d2e4b';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  configDir: string;
  env: Record<string, string>;
}

// A `ps` that shows no agent anywhere: the tests run under omp/claude themselves, and the real
// ancestry must not leak into an outside-tmux identity.
function fixture(record: Record<string, unknown> | null, opts: { ompAncestor?: boolean; rigSession?: string } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'tg-host-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'tg-host-cfg-'));
  const binDir = mkdtempSync(join(tmpdir(), 'tg-host-bin-'));
  dirs.push(home, configDir, binDir);
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  const ps = opts.ompAncestor
    ? '#!/bin/sh\nTG="$PPID"\nTGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n[ -z "$TGPPID" ] && TGPPID=900000\necho "$TG $TGPPID bun run tg"\necho "$TGPPID 1 /opt/homebrew/bin/omp"\n'
    : "#!/bin/sh\nprintf '    1     0 /sbin/launchd\\n'\n";
  writeFileSync(join(binDir, 'ps'), ps, { mode: 0o755 });
  chmodSync(join(binDir, 'ps'), 0o755);
  if (record !== null) {
    mkdirSync(join(configDir, 'hosts'), { mode: 0o700 });
    writeFileSync(join(configDir, 'hosts', `${NAME}.json`), JSON.stringify(record), { mode: 0o600 });
  }
  return {
    configDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: home,
      TG_CTL_CONFIG_DIR: configDir,
      RIG_SESSION: opts.rigSession ?? NAME,
    },
  };
}

const RECORD = {
  v: 1,
  name: NAME,
  harness: 'claude',
  label: 'landing-page',
  cwd: '/Users/u/work/landing',
  socket: `/s/${NAME}@h`,
  serverPid: 4242,
  role: 'coordinator',
};

function run(f: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bun', TG, ...args], { env: { ...f.env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe' });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

test('--detect-agent outside tmux: the record label is the [window] name, the cwd project is the fallback', () => {
  expect(run(fixture(RECORD), ['--detect-agent']).out.split('\n')[0]).toBe('landing-page');
  expect(run(fixture({ ...RECORD, label: null }), ['--detect-agent']).out.split('\n')[0]).toBe('landing');
});

test('--detect-agent: no usable record (missing, invalid, another session\u2019s) means no session identity — no invented bracket', () => {
  expect(run(fixture(null), ['--detect-agent']).out.split('\n')[0]).toBe('(none)');
  expect(run(fixture({ ...RECORD, v: 9 }), ['--detect-agent']).out.split('\n')[0]).toBe('(none)');
  expect(run(fixture(RECORD, { rigSession: 'claude-000000000000' }), ['--detect-agent']).out.split('\n')[0]).toBe('(none)');
  expect(run(fixture(RECORD, { rigSession: '../../etc/passwd' }), ['--detect-agent']).out.split('\n')[0]).toBe('(none)');
});

test('a host label outranks the omp title of an omp hosted by the wrapper (the wrapper\u2019s --name is its window)', () => {
  const f = fixture({ ...RECORD, harness: 'omp', name: NAME }, { ompAncestor: true });
  // name/stem must agree with the harness prefix only by convention; the record stays valid
  expect(run(f, ['--detect-agent']).out.split('\n')[0]).toBe('landing-page');
});

test('an outbound send from a hosted session carries the label and records route + history under host:<name>', async () => {
  const f = fixture(RECORD);
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/sendMessage')) {
        received.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 88 } });
      }
      return Response.json({ ok: false, description: 'unexpected' }, { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(['bun', TG, 'hello from a hosted claude'], {
      env: { ...f.env, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(err).toBe('');
    expect(received).toHaveLength(1);
    // the prefix is Unicode-styled (bold sans); NFKC folds it back to plain letters
    expect(String(received[0].text).normalize('NFKC')).toContain('[landing-page]');

    const routes = JSON.parse(readFileSync(join(f.configDir, 'tg-ctl.123.routes.json'), 'utf8')) as Array<{ id: number; paneId: string; cwd: string }>;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ id: 88, paneId: `host:${NAME}`, cwd: '/Users/u/work/landing' });

    const history = readFileSync(join(f.configDir, 'tg-ctl.123.history.jsonl'), 'utf8').trim().split('\n');
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0])).toMatchObject({ direction: 'agent', pane: `host:${NAME}`, targetAgent: 'landing-page', text: 'hello from a hosted claude' });
  } finally {
    server.stop(true);
  }
}, 20_000);

test('an omp hosted by the wrapper keeps its omp:<pid> origin (omp-live is its first channel)', async () => {
  const f = fixture({ ...RECORD, harness: 'omp' }, { ompAncestor: true });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      return new URL(req.url).pathname.endsWith('/sendMessage') ? Response.json({ ok: true, result: { message_id: 91 } }) : Response.json({ ok: false }, { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(['bun', TG, 'hello from a hosted omp'], {
      env: { ...f.env, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    const routes = JSON.parse(readFileSync(join(f.configDir, 'tg-ctl.123.routes.json'), 'utf8')) as Array<{ paneId: string }>;
    expect(routes[0].paneId).toMatch(/^omp:\d+$/);
  } finally {
    server.stop(true);
  }
}, 20_000);

test('no RIG_SESSION record, no agent ancestor, no tmux: a bare send records no route at all', async () => {
  const f = fixture(null);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      return new URL(req.url).pathname.endsWith('/sendMessage') ? Response.json({ ok: true, result: { message_id: 92 } }) : Response.json({ ok: false }, { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(['bun', TG, 'cron job output'], {
      env: { ...f.env, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(existsSync(join(f.configDir, 'tg-ctl.123.routes.json'))).toBe(false);
  } finally {
    server.stop(true);
  }
}, 20_000);
