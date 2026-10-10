import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// `tg --session-topic` (tg-cli#553): a launcher of a nohup-detached child (reparented to pid 1, so
// the daemon cannot match it by ancestry) asks for the topic of the session it runs in and exports
// it as TG_TOPIC. The answer is the id, or nothing — never an error, so `$(tg --session-topic)` is
// safe in a launcher script.

const TG = join(import.meta.dir, '..', 'tg');
const SOCK_NAME = 'tg-ctl.123.sock';
const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  env: Record<string, string>;
  configDir: string;
}

function fixture(topicsYaml = 'control:\n  enabled: true\n  topics: true\n'): Fixture {
  const home = tempDir('tg-st-home-');
  const configDir = join(home, '.config', 'tg-cli');
  const binDir = tempDir('tg-st-bin-');
  dirs.push(home, binDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=-100123\n');
  writeFileSync(join(configDir, 'config.yaml'), topicsYaml);
  // No agent anywhere in the process table: the identity comes from $TMUX only.
  writeFileSync(join(binDir, 'ps'), "#!/bin/sh\nprintf '    1     0 /sbin/launchd\\n'\n", { mode: 0o755 });
  return { configDir, env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TG_CTL_CONFIG_DIR: configDir, TMUX: '/tmp/x,4242,0', TMUX_PANE: '%5' } };
}

// A daemon socket that answers every resolve-session line with `reply` and records the lines.
function fakeDaemon(f: Fixture, reply: unknown): string[] {
  const lines: string[] = [];
  const server = createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d: string) => {
      lines.push(d.trim());
      c.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(join(f.configDir, SOCK_NAME));
  servers.push(server);
  return lines;
}

async function run(f: Fixture): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', TG, '--session-topic'], { env: f.env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

test('prints the topic id the daemon resolves for this tmux pane', async () => {
  const f = fixture();
  const seen = fakeDaemon(f, { key: 'omp:abc', name: 'alpha', threadId: 191564 });
  const r = await run(f);
  expect(r).toMatchObject({ code: 0, out: '191564\n' });
  expect(JSON.parse(seen[0] ?? '{}')).toMatchObject({ kind: 'resolve-session', tmuxPane: '%5', tmuxServerPid: 4242 });
});

test('prints nothing and exits 0 for a session without a topic', async () => {
  const f = fixture();
  fakeDaemon(f, { key: null, name: null, threadId: null });
  expect(await run(f)).toMatchObject({ code: 0, out: '' });
});

test('prints nothing and exits 0 when the daemon is not running', async () => {
  expect(await run(fixture())).toMatchObject({ code: 0, out: '' });
});

test('prints nothing, without asking the daemon, when topics are off', async () => {
  const f = fixture('control:\n  enabled: true\n  topics: false\n');
  const seen = fakeDaemon(f, { key: 'omp:abc', name: 'alpha', threadId: 7 });
  expect(await run(f)).toMatchObject({ code: 0, out: '' });
  expect(seen).toEqual([]);
});

test('prints nothing outside any session (no tmux, no agent ancestor)', async () => {
  const f = fixture();
  const seen = fakeDaemon(f, { key: 'omp:abc', name: 'alpha', threadId: 7 });
  const { TMUX: _t, TMUX_PANE: _p, ...bare } = f.env;
  const proc = Bun.spawnSync(['bun', TG, '--session-topic'], { env: bare, stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toBe('');
  expect(seen).toEqual([]);
});

test('prints nothing and exits 0 without credentials', async () => {
  const f = fixture();
  writeFileSync(join(f.configDir, '.env'), '');
  expect(await run(f)).toMatchObject({ code: 0, out: '' });
});
