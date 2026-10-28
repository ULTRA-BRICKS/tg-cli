// Shared fixture of the remote-hub integration tests: a REAL `tg-ctl run` against a fake Bot API, a fake
// tmux/ps with ONE local agent pane (%3, pid 3003 — the same pane id and pid a remote machine's
// route carries, which is the whole point), and a fake `tg-remote` (TG_REMOTE_BIN). No live
// Telegram, no real ssh, no real tmux.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, type DaemonRegistry } from './daemon-lifecycle';
import { fakeRemoteHub, type FakeHub } from './fake-remote-hub';
import { tempDir } from './test-temp';

export const TG_CTL = join(import.meta.dir, '..', '..', 'tg-ctl');
export const LOCAL_PANE = '%3';
export const LOCAL_PID = 3003;
export const TMUX_SERVER_PID = 9999;

export interface HubHarness {
  cfgDir: string;
  localDir: string;
  injectLog: string;
  remote: FakeHub;
  file: (name: string) => string;
  read: (name: string) => string | null;
  injected: () => string[];
}

export interface HubHarnessOpts {
  /** The `control.remote_machines` value; undefined = a plain local machine (hub off). */
  remoteMachines?: string;
  machines?: { name: string; target: string }[];
  /** Message ids the LOCAL agent (pane %3) sent: routes.json rows against its own project dir. */
  localRoutes?: number[];
}

export function fakeTmux(cfgDir: string, injectLog: string): string {
  const panes = join(cfgDir, 'panes.tsv');
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    case "$*" in *pane_title*) exit 0 ;; esac
    cat '${panes}' 2>/dev/null
    ;;
  display-message)
    pane=""; fmt=""
    while [ $# -gt 0 ]; do
      case "$1" in -t) pane="$2"; shift ;; -p) ;; *) fmt="$1" ;; esac
      shift
    done
    if [ -z "$pane" ]; then printf '%s\\n' '${TMUX_SERVER_PID}'; exit 0; fi
    awk -F'\\t' -v p="$pane" '$3 == p { print $7 }' '${panes}'
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
  load-buffer) cat > '${join(cfgDir, 'buffer.txt')}' ;;
  paste-buffer)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    printf '%s\\t%s\\n' "$pane" "$(cat '${join(cfgDir, 'buffer.txt')}' 2>/dev/null)" >> '${injectLog}'
    ;;
  capture-pane)
    if [ -f '${join(cfgDir, 'capture.txt')}' ]; then cat '${join(cfgDir, 'capture.txt')}'; else exit 1; fi
    ;;
esac
exit 0
`;
}

const FAKE_PS = `#!/bin/sh
case "$*" in
  *tty*) printf '%s %s\\n' '${LOCAL_PID}' '??' ;;
  *) printf '%s %s %s\\n' '${LOCAL_PID}' '1' 'claude' ;;
esac
exit 0
`;

export function makeHubHarness(opts: HubHarnessOpts = {}): HubHarness {
  const cfgDir = tempDir('tgctl-hub-');
  const localDir = join(cfgDir, 'proj-local');
  mkdirSync(localDir, { recursive: true });
  const injectLog = join(cfgDir, 'inject.log');
  const machines = opts.machines ?? [{ name: 'clvm', target: 'ultra@65.21.40.51' }];
  const remote = fakeRemoteHub(machines);

  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  const control = ['control:', '  enabled: true'];
  if (opts.remoteMachines !== undefined) control.push(`  remote_machines: "${opts.remoteMachines}"`);
  writeFileSync(join(cfgDir, 'config.yaml'), `${control.join('\n')}\n`);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: LOCAL_PANE, cwd: localDir }));
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify((opts.localRoutes ?? []).map((id) => ({ id, paneId: LOCAL_PANE, cwd: localDir, ts: now }))));
  writeFileSync(join(cfgDir, 'panes.tsv'), `slocal\t0\t${LOCAL_PANE}\t${LOCAL_PID}\tclaude\tlocalproj\t${localDir}\n`);
  mkdirSync(join(cfgDir, 'bin'));
  for (const [name, body] of Object.entries({ tmux: fakeTmux(cfgDir, injectLog), ps: FAKE_PS })) {
    writeFileSync(join(cfgDir, 'bin', name), body);
    chmodSync(join(cfgDir, 'bin', name), 0o755);
  }

  const file = (name: string): string => join(cfgDir, name);
  const read = (name: string): string | null => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : null);
  return {
    cfgDir,
    localDir,
    injectLog,
    remote,
    file,
    read,
    injected: () => (existsSync(injectLog) ? readFileSync(injectLog, 'utf8').split('\n').filter(Boolean) : []),
  };
}

// --- a scripted Bot API -------------------------------------------------------------------------

export interface Sent {
  text: string;
  hasMarkup: boolean;
}

export interface FakeTg {
  port: number;
  sends: Sent[];
  reactions: Record<string, unknown>[];
  pushReply: (updateId: number, messageId: number, replyToId: number, text: string, repliedText?: string) => void;
  pushPhotoReply: (updateId: number, messageId: number, replyToId: number, repliedText?: string) => void;
  pushText: (updateId: number, messageId: number, text: string) => void;
  stop: () => void;
}

export function startFakeTg(): FakeTg {
  const queue: unknown[][] = [];
  const sends: Sent[] = [];
  const reactions: Record<string, unknown>[] = [];
  let delivered = 0;
  const message = (messageId: number, extra: Record<string, unknown>) => ({
    message_id: messageId,
    from: { id: 1, first_name: 'Alex' },
    chat: { id: 1 },
    date: Math.floor(Date.now() / 1000),
    ...extra,
  });
  const replyTo = (id: number, text: string) => ({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 1 }, text });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (delivered < queue.length) return Response.json({ ok: true, result: queue[delivered++] });
        await Bun.sleep(150);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as { text: string; reply_markup?: unknown };
        sends.push({ text: body.text, hasMarkup: body.reply_markup !== undefined });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/p.jpg' } });
      if (url.pathname.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
      return Response.json({ ok: true, result: true });
    },
  });

  return {
    port: server.port ?? 0,
    sends,
    reactions,
    pushReply: (updateId, messageId, replyToId, text, repliedText = 'orig') =>
      queue.push([{ update_id: updateId, message: message(messageId, { text, reply_to_message: replyTo(replyToId, repliedText) }) }]),
    pushPhotoReply: (updateId, messageId, replyToId, repliedText = 'orig') =>
      queue.push([
        {
          update_id: updateId,
          message: message(messageId, {
            photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 1, height: 1, file_size: 3 }],
            reply_to_message: replyTo(replyToId, repliedText),
          }),
        },
      ]),
    pushText: (updateId, messageId, text) => queue.push([{ update_id: updateId, message: message(messageId, { text }) }]),
    stop: () => server.stop(true),
  };
}

// --- kit: one registry + servers per test file -----------------------------------------------------

export interface HubKit {
  reg: DaemonRegistry;
  tg: () => FakeTg;
  daemon: (h: HubHarness, tg: FakeTg) => Promise<Subprocess>;
  cleanup: () => Promise<void>;
}

export function createHubKit(): HubKit {
  const reg = createDaemonRegistry();
  const servers: FakeTg[] = [];
  return {
    reg,
    tg: () => {
      const tg = startFakeTg();
      servers.push(tg);
      return tg;
    },
    daemon: async (h, tg) => {
      const logFd = openSync(join(h.cfgDir, 'daemon.log'), 'a');
      const daemon = await spawnDaemon(reg, {
        tgCtlPath: TG_CTL,
        cfgDir: h.cfgDir,
        env: {
          PATH: `${join(h.cfgDir, 'bin')}:/usr/bin:/bin`,
          HOME: h.cfgDir,
          TG_CTL_CONFIG_DIR: h.cfgDir,
          TG_API_BASE: `http://127.0.0.1:${tg.port}`,
          TG_REMOTE_BIN: h.remote.bin,
        },
        logFd,
      });
      closeSync(logFd);
      return daemon;
    },
    cleanup: async () => {
      await reapDaemons(reg);
      for (const s of servers.splice(0)) s.stop();
    },
  };
}

export async function waitFor(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await Bun.sleep(40);
  }
  return pred();
}

/** One request line to the daemon's hook socket, one reply line back (what `tg-remote server` does). */
export function socketRequest(h: HubHarness, line: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = createConnection(h.file('tg-ctl.123.sock'));
  let out = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    out += chunk;
  });
  socket.on('end', () => resolve(out.trim()));
  socket.on('error', reject);
  socket.write(`${line}\n`);
  return promise;
}

/** A record body as `tg-remote server` relays it for a message sent from machine `clvm`. */
export function recordLine(over: Record<string, unknown> = {}, peer = 'clvm', recordOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'remote-record',
    peer,
    record: {
      v: 1,
      op: 'record',
      machine: peer,
      chat: '1',
      ids: [{ id: 700, threadId: null }],
      route: { paneId: LOCAL_PANE, cwd: '/srv/remote-proj', agentPid: LOCAL_PID, serverPid: 4321, panePid: 5555, sessionKey: `cc:pane:4321/${LOCAL_PANE}/5555` },
      history: { text: 'report from the remote machine', targetAgent: `${peer}/remoteproj`, groupToken: 'g-1', truncated: false },
      name: { primary: 'remoteproj', secondary: null },
      ts: 1_730_100_000_000,
      ...recordOver,
    },
    ...over,
  });
}
