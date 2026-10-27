import { afterEach, expect, test } from 'bun:test';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir, trackChild } from './helpers/test-temp';

// Real daemon + real `tg-ctl ask [--owner-only]` client against a fake Bot API. Owner chat 1000,
// a second allowlisted sender 2000. Daemon-restart persistence is covered at the
// normalizeButtonRequest / question-store level (tests/ctl-owner-only.test.ts): a generic ask's
// client socket does not survive a daemon restart, so there is no live card to tap afterwards.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const OWNER = 1000;
const OTHER = 2000;
const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => void | Promise<void> }> = [];
afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

async function waitFor(pred: () => boolean, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await Bun.sleep(50); }
  return pred();
}

async function harness() {
  const cfgDir = tempDir('tgctl-oo-');
  writeFileSync(join(cfgDir, '.env'), `TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=${OWNER}\n`);
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  allowed_senders: ${OTHER}\n`);
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(bin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const sent: Array<{ reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }> = [];
  const answers: string[] = [];
  const queue: unknown[] = [];
  let uid = 100;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p.endsWith('/getUpdates')) {
        const b = queue.splice(0);
        if (b.length === 0) await Bun.sleep(60);
        return Response.json({ ok: true, result: b });
      }
      if (p.endsWith('/sendMessage')) {
        sent.push((await req.json()) as never);
        return Response.json({ ok: true, result: { message_id: 500 + sent.length } });
      }
      if (p.endsWith('/answerCallbackQuery')) {
        answers.push(((await req.json()) as { text?: string }).text ?? '');
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  try {
    await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: base }, logFd, socketWaitMs: 8000 });
  } finally { closeSync(logFd); }
  const ask = (args: string[]): Subprocess =>
    trackChild(Bun.spawn([process.execPath, TG_CTL, 'ask', ...args], { env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: base }, stdout: 'pipe', stderr: 'pipe' }));
  const approveData = () => sent.at(-1)?.reply_markup?.inline_keyboard.flat().find((b) => /approve/i.test(b.text))?.callback_data;
  const tap = (from: number, chat: number, data: string) => {
    queue.push({ update_id: uid++, callback_query: { id: `q${uid}`, from: { id: from, first_name: 'X' }, data, message: { message_id: 501, chat: { id: chat }, date: Math.floor(Date.now() / 1000) } } });
  };
  return { sent, answers, ask, approveData, tap };
}

test('ownerOnly ask: foreign tappers refused, owner approves, replay does not re-approve', async () => {
  const h = await harness();
  const p = h.ask(['--owner-only', 'deploy?', '--timeout', '60']);
  expect(await waitFor(() => h.approveData() !== undefined)).toBe(true);
  const data = h.approveData()!;

  h.tap(OTHER, OWNER, data); // other allowlisted sender, owner chat
  expect(await waitFor(() => h.answers.includes('not allowed'))).toBe(true);
  const n1 = h.answers.length;
  h.tap(OWNER, 3000, data); // owner user id, but tapped from another chat
  expect(await waitFor(() => h.answers.length > n1)).toBe(true);
  expect(h.answers.at(-1)).toBe('not allowed');
  expect(p.exitCode).toBeNull();

  h.tap(OWNER, OWNER, data);
  expect(await p.exited).toBe(0);
  const n2 = h.answers.length;
  h.tap(OWNER, OWNER, data); // replay
  expect(await waitFor(() => h.answers.length > n2)).toBe(true);
  expect(h.answers.at(-1)).not.toBe('approved');
});

test('plain ask is still answerable by another allowlisted sender', async () => {
  const h = await harness();
  const p = h.ask(['deploy?', '--timeout', '60']);
  expect(await waitFor(() => h.approveData() !== undefined)).toBe(true);
  h.tap(OTHER, OWNER, h.approveData()!);
  expect(await p.exited).toBe(0);
});
