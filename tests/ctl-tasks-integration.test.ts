import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

// Integration test for the /tasks bot command (tg-cli#115) against a fake Bot
// API, with stub `task` and `gh` binaries on PATH. Proves the daemon composes
// task-cli + gh into a rich-HTML table and sends it via sendRichMessage, with
// PR/CI columns filled from gh and a dash where a ticket has no PR.

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

async function startTasksDaemon(cfgDir: string, binDir: string, apiPort: number, logName = 'daemon.log'): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, logName), 'a');
  try {
    const daemon = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      },
      logFd,
      socketWaitMs: 8000,
    });
    expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
    return daemon;
  } finally {
    closeSync(logFd);
  }
}

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const projectDir = join(cfgDir, 'project');
mkdirSync(projectDir);
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

const bin = join(cfgDir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
const taskInvocationLog = join(cfgDir, 'task-invocation.txt');
const ghInvocationLog = join(cfgDir, 'gh-invocation.txt');
// Stub task-cli: two tickets, one with a due date.
const tasksJson = JSON.stringify([
  { id: '#117', title: 'A ticket', state: 'todo', url: 'https://gh/117', due: '' },
  { id: '#5', title: 'Older ticket', state: 'in-progress', url: 'https://gh/5', due: '2026-07-10', labels: ['blocked'] },
]);
writeFileSync(join(bin, 'task'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> '${taskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
// Stub gh: one PR referencing #117 with a failing check; #5 has none.
const prsJson = JSON.stringify([
  {
    number: 200,
    title: 'fix thing (#117)',
    url: 'https://gh/pr/200',
    body: 'Closes #117',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
  },
]);
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${ghInvocationLog}'\ncat <<'JSON'\n${prsJson}\nJSON\n`, { mode: 0o755 });

let served = false;
const richMessages: any[] = [];
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
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendRichMessage')) {
      richMessages.push(await req.json());
      return Response.json({ ok: true, result: { message_id: 88 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});
servers.push(server);

test('/tasks composes task-cli + gh into a rich-HTML table via sendRichMessage', async () => {
  await startTasksDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  expect(richMessages).toHaveLength(1);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain('<table>');
  // ticket ids linked
  expect(html).toContain('href="https://gh/117"');
  expect(html).toContain('#117');
  // PR column filled for #117, CI shows the failing glyph
  expect(html).toContain('href="https://gh/pr/200"');
  expect(html).toContain('✗');
  // #5 has a due date and NO pr → an em dash somewhere
  expect(html).toContain('2026-07-10');
  expect(html).toContain('—');
  const taskInvocation = readFileSync(taskInvocationLog, 'utf8');
  expect(taskInvocation).toContain(`-C ${projectDir}`);
  expect(taskInvocation).toContain('-n 100');
  for (const state of ['todo', 'in-progress', 'in-review', 'done', 'cancelled']) {
    expect(taskInvocation).toContain(`--state ${state}`);
  }
  expect(taskInvocation).not.toContain('--all');
  expect(readFileSync(ghInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(projectDir));
}, 15_000);

test('/tasks without selector follows the last-user-target anchor, not routes.json (tg-cli#271/#78 anchor fix — review finding)', async () => {
  // resolveTasksScopeDir now shares the SAME default-target anchor the daemon's
  // inbound routing uses (tg-cli#78) — routes.json's old "whoever spoke last"
  // fallback is gone. The anchor's pane-id-reuse guard (routeMatchesPane)
  // requires the anchor's recorded cwd to match the CANDIDATE'S LIVE
  // pane_current_path, so both live panes are given real (non-empty) paths here.
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-route-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const routedDir = join(localCfgDir, 'routed-project');
  const newestDir = join(localCfgDir, 'newest-registration');
  mkdirSync(routedDir);
  mkdirSync(newestDir);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: routedDir, registeredAt: 1 },
      { paneId: '%2', cwd: newestDir, registeredAt: 2 },
    ]),
  );
  // routes.json still has a (now-irrelevant) entry for %1 — proves it is NOT what
  // resolves the ambiguity anymore; the anchor below is.
  writeFileSync(join(localCfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 77, paneId: '%1', cwd: routedDir, ts: 1 }]));
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.last-user-target.json'),
    JSON.stringify({ paneId: '%1', cwd: routedDir, ts: 1 }),
  );

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'routed' '' '${routedDir}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'newest' '' '${newestDir}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });

  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#9\",\"title\":\"Route task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localGhInvocationLog}'\nprintf '[]\\n'\n`,
    { mode: 0o755 },
  );

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 301,
                message: {
                  message_id: 11,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 89 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 1)).toBe(true);
    expect(localRichMessages).toHaveLength(1);
    expect(localRichMessages[0].rich_message.html).not.toContain('routed-project');
    expect(readFileSync(localTaskInvocationLog, 'utf8')).toContain(`-C ${routedDir}`);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).not.toContain(`-C ${newestDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(routedDir));
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks without selector: routes.json ALONE (no anchor) no longer resolves an ambiguous fleet (review finding: proves the old fallback is gone)', async () => {
  // Same ambiguous 2-pane fleet and the SAME routes.json entry for %1 as the
  // test above, but with NO last-user-target.json anchor written. Before this
  // fix, routes.json's "whoever spoke last" alone would have resolved this to
  // %1 (routed-project). Now it must send the explicit "not resolvable" error
  // instead of guessing — proving the routes.json fallback is genuinely gone,
  // not just shadowed by the anchor when both are present.
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-noanchor-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const routedDir = join(localCfgDir, 'routed-project');
  const newestDir = join(localCfgDir, 'newest-registration');
  mkdirSync(routedDir);
  mkdirSync(newestDir);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: routedDir, registeredAt: 1 },
      { paneId: '%2', cwd: newestDir, registeredAt: 2 },
    ]),
  );
  writeFileSync(join(localCfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 77, paneId: '%1', cwd: routedDir, ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'routed' '' '${routedDir}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'newest' '' '${newestDir}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });
  writeFileSync(join(localBin, 'task'), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });
  writeFileSync(join(localBin, 'gh'), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });

  let servedLocal = false;
  const localTextMessages: string[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 302,
                message: {
                  message_id: 12,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        localTextMessages.push(body.text ?? '');
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localTextMessages.length === 1)).toBe(true);
    expect(existsSync(join(localCfgDir, 'task-invocation.txt'))).toBe(false);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks matches duplicate task ids to PRs by repo identity, not worktree basename', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-dup-project-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const worktreeDir = join(localCfgDir, 'tg-cli-wt-178-tasks-view');
  mkdirSync(worktreeDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: worktreeDir, registeredAt: 2 }));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const tasksJson = JSON.stringify([
    {
      project: 'alex-mextner/tg-cli',
      tickets: [{ id: '#1', title: 'Current repo duplicate', state: 'todo', url: 'https://gh/current-1', due: '' }],
    },
    {
      project: 'other/repo',
      tickets: [{ id: '#1', title: 'Other repo duplicate', state: 'todo', url: 'https://gh/other-1', due: '' }],
    },
  ]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  const prUrl = 'https://github.com/alex-mextner/tg-cli/pull/700';
  const prsJson = JSON.stringify([
    {
      number: 700,
      title: 'fix duplicate #1',
      url: prUrl,
      body: '',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
  ]);
  writeFileSync(join(localBin, 'gh'), `#!/bin/sh\ncat <<'JSON'\n${prsJson}\nJSON\n`, { mode: 0o755 });

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 302,
                message: {
                  message_id: 12,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 94 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 1)).toBe(true);
    const html = localRichMessages[0].rich_message.html as string;
    expect(html).toContain('Current repo duplicate');
    expect(html).toContain('Other repo duplicate');
    expect(html.split(prUrl).length - 1).toBe(1);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks reply scopes to the replied-to agent instead of the latest sender', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-reply-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const repliedDir = join(localCfgDir, 'replied-project');
  const latestDir = join(localCfgDir, 'latest-project');
  mkdirSync(repliedDir);
  mkdirSync(latestDir);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: repliedDir, registeredAt: 1 },
      { paneId: '%2', cwd: latestDir, registeredAt: 2 },
    ]),
  );
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([
      { id: 77, paneId: '%1', cwd: repliedDir, ts: 1 },
      { id: 88, paneId: '%2', cwd: latestDir, ts: 2 },
    ]),
  );

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'replied' '' '${repliedDir}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'latest' '' '${latestDir}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });

  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#10\",\"title\":\"Reply task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localGhInvocationLog}'\nprintf '[]\\n'\n`,
    { mode: 0o755 },
  );

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 302,
                message: {
                  message_id: 12,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                  reply_to_message: { message_id: 77 },
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 92 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 1)).toBe(true);
    expect(localRichMessages).toHaveLength(1);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).toContain(`-C ${repliedDir}`);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).not.toContain(`-C ${latestDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(repliedDir));
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks <agent> uses matching registration when tmux has no path', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-agent-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const agentDir = join(localCfgDir, 'agent-project');
  mkdirSync(agentDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify([{ paneId: '%1', cwd: agentDir, registeredAt: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'routed' '' '' ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n'\n", { mode: 0o755 });

  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#11\",\"title\":\"Agent task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localGhInvocationLog}'\nprintf '[]\\n'\n`,
    { mode: 0o755 },
  );

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 303,
                message: {
                  message_id: 13,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks routed',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 93 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 1)).toBe(true);
    expect(localRichMessages).toHaveLength(1);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).toContain(`-C ${agentDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(agentDir));
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks without a resolvable project sends an explicit error instead of running in daemon cwd', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-noscope-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectA = join(localCfgDir, 'project-a');
  const projectB = join(localCfgDir, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: projectA, registeredAt: 1 },
      { paneId: '%2', cwd: projectB, registeredAt: 2 },
    ]),
  );

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'a' '' '${projectA}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'b' '' '${projectB}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'ran\\n' > '${localTaskInvocationLog}'\nprintf '[]\\n'\n`, {
    mode: 0o755,
  });
  writeFileSync(join(localBin, 'gh'), `#!/bin/sh\nprintf 'ran\\n' > '${localGhInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });

  let servedLocal = false;
  const localTextMessages: any[] = [];
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 302,
                message: {
                  message_id: 12,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        localTextMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 91 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localTextMessages.length === 1)).toBe(true);
    expect(localTextMessages).toHaveLength(1);
    expect(localTextMessages[0].text).toContain("couldn't resolve a project for /tasks");
    expect(localRichMessages).toHaveLength(0);
    expect(existsSync(localTaskInvocationLog)).toBe(false);
    expect(existsSync(localGhInvocationLog)).toBe(false);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks pagination callback sends the requested page with a filter keyboard', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-page-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const ackMarker = join(localCfgDir, 'callback-ack');
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');

  const allTasks = JSON.stringify([
    {
      project: 'alex-mextner/tg-cli',
      tickets: Array.from({ length: 11 }, (_, i) => ({
        id: `#${i + 1}`,
        title: `Forgotten task ${i + 1}`,
        state: 'todo',
        url: `https://gh/${i + 1}`,
        labels: [],
        due: '',
      })),
    },
  ]);
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh
if [ -f '${ackMarker}' ]; then
  printf 'yes\\n' >> '${localTaskInvocationLog}'
else
  printf 'no\\n' >> '${localTaskInvocationLog}'
fi
cat <<'JSON'
${allTasks}
JSON
`,
    { mode: 0o755 },
  );
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  const prsJson = JSON.stringify([
    {
      number: 501,
      title: 'fix forgotten task #11',
      url: 'https://gh/pr/501',
      body: 'Closes #11',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    },
  ]);
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "$PWD" >> '${localGhInvocationLog}'\ncat <<'JSON'\n${prsJson}\nJSON\n`,
    { mode: 0o755 },
  );

  let servedCommand = false;
  let servedCallback = false;
  let callbackData: string | null = null;
  let taskBoardMessageId: number | null = null;
  const localRichMessages: any[] = [];
  const answeredCallbacks: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 400,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        if (callbackData && !servedCallback) {
          servedCallback = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 401,
                callback_query: {
                  id: 'cb_page',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: taskBoardMessageId!, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        const body = await req.json();
        localRichMessages.push(body);
        taskBoardMessageId = 88 + localRichMessages.length;
        const rows = body.reply_markup?.inline_keyboard ?? [];
        const next = rows.flat().find((b: any) => b.callback_data === 'tgt:page:attention:1');
        if (next) callbackData = next.callback_data;
        return Response.json({ ok: true, result: { message_id: taskBoardMessageId } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        writeFileSync(ackMarker, '1');
        answeredCallbacks.push({ ...(await req.json()), richCount: localRichMessages.length });
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 2 && answeredCallbacks.length === 1)).toBe(true);
    expect(localRichMessages).toHaveLength(2);
    expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb_page', text: 'updating', richCount: 1 }]);
    const taskAckStates = readFileSync(localTaskInvocationLog, 'utf8').trim().split('\n');
    expect(taskAckStates.filter((state) => state === 'no')).toHaveLength(5);
    expect(taskAckStates.filter((state) => state === 'yes')).toHaveLength(5);
    expect(localRichMessages[0].rich_message.html).toContain('Forgotten task 1');
    expect(localRichMessages[0].rich_message.html).not.toContain('Forgotten task 11');
    expect(localRichMessages[1].rich_message.html).toContain('Forgotten task 11');
    expect(localRichMessages[1].rich_message.html).toContain('🔴 Forgotten task 11');
    expect(localRichMessages[1].rich_message.html).toContain('href="https://gh/pr/501"');
    expect(localRichMessages[1].rich_message.html).toContain('✗');
    expect(localRichMessages[1].reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toContain('All');
    expect(readFileSync(localGhInvocationLog, 'utf8').trim().split('\n')).toEqual([realpathSync(projectDir), realpathSync(projectDir)]);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks callback state is scoped by Telegram chat id as well as message id', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-chat-scope-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  const tasksJson = JSON.stringify([{ id: '#60', title: 'Forgotten task', state: 'todo', url: 'https://gh/60' }]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'task\\n' >> '${localTaskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  writeFileSync(join(localBin, 'gh'), `#!/bin/sh\nprintf 'gh\\n' >> '${localGhInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });

  let servedCommand = false;
  let servedWrongChatCallback = false;
  let taskBoardMessageId: number | null = null;
  const localRichMessages: any[] = [];
  const answeredCallbacks: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 420,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        if (taskBoardMessageId !== null && !servedWrongChatCallback) {
          servedWrongChatCallback = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 421,
                callback_query: {
                  id: 'cb_wrong_chat',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: taskBoardMessageId, chat: { id: 2 }, date: Math.floor(Date.now() / 1000) },
                  data: 'tgt:filter:all:0',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        taskBoardMessageId = 88;
        return Response.json({ ok: true, result: { message_id: taskBoardMessageId } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 1 && answeredCallbacks.length === 1)).toBe(true);
    expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb_wrong_chat', text: 'expired' }]);
    expect(localRichMessages).toHaveLength(1);
    expect(readFileSync(localTaskInvocationLog, 'utf8').trim().split('\n')).toHaveLength(5);
    expect(readFileSync(localGhInvocationLog, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks in a bound topic keeps the topic thread on the board and callbacks', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-topic-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  const projectDir = join(localCfgDir, 'project');
  const flatDir = join(localCfgDir, 'flat-project');
  mkdirSync(projectDir);
  mkdirSync(flatDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: flatDir, registeredAt: 2 }));
  writeFileSync(join(localCfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 123, name: 'Tasks', status: 'bound', paneId: '%1', path: projectDir, ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), '#!/bin/sh\nprintf "111 1 claude\\n"\n', { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  const tasksJson = JSON.stringify([{ id: '#70', title: 'Topic task', state: 'todo', url: 'https://gh/70' }]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${localTaskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  writeFileSync(join(localBin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$PWD" >> '${localGhInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });

  let servedCommand = false;
  let servedCallback = false;
  let taskBoardMessageId: number | null = null;
  const localRichMessages: any[] = [];
  const answeredCallbacks: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 430,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  message_thread_id: 123,
                  is_topic_message: true,
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        if (taskBoardMessageId !== null && !servedCallback) {
          servedCallback = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 431,
                callback_query: {
                  id: 'cb_topic_all',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: taskBoardMessageId, chat: { id: 1 }, message_thread_id: 123, date: Math.floor(Date.now() / 1000) },
                  data: 'tgt:filter:all:0',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        taskBoardMessageId = 88 + localRichMessages.length;
        return Response.json({ ok: true, result: { message_id: taskBoardMessageId } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 2 && answeredCallbacks.length === 1)).toBe(true);
    expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb_topic_all', text: 'updating' }]);
    expect(localRichMessages.map((body) => body.message_thread_id)).toEqual([123, 123]);
    const taskInvocations = readFileSync(localTaskInvocationLog, 'utf8').trim().split('\n');
    expect(taskInvocations).toHaveLength(11);
    for (const invocation of taskInvocations) expect(invocation).toContain(`-C ${projectDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').trim().split('\n')).toEqual([realpathSync(projectDir), realpathSync(projectDir)]);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks render failure fallback stays in the bound topic reply context', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-topic-fallback-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 123, name: 'Tasks', status: 'bound', paneId: '%1', path: projectDir, ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const tasksJson = JSON.stringify([{ id: '#71', title: 'Topic task', state: 'todo', url: 'https://gh/71' }]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  writeFileSync(join(localBin, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });

  let servedCommand = false;
  const localTextMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 440,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  message_thread_id: 123,
                  is_topic_message: true,
                  reply_to_message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'agent output' },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) return Response.json({ ok: true, result: {} });
      if (url.pathname.endsWith('/sendMessage')) {
        localTextMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localTextMessages.length === 1)).toBe(true);
    expect(localTextMessages[0]).toMatchObject({
      text: "couldn't render the task board — see the daemon log",
      message_thread_id: 123,
      reply_parameters: { message_id: 77 },
    });
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks in a pathless topic fails closed in the topic reply context', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-topic-unresolved-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(localCfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 123, name: 'Tasks', status: 'bound', paneId: '%1', ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'task'), '#!/bin/sh\necho task should not run >&2\nexit 42\n', { mode: 0o755 });
  writeFileSync(join(localBin, 'gh'), '#!/bin/sh\necho gh should not run >&2\nexit 42\n', { mode: 0o755 });

  let servedCommand = false;
  const localTextMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 450,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  message_thread_id: 123,
                  is_topic_message: true,
                  reply_to_message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'agent output' },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        localTextMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localTextMessages.length === 1)).toBe(true);
    expect(localTextMessages[0]).toMatchObject({
      text: "couldn't resolve a project for /tasks — reply to an agent message or use /tasks <agent>",
      message_thread_id: 123,
      reply_parameters: { message_id: 77 },
    });
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks status-scoped pagination keeps the status label on page callbacks', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-status-page-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const doneTasks = JSON.stringify(
    Array.from({ length: 11 }, (_, index) => ({
      id: `#${index + 1}`,
      title: `Done task ${index + 1}`,
      state: 'done',
      url: `https://gh/${index + 1}`,
    })),
  );
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh
state=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--state" ]; then
    shift
    state="$1"
  fi
  shift || break
done
printf '%s\\n' "$state" >> '${localTaskInvocationLog}'
case "$state" in
  done) cat <<'JSON'
${doneTasks}
JSON
    ;;
  *) printf '[]\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });

  let servedCommand = false;
  let servedCallback = false;
  let callbackData: string | null = null;
  let taskBoardMessageId: number | null = null;
  const localRichMessages: any[] = [];
  const answeredCallbacks: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 460,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks done',
                },
              },
            ],
          });
        }
        if (callbackData && !servedCallback) {
          servedCallback = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 461,
                callback_query: {
                  id: 'cb_done_page',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: taskBoardMessageId!, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        const body = await req.json();
        localRichMessages.push(body);
        taskBoardMessageId = 94 + localRichMessages.length;
        const rows = body.reply_markup?.inline_keyboard ?? [];
        const next = rows.flat().find((b: any) => b.callback_data === 'tgt:page:all:1');
        if (next) callbackData = next.callback_data;
        return Response.json({ ok: true, result: { message_id: taskBoardMessageId } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 2 && answeredCallbacks.length === 1)).toBe(true);
    expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb_done_page', text: 'updating' }]);
    expect(localRichMessages[0].rich_message.html).toContain('— <b>Done</b> page 1/2');
    expect(localRichMessages[1].rich_message.html).toContain('— <b>Done</b> page 2/2');
    expect(localRichMessages[1].rich_message.html).not.toContain('— <b>All</b>');
    expect(localRichMessages[1].rich_message.html).toContain('Done task 11');
    expect(readFileSync(localTaskInvocationLog, 'utf8').trim().split('\n')).toEqual(['done', 'done']);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks All quick filter callback unpins an explicit status board', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-status-filter-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const doneTasks = JSON.stringify([{ id: '#40', title: 'Done task', state: 'done', url: 'https://gh/40' }]);
  const activeTasks = JSON.stringify([{ id: '#41', title: 'Active task', state: 'in-progress', url: 'https://gh/41' }]);
  const customStateTasks = JSON.stringify([{ id: '#42', title: 'Custom state task', state: 'waiting-for-user', url: 'https://gh/42' }]);
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh
state=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--state" ]; then
    shift
    state="$1"
  fi
  shift || break
done
printf '%s\\n' "$state" >> '${localTaskInvocationLog}'
case "$state" in
  done) cat <<'JSON'
${doneTasks}
JSON
    ;;
  in-progress) cat <<'JSON'
${activeTasks}
JSON
    ;;
  '') cat <<'JSON'
${customStateTasks}
JSON
    ;;
  *) printf '[]\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });

  let servedCommand = false;
  let servedCallback = false;
  let callbackData: string | null = null;
  let taskBoardMessageId: number | null = null;
  const localRichMessages: any[] = [];
  const answeredCallbacks: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCommand) {
          servedCommand = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 420,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks done',
                },
              },
            ],
          });
        }
        if (callbackData && !servedCallback) {
          servedCallback = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 421,
                callback_query: {
                  id: 'cb_all',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: taskBoardMessageId!, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: callbackData,
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        const body = await req.json();
        localRichMessages.push(body);
        taskBoardMessageId = 92 + localRichMessages.length;
        const rows = body.reply_markup?.inline_keyboard ?? [];
        const all = rows.flat().find((b: any) => b.callback_data === 'tgt:filter:all:0');
        if (all) callbackData = all.callback_data;
        return Response.json({ ok: true, result: { message_id: taskBoardMessageId } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => localRichMessages.length === 2 && answeredCallbacks.length === 1)).toBe(true);
    expect(localRichMessages).toHaveLength(2);
    expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb_all', text: 'updating' }]);
    expect(localRichMessages[0].rich_message.html).toContain('Done task');
    expect(localRichMessages[0].rich_message.html).toContain('— <b>Done</b>');
    expect(localRichMessages[0].rich_message.html).not.toContain('— <b>All</b>');
    expect(localRichMessages[1].rich_message.html).toContain('Active task');
    expect(localRichMessages[1].rich_message.html).toContain('Done task');
    expect(localRichMessages[1].rich_message.html).toContain('Custom state task');
    const states = readFileSync(localTaskInvocationLog, 'utf8').trim().split('\n');
    expect(states[0]).toBe('done');
    expect(states.slice(1).sort()).toEqual(['', 'cancelled', 'done', 'in-progress', 'in-review', 'todo'].sort());
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks stale pagination callback answers expired without guessing a project', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-stale-page-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'ran\\n' > '${localTaskInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });
  writeFileSync(join(localBin, 'gh'), `#!/bin/sh\nprintf 'ran\\n' > '${localGhInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });

  let servedCallback = false;
  const localRichMessages: any[] = [];
  const answeredCallbacks: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedCallback) {
          servedCallback = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 410,
                callback_query: {
                  id: 'cb_stale_page',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 999, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                  data: 'tgt:attention:1',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(await req.json());
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    daemon = await startTasksDaemon(localCfgDir, localBin, localServer.port);

    expect(await waitFor(() => answeredCallbacks.length === 1)).toBe(true);
    expect(answeredCallbacks).toEqual([{ callback_query_id: 'cb_stale_page', text: 'expired' }]);
    expect(localRichMessages).toHaveLength(0);
    expect(existsSync(localTaskInvocationLog)).toBe(false);
    expect(existsSync(localGhInvocationLog)).toBe(false);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);
