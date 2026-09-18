import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemonRegistry, reapDaemons, spawnDaemon } from "./helpers/daemon-lifecycle";

// Regression (found in review of the tg-cli#353-adjacent serialization fix,
// 2026-09-18): the FIRST version of writePrompt's watchdog treated "the
// session is still alive" (client.lastActivityAt advancing, or a pending
// Telegram permission) as a reason to ADVANCE the queue -- i.e. flush the
// next queued text as a new session/prompt frame -- once
// ACP_PROMPT_TIMEOUT_MS elapsed, even though turn 1's own session/prompt had
// NOT resolved yet. For a genuinely busy multi-step turn (streaming
// session/update notifications past the timeout -- exactly the production
// incident's shape), this reintroduced the identical double-frame wedge the
// whole fix exists to prevent, just delayed until the watchdog fired instead
// of happening immediately. The corrected design treats "still alive" as a
// reason to keep WAITING (re-arm against a sliding checkpoint), never to
// advance -- only a genuinely resolved response (via the normal
// resolve/reject path) or genuine silence (no activity since the last
// checkpoint) may release the queue slot.
//
// This test uses a SHORT watchdog timeout and a fake omp that streams
// session/update notifications throughout a long-held turn, so the watchdog
// fires several times while the session is provably still working. It fails
// against the buggy "still alive -> advance" code (a second session/prompt
// frame appears well before release) and passes against the fix (exactly
// one frame until release).

const TG_CTL = join(import.meta.dir, "..", "tg-ctl");

const cfgDir = mkdtempSync(join(tmpdir(), "tgctl-omp-acp-watchdog-busy-"));
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
    String.raw`{"type":"title","v":1,"title":"BusySession","source":"auto"}`,
    String.raw`{"type":"session","version":3,"id":"01a08270-31de-747a-9cad-a004085c0394","cwd":"/Users/u/work/state-lib/site","title":"BusySession"}`,
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

// A fake `omp acp` that, once it receives session/prompt, streams a
// session/update notification every 50ms (bumping the daemon's
// lastActivityAt on every frame, exactly like a real multi-step turn) until
// the release file appears, at which point it finally answers session/prompt.
// TG_CTL_ACP_PROMPT_TIMEOUT_MS is set well below the total held duration, so
// the watchdog fires multiple times while these updates are still streaming.
writeFileSync(
  join(binDir, "omp"),
  `#!/usr/bin/env bun
const fs = require("fs");
const logPath = process.env.OMP_ACP_LOG;
const spawnLog = process.env.OMP_ACP_SPAWN_LOG;
const releasePath = process.env.OMP_ACP_PROMPT_RELEASE;
if (!process.argv.includes("acp")) process.exit(0);
if (spawnLog) fs.appendFileSync(spawnLog, String(process.pid) + "\\n");
function encode(msg) {
  return JSON.stringify(msg) + "\\n";
}
let buf = "";
let sessionId = null;
let streaming = null;
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
      sessionId = msg.params.sessionId;
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: { sessionId } }));
    } else if (msg.method === "session/prompt") {
      const id = msg.id;
      clearInterval(streaming);
      streaming = setInterval(() => {
        process.stdout.write(encode({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk" } } }));
      }, 50);
      const waitForRelease = () => {
        if (releasePath && fs.existsSync(releasePath)) {
          clearInterval(streaming);
          process.stdout.write(encode({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
          return;
        }
        setTimeout(waitForRelease, 20);
      };
      waitForRelease();
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
const releaseFile = join(cfgDir, "prompt.release");

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

test("the watchdog never advances the queue while the session is still genuinely busy, even past its own timeout", async () => {
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
      OMP_ACP_PROMPT_RELEASE: releaseFile,
      // Short: the watchdog MUST fire multiple times before the turn (held
      // for ~1.2s below) actually releases -- the whole point of this test.
      TG_CTL_ACP_PROMPT_TIMEOUT_MS: "200",
      TMUX: "",
    },
    logFd,
  });
  closeSync(logFd);

  updates.push({
    update_id: 100,
    message: { message_id: 10, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 1, text: "/agent BusySession first message" },
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const lines = promptLinesIn(existsSync(acpLog) ? readFileSync(acpLog, "utf8") : "");
    if (lines.length >= 1) break;
    await Bun.sleep(50);
  }
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(1);

  updates.push({
    update_id: 101,
    message: { message_id: 11, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 2, text: "/agent BusySession second message" },
  });

  // Wait for the queued-signal so we know update 101 was actually processed
  // (not just "no second frame yet because it hasn't run").
  const t1 = Date.now();
  while (Date.now() - t1 < 10_000) {
    const daemonLog = existsSync(join(cfgDir, "daemon.log")) ? readFileSync(join(cfgDir, "daemon.log"), "utf8") : "";
    if (daemonLog.includes("omp-acp: session/prompt queued")) break;
    await Bun.sleep(50);
  }
  expect(readFileSync(join(cfgDir, "daemon.log"), "utf8")).toContain("omp-acp: session/prompt queued");

  // Hold well past several watchdog cycles (200ms timeout, held ~1.2s) while
  // session/update notifications keep streaming. Against the buggy
  // "still-alive -> advance" code, the watchdog's `lastActivityAt > checkpoint`
  // branch would already have force-flushed message 2 as a second frame
  // during this window. Poll continuously so a transient double-frame is
  // never missed by sampling only at the end.
  const t2 = Date.now();
  let sawSecondFrameEarly = false;
  while (Date.now() - t2 < 1200) {
    if (promptLinesIn(readFileSync(acpLog, "utf8")).length >= 2) {
      sawSecondFrameEarly = true;
      break;
    }
    await Bun.sleep(30);
  }
  expect(sawSecondFrameEarly).toBe(false);
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(1);
  // No eviction either -- the client is provably alive, not wedged.
  expect(readFileSync(join(cfgDir, "daemon.log"), "utf8")).not.toContain("omp-acp: evicted wedged client");

  // Now release turn 1 -- it must resolve normally and flush message 2 as
  // frame 2 through the SAME client (no respawn).
  writeFileSync(releaseFile, "go");

  const t3 = Date.now();
  while (Date.now() - t3 < 10_000) {
    if (promptLinesIn(readFileSync(acpLog, "utf8")).length >= 2) break;
    await Bun.sleep(50);
  }
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(2);

  const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  expect(spawns.length).toBe(1);
}, 25_000);
