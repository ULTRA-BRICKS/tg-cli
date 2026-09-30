import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Startup crash-orphan reconcile (reconcileTopicsOnStartup in tg-ctl), end to end: the real daemon,
// a fake Telegram server, and a fake tmux/ps. The flat `/new` private-topic spawn persists
// awaiting-model + spawnPending + spawnToken → `tmux new-window` → `bound`. A crash between the
// new-window and the `bound` write leaves a live orphan pane; on startup the daemon must ADOPT it
// (never a second spawn) only when it can PROVE the pane is the one it launched (recorded paneId, or
// an unambiguous @tg_spawn_token match in the topic-slug window with the same cwd). A `bound` binding
// whose pane vanished while the daemon was down is marked closed. Nothing here ever spawns.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

type Row = Record<string, unknown>;

// One tab-separated list-panes row in the 8-field PANE_FORMAT:
// session, window_index, pane_id, pane_pid, command, window_name, @tg_spawn_token, pane_current_path.
interface PaneRow {
  paneId: string;
  pid: number;
  window: string;
  token: string;
  cwd: string;
}

// A fake tmux whose list-panes reports the flat pane %1 plus `panes`. new-window is LOGGED to
// $spawnLog so a test can assert reconcile never spawns.
function fakeTmux(cwd: string, panes: PaneRow[], spawnLog: string): string {
  const row = (p: PaneRow): string =>
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${p.paneId}' '${p.pid}' 'claude' '${p.window}' '${p.token}' '${p.cwd}'`;
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
${panes.map(row).join('\n')}
    ;;
  display-message) printf 'main\\n' ;;
  new-window) printf 'new-window %s\\n' "$*" >> '${spawnLog}'; printf '%s\\n' '%99' ;;
esac
exit 0
`;
}

function fakePs(pids: number[]): string {
  const lines = pids.map((p) => `printf '%s %s %s\\n' '${p}' '1' 'claude'`).join('\n');
  return `#!/bin/sh\n${lines}\nexit 0\n`;
}

// A Telegram server that never delivers an update — reconcile runs purely off the seeded store.
// The daemon reconciles synchronously BEFORE its poll loop, so the first getUpdates is the
// deterministic "reconcile is done" signal (`polled`).
function makeServer(): { port: number; polled: () => boolean } {
  let polled = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        polled = true;
        // Simulated long-poll latency so the idle daemon doesn't spin on empty batches.
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  return { port: server.port, polled: () => polled };
}

interface Scenario {
  topics?: boolean;
  seed: Row[];
  // Build the extra panes once cfgDir (the default project cwd) is known.
  panes: (cfgDir: string) => PaneRow[];
  pids: number[];
}

interface Started {
  cfgDir: string;
  daemon: Subprocess;
  store: () => Row[];
  binding: (threadId: number) => Row | undefined;
  spawnLog: string;
  // Resolves once startup reconcile has finished (the daemon entered its poll loop).
  reconciled: () => Promise<void>;
}

async function startWith(s: Scenario): Promise<Started> {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-reconcile-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  topics: ${s.topics ?? true}\n`);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  const seed = s.seed.map((r) => (r.path === '$CFG' ? { ...r, path: cfgDir } : r));
  writeFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify(seed));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, s.panes(cfgDir), spawnLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(s.pids), { mode: 0o755 });
  const server = makeServer();
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    logFd,
  });
  closeSync(logFd);
  const store = (): Row[] => {
    try {
      return JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')) as Row[];
    } catch {
      return [];
    }
  };
  return {
    cfgDir,
    daemon,
    store,
    binding: (id) => store().find((b) => b.threadId === id),
    spawnLog,
    reconciled: () => waitFor(server.polled),
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

async function stop(d: Subprocess): Promise<void> {
  d.kill('SIGTERM');
  await d.exited;
}

// The crash-gap binding: awaiting-model + path + model + spawnPending + spawnToken.
const pending = (threadId: number, name: string, token: string, extra: Row = {}): Row => ({
  threadId,
  name,
  status: 'awaiting-model',
  path: '$CFG',
  model: 'claude-opus',
  spawnPending: true,
  spawnToken: token,
  ts: 1,
  ...extra,
});

const pane = (paneId: string, pid: number, window: string, token: string, cwd: string): PaneRow => ({ paneId, pid, window, token, cwd });

test('a spawnPending orphan in its slug window with the matching token is RE-BOUND on startup — no second spawn', async () => {
  const r = await startWith({
    seed: [pending(113, 'orphan', '113-1-1')],
    panes: (cwd) => [pane('%5', 4299, 'orphan', '113-1-1', cwd)],
    pids: [4241, 4299],
  });
  await r.reconciled();
  expect(r.binding(113)?.status).toBe('bound');
  expect(r.binding(113)?.paneId).toBe('%5');
  expect(r.binding(113)?.spawnPending).toBeUndefined(); // markBound drops the crash-gap marker
  expect(existsSync(r.spawnLog)).toBe(false); // adopted, never re-spawned
  await stop(r.daemon);
}, 30_000);

test('a BOUND binding whose pane vanished while down is marked CLOSED on startup', async () => {
  const r = await startWith({
    seed: [{ threadId: 114, name: 'gone', status: 'bound', paneId: '%9', path: '/w', model: 'claude-opus', ts: 1 }],
    panes: () => [],
    pids: [4241],
  });
  await r.reconciled();
  expect(r.binding(114)?.status).toBe('closed');
  expect(existsSync(r.spawnLog)).toBe(false);
  await stop(r.daemon);
}, 30_000);

test('topics OFF — startup reconcile is a no-op (a stale bound binding is left untouched)', async () => {
  const r = await startWith({
    topics: false,
    seed: [{ threadId: 115, name: 'off', status: 'bound', paneId: '%9', path: '/w', model: 'claude-opus', ts: 1 }],
    panes: () => [],
    pids: [4241],
  });
  await r.reconciled();
  expect(r.binding(115)?.status).toBe('bound');
  await stop(r.daemon);
}, 30_000);

test('a flaky empty-procs read does NOT falsely close a bound binding', async () => {
  // Panes list fine but `ps` returns nothing → zero live agents. Reconcile must skip, not mass-close.
  const r = await startWith({
    seed: [{ threadId: 121, name: 'flake', status: 'bound', paneId: '%5', path: '$CFG', model: 'claude-opus', ts: 1 }],
    panes: (cwd) => [pane('%5', 4299, 'flake', '', cwd)],
    pids: [],
  });
  await r.reconciled();
  expect(r.binding(121)?.status).toBe('bound');
  await stop(r.daemon);
}, 30_000);

test('two same-slug orphan bindings with the same token do NOT both adopt the one pane', async () => {
  const r = await startWith({
    seed: [pending(122, 'dup', '122-1-1'), pending(123, 'dup', '122-1-1')],
    panes: (cwd) => [pane('%6', 4299, 'dup', '122-1-1', cwd)],
    pids: [4241, 4299],
  });
  const boundOn6 = (): Row[] => r.store().filter((b) => b.status === 'bound' && b.paneId === '%6');
  await r.reconciled();
  expect(boundOn6()).toHaveLength(1);
  await stop(r.daemon);
}, 30_000);

test('a same-slug window with the matching token but a DIFFERENT project dir is NOT adopted', async () => {
  const r = await startWith({
    seed: [pending(131, 'proj', '131-1-1')],
    panes: () => [pane('%7', 4299, 'proj', '131-1-1', '/other')],
    pids: [4241, 4299],
  });
  await r.reconciled();
  expect(r.binding(131)?.status).toBe('awaiting-model');
  expect(r.binding(131)?.paneId).toBeUndefined();
  await stop(r.daemon);
}, 30_000);

test('a CLOSED topic is never resurrected by a live same-slug agent', async () => {
  const r = await startWith({
    seed: [{ threadId: 140, name: 'keep', status: 'closed', path: '$CFG', model: 'claude-opus', paneId: '%8', ts: 1 }],
    panes: (cwd) => [pane('%8', 4299, 'keep', '', cwd)],
    pids: [4241, 4299],
  });
  await r.reconciled();
  expect(r.binding(140)?.status).toBe('closed');
  await stop(r.daemon);
}, 30_000);

test('awaiting-model WITHOUT spawnPending (no model chosen, or a failed spawn) is never bound to a same-slug stranger', async () => {
  const r = await startWith({
    seed: [
      { threadId: 160, name: 'nm', status: 'awaiting-model', path: '$CFG', ts: 1 },
      { threadId: 200, name: 'failadopt', status: 'awaiting-model', path: '$CFG', model: 'claude-opus', ts: 1 },
    ],
    panes: (cwd) => [pane('%5', 4299, 'nm', '', cwd), pane('%6', 4300, 'failadopt', '', cwd)],
    pids: [4241, 4299, 4300],
  });
  await r.reconciled();
  expect(r.store().filter((b) => b.status === 'bound')).toEqual([]);
  await stop(r.daemon);
}, 30_000);

test('a stale path-mismatched bound claim on a reused pane does NOT block a real orphan from adopting it', async () => {
  // b1 recorded %5 + /OTHER, but tmux reused %5 for the orphan in cfgDir with b2's token.
  const r = await startWith({
    seed: [
      { threadId: 210, name: 'b1', status: 'bound', paneId: '%5', path: '/OTHER', model: 'claude-opus', ts: 1 },
      pending(211, 'dup', '211-1-1'),
    ],
    panes: (cwd) => [pane('%5', 4299, 'dup', '211-1-1', cwd)],
    pids: [4241, 4299],
  });
  await r.reconciled();
  expect(r.binding(211)?.status).toBe('bound');
  expect(r.binding(211)?.paneId).toBe('%5');
  // b1's live pane only mismatches its path — reconcile never closes on that (routing guards the leak).
  expect(r.binding(210)?.status).toBe('bound');
  await stop(r.daemon);
}, 30_000);

test('a spawnPending orphan whose window LACKS the matching token (and no recorded paneId) is NOT adopted', async () => {
  const r = await startWith({
    seed: [pending(240, 'notok', 'EXPECTED')],
    panes: (cwd) => [pane('%5', 4299, 'notok', '', cwd)],
    pids: [4241, 4299],
  });
  await r.reconciled();
  expect(r.binding(240)?.status).toBe('awaiting-model');
  expect(r.binding(240)?.paneId).toBeUndefined();
  await stop(r.daemon);
}, 30_000);

test('a recorded paneId adopts the orphan even when the token stamp never landed', async () => {
  const r = await startWith({
    seed: [pending(260, 'paneid', '260-1-1', { paneId: '%5' })],
    panes: (cwd) => [pane('%5', 4299, 'paneid', '', cwd)],
    pids: [4241, 4299],
  });
  await r.reconciled();
  expect(r.binding(260)?.status).toBe('bound');
  expect(r.binding(260)?.paneId).toBe('%5');
  await stop(r.daemon);
}, 30_000);

test('a multi-pane slug window sharing the token is ambiguous without a recorded paneId — not adopted', async () => {
  const r = await startWith({
    seed: [pending(400, 'multi', '400-1-1')],
    panes: (cwd) => [pane('%5', 4299, 'multi', '400-1-1', cwd), pane('%6', 4300, 'multi', '400-1-1', cwd)],
    pids: [4241, 4299, 4300],
  });
  await r.reconciled();
  expect(r.binding(400)?.status).toBe('awaiting-model');
  await stop(r.daemon);
}, 30_000);

test('a multi-pane slug window sharing the token adopts the EXACT recorded paneId', async () => {
  const r = await startWith({
    seed: [pending(401, 'multi', '401-1-1', { paneId: '%6' })],
    panes: (cwd) => [pane('%5', 4299, 'multi', '401-1-1', cwd), pane('%6', 4300, 'multi', '401-1-1', cwd)],
    pids: [4241, 4299, 4300],
  });
  await r.reconciled();
  expect(r.binding(401)?.status).toBe('bound');
  expect(r.binding(401)?.paneId).toBe('%6');
  await stop(r.daemon);
}, 30_000);
