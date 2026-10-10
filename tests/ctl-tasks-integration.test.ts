import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// Integration test for the /tasks bot command (tg-cli#115) against a fake Bot
// API and a fake Forgejo, with a stub `task` binary on PATH. Proves the daemon
// composes task-cli + Forgejo PR/CI/review data into a rich-HTML table and sends
// it via sendRichMessage. The scope checkout's `origin` names the fake forge and
// each candidate dir gets its own repo slug, so the forge's request log proves
// which directory the board was scoped to.

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


interface ForgePr {
  number: number;
  title: string;
  body?: string;
  draft?: boolean;
  /** Combined commit status state; absent = no statuses on the head commit. */
  ci?: 'success' | 'failure' | 'pending';
  reviews?: Array<{ id: number; login: string; state: string }>;
}

interface FakeForge {
  port: number;
  /** `owner/name` of every PR-list request, in order. */
  pullLists: string[];
  /** Every API path requested. */
  requests: string[];
}

// A Forgejo REST API stand-in serving the endpoints /tasks reads, per `owner/name` slug.
function startFakeForge(prsBySlug: Record<string, ForgePr[]> = {}): FakeForge {
  const forge: FakeForge = { port: 0, pullLists: [], requests: [] };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      forge.requests.push(url.pathname);
      if (req.headers.get('authorization') !== 'token test-token') return new Response('{}', { status: 401 });
      const m = url.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!m) return new Response('{}', { status: 404 });
      const slug = `${m[1]}/${m[2]}`;
      const prs = prsBySlug[slug] ?? [];
      const rest = m[3];
      if (rest === 'pulls') {
        forge.pullLists.push(slug);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const page = Number(url.searchParams.get('page') ?? 1);
        return Response.json(
          prs.slice((page - 1) * limit, page * limit).map((pr) => ({
            number: pr.number,
            title: pr.title,
            body: pr.body ?? '',
            html_url: `https://git.hyperide.ai/${slug}/pulls/${pr.number}`,
            state: 'open',
            draft: pr.draft ?? false,
            head: { sha: `sha${pr.number}` },
            requested_reviewers: [],
          })),
        );
      }
      const status = rest.match(/^commits\/sha(\d+)\/status$/);
      if (status) {
        const pr = prs.find((p) => p.number === Number(status[1]));
        return Response.json(pr?.ci ? { state: pr.ci, total_count: 1, statuses: [{ status: pr.ci }] } : { state: '', total_count: 0, statuses: [] });
      }
      const reviews = rest.match(/^pulls\/(\d+)\/reviews$/);
      if (reviews) {
        const pr = prs.find((p) => p.number === Number(reviews[1]));
        return Response.json((pr?.reviews ?? []).map((r) => ({ id: r.id, user: { login: r.login }, state: r.state, dismissed: false })));
      }
      return new Response('{}', { status: 404 });
    },
  });
  servers.push(server);
  forge.port = server.port;
  return forge;
}

// Make `dir` a git checkout whose origin is `slug` on the fake forge, and give the daemon's
// HOME an fj key store for the forge host — what `fj auth login` leaves behind.
function linkForgejo(dir: string, home: string, forge: FakeForge, slug = 'ultrabricks/tg-cli'): void {
  Bun.spawnSync(['git', 'init', '-q', dir]);
  Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', `http://127.0.0.1:${forge.port}/${slug}.git`]);
  const keysDir = join(home, '.local', 'share', 'forgejo-cli');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(
    join(keysDir, 'keys.json'),
    JSON.stringify({ hosts: { [`127.0.0.1:${forge.port}`]: { type: 'Application', name: 'test', token: 'test-token' } }, aliases: {}, default_ssh: [] }),
  );
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

const cfgDir = tempDir('tgctl-tasks-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const projectDir = join(cfgDir, 'project');
mkdirSync(projectDir);
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

const bin = join(cfgDir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
const taskInvocationLog = join(cfgDir, 'task-invocation.txt');
// Stub task-cli: two tickets, one with a due date.
const tasksJson = JSON.stringify([
  { id: '#117', title: 'A ticket', state: 'todo', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/117', due: '' },
  { id: '#5', title: 'Older ticket', state: 'in-progress', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/5', due: '2026-07-10', labels: ['blocked'] },
]);
writeFileSync(join(bin, 'task'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> '${taskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
// Fake Forgejo: a PR referencing #117 with green CI and an approval, and a draft PR for #5
// (a draft's verdict needs no reviews lookup).
const forge = startFakeForge({
  'ultrabricks/tg-cli': [
    { number: 200, title: 'fix thing (#117)', body: 'Closes #117', ci: 'success', reviews: [{ id: 1, login: 'rev', state: 'APPROVED' }] },
    { number: 201, title: 'wip', body: 'Refs #5', draft: true, ci: 'pending' },
  ],
});
linkForgejo(projectDir, cfgDir, forge);

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

test('/tasks composes task-cli + Forgejo into a rich-HTML table via sendRichMessage', async () => {
  await startTasksDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  expect(richMessages).toHaveLength(1);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain('<table>');
  // ticket ids linked
  expect(html).toContain('href="https://git.hyperide.ai/ultrabricks/tg-cli/issues/117"');
  expect(html).toContain('#117');
  // PR column filled for #117, with the head commit's CI verdict and the review verdict.
  expect(html).toContain('href="https://git.hyperide.ai/ultrabricks/tg-cli/pulls/200"');
  expect(html).toContain('<td>✓</td><td>✅</td>');
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
  // The PR list came from the scope checkout's origin; CI/review only for the matched PRs,
  // and no reviews lookup for the draft.
  expect(html).toContain('<td>…</td><td>✏️</td>');
  expect(forge.pullLists).toEqual(['ultrabricks/tg-cli']);
  expect(forge.requests).toContain('/api/v1/repos/ultrabricks/tg-cli/commits/sha200/status');
  expect(forge.requests).toContain('/api/v1/repos/ultrabricks/tg-cli/pulls/200/reviews');
  expect(forge.requests).toContain('/api/v1/repos/ultrabricks/tg-cli/commits/sha201/status');
  expect(forge.requests).not.toContain('/api/v1/repos/ultrabricks/tg-cli/pulls/201/reviews');
}, 15_000);

test('/tasks without selector follows the last-user-target anchor, not routes.json (tg-cli#271/#78 anchor fix — review finding)', async () => {
  // resolveTasksScopeDir now shares the SAME default-target anchor the daemon's
  // inbound routing uses (tg-cli#78) — routes.json's old "whoever spoke last"
  // fallback is gone. The anchor's pane-id-reuse guard (routeMatchesPane)
  // requires the anchor's recorded cwd to match the CANDIDATE'S LIVE
  // pane_current_path, so both live panes are given real (non-empty) paths here.
  const localCfgDir = tempDir('tgctl-tasks-route-');
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
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#9\",\"title\":\"Route task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  const localForge = startFakeForge();
  linkForgejo(routedDir, localCfgDir, localForge, 'o/routed-project');
  linkForgejo(newestDir, localCfgDir, localForge, 'o/newest-registration');

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
    expect(localForge.pullLists).toEqual(['o/routed-project']);
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
  const localCfgDir = tempDir('tgctl-tasks-noanchor-');
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
  const localForge = startFakeForge();
  linkForgejo(routedDir, localCfgDir, localForge, 'o/routed-project');
  linkForgejo(newestDir, localCfgDir, localForge, 'o/newest-registration');

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
    expect(localForge.requests).toEqual([]);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks matches duplicate task ids to PRs by repo identity, not worktree basename', async () => {
  const localCfgDir = tempDir('tgctl-tasks-dup-project-');
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
      project: 'ultrabricks/tg-cli',
      tickets: [{ id: '#1', title: 'Current repo duplicate', state: 'todo', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/current-1', due: '' }],
    },
    {
      project: 'other/repo',
      tickets: [{ id: '#1', title: 'Other repo duplicate', state: 'todo', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/other-1', due: '' }],
    },
  ]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  const prUrl = 'https://git.hyperide.ai/ultrabricks/tg-cli/pulls/700';
  linkForgejo(worktreeDir, localCfgDir, startFakeForge({ 'ultrabricks/tg-cli': [{ number: 700, title: 'fix duplicate #1', body: '' }] }));

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
  const localCfgDir = tempDir('tgctl-tasks-reply-');
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
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#10\",\"title\":\"Reply task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  const localForge = startFakeForge();
  linkForgejo(repliedDir, localCfgDir, localForge, 'o/replied-project');
  linkForgejo(latestDir, localCfgDir, localForge, 'o/latest-project');

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
    expect(localForge.pullLists).toEqual(['o/replied-project']);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks <agent> uses matching registration when tmux has no path', async () => {
  const localCfgDir = tempDir('tgctl-tasks-agent-');
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
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#11\",\"title\":\"Agent task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  const localForge = startFakeForge();
  linkForgejo(agentDir, localCfgDir, localForge, 'o/agent-project');

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
    expect(localForge.pullLists).toEqual(['o/agent-project']);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks without a resolvable project sends an explicit error instead of running in daemon cwd', async () => {
  const localCfgDir = tempDir('tgctl-tasks-noscope-');
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
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'ran\\n' > '${localTaskInvocationLog}'\nprintf '[]\\n'\n`, {
    mode: 0o755,
  });
  const localForge = startFakeForge();
  linkForgejo(projectA, localCfgDir, localForge, 'o/project-a');
  linkForgejo(projectB, localCfgDir, localForge, 'o/project-b');

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
    expect(localForge.requests).toEqual([]);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);

test('/tasks pagination callback sends the requested page with a filter keyboard', async () => {
  const localCfgDir = tempDir('tgctl-tasks-page-');
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
      project: 'ultrabricks/tg-cli',
      tickets: Array.from({ length: 11 }, (_, i) => ({
        id: `#${i + 1}`,
        title: `Forgotten task ${i + 1}`,
        state: 'todo',
        url: `https://git.hyperide.ai/ultrabricks/tg-cli/issues/${i + 1}`,
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
  // 54 unrelated PRs first, so the one referencing #11 is only on the second list page.
  const fillerPrs = Array.from({ length: 54 }, (_, i) => ({ number: 600 + i, title: `unrelated ${i}` }));
  const localForge = startFakeForge({ 'ultrabricks/tg-cli': [...fillerPrs, { number: 501, title: 'fix forgotten task #11', body: 'Closes #11' }] });
  linkForgejo(projectDir, localCfgDir, localForge);

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
    expect(localRichMessages[1].rich_message.html).toContain('🟢 Forgotten task 11');
    expect(localRichMessages[1].rich_message.html).toContain('href="https://git.hyperide.ai/ultrabricks/tg-cli/pulls/501"');
    expect(localRichMessages[1].rich_message.html).toContain('—');
    expect(localRichMessages[1].reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toContain('All');
    // Two board renders × two list pages each.
    expect(localForge.pullLists).toEqual(['ultrabricks/tg-cli', 'ultrabricks/tg-cli', 'ultrabricks/tg-cli', 'ultrabricks/tg-cli']);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks callback state is scoped by Telegram chat id as well as message id', async () => {
  const localCfgDir = tempDir('tgctl-tasks-chat-scope-');
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
  const tasksJson = JSON.stringify([{ id: '#60', title: 'Forgotten task', state: 'todo', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/60' }]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'task\\n' >> '${localTaskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  const localForge = startFakeForge();
  linkForgejo(projectDir, localCfgDir, localForge);

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
    expect(localForge.pullLists).toHaveLength(1);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks in a bound topic keeps the topic thread on the board and callbacks', async () => {
  const localCfgDir = tempDir('tgctl-tasks-topic-');
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
  const tasksJson = JSON.stringify([{ id: '#70', title: 'Topic task', state: 'todo', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/70' }]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${localTaskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  const localForge = startFakeForge();
  linkForgejo(projectDir, localCfgDir, localForge, 'o/project');
  linkForgejo(flatDir, localCfgDir, localForge, 'o/flat-project');

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
    expect(localForge.pullLists).toEqual(['o/project', 'o/project']);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 20_000);

test('/tasks render failure fallback stays in the bound topic reply context', async () => {
  const localCfgDir = tempDir('tgctl-tasks-topic-fallback-');
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  const projectDir = join(localCfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 123, name: 'Tasks', status: 'bound', paneId: '%1', path: projectDir, ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  const tasksJson = JSON.stringify([{ id: '#71', title: 'Topic task', state: 'todo', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/71' }]);
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
  linkForgejo(projectDir, localCfgDir, startFakeForge());

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
  const localCfgDir = tempDir('tgctl-tasks-topic-unresolved-');
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  writeFileSync(join(localCfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 123, name: 'Tasks', status: 'bound', paneId: '%1', ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(join(localBin, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  writeFileSync(join(localBin, 'task'), '#!/bin/sh\necho task should not run >&2\nexit 42\n', { mode: 0o755 });

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
  const localCfgDir = tempDir('tgctl-tasks-status-page-');
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
      url: `https://git.hyperide.ai/ultrabricks/tg-cli/issues/${index + 1}`,
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
  linkForgejo(projectDir, localCfgDir, startFakeForge());

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
  const localCfgDir = tempDir('tgctl-tasks-status-filter-');
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
  const doneTasks = JSON.stringify([{ id: '#40', title: 'Done task', state: 'done', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/40' }]);
  const activeTasks = JSON.stringify([{ id: '#41', title: 'Active task', state: 'in-progress', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/41' }]);
  const customStateTasks = JSON.stringify([{ id: '#42', title: 'Custom state task', state: 'waiting-for-user', url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/42' }]);
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
  linkForgejo(projectDir, localCfgDir, startFakeForge());

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
  const localCfgDir = tempDir('tgctl-tasks-stale-page-');
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
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'ran\\n' > '${localTaskInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });
  const localForge = startFakeForge();
  linkForgejo(projectDir, localCfgDir, localForge);

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
    expect(localForge.requests).toEqual([]);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
}, 15_000);
