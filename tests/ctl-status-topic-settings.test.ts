import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// `tg-ctl status` reports the bot's topic settings from getMe (docs/specs/session-registry-and-topics.md
// §4.6, tg-cli#736). With allows_users_to_create_topics=true every message the CTO sends from
// Telegram's "New Chat" entry opens a fresh topic (MTProto: messageActionTopicCreate with
// title_missing, i.e. Bot API is_name_implicit) — status must say so, or the cause stays invisible.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function getMeServer(reply: () => Response | Promise<Response>): number {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new URL(req.url).pathname.endsWith('/getMe') ? reply() : Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  return server.port;
}

async function status(control: string, port: number): Promise<string> {
  const cfgDir = tempDir('tgctl-status-topics-');
  dirs.push(cfgDir);
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n${control}`);
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const p = Bun.spawn([process.execPath, TG_CTL, 'status'], {
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${port}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  return stdout;
}

const me = (extra: Record<string, unknown>) => () => Response.json({ ok: true, result: { id: 123, is_bot: true, ...extra } });

test('status warns that users may create topics: every "New Chat" message opens a new one', async () => {
  const out = await status('  private_topics: true\n', getMeServer(me({ has_topics_enabled: true, allows_users_to_create_topics: true })));
  const line = out.split('\n').find((l) => l.startsWith('topics: '));
  expect(line).toContain('has_topics_enabled=true, allows_users_to_create_topics=true');
  expect(line).toContain('"New Chat"');
  expect(line).toContain('@BotFather');
});

test('status shows the topic settings without a warning when users cannot create topics', async () => {
  const out = await status('  topics: true\n', getMeServer(me({ has_topics_enabled: true, allows_users_to_create_topics: false })));
  expect(out.split('\n').find((l) => l.startsWith('topics: '))).toBe('topics: has_topics_enabled=true, allows_users_to_create_topics=false');
});

test('status says getMe is unavailable instead of failing', async () => {
  const out = await status('  private_topics: true\n', getMeServer(() => Response.json({ ok: false, description: 'boom' }, { status: 502 })));
  expect(out.split('\n').find((l) => l.startsWith('topics: '))).toBe('topics: getMe unavailable (boom)');
});

test('a stalled getMe costs status a few seconds, not the 15 s send timeout', async () => {
  // The server never answers getMe: only the status' own short diagnostic timeout ends the call.
  const t0 = Date.now();
  const out = await status('  private_topics: true\n', getMeServer(() => new Promise<Response>(() => {})));
  expect(out.split('\n').find((l) => l.startsWith('topics: '))).toStartWith('topics: getMe unavailable (');
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 20_000);

test('status has no topics line when topics are off', async () => {
  const out = await status('', getMeServer(me({ has_topics_enabled: true, allows_users_to_create_topics: true })));
  expect(out.split('\n').some((l) => l.startsWith('topics: '))).toBe(false);
});
