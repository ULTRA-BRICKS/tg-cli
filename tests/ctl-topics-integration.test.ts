import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// End-to-end forum-topics ROUTING (docs/specs/tg-forum-topics.md §8, increment 3 minus
// spawn): the real daemon, a fake Telegram server, and a fake tmux/ps reporting TWO claude
// panes — %1 (the flat/1:1 default target, pinned via registration) and %2 (a pre-seeded
// BOUND topic's pane). Every injected payload is logged as `<paneId>\t<text>` so a test can
// assert WHICH pane each message reached.
//
// The load-bearing guarantees under test:
//   1. With control.topics OFF, a plain (non-topic) message injects into the flat pane %1 —
//      1:1 routing is byte-identical (tg-ctl is the CTO's daily lifeline; this must not move).
//   2. With control.topics ON, a plain (General / no message_thread_id) message STILL injects
//      into the flat pane %1 — turning topics on does not change non-topic routing.
//   3. With control.topics ON, a message inside a BOUND topic injects into THAT topic's pane
//      (%2), never the flat target.
//   4. A topic whose bound pane is DEAD does NOT leak into the flat agent: the daemon posts an
//      error sendMessage carrying message_thread_id = T (outbound threading) and injects nothing.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

const FLAT_PANE = '%1'; // pinned as the registration target → the flat/1:1 default
const FLAT_PID = 4241;
const TOPIC_PANE = '%2'; // the bound topic's agent pane
const TOPIC_PID = 4242;

// A fake tmux reporting TWO claude-hosting panes and logging every send-keys -l payload as
// `<paneId>\t<text>` to $injectLog. The pane id is captured from the `-t %N` flag in the same
// invocation. load-buffer/paste-buffer (multi-line) is unused here (all test texts are single
// line) so it is logged verbatim without a pane prefix — never hit in these cases.
function fakeTmux(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${FLAT_PANE}' '${FLAT_PID}' 'claude' 'main' '${cwd}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${TOPIC_PANE}' '${TOPIC_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message)
    printf 'main\\n'
    ;;
  send-keys)
    # Capture the -t <pane> target and, if this is a literal (-l) injection, log '<pane>\\t<text>'.
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

// ps -axo pid=,ppid=,command= → both pane pids run claude, so findAgentInPane resolves both.
function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${FLAT_PID}' '1' 'claude'
printf '%s %s %s\\n' '${TOPIC_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(opts: { topics: boolean; seedTopics?: unknown[] | ((cfgDir: string) => unknown[]) }): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-topics-'));
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  topics: ${opts.topics}\n`);
  // registration pins %1 as the flat default target so discovery is deterministic.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: FLAT_PANE, cwd: cfgDir }),
  );
  if (opts.seedTopics) {
    const seeds = typeof opts.seedTopics === 'function' ? opts.seedTopics(cfgDir) : opts.seedTopics;
    writeFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify(seeds));
  }
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return cfgDir;
}

// Parsed inject log: { pane, text } per logged literal injection.
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

function topicsStore(cfgDir: string): Array<Record<string, unknown>> {
  const p = join(cfgDir, 'tg-ctl.123.topics.json');
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
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

// A scripted Telegram server: getUpdates drains updateQueue one batch at a time; sendMessage
// and setMessageReaction bodies are captured so the test can assert message_thread_id threading
// and delivery receipts.
function makeServer(updateQueue: unknown[][]): {
  server: ReturnType<typeof Bun.serve>;
  sends: Array<Record<string, unknown>>;
  reactions: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const reactions: Array<Record<string, unknown>> = [];
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
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, sends, reactions };
}

function plainMsg(messageId: number, text: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text },
  };
}

function topicMsg(messageId: number, threadId: number, text: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      text,
      message_thread_id: threadId,
      is_topic_message: true,
    },
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

test('topics OFF: a plain (non-topic) message injects into the flat %1 pane — 1:1 routing unchanged', async () => {
  const cfgDir = makeCfgDir({ topics: false });
  const updateQueue: unknown[][] = [];
  const { server, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([plainMsg(10, 'flat hello', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(FLAT_PANE);
  expect(landed[0].text).toContain('flat hello');
  // No topic store is ever written with the flag off.
  expect(existsSync(join(cfgDir, 'tg-ctl.123.topics.json'))).toBe(false);
  // It still earns its 👀 delivery receipt.
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 10 });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a plain (General / no thread) message STILL injects into the flat %1 pane', async () => {
  // Seed a bound topic on %2 to prove the General message is NOT mis-attracted to it.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([plainMsg(11, 'general msg', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(FLAT_PANE); // flat, NOT the topic pane %2
  expect(landed[0].text).toContain('general msg');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a message in a BOUND topic injects into THAT topic pane (%2), not the flat target', async () => {
  // The binding records the same path the fake tmux reports for %2 (cfgDir), so the pane-reuse
  // guard (path-match) passes and the message routes.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: (dir) => [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, path: dir, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(12, 50, 'deploy now', nowSec)]);

  await waitFor(() => injected(cfgDir).length >= 1);
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(TOPIC_PANE); // routed to the topic's pane, NOT %1
  expect(landed[0].text).toContain('deploy now');
  expect(landed[0].text).toContain('[TG from Alex'); // wrapped like a normal inbound
  // Its 👀 receipt targets the source message inside the topic.
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 12 });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: daemon slash commands in a BOUND topic reply inside that topic, not General', async () => {
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: (dir) => [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, path: dir, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(16, 50, '/status', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text ?? '').includes('tg-ctl: running')));
  expect(injected(cfgDir)).toEqual([]);
  const statusReplies = sends.filter((s) => String(s.text ?? '').includes('tg-ctl: running'));
  expect(statusReplies.length).toBeGreaterThan(0);
  expect(statusReplies.every((s) => s.message_thread_id === 50)).toBe(true);
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 16 });

  updateQueue.push([topicMsg(17, 50, '/limit codex', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text ?? '').includes('No recent limit telemetry for codex')));
  expect(injected(cfgDir)).toEqual([]);
  const limitReplies = sends.filter((s) => String(s.text ?? '').includes('No recent limit telemetry for codex'));
  expect(limitReplies.length).toBeGreaterThan(0);
  expect(limitReplies.every((s) => s.message_thread_id === 50)).toBe(true);
  await waitFor(() => reactions.length >= 2);
  expect(reactions.at(-1)).toMatchObject({ message_id: 17 });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a REUSED pane (binding path != live pane path) does NOT leak — message refused, binding NOT closed', async () => {
  // The bound pane %2 still hosts an agent in the fake tmux, but its path is cfgDir while the
  // binding recorded a DIFFERENT project path. tmux reuses pane ids after kill-pane, so this
  // models another project's agent inheriting %2. The path-match guard must refuse to inject (no
  // leak into the stranger). It must NOT close the binding — a path mismatch can also be a
  // transient empty-path read or a legit `cd`, so closing would irreversibly kill a live topic.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, path: '/some/other/project', ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(17, 50, 'deploy now', nowSec)]);

  await waitFor(() => sends.length >= 1);
  expect(injected(cfgDir)).toEqual([]); // refused — NOT injected into %2 (the reused stranger) NOR %1
  expect(sends[0].message_thread_id).toBe(50); // notice threaded into the topic
  await Bun.sleep(300);
  // The binding is left BOUND (recoverable) — a transient/cd self-heals on the next message; a
  // true reuse keeps failing the same harmless way. NOT irreversibly closed.
  expect(topicsStore(cfgDir).find((t) => t.threadId === 50)?.status).toBe('bound');
  expect(reactions).toEqual([]); // a refused route earns no 👀

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a BOUND topic whose pane is DEAD does NOT leak to the flat agent — error posted with message_thread_id, binding closed', async () => {
  // %9 is not in the fake tmux pane list → the bound pane is gone.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: '%9', ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server, sends, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(13, 50, 'are you there?', nowSec)]);

  // The daemon posts an error into the topic — wait for that sendMessage.
  await waitFor(() => sends.length >= 1);
  // CRITICAL safety: nothing was injected anywhere (no leak into the flat %1 agent).
  expect(injected(cfgDir)).toEqual([]);
  // The replies are threaded into the topic (message_thread_id = T), not General. The restart flow
  // (no path/model seed) posts the path prompt AND an "exited — set it up again" notice into T.
  await waitFor(() => sends.some((s) => s.message_thread_id === 50 && String(s.text).includes('exited')));
  const exitedReplies = sends.filter((s) => String(s.text).includes('exited'));
  expect(exitedReplies.length).toBeGreaterThan(0);
  expect(exitedReplies.every((s) => s.message_thread_id === 50)).toBe(true);
  // The dead binding flips to closed, then increment 4 recovers: this seed has NO path/model, so
  // the entrypoint restarts the /new flow (back to awaiting-path) rather than a one-tap re-spawn —
  // the human is never left at a dead-end. (A seed WITH path+model would offer a Re-spawn button;
  // see the dedicated re-spawn test below.)
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 50 && t.status === 'awaiting-path'));
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 50);
  expect(binding?.status).toBe('awaiting-path');
  // A FAILED route earns NO 👀 receipt — the trailing ack reads the route's false verdict
  // (lastActionOk), so a dead-pane message must not also be marked "seen by the agent". Give
  // the ack a beat to run after the error sendMessage, then assert no reaction was set.
  await Bun.sleep(300);
  expect(reactions).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a message in an UNTRACKED topic (no binding) is ACK-only — never leaks to the flat agent', async () => {
  // The COMMON case at topics:true before the spawn executor lands: a topic with no binding
  // (topic-new is a logged no-op, so topicStatusOf → null). stepUpdates ACKs it and emits NO
  // route, so nothing reaches the flat %1 agent. This is the headline safety guarantee.
  const cfgDir = makeCfgDir({ topics: true }); // no seeded bindings
  const updateQueue: unknown[][] = [];
  const { server, reactions } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(15, 77, 'hello untracked topic', nowSec)]);

  // It gets a 👀 (ack-only) — wait for that, then assert nothing was injected anywhere.
  await waitFor(() => reactions.length >= 1);
  expect(reactions.at(-1)).toMatchObject({ message_id: 15 });
  await Bun.sleep(200);
  expect(injected(cfgDir)).toEqual([]); // NOT in %1, NOT in %2 — nowhere

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: forum_topic_reopened on a tracked closed topic resumes the /new flow (markReopened)', async () => {
  // A closed topic that already knows its path → reopen drops to awaiting-model (re-pick model
  // → increment 2 re-spawns), and the old pane is dropped. Mirrors the close test for symmetry.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'closed', path: '/w', model: 'claude-opus', paneId: TOPIC_PANE, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 16,
      message: {
        message_id: 16,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        message_thread_id: 50,
        forum_topic_reopened: {},
      },
    },
  ]);

  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 50 && t.status === 'awaiting-model'));
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 50);
  expect(binding?.status).toBe('awaiting-model'); // path known → re-pick model
  expect(binding?.paneId).toBeUndefined(); // old pane dropped on reopen
  expect(injected(cfgDir)).toEqual([]); // a service message never reaches an agent

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: forum_topic_closed on a tracked topic persists status=closed (lifecycle wiring)', async () => {
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 14,
      message: {
        message_id: 14,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        message_thread_id: 50,
        forum_topic_closed: {},
      },
    },
  ]);

  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 50 && t.status === 'closed'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 50)?.status).toBe('closed');
  // Nothing injected — a service message never reaches an agent.
  expect(injected(cfgDir)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: `/agent <gone>` inside a BOUND topic does NOT fall back to the flat last-user-target anchor', async () => {
  // The flat 1:1 anchor points at %1 (an earlier flat conversation), but the CTO
  // is typing inside topic 50, bound to %2 — a DIFFERENT project's pane. The flat
  // anchor must never override the topic's own (stronger, deliberately chosen)
  // routing signal; see tg-ctl's handleAgentRoute gone-agent fallback comment.
  const cfgDir = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 50, name: 'api', status: 'bound', paneId: TOPIC_PANE, ts: 1 }],
  });
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.last-user-target.json'),
    JSON.stringify({ paneId: FLAT_PANE, cwd: cfgDir, ts: Math.floor(Date.now() / 1000) }),
  );
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicMsg(18, 50, '/agent ghost do this', nowSec)]);

  await waitFor(() => sends.some((s) => String(s.text ?? '').includes("no agent matching 'ghost'")));
  // Never injected into the flat anchor pane (%1) — the topic guard held.
  expect(injected(cfgDir).some((l) => l.pane === FLAT_PANE)).toBe(false);
  expect(injected(cfgDir)).toEqual([]);
  const errorReplies = sends.filter((s) => String(s.text ?? '').includes("no agent matching 'ghost'"));
  expect(errorReplies.every((s) => s.message_thread_id === 50)).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);
