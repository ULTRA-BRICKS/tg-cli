// An omp a rig wrapper hosts in abduco OUTSIDE tmux, with no omp-live endpoint published: the
// daemon must type into that exact process's abduco PTY (its own TUI — no second writer, no
// spawn), exactly once. The sibling cases: with an endpoint nothing is typed; an omp that no
// live host owns fails closed and is never typed into.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SID = '01a0d2d7-6202-702d-b9e8-006b656b0799';
const NAME = 'omp-5c0de1a2b3f4';
const reg = createDaemonRegistry();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await reapDaemons(reg);
  for (const fn of cleanup.splice(0)) await fn();
});

interface Scenario {
  // true: a live endpoint is published for the omp (delivery must stay on it)
  endpoint: boolean;
  // true: the abduco server and its record exist; false: the omp is a stray under a shell
  hosted: boolean;
}

async function daemon({ endpoint, hosted }: Scenario) {
  const cfg = tempDir('tgctl-host-omp-');
  const sockDir = tempDir('tgo-', { short: true });
  const socketPath = join(sockDir, `${NAME}@testhost`);
  const bin = join(cfg, 'bin');
  mkdirSync(bin);
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n  git_state_banner: false\n');
  const sessionFile = join(cfg, `2026-09-29T01-00-00-000Z_${SID}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: SID, cwd: '/work/hosted-omp', title: 'HostedOmp' }) + '\n');
  const spawnLog = join(cfg, 'spawn.log');
  writeFileSync(spawnLog, '');
  const pid = process.pid; // the omp "process" is this runner, so the endpoint (if any) is real
  if (hosted) {
    mkdirSync(join(cfg, 'hosts'), { mode: 0o700 });
    writeFileSync(
      join(cfg, 'hosts', `${NAME}.json`),
      JSON.stringify({
        v: 1, name: NAME, harness: 'omp', label: 'hosted-omp', cwd: '/work/hosted-omp', socket: socketPath,
        serverPid: 41000, harnessPid: pid, role: 'coordinator',
        startedAt: '2026-09-30T21:30:00Z', updatedAt: '2026-09-30T21:30:00Z',
      }),
      { mode: 0o600 },
    );
  }
  const tree = hosted
    ? `    1     0 /sbin/launchd\\n41000     1 abduco -n ${NAME} rig host-run ${NAME}\\n41001 41000 /opt/homebrew/bin/python3 /Users/u/bin/rig host-run ${NAME}\\n ${pid} 41001 /opt/homebrew/bin/omp\\n`
    : `    1     0 /sbin/launchd\\n 5001     1 /bin/zsh -l\\n ${pid}  5001 /opt/homebrew/bin/omp\\n`;
  const scripts: Record<string, string> = {
    tmux: TMUX_NO_SERVER_SHIM,
    ps: `#!/bin/sh\ncase "$*" in *tty*) printf '${pid} ttys099\\n';; *) printf '${tree}';; esac\n`,
    lsof: `#!/bin/sh\nprintf 'p${pid}\\nfcwd\\nn/work/hosted-omp\\nn${sessionFile}\\n'\n`,
    omp: `#!/bin/sh\nprintf 'FORBIDDEN SPAWN %s\\n' "$*" >> '${spawnLog}'\nexit 1\n`,
  };
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(bin, name), text, { mode: 0o755 });

  // What the abduco client protocol delivers on the host's socket, per connection.
  const connections: Buffer[][] = [];
  if (hosted) {
    const abduco = Bun.listen<{ chunks: Buffer[] }>({
      unix: socketPath,
      socket: {
        open(sock) { sock.data = { chunks: [] }; },
        data(sock, data) { sock.data.chunks.push(Buffer.from(data)); },
        close(sock) { connections.push(sock.data.chunks); },
      },
    });
    cleanup.push(() => abduco.stop(true));
  }
  const received: string[] = [];
  if (endpoint) {
    const live = await startLiveEndpoint({
      root: join(cfg, 'omp-live'),
      snapshot: () => ({ sessionId: SID, sessionFile, cwd: '/work/hosted-omp', title: 'HostedOmp', busy: false }),
      send: (text: string) => { received.push(text); },
    });
    cleanup.push(() => live.close());
  }
  const notices: string[] = [];
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          return Response.json({ ok: true, result: [{ update_id: 100, message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'reach the hosted omp' } }, { update_id: 101, message: { message_id: 32, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: '/agent hosted-omp by its wrapper label' } }] });
        }
        await Bun.sleep(50);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) notices.push(String((await req.json()).text));
      return Response.json({ ok: true, result: { message_id: 77 } });
    },
  });
  cleanup.push(() => { server.stop(true); });
  const fd = openSync(join(cfg, 'daemon.log'), 'w');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir: cfg, logFd: fd, env: { PATH: `${bin}:${process.env.PATH}`, HOME: cfg, TG_CTL_CONFIG_DIR: cfg, TMUX: '', TG_API_BASE: `http://127.0.0.1:${server.port}` } });
  closeSync(fd);
  const typed = (): string[] => connections.map((c) => Buffer.concat(c).toString('latin1'));
  return { cfg, spawnLog, received, notices, typed, connections };
}

// The daemon is a real subprocess: poll for its observable effect (no fake clock reaches it).
async function until(check: () => boolean, limit = 8000) {
  const end = Date.now() + limit;
  while (!check() && Date.now() < end) await Bun.sleep(25);
}

test('an abduco-hosted omp with no endpoint is typed into through its PTY exactly once, no spawn', async () => {
  const f = await daemon({ endpoint: false, hosted: true });
  await until(() => f.connections.length > 0 || f.notices.length > 0);
  await Bun.sleep(500);
  await until(() => f.connections.length >= 2);
  expect(f.connections).toHaveLength(2);
  const bytes = f.typed().join('\n');
  expect(bytes).toContain('reach the hosted omp');
  expect(bytes).toContain('tg#31');
  // `/agent <wrapper label>` selects the hosted omp's row (named by the wrapper, not its title)
  expect(bytes).toContain('by its wrapper label');
  expect(bytes).toContain('tg#32');
  expect(f.notices.join('\n')).not.toMatch(/endpoint_unavailable|Original OMP bridge/);
  expect(readFileSync(f.spawnLog, 'utf8')).toBe('');
}, 30_000);

test('an abduco-hosted omp WITH an endpoint is delivered on the endpoint and its PTY is never typed into', async () => {
  const f = await daemon({ endpoint: true, hosted: true });
  await until(() => f.received.length >= 2 || f.connections.length > 0);
  await Bun.sleep(300);
  expect(f.received).toHaveLength(2);
  expect(f.received.join('\n')).toContain('reach the hosted omp');
  expect(f.connections).toEqual([]);
}, 30_000);

test('an omp no live host owns and without an endpoint fails closed: nothing typed, bridge error reported', async () => {
  const f = await daemon({ endpoint: false, hosted: false });
  await until(() => f.notices.some((n) => n.includes('Original OMP bridge')));
  expect(f.notices.join('\n')).toContain('Original OMP bridge: endpoint_unavailable');
  expect(f.connections).toEqual([]);
  expect(readFileSync(f.spawnLog, 'utf8')).toBe('');
}, 30_000);
