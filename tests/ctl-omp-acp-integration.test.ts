import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Integration (tg-cli#323): inbound Telegram text reaches a live omp child via ACP
// session/prompt with TMUX unset. A tmux send-keys path would fail this test
// (the fake tmux logs argv; we assert it never saw send-keys). Session name
// comes from omp's own jsonl title, not the cwd basename.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-omp-acp-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux.log');
writeFileSync(tmuxLog, '');
writeFileSync(
  join(binDir, 'tmux'),
  `#!/bin/sh
echo "$0 $*" >> ${JSON.stringify(tmuxLog).slice(1, -1)}
exit 0
`,
  { mode: 0o755 },
);

const sessionDir = join(cfgDir, 'sessions');
mkdirSync(sessionDir);
const sessionFile = join(sessionDir, '2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl');
writeFileSync(
  sessionFile,
  [
    '{"type":"title","v":1,"title":"ReviewFix","source":"auto"}',
    '{"type":"session","version":3,"id":"01a07d8e-c12c-7433-903d-e98726bfda37","cwd":"/Users/u/work/review-cli","title":"ReviewFix"}',
    '',
  ].join('\n'),
);

writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' 7103 ttys004\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' 7103     1 /opt/homebrew/bin/omp\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
printf 'p7103\\n'
printf 'fcwd\\n'
printf 'n/Users/u/work/review-cli\\n'
printf 'n${sessionFile}\\n'
exit 0
`,
  { mode: 0o755 },
);

const acpLog = join(cfgDir, 'acp.log');
writeFileSync(acpLog, '');
writeFileSync(
  join(binDir, 'omp'),
  `#!/usr/bin/env bun
const fs = require("fs");
const logPath = process.env.OMP_ACP_LOG;
if (!process.argv.includes("acp")) process.exit(0);
function encode(msg) {
  const json = JSON.stringify(msg);
  return "Content-Length: " + Buffer.byteLength(json, "utf8") + "\\r\\n\\r\\n" + json;
}
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  while (true) {
    const headerEnd = buf.search(/\\r?\\n\\r?\\n/);
    if (headerEnd < 0) break;
    const header = buf.slice(0, headerEnd);
    const m = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!m) break;
    const len = Number(m[1]);
    const sep = buf.slice(headerEnd, headerEnd + 4).startsWith("\\r\\n\\r\\n") ? 4 : 2;
    const bodyStart = headerEnd + sep;
    const bodyBuf = Buffer.from(buf.slice(bodyStart), "utf8");
    if (bodyBuf.length < len) break;
    const json = bodyBuf.subarray(0, len).toString("utf8");
    buf = bodyBuf.subarray(len).toString("utf8");
    let msg;
    try { msg = JSON.parse(json); } catch { continue; }
    if (logPath) fs.appendFileSync(logPath, json + "\\n");
    if (msg.method === "initialize") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "oh-my-pi" } } }));
    } else if (msg.method === "session/new") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "01fake-acp-session" } }));
      process.stdout.write(encode({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "01fake-acp-session", update: { sessionUpdate: "session_info_update", title: "ReviewFix" } } }));
    } else if (msg.method === "session/prompt") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    }
  }
});
setInterval(() => {}, 1 << 30);
`,
  { mode: 0o755 },
);

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
            {
              update_id: 100,
              message: {
                message_id: 10,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: 1,
                text: '/agent ReviewFix deploy now',
              },
            },
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
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('Telegram text reaches fake omp ACP with TMUX unset; never tmux send-keys; name from omp title', async () => {
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
      TMUX: '',
    },
    logFd,
  });
  closeSync(logFd);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    const acp = existsSync(acpLog) ? readFileSync(acpLog, 'utf8') : '';
    if (acp.includes('session/prompt')) break;
    await Bun.sleep(100);
  }

  const acp = existsSync(acpLog) ? readFileSync(acpLog, 'utf8') : '';
  expect(acp).toContain('"method":"initialize"');
  expect(acp).toContain('"method":"session/new"');
  expect(acp).toContain('"method":"session/prompt"');
  expect(acp).toContain('deploy now');
  expect(acp).toContain('[TG from Alex');
  expect(acp).toContain('tg#10');
  expect(acp).not.toContain('send-keys');

  const tmux = readFileSync(tmuxLog, 'utf8');
  expect(tmux).not.toContain('send-keys');

  const confirm = sentMessages.find((m) => String(m.text).includes('ReviewFix'));
  expect(confirm?.text).toContain('ReviewFix');
  expect(String(confirm?.text)).not.toContain('review-cli');
});
