/**
 * @file laya's verdict for the intent gate, from task-cli's warm classify server — never
 * by loading the model in this process.
 *
 * Accessed via: the `tg` entrypoint, only when the deterministic detector found no ask in
 * the body (intent-gate.ts `layaWorthAsking`).
 *
 * WHAT: laya (PyPI `laya`, Convai Innovations' local classifier) answers typed questions
 * about a text with calibrated probabilities. task-cli keeps one loaded model resident in
 * a machine-wide server (task-cli `tasklib/classify_server.py`: a unix socket under
 * `$XDG_STATE_HOME/task-cli/classify/laya-<version>.sock`, one JSON request line
 * `{"op":"predict","message":…,"questions":…}` → one reply line `{"ok":true,"result":…}`),
 * spawned by `task classify` and idle-exiting after 15 minutes. tg only connects to a
 * server that is already listening: it never spawns one and never imports the model, so a
 * send costs one socket round-trip at most, bounded by `TG_LAYA_TIMEOUT_MS`.
 *
 * Fail-open by design: no server, a foreign-owned or group/world-accessible socket dir, a
 * timeout or an unparsable reply all yield `null`, and the gate runs on its heuristic
 * alone (which is the authority — laya only ever adds an advisory hint).
 *
 * The one impure module of the intent gate (socket + directory reads).
 */
import { lstatSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

// The one question asked. `noul` = a calibrated P(true) in `answers.<name>.noul`.
export const LAYA_QUESTIONS = {
  asks_reader: {
    type: 'noul',
    instructions: 'Does the message ask the reader to decide, choose, approve, or answer an open question?',
  },
} as const;

const DEFAULT_TIMEOUT_MS = 1200;
// laya reads a few hundred tokens per state; the head of a long body is what it sees anyway.
const MAX_MESSAGE_CHARS = 2000;

/** P(asks the reader) from a classify-server reply line, or null when it is not one. */
export function parseLayaReply(line: string): number | null {
  try {
    const reply = JSON.parse(line) as { ok?: unknown; result?: { answers?: Record<string, { noul?: unknown }> } };
    const p = reply.ok === true ? reply.result?.answers?.asks_reader?.noul : undefined;
    return typeof p === 'number' && p >= 0 && p <= 1 ? p : null;
  } catch {
    return null;
  }
}

// Only a directory this user owns and nobody else can enter: another account must not be
// able to plant a listener that receives the message text (task-cli's `_private_dir` rule).
function privateDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** The socket to try: `TG_LAYA_SOCKET`, else the newest `laya-*.sock` task-cli left listening. */
export function layaSocketPath(env: NodeJS.ProcessEnv): string | null {
  if (env.TG_LAYA_SOCKET) return privateDir(dirname(env.TG_LAYA_SOCKET)) ? env.TG_LAYA_SOCKET : null;
  const state = env.XDG_STATE_HOME || join(env.HOME ?? '', '.local', 'state');
  const dir = join(state, 'task-cli', 'classify');
  if (!privateDir(dir)) return null;
  try {
    const sockets = readdirSync(dir)
      .filter((name) => /^laya-.*\.sock$/u.test(name))
      .map((name) => {
        const path = join(dir, name);
        const st = lstatSync(path);
        return { path, mtime: st.mtimeMs, ok: st.isSocket() && st.uid === process.getuid?.() };
      })
      .filter((s) => s.ok)
      .sort((a, b) => b.mtime - a.mtime);
    return sockets[0]?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * laya's P(the body asks the reader something), or null when no warm server answered in
 * time. `TG_LAYA=0` turns it off.
 */
export async function layaAskProbability(body: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  if (/^(?:0|false|no|off)$/iu.test((env.TG_LAYA ?? '').trim())) return null;
  const path = layaSocketPath(env);
  if (path === null) return null;
  const parsedTimeout = Number(env.TG_LAYA_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const request = `${JSON.stringify({ op: 'predict', message: body.slice(0, MAX_MESSAGE_CHARS), questions: LAYA_QUESTIONS })}\n`;
  return new Promise<number | null>((resolve) => {
    let settled = false;
    let buffer = '';
    let connection: { end(): void } | undefined;
    const decoder = new TextDecoder();
    const timer = setTimeout(() => finish(null, connection), timeoutMs);
    const finish = (value: number | null, socket?: { end(): void }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.end();
      resolve(value);
    };
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          connection = socket;
          socket.write(request);
        },
        data(socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          const newline = buffer.indexOf('\n');
          if (newline >= 0) finish(parseLayaReply(buffer.slice(0, newline)), socket);
        },
        close() {
          finish(null);
        },
        error() {
          finish(null);
        },
        connectError() {
          finish(null);
        },
      },
    }).catch(() => finish(null));
  });
}
