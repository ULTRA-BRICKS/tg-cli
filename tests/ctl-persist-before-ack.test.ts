import { appendFileSync } from 'node:fs';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM, tmuxNoServerShim } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';
import { NO_AGENT_REPLY } from '../tg-ctl';
import { parsePendingBatch, serializePendingBatch } from '../features/tg-ctl/updates';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

// --- (b) unit-level persist helpers ---

const SAMPLE_UPDATES = [
  {
    update_id: 100,
    message: {
      message_id: 1,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: 1,
      text: 'hello agent',
    },
  },
];

test('parsePendingBatch/serializePendingBatch round-trip and edge cases', () => {
  expect(parsePendingBatch(serializePendingBatch(SAMPLE_UPDATES))).toEqual(SAMPLE_UPDATES);
  expect(parsePendingBatch(null)).toEqual([]);
  expect(parsePendingBatch('not json')).toEqual([]);
  expect(parsePendingBatch('{}')).toEqual([]);
});

// --- (a) SIGKILL durability integration ---

const nowSec = Math.floor(Date.now() / 1000);
const SIGKILL_UPDATE = {
  update_id: 100,
  message: {
    message_id: 1,
    from: { id: 1, first_name: 'Alex' },
    chat: { id: 1 },
    date: nowSec,
    text: 'hello agent',
  },
};

const sigkillReg = createDaemonRegistry();
const sigkillCfgDir = tempDir('tgctl-sigkill-');
const pendingBatchPath = join(sigkillCfgDir, 'tg-ctl.123.pending-batch.json');
writeFileSync(join(sigkillCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(sigkillCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const sigkillShimDir = join(sigkillCfgDir, 'bin');
mkdirSync(sigkillShimDir);
writeFileSync(join(sigkillShimDir, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
writeFileSync(
  join(sigkillShimDir, 'ps'),
  '#!/bin/sh\nprintf \'    1     0 /sbin/launchd\\n\'\nexit 0\n',
  { mode: 0o755 },
);

const sigkillSent: { chat_id: number; text: string }[] = [];
let sigkillServeCount = 0;
// The first daemon's no-agent reply is held open: its batch stays journaled and unprocessed
// (the daemon unlinks the journal only after every action of the batch finished), so the
// SIGKILL lands inside that window by construction, however fast or slow the host is.
const heldReply = Promise.withResolvers<void>();
let holdReply = true;
let replyHeld = false;

const sigkillServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/setMyCommands')) {
      await req.json();
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && sigkillServeCount === 0) {
        sigkillServeCount += 1;
        return Response.json({ ok: true, result: [SIGKILL_UPDATE] });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as { chat_id: number; text: string };
      if (holdReply && body.text === NO_AGENT_REPLY) {
        replyHeld = true;
        await heldReply.promise;
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      sigkillSent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

afterAll(async () => {
  heldReply.resolve();
  await reapDaemons(sigkillReg);
  sigkillServer.stop(true);
});

test('SIGKILL after pending-batch write recovers on respawn — message not lost', async () => {
  const logFd = openSync(join(sigkillCfgDir, 'daemon1.log'), 'w');
  const daemon1 = await spawnDaemon(sigkillReg, {
    tgCtlPath: TG_CTL,
    cfgDir: sigkillCfgDir,
    env: {
      PATH: `${sigkillShimDir}:${process.env.PATH ?? ''}`,
      HOME: sigkillCfgDir,
      TG_CTL_CONFIG_DIR: sigkillCfgDir,
      TG_API_BASE: `http://127.0.0.1:${sigkillServer.port}`,
    },
    logFd,
  });
  closeSync(logFd);

  // Killed while its reply is in flight: the batch is journaled and not yet processed.
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !replyHeld) await Bun.sleep(50);
  expect(replyHeld).toBe(true);
  expect(readFileSync(pendingBatchPath, 'utf8').trim().length).toBeGreaterThan(0);

  daemon1.kill('SIGKILL');
  await daemon1.exited;
  holdReply = false;

  const sentBeforeRespawn = sigkillSent.length;

  const logFd2 = openSync(join(sigkillCfgDir, 'daemon2.log'), 'w');
  const daemon2 = await spawnDaemon(sigkillReg, {
    tgCtlPath: TG_CTL,
    cfgDir: sigkillCfgDir,
    env: {
      PATH: `${sigkillShimDir}:${process.env.PATH ?? ''}`,
      HOME: sigkillCfgDir,
      TG_CTL_CONFIG_DIR: sigkillCfgDir,
      TG_API_BASE: `http://127.0.0.1:${sigkillServer.port}`,
    },
    logFd: logFd2,
  });
  closeSync(logFd2);

  const t1 = Date.now();
  while (Date.now() - t1 < 8000) {
    if (sigkillSent.length > sentBeforeRespawn && sigkillSent.some((m) => m.text === NO_AGENT_REPLY)) break;
    await Bun.sleep(50);
  }

  expect(sigkillSent.some((m) => m.text === NO_AGENT_REPLY)).toBe(true);
  expect(sigkillSent.length).toBeGreaterThan(sentBeforeRespawn);

  const t2 = Date.now();
  while (Date.now() - t2 < 8000) {
    if (!existsSync(pendingBatchPath)) break;
    await Bun.sleep(50);
  }
  expect(existsSync(pendingBatchPath)).toBe(false);

  daemon2.kill('SIGTERM');
  const exited = await Promise.race([
    daemon2.exited,
    Bun.sleep(4000).then(() => 'timeout' as const),
  ]);
  expect(exited).not.toBe('timeout');
}, 25_000);

// --- (c) fire-and-forget omp ACP delivery ---

const ffCfgDir = tempDir('tgctl-ff-omp-');
writeFileSync(join(ffCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(ffCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const ffBinDir = join(ffCfgDir, 'bin');
mkdirSync(ffBinDir);
const ffTmuxLog = join(ffCfgDir, 'tmux.log');
writeFileSync(ffTmuxLog, '');
writeFileSync(join(ffBinDir, 'tmux'), tmuxNoServerShim(`echo "$0 $*" >> ${JSON.stringify(ffTmuxLog).slice(1, -1)}`), { mode: 0o755 });

const ffSessionDir = join(ffCfgDir, 'sessions');
mkdirSync(ffSessionDir);
const ffSessionFile = join(ffSessionDir, '2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl');
writeFileSync(
  ffSessionFile,
  [
    '{"type":"title","v":1,"title":"ReviewFix","source":"auto"}',
    '{"type":"session","version":3,"id":"01a07d8e-c12c-7433-903d-e98726bfda37","cwd":"/Users/u/work/review-cli","title":"ReviewFix"}',
    '',
  ].join('\n'),
);

writeFileSync(
  join(ffBinDir, 'ps'),
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
  join(ffBinDir, 'lsof'),
  `#!/bin/sh
printf 'p${process.pid}\\n'
printf 'fcwd\\n'
printf 'n/Users/u/work/review-cli\\n'
printf 'n${ffSessionFile}\\n'
exit 0
`,
  { mode: 0o755 },
);

const ffAcpLog = join(ffCfgDir, 'acp.log');
writeFileSync(ffAcpLog, '');
writeFileSync(join(ffBinDir, 'omp'), `#!/bin/sh\nprintf 'FORBIDDEN\\n' >> '${ffAcpLog}.spawned'\nexit 1\n`, { mode: 0o755 });
const ffEndpoint = await startLiveEndpoint({ root: join(ffCfgDir, 'omp-live'),
  snapshot: () => ({ sessionId: '01a07d8e-c12c-7433-903d-e98726bfda37', sessionFile: ffSessionFile, cwd: '/Users/u/work/review-cli', title: 'ReviewFix', busy: true }),
  send: (text: string) => { appendFileSync(ffAcpLog, JSON.stringify({ event: 'original-input', text }) + '\n'); },
});

const ffSent: Array<Record<string, unknown>> = [];
let ffServed = 0;
const ffServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && ffServed === 0) {
        ffServed = 1;
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
      ffSent.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const ffReg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(ffReg);
  ffServer.stop(true);
  await ffEndpoint.close();
});

test('original OMP acknowledgement does not wait for the busy model to finish a turn', async () => {
  const spawnT0 = Date.now();
  const logFd = openSync(join(ffCfgDir, 'daemon.log'), 'w');
  const daemon = await spawnDaemon(ffReg, {
    tgCtlPath: TG_CTL,
    cfgDir: ffCfgDir,
    env: {
      PATH: `${ffBinDir}:${process.env.PATH ?? ''}`,
      HOME: ffCfgDir,
      TG_CTL_CONFIG_DIR: ffCfgDir,
      TG_API_BASE: `http://127.0.0.1:${ffServer.port}`,
      OMP_ACP_LOG: ffAcpLog,
      TMUX: '',
    },
    logFd,
  });
  closeSync(logFd);

  let promptAt = 0;
  while (Date.now() - spawnT0 < 12000) {
    const acp = existsSync(ffAcpLog) ? readFileSync(ffAcpLog, 'utf8') : '';
    if (acp.includes('original-input')) {
      promptAt = Date.now();
      break;
    }
    await Bun.sleep(50);
  }

  const acp = existsSync(ffAcpLog) ? readFileSync(ffAcpLog, 'utf8') : '';
  expect(acp).toContain('"event":"original-input"');
  expect(promptAt).toBeGreaterThan(0);
  expect(existsSync(ffAcpLog + '.spawned')).toBe(false);

  // The old design blocked on acpCall(...120_000) here — with no response from the
  // fake omp, that would stall ~120s before the routing confirm could land. Fire-and-
  // forget must let the daemon make forward progress within a couple seconds of the
  // prompt frame being written, even though the fake never answers original-input.
  const confirmT0 = Date.now();
  while (Date.now() - confirmT0 < 3000) {
    const confirm = ffSent.find((m) => String(m.text).includes('ReviewFix'));
    if (confirm) break;
    await Bun.sleep(50);
  }
  expect(Date.now() - promptAt).toBeLessThan(2000);
  expect(Date.now() - spawnT0).toBeLessThan(15_000);

  const confirm = ffSent.find((m) => String(m.text).includes('ReviewFix'));
  expect(confirm?.text).toContain('ReviewFix');

  daemon.kill('SIGTERM');
  const exited = await Promise.race([
    daemon.exited,
    Bun.sleep(4000).then(() => 'timeout' as const),
  ]);
  expect(exited).not.toBe('timeout');
}, 20_000);
