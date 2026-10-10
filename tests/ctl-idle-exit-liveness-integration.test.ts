// The idle exit must confirm with a FRESH liveness scan (tg-cli#547). The scan now runs off the
// poll loop at most once per interval, so when the idle threshold passes, the last scan may
// predate an agent that is running right now. Exiting then would leave that agent's hook asks
// and question cards with no daemon.
//
// The scan interval is stretched to 10 minutes and idle_exit_min is 1. Two daemons run side by
// side. One has an agent outside tmux running the whole time and must survive past the threshold:
// the stale timestamp from its first scan has to be re-checked, not trusted. The other has no
// agent and must still exit.
import { afterAll, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/getUpdates')) {
      // A real long-poll holds the request; a short hold keeps the daemon from hot-looping.
      await Bun.sleep(200);
      return Response.json({ ok: true, result: [] });
    }
    return Response.json({ ok: true, result: true });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

// A daemon whose ps shows `procTable` (the 3-column read) and `ttyTable` (the `pid tty` read).
async function startDaemon(procTable: string, ttyTable: string): Promise<{ daemon: Subprocess; log: () => string }> {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-idle-liveness-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  idle_exit_min: 1\n');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\ncase "$*" in\n  *tty=*) printf '${ttyTable}' ;;\n  *) printf '${procTable}' ;;\nesac\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const logPath = join(cfgDir, 'daemon.log');
  const logFd = openSync(logPath, 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TG_CTL_LIVENESS_SCAN_MS: '600000',
    },
    logFd,
  });
  closeSync(logFd);
  return { daemon, log: () => readFileSync(logPath, 'utf8') };
}

test('the idle exit re-checks liveness with a fresh scan: a running agent keeps the daemon, none lets it exit (tg-cli#547)', async () => {
  // A Claude Code with a tty and no pane: an agent outside tmux, which keeps the daemon alive.
  const withAgent = await startDaemon('    1     0 /sbin/init\\n 7103     1 claude\\n', '    1 ?\\n 7103 ttys004\\n');
  const idle = await startDaemon('    1     0 /sbin/init\\n', '    1 ?\\n');
  // idle_exit_min is a whole number of minutes, so the threshold can only be crossed for real.
  // The idle daemon exiting marks it; the other gets a margin past it.
  await Promise.race([idle.daemon.exited, Bun.sleep(90_000)]);
  expect(idle.log()).toContain('no agent pane for 1 min — idle exit');
  await Promise.race([withAgent.daemon.exited, Bun.sleep(10_000)]);
  expect(withAgent.log()).not.toContain('idle exit');
  expect(withAgent.daemon.exitCode).toBeNull();
}, 120_000);
