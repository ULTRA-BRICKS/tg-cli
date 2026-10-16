// `tg auth user|caller` (via the one `tg auth` parser, features/auth/args.ts), `tg call`,
// `tg user send` argument parsing. PURE: the entrypoint passes the raw argv and acts on the
// result (docs/specs/independent-telegram-clients.md §1).
//
// Exact-match leading tokens only, like `replies`/`voice`: `null` means "not ours", so
// `tg "call me later"` (one quoted argument) and `tg user find x` keep their old meaning.

import { isNeverAttach } from '../auto-attach/denylist';

/** The sidecar's two accounts: the user's own (`personal`) and a separate one that rings it. */
export type Role = 'personal' | 'caller';

export interface Output {
  json: boolean;
}

export type UserAccountCommand =
  | ({ kind: 'login'; role: Role; qr: boolean; expectedId?: string } & Output)
  | ({ kind: 'import'; role: Role; session: string; config: string; expectedId?: string } & Output)
  | ({ kind: 'status'; role: Role; online: boolean; sourceIdle: boolean } & Output)
  | ({ kind: 'logout'; role: Role } & Output)
  | ({
      kind: 'call';
      role: Role;
      peer: string;
      say?: string;
      audio?: string;
      timeout?: string;
      dryRun: boolean;
      sourceIdle: boolean;
    } & Output)
  | ({ kind: 'send'; peer: string; text?: string; files?: string[]; dryRun: boolean; sourceIdle: boolean } & Output);

export type HelpTopic = 'call' | 'user-send';

export type UserAccountArgs =
  | UserAccountCommand
  | { kind: 'help'; topic: HelpTopic }
  | { kind: 'error'; message: string };

/** `tg auth user|caller …`: help is the one `tg auth` help, so it carries no topic. */
export type AccountAuthArgs = UserAccountCommand | { kind: 'help' } | { kind: 'error'; message: string };

interface Scanned {
  positionals: string[];
  flags: Map<string, string | true>;
  /** Values of the `repeated` flags, in argv order. */
  lists: Map<string, string[]>;
  error?: string;
}

interface ScanSpec {
  valued: readonly string[];
  booleans: readonly string[];
  /** Valued flags that may be given more than once (`--file a --file b`). */
  repeated?: readonly string[];
  /** `--` ends options (only where free text follows: `tg user send`). */
  endOfOptions?: boolean;
}

// `valued` flags take `--flag value` or `--flag=value`; `booleans` stand alone; anything else
// starting with `--` is an error, so a typo never becomes message text. A separated value
// that starts with `-` is refused: `tg call @a --say --dry-run` must be a usage error, never
// a real call that speaks "--dry-run". Dash-leading text goes through `--say=<text>`, and
// even then a value that IS one of this command's flags is refused.
function scan(argv: string[], spec: ScanSpec): Scanned {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const repeated = spec.repeated ?? [];
  const known = [...spec.valued, ...repeated, ...spec.booleans];
  const fail = (error: string): Scanned => ({ positionals, flags, lists, error });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' && spec.endOfOptions) {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      flags.set('--help', true);
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (spec.booleans.includes(name)) {
      if (eq !== -1) return fail(`${name} takes no value.`);
      flags.set(name, true);
    } else if (spec.valued.includes(name) || repeated.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') return fail(`${name} needs a value.`);
      if (eq === -1 && value.startsWith('-')) {
        return fail(`${name} needs a value, got the flag-like '${value}'. For a value that starts with '-', write ${name}=<value>.`);
      }
      if (known.includes(value) || value === '--help') return fail(`${name} needs a value, not the flag ${value}.`);
      if (repeated.includes(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
      else flags.set(name, value);
    } else {
      return fail(`unknown option ${name}.`);
    }
  }
  return { positionals, flags, lists };
}

function value(s: Scanned, flag: string): string | undefined {
  const v = s.flags.get(flag);
  return typeof v === 'string' ? v : undefined;
}

const HELP_COMMAND = {
  auth: 'tg auth --help',
  call: 'tg call --help',
  'user-send': 'tg user send --help',
} as const;

function error(message: string, topic: keyof typeof HELP_COMMAND): { kind: 'error'; message: string } {
  return { kind: 'error', message: `${message} See \`${HELP_COMMAND[topic]}\`.` };
}

const POSITIVE_INT = /^[1-9][0-9]*$/;

// Flags each `tg auth user|caller <action>` accepts (besides --json), so a flag that would
// silently do nothing — `status --expected-id 5` — is a usage error instead.
const AUTH_ACTION_FLAGS: Record<string, readonly string[]> = {
  login: ['--qr', '--expected-id', '--import-session', '--import-config'],
  status: ['--online', '--source-idle-confirmed'],
  logout: [],
};

/** `tg auth user|caller <argv…>` — called by `parseAuthArgs` (features/auth/args.ts). */
export function parseAccountAuth(role: Role, argv: string[]): AccountAuthArgs {
  const s = scan(argv, {
    valued: ['--expected-id', '--import-session', '--import-config'],
    booleans: ['--qr', '--online', '--json', '--source-idle-confirmed'],
  });
  if (s.error) return error(s.error, 'auth');
  if (s.flags.has('--help')) return { kind: 'help' };
  const json = s.flags.has('--json');
  const [action = 'login', ...rest] = s.positionals;
  if (rest.length > 0) return error(`unexpected argument '${rest[0]}'.`, 'auth');
  const allowed = Object.hasOwn(AUTH_ACTION_FLAGS, action) ? AUTH_ACTION_FLAGS[action] : undefined;
  if (allowed === undefined) return error(`unknown action '${action}' (login, status, logout).`, 'auth');
  const foreign = [...s.flags.keys()].find((flag) => flag !== '--json' && !allowed.includes(flag));
  if (foreign !== undefined) {
    return error(`${foreign} does not apply to \`tg auth ${role === 'personal' ? 'user' : 'caller'} ${action}\`.`, 'auth');
  }
  const expectedId = value(s, '--expected-id');
  if (expectedId !== undefined && !POSITIVE_INT.test(expectedId)) {
    return error('--expected-id must be a positive numeric Telegram user id.', 'auth');
  }
  if (action === 'status') {
    return { kind: 'status', role, online: s.flags.has('--online'), sourceIdle: s.flags.has('--source-idle-confirmed'), json };
  }
  if (action === 'logout') return { kind: 'logout', role, json };
  const session = value(s, '--import-session');
  const config = value(s, '--import-config');
  if (session !== undefined || config !== undefined) {
    if (session === undefined || config === undefined) {
      return error('--import-session and --import-config go together.', 'auth');
    }
    if (s.flags.has('--qr')) return error('--qr is a new login; it cannot be combined with --import-session.', 'auth');
    return { kind: 'import', role, session, config, ...(expectedId ? { expectedId } : {}), json };
  }
  return { kind: 'login', role, qr: s.flags.has('--qr'), ...(expectedId ? { expectedId } : {}), json };
}

function parseCall(argv: string[]): UserAccountArgs {
  // No `--` here: `tg call` takes no free text, so a `--`-prefixed word can never become the
  // peer (`tg call -- --dry-run --say x` is an error, not a call to "--dry-run").
  const s = scan(argv, {
    valued: ['--say', '--audio', '--from', '--timeout'],
    booleans: ['--dry-run', '--json', '--source-idle-confirmed'],
  });
  if (s.error) return error(s.error, 'call');
  if (s.flags.has('--help')) return { kind: 'help', topic: 'call' };
  const [peer, ...rest] = s.positionals;
  if (peer === undefined) return error('missing <peer> (@username, numeric user id, or me).', 'call');
  if (rest.length > 0) return error(`unexpected argument '${rest[0]}' (quote --say text).`, 'call');
  const say = value(s, '--say');
  const audio = value(s, '--audio');
  if ((say === undefined) === (audio === undefined)) return error('give exactly one of --say <text> or --audio <file>.', 'call');
  const from = value(s, '--from');
  if (from !== undefined && from !== 'user' && from !== 'caller') return error("--from is 'user' or 'caller'.", 'call');
  if (peer === 'me' && from === 'user') {
    return error('an account cannot ring itself: `tg call me` rings you FROM the caller account.', 'call');
  }
  const timeout = value(s, '--timeout');
  if (timeout !== undefined && !POSITIVE_INT.test(timeout)) return error('--timeout is a whole number of seconds.', 'call');
  const role: Role = peer === 'me' || from === 'caller' ? 'caller' : 'personal';
  return {
    kind: 'call',
    role,
    peer,
    ...(say !== undefined ? { say } : { audio }),
    ...(timeout ? { timeout } : {}),
    dryRun: s.flags.has('--dry-run'),
    json: s.flags.has('--json'),
    sourceIdle: s.flags.has('--source-idle-confirmed'),
  };
}

function parseSend(argv: string[]): UserAccountArgs {
  const s = scan(argv, {
    valued: [],
    repeated: ['--file'],
    booleans: ['--dry-run', '--json', '--source-idle-confirmed'],
    endOfOptions: true,
  });
  if (s.error) return error(s.error, 'user-send');
  if (s.flags.has('--help')) return { kind: 'help', topic: 'user-send' };
  const [peer, ...words] = s.positionals;
  if (peer === undefined) return error('missing <peer> (@username, numeric id, or me).', 'user-send');
  const files = s.lists.get('--file') ?? [];
  // The bot send's never-attach denylist (features/auto-attach/denylist.ts): an explicit
  // secret attach is almost certainly a leak, so it is an error, never a silent skip. There
  // is no override here — the user account sends as the user, to anyone. The name checked is
  // the one the sidecar opens: Python's Path() drops trailing `/` and `/.` (`/x/.env/.` opens
  // `/x/.env`) but keeps `..`, which only the filesystem may resolve (symlinks), so the path
  // itself goes over unchanged.
  const secret = files.find((file) => isNeverAttach(file.replace(/(?:\/+\.?)+$/, '')));
  if (secret !== undefined) {
    return error(`refusing to attach '${secret}': matches the never-attach denylist (secrets).`, 'user-send');
  }
  return {
    kind: 'send',
    peer,
    ...(words.length > 0 ? { text: words.join(' ') } : {}),
    ...(files.length > 0 ? { files } : {}),
    dryRun: s.flags.has('--dry-run'),
    json: s.flags.has('--json'),
    sourceIdle: s.flags.has('--source-idle-confirmed'),
  };
}

/** `tg call …` and `tg user send …`; `tg auth user|caller` goes through `parseAuthArgs`. */
export function parseUserAccountArgs(argv: string[]): UserAccountArgs | null {
  const [first, second, ...rest] = argv;
  if (first === 'call') return parseCall(argv.slice(1));
  if (first === 'user' && second === 'send') return parseSend(rest);
  return null;
}
