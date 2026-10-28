// Shared fixture of the ctl-client tests: a private HOME/config dir with a client `config.yaml`, a fake
// Bot API on this process's event loop, a fake `ps` that makes the sender an out-of-tmux omp (so a route
// and a session name exist without tmux), and a runner for the REAL `tg` entrypoint.
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './test-temp';

export const CLIENT_YAML = 'control:\n  server: ssh://tg-ctl-ubuntu\n  machine: clvm\n';

const ROOT = join(import.meta.dir, '..', '..');

export interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}

export interface FakeApi {
  url: string;
  calls: ApiCall[];
  /** The message_id the next send gets; a test resets it to keep ids deterministic. */
  nextId: number;
  /** Status for the next sendMessage calls; the default (200) once the script runs out. */
  script: number[];
  fallback: number;
  stop: () => void;
}

export function startFakeApi(): FakeApi {
  const firstId = 100;
  const api: FakeApi = {
    url: '',
    calls: [],
    nextId: firstId,
    script: [],
    fallback: 200,
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      const type = req.headers.get('content-type') ?? '';
      let body: Record<string, unknown> = {};
      if (type.includes('multipart/form-data')) {
        for (const [key, value] of (await req.formData()).entries()) body[key] = value instanceof Blob ? `<blob:${value.size}b>` : value;
      } else if (type.includes('json')) {
        body = (await req.json()) as Record<string, unknown>;
      }
      api.calls.push({ method, body });
      const status = method === 'sendMessage' ? (api.script.shift() ?? api.fallback) : 200;
      if (status !== 200) return Response.json({ ok: false, error_code: status, description: 'Bad Gateway' }, { status });
      return Response.json({ ok: true, result: { message_id: api.nextId++ } });
    },
  });
  api.url = `http://127.0.0.1:${server.port}`;
  return api;
}

export interface ClientFixture {
  home: string;
  configDir: string;
  binDir: string;
  /** The cwd `tg` runs in; its basename names the session (out-of-tmux omp: the cwd project). */
  cwd: string;
}

/** `yaml: null` = no config.yaml at all. */
export function clientFixture(yaml: string | null = CLIENT_YAML, opts: { short?: boolean } = {}): ClientFixture {
  const home = tempDir('tg-client-home-', opts);
  const configDir = join(home, 'cfg');
  const binDir = join(home, 'bin');
  const cwd = join(home, 'proj-x');
  for (const dir of [configDir, binDir, cwd]) mkdirSync(dir);
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  if (yaml !== null) writeFileSync(join(configDir, 'config.yaml'), yaml);
  const ps =
    '#!/bin/sh\n' +
    'TG="$PPID"\n' +
    'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
    '[ -z "$TGPPID" ] && TGPPID=900000\n' +
    'echo "$TG $TGPPID bun run tg"\n' +
    'echo "$TGPPID 1 /opt/homebrew/bin/omp"\n';
  writeFileSync(join(binDir, 'ps'), ps);
  chmodSync(join(binDir, 'ps'), 0o755);
  return { home, configDir, binDir, cwd };
}

export interface TgRun {
  code: number;
  out: string;
  err: string;
}

export async function runEntry(
  entry: 'tg' | 'tg-ctl',
  args: string[],
  f: ClientFixture,
  env: Record<string, string>,
  stdin?: string,
): Promise<TgRun> {
  const proc = Bun.spawn([process.execPath, join(ROOT, entry), ...args], {
    cwd: f.cwd,
    env: {
      PATH: `${f.binDir}:${process.env.PATH ?? ''}`,
      HOME: f.home,
      NO_COLOR: '1',
      TG_LAYA: '0',
      TG_CTL_CONFIG_DIR: f.configDir,
      ...env,
    },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out, err };
}

export const runTg = (args: string[], f: ClientFixture, env: Record<string, string>, stdin?: string) => runEntry('tg', args, f, env, stdin);
