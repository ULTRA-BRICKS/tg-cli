// tg-cli#789: the REAL daemon sweep must nudge a working session and never an idle one.
// Fake omp host (a live endpoint in this process), fake Bot API server, hermetic ps/tmux; the
// persisted nudge state says the session has been working for two hours without a tg send,
// so the only thing that can stop the reminder is the activity the host reports.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { AWARENESS_NUDGE_TEXT, parseAwarenessNudgeStore } from '../features/tg-ctl/tg-awareness-nudge';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SID = '01a0d2d7-6202-702d-b9e8-006b656b0798';
const KEY = `omp:${SID}`;
const reg = createDaemonRegistry();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await reapDaemons(reg);
  for (const fn of cleanup.splice(0)) await fn();
});

interface HostFacts {
  busy: boolean;
  subagents: number | null;
  awaitingUser: boolean | null;
}

async function fixture(facts: HostFacts) {
  const cfg = tempDir('tgctl-nudge-');
  const bin = join(cfg, 'bin');
  mkdirSync(bin);
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n');
  const sessionFile = join(cfg, `2026-09-27T01-00-00-000Z_${SID}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: SID, cwd: '/work/original', title: 'Nudged' }) + '\n');
  const scripts: Record<string, string> = {
    ps: `#!/bin/sh\ncase "$*" in *tty*) printf '${process.pid} ??\\n';; *) printf '${process.pid} 1 /opt/homebrew/bin/omp\\n';; esac\n`,
    lsof: `#!/bin/sh\nprintf 'p${process.pid}\\nfcwd\\nn/work/original\\nn${sessionFile}\\n'\n`,
    tmux: TMUX_NO_SERVER_SHIM,
  };
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(bin, name), text, { mode: 0o755 });

  const received: string[] = [];
  const endpoint = await startLiveEndpoint({
    root: join(cfg, 'omp-live'),
    snapshot: () => ({ sessionId: SID, sessionFile, cwd: '/work/original', title: 'Nudged', ...facts }),
    send: (text: string) => {
      received.push(text);
    },
  });
  cleanup.push(() => endpoint.close());

  // Two hours of uninterrupted work, observed a moment ago, no tg send, never nudged. The row
  // is also what a pre-#789 daemon wrote (`firstSeenAt`), which that daemon would nudge at once.
  const statePath = join(cfg, 'tg-ctl.123.awareness-nudge.json');
  const now = Date.now();
  writeFileSync(
    statePath,
    JSON.stringify({ version: 1, agents: { [KEY]: { firstSeenAt: now - 2 * 3_600_000, lastTgSentAt: null, sessionId: SID, activeSince: now - 2 * 3_600_000, lastObservedAt: now } } }),
  );

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/getUpdates')) {
        await Bun.sleep(50);
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: { message_id: 77 } });
    },
  });
  cleanup.push(() => {
    server.stop(true);
  });
  const fd = openSync(join(cfg, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: cfg,
    logFd: fd,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: cfg, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: `http://127.0.0.1:${server.port}`, TMUX: '' },
  });
  closeSync(fd);
  return { received, decision: () => parseAwarenessNudgeStore(readFileSync(statePath, 'utf8'))[KEY]?.decision };
}

// The daemon is a separate real process, so its sweeps cannot run on a fake clock: poll for the
// awaited state, and the short settle sleeps below only prove that MORE sweeps change nothing.
async function until(check: () => boolean, limitMs = 6000): Promise<void> {
  const end = Date.now() + limitMs;
  while (!check() && Date.now() < end) await Bun.sleep(25);
}

test('an idle session is never nudged by the real daemon, however long its state says it was silent', async () => {
  const f = await fixture({ busy: false, subagents: 0, awaitingUser: false });
  await until(() => f.received.length > 0 || f.decision()?.outcome === 'not-working');
  await Bun.sleep(1500); // several more sweeps — still nothing
  expect(f.received).toEqual([]);
  expect(f.decision()).toEqual({ state: 'idle', reason: 'no turn running, no subagents', outcome: 'not-working' });
}, 20000);

test('a session waiting on an ask is not nudged', async () => {
  const f = await fixture({ busy: true, subagents: 0, awaitingUser: true });
  await until(() => f.received.length > 0 || f.decision()?.outcome === 'not-working');
  await Bun.sleep(1500);
  expect(f.received).toEqual([]);
  expect(f.decision()?.state).toBe('waiting-for-user');
}, 20000);

test('a working session past the threshold gets exactly one reminder', async () => {
  const f = await fixture({ busy: true, subagents: 0, awaitingUser: false });
  await until(() => f.received.length > 0);
  await Bun.sleep(1500); // more sweeps must not repeat it
  expect(f.received).toEqual([AWARENESS_NUDGE_TEXT]);
  expect(f.decision()?.outcome).toBe('already-nudged');
}, 20000);
