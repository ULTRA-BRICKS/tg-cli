// `tg`'s side of the session-topic lookup (docs/specs/session-registry-and-topics.md §4.3,
// tg-cli#467): ask the daemon, over its hook socket, which registry session this `tg` runs
// in and which forum topic that session posts into. The daemon creates the topic on the
// first ask. No env stamping is needed: the pane, its tmux server and the harness ancestor
// pid identify the session. Every failure (daemon down, slow, old) answers null and the
// send goes to General with its `[name]` header, as before.

import { createConnection } from 'net';

export interface ResolvedSession {
  key: string;
  name: string;
  threadId: number | null;
}

// `$TMUX` is `<socket path>,<server pid>,<session index>`; the server pid is part of every
// pane locator, because a restarted tmux server reuses `%N` pane ids.
export function tmuxServerPidFromEnv(tmux: string | undefined): number | null {
  const pid = Number(tmux?.split(',')[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function parseResolvedSession(raw: unknown): ResolvedSession | null {
  if (!raw || typeof raw !== 'object' || !('key' in raw) || typeof raw.key !== 'string') return null;
  const name = 'name' in raw && typeof raw.name === 'string' ? raw.name : '';
  const threadId = 'threadId' in raw && typeof raw.threadId === 'number' && Number.isInteger(raw.threadId) && raw.threadId > 0 ? raw.threadId : null;
  return { key: raw.key, name, threadId };
}

// One JSON line to the daemon socket; resolves with the parsed first reply line, or null on
// any error, an unparsable reply, a close without a reply, or `timeoutMs` elapsing.
// `expectReply: false` resolves true once the line is flushed (fire-and-report lines).
export function askDaemon(socketPath: string, payload: unknown, timeoutMs: number, expectReply = true): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  let settled = false;
  let buf = '';
  const socket = createConnection(socketPath);
  const finish = (value: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(value);
  };
  const timer = setTimeout(() => finish(null), timeoutMs);
  socket.setEncoding('utf8');
  socket.on('error', () => finish(null));
  socket.on('close', () => finish(null));
  socket.on('connect', () => {
    socket.write(`${JSON.stringify(payload)}\n`, () => {
      if (!expectReply) finish(true);
    });
  });
  socket.on('data', (chunk: string) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    try {
      finish(JSON.parse(buf.slice(0, nl)));
    } catch {
      finish(null);
    }
  });
  return promise;
}
