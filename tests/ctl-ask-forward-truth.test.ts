// tg-cli#317: the asking side must report what the daemon actually did. Before this,
// a card the daemon POSTED (messageId in its own log) and then expired on its unscoped
// timer produced the same bare `null` as a request DROPPED at the door, and the client
// logged both as "ask-forward not-posted … daemon declined or unreachable" — the hatch
// helper forwarded that to the agent, which was told a card Alex could see in Telegram
// was never sent (2026-09-05, messageId=14880). The daemon now writes an interim status
// line before its final reply; the client reads it and says expired / dropped(reason) /
// timed-out / unreachable. These tests drive a private daemon with a 400ms unscoped
// timer against a mock Telegram and read the CLIENT's stderr (what the hook sees).

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Server, Subprocess } from 'bun';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir, trackChild } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const REGISTERED_CWD = '/registered/project';

const cfgDir = tempDir('tgctl-asktruth-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
// An UNSCOPED request (no paneId — the hatch helper's shape) matches a registration by cwd.
writeFileSync(
  join(cfgDir, 'tg-ctl.123.registration.json'),
  JSON.stringify({ paneId: '%9', cwd: REGISTERED_CWD }),
);
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      await Bun.sleep(100);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      return Response.json({ ok: true, result: { message_id: 4242 } });
    }
    if (url.pathname.endsWith('/editMessageText') || url.pathname.endsWith('/editMessageReplyMarkup')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const procs: Subprocess[] = [];
const extraServers: Server[] = [];
const daemonEnv = {
  PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
  HOME: cfgDir,
  TG_CTL_CONFIG_DIR: cfgDir,
  TG_API_BASE: `http://127.0.0.1:${server.port}`,
  TG_CTL_UNSCOPED_TIMEOUT_MS: '400', // the incident's 110s, shrunk so the expiry is observable
};

beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], { env: daemonEnv, stdio: ['ignore', logFd, logFd] }));
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
  for (const s of extraServers) s.stop(true);
  server.stop(true);
});

// Run one `tg-ctl ask` (the hook client) to completion and return what the hook sees.
async function askAndWait(payload: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(JSON.stringify(payload) + '\n');
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr };
}

const hatchRequest = (requestId: string, cwd: string) => ({
  requestId,
  agent: 'claude',
  kind: 'permission',
  question: 'Approve a one-time exception?',
  title: 'Hatch: no-long-inline-process',
  decisionLabels: { allow: 'Approve', deny: 'Deny' },
  cwd,
});

test('a posted card that expires is reported as EXPIRED with its messageId, never as not-posted', async () => {
  const { stdout, stderr } = await askAndWait(hatchRequest('hatch-posted-then-expired', REGISTERED_CWD));
  expect(stdout.trim()).toBe(''); // no decision → nothing for the harness
  expect(stderr).toContain('ask-forward expired: req=hatch-posted-then-expired');
  expect(stderr).toContain('messageId=4242');
  expect(stderr).toContain('posted to Telegram');
  expect(stderr).toMatch(/no decision within \d+ms \(daemon expiry/);
  expect(stderr).not.toContain('not-posted');
  expect(stderr).not.toContain('unreachable');
}, 15_000);

test('a request the daemon declines is reported as NOT-POSTED with the daemon reason', async () => {
  // requestId deliberately does NOT start with `hatch-`: tg-cli#333 (merged after this
  // branch was cut) exempts hatch-prefixed permissions from the registration gate, so a
  // hatch-shaped request here would skip straight to forward/expire instead of exercising
  // the not-registered drop this test is about.
  const { stdout, stderr } = await askAndWait(hatchRequest('plain-not-registered', '/some/unregistered/dir'));
  expect(stdout.trim()).toBe('');
  expect(stderr).toContain('ask-forward not-posted: req=plain-not-registered');
  expect(stderr).toContain('daemon declined: reason=not-registered');
  expect(stderr).not.toContain('posted to Telegram');
}, 15_000);

test('no daemon at all is reported as UNREACHABLE', async () => {
  const lonely = tempDir('tgctl-asktruth-nodaemon-');
  writeFileSync(join(lonely, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(lonely, 'config.yaml'), 'control:\n  enabled: true\n');
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: lonely, TG_CTL_CONFIG_DIR: lonely, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(JSON.stringify(hatchRequest('hatch-no-daemon', REGISTERED_CWD)) + '\n');
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain('ask-forward unreachable: req=hatch-no-daemon');
  expect(stderr).toContain('daemon socket closed or errored without a reply');
}, 15_000);

// tg-cli#355 residual: the multi-question failure summary used to say "declined, timed
// out, or partial" — ONE wording for three different realities, the exact conflation
// this ticket exists to eliminate (an agent reading it cannot tell a dead daemon from a
// slow human). The set that cannot complete now logs each question's OWN truthful
// outcome (via the same describeAskOutcome as the single-question path), and a question
// never reached because an earlier one failed says not-attempted instead of implying
// its own failure.
test('a multi-question set that cannot complete logs per-question outcomes, not one conflated line', async () => {
  const lonely = tempDir('tgctl-asktruth-multiq-');
  writeFileSync(join(lonely, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(lonely, 'config.yaml'), 'control:\n  enabled: true\n');
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: lonely, TG_CTL_CONFIG_DIR: lonely, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  // A RAW Claude Code multi-question hook payload. No TMUX_PANE in the env, so both
  // questions are UNSCOPED — single-attempt connects that fail fast with no daemon.
  proc.stdin.write(
    JSON.stringify({
      session_id: 'multiq-truth-1',
      cwd: REGISTERED_CWD,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { header: 'First', question: 'First question?', options: [{ label: 'One' }, { label: 'Two' }] },
          { header: 'Second', question: 'Second question?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    }) + '\n',
  );
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain('ask-forward multi-question not-completed');
  // The conflated trichotomy is gone.
  expect(stderr).not.toContain('declined, timed out, or partial');
  // The question that WAS attempted reports its real outcome (unreachable — no daemon).
  expect(stderr).toContain('ask-forward unreachable: req=');
  expect(stderr).toContain('daemon socket closed or errored without a reply');
  // The question never reached says so — it did not itself fail.
  expect(stderr).toContain('ask-forward not-attempted: req=');
  expect(stderr).toContain('an earlier question of the set did not complete');
}, 15_000);

// Review finding on the per-question loop: collectQuestionAnswers aborts at the FIRST
// unanswered question, so an EARLIER question may already hold a delivered human decision
// that the all-or-nothing rule discards. Running that attempt through describeAskOutcome
// (a no-usable-reply verdict) affirmatively LIED — "declined-after-post … no decision" —
// about a card the human DID answer. The answered question must log answered-discarded.
test('a multi-question set with Q1 answered and Q2 failed reports Q1 as answered-discarded, never as a failure', async () => {
  // Mock Telegram that AUTO-TAPS the FIRST card's first option (Q1 answered); the second
  // card gets no tap and expires on the shrunk unscoped timer (TG_CTL_UNSCOPED_TIMEOUT_MS
  // = 8000ms below — headroom for the auto-tap to land on Q1 on a loaded host, short enough
  // to keep the test inside its budget).
  const taps: Array<{ update_id: number; message_id: number; data: string }> = [];
  let nextMessageId = 500;
  let nextUpdateId = 900;
  const tapServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const tap = taps.shift();
        if (tap) {
          return Response.json({
            ok: true,
            result: [
              {
                update_id: tap.update_id,
                callback_query: {
                  id: `cb${tap.update_id}`,
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: tap.message_id, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: tap.data,
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        const messageId = nextMessageId++;
        // Only the FIRST card is auto-answered — the set must fail on the second.
        if (messageId === 500) {
          taps.push({ update_id: nextUpdateId++, message_id: messageId, data: body.reply_markup.inline_keyboard[0][0].callback_data });
        }
        return Response.json({ ok: true, result: { message_id: messageId } });
      }
      if (url.pathname.endsWith('/editMessageText') || url.pathname.endsWith('/editMessageReplyMarkup')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  extraServers.push(tapServer);
  const cfg = tempDir('tgctl-asktruth-mixed-');
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfg, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfg, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%9', cwd: REGISTERED_CWD }));
  mkdirSync(join(cfg, 'bin'));
  writeFileSync(join(cfg, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  // The host's real process table (live omp sessions) makes the daemon's discovery scan block
  // its poll loop for seconds, so the auto-tap would land after Q1's expiry. Agent-free `ps`.
  writeFileSync(join(cfg, 'bin', 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const logFd = openSync(join(cfg, 'daemon.log'), 'a');
  const daemon = trackChild(Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfg, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfg,
      TG_CTL_CONFIG_DIR: cfg,
      TG_API_BASE: `http://127.0.0.1:${tapServer.port}`,
      TG_CTL_UNSCOPED_TIMEOUT_MS: '8000', // headroom for the auto-tap to land on Q1; Q2 still expires
    },
    stdio: ['ignore', logFd, logFd],
  }));
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(cfg, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);

  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: cfg, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: `http://127.0.0.1:${tapServer.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(
    JSON.stringify({
      session_id: 'multiq-mixed-1',
      cwd: REGISTERED_CWD,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { header: 'First', question: 'Answered question?', options: [{ label: 'One' }, { label: 'Two' }] },
          { header: 'Second', question: 'Unanswered question?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    }) + '\n',
  );
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  daemon.kill(9);
  await daemon.exited;

  // No combined reply — the set did not complete.
  expect(stdout.trim()).toBe('');
  expect(stderr).toContain('ask-forward multi-question not-completed');
  // Q1: a delivered human decision, discarded by the all-or-nothing rule — NOT a failure.
  expect(stderr).toContain('ask-forward answered-discarded: req=');
  expect(stderr).toContain('the human answered this card');
  // The affirmative lie the review caught must be gone: Q1 must not be described as
  // declined/failed in any wording. (Q2's own truthful expiry line — "no decision
  // within Nms" — is EXPECTED and is not asserted against.)
  expect(stderr).not.toContain('declined-after-post');
  expect(stderr).not.toContain('ask-forward not-posted');
  expect(stderr).not.toContain('ask-forward unreachable');
  // Q2: its own truthful outcome (posted, then expired on the shrunk timer).
  expect(stderr).toContain('ask-forward expired: req=');
}, 25_000);

// A question whose ask never opened a socket (the set's shared budget was exhausted before
// it was sent) must never be logged as a daemon timeout — "no reply … within Nms" blames
// the daemon for a request it never received, the conflation tg-cli#355 targets. With a
// 1ms budget Q1 is either never sent (budget wording) or sent and refused (no daemon →
// unreachable) depending on scheduling; both are truthful. Q2 is never reached.
test('a set that cannot complete on an exhausted budget logs truthful lines, never a phantom daemon timeout', async () => {
  const lonely = tempDir('tgctl-asktruth-budget-');
  writeFileSync(join(lonely, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(lonely, 'config.yaml'), 'control:\n  enabled: true\n');
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: lonely,
      TG_CTL_CONFIG_DIR: lonely,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TG_CTL_ASK_TOTAL_TIMEOUT_MS: '1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(
    JSON.stringify({
      session_id: 'multiq-budget-1',
      cwd: REGISTERED_CWD,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { header: 'First', question: 'Budget question one?', options: [{ label: 'One' }, { label: 'Two' }] },
          { header: 'Second', question: 'Budget question two?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    }) + '\n',
  );
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain('ask-forward multi-question not-completed');
  expect(stderr).toMatch(
    /ask-forward (unreachable: req=\S+ .*daemon socket closed|not-attempted: req=\S+ .*time budget was exhausted before this request was sent)/,
  );
  expect(stderr).toContain('an earlier question of the set did not complete');
  // No question is blamed on a daemon timeout it never gave: with a 1ms budget a
  // never-sent or instantly-failed question must not read as a 1ms…115s daemon silence.
  expect(stderr).not.toContain('no reply and no status line from the daemon');
}, 25_000);
