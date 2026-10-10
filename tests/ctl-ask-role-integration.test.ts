// docs/specs/agent-role-model.md §4.2, end to end: the REAL `tg-ctl ask` hook client against a
// private daemon and a mock Telegram. The card's "Source:" line must name a subagent only from a
// trusted signal — the raw payload's top-level agent_id, or the launcher env — and never from
// CLAUDE_CODE_CHILD_SESSION, which Claude Code also sets on the main thread (the old
// agent-detect auto-detection labelled EVERY permission card `subagent=subagent`).

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, watch, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const REGISTERED_CWD = '/registered/project';
const FIXTURE = join(import.meta.dir, 'fixtures', 'agent-role', 'claude-code-2.1.285-hooks.jsonl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-asktrole-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%9', cwd: REGISTERED_CWD }));
mkdirSync(join(cfgDir, 'bin'));
writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

const cards: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      // Hold the long-poll open until the daemon drops it — no polling timer.
      await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()));
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      cards.push(String(((await req.json()) as Record<string, unknown>).text));
      return Response.json({ ok: true, result: { message_id: 4000 + cards.length } });
    }
    if (url.pathname.endsWith('/editMessageText') || url.pathname.endsWith('/editMessageReplyMarkup')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const procs: Subprocess[] = [];
beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TG_CTL_UNSCOPED_TIMEOUT_MS: '400',
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  // Await the daemon's socket appearing (directory watch), not a guessed boot time.
  await new Promise<void>((resolve) => {
    const dir = watch(cfgDir, () => {
      if (existsSync(socket)) {
        dir.close();
        resolve();
      }
    });
    if (existsSync(socket)) {
      dir.close();
      resolve();
    }
  });
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

// The fixture's two Bash tool calls become PermissionRequests at the registered cwd.
const ccBash = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)
  .filter((e) => e.tool_name === 'Bash')
  .map((e) => ({ ...e, hook_event_name: 'PermissionRequest', cwd: REGISTERED_CWD }));
const subagentCall = ccBash.find((e) => e.agent_id)!;
const coordinatorCall = ccBash.find((e) => !e.agent_id)!;

// Run one `tg-ctl ask` to completion (the 400ms unscoped timer expires the card) and return
// the Source line of the card it posted.
async function askSource(payload: Record<string, unknown>, env: Record<string, string>): Promise<string> {
  const before = cards.length;
  const proc = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}`, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  proc.stdin.write(JSON.stringify(payload) + '\n');
  proc.stdin.end();
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(cards.length).toBe(before + 1);
  return cards[before].split('\n').find((l) => l.startsWith('Source:')) ?? '';
}

// The old auto-detection turned these two env vars into `subagent=subagent` on every card.
const claudeEnv = { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' };

test('a permission raised inside a Claude Code subagent names it from the payload agent_id', async () => {
  expect(await askSource(subagentCall, claudeEnv)).toContain('subagent=general-purpose#e69145c6');
}, 15_000);

test('the coordinator\'s permission carries no subagent label even with CLAUDE_CODE_CHILD_SESSION=1', async () => {
  expect(await askSource(coordinatorCall, claudeEnv)).not.toContain('subagent=');
}, 15_000);

test('a detached child (launcher RIG_AGENT_ID) is labelled from its env when the payload has no agent_id', async () => {
  expect(await askSource(coordinatorCall, { ...claudeEnv, RIG_AGENT_ID: 'reviewer-1' })).toContain('subagent=reviewer-1');
}, 15_000);
