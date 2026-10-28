import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
import { LOCAL_PANE, LOCAL_PID, TG_CTL, TMUX_SERVER_PID, makeHubHarness, type HubHarness } from './helpers/remote-hub-harness';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// `tg-ctl satellite-deliver` (docs/specs/2026-10-28-remote-ctl-server.md §4.2): run on the CLIENT machine
// by `tg-remote satellite serve`. Real one-shot process, fake tmux/ps, fake omp-live endpoint.
// It never needs config, credentials or a daemon, prints exactly one JSON line and exits 0.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  line: Record<string, unknown>;
}

async function satellite(env: Record<string, string>, stdin: string): Promise<Run> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'satellite-deliver'], {
    env: { ...env, TMUX: '' },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  // Exactly ONE line on stdout, whatever else happens: the Python parent relays it verbatim.
  expect(stdout.endsWith('\n') && stdout.trim().split('\n').length === 1).toBe(true);
  return { code, stdout, stderr, line: JSON.parse(stdout) as Record<string, unknown> };
}

const tmuxEnv = (h: HubHarness): Record<string, string> => ({
  PATH: `${join(h.cfgDir, 'bin')}:/usr/bin:/bin`,
  HOME: h.cfgDir,
  TG_CTL_CONFIG_DIR: h.cfgDir,
});

const request = (route: Record<string, unknown>, text = 'hello from the hub') => JSON.stringify({ idem: '1:77', route, text, replyTo: { id: 700 } });

// The route `tg` recorded on the client: the pane, its tmux server, the pane process and the agent.
const TMUX_ROUTE = { paneId: LOCAL_PANE, serverPid: TMUX_SERVER_PID, panePid: LOCAL_PID, agentPid: LOCAL_PID, sessionKey: `cc:pane:${TMUX_SERVER_PID}/${LOCAL_PANE}/${LOCAL_PID}` };

function replaceAgent(h: HubHarness, pid: number): void {
  writeFileSync(h.file('panes.tsv'), `slocal\t0\t${LOCAL_PANE}\t${pid}\tclaude\tlocalproj\t${h.localDir}\n`);
  writeFileSync(join(h.cfgDir, 'bin', 'ps'), `#!/bin/sh\ncase "$*" in *tty*) printf '%s %s\\n' '${pid}' '??' ;; *) printf '%s %s %s\\n' '${pid}' '1' 'claude' ;; esac\n`);
  chmodSync(join(h.cfgDir, 'bin', 'ps'), 0o755);
}

test('a live tmux session is typed into through the existing inject plan; the answer names the sink', async () => {
  const h = makeHubHarness({});

  const run = await satellite(tmuxEnv(h), request(TMUX_ROUTE));

  expect(run.code).toBe(0);
  expect(run.stdout).toBe('{"ok":true,"sink":"tmux"}\n');
  expect(h.injected()).toEqual([`${LOCAL_PANE}\thello from the hub`]);
}, 30_000);

test('a multi-line reply is pasted whole (bracketed paste), not typed line by line', async () => {
  const h = makeHubHarness({});

  const run = await satellite(tmuxEnv(h), request(TMUX_ROUTE, 'line one\nline two'));

  expect(run.line).toEqual({ ok: true, sink: 'tmux' });
  // The paste is logged as "<pane>\t<buffer>": one entry whose buffer holds both lines, not two typed lines.
  expect(h.injected().join('\n')).toBe(`${LOCAL_PANE}\tline one\nline two`);
  expect(h.injected().filter((l) => l.startsWith(`${LOCAL_PANE}\t`))).toHaveLength(1);
}, 30_000);

test('a reused pane id is refused: another agent now sits in %3 with the same id', async () => {
  const h = makeHubHarness({});
  replaceAgent(h, 4004);

  const run = await satellite(tmuxEnv(h), request(TMUX_ROUTE));

  expect(run.code).toBe(0);
  expect(run.line).toEqual({ ok: false, error: 'no-session', uncertain: false });
  expect(h.injected()).toEqual([]);
}, 30_000);

test('a pane that changes hands WHILE the reply waits for its typing lock is never typed into', async () => {
  const h = makeHubHarness({});
  // Another message is mid-typing in %3: its lock is held by a live process (this one).
  const locks = join(h.cfgDir, 'pane-locks');
  mkdirSync(locks, { recursive: true });
  writeFileSync(join(locks, '_3.lock'), String(process.pid));
  const pending = satellite(tmuxEnv(h), request(TMUX_ROUTE));

  // A real subprocess is waiting on a real lock file: there is no event to await, only time to give it
  // (long enough for it to have resolved its target and started waiting), then the pane changes hands
  // and the lock is released.
  await Bun.sleep(1500);
  replaceAgent(h, 4004);
  unlinkSync(join(locks, '_3.lock'));

  const run = await pending;
  expect(run.line).toEqual({ ok: false, error: 'no-session', uncertain: false });
  expect(h.injected()).toEqual([]);
}, 40_000);

test('a bare pane id (no session key, no process locators) is never enough', async () => {
  const h = makeHubHarness({});

  const run = await satellite(tmuxEnv(h), request({ paneId: LOCAL_PANE, cwd: h.localDir }));

  expect(run.line).toEqual({ ok: false, error: 'no-session', uncertain: false });
  expect(h.injected()).toEqual([]);
}, 30_000);

test('a gone session (no pane listed any more) is no-session, never a guess', async () => {
  const h = makeHubHarness({});
  writeFileSync(h.file('panes.tsv'), '');

  const run = await satellite(tmuxEnv(h), request(TMUX_ROUTE));

  expect(run.line).toEqual({ ok: false, error: 'no-session', uncertain: false });
  expect(h.injected()).toEqual([]);
}, 30_000);

test('text still sitting in the agent input box after the retry Enter is unsubmitted and uncertain', async () => {
  const h = makeHubHarness({});
  const rule = '─'.repeat(40);
  writeFileSync(h.file('capture.txt'), `${rule}\n❯ hello from the hub\n${rule}\n  ? for shortcuts\n`);

  const run = await satellite(tmuxEnv(h), request(TMUX_ROUTE));

  expect(run.code).toBe(0);
  expect(run.line).toEqual({ ok: false, error: 'unsubmitted', uncertain: true });
}, 30_000);

test('a malformed request is bad-request on the same one-line channel, never a crash', async () => {
  const h = makeHubHarness({});
  for (const bad of ['', 'not json', '[]', JSON.stringify({ idem: 'nope', route: {}, text: 'x' }), JSON.stringify({ idem: '1:2', route: {}, text: 'x', extra: 1 })]) {
    const run = await satellite(tmuxEnv(h), bad);
    expect(run.code).toBe(0);
    expect(run.line).toEqual({ ok: false, error: 'bad-request', uncertain: false });
  }
  expect(h.injected()).toEqual([]);
}, 40_000);

test('no config, credentials or daemon are needed: an empty config dir still answers', async () => {
  const empty = tempDir('tg-satellite-empty-');
  mkdirSync(join(empty, 'bin'));
  writeFileSync(join(empty, 'bin', 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });

  const run = await satellite({ PATH: `${join(empty, 'bin')}:/usr/bin:/bin`, HOME: empty, TG_CTL_CONFIG_DIR: empty }, request(TMUX_ROUTE));

  expect(run.line).toEqual({ ok: false, error: 'no-session', uncertain: false });
}, 30_000);

// --- a live omp: the original process, through its published endpoint ---------------------------

async function ompFixture(publish: boolean) {
  const cfg = tempDir('tg-satellite-omp-');
  const bin = join(cfg, 'bin');
  mkdirSync(bin);
  const sid = '01a0d2d7-6202-702d-b9e8-006b656b0798';
  const sessionFile = join(cfg, `2026-09-27T01-00-00-000Z_${sid}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sid, cwd: '/work/original', title: 'OriginalReceiver' })}\n`);
  const scripts: Record<string, string> = {
    ps: `#!/bin/sh\ncase "$*" in *tty*) printf '${process.pid} ??\\n';; *) printf '${process.pid} 1 /opt/homebrew/bin/omp\\n';; esac\n`,
    lsof: `#!/bin/sh\nprintf 'p${process.pid}\\nfcwd\\nn/work/original\\nn${sessionFile}\\n'\n`,
    tmux: TMUX_NO_SERVER_SHIM,
    omp: "#!/bin/sh\nexit 1\n",
  };
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(bin, name), text, { mode: 0o755 });
  const received: string[] = [];
  if (publish) {
    const endpoint = await startLiveEndpoint({
      root: join(cfg, 'omp-live'),
      snapshot: () => ({ sessionId: sid, sessionFile, cwd: '/work/original', title: 'OriginalReceiver', busy: false }),
      send: (text: string) => {
        received.push(text);
      },
    });
    cleanup.push(() => endpoint.close());
  }
  return { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: cfg, TG_CTL_CONFIG_DIR: cfg }, received, sid };
}

test('a live omp is reached through its omp-live endpoint (the original process, no second writer)', async () => {
  const f = await ompFixture(true);

  const run = await satellite(f.env, request({ paneId: `omp:${process.pid}`, agentPid: process.pid, sessionKey: `omp:${f.sid}` }));

  expect(run.code).toBe(0);
  expect(run.stdout).toBe('{"ok":true,"sink":"omp-live"}\n');
  expect(f.received).toEqual(['hello from the hub']);
}, 30_000);

test('an omp session that moved to a new pid is followed by its session key', async () => {
  const f = await ompFixture(true);

  const run = await satellite(f.env, request({ paneId: 'omp:1', agentPid: 1, sessionKey: `omp:${f.sid}` }));

  expect(run.line).toEqual({ ok: true, sink: 'omp-live' });
  expect(f.received).toEqual(['hello from the hub']);
}, 30_000);

test('an omp that is gone is no-session; an omp without an endpoint is reported unavailable, never typed or respawned', async () => {
  const withEndpoint = await ompFixture(true);
  const gone = await satellite(withEndpoint.env, request({ paneId: 'omp:424242', agentPid: 424242, sessionKey: 'omp:some-other-session' }));
  expect(gone.line).toEqual({ ok: false, error: 'no-session', uncertain: false });
  expect(withEndpoint.received).toEqual([]);

  const bare = await ompFixture(false);
  const unavailable = await satellite(bare.env, request({ paneId: `omp:${process.pid}`, agentPid: process.pid, sessionKey: `omp:${bare.sid}` }));
  expect(unavailable.line).toEqual({ ok: false, error: 'unavailable', uncertain: false });
  expect(bare.received).toEqual([]);
}, 40_000);
