import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// Regression for tg-cli#274: a confident `/agent
// <selector> <message>` route lost the inbound `tg#<id>` wrap tag that every
// other inbound path (auto-bind inject, reply-quote, deferred flush) already
// carried. Root cause: `injectToPane` accepted a `sourceMessageId` parameter
// (used only for the deferred-queue bookkeeping) but never forwarded it into
// `wrapInbound`, so the pane always saw `[TG from Alex] <msg>` instead of
// `[TG from Alex tg#<id>] <msg>` for a selector-routed message — breaking
// `tg --reply-to <id>` threading for anything sent via `/agent <name> …`.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-agent-route-id-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

// One claude pane in window "4" named "rig" — a confident, unambiguous selector match.
const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux-invocations.log');
const tmuxScript = `#!/bin/sh
case "$*" in
  *list-panes*)
    printf '4\\t0\\t%%5001\\t5001\\tnode\\trig\\t/Users/u/xp/rig\\n'
    ;;
  *)
    echo "$*" >> "${tmuxLog}"
    ;;
esac
exit 0
`;
writeFileSync(join(binDir, 'tmux'), tmuxScript, { mode: 0o755 });

const psScript = `#!/bin/sh
printf '    1     0 /sbin/launchd\\n'
printf ' 5001     1 claude --resume\\n'
exit 0
`;
writeFileSync(join(binDir, 'ps'), psScript, { mode: 0o755 });

const sentMessages: Array<Record<string, unknown>> = [];
const reactions: Array<Record<string, unknown>> = [];
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
              update_id: 100,
              message: {
                message_id: 4242,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: Math.floor(Date.now() / 1000),
                text: '/agent rig deploy now',
              },
            },
          ],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const reg = createDaemonRegistry();

afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('/agent <name> <msg> confident route keeps the tg#<id> wrap tag', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);

  const tEnd = Date.now() + 10000;
  // The wrapped text below ("deploy now") has no newline, so buildTextInjectPlan
  // always takes the single-line `send-keys -l` branch (never `paste-buffer`,
  // which carries its payload over stdin/load-buffer — invisible to this mock's
  // `echo "$*"` argv log). Matching only `send-keys` keeps this gate in sync
  // with what the assertions below actually check.
  const injected = (): boolean => {
    const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
    return /^send-keys\b.*-t %5001\b/m.test(log);
  };
  while (Date.now() < tEnd && (!injected() || !reactions.some((r) => r.message_id === 4242))) {
    await Bun.sleep(80);
  }

  daemon.kill('SIGTERM');
  await daemon.exited;

  const log = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  // The wrap must carry the inbound message's own id so the agent can thread
  // its reply with `tg --reply-to 4242`.
  expect(log).toContain('tg#4242');
  expect(log).toContain('deploy now');
}, 25_000);
