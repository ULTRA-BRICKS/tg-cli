// --- `tg auth` argv (docs/specs/tg-auth.md §2) ---
//
// Exact-match leading token, the same contract as `tg replies` / `tg voice`:
// only `tg auth`, `tg auth <subcommand> …` and `tg auth --flag …` are the
// command; anything else (`tg auth is broken`) returns null and is sent as a
// message.

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

Connect tg to Telegram in one step: paste your BotFather token, tap Start in
Telegram, and TG_BOT_TOKEN + TG_CHAT_ID are written to <config>/.env
(~/.config/tg-cli/.env, or $TG_CTL_CONFIG_DIR/.env).

  tg auth            connected → show status; otherwise run login
  tg auth login      (re)bind: validate the token, print a one-time
                     https://t.me/<bot>?start=… link, wait for your Start tap
                     (alias: tg auth bot). A running tg-ctl reads the tap
                     for you; otherwise tg auth reads it itself.
  tg auth status     bot @username, target chat name/@username/id, config
                     path, whether the tg-ctl daemon is running
  tg auth logout     remove TG_BOT_TOKEN and TG_CHAT_ID from the .env

Options:
  --token <token>    login with this BotFather token (default: the configured
                     one; prompts on a terminal). --token - reads it from stdin.
  --timeout <sec>    how long login waits for the Start tap (default 300)
  --test             after login, send one confirmation message to the chat
  --yes, -y          logout without asking (required without a terminal)

Exit codes:
  0   success
  1   Telegram/network error, chat unreachable, .env write failed, logout
      declined, another login for this bot still waiting for its tap
  2   usage error (bad flag or token, no token and no terminal, logout without --yes)
  3   Telegram rejected the token
  4   timed out waiting for the Start tap
  5   another consumer holds this bot's updates (other machine or a webhook)
  78  not configured (tg auth status; also a plain \`tg\` send)

Spec: docs/specs/tg-auth.md`;

const LOGIN_FLAGS = ['--token', '--timeout', '--test'];
const FLAGS_BY_SUB: Record<AuthSub, readonly string[]> = {
  auto: LOGIN_FLAGS,
  login: LOGIN_FLAGS,
  status: [],
  logout: ['--yes'],
  help: [],
};

/** `rawArgs` (argv after the script) → an auth command, a usage error, or null (not `tg auth`). */
export function parseAuthArgs(rawArgs: readonly string[]): AuthCommand | { error: string } | null {
  if (rawArgs[0] !== 'auth') return null;
  const second = rawArgs[1];
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
    if (arg === '--help' || arg === '-h') return { ...cmd, sub: 'help' };
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? (arg === '-y' ? '--yes' : arg) : arg.slice(0, eq);
    if (!name.startsWith('-')) return { error: `tg auth ${sub === 'auto' ? '' : `${sub} `}takes no argument '${arg}'. See \`tg auth --help\`.` };
    if (!FLAGS_BY_SUB[sub].includes(name)) return { error: `unknown option '${name}' for tg auth${sub === 'auto' ? '' : ` ${sub}`}. See \`tg auth --help\`.` };
    const takesValue = name === '--token' || name === '--timeout';
    let value: string | undefined;
    if (takesValue) {
      value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') return { error: `${name} needs a value. See \`tg auth --help\`.` };
      // `--token --test` must not read '--test' as the token; `--token -` (stdin) stays valid.
      if (eq === -1 && value.startsWith('-') && value !== '-') {
        return { error: `${name} needs a value, got the option '${value}'. Use ${name}=<value> for a value starting with '-'. See \`tg auth --help\`.` };
      }
    } else if (eq !== -1) {
      return { error: `${name} takes no value, got '${arg}'. See \`tg auth --help\`.` };
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
