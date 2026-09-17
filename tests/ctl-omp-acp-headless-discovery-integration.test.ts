import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { NO_AGENT_REPLY } from '../tg-ctl';

// Regression (tg-cli live incident, 2026-09-17): a genuinely live, interactive
// omp session with NEITHER a controlling tty NOR a tmux pane (e.g. started
// detached/headless) was invisible to every candidate list and got the bare
// "Claude Code not in tmux" legacy reply instead of ACP delivery. Fixed in
// `findLiveOmpAgents` (features/tg-ctl/omp.ts) — this proves an ordinary
// inbound Telegram text message now reaches such a session via ACP
// (session/prompt), never NO_AGENT_REPLY. tmux / ps / lsof / omp are
// PATH-shimmed with a fake process table + a fake `omp acp` NDJSON responder.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-headless-omp-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);

// No tmux server at all.
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// One omp process, pid 30099, tty `??` (NO controlling terminal) and — since
// there are no tmux panes at all — no tmux pane either. This is the exact
// "neither tty nor pane" shape the bug dropped.
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf '30099 ??\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf '30099     1 /opt/homebrew/bin/omp\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
printf 'p30099\\n'
printf 'fcwd\\n'
printf 'n/Users/u/work/headless-omp\\n'
exit 0
`,
  { mode: 0o755 },
);

// A fake `omp acp` that answers initialize/session-new/session-prompt
// immediately (no wedge — this test is about DISCOVERY, not delivery
// reliability) and logs every inbound frame so the test can see the prompt
// text actually reached it.
writeFileSync(
  join(binDir, 'omp'),
  `#!/usr/bin/env bun
const fs = require("fs");
const logPath = process.env.OMP_ACP_LOG;
if (!process.argv.includes("acp")) process.exit(0);
function encode(msg) { return JSON.stringify(msg) + "\\n"; }
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
    } else if (msg.method === "session/new") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "headless-session-1" } }));
    } else if (msg.method === "session/prompt") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    }
  }
});
setInterval(() => {}, 1 << 30);
`,
  { mode: 0o755 },
);

const acpLog = join(cfgDir, 'acp.log');
writeFileSync(acpLog, '');

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

test('a plain text message reaches a headless (no tty, no tmux pane) omp session via ACP, never the legacy no-tmux reply', async () => {
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      OMP_ACP_LOG: acpLog,
      TMUX: '',
    },
  });

  updates.push({
    update_id: 100,
    message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: 'headless reply test message' },
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const log = readFileSync(acpLog, 'utf8');
    if (log.includes('"method":"session/prompt"')) break;
    await Bun.sleep(50);
  }

  const acpLogContent = readFileSync(acpLog, 'utf8');
  expect(acpLogContent).toContain('"method":"session/prompt"');
  expect(acpLogContent).toContain('headless reply test message');
  expect(sentMessages.some((m) => String(m.text) === NO_AGENT_REPLY)).toBe(false);
  expect(sentMessages.some((m) => String(m.text).includes('not in tmux'))).toBe(false);
}, 15_000);
