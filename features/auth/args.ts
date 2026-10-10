// --- `tg auth` argv (docs/specs/tg-auth.md §2) ---
//
// Exact-match leading token, the same contract as `tg replies` / `tg voice`:
// only `tg auth`, `tg auth <subcommand> …` and `tg auth --flag …` are the
// command; anything else (`tg auth is broken`) returns null and is sent as a
// message. ONE parser for the whole command: `tg auth user|caller …` (the
// user's own MTProto accounts, §9) is delegated to `parseAccountAuth` and comes
// back as `{ account }`.
import { parseAccountAuth, type UserAccountCommand } from '../user-account/args';

export type AuthSub = 'auto' | 'login' | 'status' | 'logout' | 'help';

export interface AuthCommand {
  sub: AuthSub;
  token?: string;
  tokenFromStdin: boolean;
  timeoutSec: number;
  test: boolean;
  yes: boolean;
}

const SUBCOMMANDS: Record<string, AuthSub> = { login: 'login', bot: 'login', status: 'status', logout: 'logout' };
const DEFAULT_TIMEOUT_SEC = 300;

export const AUTH_USAGE = `Usage: tg auth [login|status|logout] [options]
       tg auth user|caller [status|logout] [options]

Connect tg to Telegram. The bot (what tg sends as by default): paste your
BotFather token, tap Start in Telegram, and TG_BOT_TOKEN + TG_CHAT_ID are
written to <config>/.env (~/.config/tg-cli/.env, or $TG_CTL_CONFIG_DIR/.env).
Your own account (tg user send, tg call): log in once over MTProto.

Bot:
  tg auth            connected → show status; otherwise run login
  tg auth login      (re)bind: validate the token, print a one-time
                     https://t.me/<bot>?start=… link, wait for your Start tap
                     (alias: tg auth bot). A running tg-ctl reads the tap
                     for you; otherwise tg auth reads it itself.
  tg auth status     bot @username, target chat name/@username/id, config
                     path, tg-ctl daemon — and both accounts below (offline)
  tg auth logout     remove TG_BOT_TOKEN and TG_CHAT_ID from the .env

  --token <token>    login with this BotFather token (default: the configured
                     one; prompts on a terminal). --token - reads it from stdin.
  --timeout <sec>    how long login waits for the Start tap (default 300)
  --test             after login, send one confirmation message to the chat
  --yes, -y          logout without asking (required without a terminal)

Your Telegram account (user) and the account that rings you (caller):
  tg auth user [--qr] [--expected-id <id>]     log in YOUR account
  tg auth caller [--qr] [--expected-id <id>]   log in a second account (an
                     account cannot ring itself; tg call me rings from it)
  tg auth user|caller --import-session <file.session> --import-config <.env>
                     copy an existing pyrogram session (HyperCalendarBot)
  tg auth user|caller status [--online] [--json]   --online checks with Telegram
  tg auth user|caller logout                   delete the local session file

  Login asks, hidden, on this terminal: the API ID/hash of your app at
  https://my.telegram.org/apps (once; TG_API_ID/TG_API_HASH in the env or the
  config .env skip it), your phone number, the code Telegram sends, and the 2FA
  password if you have one. --qr draws a QR code instead: scan it in Telegram →
  Settings → Devices → Link Desktop Device. The session is saved to
  <config>/mtproto/<personal|caller>.json (mode 0600); it IS the account — keep
  it private. Logout deletes the file; terminate the login itself in Telegram →
  Settings → Devices.

A flag is never taken as a value (--token --test is an error); use --flag=value
for a value that starts with '-'.

Exit codes (bot):
  0   success
  1   Telegram/network error, chat unreachable, .env write failed, logout
      declined, another login for this bot still waiting for its tap
  2   usage error (bad flag or token, no token and no terminal, logout without --yes)
  3   Telegram rejected the token
  4   timed out waiting for the Start tap
  5   another consumer holds this bot's updates (other machine or a webhook)
  78  bot not configured (tg auth status; also a plain \`tg\` send)
Exit codes (user|caller): 0 ok, 2 usage, 3 not logged in / refused, 1 failed.

Spec: docs/specs/tg-auth.md, docs/specs/independent-telegram-clients.md`;

const LOGIN_FLAGS = ['--token', '--timeout', '--test'];
const FLAGS_BY_SUB: Record<AuthSub, readonly string[]> = {
  auto: LOGIN_FLAGS,
  login: LOGIN_FLAGS,
  status: [],
  logout: ['--yes'],
  help: [],
};

export type AuthArgs = AuthCommand | { error: string } | { account: UserAccountCommand };

/** `rawArgs` (argv after the script) → an auth command, a usage error, or null (not `tg auth`). */
export function parseAuthArgs(rawArgs: readonly string[]): AuthArgs | null {
  if (rawArgs[0] !== 'auth') return null;
  const second = rawArgs[1];
  const help: AuthCommand = { sub: 'help', tokenFromStdin: false, timeoutSec: DEFAULT_TIMEOUT_SEC, test: false, yes: false };
  if (second === 'user' || second === 'caller') {
    const account = parseAccountAuth(second === 'user' ? 'personal' : 'caller', rawArgs.slice(2));
    if (account.kind === 'help') return help;
    if (account.kind === 'error') return { error: account.message };
    return { account };
  }
  let sub: AuthSub = 'auto';
  let rest = rawArgs.slice(1);
  if (second !== undefined && !second.startsWith('-')) {
    // Own keys only: `tg auth constructor …` must not resolve through Object.prototype.
    const mapped = Object.hasOwn(SUBCOMMANDS, second) ? SUBCOMMANDS[second] : undefined;
    if (!mapped) return null;
    sub = mapped;
    rest = rawArgs.slice(2);
  }
  const cmd: AuthCommand = { sub, tokenFromStdin: false, timeoutSec: DEFAULT_TIMEOUT_SEC, test: false, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--help' || arg === '-h') return help;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? (arg === '-y' ? '--yes' : arg) : arg.slice(0, eq);
    if (!name.startsWith('-')) return { error: `tg auth ${sub === 'auto' ? '' : `${sub} `}takes no argument '${arg}'. See \`tg auth --help\`.` };
    if (!FLAGS_BY_SUB[sub].includes(name)) return { error: `unknown option '${name}' for tg auth${sub === 'auto' ? '' : ` ${sub}`}. See \`tg auth --help\`.` };
    const takesValue = name === '--token' || name === '--timeout';
    let value: string | undefined;
    if (takesValue) {
      value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') return { error: `${name} needs a value. See \`tg auth --help\`.` };
      // `--token --test` must not become the token "--test"; `--token -` is stdin.
      if (eq === -1 && value.startsWith('-') && !(name === '--token' && value === '-')) {
        return { error: `${name} needs a value, got the flag-like '${value}'. See \`tg auth --help\`.` };
      }
    } else if (eq !== -1) {
      return { error: `${name} takes no value. See \`tg auth --help\`.` };
    }
    if (name === '--token') {
      if (value === '-') cmd.tokenFromStdin = true;
      else cmd.token = value;
    } else if (name === '--timeout') {
      const sec = Number(value);
      if (!Number.isInteger(sec) || sec <= 0) return { error: `--timeout must be a positive number of seconds, got '${value}'.` };
      cmd.timeoutSec = sec;
    } else if (name === '--test') cmd.test = true;
    else if (name === '--yes') cmd.yes = true;
  }
  return cmd;
}
