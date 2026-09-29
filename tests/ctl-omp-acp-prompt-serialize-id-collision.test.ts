import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemonRegistry, reapDaemons, spawnDaemon } from "./helpers/daemon-lifecycle";

// Regression (review finding, "critical", 2026-09-18): registering a
// session/prompt's own id in `client.pending` (this fix's core mechanism)
// introduced an id-namespace collision hazard that did not exist before.
// ACP is bidirectional JSON-RPC: `client.nextId` numbers OUR outbound
// requests (initialize, session/load, session/prompt), while an inbound
// `session/request_permission` carries the AGENT's own, independently
// counted id. Both counters are small sequential integers, so a permission
// request issued mid-turn can numerically collide with the currently
// in-flight session/prompt's id. Matching `client.pending` on id alone would
// treat that permission REQUEST as the prompt's own RESPONSE: the permission
// never reaches `acpPermissionToButtonRequest` (the human never sees the
// card), and `advance()` fires prematurely, flushing the next queued text
// into a session still actually blocked on that unanswered decision -- the
// exact double-frame wedge this whole file exists to prevent, reached
// through the id-collision back door. The fix requires `rec.method ===
// undefined` (a genuine JSON-RPC response never carries `method`) before
// matching on id. This test sends a permission request that reuses the
// EXACT id of the in-flight session/prompt and asserts it is still
// forwarded to Telegram (not swallowed) and does not advance the queue.

const TG_CTL = join(import.meta.dir, "..", "tg-ctl");

const cfgDir = mkdtempSync(join(tmpdir(), "tgctl-omp-acp-idcollide-"));
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
    String.raw`{"type":"title","v":1,"title":"CollideSession","source":"auto"}`,
    String.raw`{"type":"session","version":3,"id":"01a08270-31de-747a-9cad-a004085c0394","cwd":"/Users/u/work/state-lib/site","title":"CollideSession"}`,
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

// A fake `omp acp` that, on receiving session/prompt, immediately emits a
// session/request_permission REQUEST reusing the EXACT SAME numeric id as
// the just-received session/prompt (the collision this test targets), then
// holds the actual session/prompt response until released.
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
      const collidingId = msg.id;
      // The collision: an inbound REQUEST reusing the SAME id as the
      // in-flight session/prompt, sent BEFORE the prompt's own response.
      process.stdout.write(encode({
        jsonrpc: "2.0",
        id: collidingId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { title: "Deploy where?" },
          options: [
            { optionId: "staging", name: "staging", kind: "allow_once" },
            { optionId: "prod", name: "prod", kind: "allow_once" },
          ],
        },
      }));
      const waitForRelease = () => {
        if (releasePath && fs.existsSync(releasePath)) {
          process.stdout.write(encode({ jsonrpc: "2.0", id: collidingId, result: { stopReason: "end_turn" } }));
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

test("a session/request_permission that reuses the in-flight session/prompt's id is still forwarded, not swallowed as the prompt's response", async () => {
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
      TG_CTL_ACP_PROMPT_TIMEOUT_MS: "60000",
      TMUX: "",
    },
    logFd,
  });
  closeSync(logFd);

  updates.push({
    update_id: 100,
    message: { message_id: 10, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 1, text: "/agent CollideSession first message" },
  });

  // The colliding permission request must still be forwarded to Telegram --
  // against the pre-fix (id-only) matcher it would be silently swallowed as
  // the prompt's own response instead, and no card ("Deploy where?", the
  // toolCall title) would ever appear among the sent messages (an earlier
  // routing-info message is expected too, so search rather than index [0]).
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    if (sentMessages.some((m) => JSON.stringify(m).includes("Deploy where?"))) break;
    await Bun.sleep(50);
  }
  const forwarded = sentMessages.find((m) => JSON.stringify(m).includes("Deploy where?"));
  expect(forwarded).toBeDefined();

  // This is a QUESTION-shaped ACP elicitation (no reject option), not merely
  // a permission approval. Prove the Telegram card carries the two choices,
  // tap "prod", and verify the selected option is written back to the SAME
  // ACP pipe before the outstanding session/prompt is released.
  const keyboard = (forwarded?.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined)
    ?.inline_keyboard ?? [];
  const prod = keyboard.flat().find((b) => b.text === "prod");
  expect(prod).toBeDefined();
  updates.push({
    update_id: 101,
    callback_query: {
      id: "cb-omp-question",
      from: { id: 1, first_name: "Alex" },
      message: { message_id: 77, chat: { id: 1 }, date: 3 },
      data: prod!.callback_data,
    },
  });
  const tTap = Date.now();
  while (Date.now() - tTap < 10_000) {
    if (readFileSync(acpLog, "utf8").includes('"optionId":"prod"')) break;
    await Bun.sleep(50);
  }
  expect(readFileSync(acpLog, "utf8")).toContain('"optionId":"prod"');

  // The queue must NOT have advanced: only one session/prompt frame exists,
  // and no eviction happened -- the turn is still correctly outstanding.
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(1);
  expect(readFileSync(join(cfgDir, "daemon.log"), "utf8")).not.toContain("omp-acp: evicted wedged client");

  // A second reply while the (still-open) permission decision is outstanding
  // must queue, not race a second frame into the pipe.
  updates.push({
    update_id: 102,
    message: { message_id: 11, from: { id: 1, first_name: "Alex" }, chat: { id: 1 }, date: 2, text: "/agent CollideSession second message" },
  });
  const t1 = Date.now();
  while (Date.now() - t1 < 10_000) {
    const daemonLog = existsSync(join(cfgDir, "daemon.log")) ? readFileSync(join(cfgDir, "daemon.log"), "utf8") : "";
    if (daemonLog.includes("omp-acp: session/prompt queued")) break;
    await Bun.sleep(50);
  }
  expect(readFileSync(join(cfgDir, "daemon.log"), "utf8")).toContain("omp-acp: session/prompt queued");
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(1);

  // Release the turn -- it must resolve normally (the REAL response, sent
  // with the same id after the collision) and flush the queued second
  // message through the SAME client.
  writeFileSync(releaseFile, "go");
  const t2 = Date.now();
  while (Date.now() - t2 < 10_000) {
    if (promptLinesIn(readFileSync(acpLog, "utf8")).length >= 2) break;
    await Bun.sleep(50);
  }
  expect(promptLinesIn(readFileSync(acpLog, "utf8")).length).toBe(2);

  const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  expect(spawns.length).toBe(1);
}, 25_000);
