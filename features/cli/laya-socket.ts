/**
 * @file laya's verdict for the intent gate, from task-cli's warm classify server — never
 * by loading the model in this process.
 *
 * Accessed via: the `tg` entrypoint for explicit problem reports, or when the deterministic
 * detector found no ask in another body (intent-gate.ts `layaWorthAsking`). Never on dry-run.
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
 * Ask hints fail open (null). Problem checks return a typed unavailable reason and fall
 * back to mandatory deterministic action/result checks. An available negative problem
 * classification blocks; a positive never overrides deterministic missing evidence.
 *
 * The one impure module of the intent gate (socket + directory reads).
 */
import { lstatSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { problemRemediationEvidence, type ProblemLayaAssessment } from './problem-remediation';

// The one question asked. `noul` = a calibrated P(true) in `answers.<name>.noul`.
export const LAYA_QUESTIONS = {
  asks_reader: {
    type: 'noul',
    instructions: 'Does the message ask the reader to decide, choose, approve, or answer an open question?',
  },
} as const;

const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_PROBLEM_TIMEOUT_MS = 3000;
// laya reads a few hundred tokens per state; the head of a long body is what it sees anyway.
const MAX_MESSAGE_CHARS = 2000;
const MAX_REQUEST_BYTES = 16 * 1024;

export const LAYA_PROBLEM_QUESTIONS = {
  has_done: {
    type: 'noul',
    instructions: 'Does the author state a concrete diagnostic or recovery action they already performed AND its observed result? Failed attempts count. Future plans, headings alone and quoted examples do not count.',
  },
  has_current: {
    type: 'noul',
    instructions: 'Does the author state a concrete recovery action currently in progress, or an exact external blocker with the verification/retry when it clears? Passive monitoring, "under observation", headings alone and future promises do not count.',
  },
} as const;

function probability(line: string, name: string): number | null {
  try {
    const reply = JSON.parse(line) as { ok?: unknown; result?: { answers?: Record<string, { noul?: unknown }> } };
    const p = reply.ok === true ? reply.result?.answers?.[name]?.noul : undefined;
    return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
  } catch { return null; }
}

/** P(asks the reader) from a classify-server reply line, or null when it is not one. */
export function parseLayaReply(line: string): number | null {
  return probability(line, 'asks_reader');
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
  const reply = await requestLaya(body.slice(0, MAX_MESSAGE_CHARS), LAYA_QUESTIONS, env, DEFAULT_TIMEOUT_MS);
  return reply.status === 'ok' ? parseLayaReply(reply.line) : null;
}

/** Full action sections, not the body's head; too large is unavailable, never a negative
 * inferred from truncated evidence. Uses the same socket discovery and TG_LAYA settings.
 */
export async function layaProblemAssessment(body: string, env: NodeJS.ProcessEnv): Promise<ProblemLayaAssessment> {
  const evidence = problemRemediationEvidence(body);
  // Only the author's words. Synthetic "attempts/results" headings around a bare
  // symptom can bias the classifier into claiming those facts exist.
  // A side without its own label falls back to the whole prose, which usually already holds
  // the other side: send that once. Two labelled sections are distinct text; send both. A
  // labelled done section that prose lacks (a `Result:` heading is kept only in done) is kept.
  const message = evidence.doneLabel && evidence.currentLabel ? `${evidence.done}\n${evidence.current}`
    : !evidence.doneLabel ? evidence.done
    : evidence.current.includes(evidence.done) ? evidence.current
    : `${evidence.done}\n${evidence.current}`;
  const reply = await requestLaya(message, LAYA_PROBLEM_QUESTIONS, env, DEFAULT_PROBLEM_TIMEOUT_MS);
  if (reply.status !== 'ok') return reply;
  const done = probability(reply.line, 'has_done');
  const current = probability(reply.line, 'has_current');
  return done === null || current === null
    ? { status: 'unavailable', reason: 'invalid-response' }
    : { status: 'ok', done, current };
}

type LayaResponse = { status: 'ok'; line: string } | Extract<ProblemLayaAssessment, { status: 'unavailable' }>;

async function requestLaya(body: string, questions: Record<string, unknown>, env: NodeJS.ProcessEnv, defaultTimeoutMs: number): Promise<LayaResponse> {
  if (/^(?:0|false|no|off)$/iu.test((env.TG_LAYA ?? '').trim())) return { status: 'unavailable', reason: 'disabled' };
  const path = layaSocketPath(env);
  if (path === null) return { status: 'unavailable', reason: 'no-socket' };
  const parsedTimeout = Number(env.TG_LAYA_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : defaultTimeoutMs;
  const request = `${JSON.stringify({ op: 'predict', message: body, questions })}\n`;
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) return { status: 'unavailable', reason: 'payload-too-large' };
  return new Promise<LayaResponse>((resolve) => {
    let settled = false;
    let buffer = '';
    let connection: { end(): void } | undefined;
    const decoder = new TextDecoder();
    const timer = setTimeout(() => finish({ status: 'unavailable', reason: 'timeout' }, connection), timeoutMs);
    const finish = (value: LayaResponse, socket?: { end(): void }): void => {
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
          if (settled) { socket.end(); return; }
          socket.write(request);
        },
        data(socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
            finish({ status: 'unavailable', reason: 'invalid-response' }, socket);
            return;
          }
          const newline = buffer.indexOf('\n');
          if (newline >= 0) finish({ status: 'ok', line: buffer.slice(0, newline) }, socket);
        },
        close() {
          finish({ status: 'unavailable', reason: 'connection-error' });
        },
        error() {
          finish({ status: 'unavailable', reason: 'connection-error' }, connection);
        },
        connectError() {
          finish({ status: 'unavailable', reason: 'connection-error' }, connection);
        },
      },
    }).catch(() => finish({ status: 'unavailable', reason: 'connection-error' }, connection));
  });
}
