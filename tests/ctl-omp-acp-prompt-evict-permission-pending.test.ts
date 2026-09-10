import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Regression for the P1 review-quorum finding on tg-cli#352/#353
// (https://github.com/alex-mextner/tg-cli/pull/352#issuecomment-5610743766,
// Opus-omp + Sonnet-omp): the 1.49.2 wedged-client eviction fix
// (ctl-omp-acp-prompt-evict.test.ts) evicted + killed the cached ACP client
// on ANY session/prompt timeout. But session/prompt only resolves at turn
// completion per ACP semantics, so a still-outstanding
// session/request_permission -- e.g. a human slowly answering a Telegram
// permission prompt, covered by the documented 12h
// ABANDONED_PERMISSION_RETAIN_MS "never lose the tap" guarantee (tg-ctl,
// AGENTS.md "Queued permission decisions") -- got its pipe destroyed on the
// very next unrelated prompt timeout, and replyOmpAcpPermission never
// respawns a client, so every later tap on that permission failed
// identically forever.
//
// This asserts BOTH halves of the fix (promptOmpAcp only evicts when
// `!hasPendingPermission && !sawActivitySincePrompt`):
//   1. A FIRST session/prompt timeout with an outstanding permission is NOT
//      evicted -- the client survives so a later replyOmpAcpPermission can
//      still write into its stdin.
//   2. A SECOND session/prompt timeout against the SAME cached client, with
//      the permission still outstanding and this time with NO new ACP
//      traffic at all (activitySincePrompt=false), is STILL not evicted --
//      proving the pendingPermissions check is independently load-bearing,
//      not merely redundant with the activity check.
//
// The sibling test ctl-omp-acp-prompt-evict.test.ts covers the complementary
// case: zero pending permissions and zero activity DOES still evict, so a
// genuinely wedged session (no live owner, no permission) is still reaped.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-omp-acp-evict-permpending-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);

const sessionDir = join(cfgDir, 'sessions');
mkdirSync(sessionDir);
const sessionFile = join(sessionDir, '2026-09-08T19-13-06-014Z_01a08270-31de-747a-9cad-a004085c0395.jsonl');
writeFileSync(
  sessionFile,
  [
    '{"type":"title","v":1,"title":"PermPendingSession","source":"auto"}',
    '{"type":"session","version":3,"id":"01a08270-31de-747a-9cad-a004085c0395","cwd":"/Users/u/work/state-lib/site","title":"PermPendingSession"}',
    '',
  ].join('\n'),
);

writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\n'
    printf ' 20149 ttys004\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\n'
    printf ' 20149     1 /opt/homebrew/bin/omp\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
printf 'p20149\n'
printf 'fcwd\n'
printf 'n/Users/u/work/state-lib/site\n'
printf 'n${sessionFile}\n'
exit 0
`,
  { mode: 0o755 },
);

// A fake `omp acp` that answers initialize/session-load immediately. On the
// FIRST session/prompt it receives, it fires ONE unsolicited
// session/request_permission (using the sessionId from that prompt) and then
// NEVER responds to session/prompt again (first or any later attempt), and
// NEVER sends a second permission request -- the permission stays
// outstanding across repeated prompt timeouts, exactly like a human still
// deciding on Telegram.
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
let sentPermission = false;
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
    } else if (msg.method === "session/prompt") {
      if (!sentPermission) {
        sentPermission = true;
        const sid = msg.params.sessionId;
        // Delay past the daemon's promptSentAt capture so the activity
        // timestamp this produces is unambiguously later, not a same-tick
        // race against Date.now() millisecond resolution.
        setTimeout(() => {
          process.stdout.write(encode({
            jsonrpc: "2.0",
            id: 9001,
            method: "session/request_permission",
            params: {
              sessionId: sid,
              toolCall: { title: "Edit a file" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            },
          }));
        }, 50);
      }
      // deliberately never respond to session/prompt itself, on this or any
      // later attempt -- the permission is the only thing keeping this
      // client "alive" from promptOmpAcp's point of view on attempt 2+.
    }
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

test('a session/prompt timeout with an outstanding permission is not evicted, across repeated timeouts', async () => {
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
    update_id: 200,
    message: { message_id: 20, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: '/agent PermPendingSession first attempt' },
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const daemonLog = existsSync(join(cfgDir, 'daemon.log')) ? readFileSync(join(cfgDir, 'daemon.log'), 'utf8') : '';
    if (daemonLog.includes('omp-acp: prompt timed out but not evicting')) break;
    await Bun.sleep(50);
  }

  const daemonLogAfterFirst = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(daemonLogAfterFirst).toContain('ACP session/prompt timed out');
  expect(daemonLogAfterFirst).toContain('pendingPermissions=1, activitySincePrompt=true');

  const spawnsAfterFirst = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
  expect(spawnsAfterFirst.length).toBe(1);

  // Second attempt: same cached client, permission still outstanding, but
  // this time NO new ACP traffic arrives at all before this prompt also
  // times out -- proving pendingPermissions alone (not activity) is what
  // keeps the client alive here.
  updates.push({
    update_id: 201,
    message: { message_id: 21, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 2, text: '/agent PermPendingSession second attempt' },
  });

  const t1 = Date.now();
  while (Date.now() - t1 < 10_000) {
    const daemonLog = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
    const notEvictingCount = (daemonLog.match(/prompt timed out but not evicting/g) ?? []).length;
    if (notEvictingCount >= 2) break;
    await Bun.sleep(50);
  }

  const daemonLogAfterSecond = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  const notEvictingCount = (daemonLogAfterSecond.match(/prompt timed out but not evicting/g) ?? []).length;
  expect(notEvictingCount).toBe(2);
  expect(daemonLogAfterSecond).toContain('activitySincePrompt=false');

  const spawnsAfterSecond = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
  expect(spawnsAfterSecond.length).toBe(1);
  expect(new Set(spawnsAfterSecond).size).toBe(1);
}, 25_000);
