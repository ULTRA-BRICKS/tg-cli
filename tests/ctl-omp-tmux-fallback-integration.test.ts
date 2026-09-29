// #458: an omp in a tmux pane WITHOUT an original-process endpoint is still the
// original process; the real daemon types into its own pane instead of refusing.
// With an endpoint, delivery stays on the endpoint and nothing is typed (no duplicate).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { createDaemonRegistry, spawnDaemon, reapDaemons } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SID = '01a0d2d7-6202-702d-b9e8-006b656b0799';
const reg = createDaemonRegistry();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { await reapDaemons(reg); for (const fn of cleanup.splice(0)) await fn(); });

function environment() {
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-omp-tmux-'));
  const bin = join(cfg, 'bin'); mkdirSync(bin);
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n  git_state_banner: false\n');
  const sessionFile = join(cfg, `2026-09-29T01-00-00-000Z_${SID}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: SID, cwd: '/work/omp-pane', title: 'PaneOmp' }) + '\n');
  const tmuxLog = join(cfg, 'tmux.log'); writeFileSync(tmuxLog, '');
  const spawnLog = join(cfg, 'spawn.log'); writeFileSync(spawnLog, '');
  const pid = process.pid; // the omp "process" is this runner, so the endpoint (if any) is real
  const scripts: Record<string, string> = {
    tmux: `#!/bin/sh\ncase "$*" in\n  *list-panes*) printf 'main\\t0\\t%%9\\t5001\\tbun\\tomp-win\\t/work/omp-pane\\n' ;;\n  *) echo "$*" >> '${tmuxLog}' ;;\nesac\nexit 0\n`,
    ps: `#!/bin/sh\ncase "$*" in *tty*) printf '${pid} ttys099\\n';; *) printf '    1     0 /sbin/launchd\\n 5001     1 /bin/zsh -l\\n ${pid}  5001 /opt/homebrew/bin/omp\\n';; esac\n`,
    lsof: `#!/bin/sh\nprintf 'p${pid}\\nfcwd\\nn/work/omp-pane\\nn${sessionFile}\\n'\n`,
    omp: `#!/bin/sh\nprintf 'FORBIDDEN SPAWN %s\\n' "$*" >> '${spawnLog}'\nexit 1\n`,
  };
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(bin, name), text, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: cfg, TG_CTL_CONFIG_DIR: cfg, TMUX: '' };
  return { cfg, env, sessionFile, tmuxLog, spawnLog };
}

async function daemon(publish: boolean) {
  const e = environment();
  const received: string[] = [];
  if (publish) {
    const endpoint = await startLiveEndpoint({ root: join(e.cfg, 'omp-live'),
      snapshot: () => ({ sessionId: SID, sessionFile: e.sessionFile, cwd: '/work/omp-pane', title: 'PaneOmp', busy: false }),
      send: (text: string) => { received.push(text); },
    });
    cleanup.push(() => endpoint.close());
  }
  const notices: string[] = []; let served = false;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      if (!served) { served = true; return Response.json({ ok: true, result: [{ update_id: 100,
        message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 },
          date: Math.floor(Date.now() / 1000), text: 'reach the pane omp' } }] }); }
      await Bun.sleep(50); return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) { const body = await req.json(); notices.push(String(body.text)); }
    return Response.json({ ok: true, result: { message_id: 77 } });
  } }); cleanup.push(() => { server.stop(true); });
  const fd = openSync(join(e.cfg, 'daemon.log'), 'w');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir: e.cfg, logFd: fd,
    env: { ...e.env, TG_API_BASE: `http://127.0.0.1:${server.port}` } }); closeSync(fd);
  return { ...e, received, notices };
}

// The daemon is a real subprocess: poll for its observable effect (no fake clock reaches it).
async function until(check: () => boolean, limit = 6000) {
  const end = Date.now() + limit;
  while (!check() && Date.now() < end) await Bun.sleep(25);
}
const typed = (log: string) => readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('send-keys -t %9'));

test('in-tmux omp without an endpoint gets tmux send-keys into its own pane, no spawn', async () => {
  const f = await daemon(false);
  await until(() => typed(f.tmuxLog).some(l => l === 'send-keys -t %9 Enter') || f.notices.length > 0);
  const keys = typed(f.tmuxLog);
  expect(keys.some(l => l.includes('-l') && l.includes('reach the pane omp') && l.includes('tg#31'))).toBe(true);
  expect(keys.at(-1)).toBe('send-keys -t %9 Enter');
  expect(f.notices.join('\n')).not.toMatch(/endpoint_unavailable/);
  expect(readFileSync(f.spawnLog, 'utf8')).toBe('');
}, 20000);

test('in-tmux omp WITH an endpoint is delivered on the endpoint and never typed into', async () => {
  const f = await daemon(true);
  // An accepted endpoint receipt returns before any fallback could run.
  await until(() => f.received.length > 0 || typed(f.tmuxLog).length > 0);
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toContain('reach the pane omp');
  expect(typed(f.tmuxLog)).toEqual([]);
  expect(readFileSync(f.spawnLog, 'utf8')).toBe('');
}, 20000);

test('tg-ctl status names the live omp that has no bridge and how it is reached', async () => {
  const e = environment();
  const p = Bun.spawn([process.execPath, TG_CTL, 'status'], {
    env: { ...process.env, ...e.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out).toContain('omp without bridge: 1');
  expect(out).toMatch(/- PaneOmp · pid \d+ · pane %9 → tmux send-keys into its own TUI/);
}, 20000);
