// Per-pane registration SET — END-TO-END (tg-cli#67).
//
// The bug this fixes: tg-ctl kept ONE global registration naming a single
// pane/cwd, so a question from any OTHER live session failed the forward gate
// and never reached Telegram. The CTO runs several sessions at once; this was a
// daily silent drop. These tests drive the REAL daemon (mock Telegram via
// TG_API_BASE) with TWO sessions registered concurrently and assert a question
// from EITHER pane forwards (posts buttons), scoped to the asking pane.
//
// Mirrors ctl-buttons-integration / ctl-ask-forward-logging: spawn `tg-ctl run`,
// fire `tg-ctl ask` per case, read posted messages back from the mock + the log.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import {
  awaitDetachedStartsSettled,
  createDaemonRegistry,
  reapDaemons,
  trackCfgDir,
  trackProc,
} from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-multisess-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const regPath = join(cfgDir, 'tg-ctl.123.registration.json');
// TWO sessions registered concurrently — the per-pane SET. Pane %2 = session A
// (this agent-tools session), pane %7 = session B (a second project).
writeFileSync(
  regPath,
  JSON.stringify([
    { paneId: '%2', cwd: '/Users/ultra/xp/agent-tools' },
    { paneId: '%7', cwd: '/Users/ultra/work/other-project' },
  ]),
);
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

const sentMessages: { text: string; reply_markup?: unknown }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      await Bun.sleep(100);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as { text: string; reply_markup?: unknown };
      sentMessages.push(body);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const logPath = join(cfgDir, 'daemon.log');
const reg = createDaemonRegistry();
// The cfgDir is tracked up front (with detachedStarts) so the scoped backstop
// settle-reaps the DETACHED `tg-ctl run` grandchildren that `tg-ctl start` spawns
// (issue #70) — `procs[]` only ever holds the `start` launcher, never its
// unref'd grandchild.
trackCfgDir(reg, cfgDir, { detachedStarts: true });
let daemon: Subprocess;

beforeAll(async () => {
  const logFd = openSync(logPath, 'a');
  daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  trackProc(reg, daemon);
  closeSync(logFd);
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
});

afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

function ask(payload: Record<string, unknown>): Subprocess {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  trackProc(reg, proc);
  proc.stdin.write(JSON.stringify(payload) + '\n');
  proc.stdin.end();
  return proc;
}

async function waitForLog(needle: string, timeoutMs = 5000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    if (txt.includes(needle)) return txt;
    await Bun.sleep(50);
  }
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

function sentFor(question: string): { text: string; reply_markup?: unknown } | undefined {
  return sentMessages.find((m) => m.text.includes(question));
}

// THE core assertion: a question from session A's pane forwards.
test('session A (%2) — question forwards and posts buttons', async () => {
  const proc = ask({
    requestId: 'q_A',
    paneId: '%2',
    cwd: '/Users/ultra/xp/agent-tools',
    agent: 'claude',
    kind: 'question',
    question: 'Deploy from session A?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  await waitForLog('ask-forward posted: agent=claude kind=question req=q_A');
  const msg = sentFor('Deploy from session A?');
  expect(msg).toBeDefined();
  expect((msg!.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toHaveLength(2);
  proc.kill(9);
  await proc.exited;
});

// THE fix: a question from the OTHER session's pane ALSO forwards — under the
// old single-registration model this dropped as reason=not-registered.
test('session B (%7) — question ALSO forwards (no silent drop)', async () => {
  const proc = ask({
    requestId: 'q_B',
    paneId: '%7',
    cwd: '/Users/ultra/work/other-project',
    agent: 'claude',
    kind: 'question',
    question: 'Deploy from session B?',
    options: [{ label: 'Ship' }, { label: 'Hold' }],
  });
  const log = await waitForLog('ask-forward posted: agent=claude kind=question req=q_B');
  // It was NOT dropped for this request.
  expect(log).not.toContain('reason=not-registered agent=claude kind=question req=q_B');
  const msg = sentFor('Deploy from session B?');
  expect(msg).toBeDefined();
  expect((msg!.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0][0].text).toBe('Ship');
  proc.kill(9);
  await proc.exited;
});

// A pane that is NOT in the set still fails closed (the gate didn't go wide-open).
test('an UNregistered pane still fails closed (reason=not-registered)', async () => {
  const proc = ask({
    requestId: 'q_unreg',
    paneId: '%99',
    cwd: '/nowhere',
    agent: 'claude',
    kind: 'question',
    question: 'From an unregistered pane?',
    options: [{ label: 'A' }],
  });
  const log = await waitForLog('reason=not-registered ' + 'agent=claude kind=question req=q_unreg');
  expect(log).toContain('reason=not-registered');
  expect(log).toContain('req=q_unreg');
  // The log line names BOTH registered entries (the set), not just one.
  expect(log).toContain('pane=%2');
  expect(log).toContain('pane=%7');
  expect(sentFor('From an unregistered pane?')).toBeUndefined();
  await proc.exited; // dropped → returns immediately
});

// Re-registering session A (a fresh `tg start` from pane %2) must NOT drop
// session B's entry — the whole point of the SET. After it, B still forwards.
test('re-registering one session via `tg-ctl start` keeps the other registered', async () => {
  const start = Bun.spawn([process.execPath, TG_CTL, 'start', '--pane', '%2', '--cwd', '/Users/ultra/xp/agent-tools'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  trackProc(reg, start);
  await start.exited;
  // Let the detached `run` grandchild reach (and lose) the flock while the main
  // daemon still holds it, so it can't survive a teardown that kills main first.
  await awaitDetachedStartsSettled(cfgDir, daemon.pid);

  // The on-disk store still has BOTH panes.
  const store = JSON.parse(readFileSync(regPath, 'utf8')) as { paneId?: string }[];
  const panes = store.map((e) => e.paneId).sort();
  expect(panes).toEqual(['%2', '%7']);

  // And session B's question still forwards after the re-register.
  const proc = ask({
    requestId: 'q_B2',
    paneId: '%7',
    cwd: '/Users/ultra/work/other-project',
    agent: 'claude',
    kind: 'question',
    question: 'B still works after A re-registered?',
    options: [{ label: 'Yes' }],
  });
  await waitForLog('ask-forward posted: agent=claude kind=question req=q_B2');
  expect(sentFor('B still works after A re-registered?')).toBeDefined();
  proc.kill(9);
  await proc.exited;
}, 15_000);

// Two NEW sessions starting CONCURRENTLY must both survive the upsert RMW — the
// registration lock (O_EXCL + PID-liveness) serializes the read-modify-write, so
// neither parallel `tg-ctl start` clobbers the other (the lost-update the lock
// exists to prevent).
test('two concurrent `tg-ctl start`s both land (lock serializes the upsert)', async () => {
  // Fresh store so this test owns the assertion (no leftover panes from above).
  writeFileSync(regPath, JSON.stringify([]));
  const startOne = (pane: string, cwd: string): Subprocess => {
    const p = Bun.spawn([process.execPath, TG_CTL, 'start', '--pane', pane, '--cwd', cwd], {
      env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    trackProc(reg, p);
    return p;
  };
  // Launch both without awaiting between them — they race the RMW.
  const a = startOne('%11', '/proj/a');
  const b = startOne('%12', '/proj/b');
  await Promise.all([a.exited, b.exited]);
  // Both detached grandchildren must lose the flock to the held main daemon
  // before teardown — otherwise one grabs it post-kill and leaks (issue #70).
  await awaitDetachedStartsSettled(cfgDir, daemon.pid);

  const store = JSON.parse(readFileSync(regPath, 'utf8')) as { paneId?: string }[];
  const panes = store.map((e) => e.paneId).sort();
  expect(panes).toEqual(['%11', '%12']); // BOTH survived — neither clobbered the other
}, 15_000);
