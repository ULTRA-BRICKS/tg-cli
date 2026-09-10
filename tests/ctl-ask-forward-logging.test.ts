// Every ask-forward outcome must leave a distinct, greppable log line so a
// question that never reaches Telegram (it stays in the Claude Code harness) is
// VISIBLE instead of a silent socket.end("null"). Issue #65: an AskUserQuestion
// raised in a session whose pane/cwd didn't match the single registration was
// dropped with zero log signal. These tests assert each non-forward branch now
// emits its reason, and that the happy path still posts buttons.
//
// The daemon writes stderr (where log() lands) to daemon.log; we spawn `tg-ctl
// ask` per case against a mock Telegram (TG_API_BASE) and read that log back.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-askfwd-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
// Registration names a DIFFERENT cwd than the questions below send, so a request
// that carries no matching pane/cwd hits the not-registered branch by default.
writeFileSync(
  join(cfgDir, 'tg-ctl.123.registration.json'),
  JSON.stringify({ paneId: '%9', cwd: '/some/other/registered/dir' }),
);
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const sentMessages: { text: string }[] = [];

// A question whose text carries this marker makes the mock reject sendMessage —
// exercises the daemon's send-failed abandon branch deterministically.
const FAIL_MARKER = 'FORCE_SEND_FAILURE';

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      await Bun.sleep(100);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as { text: string };
      if (body.text.includes(FAIL_MARKER)) {
        return Response.json({ ok: false, description: 'forced failure' }, { status: 400 });
      }
      sentMessages.push(body);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

// Count posted messages whose text contains a substring (used to wait for an
// async fire-and-forget notice to actually land before asserting on counts).
function countSent(needle: string): number {
  return sentMessages.filter((m) => m.text.includes(needle)).length;
}

async function waitForSent(needle: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && countSent(needle) === 0) await Bun.sleep(25);
}

const logPath = join(cfgDir, 'daemon.log');
const procs: Subprocess[] = [];
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
  procs.push(daemon);
  closeSync(logFd);

  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
});

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  server.stop(true);
});

// Fire one `tg-ctl ask` with the given normalized request payload. A DROPPED
// (non-forward) request exits immediately; a SUCCESSFULLY forwarded scoped
// question blocks on the open socket waiting for a Telegram answer, so the
// returned handle lets a caller kill it. The daemon's log line lands in
// daemon.log regardless.
function ask(payload: Record<string, unknown>): Subprocess {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
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

test('not-registered question logs a distinct reason and posts nothing', async () => {
  const before = sentMessages.length;
  const proc = ask({
    requestId: 'q_notreg',
    cwd: '/Users/ultra/work/ext-test-projects', // does NOT match the registered cwd
    paneId: '%2', // does NOT match the registered pane %9
    agent: 'claude',
    kind: 'question',
    question: 'Origin wins, Keep local, or Merge both?',
    options: [{ label: 'Origin wins' }, { label: 'Keep local' }, { label: 'Merge both' }],
  });
  const log = await waitForLog('reason=not-registered');
  expect(log).toContain('ask-forward dropped: reason=not-registered');
  expect(log).toContain('req=q_notreg');
  expect(log).toContain('reg=pane=%9'); // names the registration it failed to match
  expect(sentMessages.length).toBe(before); // nothing posted to Telegram
  await proc.exited; // a dropped request returns immediately
});

test('hatch permission with unmatched pane/cwd is not dropped not-registered', async () => {
  // Non-tmux omp hatch: requestId hatch-*, kind permission, pane=-, cwd not in
  // the registration set. The #67 not-registered gate must not swallow it.
  const before = countSent('Allow hatch for no-long-inline-process');
  const proc = ask({
    requestId: 'hatch-no-long-inline-process-abc123def456',
    cwd: '/Users/ultra/xp/rig-cli',
    paneId: '-',
    agent: 'claude',
    kind: 'permission',
    question: 'Allow hatch for no-long-inline-process?',
  });
  const log = await waitForLog('ask-forward posted: agent=claude kind=permission req=hatch-no-long-inline-process-abc123def456');
  expect(log).not.toContain('reason=not-registered agent=claude kind=permission req=hatch-no-long-inline-process-abc123def456');
  expect(log).toContain('ask-forward posted: agent=claude kind=permission req=hatch-no-long-inline-process-abc123def456');
  expect(countSent('Allow hatch for no-long-inline-process')).toBe(before + 1);
  proc.kill(9);
  await proc.exited;
});

test('not-forwardable agent logs a distinct reason', async () => {
  const proc = ask({
    requestId: 'q_aider',
    cwd: '/some/other/registered/dir', // matches registration → passes the gate
    paneId: '%9',
    agent: 'aider', // capability is unsupported → not forwardable
    kind: 'question',
    question: 'pick one',
    options: [{ label: 'A' }],
  });
  const log = await waitForLog('reason=not-forwardable');
  expect(log).toContain('ask-forward dropped: reason=not-forwardable');
  expect(log).toContain('agent=aider');
  expect(log).toContain('req=q_aider');
  await proc.exited; // a dropped request returns immediately
  // This branch also fires a fire-and-forget "answer in the terminal" notice;
  // wait for it to land so its late arrival can't skew a later count assertion.
  await waitForSent('answer in the terminal');
});

test('an unrecognized --agent value warns on hook stderr and falls back to claude', async () => {
  // Pins hookAgentFromArgv's present-but-invalid branch: a typo'd kind must not
  // silently inherit claude semantics WITHOUT a signal — the warning lands on
  // the ask process's stderr (the hook installer's visible channel), and the
  // payload is still processed as the fallback kind.
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask', '--agent', 'opm'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write('{}\n');
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain("unrecognized --agent 'opm'");
  expect(stderr).toContain('falling back to claude');
  expect(stderr).toContain('agent=claude'); // the drop line confirms the fallback kind
});

test('an omp question is forwarded as buttons (ACP), never silently given claude hook semantics', async () => {
  const proc = ask({
    requestId: 'q_omp',
    cwd: '/some/other/registered/dir',
    paneId: '%9',
    agent: 'omp',
    kind: 'question',
    question: 'pick one',
    options: [{ label: 'A' }],
  });
  const log = await waitForLog('ask-forward posted: agent=omp');
  expect(log).toContain('ask-forward posted: agent=omp kind=question req=q_omp');
  expect(log).not.toContain('ask-forward dropped: reason=not-forwardable agent=omp');
  proc.kill(9);
  await proc.exited;
});

test('duplicate in-flight question logs a distinct reason', async () => {
  // First scoped question forwards and blocks (held pending). A second identical
  // one (same callback key) hits the duplicate-in-flight gate.
  const first = ask({
    requestId: 'q_dup',
    cwd: '/some/other/registered/dir',
    paneId: '%9',
    agent: 'claude',
    kind: 'question',
    question: 'duplicate?',
    options: [{ label: 'A' }],
  });
  await waitForLog('ask-forward posted: agent=claude kind=question req=q_dup');
  const second = ask({
    requestId: 'q_dup',
    cwd: '/some/other/registered/dir',
    paneId: '%9',
    agent: 'claude',
    kind: 'question',
    question: 'duplicate?',
    options: [{ label: 'A' }],
  });
  const log = await waitForLog('reason=duplicate-in-flight');
  expect(log).toContain('ask-forward dropped: reason=duplicate-in-flight');
  expect(log).toContain('req=q_dup');
  await second.exited; // the duplicate is dropped immediately
  first.kill(9);
  await first.exited;
});

test('send failure logs a distinct reason', async () => {
  const proc = ask({
    requestId: 'q_sendfail',
    cwd: '/some/other/registered/dir',
    paneId: '%9',
    agent: 'claude',
    kind: 'question',
    question: `deploy? ${FAIL_MARKER}`, // mock rejects sendMessage for this text
    options: [{ label: 'A' }],
  });
  const log = await waitForLog('reason=send-failed');
  expect(log).toContain('ask-forward dropped: reason=send-failed');
  expect(log).toContain('req=q_sendfail');
  await proc.exited; // abandon closes the socket → ask returns
});

test('happy-path forward logs arrived + posted and posts buttons', async () => {
  const before = countSent('Where should I deploy?');
  // A successfully forwarded SCOPED question blocks waiting for the Telegram
  // answer, so don't await exit — assert the posted log + the sent message, then
  // kill the still-pending hook process.
  const proc = ask({
    requestId: 'q_ok',
    cwd: '/some/other/registered/dir', // matches registration
    paneId: '%9',
    agent: 'claude',
    kind: 'question',
    question: 'Where should I deploy?',
    options: [{ label: 'Staging' }, { label: 'Production' }],
  });
  const log = await waitForLog('ask-forward posted: agent=claude kind=question req=q_ok');
  expect(log).toContain('ask-forward arrived: agent=claude kind=question req=q_ok');
  expect(log).toContain('ask-forward posted: agent=claude kind=question req=q_ok');
  expect(log).toContain('messageId=77');
  // Count by THIS question's text so an unrelated late notice can't skew it.
  expect(countSent('Where should I deploy?')).toBe(before + 1); // it DID post buttons
  proc.kill(9);
  await proc.exited;
});
