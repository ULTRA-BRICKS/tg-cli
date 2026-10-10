import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Server, Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// End-to-end "gone subagent" fallback (live report, 2026-09-18): a real daemon, a fake
// Telegram server, and a fake tmux/ps reporting ONE live claude pane (%1). The CTO's
// last-user-target anchor (tg-cli#78) is pre-seeded to point at that pane. Addressing
// `/agent <a-name-that-does-not-exist>` must NOT drop the message — it must land in the
// anchor pane (the closest available proxy for "whoever was addressing the now-gone
// name") and the daemon must reply saying exactly that, never silently.
//
// This drives a REAL `tg-ctl run` subprocess against a REAL HTTP fake (Bun.serve) —
// fake timers can't control a separate OS process or its socket polling, so `waitFor`
// below polls the platform clock (same convention as every other `ctl-*-integration`
// test in this suite, e.g. ctl-topics-integration.test.ts).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

const PANE = '%1';
const PANE_PID = 5301;

// A fake tmux reporting ONE claude-hosting pane, logging every send-keys -l payload as
// `<paneId>\t<text>` to $injectLog (mirrors ctl-topics-integration.test.ts's fakeTmux).
function fakeTmux(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE}' '${PANE_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message)
    printf 'main\\n'
    ;;
  send-keys)
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer)
    cat >> '${injectLog}'
    printf '\\n' >> '${injectLog}'
    ;;
esac
exit 0
`;
}

// ps -axo pid=,ppid=,command= → the pane pid runs claude, so findAgentInPane resolves it.
function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(opts: { seedAnchor: boolean }): string {
  const cfgDir = tempDir('tgctl-gone-agent-');
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  if (opts.seedAnchor) {
    // The CTO's last confirmed target: %1, at this pane's own cwd (cfgDir) — matches
    // routeMatchesPane's cwd check against the live candidate's panePath.
    writeFileSync(
      join(cfgDir, 'tg-ctl.123.last-user-target.json'),
      JSON.stringify({ paneId: PANE, cwd: cfgDir, ts: Math.floor(Date.now() / 1000) }),
    );
  }
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return cfgDir;
}

function injected(cfgDir: string): Array<{ pane: string; text: string }> {
  const p = join(cfgDir, 'inject.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab === -1 ? { pane: '', text: l } : { pane: l.slice(0, tab), text: l.slice(tab + 1) };
    });
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

function makeServer(updateQueue: unknown[][]): {
  server: Server;
  sends: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sends.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, sends };
}

function agentMsg(messageId: number, text: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text },
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

test('`/agent <gone-name>` with an anchor pane live delivers there and says so, instead of dropping the message', async () => {
  const cfgDir = makeCfgDir({ seedAnchor: true });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // "ghost" matches nothing: not the tmux window name ("main"), not any out-of-tmux
  // process, not any live omp session — it is a subagent-style name that never
  // resolves to a live pane at all.
  updateQueue.push([agentMsg(10, '/agent ghost please pick this up', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(PANE);
  expect(landed[0].text).toContain('please pick this up');

  await waitFor(() => sends.length >= 1);
  const reply = sends.find((s) => typeof s.text === 'string' && (s.text as string).includes('ghost'));
  expect(reply).toBeTruthy();
  expect(reply!.text as string).toContain("agent 'ghost' is gone");
  expect(reply!.text as string).toContain('your last active session');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('`/agent <gone-name>` with exactly one live agent but NO anchor still errors — never guess by candidate count', async () => {
  const cfgDir = makeCfgDir({ seedAnchor: false });
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([agentMsg(11, '/agent ghost second try', nowSec)]);

  await waitFor(() => sends.length >= 1);
  // NOT injected anywhere — a single live agent with no anchor is exactly the
  // "only agent running" heuristic this fallback deliberately refuses (the past
  // `/agent ext` → lone `rig` pane misroute).
  expect(injected(cfgDir)).toHaveLength(0);
  const reply = sends[0];
  expect(reply.text as string).toContain("no agent matching 'ghost'");

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);
