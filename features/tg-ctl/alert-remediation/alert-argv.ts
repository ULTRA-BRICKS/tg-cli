// The `tg-ctl alert …` argv grammar (tg-cli#817 decomposition of alert-subscriptions.ts):
// one small parser per command, validated in the same order the single-function parser
// used, so every error string and flag-precedence outcome is unchanged. PURE.

import type { AlertMessage, AlertSeverity } from '../alert-subscriptions';
import {
  DEFAULT_ALERT_TTL_MS, DEFAULT_ALERT_WINDOW_MS, KEY_MAX, SEVERITIES, SOURCE_RE, TEXT_MAX, TITLE_MAX, isPositiveInt,
} from './alert-primitives';

export type AlertCommand =
  | { cmd: 'send'; message: AlertMessage; windowMs: number; force: boolean; toHolder: boolean }
  | { cmd: 'subscribe'; pid: number | null; sessionId: string | null; sources: string[] | null; ttlMs: number | null; exclusive: boolean; source: string | null }
  | { cmd: 'unsubscribe'; pid: number | null; sessionId: string | null; all: boolean }
  | { cmd: 'list'; json: boolean }
  | { cmd: 'handoff-request'; source: string; reason: string | null; pid: number | null; sessionId: string | null }
  | { cmd: 'handoff'; source: string; to: string | null; deny: boolean; reason: string | null; pid: number | null; sessionId: string | null }
  | { cmd: 'take'; source: string; pid: number | null; sessionId: string | null; ttlMs: number | null }
  | { cmd: 'release'; source: string; pid: number | null; sessionId: string | null }
  | { cmd: 'holder'; source: string; json: boolean }
  | { cmd: 'error'; error: string };

type ErrorCommand = Extract<AlertCommand, { cmd: 'error' }>;
type AlertCmdName = Exclude<AlertCommand['cmd'], 'error'>;
type HolderCmdName = 'holder' | 'handoff-request' | 'handoff' | 'take' | 'release';
type Flags = Record<string, string | true>;
type FlagsResult = { ok: true; flags: Flags } | { ok: false; error: string };
type Caller = { pid: number | null; sessionId: string | null };

const UNITS = { '': 60_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// `10m`, `90s`, `2h`, `1d`; a bare number is minutes. null = not a duration.
export function parseDurationMs(raw: string): number | null {
  const m = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNITS[m[2] as keyof typeof UNITS];
  return Number.isSafeInteger(ms) ? ms : null;
}

const USAGE = 'usage: tg-ctl alert send|subscribe|unsubscribe|list|handoff-request|handoff|take|release|holder';

// Flags are `--name value` (or bare boolean flags); values are taken verbatim so a text
// that starts with a dash still works after its flag.
function readFlags(argv: readonly string[], booleans: readonly string[]): FlagsResult {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { ok: false, error: `unexpected argument: ${a}` };
    const name = a.slice(2);
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (i + 1 >= argv.length) return { ok: false, error: `missing value for --${name}` };
    flags[name] = argv[++i];
  }
  return { ok: true, flags };
}

const KNOWN: Record<string, readonly string[]> = {
  send: ['source', 'severity', 'key', 'text', 'title', 'html', 'window', 'force', 'to-holder'],
  subscribe: ['pid', 'session', 'sources', 'ttl', 'exclusive', 'source'],
  unsubscribe: ['pid', 'session', 'all'],
  list: ['json'],
  'handoff-request': ['source', 'reason', 'pid', 'session'],
  handoff: ['source', 'to', 'deny', 'reason', 'pid', 'session'],
  take: ['source', 'pid', 'session', 'ttl'],
  release: ['source', 'pid', 'session'],
  holder: ['source', 'json'],
};
const BOOLEANS = ['html', 'force', 'all', 'json', 'exclusive', 'deny', 'to-holder'];

const isAlertCmd = (cmd: string | undefined): cmd is AlertCmdName => cmd !== undefined && Object.hasOwn(KNOWN, cmd);
const fail = (error: string): ErrorCommand => ({ cmd: 'error', error });
const isFail = (v: object): v is ErrorCommand => 'cmd' in v;
const badSource = (source: string): string => `invalid --source: ${source} (letters, digits, - _ . only)`;
const str = (flags: Flags, name: string): string | null => {
  const v = flags[name];
  return typeof v === 'string' ? v : null;
};
const isSet = (flags: Flags, name: string): boolean => flags[name] === true;

function unknownFlag(cmd: AlertCmdName, flags: Flags): ErrorCommand | null {
  const name = Object.keys(flags).find((n) => !KNOWN[cmd].includes(n));
  return name === undefined ? null : fail(`unknown flag: --${name}`);
}

// The caller's session is --pid, --session or (resolved later) the nearest live omp ancestor.
function readCaller(flags: Flags): Caller | ErrorCommand {
  const raw = str(flags, 'pid');
  const pid = raw === null ? null : Number(raw);
  if (raw !== null && !isPositiveInt(pid)) return fail(`invalid --pid: ${raw}`);
  const sessionId = str(flags, 'session');
  if (pid !== null && sessionId !== null) return fail('--pid and --session are exclusive');
  return { pid, sessionId };
}

function readTtl(flags: Flags): { ttlMs: number | null } | ErrorCommand {
  const raw = str(flags, 'ttl');
  if (raw === null) return { ttlMs: DEFAULT_ALERT_TTL_MS };
  const ms = parseDurationMs(raw);
  if (ms === null) return fail(`invalid --ttl: ${raw} (e.g. 12h, 30m, 0 = no expiry)`);
  return { ttlMs: ms === 0 ? null : ms };
}

function parseHandoff(source: string, caller: Caller, flags: Flags): AlertCommand {
  const to = str(flags, 'to');
  const deny = isSet(flags, 'deny');
  if (to !== null && deny) return fail('--to and --deny are exclusive');
  if (to === null && !deny) return fail('handoff requires --to <session id> or --deny');
  return { cmd: 'handoff', source, to, deny, reason: str(flags, 'reason'), ...caller };
}

// The holder commands (tg-cli#747): each names a --source; the caller's session is --pid,
// --session or the nearest live omp ancestor, as for subscribe.
function parseHolderCommand(cmd: HolderCmdName, flags: Flags): AlertCommand {
  const source = str(flags, 'source');
  if (source === null) return fail(`${cmd} requires --source`);
  if (!SOURCE_RE.test(source)) return fail(badSource(source));
  if (cmd === 'holder') return { cmd, source, json: isSet(flags, 'json') };
  const caller = readCaller(flags);
  if (isFail(caller)) return caller;
  switch (cmd) {
    case 'release':
      return { cmd, source, ...caller };
    case 'take': {
      const ttl = readTtl(flags);
      return isFail(ttl) ? ttl : { cmd, source, ...caller, ttlMs: ttl.ttlMs };
    }
    case 'handoff-request':
      return { cmd, source, reason: str(flags, 'reason'), ...caller };
    default:
      return parseHandoff(source, caller, flags);
  }
}

type SubscribeScope = { sources: string[] | null; source: string | null };

// An exclusive subscription holds one source slot; it never carries a source list.
function exclusiveScope(source: string | null, sourcesRaw: string | null): SubscribeScope | ErrorCommand {
  if (source === null) return fail('--exclusive requires --source');
  if (sourcesRaw !== null) return fail('--exclusive and --sources are exclusive');
  if (!SOURCE_RE.test(source)) return fail(badSource(source));
  return { sources: null, source };
}

function sharedScope(source: string | null, sourcesRaw: string | null): SubscribeScope | ErrorCommand {
  if (source !== null) return fail('--source requires --exclusive (use --sources for a non-exclusive subscription)');
  if (sourcesRaw === null) return { sources: null, source: null };
  const sources = sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0 || sources.some((s) => !SOURCE_RE.test(s))) return fail(`invalid --sources: ${sourcesRaw}`);
  return { sources, source: null };
}

function parseSubscribe(flags: Flags): AlertCommand {
  const caller = readCaller(flags);
  if (isFail(caller)) return caller;
  const ttl = readTtl(flags);
  if (isFail(ttl)) return ttl;
  const exclusive = isSet(flags, 'exclusive');
  const source = str(flags, 'source');
  const sourcesRaw = str(flags, 'sources');
  const scope = exclusive ? exclusiveScope(source, sourcesRaw) : sharedScope(source, sourcesRaw);
  if (isFail(scope)) return scope;
  return { cmd: 'subscribe', ...caller, sources: scope.sources, ttlMs: ttl.ttlMs, exclusive, source: scope.source };
}

function parseUnsubscribe(flags: Flags): AlertCommand {
  const caller = readCaller(flags);
  return isFail(caller) ? caller : { cmd: 'unsubscribe', ...caller, all: isSet(flags, 'all') };
}

// The first violated send-field rule, in the order the operator is told about them.
function sendFieldError(source: string, severity: string, key: string, text: string, title: string | null): string | null {
  if (!SOURCE_RE.test(source)) return badSource(source);
  if (!(SEVERITIES as readonly string[]).includes(severity)) return `invalid --severity: ${severity} (info|warning|critical)`;
  if (!text.trim()) return 'empty --text';
  if (text.length > TEXT_MAX) return `--text longer than ${TEXT_MAX} chars`;
  if (key.length > KEY_MAX) return `--key longer than ${KEY_MAX} chars`;
  if (title !== null && title.length > TITLE_MAX) return `--title longer than ${TITLE_MAX} chars`;
  return null;
}

function readWindow(flags: Flags): { windowMs: number } | ErrorCommand {
  const raw = str(flags, 'window');
  if (raw === null) return { windowMs: DEFAULT_ALERT_WINDOW_MS };
  const ms = parseDurationMs(raw);
  return ms === null ? fail(`invalid --window: ${raw}`) : { windowMs: ms };
}

function parseSend(flags: Flags): AlertCommand {
  const source = str(flags, 'source');
  const severity = str(flags, 'severity');
  const key = str(flags, 'key');
  const text = str(flags, 'text');
  const title = str(flags, 'title');
  if (source === null || severity === null || key === null || text === null) {
    return fail('send requires --source, --severity, --key and --text');
  }
  const invalid = sendFieldError(source, severity, key, text, title);
  if (invalid !== null) return fail(invalid);
  const window = readWindow(flags);
  if (isFail(window)) return window;
  return {
    cmd: 'send',
    message: { source, severity: severity as AlertSeverity, key: key.trim() || '-', text, html: isSet(flags, 'html'), title },
    windowMs: window.windowMs,
    force: isSet(flags, 'force'),
    toHolder: isSet(flags, 'to-holder'),
  };
}

function parseKnownCommand(cmd: AlertCmdName, flags: Flags): AlertCommand {
  switch (cmd) {
    case 'list':
      return { cmd, json: isSet(flags, 'json') };
    case 'holder':
    case 'handoff-request':
    case 'handoff':
    case 'take':
    case 'release':
      return parseHolderCommand(cmd, flags);
    case 'subscribe':
      return parseSubscribe(flags);
    case 'unsubscribe':
      return parseUnsubscribe(flags);
    case 'send':
      return parseSend(flags);
  }
}

export function parseAlertArgv(argv: readonly string[]): AlertCommand {
  const [cmd, ...rest] = argv;
  if (!isAlertCmd(cmd)) return fail(USAGE);
  const read = readFlags(rest, BOOLEANS);
  if (!read.ok) return fail(read.error);
  return unknownFlag(cmd, read.flags) ?? parseKnownCommand(cmd, read.flags);
}
