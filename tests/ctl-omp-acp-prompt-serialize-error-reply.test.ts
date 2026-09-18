import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemonRegistry, reapDaemons, spawnDaemon } from "./helpers/daemon-lifecycle";

// Regression (review finding, 2026-09-18): an earlier draft of this fix
// treated ANY explicit ACP JSON-RPC error reply to session/prompt like a
// dead pipe -- evict the client and immediately redeliver through a fresh
// one. For a session with a PERSISTENT per-prompt error (e.g. a genuinely
// unrecoverable "session already owned by another live process"), the fresh
// client's session/prompt fails identically and immediately re-evicts,
// producing an unbounded, zero-backoff `omp acp` spawn loop with no retry
// cap -- reverted after review. The final design logs the error and
// advances the queue normally (NOT evict): the client just proved its pipe
// is alive by replying at all. This pins that decision: a persistent error
// reply must drain the queue through the SAME client, never spawn a second
// process, and must be logged (not silently discarded, the original gap).

const TG_CTL = join(import.meta.dir, "..", "tg-ctl");

const cfgDir = mkdtempSync(join(tmpdir(), "tgctl-omp-acp-errorreply-"));
writeFileSync(join(cfgDir, ".env"), "TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n");
writeFileSync(join(cfgDir, "config.yaml"), "control:\n  enabled: true\n");

const binDir = join(cfgDir, "bin");
mkdirSync(binDir);

const sessionDir = join(cfgDir, "sessions");
mkdirSync(sessionDir);
const sessionFile = join(sessionDir, "2026-09-08T19-13-06-014Z_01a08270-31de-747a-9cad-a004085c0394.jsonl");
writeFileSync(
  sessionFile,
  [
    String.raw`{"type":"title","v":1,"title":"ErrorReplySession","source":"auto"}`,
    String.raw`{"type":"session","version":3,"id":"01a08270-31de-747a-9cad-a004085c0394","cwd":"/Users/u/work/state-lib/site","title":"ErrorReplySession"}`,
    "",
  ].join("\n"),
);

writeFileSync(
  join(binDir, "ps"),
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
  join(binDir, "lsof"),
  `#!/bin/sh
printf 'p20148\n'
printf 'fcwd\n'
printf 'n/Users/u/work/state-lib/site\n'
printf 'n${sessionFile}\n'
exit 0
`,
  { mode: 0o755 },
);

// A fake `omp acp` that answers EVERY session/prompt with a persistent
// JSON-RPC error -- the "session already owned by another live process"
// shape that must NOT trigger evict-and-respawn.
writeFileSync(
  join(binDir, "omp"),
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
    } else if (msg.method === "session/prompt") {
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "session already owned by another live process" } }));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`,
  { mode: 0o755 },
);

const acpLog = join(cfgDir, "acp.log");
writeFileSync(acpLog, "");
const spawnLog = join(cfgDir, "spawns.log");
writeFileSync(spawnLog, "");

const updates: Array<Record<string, unknown>> = [];
let nextUpdateIndex = 0;
const sentMessages: Array<Record<string, unknown>> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/getUpdates")) {
      if (nextUpdateIndex < updates.length) {
        const update = updates[nextUpdateIndex];
        nextUpdateIndex += 1;
        return Response.json({ ok: true, result: [update] });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith("/sendMessage")) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

function promptLinesIn(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      try {
        return JSON.parse(line).method === "session/prompt";
      } catch {
        return false;
      }
    });
}

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test("a persistent ACP error reply to session/prompt is logged and drains the queue through the SAME client, never evict-and-respawn", async () => {
  const logFd = openSync(join(cfgDir, "daemon.log"), "w");
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      OMP_ACP_LOG: acpLog,
      OMP_ACP_SPAWN_LOG: spawnLog,
      TG_CTL_ACP_PROMPT_TIMEOUT_MS: "60000",
      TMUX: "",
    },
    logFd,
  });
  closeSync(logFd);

  // Two replies sent up front: the first will error immediately; the second
  // must still be delivered (drained from the queue) through the SAME
  // client, not lost and not triggering a respawn.
  updates.push({
    update_id: 100,
    message: { message_id: 10, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 1, text: "/agent ErrorReplySession first message" },
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const daemonLog = existsSync(join(cfgDir, "daemon.log")) ? readFileSync(join(cfgDir, "daemon.log"), "utf8") : "";
    if (daemonLog.includes("omp-acp: session/prompt error")) break;
    await Bun.sleep(50);
  }
  const daemonLogAfterError = readFileSync(join(cfgDir, "daemon.log"), "utf8");
  expect(daemonLogAfterError).toContain("omp-acp: session/prompt error");
  expect(daemonLogAfterError).toContain("session already owned by another live process");
  // Deliberately NOT evicted: the client proved its pipe alive by replying.
  expect(daemonLogAfterError).not.toContain("omp-acp: evicted wedged client");

  updates.push({
    update_id: 101,
    message: { message_id: 11, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 2, text: "/agent ErrorReplySession second message" },
  });

  // The second reply must be written (and also error) through the SAME
  // client -- exactly 2 session/prompt frames, exactly 1 spawn, ever.
  const t1 = Date.now();
  while (Date.now() - t1 < 10_000) {
    if (promptLinesIn(readFileSync(acpLog, "utf8")).length >= 2) break;
    await Bun.sleep(50);
  }
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(2);

  // Give any (buggy) evict-driven respawn a real window to manifest before
  // asserting the spawn count stayed at exactly 1.
  await Bun.sleep(300);
  const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  expect(spawns.length).toBe(1);
  expect(readFileSync(join(cfgDir, "daemon.log"), "utf8")).not.toContain("omp-acp: evicted wedged client");
}, 25_000);
