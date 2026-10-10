// tg-cli#464: a real daemon + real `tg-ctl ask` clients against a mock Bot API. An open
// question older than the (test-shortened) threshold gets ONE reminder; a second question
// crossing it produces a new reminder that lists both and deletes the previous reminder —
// never an original card — nothing repeats afterwards, and answering the last listed card
// withdraws the reminder. Quiet hours are forced off (start === end) so the runner's local
// clock can't land inside the default 23-8 window.
import { afterEach, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-unanswered-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  return cfgDir;
}

function baseEnv(cfgDir: string, apiPort: number): Record<string, string> {
  return {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
  };
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      ...baseEnv(cfgDir, apiPort),
      TG_CTL_UNANSWERED_REMINDER_AFTER_MS: '400',
      TG_CTL_QUIET_HOURS_START_HOUR: '0',
      TG_CTL_QUIET_HOURS_END_HOUR: '0',
    },
    logFd,
  });
  closeSync(logFd);
  return daemon;
}

function startAsk(cfgDir: string, apiPort: number, hookId: string): Subprocess {
  const ask = trackProc(
    reg,
    Bun.spawn([process.execPath, TG_CTL, 'ask'], { env: baseEnv(cfgDir, apiPort), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }),
  );
  const request = {
    cwd: cfgDir,
    requestId: `hatch-${hookId}-cccccccccccc`,
    agent: 'claude',
    kind: 'permission',
    question: `Allow rig hatch escalation: ${hookId}?`,
    permissionEvent: 'PermissionRequest',
  };
  ask.stdin.write(JSON.stringify(request) + '\n');
  ask.stdin.end();
  return ask;
}

interface Sent {
  id: number;
  text: string;
  firstButton: string | null; // callback_data of a card's first button (Allow); null for plain text
}

function mockTelegram() {
  const sent: Sent[] = [];
  const deletes: number[] = [];
  const updates: unknown[][] = [];
  let seq = 900;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updates.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body: { text?: string; reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } } = await req.json();
        seq += 1;
        sent.push({ id: seq, text: String(body.text ?? ''), firstButton: body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? null });
        return Response.json({ ok: true, result: { message_id: seq } });
      }
      if (url.pathname.endsWith('/deleteMessage')) {
        const body: { message_id?: unknown } = await req.json();
        deletes.push(Number(body.message_id));
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  const reminders = (): Sent[] => sent.filter((s) => s.text.startsWith('⏳'));
  const cards = (): Sent[] => sent.filter((s) => s.firstButton !== null);
  // The human taps a card's first button (Allow).
  const tap = (card: Sent, updateId: number): void => {
    updates.push([
      {
        update_id: updateId,
        callback_query: {
          id: `cb${updateId}`,
          from: { id: 1, first_name: 'Alex' },
          message: { message_id: card.id, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
          data: card.firstButton,
        },
      },
    ]);
  };
  return { port: server.port, stop: (c?: boolean) => server.stop(c), reminders, cards, tap, deletes: () => deletes };
}

// Generous: each wait spans a daemon/ask process spawn, which a loaded CI runner can slow to
// several seconds; a passing run returns the moment the condition holds.
async function until(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(40);
  }
  return cond();
}

test('UNANSWERED REMINDER (tg-cli#464): one reminder per overdue question; the next one replaces it; no repeats', async () => {
  const cfgDir = makeCfgDir();
  const tg = mockTelegram();
  servers.push(tg);
  const daemon = await startDaemon(cfgDir, tg.port);

  const askA = startAsk(cfgDir, tg.port, 'first');
  expect(await until(() => tg.cards().length === 1)).toBe(true);
  const cardA = tg.cards()[0];

  expect(await until(() => tg.reminders().length === 1)).toBe(true);
  const first = tg.reminders()[0];
  expect(first.text).toStartWith('⏳ 1 agent question still waiting on you:');
  expect(first.text).toContain('Allow rig hatch escalation: first?');
  expect(first.text).toContain(`tg#${cardA.id}`);

  const askB = startAsk(cfgDir, tg.port, 'second');
  expect(await until(() => tg.cards().length === 2)).toBe(true);
  const cardB = tg.cards()[1];

  expect(await until(() => tg.reminders().length === 2)).toBe(true);
  const second = tg.reminders()[1];
  expect(second.text).toStartWith('⏳ 2 agent questions still waiting on you:');
  expect(second.text).toContain(`tg#${cardA.id}`);
  expect(second.text).toContain(`tg#${cardB.id}`);
  // Replaced, not stacked: the first reminder is deleted; no card ever is.
  expect(await until(() => tg.deletes().includes(first.id))).toBe(true);

  // Both questions stay open well past the threshold again — still exactly two reminders.
  // A genuine wall-clock wait: the thing under test is the ABSENCE of a send from a real
  // daemon process sweeping on its own clock (every ~60ms mock poll); no virtual clock
  // reaches across the process boundary and no event marks "did not remind".
  await Bun.sleep(1500);
  expect(tg.reminders()).toHaveLength(2);

  // Answering one card leaves the reminder up; answering the last one withdraws it.
  tg.tap(cardA, 701);
  expect(await askA.exited).toBe(0);
  expect(tg.deletes()).not.toContain(second.id);
  tg.tap(cardB, 702);
  expect(await askB.exited).toBe(0);
  expect(await until(() => tg.deletes().includes(second.id))).toBe(true);
  expect(tg.deletes()).not.toContain(cardA.id);
  expect(tg.deletes()).not.toContain(cardB.id);
  expect(tg.reminders()).toHaveLength(2);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 90_000);
