import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// End-to-end flat `/new` command (issue #27): the REAL daemon + a fake Telegram server + a fake
// tmux/ps. A `/new [<model>] [<dir>] name [<task>]` message drives the interactive flow (ask dir →
// ask model via buttons → `tmux new-window` spawn into a named window). The fake tmux's new-window
// logs its full argv so a test asserts the spawn shape (model argv, -c <dir>, -n <slug>, the task
// as a trailing prompt arg). Distinct from the forum-topics spawn (no topic, no binding) — this
// exercises the in-memory pending-session machine + the non-topic spawn path.
//
// Load-bearing guarantees (this is the CTO's daily lifeline daemon):
//   1. `/new <name>` → dir button tap → model button tap SPAWNS exactly one agent in the named
//      window, with the model argv + -c <dir>.
//   2. `/new <model> <dir> <name> <task>` with everything supplied spawns IMMEDIATELY (no buttons),
//      passing the task as the agent's initial prompt arg.
//   3. `/new` with no name replies with the usage hint and does NOT spawn.
//   4. A TYPED absolute path answers the dir step (not only the buttons).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SPAWNED_PANE = '%8';

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];
const cfgDirs: string[] = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
  for (const d of cfgDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Fake tmux: list-panes reports one pre-existing claude pane (%1) so sessionForSpawn has a target;
// new-window prints SPAWNED_PANE and logs its full argv; set-option/send-keys are accepted no-ops.
function fakeTmux(cwd: string, spawnLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window)
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option) : ;;
  send-keys) : ;;
  load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '4241' '1' 'claude'
exit 0
`;
}

// A fake tmux whose new-window EXITS 1 while $failFlag exists (models a spawn failure), then
// succeeds (logging argv) once the flag is removed — so a test can drive the failure→retry path.
function fakeTmuxFailable(cwd: string, spawnLog: string, failFlag: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}' ;;
  display-message) printf 'main\\n' ;;
  new-window)
    if [ -f '${failFlag}' ]; then echo 'no current session' >&2; exit 1; fi
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option) : ;; send-keys) : ;; load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

// A fake tmux that LOGS every send-keys/load-buffer inject to $injectLog (so a test can prove a
// message reached the live agent pane), and answers new-window with SPAWNED_PANE.
function fakeTmuxLoggingInjects(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}' ;;
  display-message) printf 'main\\n' ;;
  new-window) printf '%s\\n' '${SPAWNED_PANE}' ;;
  set-option) : ;;
  send-keys)
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer) cat >> '${injectLog}'; printf '\\n' >> '${injectLog}' ;;
esac
exit 0
`;
}

function makeCfgDir(topics: boolean): { cfgDir: string; spawnLog: string } {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-new-'));
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    `control:\n  enabled: true\n  topics: ${topics}\n  private_topics: false\n`,
  );
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return { cfgDir, spawnLog };
}

function spawnArgvLog(spawnLog: string): string[] {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

// `updateQueue` is the LIVE array the server drains one batch per poll — a test may PUSH more
// batches as the flow advances (the closure reads the same array reference).
function makeServer(updateQueue: unknown[][]): {
  server: ReturnType<typeof Bun.serve>;
  sends: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sends.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  return { server, sends };
}

// `date` must be CURRENT (the daemon drops messages older than stalenessSec, 300s) — a date of 0
// would be "skipped N stale", never processed.
const nowSec = (): number => Math.floor(Date.now() / 1000);

function textMsg(id: number, text: string): unknown {
  return { update_id: id, message: { message_id: id, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec(), text } };
}

function dirTap(id: number, token: string, index: number): unknown {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: 1, first_name: 'Alex' }, message: { message_id: id, chat: { id: 1 }, date: 0 }, data: `tnp:${token}:${index}` },
  };
}

function modelTap(id: number, token: string, modelId: string): unknown {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: 1, first_name: 'Alex' }, message: { message_id: id, chat: { id: 1 }, date: 0 }, data: `tnm:${token}:${modelId}` },
  };
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${apiPort}` },
    logFd,
  });
  closeSync(logFd);
  return daemon;
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

const sent = (sends: Array<Record<string, unknown>>, needle: string): boolean =>
  sends.some((s) => String(s.text ?? '').includes(needle));

test('full /new flow: command → dir tap → model tap spawns one agent in the named window', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  // LIVE queue: start with /new, push later batches as the prompts arrive. The daemon mints the
  // session token `n1` for the first /new of its lifetime.
  const queue: unknown[][] = [[textMsg(10, '/new myproj')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);

  await waitFor(() => sent(sends, 'New agent `myproj`'));
  expect(sent(sends, 'New agent `myproj`')).toBe(true);

  // Tap dir button index 0 (the cfgDir, the only/newest recent cwd).
  queue.push([dirTap(11, 'n1', 0)]);
  await waitFor(() => sent(sends, 'Which model should `myproj` run?'));
  expect(sent(sends, 'Which model should `myproj` run?')).toBe(true);

  // Tap the model button.
  queue.push([modelTap(12, 'n1', 'claude-opus')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  expect(argv[0]).toContain('-n myproj');
  expect(argv[0]).toContain(`-c ${cfgDir}`);
  expect(argv[0]).toContain('claude --model opus');

  await waitFor(() => sent(sends, 'spawned `claude-opus`'));
  expect(sent(sends, 'spawned `claude-opus`')).toBe(true);
  daemon.kill();
});

test('/new with model+dir+name+task spawns immediately, task as the initial prompt arg', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const { server, sends } = makeServer([[textMsg(20, `/new opus ${cfgDir} api fix the build`)]]);
  const daemon = await startDaemon(cfgDir, server.port);

  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  expect(argv[0]).toContain('-n api');
  expect(argv[0]).toContain(`-c ${cfgDir}`);
  expect(argv[0]).toContain('claude --model opus');
  // The task is the trailing positional prompt, AFTER a `--` end-of-options separator (review #1).
  expect(argv[0]).toContain('-- fix the build');

  await waitFor(() => sent(sends, 'spawned `claude-opus`'));
  expect(sent(sends, 'with task: fix the build')).toBe(true);
  daemon.kill();
});

test('a task beginning with a dash is passed after `--`, not parsed as a flag (review #1)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const { server, sends } = makeServer([[textMsg(95, `/new claude-default ${cfgDir} dashtask --continue please`)]]);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  // The `--` precedes the dash-prefixed task so the agent treats it as a prompt, not a flag.
  expect(argv[0]).toContain('-- --continue please');
  await waitFor(() => sent(sends, 'spawned `claude-default`'));
  daemon.kill();
});

test('/new with no name replies usage and does NOT spawn', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const { server, sends } = makeServer([[textMsg(30, '/new')]]);
  const daemon = await startDaemon(cfgDir, server.port);

  await waitFor(() => sent(sends, 'usage: /new'));
  expect(sent(sends, 'usage: /new')).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(spawnLog)).toEqual([]);
  daemon.kill();
});

test('/new <name> then a TYPED absolute path advances to the model step and spawns on a model tap', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(40, '/new typed')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);

  await waitFor(() => sent(sends, 'New agent `typed`'));
  // Type the absolute path instead of tapping a button (cfgDir is a real dir).
  queue.push([textMsg(41, cfgDir)]);
  await waitFor(() => sent(sends, 'Which model should `typed` run?'));
  expect(sent(sends, 'Which model should `typed` run?')).toBe(true);

  queue.push([modelTap(42, 'n1', 'claude-default')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  expect(argv[0]).toContain('-n typed');
  expect(argv[0]).toContain(`-c ${cfgDir}`);
  daemon.kill();
});

// A fake tmux whose list-panes reports a window already NAMED `myproj` (column 6), for the
// name-collision warning. Otherwise identical to fakeTmux.
function fakeTmuxWithWindow(cwd: string, spawnLog: string, windowName: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' '${windowName}' '' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window) printf 'new-window %s\\n' "$*" >> '${spawnLog}'; printf '%s\\n' '${SPAWNED_PANE}' ;;
  set-option) : ;; send-keys) : ;; load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

test('/new <name> whose slug collides with a live window WARNS but still proceeds (review #5)', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-new-'));
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n  private_topics: false\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxWithWindow(cfgDir, spawnLog, 'myproj'), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });

  const { server, sends } = makeServer([[textMsg(50, '/new myproj')]]);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'already exists'));
  expect(sent(sends, 'a window named `myproj` already exists')).toBe(true);
  // Still proceeds to ask for a dir (the warning is non-blocking).
  await waitFor(() => sent(sends, 'New agent `myproj`'));
  expect(sent(sends, 'New agent `myproj`')).toBe(true);
  daemon.kill();
});

test('an unknown model tap re-asks and does NOT spawn (review #5)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(60, `/new ${cfgDir} um`)]]; // dir supplied → straight to model step
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which model should `um` run?'));

  // A forged/stale callback with a model id not in the catalog.
  queue.push([modelTap(61, 'n1', 'gpt-9')]);
  await waitFor(() => sent(sends, 'unknown model'));
  expect(sent(sends, 'unknown model `gpt-9`')).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // never spawned
  daemon.kill();
});

test('REGRESSION (review #1): ordinary prose mid-/new still reaches the agent (not swallowed)', async () => {
  const { cfgDir } = makeCfgDir(false);
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxLoggingInjects(cfgDir, injectLog), { mode: 0o755 });
  const queue: unknown[][] = [[textMsg(70, '/new pending')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `pending`'));
  // Now send ordinary prose (no leading slash) while awaiting-dir — it must inject, NOT be eaten.
  queue.push([textMsg(71, 'hello there agent')]);
  await waitFor(() => (existsSync(injectLog) ? readFileSync(injectLog, 'utf8').includes('hello there agent') : false));
  expect(existsSync(injectLog) && readFileSync(injectLog, 'utf8').includes('hello there agent')).toBe(true);
  daemon.kill();
});

test('/new <model> <name> (dir via flow) spawns with the supplied model, skipping the model prompt', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(90, '/new opus mdl')]]; // model on the line, no dir → ask dir only
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `mdl`'));
  // Tap the dir button — with the model already chosen, this spawns directly (NO model prompt).
  queue.push([dirTap(91, 'n1', 0)]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  expect(argv[0]).toContain('claude --model opus');
  expect(sent(sends, 'Which model should')).toBe(false); // model prompt was skipped
  expect(sent(sends, 'spawned `claude-opus`')).toBe(true);
  daemon.kill();
});

test('a spawn FAILURE leaves the session retryable and re-posts the model keyboard (review #3/#5)', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-new-'));
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  const failFlag = join(cfgDir, 'FAIL_SPAWN');
  writeFileSync(failFlag, '1'); // arm the failure
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n  private_topics: false\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxFailable(cfgDir, spawnLog, failFlag), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });

  // dir on the line → straight to model step; the tap triggers the (failing) spawn.
  const queue: unknown[][] = [[textMsg(110, `/new ${cfgDir} retryme`)]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which model should `retryme` run?'));
  queue.push([modelTap(111, 'n1', 'claude-default')]);

  // The spawn fails → an error posts AND a fresh model keyboard is re-offered (session retryable).
  await waitFor(() => sent(sends, "couldn't start the agent"));
  expect(sent(sends, "couldn't start the agent")).toBe(true);
  // The model prompt re-appears (count >= 2: the first ask + the re-ask after failure).
  const modelPrompts = sends.filter((s) => String(s.text ?? '').includes('Which model should `retryme` run?'));
  expect(modelPrompts.length).toBeGreaterThanOrEqual(2);

  // Now clear the failure and re-tap → it spawns.
  rmSync(failFlag, { force: true });
  queue.push([modelTap(112, 'n1', 'claude-default')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  expect(spawnArgvLog(spawnLog).length).toBe(1);
  await waitFor(() => sent(sends, 'spawned `claude-default`'));
  expect(sent(sends, 'spawned `claude-default`')).toBe(true);
  daemon.kill();
});

test('a typed path that is a FILE (not a directory) is rejected (review #5)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const filePath = join(cfgDir, '.env'); // a real FILE in the cfgDir, not a directory
  const queue: unknown[][] = [[textMsg(120, '/new filecheck')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `filecheck`'));
  queue.push([textMsg(121, filePath)]);
  await waitFor(() => sent(sends, 'is not an absolute path'));
  expect(sent(sends, 'is not an absolute path')).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // a file path never spawns
  daemon.kill();
});

test('a typed filesystem root `/` is rejected as a cwd (review #4)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(100, '/new rootcheck')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `rootcheck`'));
  queue.push([textMsg(101, '/')]);
  await waitFor(() => sent(sends, "filesystem root"));
  expect(sent(sends, "the filesystem root `/` isn't a project directory")).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // never spawned at /
  daemon.kill();
});

test('REGRESSION (review #1, 2nd pass): a harness command /compact mid-/new reaches the agent, not eaten as a bad path', async () => {
  const { cfgDir } = makeCfgDir(false);
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxLoggingInjects(cfgDir, injectLog), { mode: 0o755 });
  const queue: unknown[][] = [[textMsg(80, '/new pend')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `pend`'));
  // /compact is a harness passthrough — must reach the agent verbatim, NOT produce "is not an
  // absolute path" and NOT be lost while the /new is mid-flow.
  queue.push([textMsg(81, '/compact')]);
  await waitFor(() => (existsSync(injectLog) ? readFileSync(injectLog, 'utf8').includes('/compact') : false));
  expect(existsSync(injectLog) && readFileSync(injectLog, 'utf8').includes('/compact')).toBe(true);
  expect(sent(sends, 'is not an absolute path')).toBe(false);
  daemon.kill();
});
