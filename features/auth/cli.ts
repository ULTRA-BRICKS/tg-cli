// --- `tg auth` orchestration (docs/specs/tg-auth.md) ---
//
// login / status / logout as one effectful-via-DI runner, like
// features/replies/cli.ts: every effect (Bot API fetch, config-dir file I/O,
// clock, stdin, daemon liveness, output) is injected as AuthDeps, so the whole
// flow — including the hand-off to a running tg-ctl — is unit-tested without a
// network, a disk or a daemon. The `tg` entrypoint only wires real I/O.
import { join } from 'path';
import { parseEnvContent } from '../config/env';
import { botIdFromToken, ctlPaths } from '../tg-ctl/lock';
import { AUTH_USAGE, type AuthCommand } from './args';
import {
  NONCE_BYTES,
  matchStart,
  newNonce,
  parseChat,
  parsePending,
  parseUpdates,
  serializePending,
  startLink,
  waitingPending,
  type AuthChat,
  type PendingWaiting,
} from './binding';
import { mergeEnvContent } from './env-file';
import { chatLabel, formatStatus, type BotInfo, type ChatState } from './status';

export interface AuthDeps {
  configDir: string;
  env: Readonly<Record<string, string | undefined>>; // process env — wins over the file
  apiBase: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readFile: (path: string) => string | null;
  writeFileAtomic: (path: string, content: string) => void; // 0600, parent dir created
  withLock: <T>(lockPath: string, body: () => T) => T | undefined; // O_EXCL lockfile; undefined = held by a live writer
  removeFile: (path: string) => void;
  onInterrupt: (cleanup: () => void) => () => void; // run `cleanup` on Ctrl-C; returns the unregister
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomBytes: (n: number) => Uint8Array;
  stdinIsTTY: boolean;
  readLine: () => Promise<string | null>;
  daemonPid: (botId: string) => number | null; // live tg-ctl for that bot, else null
  renderQr?: (text: string) => string | null;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, badToken: 3, timeout: 4, conflict: 5, notConfigured: 78 } as const;

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
const CRED_KEYS = ['TG_BOT_TOKEN', 'TG_CHAT_ID'] as const;
const HANDOFF_POLL_MS = 1000;
const PEEK_POLL_MS = 1500;
const RETRY_MS = 3000;
const LONG_POLL_SEC = 25;

type ApiResult = { kind: 'ok'; result: unknown } | { kind: 'http'; status: number; description: string } | { kind: 'network'; message: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function callApi(deps: AuthDeps, token: string, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<ApiResult> {
  let resp: Response;
  try {
    resp = await deps.fetch(`${deps.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { kind: 'network', message: errorText(e) };
  }
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const isObj = typeof body === 'object' && body !== null;
  if (resp.ok && isObj && 'ok' in body && body.ok === true) return { kind: 'ok', result: 'result' in body ? body.result : null };
  const description = isObj && 'description' in body && typeof body.description === 'string' ? body.description : `HTTP ${resp.status}`;
  return { kind: 'http', status: resp.status, description };
}

function apiError(r: Exclude<ApiResult, { kind: 'ok' }>): string {
  return r.kind === 'network' ? `network error: ${r.message}` : `HTTP ${r.status}: ${r.description}`;
}

function parseBot(raw: unknown): BotInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  if (!('id' in raw) || typeof raw.id !== 'number') return null;
  if (!('username' in raw) || typeof raw.username !== 'string') return null;
  const firstName = 'first_name' in raw && typeof raw.first_name === 'string' ? raw.first_name : raw.username;
  return { id: raw.id, username: raw.username, first_name: firstName };
}

interface Config {
  envPath: string;
  fileContent: string | null;
  file: Record<string, string>;
  merged: Record<string, string>; // file, then process env on top (the precedence every tg path uses)
  fromEnvironment: string[];
}

function readConfig(deps: AuthDeps): Config {
  const envPath = join(deps.configDir, '.env');
  const fileContent = deps.readFile(envPath);
  const file = parseEnvContent(fileContent ?? '');
  const merged = { ...file };
  const fromEnvironment: string[] = [];
  for (const key of CRED_KEYS) {
    const v = deps.env[key];
    if (v) {
      merged[key] = v;
      fromEnvironment.push(key);
    }
  }
  return { envPath, fileContent, file, merged, fromEnvironment };
}

// getMe with the exit-code mapping every subcommand shares: a rejected token is 3.
async function getBot(deps: AuthDeps, token: string): Promise<BotInfo | number> {
  const r = await callApi(deps, token, 'getMe', {});
  if (r.kind === 'ok') {
    const bot = parseBot(r.result);
    if (bot) return bot;
    deps.err('Error: Telegram answered getMe without a bot username.');
    return EXIT.failed;
  }
  if (r.kind === 'http' && (r.status === 401 || r.status === 404)) {
    deps.err(`Error: Telegram rejected the bot token (${apiError(r)}).`);
    deps.err('Copy it again from @BotFather (/mybots → your bot → API Token) and run: tg auth login --token <token>');
    return EXIT.badToken;
  }
  deps.err(`Error: could not reach Telegram to check the token — ${apiError(r)}.`);
  return EXIT.failed;
}

export async function runAuth(cmd: AuthCommand, deps: AuthDeps): Promise<number> {
  if (cmd.sub === 'help') {
    deps.out(AUTH_USAGE);
    return EXIT.ok;
  }
  if (cmd.sub === 'status') return runStatus(deps, false);
  if (cmd.sub === 'logout') return runLogout(cmd, deps);
  if (cmd.sub === 'auto' && cmd.token === undefined && !cmd.tokenFromStdin) {
    const { merged } = readConfig(deps);
    if (merged.TG_BOT_TOKEN && merged.TG_CHAT_ID) return runStatus(deps, true);
  }
  return runLogin(cmd, deps);
}

async function runStatus(deps: AuthDeps, fromAuto: boolean): Promise<number> {
  const cfg = readConfig(deps);
  const token = cfg.merged.TG_BOT_TOKEN;
  if (!token) {
    deps.err(`tg is not connected to Telegram: no TG_BOT_TOKEN in ${cfg.envPath}.`);
    deps.err('Run `tg auth` to connect (BotFather token + one Start tap).');
    return EXIT.notConfigured;
  }
  const bot = await getBot(deps, token);
  if (typeof bot === 'number') return bot;
  const chatId = cfg.merged.TG_CHAT_ID;
  let chat: ChatState = { kind: 'unbound' };
  if (chatId) {
    const r = await callApi(deps, token, 'getChat', { chat_id: chatId });
    const parsed = r.kind === 'ok' ? parseChat(r.result) : null;
    chat = parsed ? { kind: 'ok', chat: parsed } : { kind: 'error', id: chatId, description: r.kind === 'ok' ? 'malformed getChat answer' : r.kind === 'http' ? r.description : `network error: ${r.message}` };
  }
  deps.out(formatStatus({ bot, chat, envPath: cfg.envPath, daemonPid: deps.daemonPid(botIdFromToken(token)), fromEnvironment: cfg.fromEnvironment }));
  if (chat.kind === 'unbound') return EXIT.notConfigured;
  if (chat.kind === 'error') return EXIT.failed;
  if (fromAuto) deps.out('Already connected. To bind another chat or bot: tg auth login [--token <token>]');
  return EXIT.ok;
}

async function resolveToken(cmd: AuthCommand, deps: AuthDeps, cfg: Config): Promise<string | number> {
  let token = cmd.token;
  if (token === undefined && cmd.tokenFromStdin) {
    token = (await deps.readLine())?.trim() ?? '';
    if (!token) {
      deps.err('Error: --token - read nothing from stdin.');
      return EXIT.usage;
    }
  }
  token ??= cfg.merged.TG_BOT_TOKEN;
  if (!token) {
    if (!deps.stdinIsTTY) {
      deps.err('Error: no bot token. Create a bot with @BotFather (/newbot), then pass its token:');
      deps.err('  tg auth login --token <token>     or     echo <token> | tg auth login --token -');
      return EXIT.usage;
    }
    deps.err('Create a bot with @BotFather (https://t.me/BotFather → /newbot) and paste its token here:');
    token = (await deps.readLine())?.trim() ?? '';
  }
  if (!TOKEN_RE.test(token)) {
    deps.err('Error: that is not a bot token — expected <digits>:<secret> as @BotFather shows it.');
    return EXIT.usage;
  }
  return token;
}

type WaitResult = { kind: 'bound'; chat: AuthChat } | { kind: 'exit'; code: number };

async function waitForStart(
  deps: AuthDeps,
  token: string,
  bot: BotInfo,
  pending: PendingWaiting,
  opts: { botId: string; pendingPath: string; envPath: string; chatAtStart: string | undefined; handOff: boolean; confirm: boolean; timeoutSec: number },
): Promise<WaitResult> {
  const botId = opts.botId;
  let mode: 'daemon' | 'self' = opts.handOff ? 'daemon' : 'self';
  let offset: number | undefined;
  if (mode === 'daemon') deps.out(`tg-ctl (pid ${deps.daemonPid(botId)}) is polling @${bot.username}; it will pick up the tap.`);
  deps.out(`Waiting up to ${opts.timeoutSec}s for the Start tap…`);
  for (;;) {
    const seen = parsePending(deps.readFile(opts.pendingPath));
    if (seen?.nonceHash === pending.nonceHash && seen.status === 'bound') return { kind: 'bound', chat: seen.chat };
    if (seen?.nonceHash === pending.nonceHash && seen.status === 'failed') {
      deps.err(`Error: tg-ctl received the tap but could not save the chat: ${seen.error}`);
      return { kind: 'exit', code: EXIT.failed };
    }
    const remaining = pending.expiresAt - deps.now();
    if (remaining <= 0) {
      deps.err(`Error: timed out after ${opts.timeoutSec}s waiting for the Start tap.`);
      // A daemon may have saved the chat and then failed to confirm it — never claim "nothing changed" then.
      const chatNow = parseEnvContent(deps.readFile(opts.envPath) ?? '').TG_CHAT_ID;
      if (chatNow !== opts.chatAtStart) deps.err(`tg-ctl saved TG_CHAT_ID=${chatNow} without confirming it; check with: tg auth status`);
      else deps.err('Nothing was changed; run tg auth again.');
      if (mode === 'daemon') deps.err('If tg-ctl predates tg auth support it ignores the tap: run `tg-ctl restart`, then retry.');
      return { kind: 'exit', code: EXIT.timeout };
    }
    if (mode === 'daemon') {
      if (deps.daemonPid(botId) === null) {
        mode = 'self';
        deps.err('tg-ctl stopped — reading the tap directly.');
        continue;
      }
      await deps.sleep(Math.min(HANDOFF_POLL_MS, remaining));
      continue;
    }
    const pollSec = opts.confirm ? Math.min(LONG_POLL_SEC, Math.floor(remaining / 1000)) : 0;
    const r = await callApi(deps, token, 'getUpdates', offset === undefined ? { timeout: pollSec } : { offset, timeout: pollSec }, (pollSec + 10) * 1000);
    if (r.kind === 'http' && r.status === 409) {
      if (deps.daemonPid(botId) !== null) {
        mode = 'daemon';
        deps.err('tg-ctl is polling this bot — handing the tap over to it.');
        continue;
      }
      deps.err(`Error: another consumer is reading this bot's updates (${r.description}).`);
      deps.err(
        /webhook/i.test(r.description)
          ? `The bot has a webhook. Remove it (https://api.telegram.org/bot<token>/deleteWebhook) or bind from the machine that serves it.`
          : 'Another machine or program long-polls this bot. Stop it (tg-ctl stop there) or run tg auth on that machine.',
      );
      return { kind: 'exit', code: EXIT.conflict };
    }
    if (r.kind === 'http' && (r.status === 401 || r.status === 404)) {
      deps.err(`Error: Telegram rejected the bot token while waiting (${apiError(r)}).`);
      return { kind: 'exit', code: EXIT.badToken };
    }
    if (r.kind !== 'ok') {
      deps.err(`getUpdates failed (${apiError(r)}); retrying.`);
      await deps.sleep(Math.min(RETRY_MS, remaining));
      continue;
    }
    const updates = parseUpdates(r.result);
    if (opts.confirm && updates.length > 0) offset = Math.max(...updates.map((u) => u.update_id)) + 1;
    const hit = matchStart(updates, pending, deps.now());
    if (hit) {
      // First-time setup: acknowledge the tap so a daemon started next never sees it.
      if (opts.confirm) await callApi(deps, token, 'getUpdates', { offset, timeout: 0 });
      return { kind: 'bound', chat: hit.chat };
    }
    if (!opts.confirm) await deps.sleep(Math.min(PEEK_POLL_MS, remaining));
  }
}

async function runLogin(cmd: AuthCommand, deps: AuthDeps): Promise<number> {
  const cfg = readConfig(deps);
  const token = await resolveToken(cmd, deps, cfg);
  if (typeof token === 'number') return token;
  const bot = await getBot(deps, token);
  if (typeof bot === 'number') return bot;
  const botId = botIdFromToken(token);
  const pendingPath = ctlPaths(deps.configDir, botId).authPending;
  const nonce = newNonce(deps.randomBytes(NONCE_BYTES));
  const pending = waitingPending(nonce, deps.now() + cmd.timeoutSec * 1000);
  // One login per bot at a time: a second one would overwrite the pending record and kill the
  // first link (the daemon drops a nonce-shaped /start it cannot match). Check-and-write runs
  // under `<pending>.lock` (the routes lock protocol): a live record refuses, a stale one
  // (expired, finished, unreadable) is replaced, and a contended lock counts as busy.
  const lockPath = `${pendingPath}.lock`;
  let claimed: 'ok' | 'busy' | undefined;
  try {
    claimed = deps.withLock<'ok' | 'busy'>(lockPath, () => {
      const inFlight = parsePending(deps.readFile(pendingPath));
      if (inFlight?.status === 'waiting' && inFlight.expiresAt > deps.now()) return 'busy';
      deps.writeFileAtomic(pendingPath, serializePending(pending));
      return 'ok';
    });
  } catch (e) {
    deps.err(`Error: cannot write ${pendingPath}: ${errorText(e)}`);
    return EXIT.failed;
  }
  if (claimed !== 'ok') {
    deps.err(`Error: another tg auth login for @${bot.username} is already waiting for its Start tap.`);
    deps.err(`Finish or cancel that one; if its process is gone, delete ${pendingPath}.`);
    return EXIT.failed;
  }
  // Remove only OUR record: once it expired, a newer login may already own the file. The same
  // guarded release runs on Ctrl-C (onInterrupt), where this function's `finally` never does.
  const release = (): void => {
    deps.withLock(lockPath, () => {
      if (parsePending(deps.readFile(pendingPath))?.nonceHash === pending.nonceHash) deps.removeFile(pendingPath);
    });
  };
  const offInterrupt = deps.onInterrupt(release);
  let result: WaitResult;
  try {
    const link = startLink(bot.username, nonce);
    deps.out(`Bot: @${bot.username} (${bot.first_name})`);
    deps.out('Open this link in Telegram (on any device) and tap Start:');
    deps.out(`  ${link}`);
    const qr = deps.renderQr?.(link);
    if (qr) deps.out(qr);
    result = await waitForStart(deps, token, bot, pending, {
      botId,
      pendingPath,
      envPath: cfg.envPath,
      chatAtStart: cfg.file.TG_CHAT_ID,
      // The daemon reads the token in the .env; a different token is not its poll.
      handOff: deps.daemonPid(botId) !== null && token === cfg.merged.TG_BOT_TOKEN,
      // Nobody else consumes this bot's updates before a chat is bound.
      confirm: !cfg.merged.TG_CHAT_ID,
      timeoutSec: cmd.timeoutSec,
    });
  } finally {
    offInterrupt();
    release();
  }
  if (result.kind === 'exit') return result.code;
  const chat = result.chat;

  // Re-read: a daemon claim has just written TG_CHAT_ID into this same file — then there is
  // usually nothing left to change, and the daemon's write is not touched again.
  const latest = readConfig(deps);
  try {
    const next = mergeEnvContent(latest.fileContent, { TG_BOT_TOKEN: token, TG_CHAT_ID: String(chat.id) });
    if (next !== latest.fileContent) deps.writeFileAtomic(latest.envPath, next);
  } catch (e) {
    deps.err(`Error: bound ${chatLabel(chat)} but cannot write ${latest.envPath}: ${errorText(e)}`);
    return EXIT.failed;
  }
  for (const [key, value] of [['TG_BOT_TOKEN', token], ['TG_CHAT_ID', String(chat.id)]] as const) {
    const fromEnv = deps.env[key];
    if (fromEnv && fromEnv !== value) deps.err(`Warning: ${key} is also set in the environment and overrides ${latest.envPath} — unset it.`);
  }
  deps.out('Connected.');
  deps.out(formatStatus({ bot, chat: { kind: 'ok', chat }, envPath: latest.envPath, daemonPid: deps.daemonPid(botId), fromEnvironment: [] }));
  const previousBotId = botIdFromToken(cfg.merged.TG_BOT_TOKEN ?? '');
  const previousDaemon = previousBotId && previousBotId !== botId ? deps.daemonPid(previousBotId) : null;
  if (previousDaemon !== null) deps.out(`tg-ctl (pid ${previousDaemon}) still polls the previous bot — switch it: tg-ctl restart`);

  if (cmd.test) {
    const r = await callApi(deps, token, 'sendMessage', { chat_id: chat.id, text: '✅ tg is connected — messages from this machine arrive here.' });
    if (r.kind !== 'ok') {
      deps.err(`Error: bound, but the test message failed — ${apiError(r)}.`);
      return EXIT.failed;
    }
    deps.out('Test message sent.');
  }
  return EXIT.ok;
}

async function runLogout(cmd: AuthCommand, deps: AuthDeps): Promise<number> {
  const cfg = readConfig(deps);
  const present = CRED_KEYS.filter((k) => cfg.file[k] !== undefined);
  if (present.length === 0) {
    deps.out(`Not logged in: no TG_BOT_TOKEN or TG_CHAT_ID in ${cfg.envPath}.`);
  } else {
    if (!cmd.yes) {
      if (!deps.stdinIsTTY) {
        deps.err('Error: logout needs confirmation — pass --yes.');
        return EXIT.usage;
      }
      deps.err(`Remove ${present.join(' and ')} from ${cfg.envPath}? [y/N]`);
      const answer = ((await deps.readLine()) ?? '').trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        deps.out('Logout cancelled; nothing changed.');
        return EXIT.failed;
      }
    }
    try {
      deps.writeFileAtomic(cfg.envPath, mergeEnvContent(cfg.fileContent, {}, CRED_KEYS));
    } catch (e) {
      deps.err(`Error: cannot write ${cfg.envPath}: ${errorText(e)}`);
      return EXIT.failed;
    }
    deps.out(`Logged out: removed ${present.join(' and ')} from ${cfg.envPath}.`);
    const oldBotId = botIdFromToken(cfg.file.TG_BOT_TOKEN ?? '');
    const daemon = oldBotId ? deps.daemonPid(oldBotId) : null;
    if (daemon !== null) deps.out(`tg-ctl (pid ${daemon}) keeps the old credentials until it stops: tg-ctl stop`);
  }
  if (cfg.fromEnvironment.length > 0) {
    deps.err(`Note: ${cfg.fromEnvironment.join(' and ')} still set in the environment; tg keeps using it until you unset it.`);
  }
  return EXIT.ok;
}
