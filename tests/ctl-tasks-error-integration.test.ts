import { afterEach, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// /tasks must tell a failed `task list` apart from a genuinely empty backlog
// (tg-cli#201, rescued from the closed PR #129/#135 review finding). Before, a
// non-zero exit, unparsable stdout or non-array JSON all rendered the same
// "No matching tasks." board, and the only trace was a daemon log line.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActive?: boolean) => void | Promise<void> }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

// One registered project, no tmux panes → `/tasks` scopes to that project
// (the no-agent → single registration path), so only the task stub varies.
function setup(prefix: string, taskScript: string) {
  const cfgDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'task'), taskScript, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  return { cfgDir, bin };
}

type SentMessage = { text: string };

function fakeBotApi() {
  let served = false;
  const richMessages: unknown[] = [];
  const sentMessages: SentMessage[] = [];
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
                update_id: 300,
                message: {
                  message_id: 10,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        // Long-poll stand-in: an empty getUpdates answered instantly would spin the daemon's poll loop.
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        richMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 88 } });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sentMessages.push((await req.json()) as SentMessage);
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  servers.push(server);
  return { server, richMessages, sentMessages };
}

async function runTasks(prefix: string, taskScript: string) {
  const { cfgDir, bin } = setup(prefix, taskScript);
  const api = fakeBotApi();
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  try {
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${api.server.port}`,
      },
      logFd,
      socketWaitMs: 8000,
    });
  } finally {
    closeSync(logFd);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000 && api.richMessages.length === 0 && api.sentMessages.length === 0) await Bun.sleep(50);
  // A wrong SECOND reply (a board after the error, or an error after the board) has no
  // positive signal to await — give the real daemon a short window to send it.
  await Bun.sleep(300);
  return api;
}

test("/tasks with a failing 'task list' → error reply naming the failure, not an empty board", async () => {
  const { richMessages, sentMessages } = await runTasks(
    'tgctl-tasks-failload-',
    '#!/bin/sh\necho "task-cli: backend unreachable" >&2\nexit 1\n',
  );
  expect(richMessages).toHaveLength(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
  expect(sentMessages[0].text as string).toContain('task-cli: backend unreachable');
}, 30_000);

test("/tasks when only ONE lifecycle-state 'task list' call fails → error reply, not a silently partial board", async () => {
  const { richMessages, sentMessages } = await runTasks(
    'tgctl-tasks-partial-',
    `#!/bin/sh
case "$*" in
  *"--state done"*) echo "task-cli: done view timed out" >&2; exit 2 ;;
esac
echo '[{"id":"#1","title":"Open ticket","state":"todo"}]'
`,
  );
  expect(richMessages).toHaveLength(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
  expect(sentMessages[0].text as string).toContain("'task list --state done' failed (exit 2)");
  expect(sentMessages[0].text as string).toContain('task-cli: done view timed out');
}, 30_000);

test("/tasks with 'task list' returning malformed JSON → error reply, not an empty board", async () => {
  const { richMessages, sentMessages } = await runTasks('tgctl-tasks-badjson-', "#!/bin/sh\necho '{not json'\n");
  expect(richMessages).toHaveLength(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
  expect(sentMessages[0].text as string).toMatch(/malformed JSON/);
}, 30_000);

test("/tasks with 'task list' returning non-array JSON → error reply, not an empty board", async () => {
  const { richMessages, sentMessages } = await runTasks(
    'tgctl-tasks-nonarray-',
    `#!/bin/sh\necho '{"error":"unexpected shape"}'\n`,
  );
  expect(richMessages).toHaveLength(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
  expect(sentMessages[0].text as string).toMatch(/non-array JSON/);
}, 30_000);

test('/tasks with a genuinely empty backlog (blank stdout, exit 0) → the board, not an error', async () => {
  const { richMessages, sentMessages } = await runTasks('tgctl-tasks-emptyok-', '#!/bin/sh\nexit 0\n');
  expect(sentMessages).toHaveLength(0);
  expect(richMessages).toHaveLength(1);
}, 30_000);
