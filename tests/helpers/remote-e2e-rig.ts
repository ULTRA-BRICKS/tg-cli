// The rig of tests/remote-e2e-integration.test.ts: the REAL components of the remote ctl feature wired to
// each other with no network and no Telegram.
//
//   client machine "clvm"  real `tg` (bun) -> real `python3 -I tg-remote client record` -> fake ssh
//   fake ssh               real `python3 -I tg-remote server --peer clvm`  -> the hub's hook socket
//   hub (daemon host)      real `tg-ctl run` against a fake Bot API; a reply goes out through real
//                          `tg-remote hub deliver` -> fake ssh -> real `tg-remote satellite serve` on the
//                          client -> real `tg-ctl satellite-deliver` -> the client's fake tmux
//
// The two machines have separate config dirs, homes and fake tmux/ps. BOTH panes are `%3` with agent pid
// 3003 — the hub's pane is the decoy a misrouted reply would type into. Nothing here is written to by two
// sides: the only things crossing between the machines are the bytes the two Python endpoints exchange.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Subprocess } from 'bun';
import { startLiveEndpoint } from '../../features/tg-ctl/omp-live-runtime.mjs';
import { parseHistory, type HistoryRecord } from '../../features/replies/history';
import { CLIENT_YAML, clientFixture, runEntry, startFakeApi, type ApiCall, type ClientFixture, type FakeApi, type TgRun } from './client-send';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './daemon-lifecycle';
import { fakeSsh, type FakeSsh } from './fake-ssh-link';
import { TMUX_NO_SERVER_SHIM } from './hermetic-host';
import { LOCAL_PANE, LOCAL_PID, TG_CTL, TMUX_SERVER_PID, fakeTmux, makeHubHarness, startFakeTg, type FakeTg, type HubHarness } from './remote-hub-harness';

export const REPO = join(import.meta.dir, '..', '..');

// `tg` starts its ancestry walk at ITS parent, so the parent (whoever spawned it: the test run) is listed as a
// child of the agent: the sender is the claude at pid 3003 in pane %3, exactly as on a real client machine.
const CLIENT_PS = `#!/bin/sh
case "$*" in
  *tty*) printf '%s %s\\n' '${LOCAL_PID}' '??' ;;
  *)
    parent=$(/bin/ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')
    printf '%s %s %s\\n' "\${parent:-900000}" '${LOCAL_PID}' 'bun test'
    printf '%s %s %s\\n' '${LOCAL_PID}' '1' 'claude'
    ;;
esac
exit 0
`;

// The shared fake tmux answers `display-message` with the pane path only; a real tmux fills every field of the
// format. The client's `tg` asks for `path, server pid, pane pid` (its route locators) and `window, path` (its name).
function clientTmux(fake: string, cwd: string): string {
  return `#!/bin/sh
if [ "$1" = display-message ]; then
  case "$*" in
    *'#{pane_current_path}'*'#{pid}'*) printf '%s\\t%s\\t%s\\n' '${cwd}' '${TMUX_SERVER_PID}' '${LOCAL_PID}'; exit 0 ;;
    *'#{window_name}'*) printf '%s\\t%s\\n' "$(cat '${join(fake, 'window-name')}')" '${cwd}'; exit 0 ;;
  esac
fi
exec '${join(fake, 'tmux-base')}' "$@"
`;
}

export interface LedgerEvent {
  event: string;
  msg?: number;
  update?: number;
  target?: string;
}

export interface RemoteRouteRow {
  machine: string;
  chat: string;
  id: number;
  route: Record<string, unknown>;
}

export interface ClientMachine extends ClientFixture {
  injectLog: string;
  /** What reached the client's pane: `<pane>\t<text>` per typed line or paste. */
  injected: () => string[];
  api: FakeApi;
  /** The sendMessage texts as Telegram would show them to a replier: header brackets in ASCII, no markup. */
  sent: () => { text: string }[];
  /** The tmux window name `tg` reads for its session name (default `clproj`). */
  setWindowName: (name: string) => void;
}

export interface Rig {
  hub: HubHarness;
  hubApi: FakeTg;
  client: ClientMachine;
  ssh: FakeSsh;
  daemon: Subprocess;
  /** `tg <args>` on the client machine; `env` adds to (never replaces) the rig's own. */
  tg: (args: string[], opts?: { stdin?: string; env?: Record<string, string> }) => Promise<TgRun>;
  /** `tg-remote <args>` on the client machine, as a person (or cron) would run it. */
  clientRemote: (args: string[]) => Promise<TgRun>;
  remoteRoutes: () => RemoteRouteRow[];
  history: () => HistoryRecord[];
  ledger: () => LedgerEvent[];
  finalState: (msg: number) => string | undefined;
  journal: () => string[];
  cleanup: () => Promise<void>;
}

function installFakes(f: ClientFixture): { injectLog: string } {
  const fake = join(f.home, 'fake');
  mkdirSync(fake);
  const injectLog = join(fake, 'inject.log');
  writeFileSync(join(fake, 'panes.tsv'), `sclient\t0\t${LOCAL_PANE}\t${LOCAL_PID}\tclaude\tclproj\t${f.cwd}\n`);
  writeFileSync(join(fake, 'window-name'), 'clproj');
  writeFileSync(join(fake, 'tmux-base'), fakeTmux(fake, injectLog));
  chmodSync(join(fake, 'tmux-base'), 0o755);
  for (const [name, body] of Object.entries({ tmux: clientTmux(fake, f.cwd), ps: CLIENT_PS })) {
    writeFileSync(join(f.binDir, name), body);
    chmodSync(join(f.binDir, name), 0o755);
  }
  return { injectLog };
}

export async function createRig(): Promise<Rig> {
  const reg = createDaemonRegistry();
  const hub = makeHubHarness({ remoteMachines: 'clvm=ultra@127.0.0.1' });
  const hubApi = startFakeTg();
  const clientApi = startFakeApi();
  const f = clientFixture(CLIENT_YAML);
  const { injectLog } = installFakes(f);
  const ssh = fakeSsh({
    repo: REPO,
    hubCfg: hub.cfgDir,
    hubHome: hub.cfgDir, // the hub harness gives the daemon its config dir as HOME; the forced command sees the same
    clientCfg: f.configDir,
    clientHome: f.home,
    clientPath: `${f.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  });
  ssh.reset();

  const logFd = openSync(join(hub.cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: hub.cfgDir,
    env: {
      PATH: `${join(hub.cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: hub.cfgDir,
      TG_CTL_CONFIG_DIR: hub.cfgDir,
      TG_API_BASE: `http://127.0.0.1:${hubApi.port}`,
      TG_REMOTE_SSH: ssh.bin,
    },
    logFd,
  });
  closeSync(logFd);

  const client: ClientMachine = {
    ...f,
    injectLog,
    api: clientApi,
    setWindowName: (name) => writeFileSync(join(f.home, 'fake', 'window-name'), name),
    injected: () => (existsSync(injectLog) ? readFileSync(injectLog, 'utf8').split('\n').filter(Boolean) : []),
    sent: () =>
      clientApi.calls
        .filter((c: ApiCall) => c.method === 'sendMessage')
        .map((c) => ({ text: String(c.body.text).replace(/<[^>]*>/g, '').normalize('NFKC') })),
  };

  const clientEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    TMUX: '/tmp/fake-tmux,1,0',
    TMUX_PANE: LOCAL_PANE,
    TG_API_BASE: clientApi.url,
    TG_REMOTE_SSH: ssh.bin,
    ...extra,
  });
  const ledger = (): LedgerEvent[] =>
    (hub.read('tg-ctl.123.delivery.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEvent);

  return {
    hub,
    hubApi,
    client,
    ssh,
    daemon,
    tg: async (args, opts = {}) => runEntry('tg', args, f, clientEnv(opts.env), opts.stdin),
    clientRemote: async (args) => {
      const proc = Bun.spawn(['python3', '-I', join(REPO, 'tg-remote'), ...args], {
        cwd: f.cwd,
        env: { PATH: `${f.binDir}:${process.env.PATH ?? ''}`, HOME: f.home, TG_CTL_CONFIG_DIR: f.configDir, TG_REMOTE_SSH: ssh.bin },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, out, err };
    },
    remoteRoutes: () => {
      const raw = hub.read('tg-ctl.123.remote-routes.json');
      return raw === null ? [] : (JSON.parse(raw) as RemoteRouteRow[]);
    },
    history: () => parseHistory(hub.read('tg-ctl.123.history.jsonl')),
    ledger,
    finalState: (msg) =>
      ledger()
        .filter((e) => e.msg === msg && ['delivered', 'failed', 'uncertain', 'duplicate'].includes(e.event))
        .at(-1)?.event,
    journal: () => {
      const dir = join(f.configDir, 'remote', 'journal');
      return existsSync(dir) ? readdirSync(dir) : [];
    },
    cleanup: async () => {
      await reapDaemons(reg);
      hubApi.stop();
      clientApi.stop();
    },
  };
}

export interface OmpHarness {
  /** What the omp's live endpoint was handed, in order. */
  received: string[];
  sessionId: string;
  /** Close the endpoint and put the client's tmux/ps shims back. */
  stop: () => Promise<void>;
}

/**
 * Turn the client's agent into an out-of-tmux omp: the test process is the omp (a real, live pid) and publishes a
 * real omp-live endpoint under the client's config dir; ps/lsof/tmux shims describe it. `tg` then records an
 * `omp:<pid>` route and the satellite must type through the endpoint, not a pane.
 */
export async function useOmpHarness(client: ClientMachine): Promise<OmpHarness> {
  const sessionId = '01a0d2d7-6202-702d-b9e8-006b656b0798';
  const sessionFile = join(client.home, `2026-09-27T01-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd: client.cwd, title: 'OmpReceiver' })}\n`);
  const shims: Record<string, string> = {
    ps: `#!/bin/sh\ncase "$*" in *tty*) printf '${process.pid} ??\\n';; *) printf '${process.pid} 1 /opt/homebrew/bin/omp\\n';; esac\n`,
    lsof: `#!/bin/sh\nprintf 'p${process.pid}\\nfcwd\\nn${client.cwd}\\nn${sessionFile}\\n'\n`,
    tmux: TMUX_NO_SERVER_SHIM,
    omp: '#!/bin/sh\nexit 1\n',
  };
  const saved = new Map<string, string | null>();
  for (const [name, body] of Object.entries(shims)) {
    const path = join(client.binDir, name);
    saved.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
    writeFileSync(path, body, { mode: 0o755 });
  }
  const received: string[] = [];
  const endpoint = await startLiveEndpoint({
    root: join(client.configDir, 'omp-live'),
    snapshot: () => ({ sessionId, sessionFile, cwd: client.cwd, title: 'OmpReceiver', busy: false }),
    send: (text: string) => {
      received.push(text);
    },
  });
  return {
    received,
    sessionId,
    stop: async () => {
      await endpoint.close();
      for (const [path, body] of saved) {
        if (body === null) rmSync(path, { force: true });
        else writeFileSync(path, body, { mode: 0o755 });
      }
    },
  };
}
