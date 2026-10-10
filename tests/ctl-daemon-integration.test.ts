import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { NO_AGENT_REPLY } from '../tg-ctl';
import { withClaudeHooks, withClaudeStatusLineTelemetry, withHarnessHooks } from '../features/tg-ctl/hook-install';

// Full daemon round-trip against a local Bot-API fake (spec §11: "the daemon
// is spawned as a real subprocess against the fake"). tmux is PATH-shimmed to
// an argv-logging stub that prints an EMPTY pane list, so (1) the user's real
// tmux server is never touched and (2) every inject degrades to the no-agent
// guard reply — capturable via the fake's sendMessage endpoint.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const nowSec = Math.floor(Date.now() / 1000);

// Scripted updates, served at-most-once via the offset param:
// 100 → allowed sender, plain text  → inject attempt → no-agent guard reply
// 101 → /status                     → status reply containing "running"
// 102 → OLD owner message (#183)    → still delivered → no-agent guard reply
// 103 → DISALLOWED sender           → no reply, but the offset must still advance
// 104 → photo from allowed sender   → getFile + download, then no-agent reply
const QUEUE = [
  { update_id: 100, message: { message_id: 1, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'hello agent' } },
  { update_id: 101, message: { message_id: 2, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: '/status' } },
  { update_id: 102, message: { message_id: 3, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec - 9000, text: 'old news' } },
  { update_id: 103, message: { message_id: 4, from: { id: 999, first_name: 'Mallory' }, chat: { id: 1 }, date: nowSec, text: 'evil command' } },
  {
    update_id: 104,
    message: {
      message_id: 5,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      caption: 'pic',
      // Size-ascending renditions — the daemon must pick the largest.
      photo: [
        { file_id: 'photo-small', file_size: 100 },
        { file_id: 'photo-big', file_size: 5000 },
      ],
    },
  },
];

const offsets: number[] = []; // every offset getUpdates was called with
const sent: { chat_id: number; text: string }[] = []; // sendMessage bodies
const reactions: { chat_id: number; message_id: number; reaction: { type: string; emoji: string }[] }[] = [];
let serveCount = 0; // how many times the queue was (re-)delivered
let fetchedFileId: string | null = null;

let setMyCommandsHits = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/setMyCommands')) {
      // Startup self-provisions the command menu (issue #68) — acknowledge so it
      // doesn't 404-log; the dedicated payload assertions live in
      // ctl-setmycommands-integration.test.ts.
      setMyCommandsHits += 1;
      await req.json();
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      offsets.push(offset);
      const pending = QUEUE.filter((u) => u.update_id >= offset);
      if (pending.length) {
        serveCount += 1;
        return Response.json({ ok: true, result: pending });
      }
      await Bun.sleep(1500); // pace the loop like the real long-poll
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as { chat_id: number; text: string });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push((await req.json()) as (typeof reactions)[number]);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/getFile')) {
      fetchedFileId = url.searchParams.get('file_id');
      return Response.json({ ok: true, result: { file_path: 'photos/big.jpg' } });
    }
    if (url.pathname.startsWith('/file/bot')) {
      return new Response('JPEGDATA');
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-daemon-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const pidFile = join(cfgDir, 'tg-ctl.123.pid');
const statusProject = mkdtempSync(join(tmpdir(), 'tgctl-status-project-'));

// tmux PATH shim: log argv, print NOTHING — parsePaneList('') = no panes, so
// discovery yields no-agent and the daemon must answer with the guard text.
const shimDir = join(cfgDir, 'bin');
const shimLog = join(cfgDir, 'tmux-calls.log');
mkdirSync(shimDir);
writeFileSync(join(shimDir, 'tmux'), `#!/bin/sh\necho "$@" >> '${shimLog}'\nexit 0\n`, { mode: 0o755 });
// ps PATH shim: the legacy 3-column `pid ppid command` shape regardless of argv, with no
// agent process on the fake table (only launchd) — the process-table scan for agents
// OUTSIDE tmux (tg-cli#306) always runs now (tg-cli#413 follow-up removed the
// empty-tty-map short-circuit) but still lists nothing here because there is nothing to
// match, not because the scan was skipped — otherwise the guard text would enumerate
// whatever interactive claude/codex sessions happen to run on the developer's machine,
// and (a) below would not be hermetic.
writeFileSync(join(shimDir, 'ps'), `#!/bin/sh\nprintf '    1     0 /sbin/launchd\\n'\nexit 0\n`, { mode: 0o755 });
// launchctl PATH shim: an empty job list. `/status` probes launchd for an external supervisor
// (macOS), which otherwise runs `launchctl print` once per loaded host job — hundreds of spawns
// that made the reply take seconds and the round-trip miss its wait on a busy developer machine.
writeFileSync(join(shimDir, 'launchctl'), `#!/bin/sh\n[ "$1" = list ] && printf 'PID\\tStatus\\tLabel\\n'\nexit 0\n`, { mode: 0o755 });

const reg = createDaemonRegistry();

afterAll(async () => {
  // Snapshot tracked pids before reapDaemons drains the registry, so the
  // post-teardown "nothing survived" assertion still has them.
  const pids = reg.procs.map((p) => p.pid);
  await reapDaemons(reg);
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
  server.stop(true);
});

test('daemon round-trip: old owner message still delivered, guard replies, /status, allowlist drop, media download', async () => {
  mkdirSync(join(cfgDir, '.claude'), { recursive: true });
  const hooks = withClaudeHooks({}, 'tg-ctl ask');
  const harness = withHarnessHooks(hooks.settings, 'tg-ctl harness-event');
  const telemetry = withClaudeStatusLineTelemetry(harness.settings, 'tg-ctl harness-event --agent claude');
  writeFileSync(join(cfgDir, '.claude', 'settings.json'), `${JSON.stringify(telemetry.settings)}\n`);

  mkdirSync(join(statusProject, '.claude'), { recursive: true });
  writeFileSync(
    join(statusProject, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`,
  );
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    `${JSON.stringify([{ paneId: '%2', cwd: statusProject, registeredAt: nowSec }])}\n`,
  );

  // Daemon stderr goes to a file, not a pipe — post-mortem readable, can't block.
  // spawnDaemon tracks the proc + cfgDir BEFORE waiting on the socket, so a
  // missing socket can never leak the spawned daemon.
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir, // media lands under $HOME/.cache/tg-cli/inbound
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    logFd,
  });
  closeSync(logFd);

  // Wait until the whole batch is processed: 4 sends captured AND the next
  // getUpdates confirmed offset 105 (max update_id + 1). The bound is only a
  // backstop well inside the test timeout — the loop exits on the events.
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    if (sent.length >= 4 && reactions.length >= 1 && offsets.includes(105)) break;
    await Bun.sleep(50);
  }

  // The batch's actions are dispatched concurrently (tg-cli#357) and discovery is awaited
  // (tg-cli#547), so the replies to different messages can arrive in any order.
  // (b) /status → composed status names THIS daemon as running.
  const status = sent.find((m) => m.text.startsWith('tg-ctl: running'))?.text;
  expect(status).toContain(`tg-ctl: running (pid ${daemon.pid})`);
  expect(status).toContain('offset: 105');
  expect(status).toContain('usage telemetry: shadowed by');
  expect(status).toContain(join(statusProject, '.claude', 'settings.json'));
  // (a) prompt from allowed sender → inject attempted → no panes → guard reply.
  // (c) OLD owner message (#183) is NOT dropped by age — it is delivered like any
  // other, degrading to the no-agent guard here (no "skipped N stale" notice).
  // (e) photo → downloaded, then the inject for it degrades to the guard too.
  expect(sent.filter((m) => m.text === NO_AGENT_REPLY)).toHaveLength(3);
  expect(sent).toHaveLength(4);
  expect(sent.some((m) => m.text.includes('skipped'))).toBe(false);
  for (const m of sent) expect(m.chat_id).toBe(1);

  // (d) disallowed sender: nothing echoed anywhere, yet the offset advanced —
  // the queue was served exactly ONCE and the next poll confirmed past it.
  expect(sent.some((m) => m.text.includes('evil'))).toBe(false);
  expect(offsets[0]).toBe(0); // no offset file yet on first poll
  expect(offsets).toContain(105);
  expect(serveCount).toBe(1);
  expect(readFileSync(join(cfgDir, 'tg-ctl.123.offset'), 'utf8').trim()).toBe('105');

  // Media: largest rendition resolved via getFile, bytes written under the
  // daemon-chosen name <update_id>.jpg (never the Telegram basename).
  expect(fetchedFileId).toBe('photo-big');
  const saved = join(cfgDir, '.cache', 'tg-cli', 'inbound', '104.jpg');
  expect(readFileSync(saved, 'utf8')).toBe('JPEGDATA');

  // Delivery receipts (👀): ONLY the handled /status message gets one. The
  // failed injects (no agent pane → guard reply) must NOT be acknowledged —
  // the error reply is the failure signal; a 👀 would claim delivery.
  expect(reactions).toEqual([
    { chat_id: 1, message_id: 2, reaction: [{ type: 'emoji', emoji: '👀' }] },
  ]);

  // The PATH shim actually intercepted discovery — without this the test
  // could pass by accident while talking to a real tmux server.
  expect(readFileSync(shimLog, 'utf8')).toContain('list-panes');

  // Startup self-provisioned the command menu exactly once (issue #68).
  expect(setMyCommandsHits).toBe(1);

  // Clean shutdown.
  daemon.kill('SIGTERM');
  const exited = await Promise.race([
    daemon.exited,
    Bun.sleep(4000).then(() => 'timeout' as const),
  ]);
  expect(exited).not.toBe('timeout');
  expect(daemon.exitCode).toBe(0);
  expect(existsSync(pidFile)).toBe(false);
}, 60_000);
