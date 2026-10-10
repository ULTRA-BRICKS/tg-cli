import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// Integration test (tg-cli#413 follow-up): a FULLY headless claude session — no
// controlling terminal at all (not merely "no tmux pane"), parented directly under
// launchd with no intermediate shell — used to be silently dropped by two stacked
// gates: `findUnreachableAgents` required a tty map entry to include a pid at all,
// and `listUnreachableAgents` skipped its entire scan whenever the system-wide tty
// map was empty. Both are removed. This mirrors `ctl-unreachable-route-integration`
// but the `ps` tty-query branch reports `??` (no controlling terminal) for EVERY
// pid, including pid 1, so `readPidTtyMap()` ends up with no usable tty entries.
// tmux / ps / lsof are PATH-shimmed with a fake process table.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-headless-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
// No tmux panes at all.
writeFileSync(join(binDir, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
// ps: the 3-column tree read AND the 2-column `pid tty` read, keyed off argv.
// EVERY pid reports `??` on the tty query — a fully headless host with no
// controlling terminal anywhere, not even for pid 1.
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' 7103 ??\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' 7103     1 claude --permission-mode bypassPermissions --name landing\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(join(binDir, 'lsof'), "#!/bin/sh\nprintf 'p7103\\nfcwd\\nn/Users/u/work/landing\\n'\nexit 0\n", { mode: 0o755 });

const sentMessages: Array<Record<string, unknown>> = [];
let served = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && served === 0) {
        served = 1;
        return Response.json({
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: '/agent landing deploy now' } },
            { update_id: 101, message: { message_id: 11, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: 'plain message, nobody in tmux' } },
          ],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('a fully headless claude session (no tty anywhere, parented under launchd) is found: /agent names it in a refusal, and it is listed as unreachable', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000 && sentMessages.length < 2) await Bun.sleep(100);

  // The literal legacy bare guard text never went out standalone — the enriched,
  // agent-naming reply replaced it, exactly as it does when a tty IS available.
  expect(sentMessages.some((m) => String(m.text).startsWith('Claude Code not in tmux'))).toBe(false);

  // Found, so `/agent landing …` is refused by name (outside tmux and the rig wrapper, tg-cli#456) — not "no agent matching".

  const refusal = sentMessages.find((m) => String(m.text).includes('landing · claude runs outside tmux'));
  expect(String(refusal?.text).endsWith('Restart it with: rig harness run claude --name landing (or in a tmux window)')).toBe(true);
  expect(existsSync(join(cfgDir, 'inbox', 'landing'))).toBe(false);

  const listing = sentMessages.find((m) => String(m.text).includes('OUTSIDE tmux'));
  expect(listing?.text).toContain('landing · claude — unreachable: not in tmux (tty none, cwd /Users/u/work/landing, name landing, pid 7103)');
}, 25_000);
