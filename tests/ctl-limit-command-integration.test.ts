import { expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

test('/limit [agent] reports the latest stored usage buckets through the Telegram daemon', async () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const cfgDir = tempDir('tgctl-limit-command-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.usage-latest.json'),
    `${JSON.stringify({
      version: 1,
      samples: [
        {
          agent: 'claude',
          limitName: '5-hour',
          percent: 98,
          resetAt: now + 2 * 60 * 60_000,
          language: 'en',
          detail: '',
          sampledAt: now - 60_000,
        },
        {
          agent: 'claude',
          limitName: 'weekly',
          percent: 64,
          resetAt: now + 2 * 24 * 60 * 60_000,
          language: 'en',
          detail: '',
          sampledAt: now - 60_000,
        },
        {
          agent: 'codex',
          limitName: '5-hour',
          percent: 91,
          resetAt: now + 60 * 60_000,
          language: 'en',
          detail: '',
          sampledAt: now - 60_000,
        },
      ],
    })}\n`,
  );

  const updates = [
    {
      update_id: 100,
      message: {
        message_id: 1,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        text: '/limit claude',
      },
    },
  ];
  const offsets: number[] = [];
  const sent: Array<{ chat_id: number; text: string }> = [];
  const reactions: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/getUpdates')) {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        offsets.push(offset);
        const pending = updates.filter((u) => u.update_id >= offset);
        if (pending.length) return Response.json({ ok: true, result: pending });
        await Bun.sleep(1500);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sent.push((await req.json()) as { chat_id: number; text: string });
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  const reg = createDaemonRegistry();
  try {
    const daemon = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      if (sent.length >= 1 && offsets.includes(101)) break;
      await Bun.sleep(100);
    }

    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe(1);
    expect(sent[0].text).toContain('Latest limits for claude:');
    expect(sent[0].text).toContain('claude:');
    expect(sent[0].text).toContain('- 5-hour: 98%');
    expect(sent[0].text).toContain('- weekly: 64%');
    expect(sent[0].text).not.toContain('codex:');
    expect(reactions).toEqual([{ chat_id: 1, message_id: 1, reaction: [{ type: 'emoji', emoji: '👀' }] }]);

    daemon.kill('SIGTERM');
    const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => 'timeout' as const)]);
    expect(exited).not.toBe('timeout');
    expect(daemon.exitCode).toBe(0);
  } finally {
    await reapDaemons(reg);
    server.stop(true);
  }
}, 15_000);
