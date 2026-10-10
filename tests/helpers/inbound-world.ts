// One hermetic "world" per delivery target kind for the inbound routing matrix
// (tests/ctl-inbound-matrix-integration.test.ts): a real `tg-ctl run` against a fake Bot API,
// with tmux / ps / lsof / omp / ffmpeg / whisper-cli shimmed on PATH so the daemon's REAL
// discovery sees exactly one agent of the kind under test, and a sink per kind that records
// every byte the agent would receive (tmux send-keys log, an omp-live endpoint run by this
// process, an abduco stand-in socket). Nothing reads the live machine.

import { startLiveEndpoint } from '../../features/tg-ctl/omp-live-runtime.mjs';
import { parseRegistry } from '../../features/tg-ctl/session-registry-store';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { type DaemonRegistry, spawnDaemon } from './daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './hermetic-host';

const TG_CTL = join(import.meta.dir, '..', '..', 'tg-ctl');
export const CHAT = 1;
export const TRANSCRIPT = 'voice says ship the hotfix';
// The message id of the agent's own earlier `tg` report — the anchor of every reply row.
export const ROUTE_ANCHOR = 50;

export type WorldKind =
  | 'omp-tmux-live'
  | 'omp-tmux-bare'
  | 'omp-notmux-live'
  | 'omp-notmux-bare'
  | 'claude-tmux'
  | 'codex-tmux'
  | 'claude-unhosted'
  | 'codex-unhosted'
  | 'hosted';

// ---------------------------------------------------------------- fake Bot API

export interface SentMessage {
  id: number;
  method: string;
  text: string;
  body: Record<string, unknown>;
  buttons: Array<{ text: string; callback_data: string }>;
}

export interface FakeBotApi {
  port: number;
  sent: SentMessage[];
  reactions: Array<{ message_id: number; emoji: string }>;
  callbacksAnswered: Array<{ id: string; text?: string }>;
  offsets: number[];
  push: (...updates: unknown[]) => void;
  stop: () => void;
}

export function startFakeBotApi(): FakeBotApi {
  const queue: unknown[][] = [];
  let nextId = 7000;
  const api: FakeBotApi = {
    port: 0,
    sent: [],
    reactions: [],
    callbacksAnswered: [],
    offsets: [],
    push: (...updates) => {
      queue.push(updates);
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split('/').pop() ?? '';
      if (method === 'getUpdates') {
        api.offsets.push(Number(url.searchParams.get('offset') ?? '0'));
        const batch = queue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.includes('/file/bot')) return new Response('MEDIA-BYTES');
      if (method === 'getFile') {
        const fileId = url.searchParams.get('file_id') ?? (await req.json().catch(() => ({})) as { file_id?: string }).file_id;
        return Response.json({ ok: true, result: { file_path: `media/${fileId}.bin` } });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (method === 'sendMessage' || method === 'editMessageText') {
        const id = method === 'sendMessage' ? ++nextId : Number(body.message_id);
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        api.sent.push({ id, method, text: String(body.text ?? ''), body, buttons: kb?.flat() ?? [] });
        return Response.json({ ok: true, result: { message_id: id } });
      }
      if (method === 'setMessageReaction') {
        const r = (body.reaction as Array<{ emoji: string }> | undefined)?.[0];
        if (r) api.reactions.push({ message_id: Number(body.message_id), emoji: r.emoji });
        return Response.json({ ok: true, result: true });
      }
      if (method === 'answerCallbackQuery') {
        api.callbacksAnswered.push({ id: String(body.callback_query_id), text: body.text as string | undefined });
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  api.port = server.port;
  return api;
}

// ---------------------------------------------------------------- update builders

const nowSec = (): number => Math.floor(Date.now() / 1000);
const FROM = { id: CHAT, first_name: 'Alex' };

export function textMsg(messageId: number, text: string, extra: Record<string, unknown> = {}) {
  return { message_id: messageId, from: FROM, chat: { id: CHAT }, date: nowSec(), text, ...extra };
}

export function replyTo(anchor: number) {
  return { reply_to_message: { message_id: anchor, chat: { id: CHAT }, date: nowSec(), text: 'agent report' } };
}

export function voiceMsg(messageId: number, extra: Record<string, unknown> = {}) {
  return {
    message_id: messageId,
    from: FROM,
    chat: { id: CHAT },
    date: nowSec(),
    voice: { file_id: `voice-${messageId}`, duration: 3, mime_type: 'audio/ogg', file_size: 2048 },
    ...extra,
  };
}

export function photoMsg(messageId: number, extra: Record<string, unknown> = {}) {
  return {
    message_id: messageId,
    from: FROM,
    chat: { id: CHAT },
    date: nowSec(),
    photo: [
      { file_id: `photo-${messageId}-s`, file_unique_id: `u${messageId}s`, width: 90, height: 90, file_size: 900 },
      { file_id: `photo-${messageId}`, file_unique_id: `u${messageId}`, width: 800, height: 800, file_size: 9000 },
    ],
    ...extra,
  };
}

export function documentMsg(messageId: number, extra: Record<string, unknown> = {}) {
  return {
    message_id: messageId,
    from: FROM,
    chat: { id: CHAT },
    date: nowSec(),
    document: { file_id: `doc-${messageId}`, file_unique_id: `d${messageId}`, file_name: 'notes.txt', mime_type: 'text/plain', file_size: 120 },
    ...extra,
  };
}

export function callback(updateId: number, data: string, onMessageId: number, fromId = CHAT) {
  return {
    update_id: updateId,
    callback_query: { id: `cb${updateId}`, from: { id: fromId, first_name: 'Alex' }, message: { message_id: onMessageId, chat: { id: CHAT }, date: nowSec() }, data },
  };
}

// ---------------------------------------------------------------- the world

export interface LedgerEvent {
  event: string;
  msg?: number;
  target?: string;
  update?: number;
}

export interface HistoryRow {
  message_id: number;
  direction: string;
  text: string;
  pane: string | null;
  targetAgent?: string;
  sessionKey?: string;
  threadId?: number | null;
}

export interface World {
  kind: WorldKind;
  cfgDir: string;
  api: FakeBotApi;
  daemon: Subprocess | null;
  // The ledger target a delivery to this world's agent is recorded under.
  locator: string;
  // The session's PRIMARY name (history targetAgent, picker label).
  agentName: string;
  // An `/agent <selector>` that picks this world's agent.
  selector: string;
  // Every text the agent received, in order, one entry per delivery.
  received: () => string[];
  ledger: () => LedgerEvent[];
  history: () => HistoryRow[];
  // The session registry's one-shot routes.json migration ran (spec §2.4) — it runs after the
  // daemon's first trusted scan, so a reply sent earlier never saw migrated routes.
  routesMigrated: () => boolean;
  log: () => string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

const OMP_SESSION = '01a0d2d7-6202-702d-b9e8-006b656b0799';
const HOST_NAME = 'claude-3f9a0c1d2e4b';

function shim(binDir: string, name: string, body: string): void {
  writeFileSync(join(binDir, name), body, { mode: 0o755 });
}

// tmux with ONE agent pane. send-keys -l / load-buffer text goes to `typedLog` one line per
// typed chunk; everything else succeeds with no output (capture-pane: an empty box, so the
// #463 submit check sees nothing left typed).
function tmuxOnePane(paneLine: string, typedLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\n' '${paneLine}' ;;
  display-message) printf '777\\n' ;;
  send-keys)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then printf '%s\\n' "$2" | tr '\\n' ' ' >> '${typedLog}'; printf '\\n' >> '${typedLog}'; break; fi
      shift
    done
    ;;
  load-buffer) cat | tr '\\n' ' ' >> '${typedLog}'; printf '\\n' >> '${typedLog}' ;;
esac
exit 0
`;
}

// The voice pipeline's binaries: ffmpeg creates its output wav, whisper prints the transcript.
function voiceShims(binDir: string): string {
  shim(binDir, 'ffmpeg', '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\n: > "$out"\nexit 0\n');
  const whisper = join(binDir, 'whisper-cli');
  shim(binDir, 'whisper-cli', `#!/bin/sh\nprintf '  ${TRANSCRIPT}  \\n'\nexit 0\n`);
  const model = join(binDir, 'ggml-test.bin');
  writeFileSync(model, 'FAKEMODEL');
  return ['voice:', '  enabled: true', '  runner: whisper.cpp', `  bin_path: "${whisper}"`, `  model_path: "${model}"`, '  language: auto', ''].join('\n');
}

// `control`: extra `control:` lines (indented two spaces), e.g. `  allowed_senders: 7\n`.
export async function createWorld(kind: WorldKind, reg: DaemonRegistry, opts: { control?: string } = {}): Promise<World> {
  const cfgDir = mkdtempSync(join(tmpdir(), `tgctl-matrix-${kind}-`));
  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);
  const typedLog = join(cfgDir, 'typed.log');
  writeFileSync(typedLog, '');
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(spawnLog, '');
  writeFileSync(join(cfgDir, '.env'), `TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=${CHAT}\n`);
  const voiceBlock = voiceShims(binDir);
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  git_state_banner: false\n${opts.control ?? ''}${voiceBlock}`);
  // Any omp spawn is a regression: delivery to a live session never starts a second process.
  shim(binDir, 'omp', `#!/bin/sh\nprintf 'FORBIDDEN SPAWN %s\\n' "$*" >> '${spawnLog}'\nexit 1\n`);

  const cleanups: Array<() => Promise<void> | void> = [];
  const endpointInputs: string[] = [];
  const abducoConnections: string[] = [];
  let locator = '';
  let agentName = '';
  let selector = '';

  const pid = process.pid; // an omp "process" is this runner, so its omp-live endpoint is real
  // The omp "process" is this runner: on a host with procfs the daemon reads its real cwd from
  // /proc instead of the lsof shim, so the shim reports that same cwd and both agree.
  const ompCwd = process.cwd();
  const sessionFile = join(cfgDir, `2026-10-01T00-00-00-000Z_${OMP_SESSION}.jsonl`);
  const ompTitle = 'OmpTitle';
  const publishEndpoint = async (): Promise<void> => {
    const endpoint = await startLiveEndpoint({
      root: join(cfgDir, 'omp-live'),
      snapshot: () => ({ sessionId: OMP_SESSION, sessionFile, cwd: ompCwd, title: ompTitle, busy: false }),
      send: (text: string) => {
        endpointInputs.push(text);
      },
    });
    cleanups.push(() => endpoint.close());
  };
  const ompLsof = `#!/bin/sh\nprintf 'p${pid}\\nfcwd\\nn${ompCwd}\\nn${sessionFile}\\n'\nexit 0\n`;

  // Fake process pids sit above every host's pid_max (Linux 4194304, macOS 99998): never a live
  // process, so the daemon's /proc cwd read cannot pick up a real one (#618).
  switch (kind) {
    case 'omp-tmux-live':
    case 'omp-tmux-bare': {
      writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: OMP_SESSION, cwd: ompCwd, title: ompTitle })}\n`);
      shim(binDir, 'tmux', tmuxOnePane(`main\t0\t%9\t4195001\tbun\tompwin\t${ompCwd}`, typedLog));
      shim(
        binDir,
        'ps',
        `#!/bin/sh\ncase "$*" in *tty*) printf '    1 ??\\n ${pid} ttys099\\n' ;; *) printf '    1     0 /sbin/launchd\\n 4195001     1 /bin/zsh -l\\n ${pid}  4195001 /opt/homebrew/bin/omp\\n' ;; esac\nexit 0\n`,
      );
      shim(binDir, 'lsof', ompLsof);
      if (kind === 'omp-tmux-live') await publishEndpoint();
      locator = '%9';
      agentName = 'ompwin';
      selector = 'ompwin';
      break;
    }
    case 'omp-notmux-live':
    case 'omp-notmux-bare': {
      writeFileSync(sessionFile, `${JSON.stringify({ type: 'title', v: 1, title: ompTitle, source: 'auto' })}\n${JSON.stringify({ type: 'session', version: 3, id: OMP_SESSION, cwd: ompCwd, title: ompTitle })}\n`);
      shim(binDir, 'tmux', TMUX_NO_SERVER_SHIM);
      shim(
        binDir,
        'ps',
        `#!/bin/sh\ncase "$*" in *tty*) printf '    1 ??\\n ${pid} ttys004\\n' ;; *) printf '    1     0 /sbin/launchd\\n ${pid}     1 /opt/homebrew/bin/omp\\n' ;; esac\nexit 0\n`,
      );
      shim(binDir, 'lsof', ompLsof);
      if (kind === 'omp-notmux-live') await publishEndpoint();
      locator = `omp:${pid}`;
      agentName = ompTitle;
      selector = ompTitle;
      break;
    }
    case 'claude-tmux':
    case 'codex-tmux': {
      const cmd = kind === 'claude-tmux' ? '2.1.198' : 'codex';
      const proc = kind === 'claude-tmux' ? 'claude' : 'codex';
      shim(binDir, 'tmux', tmuxOnePane(`main\t0\t%1\t4194342\t${cmd}\tagentwin\t/work/agent-proj`, typedLog));
      shim(
        binDir,
        'ps',
        `#!/bin/sh\ncase "$*" in *tty*) printf '    1 ??\\n 4194342 ttys001\\n' ;; *) printf '    1     0 /sbin/launchd\\n 4194342     1 ${proc}\\n' ;; esac\nexit 0\n`,
      );
      shim(binDir, 'lsof', '#!/bin/sh\nexit 0\n');
      locator = '%1';
      agentName = 'agentwin';
      selector = 'agentwin';
      break;
    }
    case 'claude-unhosted':
    case 'codex-unhosted': {
      const proc = kind === 'claude-unhosted' ? 'claude --name landing' : 'codex';
      shim(binDir, 'tmux', TMUX_NO_SERVER_SHIM);
      shim(
        binDir,
        'ps',
        `#!/bin/sh\ncase "$*" in *tty*) printf '    1 ??\\n 4196001 ttys004\\n 4197103 ttys004\\n' ;; *) printf '    1     0 /sbin/launchd\\n 4196001     1 -zsh\\n 4197103  4196001 ${proc}\\n' ;; esac\nexit 0\n`,
      );
      shim(binDir, 'lsof', `#!/bin/sh\nprintf 'p4197103\\nfcwd\\nn/Users/u/work/landing\\n'\nexit 0\n`);
      locator = '';
      agentName = 'landing';
      selector = 'landing';
      break;
    }
    case 'hosted': {
      const sockDir = mkdtempSync('/tmp/tgm-');
      cleanups.push(() => rmSync(sockDir, { recursive: true, force: true }));
      const socketPath = join(sockDir, `${HOST_NAME}@testhost`);
      mkdirSync(join(cfgDir, 'hosts'), { mode: 0o700 });
      writeFileSync(
        join(cfgDir, 'hosts', `${HOST_NAME}.json`),
        JSON.stringify({
          v: 1,
          name: HOST_NAME,
          harness: 'claude',
          label: 'landing',
          cwd: '/Users/u/work/landing',
          socket: socketPath,
          serverPid: 4241000,
          harnessPid: 4241002,
          role: 'coordinator',
          startedAt: '2026-09-30T21:30:00Z',
          updatedAt: '2026-09-30T21:30:00Z',
        }),
        { mode: 0o600 },
      );
      shim(binDir, 'tmux', TMUX_NO_SERVER_SHIM);
      shim(
        binDir,
        'ps',
        `#!/bin/sh\ncase "$*" in *tty*) printf '    1 ??\\n4241002 ttys010\\n' ;; *) printf '    1     0 /sbin/launchd\\n4241000     1 abduco -n ${HOST_NAME} rig host-run ${HOST_NAME}\\n4241001 4241000 /opt/homebrew/bin/python3 /Users/u/bin/rig host-run ${HOST_NAME}\\n4241002 4241001 /Users/u/.local/bin/claude --name landing\\n' ;; esac\nexit 0\n`,
      );
      shim(binDir, 'lsof', `#!/bin/sh\nprintf 'p4241002\\nfcwd\\nn/Users/u/work/landing\\n'\nexit 0\n`);
      // The abduco stand-in: what one client connection typed (MSG_CONTENT payloads, Enter dropped).
      const listener = Bun.listen<{ chunks: Buffer[] }>({
        unix: socketPath,
        socket: {
          open(sock) {
            sock.data = { chunks: [] };
          },
          data(sock, data) {
            sock.data.chunks.push(Buffer.from(data));
          },
          close(sock) {
            const buf = Buffer.concat(sock.data.chunks);
            let typed = '';
            for (let off = 0; off + 16 <= buf.length; ) {
              const len = Number(buf.readBigUInt64LE(off + 8));
              if (buf.readUInt32LE(off) === 0) typed += buf.subarray(off + 16, off + 16 + len).toString('utf8');
              off += 16 + len;
            }
            abducoConnections.push(typed.replace(/\r$/, ''));
          },
        },
      });
      cleanups.push(() => listener.stop(true));
      locator = `host:${HOST_NAME}`;
      agentName = 'landing';
      selector = 'landing';
      break;
    }
  }

  // One outbound message the agent sent earlier with `tg` (ROUTE_ANCHOR): a reply to it routes back
  // to the agent's locator. An unhosted claude/codex cannot have one (tg there names no route origin).
  if (locator !== '') {
    const routeCwd = kind.startsWith('omp') ? ompCwd : kind === 'hosted' ? '/Users/u/work/landing' : '/work/agent-proj';
    writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: ROUTE_ANCHOR, paneId: locator, cwd: routeCwd, ts: nowSec() }]));
  }

  const api = startFakeBotApi();
  cleanups.push(() => api.stop());

  const readLines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '') : []);
  const world: World = {
    kind,
    cfgDir,
    api,
    daemon: null,
    locator,
    agentName,
    selector,
    received: () => [...endpointInputs, ...abducoConnections, ...readLines(typedLog), ...readLines(spawnLog)],
    ledger: () => readLines(join(cfgDir, 'tg-ctl.123.delivery.jsonl')).map((l) => JSON.parse(l) as LedgerEvent),
    history: () => readLines(join(cfgDir, 'tg-ctl.123.history.jsonl')).map((l) => JSON.parse(l) as HistoryRow),
    routesMigrated: () => {
      const p = join(cfgDir, 'tg-ctl.123.sessions.json');
      return existsSync(p) && parseRegistry(readFileSync(p, 'utf8')).migrated.routes !== undefined;
    },
    log: () => (existsSync(join(cfgDir, 'daemon.log')) ? readFileSync(join(cfgDir, 'daemon.log'), 'utf8') : ''),
    start: async () => {
      const fd = openSync(join(cfgDir, 'daemon.log'), 'a');
      world.daemon = await spawnDaemon(reg, {
        tgCtlPath: TG_CTL,
        cfgDir,
        logFd: fd,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          HOME: cfgDir,
          TG_CTL_CONFIG_DIR: cfgDir,
          TG_API_BASE: `http://127.0.0.1:${api.port}`,
          TMUX_TMPDIR: process.env.TMUX_TMPDIR ?? '/tmp',
        },
      });
      closeSync(fd);
    },
    stop: async () => {
      const d = world.daemon;
      if (!d || d.exitCode !== null) return;
      d.kill('SIGTERM');
      await d.exited;
    },
    cleanup: async () => {
      for (const c of cleanups.splice(0).reverse()) await c();
      rmSync(cfgDir, { recursive: true, force: true });
    },
  };
  return world;
}

// The daemon is a real subprocess: poll its observable effects, bounded (no fake clock reaches it).
export async function waitUntil(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await Bun.sleep(40);
  }
}
