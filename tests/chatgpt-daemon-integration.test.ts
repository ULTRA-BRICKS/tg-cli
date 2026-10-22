import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// End to end through the real tg-ctl daemon: a fake Bot API serves /chatgpt and the button taps,
// a fake `pm` on PATH answers the frozen API and logs every call. Proves the wiring (not just the
// pure modules): the menu is sent as escaped HTML with a keyboard, one tap queues exactly one
// request, a replay / foreign-chat tap / forged ref does nothing, and the ref store is 0600.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActive?: boolean) => void | Promise<void> }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

const cfgDir = tempDir('tgctl-chatgpt-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const bin = join(cfgDir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
writeFileSync(join(bin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
const pmLog = join(cfgDir, 'pm-calls.txt');
writeFileSync(
  join(bin, 'pm'),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${pmLog}'
case "$3" in
  sessions.list) cat <<'JSON'
{"ok":true,"result":{"workspace":"all","accounts":[{"workspace":"home","ok":true,"stale":false,"summary":{"enrolled":1,"present":1,"running":0,"blocked":0}}],"sessions":[{"account":"home","chat":"chat-a","title":"Plan <b>&</b>","status":"complete","continuation":"complete","latest_turn":"turn-1"}],"events":[]}}
JSON
  ;;
  actions.request) echo '{"ok":true,"result":{"request_id":"req-9","status":"pending","action":"pause","workspace":"home","chat":"chat-a","expected_turn":null,"expires_at":1790000900}}' ;;
  *) echo '{"ok":false,"error":{"code":"nope","message":"unexpected"}}'; exit 1 ;;
esac
`,
  { mode: 0o755 },
);

interface Sent {
  text: string;
  parse_mode?: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}
const sent: Sent[] = [];
const answers: string[] = [];
const pending: unknown[] = [];
let nextUpdateId = 100;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const batch = pending.splice(0);
      if (batch.length === 0) await Bun.sleep(60);
      return Response.json({ ok: true, result: batch });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as Sent);
      return Response.json({ ok: true, result: { message_id: 500 + sent.length } });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      answers.push(((await req.json()) as { text: string }).text);
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: {} });
  },
});
servers.push(server);

function pmCalls(): string[] {
  return existsSync(pmLog) ? readFileSync(pmLog, 'utf8').split('\n').filter(Boolean) : [];
}

function tapUpdate(data: string, chat: number) {
  return { update_id: nextUpdateId++, callback_query: { id: `q${nextUpdateId}`, from: { id: 1, first_name: 'Alex' }, data, message: { message_id: 7, chat: { id: chat }, date: Math.floor(Date.now() / 1000) } } };
}

test('/chatgpt menu, one-tap request, replay / foreign chat / forged ref do nothing', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  try {
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      logFd,
      socketWaitMs: 8000,
    });
  } finally {
    closeSync(logFd);
  }

  pending.push({ update_id: nextUpdateId++, message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: '/chatgpt' } });
  expect(await waitFor(() => sent.some((m) => m.text.includes('ChatGPT sessions')))).toBe(true);
  const menu = sent.find((m) => m.text.includes('ChatGPT sessions'))!;
  expect(menu.parse_mode).toBe('HTML');
  expect(menu.text).toContain('Plan &lt;b&gt;&amp;&lt;/b&gt;');
  const buttons = menu.reply_markup!.inline_keyboard.flat();
  for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  const pause = buttons.find((b) => /Pause/.test(b.text))!;
  expect(pause.callback_data.startsWith('cgp:')).toBe(true);

  // forged ref + a tap from a foreign chat first: no pm mutation
  pending.push(tapUpdate('cgp:AAAAAAAAAAAAAAAAAAAAAA', 1));
  pending.push(tapUpdate(pause.callback_data, 2));
  expect(await waitFor(() => answers.includes('expired') && answers.includes('not allowed'))).toBe(true);
  expect(pmCalls().filter((c) => c.includes('actions.request'))).toHaveLength(0);

  // the real tap, then a replay
  pending.push(tapUpdate(pause.callback_data, 1));
  expect(await waitFor(() => sent.some((m) => m.text.includes('Approval requested')))).toBe(true);
  pending.push(tapUpdate(pause.callback_data, 1));
  expect(await waitFor(() => answers.filter((a) => a === 'expired').length >= 2)).toBe(true);
  const requests = pmCalls().filter((c) => c.includes('actions.request'));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('"action":"pause"');
  expect(requests[0]).not.toContain('approved');
  expect(answers.some((a) => a.includes('Approval requested (id req-9); confirm in the approval prompt'))).toBe(true);

  const store = join(cfgDir, readdirStore());
  expect(statSync(store).mode & 0o777).toBe(0o600);
  expect(readFileSync(store, 'utf8')).not.toContain('Plan');
});

function readdirStore(): string {
  const entry = Bun.spawnSync(['ls', cfgDir]).stdout.toString().split('\n').find((f) => f.endsWith('.chatgpt-refs.json'));
  expect(entry).toBeDefined();
  return entry!;
}
