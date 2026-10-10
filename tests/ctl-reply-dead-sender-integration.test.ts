import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { PS_NO_AGENTS_SHIM, TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';

// Regression for the "dead sender" reply-routing path: a one-shot/disposable
// sender (a subagent process running `tg --tag report`, or any headless
// script) records an outbound route (routes.json) and then EXITS for good —
// its paneId/pid will NEVER become visible again. Only a lineage parent `tg`
// recorded from the process tree at send time (`parentPaneId`, #503) may take
// such a reply; ctl-omp-reply-no-tmux-integration.test.ts covers that delivery.
// Without one, a reply gets the picker: a live agent that merely shares the
// dead sender's cwd is NOT its parent — unrelated sessions share /tmp or a
// repository root, and the old exact-cwd guess (#423) typed replies into them.
//
// This drives the REAL daemon against a fake Telegram + a fake tmux/ps, with
// routes.json pre-seeded to a synthetic `omp:<deadpid>` origin (tg-cli#363's
// out-of-tmux synthetic id) that never appears in any snapshot — simulating
// the disposable sender having already exited by the time the reply arrives.
//
// Real subprocess daemon + real sockets/HTTP: the short settle sleeps below
// are the same pattern ctl-reply-misroute-integration.test.ts already uses —
// there is no in-process clock to fake against a live daemon child process.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

// The disposable sender's synthetic origin — never present in tmux or ps.
const DEAD_ORIGIN = 'omp:942424';

// A live agent in the SAME project directory as the dead sender but with no
// recorded lineage to it — proves a shared cwd never makes it the parent.
const PANE_PARENT = '%9';
const PID_PARENT = 9009;
// A live agent in a DIFFERENT, unrelated project.
const PANE_OTHER = '%2';
const PID_OTHER = 2002;
// A second live agent in the SAME project as the dead sender.
const PANE_PARENT_B = '%11';
const PID_PARENT_B = 1111;
const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

function fakeTmux(
  cfgDir: string,
  dirParent: string,
  dirOther: string,
  injectLog: string,
  includeParentB: boolean,
): string {
  const parentBLine = includeParentB
    ? `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'sparentb' '0' '${PANE_PARENT_B}' '${PID_PARENT_B}' 'claude' 'parentb' '${dirParent}'\n`
    : '';
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'sparent' '0' '${PANE_PARENT}' '${PID_PARENT}' 'claude' 'parent' '${dirParent}'
${parentBLine}    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'sother' '0' '${PANE_OTHER}' '${PID_OTHER}' 'claude' 'other' '${dirOther}'
    ;;
  display-message)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ "$pane" = "${PANE_PARENT}" ] || [ "$pane" = "${PANE_PARENT_B}" ]; then printf '%s\\n' '${dirParent}'
    elif [ "$pane" = "${PANE_OTHER}" ]; then printf '%s\\n' '${dirOther}'
    else printf 'main\\n'; fi
    ;;
  send-keys)
    pane=""; text=""; is_enter=0
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then text="$2"; fi
      if [ "$1" = "Enter" ]; then is_enter=1; fi
      shift
    done
    if [ "$is_enter" = "0" ] && [ -n "$pane" ]; then printf '%s\\t%s\\n' "$pane" "$text" >> '${injectLog}'; fi
    ;;
  load-buffer)
    cat >/dev/null
    ;;
  paste-buffer)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ -n "$pane" ]; then printf '%s\\tPASTE\\n' "$pane" >> '${injectLog}'; fi
    ;;
esac
exit 0
`;
}

function fakePs(includeParentB: boolean): string {
  const parentBLine = includeParentB ? `printf '%s %s %s\\n' '${PID_PARENT_B}' '1' 'claude'\n` : '';
  return `#!/bin/sh
printf '%s %s %s\\n' '${PID_PARENT}' '1' 'claude'
${parentBLine}printf '%s %s %s\\n' '${PID_OTHER}' '1' 'claude'
exit 0
`;
}

interface Harness {
  cfgDir: string;
  dirParent: string;
  dirOther: string;
  injectLog: string;
}

interface HarnessOpts {
  includeParentB?: boolean;
  omitParent?: boolean;
  // The route's lineage parent as `tg` would record it (`omp:<pid>`).
  parentPaneId?: string;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-dead-sender-'));
  const dirParent = join(cfgDir, 'proj-parent');
  const dirOther = join(cfgDir, 'proj-other');
  mkdirSync(dirParent, { recursive: true });
  mkdirSync(dirOther, { recursive: true });
  const injectLog = join(cfgDir, 'inject.log');

  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: PANE_OTHER, cwd: dirOther }),
  );
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([
      {
        id: 500,
        paneId: DEAD_ORIGIN,
        cwd: dirParent,
        ...(opts.parentPaneId ? { parentPaneId: opts.parentPaneId } : {}),
        ts: Math.floor(Date.now() / 1000),
      },
    ]),
  );

  mkdirSync(join(cfgDir, 'bin'));
  const includeParentB = opts.includeParentB ?? false;
  const tmuxScript = opts.omitParent
    ? fakeTmux(cfgDir, dirParent, dirOther, injectLog, false).replace(
        /printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'sparent'.*\n/,
        '',
      )
    : fakeTmux(cfgDir, dirParent, dirOther, injectLog, includeParentB);
  writeFileSync(join(cfgDir, 'bin', 'tmux'), tmuxScript, { mode: 0o755 });
  writeFileSync(
    join(cfgDir, 'bin', 'ps'),
    opts.omitParent
      ? `#!/bin/sh\nprintf '%s %s %s\\n' '${PID_OTHER}' '1' 'claude'\nexit 0\n`
      : fakePs(includeParentB),
    { mode: 0o755 },
  );

  return { cfgDir, dirParent, dirOther, injectLog };
}

function injectedLines(injectLog: string): string[] {
  if (!existsSync(injectLog)) return [];
  return readFileSync(injectLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

interface FakeTg {
  port: number;
  pushReply: (updateId: number, messageId: number, replyToId: number, text: string) => void;
  sends: Array<{ text: string; hasMarkup: boolean }>;
  stop: () => void;
}

function startFakeTg(): FakeTg {
  const queue: unknown[][] = [];
  const sends: Array<{ text: string; hasMarkup: boolean }> = [];
  let delivered = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (delivered < queue.length) {
          const batch = queue[delivered];
          delivered += 1;
          return Response.json({ ok: true, result: batch });
        }
        await Bun.sleep(300);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as { text: string; reply_markup?: unknown };
        sends.push({ text: body.text, hasMarkup: body.reply_markup !== undefined });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  return {
    port: server.port,
    sends,
    pushReply: (updateId, messageId, replyToId, text) => {
      const nowSec = Math.floor(Date.now() / 1000);
      queue.push([
        {
          update_id: updateId,
          message: {
            message_id: messageId,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: nowSec,
            text,
            reply_to_message: { message_id: replyToId, date: nowSec, chat: { id: 1 }, text: 'report' },
          },
        },
      ]);
    },
    stop: () => server.stop(true),
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await Bun.sleep(50);
  }
}

test('DEAD SENDER with no recorded lineage: the sole live agent sharing its cwd is NOT its parent — picker, nothing typed', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushReply(600, 10, 500, 'чек');

  // Picker and delivery are exclusive outcomes of one reply: wait for either.
  await waitFor(() => tg.sends.some((s) => s.hasMarkup) || injectedLines(h.injectLog).length > 0);

  // Same cwd is project affinity, not parentage: an unrelated session in
  // /tmp or the same repository root must never receive this reply.
  expect(injectedLines(h.injectLog)).toEqual([]);
  expect(tg.sends.some((s) => s.hasMarkup && /no longer running/.test(s.text))).toBe(true);
  daemon.kill();
}, 15_000);

test('DEAD SENDER whose recorded lineage parent has exited too: picker, never the same-cwd agent', async () => {
  const h = makeHarness({ parentPaneId: 'omp:31337' });
  const tg = startFakeTg();
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushReply(604, 14, 500, 'чек');

  await waitFor(() => tg.sends.some((s) => s.hasMarkup) || injectedLines(h.injectLog).length > 0);

  expect(injectedLines(h.injectLog)).toEqual([]);
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(true);
  daemon.kill();
}, 15_000);

test('DEAD SENDER, no live agent in that project: falls to the picker (visible), never auto-routes across projects', async () => {
  const h = makeHarness({ omitParent: true });
  const tg = startFakeTg();
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushReply(601, 11, 500, 'чек');

  await waitFor(() => tg.sends.some((s) => s.hasMarkup));
  await Bun.sleep(300);

  expect(tg.sends.some((s) => s.hasMarkup)).toBe(true);
  const lines = injectedLines(h.injectLog);
  expect(lines.length).toBe(0);
  daemon.kill();
}, 15_000);

test('DEAD SENDER, two live agents in that same project: still ambiguous, falls to the picker rather than guessing', async () => {
  const h = makeHarness({ includeParentB: true });
  const tg = startFakeTg();
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushReply(602, 12, 500, 'чек');

  await waitFor(() => tg.sends.some((s) => s.hasMarkup));
  await Bun.sleep(300);

  expect(tg.sends.some((s) => s.hasMarkup)).toBe(true);
  const lines = injectedLines(h.injectLog);
  expect(lines.length).toBe(0);
  daemon.kill();
}, 15_000);

test('DEAD SENDER, no live agent anywhere: a visible no-agent reply, never a silent drop', async () => {
  const h = makeHarness({ omitParent: true });
  writeFileSync(join(h.cfgDir, 'bin', 'ps'), PS_NO_AGENTS_SHIM, { mode: 0o755 });
  writeFileSync(join(h.cfgDir, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
  const tg = startFakeTg();
  const daemon = await startDaemon(h.cfgDir, tg.port);

  tg.pushReply(603, 13, 500, 'чек');

  // A truly EMPTY tmux+ps snapshot pays the full retry tax at every one of the
  // reply-route path's several snapshot()-equivalent calls (matchLiveOmpOrigin's
  // listLiveOmpAgents, the direct snapshot(), and listAgentCandidates()) — each
  // exit-0-but-empty read retries 3x with real subprocess spawns, and none of
  // them can short-circuit early the way a populated snapshot does. Observed
  // over 11s end-to-end on a loaded machine, well past the suite's shared
  // 8s waitFor default (fine for every other case here, where tmux or ps
  // returns real rows and the retry loop breaks on attempt 1).
  await waitFor(() => tg.sends.length > 0, 25_000);
  await Bun.sleep(300);

  expect(tg.sends.length).toBeGreaterThan(0);
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
  const lines = injectedLines(h.injectLog);
  expect(lines.length).toBe(0);
  daemon.kill();
}, 30_000);
