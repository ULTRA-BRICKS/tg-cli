import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemonRegistry, reapDaemons, spawnDaemon } from "./helpers/daemon-lifecycle";

// Regression (tg-cli#353-adjacent, 2026-09-18): the eviction watchdog restored
// by ctl-omp-acp-prompt-evict.test.ts only detects a client whose pipe has
// gone COMPLETELY silent. It does nothing to prevent the actual wedge shape:
// ACP `session/prompt` is one turn at a time per session, and promptOmpAcp
// used to write a brand-new `session/prompt` JSON-RPC frame into the same
// stdin pipe on every call, with no check for one already outstanding. A
// human replying twice to the same live agent before its first turn finished
// (exactly what happens when the target session is busy doing other
// multi-step work) raced a second frame into the pipe while the first was
// still unanswered -- undefined ACP behavior, and the shape a live incident
// (four replies to the same busy session, 2026-09-17) traced back to "the
// reply never reached the agent". This proves prompts are now serialized per
// client: a second reply arriving while the first is still outstanding is
// QUEUED (no second frame written) and flushed only once the first resolves
// -- served by the SAME `omp acp` process, not a fresh eviction-triggered
// respawn.

const TG_CTL = join(import.meta.dir, "..", "tg-ctl");

const cfgDir = mkdtempSync(join(tmpdir(), "tgctl-omp-acp-serialize-"));
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
    String.raw`{"type":"title","v":1,"title":"WedgedSession","source":"auto"}`,
    String.raw`{"type":"session","version":3,"id":"01a08270-31de-747a-9cad-a004085c0394","cwd":"/Users/u/work/state-lib/site","title":"WedgedSession"}`,
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

// A fake `omp acp` that answers initialize/session-load immediately, but
// defers ITS response to session/prompt until an external release file shows
// up on disk (polled every 20ms) -- simulating a session genuinely busy on a
// long-running turn, as opposed to the sibling evict test's permanently-dead
// pipe. Each spawn appends its own pid to OMP_ACP_SPAWN_LOG so the test can
// prove only ONE `omp acp` process is ever spawned across both replies --
// proof the second reply was queued, not delivered via a fresh respawn.
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
      // Hold the response until the test flips the release file into
      // existence -- this is the "busy turn" window the fix must serialize
      // a second reply through instead of racing a second frame into stdin.
      const id = msg.id;
      const waitForRelease = () => {
        if (releasePath && fs.existsSync(releasePath)) {
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

// Three call sites (initial poll, mid-window recheck, post-flush poll) need
// the exact same "count real session/prompt frames" definition in lockstep --
// a divergent count in any one of them would silently change what the test
// actually proves.
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

// Integration test against a REAL subprocess (a spawned `tg-ctl run` daemon
// and a spawned fake `omp acp` child) and REAL platform timers -- there is no
// in-process clock to fake-advance against, matching the sibling
// ctl-omp-acp-prompt-evict.test.ts's same documented exception.
test("a second reply to a busy live session is queued, not raced into the same pipe, and flushes once the first turn resolves", async () => {
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
      // Generously high so the eviction watchdog itself can never fire during
      // this test -- an eviction-driven respawn would silently mask a
      // serialization bug as a (correct-looking) queue flush.
      TG_CTL_ACP_PROMPT_TIMEOUT_MS: "60000",
      TMUX: "",
    },
    logFd,
  });
  closeSync(logFd);

  updates.push({
    update_id: 100,
    message: { message_id: 10, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 1, text: "/agent WedgedSession first message" },
  });

  // Poll acp.log until exactly one session/prompt frame has been written.
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const lines = promptLinesIn(existsSync(acpLog) ? readFileSync(acpLog, "utf8") : "");
    if (lines.length >= 1) break;
    await Bun.sleep(50);
  }
  const afterFirst = promptLinesIn(readFileSync(acpLog, "utf8"));
  expect(afterFirst.length).toBe(1);

  // A second reply to the SAME busy agent, sent before the first turn's
  // session/prompt has been acknowledged by the fake omp.
  updates.push({
    update_id: 101,
    message: { message_id: 11, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 2, text: "/agent WedgedSession second message" },
  });

  // Deterministic instead of a blind sleep: wait for the daemon's own
  // "queued" log line (added specifically for this) proving update 101 was
  // actually processed and its text was queued behind the outstanding
  // prompt -- not merely that no second frame has appeared YET, which could
  // false-pass against the buggy code if update 101 simply hasn't been
  // processed yet on a slow/loaded machine. Against the pre-fix code this
  // line never appears at all (queuePrompt's queued branch didn't exist),
  // so the daemon-log wait itself would time out and fail -- still a valid
  // regression signal, not just the frame-count check below.
  const t0b = Date.now();
  while (Date.now() - t0b < 10_000) {
    const daemonLog = existsSync(join(cfgDir, "daemon.log")) ? readFileSync(join(cfgDir, "daemon.log"), "utf8") : "";
    if (daemonLog.includes("omp-acp: session/prompt queued")) break;
    await Bun.sleep(50);
  }
  const daemonLogAfterQueue = readFileSync(join(cfgDir, "daemon.log"), "utf8");
  expect(daemonLogAfterQueue).toContain("omp-acp: session/prompt queued");

  const stillOne = promptLinesIn(readFileSync(acpLog, "utf8"));
  expect(stillOne.length).toBe(1);

  // Release the first turn -- the fake omp now answers the outstanding
  // session/prompt, which must flush the queued second message as a NEW
  // session/prompt frame through the SAME client.
  writeFileSync(releaseFile, "go");

  const t1 = Date.now();
  while (Date.now() - t1 < 10_000) {
    const lines = promptLinesIn(readFileSync(acpLog, "utf8"));
    if (lines.length >= 2) break;
    await Bun.sleep(50);
  }
  const afterSecond = promptLinesIn(readFileSync(acpLog, "utf8"));
  expect(afterSecond.length).toBe(2);

  // Exactly one `omp acp` process the whole time -- serialization via
  // queueing, never an eviction-triggered respawn.
  const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  expect(spawns.length).toBe(1);
}, 25_000);
