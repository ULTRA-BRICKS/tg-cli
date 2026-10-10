import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// End-to-end flat `/new` command (issue #27): the REAL daemon + a fake Telegram server + a fake
// tmux/ps. A `/new [<harness>|<model>] [<dir>] name [<task>]` message drives the interactive flow
// (ask dir → ask harness when omitted → ask model → `tmux new-window` spawn into a named window).
// The fake tmux's new-window logs its full argv so a test asserts the spawn shape (model argv,
// -c <dir>, -n <slug>, the task as a trailing prompt arg). Distinct from the forum-topics spawn
// (no topic, no binding) — this exercises the in-memory pending-session machine + the non-topic
// spawn path.
//
// Load-bearing guarantees (this is the CTO's daily lifeline daemon):
//   1. `/new <name>` → dir button tap → harness tap → model button tap SPAWNS exactly one agent in
//      the named window, with the model argv + -c <dir>.
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

// A fake tmux that models the REAL "session named `1`" collision: list-panes reports the agent in
// a session literally named `1`, and new-window emulates tmux's target parsing — a BARE numeric
// `-t` target is read as a WINDOW INDEX and fails `create window failed: index 1 in use`, while a
// `=1:` session target (trailing colon) succeeds. Proves the daemon targets the session
// unambiguously (BUG 1: numeric session name must not be misparsed as a window index).
function fakeTmuxNumericSession(cwd: string, spawnLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' '1' '1' '%1' '4241' 'claude' 'w1' '' '${cwd}' ;;
  display-message) printf '1\\n' ;;
  new-window)
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    target=''; prev=''
    for a in "$@"; do
      if [ "$prev" = "-t" ]; then target="$a"; fi
      prev="$a"
    done
    case "$target" in
      *:) : ;;            # session target (trailing colon) — ok
      '') : ;;            # no target — ok
      *[!0-9]*) : ;;      # non-numeric bare name — tmux would resolve the session — ok
      *) echo 'create window failed: index 1 in use' >&2; exit 1 ;;  # bare number = window index
    esac
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option) : ;; send-keys) : ;; load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

function makeCfgDir(topics: boolean): { cfgDir: string; spawnLog: string } {
  const cfgDir = tempDir('tgctl-new-');
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  topics: ${topics}\n`);
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
  callbacks: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const callbacks: Array<Record<string, unknown>> = [];
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
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        callbacks.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageReplyMarkup')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  return { server, sends, callbacks };
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

function harnessTap(id: number, token: string, harness: string): unknown {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: 1, first_name: 'Alex' }, message: { message_id: id, chat: { id: 1 }, date: 0 }, data: `tnh:${token}:${harness}` },
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

test('full /new flow: command → dir tap → harness tap → model tap spawns one agent in the named window', async () => {
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
  await waitFor(() => sent(sends, 'Which harness should `myproj` use?'));
  expect(sent(sends, 'Which harness should `myproj` use?')).toBe(true);

  queue.push([harnessTap(12, 'n1', 'claude')]);
  await waitFor(() => sent(sends, 'Which Claude model should `myproj` run?'));
  expect(sent(sends, 'Which Claude model should `myproj` run?')).toBe(true);

  // Tap the model button.
  queue.push([modelTap(13, 'n1', 'claude-opus')]);
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

test('BUG 1: a NUMERIC tmux session name spawns successfully (no `index 1 in use` collision)', async () => {
  const cfgDir = tempDir('tgctl-new-');
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxNumericSession(cfgDir, spawnLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });

  // model+dir+name all inline → immediate spawn into the numeric session.
  const { server, sends } = makeServer([[textMsg(150, `/new opus ${cfgDir} numsess`)]]);
  const daemon = await startDaemon(cfgDir, server.port);

  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  // Session targeted unambiguously as a session (=1:), never a bare `-t 1`.
  expect(argv[0]).toContain('-t =1:');
  expect(argv[0]).not.toMatch(/-t 1(\s|$)/);
  // The spawn SUCCEEDED — no collision error, no retry offered.
  await waitFor(() => sent(sends, 'spawned `claude-opus`'));
  expect(sent(sends, 'spawned `claude-opus`')).toBe(true);
  expect(sent(sends, 'index 1 in use')).toBe(false);
  expect(sent(sends, "couldn't start the agent")).toBe(false);
  daemon.kill();
});

test('BUG 2: an inline absolute dir AFTER the name is used and skips the dir prompt', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  // `/new <name> <dir>` — the dir comes AFTER the name (the exact shape the CTO reported broken).
  const queue: unknown[][] = [[textMsg(160, `/new hyperos ${cfgDir}`)]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  // The dir prompt must be SKIPPED — the flow goes straight to the harness pick.
  await waitFor(() => sent(sends, 'Which harness should `hyperos` use?'));
  expect(sent(sends, 'Which harness should `hyperos` use?')).toBe(true);
  expect(sent(sends, 'Pick a recent project')).toBe(false);
  expect(sent(sends, 'Which directory should')).toBe(false);
  // Finish the flow and confirm it spawns in the inline dir.
  queue.push([harnessTap(161, 'n1', 'claude')]);
  await waitFor(() => sent(sends, 'Which Claude model should `hyperos` run?'));
  queue.push([modelTap(162, 'n1', 'claude-default')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  expect(spawnArgvLog(spawnLog)[0]).toContain(`-c ${cfgDir}`);
  daemon.kill();
});

test('an inline /command after the name is preserved as task text, not a dropped dir (codex #187)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  // `/new api /compact first`: `/compact` looks like a dir (absolute) but is a
  // harness passthrough, not a real directory. It must NOT raise the bad-dir error
  // and must NOT be dropped — it is preserved at the FRONT of the task, and the dir
  // prompt is asked normally. The whole task reaches the spawned agent as
  // `/compact first`.
  const queue: unknown[][] = [[textMsg(200, '/new api /compact first')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Pick a recent project') || sent(sends, 'is not an absolute existing directory'));
  expect(sent(sends, 'is not an absolute existing directory')).toBe(false);
  expect(sent(sends, 'Pick a recent project')).toBe(true);
  // Complete the flow: tap the recent dir (cfgDir), harness, model → spawn.
  queue.push([dirTap(201, 'n1', 0)]);
  await waitFor(() => sent(sends, 'Which harness should `api` use?'));
  queue.push([harnessTap(202, 'n1', 'claude')]);
  await waitFor(() => sent(sends, 'Which Claude model should `api` run?'));
  queue.push([modelTap(203, 'n1', 'claude-default')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  // The preserved task is the trailing positional prompt, after the `--` separator.
  expect(spawnArgvLog(spawnLog)[0]).toContain('-- /compact first');
  daemon.kill();
});

test('an inline single-component absolute dir after the name is used, not treated as a command (codex #187)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  // Guards the P1 regression: a single-segment path like /tmp is a REAL directory,
  // so it must be used as the dir (skip the prompt), never mistaken for a command.
  const queue: unknown[][] = [[textMsg(210, '/new svc /tmp keep running')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which harness should `svc` use?'));
  expect(sent(sends, 'Which harness should `svc` use?')).toBe(true);
  expect(sent(sends, 'Pick a recent project')).toBe(false);
  expect(sent(sends, 'is not an absolute existing directory')).toBe(false);
  queue.push([harnessTap(211, 'n1', 'claude')]);
  await waitFor(() => sent(sends, 'Which Claude model should `svc` run?'));
  queue.push([modelTap(212, 'n1', 'claude-default')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  expect(spawnArgvLog(spawnLog)[0]).toContain('-c /tmp');
  expect(spawnArgvLog(spawnLog)[0]).toContain('-- keep running');
  daemon.kill();
});

test('an inline nonexistent MULTI-component path after the name still errors, not preserved as task (codex #187)', async () => {
  const { cfgDir } = makeCfgDir(false);
  // `/does/not/exist` is not command-shaped (a second slash) — it is a genuine
  // dir typo, so it must raise the invalid-directory error, NOT be silently
  // buried in the task. Mirrors the typed-path flow's isLikelySlashCommand gate.
  const queue: unknown[][] = [[textMsg(220, '/new proj /does/not/exist fix the bug')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'is not an absolute existing directory'));
  expect(sent(sends, 'is not an absolute existing directory')).toBe(true);
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

test('/new <name> then a TYPED absolute path advances to harness/model picks and spawns', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(40, '/new typed')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);

  await waitFor(() => sent(sends, 'New agent `typed`'));
  // Type the absolute path instead of tapping a button (cfgDir is a real dir).
  queue.push([textMsg(41, cfgDir)]);
  await waitFor(() => sent(sends, 'Which harness should `typed` use?'));
  expect(sent(sends, 'Which harness should `typed` use?')).toBe(true);

  queue.push([harnessTap(42, 'n1', 'claude')]);
  await waitFor(() => sent(sends, 'Which Claude model should `typed` run?'));
  expect(sent(sends, 'Which Claude model should `typed` run?')).toBe(true);

  queue.push([modelTap(43, 'n1', 'claude-default')]);
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
  const cfgDir = tempDir('tgctl-new-');
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n');
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
  const queue: unknown[][] = [[textMsg(60, `/new codex ${cfgDir} um`)]]; // harness+dir supplied → straight to model step
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which Codex model should `um` run?'));

  // A forged/stale callback with a model id not in the catalog.
  queue.push([modelTap(61, 'n1', 'gpt-9')]);
  await waitFor(() => sent(sends, 'unknown model'));
  expect(sent(sends, 'unknown model `gpt-9`')).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // never spawned
  daemon.kill();
});

test('a forged cross-harness model tap is rejected and does NOT spawn', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(62, `/new codex ${cfgDir} cdx`)]];
  const { server, sends, callbacks } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which Codex model should `cdx` run?'));

  queue.push([modelTap(63, 'n1', 'claude-opus')]);
  await waitFor(() => callbacks.some((c) => String(c.text ?? '').includes('pick a Codex model')));
  expect(callbacks.some((c) => String(c.text ?? '').includes('pick a Codex model'))).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]);

  queue.push([modelTap(64, 'n1', 'codex-gpt-5.5')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  expect(spawnArgvLog(spawnLog)[0]).toContain('codex --model gpt-5.5');
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
  await waitFor(() => sent(sends, 'spawned `claude-opus`'));
  expect(sent(sends, 'spawned `claude-opus`')).toBe(true);
  daemon.kill();
});

test('/new <harness> <name> <task> asks that harness models after path, then spawns that harness', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(130, '/new codex task-cli msg')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `task-cli`'));
  expect(sent(sends, 'New agent `codex`')).toBe(false);

  queue.push([dirTap(131, 'n1', 0)]);
  await waitFor(() => sent(sends, 'Which Codex model should `task-cli` run?'));
  expect(sent(sends, 'Which Codex model should `task-cli` run?')).toBe(true);
  const modelPrompt = sends.find((s) => String(s.text ?? '').includes('Which Codex model should `task-cli` run?'));
  const keyboard = (modelPrompt?.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [];
  const labels = keyboard.map((row) => row[0]?.text).filter(Boolean);
  expect(labels.some((label) => label.includes('Codex'))).toBe(true);
  expect(labels.some((label) => label.includes('Claude'))).toBe(false);

  queue.push([modelTap(132, 'n1', 'codex-gpt-5.5')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  expect(argv[0]).toContain('-n task-cli');
  expect(argv[0]).toContain('codex --model gpt-5.5 -- msg');
  await waitFor(() => sent(sends, 'spawned `codex-gpt-5.5`'));
  expect(sent(sends, 'spawned `codex-gpt-5.5`')).toBe(true);
  daemon.kill();
});

test('/new with no harness/model asks harness first, then models for that harness', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  const queue: unknown[][] = [[textMsg(140, '/new pickme do it')]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'New agent `pickme`'));

  queue.push([dirTap(141, 'n1', 0)]);
  await waitFor(() => sent(sends, 'Which harness should `pickme` use?'));
  const harnessPrompt = sends.find((s) => String(s.text ?? '').includes('Which harness should `pickme` use?'));
  const harnessKeyboard = (harnessPrompt?.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [];
  const harnessLabels = harnessKeyboard.map((row) => row[0]?.text).filter(Boolean);
  expect(harnessLabels).toEqual(['Claude', 'Codex', 'opencode']);

  queue.push([harnessTap(142, 'n1', 'opencode')]);
  await waitFor(() => sent(sends, 'Which opencode model should `pickme` run?'));
  expect(sent(sends, 'Which opencode model should `pickme` run?')).toBe(true);
  queue.push([modelTap(143, 'n1', 'opencode-zai-glm-5.2')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  const argv = spawnArgvLog(spawnLog);
  expect(argv.length).toBe(1);
  expect(argv[0]).toContain('-n pickme');
  expect(argv[0]).toContain('opencode --model zai/glm-5.2 --prompt=do it');
  daemon.kill();
});

function retryTap(id: number, token: string): unknown {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: 1, first_name: 'Alex' }, message: { message_id: id, chat: { id: 1 }, date: 0 }, data: `tnr:${token}` },
  };
}

test('a spawn FAILURE offers a Retry button and does NOT re-ask the model (BUG 1: no loop)', async () => {
  const cfgDir = tempDir('tgctl-new-');
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  const failFlag = join(cfgDir, 'FAIL_SPAWN');
  writeFileSync(failFlag, '1'); // arm the failure
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxFailable(cfgDir, spawnLog, failFlag), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });

  // harness+dir on the line → straight to model step; the tap triggers the (failing) spawn.
  const queue: unknown[][] = [[textMsg(110, `/new codex ${cfgDir} retryme`)]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which Codex model should `retryme` run?'));
  queue.push([modelTap(111, 'n1', 'codex-gpt-5.5')]);

  // The spawn fails → the error posts ONCE and a Retry button is offered (session preserved).
  await waitFor(() => sent(sends, "couldn't start the agent"));
  expect(sent(sends, "couldn't start the agent")).toBe(true);
  await Bun.sleep(200);
  // BUG 1 regression guard: the model question is asked exactly ONCE (the initial ask) — the
  // failure must NOT re-enter the questionnaire.
  const modelPrompts = sends.filter((s) => String(s.text ?? '').includes('Which Codex model should `retryme` run?'));
  expect(modelPrompts.length).toBe(1);
  // A Retry button was offered (tnr:<token>), carrying the preserved session.
  const retryPrompt = sends.find((s) => {
    const kb = (s.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [];
    return kb.some((row) => row.some((b) => String(b.callback_data ?? '').startsWith('tnr:')));
  });
  expect(retryPrompt).toBeDefined();

  // Now clear the failure and tap Retry → it spawns with the preserved answers (no re-ask).
  rmSync(failFlag, { force: true });
  queue.push([retryTap(112, 'n1')]);
  await waitFor(() => spawnArgvLog(spawnLog).length > 0);
  expect(spawnArgvLog(spawnLog).length).toBe(1);
  expect(spawnArgvLog(spawnLog)[0]).toContain('codex --model gpt-5.5');
  await waitFor(() => sent(sends, 'spawned `codex-gpt-5.5`'));
  expect(sent(sends, 'spawned `codex-gpt-5.5`')).toBe(true);
  daemon.kill();
});

test('a forged/expired Retry tap (no pending session) is refused and does NOT spawn', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  // No /new was ever run, so token `n1` has no pending session — the tap must be refused.
  const { server, callbacks } = makeServer([[retryTap(170, 'n1')]]);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => callbacks.some((c) => String(c.text ?? '').includes('run /new again')));
  expect(callbacks.some((c) => String(c.text ?? '').includes('run /new again'))).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // never spawned
  daemon.kill();
});

test('a Retry tap on a session that never failed (awaiting-model) is refused (wrong state)', async () => {
  const { cfgDir, spawnLog } = makeCfgDir(false);
  // harness+dir supplied → session sits at awaiting-model (no failure yet). A retry tap here is
  // out-of-state and must be refused, not spawn.
  const queue: unknown[][] = [[textMsg(180, `/new codex ${cfgDir} wrongstate`)]];
  const { server, sends, callbacks } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which Codex model should `wrongstate` run?'));
  queue.push([retryTap(181, 'n1')]);
  await waitFor(() => callbacks.some((c) => String(c.text ?? '').includes('nothing to retry')));
  expect(callbacks.some((c) => String(c.text ?? '').includes('nothing to retry'))).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]);
  daemon.kill();
});

test('a Retry after the working dir vanished re-asks for a dir and does NOT spawn into nothing', async () => {
  const cfgDir = tempDir('tgctl-new-');
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  const failFlag = join(cfgDir, 'FAIL_SPAWN');
  const workdir = join(cfgDir, 'workdir'); // a real dir we delete before the retry
  mkdirSync(workdir);
  writeFileSync(failFlag, '1');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: false\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmuxFailable(cfgDir, spawnLog, failFlag), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });

  const queue: unknown[][] = [[textMsg(190, `/new codex ${workdir} vanish`)]];
  const { server, sends } = makeServer(queue);
  const daemon = await startDaemon(cfgDir, server.port);
  await waitFor(() => sent(sends, 'Which Codex model should `vanish` run?'));
  queue.push([modelTap(191, 'n1', 'codex-gpt-5.5')]);
  await waitFor(() => sent(sends, "couldn't start the agent"));

  // Delete the working dir, then clear the spawn failure and tap Retry: the dir is now gone, so the
  // flow must re-ask for a directory rather than spawn into a vanished cwd.
  rmSync(workdir, { recursive: true, force: true });
  rmSync(failFlag, { force: true });
  queue.push([retryTap(192, 'n1')]);
  await waitFor(() => sent(sends, 'is not an absolute existing directory'));
  expect(sent(sends, 'is not an absolute existing directory')).toBe(true);
  await Bun.sleep(150);
  expect(spawnArgvLog(spawnLog)).toEqual([]); // never spawned into the vanished dir
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
