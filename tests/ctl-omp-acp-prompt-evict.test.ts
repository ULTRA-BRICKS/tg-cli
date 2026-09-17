import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Regression (tg-cli#353 relapse, 2026-09-17): 1.52.4/1.52.5 made promptOmpAcp
// fire-and-forget (tg-cli#322/#357) so Telegram delivery no longer blocks on
// the agent's reply. That same commit (b640b65) also deleted the ONLY code
// that ever evicted a wedged ACP client (the awaited acpCall's own
// timeout/catch) with no replacement -- confirmed by grep:
// ACP_PROMPT_TIMEOUT_MS became unused dead code, and this file (and its
// sibling ctl-omp-acp-prompt-evict-permission-pending.test.ts) were deleted
// by that same commit. A cached client whose pipe never responds to
// session/prompt again (the tg-cli#353 shape: a session already owned by
// another live process) was then reused FOREVER: every later prompt into
// that key wrote into the dead pipe, promptOmpAcp kept returning {ok:true}
// (a stdin write never itself errors), and nothing ever reached the human.
// This proves the eviction is restored, off the fire-and-forget critical
// path: a second reply after the first one wedges still spawns a SECOND
// `omp acp` process instead of reusing the dead one.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-omp-acp-evict-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);

const sessionDir = join(cfgDir, 'sessions');
mkdirSync(sessionDir);
const sessionFile = join(sessionDir, '2026-09-08T19-13-06-014Z_01a08270-31de-747a-9cad-a004085c0394.jsonl');
writeFileSync(
  sessionFile,
  [
    '{"type":"title","v":1,"title":"WedgedSession","source":"auto"}',
    '{"type":"session","version":3,"id":"01a08270-31de-747a-9cad-a004085c0394","cwd":"/Users/u/work/state-lib/site","title":"WedgedSession"}',
    '',
  ].join('\n'),
);

writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\n'
    printf ' 20148 ttys004\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\n'
    printf ' 20148     1 /opt/homebrew/bin/omp\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
printf 'p20148\n'
printf 'fcwd\n'
printf 'n/Users/u/work/state-lib/site\n'
printf 'n${sessionFile}\n'
exit 0
`,
  { mode: 0o755 },
);

// A fake `omp acp` that answers initialize/session-load immediately but NEVER
// answers session/prompt -- the wedged-session shape from the live incident.
// Each spawn appends its own pid to OMP_ACP_SPAWN_LOG so the test can prove a
// SECOND process gets spawned after the first one wedges.
writeFileSync(
  join(binDir, 'omp'),
  `#!/usr/bin/env bun
const fs = require("fs");
const logPath = process.env.OMP_ACP_LOG;
const spawnLog = process.env.OMP_ACP_SPAWN_LOG;
if (!process.argv.includes("acp")) process.exit(0);
if (spawnLog) fs.appendFileSync(spawnLog, String(process.pid) + "\\n");
function encode(msg) {
  return JSON.stringify(msg) + "\\n";
}
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  while (true) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) break;
    const json = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!json.startsWith("{")) continue;
    let msg;
    try { msg = JSON.parse(json); } catch { continue; }
    if (logPath) fs.appendFileSync(logPath, json + "\\n");
    if (msg.method === "initialize") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "oh-my-pi" } } }));
    } else if (msg.method === "session/load") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
    }
    // deliberately never respond to session/prompt -- simulates a session
    // wedged behind another live owner (the tg-cli#353 shape).
  }
});
setInterval(() => {}, 1 << 30);
`,
  { mode: 0o755 },
);

const acpLog = join(cfgDir, 'acp.log');
writeFileSync(acpLog, '');
const spawnLog = join(cfgDir, 'spawns.log');
writeFileSync(spawnLog, '');

const updates: Array<Record<string, unknown>> = [];
let nextUpdateIndex = 0;
const sentMessages: Array<Record<string, unknown>> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      if (nextUpdateIndex < updates.length) {
        const update = updates[nextUpdateIndex];
        nextUpdateIndex += 1;
        return Response.json({ ok: true, result: [update] });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('a session/prompt that never replies is evicted (off the fire-and-forget path) so the next reply spawns a fresh omp, not the wedged one', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      OMP_ACP_LOG: acpLog,
      OMP_ACP_SPAWN_LOG: spawnLog,
      TG_CTL_ACP_PROMPT_TIMEOUT_MS: '300',
      TMUX: '',
    },
    logFd,
  });
  closeSync(logFd);

  updates.push({
    update_id: 100,
    message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: '/agent WedgedSession first attempt' },
  });

  // Fire-and-forget delivery reports {ok:true} immediately; the wedge is only
  // detectable via the deferred eviction that fires TG_CTL_ACP_PROMPT_TIMEOUT_MS
  // after the prompt was written. Real subprocess + real timer: nothing to
  // fake-advance against (the daemon is a separate OS process on the platform
  // clock), so this polls its log file the same way the sibling ACP
  // integration tests do.
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const daemonLog = existsSync(join(cfgDir, 'daemon.log')) ? readFileSync(join(cfgDir, 'daemon.log'), 'utf8') : '';
    if (daemonLog.includes('omp-acp: evicted wedged client')) break;
    await Bun.sleep(50);
  }

  const daemonLogAfterFirst = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(daemonLogAfterFirst).toContain('omp-acp: evicted wedged client');

  const spawnsAfterFirst = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
  expect(spawnsAfterFirst.length).toBe(1);

  updates.push({
    update_id: 101,
    message: { message_id: 11, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 2, text: '/agent WedgedSession second attempt' },
  });

  // A second reply after the first one wedged must spawn a NEW omp acp child
  // instead of reusing the dead one (the regression: it never did, forever).
  const t1 = Date.now();
  while (Date.now() - t1 < 10_000) {
    const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
    if (spawns.length >= 2) break;
    await Bun.sleep(50);
  }

  const spawnsAfterSecond = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
  expect(spawnsAfterSecond.length).toBe(2);
  expect(new Set(spawnsAfterSecond).size).toBe(2);
}, 25_000);
