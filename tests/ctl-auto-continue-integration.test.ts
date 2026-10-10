import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

// Integration test for auto-continue scheduling (tg-cli#113). Proves: (1) tapping
// the auto-continue button arms + PERSISTS a schedule and answers the callback;
// (2) a schedule that survives a restart is re-armed on startup and fires (its
// entry is dropped from the persisted file once it fires). The inject itself
// needs a live agent pane (out of scope for a stub); we assert the durable
// schedule state, which is the AC's restart-survival guarantee.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SCHEDULES = 'tg-ctl.123.schedules.json';

// `tmuxScript`: the fake tmux; the default hosts no agent pane anywhere.
function makeCfg(tmuxScript = TMUX_NO_SERVER_SHIM): string {
  const dir = mkdtempSync(join(tmpdir(), 'tgctl-autocont-'));
  writeFileSync(join(dir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(dir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(dir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: dir }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), tmuxScript, { mode: 0o755 });
  return dir;
}

const procs: Subprocess[] = [];
function spawnDaemon(cfgDir: string, port: number): Subprocess {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const d = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(d);
  closeSync(logFd);
  return d;
}

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
});

test('tapping the auto-continue button arms + persists a schedule and answers the callback', async () => {
  const cfgDir = makeCfg();
  const answered: any[] = [];
  const resetAt = Date.now() + 60 * 60_000; // 1h out → stays armed
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 400,
                callback_query: {
                  id: 'cb1',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: `lc:%3:${resetAt}`,
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answered.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  try {
    spawnDaemon(cfgDir, server.port);
    const schedPath = join(cfgDir, SCHEDULES);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !(existsSync(schedPath) && readFileSync(schedPath, 'utf8').includes('%3'))) {
      await Bun.sleep(50);
    }
    expect(existsSync(schedPath)).toBe(true);
    const data = JSON.parse(readFileSync(schedPath, 'utf8'));
    expect(data.schedules.map((s: any) => s.paneId)).toContain('%3');
    expect(data.schedules[0].resetAt).toBe(resetAt);
    // callback was acknowledged
    while (Date.now() - t0 < 8000 && answered.length === 0) await Bun.sleep(50);
    expect(answered).toHaveLength(1);
    expect(answered[0].text).toContain('auto-continue armed');
  } finally {
    server.stop(true);
  }
});

test('a stale first-time tap (reset >1 day past) is rejected, never armed or persisted', async () => {
  const cfgDir = makeCfg();
  const answered: any[] = [];
  const staleResetAt = Date.now() - 25 * 60 * 60_000; // >1 day past → dead
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 401,
                callback_query: {
                  id: 'cb2',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 78, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: `lc:%4:${staleResetAt}`,
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answered.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  try {
    spawnDaemon(cfgDir, server.port);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && answered.length === 0) await Bun.sleep(50);
    expect(answered).toHaveLength(1);
    // Rejected with an "expired" toast, NOT the "auto-continue armed" ack.
    expect(answered[0].text).toContain('expired');
    expect(answered[0].text).not.toContain('armed');
    // Never persisted — a stale tap must not create a schedule at all.
    const schedPath = join(cfgDir, SCHEDULES);
    await Bun.sleep(200);
    if (existsSync(schedPath)) {
      const data = JSON.parse(readFileSync(schedPath, 'utf8'));
      expect(data.schedules.map((s: any) => s.paneId)).not.toContain('%4');
    }
  } finally {
    server.stop(true);
  }
});

test('a persisted schedule survives a restart, re-arms, fires, flips 👀 on the source, and clears the card', async () => {
  // Pane %9 hosts a claude (pid 9001) with an empty input box; no other pane exists.
  const cfgDir = makeCfg(
    `#!/bin/sh\ncase "$*" in\n  *list-panes*) printf '4\\t0\\t%%9\\t9001\\tnode\\tw\\t/tmp\\n' ;;\n  *capture-pane*) printf '────────────\\n❯ \\n────────────\\n' ;;\nesac\nexit 0\n`,
  );
  writeFileSync(join(cfgDir, 'bin', 'ps'), `#!/bin/sh\nprintf '    1     0 /sbin/launchd\\n'\nprintf ' 9001     1 claude\\n'\n`, { mode: 0o755 });
  // Pre-seed schedules whose reset is already past → a restarted daemon re-arms
  // them and they fire immediately (delay 0), each removed from the file. %9 is
  // injected: its SOURCE message (55) flips back to 👀 (NOT the card) and the card's
  // (88) button is cleared.
  const schedPath = join(cfgDir, SCHEDULES);
  writeFileSync(
    schedPath,
    JSON.stringify({
      version: 1,
      schedules: [
        // agent "" = identity unknown at arm time → fire proceeds best-effort.
        { paneId: '%9', resetAt: Date.now() - 5000, agent: '', sourceMessageId: 55, cardMessageId: 88, armedAt: Date.now() },
        // agent "ghost" with no such pane = pane no longer hosts it →
        // the guard SKIPS the inject/flip (a recycled pane must not be poked).
        { paneId: '%8', resetAt: Date.now() - 5000, agent: 'ghost', sourceMessageId: 66, cardMessageId: 99, armedAt: Date.now() },
        // identity unknown, pane gone → the inject fails: the agent did NOT resume,
        // so its source (44) must not claim 👀 "working".
        { paneId: '%7', resetAt: Date.now() - 5000, agent: '', sourceMessageId: 44, cardMessageId: 111, armedAt: Date.now() },
      ],
    }),
  );
  const reactions: any[] = [];
  const clearedKeyboards: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) {
        clearedKeyboards.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    },
  });
  try {
    spawnDaemon(cfgDir, server.port);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const data = JSON.parse(readFileSync(schedPath, 'utf8'));
      if (!data.schedules.some((s: any) => s.paneId === '%9' || s.paneId === '%8' || s.paneId === '%7')) break;
      await Bun.sleep(50);
    }
    // All schedules fire on the startup re-arm (only fireAutoContinue rewrites
    // the file) — so every entry disappearing proves the restart re-armed them.
    const data = JSON.parse(readFileSync(schedPath, 'utf8'));
    expect(data.schedules.some((s: any) => s.paneId === '%9' || s.paneId === '%8' || s.paneId === '%7')).toBe(false);
    // %9 (identity unknown) proceeds: 👀 lands on the SOURCE message (55), not
    // the card; the card's (88) button is cleared so it can't re-arm.
    // %9's inject (with its ~0.7 s submit check) resolves after %7's quick failure,
    // so waiting for 55 also covers 44.
    while (Date.now() - t0 < 8000 && !reactions.some((r) => r.message_id === 55)) await Bun.sleep(50);
    expect(reactions.some((r) => r.message_id === 55 && r.reaction[0].emoji === '👀')).toBe(true);
    expect(clearedKeyboards.some((k) => k.message_id === 88)).toBe(true);
    // %8's agent (ghost) no longer maps to the pane → guard SKIPS it: no reaction
    // on its source (66) and its card (99) button is left alone.
    expect(reactions.some((r) => r.message_id === 66)).toBe(false);
    expect(clearedKeyboards.some((k) => k.message_id === 99)).toBe(false);
    expect(reactions.some((r) => r.message_id === 44)).toBe(false);
  } finally {
    server.stop(true);
  }
});
