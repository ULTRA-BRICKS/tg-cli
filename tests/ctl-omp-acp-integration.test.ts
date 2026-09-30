import { appendFileSync } from 'node:fs';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Integration (tg-cli#323): inbound Telegram text reaches a live omp child via ACP
// session/prompt with TMUX unset. A tmux send-keys path would fail this test
// (the fake tmux logs argv; we assert it never saw send-keys). Session name
// comes from omp's own jsonl title, not the cwd basename.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-omp-acp-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
const tmuxLog = join(cfgDir, 'tmux.log');
writeFileSync(tmuxLog, '');
writeFileSync(
  join(binDir, 'tmux'),
  `#!/bin/sh
echo "$0 $*" >> ${JSON.stringify(tmuxLog).slice(1, -1)}
exit 0
`,
  { mode: 0o755 },
);

const sessionDir = join(cfgDir, 'sessions');
mkdirSync(sessionDir);
const sessionFile = join(sessionDir, '2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl');
writeFileSync(
  sessionFile,
  [
    '{"type":"title","v":1,"title":"ReviewFix","source":"auto"}',
    '{"type":"session","version":3,"id":"01a07d8e-c12c-7433-903d-e98726bfda37","cwd":"/Users/u/work/review-cli","title":"ReviewFix"}',
    '',
  ].join('\n'),
);

writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' ${process.pid} ttys004\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' ${process.pid}     1 /opt/homebrew/bin/omp\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
printf 'p${process.pid}\\n'
printf 'fcwd\\n'
printf 'n/Users/u/work/review-cli\\n'
printf 'n${sessionFile}\\n'
exit 0
`,
  { mode: 0o755 },
);

const acpLog = join(cfgDir, 'acp.log');
writeFileSync(acpLog, '');
writeFileSync(join(binDir, 'omp'), `#!/bin/sh\nprintf 'FORBIDDEN\\n' >> '${acpLog}.spawned'\nexit 1\n`, { mode: 0o755 });
// Both observable effects of the routed message are awaited as events, not polled in a window:
// the original host's input callback runs in this process, and the daemon posts its confirmation
// to the fake Bot API only AFTER the delivery, so looking for that confirmation the moment the
// input lands races the send.
const originalInput = Promise.withResolvers<void>();
const confirmSent = Promise.withResolvers<Record<string, unknown>>();
const endpoint = await startLiveEndpoint({ root: join(cfgDir, 'omp-live'),
  snapshot: () => ({ sessionId: '01a07d8e-c12c-7433-903d-e98726bfda37', cwd: '/Users/u/work/review-cli', sessionFile, title: 'ReviewFix', busy: false }),
  send: (text: string) => {
    appendFileSync(acpLog, JSON.stringify({ event: 'original-input', pid: process.pid, sessionId: '01a07d8e-c12c-7433-903d-e98726bfda37', text }) + '\n');
    originalInput.resolve();
  },
});

let served = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && served === 0) {
        served = 1;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 10,
                from: { id: 1, first_name: 'Alex' },
                chat: { id: 1 },
                date: 1,
                text: '/agent ReviewFix deploy now',
              },
            },
          ],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      if (String(body.text).includes('ReviewFix')) confirmSent.resolve(body);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
  await endpoint.close();
});

test('Telegram name selector reaches original OMP with TMUX unset; never tmux send-keys or ACP clone', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      OMP_ACP_LOG: acpLog,
      TMUX: '',
    },
    logFd,
  });
  closeSync(logFd);

  await originalInput.promise;

  const acp = readFileSync(acpLog, 'utf8');
  expect(acp).toContain('"event":"original-input"');
  expect(existsSync(acpLog + '.spawned')).toBe(false);
  expect(acp).toContain('01a07d8e-c12c-7433-903d-e98726bfda37');
  expect(acp).not.toContain('"method":"session/new"');
  expect(acp).toContain('"event":"original-input"');
  expect(acp).toContain('deploy now');
  expect(acp).toContain('[TG from Alex');
  expect(acp).toContain('tg#10');
  expect(acp).not.toContain('send-keys');

  const tmux = readFileSync(tmuxLog, 'utf8');
  expect(tmux).not.toContain('send-keys');

  const confirm = await confirmSent.promise;
  expect(String(confirm.text)).toContain('ReviewFix');
  // Ask 108 / tg-cli#342: the stable project token stays on the label so
  // /agent landing and /agent rig-cli remain visible next to the title.
  expect(String(confirm.text)).toContain('review-cli');
}, 20_000);
