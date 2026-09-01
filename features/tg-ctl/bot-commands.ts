// Bot command menu (setMyCommands). Single source of truth for the slash-commands
// the bot publishes to Telegram's "/" autocomplete + menu button.
//
// Runtime path: runDaemon() (in ../../tg-ctl) calls publishBotCommands() once on
// startup, POSTing this list via setMyCommands. The post is best-effort — a
// network/API failure is logged and ignored, never blocking the poll loop.
//
// Invariant: ONLY the bot's OWN commands belong here — the verbs `textAction`
// (in ./updates.ts) recognizes and handles itself. A slash that passes through
// VERBATIM to the harness (`/compact`, `/clear`, …) is NOT a bot command and is
// deliberately absent. `botCommandNames()` is asserted equal to the handled set
// by tests/ctl-bot-commands.test.ts so a newly-handled command can't silently
// miss the menu.

export interface BotCommand {
  // No leading slash; Telegram renders it with one. Lowercase, [a-z0-9_], 1-32 chars.
  command: string;
  // 1-256 chars; shown next to the command in the menu.
  description: string;
}

// Telegram constraints (setMyCommands / BotCommand):
//   command: 1-32 chars, lowercase letters, digits and underscores only.
//   description: 1-256 chars.
export const MAX_COMMAND_LEN = 32;
export const MAX_DESCRIPTION_LEN = 256;
// Built from MAX_COMMAND_LEN so the bound, the regex, and the error text never
// drift apart if the constant changes.
const COMMAND_RE = new RegExp(`^[a-z0-9_]{1,${MAX_COMMAND_LEN}}$`);

// The published menu. Order = the order shown in the Telegram client.
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'agent', description: 'Route a message to a specific agent (or pick from buttons)' },
  { command: 'new', description: 'Spawn a new agent session: /new [harness|model] [dir] name [task]' },
  { command: 'stop', description: 'Interrupt the current agent turn — session survives' },
  { command: 'kill', description: 'End the agent session (SIGINT)' },
  { command: 'status', description: 'Report daemon state' },
  { command: 'limit', description: 'Show latest agent usage limits: /limit [agent]' },
  { command: 'tasks', description: 'Task board: attention default, filters, pages' },
  { command: 'daily', description: 'What-shipped report: merged PRs since last run (rig daily)' },
  { command: 'usage', description: 'Token/cost usage report: /usage [day|week|month] (rig usage)' },
];

export function botCommandNames(): string[] {
  return BOT_COMMANDS.map((c) => c.command);
}

// Throws on any command that violates Telegram's setMyCommands constraints, so a
// malformed entry fails the test suite (and never ships) rather than being
// silently rejected by the Bot API at runtime.
export function validateBotCommands(commands: readonly BotCommand[] = BOT_COMMANDS): void {
  if (commands.length === 0) throw new Error('bot commands: list is empty');
  if (commands.length > 100) throw new Error(`bot commands: ${commands.length} > 100 (Telegram cap)`);
  const seen = new Set<string>();
  for (const c of commands) {
    if (!COMMAND_RE.test(c.command)) {
      throw new Error(`bot commands: invalid command name ${JSON.stringify(c.command)} (need [a-z0-9_], 1-${MAX_COMMAND_LEN})`);
    }
    if (seen.has(c.command)) throw new Error(`bot commands: duplicate command ${JSON.stringify(c.command)}`);
    seen.add(c.command);
    // Count Unicode code points ([...str]), not UTF-16 code units (str.length),
    // so the bound matches how the Bot API counts a description with emoji /
    // surrogate pairs. (Descriptions are ASCII today; this keeps it honest.)
    const len = [...c.description].length;
    if (len < 1 || len > MAX_DESCRIPTION_LEN) {
      throw new Error(`bot commands: description for ${JSON.stringify(c.command)} must be 1-${MAX_DESCRIPTION_LEN} chars (got ${len})`);
    }
  }
}
