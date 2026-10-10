// A recording fake Telegram Bot API plus a throwaway HOME for spawning the REAL `tg`.
//
// Outbound contract tests assert the exact Bot API calls `tg` makes — method, JSON or multipart
// fields, order — so they need a server that records every request and can be told to answer a
// specific call with an error. The fake also hands out sequential message ids, the way Telegram
// numbers messages per chat, so tests can match history rows and the stdout `OK tg#…` line
// against the ids the server gave out.
//
// The spawned `tg` gets an explicit env (never the developer's): the preload's hermetic PATH
// (ps/launchctl shims), a per-home bin dir that shadows tmux/gh/linear/pandoc, and a
// TG_CHROME_PATH that does not exist, so no test ever reaches a live tmux server, a real repo's
// GitHub, or a real headless Chrome.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseHistory, type HistoryRecord } from '../../features/replies/history';
import { TMUX_NO_SERVER_SHIM } from './hermetic-host';

export const TG_SCRIPT = join(import.meta.dir, '..', '..', 'tg');
export const BOT_ID = '123';
export const BOT_TOKEN = `${BOT_ID}:abc`;

export interface UploadedFile {
  name: string;
  size: number;
  text: string;
}

export interface BotCall {
  method: string;
  /** JSON body, or the non-file multipart fields. */
  body: Record<string, unknown>;
  /** Multipart file fields by field name. Empty for a JSON call. */
  files: Record<string, UploadedFile>;
}

/** Answer one call yourself; return undefined to get the default success. */
export type Responder = (call: BotCall, index: number) => Response | undefined | Promise<Response | undefined>;

export interface FakeBotApi {
  base: string;
  calls: BotCall[];
  respond: Responder | null;
  reset(): void;
  stop(): void;
}

let nextMessageId = 1000;

const success = (call: BotCall): Response => {
  if (call.method === 'sendMediaGroup') {
    const media = JSON.parse(String(call.body.media ?? '[]')) as unknown[];
    return Response.json({ ok: true, result: media.map(() => ({ message_id: nextMessageId++ })) });
  }
  if (call.method.startsWith('send')) return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
  return Response.json({ ok: true, result: true });
};

export function startFakeBotApi(): FakeBotApi {
  const api: FakeBotApi = {
    base: '',
    calls: [],
    respond: null,
    reset() {
      api.calls = [];
      api.respond = null;
    },
    stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      const call: BotCall = { method, body: {}, files: {} };
      if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
        const form = await req.formData();
        for (const [k, v] of form.entries()) {
          // The multipart encoding sends every line break in a field as CRLF (HTML form-data
          // rule); Telegram reads it as one line break, so compare against the LF the caller sent.
          if (typeof v === 'string') call.body[k] = v.replace(/\r\n/g, '\n');
          else call.files[k] = { name: v.name, size: v.size, text: await v.text() };
        }
      } else {
        const raw = await req.text();
        call.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      }
      const index = api.calls.length;
      api.calls.push(call);
      return (await api.respond?.(call, index)) ?? success(call);
    },
  });
  api.base = `http://127.0.0.1:${server.port}`;
  return api;
}

/** A Telegram error answer in the real shape (HTTP status + `{ok:false, error_code, description}`). */
export function apiError(status: number, description: string, parameters?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }, { status });
}

export interface TgHome {
  home: string;
  cfg: string;
  bin: string;
}

export interface HomeOptions {
  chatId?: number | string;
  /** Extra lines for `~/.config/tg-cli/.env`. */
  envFile?: string;
  configYaml?: string;
  history?: HistoryRecord[];
}

const homes: string[] = [];

// /tmp, not tmpdir(): a daemon socket under it must stay inside the 104-byte unix-socket limit.
export function makeTgHome(opts: HomeOptions = {}): TgHome {
  const home = mkdtempSync('/tmp/tg-out-');
  homes.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), `TG_BOT_TOKEN=${BOT_TOKEN}\nTG_CHAT_ID=${opts.chatId ?? 5153477378}\n${opts.envFile ?? ''}`);
  if (opts.configYaml !== undefined) writeFileSync(join(cfg, 'config.yaml'), opts.configYaml);
  if (opts.history) writeFileSync(historyPath({ home, cfg, bin: '' }), opts.history.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // Nothing outside the test exists: no tmux server, no gh/linear/pandoc on this host.
  writeShim(bin, 'tmux', TMUX_NO_SERVER_SHIM);
  for (const name of ['gh', 'linear', 'pandoc']) writeShim(bin, name, '#!/bin/sh\nexit 127\n');
  return { home, cfg, bin };
}

export function writeShim(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
}

/** Remove every home this module created; call from afterAll. */
export function removeTgHomes(): void {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}

export const historyPath = (h: TgHome): string => join(h.cfg, `tg-ctl.${BOT_ID}.history.jsonl`);

export function readHistory(h: TgHome): HistoryRecord[] {
  try {
    return parseHistory(readFileSync(historyPath(h), 'utf8'));
  } catch {
    return [];
  }
}

export interface TgResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
}

// MUST stay async (Bun.spawn): the fake API serves on this process's event loop, so a
// synchronous spawn would deadlock on the first send.
export async function runTg(api: FakeBotApi, h: TgHome, args: string[], opts: RunOptions = {}): Promise<TgResult> {
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    cwd: opts.cwd ?? h.home,
    env: {
      PATH: `${h.bin}:${process.env.PATH ?? ''}`,
      HOME: h.home,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR ?? h.home,
      TG_API_BASE: api.base,
      TG_CHROME_PATH: join(h.home, 'no-chrome'),
      // A session identity with no tmux server behind it: `tg` records routes and history
      // under this pane, and its [window] name is the cwd basename.
      TMUX: '/tmp/none,4242,0',
      TMUX_PANE: '%9',
      ...opts.env,
    },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => proc.kill('SIGKILL'), 25_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(killer);
  return { exitCode, stdout, stderr };
}

/** Message ids from the `OK tg#1 tg#2` line a successful send prints. */
export function sentRefs(stdout: string): number[] {
  const line = stdout.split('\n').find((l) => l.startsWith('OK')) ?? '';
  return [...line.matchAll(/tg#(\d+)/g)].map((m) => Number(m[1]));
}
